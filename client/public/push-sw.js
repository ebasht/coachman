self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }

  const isCall = data.type === 'incoming-call';
  const title = data.title || (isCall ? 'Входящий звонок' : 'Ямщик');
  const tag = isCall
    ? `call-${data.callId || data.chatId || 'ring'}`
    : data.chatId
      ? `chat-${data.chatId}`
      : 'coachman-message';

  const notifData = {
    chatId: data.chatId || null,
    callId: data.callId || null,
    fromUserId: data.fromUserId || null,
    type: data.type || 'message',
  };

  const options = {
    body: data.body || (isCall ? 'Видеозвонок' : 'Новое сообщение'),
    icon: '/app-icon-192.png',
    badge: '/app-icon-192.png',
    tag,
    renotify: true,
    requireInteraction: isCall,
    data: notifData,
  };
  if (isCall) {
    options.vibrate = [400, 200, 400, 200, 400, 800];
    options.actions = [
      { action: 'accept', title: 'Принять' },
      { action: 'decline', title: 'Отклонить' },
    ];
  }

  const badgeCount = typeof data.badge === 'number' && data.badge > 0 ? data.badge : 1;

  event.waitUntil(
    (async () => {
      const windowClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      let hasFocused = false;
      for (const client of windowClients) {
        if (client.focused) hasFocused = true;
      }

      // Focused app gets the invite over WebSocket — do not also postMessage
      // (duplicate invite used to auto-reject the call).
      if (isCall && hasFocused) {
        return;
      }

      // Backgrounded tab/PWA: wake UI via postMessage (WS may be paused on mobile).
      if (isCall) {
        for (const client of windowClients) {
          client.postMessage({
            type: 'incoming-call',
            chatId: notifData.chatId,
            callId: notifData.callId,
            fromUserId: notifData.fromUserId,
          });
        }
      }

      await self.registration.showNotification(title, options);
      if (!isCall) {
        const nav = self.navigator || navigator;
        if (nav.setAppBadge) {
          try {
            await nav.setAppBadge(badgeCount > 99 ? '99+' : badgeCount);
          } catch {
            // ignore
          }
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

function postIncomingCall(client, nData, extras) {
  client.postMessage({
    type: 'incoming-call',
    chatId: nData.chatId || null,
    callId: nData.callId || null,
    fromUserId: nData.fromUserId || null,
    ...extras,
  });
}

self.addEventListener('notificationclick', (event) => {
  const nData = event.notification.data || {};
  const chatId = nData.chatId;
  const isCall = nData.type === 'incoming-call';
  const action = event.action; // '' | 'accept' | 'decline'
  event.notification.close();

  const targetPath = chatId ? `/c/${encodeURIComponent(chatId)}` : '/';
  const targetUrl = new URL(targetPath, self.location.origin).href;

  const extras = {};
  if (isCall && action === 'accept') extras.autoAccept = true;
  if (isCall && action === 'decline') extras.autoReject = true;

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
        if (isCall) {
          postIncomingCall(client, nData, extras);
        } else {
          client.postMessage({ type: 'open-chat', chatId: chatId || null });
        }
        if ('focus' in client) {
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        const url = new URL(targetUrl);
        if (isCall && nData.callId) {
          url.searchParams.set('call', nData.callId);
          if (nData.fromUserId) url.searchParams.set('from', nData.fromUserId);
          if (action === 'accept') url.searchParams.set('callAction', 'accept');
          if (action === 'decline') url.searchParams.set('callAction', 'decline');
        }
        return self.clients.openWindow(url.href);
      }
    })(),
  );
});
