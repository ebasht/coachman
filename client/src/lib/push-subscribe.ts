import { api, getAuthToken } from './api';
import { isStandalonePWA } from './pwa';

const VAPID_KEY_CACHE = 'cm:pushVapidKey';

function isIOS(): boolean {
  return (
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  );
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    output[i] = raw.charCodeAt(i);
  }
  return output;
}

export function pushNeedsPWAInstall(): boolean {
  return isIOS() && !isStandalonePWA() && 'Notification' in window;
}

export function pushSupported(): boolean {
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    return false;
  }
  if (isIOS() && !isStandalonePWA()) {
    return false;
  }
  return true;
}

export function pushPermission(): NotificationPermission | 'unsupported' {
  if (pushNeedsPWAInstall()) return 'unsupported';
  if (!pushSupported()) return 'unsupported';
  return Notification.permission;
}

export async function prefetchPushConfig(): Promise<void> {
  try {
    const config = await api.getPushConfig();
    if (config.enabled && config.publicKey) {
      localStorage.setItem(VAPID_KEY_CACHE, config.publicKey);
    }
  } catch {
    // optional warmup
  }
}

async function getVapidPublicKey(): Promise<string | null> {
  const cached = localStorage.getItem(VAPID_KEY_CACHE);
  if (cached) return cached;
  await prefetchPushConfig();
  return localStorage.getItem(VAPID_KEY_CACHE);
}

async function registerSubscriptionOnServer(subscription: PushSubscription): Promise<boolean> {
  if (!getAuthToken()) return false;
  const json = subscription.toJSON();
  if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) return false;
  await api.subscribePush({
    endpoint: json.endpoint,
    keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
  });
  return true;
}

export type PushEnableResult =
  | 'ok'
  | 'denied'
  | 'unsupported'
  | 'needs-install'
  | 'no-vapid'
  | 'error';

/**
 * Call directly from a button click handler.
 * Notification.requestPermission() runs synchronously on the first line (required on iOS).
 */
export function onEnablePushClick(onDone?: (result: PushEnableResult) => void): void {
  if (pushNeedsPWAInstall()) {
    onDone?.('needs-install');
    return;
  }
  if (!pushSupported()) {
    onDone?.('unsupported');
    return;
  }

  const cachedKey = localStorage.getItem(VAPID_KEY_CACHE);
  if (!cachedKey) {
    void prefetchPushConfig();
    onDone?.('no-vapid');
    return;
  }

  if (Notification.permission === 'denied') {
    onDone?.('denied');
    return;
  }

  const permissionPromise: Promise<NotificationPermission> =
    Notification.permission === 'granted'
      ? Promise.resolve('granted')
      : Notification.requestPermission();

  void permissionPromise
    .then(async (permission) => {
      if (permission !== 'granted') {
        return 'denied' as const;
      }

      const registration = await navigator.serviceWorker.ready;
      const applicationServerKey = urlBase64ToUint8Array(cachedKey) as BufferSource;
      let subscription = await registration.pushManager.getSubscription();

      if (subscription) {
        const json = subscription.toJSON();
        const storedKey = localStorage.getItem(VAPID_KEY_CACHE);
        if (storedKey && storedKey !== cachedKey) {
          try {
            if (getAuthToken() && json.endpoint) {
              await api.unsubscribePush(json.endpoint);
            }
          } catch {
            // already removed
          }
          await subscription.unsubscribe();
          subscription = null;
        }
      }

      if (!subscription) {
        subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey,
        });
      }

      localStorage.setItem(VAPID_KEY_CACHE, cachedKey);

      if (getAuthToken()) {
        await registerSubscriptionOnServer(subscription);
      }

      return 'ok' as const;
    })
    .then((result) => onDone?.(result))
    .catch((e) => {
      console.warn('push enable failed', e);
      onDone?.('error');
    });
}

/** @deprecated use onEnablePushClick */
export function beginPushSubscribeFromGesture(): void {
  onEnablePushClick();
}

/** @deprecated use onEnablePushClick */
export function startPushFromGesture(): void {
  onEnablePushClick();
}

export async function enablePushFromGesture(): Promise<boolean> {
  return new Promise((resolve) => {
    onEnablePushClick((result) => resolve(result === 'ok'));
  });
}

export async function syncPushSubscription(): Promise<boolean> {
  if (!pushSupported()) return false;
  if (Notification.permission !== 'granted') return false;
  if (!getAuthToken()) return false;

  const publicKey = await getVapidPublicKey();
  if (!publicKey) return false;

  const registration = await navigator.serviceWorker.ready;
  let subscription = await registration.pushManager.getSubscription();

  if (!subscription) {
    if (isIOS()) return false;
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource,
    });
  }

  if (!subscription) return false;
  return registerSubscriptionOnServer(subscription);
}

export async function subscribeToPush(): Promise<boolean> {
  return enablePushFromGesture();
}

export async function unsubscribeFromPush(): Promise<void> {
  if (!('serviceWorker' in navigator)) return;

  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  if (!subscription) return;

  try {
    if (getAuthToken()) {
      await api.unsubscribePush(subscription.endpoint);
    }
  } catch {
    // already removed
  }
  await subscription.unsubscribe();
  localStorage.removeItem(VAPID_KEY_CACHE);
}
