import { ItemView, MarkdownView, Notice, WorkspaceLeaf } from 'obsidian';
import type VoicePlugin from './main';
import { RealtimeSession, SessionStatus } from './RealtimeSession';
import { DOCUMENT_TOOLS, executeToolCall } from './DocumentTools';
import { CLAUDE_THREADS_TOOLS, CLAUDE_THREADS_TOOL_NAMES, executeClaudeThreadsTool } from './ClaudeThreadsTools';
import { NotificationBridge } from './NotificationBridge';
import { OPENAI_SECRET_ID, REALTIME_MODEL } from './settings';
import { WakeWordDetector } from './WakeWordDetector';

export const VOICE_VIEW_TYPE = 'obsidian-voice:panel';

const VOICE_CONTROL_TOOLS = [
  {
    type: 'function',
    name: 'voice_disconnect',
    description: 'Disconnect the voice session. Use when the user says goodbye, asks to stop, or wants to end the conversation.',
    parameters: { type: 'object', properties: {}, required: [] },
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

interface TranscriptEntry {
  role: 'user' | 'assistant' | 'tool';
  text: string;
  el: HTMLElement;
}

export class VoiceView extends ItemView {
  private plugin: VoicePlugin;
  private session: RealtimeSession | null = null;
  private isConnected = false;
  private notificationBridge: NotificationBridge | null = null;
  // Tracks the last markdown tab the user focused. Stays populated even when
  // the Voice panel itself is active, so Connect always targets the document
  // you were just looking at.
  private lastMarkdownView: MarkdownView | null = null;

  // Wake word
  private wakeDetector: WakeWordDetector | null = null;

  private silenceTimer: ReturnType<typeof setTimeout> | null = null;
  private countdownInterval: ReturnType<typeof setInterval> | null = null;

  // Real-time session activity — drives the status label while connected
  private sessionActivity: 'listening' | 'user-speaking' | 'ai-responding' | 'silence' = 'listening';
  private silenceSecsLeft = 0;

  // UI elements
  private statusDot!: HTMLElement;
  private statusText!: HTMLElement;
  private connectBtn!: HTMLButtonElement;
  private contextBanner!: HTMLElement;
  private transcriptContainer!: HTMLElement;

  // Transcript state
  private entries: TranscriptEntry[] = [];
  private pendingAssistant: TranscriptEntry | null = null;
  private pendingUser: TranscriptEntry | null = null;
  private pendingToolEls = new Map<string, HTMLElement>();

  constructor(leaf: WorkspaceLeaf, plugin: VoicePlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VOICE_VIEW_TYPE;
  }

  getDisplayText(): string {
    return 'Voice';
  }

  getIcon(): string {
    return 'mic';
  }

  async onOpen(): Promise<void> {
    const root = this.containerEl.children[1] as HTMLElement;
    root.empty();
    root.addClass('voice-panel');

    // Header: status indicator row + full-width connect button (separate rows
    // so the status text never competes for space with the button).
    const header = root.createDiv({ cls: 'voice-header' });
    const statusBar = header.createDiv({ cls: 'voice-status' });
    this.statusDot = statusBar.createSpan({ cls: 'voice-status__dot' });
    this.statusText = statusBar.createSpan({ cls: 'voice-status__text', text: 'Idle' });
    this.connectBtn = header.createEl('button', {
      cls: 'voice-connect-btn',
      text: 'Connect',
    });
    this.connectBtn.addEventListener('click', () => this.handleConnectToggle());

    // Context banner — shows which file will be sent as context
    this.contextBanner = root.createDiv({ cls: 'voice-context-banner' });

    // Seed the tracker with whatever is already active when the panel opens.
    // getActiveViewOfType works here because we haven't stolen focus yet.
    this.lastMarkdownView = this.app.workspace.getActiveViewOfType(MarkdownView);
    this.updateContextBanner();

    // Keep the tracker current as the user navigates tabs.
    // When focus moves to the Voice panel the leaf is not a MarkdownView, so
    // we leave lastMarkdownView alone — the previous document stays tracked.
    this.registerEvent(
      this.app.workspace.on('active-leaf-change', (leaf) => {
        if (leaf?.view instanceof MarkdownView && leaf.view.file) {
          this.lastMarkdownView = leaf.view as MarkdownView;
        }
        this.updateContextBanner();
      })
    );

    // Transcript container
    this.transcriptContainer = root.createDiv({ cls: 'voice-transcript' });

    this.updateStatus('idle');

    // Start wake word detector if enabled
    this.syncWakeWordDetector();
  }

  async onClose(): Promise<void> {
    this.clearSilenceTimer();
    this.wakeDetector?.stop();
    this.wakeDetector = null;
    this.session?.disconnect();
    this.session = null;
    this.isConnected = false;
  }

  async toggleConnection(): Promise<void> {
    if (this.isConnected) {
      this.doDisconnect();
    } else {
      await this.doConnect();
    }
  }

  /** Stop the wake word detector without affecting session state. Used by enrollment. */
  stopWakeDetector(): void {
    this.wakeDetector?.stop();
    this.wakeDetector = null;
    this.updateStatus('idle'); // refresh label to show suspended state if applicable
  }

  /**
   * Called by main.ts whenever wakeWordEnabled or wakeWord changes in settings,
   * and from onOpen after the UI is ready.
   */
  syncWakeWordDetector(): void {
    const { wakeWordEnabled, debugLogging } = this.plugin.settings;

    // Stop any existing detector first
    if (this.wakeDetector) {
      this.wakeDetector.stop();
      this.wakeDetector = null;
    }

    if (!wakeWordEnabled || this.isConnected || this.plugin.wakeDetectorSuspended) {
      this.updateStatus('idle');
      return;
    }

    // Resolve absolute path to plugin directory so the ONNX models can be read.
    const adapter = this.plugin.app.vault.adapter as { basePath?: string };
    const modelDir = adapter.basePath && this.plugin.manifest.dir
      ? `${adapter.basePath}/${this.plugin.manifest.dir}`
      : (this.plugin.manifest.dir ?? '');

    let downloadNotice: Notice | null = null;
    this.wakeDetector = new WakeWordDetector(
      modelDir,
      () => {
        if (debugLogging) {
          console.log('[Voice] Wake word detected — auto-connecting');
        }
        this.addToolEvent('Wake word detected: "hey obsidian" — connecting…');
        void this.doConnect();
      },
      debugLogging,
      this.plugin.settings.wakeWordThreshold,
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
    this.updateStatus('idle'); // refresh label — updateStatus reads wakeDetector.isActive()
  }

  private async handleConnectToggle(): Promise<void> {
    return this.toggleConnection();
  }

  private async doConnect(): Promise<void> {
    // Stop wake word detection while the real session is active
    if (this.wakeDetector) {
      this.wakeDetector.stop();
      this.wakeDetector = null;
    }

    const { voice, systemPromptExtra } = this.plugin.settings;
    const apiKey = this.plugin.app.secretStorage.getSecret(OPENAI_SECRET_ID);

    if (!apiKey) {
      new Notice('Voice: no OpenAI API key configured. Open Settings to add one.');
      this.syncWakeWordDetector(); // re-arm the detector
      return;
    }

    const view = this.getMarkdownView();
    const docContent = this.getCurrentDocContent();
    const claudeThreadsAvailable = this.isClaudeThreadsAvailable();
    if (claudeThreadsAvailable) {
      this.notificationBridge = new NotificationBridge();
    }
    const systemPrompt = this.buildSystemPrompt(docContent, systemPromptExtra, claudeThreadsAvailable);

    // Merge document tools, Claude Threads tools (when available), and voice control tools
    const allTools = claudeThreadsAvailable
      ? [...DOCUMENT_TOOLS, ...CLAUDE_THREADS_TOOLS, ...VOICE_CONTROL_TOOLS]
      : [...DOCUMENT_TOOLS, ...VOICE_CONTROL_TOOLS];

    this.session = new RealtimeSession();
    this.clearTranscript();
    this.connectBtn.disabled = true;

    await this.session.connect(apiKey, REALTIME_MODEL, voice, systemPrompt, {
      onStatusChange: (status) => {
        this.updateStatus(status);
        if (status === 'connected') {
          this.isConnected = true;
          this.sessionActivity = 'listening';
          this.connectBtn.disabled = false;
          this.connectBtn.textContent = 'Disconnect';
          this.playChime('connect');
          // Start the silence watchdog — resets on any user/assistant activity
          this.resetSilenceTimer();
          // Wire notification bridge now that session is live
          if (this.notificationBridge && this.session) {
            const ct = (this.app as any)?.plugins?.plugins?.['claude-threads'] as Record<string, unknown> | null;
            const manager = ct?.manager as Parameters<NotificationBridge['connect']>[0] | undefined;
            if (manager) {
              this.notificationBridge.connect(manager, this.session, this.plugin.settings.debugLogging);
            }
          }
          // Show what file was captured as context
          if (view?.file) {
            const chars = docContent.length.toLocaleString();
            this.addToolEvent(`Context snapshot: ${view.file.name} · ${chars} chars`);
          } else {
            this.addToolEvent('Context snapshot: no document open');
          }
        } else if (status === 'idle' || status === 'error') {
          const wasConnected = this.isConnected;
          this.isConnected = false;
          this.connectBtn.disabled = false;
          this.connectBtn.textContent = 'Connect';
          if (wasConnected) this.playChime('disconnect');
          this.notificationBridge?.disconnect();
          this.notificationBridge = null;
          this.session = null;
          // Re-arm wake word detection now that the session has ended
          this.syncWakeWordDetector();
        }
      },
      onSpeechStarted: () => {
        this.sessionActivity = 'user-speaking';
        this.clearSilenceTimer();
        this.refreshConnectedStatus();
      },
      onSpeechStopped: () => {
        // User finished — wait for AI to pick up; resetSilenceTimer sets
        // activity to 'silence' and starts the countdown.
        this.resetSilenceTimer();
      },
      onResponseStarted: () => {
        this.sessionActivity = 'ai-responding';
        this.clearSilenceTimer();
        this.refreshConnectedStatus();
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
        const el = this.addToolEvent(label);
        this.pendingToolEls.set(callId, el);
      },
      onError: (msg) => {
        new Notice(`Voice error: ${msg}`);
        this.addToolEvent(`Error: ${msg}`);
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
        // Update the pill with outcome
        const el = this.pendingToolEls.get(callId);
        if (el) {
          el.textContent = this.formatToolResult(name, argsJson, result);
          this.pendingToolEls.delete(callId);
        }
        return result;
      },
    }, allTools, this.plugin.settings.debugLogging);
  }

  /** Start (or restart) the inactivity watchdog using the current setting. No-op if timeout is 0. */
  private resetSilenceTimer(): void {
    this.clearSilenceTimer();
    const secs = this.plugin.settings.silenceTimeoutSecs;
    if (!secs) return; // 0 = disabled

    this.sessionActivity = 'silence';
    this.silenceSecsLeft = secs;
    this.refreshConnectedStatus();

    // Tick every second to keep the countdown live in the status bar
    this.countdownInterval = setInterval(() => {
      this.silenceSecsLeft = Math.max(0, this.silenceSecsLeft - 1);
      this.refreshConnectedStatus();
    }, 1000);

    this.silenceTimer = setTimeout(() => {
      if (!this.isConnected) return;
      this.clearCountdownInterval();
      this.addToolEvent(
        `Disconnected after ${secs}s of silence — say "hey obsidian" to reconnect`
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

  /** Re-render the status label without changing the session status. */
  private refreshConnectedStatus(): void {
    if (this.isConnected) this.updateStatus('connected');
  }

  private doDisconnect(): void {
    this.clearSilenceTimer();
    if (this.isConnected) this.playChime('disconnect');
    this.session?.disconnect();
    this.session = null;
    this.isConnected = false;
    this.connectBtn.textContent = 'Connect';
    this.updateStatus('idle');
    // Re-arm wake word detection
    this.syncWakeWordDetector();
  }

  private getMarkdownView(): MarkdownView | null {
    return this.lastMarkdownView;
  }

  private getCurrentDocContent(): string {
    const view = this.getMarkdownView();
    if (!view) return '(no document currently open)';
    return view.editor.getValue();
  }

  private isClaudeThreadsAvailable(): boolean {
    // app.plugins is an internal Obsidian API not in the TypeScript types.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return !!((this.app as any)?.plugins?.plugins?.['claude-threads']);
  }

  private updateContextBanner(): void {
    const view = this.getMarkdownView();
    this.contextBanner.empty();
    if (view?.file) {
      const charCount = view.editor.getValue().length;
      this.contextBanner.createSpan({ cls: 'voice-context-banner__label', text: 'Context: ' });
      this.contextBanner.createSpan({ cls: 'voice-context-banner__file', text: view.file.name });
      this.contextBanner.createSpan({
        cls: 'voice-context-banner__chars',
        text: ` · ${charCount.toLocaleString()} chars`,
      });
    } else {
      this.contextBanner.createSpan({
        cls: 'voice-context-banner__none',
        text: 'No document open — AI will have no context',
      });
    }
  }

  private buildSystemPrompt(docContent: string, extra: string, hasClaudeThreads = false): string {
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
    if (extra.trim()) {
      prompt += '\n\n' + extra.trim();
    }
    return prompt;
  }

  private updateStatus(status: SessionStatus): void {
    const isListening = !this.isConnected && (this.wakeDetector?.isActive() ?? false);
    // Wake word enabled but window is not focused — detector is paused.
    const isFocusPaused = !this.isConnected &&
      this.plugin.settings.wakeWordEnabled &&
      this.plugin.wakeDetectorSuspended;

    const connectedLabel = (): string => {
      switch (this.sessionActivity) {
        case 'user-speaking':  return 'You\'re speaking…';
        case 'ai-responding':  return 'AI responding…';
        case 'silence':        return `Silence — ${this.silenceSecsLeft}s`;
        default:               return 'Connected';
      }
    };
    const connectedDot = (): string => {
      switch (this.sessionActivity) {
        case 'user-speaking': return 'voice-status__dot--listening';  // accent pulse
        case 'ai-responding': return 'voice-status__dot--connecting'; // yellow pulse
        default:              return 'voice-status__dot--connected';   // static green
      }
    };

    const labels: Record<SessionStatus, string> = {
      idle: isListening
        ? `Listening for "${this.plugin.settings.wakeWord}"…`
        : isFocusPaused
        ? `Wake word paused — window not in focus`
        : 'Idle',
      connecting: 'Connecting…',
      connected: connectedLabel(),
      error: 'Error',
    };
    const dotClasses: Record<SessionStatus, string> = {
      idle: isListening ? 'voice-status__dot--listening' : 'voice-status__dot--idle',
      connecting: 'voice-status__dot--connecting',
      connected: connectedDot(),
      error: 'voice-status__dot--error',
    };

    this.statusText.textContent = labels[status];

    // Remove all status modifier classes then add the right one
    for (const cls of [
      'voice-status__dot--idle',
      'voice-status__dot--listening',
      'voice-status__dot--connecting',
      'voice-status__dot--connected',
      'voice-status__dot--error',
    ]) {
      this.statusDot.removeClass(cls);
    }
    this.statusDot.addClass(dotClasses[status]);
  }

  private handleTranscript(role: 'user' | 'assistant', text: string, done: boolean): void {
    if (role === 'assistant') {
      if (!this.pendingAssistant) {
        const el = this.createMessageEl('assistant', '');
        this.pendingAssistant = { role: 'assistant', text: '', el };
        this.entries.push(this.pendingAssistant);
      }
      if (text) {
        this.pendingAssistant.text += text;
        this.pendingAssistant.el.querySelector('.voice-msg__text')!.textContent =
          this.pendingAssistant.text;
        this.scrollToBottom();
      }
      if (done) {
        this.pendingAssistant = null;
      }
    } else {
      // User transcript arrives complete (done=true always for user)
      if (!this.pendingUser) {
        const el = this.createMessageEl('user', text);
        this.pendingUser = { role: 'user', text, el };
        this.entries.push(this.pendingUser);
        this.scrollToBottom();
      } else {
        this.pendingUser.text = text;
        this.pendingUser.el.querySelector('.voice-msg__text')!.textContent = text;
        this.scrollToBottom();
      }
      if (done) {
        this.pendingUser = null;
      }
    }
  }

  private createMessageEl(role: 'user' | 'assistant', text: string): HTMLElement {
    const wrapper = this.transcriptContainer.createDiv({
      cls: `voice-msg voice-msg--${role}`,
    });
    wrapper.createSpan({ cls: 'voice-msg__label', text: role === 'user' ? 'You' : 'AI' });
    wrapper.createSpan({ cls: 'voice-msg__text', text });
    return wrapper;
  }

  private addToolEvent(label: string): HTMLElement {
    const el = this.transcriptContainer.createDiv({
      cls: 'voice-tool-event',
      text: label,
    });
    this.scrollToBottom();
    return el;
  }

  // Label shown while tool is executing
  private formatToolLabel(name: string, argsJson: string): string {
    let args: Record<string, unknown> = {};
    try { args = JSON.parse(argsJson) as Record<string, unknown>; } catch { /* ok */ }

    switch (name) {
      case 'search_vault':
        return `Searching vault · "${args.query as string ?? ''}"…`;
      case 'open_file':
        return `Opening · ${args.filename as string ?? ''}…`;
      case 'get_document':
        return 'Reading document…';
      case 'append_note':
        return 'Appending note…';
      case 'insert_at_cursor':
        return 'Inserting text…';
      case 'replace_document':
        return 'Replacing document…';
      case 'get_links':
        return 'Getting links…';
      case 'create_document':
        return `Creating document · ${args.path as string ?? ''}…`;
      case 'list_folder':
        return `Listing folder · ${args.path as string || '/'}…`;
      // Claude Threads tools
      case 'ct_send_message':
        return `Sending to thread · "${String(args.message ?? '').slice(0, 40)}"…`;
      case 'ct_new_thread':
        return `Starting new thread · "${String(args.message ?? '').slice(0, 40)}"…`;
      case 'ct_wait_for_thread':
        return `Waiting for thread${args.thread_id ? ` · ${String(args.thread_id).slice(0, 8)}` : ''}…`;
      case 'ct_get_thread':
        return `Reading thread${args.thread_id ? ` · ${String(args.thread_id).slice(0, 8)}` : ''}…`;
      case 'ct_list_threads':
        return args.status && args.status !== 'all'
          ? `Listing ${String(args.status)} threads…`
          : 'Listing threads…';
      case 'ct_open_thread':
        return `Opening thread · ${String(args.thread_id ?? '').slice(0, 8)}…`;
      case 'ct_close_thread':
        return args.thread_id
          ? `Closing thread · ${String(args.thread_id).slice(0, 8)}…`
          : 'Closing active thread…';
      case 'ct_get_active_thread':
        return 'Reading active thread…';
      case 'ct_watch':
        return args.thread_id
          ? `Watching thread · ${String(args.thread_id).slice(0, 8)}…`
          : 'Watching all threads…';
      case 'ct_unwatch':
        return args.thread_id
          ? `Stopped watching · ${String(args.thread_id).slice(0, 8)}…`
          : 'Stopped watching all threads…';
      case 'voice_disconnect':
        return 'Disconnecting…';
      case 'voice_wait':
        return `Waiting ${Number(args.seconds) || 5}s…`;
      default:
        return `${name}…`;
    }
  }

  // Label shown after tool completes
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
      case 'open_file': {
        if (isError) return `File not found · ${args.filename as string ?? ''}`;
        return `Opened · ${args.filename as string ?? ''}`;
      }
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
      case 'create_document': {
        if (isError) return `Create failed · ${args.path as string ?? ''}`;
        return `Created · ${args.path as string ?? ''}`;
      }
      case 'list_folder': {
        if (isError) return `List failed · ${args.path as string || '/'}`;
        const count = (result.match(/\n  /g) ?? []).length;
        return `Listed · ${args.path as string || '/'} · ${count} item${count !== 1 ? 's' : ''}`;
      }
      // Claude Threads tools
      case 'ct_send_message':
        return isError ? 'Send failed' : 'Sent · agent replied';
      case 'ct_new_thread':
        return isError ? 'New thread failed' : 'New thread · agent replied';
      case 'ct_wait_for_thread':
        return isError ? 'Wait failed' : 'Thread finished';
      case 'ct_get_thread': {
        if (isError) return `Read thread failed`;
        return `Read thread${args.thread_id ? ` · ${String(args.thread_id).slice(0, 8)}` : ''}`;
      }
      case 'ct_list_threads': {
        if (isError) return 'List threads failed';
        const countMatch = result.match(/"count":\s*(\d+)/);
        const n = countMatch ? countMatch[1] : '?';
        return `Listed ${n} thread${n !== '1' ? 's' : ''}`;
      }
      case 'ct_open_thread':
        return isError ? 'Open thread failed' : 'Opened thread';
      case 'ct_close_thread':
        return isError ? 'Close thread failed' : 'Thread closed';
      case 'ct_get_active_thread':
        return isError ? 'Read active thread failed' : 'Read active thread';
      case 'ct_watch':
        return isError
          ? 'Watch failed'
          : args.thread_id
            ? `Watching · ${String(args.thread_id).slice(0, 8)}`
            : 'Watching all threads';
      case 'ct_unwatch':
        return isError
          ? 'Unwatch failed'
          : args.thread_id
            ? `Stopped watching · ${String(args.thread_id).slice(0, 8)}`
            : 'Stopped all notifications';
      case 'voice_disconnect':
        return 'Disconnecting…';
      case 'voice_wait':
        return result;
      default:
        return isError ? `${name} failed` : name;
    }
  }

  /**
   * Play a short synthesised chime using the Web Audio API.
   * connect  → ascending two-note chime  (C5 → G5)
   * disconnect → descending two-note chime (G5 → C5), quieter
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
          : [[783.99, 0, 0.14], [523.25, 0.1, 0.22]]; // G5 → C5

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

      // Release the AudioContext once both notes have finished
      setTimeout(() => ctx.close(), 800);
    } catch {
      // AudioContext unavailable — skip sound silently
    }
  }

  private clearTranscript(): void {
    this.transcriptContainer.empty();
    this.entries = [];
    this.pendingAssistant = null;
    this.pendingUser = null;
    this.pendingToolEls.clear();
  }

  private scrollToBottom(): void {
    this.transcriptContainer.scrollTop = this.transcriptContainer.scrollHeight;
  }
}
