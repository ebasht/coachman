self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }

  const title = data.title || 'Ямщик';
  const tag = data.chatId
    ? `chat-${data.chatId}`
    : 'coachman-message';
  const options = {
    body: data.body || 'Новое сообщение',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag,
    renotify: true,
    data: { chatId: data.chatId || null },
  };

  const badgeCount = typeof data.badge === 'number' && data.badge > 0 ? data.badge : 1;

  // iOS: showNotification must finish inside waitUntil before the push event ends.
  event.waitUntil(
    (async () => {
      await self.registration.showNotification(title, options);
      const nav = self.navigator || navigator;
      if (nav.setAppBadge) {
        try {
          await nav.setAppBadge(badgeCount > 99 ? '99+' : badgeCount);
        } catch {
          // ignore
        }
      }
    })(),
  );
});

self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    (async () => {
      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of clients) {
        client.postMessage({ type: 'push-resubscribe' });
      }
    })(),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const chatId = event.notification.data?.chatId;
  const targetPath = chatId ? `/c/${encodeURIComponent(chatId)}` : '/';
  const targetUrl = new URL(targetPath, self.location.origin).href;

  event.waitUntil(
    (async () => {
      const nav = self.navigator || navigator;
      if (nav.clearAppBadge) {
        try {
          await nav.clearAppBadge();
        } catch {
          // ignore
        }
      }

      const windowClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of windowClients) {
        client.postMessage({ type: 'open-chat', chatId: chatId || null });
        if ('focus' in client) {
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
    })(),
  );
});
