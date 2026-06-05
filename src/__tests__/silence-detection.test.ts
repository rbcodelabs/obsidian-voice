/**
 * silence-detection.test.ts
 *
 * Tests for the audio-silence detection logic in RealtimeSession and its
 * interaction with the VoiceView silence countdown (simulated inline here
 * so we don't need Obsidian APIs).
 *
 * Key scenarios:
 *  1. waitForAudioSilence fires onAudioDone after 600ms of actual silence
 *  2. waitForAudioSilence does NOT fire while audio is playing
 *  3. response.created cancels a stale silence-wait loop
 *  4. audioDoneFired guard prevents double-fire per response
 *  5. *** BUG SCENARIO ***: user speaks > 15s → should NOT disconnect
 *     Currently fails because waitForAudioSilence fires onAudioDone after
 *     AI audio drains, even if the user started speaking before then.
 *
 * How the mocks work:
 *  - AudioContext / AnalyserNode are mocked globally (Node has neither)
 *  - RMS is controlled by filling the Float32Array with a constant value:
 *    rms = sqrt(mean(v²)) = |v|, so buf.fill(0.1) → rms = 0.1 (audio
 *    playing), buf.fill(0.001) → rms = 0.001 (silence)
 *  - vi.useFakeTimers() controls setTimeout so we don't have real waits
 *  - CHECK_MS = 50, SILENCE_REQUIRED_MS = 600, so 12 silent ticks → fire
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RealtimeSession, SessionCallbacks } from '../RealtimeSession';

// ---------------------------------------------------------------------------
// Web Audio API mocks (not available in Node)
// ---------------------------------------------------------------------------

type MockAnalyser = {
  fftSize: number;
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  getFloatTimeDomainData: ReturnType<typeof vi.fn>;
  /** Controls what RMS the next check() sees. */
  rms: number;
};

function makeMockAnalyser(initialRms = 0.1): MockAnalyser {
  const analyser: MockAnalyser = {
    fftSize: 512,
    rms: initialRms,
    connect: vi.fn(),
    disconnect: vi.fn(),
    getFloatTimeDomainData: vi.fn((buf: Float32Array) => {
      // Fill with a constant so sqrt(mean(v²)) = |v| = analyser.rms
      buf.fill(analyser.rms);
    }),
  };
  return analyser;
}

type MockSource = {
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
};

function makeMockAudioCtx(analyser: MockAnalyser) {
  const source: MockSource = { connect: vi.fn(), disconnect: vi.fn() };
  return {
    state: 'running' as AudioContextState,
    resume: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
    // createMediaElementSource is used by the production code to tap the
    // <audio> element's playback pipeline rather than the raw network stream.
    createMediaElementSource: vi.fn().mockReturnValue(source),
    // Keep createMediaStreamSource to avoid runtime errors if any code path
    // still references it (and so the existing type is still satisfied).
    createMediaStreamSource: vi.fn().mockReturnValue(source),
    createAnalyser: vi.fn().mockReturnValue(analyser),
    destination: {},
    _source: source,
  };
}

// ---------------------------------------------------------------------------
// Inline VoiceView-like silence controller
//
// Simulates just the timer logic from VoiceView so we can test the full
// callback interaction without needing Obsidian APIs.
// ---------------------------------------------------------------------------

const SILENCE_TIMEOUT_SECS = 15;

class SilenceController {
  silenceTimer: ReturnType<typeof setTimeout> | null = null;
  countdownInterval: ReturnType<typeof setInterval> | null = null;
  secsLeft = 0;
  activity: 'user-speaking' | 'ai-responding' | 'silence' | 'idle' = 'idle';
  disconnected = false;
  disconnectAt: number | null = null;   // fake-timer timestamp of disconnect

  reset(secsLeft = SILENCE_TIMEOUT_SECS) {
    this.clear();
    this.activity = 'silence';
    this.secsLeft = secsLeft;
    this.countdownInterval = setInterval(() => {
      this.secsLeft = Math.max(0, this.secsLeft - 1);
    }, 1000);
    this.silenceTimer = setTimeout(() => {
      this.disconnected = true;
      this.disconnectAt = Date.now();
    }, secsLeft * 1000);
  }

  clear() {
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    if (this.countdownInterval) clearInterval(this.countdownInterval);
    this.silenceTimer = null;
    this.countdownInterval = null;
  }

  /** Build the subset of SessionCallbacks that drive timing. */
  asCallbacks(): Partial<SessionCallbacks> {
    return {
      onSpeechStarted: () => {
        this.activity = 'user-speaking';
        this.clear();
      },
      onSpeechStopped: () => {
        this.reset();
      },
      onResponseStarted: () => {
        this.activity = 'ai-responding';
        this.clear();
      },
      onAudioDone: () => {
        // VoiceView resets the silence timer when AI audio finishes
        this.reset();
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeFullCallbacks(ctrl: SilenceController): SessionCallbacks {
  const timing = ctrl.asCallbacks();
  return {
    onTranscript: vi.fn(),
    onToolCall: vi.fn(),
    onStatusChange: vi.fn(),
    onError: vi.fn(),
    getToolResult: vi.fn().mockResolvedValue('ok'),
    onSpeechStarted: vi.fn().mockImplementation(() => timing.onSpeechStarted!()),
    onSpeechStopped: vi.fn().mockImplementation(() => timing.onSpeechStopped!()),
    onResponseStarted: vi.fn().mockImplementation(() => timing.onResponseStarted!()),
    onAudioDone: vi.fn().mockImplementation(() => timing.onAudioDone!()),
  };
}

function fireEvent(
  session: RealtimeSession,
  event: Record<string, unknown>,
  callbacks: SessionCallbacks,
) {
  (session as unknown as { handleEvent: typeof fireEvent }).handleEvent(event, callbacks);
}

function injectAudio(session: RealtimeSession, stream: MediaStream, audioCtx: ReturnType<typeof makeMockAudioCtx>) {
  // Inject a minimal fake <audio> element. The production code now calls
  // createMediaElementSource(audioEl) to tap the playback pipeline rather
  // than createMediaStreamSource(stream), so we only need a truthy object here.
  const audioEl = { srcObject: stream, autoplay: true, style: { display: '' } };
  (session as unknown as Record<string, unknown>).audioEl = audioEl;
  // Pre-inject our mock AudioContext so it's not created via `new AudioContext()`
  (session as unknown as Record<string, unknown>).audioCtxForAnalysis = audioCtx;
}

function get(session: RealtimeSession, field: string): unknown {
  return (session as unknown as Record<string, unknown>)[field];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('waitForAudioSilence — core behaviour', () => {
  let session: RealtimeSession;
  let callbacks: SessionCallbacks;
  let ctrl: SilenceController;
  let analyser: MockAnalyser;
  let audioCtx: ReturnType<typeof makeMockAudioCtx>;
  const fakeStream = {} as MediaStream;

  beforeEach(() => {
    vi.useFakeTimers();
    analyser = makeMockAnalyser(0.1); // starts with audio playing
    audioCtx = makeMockAudioCtx(analyser);
    session = new RealtimeSession();
    ctrl = new SilenceController();
    callbacks = makeFullCallbacks(ctrl);
    injectAudio(session, fakeStream, audioCtx);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires onAudioDone after 600ms of continuous silence (12 × 50ms ticks)', () => {
    analyser.rms = 0.001; // silent from the start

    fireEvent(session, { type: 'response.created' }, callbacks);
    fireEvent(session, { type: 'response.output_audio.done' }, callbacks);

    // 11 ticks of silence → not yet (550ms)
    vi.advanceTimersByTime(550);
    expect(callbacks.onAudioDone).not.toHaveBeenCalled();

    // 12th tick tips it over 600ms
    vi.advanceTimersByTime(50);
    expect(callbacks.onAudioDone).toHaveBeenCalledOnce();
  });

  it('does NOT fire onAudioDone while audio is playing', () => {
    analyser.rms = 0.1; // loud: well above SILENCE_THRESHOLD=0.005

    fireEvent(session, { type: 'response.created' }, callbacks);
    fireEvent(session, { type: 'response.output_audio.done' }, callbacks);

    vi.advanceTimersByTime(2000); // 40 ticks, all noisy
    expect(callbacks.onAudioDone).not.toHaveBeenCalled();
  });

  it('fires only after audio goes quiet (active then silent)', () => {
    analyser.rms = 0.1; // audio playing

    fireEvent(session, { type: 'response.created' }, callbacks);
    fireEvent(session, { type: 'response.output_audio.done' }, callbacks);

    // 400ms of audio playing
    vi.advanceTimersByTime(400);
    expect(callbacks.onAudioDone).not.toHaveBeenCalled();

    // audio drains
    analyser.rms = 0.001;

    // 550ms more — still not enough (only 550ms silent)
    vi.advanceTimersByTime(550);
    expect(callbacks.onAudioDone).not.toHaveBeenCalled();

    // 50ms more — 600ms silent → fires
    vi.advanceTimersByTime(50);
    expect(callbacks.onAudioDone).toHaveBeenCalledOnce();
  });

  it('resets the silence accumulator if audio comes back during the wait', () => {
    analyser.rms = 0.001; // silent

    fireEvent(session, { type: 'response.created' }, callbacks);
    fireEvent(session, { type: 'response.output_audio.done' }, callbacks);

    vi.advanceTimersByTime(400); // 400ms silent
    analyser.rms = 0.1;          // audio bursts back (e.g. comfort noise spike)
    vi.advanceTimersByTime(100); // reset the accumulator
    analyser.rms = 0.001;        // silent again

    vi.advanceTimersByTime(550); // only 550ms since reset → not yet
    expect(callbacks.onAudioDone).not.toHaveBeenCalled();

    vi.advanceTimersByTime(50); // 600ms clean silence → fires
    expect(callbacks.onAudioDone).toHaveBeenCalledOnce();
  });

  it('audioDoneFired guard prevents onAudioDone firing twice for one response', () => {
    analyser.rms = 0.001;

    fireEvent(session, { type: 'response.created' }, callbacks);
    // Both events arrive (e.g. response.audio.done then response.done idle path)
    fireEvent(session, { type: 'response.output_audio.done' }, callbacks);
    // second call is a no-op due to silenceWaitPending guard
    fireEvent(session, { type: 'response.output_audio.done' }, callbacks);

    vi.advanceTimersByTime(700);
    expect(callbacks.onAudioDone).toHaveBeenCalledOnce();
  });

  it('response.created cancels any stale silence-wait from the prior response', () => {
    analyser.rms = 0.001; // silent

    fireEvent(session, { type: 'response.created' }, callbacks);
    fireEvent(session, { type: 'response.output_audio.done' }, callbacks);

    vi.advanceTimersByTime(400); // 400ms into the wait

    // New response interrupts
    fireEvent(session, { type: 'response.created' }, callbacks);

    vi.advanceTimersByTime(400); // 400ms more — old loop should be dead
    expect(callbacks.onAudioDone).not.toHaveBeenCalled();

    // New response ends and silence detected
    fireEvent(session, { type: 'response.output_audio.done' }, callbacks);
    vi.advanceTimersByTime(650);
    expect(callbacks.onAudioDone).toHaveBeenCalledOnce(); // only from the new response
  });

  it('handles the legacy beta event name response.audio.done identically', () => {
    analyser.rms = 0.001;

    fireEvent(session, { type: 'response.created' }, callbacks);
    fireEvent(session, { type: 'response.audio.done' }, callbacks); // old beta name

    vi.advanceTimersByTime(700);
    expect(callbacks.onAudioDone).toHaveBeenCalledOnce();
  });

  it('fires onAudioDone immediately via response.done idle path when output_audio.done was skipped', () => {
    analyser.rms = 0.001; // AI track already silent

    fireEvent(session, { type: 'response.created' }, callbacks);
    // output_audio.done never arrives (e.g. WebRTC didn't echo it)
    fireEvent(session, { type: 'response.done' }, callbacks); // idle path

    vi.advanceTimersByTime(700);
    expect(callbacks.onAudioDone).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// THE KEY BUG SCENARIO: long user message (> 15 seconds)
// ---------------------------------------------------------------------------

describe('silence timer interaction — long user message', () => {
  let session: RealtimeSession;
  let callbacks: SessionCallbacks;
  let ctrl: SilenceController;
  let analyser: MockAnalyser;
  let audioCtx: ReturnType<typeof makeMockAudioCtx>;
  const fakeStream = {} as MediaStream;

  beforeEach(() => {
    vi.useFakeTimers();
    analyser = makeMockAnalyser(0.1);
    audioCtx = makeMockAudioCtx(analyser);
    session = new RealtimeSession();
    ctrl = new SilenceController();
    callbacks = makeFullCallbacks(ctrl);
    injectAudio(session, fakeStream, audioCtx);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * TIMELINE (all durations approximate):
   *
   *  T+0s    AI finishes streaming → response.output_audio.done fires
   *          waitForAudioSilence starts polling (AI audio RMS = 0.1, still playing)
   *
   *  T+0.1s  User starts speaking → speech_started fires
   *          VoiceView clears any silence timer ✓
   *          waitForAudioSilence is still running (AI audio still playing)
   *
   *  T+0.7s  AI audio buffer drains → RMS drops → 600ms silence → onAudioDone
   *          VoiceView calls resetSilenceTimer() → 15s countdown starts
   *          *** USER IS STILL SPEAKING AT THIS POINT ***
   *
   *  T+16s   Countdown expires → DISCONNECT while user is mid-sentence
   *
   * Expected: session should NOT disconnect while user is speaking.
   * The fix requires cancelling waitForAudioSilence when speech_started fires.
   */
  it('does NOT disconnect while the user is speaking a long message (> 15s)', () => {
    // AI finishes response
    fireEvent(session, { type: 'response.created' }, callbacks);
    fireEvent(session, { type: 'response.output_audio.done' }, callbacks);

    // 100ms later: user starts speaking; AI audio still playing (rms=0.1)
    vi.advanceTimersByTime(100);
    expect(ctrl.disconnected).toBe(false);
    fireEvent(session, { type: 'input_audio_buffer.speech_started' }, callbacks);

    // AI audio drains 600ms after user started talking → onAudioDone fires
    analyser.rms = 0.001; // AI track goes silent
    vi.advanceTimersByTime(700); // silence detected → onAudioDone

    // At this point the user is still speaking (only 800ms into their turn)
    // onAudioDone should NOT have started a countdown while user is speaking.
    // Advance 20 seconds total — far beyond the 15s timeout — to see if disconnect fires.
    vi.advanceTimersByTime(20_000);

    expect(ctrl.disconnected).toBe(
      false,
      'Session disconnected while the user was speaking a long message',
    );
  });

  /**
   * COROLLARY: after the user finishes speaking and the AI responds and finishes,
   * the silence countdown SHOULD fire normally (i.e. we're not suppressing it
   * globally — only during active user speech).
   */
  it('DOES disconnect after silence once the user has finished and AI has responded', () => {
    // Full turn: AI speaks → user speaks → AI speaks again → silence → disconnect

    // Turn 1: AI speaks
    fireEvent(session, { type: 'response.created' }, callbacks);
    analyser.rms = 0.1; // AI audio playing
    vi.advanceTimersByTime(1000);
    fireEvent(session, { type: 'response.output_audio.done' }, callbacks);

    // AI audio drains
    analyser.rms = 0.001;
    vi.advanceTimersByTime(700); // onAudioDone fires → 15s countdown

    // User starts speaking (clears countdown)
    fireEvent(session, { type: 'input_audio_buffer.speech_started' }, callbacks);
    vi.advanceTimersByTime(5000); // user speaks for 5 seconds

    // User stops; AI picks up
    fireEvent(session, { type: 'input_audio_buffer.speech_stopped' }, callbacks);
    fireEvent(session, { type: 'response.created' }, callbacks); // clears timer

    // Turn 2: AI speaks and finishes
    analyser.rms = 0.1;
    vi.advanceTimersByTime(2000);
    fireEvent(session, { type: 'response.output_audio.done' }, callbacks);

    // Turn 2 AI audio drains → onAudioDone → 15s countdown
    analyser.rms = 0.001;
    vi.advanceTimersByTime(700);

    expect(ctrl.disconnected).toBe(false); // still within 15s

    // 14.8s more — still connected (onAudioDone fired 100ms before this
    // advance started, so the 15s window ends 100ms into a 14.9s advance;
    // use 14.8s to stay safely inside).
    vi.advanceTimersByTime(14_800);
    expect(ctrl.disconnected).toBe(false);

    // Final 300ms tips it past 15s
    vi.advanceTimersByTime(300);
    expect(ctrl.disconnected).toBe(true);
  });

  /**
   * EDGE CASE: user speaks immediately after AI, before the 600ms silence
   * accumulates. waitForAudioSilence should see the user is speaking and
   * not fire onAudioDone at all during their turn.
   */
  it('does not fire onAudioDone when user starts speaking before AI audio drains', () => {
    fireEvent(session, { type: 'response.created' }, callbacks);
    analyser.rms = 0.1;
    fireEvent(session, { type: 'response.output_audio.done' }, callbacks);

    // 50ms: only 1 poll tick; user speaks immediately
    vi.advanceTimersByTime(50);
    fireEvent(session, { type: 'input_audio_buffer.speech_started' }, callbacks);

    // AI audio drains while user is speaking
    analyser.rms = 0.001;
    vi.advanceTimersByTime(700); // would accumulate 600ms if loop still running

    expect(callbacks.onAudioDone).not.toHaveBeenCalled();
  });

  /**
   * EDGE CASE: user speaks for exactly 15 seconds then stops.
   * Disconnect should come from the speech_stopped path, not mid-message.
   */
  it('correctly attributes the disconnect to post-speech silence, not mid-speech', () => {
    // AI finishes; user starts speaking 100ms later
    fireEvent(session, { type: 'response.created' }, callbacks);
    fireEvent(session, { type: 'response.output_audio.done' }, callbacks);
    vi.advanceTimersByTime(100);
    fireEvent(session, { type: 'input_audio_buffer.speech_started' }, callbacks);

    // User speaks for exactly 15s (the same duration as the silence timeout)
    vi.advanceTimersByTime(15_000);
    expect(ctrl.disconnected).toBe(false); // must still be connected while speaking

    // User stops → 15s silence countdown starts
    fireEvent(session, { type: 'input_audio_buffer.speech_stopped' }, callbacks);

    vi.advanceTimersByTime(14_900);
    expect(ctrl.disconnected).toBe(false);

    vi.advanceTimersByTime(200);
    expect(ctrl.disconnected).toBe(true); // disconnects only after post-speech silence
  });
});

// ---------------------------------------------------------------------------
// GA event names — ensure both old and new names are exercised
// ---------------------------------------------------------------------------

describe('GA event name coverage', () => {
  let session: RealtimeSession;
  let callbacks: SessionCallbacks;
  let analyser: MockAnalyser;
  let audioCtx: ReturnType<typeof makeMockAudioCtx>;
  const fakeStream = {} as MediaStream;

  beforeEach(() => {
    vi.useFakeTimers();
    analyser = makeMockAnalyser(0.001); // silent
    audioCtx = makeMockAudioCtx(analyser);
    session = new RealtimeSession();
    callbacks = {
      onTranscript: vi.fn(),
      onToolCall: vi.fn(),
      onStatusChange: vi.fn(),
      onError: vi.fn(),
      getToolResult: vi.fn().mockResolvedValue('ok'),
      onAudioDone: vi.fn(),
      onSpeechStarted: vi.fn(),
      onSpeechStopped: vi.fn(),
      onResponseStarted: vi.fn(),
    };
    injectAudio(session, fakeStream, audioCtx);
  });

  afterEach(() => { vi.useRealTimers(); });

  it('response.output_audio_transcript.delta fires onTranscript(partial)', () => {
    fireEvent(session, { type: 'response.output_audio_transcript.delta', delta: 'Hi' }, callbacks);
    expect(callbacks.onTranscript).toHaveBeenCalledWith('assistant', 'Hi', false);
  });

  it('response.output_audio_transcript.done fires onTranscript(done)', () => {
    fireEvent(session, { type: 'response.output_audio_transcript.done' }, callbacks);
    expect(callbacks.onTranscript).toHaveBeenCalledWith('assistant', '', true);
  });

  it('response.output_audio.done triggers silence detection (GA name)', () => {
    fireEvent(session, { type: 'response.created' }, callbacks);
    fireEvent(session, { type: 'response.output_audio.done' }, callbacks);
    vi.advanceTimersByTime(700);
    expect(callbacks.onAudioDone).toHaveBeenCalledOnce();
  });

  it('silenceWaitPending is set immediately when response.output_audio.done fires', () => {
    fireEvent(session, { type: 'response.created' }, callbacks);
    fireEvent(session, { type: 'response.output_audio.done' }, callbacks);
    expect(get(session, 'silenceWaitPending')).toBe(true);
  });

  it('silenceWaitPending is reset at response.created (cancels stale poll)', () => {
    fireEvent(session, { type: 'response.created' }, callbacks);
    fireEvent(session, { type: 'response.output_audio.done' }, callbacks);
    expect(get(session, 'silenceWaitPending')).toBe(true);

    fireEvent(session, { type: 'response.created' }, callbacks);
    expect(get(session, 'silenceWaitPending')).toBe(false);
  });

  it(
    'speech_started cancels the silence-wait loop (silenceWaitPending → false)',
    () => {
      analyser.rms = 0.1; // AI audio still playing

      fireEvent(session, { type: 'response.created' }, callbacks);
      fireEvent(session, { type: 'response.output_audio.done' }, callbacks);
      expect(get(session, 'silenceWaitPending')).toBe(true);

      // User starts speaking
      fireEvent(session, { type: 'input_audio_buffer.speech_started' }, callbacks);

      // The poll should be cancelled
      expect(get(session, 'silenceWaitPending')).toBe(false);

      // AI audio drains while user is talking — onAudioDone must NOT fire
      analyser.rms = 0.001;
      vi.advanceTimersByTime(700);
      expect(callbacks.onAudioDone).not.toHaveBeenCalled();
    },
  );
});
