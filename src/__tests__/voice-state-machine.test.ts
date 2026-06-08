/**
 * voice-state-machine.test.ts
 *
 * Verifies the VoiceView session-activity state machine introduced in
 * fix/auto-disconnect-robustness. The state machine routes all transitions
 * through a single transitionTo(activity, reason) method and arms the
 * silence countdown ONLY in 'silence'.
 *
 * Why an inline mock instead of importing VoiceView directly?
 * VoiceView extends ItemView and depends on Obsidian's runtime (workspace,
 * adapter, secrets, wake word detector, etc.). The state-machine logic is
 * decoupled enough that we can verify the contract here with the same
 * pattern used in silence-detection.test.ts (the SilenceController class).
 *
 * The inline VoiceController class below mirrors the production transitions
 * from VoiceView.doConnect(). If you change one, change the other.
 *
 * Key scenarios:
 *  1. connect() leaves us in 'listening' with NO silence countdown armed
 *  2. onToolCall enters 'tool-running' with NO countdown (fixes the
 *     "AI cut off mid-tool because countdown expired during a 30s tool" bug)
 *  3. onAudioDone is a no-op while in 'tool-running' (the AI's pre-tool
 *     "Let me check..." preamble must not arm the countdown)
 *  4. voice_disconnect → 'disconnect-pending' with a separate grace timer
 *     and abort UI
 *  5. Stay button cancels disconnect-pending and injects a "continue" message
 *  6. User speaking during disconnect-pending cancels it (no injection — the
 *     user's voice IS the next message)
 *  7. Grace timer expiry triggers a real disconnect
 *  8. Transitions emit [Voice/lifecycle] log lines
 *  9. Silence countdown arms on speech_stopped and audio_done (only when
 *     transitioning out of an in-flight turn)
 * 10. Network drop (onStatusChange('idle')) clears both timers
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RealtimeSession, SessionCallbacks } from '../RealtimeSession';

// ---------------------------------------------------------------------------
// Inline mock of the production state machine. Mirrors VoiceView.doConnect()
// and the new transitionTo / startDisconnectPending / cancelDisconnectPending
// methods. Any divergence between this and VoiceView is a test bug.
// ---------------------------------------------------------------------------

type SessionActivity =
  | 'listening'
  | 'user-speaking'
  | 'ai-responding'
  | 'tool-running'
  | 'silence'
  | 'disconnect-pending';

interface ControllerOpts {
  silenceTimeoutSecs: number;
  voiceDisconnectGraceSecs: number;
  injectUserMessage: (text: string) => void;
  doDisconnect: () => void;
  onLifecycleLog?: (line: string) => void;
}

class VoiceController {
  activity: SessionActivity = 'listening';
  silenceSecsLeft = 0;
  disconnectPendingSecsLeft = 0;
  silenceTimer: ReturnType<typeof setTimeout> | null = null;
  silenceInterval: ReturnType<typeof setInterval> | null = null;
  disconnectPendingTimer: ReturnType<typeof setTimeout> | null = null;
  disconnectPendingInterval: ReturnType<typeof setInterval> | null = null;
  disconnectPendingReason = '';
  disconnectPendingPhrase = '';
  lifecycleLog: string[] = [];
  silenceTimeoutFired = false;
  disconnectPendingExpired = false;

  constructor(private opts: ControllerOpts) {}

  // ── core transition ─────────────────────────────────────────────────────
  transitionTo(next: SessionActivity, reason: string): void {
    const prev = this.activity;
    if (prev === next && next !== 'silence') return;

    const line = `[Voice/lifecycle] ${prev} → ${next} (${reason})`;
    this.lifecycleLog.push(line);
    this.opts.onLifecycleLog?.(line);

    this.activity = next;
    this.clearSilenceTimer();

    if (next === 'silence') {
      this.armSilenceCountdown();
    }
  }

  private armSilenceCountdown(): void {
    const secs = this.opts.silenceTimeoutSecs;
    if (!secs) return;
    this.silenceSecsLeft = secs;
    this.silenceInterval = setInterval(() => {
      this.silenceSecsLeft = Math.max(0, this.silenceSecsLeft - 1);
    }, 1000);
    this.silenceTimer = setTimeout(() => {
      this.silenceTimeoutFired = true;
      this.clearSilenceTimer();
      this.opts.doDisconnect();
    }, secs * 1000);
  }

  private clearSilenceTimer(): void {
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    if (this.silenceInterval) clearInterval(this.silenceInterval);
    this.silenceTimer = null;
    this.silenceInterval = null;
  }

  // ── disconnect-pending ──────────────────────────────────────────────────
  startDisconnectPending(reason: string, phrase: string): void {
    const grace = Math.min(30, Math.max(1, this.opts.voiceDisconnectGraceSecs));
    const line = `[Voice/lifecycle] ${this.activity} → disconnect-pending (voice_disconnect reason="${reason}" phrase="${phrase}" grace=${grace}s)`;
    this.lifecycleLog.push(line);
    this.opts.onLifecycleLog?.(line);

    this.activity = 'disconnect-pending';
    this.disconnectPendingReason = reason;
    this.disconnectPendingPhrase = phrase;
    this.clearSilenceTimer();
    this.clearDisconnectPendingTimer();
    this.disconnectPendingSecsLeft = grace;

    this.disconnectPendingInterval = setInterval(() => {
      this.disconnectPendingSecsLeft = Math.max(0, this.disconnectPendingSecsLeft - 1);
    }, 1000);
    this.disconnectPendingTimer = setTimeout(() => {
      this.disconnectPendingExpired = true;
      const log = `[Voice/lifecycle] disconnect-pending → idle (grace_expired reason="${reason}")`;
      this.lifecycleLog.push(log);
      this.opts.onLifecycleLog?.(log);
      this.clearDisconnectPendingTimer();
      this.opts.doDisconnect();
    }, grace * 1000);
  }

  cancelDisconnectPending(via: string, injectMessage: boolean): void {
    if (this.activity !== 'disconnect-pending') return;
    const log = `[Voice/lifecycle] disconnect-pending → listening (cancelled via=${via} original_reason="${this.disconnectPendingReason}")`;
    this.lifecycleLog.push(log);
    this.opts.onLifecycleLog?.(log);

    this.clearDisconnectPendingTimer();
    if (injectMessage) {
      this.opts.injectUserMessage(
        'I clicked Stay connected. Please continue the conversation — I did not mean to end the session.'
      );
    }
    this.disconnectPendingReason = '';
    this.disconnectPendingPhrase = '';
    this.transitionTo('listening', `disconnect_cancelled:${via}`);
  }

  private clearDisconnectPendingTimer(): void {
    if (this.disconnectPendingTimer) clearTimeout(this.disconnectPendingTimer);
    if (this.disconnectPendingInterval) clearInterval(this.disconnectPendingInterval);
    this.disconnectPendingTimer = null;
    this.disconnectPendingInterval = null;
  }

  // ── callbacks to wire into RealtimeSession ──────────────────────────────
  asCallbacks(): Partial<SessionCallbacks> {
    return {
      onStatusChange: (status) => {
        if (status === 'connected') {
          this.transitionTo('listening', 'connected');
        } else if (status === 'idle' || status === 'error') {
          this.clearSilenceTimer();
          this.clearDisconnectPendingTimer();
        }
      },
      onSpeechStarted: () => {
        if (this.activity === 'disconnect-pending') {
          this.cancelDisconnectPending('user_resumed_speaking', false);
        }
        this.transitionTo('user-speaking', 'speech_started');
      },
      onSpeechStopped: () => {
        this.transitionTo('silence', 'speech_stopped');
      },
      onResponseStarted: () => {
        if (this.activity === 'disconnect-pending') return;
        this.transitionTo('ai-responding', 'response.created');
      },
      onAudioDone: () => {
        if (this.activity === 'tool-running' || this.activity === 'disconnect-pending') return;
        this.transitionTo('silence', 'audio_done');
      },
      onToolCall: (_callId, name) => {
        this.transitionTo('tool-running', `tool_call:${name}`);
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Test scaffolding
// ---------------------------------------------------------------------------

function fireEvent(
  session: RealtimeSession,
  event: Record<string, unknown>,
  callbacks: SessionCallbacks,
): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (session as any).handleEvent(event, callbacks);
}

function fullCallbacks(ctrl: VoiceController): SessionCallbacks {
  const partial = ctrl.asCallbacks();
  return {
    onTranscript: vi.fn(),
    onToolCall: partial.onToolCall ?? vi.fn(),
    onStatusChange: partial.onStatusChange ?? vi.fn(),
    onError: vi.fn(),
    getToolResult: vi.fn().mockResolvedValue('ok'),
    onSpeechStarted: partial.onSpeechStarted,
    onSpeechStopped: partial.onSpeechStopped,
    onResponseStarted: partial.onResponseStarted,
    onAudioDone: partial.onAudioDone,
  };
}

function makeController(opts: Partial<ControllerOpts> = {}): VoiceController {
  return new VoiceController({
    silenceTimeoutSecs: 15,
    voiceDisconnectGraceSecs: 3,
    injectUserMessage: vi.fn(),
    doDisconnect: vi.fn(),
    ...opts,
  });
}

// ---------------------------------------------------------------------------
// 1. Connect: no countdown armed (was the auto-disconnect-on-connect bug)
// ---------------------------------------------------------------------------

describe('VoiceView state machine — connect grace', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('after onStatusChange(connected) we enter listening with NO countdown', () => {
    const ctrl = makeController();
    const callbacks = fullCallbacks(ctrl);

    callbacks.onStatusChange('connected');

    expect(ctrl.activity).toBe('listening');
    expect(ctrl.silenceTimer).toBeNull();
    expect(ctrl.silenceInterval).toBeNull();
  });

  it('30s after connect with no user activity, the session is still up', () => {
    const ctrl = makeController({ silenceTimeoutSecs: 15 });
    const callbacks = fullCallbacks(ctrl);

    callbacks.onStatusChange('connected');
    vi.advanceTimersByTime(30_000);

    expect(ctrl.silenceTimeoutFired).toBe(false);
    expect(ctrl.activity).toBe('listening');
  });

  it('connect is a no-op log (initial state is already listening)', () => {
    // The initial activity is 'listening', and transitionTo bails early on
    // a no-op transition without logging. First-real transition logs.
    const ctrl = makeController();
    fullCallbacks(ctrl).onStatusChange('connected');
    expect(ctrl.lifecycleLog).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 2. Tool-running: never arms the countdown
// ---------------------------------------------------------------------------

describe('VoiceView state machine — tool-running suspension', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('onToolCall enters tool-running, NOT silence', () => {
    const ctrl = makeController();
    const callbacks = fullCallbacks(ctrl);
    callbacks.onStatusChange('connected');

    const session = new RealtimeSession();
    fireEvent(session, { type: 'response.created' }, callbacks);
    fireEvent(session, {
      type: 'response.function_call_arguments.done',
      call_id: 'c1', name: 'ct_send_message', arguments: '{}',
    }, callbacks);

    expect(ctrl.activity).toBe('tool-running');
    expect(ctrl.silenceTimer).toBeNull();
  });

  it('a 60-second tool call does not auto-disconnect', () => {
    const ctrl = makeController({ silenceTimeoutSecs: 15 });
    const callbacks = fullCallbacks(ctrl);
    callbacks.onStatusChange('connected');

    const session = new RealtimeSession();
    fireEvent(session, { type: 'response.created' }, callbacks);
    fireEvent(session, {
      type: 'response.function_call_arguments.done',
      call_id: 'c1', name: 'slow_tool', arguments: '{}',
    }, callbacks);

    vi.advanceTimersByTime(60_000); // 4× the 15s default
    expect(ctrl.silenceTimeoutFired).toBe(false);
    expect(ctrl.activity).toBe('tool-running');
  });

  it('onAudioDone during tool-running is a no-op (no countdown armed)', () => {
    const ctrl = makeController();
    const callbacks = fullCallbacks(ctrl);
    callbacks.onStatusChange('connected');

    const session = new RealtimeSession();
    fireEvent(session, { type: 'response.created' }, callbacks);
    fireEvent(session, {
      type: 'response.function_call_arguments.done',
      call_id: 'c1', name: 'slow_tool', arguments: '{}',
    }, callbacks);

    // AI's pre-tool preamble audio finishes and fires onAudioDone
    callbacks.onAudioDone!();

    expect(ctrl.activity).toBe('tool-running'); // unchanged
    expect(ctrl.silenceTimer).toBeNull();        // no countdown
  });

  it('after tool resolution, the next response.created moves us back to ai-responding', () => {
    const ctrl = makeController();
    const callbacks = fullCallbacks(ctrl);
    callbacks.onStatusChange('connected');

    const session = new RealtimeSession();
    fireEvent(session, { type: 'response.created' }, callbacks);
    fireEvent(session, {
      type: 'response.function_call_arguments.done',
      call_id: 'c1', name: 'slow_tool', arguments: '{}',
    }, callbacks);
    expect(ctrl.activity).toBe('tool-running');

    // Tool resolves, flushToolBatch sends response.create, server starts new response
    fireEvent(session, { type: 'response.created' }, callbacks);
    expect(ctrl.activity).toBe('ai-responding');
  });

  it('onSpeechStarted during tool-running cancels and goes to user-speaking', () => {
    const ctrl = makeController();
    const callbacks = fullCallbacks(ctrl);
    callbacks.onStatusChange('connected');

    const session = new RealtimeSession();
    fireEvent(session, { type: 'response.created' }, callbacks);
    fireEvent(session, {
      type: 'response.function_call_arguments.done',
      call_id: 'c1', name: 'slow_tool', arguments: '{}',
    }, callbacks);
    fireEvent(session, { type: 'input_audio_buffer.speech_started' }, callbacks);

    expect(ctrl.activity).toBe('user-speaking');
  });
});

// ---------------------------------------------------------------------------
// 3. Disconnect-pending: the primary bug fix
// ---------------------------------------------------------------------------

describe('VoiceView state machine — disconnect-pending', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('startDisconnectPending enters the state and arms the grace timer', () => {
    const ctrl = makeController({ voiceDisconnectGraceSecs: 3 });
    ctrl.startDisconnectPending('user said goodbye', 'bye obsidian');

    expect(ctrl.activity).toBe('disconnect-pending');
    expect(ctrl.disconnectPendingSecsLeft).toBe(3);
    expect(ctrl.disconnectPendingTimer).not.toBeNull();
    expect(ctrl.silenceTimer).toBeNull(); // no silence countdown competing
  });

  it('grace expiry fires doDisconnect', () => {
    const doDisconnect = vi.fn();
    const ctrl = makeController({ voiceDisconnectGraceSecs: 3, doDisconnect });
    ctrl.startDisconnectPending('user said goodbye', 'bye');

    vi.advanceTimersByTime(3_000);
    expect(ctrl.disconnectPendingExpired).toBe(true);
    expect(doDisconnect).toHaveBeenCalledOnce();
  });

  it('Stay button cancels the grace timer and injects a continue message', () => {
    const injectUserMessage = vi.fn();
    const doDisconnect = vi.fn();
    const ctrl = makeController({ voiceDisconnectGraceSecs: 3, injectUserMessage, doDisconnect });
    ctrl.startDisconnectPending('user said goodbye', 'bye');

    vi.advanceTimersByTime(1_000); // 1s into the 3s window
    ctrl.cancelDisconnectPending('stay_button', true);

    expect(ctrl.activity).toBe('listening');
    expect(injectUserMessage).toHaveBeenCalledOnce();
    expect((injectUserMessage.mock.calls[0][0] as string)).toMatch(/Stay connected/);

    // Grace timer must be cleared so doDisconnect doesn't fire later
    vi.advanceTimersByTime(5_000);
    expect(doDisconnect).not.toHaveBeenCalled();
  });

  it('user speaking during disconnect-pending cancels it WITHOUT injecting', () => {
    const injectUserMessage = vi.fn();
    const doDisconnect = vi.fn();
    const ctrl = makeController({ voiceDisconnectGraceSecs: 3, injectUserMessage, doDisconnect });
    const callbacks = fullCallbacks(ctrl);
    ctrl.startDisconnectPending('user said goodbye', 'bye');

    callbacks.onSpeechStarted!();

    expect(ctrl.activity).toBe('user-speaking');
    expect(injectUserMessage).not.toHaveBeenCalled(); // the user's voice IS the message
    vi.advanceTimersByTime(5_000);
    expect(doDisconnect).not.toHaveBeenCalled();
  });

  it('response.created during disconnect-pending does NOT transition out', () => {
    // The model often produces a "OK, goodbye!" response right after firing
    // voice_disconnect. Its response.created must not eject us out of the
    // disconnect-pending state.
    const ctrl = makeController({ voiceDisconnectGraceSecs: 3 });
    const callbacks = fullCallbacks(ctrl);
    ctrl.startDisconnectPending('user said goodbye', 'bye');

    const session = new RealtimeSession();
    fireEvent(session, { type: 'response.created' }, callbacks);

    expect(ctrl.activity).toBe('disconnect-pending');
  });

  it('onAudioDone during disconnect-pending does NOT transition to silence', () => {
    const ctrl = makeController({ voiceDisconnectGraceSecs: 3 });
    const callbacks = fullCallbacks(ctrl);
    ctrl.startDisconnectPending('user said goodbye', 'bye');

    callbacks.onAudioDone!();
    expect(ctrl.activity).toBe('disconnect-pending');
  });

  it('voiceDisconnectGraceSecs is clamped to [1, 30]', () => {
    const tooSmall = makeController({ voiceDisconnectGraceSecs: 0 });
    tooSmall.startDisconnectPending('r', 'p');
    expect(tooSmall.disconnectPendingSecsLeft).toBe(1);

    const tooBig = makeController({ voiceDisconnectGraceSecs: 999 });
    tooBig.startDisconnectPending('r', 'p');
    expect(tooBig.disconnectPendingSecsLeft).toBe(30);
  });

  it('countdown ticks every second', () => {
    const ctrl = makeController({ voiceDisconnectGraceSecs: 5 });
    ctrl.startDisconnectPending('r', 'p');
    expect(ctrl.disconnectPendingSecsLeft).toBe(5);

    vi.advanceTimersByTime(1_000);
    expect(ctrl.disconnectPendingSecsLeft).toBe(4);
    vi.advanceTimersByTime(2_000);
    expect(ctrl.disconnectPendingSecsLeft).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 4. Silence countdown wiring
// ---------------------------------------------------------------------------

describe('VoiceView state machine — silence countdown', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('speech_stopped arms the silence countdown', () => {
    const ctrl = makeController({ silenceTimeoutSecs: 15 });
    const callbacks = fullCallbacks(ctrl);
    callbacks.onStatusChange('connected');
    callbacks.onSpeechStarted!();
    callbacks.onSpeechStopped!();

    expect(ctrl.activity).toBe('silence');
    expect(ctrl.silenceSecsLeft).toBe(15);
    expect(ctrl.silenceTimer).not.toBeNull();
  });

  it('audio_done from ai-responding arms the silence countdown', () => {
    const ctrl = makeController({ silenceTimeoutSecs: 15 });
    const callbacks = fullCallbacks(ctrl);
    callbacks.onStatusChange('connected');

    const session = new RealtimeSession();
    fireEvent(session, { type: 'response.created' }, callbacks);
    expect(ctrl.activity).toBe('ai-responding');

    callbacks.onAudioDone!();
    expect(ctrl.activity).toBe('silence');
    expect(ctrl.silenceTimer).not.toBeNull();
  });

  it('15s silence countdown expires → doDisconnect fires', () => {
    const doDisconnect = vi.fn();
    const ctrl = makeController({ silenceTimeoutSecs: 15, doDisconnect });
    const callbacks = fullCallbacks(ctrl);

    callbacks.onStatusChange('connected');
    callbacks.onSpeechStarted!();
    callbacks.onSpeechStopped!();

    vi.advanceTimersByTime(15_000);
    expect(doDisconnect).toHaveBeenCalledOnce();
    expect(ctrl.silenceTimeoutFired).toBe(true);
  });

  it('silenceTimeoutSecs=0 disables the watchdog entirely', () => {
    const doDisconnect = vi.fn();
    const ctrl = makeController({ silenceTimeoutSecs: 0, doDisconnect });
    const callbacks = fullCallbacks(ctrl);

    callbacks.onStatusChange('connected');
    callbacks.onSpeechStarted!();
    callbacks.onSpeechStopped!();
    expect(ctrl.silenceTimer).toBeNull();

    vi.advanceTimersByTime(120_000); // 2 minutes
    expect(doDisconnect).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 5. Network-drop cleanup
// ---------------------------------------------------------------------------

describe('VoiceView state machine — network drop cleanup', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('onStatusChange(idle) tears down a running silence timer', () => {
    const doDisconnect = vi.fn();
    const ctrl = makeController({ silenceTimeoutSecs: 15, doDisconnect });
    const callbacks = fullCallbacks(ctrl);

    callbacks.onStatusChange('connected');
    callbacks.onSpeechStarted!();
    callbacks.onSpeechStopped!();
    expect(ctrl.silenceTimer).not.toBeNull();

    callbacks.onStatusChange('idle');
    expect(ctrl.silenceTimer).toBeNull();

    vi.advanceTimersByTime(60_000);
    expect(doDisconnect).not.toHaveBeenCalled();
  });

  it('onStatusChange(idle) tears down a running disconnect-pending timer', () => {
    const doDisconnect = vi.fn();
    const ctrl = makeController({ voiceDisconnectGraceSecs: 3, doDisconnect });
    const callbacks = fullCallbacks(ctrl);

    ctrl.startDisconnectPending('r', 'p');
    expect(ctrl.disconnectPendingTimer).not.toBeNull();

    callbacks.onStatusChange('idle');
    expect(ctrl.disconnectPendingTimer).toBeNull();

    vi.advanceTimersByTime(10_000);
    expect(doDisconnect).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 6. Lifecycle logging
// ---------------------------------------------------------------------------

describe('VoiceView state machine — lifecycle logging', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('every transition emits a [Voice/lifecycle] line with state and reason', () => {
    const ctrl = makeController();
    const callbacks = fullCallbacks(ctrl);

    callbacks.onStatusChange('connected');     // listening → listening (no-op, no log)
    callbacks.onSpeechStarted!();              // listening → user-speaking
    callbacks.onSpeechStopped!();              // user-speaking → silence

    expect(ctrl.lifecycleLog).toEqual([
      '[Voice/lifecycle] listening → user-speaking (speech_started)',
      '[Voice/lifecycle] user-speaking → silence (speech_stopped)',
    ]);
  });

  it('disconnect-pending transitions log the reason and phrase', () => {
    const ctrl = makeController({ voiceDisconnectGraceSecs: 3 });
    ctrl.startDisconnectPending('user said goodbye', 'see ya');

    const line = ctrl.lifecycleLog.find(l => l.includes('disconnect-pending'));
    expect(line).toContain('voice_disconnect');
    expect(line).toContain('reason="user said goodbye"');
    expect(line).toContain('phrase="see ya"');
    expect(line).toContain('grace=3s');
  });
});
