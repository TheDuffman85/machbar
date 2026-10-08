import { chromium, expect, test, type Page, type Worker } from '@playwright/test';
import { localEntry, readSnapshot } from './helpers.js';

const base = 'http://localhost:3100';
const bindingId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const publicKey = 'B' + 'A'.repeat(86);
// Full Chromium supports notifications; headless-shell can deny them even
// after granting permissions through the browser automation protocol.
test.use({
  launchOptions: {
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ?? chromium.executablePath(),
  },
});
test.beforeEach(async ({ request }) => {
  await request.post(`${base}/test/reset`, { headers: { origin: base } });
});
async function ready(page: Page) {
  await page.goto('/');
  await page.getByLabel('What should we call you?').fill('Reminder friend');
  await page.getByRole('button', { name: 'Let’s begin' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await readSnapshot(page);
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
}
async function deliver(worker: Worker, data: unknown) {
  return worker.evaluate(async (data) => {
    const scope = globalThis as unknown as {
      PushEvent: new (type: string, init: { data: string }) => Event;
      dispatchEvent: (event: Event) => void;
      registration: ServiceWorkerRegistration;
    };
    const event = new scope.PushEvent('push', { data: JSON.stringify(data) });
    let work: Promise<unknown> = Promise.resolve();
    Object.defineProperty(event, 'waitUntil', {
      value: (task: Promise<unknown>) => {
        work = task;
      },
    });
    scope.dispatchEvent(event);
    await work;
    return (await scope.registration.getNotifications()).map((n) => ({
      body: n.body,
      tag: n.tag,
      icon: n.icon,
      badge: n.badge,
      data: n.data,
    }));
  }, data);
}

test('optional habit reminders save offline, survive reload, and sync', async ({
  page,
  context,
}) => {
  await ready(page);
  await context.setOffline(true);
  await page.goto('/habits');
  await page.getByRole('button', { name: 'Add a habit', exact: true }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Name', { exact: true }).fill('Offline reading reminder');
  await dialog.getByRole('checkbox', { name: 'Remind me about this habit', exact: true }).check();
  await dialog.getByLabel('Reminder time', { exact: true }).fill('18:30');
  await dialog.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect((await localEntry(page)).snapshot.document.habits[0]!.reminderTime).toBe('18:30');
  await page.reload();
  await page.getByRole('button', { name: 'Edit Offline reading reminder', exact: true }).click();
  await expect(dialog.getByLabel('Reminder time', { exact: true })).toHaveValue('18:30');
  await dialog.getByLabel('Reminder time', { exact: true }).fill('19:15');
  await dialog.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await context.setOffline(false);
  expect((await readSnapshot(page)).document.habits[0]!.reminderTime).toBe('19:15');
  await page.getByRole('button', { name: 'Edit Offline reading reminder', exact: true }).click();
  await dialog.getByRole('checkbox', { name: 'Remind me about this habit', exact: true }).uncheck();
  await dialog.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect((await readSnapshot(page)).document.habits[0]!.reminderTime).toBeNull();
});

test('settings explain unavailable server configuration without prompting permission', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const scope = window as Window & { notificationPermissionRequests?: number };
    scope.notificationPermissionRequests = 0;
    const original = Notification.requestPermission.bind(Notification);
    Notification.requestPermission = () => {
      scope.notificationPermissionRequests!++;
      return original();
    };
  });
  await ready(page);
  await page.goto('/settings');
  await expect(page.getByRole('heading', { name: 'Notifications', exact: true })).toBeVisible();
  await expect(page.getByText('Notifications are unavailable.', { exact: false })).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Enable notifications', exact: true }),
  ).toBeDisabled();
  expect(
    await page.evaluate(
      () =>
        (window as Window & { notificationPermissionRequests?: number })
          .notificationPermissionRequests,
    ),
  ).toBe(0);
});

test('device opt-in uses the installed worker, displays push content offline, and clears on profile switch', async ({
  page,
  context,
  request,
}) => {
  await context.grantPermissions(['notifications'], { origin: base });
  // Browser push enrollment and server transport are mocked; the built worker,
  // IndexedDB state, UI, notification display, and identity switch are real.
  await page.addInitScript((publicKey) => {
    let subscribed = false;
    const subscription = {
      endpoint: 'https://push.example.com/browser-test',
      options: {},
      unsubscribe: async () => {
        subscribed = false;
        return true;
      },
      toJSON: () => ({
        endpoint: 'https://push.example.com/browser-test',
        keys: { p256dh: publicKey, auth: 'AAAAAAAAAAAAAAAAAAAAAA' },
      }),
    };
    PushManager.prototype.getSubscription = async () =>
      subscribed ? (subscription as unknown as PushSubscription) : null;
    PushManager.prototype.subscribe = async () => {
      subscribed = true;
      return subscription as unknown as PushSubscription;
    };
  }, publicKey);
  await page.route('**/api/notifications/config', (route) =>
    route.fulfill({ json: { available: true, publicKey } }),
  );
  const removed: string[] = [];
  await page.route('**/api/notifications/subscription', (route) => {
    if (route.request().method() === 'DELETE')
      removed.push(route.request().headers()['x-machbar-user']!);
    return route.fulfill({
      json: route.request().method() === 'PUT' ? { bindingId } : { ok: true },
    });
  });
  await ready(page);
  const alice = (await readSnapshot(page)).document.userId;
  await page.goto('/settings');
  await page.getByRole('button', { name: 'Enable notifications', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Disable notifications', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Send test notification', exact: true }),
  ).toBeEnabled();
  const worker = context.serviceWorkers()[0]!;
  const payload = {
    version: 1,
    bindingId,
    title: 'Machbar',
    body: 'Time for a small win: Read',
    tag: `${bindingId}:read:2026-10-07`,
    expiresAt: Date.now() + 60_000,
  };
  await context.setOffline(true);
  // The installed worker must serve notification artwork from its offline cache.
  expect(
    await page.evaluate(async () => {
      return Promise.all(
        ['/pwa-192.png', '/notification-badge.png'].map(async (path) => {
          const response = await fetch(path);
          return { ok: response.ok, type: response.headers.get('content-type') };
        }),
      );
    }),
  ).toEqual([
    { ok: true, type: 'image/png' },
    { ok: true, type: 'image/png' },
  ]);
  expect(await deliver(worker, payload)).toMatchObject([
    {
      body: payload.body,
      icon: `${base}/pwa-192.png`,
      badge: `${base}/notification-badge.png`,
      data: { bindingId },
    },
  ]);
  // Repeated deliveries replace the same visible notification.
  expect(await deliver(worker, payload)).toHaveLength(1);
  expect(
    await deliver(worker, {
      ...payload,
      bindingId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      tag: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:wrong',
    }),
  ).toHaveLength(1);
  expect(
    await deliver(worker, { ...payload, tag: `${bindingId}:expired`, expiresAt: Date.now() - 1 }),
  ).toHaveLength(1);
  await context.setOffline(false);
  // Clicks use a fixed local route; no profile ID or supplied URL becomes navigation.
  expect(
    await worker.evaluate(async () => {
      const scope = globalThis as unknown as {
        registration: ServiceWorkerRegistration;
        location: { origin: string };
        NotificationEvent: new (type: string, init: { notification: Notification }) => Event;
        dispatchEvent: (event: Event) => void;
        clients: { matchAll: (...args: unknown[]) => Promise<unknown[]> };
      };
      const original = scope.clients.matchAll;
      const navigations: string[] = [];
      scope.clients.matchAll = async () => [
        {
          url: scope.location.origin + '/habits',
          navigate: async (path: string) => {
            navigations.push(path);
          },
          focus: async () => {},
        },
      ];
      try {
        const notification = (await scope.registration.getNotifications())[0]!;
        const event = new scope.NotificationEvent('notificationclick', { notification });
        let work: Promise<unknown> = Promise.resolve();
        Object.defineProperty(event, 'waitUntil', {
          value: (task: Promise<unknown>) => {
            work = task;
          },
        });
        scope.dispatchEvent(event);
        await work;
        return navigations;
      } finally {
        scope.clients.matchAll = original;
      }
    }),
  ).toEqual(['/']);
  await deliver(worker, { ...payload, tag: `${bindingId}:second` });
  const bob = crypto.randomUUID();
  const doc = structuredClone((await readSnapshot(page)).document);
  doc.userId = bob;
  doc.revision = 0;
  doc.preferences.name = 'Bob';
  await request.post(`${base}/test/seed`, { headers: { origin: base }, data: doc });
  await page.getByRole('button', { name: 'Profile menu', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Switch User', exact: true }).click();
  await page.getByLabel('Existing user ID').fill(bob);
  await page.getByRole('button', { name: 'Switch profile', exact: true }).click();
  await expect.poll(() => page.evaluate(() => localStorage.getItem('machbar-user-id'))).toBe(bob);
  expect(removed).toContain(alice);
  expect(await deliver(worker, payload)).toEqual([]);
  await page.goto('/settings');
  await expect(
    page.getByRole('button', { name: 'Enable notifications', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Disable notifications', exact: true }),
  ).toHaveCount(0);
  await page.screenshot({
    path: `test-results/notifications-${test.info().project.name}.png`,
    fullPage: true,
  });
});
