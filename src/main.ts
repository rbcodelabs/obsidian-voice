import { Menu, Plugin, WorkspaceLeaf } from 'obsidian';
import { VoiceView, VOICE_VIEW_TYPE } from './VoiceView';
import { VoiceController } from './VoiceController';
import { VoiceSettings, DEFAULT_SETTINGS, VoiceSettingTab, OPENAI_SECRET_ID } from './settings';
import type { SessionStatus } from './RealtimeSession';

export default class VoicePlugin extends Plugin {
  settings!: VoiceSettings;
  controller!: VoiceController;
  wakeDetectorSuspended = false;

  // Status bar UI elements
  private statusBarItem!: HTMLElement;
  private statusBarDot!: HTMLElement;
  private statusBarText!: HTMLElement;

  async onload() {
    await this.loadSettings();

    // Create the plugin-level controller (independent of any pane).
    this.controller = new VoiceController(this);
    this.controller.startTrackingActiveFile();

    // Start wake word detector once the workspace is fully ready.
    this.app.workspace.onLayoutReady(() => {
      this.controller.syncWakeWordDetector();
    });

    // Register the pane view.
    this.registerView(VOICE_VIEW_TYPE, (leaf) => new VoiceView(leaf, this));

    // Ribbon icon — opens the transcript pane.
    this.addRibbonIcon('mic', 'Voice — open panel', () => this.activateView());

    // Status bar item — shows live status and opens a menu on click.
    this.statusBarItem = this.addStatusBarItem();
    this.statusBarItem.addClass('voice-statusbar-item');
    this.statusBarItem.setAttribute('aria-label', 'Voice: click to connect / disconnect');
    this.statusBarItem.setAttribute('title', 'Voice: click to connect / disconnect');

    this.statusBarDot  = this.statusBarItem.createSpan({ cls: 'voice-statusbar-dot voice-statusbar-dot--idle' });
    this.statusBarText = this.statusBarItem.createSpan({ cls: 'voice-statusbar-text', text: 'Voice' });

    this.statusBarItem.addEventListener('click', (evt) => this.showStatusBarMenu(evt));

    // Keep the status bar in sync with controller events.
    this.controller.onStatusChange((status) => this.updateStatusBar(status));

    // Commands
    this.addCommand({
      id: 'open-voice-panel',
      name: 'Open Voice panel',
      callback: () => this.activateView(),
    });

    this.addCommand({
      id: 'toggle-voice-connection',
      name: 'Toggle Voice connection',
      callback: () => this.controller.toggleConnection(),
    });

    this.addCommand({
      id: 'toggle-wake-word',
      name: 'Toggle wake word listening',
      callback: () => this.toggleWakeWord(),
    });

    this.addSettingTab(new VoiceSettingTab(this.app, this));

    // Only the focused vault window should listen for wake words.
    // Each vault is its own Electron BrowserWindow; focus/blur fire when the
    // user switches between them. registerDomEvent auto-removes on unload.
    this.registerDomEvent(window, 'blur',  () => this.suspendWakeDetector());
    this.registerDomEvent(window, 'focus', () => this.resumeWakeDetector());
    // If this vault window isn't currently focused (e.g. opened in background
    // by BRAT), start with the detector already suspended.
    if (!document.hasFocus()) this.wakeDetectorSuspended = true;
  }

  async onunload() {
    this.controller.destroy();
    // Detach all Voice panel leaves on unload so Obsidian doesn't keep a
    // stale VoiceView instance alive across plugin reloads or BRAT updates.
    // Without this, the old view object stays in the leaf and new code that
    // calls methods added in the update (e.g. stopWakeDetector) crashes with
    // "is not a function". The panel reopens automatically via activateView()
    // the next time the user clicks the ribbon icon or uses the hotkey.
    this.app.workspace.detachLeavesOfType(VOICE_VIEW_TYPE);
  }

  /** Called from the settings tab whenever wakeWordEnabled or wakeWord changes. */
  applyWakeWordSetting(): void {
    this.controller.syncWakeWordDetector();
  }

  suspendWakeDetector(): void {
    this.wakeDetectorSuspended = true;
    this.controller.stopWakeDetector();
  }

  resumeWakeDetector(): void {
    this.wakeDetectorSuspended = false;
    this.controller.activateWakeDetector();
  }

  async activateView() {
    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(VOICE_VIEW_TYPE)[0] ?? null;
    if (!leaf) {
      leaf = workspace.getRightLeaf(false) ?? workspace.getLeaf('split', 'vertical');
      await leaf.setViewState({ type: VOICE_VIEW_TYPE, active: true });
    }
    workspace.revealLeaf(leaf);
  }

  async loadSettings() {
    const data = await this.loadData();

    // One-time migration: move API key from data.json into SecretStorage.
    if (data?.openaiApiKey) {
      this.app.secretStorage.setSecret(OPENAI_SECRET_ID, data.openaiApiKey);
      delete data.openaiApiKey;
      await this.saveData(data);
    }

    // Clean up any garbage written by SecretComponent (stores key name, not value).
    // If the stored value doesn't look like an OpenAI key, wipe it so the
    // settings UI shows "No key set" rather than a confusing masked garbage value.
    const storedKey = this.app.secretStorage.getSecret(OPENAI_SECRET_ID);
    if (storedKey && !storedKey.startsWith('sk-')) {
      this.app.secretStorage.setSecret(OPENAI_SECRET_ID, '');
    }

    this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  // ── Status bar menu ──────────────────────────────────────────────────────

  private showStatusBarMenu(evt: MouseEvent): void {
    const menu = new Menu();
    const connected = this.controller.isConnected;

    // Connect / Disconnect
    menu.addItem((item) =>
      item
        .setTitle(connected ? 'Disconnect' : 'Connect')
        .setIcon(connected ? 'mic-off' : 'mic')
        .onClick(() => this.controller.toggleConnection()),
    );

    menu.addSeparator();

    // Wake word toggle
    const wakeEnabled = this.settings.wakeWordEnabled;
    menu.addItem((item) =>
      item
        .setTitle(wakeEnabled ? 'Disable wake word' : 'Enable wake word')
        .setIcon(wakeEnabled ? 'volume-x' : 'volume-2')
        .onClick(() => this.toggleWakeWord()),
    );

    menu.addSeparator();

    // Open transcript pane
    menu.addItem((item) =>
      item
        .setTitle('Open Voice panel')
        .setIcon('layout-panel-right')
        .onClick(() => this.activateView()),
    );

    menu.showAtMouseEvent(evt);
  }

  private async toggleWakeWord(): Promise<void> {
    this.settings.wakeWordEnabled = !this.settings.wakeWordEnabled;
    await this.saveSettings();
    this.controller.syncWakeWordDetector();
    // Refresh status bar dot (listening vs idle state may change).
    this.updateStatusBar(
      this.controller.isConnected ? 'connected' : 'idle',
    );
  }

  // ── Status bar rendering ─────────────────────────────────────────────────

  private updateStatusBar(status: SessionStatus): void {
    const isListening = !this.controller.isConnected && this.controller.isWakeWordActive();

    const labels: Record<SessionStatus, string> = {
      idle:       isListening ? 'Listening…' : 'Voice',
      connecting: 'Connecting…',
      connected:  'Voice',
      error:      'Voice',
    };

    const dotMods: Record<SessionStatus, string> = {
      idle:       isListening ? 'listening' : 'idle',
      connecting: 'connecting',
      connected:  'connected',
      error:      'error',
    };

    this.statusBarText.textContent = labels[status];

    for (const mod of ['idle', 'listening', 'connecting', 'connected', 'error']) {
      this.statusBarDot.removeClass(`voice-statusbar-dot--${mod}`);
    }
    this.statusBarDot.addClass(`voice-statusbar-dot--${dotMods[status]}`);
  }
}
