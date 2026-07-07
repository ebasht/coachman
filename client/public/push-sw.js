async function shouldSuppressNotification(chatId) {
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  if (clients.length === 0) return false;

  const checks = clients.map(
    (client) =>
      new Promise((resolve) => {
        const channel = new MessageChannel();
        const timer = setTimeout(() => resolve(false), 300);
        channel.port1.onmessage = (event) => {
          clearTimeout(timer);
          resolve(!!event.data?.suppress);
        };
        try {
          client.postMessage({ type: 'push-suppress-check', chatId: chatId || null }, [channel.port2]);
        } catch {
          clearTimeout(timer);
          resolve(false);
        }
      }),
  );

  const results = await Promise.all(checks);
  return results.some(Boolean);
}

self.addEventListener('push', (event) => {
  event.waitUntil(
    (async () => {
      let data = {};
      try {
        data = event.data ? event.data.json() : {};
      } catch {
        data = {};
      }

      if (data.badge && self.navigator.setAppBadge) {
        try {
          await self.navigator.setAppBadge(data.badge);
        } catch {
          // ignore
        }
      }

      const suppress = await shouldSuppressNotification(data.chatId);
      if (suppress) return;

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

      await self.registration.showNotification(title, options);
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
