import { AbstractInputSuggest, App, PluginSettingTab, SecretComponent, Setting, TFile } from 'obsidian';
import type VoicePlugin from './main';
import { isSpeechRecognitionAvailable } from './WakeWordDetector';

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
  /** Vault-relative paths loaded as persistent context on every session connect. */
  contextFiles: string[];
  autoApplyEdits: boolean;
  debugLogging: boolean;
  wakeWordEnabled: boolean;
  wakeWord: string;
}

export const DEFAULT_SETTINGS: Omit<VoiceSettings, 'openaiApiKey'> = {
  voice: 'marin',
  systemPromptExtra: '',
  contextFiles: [],
  autoApplyEdits: true,
  debugLogging: false,
  wakeWordEnabled: false,
  wakeWord: 'hey obsidian',
};

/** Fuzzy file suggest for the context-files picker. */
class VaultFileSuggest extends AbstractInputSuggest<TFile> {
  private onSelect: (file: TFile) => void;

  constructor(app: App, inputEl: HTMLInputElement, onSelect: (file: TFile) => void) {
    super(app, inputEl);
    this.onSelect = onSelect;
  }

  getSuggestions(query: string): TFile[] {
    const lower = query.toLowerCase();
    return this.app.vault.getMarkdownFiles()
      .filter(f => f.path.toLowerCase().includes(lower))
      .slice(0, 20);
  }

  renderSuggestion(file: TFile, el: HTMLElement): void {
    el.createSpan({ cls: 'voice-suggest-path', text: file.path });
  }

  selectSuggestion(file: TFile): void {
    this.onSelect(file);
    this.setValue('');
    this.close();
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

    new Setting(containerEl)
      .setName('OpenAI API Key')
      .setDesc('Your OpenAI API key. Stored in Obsidian secure storage, not in data.json.')
      .addComponent(el => {
        const secret = new SecretComponent(this.app, el);
        const current = this.app.secretStorage.getSecret(OPENAI_SECRET_ID);
        if (current) secret.setValue(current);
        secret.onChange((value) => {
          this.app.secretStorage.setSecret(OPENAI_SECRET_ID, value);
        });
        return secret;
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

    // Context files — pill picker with fuzzy file autocomplete
    new Setting(containerEl)
      .setName('Context files')
      .setDesc(
        'Vault files injected as persistent context on every session connect. ' +
        'Type to search, select to add. Contents become <context> blocks in the system prompt, ' +
        'after the active document and before the extra system prompt.'
      );

    const pickerEl = containerEl.createDiv({ cls: 'voice-context-file-picker' });

    const renderPills = () => {
      pickerEl.empty();

      // Existing files as removable pills
      for (const [i, path] of (this.plugin.settings.contextFiles ?? []).entries()) {
        const pill = pickerEl.createDiv({ cls: 'voice-context-file-pill' });
        pill.createSpan({ text: path });
        const removeBtn = pill.createEl('button', {
          cls: 'voice-context-file-pill__remove',
          text: '×',
          attr: { 'aria-label': `Remove ${path}` },
        });
        removeBtn.addEventListener('click', async () => {
          this.plugin.settings.contextFiles.splice(i, 1);
          await this.plugin.saveSettings();
          renderPills();
        });
      }

      // Search input
      const inputEl = pickerEl.createEl('input', {
        cls: 'voice-context-file-input',
        attr: { type: 'text', placeholder: 'Search and add a file…', spellcheck: 'false' },
      }) as HTMLInputElement;

      new VaultFileSuggest(this.app, inputEl, async (file: TFile) => {
        const files = this.plugin.settings.contextFiles ?? [];
        if (!files.includes(file.path)) {
          files.push(file.path);
          this.plugin.settings.contextFiles = files;
          await this.plugin.saveSettings();
        }
        renderPills();
      });
    };

    renderPills();

    // Wake word section
    containerEl.createEl('h2', { text: 'Wake Word' });

    const wakeWordAvailable = isSpeechRecognitionAvailable();

    if (!wakeWordAvailable) {
      containerEl.createEl('p', {
        text: 'Wake word is not available: SpeechRecognition API not found in this environment.',
        cls: 'setting-item-description',
      });
    }

    const wakeToggle = new Setting(containerEl)
      .setName('Enable wake word')
      .setDesc(
        'When enabled and the Voice panel is open, the plugin listens for your wake phrase ' +
        'and auto-connects when it hears it. Uses the browser\'s built-in speech recognition ' +
        '(Chromium/Electron — audio may be processed by Google).'
      )
      .addToggle(toggle => {
        toggle
          .setValue(this.plugin.settings.wakeWordEnabled)
          .setDisabled(!wakeWordAvailable)
          .onChange(async (value) => {
            this.plugin.settings.wakeWordEnabled = value;
            await this.plugin.saveSettings();
            // Tell the open voice view to start/stop the detector immediately
            this.plugin.applyWakeWordSetting();
          });
      });

    if (!wakeWordAvailable) {
      wakeToggle.setDisabled(true);
    }

    new Setting(containerEl)
      .setName('Wake phrase')
      .setDesc('The phrase that triggers auto-connect. Case-insensitive. Keep it distinct to avoid false triggers.')
      .addText(text => {
        text
          .setPlaceholder('hey obsidian')
          .setValue(this.plugin.settings.wakeWord)
          .setDisabled(!wakeWordAvailable)
          .onChange(async (value) => {
            this.plugin.settings.wakeWord = value.trim() || 'hey obsidian';
            await this.plugin.saveSettings();
            this.plugin.applyWakeWordSetting();
          });
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
