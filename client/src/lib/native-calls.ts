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
let bridgeRegistered = false;
let pushRegistered = false;
let currentToken: string | null = null;
let inCallActive = false;
/** Events that arrived before React registered the handler (cold start Accept). */
const pendingHandlerEvents: CoachmanCallEvent[] = [];
/** Deduplicate delivered native call actions by eventId. */
const processedNativeCallEventIds = new Set<string>();

export function isNativeAndroid(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';
}

export function truthyFlag(v: unknown): boolean {
  return v === true || v === 'true' || v === '1' || v === 1;
}

export function setNativeCallPushHandler(handler: NativeCallPushHandler | null): void {
  pushHandler = handler;
  if (!handler) return;
  while (pendingHandlerEvents.length > 0) {
    const next = pendingHandlerEvents.shift();
    if (next) handler(next);
  }
}

function dispatchCallEvent(event: CoachmanCallEvent, opts?: { presentNativeUi?: boolean }): void {
  const normalized = dataFromPush(event);
  if (!normalized.type) return;
  event = { ...event, ...normalized };

  const eventId = event.eventId;
  if (eventId) {
    if (processedNativeCallEventIds.has(eventId)) {
      console.info('[native-calls] skip duplicate eventId=', eventId, 'callId=', event.callId);
      return;
    }
  }

  if (event.type === 'incoming-call' && event.chatId && event.callId) {
    const acted = isNativeCallAction(event);
    if (acted) {
      clearPendingCallInvite(event.callId);
    } else {
      savePendingCallInvite({
        chatId: event.chatId,
        callId: event.callId,
        fromUserId: event.fromUserId,
      });
    }
    const present = shouldPresentNativeIncomingUi(event, {
      presentNativeUi: opts?.presentNativeUi,
      documentHidden: document.hidden,
    });
    if (present) {
      void CoachmanCalls.showIncomingCall({
        callId: event.callId,
        chatId: event.chatId,
        fromUserId: event.fromUserId,
        title: event.title || 'Входящий видеозвонок',
        body: event.body || 'Собеседник',
      }).catch(() => {});
    }
  }
  if (event.type === 'call-ended' && event.callId) {
    clearPendingCallInvite(event.callId);
    markCallDismissed(event.callId);
    void CoachmanCalls.dismissIncomingCall({ callId: event.callId }).catch(() => {});
  }

  console.info(
    '[native-calls] event delivered eventId=',
    event.eventId,
    'callId=',
    event.callId,
    'action=',
    event.action ?? (event.autoAccept ? 'accept' : event.autoReject ? 'reject' : ''),
  );

  if (pushHandler) {
    pushHandler(event);
  } else {
    pendingHandlerEvents.push(event);
  }
}

async function prefetchFromNativePush(data: CoachmanCallEvent): Promise<void> {
  const chatId = data.chatId;
  if (!chatId) return;
  const t = data.type;
  if (t && t !== 'message' && t !== 'message-push' && t !== 'badge') return;
  try {
    const { prefetchChatInBackground } = await import('./background-prefetch');
    await prefetchChatInBackground(chatId);
    window.dispatchEvent(new CustomEvent('coachman-prefetch-ready', { detail: { chatId } }));
  } catch (e) {
    console.warn('native background prefetch failed', e);
  }
}

function dataFromPush(value: unknown): CoachmanCallEvent {
  if (!value || typeof value !== 'object') return {};
  const raw = value as Record<string, unknown>;
  const nested =
    raw.data && typeof raw.data === 'object' ? (raw.data as Record<string, unknown>) : raw;
  const str = (k: string) => {
    const v = nested[k] ?? raw[k];
    return typeof v === 'string' ? v : undefined;
  };
  const actionRaw = str('action');
  const autoAccept = truthyFlag(nested.autoAccept ?? raw.autoAccept) || actionRaw === 'accept';
  const autoReject = truthyFlag(nested.autoReject ?? raw.autoReject) || actionRaw === 'reject';
  return {
    eventId: str('eventId'),
    type: str('type'),
    action: actionRaw ?? (autoAccept ? 'accept' : autoReject ? 'reject' : undefined),
    callId: str('callId'),
    chatId: str('chatId'),
    fromUserId: str('fromUserId'),
    title: str('title'),
    body: str('body'),
    autoAccept,
    autoReject,
    createdAt: typeof nested.createdAt === 'number' ? nested.createdAt : undefined,
  };
}

export function parseCallPushData(value: unknown): CoachmanCallEvent {
  return dataFromPush(value);
}

export function isNativeCallAction(event: CoachmanCallEvent): boolean {
  return truthyFlag(event.autoAccept) || truthyFlag(event.autoReject) || event.action === 'accept' || event.action === 'reject';
}

export function shouldPresentNativeIncomingUi(
  event: CoachmanCallEvent,
  opts?: { presentNativeUi?: boolean; documentHidden?: boolean },
): boolean {
  if (event.type !== 'incoming-call' || !event.chatId || !event.callId) return false;
  if (isNativeCallAction(event)) return false;
  return opts?.presentNativeUi ?? opts?.documentHidden ?? false;
}

/** Mark event processed in JS and ack native store (after accept/reject applied). */
export async function acknowledgeNativeCallAction(eventId: string | undefined): Promise<void> {
  if (!eventId || !isNativeAndroid()) return;
  processedNativeCallEventIds.add(eventId);
  try {
    await CoachmanCalls.ackPendingCallAction({ eventId });
    console.info('[native-calls] event acknowledged eventId=', eventId);
  } catch (e) {
    console.warn('[native-calls] ack failed', eventId, e);
  }
}

async function registerTokenOnServer(token: string): Promise<void> {
  if (!getAuthToken()) return;
  currentToken = token;
  await api.registerDevicePushToken({
    token,
    platform: 'android',
    nativeVideoCall: true,
    nativeCallProtocol: 1,
  });
}

/**
 * Capacitor call bridge — independent of auth / FCM token.
 * Safe to call once at app startup.
 */
export async function initNativeCallBridge(): Promise<void> {
  if (!isNativeAndroid() || bridgeRegistered) return;
  bridgeRegistered = true;

  await CoachmanCalls.ensureChannels().catch(() => {});

  await CoachmanCalls.addListener('callEvent', (event) => {
    dispatchCallEvent(event, { presentNativeUi: false });
  });
  console.info('[native-calls] bridge listener registered');

  const pending = await CoachmanCalls.peekPendingCallAction().catch(() => ({} as CoachmanCallEvent));
  if (pending?.type) {
    console.info(
      '[native-calls] peek pending eventId=',
      pending.eventId,
      'callId=',
      pending.callId,
    );
    dispatchCallEvent(pending, { presentNativeUi: false });
  }
}

/**
 * FCM permission + token registration. Does not own Accept/Reject delivery.
 */
export async function syncNativeDeviceToken(): Promise<boolean> {
  if (!isNativeAndroid()) return false;

  await initNativeCallBridge();

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

  if (!pushRegistered) {
    pushRegistered = true;

    await PushNotifications.addListener('registration', (token) => {
      void registerTokenOnServer(token.value).catch((e) =>
        console.warn('device push token register failed', e),
      );
    });

    await PushNotifications.addListener('registrationError', (err) => {
      console.warn('FCM registration error', err);
    });

    await PushNotifications.addListener('pushNotificationReceived', (notification) => {
      const data = dataFromPush(notification.data ?? notification);
      // Foreground: React overlay owns UI. Background: presentNativeUi if tab hidden.
      dispatchCallEvent(data, { presentNativeUi: document.hidden });
      void prefetchFromNativePush(data);
    });

    await PushNotifications.addListener('pushNotificationActionPerformed', (action) => {
      const data = dataFromPush(action.notification?.data ?? action.notification);
      dispatchCallEvent(data, { presentNativeUi: false });
      void prefetchFromNativePush(data);
    });
  }

  await PushNotifications.register();

  if (getAuthToken() && currentToken) {
    await registerTokenOnServer(currentToken).catch(() => {});
  }

  return true;
}

/** @deprecated Use initNativeCallBridge + syncNativeDeviceToken */
export async function initNativeCallPush(): Promise<boolean> {
  await initNativeCallBridge();
  return syncNativeDeviceToken();
}

export async function unregisterNativeDeviceToken(): Promise<void> {
  if (!isNativeAndroid() || !currentToken || !getAuthToken()) return;
  try {
    await api.unregisterDevicePushToken(currentToken);
  } catch {
    // ignore
  }
}

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

export async function setNativeCallWindowMode(active: boolean): Promise<void> {
  if (!isNativeAndroid()) return;
  try {
    await CoachmanCalls.setCallWindowMode({ active });
  } catch {
    // ignore
  }
}

export async function requestNativeMediaPermissions(): Promise<boolean> {
  if (!isNativeAndroid()) return true;
  try {
    const r = await CoachmanCalls.requestMediaPermissions();
    return !!(r.cameraGranted ?? r.camera) && !!(r.microphoneGranted ?? r.microphone);
  } catch {
    return false;
  }
}

export async function dismissNativeIncomingCall(callId: string | null | undefined): Promise<void> {
  if (!isNativeAndroid()) return;
  await CoachmanCalls.dismissIncomingCall({ callId: callId || '' }).catch(() => {});
}

export async function getNativeCallLaunchContext() {
  if (!isNativeAndroid()) return { active: false as const };
  try {
    return await CoachmanCalls.getCallLaunchContext();
  } catch {
    return { active: false as const };
  }
}

export async function notifyNativeCallUiReady(callId: string): Promise<void> {
  if (!isNativeAndroid() || !callId) return;
  await CoachmanCalls.callUiReady({ callId }).catch(() => {});
}

export async function finishNativeCallAndOpenApp(callId: string): Promise<boolean> {
  if (!isNativeAndroid()) return true;
  try {
    const r = await CoachmanCalls.finishCallAndOpenApp({ callId });
    return !!r.unlocked;
  } catch {
    return false;
  }
}

export async function closeNativeCallOnlyMode(callId: string): Promise<void> {
  if (!isNativeAndroid()) return;
  await CoachmanCalls.closeCallOnlyMode({ callId }).catch(() => {});
}

/** Open FSI settings from an explicit Settings UI — never auto-prompt on launch. */
export async function openNativeFullScreenIntentSettings(): Promise<void> {
  if (!isNativeAndroid()) return;
  await CoachmanCalls.openFullScreenIntentSettings().catch(() => {});
}

export async function canUseNativeFullScreenIntent(): Promise<boolean> {
  if (!isNativeAndroid()) return true;
  try {
    const r = await CoachmanCalls.canUseFullScreenIntent();
    return !!r.allowed;
  } catch {
    return true;
  }
}
