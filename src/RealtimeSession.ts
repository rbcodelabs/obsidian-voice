export type SessionStatus = 'idle' | 'connecting' | 'connected' | 'error';

export interface SessionCallbacks {
  onTranscript: (role: 'user' | 'assistant', text: string, done: boolean) => void;
  onToolCall: (callId: string, name: string, args: string) => void;
  onStatusChange: (status: SessionStatus) => void;
  onError: (msg: string) => void;
  getToolResult: (callId: string, name: string, argsJson: string) => Promise<string>;
  /** Fired when the server VAD detects the user has started speaking. */
  onSpeechStarted?: () => void;
  /** Fired when the server VAD detects the user has stopped speaking. */
  onSpeechStopped?: () => void;
  /** Fired when the server begins generating a response (response.created). */
  onResponseStarted?: () => void;
  /** Fired when the server has finished streaming all audio for a response. */
  onAudioDone?: () => void;
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
  private debug = false;

  // Audio silence detection — used to find when the AI has actually finished
  // playing audio (not just when the server finished sending it).
  // response.output_audio.done / response.done fire when the server is done,
  // but audio may still be playing from the client-side WebRTC buffer.
  private audioCtxForAnalysis: AudioContext | null = null;
  // Cached MediaElementAudioSourceNode — createMediaElementSource() can only
  // be called once per element per AudioContext; we reuse this across responses.
  private audioElementSource: MediaElementAudioSourceNode | null = null;
  private silenceWaitPending = false;
  // Guards against onAudioDone firing more than once per response.
  private audioDoneFired = false;

  async connect(
    apiKey: string,
    model: string,
    voice: string,
    systemPrompt: string,
    callbacks: SessionCallbacks,
    tools: unknown[] = [],
    debug = false
  ): Promise<void> {
    callbacks.onStatusChange('connecting');
    this.callbacks = callbacks;
    this.debug = debug;

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

    if (this.debug) console.debug(`[Voice] event: ${type}`);

    if (type === 'input_audio_buffer.speech_started') {
      // Cancel any in-progress silence-wait so onAudioDone doesn't fire
      // mid-sentence if the AI's buffered audio drains while the user is talking.
      this.silenceWaitPending = false;
      callbacks.onSpeechStarted?.();
      return;
    }

    if (type === 'input_audio_buffer.speech_stopped') {
      callbacks.onSpeechStopped?.();
      return;
    }

    if (type === 'response.created') {
      this.isResponseActive = true;
      this.audioDoneFired = false; // arm for the new response
      this.silenceWaitPending = false; // cancel any stale silence-wait from prior response
      callbacks.onResponseStarted?.();
      if (this.pendingNotificationContext) {
        this.currentResponseContext = { type: 'notification', threadId: this.pendingNotificationContext.threadId };
        this.pendingNotificationContext = null;
      } else {
        this.currentResponseContext = { type: 'user' };
      }
      if (this.debug) console.debug(`[Voice] response.created — ctx now: ${JSON.stringify(this.currentResponseContext)}`);
    } else if (type === 'response.output_audio.done' || type === 'response.audio.done') {
      // Server finished streaming audio bytes to the client buffer.
      // In WebRTC mode the <audio> element still plays from that buffer for
      // some time after this event — do NOT fire onAudioDone yet.
      // Instead, poll the audio level and wait for actual silence.
      if (this.debug) console.debug(`[Voice] ${type} → starting audio silence detection`);
      this.waitForAudioSilence(callbacks);
    } else if (type === 'response.output_audio_transcript.done' || type === 'response.audio_transcript.done') {
      callbacks.onTranscript('assistant', '', true);
    } else if (type === 'response.output_audio_transcript.delta' || type === 'response.audio_transcript.delta') {
      const delta = (event.delta as string) ?? '';
      if (delta) callbacks.onTranscript('assistant', delta, false);
    } else if (type === 'conversation.item.input_audio_transcription.completed') {
      const transcript = (event.transcript as string) ?? '';
      if (transcript) callbacks.onTranscript('user', transcript, true);
    } else if (type === 'response.function_call_arguments.done') {
      const callId = (event.call_id as string) ?? '';
      const name = (event.name as string) ?? '';
      const argsJson = (event.arguments as string) ?? '{}';
      console.debug(`[Voice] Tool call buffered: ${name} (${callId}) — pendingTools now ${this.pendingToolCalls.length + 1}`);
      callbacks.onToolCall(callId, name, argsJson);
      this.pendingToolCalls.push({ callId, name, argsJson });
    } else if (type === 'response.done') {
      this.isResponseActive = false;
      this.currentResponseContext = null;

      const resolvers = this.responseDoneResolvers.splice(0);
      for (const resolve of resolvers) resolve();

      if (this.debug) console.debug(`[Voice] response.done: resolvers=${resolvers.length} pendingTools=${this.pendingToolCalls.length} notifQueue=${this.notificationQueue.length} notifCancelPending=${this.notificationCancelPending} pendingRetry=${this.pendingResponseRetry}`);

      // If this done was triggered by a flushToolBatch cancel-wait, don't
      // touch the notification queue — flushToolBatch will send response.create
      // and the next response.done will drain it.
      if (resolvers.length > 0) {
        if (this.debug) console.debug('[Voice] response.done: → early return (flushToolBatch cancel-wait resolved)');
        return;
      }

      // Tool batch takes priority over notifications
      if (this.pendingToolCalls.length > 0) {
        const batch = this.pendingToolCalls.splice(0);
        void this.flushToolBatch(batch, callbacks);
        if (this.debug) console.debug('[Voice] response.done: → flushing tool batch');
        return;
      }

      // Drain notification queue
      if (this.notificationCancelPending || this.notificationQueue.length > 0) {
        if (this.debug) console.debug(`[Voice] response.done: → draining notification queue (${this.notificationQueue.length + (this.notificationCancelPending ? 1 : 0)} pending)`);
        this.notificationCancelPending = false;
        const next = this.notificationQueue.shift();
        if (next) void this.sendNotification(next);
        return;
      }

      // Retry a response.create that was rejected due to an active-response race.
      // The conversation item already landed; just nudge the server to respond to it.
      if (this.pendingResponseRetry && !this.isResponseActive && this.notificationQueue.length === 0) {
        this.pendingResponseRetry = false;
        if (this.debug) console.debug('[Voice] response.done: → firing pendingResponseRetry response.create');
        if (this.dc && this.dc.readyState === 'open') {
          this.dc.send(JSON.stringify({ type: 'response.create' }));
        }
        return;
      }

      // Session is truly idle. Primary trigger for onAudioDone is
      // response.output_audio.done (which starts audio silence detection).
      // This path is a safety net in case that event didn't arrive — e.g.
      // some WebRTC deployments may not echo it on the data channel.
      // waitForAudioSilence() is idempotent (silenceWaitPending guard).
      if (this.debug) console.debug('[Voice] response.done: → idle, ensuring audio silence detection is running');
      this.waitForAudioSilence(callbacks);
    } else if (type === 'error') {
      const errorObj = event.error as Record<string, unknown> | undefined;
      const errMsg = (errorObj?.message as string) ?? (event.message as string) ?? JSON.stringify(event);
      const errCode = (errorObj?.code as string) ?? '';

      // "conversation already has active response" is a timing race we can recover from:
      // our conversation.item.create already landed, so just retry response.create on next response.done.
      if (errCode === 'conversation_already_has_active_response' || errMsg.includes('already has an active response')) {
        if (this.debug) console.warn(`[Voice] Active-response race (suppressed): "${errMsg}" — pendingResponseRetry set`);
        this.pendingResponseRetry = true;
        return;
      }

      console.error('[Voice] Server error:', event);
      callbacks.onError(`Server error: ${errMsg}`);
    }
  }

  /**
   * Polls the <audio> element's playback amplitude every 50 ms until the level
   * stays below SILENCE_THRESHOLD for SILENCE_REQUIRED_MS, then fires
   * onAudioDone.  This correctly handles the gap between when the server says
   * "all audio bytes sent" (response.output_audio.done / response.done) and
   * when the client-side playback buffer actually drains.
   *
   * IMPORTANT: we tap the <audio> element via createMediaElementSource(), NOT
   * the raw WebRTC stream via createMediaStreamSource().  The element source
   * reflects what the audio renderer is actually outputting; the stream source
   * only reflects what has arrived over the network and can go quiet while the
   * browser's playback buffer still has seconds of audio left to play.
   *
   * Guards:
   *  - audioDoneFired: prevents double-firing per response
   *  - silenceWaitPending: prevents concurrent polling loops
   *  - TIMEOUT_MS: fallback in case analysis fails (no audio element, etc.)
   *  - Setting silenceWaitPending=false cancels a running loop (used in
   *    response.created reset and cleanup())
   */
  private waitForAudioSilence(callbacks: SessionCallbacks): void {
    if (this.audioDoneFired || this.silenceWaitPending) return;
    this.silenceWaitPending = true;

    if (!this.audioEl) {
      // No audio element yet — fire immediately (first-connect edge case)
      this.silenceWaitPending = false;
      this.audioDoneFired = true;
      if (this.debug) console.debug('[Voice] waitForAudioSilence: no audio element → onAudioDone immediately');
      callbacks.onAudioDone?.();
      return;
    }

    // Log moment 1: network buffer receipt (caller already logged the event,
    // but mark the start of our playback-end wait here for tracing).
    console.log('[Voice] audio buffer received from network — waiting for playback to finish');

    if (!this.audioCtxForAnalysis) {
      this.audioCtxForAnalysis = new AudioContext();
    }
    const ctx = this.audioCtxForAnalysis;
    if (ctx.state === 'suspended') void ctx.resume();

    // Use createMediaElementSource so we measure the audio element's actual
    // decoder output, not the raw network stream.  createMediaElementSource
    // can only be called once per element; reuse the cached node across
    // responses and reconnect it to a fresh analyser each time.
    if (!this.audioElementSource) {
      try {
        this.audioElementSource = ctx.createMediaElementSource(this.audioEl);
        // Route through the context's destination so the audio still plays.
        this.audioElementSource.connect(ctx.destination);
      } catch {
        // createMediaElementSource failed (e.g. in tests / unsupported env) —
        // fall back to immediate fire so session state still advances.
        this.audioElementSource = null;
        this.silenceWaitPending = false;
        this.audioDoneFired = true;
        callbacks.onAudioDone?.();
        return;
      }
    }

    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    this.audioElementSource.connect(analyser);
    const buf = new Float32Array(analyser.fftSize);

    const SILENCE_THRESHOLD  = 0.005; // RMS below this = silent
    const SILENCE_REQUIRED_MS = 600;  // must stay silent this long
    const CHECK_MS = 50;
    const TIMEOUT_MS = 30_000;
    const t0 = Date.now();
    let silenceMs = 0;
    let playbackStartLogged = false;

    if (this.debug) console.debug('[Voice] waitForAudioSilence: polling started (element source)');

    const check = () => {
      if (!this.silenceWaitPending) {
        analyser.disconnect(); // cancelled by response.created or cleanup()
        return;
      }
      if (Date.now() - t0 > TIMEOUT_MS) {
        if (this.debug) console.debug('[Voice] waitForAudioSilence: timeout → onAudioDone');
        analyser.disconnect();
        this.silenceWaitPending = false;
        this.audioDoneFired = true;
        // Log moment 3: playback end (via timeout fallback)
        console.log('[Voice] playback end detected (timeout fallback) — transitioning to silence');
        callbacks.onAudioDone?.();
        return;
      }

      analyser.getFloatTimeDomainData(buf);
      const rms = Math.sqrt(buf.reduce((s, v) => s + v * v, 0) / buf.length);

      // Log moment 2: playback start (first tick where audio is actually playing)
      if (!playbackStartLogged && rms >= SILENCE_THRESHOLD) {
        playbackStartLogged = true;
        console.log(`[Voice] playback start detected (rms=${rms.toFixed(4)})`);
      }

      if (this.debug && silenceMs % 500 < CHECK_MS) {
        console.debug(`[Voice] waitForAudioSilence: rms=${rms.toFixed(4)} silenceMs=${silenceMs}`);
      }

      if (rms < SILENCE_THRESHOLD) {
        silenceMs += CHECK_MS;
        if (silenceMs >= SILENCE_REQUIRED_MS) {
          if (this.debug) console.debug(`[Voice] waitForAudioSilence: silence confirmed (rms=${rms.toFixed(4)}) → onAudioDone`);
          analyser.disconnect();
          this.silenceWaitPending = false;
          this.audioDoneFired = true;
          // Log moment 3: playback end (silence confirmed)
          console.log(`[Voice] playback end detected — audio silent for ${SILENCE_REQUIRED_MS}ms, transitioning to silence`);
          callbacks.onAudioDone?.();
          return;
        }
      } else {
        silenceMs = 0;
      }

      setTimeout(check, CHECK_MS);
    };

    setTimeout(check, CHECK_MS);
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
      if (this.debug) console.debug('[Voice] Active response detected; sending response.cancel before tool outputs');
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

    if (this.debug) console.debug(`[Voice] injectNotification: threadId="${threadId}" isResponseActive=${this.isResponseActive} queueLen=${this.notificationQueue.length} ctx=${JSON.stringify(this.currentResponseContext)}`);

    const item = { threadId, text };

    if (!this.isResponseActive) {
      if (this.debug) console.debug(`[Voice] injectNotification: no active response — sending immediately`);
      void this.sendNotification(item);
      return;
    }

    if (
      this.currentResponseContext?.type === 'notification' &&
      this.currentResponseContext.threadId === threadId
    ) {
      // Same thread being discussed — cancel and re-queue
      if (this.debug) console.debug(`[Voice] injectNotification: same-thread interrupt — cancelling active response and queueing`);
      this.notificationQueue.push(item);
      this.notificationCancelPending = true;
      this.dc.send(JSON.stringify({ type: 'response.cancel' }));
    } else {
      // Different context — queue for later
      if (this.debug) console.debug(`[Voice] injectNotification: queuing — different context active`);
      this.notificationQueue.push(item);
    }
  }

  private async sendNotification(item: { threadId: string; text: string }): Promise<void> {
    if (!this.dc || this.dc.readyState !== 'open') return;

    if (this.debug) console.debug(`[Voice] sendNotification: isResponseActive=${this.isResponseActive} text="${item.text.slice(0, 80)}"`);

    // If a response is active, cancel it first (same guard as flushToolBatch)
    if (this.isResponseActive) {
      if (this.debug) console.debug(`[Voice] sendNotification: active response detected — cancelling before inject`);
      this.dc.send(JSON.stringify({ type: 'response.cancel' }));
      await new Promise<void>(resolve => this.responseDoneResolvers.push(resolve));
      if (!this.dc || this.dc.readyState !== 'open') return;
      if (this.debug) console.debug(`[Voice] sendNotification: cancel resolved — sending conversation.item.create + response.create`);
    } else {
      if (this.debug) console.debug(`[Voice] sendNotification: sending conversation.item.create + response.create`);
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
    this.debug = false;
    this.notificationQueue = [];
    this.currentResponseContext = null;
    this.pendingNotificationContext = null;
    this.notificationCancelPending = false;
    this.pendingResponseRetry = false;
    // Cancel any running silence poll and release the AudioContext
    this.silenceWaitPending = false;
    this.audioDoneFired = false;
    this.audioElementSource = null; // released when ctx closes
    if (this.audioCtxForAnalysis) {
      void this.audioCtxForAnalysis.close();
      this.audioCtxForAnalysis = null;
    }
  }
}
