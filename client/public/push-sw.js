self.addEventListener('push', (event) => {
  event.waitUntil(
    (async () => {
      let data = {};
      try {
        data = event.data ? event.data.json() : {};
      } catch {
        data = {};
      }

      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const appVisible = clients.some(
        (client) => client.visibilityState === 'visible' && client.focused,
      );

      if (data.badge && self.navigator.setAppBadge) {
        try {
          await self.navigator.setAppBadge(data.badge);
        } catch {
          // ignore
        }
      }

      if (appVisible) return;

      const title = data.title || 'Ямщик';
      const options = {
        body: data.body || 'Новое сообщение',
        icon: '/icon-192.png',
        badge: '/icon-192.png',
        tag: data.chatId ? `chat-${data.chatId}` : 'coachman-message',
        renotify: true,
        data: { chatId: data.chatId || null },
      };

      await self.registration.showNotification(title, options);
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
