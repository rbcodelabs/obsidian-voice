import { ItemView, MarkdownView, WorkspaceLeaf } from 'obsidian';
import type VoicePlugin from './main';
import type { SessionStatus } from './RealtimeSession';
import type { TranscriptLine, ToolLine } from './VoiceController';

export const VOICE_VIEW_TYPE = 'obsidian-voice:panel';

export class VoiceView extends ItemView {
  private plugin: VoicePlugin;

  // UI elements
  private statusDot!: HTMLElement;
  private statusText!: HTMLElement;
  private connectBtn!: HTMLButtonElement;
  private contextBanner!: HTMLElement;
  private transcriptContainer!: HTMLElement;

  // DOM references keyed by transcript/tool line ID so we can update in place.
  private lineEls = new Map<string, HTMLElement>();

  // Unsubscribe functions returned by controller.on*
  private unsubs: Array<() => void> = [];

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

    // Header: status indicator row + full-width connect button
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
      this.app.workspace.on('active-leaf-change', (leaf) => {
        if (leaf?.view instanceof MarkdownView && leaf.view.file) {
          // The controller already tracks this; we just need to refresh the banner.
        }
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
      this.plugin.controller.onTranscript((line) => this.renderTranscriptLine(line)),
      this.plugin.controller.onToolEvent((tool) => this.renderToolLine(tool)),
    );

    // Render current status.
    this.updateStatus(this.plugin.controller.currentStatus);
  }

  async onClose(): Promise<void> {
    for (const unsub of this.unsubs) unsub();
    this.unsubs = [];
    this.lineEls.clear();
  }

  /** Delegate to controller — kept for backward compat with any callers. */
  async toggleConnection(): Promise<void> {
    return this.plugin.controller.toggleConnection();
  }

  /** Delegate to controller — kept for backward compat with main.ts focus/blur path. */
  stopWakeDetector(): void {
    this.plugin.controller.stopWakeDetector();
  }

  /** Delegate to controller — kept for backward compat with main.ts focus/blur path. */
  activateWakeDetector(): void {
    this.plugin.controller.activateWakeDetector();
  }

  /** Delegate to controller — kept for backward compat with settings tab. */
  syncWakeWordDetector(): void {
    this.plugin.controller.syncWakeWordDetector();
  }

  // ── Private rendering helpers ────────────────────────────────────────────

  private updateContextBanner(): void {
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
    const isListening = !ctrl.isConnected && ctrl.isWakeWordActive();
    const isFocusPaused = !ctrl.isConnected &&
      this.plugin.settings.wakeWordEnabled &&
      this.plugin.wakeDetectorSuspended;

    const labels: Record<SessionStatus, string> = {
      idle: isListening
        ? `Listening for "${this.plugin.settings.wakeWord}"…`
        : isFocusPaused
        ? 'Wake word paused — window not in focus'
        : 'Idle',
      connecting: 'Connecting…',
      connected:  ctrl.isConnected ? 'Connected' : 'Idle',
      error:      'Error',
    };

    const dotClasses: Record<SessionStatus, string> = {
      idle:       isListening ? 'voice-status__dot--listening' : 'voice-status__dot--idle',
      connecting: 'voice-status__dot--connecting',
      connected:  'voice-status__dot--connected',
      error:      'voice-status__dot--error',
    };

    this.statusText.textContent = labels[status];

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

    // Keep connect button label in sync.
    this.connectBtn.textContent = ctrl.isConnected ? 'Disconnect' : 'Connect';
  }

  private renderTranscriptLine(line: TranscriptLine): void {
    const existing = this.lineEls.get(line.id);
    if (existing) {
      // Update text in place.
      const textEl = existing.querySelector('.voice-msg__text');
      if (textEl) textEl.textContent = line.text;
    } else {
      // Create a new message element.
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

  private scrollToBottom(): void {
    this.transcriptContainer.scrollTop = this.transcriptContainer.scrollHeight;
  }
}
