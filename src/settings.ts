import { App, Modal, Notice, PluginSettingTab, SecretComponent, Setting } from 'obsidian';
import type VoicePlugin from './main';
import { isWakeWordAvailable } from './WakeWordDetector';
import { EnrollmentModal } from './EnrollmentModal';

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
  wakeWordEnabled: boolean;
  /** Kept for data-model compat; phrase is fixed to "hey obsidian" by the bundled model. */
  wakeWord: string;
  /** Seconds of silence before the session auto-disconnects (0 = disabled). */
  silenceTimeoutSecs: number;
  /** Confidence threshold for wake word detection (0–1). Lower = more sensitive, more false positives. */
  wakeWordThreshold: number;
  /** Voice templates from enrollment (top-3 averaged embedding vectors, each 96 floats). */
  enrollmentEmbeddings: number[][] | null;
}

export const DEFAULT_SETTINGS: Omit<VoiceSettings, 'openaiApiKey'> = {
  voice: 'marin',
  systemPromptExtra: '',
  autoApplyEdits: true,
  debugLogging: false,
  wakeWordEnabled: false,
  wakeWord: 'hey obsidian',
  silenceTimeoutSecs: 15,
  wakeWordThreshold: 0.75,
  enrollmentEmbeddings: null,
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

    // Wake word section
    containerEl.createEl('h2', { text: 'Wake Word' });

    const available = isWakeWordAvailable();

    if (!available) {
      containerEl.createEl('p', {
        text: 'Wake word is not available: microphone access (getUserMedia) not found in this environment.',
        cls: 'setting-item-description',
      });
    }

    new Setting(containerEl)
      .setName('Enable wake word')
      .setDesc(
        'When enabled and the Voice panel is open, the plugin listens for "hey obsidian" ' +
        'and auto-connects when it hears it. Uses a locally-trained ONNX model — ' +
        'no audio leaves your device.',
      )
      .addToggle(toggle => {
        toggle
          .setValue(this.plugin.settings.wakeWordEnabled)
          .setDisabled(!available)
          .onChange(async (value) => {
            this.plugin.settings.wakeWordEnabled = value;
            await this.plugin.saveSettings();
            this.plugin.applyWakeWordSetting();
          });
      });

    new Setting(containerEl)
      .setName('Calibrate to your voice')
      .setDesc(
        this.plugin.settings.enrollmentEmbeddings
          ? '✓ Calibrated — threshold and voice templates have been personalised to your voice.'
          : 'Record 5 samples of "hey obsidian" to auto-set the threshold and build voice templates for your mic and voice.',
      )
      .addButton(btn => {
        btn
          .setButtonText(this.plugin.settings.enrollmentEmbeddings ? 'Re-calibrate' : 'Calibrate')
          .setCta()
          .setDisabled(!available)
          .onClick(() => new EnrollmentModal(this.app, this.plugin).open());
      })
      .addButton(btn => {
        btn
          .setButtonText('Clear')
          .setDisabled(!this.plugin.settings.enrollmentEmbeddings)
          .setWarning()
          .onClick(async () => {
            this.plugin.settings.enrollmentEmbeddings = null;
            this.plugin.settings.wakeWordThreshold = 0.75;
            await this.plugin.saveSettings();
            this.plugin.applyWakeWordSetting();
            this.display(); // re-render settings
          });
      });

    new Setting(containerEl)
      .setName('Detection threshold')
      .setDesc(
        'Confidence score (0–1) required to trigger wake word detection. ' +
        'Lower values catch more phrases but may trigger on background speech. ' +
        'Enable Debug logging to see live scores and tune this value.',
      )
      .addText(text => {
        text
          .setPlaceholder('0.75')
          .setValue(String(this.plugin.settings.wakeWordThreshold))
          .onChange(async (value) => {
            const n = parseFloat(value);
            this.plugin.settings.wakeWordThreshold = isNaN(n) ? 0.75 : Math.min(1, Math.max(0, n));
            await this.plugin.saveSettings();
            this.plugin.applyWakeWordSetting(); // re-arm detector with new threshold
          });
        text.inputEl.type = 'number';
        text.inputEl.min = '0';
        text.inputEl.max = '1';
        text.inputEl.step = '0.05';
        text.inputEl.style.width = '5em';
      });

    new Setting(containerEl)
      .setName('Silence timeout')
      .setDesc(
        'Auto-disconnect after this many seconds of silence during a voice session. ' +
        'The wake word detector re-arms immediately so you can say "hey obsidian" to reconnect. ' +
        'Set to 0 to disable.',
      )
      .addText(text => {
        text
          .setPlaceholder('15')
          .setValue(String(this.plugin.settings.silenceTimeoutSecs))
          .onChange(async (value) => {
            const n = parseInt(value, 10);
            this.plugin.settings.silenceTimeoutSecs = isNaN(n) || n < 0 ? 0 : n;
            await this.plugin.saveSettings();
          });
        text.inputEl.type = 'number';
        text.inputEl.min = '0';
        text.inputEl.style.width = '5em';
      });

    containerEl.createEl('h2', { text: 'Developer' });

    new Setting(containerEl)
      .setName('Debug logging')
      .setDesc('Log detailed [Voice] and [WakeWord] events to the DevTools console (Cmd+Option+I). Disable when not needed.')
      .addToggle(toggle => {
        toggle
          .setValue(this.plugin.settings.debugLogging)
          .onChange(async (value) => {
            this.plugin.settings.debugLogging = value;
            await this.plugin.saveSettings();
            // Re-arm the wake word detector so it picks up the new debug flag.
            this.plugin.applyWakeWordSetting();
          });
      });
  }
}
