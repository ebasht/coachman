import { Capacitor } from '@capacitor/core';
import { api, getAuthToken } from './api';
import { isStandalonePWA } from './pwa';
import { isNativeAndroid, syncNativeDeviceToken } from './native-calls';

const VAPID_KEY_CACHE = 'cm:pushVapidKey';
const NATIVE_PUSH_GRANTED_KEY = 'coachman_native_push_granted';

declare global {
  interface Window {
    __COACHMAN_RUNTIME__?: { vapidPublicKey?: string; iceServers?: RTCIceServer[] };
  }
}

function runtimeVapidKey(): string | null {
  const key = window.__COACHMAN_RUNTIME__?.vapidPublicKey?.trim();
  return key || null;
}

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

function hasNotificationApi(): boolean {
  return typeof Notification !== 'undefined';
}

function webNotificationPermission(): NotificationPermission | 'unsupported' {
  if (!hasNotificationApi()) return 'unsupported';
  return Notification.permission;
}

export function pushNeedsPWAInstall(): boolean {
  if (isNativeAndroid()) return false;
  return isIOS() && !isStandalonePWA() && hasNotificationApi();
}

export function pushSupported(): boolean {
  if (isNativeAndroid()) return Capacitor.isNativePlatform();
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !hasNotificationApi()) {
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
  if (isNativeAndroid()) {
    // Capacitor uses FCM — Web Notification.permission is meaningless / stuck on default.
    try {
      if (localStorage.getItem(NATIVE_PUSH_GRANTED_KEY) === '1') return 'granted';
      if (localStorage.getItem(NATIVE_PUSH_GRANTED_KEY) === '0') return 'denied';
    } catch {
      // ignore
    }
    return 'default';
  }
  return webNotificationPermission();
}

/** Sync FCM permission into localStorage so the chat-list banner can hide. */
export async function refreshNativePushPermissionState(): Promise<NotificationPermission | 'unsupported'> {
  if (!isNativeAndroid()) return pushPermission();
  try {
    const { PushNotifications } = await import('@capacitor/push-notifications');
    const status = await PushNotifications.checkPermissions();
    if (status.receive === 'granted') {
      localStorage.setItem(NATIVE_PUSH_GRANTED_KEY, '1');
      return 'granted';
    }
    if (status.receive === 'denied') {
      localStorage.setItem(NATIVE_PUSH_GRANTED_KEY, '0');
      return 'denied';
    }
    localStorage.removeItem(NATIVE_PUSH_GRANTED_KEY);
    return 'default';
  } catch {
    return pushPermission();
  }
}

function setNativePushGranted(granted: boolean): void {
  try {
    localStorage.setItem(NATIVE_PUSH_GRANTED_KEY, granted ? '1' : '0');
  } catch {
    // ignore
  }
}

export async function prefetchPushConfig(): Promise<void> {
  if (!window.__COACHMAN_RUNTIME__) {
    await loadRuntimeConfigScript();
  }
  const runtime = runtimeVapidKey();
  if (runtime) {
    localStorage.setItem(VAPID_KEY_CACHE, runtime);
    return;
  }
  try {
    const config = await api.getPushConfig();
    if (config.enabled && config.publicKey) {
      localStorage.setItem(VAPID_KEY_CACHE, config.publicKey);
    }
  } catch {
    // optional warmup
  }
}

function loadRuntimeConfigScript(): Promise<void> {
  if (document.querySelector('script[data-runtime-config]')) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const script = document.createElement('script');
    script.src = '/runtime-config.js';
    script.async = true;
    script.dataset.runtimeConfig = '1';
    const done = () => resolve();
    script.onload = done;
    script.onerror = done;
    // Safari can hang script loads when offline instead of firing onerror.
    window.setTimeout(done, 2000);
    document.head.appendChild(script);
  });
}

async function getVapidPublicKey(): Promise<string | null> {
  const runtime = runtimeVapidKey();
  if (runtime) {
    localStorage.setItem(VAPID_KEY_CACHE, runtime);
    return runtime;
  }
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
  if (isNativeAndroid()) {
    void (async () => {
      try {
        const ok = await syncNativeDeviceToken();
        setNativePushGranted(ok);
        onDone?.(ok ? 'ok' : 'denied');
      } catch (e) {
        console.warn('native push enable failed', e);
        onDone?.('error');
      }
    })();
    return;
  }
  if (pushNeedsPWAInstall()) {
    onDone?.('needs-install');
    return;
  }
  if (!pushSupported()) {
    onDone?.('unsupported');
    return;
  }
  if (!hasNotificationApi()) {
    onDone?.('unsupported');
    return;
  }
  if (Notification.permission === 'denied') {
    onDone?.('denied');
    return;
  }

  // iOS: must invoke requestPermission synchronously inside the click handler.
  const permissionPromise: Promise<NotificationPermission> =
    Notification.permission === 'granted'
      ? Promise.resolve('granted')
      : Notification.requestPermission();

  void (async () => {
    try {
      const [permission, publicKey] = await Promise.all([
        permissionPromise,
        getVapidPublicKey(),
      ]);

      if (permission !== 'granted') {
        onDone?.('denied');
        return;
      }
      if (!publicKey) {
        onDone?.('no-vapid');
        return;
      }

      const registration = await navigator.serviceWorker.ready;
      const applicationServerKey = urlBase64ToUint8Array(publicKey) as BufferSource;
      let subscription = await registration.pushManager.getSubscription();

      if (subscription) {
        const json = subscription.toJSON();
        const storedKey = localStorage.getItem(VAPID_KEY_CACHE);
        if (storedKey && storedKey !== publicKey) {
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

      localStorage.setItem(VAPID_KEY_CACHE, publicKey);

      if (getAuthToken()) {
        await registerSubscriptionOnServer(subscription);
      }

      onDone?.('ok');
    } catch (e) {
      console.warn('push enable failed', e);
      onDone?.('error');
    }
  })();
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
  if (isNativeAndroid()) {
    return syncNativeDeviceToken();
  }
  if (!pushSupported()) return false;
  if (!hasNotificationApi() || Notification.permission !== 'granted') return false;
  if (!getAuthToken()) return false;

  const publicKey = await getVapidPublicKey();
  if (!publicKey) return false;

  const registration = await navigator.serviceWorker.ready;
  let subscription = await registration.pushManager.getSubscription();

  if (!subscription) {
    // Permission already granted: recreate endpoint after iOS revoked a silent-push
    // subscription (or after OS cleared it). First-time grant still needs a gesture
    // via onEnablePushClick; here permission is already 'granted'.
    try {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource,
      });
    } catch (e) {
      console.warn('push resubscribe failed', e);
      return false;
    }
  }

  if (!subscription) return false;
  localStorage.setItem(VAPID_KEY_CACHE, publicKey);
  return registerSubscriptionOnServer(subscription);
}

export async function subscribeToPush(): Promise<boolean> {
  return enablePushFromGesture();
}

export async function unsubscribeFromPush(): Promise<void> {
  if (isNativeAndroid()) {
    const { unregisterNativeDeviceToken } = await import('./native-calls');
    await unregisterNativeDeviceToken();
    return;
  }
  if (!('serviceWorker' in navigator)) return;

  const registration = await navigator.serviceWorker.getRegistration();
  if (!registration) return;

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
