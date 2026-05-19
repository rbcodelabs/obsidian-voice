import { App, PluginSettingTab, Setting } from 'obsidian';
import type VoicePlugin from './main';

export type RealtimeModel = 'gpt-realtime' | 'gpt-realtime-mini';
export type RealtimeVoice =
  | 'alloy' | 'ash' | 'ballad' | 'cedar' | 'coral'
  | 'echo' | 'fable' | 'marin' | 'nova' | 'onyx'
  | 'sage' | 'shimmer' | 'verse';

export interface VoiceSettings {
  openaiApiKey: string;
  model: RealtimeModel;
  voice: RealtimeVoice;
  systemPromptExtra: string;
  autoApplyEdits: boolean;
}

export const DEFAULT_SETTINGS: VoiceSettings = {
  openaiApiKey: '',
  model: 'gpt-realtime',
  voice: 'marin',
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
      .setName('Model')
      .setDesc('gpt-realtime is the full model; gpt-realtime-mini is faster and cheaper.')
      .addDropdown(drop => {
        drop
          .addOption('gpt-realtime', 'gpt-realtime (recommended)')
          .addOption('gpt-realtime-mini', 'gpt-realtime-mini (faster / cheaper)')
          .setValue(this.plugin.settings.model)
          .onChange(async (value) => {
            this.plugin.settings.model = value as RealtimeModel;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName('Voice')
      .setDesc('The voice the AI will use when speaking. Marin and Cedar are Realtime-exclusive.')
      .addDropdown(drop => {
        drop
          .addOption('marin', 'Marin (recommended)')
          .addOption('cedar', 'Cedar')
          .addOption('alloy', 'Alloy')
          .addOption('ash', 'Ash')
          .addOption('ballad', 'Ballad')
          .addOption('coral', 'Coral')
          .addOption('echo', 'Echo')
          .addOption('fable', 'Fable')
          .addOption('nova', 'Nova')
          .addOption('onyx', 'Onyx')
          .addOption('sage', 'Sage')
          .addOption('shimmer', 'Shimmer')
          .addOption('verse', 'Verse')
          .setValue(this.plugin.settings.voice)
          .onChange(async (value) => {
            this.plugin.settings.voice = value as RealtimeVoice;
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
