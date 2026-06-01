import { App } from 'obsidian';

// ── Tool definitions ──────────────────────────────────────────────────────────

export const CLAUDE_THREADS_TOOLS = [
  {
    type: 'function',
    name: 'ct_send_message',
    description:
      'Send a message to an existing Claude thread. ' +
      'When wait=true (the default) this tool blocks until the agent finishes and returns its response directly. ' +
      'Set wait=false only if the user explicitly asks to run in the background.',
    parameters: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'The message to send to the thread.' },
        thread_id: { type: 'string', description: 'ID of the thread to send to.' },
        wait: {
          type: 'boolean',
          description: 'If true (default), block until the agent finishes and return its response. Set false to send without waiting.',
        },
        watch: {
          type: 'boolean',
          description:
            'When wait=false, automatically subscribe to live notifications for this thread (default true). ' +
            'Set false only if you do not want to be notified when it finishes.',
        },
        timeout_secs: {
          type: 'number',
          description: 'Seconds to wait before timing out (default 120, max 300).',
        },
      },
      required: ['message', 'thread_id'],
    },
  },
  {
    type: 'function',
    name: 'ct_new_thread',
    description:
      'Start a brand-new Claude thread with an initial message. ' +
      'When wait=true (the default) this tool blocks until the agent finishes and returns its response directly. ' +
      'Set wait=false only if the user explicitly asks to run in the background.',
    parameters: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'The initial message or task to start the thread with.' },
        title_hint: { type: 'string', description: 'Optional short title for the new thread.' },
        wait: {
          type: 'boolean',
          description: 'If true (default), block until the agent finishes and return its response. Set false to send without waiting.',
        },
        watch: {
          type: 'boolean',
          description:
            'When wait=false, automatically subscribe to live notifications for this thread (default true). ' +
            'Set false only if you do not want to be notified when it finishes.',
        },
        timeout_secs: {
          type: 'number',
          description: 'Seconds to wait before timing out (default 120, max 300).',
        },
      },
      required: ['message'],
    },
  },
  {
    type: 'function',
    name: 'ct_wait_for_thread',
    description: 'Wait for a running Claude thread agent to finish, then return its response.',
    parameters: {
      type: 'object',
      properties: {
        thread_id: {
          type: 'string',
          description: 'Thread ID to wait for. Omit to wait for the currently active thread.',
        },
        timeout_secs: {
          type: 'number',
          description: 'Seconds to wait before timing out (default 120, max 300).',
        },
      },
      required: [],
    },
  },
  {
    type: 'function',
    name: 'ct_get_thread',
    description: 'Read messages and status from a Claude thread.',
    parameters: {
      type: 'object',
      properties: {
        thread_id: {
          type: 'string',
          description: 'Thread ID to read. Omit to read the currently active thread.',
        },
        last_n: {
          type: 'number',
          description: 'How many recent messages to return (default 5, max 20).',
        },
      },
      required: [],
    },
  },
  {
    type: 'function',
    name: 'ct_list_threads',
    description:
      'List Claude threads and their statuses. ' +
      'Use status="active" to see agents currently running, "waiting_new" to see threads with unread results, ' +
      '"waiting" to see all idle threads (read and unread), "error" for failed threads, or "all" for everything.',
    parameters: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['active', 'waiting', 'waiting_new', 'error', 'all'],
          description:
            'Filter by status. "waiting_new" = finished but not yet reviewed. ' +
            '"waiting" = all idle threads. Default is "all".',
        },
        limit: {
          type: 'number',
          description: 'Maximum threads to return (default 15, max 30).',
        },
      },
      required: [],
    },
  },
  {
    type: 'function',
    name: 'ct_open_thread',
    description: 'Open a Claude thread in the Obsidian UI so you can see it.',
    parameters: {
      type: 'object',
      properties: {
        thread_id: { type: 'string', description: 'ID of the thread to open.' },
      },
      required: ['thread_id'],
    },
  },
  {
    type: 'function',
    name: 'ct_close_thread',
    description:
      'Close (delete) a Claude thread. If the thread has messages and vault-save is enabled it will be archived first. ' +
      'Cannot close the last remaining thread. Omit thread_id to close the currently active thread.',
    parameters: {
      type: 'object',
      properties: {
        thread_id: {
          type: 'string',
          description: 'ID of the thread to close. Omit to close the currently active thread.',
        },
      },
      required: [],
    },
  },
  {
    type: 'function',
    name: 'ct_get_active_thread',
    description: 'Get the thread currently visible in the Claude Threads panel, including its recent messages.',
    parameters: {
      type: 'object',
      properties: {
        last_n: {
          type: 'number',
          description: 'How many recent messages to return (default 5).',
        },
      },
      required: [],
    },
  },
  {
    type: 'function',
    name: 'ct_watch',
    description:
      'Subscribe to live notifications for a Claude thread. ' +
      'When the thread finishes, errors, or sends a new message, you will be notified automatically. ' +
      'Use after launching a thread with wait=false. Omit thread_id to watch ALL currently running threads.',
    parameters: {
      type: 'object',
      properties: {
        thread_id: {
          type: 'string',
          description: 'Thread ID to watch. Omit to watch all current threads.',
        },
      },
      required: [],
    },
  },
  {
    type: 'function',
    name: 'ct_unwatch',
    description:
      'Stop receiving notifications for a thread (or all threads). ' +
      'Use when you no longer need updates from a thread.',
    parameters: {
      type: 'object',
      properties: {
        thread_id: {
          type: 'string',
          description: 'Thread ID to stop watching. Omit to stop watching all threads.',
        },
      },
      required: [],
    },
  },
];

// ── Names set for routing in VoiceView ───────────────────────────────────────

export const CLAUDE_THREADS_TOOL_NAMES = new Set(
  CLAUDE_THREADS_TOOLS.map((t) => t.name)
);

// ── Internal types ────────────────────────────────────────────────────────────

interface Thread {
  id: string;
  title: string;
  status?: string;
  reviewed?: boolean;
  messages?: Array<{ role: string; content: string; timestamp?: number }>;
  createdAt: number;
  updatedAt: number;
  lastError?: string;
  cwd?: string;
}

type SubscribableManager = {
  getThread: (id: string) => Thread | undefined;
  getThreads: () => Thread[];
  isRunning: (id: string) => boolean;
  sendMessage: (id: string, msg: string) => Promise<void>;
  deleteThread: (id: string) => void;
  subscribe: (listener: (threadId: string, event: { type: string }) => void) => () => void;
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function getPlugin(app: App): Record<string, unknown> | null {
  // app.plugins is an internal Obsidian API not exposed in the TypeScript types.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pluginMap = (app as any)?.plugins?.plugins as Record<string, unknown> | undefined;
  return (pluginMap?.['claude-threads'] as Record<string, unknown>) ?? null;
}

/** Returns a fine-grained status string that distinguishes waiting_new from waiting. */
function computeFullStatus(t: Thread): string {
  const base = t.status ?? 'waiting';
  if (base === 'waiting' && (t.messages?.length ?? 0) > 0) {
    return t.reviewed ? 'waiting' : 'waiting_new';
  }
  return base;
}

function threadSummary(t: Thread, lastN?: number): Record<string, unknown> {
  const msgs = (t.messages ?? []).slice(-(Math.min(lastN ?? 5, 20)));
  return {
    id: t.id,
    title: t.title,
    status: computeFullStatus(t),
    cwd: t.cwd,
    messageCount: t.messages?.length ?? 0,
    updatedAt: t.updatedAt,
    lastError: t.lastError,
    messages: msgs.map((m) => ({
      role: m.role,
      content: typeof m.content === 'string' ? m.content.slice(0, 500) : String(m.content),
      timestamp: m.timestamp,
    })),
  };
}

/** Block until the thread finishes (event-driven via manager.subscribe). */
function waitForThread(manager: SubscribableManager, threadId: string, timeoutSecs: number): Promise<string> {
  // If the thread is already done, return the last message immediately.
  if (!manager.isRunning(threadId)) {
    const thread = manager.getThread(threadId);
    if (!thread) return Promise.resolve(`Error: thread "${threadId}" not found.`);
    const last = thread.messages?.at(-1);
    return Promise.resolve(
      last
        ? `Thread finished. Last message (${last.role}): ${String(last.content).slice(0, 800)}`
        : `Thread finished (no messages).`
    );
  }

  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout>;

    const unsubscribe = manager.subscribe((id, event) => {
      if (id !== threadId) return;
      if (event.type === 'done' || event.type === 'error') {
        clearTimeout(timer);
        unsubscribe();
        const thread = manager.getThread(threadId);
        if (!thread) { resolve(`Thread ${threadId} finished.`); return; }
        if (event.type === 'error') {
          resolve(`Thread error: ${thread.lastError ?? 'unknown error'}`);
          return;
        }
        const last = thread.messages?.at(-1);
        resolve(
          last
            ? `Thread finished. Last message (${last.role}): ${String(last.content).slice(0, 800)}`
            : `Thread finished (no messages).`
        );
      }
    });

    timer = setTimeout(() => {
      unsubscribe();
      resolve(`Timed out waiting for thread ${threadId} after ${timeoutSecs} seconds. Use ct_wait_for_thread to check again.`);
    }, timeoutSecs * 1000);
  });
}

// ── Executor ──────────────────────────────────────────────────────────────────

export async function executeClaudeThreadsTool(
  name: string,
  args: Record<string, unknown>,
  app: App,
  bridge?: import('./NotificationBridge').NotificationBridge | null
): Promise<string> {
  const ct = getPlugin(app);
  if (!ct) {
    return 'Error: Claude Threads plugin is not installed or enabled.';
  }

  const manager = ct.manager as SubscribableManager;

  // ── ct_send_message ────────────────────────────────────────────────────────
  if (name === 'ct_send_message') {
    const message = String(args.message ?? '').trim();
    if (!message) return 'Error: message is required.';
    const threadId = String(args.thread_id ?? '').trim();
    if (!threadId) return 'Error: thread_id is required.';
    if (!manager.getThread(threadId)) return `Error: thread "${threadId}" not found.`;

    const wait = args.wait !== false; // default true
    const timeoutSecs = Math.min(Math.max(10, Number(args.timeout_secs) || 120), 300);

    const activateView = (ct.activateView as () => Promise<void>).bind(ct);
    const getView = (ct.getView as () => { focusThread: (id: string) => void } | null).bind(ct);

    // Fire WITHOUT await so the user message appears in the thread immediately
    // (manager.sendMessage pushes it synchronously before its first internal await).
    void manager.sendMessage(threadId, message);

    await activateView();
    await new Promise((r) => setTimeout(r, 150));
    getView()?.focusThread(threadId);

    if (!wait) {
      if (bridge && args.watch !== false) {
        bridge.watch(threadId);
      }
      return `Message sent to thread ${threadId}. Running in the background.`;
    }
    return waitForThread(manager, threadId, timeoutSecs);
  }

  // ── ct_new_thread ──────────────────────────────────────────────────────────
  if (name === 'ct_new_thread') {
    const message = String(args.message ?? '').trim();
    if (!message) return 'Error: message is required.';

    const wait = args.wait !== false; // default true
    const timeoutSecs = Math.min(Math.max(10, Number(args.timeout_secs) || 120), 300);

    const dispatchNewThread = (ct.dispatchNewThread as (text: string, images?: unknown, titleHint?: string) => Promise<string>).bind(ct);
    const activateView = (ct.activateView as () => Promise<void>).bind(ct);
    const getView = (ct.getView as () => { focusThread: (id: string) => void } | null).bind(ct);

    const threadId = await dispatchNewThread(message, undefined, args.title_hint ? String(args.title_hint) : undefined);

    await activateView();
    await new Promise((r) => setTimeout(r, 150));
    getView()?.focusThread(threadId);

    if (!wait) {
      if (bridge && args.watch !== false) {
        bridge.watch(threadId);
      }
      return `New thread started (id: ${threadId}). Running in the background.`;
    }
    return waitForThread(manager, threadId, timeoutSecs);
  }

  // ── ct_wait_for_thread ────────────────────────────────────────────────────
  if (name === 'ct_wait_for_thread') {
    const getActiveThreadId = (ct.getActiveThreadId as () => string | null).bind(ct);
    const id = args.thread_id ? String(args.thread_id) : getActiveThreadId();
    if (!id) return 'Error: no thread_id provided and no active thread.';
    if (!manager.getThread(id)) return `Error: thread "${id}" not found.`;
    const timeoutSecs = Math.min(Math.max(10, Number(args.timeout_secs) || 120), 300);
    return waitForThread(manager, id, timeoutSecs);
  }

  // ── ct_get_thread ──────────────────────────────────────────────────────────
  if (name === 'ct_get_thread') {
    const getActiveThreadId = (ct.getActiveThreadId as () => string | null).bind(ct);
    const id = args.thread_id ? String(args.thread_id) : getActiveThreadId();
    if (!id) return 'Error: no thread_id provided and no active thread.';
    const thread = manager.getThread(id);
    if (!thread) return `Error: thread "${id}" not found.`;
    const lastN = args.last_n ? Math.min(Number(args.last_n), 20) : 5;
    return JSON.stringify(threadSummary(thread, lastN), null, 2);
  }

  // ── ct_list_threads ────────────────────────────────────────────────────────
  if (name === 'ct_list_threads') {
    const allThreads = manager.getThreads();
    const statusFilter = args.status ? String(args.status) : 'all';
    const limit = Math.min(args.limit ? Number(args.limit) : 15, 30);

    const filtered =
      statusFilter === 'all'
        ? allThreads
        : statusFilter === 'waiting'
          ? allThreads.filter((t) => (t.status ?? 'waiting') === 'waiting')
          : allThreads.filter((t) => computeFullStatus(t) === statusFilter);

    const sorted = filtered
      .slice()
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, limit);

    if (sorted.length === 0) {
      return statusFilter === 'all'
        ? 'No threads found.'
        : `No threads with status "${statusFilter}".`;
    }

    const summaries = sorted.map((t) => ({
      id: t.id,
      title: t.title,
      status: computeFullStatus(t),
      messageCount: t.messages?.length ?? 0,
      lastMessage: t.messages?.at(-1)?.content?.toString().slice(0, 120),
      updatedAt: new Date(t.updatedAt).toISOString(),
      lastError: t.lastError,
    }));

    return JSON.stringify({ count: summaries.length, threads: summaries }, null, 2);
  }

  // ── ct_open_thread ─────────────────────────────────────────────────────────
  if (name === 'ct_open_thread') {
    const threadId = String(args.thread_id ?? '').trim();
    if (!threadId) return 'Error: thread_id is required.';

    // openThreadInChatView calls activateView() then immediately focusThread(),
    // but if the panel wasn't already open the view's DOM (titleEl) hasn't mounted
    // yet and setActiveThread bails out early. Fix: activate first, wait for
    // Obsidian to finish mounting, then focus the thread ourselves.
    const activateView = (ct.activateView as () => Promise<void>).bind(ct);
    const getView = (ct.getView as () => { focusThread: (id: string) => void } | null).bind(ct);

    await activateView();
    await new Promise((r) => setTimeout(r, 150));
    const view = getView();
    if (!view) return `Error: Claude Threads chat view could not be opened.`;
    view.focusThread(threadId);
    return `Opened thread ${threadId} in the Claude Threads panel.`;
  }

  // ── ct_close_thread ────────────────────────────────────────────────────────
  if (name === 'ct_close_thread') {
    const getActiveThreadId = (ct.getActiveThreadId as () => string | null).bind(ct);
    const getView = (ct.getView as () => { closeThread: (id: string) => void } | null).bind(ct);

    const id = args.thread_id ? String(args.thread_id) : getActiveThreadId();
    if (!id) return 'Error: no thread_id provided and no active thread.';
    if (!manager.getThread(id)) return `Error: thread "${id}" not found.`;

    const allThreads = manager.getThreads();
    if (allThreads.length <= 1) return 'Cannot close the last remaining thread.';

    const view = getView();
    if (!view) {
      // Panel not open — delete directly via manager
      manager.deleteThread(id);
      const saveSettings = (ct.saveSettings as () => Promise<void>).bind(ct);
      await saveSettings();
      return `Thread ${id} closed.`;
    }

    view.closeThread(id);
    return `Thread ${id} closed.`;
  }

  // ── ct_get_active_thread ───────────────────────────────────────────────────
  if (name === 'ct_get_active_thread') {
    const getActiveThreadId = (ct.getActiveThreadId as () => string | null).bind(ct);
    const id = getActiveThreadId();
    if (!id) return 'No active thread — the Claude Threads panel may not be open.';
    const thread = manager.getThread(id);
    if (!thread) return `Active thread ID "${id}" not found in manager.`;
    const lastN = args.last_n ? Math.min(Number(args.last_n), 20) : 5;
    return JSON.stringify(threadSummary(thread, lastN), null, 2);
  }

  // ── ct_watch ─────────────────────────────────────────────────────────────
  if (name === 'ct_watch') {
    if (!bridge) return 'Error: notification bridge not available in this session.';
    const threadId = args.thread_id ? String(args.thread_id).trim() : null;
    if (threadId) {
      if (!manager.getThread(threadId)) return `Error: thread "${threadId}" not found.`;
      bridge.watch(threadId);
      return `Now watching thread ${threadId} for live notifications.`;
    } else {
      bridge.watchAll();
      const count = manager.getThreads().length;
      return `Now watching all ${count} thread${count !== 1 ? 's' : ''} for live notifications.`;
    }
  }

  // ── ct_unwatch ────────────────────────────────────────────────────────────
  if (name === 'ct_unwatch') {
    if (!bridge) return 'Error: notification bridge not available in this session.';
    const threadId = args.thread_id ? String(args.thread_id).trim() : undefined;
    bridge.unwatch(threadId);
    return threadId
      ? `Stopped watching thread ${threadId}.`
      : 'Stopped watching all threads — notifications paused.';
  }

  return `Error: unknown Claude Threads tool "${name}"`;
}
