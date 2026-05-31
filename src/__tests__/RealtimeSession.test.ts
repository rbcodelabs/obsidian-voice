import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RealtimeSession, SessionCallbacks } from '../RealtimeSession';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCallbacks(): SessionCallbacks {
  return {
    onTranscript: vi.fn(),
    onToolCall: vi.fn(),
    onStatusChange: vi.fn(),
    onError: vi.fn(),
    getToolResult: vi.fn(),
  };
}

/** Minimal DataChannel mock — captures every send() call. */
function makeMockDc() {
  return {
    readyState: 'open',
    send: vi.fn<[string], void>(),
  };
}

type MockDc = ReturnType<typeof makeMockDc>;

/** Parse all JSON strings sent to the mock dc. */
function sentMessages(dc: MockDc): Record<string, unknown>[] {
  return dc.send.mock.calls.map(([raw]) => JSON.parse(raw));
}

/** Bypass private-method visibility so we can drive handleEvent directly. */
function fireEvent(
  session: RealtimeSession,
  event: Record<string, unknown>,
  callbacks: SessionCallbacks,
): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (session as any).handleEvent(event, callbacks);
}

/** Inject a mock DataChannel, bypassing the full WebRTC connect() flow. */
function injectDc(session: RealtimeSession, dc: MockDc): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (session as any).dc = dc;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RealtimeSession', () => {
  let session: RealtimeSession;
  let callbacks: SessionCallbacks;
  let dc: MockDc;

  beforeEach(() => {
    session = new RealtimeSession();
    callbacks = makeCallbacks();
    dc = makeMockDc();
    injectDc(session, dc);
  });

  // -------------------------------------------------------------------------
  // isResponseActive flag
  // -------------------------------------------------------------------------

  describe('isResponseActive flag', () => {
    it('is false initially', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((session as any).isResponseActive).toBe(false);
    });

    it('becomes true on response.created', () => {
      fireEvent(session, { type: 'response.created' }, callbacks);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((session as any).isResponseActive).toBe(true);
    });

    it('becomes false on response.done', () => {
      fireEvent(session, { type: 'response.created' }, callbacks);
      fireEvent(session, { type: 'response.done' }, callbacks);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((session as any).isResponseActive).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Tool call batching
  // -------------------------------------------------------------------------

  describe('tool call batching', () => {
    it('buffers tool calls and does not fetch results until response.done', () => {
      vi.mocked(callbacks.getToolResult).mockResolvedValue('result');

      fireEvent(session, {
        type: 'response.function_call_arguments.done',
        call_id: 'call1',
        name: 'my_tool',
        arguments: '{}',
      }, callbacks);

      expect(callbacks.getToolResult).not.toHaveBeenCalled();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((session as any).pendingToolCalls).toHaveLength(1);
    });

    it('calls getToolResult after response.done fires', async () => {
      vi.mocked(callbacks.getToolResult).mockResolvedValue('result');

      fireEvent(session, {
        type: 'response.function_call_arguments.done',
        call_id: 'call1',
        name: 'my_tool',
        arguments: '{}',
      }, callbacks);
      fireEvent(session, { type: 'response.done' }, callbacks);

      await vi.waitFor(() => expect(callbacks.getToolResult).toHaveBeenCalledOnce());
    });

    it('sends function_call_output then exactly one response.create', async () => {
      vi.mocked(callbacks.getToolResult).mockResolvedValue('tool output');

      fireEvent(session, {
        type: 'response.function_call_arguments.done',
        call_id: 'call1',
        name: 'my_tool',
        arguments: '{}',
      }, callbacks);
      fireEvent(session, { type: 'response.done' }, callbacks);

      await vi.waitFor(() => {
        expect(sentMessages(dc).some(m => m.type === 'response.create')).toBe(true);
      });

      const msgs = sentMessages(dc);
      const outputMsg = msgs.find(m => m.type === 'conversation.item.create') as
        | { type: string; item: { type: string; call_id: string; output: string } }
        | undefined;
      const createMsgs = msgs.filter(m => m.type === 'response.create');

      expect(outputMsg?.item.output).toBe('tool output');
      expect(outputMsg?.item.call_id).toBe('call1');
      expect(createMsgs).toHaveLength(1);
    });

    it('batches multiple tool calls into a single response.create', async () => {
      vi.mocked(callbacks.getToolResult).mockResolvedValue('ok');

      for (const id of ['call1', 'call2', 'call3']) {
        fireEvent(session, {
          type: 'response.function_call_arguments.done',
          call_id: id,
          name: 'tool',
          arguments: '{}',
        }, callbacks);
      }
      fireEvent(session, { type: 'response.done' }, callbacks);

      await vi.waitFor(() => {
        expect(sentMessages(dc).some(m => m.type === 'response.create')).toBe(true);
      });

      const msgs = sentMessages(dc);
      expect(msgs.filter(m => m.type === 'conversation.item.create')).toHaveLength(3);
      expect(msgs.filter(m => m.type === 'response.create')).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // Race condition: VAD fires a new response while a slow tool is running
  // -------------------------------------------------------------------------

  describe('race condition fix: VAD fires during slow tool execution', () => {
    it('sends response.cancel before tool outputs when a response is active', async () => {
      let resolveToolResult!: (value: string) => void;
      const slowTool = new Promise<string>(resolve => {
        resolveToolResult = resolve;
      });
      vi.mocked(callbacks.getToolResult).mockReturnValue(slowTool);

      // Tool call arrives; response.done starts the flush (tool is slow)
      fireEvent(session, {
        type: 'response.function_call_arguments.done',
        call_id: 'call1',
        name: 'slow_tool',
        arguments: '{}',
      }, callbacks);
      fireEvent(session, { type: 'response.done' }, callbacks);

      // VAD starts a new response while the tool is running
      fireEvent(session, { type: 'response.created' }, callbacks);

      // Tool finishes — flush should detect the active response and cancel it
      resolveToolResult('slow result');

      await vi.waitFor(() => {
        expect(sentMessages(dc).some(m => m.type === 'response.cancel')).toBe(true);
      });

      // Server acknowledges the cancel via response.done
      fireEvent(session, { type: 'response.done' }, callbacks);

      // Now tool outputs + response.create should be sent
      await vi.waitFor(() => {
        expect(sentMessages(dc).some(m => m.type === 'response.create')).toBe(true);
      });

      const msgs = sentMessages(dc);
      const cancelIdx = msgs.findIndex(m => m.type === 'response.cancel');
      const outputIdx = msgs.findIndex(m => m.type === 'conversation.item.create');
      const createIdx = msgs.findIndex(m => m.type === 'response.create');

      // Ordering guarantee: cancel → output → response.create
      expect(cancelIdx).toBeGreaterThanOrEqual(0);
      expect(cancelIdx).toBeLessThan(outputIdx);
      expect(outputIdx).toBeLessThan(createIdx);
    });

    it('skips response.cancel when no response is active at flush time', async () => {
      vi.mocked(callbacks.getToolResult).mockResolvedValue('result');

      fireEvent(session, {
        type: 'response.function_call_arguments.done',
        call_id: 'call1',
        name: 'fast_tool',
        arguments: '{}',
      }, callbacks);
      // response.done is sent, but isResponseActive is already false here
      fireEvent(session, { type: 'response.done' }, callbacks);

      await vi.waitFor(() => {
        expect(sentMessages(dc).some(m => m.type === 'response.create')).toBe(true);
      });

      expect(sentMessages(dc).some(m => m.type === 'response.cancel')).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Error event handling
  // -------------------------------------------------------------------------

  describe('error event handling', () => {
    it('extracts message from event.error.message (nested path)', () => {
      fireEvent(session, {
        type: 'error',
        error: {
          message: 'conversation_already_has_active_response',
          code: 'invalid_state',
        },
      }, callbacks);

      expect(callbacks.onError).toHaveBeenCalledWith(
        'Server error: conversation_already_has_active_response',
      );
    });

    it('falls back to event.message when error object is absent', () => {
      fireEvent(session, {
        type: 'error',
        message: 'something went wrong',
      }, callbacks);

      expect(callbacks.onError).toHaveBeenCalledWith('Server error: something went wrong');
    });

    it('does not leak a raw JSON blob on a well-formed error event', () => {
      fireEvent(session, {
        type: 'error',
        error: { message: 'rate_limit_exceeded' },
      }, callbacks);

      const [errArg] = vi.mocked(callbacks.onError).mock.calls[0];
      expect(errArg).not.toContain('"type"');  // no raw JSON
      expect(errArg).toContain('rate_limit_exceeded');
    });
  });

  // -------------------------------------------------------------------------
  // Transcript events
  // -------------------------------------------------------------------------

  describe('transcript events', () => {
    it('emits partial assistant transcript on audio_transcript.delta', () => {
      fireEvent(session, {
        type: 'response.audio_transcript.delta',
        delta: 'Hello',
      }, callbacks);

      expect(callbacks.onTranscript).toHaveBeenCalledWith('assistant', 'Hello', false);
    });

    it('emits done=true on audio_transcript.done', () => {
      fireEvent(session, { type: 'response.audio_transcript.done' }, callbacks);
      expect(callbacks.onTranscript).toHaveBeenCalledWith('assistant', '', true);
    });

    it('emits user transcript on input_audio_transcription.completed', () => {
      fireEvent(session, {
        type: 'conversation.item.input_audio_transcription.completed',
        transcript: 'Tell me about X',
      }, callbacks);

      expect(callbacks.onTranscript).toHaveBeenCalledWith('user', 'Tell me about X', true);
    });

    it('ignores empty delta strings', () => {
      fireEvent(session, {
        type: 'response.audio_transcript.delta',
        delta: '',
      }, callbacks);

      expect(callbacks.onTranscript).not.toHaveBeenCalled();
    });
  });
});
