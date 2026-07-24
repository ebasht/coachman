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
import './index.css';

initTheme();
void initNativeShell();
void initNativeCallBridge();

let swRefreshing = false;
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (swRefreshing) return;
    // Reloading while offline often blanks the PWA if the new SW race-conditions precache.
    if (!navigator.onLine) return;
    // Mid-call reload drops WebRTC + call UI and lands on the chat list.
    if (isCallUiActive()) {
      console.warn('[sw] skip reload — call in progress');
      return;
    }
    swRefreshing = true;
    window.location.reload();
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
