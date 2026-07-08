import { api } from './api';
import { isStandalonePWA } from './pwa';

const VAPID_KEY_CACHE = 'cm:pushVapidKey';

let pendingPermission: Promise<NotificationPermission> | null = null;

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

/** Request permission synchronously from a tap (required on iOS). */
export function beginPushSubscribeFromGesture(): void {
  if (pushNeedsPWAInstall()) return;
  if (!('Notification' in window)) return;
  if (Notification.permission === 'default') {
    pendingPermission = Notification.requestPermission();
  }
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

async function resolvePermission(skipRequest: boolean): Promise<boolean> {
  if (pendingPermission) {
    const permission = await pendingPermission;
    pendingPermission = null;
    return permission === 'granted';
  }
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') return false;
  if (skipRequest) return false;
  return false;
}

/** Sync browser push subscription with server (permission must already be granted). */
export async function syncPushSubscription(): Promise<boolean> {
  return subscribeToPush({ skipPermissionRequest: true });
}

export async function subscribeToPush(options?: { skipPermissionRequest?: boolean }): Promise<boolean> {
  if (!pushSupported()) return false;

  const skipRequest = options?.skipPermissionRequest ?? false;
  const granted = await resolvePermission(skipRequest);
  if (!granted) return false;

  const config = await api.getPushConfig();
  if (!config.enabled || !config.publicKey) {
    console.warn('push: server has no VAPID keys configured');
    return false;
  }

  const registration = await navigator.serviceWorker.ready;
  const applicationServerKey = urlBase64ToUint8Array(config.publicKey) as BufferSource;
  let subscription = await registration.pushManager.getSubscription();

  const cachedKey = localStorage.getItem(VAPID_KEY_CACHE);
  if (subscription && cachedKey && cachedKey !== config.publicKey) {
    try {
      await api.unsubscribePush(subscription.endpoint);
    } catch {
      // already removed
    }
    await subscription.unsubscribe();
    subscription = null;
  }

  if (!subscription) {
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey,
    });
  }

  const json = subscription.toJSON();
  if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) return false;

  await api.subscribePush({
    endpoint: json.endpoint,
    keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
  });
  localStorage.setItem(VAPID_KEY_CACHE, config.publicKey);
  return true;
}

export async function unsubscribeFromPush(): Promise<void> {
  if (!('serviceWorker' in navigator)) return;

  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  if (!subscription) return;

  try {
    await api.unsubscribePush(subscription.endpoint);
  } catch {
    // already removed
  }
  await subscription.unsubscribe();
  localStorage.removeItem(VAPID_KEY_CACHE);
}
