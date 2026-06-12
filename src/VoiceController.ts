import { App, MarkdownView, Notice, TFile } from 'obsidian';
import type VoicePlugin from './main';
import { RealtimeSession, SessionStatus } from './RealtimeSession';
import { DOCUMENT_TOOLS, executeToolCall } from './DocumentTools';
import { CLAUDE_THREADS_TOOLS, CLAUDE_THREADS_TOOL_NAMES, executeClaudeThreadsTool } from './ClaudeThreadsTools';
import { NotificationBridge } from './NotificationBridge';
import { OPENAI_SECRET_ID, REALTIME_MODEL } from './settings';
import { WakeWordDetector } from './WakeWordDetector';

// ─── Event types ─────────────────────────────────────────────────────────────

export type TranscriptRole = 'user' | 'assistant';

export interface TranscriptLine {
  id: string;
  role: TranscriptRole;
  text: string;
  final: boolean;
}

export interface ToolLine {
  id: string;       // call ID or synthetic ID
  text: string;
  final: boolean;   // false while tool is running
}

/**
 * Activity states for a live voice session. The silence countdown only runs
 * in 'silence'. 'disconnect-pending' has its own short countdown (3s default)
 * driven by voiceDisconnectGraceSecs.
 *
 *   listening          connected, no turn in flight              no timer
 *   user-speaking      between speech_started and speech_stopped no timer
 *   ai-responding      between response.created and response.done no timer
 *   tool-running       at least one tool call mid-execution      no timer
 *   silence            fully idle                                silence countdown
 *   disconnect-pending AI fired voice_disconnect tool            grace countdown
 */
export type SessionActivity =
  | 'listening'
  | 'user-speaking'
  | 'ai-responding'
  | 'tool-running'
  | 'silence'
  | 'disconnect-pending';

/** Richer activity payload — includes any live countdown. */
export interface ActivityInfo {
  activity: SessionActivity;
  /** Seconds remaining in the active countdown, if any. */
  silenceSecsLeft?: number;
  disconnectPendingSecsLeft?: number;
}

export type StatusListener            = (status: SessionStatus) => void;
export type TranscriptListener        = (line: TranscriptLine) => void;
export type ToolListener              = (line: ToolLine) => void;
export type ActivityListener          = (info: ActivityInfo) => void;
export type DisconnectPendingListener = (event: DisconnectPendingEvent) => void;

/** Lifecycle of the disconnect-pending abort UI. */
export type DisconnectPendingEvent =
  | { kind: 'started'; reason: string; phrase: string; graceSecs: number }
  | { kind: 'tick'; secsLeft: number }
  | { kind: 'resolved'; finalText: string };

// ─── VOICE_CONTROL_TOOLS ─────────────────────────────────────────────────────

const VOICE_CONTROL_TOOLS = [
  {
    type: 'function',
    name: 'notification_acknowledged',
    description:
      'Call this to silently acknowledge a background update or notification that does not need a spoken response. ' +
      'Use it when you receive a context update, a thread progress notification, or any background information ' +
      'where speaking would be unnecessary or disruptive. Calling this keeps the session alive and resets the ' +
      'auto-disconnect silence timer without producing any audio.',
    parameters: {
      type: 'object',
      properties: {
        reason: {
          type: 'string',
          description: 'Optional internal note on why you are not responding verbally.',
        },
      },
    },
  },
  {
    type: 'function',
    name: 'voice_disconnect',
    description:
      'End the voice session. ONLY call this when the user has CLEARLY AND EXPLICITLY asked ' +
      'to end the conversation. Clear requests look like: "end session", "goodbye obsidian", ' +
      '"disconnect", "stop voice", "I am done". ' +
      'DO NOT call this for filler words ("ok", "thanks", "alright", "hmm"), for pauses in the ' +
      'conversation, for the user trailing off mid-thought, or for vague or implied endings. ' +
      'If there is ANY chance the user wants to keep talking, do NOT call this — keep the ' +
      'conversation going. You must provide both a reason and the exact phrase you heard.',
    parameters: {
      type: 'object',
      properties: {
        reason: {
          type: 'string',
          description:
            'One short sentence explaining why you are ending the session ' +
            '(e.g. "User said goodbye and asked to end the session").',
        },
        phrase: {
          type: 'string',
          description:
            'The exact words the user said that you interpret as ending the session, verbatim. ' +
            'Do not paraphrase.',
        },
      },
      required: ['reason', 'phrase'],
    },
  },
  {
    type: 'function',
    name: 'voice_wait',
    description: 'Pause for a specified number of seconds before responding. Useful when waiting for something to happen.',
    parameters: {
      type: 'object',
      properties: {
        seconds: { type: 'number', description: 'How many seconds to wait (1–300).' },
        reason: { type: 'string', description: 'Optional reason for waiting, shown in the transcript.' },
      },
      required: ['seconds'],
    },
  },
];

// ─── VoiceController ─────────────────────────────────────────────────────────

/**
 * Plugin-level singleton that owns all voice session state.
 *
 * Lives as long as the plugin is loaded — independent of any pane. The pane
 * (VoiceView) is a passive observer that renders whatever the controller emits.
 * This is what makes the "run a voice session from the status bar with the
 * panel closed" workflow work — the panel can be detached and reopened freely
 * without disrupting the live session.
 *
 * State machine, auto-disconnect robustness, voice_disconnect tool, and
 * playback-end detection all live here.
 */
export class VoiceController {
  private plugin: VoicePlugin;
  private app: App;

  private session: RealtimeSession | null = null;
  private notificationBridge: NotificationBridge | null = null;
  private wakeDetector: WakeWordDetector | null = null;

  public isConnected = false;
  public currentStatus: SessionStatus = 'idle';
  public currentActivity: SessionActivity = 'listening';

  /** Tracks the last markdown tab the user focused. */
  public lastMarkdownView: MarkdownView | null = null;

  /** Transcript buffer — kept so the pane can replay on open. */
  private static readonly BUFFER_MAX = 80;
  public transcriptBuffer: TranscriptLine[] = [];
  public toolBuffer: ToolLine[] = [];

  // Pending IDs for partial updates
  private pendingAssistantId: string | null = null;
  private pendingUserId: string | null = null;

  // Listeners
  private statusListeners: StatusListener[] = [];
  private transcriptListeners: TranscriptListener[] = [];
  private toolListeners: ToolListener[] = [];
  private activityListeners: ActivityListener[] = [];
  private disconnectPendingListeners: DisconnectPendingListener[] = [];

  private lineCounter = 0;

  // Silence watchdog — only runs while currentActivity === 'silence'.
  private silenceTimer: ReturnType<typeof setTimeout> | null = null;
  private silenceCountdownInterval: ReturnType<typeof setInterval> | null = null;
  private silenceSecsLeft = 0;

  // Disconnect-pending — own timer pair, independent of the silence watchdog.
  private disconnectPendingTimer: ReturnType<typeof setTimeout> | null = null;
  private disconnectPendingInterval: ReturnType<typeof setInterval> | null = null;
  private disconnectPendingSecsLeft = 0;
  private disconnectPendingReason = '';
  private disconnectPendingPhrase = '';

  constructor(plugin: VoicePlugin) {
    this.plugin = plugin;
    this.app = plugin.app;
  }

  // ── Listener registration ────────────────────────────────────────────────

  onStatusChange(fn: StatusListener): () => void {
    this.statusListeners.push(fn);
    return () => { this.statusListeners = this.statusListeners.filter(l => l !== fn); };
  }

  onTranscript(fn: TranscriptListener): () => void {
    this.transcriptListeners.push(fn);
    return () => { this.transcriptListeners = this.transcriptListeners.filter(l => l !== fn); };
  }

  onToolEvent(fn: ToolListener): () => void {
    this.toolListeners.push(fn);
    return () => { this.toolListeners = this.toolListeners.filter(l => l !== fn); };
  }

  onActivityChange(fn: ActivityListener): () => void {
    this.activityListeners.push(fn);
    return () => { this.activityListeners = this.activityListeners.filter(l => l !== fn); };
  }

  onDisconnectPending(fn: DisconnectPendingListener): () => void {
    this.disconnectPendingListeners.push(fn);
    return () => { this.disconnectPendingListeners = this.disconnectPendingListeners.filter(l => l !== fn); };
  }

  // ── Workspace tracking ───────────────────────────────────────────────────

  startTrackingActiveFile(): void {
    this.plugin.registerEvent(
      this.app.workspace.on('active-leaf-change', (leaf) => {
        if (leaf?.view instanceof MarkdownView && leaf.view.file) {
          this.lastMarkdownView = leaf.view;
        }
      })
    );
    this.lastMarkdownView = this.app.workspace.getActiveViewOfType(MarkdownView);
  }

  // ── Connection ───────────────────────────────────────────────────────────

  async toggleConnection(): Promise<void> {
    if (this.isConnected) {
      this.doDisconnect();
    } else {
      await this.doConnect();
    }
  }

  async doConnect(): Promise<void> {
    if (this.wakeDetector) {
      this.wakeDetector.stop();
      this.wakeDetector = null;
    }

    const { voice, systemPromptExtra } = this.plugin.settings;
    const apiKey = this.app.secretStorage.getSecret(OPENAI_SECRET_ID);

    if (!apiKey) {
      new Notice('Voice: no OpenAI API key configured. Open Settings to add one.');
      this.syncWakeWordDetector();
      return;
    }

    const view       = this.lastMarkdownView;
    const docContent = this.getCurrentDocContent();
    const claudeThreadsAvailable = this.isClaudeThreadsAvailable();

    if (claudeThreadsAvailable) {
      this.notificationBridge = new NotificationBridge();
    }

    const { content: contextFilesContent, loadedCount, failedPaths } = await this.loadContextFiles();
    const systemPrompt = this.buildSystemPrompt(docContent, contextFilesContent, systemPromptExtra, claudeThreadsAvailable);
    const allTools = claudeThreadsAvailable
      ? [...DOCUMENT_TOOLS, ...CLAUDE_THREADS_TOOLS, ...VOICE_CONTROL_TOOLS]
      : [...DOCUMENT_TOOLS, ...VOICE_CONTROL_TOOLS];

    this.session = new RealtimeSession();
    this.clearTranscript();

    await this.session.connect(
      apiKey,
      REALTIME_MODEL,
      voice,
      systemPrompt,
      {
        onStatusChange: (status) => {
          this.currentStatus = status;
          if (status === 'connected') {
            this.isConnected = true;
            this.playChime('connect');
            this.transitionTo('listening', 'connected');
            if (this.notificationBridge && this.session) {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const ct = (this.app as any)?.plugins?.plugins?.['claude-threads'] as Record<string, unknown> | null;
              const manager = ct?.manager as Parameters<NotificationBridge['connect']>[0] | undefined;
              if (manager) {
                this.notificationBridge.connect(manager, this.session, this.plugin.settings.debugLogging);
              }
            }
            if (view?.file) {
              const chars = docContent.length.toLocaleString();
              this.emitToolEvent(`Context snapshot: ${view.file.name} · ${chars} chars`, true);
            } else {
              this.emitToolEvent('Context snapshot: no document open', true);
            }
            if (loadedCount > 0) {
              this.emitToolEvent(`Context files: ${loadedCount} file${loadedCount !== 1 ? 's' : ''} loaded`, true);
            }
            if (failedPaths.length > 0) {
              this.emitToolEvent(`Context files: could not load — ${failedPaths.join(', ')}`, true);
            }
          } else if (status === 'idle' || status === 'error') {
            const wasConnected = this.isConnected;
            this.isConnected = false;
            this.clearSilenceTimer();
            this.clearDisconnectPendingTimer();
            this.disconnectPendingReason = '';
            this.disconnectPendingPhrase = '';
            if (wasConnected) this.playChime('disconnect');
            this.notificationBridge?.disconnect();
            this.notificationBridge = null;
            this.session = null;
            this.syncWakeWordDetector();
          }
          this.emitStatus(status);
        },

        onSpeechStarted: () => {
          if (this.currentActivity === 'disconnect-pending') {
            this.cancelDisconnectPending('user_resumed_speaking', /* injectMessage */ false);
          }
          this.transitionTo('user-speaking', 'speech_started');
        },

        onSpeechStopped: () => {
          this.transitionTo('silence', 'speech_stopped');
        },

        onResponseStarted: () => {
          if (this.currentActivity === 'disconnect-pending') return;
          this.transitionTo('ai-responding', 'response.created');
        },

        onAudioDone: () => {
          if (this.currentActivity === 'tool-running' || this.currentActivity === 'disconnect-pending') return;
          this.transitionTo('silence', 'audio_done');
        },

        onTranscript: (role, text, done) => {
          this.handleTranscript(role, text, done);
        },

        onToolCall: (callId, name, argsJson) => {
          this.transitionTo('tool-running', `tool_call:${name}`);
          const label = this.formatToolLabel(name, argsJson);
          this.emitToolEvent(label, false, callId);
        },

        onError: (msg) => {
          new Notice(`Voice error: ${msg}`);
          this.emitToolEvent(`Error: ${msg}`, true);
        },

        getToolResult: async (callId, name, argsJson) => {
          let args: Record<string, unknown> = {};
          try {
            args = JSON.parse(argsJson) as Record<string, unknown>;
          } catch {
            return `Error: could not parse tool arguments`;
          }

          let result: string;
          if (name === 'voice_disconnect') {
            const reason = String(args.reason ?? '').trim() || '(no reason given)';
            const phrase = String(args.phrase ?? '').trim() || '(no phrase captured)';
            this.startDisconnectPending(reason, phrase);
            result = `Disconnect requested. The user has ${this.plugin.settings.voiceDisconnectGraceSecs} seconds to cancel by clicking Stay or speaking. Reason: "${reason}". Phrase heard: "${phrase}".`;
          } else if (name === 'voice_wait') {
            const secs = Math.min(Math.max(1, Number(args.seconds) || 5), 300);
            await new Promise((r) => setTimeout(r, secs * 1000));
            result = `Waited ${secs} second${secs !== 1 ? 's' : ''}.${args.reason ? ' ' + String(args.reason) : ''}`;
          } else if (CLAUDE_THREADS_TOOL_NAMES.has(name)) {
            result = await executeClaudeThreadsTool(name, args, this.app, this.notificationBridge);
          } else {
            result = await executeToolCall(name, args, this.app, this.lastMarkdownView);
          }

          const finalText = this.formatToolResult(name, argsJson, result);
          this.emitToolEvent(finalText, true, callId);
          return result;
        },
      },
      allTools,
      this.plugin.settings.debugLogging,
    );
  }

  doDisconnect(): void {
    this.clearSilenceTimer();
    this.clearDisconnectPendingTimer();
    this.disconnectPendingReason = '';
    this.disconnectPendingPhrase = '';
    if (this.isConnected) this.playChime('disconnect');
    this.session?.disconnect();
    this.session = null;
    this.isConnected = false;
    this.currentActivity = 'listening';
    this.emitActivity();
    this.syncWakeWordDetector();
    this.emitStatus('idle');
  }

  // ── State machine ────────────────────────────────────────────────────────

  private transitionTo(next: SessionActivity, reason: string): void {
    const prev = this.currentActivity;
    if (prev === next && next !== 'silence') {
      console.debug(`[Voice/lifecycle] (no-op) ${prev} → ${next} (${reason})`);
      return;
    }

    console.log(`[Voice/lifecycle] ${prev} → ${next} (${reason})`);
    this.currentActivity = next;

    this.clearSilenceTimer();

    if (next === 'silence') {
      this.armSilenceCountdown();
    }

    this.emitActivity();
  }

  private armSilenceCountdown(): void {
    const secs = this.plugin.settings.silenceTimeoutSecs;
    if (!secs) return;

    this.silenceSecsLeft = secs;
    this.emitActivity();

    this.silenceCountdownInterval = setInterval(() => {
      this.silenceSecsLeft = Math.max(0, this.silenceSecsLeft - 1);
      this.emitActivity();
    }, 1000);

    this.silenceTimer = setTimeout(() => {
      if (!this.isConnected) return;
      this.clearSilenceCountdownInterval();
      console.log(`[Voice/lifecycle] silence → idle (silence_timeout:${secs}s)`);
      this.emitToolEvent(
        `Disconnected after ${secs}s of silence — say "hey obsidian" to reconnect`,
        true,
      );
      this.doDisconnect();
    }, secs * 1000);
  }

  private clearSilenceTimer(): void {
    if (this.silenceTimer !== null) {
      clearTimeout(this.silenceTimer);
      this.silenceTimer = null;
    }
    this.clearSilenceCountdownInterval();
  }

  private clearSilenceCountdownInterval(): void {
    if (this.silenceCountdownInterval !== null) {
      clearInterval(this.silenceCountdownInterval);
      this.silenceCountdownInterval = null;
    }
  }

  // ── Disconnect-pending ───────────────────────────────────────────────────

  private startDisconnectPending(reason: string, phrase: string): void {
    const grace = Math.min(30, Math.max(1, this.plugin.settings.voiceDisconnectGraceSecs || 3));
    this.disconnectPendingReason = reason;
    this.disconnectPendingPhrase = phrase;

    console.log(`[Voice/lifecycle] ${this.currentActivity} → disconnect-pending (voice_disconnect reason="${reason}" phrase="${phrase}" grace=${grace}s)`);
    this.currentActivity = 'disconnect-pending';

    this.clearSilenceTimer();
    this.clearDisconnectPendingTimer();
    this.disconnectPendingSecsLeft = grace;

    this.emitDisconnectPending({ kind: 'started', reason, phrase, graceSecs: grace });
    this.emitActivity();

    this.disconnectPendingInterval = setInterval(() => {
      this.disconnectPendingSecsLeft = Math.max(0, this.disconnectPendingSecsLeft - 1);
      this.emitDisconnectPending({ kind: 'tick', secsLeft: this.disconnectPendingSecsLeft });
      this.emitActivity();
    }, 1000);

    this.disconnectPendingTimer = setTimeout(() => {
      if (!this.isConnected) return;
      console.log(`[Voice/lifecycle] disconnect-pending → idle (grace_expired reason="${reason}")`);
      this.clearDisconnectPendingTimer();
      this.emitDisconnectPending({ kind: 'resolved', finalText: 'Disconnected.' });
      this.emitToolEvent(`Disconnected by AI · reason: "${reason}"`, true);
      this.doDisconnect();
    }, grace * 1000);
  }

  cancelDisconnectPending(via: string, injectMessage: boolean): void {
    if (this.currentActivity !== 'disconnect-pending') return;
    const reason = this.disconnectPendingReason;
    console.log(`[Voice/lifecycle] disconnect-pending → listening (cancelled via=${via} original_reason="${reason}")`);

    this.clearDisconnectPendingTimer();

    const finalText = via === 'stay_button'
      ? 'Stayed connected.'
      : via === 'user_resumed_speaking'
        ? 'User resumed speaking — stayed connected.'
        : 'Disconnect cancelled.';
    this.emitDisconnectPending({ kind: 'resolved', finalText });

    if (injectMessage && this.session) {
      void this.session.injectUserMessage(
        'I clicked Stay connected. Please continue the conversation — I did not mean to end the session.'
      );
    }

    this.disconnectPendingReason = '';
    this.disconnectPendingPhrase = '';
    this.transitionTo('listening', `disconnect_cancelled:${via}`);
  }

  private clearDisconnectPendingTimer(): void {
    if (this.disconnectPendingTimer !== null) {
      clearTimeout(this.disconnectPendingTimer);
      this.disconnectPendingTimer = null;
    }
    if (this.disconnectPendingInterval !== null) {
      clearInterval(this.disconnectPendingInterval);
      this.disconnectPendingInterval = null;
    }
  }

  // ── Wake word ────────────────────────────────────────────────────────────

  syncWakeWordDetector(): void {
    const { wakeWordEnabled, wakeWordThreshold, debugLogging } = this.plugin.settings;

    if (this.wakeDetector) {
      this.wakeDetector.stop();
      this.wakeDetector = null;
    }

    if (!wakeWordEnabled || this.isConnected || this.plugin.wakeDetectorSuspended) {
      this.emitStatus(this.currentStatus);
      return;
    }

    const adapter = this.app.vault.adapter as { basePath?: string };
    const modelDir = adapter.basePath && this.plugin.manifest.dir
      ? `${adapter.basePath}/${this.plugin.manifest.dir}`
      : (this.plugin.manifest.dir ?? '');

    let downloadNotice: Notice | null = null;
    this.wakeDetector = new WakeWordDetector(
      modelDir,
      () => {
        if (debugLogging) console.log('[Voice] Wake word detected — auto-connecting');
        this.emitToolEvent('Wake word detected: "hey obsidian" — connecting…', true);
        void this.doConnect();
      },
      debugLogging,
      wakeWordThreshold ?? 0.75,
      (msg) => {
        if (msg === null) {
          downloadNotice?.hide();
          downloadNotice = null;
          return;
        }
        if (!downloadNotice) downloadNotice = new Notice(msg, 0);
        else downloadNotice.setMessage(msg);
        if (msg === 'Loading models…') {
          setTimeout(() => { downloadNotice?.hide(); downloadNotice = null; }, 2000);
        }
      },
    );
    try {
      this.wakeDetector.start();
    } catch (err) {
      (downloadNotice as Notice | null)?.hide();
      downloadNotice = null;
      new Notice('Voice: wake word model download failed — check your internet connection.');
      console.error('[Voice] wake word start failed:', err);
    }
    this.emitStatus(this.currentStatus);
  }

  isWakeWordActive(): boolean {
    return this.wakeDetector?.isActive() ?? false;
  }

  stopWakeDetector(): void {
    this.wakeDetector?.stop();
    this.emitStatus(this.currentStatus);
  }

  activateWakeDetector(): void {
    if (this.wakeDetector && !this.isConnected && !this.plugin.wakeDetectorSuspended) {
      this.wakeDetector.start();
      this.emitStatus(this.currentStatus);
      return;
    }
    this.syncWakeWordDetector();
  }

  // ── Destroy ──────────────────────────────────────────────────────────────

  destroy(): void {
    this.clearSilenceTimer();
    this.clearDisconnectPendingTimer();
    this.wakeDetector?.stop();
    this.wakeDetector = null;
    this.session?.disconnect();
    this.session = null;
    this.isConnected = false;
    this.statusListeners = [];
    this.transcriptListeners = [];
    this.toolListeners = [];
    this.activityListeners = [];
    this.disconnectPendingListeners = [];
  }

  // ── Live activity snapshot ───────────────────────────────────────────────

  getActivityInfo(): ActivityInfo {
    const info: ActivityInfo = { activity: this.currentActivity };
    if (this.currentActivity === 'silence') info.silenceSecsLeft = this.silenceSecsLeft;
    if (this.currentActivity === 'disconnect-pending') info.disconnectPendingSecsLeft = this.disconnectPendingSecsLeft;
    return info;
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  private nextId(): string {
    return String(++this.lineCounter);
  }

  private emitStatus(status: SessionStatus): void {
    this.currentStatus = status;
    for (const fn of this.statusListeners) fn(status);
  }

  private emitActivity(): void {
    const info = this.getActivityInfo();
    for (const fn of this.activityListeners) fn(info);
  }

  private emitDisconnectPending(event: DisconnectPendingEvent): void {
    for (const fn of this.disconnectPendingListeners) fn(event);
  }

  private handleTranscript(role: 'user' | 'assistant', text: string, done: boolean): void {
    if (role === 'assistant') {
      if (!this.pendingAssistantId) {
        const id = this.nextId();
        this.pendingAssistantId = id;
        const line: TranscriptLine = { id, role: 'assistant', text: '', final: false };
        this.pushTranscriptBuffer(line);
        for (const fn of this.transcriptListeners) fn({ ...line });
      }
      if (text) {
        const buf = this.transcriptBuffer.find(l => l.id === this.pendingAssistantId);
        if (buf) buf.text += text;
        const updated: TranscriptLine = {
          id: this.pendingAssistantId,
          role: 'assistant',
          text: buf?.text ?? text,
          final: false,
        };
        for (const fn of this.transcriptListeners) fn(updated);
      }
      if (done) {
        const buf = this.transcriptBuffer.find(l => l.id === this.pendingAssistantId);
        if (buf) buf.final = true;
        const finalized: TranscriptLine = {
          id: this.pendingAssistantId!,
          role: 'assistant',
          text: buf?.text ?? '',
          final: true,
        };
        for (const fn of this.transcriptListeners) fn(finalized);
        this.pendingAssistantId = null;
      }
    } else {
      if (!this.pendingUserId) {
        const id = this.nextId();
        this.pendingUserId = id;
        const line: TranscriptLine = { id, role: 'user', text, final: false };
        this.pushTranscriptBuffer(line);
        for (const fn of this.transcriptListeners) fn({ ...line });
      } else {
        const buf = this.transcriptBuffer.find(l => l.id === this.pendingUserId);
        if (buf) buf.text = text;
        const updated: TranscriptLine = {
          id: this.pendingUserId,
          role: 'user',
          text,
          final: false,
        };
        for (const fn of this.transcriptListeners) fn(updated);
      }
      if (done) {
        const buf = this.transcriptBuffer.find(l => l.id === this.pendingUserId);
        if (buf) { buf.text = text; buf.final = true; }
        const finalized: TranscriptLine = {
          id: this.pendingUserId!,
          role: 'user',
          text,
          final: true,
        };
        for (const fn of this.transcriptListeners) fn(finalized);
        this.pendingUserId = null;
      }
    }
  }

  private pushTranscriptBuffer(line: TranscriptLine): void {
    this.transcriptBuffer.push(line);
    if (this.transcriptBuffer.length > VoiceController.BUFFER_MAX) {
      this.transcriptBuffer.shift();
    }
  }

  private emitToolEvent(text: string, final: boolean, callId?: string): void {
    const id = callId ?? this.nextId();

    const existing = this.toolBuffer.find(t => t.id === id);
    if (existing) {
      existing.text = text;
      existing.final = final;
    } else {
      this.toolBuffer.push({ id, text, final });
      if (this.toolBuffer.length > VoiceController.BUFFER_MAX) {
        this.toolBuffer.shift();
      }
    }

    for (const fn of this.toolListeners) fn({ id, text, final });
  }

  private clearTranscript(): void {
    this.transcriptBuffer = [];
    this.toolBuffer = [];
    this.pendingAssistantId = null;
    this.pendingUserId = null;
    this.lineCounter = 0;
  }

  private getCurrentDocContent(): string {
    if (!this.lastMarkdownView) return '(no document currently open)';
    return this.lastMarkdownView.editor.getValue();
  }

  private isClaudeThreadsAvailable(): boolean {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return !!((this.app as any)?.plugins?.plugins?.['claude-threads']);
  }

  private async loadContextFiles(): Promise<{
    content: string;
    loadedCount: number;
    failedPaths: string[];
  }> {
    const paths = this.plugin.settings.contextFiles ?? [];
    if (paths.length === 0) return { content: '', loadedCount: 0, failedPaths: [] };

    const sections: string[] = [];
    const failedPaths: string[] = [];

    for (const rawPath of paths) {
      const path = rawPath.trim();
      if (!path) continue;
      try {
        const abstract = this.app.vault.getAbstractFileByPath(path);
        if (!(abstract instanceof TFile)) {
          failedPaths.push(path);
          continue;
        }
        const content = await this.app.vault.read(abstract);
        sections.push(`<context name="${path}">\n${content}\n</context>`);
      } catch {
        failedPaths.push(path);
      }
    }

    return {
      content: sections.join('\n\n'),
      loadedCount: sections.length,
      failedPaths,
    };
  }

  private buildSystemPrompt(
    docContent: string,
    contextFilesContent: string,
    extra: string,
    hasClaudeThreads = false,
  ): string {
    let prompt =
      'You are a voice assistant helping with an Obsidian document. ' +
      'The current document content is:\n\n```\n' +
      docContent +
      '\n```\n\n' +
      'You can read it, answer questions about it, and use the available tools to edit it. ' +
      'Keep responses concise: this is a voice conversation.';
    if (hasClaudeThreads) {
      prompt +=
        '\n\nYou also have access to Claude Threads tools (ct_* prefix). ' +
        'Use ct_new_thread to start a fresh agent and ct_send_message to reply in an existing thread.' +
        '\n\n== Async thread rules — read carefully ==' +
        '\n• When you call ct_send_message or ct_new_thread with wait=true (default), the tool BLOCKS ' +
        'until the agent finishes and returns the final result. Handle it in one turn.' +
        '\n• When wait=false, the thread runs in the BACKGROUND. The tool returns immediately with just the ' +
        'thread ID — NOT the result.' +
        '\n• While a background thread is running, you will receive proactive voice notifications with its ' +
        'PARTIAL progress (each new message it posts). Each notification arrives tagged with one of:' +
        '\n    [Thread STATUS=working id="…"]  → the agent is still actively working' +
        '\n    [Thread STATUS=idle id="…"]     → the agent posted a message and stopped (but no done signal)' +
        '\n    [Thread STATUS=done id="…"]     → terminal: the thread finished successfully' +
        '\n    [Thread STATUS=error id="…"]    → terminal: the thread errored out' +
        '\n• Your job when you receive a STATUS=working partial: narrate briefly to the USER in one short ' +
        'sentence (e.g., "Looks like it\'s now reading the README.") so they stay informed. ' +
        'CRITICAL: DO NOT call ct_send_message on a thread that is STATUS=working — the agent has work in ' +
        'flight and a new message would just queue behind it. Just talk to the user.' +
        '\n• On STATUS=done or STATUS=error: acknowledge the result, paraphrase the key point (don\'t recite ' +
        'verbatim), and ask the user what to do next. After this, ct_send_message is fair game again.' +
        '\n• On STATUS=idle (rare — usually means a message arrived just before the done signal): treat ' +
        'like done. The agent is not currently working but the thread is also not formally finished.' +
        '\n• NEVER ask the user "is the thread still working?" or "is it done yet?" — the notifications ' +
        'already tell you. NEVER poll ct_get_thread proactively. Call it only when the user explicitly ' +
        'asks for a status check or for the full transcript of a thread.' +
        '\n• When you receive a background notification and do NOT need to say anything, call ' +
        'notification_acknowledged instead of staying silent. This resets the auto-disconnect timer ' +
        'so the session stays alive while threads are still running.';
    }
    if (contextFilesContent.trim()) {
      prompt += '\n\n' + contextFilesContent.trim();
    }
    if (extra.trim()) {
      prompt += '\n\n' + extra.trim();
    }
    return prompt;
  }

  // ── Tool label helpers ───────────────────────────────────────────────────

  private formatToolLabel(name: string, argsJson: string): string {
    let args: Record<string, unknown> = {};
    try { args = JSON.parse(argsJson) as Record<string, unknown>; } catch { /* ok */ }

    switch (name) {
      case 'search_vault':       return `Searching vault · "${args.query as string ?? ''}"…`;
      case 'open_file':          return `Opening · ${args.filename as string ?? ''}…`;
      case 'get_document':       return 'Reading document…';
      case 'append_note':        return 'Appending note…';
      case 'insert_at_cursor':   return 'Inserting text…';
      case 'replace_document':   return 'Replacing document…';
      case 'get_links':          return 'Getting links…';
      case 'create_document':    return `Creating document · ${args.path as string ?? ''}…`;
      case 'list_folder':        return `Listing folder · ${args.path as string || '/'}…`;
      case 'ct_send_message':    return `Sending to thread · "${String(args.message ?? '').slice(0, 40)}"…`;
      case 'ct_new_thread':      return `Starting new thread · "${String(args.message ?? '').slice(0, 40)}"…`;
      case 'ct_wait_for_thread': return `Waiting for thread${args.thread_id ? ` · ${String(args.thread_id).slice(0, 8)}` : ''}…`;
      case 'ct_get_thread':      return `Reading thread${args.thread_id ? ` · ${String(args.thread_id).slice(0, 8)}` : ''}…`;
      case 'ct_list_threads':    return args.status && args.status !== 'all' ? `Listing ${String(args.status)} threads…` : 'Listing threads…';
      case 'ct_open_thread':     return `Opening thread · ${String(args.thread_id ?? '').slice(0, 8)}…`;
      case 'ct_close_thread':    return args.thread_id ? `Closing thread · ${String(args.thread_id).slice(0, 8)}…` : 'Closing active thread…';
      case 'ct_get_active_thread': return 'Reading active thread…';
      case 'ct_watch':           return args.thread_id ? `Watching thread · ${String(args.thread_id).slice(0, 8)}…` : 'Watching all threads…';
      case 'ct_unwatch':         return args.thread_id ? `Stopped watching · ${String(args.thread_id).slice(0, 8)}…` : 'Stopped watching all threads…';
      case 'voice_disconnect':   return 'Disconnect requested…';
      case 'voice_wait':         return `Waiting ${Number(args.seconds) || 5}s…`;
      default:                   return `${name}…`;
    }
  }

  private formatToolResult(name: string, argsJson: string, result: string): string {
    let args: Record<string, unknown> = {};
    try { args = JSON.parse(argsJson) as Record<string, unknown>; } catch { /* ok */ }

    const isError = result.startsWith('Error:');

    switch (name) {
      case 'search_vault': {
        if (isError) return `Search failed · "${args.query as string ?? ''}"`;
        const count = (result.match(/^\d+\./gm) ?? []).length;
        return `Searched vault · "${args.query as string ?? ''}" · ${count} result${count !== 1 ? 's' : ''}`;
      }
      case 'open_file':
        return isError ? `File not found · ${args.filename as string ?? ''}` : `Opened · ${args.filename as string ?? ''}`;
      case 'get_document':
        return isError ? 'Read document · no file open' : 'Read document';
      case 'append_note':
        return isError ? 'Append failed' : 'Appended note';
      case 'insert_at_cursor':
        return isError ? 'Insert failed' : 'Inserted text';
      case 'replace_document':
        return isError ? 'Replace failed' : 'Replaced document';
      case 'get_links': {
        if (isError) return 'Got links · no file open';
        const count = (result.match(/^- /gm) ?? []).length;
        return `Got links · ${count} link${count !== 1 ? 's' : ''}`;
      }
      case 'create_document':
        return isError ? `Create failed · ${args.path as string ?? ''}` : `Created · ${args.path as string ?? ''}`;
      case 'list_folder': {
        if (isError) return `List failed · ${args.path as string || '/'}`;
        const count = (result.match(/\n  /g) ?? []).length;
        return `Listed · ${args.path as string || '/'} · ${count} item${count !== 1 ? 's' : ''}`;
      }
      case 'ct_send_message':    return isError ? 'Send failed' : 'Sent · agent replied';
      case 'ct_new_thread':      return isError ? 'New thread failed' : 'New thread · agent replied';
      case 'ct_wait_for_thread': return isError ? 'Wait failed' : 'Thread finished';
      case 'ct_get_thread':      return isError ? `Read thread failed` : `Read thread${args.thread_id ? ` · ${String(args.thread_id).slice(0, 8)}` : ''}`;
      case 'ct_list_threads': {
        if (isError) return 'List threads failed';
        const countMatch = result.match(/"count":\s*(\d+)/);
        const n = countMatch ? countMatch[1] : '?';
        return `Listed ${n} thread${n !== '1' ? 's' : ''}`;
      }
      case 'ct_open_thread':       return isError ? 'Open thread failed' : 'Opened thread';
      case 'ct_close_thread':      return isError ? 'Close thread failed' : 'Thread closed';
      case 'ct_get_active_thread': return isError ? 'Read active thread failed' : 'Read active thread';
      case 'ct_watch':
        return isError ? 'Watch failed' : (args.thread_id ? `Watching · ${String(args.thread_id).slice(0, 8)}` : 'Watching all threads');
      case 'ct_unwatch':
        return isError ? 'Unwatch failed' : (args.thread_id ? `Stopped watching · ${String(args.thread_id).slice(0, 8)}` : 'Stopped all notifications');
      case 'voice_disconnect': return 'Disconnect requested · awaiting grace period';
      case 'voice_wait':       return result;
      default:                 return isError ? `${name} failed` : name;
    }
  }

  // ── Audio feedback ───────────────────────────────────────────────────────

  private playChime(type: 'connect' | 'disconnect'): void {
    try {
      const ctx = new AudioContext();
      const master = ctx.createGain();
      master.gain.value = type === 'connect' ? 0.35 : 0.22;
      master.connect(ctx.destination);

      const notes: [number, number, number][] =
        type === 'connect'
          ? [[523.25, 0, 0.18], [783.99, 0.13, 0.22]]
          : [[783.99, 0, 0.14], [523.25, 0.1,  0.22]];

      for (const [freq, offset, dur] of notes) {
        const osc = ctx.createOscillator();
        const env = ctx.createGain();
        osc.connect(env);
        env.connect(master);
        osc.type = 'sine';
        osc.frequency.value = freq;
        const t = ctx.currentTime + offset;
        env.gain.setValueAtTime(0, t);
        env.gain.linearRampToValueAtTime(1, t + 0.008);
        env.gain.exponentialRampToValueAtTime(0.001, t + dur);
        osc.start(t);
        osc.stop(t + dur);
      }

      setTimeout(() => ctx.close(), 800);
    } catch {
      // AudioContext unavailable
    }
  }
}
