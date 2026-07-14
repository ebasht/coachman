const PENDING_CALL_CACHE = 'coachman-pending-call';
const PENDING_CALL_URL = '/__coachman_pending_call';

async function savePendingCallInCache(data) {
  if (!data.chatId || !data.callId) return;
  try {
    const cache = await caches.open(PENDING_CALL_CACHE);
    await cache.put(
      PENDING_CALL_URL,
      new Response(
        JSON.stringify({
          chatId: data.chatId,
          callId: data.callId,
          fromUserId: data.fromUserId || undefined,
          savedAt: Date.now(),
        }),
        { headers: { 'Content-Type': 'application/json' } },
      ),
    );
  } catch {
    // ignore
  }
}

async function clearPendingCallInCache(callId) {
  try {
    const cache = await caches.open(PENDING_CALL_CACHE);
    if (!callId) {
      await cache.delete(PENDING_CALL_URL);
      return;
    }
    const res = await cache.match(PENDING_CALL_URL);
    if (!res) return;
    const parsed = await res.json();
    if (!parsed?.callId || parsed.callId === callId) {
      await cache.delete(PENDING_CALL_URL);
    }
  } catch {
    // ignore
  }
}

async function closeCallNotifications(callId, chatId) {
  try {
    const tags = new Set();
    if (callId) tags.add(`call-${callId}`);
    if (chatId) tags.add(`call-${chatId}`);
    tags.add('call-ring');
    for (const tag of tags) {
      const notes = await self.registration.getNotifications({ tag });
      for (const n of notes) n.close();
    }
    if (callId) {
      const all = await self.registration.getNotifications();
      for (const n of all) {
        const d = n.data || {};
        if (d.callId === callId || (d.type === 'incoming-call' && (!d.callId || d.callId === callId))) {
          n.close();
        }
      }
    }
  } catch {
    // ignore
  }
}

function buildCallLaunchUrl(nData, action) {
  const targetPath = nData.chatId ? `/c/${encodeURIComponent(nData.chatId)}` : '/';
  const url = new URL(targetPath, self.location.origin);
  if (nData.callId) {
    url.searchParams.set('call', nData.callId);
    if (nData.fromUserId) url.searchParams.set('from', nData.fromUserId);
    if (action === 'accept') url.searchParams.set('callAction', 'accept');
    if (action === 'decline') url.searchParams.set('callAction', 'decline');
  }
  return url.href;
}

function postIncomingCall(client, nData, extras) {
  client.postMessage({
    type: 'incoming-call',
    chatId: nData.chatId || null,
    callId: nData.callId || null,
    fromUserId: nData.fromUserId || null,
    ...extras,
  });
}

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }

  const pushType = data.type || 'message';
  const isCall = pushType === 'incoming-call';
  const isCallEnded = pushType === 'call-ended';
  const title = data.title || (isCall ? 'Входящий звонок' : 'Ямщик');
  const tag =
    isCall || isCallEnded
      ? `call-${data.callId || data.chatId || 'ring'}`
      : data.chatId
        ? `chat-${data.chatId}`
        : 'coachman-message';

  const notifData = {
    chatId: data.chatId || null,
    callId: data.callId || null,
    fromUserId: data.fromUserId || null,
    type: pushType,
  };

  if (isCallEnded) {
    event.waitUntil(
      (async () => {
        await clearPendingCallInCache(notifData.callId);
        await closeCallNotifications(notifData.callId, notifData.chatId);
        const windowClients = await self.clients.matchAll({
          type: 'window',
          includeUncontrolled: true,
        });
        for (const client of windowClients) {
          client.postMessage({
            type: 'call-ended',
            chatId: notifData.chatId,
            callId: notifData.callId,
            fromUserId: notifData.fromUserId,
          });
        }
        await self.registration.showNotification(title, {
          body: data.body || 'Входящий вызов отменён',
          icon: '/app-icon-192.png',
          badge: '/app-icon-192.png',
          tag,
          renotify: false,
          requireInteraction: false,
          silent: true,
          data: notifData,
        });
        const shown = await self.registration.getNotifications({ tag });
        for (const n of shown) n.close();
      })(),
    );
    return;
  }

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

      if (isCall) {
        await savePendingCallInCache(notifData);
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

self.addEventListener('notificationclick', (event) => {
  const nData = event.notification.data || {};
  const chatId = nData.chatId;
  const isCall = nData.type === 'incoming-call';
  const action = event.action;
  event.notification.close();

  if (nData.type === 'call-ended') {
    return;
  }

  const extras = {};
  if (isCall && action === 'accept') extras.autoAccept = true;
  if (isCall && action === 'decline') extras.autoReject = true;

  const launchUrl = isCall
    ? buildCallLaunchUrl(nData, action)
    : new URL(chatId ? `/c/${encodeURIComponent(chatId)}` : '/', self.location.origin).href;

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

      if (isCall) {
        if (action !== 'decline') {
          await savePendingCallInCache(nData);
        } else {
          await clearPendingCallInCache(nData.callId);
        }
      }

      const windowClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of windowClients) {
        if (!('focus' in client)) continue;

        if (isCall) {
          if ('navigate' in client) {
            try {
              const navigated = await client.navigate(launchUrl);
              if (navigated) {
                await navigated.focus();
                return;
              }
            } catch {
              // fall through
            }
          }
          postIncomingCall(client, nData, extras);
          await client.focus();
          return;
        }

        client.postMessage({ type: 'open-chat', chatId: chatId || null });
        await client.focus();
        return;
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(launchUrl);
      }
    })(),
  );
});
