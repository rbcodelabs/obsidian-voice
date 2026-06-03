import { App, Modal, Notice, PluginSettingTab, SecretComponent, Setting } from 'obsidian';
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

function maskOpenAiKey(key: string | null | undefined): string {
  if (!key) return 'No key set';
  if (key.length <= 12) return '••••••••';
  return key.slice(0, 8) + '…' + key.slice(-4);
}

/** Modal for securely entering a new OpenAI API key. */
class OpenAiKeyModal extends Modal {
  constructor(app: App, private settingTab: VoiceSettingTab) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl('h2', { text: 'OpenAI API Key' });
    contentEl.createEl('p', {
      text: 'Paste your API key from platform.openai.com/api-keys',
      cls: 'setting-item-description',
    });

    const input = contentEl.createEl('input', {
      type: 'password',
      placeholder: 'sk-…',
    });
    input.style.width = '100%';
    input.style.marginBottom = '1rem';

    const buttonRow = contentEl.createDiv();
    buttonRow.style.display = 'flex';
    buttonRow.style.justifyContent = 'flex-end';
    buttonRow.style.gap = '8px';

    const cancelBtn = buttonRow.createEl('button', { text: 'Cancel' });
    cancelBtn.addEventListener('click', () => this.close());

    const saveBtn = buttonRow.createEl('button', { text: 'Save', cls: 'mod-cta' });
    saveBtn.addEventListener('click', () => {
      const trimmed = input.value.trim();
      if (!trimmed) return;
      this.app.secretStorage.setSecret(OPENAI_SECRET_ID, trimmed);
      new Notice('API key saved');
      this.close();
      this.settingTab.display();
    });

    input.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter') saveBtn.click();
    });

    setTimeout(() => input.focus(), 50);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

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

    // ── OpenAI API Key ────────────────────────────────────────────────────
    {
      const existingKey = this.app.secretStorage.getSecret(OPENAI_SECRET_ID);
      const maskedKey = maskOpenAiKey(existingKey);

      const keySetting = new Setting(containerEl)
        .setName('OpenAI API Key')
        .setDesc('Stored securely in your OS keychain, not in data.json.');

      keySetting.descEl.createEl('br');
      keySetting.descEl.createEl('span', { text: maskedKey });

      keySetting
        .addButton((btn) => {
          if (!existingKey) btn.setCta();
          btn.setButtonText(existingKey ? 'Change' : 'Set key').onClick(() => {
            new OpenAiKeyModal(this.app, this).open();
          });
        })
        .addButton((btn) => {
          btn
            .setButtonText('Link existing')
            .setTooltip('Use a key already stored by another plugin')
            .onClick(() => {
              const tmp = document.body.createDiv();
              tmp.style.display = 'none';
              const picker = new SecretComponent(this.app, tmp);
              picker.onChange((secretName: string) => {
                tmp.remove();
                if (!secretName) return;
                const actualValue = this.app.secretStorage.getSecret(secretName);
                if (actualValue) {
                  this.app.secretStorage.setSecret(OPENAI_SECRET_ID, actualValue);
                  new Notice('Key linked');
                  this.display();
                } else {
                  new Notice('That secret has no value stored');
                }
              });
              // SecretComponent renders a button — click it to open the picker
              const inner = tmp.querySelector('button, input') as HTMLElement | null;
              if (inner) {
                inner.click();
              } else {
                tmp.remove();
                new Notice('Secret picker not available');
              }
            });
        });
    }

    // ── Voice ─────────────────────────────────────────────────────────────
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

    // ── Extra system prompt ───────────────────────────────────────────────
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

    // ── Developer ─────────────────────────────────────────────────────────
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
