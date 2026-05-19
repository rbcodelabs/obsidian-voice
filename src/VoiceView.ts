import { ItemView, MarkdownView, Notice, WorkspaceLeaf } from 'obsidian';
import type VoicePlugin from './main';
import { RealtimeSession, SessionStatus } from './RealtimeSession';
import { executeToolCall } from './DocumentTools';

export const VOICE_VIEW_TYPE = 'obsidian-voice:panel';

interface TranscriptEntry {
  role: 'user' | 'assistant' | 'tool';
  text: string;
  el: HTMLElement;
}

export class VoiceView extends ItemView {
  private plugin: VoicePlugin;
  private session: RealtimeSession | null = null;
  private isConnected = false;

  // UI elements
  private statusDot!: HTMLElement;
  private statusText!: HTMLElement;
  private connectBtn!: HTMLButtonElement;
  private transcriptContainer!: HTMLElement;

  // Transcript state
  private entries: TranscriptEntry[] = [];
  private pendingAssistant: TranscriptEntry | null = null;
  private pendingUser: TranscriptEntry | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: VoicePlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VOICE_VIEW_TYPE;
  }

  getDisplayText(): string {
    return 'Voice';
  }

  getIcon(): string {
    return 'mic';
  }

  async onOpen(): Promise<void> {
    const root = this.containerEl.children[1] as HTMLElement;
    root.empty();
    root.addClass('voice-panel');

    // Status bar
    const statusBar = root.createDiv({ cls: 'voice-status' });
    this.statusDot = statusBar.createSpan({ cls: 'voice-status__dot' });
    this.statusText = statusBar.createSpan({ cls: 'voice-status__text', text: 'Idle' });

    // Connect button
    this.connectBtn = root.createEl('button', {
      cls: 'voice-connect-btn',
      text: 'Connect',
    });
    this.connectBtn.addEventListener('click', () => this.handleConnectToggle());

    // Transcript container
    this.transcriptContainer = root.createDiv({ cls: 'voice-transcript' });

    this.updateStatus('idle');
  }

  async onClose(): Promise<void> {
    this.session?.disconnect();
    this.session = null;
    this.isConnected = false;
  }

  private async handleConnectToggle(): Promise<void> {
    if (this.isConnected) {
      this.doDisconnect();
    } else {
      await this.doConnect();
    }
  }

  private async doConnect(): Promise<void> {
    const { openaiApiKey, model, voice, systemPromptExtra } = this.plugin.settings;

    if (!openaiApiKey) {
      new Notice('Voice: no OpenAI API key configured. Open Settings to add one.');
      return;
    }

    const docContent = this.getCurrentDocContent();
    const systemPrompt = this.buildSystemPrompt(docContent, systemPromptExtra);

    this.session = new RealtimeSession();
    this.clearTranscript();
    this.connectBtn.disabled = true;

    await this.session.connect(openaiApiKey, model, voice, systemPrompt, {
      onStatusChange: (status) => {
        this.updateStatus(status);
        if (status === 'connected') {
          this.isConnected = true;
          this.connectBtn.disabled = false;
          this.connectBtn.textContent = 'Disconnect';
        } else if (status === 'idle' || status === 'error') {
          this.isConnected = false;
          this.connectBtn.disabled = false;
          this.connectBtn.textContent = 'Connect';
          this.session = null;
        }
      },
      onTranscript: (role, text, done) => {
        this.handleTranscript(role, text, done);
      },
      onToolCall: (_callId, name, _args) => {
        this.addToolEvent(this.formatToolName(name));
      },
      onError: (msg) => {
        new Notice(`Voice error: ${msg}`);
        this.addToolEvent(`Error: ${msg}`);
      },
      getToolResult: (_callId, name, argsJson) => {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(argsJson) as Record<string, unknown>;
        } catch {
          return `Error: could not parse tool arguments`;
        }
        return executeToolCall(name, args, this.app);
      },
    });
  }

  private doDisconnect(): void {
    this.session?.disconnect();
    this.session = null;
    this.isConnected = false;
    this.connectBtn.textContent = 'Connect';
    this.updateStatus('idle');
  }

  private getCurrentDocContent(): string {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) return '(no document currently open)';
    return view.editor.getValue();
  }

  private buildSystemPrompt(docContent: string, extra: string): string {
    let prompt =
      'You are a voice assistant helping with an Obsidian document. ' +
      'The current document content is:\n\n```\n' +
      docContent +
      '\n```\n\n' +
      'You can read it, answer questions about it, and use the available tools to edit it. ' +
      'Keep responses concise: this is a voice conversation.';
    if (extra.trim()) {
      prompt += '\n\n' + extra.trim();
    }
    return prompt;
  }

  private updateStatus(status: SessionStatus): void {
    const labels: Record<SessionStatus, string> = {
      idle: 'Idle',
      connecting: 'Connecting...',
      connected: 'Connected',
      error: 'Error',
    };
    const dotClasses: Record<SessionStatus, string> = {
      idle: 'voice-status__dot--idle',
      connecting: 'voice-status__dot--connecting',
      connected: 'voice-status__dot--connected',
      error: 'voice-status__dot--error',
    };

    this.statusText.textContent = labels[status];

    // Remove all status modifier classes then add the right one
    for (const cls of Object.values(dotClasses)) {
      this.statusDot.removeClass(cls);
    }
    this.statusDot.addClass(dotClasses[status]);
  }

  private handleTranscript(role: 'user' | 'assistant', text: string, done: boolean): void {
    if (role === 'assistant') {
      if (!this.pendingAssistant) {
        const el = this.createMessageEl('assistant', '');
        this.pendingAssistant = { role: 'assistant', text: '', el };
        this.entries.push(this.pendingAssistant);
      }
      if (text) {
        this.pendingAssistant.text += text;
        this.pendingAssistant.el.querySelector('.voice-msg__text')!.textContent =
          this.pendingAssistant.text;
        this.scrollToBottom();
      }
      if (done) {
        this.pendingAssistant = null;
      }
    } else {
      // User transcript arrives complete (done=true always for user)
      if (!this.pendingUser) {
        const el = this.createMessageEl('user', text);
        this.pendingUser = { role: 'user', text, el };
        this.entries.push(this.pendingUser);
        this.scrollToBottom();
      } else {
        this.pendingUser.text = text;
        this.pendingUser.el.querySelector('.voice-msg__text')!.textContent = text;
        this.scrollToBottom();
      }
      if (done) {
        this.pendingUser = null;
      }
    }
  }

  private createMessageEl(role: 'user' | 'assistant', text: string): HTMLElement {
    const wrapper = this.transcriptContainer.createDiv({
      cls: `voice-msg voice-msg--${role}`,
    });
    wrapper.createSpan({ cls: 'voice-msg__label', text: role === 'user' ? 'You' : 'AI' });
    wrapper.createSpan({ cls: 'voice-msg__text', text });
    return wrapper;
  }

  private addToolEvent(label: string): void {
    this.transcriptContainer.createDiv({
      cls: 'voice-tool-event',
      text: label,
    });
    this.scrollToBottom();
  }

  private formatToolName(name: string): string {
    const labels: Record<string, string> = {
      get_document: 'Read document',
      append_note: 'Appended note',
      insert_at_cursor: 'Inserted text',
      replace_document: 'Replaced document',
    };
    return labels[name] ?? name;
  }

  private clearTranscript(): void {
    this.transcriptContainer.empty();
    this.entries = [];
    this.pendingAssistant = null;
    this.pendingUser = null;
  }

  private scrollToBottom(): void {
    this.transcriptContainer.scrollTop = this.transcriptContainer.scrollHeight;
  }
}
