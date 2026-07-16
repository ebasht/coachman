import { Capacitor } from '@capacitor/core';
import { KeepAwake } from '@capacitor-community/keep-awake';
import { PushNotifications } from '@capacitor/push-notifications';
import { api, getAuthToken } from './api';
import { CoachmanCalls, type CoachmanCallEvent } from './coachman-calls';
import {
  clearPendingCallInvite,
  markCallDismissed,
  savePendingCallInvite,
} from './pending-call-invite';

export type NativeCallPushHandler = (event: CoachmanCallEvent) => void;

let pushHandler: NativeCallPushHandler | null = null;
let registered = false;
let currentToken: string | null = null;
let inCallActive = false;
/** Events that arrived before React registered the handler (cold start Accept). */
const pendingHandlerEvents: CoachmanCallEvent[] = [];

export function isNativeAndroid(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';
}

export function truthyFlag(v: unknown): boolean {
  return v === true || v === 'true' || v === '1' || v === 1;
}

export function setNativeCallPushHandler(handler: NativeCallPushHandler | null): void {
  pushHandler = handler;
  if (!handler) return;
  // Flush Accept/Decline that arrived before the React handler existed.
  while (pendingHandlerEvents.length > 0) {
    const next = pendingHandlerEvents.shift();
    if (next) handler(next);
  }
}

function dispatchCallEvent(event: CoachmanCallEvent, opts?: { presentNativeUi?: boolean }): void {
  // Normalize Capacitor / intent payloads (booleans often arrive as strings).
  const normalized = dataFromPush(event);
  if (!normalized.type) return;
  event = { ...event, ...normalized };

  if (event.type === 'incoming-call' && event.chatId && event.callId) {
    const acted = truthyFlag(event.autoAccept) || truthyFlag(event.autoReject);
    if (acted) {
      // User already tapped Accept/Decline on native UI — do not re-save invite
      // (that would revive the web ringing screen after a failed media race).
      clearPendingCallInvite(event.callId);
    } else {
      savePendingCallInvite({
        chatId: event.chatId,
        callId: event.callId,
        fromUserId: event.fromUserId,
      });
    }
    const present =
      !acted && (opts?.presentNativeUi ?? document.hidden);
    if (present) {
      void CoachmanCalls.showIncomingCall({
        callId: event.callId,
        chatId: event.chatId,
        fromUserId: event.fromUserId,
        title: event.title || 'Входящий видеозвонок',
        body: event.body || 'Собеседник',
      }).catch(() => {
        // channel / permission may be missing — pending invite still saved
      });
    }
  }
  if (event.type === 'call-ended' && event.callId) {
    clearPendingCallInvite(event.callId);
    markCallDismissed(event.callId);
    void CoachmanCalls.dismissIncomingCall({ callId: event.callId }).catch(() => {});
  }
  if (pushHandler) {
    pushHandler(event);
  } else {
    pendingHandlerEvents.push(event);
  }
}

function dataFromPush(value: unknown): CoachmanCallEvent {
  if (!value || typeof value !== 'object') return {};
  const raw = value as Record<string, unknown>;
  // Capacitor may nest under .data
  const nested =
    raw.data && typeof raw.data === 'object' ? (raw.data as Record<string, unknown>) : raw;
  const str = (k: string) => {
    const v = nested[k] ?? raw[k];
    return typeof v === 'string' ? v : undefined;
  };
  return {
    type: str('type'),
    callId: str('callId'),
    chatId: str('chatId'),
    fromUserId: str('fromUserId'),
    title: str('title'),
    body: str('body'),
    autoAccept: truthyFlag(nested.autoAccept ?? raw.autoAccept),
    autoReject: truthyFlag(nested.autoReject ?? raw.autoReject),
  };
}

async function registerTokenOnServer(token: string): Promise<void> {
  if (!getAuthToken()) return;
  currentToken = token;
  await api.registerDevicePushToken({ token, platform: 'android' });
}

/** Register FCM + call channels. Safe to call repeatedly after login. */
export async function initNativeCallPush(): Promise<boolean> {
  if (!isNativeAndroid()) return false;

  await CoachmanCalls.ensureChannels().catch(() => {});

  // Android 14+: full-screen incoming UI needs an explicit grant.
  try {
    const fsi = await CoachmanCalls.canUseFullScreenIntent();
    if (!fsi.allowed) {
      const key = 'coachman_fsi_prompted';
      if (!localStorage.getItem(key)) {
        localStorage.setItem(key, '1');
        await CoachmanCalls.openFullScreenIntentSettings();
      }
    }
  } catch {
    // older plugin / web stub
  }

  const perm = await PushNotifications.requestPermissions();
  if (perm.receive !== 'granted') {
    try {
      localStorage.setItem('coachman_native_push_granted', '0');
    } catch {
      // ignore
    }
    return false;
  }
  try {
    localStorage.setItem('coachman_native_push_granted', '1');
  } catch {
    // ignore
  }

  if (!registered) {
    registered = true;

    await PushNotifications.addListener('registration', (token) => {
      void registerTokenOnServer(token.value).catch((e) =>
        console.warn('device push token register failed', e),
      );
    });

    await PushNotifications.addListener('registrationError', (err) => {
      console.warn('FCM registration error', err);
    });

    await PushNotifications.addListener('pushNotificationReceived', (notification) => {
      // Foreground: present full-screen call UI ourselves.
      dispatchCallEvent(dataFromPush(notification.data ?? notification), { presentNativeUi: true });
    });

    await PushNotifications.addListener('pushNotificationActionPerformed', (action) => {
      // User tapped system/FCM notification — app is opening; React UI is enough.
      dispatchCallEvent(dataFromPush(action.notification?.data ?? action.notification), {
        presentNativeUi: false,
      });
    });

    await CoachmanCalls.addListener('callEvent', (event) => {
      dispatchCallEvent(event, { presentNativeUi: false });
    });
  }

  await PushNotifications.register();

  const launch = await CoachmanCalls.consumeLaunchCall().catch(() => ({} as CoachmanCallEvent));
  if (launch?.type) {
    dispatchCallEvent(launch);
  }

  if (getAuthToken() && currentToken) {
    await registerTokenOnServer(currentToken).catch(() => {});
  }

  return true;
}

export async function syncNativeDeviceToken(): Promise<boolean> {
  if (!isNativeAndroid()) return false;
  return initNativeCallPush();
}

export async function unregisterNativeDeviceToken(): Promise<void> {
  if (!isNativeAndroid() || !currentToken || !getAuthToken()) return;
  try {
    await api.unregisterDevicePushToken(currentToken);
  } catch {
    // ignore
  }
}

/** Keep screen on + Android foreground service while a call is non-idle. */
export async function setNativeInCallSession(
  active: boolean,
  opts?: { peerName?: string },
): Promise<void> {
  if (!isNativeAndroid()) return;
  if (active === inCallActive) return;
  inCallActive = active;
  try {
    if (active) {
      await KeepAwake.keepAwake();
      await CoachmanCalls.startInCall({
        title: 'Ямщик',
        body: opts?.peerName ? `Звонок: ${opts.peerName}` : 'Идёт звонок',
      });
    } else {
      await KeepAwake.allowSleep();
      await CoachmanCalls.stopInCall();
    }
  } catch (e) {
    console.warn('native in-call session failed', e);
  }
}

export async function requestNativeMediaPermissions(): Promise<boolean> {
  if (!isNativeAndroid()) return true;
  try {
    const r = await CoachmanCalls.requestMediaPermissions();
    return !!(r.camera && r.microphone);
  } catch {
    return false;
  }
}

export async function dismissNativeIncomingCall(callId: string | null | undefined): Promise<void> {
  if (!isNativeAndroid()) return;
  await CoachmanCalls.dismissIncomingCall({ callId: callId || '' }).catch(() => {});
}
