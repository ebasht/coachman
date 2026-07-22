export type LockCallContext = {
  callId: string;
  chatId: string;
  fromUserId?: string;
  title?: string;
  body?: string;
  nativeOwnsRingtone: boolean;
};

type AndroidCallBridge = {
  uiReady: () => void;
  dismissRing: () => void;
  reject: () => void;
  accept: () => void;
  callEnded: (needsUnlock: boolean) => void;
  log: (msg: string) => void;
};

declare global {
  interface Window {
    CoachmanAndroidCall?: AndroidCallBridge;
    __COACHMAN_LOCK_CALL__?: Partial<LockCallContext> & { lockCall?: boolean };
    __coachmanLockBootstrap?: () => void;
    __coachmanLockAccept?: () => void;
    __coachmanLockReject?: () => void;
  }
}

export function readLockCallContext(): LockCallContext | null {
  const fromWindow = window.__COACHMAN_LOCK_CALL__;
  const q = new URLSearchParams(window.location.search);
  const lockCall =
    q.get('lockCall') === '1' || fromWindow?.lockCall === true || Boolean(fromWindow?.callId);

  if (!lockCall && !fromWindow?.callId) return null;

  const callId = (fromWindow?.callId || q.get('callId') || '').trim();
  const chatId = (fromWindow?.chatId || q.get('chatId') || '').trim();
  if (!callId || !chatId) return null;

  return {
    callId,
    chatId,
    fromUserId: (fromWindow?.fromUserId || q.get('fromUserId') || undefined) || undefined,
    title: fromWindow?.title || q.get('title') || undefined,
    body: fromWindow?.body || q.get('body') || undefined,
    nativeOwnsRingtone: fromWindow?.nativeOwnsRingtone !== false,
  };
}

export function isAndroidLockCallWebView(): boolean {
  return typeof window.CoachmanAndroidCall?.uiReady === 'function' || readLockCallContext() != null;
}

export function lockCallBridge(): AndroidCallBridge | null {
  return window.CoachmanAndroidCall ?? null;
}

export function notifyLockCallUiReady(): void {
  try {
    window.CoachmanAndroidCall?.uiReady();
    window.CoachmanAndroidCall?.log?.('uiReady');
  } catch {
    // ignore
  }
}

export function notifyLockCallDismissRing(): void {
  try {
    window.CoachmanAndroidCall?.dismissRing();
  } catch {
    // ignore
  }
}

export function notifyLockCallEnded(needsUnlock: boolean): void {
  try {
    window.CoachmanAndroidCall?.callEnded(needsUnlock);
  } catch {
    // ignore
  }
}
