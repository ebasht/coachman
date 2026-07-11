import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import App from './App';
import { NotificationHost } from './components/NotificationHost';
import { requestPersistentStorage } from './lib/pwa';
import { prefetchPushConfig } from './lib/push-subscribe';
import { restoreTabBadgeFromStorage } from './lib/tab-badge';
import './index.css';

let swRefreshing = false;
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (swRefreshing) return;
    // Reloading while offline often blanks the PWA if the new SW race-conditions precache.
    if (!navigator.onLine) return;
    swRefreshing = true;
    window.location.reload();
  });
}

registerSW({
  immediate: true,
  onRegisteredSW(_url, registration) {
    const tryUpdate = () => {
      if (!navigator.onLine) return;
      registration?.update().catch(() => {});
    };
    tryUpdate();
    // Pick up deploys while the PWA stays open.
    window.setInterval(tryUpdate, 5 * 60 * 1000);
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
