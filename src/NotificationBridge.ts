import type { RealtimeSession } from './RealtimeSession';

interface Thread {
  id: string;
  title: string;
  messages?: Array<{ role: string; content: string | unknown }>;
  lastError?: string;
}

type SubscribableManager = {
  getThread: (id: string) => Thread | undefined;
  getThreads: () => Thread[];
  isRunning: (id: string) => boolean;
  subscribe: (listener: (threadId: string, event: { type: string }) => void) => () => void;
};

export class NotificationBridge {
  private watchedThreads = new Set<string>();
  private unsubscribeFn: (() => void) | null = null;
  private session: RealtimeSession | null = null;
  private manager: SubscribableManager | null = null;
  private debug = false;

  connect(manager: SubscribableManager, session: RealtimeSession, debug = false): void {
    this.debug = debug;
    this.manager = manager;
    this.session = session;
    this.unsubscribeFn = manager.subscribe((threadId, event) => {
      this.handleCtEvent(threadId, event);
    });
  }

  disconnect(): void {
    this.unsubscribeFn?.();
    this.unsubscribeFn = null;
    this.session = null;
    this.manager = null;
    this.watchedThreads.clear();
    this.debug = false;
  }

  watch(threadId: string): void {
    this.watchedThreads.add(threadId);
  }

  watchAll(): void {
    const threads = this.manager?.getThreads() ?? [];
    for (const t of threads) this.watchedThreads.add(t.id);
  }

  unwatch(threadId?: string): void {
    if (threadId) {
      this.watchedThreads.delete(threadId);
    } else {
      this.watchedThreads.clear();
    }
  }

  isWatching(threadId: string): boolean {
    return this.watchedThreads.has(threadId);
  }

  private handleCtEvent(threadId: string, event: { type: string }): void {
    if (this.debug) console.debug(`[Voice Bridge] CT event: type="${event.type}" threadId="${threadId}" watched=${this.watchedThreads.has(threadId)} running=${this.manager?.isRunning(threadId)}`);
    if (!this.watchedThreads.has(threadId)) return;
    if (!this.session) return;

    const thread = this.manager?.getThread(threadId);
    const title = thread?.title ?? threadId.slice(0, 8);
    const lastMsg = thread?.messages?.at(-1);
    const preview = lastMsg ? String(lastMsg.content).slice(0, 300) : '';
    const isStillWorking = this.manager?.isRunning(threadId) ?? false;

    let text: string | null = null;

    if (event.type === 'done') {
      // Terminal event: thread finished. Always notify with the final message.
      text = `[Thread STATUS=done id="${title}"] Final message: ${preview || '(no message)'}. Briefly acknowledge to the user.`;
    } else if (event.type === 'error') {
      const err = thread?.lastError ?? 'unknown error';
      text = `[Thread STATUS=error id="${title}"] Error: ${err}. Tell the user.`;
    } else if (event.type === 'message' && preview) {
      // Partial update — agent is mid-work. The voice agent should NARRATE
      // this to the user briefly ("X is now doing Y") but must NOT send a
      // ct_send_message back to the thread while it's still running. We tag
      // the notification with an explicit STATUS marker so the model can't
      // miss it, even if the system-prompt rules slip out of attention.
      const statusTag = isStillWorking ? 'STATUS=working' : 'STATUS=idle';
      const directive = isStillWorking
        ? 'Agent is STILL WORKING — narrate briefly to the user (1 short sentence), DO NOT send a ct_send_message reply yet.'
        : 'Agent appears idle — acknowledge to the user.';
      text = `[Thread ${statusTag} id="${title}"] Update: ${preview}. ${directive}`;
    }

    if (this.debug) console.debug(`[Voice Bridge] Notification text: ${text ? `"${text.slice(0, 160)}"` : '(suppressed — no text for this event type)'}`);

    if (text) {
      this.session.injectNotification(threadId, text);
    }
  }
}
