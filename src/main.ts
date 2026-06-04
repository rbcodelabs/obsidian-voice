import { Plugin, WorkspaceLeaf } from 'obsidian';
import { VoiceView, VOICE_VIEW_TYPE } from './VoiceView';
import { VoiceSettings, DEFAULT_SETTINGS, VoiceSettingTab, OPENAI_SECRET_ID } from './settings';

export default class VoicePlugin extends Plugin {
  settings!: VoiceSettings;
  wakeDetectorSuspended = false;

  async onload() {
    await this.loadSettings();

    this.registerView(VOICE_VIEW_TYPE, (leaf) => new VoiceView(leaf, this));

    this.addRibbonIcon('mic', 'Voice', () => this.activateView());

    this.addCommand({
      id: 'open-voice-panel',
      name: 'Open Voice panel',
      callback: () => this.activateView(),
    });

    this.addCommand({
      id: 'toggle-voice-connection',
      name: 'Toggle Voice connection',
      callback: async () => {
        await this.activateView();
        const leaves = this.app.workspace.getLeavesOfType(VOICE_VIEW_TYPE);
        if (leaves.length > 0) {
          const view = leaves[0].view as VoiceView;
          await view.toggleConnection();
        }
      },
    });

    this.addSettingTab(new VoiceSettingTab(this.app, this));
  }

  async onunload() {
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
    const leaves = this.app.workspace.getLeavesOfType(VOICE_VIEW_TYPE);
    if (leaves.length > 0) {
      (leaves[0].view as VoiceView).syncWakeWordDetector();
    }
  }

  suspendWakeDetector(): void {
    this.wakeDetectorSuspended = true;
    const leaves = this.app.workspace.getLeavesOfType(VOICE_VIEW_TYPE);
    if (leaves.length > 0) {
      const view = leaves[0].view as VoiceView;
      // Guard against stale view instances that pre-date this method
      if (typeof view.stopWakeDetector === 'function') view.stopWakeDetector();
    }
  }

  resumeWakeDetector(): void {
    this.wakeDetectorSuspended = false;
    this.applyWakeWordSetting();
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
}
