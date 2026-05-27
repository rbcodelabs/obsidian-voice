export type SessionStatus = 'idle' | 'connecting' | 'connected' | 'error';

export interface SessionCallbacks {
  onTranscript: (role: 'user' | 'assistant', text: string, done: boolean) => void;
  onToolCall: (callId: string, name: string, args: string) => void;
  onStatusChange: (status: SessionStatus) => void;
  onError: (msg: string) => void;
  getToolResult: (callId: string, name: string, argsJson: string) => Promise<string>;
}

export class RealtimeSession {
  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private audioEl: HTMLAudioElement | null = null;
  private micStream: MediaStream | null = null;

  async connect(
    apiKey: string,
    model: string,
    voice: string,
    systemPrompt: string,
    callbacks: SessionCallbacks,
    tools: unknown[] = []
  ): Promise<void> {
    callbacks.onStatusChange('connecting');

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

    if (type === 'response.audio_transcript.delta') {
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
      console.debug('[Voice] Tool call:', name, callId, argsJson);
      callbacks.onToolCall(callId, name, argsJson);
      callbacks.getToolResult(callId, name, argsJson)
        .then((result) => {
          console.debug('[Voice] Tool result:', name, result.slice(0, 200));
          this.sendFunctionOutput(callId, result);
        })
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          console.error('[Voice] Tool error:', name, msg);
          this.sendFunctionOutput(callId, `Error: ${msg}`);
        });
    } else if (type === 'error') {
      const errMsg = (event.message as string) ?? JSON.stringify(event);
      console.error('[Voice] Server error:', event);
      callbacks.onError(`Server error: ${errMsg}`);
    }
  }

  sendFunctionOutput(callId: string, output: string): void {
    if (!this.dc || this.dc.readyState !== 'open') return;
    console.debug('[Voice] Sending function output for', callId);

    this.dc.send(JSON.stringify({
      type: 'conversation.item.create',
      item: {
        type: 'function_call_output',
        call_id: callId,
        output,
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
  }
}
