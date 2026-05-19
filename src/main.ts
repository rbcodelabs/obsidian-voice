import { Plugin, WorkspaceLeaf } from 'obsidian';
import { VoiceView, VOICE_VIEW_TYPE } from './VoiceView';
import { VoiceSettings, DEFAULT_SETTINGS, VoiceSettingTab } from './settings';

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

    this.addSettingTab(new VoiceSettingTab(this.app, this));
  }

  async onunload() {
    this.app.workspace.detachLeavesOfType(VOICE_VIEW_TYPE);
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
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}
