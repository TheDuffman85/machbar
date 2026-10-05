import { expect, test, type Page } from '@playwright/test';
import { localEntry, readSnapshot, writeSnapshot } from './helpers.js';
import { mutateDocument } from '../packages/shared/src/index.js';
const base = 'http://localhost:3100';
test.beforeEach(async ({ request }) => {
  await request.post(`${base}/test/reset`, { headers: { origin: base } });
});
async function ready(page: Page, onboarding = true) {
  await page.goto('/');
  if (onboarding) {
    await page.getByLabel('What should we call you?').fill('Offline friend');
    await page.getByRole('button', { name: 'Let’s begin' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await readSnapshot(page);
  }
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller)
      await new Promise<void>((resolve) =>
        navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), {
          once: true,
        }),
      );
  });
}
async function create(page: Page, button: string, title: string) {
  await page.getByRole('button', { name: button, exact: true }).first().click();
  await page.getByRole('dialog').getByLabel('Name', { exact: true }).fill(title);
  await page.getByRole('dialog').getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
}
async function archive(page: Page, title: string) {
  await page.getByRole('button', { name: `Archive ${title}`, exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Archive', exact: true })
    .getByRole('button', { name: 'Archive', exact: true })
    .click();
  await expect(page.getByRole('button', { name: `Archive ${title}`, exact: true })).toHaveCount(0);
}

test('all features save offline, survive reload and sync their full documents', async ({
  page,
  context,
}) => {
  await ready(page);
  await context.setOffline(true);
  await create(page, 'Add a habit', 'Offline walk');
  await page.getByRole('button', { name: 'Complete Offline walk', exact: true }).click();
  await page.getByRole('button', { name: 'Undo Offline walk', exact: true }).click();
  await page.getByRole('button', { name: 'Complete Offline walk', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Undo Offline walk', exact: true })).toBeVisible();
  await page.goto('/habits');
  await page.getByRole('button', { name: 'Edit Offline walk', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByLabel('A little more detail (optional)', { exact: true })
    .fill('Created without a server');
  await page.getByRole('dialog').getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.goto('/goals');
  await create(page, 'New goal', 'Offline home');
  await create(page, 'Add a step', 'Shelf');
  await create(page, 'Add a step', 'Plant');
  await page.getByRole('button', { name: 'Move up Plant', exact: true }).click();
  await page.getByRole('button', { name: 'Edit Shelf', exact: true }).click();
  await page.getByRole('dialog').getByLabel('Date (optional)').fill('2026-01-01');
  await page.getByRole('dialog').getByRole('button', { name: 'Save changes', exact: true }).click();
  for (const title of ['Shelf', 'Plant']) {
    await page.getByRole('button', { name: `Complete ${title}`, exact: true }).click();
    await expect(page.getByRole('button', { name: `Undo ${title}`, exact: true })).toBeVisible();
  }
  await page.getByRole('button', { name: 'Edit Offline home', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByLabel('A little more detail (optional)', { exact: true })
    .fill('An offline goal');
  await page.getByRole('dialog').getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.goto('/rewards');
  await create(page, 'Add a gift', 'Offline treat');
  await page.getByRole('button', { name: 'I treated myself', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'I treated myself', exact: true })
    .click();
  await expect(page.getByText('Enjoyed', { exact: true })).toBeVisible();
  await page.goto('/settings');
  await page.getByLabel('What should we call you?').fill('Offline name');
  await page.getByRole('button', { name: 'Dark', exact: true }).click();
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await page.getByRole('button', { name: 'Edit avatar', exact: true }).click();
  await page.getByRole('dialog').getByLabel('Eyes', { exact: true }).selectOption('hearts');
  await page.getByRole('dialog').getByRole('button', { name: 'Save avatar', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.reload();
  await expect(page.getByLabel('What should we call you?')).toHaveValue('Offline name');
  expect(await page.evaluate(() => document.documentElement.classList.contains('dark'))).toBe(true);
  expect((await localEntry(page)).snapshot.document.preferences.avatarOptions?.eyes).toBe('hearts');
  await page.goto('/user-id');
  await expect(page.getByRole('button', { name: 'Switch profile', exact: true })).toBeDisabled();
  await page.goto('/goals');
  await archive(page, 'Plant');
  await archive(page, 'Offline home');
  await page.goto('/habits');
  await archive(page, 'Offline walk');
  await page.goto('/rewards');
  await archive(page, 'Offline treat');
  const local = await localEntry(page);
  expect(local.snapshot.progress.xp).toBe(30);
  expect(local.queue.length).toBeGreaterThan(15);
  await context.setOffline(false);
  const server = await readSnapshot(page);
  expect(server.progress.xp).toBe(30);
  expect(server.document.preferences).toMatchObject({
    name: 'Offline name',
    theme: 'dark',
    avatarOptions: { eyes: 'hearts' },
  });
  expect(server.document.habits[0]).toMatchObject({ description: 'Created without a server' });
  expect(server.document.habits[0].archivedAt).not.toBeNull();
  expect(server.document.goals[0].steps.map((s) => s.title)).toEqual(['Plant', 'Shelf']);
  expect(server.document.goals[0].archivedAt).not.toBeNull();
  expect(server.document.gifts[0].claimedAt).not.toBeNull();
  expect(server.document.gifts[0].archivedAt).not.toBeNull();
  await page.reload();
  expect((await readSnapshot(page)).progress.xp).toBe(30);
});

test('onboarding can finish offline after the initial connected bootstrap', async ({
  page,
  context,
}) => {
  await ready(page, false);
  await context.setOffline(true);
  await page.getByLabel('What should we call you?').fill('Offline setup');
  await page.getByRole('button', { name: 'Let’s begin' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await create(page, 'Add a habit', 'First offline habit');
  await page.reload();
  await expect(
    page.getByRole('heading', { name: 'Hey, Offline setup', exact: true }),
  ).toBeVisible();
  await context.setOffline(false);
  expect((await readSnapshot(page)).document.habits[0].title).toBe('First offline habit');
});

test('cached startup and local saves remain responsive when navigator is online but the API fails', async ({
  page,
}) => {
  await ready(page);
  await page.route('**/api/**', (route) => route.abort('failed'));
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Hey, Offline friend', exact: true })).toBeVisible(
    { timeout: 3000 },
  );
  expect(await page.evaluate(() => navigator.onLine)).toBe(true);
  await create(page, 'Add a habit', 'API unavailable');
  expect((await localEntry(page)).snapshot.document.habits[0].title).toBe('API unavailable');
  expect((await localEntry(page)).queue.length).toBeGreaterThan(0);
  await page.unroute('**/api/**');
  await page.getByRole('button', { name: 'Sync now', exact: true }).click();
  expect((await readSnapshot(page)).document.habits[0].title).toBe('API unavailable');
});

test('edits during an in-flight sync remain local and are subsequently uploaded', async ({
  page,
}) => {
  await ready(page);
  let release!: () => void;
  let held = false;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/sync', async (route) => {
    if (!held) {
      held = true;
      await barrier;
    }
    await route.continue();
  });
  await create(page, 'Add a habit', 'During sync');
  await expect.poll(() => held).toBe(true);
  await page.getByRole('button', { name: 'Complete During sync', exact: true }).click();
  await page
    .getByRole('link', { name: 'Habits', exact: true })
    .filter({ visible: true })
    .first()
    .click();
  await page.getByRole('button', { name: 'Edit During sync', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByLabel('A little more detail (optional)', { exact: true })
    .fill('Edited during the upload');
  await page.getByRole('dialog').getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect((await localEntry(page)).queue).toHaveLength(3);
  release();
  const result = await readSnapshot(page);
  expect(result.document.habits).toHaveLength(1);
  expect(result.document.habits[0].description).toBe('Edited during the upload');
  expect(result.progress.xp).toBe(10);
});

test('a lost sync response retries without duplicating an already saved creation', async ({
  page,
  context,
}) => {
  await ready(page);
  let dropped = false;
  await page.route('**/api/bootstrap', (route) =>
    dropped ? route.abort('failed') : route.continue(),
  );
  await page.route('**/api/sync', async (route) => {
    await route.fetch();
    dropped = true;
    await route.abort('failed');
  });
  await create(page, 'Add a habit', 'Saved once');
  await expect.poll(() => dropped).toBe(true);
  expect((await localEntry(page)).queue.length).toBeGreaterThan(0);
  const id = await page.evaluate(() => localStorage.getItem('machbar-user-id')!);
  const before = await page.request.get('/api/bootstrap', { headers: { 'X-Machbar-User': id } });
  expect((await before.json()).document.habits).toHaveLength(1);
  await page.unroute('**/api/sync');
  await page.unroute('**/api/bootstrap');
  await context.setOffline(true);
  await context.setOffline(false);
  const result = await readSnapshot(page);
  expect(result.document.habits).toHaveLength(1);
  expect(result.document.revision).toBe((await before.json()).document.revision);
});

test('offline tabs share local changes without losing independent additions, even without Web Locks', async ({
  page,
  context,
}) => {
  await context.addInitScript(() =>
    Object.defineProperty(navigator, 'locks', { value: undefined }),
  );
  await ready(page);
  const other = await context.newPage();
  await other.goto('/');
  await expect(
    other.getByRole('heading', { name: 'Hey, Offline friend', exact: true }),
  ).toBeVisible();
  await context.setOffline(true);
  await Promise.all([
    create(page, 'Add a habit', 'Tab one'),
    create(other, 'Add a habit', 'Tab two'),
  ]);
  for (const tab of [page, other]) {
    await expect(tab.getByRole('button', { name: 'Complete Tab one', exact: true })).toBeVisible();
    await expect(tab.getByRole('button', { name: 'Complete Tab two', exact: true })).toBeVisible();
  }
  await context.setOffline(false);
  expect((await readSnapshot(page)).document.habits.map((h) => h.title).sort()).toEqual([
    'Tab one',
    'Tab two',
  ]);
  await other.close();
});

test('legacy IndexedDB checkoff queues upgrade without losing pending progress', async ({
  page,
  context,
}) => {
  await ready(page);
  const snapshot = await readSnapshot(page);
  const id = crypto.randomUUID();
  mutateDocument(
    snapshot.document,
    '/api/habits',
    'POST',
    { title: 'Legacy walk', weekdays: [0, 1, 2, 3, 4, 5, 6] },
    id,
  );
  const saved = await writeSnapshot(page, snapshot.document);
  await page.goto('/health');
  await page.evaluate(
    async (legacy) => {
      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.deleteDatabase('machbar');
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      });
      const db = await new Promise<IDBDatabase>((resolve) => {
        const request = indexedDB.open('machbar', 1);
        request.onupgradeneeded = () => request.result.createObjectStore('accounts');
        request.onsuccess = () => resolve(request.result);
      });
      await new Promise<void>((resolve) => {
        const tx = db.transaction('accounts', 'readwrite');
        tx.objectStore('accounts').put(legacy, legacy.snapshot.document.userId);
        tx.oncomplete = () => resolve();
      });
      db.close();
    },
    {
      snapshot: saved,
      queue: [
        {
          operationId: crypto.randomUUID(),
          targetType: 'habit',
          targetId: id,
          date: saved.today,
          timezone: saved.document.preferences.timezone,
          completed: true,
          expectedVersion: 0,
        },
      ],
    },
  );
  await context.setOffline(true);
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Undo Legacy walk', exact: true })).toBeVisible();
  expect((await localEntry(page)).snapshot.progress.xp).toBe(10);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Undo Legacy walk', exact: true })).toBeVisible();
  await context.setOffline(false);
  expect((await readSnapshot(page)).progress.xp).toBe(10);
});

test('a first bootstrap still requires a connection when no local profile exists', async ({
  page,
}) => {
  await page.goto('/health');
  await page.route('**/api/**', (route) => route.abort('failed'));
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Try again', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add a habit', exact: true })).toHaveCount(0);
});

test('revision races fetch, merge and retry without losing the local operation', async ({
  page,
}) => {
  await ready(page);
  let raced = false;
  await page.route('**/api/sync', async (route) => {
    if (!raced) {
      raced = true;
      const id = await page.evaluate(() => localStorage.getItem('machbar-user-id')!);
      const response = await page.request.get('/api/bootstrap', {
        headers: { 'X-Machbar-User': id },
      });
      const remote = (await response.json()).document;
      remote.preferences.name = 'Concurrent name';
      await writeSnapshot(page, remote);
    }
    await route.continue();
  });
  await create(page, 'Add a habit', 'Race survivor');
  const result = await readSnapshot(page);
  expect(raced).toBe(true);
  expect(result.document.habits.map((h) => h.title)).toEqual(['Race survivor']);
  expect(result.document.preferences.name).toBe('Concurrent name');
  expect(result.document.revision).toBe(3);
});

test('offline devices merge additions, independent fields and shared completions on reconnect', async ({
  page,
  context,
  browser,
}) => {
  await ready(page);
  await create(page, 'Add a habit', 'Shared walk');
  const baseline = await readSnapshot(page);
  const otherContext = await browser.newContext({ locale: 'en-US' });
  try {
    await otherContext.addInitScript(
      (id) => localStorage.setItem('machbar-user-id', id),
      baseline.document.userId,
    );
    const other = await otherContext.newPage();
    await other.goto(base);
    await other.evaluate(async () => {
      await navigator.serviceWorker.ready;
      if (!navigator.serviceWorker.controller)
        await new Promise<void>((resolve) =>
          navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), {
            once: true,
          }),
        );
    });
    await expect(
      other.getByRole('button', { name: 'Complete Shared walk', exact: true }),
    ).toBeVisible();
    await context.setOffline(true);
    await otherContext.setOffline(true);
    await page.getByRole('button', { name: 'Complete Shared walk', exact: true }).click();
    await other.getByRole('button', { name: 'Complete Shared walk', exact: true }).click();
    await page
      .getByRole('link', { name: 'Habits', exact: true })
      .filter({ visible: true })
      .first()
      .click();
    await page.getByRole('button', { name: 'Edit Shared walk', exact: true }).click();
    await page.getByRole('dialog').getByLabel('Name', { exact: true }).fill('Local title');
    await page
      .getByRole('dialog')
      .getByLabel('A little more detail (optional)', { exact: true })
      .fill('Local detail');
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Save changes', exact: true })
      .click();
    await create(page, 'Add a habit', 'Local addition');
    await other
      .getByRole('link', { name: 'Habits', exact: true })
      .filter({ visible: true })
      .first()
      .click();
    await other.getByRole('button', { name: 'Edit Shared walk', exact: true }).click();
    await other.getByRole('dialog').getByLabel('Name', { exact: true }).fill('Server title');
    await other
      .getByRole('dialog')
      .getByRole('button', { name: 'Save changes', exact: true })
      .click();
    await expect(other.getByRole('dialog')).toHaveCount(0);
    await other
      .getByRole('link', { name: 'Goals', exact: true })
      .filter({ visible: true })
      .first()
      .click();
    await create(other, 'New goal', 'Remote addition');
    await otherContext.setOffline(false);
    expect((await readSnapshot(other)).document.habits[0].title).toBe('Server title');
    await context.setOffline(false);
    const result = await readSnapshot(page);
    expect(result.document.habits).toHaveLength(2);
    expect(
      result.document.habits.find((h) => h.id === baseline.document.habits[0].id),
    ).toMatchObject({ title: 'Server title', description: 'Local detail' });
    expect(result.document.goals.map((g) => g.title)).toEqual(['Remote addition']);
    expect(result.progress.xp).toBe(10);
    await other.goto(base);
    await expect(
      other.getByRole('button', { name: 'Complete Local addition', exact: true }),
    ).toBeVisible();
    await expect(
      other.getByRole('button', { name: 'Undo Server title', exact: true }),
    ).toBeVisible();
  } finally {
    await otherContext.close();
  }
});

test('daily habits and streaks advance at midnight while remaining offline', async ({
  page,
  context,
}) => {
  const start = new Date();
  start.setUTCHours(23, 59, 45, 0);
  await page.clock.install({ time: start });
  await ready(page);
  await page.goto('/settings');
  await page.getByLabel('Timezone', { exact: true }).selectOption('UTC');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await readSnapshot(page);
  await page.goto('/');
  await context.setOffline(true);
  await create(page, 'Add a habit', 'Midnight walk');
  await page.getByRole('button', { name: 'Complete Midnight walk', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Undo Midnight walk', exact: true })).toBeVisible();
  await page.clock.fastForward(30_000);
  await expect(
    page.getByRole('button', { name: 'Complete Midnight walk', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Complete Midnight walk', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Undo Midnight walk', exact: true })).toBeVisible();
  const local = await localEntry(page);
  expect(Object.values(local.snapshot.document.completions)).toHaveLength(2);
  expect(local.snapshot.progress.xp).toBe(20);
  expect(local.snapshot.progress.habits[local.snapshot.document.habits[0].id].current).toBe(2);
  expect(await page.evaluate(() => navigator.onLine)).toBe(false);
});
