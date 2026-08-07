/// <reference lib="webworker" />
/**
 * Single-file service worker (no importScripts).
 * iOS Safari often fails offline cold-start when workbox/push logic lives in
 * separate scripts loaded via importScripts.
 */
import { clientsClaim } from 'workbox-core';
import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';
import { CacheFirst, NetworkFirst } from 'workbox-strategies';
import { ExpirationPlugin } from 'workbox-expiration';
import { prefetchChatInBackground, runQueuedBackgroundPrefetch } from './lib/background-prefetch';
import { enqueueBackgroundSyncChats } from './lib/storage';

declare let self: ServiceWorkerGlobalScope;

self.skipWaiting();
clientsClaim();

precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

registerRoute(
  new NavigationRoute(createHandlerBoundToURL('/index.html'), {
    denylist: [/^\/api\//, /^\/ws/, /^\/health$/, /^\/runtime-config\.js$/, /^\/share-target$/],
  }),
);

registerRoute(
  /\/(assets\/|app-icon|manifest\.webmanifest)/,
  new CacheFirst({
    cacheName: 'app-shell-assets',
    plugins: [new ExpirationPlugin({ maxEntries: 64, maxAgeSeconds: 60 * 60 * 24 * 90 })],
  }),
);

registerRoute(
  /\/runtime-config\.js$/i,
  new NetworkFirst({
    cacheName: 'runtime-config',
    networkTimeoutSeconds: 2,
    plugins: [new ExpirationPlugin({ maxEntries: 1, maxAgeSeconds: 60 * 60 * 24 * 7 })],
  }),
);

// —— Push / notification handlers (formerly public/push-sw.js) ——

const PENDING_CALL_CACHE = 'coachman-pending-call';
const PENDING_CALL_URL = '/__coachman_pending_call';
const PENDING_SHARE_CACHE = 'coachman-pending-share';
const PENDING_SHARE_META = '/__coachman_pending_share/meta';
const pendingShareFileUrl = (i: number) => `/__coachman_pending_share/file/${i}`;

async function handleShareTarget(request: Request): Promise<Response> {
  try {
    const form = await request.formData();
    const title = String(form.get('title') || '');
    const text = String(form.get('text') || '');
    const rawFiles = form.getAll('photos');
    const files: File[] = [];
    for (const entry of rawFiles) {
      if (entry instanceof File && entry.size > 0) files.push(entry);
    }
    // Some share sheets send a single file under other names.
    if (!files.length) {
      for (const [, value] of form.entries()) {
        if (value instanceof File && value.size > 0 && value.type.startsWith('image/')) {
          files.push(value);
        }
      }
    }

    await caches.delete(PENDING_SHARE_CACHE);
    if (files.length) {
      const cache = await caches.open(PENDING_SHARE_CACHE);
      const meta = {
        count: files.length,
        title: title || undefined,
        text: text || undefined,
        savedAt: Date.now(),
        files: files.map((f) => ({
          name: f.name || 'photo.jpg',
          type: f.type || 'image/jpeg',
        })),
      };
      await cache.put(
        PENDING_SHARE_META,
        new Response(JSON.stringify(meta), {
          headers: { 'Content-Type': 'application/json' },
        }),
      );
      for (let i = 0; i < files.length; i++) {
        await cache.put(
          pendingShareFileUrl(i),
          new Response(files[i], {
            headers: {
              'Content-Type': files[i].type || 'application/octet-stream',
              'X-Filename': encodeURIComponent(files[i].name || `photo-${i + 1}.jpg`),
            },
          }),
        );
      }
    }

    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of clients) {
      client.postMessage({ type: 'share-target', count: files.length });
    }
  } catch (err) {
    console.warn('share-target failed', err);
  }

  return Response.redirect(new URL('/?share=1', self.location.origin).href, 303);
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method === 'POST' && url.pathname === '/share-target') {
    event.respondWith(handleShareTarget(event.request));
  }
});

async function savePendingCallInCache(data: {
  chatId?: string | null;
  callId?: string | null;
  fromUserId?: string | null;
}) {
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

async function clearPendingCallInCache(callId?: string | null) {
  try {
    const cache = await caches.open(PENDING_CALL_CACHE);
    if (!callId) {
      await cache.delete(PENDING_CALL_URL);
      return;
    }
    const res = await cache.match(PENDING_CALL_URL);
    if (!res) return;
    const parsed = (await res.json()) as { callId?: string };
    if (!parsed?.callId || parsed.callId === callId) {
      await cache.delete(PENDING_CALL_URL);
    }
  } catch {
    // ignore
  }
}

async function closeCallNotifications(callId?: string | null, chatId?: string | null) {
  try {
    const tags = new Set<string>();
    if (callId) tags.add(`call-${callId}`);
    if (chatId) tags.add(`call-${chatId}`);
    tags.add('call-ring');
    for (const tag of tags) {
      const notes = await self.registration.getNotifications({ tag });
      for (const n of notes) n.close();
    }
    // Also close any call notifications whose data matches (some platforms ignore tag filter).
    if (callId) {
      const all = await self.registration.getNotifications();
      for (const n of all) {
        const d = (n.data || {}) as { callId?: string; type?: string };
        if (d.callId === callId || d.type === 'incoming-call') {
          if (!d.callId || d.callId === callId) n.close();
        }
      }
    }
  } catch {
    // ignore
  }
}

/** Dismiss story push trays when the user opens Coachman. */
async function closeStoryNotifications() {
  try {
    const all = await self.registration.getNotifications();
    for (const n of all) {
      const data = (n.data || {}) as { type?: string };
      if (data.type === 'story' || (typeof n.tag === 'string' && n.tag.startsWith('story-'))) {
        n.close();
      }
    }
  } catch {
    // ignore
  }
}

function buildCallLaunchUrl(
  nData: { chatId?: string | null; callId?: string | null; fromUserId?: string | null },
  action: string,
): string {
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

self.addEventListener('push', (event) => {
  let data: Record<string, unknown> = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }

  const pushType = typeof data.type === 'string' ? data.type : 'message';
  const isCall = pushType === 'incoming-call';
  const isCallEnded = pushType === 'call-ended';
  const isBadgeOnly = pushType === 'badge';
  const isStory = pushType === 'story';
  const title =
    (typeof data.title === 'string' && data.title) || (isCall ? 'Входящий звонок' : 'Ямщик');
  const chatId = typeof data.chatId === 'string' ? data.chatId : null;
  const callId = typeof data.callId === 'string' ? data.callId : null;
  const fromUserId = typeof data.fromUserId === 'string' ? data.fromUserId : null;
  const storyId = typeof data.storyId === 'string' ? data.storyId : null;
  const tag = isCall || isCallEnded
    ? `call-${callId || chatId || 'ring'}`
    : isStory
      ? `story-${fromUserId || storyId || 'new'}`
      : chatId
        ? `chat-${chatId}`
        : 'coachman-message';

  if (isStory) {
    event.waitUntil(
      (async () => {
        const windowClients = await self.clients.matchAll({
          type: 'window',
          includeUncontrolled: true,
        });
        let hasFocused = false;
        for (const client of windowClients) {
          client.postMessage({
            type: 'story-push',
            storyId,
            fromUserId,
          });
          if (client.focused) hasFocused = true;
        }
        // App already open — refresh the rail, skip tray noise.
        if (hasFocused) return;
        await self.registration.showNotification(title, {
          body: (typeof data.body === 'string' && data.body) || 'Новая история',
          icon: '/app-icon-192.png',
          badge: '/app-icon-192.png',
          tag,
          renotify: true,
          data: { type: 'story', storyId, fromUserId },
        } as NotificationOptions);
      })(),
    );
    return;
  }

  if (isBadgeOnly) {
    // Safety net: iOS revokes the push subscription if a push event never calls
    // showNotification. Prefer not sending badge-only Web Push from the server;
    // if one arrives anyway, show a silent notification so the endpoint survives.
    const badgeCount =
      typeof data.badge === 'number' && data.badge > 0
        ? data.badge
        : typeof data.badge === 'string' && Number(data.badge) > 0
          ? Number(data.badge)
          : 1;
    event.waitUntil(
      (async () => {
        const windowClients = await self.clients.matchAll({
          type: 'window',
          includeUncontrolled: true,
        });
        for (const client of windowClients) {
          client.postMessage({
            type: 'chat-activity',
            chatId,
            badge: badgeCount,
          });
        }
        const nav = self.navigator as Navigator & {
          setAppBadge?: (n?: number | string) => Promise<void>;
        };
        if (nav.setAppBadge) {
          try {
            await nav.setAppBadge(badgeCount > 99 ? 99 : badgeCount);
          } catch {
            // ignore
          }
        }
        // Still pull messages/photos for the chat when the OS only sent a badge bump.
        const prefetchPromise = chatId
          ? prefetchChatInBackground(chatId)
              .then(async () => {
                await enqueueBackgroundSyncChats([chatId]);
                for (const client of windowClients) {
                  client.postMessage({ type: 'prefetch-ready', chatId });
                }
              })
              .catch((err) => {
                console.warn('badge background prefetch failed', err);
              })
          : Promise.resolve();
        await Promise.all([
          self.registration.showNotification('Ямщик', {
            body: 'Есть обновления',
            tag: chatId ? `badge-${chatId}` : 'coachman-badge',
            silent: true,
            data: { chatId, type: 'badge' },
          } as NotificationOptions),
          prefetchPromise,
        ]);
      })(),
    );
    return;
  }

  if (isCallEnded) {
    event.waitUntil(
      (async () => {
        await clearPendingCallInCache(callId);
        await closeCallNotifications(callId, chatId);
        const windowClients = await self.clients.matchAll({
          type: 'window',
          includeUncontrolled: true,
        });
        for (const client of windowClients) {
          client.postMessage({
            type: 'call-ended',
            chatId,
            callId,
            fromUserId,
          });
        }
        // Replace ringing notification briefly, then dismiss — avoids stuck OS banner.
        await self.registration.showNotification(title, {
          body: (typeof data.body === 'string' && data.body) || 'Входящий вызов отменён',
          icon: '/app-icon-192.png',
          badge: '/app-icon-192.png',
          tag,
          requireInteraction: false,
          silent: true,
          data: { chatId, callId, fromUserId, type: 'call-ended' },
        } as NotificationOptions);
        const shown = await self.registration.getNotifications({ tag });
        for (const n of shown) n.close();
      })(),
    );
    return;
  }

  const notifData = {
    chatId,
    callId,
    fromUserId,
    type: pushType,
  };

  const options: NotificationOptions & {
    renotify?: boolean;
    vibrate?: number[];
    actions?: { action: string; title: string }[];
  } = {
    body:
      (typeof data.body === 'string' && data.body) || (isCall ? 'Видеозвонок' : 'Новое сообщение'),
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

  const badgeCount =
    typeof data.badge === 'number' && data.badge > 0 ? data.badge : 1;

  event.waitUntil(
    (async () => {
      const windowClients = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      });
      let hasFocused = false;
      for (const client of windowClients) {
        if (client.focused) hasFocused = true;
      }

      if (isCall && hasFocused) {
        return;
      }

      if (isCall) {
        // Survives app kill so opening via icon (not notification) still restores the ring UI.
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

      // Wake open clients so they can pull history (WS is closed while backgrounded).
      if (!isCall && chatId) {
        for (const client of windowClients) {
          client.postMessage({
            type: 'message-push',
            chatId,
            badge: badgeCount,
          });
        }
      }

      // Prefetch messages + photos into IndexedDB while the push handler is alive,
      // so opening the app from the badge already has content locally.
      // Always enqueue the chat id — even if prefetch fails — so foreground sync retries.
      const prefetchPromise =
        !isCall && chatId
          ? enqueueBackgroundSyncChats([chatId])
              .catch(() => undefined)
              .then(() =>
                prefetchChatInBackground(chatId).catch((err) => {
                  console.warn('background prefetch failed', err);
                  return 0;
                }),
              )
          : Promise.resolve(0);

      await Promise.all([
        self.registration.showNotification(title, options),
        prefetchPromise,
      ]);

      if (!isCall) {
        const nav = self.navigator as Navigator & {
          setAppBadge?: (n?: number | string) => Promise<void>;
        };
        if (nav.setAppBadge) {
          try {
            await nav.setAppBadge(badgeCount > 99 ? 99 : badgeCount);
          } catch {
            // ignore
          }
        }
        // Tell clients prefetch finished so they can decrypt without another round-trip.
        if (chatId) {
          for (const client of windowClients) {
            client.postMessage({ type: 'prefetch-ready', chatId });
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

// Continue message/photo downloads when the browser grants a Background Sync slot.
self.addEventListener('sync', ((event: Event) => {
  const syncEvent = event as ExtendableEvent & { tag?: string };
  if (syncEvent.tag !== 'coachman-prefetch') return;
  syncEvent.waitUntil(
    runQueuedBackgroundPrefetch().catch((err) => {
      console.warn('background sync prefetch failed', err);
    }),
  );
}) as EventListener);

function postIncomingCall(
  client: Client,
  nData: { chatId?: string | null; callId?: string | null; fromUserId?: string | null },
  extras: Record<string, unknown>,
) {
  client.postMessage({
    type: 'incoming-call',
    chatId: nData.chatId || null,
    callId: nData.callId || null,
    fromUserId: nData.fromUserId || null,
    ...extras,
  });
}

self.addEventListener('notificationclick', (event) => {
  const nData = (event.notification.data || {}) as {
    chatId?: string | null;
    callId?: string | null;
    fromUserId?: string | null;
    type?: string;
  };
  const chatId = nData.chatId;
  const isCall = nData.type === 'incoming-call';
  const isStory = nData.type === 'story';
  const action = event.action;
  event.notification.close();

  const extras: Record<string, unknown> = {};
  if (isCall && action === 'accept') extras.autoAccept = true;
  if (isCall && action === 'decline') extras.autoReject = true;

  const launchUrl = isCall
    ? buildCallLaunchUrl(nData, action)
    : new URL(chatId && !isStory ? `/c/${encodeURIComponent(chatId)}` : '/', self.location.origin).href;

  event.waitUntil(
    (async () => {
      const nav = self.navigator as Navigator & { clearAppBadge?: () => Promise<void> };
      if (nav.clearAppBadge) {
        try {
          await nav.clearAppBadge();
        } catch {
          // ignore
        }
      }

      if (isCall) {
        // Keep invite for accept / notification body open — not for decline.
        if (action !== 'decline') {
          await savePendingCallInCache(nData);
        } else {
          try {
            const cache = await caches.open(PENDING_CALL_CACHE);
            await cache.delete(PENDING_CALL_URL);
          } catch {
            // ignore
          }
        }
      }

      const windowClients = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      });

      for (const client of windowClients) {
        if (!('focus' in client)) continue;
        const windowClient = client as WindowClient;

        if (isCall) {
          // navigate() reloads discarded/frozen Android tabs with ?call= so the ring UI can mount.
          if ('navigate' in windowClient) {
            try {
              const navigated = await windowClient.navigate(launchUrl);
              if (navigated) {
                await navigated.focus();
                return;
              }
            } catch {
              // fall through to postMessage + focus
            }
          }
          postIncomingCall(windowClient, nData, extras);
          await windowClient.focus();
          return;
        }

        if (isStory) {
          windowClient.postMessage({
            type: 'story-push',
            fromUserId: nData.fromUserId || null,
          });
          await windowClient.focus();
          return;
        }

        windowClient.postMessage({ type: 'open-chat', chatId: chatId || null });
        await windowClient.focus();
        return;
      }

      if (self.clients.openWindow) {
        return self.clients.openWindow(launchUrl);
      }
    })(),
  );
});

self.addEventListener('message', (event) => {
  const data = event.data as { type?: string } | undefined;
  if (data?.type === 'clear-story-notifications') {
    event.waitUntil(closeStoryNotifications());
  }
});
