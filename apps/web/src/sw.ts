/// <reference lib="webworker" />
import { clientsClaim } from 'workbox-core';
import {
  cleanupOutdatedCaches,
  createHandlerBoundToURL,
  precacheAndRoute,
} from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';
import { deviceNotifications } from './notificationState';
import { parseNotificationPayload } from './notificationPayload';
declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<{ url: string; revision: string | null }>;
};
precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();
clientsClaim();
registerRoute(
  new NavigationRoute(createHandlerBoundToURL('/index.html'), {
    denylist: [/^\/api\//, /^\/auth\//, /^\/health/, /^\/admin([/?]|$)/],
  }),
);
self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
  if (event.data?.type === 'NOTIFICATION_VERSION')
    event.ports[0]?.postMessage({ notificationVersion: 1 });
});
self.addEventListener('push', (event) => {
  event.waitUntil(
    (async () => {
      let data: unknown;
      try {
        data = event.data?.json();
      } catch {
        return;
      }
      const payload = parseNotificationPayload(data);
      if (!payload || payload.expiresAt <= Date.now()) return;
      const state = await deviceNotifications();
      if (state.active?.bindingId !== payload.bindingId) return;
      await self.registration.showNotification(payload.title, {
        body: payload.body,
        tag: payload.tag,
        icon: '/pwa-192.png',
        badge: '/notification-badge.png',
        data: { bindingId: payload.bindingId },
      });
    })(),
  );
});
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      const state = await deviceNotifications();
      if (!state.active || state.active.bindingId !== event.notification.data?.bindingId) return;
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const client = windows.find((window) => new URL(window.url).origin === self.location.origin);
      if (client) {
        await client.navigate('/');
        await client.focus();
      } else await self.clients.openWindow('/');
    })(),
  );
});
