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
  id: string;       // call ID
  text: string;
  final: boolean;   // false while tool is running
}

export type StatusListener    = (status: SessionStatus) => void;
export type TranscriptListener = (line: TranscriptLine) => void;
export type ToolListener      = (line: ToolLine) => void;

// ─── VOICE_CONTROL_TOOLS ─────────────────────────────────────────────────────

const VOICE_CONTROL_TOOLS = [
  {
    type: 'function',
    name: 'voice_disconnect',
    description:
      'Disconnect the voice session. Use when the user says goodbye, asks to stop, or wants to end the conversation.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    type: 'function',
    name: 'voice_wait',
    description:
      'Pause for a specified number of seconds before responding. Useful when waiting for something to happen.',
    parameters: {
      type: 'object',
      properties: {
        seconds: { type: 'number', description: 'How many seconds to wait (1–300).' },
        reason:  { type: 'string', description: 'Optional reason for waiting, shown in the transcript.' },
      },
      required: ['seconds'],
    },
  },
];

// ─── VoiceController ─────────────────────────────────────────────────────────

/**
 * Plugin-level singleton that owns all voice session state.
 * Lives as long as the plugin is loaded — independent of any pane.
 */
export class VoiceController {
  private plugin: VoicePlugin;
  private app: App;

  private session: RealtimeSession | null = null;
  private notificationBridge: NotificationBridge | null = null;
  private wakeDetector: WakeWordDetector | null = null;

  public isConnected = false;
  public currentStatus: SessionStatus = 'idle';

  // Tracks the last markdown tab the user focused.
  public lastMarkdownView: MarkdownView | null = null;

  // Transcript buffer — kept so the pane can replay on open.
  private static readonly BUFFER_MAX = 80;
  public transcriptBuffer: TranscriptLine[] = [];
  public toolBuffer: ToolLine[] = [];

  // Pending IDs for partial updates
  private pendingAssistantId: string | null = null;
  private pendingUserId: string | null = null;

  // Listeners registered by VoiceView (or any other subscriber)
  private statusListeners: StatusListener[] = [];
  private transcriptListeners: TranscriptListener[] = [];
  private toolListeners: ToolListener[] = [];

  private lineCounter = 0;

  // Silence watchdog timer — auto-disconnects after configured idle period
  private silenceTimer: ReturnType<typeof setTimeout> | null = null;
  private countdownInterval: ReturnType<typeof setInterval> | null = null;
  private silenceSecsLeft = 0;

  constructor(plugin: VoicePlugin) {
    this.plugin = plugin;
    this.app = plugin.app;
  }

  // ── Listener registration ────────────────────────────────────────────────

  /** Returns an unsubscribe function. */
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

  // ── Workspace tracking ───────────────────────────────────────────────────

  /** Call once from plugin.onload() to keep lastMarkdownView current. */
  startTrackingActiveFile(): void {
    this.plugin.registerEvent(
      this.app.workspace.on('active-leaf-change', (leaf) => {
        if (leaf?.view instanceof MarkdownView && leaf.view.file) {
          this.lastMarkdownView = leaf.view;
        }
      })
    );
    // Seed with whatever is open right now.
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
    // Stop wake word while real session is active.
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
            // Start the silence watchdog — resets on any user/assistant activity.
            this.resetSilenceTimer();
            // Wire notification bridge.
            if (this.notificationBridge && this.session) {
              const ct = (this.app as any)?.plugins?.plugins?.['claude-threads'] as Record<string, unknown> | null;
              const manager = ct?.manager as Parameters<NotificationBridge['connect']>[0] | undefined;
              if (manager) {
                this.notificationBridge.connect(manager, this.session, this.plugin.settings.debugLogging);
              }
            }
            // Show what file was captured as context.
            if (view?.file) {
              const chars = docContent.length.toLocaleString();
              this.emitToolEvent(`Context snapshot: ${view.file.name} · ${chars} chars`, true);
            } else {
              this.emitToolEvent('Context snapshot: no document open', true);
            }
            // Report context files loaded.
            if (loadedCount > 0) {
              this.emitToolEvent(`Context files: ${loadedCount} file${loadedCount !== 1 ? 's' : ''} loaded`, true);
            }
            if (failedPaths.length > 0) {
              this.emitToolEvent(`Context files: could not load — ${failedPaths.join(', ')}`, true);
            }
          } else if (status === 'idle' || status === 'error') {
            this.isConnected = false;
            this.clearSilenceTimer();
            this.notificationBridge?.disconnect();
            this.notificationBridge = null;
            this.session = null;
            this.syncWakeWordDetector();
          }
          this.emitStatus(status);
        },

        onSpeechStarted: () => {
          this.clearSilenceTimer();
          this.emitStatus('connected');
        },

        onSpeechStopped: () => {
          // User finished — start the watchdog; AI may still pick up the speech.
          this.resetSilenceTimer();
        },

        onResponseStarted: () => {
          this.clearSilenceTimer();
          this.emitStatus('connected');
        },

        onAudioDone: () => {
          // AI finished streaming audio — genuine silence begins now.
          this.resetSilenceTimer();
        },

        onTranscript: (role, text, done) => {
          this.handleTranscript(role, text, done);
        },

        onToolCall: (callId, name, argsJson) => {
          this.resetSilenceTimer(); // tool activity also counts as interaction
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
            result = 'Disconnecting voice session.';
            setTimeout(() => this.doDisconnect(), 3000);
          } else if (name === 'voice_wait') {
            const secs = Math.min(Math.max(1, Number(args.seconds) || 5), 300);
            await new Promise((r) => setTimeout(r, secs * 1000));
            result = `Waited ${secs} second${secs !== 1 ? 's' : ''}.${args.reason ? ' ' + String(args.reason) : ''}`;
          } else if (CLAUDE_THREADS_TOOL_NAMES.has(name)) {
            result = await executeClaudeThreadsTool(name, args, this.app, this.notificationBridge);
          } else {
            result = await executeToolCall(name, args, this.app, this.lastMarkdownView);
          }

          // Update the in-progress pill to final.
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
    if (this.isConnected) this.playChime('disconnect');
    this.session?.disconnect();
    this.session = null;
    this.isConnected = false;
    this.syncWakeWordDetector();
    this.emitStatus('idle');
  }

  // ── Wake word ────────────────────────────────────────────────────────────

  syncWakeWordDetector(): void {
    const { wakeWordEnabled, wakeWordThreshold, debugLogging } = this.plugin.settings;

    // Stop any existing detector first.
    if (this.wakeDetector) {
      this.wakeDetector.stop();
      this.wakeDetector = null;
    }

    if (!wakeWordEnabled || this.isConnected || this.plugin.wakeDetectorSuspended) {
      this.emitStatus('idle');
      return;
    }

    // Resolve absolute path to plugin directory so the ONNX models can be read.
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
        // Show a transient notice while assets download on first use.
        if (!downloadNotice) downloadNotice = new Notice(msg, 0);
        else downloadNotice.setMessage(msg);
        if (msg === 'Loading models…') {
          setTimeout(() => { downloadNotice?.hide(); downloadNotice = null; }, 2000);
        }
      },
    );
    this.wakeDetector.start();
    this.emitStatus('idle'); // refreshes label in status bar / pane
  }

  isWakeWordActive(): boolean {
    return this.wakeDetector?.isActive() ?? false;
  }

  /**
   * Stop the wake word detector without affecting session state. Used when
   * the vault window loses focus (main.ts blur handler) or during enrollment.
   * Keeps the WakeWordDetector instance alive so ONNX models stay in memory.
   */
  stopWakeDetector(): void {
    this.wakeDetector?.stop();
    this.emitStatus('idle');
  }

  /**
   * Resume the wake word detector after a focus/blur pause.
   * Fast path: if a stopped detector instance already exists (models loaded),
   * just restart audio capture. Falls back to syncWakeWordDetector() only
   * when no instance is cached.
   */
  activateWakeDetector(): void {
    if (this.wakeDetector && !this.isConnected && !this.plugin.wakeDetectorSuspended) {
      this.wakeDetector.start(); // reuses loaded models — no popup
      this.emitStatus('idle');
      return;
    }
    this.syncWakeWordDetector();
  }

  // ── Silence watchdog ─────────────────────────────────────────────────────

  /** Start (or restart) the inactivity watchdog. No-op if silenceTimeoutSecs is 0. */
  private resetSilenceTimer(): void {
    this.clearSilenceTimer();
    const secs = this.plugin.settings.silenceTimeoutSecs;
    if (!secs) return; // 0 = disabled

    this.silenceSecsLeft = secs;
    this.emitStatus('connected');

    // Tick every second to keep the countdown live in the status bar.
    this.countdownInterval = setInterval(() => {
      this.silenceSecsLeft = Math.max(0, this.silenceSecsLeft - 1);
      this.emitStatus('connected');
    }, 1000);

    this.silenceTimer = setTimeout(() => {
      if (!this.isConnected) return;
      this.clearCountdownInterval();
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
    this.clearCountdownInterval();
  }

  private clearCountdownInterval(): void {
    if (this.countdownInterval !== null) {
      clearInterval(this.countdownInterval);
      this.countdownInterval = null;
    }
  }

  // ── Destroy ──────────────────────────────────────────────────────────────

  destroy(): void {
    this.clearSilenceTimer();
    this.wakeDetector?.stop();
    this.wakeDetector = null;
    this.session?.disconnect();
    this.session = null;
    this.isConnected = false;
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  private nextId(): string {
    return String(++this.lineCounter);
  }

  private emitStatus(status: SessionStatus): void {
    this.currentStatus = status;
    for (const fn of this.statusListeners) fn(status);
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

  /** Emit a tool pill. Pass `callId` to allow later update to the same pill. */
  private emitToolEvent(text: string, final: boolean, callId?: string): void {
    const id = callId ?? this.nextId();

    // Upsert in tool buffer.
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
    return !!((this.app as any)?.plugins?.plugins?.['claude-threads']);
  }

  /**
   * Reads each path in settings.contextFiles from the vault and returns
   * labeled <context> blocks for injection into the system prompt.
   */
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
        'Use ct_new_thread to start a fresh agent and ct_send_message to reply in an existing thread. ' +
        'IMPORTANT: When wait=true (default) the tool blocks until the agent finishes and returns the result directly. ' +
        'When wait=false, the thread runs in the background — and because watch=true by default, ' +
        'you will automatically receive a spoken notification when it finishes. ' +
        'You can also call ct_watch/ct_unwatch at any time to control which threads send you notifications. ' +
        'When you receive a proactive notification about a thread, acknowledge it naturally in your response.';
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
      case 'voice_disconnect':   return 'Disconnecting…';
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
      case 'voice_disconnect': return 'Disconnecting…';
      case 'voice_wait':       return result;
      default:                 return isError ? `${name} failed` : name;
    }
  }

  // ── Audio feedback ───────────────────────────────────────────────────────

  /**
   * Play a short synthesised chime using the Web Audio API.
   * connect    → ascending two-note chime  (C5 → G5, 35% volume)
   * disconnect → descending two-note chime (G5 → C5, 22% volume)
   */
  private playChime(type: 'connect' | 'disconnect'): void {
    try {
      const ctx = new AudioContext();
      const master = ctx.createGain();
      master.gain.value = type === 'connect' ? 0.35 : 0.22;
      master.connect(ctx.destination);

      // Each note: freq (Hz), start offset (s), total duration (s)
      const notes: [number, number, number][] =
        type === 'connect'
          ? [[523.25, 0, 0.18], [783.99, 0.13, 0.22]] // C5 → G5
          : [[783.99, 0, 0.14], [523.25, 0.1,  0.22]]; // G5 → C5

      for (const [freq, offset, dur] of notes) {
        const osc = ctx.createOscillator();
        const env = ctx.createGain();
        osc.connect(env);
        env.connect(master);
        osc.type = 'sine';
        osc.frequency.value = freq;
        const t = ctx.currentTime + offset;
        env.gain.setValueAtTime(0, t);
        env.gain.linearRampToValueAtTime(1, t + 0.008); // fast attack
        env.gain.exponentialRampToValueAtTime(0.001, t + dur); // natural decay
        osc.start(t);
        osc.stop(t + dur);
      }

      // Release the AudioContext once both notes have finished.
      setTimeout(() => ctx.close(), 800);
    } catch {
      // AudioContext unavailable — skip silently
    }
  }
}
