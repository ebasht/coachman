self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }

  const title = data.title || 'Ямщик';
  const tag = data.chatId
    ? `chat-${data.chatId}-${data.ts || Date.now()}`
    : `coachman-${data.ts || Date.now()}`;
  const options = {
    body: data.body || 'Новое сообщение',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag,
    renotify: true,
    data: { chatId: data.chatId || null },
  };

  // iOS: showNotification must finish inside waitUntil before the push event ends.
  event.waitUntil(
    (async () => {
      await self.registration.showNotification(title, options);
      if (data.badge && self.navigator.setAppBadge) {
        try {
          await self.navigator.setAppBadge(data.badge);
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
