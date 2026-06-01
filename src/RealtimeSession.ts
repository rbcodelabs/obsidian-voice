export type SessionStatus = 'idle' | 'connecting' | 'connected' | 'error';

export interface SessionCallbacks {
  onTranscript: (role: 'user' | 'assistant', text: string, done: boolean) => void;
  onToolCall: (callId: string, name: string, args: string) => void;
  onStatusChange: (status: SessionStatus) => void;
  onError: (msg: string) => void;
  getToolResult: (callId: string, name: string, argsJson: string) => Promise<string>;
}

interface PendingToolCall {
  callId: string;
  name: string;
  argsJson: string;
}

export class RealtimeSession {
  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private audioEl: HTMLAudioElement | null = null;
  private micStream: MediaStream | null = null;
  // Buffers tool calls arriving in a single response batch.
  // Flushed (and executed) only when response.done fires, so we can send
  // all outputs then a single response.create -- avoiding the
  // conversation_already_has_active_response error on parallel tool calls.
  private pendingToolCalls: PendingToolCall[] = [];
  // Tracks whether the server currently has an active response in flight.
  // Set on response.created, cleared on response.done.
  private isResponseActive = false;
  // Resolvers waiting for the current response to finish (used when
  // flushToolBatch needs to cancel an in-flight VAD response before
  // submitting tool outputs).
  private responseDoneResolvers: Array<() => void> = [];
  private notificationQueue: Array<{ threadId: string; text: string }> = [];
  private currentResponseContext: { type: 'user' } | { type: 'notification'; threadId: string } | null = null;
  private pendingNotificationContext: { threadId: string } | null = null;
  private notificationCancelPending = false;
  private pendingResponseRetry = false;
  private callbacks: SessionCallbacks | null = null;

  async connect(
    apiKey: string,
    model: string,
    voice: string,
    systemPrompt: string,
    callbacks: SessionCallbacks,
    tools: unknown[] = []
  ): Promise<void> {
    callbacks.onStatusChange('connecting');
    this.callbacks = callbacks;

    // Step 1: fetch ephemeral token — set model, voice, and instructions at creation time
    let ephemeralToken: string;
    try {
      const tokenRes = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          session: {
            type: 'realtime',
            model,
            instructions: systemPrompt,
            audio: {
              output: { voice },
            },
          },
        }),
      });
      if (!tokenRes.ok) {
        const err = await tokenRes.text();
        throw new Error(`Token fetch failed (${tokenRes.status}): ${err}`);
      }
      const tokenData = await tokenRes.json() as { value: string };
      ephemeralToken = tokenData.value;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      callbacks.onError(`Failed to create session: ${msg}`);
      callbacks.onStatusChange('error');
      return;
    }

    // Step 2: WebRTC peer connection
    this.pc = new RTCPeerConnection();

    // Step 3: microphone
    try {
      this.micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      callbacks.onError(`Microphone access denied: ${msg}`);
      callbacks.onStatusChange('error');
      this.pc.close();
      this.pc = null;
      return;
    }
    for (const track of this.micStream.getTracks()) {
      this.pc.addTrack(track, this.micStream);
    }

    // Step 4: audio playback element
    this.audioEl = document.createElement('audio');
    this.audioEl.autoplay = true;
    this.audioEl.style.display = 'none';
    document.body.appendChild(this.audioEl);
    this.pc.ontrack = (e) => {
      if (this.audioEl) this.audioEl.srcObject = e.streams[0];
    };

    // Step 5: data channel for events
    this.dc = this.pc.createDataChannel('oai-events');

    this.dc.onopen = () => {
      if (!this.dc) return;
      // GA API session.update only accepts type, tools, and instructions.
      // Voice, audio format, and VAD are set via client_secrets above.
      this.dc.send(JSON.stringify({
        type: 'session.update',
        session: {
          type: 'realtime',
          instructions: systemPrompt,
          tools,
          tool_choice: 'auto',
        },
      }));
      callbacks.onStatusChange('connected');
    };

    this.dc.onmessage = (e: MessageEvent) => {
      try {
        const event = JSON.parse(e.data as string) as Record<string, unknown>;
        console.debug('[Voice] DC event:', event.type, event);
        this.handleEvent(event, callbacks);
      } catch {
        // ignore malformed events
      }
    };

    this.dc.onerror = () => {
      callbacks.onError('Data channel error');
      callbacks.onStatusChange('error');
    };

    this.dc.onclose = () => {
      if (this.pc) callbacks.onStatusChange('idle');
    };

    // Step 6: SDP negotiation
    try {
      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);

      const sdpRes = await fetch('https://api.openai.com/v1/realtime/calls', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${ephemeralToken}`,
          'Content-Type': 'application/sdp',
        },
        body: offer.sdp,
      });

      if (!sdpRes.ok) {
        const err = await sdpRes.text();
        throw new Error(`SDP exchange failed (${sdpRes.status}): ${err}`);
      }

      const answerSdp = await sdpRes.text();
      await this.pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      callbacks.onError(`WebRTC setup failed: ${msg}`);
      callbacks.onStatusChange('error');
      this.cleanup();
    }
  }

  private handleEvent(event: Record<string, unknown>, callbacks: SessionCallbacks): void {
    const type = event.type as string;

    if (type === 'response.created') {
      this.isResponseActive = true;
      if (this.pendingNotificationContext) {
        this.currentResponseContext = { type: 'notification', threadId: this.pendingNotificationContext.threadId };
        this.pendingNotificationContext = null;
      } else {
        this.currentResponseContext = { type: 'user' };
      }
    } else if (type === 'response.audio_transcript.delta') {
      const delta = (event.delta as string) ?? '';
      if (delta) callbacks.onTranscript('assistant', delta, false);
    } else if (type === 'response.audio_transcript.done') {
      callbacks.onTranscript('assistant', '', true);
    } else if (type === 'conversation.item.input_audio_transcription.completed') {
      const transcript = (event.transcript as string) ?? '';
      if (transcript) callbacks.onTranscript('user', transcript, true);
    } else if (type === 'response.function_call_arguments.done') {
      const callId = (event.call_id as string) ?? '';
      const name = (event.name as string) ?? '';
      const argsJson = (event.arguments as string) ?? '{}';
      console.debug('[Voice] Tool call buffered:', name, callId);
      callbacks.onToolCall(callId, name, argsJson);
      this.pendingToolCalls.push({ callId, name, argsJson });
    } else if (type === 'response.done') {
      this.isResponseActive = false;
      this.currentResponseContext = null;

      const resolvers = this.responseDoneResolvers.splice(0);
      for (const resolve of resolvers) resolve();

      // If this done was triggered by a flushToolBatch cancel-wait, don't
      // touch the notification queue — flushToolBatch will send response.create
      // and the next response.done will drain it.
      if (resolvers.length > 0) return;

      // Tool batch takes priority over notifications
      if (this.pendingToolCalls.length > 0) {
        const batch = this.pendingToolCalls.splice(0);
        void this.flushToolBatch(batch, this.callbacks!);
        return;
      }

      // Drain notification queue
      if (this.notificationCancelPending || this.notificationQueue.length > 0) {
        this.notificationCancelPending = false;
        const next = this.notificationQueue.shift();
        if (next) void this.sendNotification(next);
      }

      // Retry a response.create that was rejected due to an active-response race.
      // The conversation item already landed; just nudge the server to respond to it.
      if (this.pendingResponseRetry && !this.isResponseActive && this.notificationQueue.length === 0) {
        this.pendingResponseRetry = false;
        if (this.dc && this.dc.readyState === 'open') {
          this.dc.send(JSON.stringify({ type: 'response.create' }));
        }
      }
    } else if (type === 'error') {
      const errorObj = event.error as Record<string, unknown> | undefined;
      const errMsg = (errorObj?.message as string) ?? (event.message as string) ?? JSON.stringify(event);
      const errCode = (errorObj?.code as string) ?? '';

      // "conversation already has active response" is a timing race we can recover from:
      // our conversation.item.create already landed, so just retry response.create on next response.done.
      if (errCode === 'conversation_already_has_active_response' || errMsg.includes('already has an active response')) {
        console.warn('[Voice] Active-response race detected — will retry response.create after current response finishes');
        this.pendingResponseRetry = true;
        return;
      }

      console.error('[Voice] Server error:', event);
      callbacks.onError(`Server error: ${errMsg}`);
    }
  }

  private async flushToolBatch(batch: PendingToolCall[], callbacks: SessionCallbacks): Promise<void> {
    // Run all tools in the batch concurrently. These can take 30-120s for
    // slow tools (e.g. ct_new_thread / ct_send_message), during which VAD
    // may fire and start a new response.
    const results = await Promise.all(
      batch.map(async ({ callId, name, argsJson }) => {
        try {
          const result = await callbacks.getToolResult(callId, name, argsJson);
          console.debug('[Voice] Tool result:', name, result.slice(0, 200));
          return { callId, output: result };
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error('[Voice] Tool error:', name, msg);
          return { callId, output: `Error: ${msg}` };
        }
      })
    );

    if (!this.dc || this.dc.readyState !== 'open') return;

    // If VAD started a new response while tools were running, cancel it
    // before submitting outputs -- otherwise we get
    // conversation_already_has_active_response.
    if (this.isResponseActive) {
      console.debug('[Voice] Active response detected; sending response.cancel before tool outputs');
      this.dc.send(JSON.stringify({ type: 'response.cancel' }));
      // Wait for the server to acknowledge the cancel via response.done.
      await new Promise<void>(resolve => this.responseDoneResolvers.push(resolve));
      if (!this.dc || this.dc.readyState !== 'open') return;
    }

    // Send all outputs first, then exactly one response.create
    for (const { callId, output } of results) {
      this.dc.send(JSON.stringify({
        type: 'conversation.item.create',
        item: { type: 'function_call_output', call_id: callId, output },
      }));
    }
    this.dc.send(JSON.stringify({ type: 'response.create' }));
  }

  injectNotification(threadId: string, text: string): void {
    if (!this.dc || this.dc.readyState !== 'open') return;

    const item = { threadId, text };

    if (!this.isResponseActive) {
      void this.sendNotification(item);
      return;
    }

    if (
      this.currentResponseContext?.type === 'notification' &&
      this.currentResponseContext.threadId === threadId
    ) {
      // Same thread being discussed — cancel and re-queue
      this.notificationQueue.push(item);
      this.notificationCancelPending = true;
      this.dc.send(JSON.stringify({ type: 'response.cancel' }));
    } else {
      // Different context — queue for later
      this.notificationQueue.push(item);
    }
  }

  private async sendNotification(item: { threadId: string; text: string }): Promise<void> {
    if (!this.dc || this.dc.readyState !== 'open') return;

    // If a response is active, cancel it first (same guard as flushToolBatch)
    if (this.isResponseActive) {
      this.dc.send(JSON.stringify({ type: 'response.cancel' }));
      await new Promise<void>(resolve => this.responseDoneResolvers.push(resolve));
      if (!this.dc || this.dc.readyState !== 'open') return;
    }

    this.pendingNotificationContext = { threadId: item.threadId };
    this.dc.send(JSON.stringify({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: item.text }],
      },
    }));
    this.dc.send(JSON.stringify({ type: 'response.create' }));
  }

  disconnect(): void {
    this.cleanup();
  }

  private cleanup(): void {
    if (this.micStream) {
      for (const track of this.micStream.getTracks()) track.stop();
      this.micStream = null;
    }
    if (this.audioEl) {
      this.audioEl.srcObject = null;
      this.audioEl.parentNode?.removeChild(this.audioEl);
      this.audioEl = null;
    }
    if (this.dc) {
      this.dc.close();
      this.dc = null;
    }
    if (this.pc) {
      this.pc.close();
      this.pc = null;
    }
    this.callbacks = null;
    this.notificationQueue = [];
    this.currentResponseContext = null;
    this.pendingNotificationContext = null;
    this.notificationCancelPending = false;
    this.pendingResponseRetry = false;
  }
}
