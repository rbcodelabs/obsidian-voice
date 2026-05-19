import { App, PluginSettingTab, Setting } from 'obsidian';
import type VoicePlugin from './main';

export interface VoiceSettings {
  openaiApiKey: string;
  voice: 'alloy' | 'echo' | 'fable' | 'onyx' | 'nova' | 'shimmer';
  systemPromptExtra: string;
  autoApplyEdits: boolean;
}

export const DEFAULT_SETTINGS: VoiceSettings = {
  openaiApiKey: '',
  voice: 'alloy',
  systemPromptExtra: '',
  autoApplyEdits: true,
};

export class VoiceSettingTab extends PluginSettingTab {
  plugin: VoicePlugin;

  constructor(app: App, plugin: VoicePlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl('h2', { text: 'Voice Settings' });

    new Setting(containerEl)
      .setName('OpenAI API Key')
      .setDesc('Your OpenAI API key. Used to create ephemeral tokens for Realtime sessions.')
      .addText(text => {
        text
          .setPlaceholder('sk-...')
          .setValue(this.plugin.settings.openaiApiKey)
          .onChange(async (value) => {
            this.plugin.settings.openaiApiKey = value;
            await this.plugin.saveSettings();
          });
        text.inputEl.type = 'password';
        text.inputEl.style.width = '100%';
      });

    new Setting(containerEl)
      .setName('Voice')
      .setDesc('The voice the AI will use when speaking.')
      .addDropdown(drop => {
        drop
          .addOption('alloy', 'Alloy')
          .addOption('echo', 'Echo')
          .addOption('fable', 'Fable')
          .addOption('onyx', 'Onyx')
          .addOption('nova', 'Nova')
          .addOption('shimmer', 'Shimmer')
          .setValue(this.plugin.settings.voice)
          .onChange(async (value) => {
            this.plugin.settings.voice = value as VoiceSettings['voice'];
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName('Extra system prompt')
      .setDesc('Additional instructions appended to the base system prompt.')
      .addTextArea(text => {
        text
          .setPlaceholder('e.g. Always respond in bullet points.')
          .setValue(this.plugin.settings.systemPromptExtra)
          .onChange(async (value) => {
            this.plugin.settings.systemPromptExtra = value;
            await this.plugin.saveSettings();
          });
        text.inputEl.rows = 4;
        text.inputEl.style.width = '100%';
      });
  }
}
