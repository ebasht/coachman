import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import App from './App';
import { NotificationHost } from './components/NotificationHost';
import { initNativeShell } from './lib/native-shell';
import { initNativeCallBridge } from './lib/native-calls';
import { isCallUiActive } from './lib/call-ui-active';
import { requestPersistentStorage } from './lib/pwa';
import { prefetchPushConfig } from './lib/push-subscribe';
import { restoreTabBadgeFromStorage } from './lib/tab-badge';
import { initTheme } from './lib/theme';
import { markBootSplashStarted } from './lib/boot-splash';
import './index.css';

markBootSplashStarted();
initTheme();
void initNativeShell();
void initNativeCallBridge();

/**
 * New SW after skipWaiting/clientsClaim. Reloading immediately kills cold start
 * (push open) and active chats. Apply the update only once the app is backgrounded.
 */
let swRefreshing = false;
let pendingSwReload = false;

function reloadForServiceWorker(): void {
  if (swRefreshing) return;
  if (!navigator.onLine) return;
  if (isCallUiActive()) {
    pendingSwReload = true;
    return;
  }
  if (document.documentElement.classList.contains('is-booting') || !document.hidden) {
    pendingSwReload = true;
    return;
  }
  swRefreshing = true;
  pendingSwReload = false;
  window.location.reload();
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    reloadForServiceWorker();
  });
  document.addEventListener('visibilitychange', () => {
    if (pendingSwReload && document.hidden) {
      reloadForServiceWorker();
    }
  });
}

registerSW({
  immediate: true,
  onRegisteredSW(url, registration) {
    // Keep registration alive; only check for updates while online.
    const tryUpdate = () => {
      if (!navigator.onLine) return;
      registration?.update().catch(() => {});
    };
    tryUpdate();
    window.setInterval(tryUpdate, 5 * 60 * 1000);

    // If we somehow loaded without a controller (common after iOS force-quit),
    // claim happens on the SW side; a soft reload once online repairs control.
    if (!navigator.serviceWorker.controller && navigator.onLine && url) {
      registration?.update().catch(() => {});
    }
  },
});

restoreTabBadgeFromStorage();
void requestPersistentStorage();
void prefetchPushConfig();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <NotificationHost />
    <App />
  </StrictMode>
);
