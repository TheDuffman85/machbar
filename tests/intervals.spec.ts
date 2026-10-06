import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { mutateDocument } from '../packages/shared/src/index.js';
import { localEntry, readSnapshot } from './helpers.js';

const base = 'http://localhost:3100';
const time = new Date('2026-10-06T10:00:00Z');
test.beforeEach(async ({ page, request }) => {
  await request.post('/test/reset', { headers: { origin: base } });
  await page.clock.setFixedTime(time);
});
async function ready(page: Page, onboard = true) {
  await page.goto('/');
  if (onboard) {
    await page.getByLabel('What should we call you?').fill('Alex');
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
async function add(page: Page, title: string, repeat: string, unit?: string) {
  await page.getByRole('button', { name: 'Add a habit', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Name', { exact: true }).fill(title);
  await dialog.getByLabel('Repeat', { exact: true }).selectOption(repeat);
  if (unit) {
    await dialog.getByLabel('Every', { exact: true }).fill('3');
    await dialog.getByLabel('Unit', { exact: true }).selectOption(unit);
  }
  await dialog.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(dialog).toHaveCount(0);
}

test('all interval types create, complete, undo, edit, reward and archive entirely offline', async ({
  page,
  context,
}) => {
  test.setTimeout(60000);
  await ready(page);
  await context.setOffline(true);
  await page.goto('/habits');
  await add(page, 'Daily walk', 'daily');
  for (const [title, repeat, unit] of [
    ['Weekly reading', 'weekly'],
    ['Monthly review', 'monthly'],
    ['Three days', 'custom', 'day'],
    ['Three weeks', 'custom', 'week'],
    ['Three months', 'custom', 'month'],
  ])
    await add(page, title!, repeat!, unit);
  await page.goto('/');
  await expect(page.locator('.daily-hero')).toContainText('0 of 1 challenges');
  const periods = page.locator('.period-habits');
  await expect(periods.locator('.task-row')).toHaveCount(5);
  for (const title of [
    'Weekly reading',
    'Monthly review',
    'Three days',
    'Three weeks',
    'Three months',
  ]) {
    await periods.getByRole('button', { name: `Complete ${title}`, exact: true }).click();
    await expect(periods.getByRole('button', { name: `Undo ${title}`, exact: true })).toBeVisible();
  }
  expect((await localEntry(page)).snapshot.progress.xp).toBe(50);
  await expect(page.locator('.daily-hero')).toContainText('0 of 1 challenges');
  await expect(page.locator('.daily-hero')).toContainText('50 XP');
  await page.reload();
  await expect(periods.getByRole('button', { name: /^Undo / })).toHaveCount(5);
  await page.clock.setFixedTime(new Date('2026-10-07T10:00:00Z'));
  await page.reload();
  await expect(periods.getByRole('button', { name: /^Undo / })).toHaveCount(5);
  await expect(page.locator('.daily-hero')).toContainText('0 XP');
  await periods.getByRole('button', { name: 'Undo Monthly review', exact: true }).click();
  await expect(
    periods.getByRole('button', { name: 'Complete Monthly review', exact: true }),
  ).toBeVisible();
  expect((await localEntry(page)).snapshot.progress.xp).toBe(40);
  await periods.getByRole('button', { name: 'Complete Monthly review', exact: true }).click();
  await expect(
    periods.getByRole('button', { name: 'Undo Monthly review', exact: true }),
  ).toBeVisible();
  await page.clock.setFixedTime(new Date('2026-10-09T10:00:00Z'));
  await page.reload();
  await periods.getByRole('button', { name: 'Complete Three days', exact: true }).click();
  await expect(periods.getByRole('button', { name: 'Undo Three days', exact: true })).toBeVisible();
  expect((await localEntry(page)).snapshot.progress.xp).toBe(60);
  await expect(periods.locator('.task-row').filter({ hasText: 'Three days' })).toContainText(
    '2 in a row',
  );
  await page.goto('/habits');
  for (const repeat of ['monthly', 'custom']) {
    await page.getByRole('button', { name: 'Edit Weekly reading', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Repeat', { exact: true }).selectOption(repeat);
    if (repeat === 'custom') {
      await dialog.getByLabel('Every', { exact: true }).fill('2');
      await dialog.getByLabel('Unit', { exact: true }).selectOption('week');
    }
    await expect(dialog).toContainText('2026-10-12');
    await dialog.getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect(dialog).toHaveCount(0);
  }
  await page.reload();
  const saved = await localEntry(page);
  const weekly = saved.snapshot.document.habits.find((h) => h.title === 'Weekly reading')!;
  expect(weekly.schedules).toHaveLength(2);
  expect(weekly.schedules[1]).toMatchObject({
    from: '2026-10-12',
    recurrence: { unit: 'week', every: 2, anchor: '2026-10-12' },
  });
  expect(saved.snapshot.progress.habits[weekly.id]!.current).toBe(1);
  await page.goto('/rewards');
  await page.getByRole('button', { name: 'Add a gift', exact: true }).click();
  const gift = page.getByRole('dialog');
  await gift.getByLabel('Name', { exact: true }).fill('Offline interval reward');
  await gift.getByLabel('Unlock this gift when…').selectOption('habitStreak');
  await gift.getByLabel('Choose a habit').selectOption(weekly.id);
  await gift.getByLabel('Target').fill('1');
  await gift.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(gift).toHaveCount(0);
  await page.getByRole('button', { name: 'I treated myself', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'I treated myself', exact: true })
    .click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByText('Enjoyed', { exact: true })).toBeVisible();
  await page.goto('/habits');
  await page.getByRole('button', { name: 'Archive Three months', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Archive', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Archive Three months', exact: true })).toHaveCount(
    0,
  );
  await page.reload();
  expect((await localEntry(page)).queue.length).toBeGreaterThan(10);
  await context.setOffline(false);
  const synced = await readSnapshot(page);
  expect(synced.progress.xp).toBe(60);
  expect(synced.document.habits.find((h) => h.id === weekly.id)!.schedules).toEqual(
    weekly.schedules,
  );
  expect(synced.document.gifts[0]!.claimedAt).not.toBeNull();
  expect(synced.document.habits.find((h) => h.title === 'Three months')!.archivedAt).not.toBeNull();
});

test('daily and selected-weekday habits retain their targets while a custom future start waits', async ({
  page,
  context,
}) => {
  await ready(page);
  await context.setOffline(true);
  await page.goto('/habits');
  await add(page, 'Daily stretch', 'daily');
  await page.getByRole('button', { name: 'Add a habit', exact: true }).click();
  let dialog = page.getByRole('dialog');
  await dialog.getByLabel('Name', { exact: true }).fill('Tuesday stretch');
  await dialog.getByLabel('Repeat', { exact: true }).selectOption('weekdays');
  for (const day of ['Mon', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'])
    await dialog.getByRole('button', { name: day, exact: true }).click();
  await dialog.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page.getByRole('button', { name: 'Add a habit', exact: true }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByLabel('Name', { exact: true }).fill('Future fortnight');
  await dialog.getByLabel('Repeat', { exact: true }).selectOption('custom');
  await dialog.getByLabel('Unit', { exact: true }).selectOption('week');
  await dialog.getByLabel('Start date', { exact: true }).fill('2026-10-20');
  await dialog.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page.goto('/');
  await expect(page.locator('.daily-hero')).toContainText('0 of 2 challenges');
  await expect(page.locator('.period-habits')).toHaveCount(0);
  for (const title of ['Daily stretch', 'Tuesday stretch']) {
    await page.getByRole('button', { name: `Complete ${title}`, exact: true }).click();
    await expect(page.getByRole('button', { name: `Undo ${title}`, exact: true })).toBeVisible();
  }
  await expect(page.locator('.daily-hero')).toContainText('2 of 2 challenges');
  await page.clock.setFixedTime(new Date('2026-10-19T10:00:00Z'));
  await page.reload();
  await expect(page.locator('.daily-hero')).toContainText('0 of 1 challenges');
  await expect(page.locator('.period-habits')).toHaveCount(0);
  await page.clock.setFixedTime(new Date('2026-10-20T10:00:00Z'));
  await page.reload();
  await expect(page.locator('.daily-hero')).toContainText('0 of 2 challenges');
  await expect(page.locator('.period-habits')).toContainText('2026-11-01');
  await page.getByRole('button', { name: 'Complete Future fortnight', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Undo Future fortnight', exact: true }),
  ).toBeVisible();
  const before = (await localEntry(page)).snapshot.document.habits.find(
    (h) => h.title === 'Future fortnight',
  )!;
  expect(before.schedules[0]).toMatchObject({
    from: '2026-10-20',
    recurrence: { unit: 'week', every: 2, anchor: '2026-10-19' },
  });
  await page.goto('/habits');
  await page.getByRole('button', { name: 'Edit Future fortnight', exact: true }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByLabel('Name', { exact: true }).fill('Renamed fortnight');
  await dialog.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(
    (await localEntry(page)).snapshot.document.habits.find((h) => h.id === before.id)!.schedules,
  ).toEqual(before.schedules);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Renamed fortnight', exact: true })).toBeVisible();
  await context.setOffline(false);
  expect((await readSnapshot(page)).progress.xp).toBe(30);
});

for (const language of ['en', 'de'] as const) {
  test(`period history preserves completion dates and daily targets in ${language}`, async ({
    page,
    context,
  }) => {
    await ready(page);
    const { document: doc } = await readSnapshot(page);
    doc.preferences.language = language;
    const id = crypto.randomUUID();
    mutateDocument(
      doc,
      '/api/habits',
      'POST',
      {
        title: 'Monthly reflection',
        weekdays: [0, 1, 2, 3, 4, 5, 6],
        recurrence: { unit: 'month', every: 1, anchor: '2026-10-01' },
      },
      id,
      new Date('2026-10-01T10:00:00Z'),
    );
    await page.request.post('/test/seed', { headers: { origin: base }, data: doc });
    await page.reload();
    await expect(
      page.getByRole('button', {
        name: language === 'en' ? 'Complete Monthly reflection' : 'Monthly reflection abschließen',
        exact: true,
      }),
    ).toBeVisible();
    await context.setOffline(true);
    await page
      .getByRole('button', {
        name: language === 'en' ? 'Previous day' : 'Vorheriger Tag',
        exact: true,
      })
      .click();
    await page
      .getByRole('button', {
        name: language === 'en' ? 'Complete Monthly reflection' : 'Monthly reflection abschließen',
        exact: true,
      })
      .click();
    await expect(page.locator('.daily-hero')).toContainText('10 XP');
    await page
      .getByRole('button', { name: language === 'en' ? 'Next day' : 'Nächster Tag', exact: true })
      .click();
    await expect(page.locator('.period-habits')).toContainText('2026-10-05');
    await expect(page.locator('.daily-hero')).toContainText('0 XP');
    await expect(page.locator('.daily-hero')).toContainText(
      language === 'en' ? '0 of 0 challenges' : '0 von 0 Aufgaben',
    );
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.goto('/habits');
    await page
      .getByRole('button', {
        name: language === 'en' ? 'Edit Monthly reflection' : 'Bearbeiten Monthly reflection',
        exact: true,
      })
      .click();
    const dialog = page.getByRole('dialog');
    await dialog
      .getByLabel(language === 'en' ? 'Repeat' : 'Wiederholung', { exact: true })
      .selectOption('custom');
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await dialog
      .getByRole('button', { name: language === 'en' ? 'Cancel' : 'Abbrechen', exact: true })
      .click();
    await context.setOffline(false);
    expect((await readSnapshot(page)).progress.xp).toBe(10);
  });
}

test('two offline devices checking different dates sync to one weekly win', async ({
  page,
  context,
  browser,
}) => {
  test.setTimeout(60000);
  await ready(page);
  const { document: doc } = await readSnapshot(page);
  const id = crypto.randomUUID();
  mutateDocument(
    doc,
    '/api/habits',
    'POST',
    {
      title: 'Shared week',
      weekdays: [0, 1, 2, 3, 4, 5, 6],
      recurrence: { unit: 'week', every: 1, anchor: '2026-10-01' },
    },
    id,
    new Date('2026-10-01T10:00:00Z'),
  );
  await page.request.post('/test/seed', { headers: { origin: base }, data: doc });
  await page.reload();
  await expect(
    page.getByRole('button', { name: 'Complete Shared week', exact: true }),
  ).toBeVisible();
  const otherContext = await browser.newContext({ baseURL: base });
  try {
    await otherContext.addInitScript(
      (userId) => localStorage.setItem('machbar-user-id', userId),
      doc.userId,
    );
    const other = await otherContext.newPage();
    await other.clock.setFixedTime(new Date('2026-10-07T10:00:00Z'));
    await ready(other, false);
    await expect(
      other.getByRole('button', { name: 'Complete Shared week', exact: true }),
    ).toBeVisible();
    await context.setOffline(true);
    await otherContext.setOffline(true);
    await page.getByRole('button', { name: 'Complete Shared week', exact: true }).click();
    await other.getByRole('button', { name: 'Complete Shared week', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Undo Shared week', exact: true })).toBeVisible();
    await expect(
      other.getByRole('button', { name: 'Undo Shared week', exact: true }),
    ).toBeVisible();
    await page.reload();
    await other.reload();
    await expect(page.getByRole('button', { name: 'Undo Shared week', exact: true })).toBeVisible();
    await expect(
      other.getByRole('button', { name: 'Undo Shared week', exact: true }),
    ).toBeVisible();
    await context.setOffline(false);
    await page.bringToFront();
    await expect
      .poll(async () => (await localEntry(page)).queue.length, { timeout: 20000 })
      .toBe(0);
    expect((await readSnapshot(page)).progress.xp).toBe(10);
    await otherContext.setOffline(false);
    await other.bringToFront();
    await expect
      .poll(async () => (await localEntry(other)).queue.length, { timeout: 20000 })
      .toBe(0);
    const merged = await readSnapshot(other);
    expect(merged.progress.xp).toBe(10);
    expect(merged.progress.habits[id]!.count).toBe(1);
    expect(Object.values(merged.document.completions).filter((c) => c.completed)).toHaveLength(1);
  } finally {
    await otherContext.close();
  }
});
