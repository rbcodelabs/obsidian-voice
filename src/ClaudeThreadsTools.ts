import { App } from 'obsidian';

// ── Tool definitions ──────────────────────────────────────────────────────────

export const CLAUDE_THREADS_TOOLS = [
  {
    type: 'function',
    name: 'ct_send_message',
    description:
      'Send a message to Claude Threads. Creates a new thread or sends to an existing one. ' +
      'The agent runs asynchronously — use ct_get_thread to check the result later.',
    parameters: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'The message or task to send to Claude.' },
        thread_id: {
          type: 'string',
          description: 'Optional. Send to an existing thread by ID. Omit to create a new thread.',
        },
        title_hint: {
          type: 'string',
          description: 'Optional short title for the new thread (ignored when thread_id is provided).',
        },
      },
      required: ['message'],
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
      'Use status="active" to see agents currently running, "waiting" to see idle threads, or "all" for everything.',
    parameters: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['active', 'waiting', 'error', 'all'],
          description: 'Filter by status. Default is "all".',
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
];

// ── Names set for routing in VoiceView ───────────────────────────────────────

export const CLAUDE_THREADS_TOOL_NAMES = new Set(
  CLAUDE_THREADS_TOOLS.map((t) => t.name)
);

// ── Executor ──────────────────────────────────────────────────────────────────

function getPlugin(app: App): Record<string, unknown> | null {
  // app.plugins is an internal Obsidian API not exposed in the TypeScript types.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pluginMap = (app as any)?.plugins?.plugins as Record<string, unknown> | undefined;
  return (pluginMap?.['claude-threads'] as Record<string, unknown>) ?? null;
}

interface Thread {
  id: string;
  title: string;
  status?: string;
  messages?: Array<{ role: string; content: string; timestamp?: number }>;
  createdAt: number;
  updatedAt: number;
  lastError?: string;
  cwd?: string;
}

function threadSummary(t: Thread, lastN?: number): Record<string, unknown> {
  const msgs = (t.messages ?? []).slice(-(Math.min(lastN ?? 5, 20)));
  return {
    id: t.id,
    title: t.title,
    status: t.status ?? 'waiting',
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

export async function executeClaudeThreadsTool(
  name: string,
  args: Record<string, unknown>,
  app: App
): Promise<string> {
  const ct = getPlugin(app);
  if (!ct) {
    return 'Error: Claude Threads plugin is not installed or enabled.';
  }

  // ── ct_send_message ────────────────────────────────────────────────────────
  if (name === 'ct_send_message') {
    const message = String(args.message ?? '').trim();
    if (!message) return 'Error: message is required.';

    if (args.thread_id) {
      const threadId = String(args.thread_id);
      const manager = ct.manager as { getThread: (id: string) => Thread | undefined; sendMessage: (id: string, msg: string) => Promise<void> };
      if (!manager.getThread(threadId)) return `Error: thread "${threadId}" not found.`;
      await manager.sendMessage(threadId, message);
      return `Message sent to thread ${threadId}.`;
    } else {
      const dispatchNewThread = ct.dispatchNewThread as (text: string, images?: unknown, titleHint?: string) => Promise<string>;
      const threadId = await dispatchNewThread(message, undefined, args.title_hint ? String(args.title_hint) : undefined);
      return `New thread created: ${threadId}\nTitle: ${args.title_hint ?? message.slice(0, 50)}\nThe agent is now running. Use ct_get_thread with thread_id "${threadId}" to check progress.`;
    }
  }

  // ── ct_get_thread ──────────────────────────────────────────────────────────
  if (name === 'ct_get_thread') {
    const manager = ct.manager as { getThread: (id: string) => Thread | undefined };
    const getActiveThreadId = ct.getActiveThreadId as () => string | null;
    const id = args.thread_id ? String(args.thread_id) : getActiveThreadId();
    if (!id) return 'Error: no thread_id provided and no active thread.';
    const thread = manager.getThread(id);
    if (!thread) return `Error: thread "${id}" not found.`;
    const lastN = args.last_n ? Math.min(Number(args.last_n), 20) : 5;
    return JSON.stringify(threadSummary(thread, lastN), null, 2);
  }

  // ── ct_list_threads ────────────────────────────────────────────────────────
  if (name === 'ct_list_threads') {
    const manager = ct.manager as { getThreads: () => Thread[] };
    const allThreads = manager.getThreads();
    const statusFilter = args.status ? String(args.status) : 'all';
    const limit = Math.min(args.limit ? Number(args.limit) : 15, 30);

    const filtered =
      statusFilter === 'all'
        ? allThreads
        : allThreads.filter((t) => (t.status ?? 'waiting') === statusFilter);

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
      status: t.status ?? 'waiting',
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
    const openThreadInChatView = ct.openThreadInChatView as (id: string) => Promise<void>;
    await openThreadInChatView(threadId);
    return `Opened thread ${threadId} in the Claude Threads panel.`;
  }

  // ── ct_get_active_thread ───────────────────────────────────────────────────
  if (name === 'ct_get_active_thread') {
    const getActiveThreadId = ct.getActiveThreadId as () => string | null;
    const manager = ct.manager as { getThread: (id: string) => Thread | undefined };
    const id = getActiveThreadId();
    if (!id) return 'No active thread — the Claude Threads panel may not be open.';
    const thread = manager.getThread(id);
    if (!thread) return `Active thread ID "${id}" not found in manager.`;
    const lastN = args.last_n ? Math.min(Number(args.last_n), 20) : 5;
    return JSON.stringify(threadSummary(thread, lastN), null, 2);
  }

  return `Error: unknown Claude Threads tool "${name}"`;
}
