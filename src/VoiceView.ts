import { ItemView, MarkdownView, WorkspaceLeaf } from 'obsidian';
import type VoicePlugin from './main';
import type { SessionStatus } from './RealtimeSession';
import type {
  ActivityInfo,
  DisconnectPendingEvent,
  ToolLine,
  TranscriptLine,
} from './VoiceController';

export const VOICE_VIEW_TYPE = 'obsidian-voice:panel';

/**
 * Thin observer of VoiceController. Owns NO session state — just subscribes
 * to controller events and renders the transcript / status / abort UI. The
 * panel can be opened and closed freely without disturbing the live session,
 * which lives on the controller (plugin-level singleton).
 */
export class VoiceView extends ItemView {
  private plugin: VoicePlugin;

  // UI elements
  private statusDot!: HTMLElement;
  private statusText!: HTMLElement;
  private connectBtn!: HTMLButtonElement;
  private contextBanner!: HTMLElement;
  private transcriptContainer!: HTMLElement;

  // DOM nodes keyed by transcript/tool line ID for in-place updates.
  private lineEls = new Map<string, HTMLElement>();

  // Disconnect-pending abort UI is a special transcript element that the
  // controller drives via the onDisconnectPending event stream.
  private disconnectPendingEl: HTMLElement | null = null;
  private disconnectPendingCountdownEl: HTMLElement | null = null;

  // Unsubscribe functions returned by controller.on*
  private unsubs: Array<() => void> = [];

  constructor(leaf: WorkspaceLeaf, plugin: VoicePlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string { return VOICE_VIEW_TYPE; }
  getDisplayText(): string { return 'Voice'; }
  getIcon(): string { return 'mic'; }

  async onOpen(): Promise<void> {
    const root = this.containerEl.children[1] as HTMLElement;
    root.empty();
    root.addClass('voice-panel');

    // Header: status row + full-width connect button
    const header = root.createDiv({ cls: 'voice-header' });
    const statusBar = header.createDiv({ cls: 'voice-status' });
    this.statusDot = statusBar.createSpan({ cls: 'voice-status__dot' });
    this.statusText = statusBar.createSpan({ cls: 'voice-status__text', text: 'Idle' });
    this.connectBtn = header.createEl('button', {
      cls: 'voice-connect-btn',
      text: this.plugin.controller.isConnected ? 'Disconnect' : 'Connect',
    });
    this.connectBtn.addEventListener('click', () => this.plugin.controller.toggleConnection());

    // Context banner — shows which file will be sent as context
    this.contextBanner = root.createDiv({ cls: 'voice-context-banner' });
    this.updateContextBanner();

    // Keep the context banner current as the user navigates tabs.
    this.registerEvent(
      this.app.workspace.on('active-leaf-change', () => {
        this.updateContextBanner();
      })
    );

    // Transcript container
    this.transcriptContainer = root.createDiv({ cls: 'voice-transcript' });

    // Replay any buffered transcript/tool lines from before the pane was opened.
    for (const line of this.plugin.controller.transcriptBuffer) {
      this.renderTranscriptLine(line);
    }
    for (const tool of this.plugin.controller.toolBuffer) {
      this.renderToolLine(tool);
    }
    this.scrollToBottom();

    // Subscribe to live controller events.
    this.unsubs.push(
      this.plugin.controller.onStatusChange((status) => this.updateStatus(status)),
      this.plugin.controller.onActivityChange(() => this.updateStatus(this.plugin.controller.currentStatus)),
      this.plugin.controller.onTranscript((line) => this.renderTranscriptLine(line)),
      this.plugin.controller.onToolEvent((tool) => this.renderToolLine(tool)),
      this.plugin.controller.onDisconnectPending((evt) => this.handleDisconnectPendingEvent(evt)),
    );

    // Render current status.
    this.updateStatus(this.plugin.controller.currentStatus);
  }

  async onClose(): Promise<void> {
    for (const unsub of this.unsubs) unsub();
    this.unsubs = [];
    this.lineEls.clear();
    this.disconnectPendingEl = null;
    this.disconnectPendingCountdownEl = null;
  }

  // ── Backward-compat delegates ────────────────────────────────────────────

  async toggleConnection(): Promise<void> {
    return this.plugin.controller.toggleConnection();
  }

  stopWakeDetector(): void {
    this.plugin.controller.stopWakeDetector();
  }

  activateWakeDetector(): void {
    this.plugin.controller.activateWakeDetector();
  }

  syncWakeWordDetector(): void {
    this.plugin.controller.syncWakeWordDetector();
  }

  // ── Status rendering ─────────────────────────────────────────────────────

  private updateContextBanner(): void {
    if (!this.contextBanner) return;
    const view = this.plugin.controller.lastMarkdownView;
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

  private updateStatus(status: SessionStatus): void {
    const ctrl = this.plugin.controller;
    const activity = ctrl.getActivityInfo();
    const isListening = !ctrl.isConnected && ctrl.isWakeWordActive();
    const isFocusPaused = !ctrl.isConnected &&
      this.plugin.settings.wakeWordEnabled &&
      this.plugin.wakeDetectorSuspended;

    const connectedLabel = (): string => {
      switch (activity.activity) {
        case 'user-speaking':       return 'You\'re speaking…';
        case 'ai-responding':       return 'AI responding…';
        case 'tool-running':        return 'AI working…';
        case 'silence':             return `Silence — ${activity.silenceSecsLeft ?? 0}s`;
        case 'disconnect-pending':  return `Disconnecting in ${activity.disconnectPendingSecsLeft ?? 0}s · click Stay`;
        case 'listening':           return 'Listening';
        default:                    return 'Connected';
      }
    };
    const connectedDot = (): string => {
      switch (activity.activity) {
        case 'user-speaking':       return 'voice-status__dot--listening';
        case 'ai-responding':       return 'voice-status__dot--connecting';
        case 'tool-running':        return 'voice-status__dot--connecting';
        case 'disconnect-pending':  return 'voice-status__dot--error';
        default:                    return 'voice-status__dot--connected';
      }
    };

    const labels: Record<SessionStatus, string> = {
      idle: isListening
        ? `Listening for "${this.plugin.settings.wakeWord}"…`
        : isFocusPaused
        ? 'Wake word paused — window not in focus'
        : 'Idle',
      connecting: 'Connecting…',
      connected:  ctrl.isConnected ? connectedLabel() : 'Idle',
      error:      'Error',
    };

    const dotClasses: Record<SessionStatus, string> = {
      idle:       isListening ? 'voice-status__dot--listening' : 'voice-status__dot--idle',
      connecting: 'voice-status__dot--connecting',
      connected:  ctrl.isConnected ? connectedDot() : 'voice-status__dot--idle',
      error:      'voice-status__dot--error',
    };

    if (this.statusText) this.statusText.textContent = labels[status];

    if (this.statusDot) {
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

    if (this.connectBtn) {
      this.connectBtn.textContent = ctrl.isConnected ? 'Disconnect' : 'Connect';
      this.connectBtn.disabled = status === 'connecting';
    }
  }

  // ── Transcript rendering ─────────────────────────────────────────────────

  private renderTranscriptLine(line: TranscriptLine): void {
    if (!this.transcriptContainer) return;
    const existing = this.lineEls.get(line.id);
    if (existing) {
      const textEl = existing.querySelector('.voice-msg__text');
      if (textEl) textEl.textContent = line.text;
    } else {
      const wrapper = this.transcriptContainer.createDiv({
        cls: `voice-msg voice-msg--${line.role}`,
      });
      wrapper.createSpan({ cls: 'voice-msg__label', text: line.role === 'user' ? 'You' : 'AI' });
      wrapper.createSpan({ cls: 'voice-msg__text', text: line.text });
      this.lineEls.set(line.id, wrapper);
      this.scrollToBottom();
    }
  }

  private renderToolLine(tool: ToolLine): void {
    if (!this.transcriptContainer) return;
    const existing = this.lineEls.get(tool.id);
    if (existing) {
      existing.textContent = tool.text;
    } else {
      const el = this.transcriptContainer.createDiv({
        cls: 'voice-tool-event',
        text: tool.text,
      });
      this.lineEls.set(tool.id, el);
      this.scrollToBottom();
    }
  }

  // ── Disconnect-pending abort UI ──────────────────────────────────────────

  private handleDisconnectPendingEvent(evt: DisconnectPendingEvent): void {
    if (!this.transcriptContainer) return;

    if (evt.kind === 'started') {
      // Build a fresh abort UI block.
      const wrapper = this.transcriptContainer.createDiv({ cls: 'voice-disconnect-pending' });
      wrapper.createDiv({
        cls: 'voice-disconnect-pending__title',
        text: 'AI requested to end the session',
      });
      wrapper.createDiv({
        cls: 'voice-disconnect-pending__meta',
        text: `Reason: ${evt.reason}`,
      });
      if (evt.phrase && evt.phrase !== '(no phrase captured)') {
        wrapper.createDiv({
          cls: 'voice-disconnect-pending__meta',
          text: `Heard: "${evt.phrase}"`,
        });
      }
      const countdownEl = wrapper.createDiv({
        cls: 'voice-disconnect-pending__countdown',
        text: `Disconnecting in ${evt.graceSecs}s…`,
      });
      const btn = wrapper.createEl('button', {
        cls: 'voice-disconnect-pending__stay-btn',
        text: 'Stay connected',
      });
      btn.addEventListener('click', () => {
        this.plugin.controller.cancelDisconnectPending('stay_button', /* injectMessage */ true);
      });
      this.disconnectPendingEl = wrapper;
      this.disconnectPendingCountdownEl = countdownEl;
      this.scrollToBottom();
    } else if (evt.kind === 'tick') {
      if (this.disconnectPendingCountdownEl) {
        this.disconnectPendingCountdownEl.textContent = `Disconnecting in ${evt.secsLeft}s…`;
      }
    } else if (evt.kind === 'resolved') {
      if (this.disconnectPendingEl) {
        const btn = this.disconnectPendingEl.querySelector('.voice-disconnect-pending__stay-btn');
        btn?.remove();
        if (this.disconnectPendingCountdownEl) {
          this.disconnectPendingCountdownEl.textContent = evt.finalText;
          this.disconnectPendingCountdownEl.classList.add('voice-disconnect-pending__countdown--final');
        }
      }
      this.disconnectPendingEl = null;
      this.disconnectPendingCountdownEl = null;
    }
  }

  private scrollToBottom(): void {
    if (this.transcriptContainer) {
      this.transcriptContainer.scrollTop = this.transcriptContainer.scrollHeight;
    }
  }
}
