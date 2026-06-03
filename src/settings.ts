import { App, PluginSettingTab, Setting } from 'obsidian';
import type VoicePlugin from './main';

export const REALTIME_MODEL = 'gpt-realtime-2';
export const OPENAI_SECRET_ID = 'openai-api-key';

export type RealtimeVoice =
  | 'alloy' | 'ash' | 'ballad' | 'cedar' | 'coral'
  | 'echo' | 'fable' | 'marin' | 'nova' | 'onyx'
  | 'sage' | 'shimmer' | 'verse';

export interface VoiceSettings {
  /** @deprecated Migrated to SecretStorage on first load. Do not use directly. */
  openaiApiKey?: string;
  voice: RealtimeVoice;
  systemPromptExtra: string;
  autoApplyEdits: boolean;
  debugLogging: boolean;
}

export const DEFAULT_SETTINGS: Omit<VoiceSettings, 'openaiApiKey'> = {
  voice: 'marin',
  systemPromptExtra: '',
  autoApplyEdits: true,
  debugLogging: false,
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
      .setDesc('Your OpenAI API key. Stored securely in your OS keychain, not in data.json.')
      .addText((text) => {
        text.inputEl.type = 'password';
        text.inputEl.placeholder = this.app.secretStorage.getSecret(OPENAI_SECRET_ID)
          ? '••••••••'
          : 'sk-…';
        text.inputEl.style.width = '100%';
        text.onChange((value) => {
          const trimmed = value.trim();
          if (trimmed) this.app.secretStorage.setSecret(OPENAI_SECRET_ID, trimmed);
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

    containerEl.createEl('h2', { text: 'Developer' });

    new Setting(containerEl)
      .setName('Debug logging')
      .setDesc('Log detailed [Voice] events to the DevTools console (Cmd+Option+I). Useful for diagnosing notification bridge issues. Disable when not needed.')
      .addToggle(toggle => {
        toggle
          .setValue(this.plugin.settings.debugLogging)
          .onChange(async (value) => {
            this.plugin.settings.debugLogging = value;
            await this.plugin.saveSettings();
          });
      });
  }
}
