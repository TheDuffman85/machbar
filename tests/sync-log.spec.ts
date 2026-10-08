import { expect, test, type Page } from '@playwright/test';
import { localEntry, readSnapshot } from './helpers.js';
import type { SyncOperation } from '../apps/web/src/cache.js';

async function storedLog(page: Page) {
  return page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('machbar');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise<SyncOperation[]>((resolve, reject) => {
        const request = database
          .transaction('syncLog')
          .objectStore('syncLog')
          .get(localStorage.getItem('machbar-user-id')!);
        request.onsuccess = () => resolve(request.result ?? []);
        request.onerror = () => reject(request.error);
      });
    } finally {
      database.close();
    }
  });
}

test.beforeEach(async ({ request, page }) => {
  await request.post('/api/test/reset', {
    headers: {
      origin: 'http://localhost:3100',
      'X-Machbar-User': '00000000-0000-4000-8000-000000000001',
    },
  });
  await page.goto('/');
  await page.getByLabel('What should we call you?').fill('Sync friend');
  await page.getByRole('button', { name: 'Let’s begin' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await readSnapshot(page);
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await expect.poll(async () => (await storedLog(page)).some((op) => op.uploaded)).toBe(true);
});

test('fast saves stay silent and slow background sync appears only after 2.5 seconds', async ({
  page,
}) => {
  await page.goto('/settings');
  await readSnapshot(page);
  await page.clock.install();
  await page.evaluate(() => {
    const messages: string[] = [];
    Object.assign(window, { syncMessages: messages });
    new MutationObserver(() => {
      const notice = document.querySelector('.notifications .notice');
      if (notice) messages.push(notice.textContent ?? '');
    }).observe(document.querySelector('.notifications')!, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  });
  await page.getByRole('button', { name: 'Dark', exact: true }).click();
  await readSnapshot(page);
  expect(
    await page.evaluate(() => (window as typeof window & { syncMessages: string[] }).syncMessages),
  ).toEqual([]);

  let release!: () => void;
  let reached = false;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/sync', async (route) => {
    reached = true;
    await held;
    await route.continue();
  });
  try {
    await page.getByRole('button', { name: 'Light', exact: true }).click();
    await expect.poll(() => reached).toBe(true);
    expect((await localEntry(page)).snapshot.document.preferences.theme).toBe('light');
    await expect(page.locator('.notifications .notice')).toHaveCount(0);
    await page.clock.fastForward(2_000);
    await expect(page.locator('.notifications .notice')).toHaveCount(0);
    await page.clock.fastForward(500);
    await expect(
      page.locator('.notifications').getByText('Syncing your changes…', { exact: true }),
    ).toBeVisible();
    release();
    await readSnapshot(page);
    await expect(page.locator('.notifications .notice')).toHaveCount(0);
  } finally {
    release();
  }
});

test('the sync log keeps 50 operations, records failures and recovery, and works offline', async ({
  page,
  context,
}) => {
  await page.goto('/settings');
  await page.getByRole('link', { name: 'View sync log', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Sync log', exact: true })).toBeVisible();
  await expect(page.locator('.sync-log-operation').first()).toContainText('Synced');
  await expect(page.getByRole('button', { name: 'Sync now', exact: true })).toBeEnabled();
  const existing = (await storedLog(page))[0]!;
  await page.evaluate(async (operation) => {
    const database = await new Promise<IDBDatabase>((resolve) => {
      const request = indexedDB.open('machbar');
      request.onsuccess = () => resolve(request.result);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = database.transaction('syncLog', 'readwrite');
        tx.objectStore('syncLog').put(
          Array.from({ length: 49 }, (_, i) => ({ ...operation, id: `seed-${i}` })),
          localStorage.getItem('machbar-user-id')!,
        );
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error);
      });
    } finally {
      database.close();
    }
  }, existing);
  await page.clock.install();
  let requests = 0;
  await page.route('**/api/bootstrap', (route) => {
    requests++;
    return route.fulfill({ status: 503, json: { code: 'INTERNAL_ERROR' } });
  });
  await page.getByRole('button', { name: 'Sync now', exact: true }).click();
  await expect(page.locator('.sync-log-operation')).toHaveCount(50);
  await expect(page.locator('.sync-log-operation').first()).toContainText('Sync failed');
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  expect((await storedLog(page))[0]).toMatchObject({
    status: 'failed',
    error: 'INTERNAL_ERROR',
    attempts: 1,
  });
  expect((await storedLog(page))[0]!.durationMs).toBeGreaterThanOrEqual(0);
  // Failures during an idle refresh retry too, without a pending local queue.
  await page.clock.fastForward(9_000);
  expect(requests).toBe(1);
  await page.unroute('**/api/bootstrap');
  await page.clock.fastForward(1_000);
  await expect(page.locator('.sync-log-operation').first()).toContainText('Synced');
  const log = await storedLog(page);
  expect(log).toHaveLength(50);
  expect(log[0]).toMatchObject({ status: 'success', uploaded: false });
  expect(log[1]).toMatchObject({ status: 'failed' });
  expect(log.some((operation) => operation.id === 'seed-48')).toBe(false);
  await context.setOffline(true);
  await page.reload();
  await expect(page.locator('.sync-log-operation')).toHaveCount(50);
  expect(await storedLog(page)).toEqual(log);
  await expect(page.getByRole('button', { name: 'Sync now', exact: true })).toBeDisabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    page.viewportSize()!.width,
  );
});
