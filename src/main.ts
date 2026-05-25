import { Plugin, WorkspaceLeaf } from 'obsidian';
import { VoiceView, VOICE_VIEW_TYPE } from './VoiceView';
import { VoiceSettings, DEFAULT_SETTINGS, VoiceSettingTab, OPENAI_SECRET_ID } from './settings';

export default class VoicePlugin extends Plugin {
  settings!: VoiceSettings;

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
    // Intentionally not detaching leaves here so the panel persists
    // across plugin reloads and BRAT updates. Obsidian serialises the
    // workspace layout including this leaf; when the plugin reloads the
    // view factory recreates VoiceView in the existing leaf automatically.
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

    this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}
