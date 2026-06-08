/**
 * silence-detection.test.ts
 *
 * Tests for the audio-playback-end detection logic in RealtimeSession and
 * its interaction with the VoiceView silence countdown (simulated inline
 * here so we don't need Obsidian APIs).
 *
 * The implementation under test (`waitForAudioPlaybackEnd`) polls
 * `pc.getStats()` for the inbound audio track's `totalSamplesDuration` —
 * the cumulative count, in seconds, of audio frames decoded by the WebRTC
 * receiver. It advances while audio is arriving and stalls when the server
 * stops sending. Once it has stalled for AUDIO_STALL_REQUIRED_MS (400ms)
 * AND response.done has arrived, the loop schedules a fixed
 * AUDIO_JITTER_DRAIN_MS (500ms) wait for the audio device playout buffer
 * to drain, then fires onAudioDone.
 *
 * Key scenarios:
 *  1. Fires onAudioDone after stream stalls + 500ms drain (once response.done seen)
 *  2. Does NOT fire while audio frames are still arriving
 *  3. responseDoneSeen gate: silence before response.done held indefinitely
 *  4. audioDoneFired guard prevents double-fire per response
 *  5. response.created cancels a stale poll loop
 *  6. BUG SCENARIO: user speaking long message must not be cut off
 *  7. Tool-only response (no audio frames) fires after NO_AUDIO_GRACE_MS
 *
 * How the mocks work:
 *  - We inject a fake RTCPeerConnection whose getStats() returns a Map
 *    containing a single inbound-rtp audio report whose
 *    totalSamplesDuration is controlled by the test via setSamplesDuration().
 *  - Timing constants:
 *      AUDIO_POLL_MS = 100
 *      AUDIO_STALL_REQUIRED_MS = 400
 *      AUDIO_JITTER_DRAIN_MS = 500
 *      NO_AUDIO_GRACE_MS = 300
 *  - getStats() returns a Promise, so tests use vi.advanceTimersByTimeAsync
 *    to flush both timers and microtasks.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RealtimeSession, SessionCallbacks } from '../RealtimeSession';

// ---------------------------------------------------------------------------
// pc.getStats() mock
// ---------------------------------------------------------------------------

interface MockPcHandle {
  pc: RTCPeerConnection;
  /** Set the totalSamplesDuration that the next getStats() call will report. */
  setSamplesDuration: (secs: number) => void;
  /** Spy on how many times getStats has been called. */
  getStatsCalls: () => number;
}

function makeMockPc(): MockPcHandle {
  const state = { duration: 0, calls: 0 };
  const report = {
    type: 'inbound-rtp',
    kind: 'audio',
    get totalSamplesDuration(): number {
      return state.duration;
    },
  };
  // Use a Map-like with .forEach to match RTCStatsReport's interface
  const stats = {
    forEach: (cb: (r: unknown) => void) => {
      cb(report);
    },
  };
  const pc = {
    getStats: vi.fn().mockImplementation(() => {
      state.calls += 1;
      return Promise.resolve(stats);
    }),
    close: vi.fn(),
  };
  return {
    pc: pc as unknown as RTCPeerConnection,
    setSamplesDuration: (secs) => {
      state.duration = secs;
    },
    getStatsCalls: () => state.calls,
  };
}

// ---------------------------------------------------------------------------
// Inline VoiceView-like silence controller
// ---------------------------------------------------------------------------

const SILENCE_TIMEOUT_SECS = 15;

class SilenceController {
  silenceTimer: ReturnType<typeof setTimeout> | null = null;
  countdownInterval: ReturnType<typeof setInterval> | null = null;
  secsLeft = 0;
  activity: 'user-speaking' | 'ai-responding' | 'silence' | 'idle' = 'idle';
  disconnected = false;
  disconnectAt: number | null = null;

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

function injectPc(session: RealtimeSession, pc: RTCPeerConnection) {
  (session as unknown as Record<string, unknown>).pc = pc;
  // Also inject a truthy audio element so any code path that checks for one
  // still has something to look at.
  (session as unknown as Record<string, unknown>).audioEl = { srcObject: {}, autoplay: true };
}

function get(session: RealtimeSession, field: string): unknown {
  return (session as unknown as Record<string, unknown>)[field];
}

/**
 * Drive the polling loop forward by N ms. Awaits microtasks after each tick
 * so that getStats().then() handlers run before the next timer fires.
 */
async function tick(ms: number) {
  await vi.advanceTimersByTimeAsync(ms);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('waitForAudioPlaybackEnd — core behaviour', () => {
  let session: RealtimeSession;
  let callbacks: SessionCallbacks;
  let ctrl: SilenceController;
  let pcHandle: MockPcHandle;

  beforeEach(() => {
    vi.useFakeTimers();
    pcHandle = makeMockPc();
    session = new RealtimeSession();
    ctrl = new SilenceController();
    callbacks = makeFullCallbacks(ctrl);
    injectPc(session, pcHandle.pc);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires onAudioDone after stream stalls + jitter drain (responseDoneSeen)', async () => {
    fireEvent(session, { type: 'response.created' }, callbacks);

    // Simulate 1.5 seconds of received audio over 1.5 seconds wall time
    pcHandle.setSamplesDuration(0.1);
    fireEvent(session, { type: 'response.output_audio.done' }, callbacks);
    fireEvent(session, { type: 'response.done' }, callbacks); // un-gates onAudioDone

    // Audio still arriving for 1500ms — polls every 100ms, duration grows
    for (let t = 100; t <= 1500; t += 100) {
      pcHandle.setSamplesDuration(t / 1000);
      await tick(100);
    }
    expect(callbacks.onAudioDone).not.toHaveBeenCalled();

    // Stream stalls — duration no longer advances
    // 400ms of stall (poll keeps reading same value) → schedule drain
    await tick(400);
    expect(callbacks.onAudioDone).not.toHaveBeenCalled();

    // 500ms drain timer → fire
    await tick(500);
    expect(callbacks.onAudioDone).toHaveBeenCalledOnce();
  });

  it('does NOT fire while audio is still arriving', async () => {
    fireEvent(session, { type: 'response.created' }, callbacks);
    fireEvent(session, { type: 'response.output_audio.done' }, callbacks);
    fireEvent(session, { type: 'response.done' }, callbacks);

    // Steadily increasing duration for 3 seconds — never stalls
    for (let t = 100; t <= 3000; t += 100) {
      pcHandle.setSamplesDuration(t / 1000);
      await tick(100);
    }
    expect(callbacks.onAudioDone).not.toHaveBeenCalled();
  });

  it('responseDoneSeen gate: stalled stream held until response.done arrives', async () => {
    fireEvent(session, { type: 'response.created' }, callbacks);
    pcHandle.setSamplesDuration(0.5);
    fireEvent(session, { type: 'response.output_audio.done' }, callbacks);

    // First tick records the duration
    await tick(100);

    // 5 seconds of stall — but response.done withheld → must not fire
    await tick(5000);
    expect(callbacks.onAudioDone).not.toHaveBeenCalled();

    // response.done arrives → next poll detects stalledMs >= 400 → drain → fire
    fireEvent(session, { type: 'response.done' }, callbacks);
    await tick(100); // next poll, decides to drain
    await tick(500); // drain timer
    expect(callbacks.onAudioDone).toHaveBeenCalledOnce();
  });

  it('audioDoneFired guard prevents onAudioDone firing twice for one response', async () => {
    fireEvent(session, { type: 'response.created' }, callbacks);
    pcHandle.setSamplesDuration(0.3);

    // Both output_audio.done events arrive (idempotent)
    fireEvent(session, { type: 'response.output_audio.done' }, callbacks);
    fireEvent(session, { type: 'response.output_audio.done' }, callbacks);
    fireEvent(session, { type: 'response.done' }, callbacks);

    // Wait for the full sequence: 100ms first tick, 400ms stall, 500ms drain
    await tick(1100);
    expect(callbacks.onAudioDone).toHaveBeenCalledOnce();
  });

  it('response.created cancels any stale poll from the prior response', async () => {
    fireEvent(session, { type: 'response.created' }, callbacks);
    pcHandle.setSamplesDuration(0.5);
    fireEvent(session, { type: 'response.output_audio.done' }, callbacks);
    fireEvent(session, { type: 'response.done' }, callbacks);

    // 200ms into the wait — poll has recorded the duration once
    await tick(200);
    expect(get(session, 'playbackWaitPending')).toBe(true);

    // New response interrupts before the stall + drain completes
    fireEvent(session, { type: 'response.created' }, callbacks);
    expect(get(session, 'playbackWaitPending')).toBe(false);

    // Advance well past the old drain deadline — must not fire from the dead loop
    await tick(2000);
    expect(callbacks.onAudioDone).not.toHaveBeenCalled();

    // New response ends with audio that stalls cleanly
    pcHandle.setSamplesDuration(0.8);
    fireEvent(session, { type: 'response.output_audio.done' }, callbacks);
    fireEvent(session, { type: 'response.done' }, callbacks);
    await tick(100); // first poll picks up the new duration
    await tick(400); // stall
    await tick(500); // drain
    expect(callbacks.onAudioDone).toHaveBeenCalledOnce();
  });

  it('handles the legacy beta event name response.audio.done', async () => {
    fireEvent(session, { type: 'response.created' }, callbacks);
    pcHandle.setSamplesDuration(0.2);
    fireEvent(session, { type: 'response.audio.done' }, callbacks);
    fireEvent(session, { type: 'response.done' }, callbacks);

    await tick(100); // first poll
    await tick(400); // stall
    await tick(500); // drain
    expect(callbacks.onAudioDone).toHaveBeenCalledOnce();
  });

  it('tool-only response (no audio) fires after NO_AUDIO_GRACE_MS', async () => {
    // No audio frames ever arrive. Only response.created → response.done.
    fireEvent(session, { type: 'response.created' }, callbacks);
    fireEvent(session, { type: 'response.done' }, callbacks); // idle safety path

    // 100ms first poll: duration=0, seenAudio=false, responseDoneSeen=true
    // but elapsed since t0 (100ms) < NO_AUDIO_GRACE_MS (300)
    await tick(100);
    expect(callbacks.onAudioDone).not.toHaveBeenCalled();

    // 300ms total elapsed → fires
    await tick(300);
    expect(callbacks.onAudioDone).toHaveBeenCalledOnce();
  });

  it('cleanup() resets responseDoneSeen and playbackWaitPending', async () => {
    fireEvent(session, { type: 'response.created' }, callbacks);
    expect(get(session, 'responseDoneSeen')).toBe(false);

    pcHandle.setSamplesDuration(0.3);
    fireEvent(session, { type: 'response.output_audio.done' }, callbacks);
    await tick(50); // start the poll
    expect(get(session, 'playbackWaitPending')).toBe(true);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (session as any).cleanup();

    expect(get(session, 'responseDoneSeen')).toBe(true);
    expect(get(session, 'playbackWaitPending')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// THE KEY BUG SCENARIO: long user message (> 15 seconds)
// ---------------------------------------------------------------------------

describe('silence timer interaction — long user message', () => {
  let session: RealtimeSession;
  let callbacks: SessionCallbacks;
  let ctrl: SilenceController;
  let pcHandle: MockPcHandle;

  beforeEach(() => {
    vi.useFakeTimers();
    pcHandle = makeMockPc();
    session = new RealtimeSession();
    ctrl = new SilenceController();
    callbacks = makeFullCallbacks(ctrl);
    injectPc(session, pcHandle.pc);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * The original bug: user speaks longer than the silence timeout. The
   * silence countdown must NOT fire mid-sentence. speech_started must
   * cancel the playback-end poll so it cannot fire onAudioDone (which
   * would arm the countdown).
   */
  it('does NOT disconnect while the user is speaking a long message (> 15s)', async () => {
    fireEvent(session, { type: 'response.created' }, callbacks);
    pcHandle.setSamplesDuration(0.5);
    fireEvent(session, { type: 'response.output_audio.done' }, callbacks);

    // User starts speaking 100ms later (AI audio still arriving)
    await tick(100);
    expect(ctrl.disconnected).toBe(false);
    fireEvent(session, { type: 'input_audio_buffer.speech_started' }, callbacks);

    // playbackWaitPending must have been cleared
    expect(get(session, 'playbackWaitPending')).toBe(false);

    // Stream stalls (no more audio), 20 seconds pass — must not disconnect
    await tick(20_000);
    expect(callbacks.onAudioDone).not.toHaveBeenCalled();
    expect(ctrl.disconnected).toBe(false);
  });

  it('DOES disconnect after silence once user has finished and AI has responded', async () => {
    // Turn 1: AI speaks
    fireEvent(session, { type: 'response.created' }, callbacks);
    pcHandle.setSamplesDuration(1.0);
    fireEvent(session, { type: 'response.output_audio.done' }, callbacks);
    fireEvent(session, { type: 'response.done' }, callbacks);

    // Poll picks up duration, stalls, drains
    await tick(100); // first poll
    await tick(400); // stall confirmed
    await tick(500); // drain timer → fires onAudioDone → starts 15s countdown

    // User starts speaking (clears countdown)
    fireEvent(session, { type: 'input_audio_buffer.speech_started' }, callbacks);
    await tick(5000); // user speaks 5s
    fireEvent(session, { type: 'input_audio_buffer.speech_stopped' }, callbacks);
    fireEvent(session, { type: 'response.created' }, callbacks);

    // Turn 2: AI responds
    pcHandle.setSamplesDuration(2.0);
    fireEvent(session, { type: 'response.output_audio.done' }, callbacks);
    fireEvent(session, { type: 'response.done' }, callbacks);
    await tick(100); // first poll
    await tick(400); // stall
    await tick(500); // drain → fires → 15s countdown

    expect(ctrl.disconnected).toBe(false);

    // 14.8s — still connected
    await tick(14_800);
    expect(ctrl.disconnected).toBe(false);

    // Final 300ms tips past 15s
    await tick(300);
    expect(ctrl.disconnected).toBe(true);
  });

  it('does not fire onAudioDone when user starts speaking before AI audio drains', async () => {
    fireEvent(session, { type: 'response.created' }, callbacks);
    pcHandle.setSamplesDuration(0.2);
    fireEvent(session, { type: 'response.output_audio.done' }, callbacks);

    // 50ms in — user barges in before the first poll has even decided anything
    await tick(50);
    fireEvent(session, { type: 'input_audio_buffer.speech_started' }, callbacks);

    // Long wait — stream may stall, but speech_started killed the poll
    await tick(5000);
    expect(callbacks.onAudioDone).not.toHaveBeenCalled();
  });

  it('attributes disconnect to post-speech silence, not mid-speech', async () => {
    fireEvent(session, { type: 'response.created' }, callbacks);
    pcHandle.setSamplesDuration(0.3);
    fireEvent(session, { type: 'response.output_audio.done' }, callbacks);
    await tick(100);
    fireEvent(session, { type: 'input_audio_buffer.speech_started' }, callbacks);

    // User speaks for 15 seconds — must stay connected
    await tick(15_000);
    expect(ctrl.disconnected).toBe(false);

    // User stops → 15s silence countdown
    fireEvent(session, { type: 'input_audio_buffer.speech_stopped' }, callbacks);
    await tick(14_900);
    expect(ctrl.disconnected).toBe(false);
    await tick(200);
    expect(ctrl.disconnected).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// THE NEW BUG SCENARIO: data received but speakers still playing
//
// This is the bug the user actually reported: the UI showed "Silence"
// while the AI was still audibly talking. The old RMS-based detector tapped
// the WebRTC stream rather than the speakers, so it went quiet as soon as
// the server stopped sending — even though the playout buffer still had
// ~300ms of audio left to play. The new detector requires both:
//   (a) totalSamplesDuration to stop advancing for AUDIO_STALL_REQUIRED_MS, AND
//   (b) AUDIO_JITTER_DRAIN_MS additional wall-clock to elapse
// before firing onAudioDone.
// ---------------------------------------------------------------------------

describe('jitter buffer drain — the originally-reported bug', () => {
  let session: RealtimeSession;
  let callbacks: SessionCallbacks;
  let ctrl: SilenceController;
  let pcHandle: MockPcHandle;

  beforeEach(() => {
    vi.useFakeTimers();
    pcHandle = makeMockPc();
    session = new RealtimeSession();
    ctrl = new SilenceController();
    callbacks = makeFullCallbacks(ctrl);
    injectPc(session, pcHandle.pc);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('waits the full drain window after the stream stalls', async () => {
    fireEvent(session, { type: 'response.created' }, callbacks);
    pcHandle.setSamplesDuration(0.5);
    fireEvent(session, { type: 'response.output_audio.done' }, callbacks);
    fireEvent(session, { type: 'response.done' }, callbacks);

    // Tick 1 (100ms): records duration=0.5, sets seenAudio=true, lastChangeAt=now
    await tick(100);
    expect(callbacks.onAudioDone).not.toHaveBeenCalled();

    // Stream is now stalled. We need 400ms of stall + 500ms drain.
    // At 400ms of stall: the poll fires that detects it and schedules the drain.
    await tick(400);
    expect(callbacks.onAudioDone).not.toHaveBeenCalled();

    // 499ms into the 500ms drain — still not yet
    await tick(499);
    expect(callbacks.onAudioDone).not.toHaveBeenCalled();

    // The 500th ms tips it
    await tick(1);
    expect(callbacks.onAudioDone).toHaveBeenCalledOnce();
  });

  it('re-arms if more audio arrives during the stall window (sentence break)', async () => {
    fireEvent(session, { type: 'response.created' }, callbacks);
    pcHandle.setSamplesDuration(0.3);
    fireEvent(session, { type: 'response.output_audio.done' }, callbacks);
    fireEvent(session, { type: 'response.done' }, callbacks);

    // Poll picks up duration=0.3
    await tick(100);

    // 300ms of stall (below the 400ms threshold)
    await tick(300);
    expect(callbacks.onAudioDone).not.toHaveBeenCalled();

    // More audio arrives — stall resets
    pcHandle.setSamplesDuration(0.6);
    await tick(100); // next poll sees the new duration, resets lastChangeAt

    // Now from scratch: 399ms of stall → not yet
    await tick(399);
    expect(callbacks.onAudioDone).not.toHaveBeenCalled();

    // 400ms of stall → drain scheduled
    await tick(1);
    expect(callbacks.onAudioDone).not.toHaveBeenCalled();

    // 500ms drain → fires
    await tick(500);
    expect(callbacks.onAudioDone).toHaveBeenCalledOnce();
  });
});
