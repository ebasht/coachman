import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLiveMessageCoalescer } from './live-message-batch';
import type { StoredMessage } from './storage';

function msg(id: string): StoredMessage {
  return {
    id,
    chatId: 'c1',
    senderId: 'peer',
    senderName: 'Peer',
    text: id,
    type: 'text',
    createdAt: 1,
  };
}

describe('createLiveMessageCoalescer', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('coalesces multiple enqueues into one flush', () => {
    const flushes: string[][] = [];
    let handle = 0;
    const pending = new Map<number, () => void>();
    const c = createLiveMessageCoalescer({
      schedule: (cb) => {
        handle += 1;
        pending.set(handle, cb);
        return handle;
      },
      cancel: (h) => pending.delete(h),
      onFlush: (batch) => flushes.push(batch.messages.map((m) => m.id)),
    });

    c.enqueue(msg('a'));
    c.enqueue(msg('b'));
    c.enqueue(msg('c'));
    expect(pending.size).toBe(1);
    [...pending.values()][0]!();
    expect(flushes).toEqual([['a', 'b', 'c']]);
  });

  it('clear drops the queue and cancels the scheduled flush', () => {
    const flushes: number[] = [];
    let handle = 0;
    const pending = new Map<number, () => void>();
    const c = createLiveMessageCoalescer({
      schedule: (cb) => {
        handle += 1;
        pending.set(handle, cb);
        return handle;
      },
      cancel: (h) => pending.delete(h),
      onFlush: (batch) => flushes.push(batch.messages.length),
    });
    c.enqueue(msg('a'));
    c.clear();
    expect(c.pendingCount()).toBe(0);
    expect(pending.size).toBe(0);
    expect(flushes).toEqual([]);
  });

  it('bumps seq on each flush', () => {
    const seqs: number[] = [];
    let handle = 0;
    const pending = new Map<number, () => void>();
    const c = createLiveMessageCoalescer({
      schedule: (cb) => {
        handle += 1;
        pending.set(handle, cb);
        return handle;
      },
      cancel: (h) => pending.delete(h),
      onFlush: (batch) => seqs.push(batch.seq),
    });
    c.enqueue(msg('a'));
    [...pending.values()][0]!();
    pending.clear();
    c.enqueue(msg('b'));
    [...pending.values()][0]!();
    expect(seqs).toEqual([1, 2]);
  });
});
