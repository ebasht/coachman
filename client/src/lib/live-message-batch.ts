import type { StoredMessage } from './storage';

/**
 * Frame-coalesced live-message batch delivered from App → ChatView.
 * `seq` bumps on every flush so React effects re-run even when the array
 * identity would otherwise look unchanged.
 */
export type LiveMessageBatch = {
  seq: number;
  messages: StoredMessage[];
};

export type LiveMessageCoalescer = {
  enqueue: (msg: StoredMessage) => void;
  /** Drop queued messages and cancel a pending frame flush. */
  clear: () => void;
  /** Pending (not yet flushed) queue length — for tests. */
  pendingCount: () => number;
};

type ScheduleFn = (cb: () => void) => number;
type CancelFn = (handle: number) => void;

/**
 * Coalesce rapid `enqueue` calls into one rAF (or custom schedule) flush.
 * Correctness: every enqueued message is delivered exactly once in order;
 * UI applies a single reconcile + at most one scroll adjustment per frame.
 */
export function createLiveMessageCoalescer(opts: {
  onFlush: (batch: LiveMessageBatch) => void;
  schedule?: ScheduleFn;
  cancel?: CancelFn;
}): LiveMessageCoalescer {
  const schedule: ScheduleFn =
    opts.schedule ??
    ((cb) =>
      typeof requestAnimationFrame === 'function'
        ? requestAnimationFrame(cb)
        : (setTimeout(cb, 0) as unknown as number));
  const cancel: CancelFn =
    opts.cancel ??
    ((handle) => {
      if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(handle);
      else clearTimeout(handle);
    });

  let queue: StoredMessage[] = [];
  let seq = 0;
  let scheduled: number | null = null;

  const flush = () => {
    scheduled = null;
    const messages = queue;
    queue = [];
    if (!messages.length) return;
    seq += 1;
    opts.onFlush({ seq, messages });
  };

  return {
    enqueue(msg) {
      queue.push(msg);
      if (scheduled != null) return;
      scheduled = schedule(flush);
    },
    clear() {
      queue = [];
      if (scheduled != null) {
        cancel(scheduled);
        scheduled = null;
      }
    },
    pendingCount() {
      return queue.length;
    },
  };
}
