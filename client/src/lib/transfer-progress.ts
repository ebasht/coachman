export type TransferKind = 'upload' | 'download';

export type TransferProgress = {
  percent: number;
  kind: TransferKind;
};

const byKey = new Map<string, TransferProgress>();
const listeners = new Set<() => void>();

function emit() {
  for (const fn of listeners) fn();
}

export function setTransferProgress(key: string, percent: number, kind: TransferKind) {
  if (!key) return;
  const p = Math.min(100, Math.max(0, Math.round(percent)));
  const prev = byKey.get(key);
  if (prev && prev.percent === p && prev.kind === kind) return;
  byKey.set(key, { percent: p, kind });
  emit();
}

export function clearTransferProgress(key: string) {
  if (!key || !byKey.has(key)) return;
  byKey.delete(key);
  emit();
}

export function getTransferProgress(key: string | null | undefined): TransferProgress | undefined {
  if (!key) return undefined;
  return byKey.get(key);
}

/** Resolve progress for a message (temp id, real id, or image id). */
export function progressForMessage(msg: {
  id: string;
  clientId?: string;
  imageId?: string;
}): TransferProgress | undefined {
  return (
    getTransferProgress(msg.id) ||
    (msg.clientId ? getTransferProgress(msg.clientId) : undefined) ||
    (msg.imageId ? getTransferProgress(`img:${msg.imageId}`) : undefined)
  );
}

export function subscribeTransferProgress(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
