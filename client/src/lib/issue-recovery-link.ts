import {
  wrapRecoveryBundle,
  type RecoveryKeyBundle,
} from './login-recovery';

export type CreateLoginRecoveryFn = (
  userId: string,
  ciphertext: string,
) => Promise<{ token: string; expiresAt: number }>;

function buildLink(origin: string, token: string, keyB64Url: string): string {
  const url = new URL(origin);
  url.searchParams.set('recover', token);
  url.searchParams.set('k', keyB64Url);
  return url.toString();
}

/** Process-wide queue — survives React Strict Mode remounts of the modal. */
const globalIssueQueue = createSerialQueue();
let globalIssueGen = 0;

/**
 * Issues a recovery link, aborting before/after server create when `isStale` flips.
 * Concurrent issues for the same process are serialized (server keeps one token per user).
 */
export async function issueRecoveryLink(opts: {
  userId: string;
  bundle: RecoveryKeyBundle;
  createLoginRecovery: CreateLoginRecoveryFn;
  isStale?: () => boolean;
  /** Defaults to window.location.origin in the browser. */
  origin?: string;
  /** When true (default), enqueue on the process-wide lock. */
  serialize?: boolean;
}): Promise<{ link: string; token: string; expiresAt: number; keyB64Url: string } | null> {
  const isStale = opts.isStale ?? (() => false);
  const run = async () => {
    const wrapped = await wrapRecoveryBundle(opts.bundle);
    if (isStale()) return null;

    const session = await opts.createLoginRecovery(opts.userId, wrapped.ciphertext);
    if (isStale()) return null;

    const origin =
      opts.origin ??
      (typeof window !== 'undefined' ? window.location.origin : 'http://localhost');

    return {
      link: buildLink(origin, session.token, wrapped.keyB64Url),
      token: session.token,
      expiresAt: session.expiresAt,
      keyB64Url: wrapped.keyB64Url,
    };
  };

  if (opts.serialize === false) return run();
  return globalIssueQueue(run);
}

/** Run a single recovery issue as the latest generation (cancels overlapping callers). */
export async function issueRecoveryLinkLatest(opts: {
  userId: string;
  bundle: RecoveryKeyBundle;
  createLoginRecovery: CreateLoginRecoveryFn;
  origin?: string;
}): Promise<{ link: string; token: string; expiresAt: number; keyB64Url: string } | null> {
  const gen = ++globalIssueGen;
  return issueRecoveryLink({
    ...opts,
    isStale: () => gen !== globalIssueGen,
    serialize: true,
  });
}

/** Run async tasks one-at-a-time (Strict Mode double-effect safe). */
export function createSerialQueue() {
  let tail: Promise<unknown> = Promise.resolve();
  return function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = tail.then(task, task);
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
}
