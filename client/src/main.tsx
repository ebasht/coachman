import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import App from './App';
import { NotificationHost } from './components/NotificationHost';
import { requestPersistentStorage } from './lib/pwa';
import { prefetchPushConfig } from './lib/push-subscribe';
import { restoreTabBadgeFromStorage } from './lib/tab-badge';
import './index.css';

registerSW({ immediate: true });
restoreTabBadgeFromStorage();
void requestPersistentStorage();
void prefetchPushConfig();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <NotificationHost />
    <App />
  </StrictMode>
);
