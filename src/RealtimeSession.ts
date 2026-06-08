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

  // Audio playback-end detection — used to find when the AI has actually
  // finished playing audio out of the speakers (not just when the server has
  // finished sending it). response.output_audio.done / response.done fire
  // when the server has flushed all bytes to the RTP stream, but those bytes
  // are still being decoded by the WebRTC receiver and played out of the
  // audio device for hundreds of ms afterwards.
  //
  // Strategy: poll pc.getStats() for the inbound audio track's
  // totalSamplesDuration. This is a cumulative count (in seconds) of audio
  // frames the receiver has decoded. It advances while audio is arriving
  // from the network and stalls as soon as the server stops sending. Once
  // it has stalled for AUDIO_STALL_REQUIRED_MS *and* response.done has
  // arrived, we wait an additional AUDIO_JITTER_DRAIN_MS for the device's
  // playout buffer to actually finish before firing onAudioDone.
  //
  // This is intentionally NOT an analyser-node / RMS measurement. With
  // srcObject = MediaStream, createMediaElementSource on an <audio> element
  // gives a source that tracks frames as they ARRIVE from the network, not
  // frames as they PLAY from the speakers. RMS would go silent the moment
  // the server stopped sending, even if the playout buffer still had
  // several hundred ms of audio left to play.
  private playbackWaitPending = false;
  // Guards against onAudioDone firing more than once per response.
  private audioDoneFired = false;
  // True once response.done has arrived for the in-flight response. Gates
  // onAudioDone: confirming the stream has stalled is not enough on its own.
  // We also need the server to say the response is finalised, otherwise a
  // mid-response packet stall can be misread as end-of-turn.
  // Reset on response.created, set on response.done.
  private responseDoneSeen = true;

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
      // Cancel any in-progress playback-wait so onAudioDone doesn't fire
      // mid-sentence if the AI's buffered audio drains while the user is talking.
      this.playbackWaitPending = false;
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
      this.playbackWaitPending = false; // cancel any stale playback-wait from prior response
      this.responseDoneSeen = false; // gate onAudioDone until response.done arrives for this response
      callbacks.onResponseStarted?.();
      if (this.pendingNotificationContext) {
        this.currentResponseContext = { type: 'notification', threadId: this.pendingNotificationContext.threadId };
        this.pendingNotificationContext = null;
      } else {
        this.currentResponseContext = { type: 'user' };
      }
      if (this.debug) console.debug(`[Voice] response.created — ctx now: ${JSON.stringify(this.currentResponseContext)}`);
    } else if (type === 'response.output_audio.done' || type === 'response.audio.done') {
      // Server finished flushing audio bytes to the RTP stream. The receiver
      // is still decoding and the audio device is still playing the buffered
      // frames — do NOT fire onAudioDone yet. Poll the RTC stats and wait
      // for the actual playout to finish.
      if (this.debug) console.debug(`[Voice] ${type} → starting playback-end detection`);
      this.waitForAudioPlaybackEnd(callbacks);
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
      this.responseDoneSeen = true; // un-gate onAudioDone; if a silence-wait is mid-flight it can now fire
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
      // response.output_audio.done (which starts playback-end detection).
      // This path is a safety net in case that event didn't arrive — e.g.
      // some WebRTC deployments may not echo it on the data channel.
      // waitForAudioPlaybackEnd() is idempotent (playbackWaitPending guard).
      if (this.debug) console.debug('[Voice] response.done: → idle, ensuring playback-end detection is running');
      this.waitForAudioPlaybackEnd(callbacks);
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
   * Polls pc.getStats() every AUDIO_POLL_MS until the inbound audio track's
   * `totalSamplesDuration` has stopped advancing for AUDIO_STALL_REQUIRED_MS
   * AND response.done has arrived, then waits AUDIO_JITTER_DRAIN_MS for the
   * audio device's playout buffer to actually finish and fires onAudioDone.
   *
   * Why getStats instead of an analyser node:
   *   The previous implementation used createMediaElementSource(audioEl) to
   *   tap the <audio> element's playback pipeline. For a WebRTC `<audio>`
   *   whose source is `srcObject = MediaStream`, that source does NOT
   *   reliably reflect speaker output — it tracks frames as they ARRIVE from
   *   the network, so RMS would drop to zero the moment the server stopped
   *   sending, even though the playout buffer still had hundreds of ms of
   *   audio left to play. The result was "Silence" appearing in the UI while
   *   the AI was still audibly talking.
   *
   *   `totalSamplesDuration` is the WebRTC stats field that explicitly
   *   tracks cumulative seconds of audio frames decoded by the receiver.
   *   It stalls as soon as the server stops sending. After it has stalled,
   *   the only thing left between "no new frames arriving" and "speakers
   *   are silent" is the receiver's playout buffer, which we drain with a
   *   fixed AUDIO_JITTER_DRAIN_MS delay.
   *
   * Guards:
   *  - audioDoneFired: prevents double-firing per response
   *  - playbackWaitPending: prevents concurrent polling loops
   *  - TIMEOUT_MS: fallback in case stats are unreliable
   *  - Setting playbackWaitPending=false cancels a running loop (used in
   *    response.created reset, speech_started, and cleanup())
   */
  private waitForAudioPlaybackEnd(callbacks: SessionCallbacks): void {
    if (this.audioDoneFired || this.playbackWaitPending) return;
    this.playbackWaitPending = true;

    if (!this.pc) {
      // No peer connection — fire immediately (shouldn't happen in production)
      this.playbackWaitPending = false;
      this.audioDoneFired = true;
      if (this.debug) console.debug('[Voice] waitForAudioPlaybackEnd: no peer connection → onAudioDone immediately');
      callbacks.onAudioDone?.();
      return;
    }

    const AUDIO_POLL_MS = 100;
    // How long the RTP totalSamplesDuration must hold steady before we
    // conclude the server is done sending. Slightly longer than typical
    // inter-packet gaps so we don't trip on jitter.
    const AUDIO_STALL_REQUIRED_MS = 400;
    // How long to wait after the receive stream stalls for the device
    // playout buffer to actually drain. Typical WebRTC jitter buffers run
    // 100–300 ms; we add a small safety margin.
    const AUDIO_JITTER_DRAIN_MS = 500;
    // Tool-only / empty responses never produce audio. If we never see any
    // frames arrive and response.done has been seen, fire after this grace.
    const NO_AUDIO_GRACE_MS = 300;
    const TIMEOUT_MS = 60_000;

    const t0 = Date.now();
    let lastDuration = 0;
    let lastChangeAt = Date.now();
    let seenAudio = false;
    let playbackStartLogged = false;

    console.log('[Voice] audio stream activity tracking started — waiting for playback to drain');

    const fire = (logMsg: string): void => {
      this.playbackWaitPending = false;
      this.audioDoneFired = true;
      console.log(`[Voice] playback end — ${logMsg} → firing onAudioDone (received ${lastDuration.toFixed(3)}s of audio)`);
      callbacks.onAudioDone?.();
    };

    const check = (): void => {
      if (!this.playbackWaitPending) return;
      if (!this.pc) {
        fire('peer connection gone');
        return;
      }
      if (Date.now() - t0 > TIMEOUT_MS) {
        fire('timeout fallback');
        return;
      }

      // Read stats asynchronously, then make the decision in the .then().
      // Each tick fires one getStats and reschedules itself only after the
      // promise resolves so we never have overlapping reads.
      this.pc.getStats().then((stats) => {
        if (!this.playbackWaitPending) return;

        let duration = lastDuration;
        stats.forEach((report) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const r = report as any;
          if (
            r &&
            r.type === 'inbound-rtp' &&
            r.kind === 'audio' &&
            typeof r.totalSamplesDuration === 'number'
          ) {
            duration = r.totalSamplesDuration;
          }
        });

        if (duration > lastDuration) {
          if (!seenAudio) {
            seenAudio = true;
            playbackStartLogged = true;
            console.log(`[Voice] playback start detected (totalSamplesDuration=${duration.toFixed(3)}s)`);
          }
          lastDuration = duration;
          lastChangeAt = Date.now();
        }

        const stalledMs = Date.now() - lastChangeAt;

        if (this.debug) {
          console.debug(`[Voice] waitForAudioPlaybackEnd: totalSamplesDuration=${duration.toFixed(3)}s stalledMs=${stalledMs} seenAudio=${seenAudio} responseDoneSeen=${this.responseDoneSeen}`);
        }

        // Path A: audio HAS arrived, stream has stalled, server has finalised
        // → schedule the drain timer, then fire.
        if (seenAudio && stalledMs >= AUDIO_STALL_REQUIRED_MS && this.responseDoneSeen) {
          this.playbackWaitPending = false; // claim ownership; no more polling
          console.log(`[Voice] received audio stream stalled for ${stalledMs}ms — waiting ${AUDIO_JITTER_DRAIN_MS}ms for jitter buffer drain`);
          setTimeout(() => fire('jitter buffer drained'), AUDIO_JITTER_DRAIN_MS);
          return;
        }

        // Path B: no audio at all for this response (tool-only / empty),
        // server has finalised, and we've waited long enough to be sure no
        // audio is coming.
        if (!seenAudio && this.responseDoneSeen && Date.now() - t0 >= NO_AUDIO_GRACE_MS) {
          fire('no audio received this response');
          return;
        }

        setTimeout(check, AUDIO_POLL_MS);
      }).catch(() => {
        // getStats can fail mid-renegotiation — just keep polling.
        if (this.playbackWaitPending) setTimeout(check, AUDIO_POLL_MS);
      });

      // Reference playbackStartLogged so TS doesn't complain it's unused
      // when debug logging is off.
      void playbackStartLogged;
    };

    setTimeout(check, AUDIO_POLL_MS);
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

  /**
   * Inject a user-role text message into the conversation and trigger a
   * response. If a response is currently in flight it is cancelled first
   * (same race-handling pattern as flushToolBatch and sendNotification).
   *
   * Used by the voice_disconnect abort UI: when the user clicks "Stay
   * connected" during the 3-second grace, this is called with a brief
   * "user cancelled" message so the model resumes the conversation.
   */
  async injectUserMessage(text: string): Promise<void> {
    if (!this.dc || this.dc.readyState !== 'open') return;

    if (this.debug) console.debug(`[Voice] injectUserMessage: isResponseActive=${this.isResponseActive} text="${text.slice(0, 80)}"`);

    if (this.isResponseActive) {
      if (this.debug) console.debug('[Voice] injectUserMessage: cancelling active response first');
      this.dc.send(JSON.stringify({ type: 'response.cancel' }));
      await new Promise<void>(resolve => this.responseDoneResolvers.push(resolve));
      if (!this.dc || this.dc.readyState !== 'open') return;
    }

    this.dc.send(JSON.stringify({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text }],
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
    // Cancel any running playback-end poll
    this.playbackWaitPending = false;
    this.audioDoneFired = false;
    this.responseDoneSeen = true; // safe default once nothing is in flight
  }
}
