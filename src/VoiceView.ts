import { ItemView, MarkdownView, Notice, WorkspaceLeaf } from 'obsidian';
import type VoicePlugin from './main';
import { RealtimeSession, SessionStatus } from './RealtimeSession';
import { executeToolCall } from './DocumentTools';
import { OPENAI_SECRET_ID, REALTIME_MODEL } from './settings';

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
  // Tracks the last markdown tab the user focused. Stays populated even when
  // the Voice panel itself is active, so Connect always targets the document
  // you were just looking at.
  private lastMarkdownView: MarkdownView | null = null;

  // UI elements
  private statusDot!: HTMLElement;
  private statusText!: HTMLElement;
  private connectBtn!: HTMLButtonElement;
  private contextBanner!: HTMLElement;
  private transcriptContainer!: HTMLElement;

  // Transcript state
  private entries: TranscriptEntry[] = [];
  private pendingAssistant: TranscriptEntry | null = null;
  private pendingUser: TranscriptEntry | null = null;
  private pendingToolEls = new Map<string, HTMLElement>();

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

    // Context banner — shows which file will be sent as context
    this.contextBanner = root.createDiv({ cls: 'voice-context-banner' });

    // Seed the tracker with whatever is already active when the panel opens.
    // getActiveViewOfType works here because we haven't stolen focus yet.
    this.lastMarkdownView = this.app.workspace.getActiveViewOfType(MarkdownView);
    this.updateContextBanner();

    // Keep the tracker current as the user navigates tabs.
    // When focus moves to the Voice panel the leaf is not a MarkdownView, so
    // we leave lastMarkdownView alone — the previous document stays tracked.
    this.registerEvent(
      this.app.workspace.on('active-leaf-change', (leaf) => {
        if (leaf?.view instanceof MarkdownView && leaf.view.file) {
          this.lastMarkdownView = leaf.view as MarkdownView;
        }
        this.updateContextBanner();
      })
    );

    // Transcript container
    this.transcriptContainer = root.createDiv({ cls: 'voice-transcript' });

    this.updateStatus('idle');
  }

  async onClose(): Promise<void> {
    this.session?.disconnect();
    this.session = null;
    this.isConnected = false;
  }

  async toggleConnection(): Promise<void> {
    if (this.isConnected) {
      this.doDisconnect();
    } else {
      await this.doConnect();
    }
  }

  private async handleConnectToggle(): Promise<void> {
    return this.toggleConnection();
  }

  private async doConnect(): Promise<void> {
    const { voice, systemPromptExtra } = this.plugin.settings;
    const apiKey = this.plugin.app.secretStorage.getSecret(OPENAI_SECRET_ID);

    if (!apiKey) {
      new Notice('Voice: no OpenAI API key configured. Open Settings to add one.');
      return;
    }

    const view = this.getMarkdownView();
    const docContent = this.getCurrentDocContent();
    const systemPrompt = this.buildSystemPrompt(docContent, systemPromptExtra);

    this.session = new RealtimeSession();
    this.clearTranscript();
    this.connectBtn.disabled = true;

    await this.session.connect(apiKey, REALTIME_MODEL, voice, systemPrompt, {
      onStatusChange: (status) => {
        this.updateStatus(status);
        if (status === 'connected') {
          this.isConnected = true;
          this.connectBtn.disabled = false;
          this.connectBtn.textContent = 'Disconnect';
          // Show what file was captured as context
          if (view?.file) {
            const chars = docContent.length.toLocaleString();
            this.addToolEvent(`Context snapshot: ${view.file.name} · ${chars} chars`);
          } else {
            this.addToolEvent('Context snapshot: no document open');
          }
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
      onToolCall: (callId, name, argsJson) => {
        const label = this.formatToolLabel(name, argsJson);
        const el = this.addToolEvent(label);
        this.pendingToolEls.set(callId, el);
      },
      onError: (msg) => {
        new Notice(`Voice error: ${msg}`);
        this.addToolEvent(`Error: ${msg}`);
      },
      getToolResult: async (callId, name, argsJson) => {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(argsJson) as Record<string, unknown>;
        } catch {
          return `Error: could not parse tool arguments`;
        }
        const result = await executeToolCall(name, args, this.app, this.lastMarkdownView);
        // Update the pill with outcome
        const el = this.pendingToolEls.get(callId);
        if (el) {
          el.textContent = this.formatToolResult(name, argsJson, result);
          this.pendingToolEls.delete(callId);
        }
        return result;
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

  private getMarkdownView(): MarkdownView | null {
    return this.lastMarkdownView;
  }

  private getCurrentDocContent(): string {
    const view = this.getMarkdownView();
    if (!view) return '(no document currently open)';
    return view.editor.getValue();
  }

  private updateContextBanner(): void {
    const view = this.getMarkdownView();
    this.contextBanner.empty();
    if (view?.file) {
      const charCount = view.editor.getValue().length;
      this.contextBanner.createSpan({ cls: 'voice-context-banner__label', text: 'Context: ' });
      this.contextBanner.createSpan({ cls: 'voice-context-banner__file', text: view.file.name });
      this.contextBanner.createSpan({
        cls: 'voice-context-banner__chars',
        text: ` · ${charCount.toLocaleString()} chars`,
      });
    } else {
      this.contextBanner.createSpan({
        cls: 'voice-context-banner__none',
        text: 'No document open — AI will have no context',
      });
    }
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

  private addToolEvent(label: string): HTMLElement {
    const el = this.transcriptContainer.createDiv({
      cls: 'voice-tool-event',
      text: label,
    });
    this.scrollToBottom();
    return el;
  }

  // Label shown while tool is executing
  private formatToolLabel(name: string, argsJson: string): string {
    let args: Record<string, unknown> = {};
    try { args = JSON.parse(argsJson) as Record<string, unknown>; } catch { /* ok */ }

    switch (name) {
      case 'search_vault':
        return `Searching vault · "${args.query as string ?? ''}"…`;
      case 'open_file':
        return `Opening · ${args.filename as string ?? ''}…`;
      case 'get_document':
        return 'Reading document…';
      case 'append_note':
        return 'Appending note…';
      case 'insert_at_cursor':
        return 'Inserting text…';
      case 'replace_document':
        return 'Replacing document…';
      case 'get_links':
        return 'Getting links…';
      case 'create_document':
        return `Creating document · ${args.path as string ?? ''}…`;
      case 'list_folder':
        return `Listing folder · ${args.path as string || '/'}…`;
      default:
        return `${name}…`;
    }
  }

  // Label shown after tool completes
  private formatToolResult(name: string, argsJson: string, result: string): string {
    let args: Record<string, unknown> = {};
    try { args = JSON.parse(argsJson) as Record<string, unknown>; } catch { /* ok */ }

    const isError = result.startsWith('Error:');

    switch (name) {
      case 'search_vault': {
        if (isError) return `Search failed · "${args.query as string ?? ''}"`;
        const count = (result.match(/^\d+\./gm) ?? []).length;
        return `Searched vault · "${args.query as string ?? ''}" · ${count} result${count !== 1 ? 's' : ''}`;
      }
      case 'open_file': {
        if (isError) return `File not found · ${args.filename as string ?? ''}`;
        return `Opened · ${args.filename as string ?? ''}`;
      }
      case 'get_document':
        return isError ? 'Read document · no file open' : 'Read document';
      case 'append_note':
        return isError ? 'Append failed' : 'Appended note';
      case 'insert_at_cursor':
        return isError ? 'Insert failed' : 'Inserted text';
      case 'replace_document':
        return isError ? 'Replace failed' : 'Replaced document';
      case 'get_links': {
        if (isError) return 'Got links · no file open';
        const count = (result.match(/^- /gm) ?? []).length;
        return `Got links · ${count} link${count !== 1 ? 's' : ''}`;
      }
      case 'create_document': {
        if (isError) return `Create failed · ${args.path as string ?? ''}`;
        return `Created · ${args.path as string ?? ''}`;
      }
      case 'list_folder': {
        if (isError) return `List failed · ${args.path as string || '/'}`;
        const count = (result.match(/\n  /g) ?? []).length;
        return `Listed · ${args.path as string || '/'} · ${count} item${count !== 1 ? 's' : ''}`;
      }
      default:
        return isError ? `${name} failed` : name;
    }
  }

  private clearTranscript(): void {
    this.transcriptContainer.empty();
    this.entries = [];
    this.pendingAssistant = null;
    this.pendingUser = null;
    this.pendingToolEls.clear();
  }

  private scrollToBottom(): void {
    this.transcriptContainer.scrollTop = this.transcriptContainer.scrollHeight;
  }
}
