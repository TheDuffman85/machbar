import { dismissedHints } from './setup-hints.js';
import { localEntry, readSnapshot, writeSnapshot } from './helpers.js';
import { expect, test, type Page } from '@playwright/test';
import { AxeBuilder } from '@axe-core/playwright';
import {
  addDays,
  applyCompletion,
  completionKey,
  type Bootstrap,
  type Habit,
} from '../packages/shared/src/index.js';
const base = 'http://localhost:3100';
test.beforeEach(async ({ request }) => {
  await request.post(`${base}/api/test/reset`, {
    headers: { origin: base, 'X-Machbar-User': '00000000-0000-4000-8000-000000000001' },
  });
});
async function onboard(page: Page, name = 'Alex') {
  await page.goto('/');
  await page.getByLabel('What should we call you?').fill(name);
  await page.getByRole('button', { name: 'Let’s begin' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: `Hey, ${name}` })).toBeVisible();
}
async function addHabit(page: Page, name = 'Take a little walk') {
  await page.locator('nav:visible').getByRole('link', { name: 'Habits', exact: true }).click();
  await page.getByRole('button', { name: 'Add a habit', exact: true }).first().click();
  await page.getByRole('dialog').getByLabel('Name', { exact: true }).fill(name);
  await page.getByRole('dialog').getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.locator('nav:visible').getByRole('link', { name: 'Today', exact: true }).click();
  await expect(page.getByRole('button', { name: `Complete ${name}`, exact: true })).toBeVisible();
}
async function serverXp(page: Page, xp: number) {
  await expect.poll(async () => (await readSnapshot(page)).progress.xp).toBe(xp);
}
async function serviceWorker(page: Page) {
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
test('onboarding, a daily habit, completion and undo survive reload', async ({ page }) => {
  await onboard(page);
  await addHabit(page);
  await page.getByRole('button', { name: 'Complete Take a little walk', exact: true }).click();
  await serverXp(page, 10);
  await expect(page.getByText('1 of 1 challenges', { exact: false })).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: 'Undo Take a little walk', exact: true }).click();
  await serverXp(page, 0);
});
test('Today shows every streak and logs missed habits on their original dates', async ({
  page,
  context,
}) => {
  await onboard(page);
  await addHabit(page);
  const snapshot = (await readSnapshot(page)) as Bootstrap;
  const today = snapshot.today;
  const yesterday = addDays(today, -1);
  const habit = snapshot.document.habits[0];
  habit.schedules[0].from = addDays(today, -3);
  // Today's schedule changed timezone and weekdays. Past checkoffs must use the old schedule.
  habit.schedules.push({
    from: today,
    weekdays: [new Date(`${today}T12:00:00Z`).getUTCDay()],
    timezone: 'UTC',
  });
  for (let i = 2; i <= 4; i++)
    snapshot.document.habits.push({ ...habit, id: crypto.randomUUID(), title: `Habit ${i}` });
  expect(
    (
      await page.request.post('/api/test/seed', {
        headers: { origin: base, 'X-Machbar-User': '00000000-0000-4000-8000-000000000001' },
        data: snapshot.document,
      })
    ).ok(),
  ).toBe(true);
  await page.reload();
  const row = page.locator('.task-row').filter({ hasText: habit.title });
  const streak = page
    .locator('.streak-card > div')
    .filter({ hasText: habit.title })
    .locator('strong');
  await expect(row.getByText('Current streak:', { exact: false })).toHaveCount(0);
  await expect(
    page.locator('.page-heading').getByRole('button', { name: 'Add a habit' }),
  ).toHaveCount(0);
  await expect(streak).toHaveText('0');
  await expect(page.locator('.streak-card > div')).toHaveCount(4);
  const nav = page.getByRole('navigation', { name: 'Main navigation' }).filter({ visible: true });
  await expect(nav.getByRole('link')).toHaveText([
    'Today',
    'Habits',
    'Goals',
    'Gifts',
    'Achievements',
  ]);
  const selectedDate = page.getByLabel('Selected date', { exact: true });
  await expect(page.locator('.history-toolbar input')).toHaveCount(0);
  await expect(selectedDate).toHaveAttribute('datetime', today);
  await expect(selectedDate).toHaveText(
    new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeZone: 'UTC' }).format(
      new Date(`${today}T12:00:00Z`),
    ),
  );
  await expect(page.getByRole('button', { name: 'Next day', exact: true })).toBeDisabled();
  await serviceWorker(page);
  await page.getByRole('button', { name: 'Previous day', exact: true }).click();
  await expect(selectedDate).toHaveAttribute('datetime', yesterday);
  await expect(
    page.getByText('Check off habits you did on this day.', { exact: false }),
  ).toBeVisible();
  await expect(row).toContainText('Every day');
  await context.setOffline(true);
  await row.getByRole('button', { name: `Complete ${habit.title}`, exact: true }).click();
  await expect(streak).toHaveText('1');
  await context.setOffline(false);
  await serverXp(page, 10);
  let saved = (await readSnapshot(page)) as Bootstrap;
  expect(saved.document.completions[completionKey('habit', habit.id, yesterday)]).toMatchObject({
    date: yesterday,
    timezone: snapshot.document.preferences.timezone,
    completed: true,
  });
  expect(saved.document.completions[completionKey('habit', habit.id, today)]).toBeUndefined();
  await page.reload();
  await expect(selectedDate).toHaveAttribute('datetime', today);
  await page.getByRole('button', { name: 'Previous day', exact: true }).click();
  await expect(row.getByRole('button', { name: `Undo ${habit.title}`, exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Previous day', exact: true }).click();
  await row.getByRole('button', { name: `Complete ${habit.title}`, exact: true }).click();
  await serverXp(page, 20);
  await expect(streak).toHaveText('2');
  await page.getByRole('button', { name: 'Next day', exact: true }).click();
  await row.getByRole('button', { name: `Undo ${habit.title}`, exact: true }).click();
  await serverXp(page, 10);
  await expect(streak).toHaveText('0');
  await page.getByRole('button', { name: 'Previous day', exact: true }).click();
  await page.getByRole('button', { name: 'Previous day', exact: true }).click();
  await expect(selectedDate).toHaveAttribute('datetime', addDays(today, -3));
  await expect(page.getByRole('button', { name: 'Previous day', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Next day', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Back to today', exact: true })).toHaveCount(0);
  for (let i = 0; i < 3; i++)
    await page.getByRole('button', { name: 'Next day', exact: true }).click();
  await expect(selectedDate).toHaveAttribute('datetime', today);
  await expect(page.getByRole('button', { name: 'Next day', exact: true })).toBeDisabled();
  saved = (await readSnapshot(page)) as Bootstrap;
  expect(saved.document.completions[completionKey('habit', habit.id, yesterday)]?.completed).toBe(
    false,
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({
    path: `test-results/habit-history-${test.info().project.name}.png`,
    fullPage: true,
  });
});
for (const language of ['en', 'de'] as const) {
  test(`Today resets its date when opened and keeps the ${language} date row aligned`, async ({
    page,
  }) => {
    await onboard(page);
    const snapshot = await readSnapshot(page);
    snapshot.document.preferences.language = language;
    expect(
      (
        await page.request.post('/api/test/seed', {
          headers: { origin: base, 'X-Machbar-User': '00000000-0000-4000-8000-000000000001' },
          data: snapshot.document,
        })
      ).ok(),
    ).toBe(true);
    await page.reload();
    const labels =
      language === 'de'
        ? {
            date: 'Ausgewähltes Datum',
            previous: 'Vorheriger Tag',
            today: 'Heute',
            habits: 'Gewohnheiten',
          }
        : { date: 'Selected date', previous: 'Previous day', today: 'Today', habits: 'Habits' };
    const selectedDate = page.getByLabel(labels.date, { exact: true });
    const previous = page.getByRole('button', { name: labels.previous, exact: true });
    const nav = page.getByRole('navigation').filter({ visible: true });
    const todayLink = nav.getByRole('link', { name: labels.today, exact: true });
    await expect(selectedDate).toHaveAttribute('datetime', snapshot.today);
    await previous.click();
    await expect(selectedDate).toHaveAttribute('datetime', addDays(snapshot.today, -1));
    await expect(page.locator('.history-actions button')).toHaveCount(2);
    await expect(page.locator('.history-toolbar input')).toHaveCount(0);
    const iconBox = await page.locator('.history-date-field svg').boundingBox();
    const dateBox = await selectedDate.boundingBox();
    expect(iconBox).not.toBeNull();
    expect(dateBox).not.toBeNull();
    expect(
      Math.abs(iconBox!.y + iconBox!.height / 2 - dateBox!.y - dateBox!.height / 2),
    ).toBeLessThan(2);
    expect(iconBox!.x + iconBox!.width).toBeLessThan(dateBox!.x);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.locator('.history-toolbar').screenshot({
      path: `test-results/history-toolbar-${language}-${test.info().project.name}.png`,
    });
    await todayLink.click();
    await expect(selectedDate).toHaveAttribute('datetime', snapshot.today);
    await previous.click();
    await nav.getByRole('link', { name: labels.habits, exact: true }).click();
    await expect(page).toHaveURL(/\/habits$/);
    await expect(selectedDate).toHaveCount(0);
    await todayLink.click();
    await expect(selectedDate).toHaveAttribute('datetime', snapshot.today);
    await previous.click();
    await nav.getByRole('link', { name: labels.habits, exact: true }).click();
    await expect(page).toHaveURL(/\/habits$/);
    await expect(selectedDate).toHaveCount(0);
    await page.goBack();
    await expect(selectedDate).toHaveAttribute('datetime', snapshot.today);
    await previous.click();
    await page.reload();
    await expect(selectedDate).toHaveAttribute('datetime', snapshot.today);
  });
}
for (const dailyHistoryDays of [0, 7]) {
  test(`Today respects a configured history limit of ${dailyHistoryDays} days`, async ({
    page,
  }) => {
    await onboard(page);
    const { today } = await readSnapshot(page);
    await page.route('**/api/bootstrap', async (route) => {
      const response = await route.fetch();
      await route.fulfill({ response, json: { ...(await response.json()), dailyHistoryDays } });
    });
    await page.reload();
    const selectedDate = page.getByLabel('Selected date', { exact: true });
    const previous = page.getByRole('button', { name: 'Previous day', exact: true });
    const next = page.getByRole('button', { name: 'Next day', exact: true });
    await expect(selectedDate).toHaveAttribute('datetime', today);
    await expect(next).toBeDisabled();
    for (let daysAgo = 1; daysAgo <= dailyHistoryDays; daysAgo++) {
      await expect(previous).toBeEnabled();
      await previous.click();
      await expect(selectedDate).toHaveAttribute('datetime', addDays(today, -daysAgo));
    }
    await expect(previous).toBeDisabled();
    if (dailyHistoryDays > 0) {
      await next.click();
      await expect(selectedDate).toHaveAttribute('datetime', addDays(today, -dailyHistoryDays + 1));
      await expect(previous).toBeEnabled();
      for (let i = 1; i < dailyHistoryDays; i++) await next.click();
      await expect(selectedDate).toHaveAttribute('datetime', today);
      await expect(next).toBeDisabled();
    }
  });
}
test('profile menu opens settings, dismisses and exposes profile switching', async ({ page }) => {
  await onboard(page);
  const trigger = page.getByRole('button', { name: 'Profile menu', exact: true });
  const menu = page.getByRole('menu', { name: 'Profile menu', exact: true });
  await trigger.click();
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitem')).toHaveCount(2);
  await expect(menu.getByRole('menuitem', { name: 'Edit avatar', exact: true })).toHaveCount(0);
  await expect(menu.getByRole('menuitem', { name: 'Switch User', exact: true })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Settings', exact: true })).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  const accessibility = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
    .analyze();
  expect(accessibility.violations).toEqual([]);
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
  await expect(menu).toHaveCount(0);
  await trigger.click();
  await page.getByRole('heading', { name: 'Settings', exact: true }).click();
  await expect(menu).toHaveCount(0);
  await trigger.click();
  await trigger.click();
  await expect(menu).toHaveCount(0);
  await page.getByRole('button', { name: 'Dark', exact: true }).click();
  await page.getByLabel('Language', { exact: true }).selectOption('de');
  await page.getByRole('button', { name: 'Profilmenü', exact: true }).click();
  await expect(page.getByRole('menuitem', { name: 'Einstellungen', exact: true })).toBeVisible();
  await page.screenshot({ path: `test-results/profile-menu-${test.info().project.name}.png` });
});
test('German onboarding is centered, scrolls internally and locks the background', async ({
  page,
}) => {
  const viewport = page.viewportSize()!;
  await page.setViewportSize({ ...viewport, height: 650 });
  await page.goto('/');
  await page.getByLabel('Language', { exact: true }).selectOption('de');
  const dialog = page.getByRole('dialog', {
    name: 'Machen wir jeden Tag ein bisschen machbarer.',
  });
  await expect(dialog).toBeVisible();
  await page.addStyleTag({ content: 'body { min-height: 200vh; }' });
  const bounds = (await dialog.boundingBox())!;
  expect(Math.abs(bounds.x + bounds.width / 2 - viewport.width / 2)).toBeLessThan(2);
  expect(Math.abs(bounds.y + bounds.height / 2 - 325)).toBeLessThan(2);
  expect(bounds.y).toBeGreaterThanOrEqual(24);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(626);
  await page.mouse.move(2, 2);
  await page.mouse.wheel(0, 700);
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  await dialog.evaluate((element) => {
    element.scrollTop = 0;
  });
  await page.screenshot({ path: `test-results/onboarding-${test.info().project.name}.png` });
  await dialog.locator('input').fill('Alex');
  await dialog.locator('button[type="submit"]').click();
  await expect(dialog).toHaveCount(0);
  await page
    .locator('nav:visible')
    .getByRole('link', { name: 'Gewohnheiten', exact: true })
    .click();
  await page.evaluate(() => window.scrollTo(0, 400));
  expect(await page.evaluate(() => window.scrollY)).toBe(400);
  // Opening another dialog must preserve the page position on dismissal.
  await page
    .getByRole('button', { name: 'Gewohnheit hinzufügen', exact: true })
    .first()
    .evaluate((button: HTMLButtonElement) => button.click());
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await page.evaluate(() => window.scrollY)).toBe(400);
});
test('non-localhost HTTP supports onboarding, avatars and completion/undo', async ({ page }) => {
  const external = 'http://machbar.test:3100';
  await page.goto(external);
  expect(await page.evaluate(() => window.isSecureContext)).toBe(false);
  await page.getByRole('button', { name: 'Edit avatar', exact: true }).click();
  await page.getByRole('button', { name: 'Another little face', exact: true }).click();
  await page.getByRole('button', { name: 'Use this avatar', exact: true }).click();
  await page.getByLabel('What should we call you?').fill('LAN friend');
  await page.getByRole('button', { name: 'Let’s begin' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Hey, LAN friend' })).toBeVisible();
  await addHabit(page, 'A LAN win');
  await page.getByRole('button', { name: 'Complete A LAN win', exact: true }).click();
  await serverXp(page, 10);
  await page.reload();
  await page.getByRole('button', { name: 'Undo A LAN win', exact: true }).click();
  await serverXp(page, 0);
});
test('goals and habits have separate pages and navigation links', async ({ page }) => {
  await onboard(page);
  const navigation = page.locator('nav:visible');
  const goalsLink = navigation.getByRole('link', { name: 'Goals', exact: true });
  const habitsLink = navigation.getByRole('link', { name: 'Habits', exact: true });

  await goalsLink.click();
  await expect(page).toHaveURL(/\/goals$/);
  await expect(goalsLink).toHaveAttribute('aria-current', 'page');
  await expect(habitsLink).not.toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('heading', { name: 'Goals', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add a habit', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'New goal', exact: true }).click();
  await page.getByRole('dialog').getByLabel('Name', { exact: true }).fill('A cozy home');
  await page.getByRole('dialog').getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'A cozy home', exact: true })).toBeVisible();

  await habitsLink.click();
  await expect(page).toHaveURL(/\/habits$/);
  await expect(habitsLink).toHaveAttribute('aria-current', 'page');
  await expect(goalsLink).not.toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('heading', { name: 'Habits', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'A cozy home', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'New goal', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Add a habit', exact: true }).click();
  await page.getByRole('dialog').getByLabel('Name', { exact: true }).fill('Take a little walk');
  await page.getByRole('dialog').getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(
    page.getByRole('heading', { name: 'Take a little walk', exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Habits', exact: true })).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Take a little walk', exact: true }),
  ).toBeVisible();
  await page.getByLabel('Archived', { exact: true }).check();

  await goalsLink.click();
  await expect(page.getByLabel('Archived', { exact: true })).not.toBeChecked();
  await expect(page.getByRole('heading', { name: 'A cozy home', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Take a little walk', exact: true })).toHaveCount(
    0,
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});

test('goals can be broken into dated and undated steps, reordered, completed and edited', async ({
  page,
}, testInfo) => {
  await onboard(page);
  await page.goto('/goals');
  await page.getByRole('button', { name: 'New goal', exact: true }).click();
  await page.getByRole('dialog').getByLabel('Name', { exact: true }).fill('A cozy home');
  await page.getByRole('dialog').getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  for (const title of ['Tidy one shelf', 'Get a plant']) {
    await page.getByRole('button', { name: 'Add a step', exact: true }).click();
    await page.getByRole('dialog').getByLabel('Name', { exact: true }).fill(title);
    if (title === 'Tidy one shelf') await page.getByLabel('Date (optional)').fill('2026-01-01');
    await page.getByRole('dialog').getByRole('button', { name: 'Create', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
  }
  const layout = await page.locator('.step-container').evaluateAll((containers) =>
    containers.map((container) => {
      const row = container.querySelector('.task-row')!.getBoundingClientRect();
      const tools = container.querySelector('.step-tools')!.getBoundingClientRect();
      const bounds = container.getBoundingClientRect();
      const buttons = [...container.querySelectorAll('.step-tools button')].map((button) =>
        button.getBoundingClientRect(),
      );
      return (
        tools.top >= row.bottom &&
        tools.bottom < bounds.bottom &&
        buttons.every(
          (button, index) =>
            button.width >= 44 &&
            button.height >= 44 &&
            button.left >= bounds.left &&
            button.right <= bounds.right &&
            (index === 0 || button.left >= buttons[index - 1].right),
        )
      );
    }),
  );
  expect(layout).toEqual([true, true]);
  await page.screenshot({ path: testInfo.outputPath('goal-steps.png'), fullPage: true });
  await page.getByRole('button', { name: 'Move up Get a plant', exact: true }).click();
  await expect(page.locator('.goal-steps .task-copy strong').first()).toHaveText('Get a plant');
  await page.getByRole('button', { name: 'Complete Tidy one shelf', exact: true }).click();
  await serverXp(page, 10);
  await page.getByRole('button', { name: 'Complete Get a plant', exact: true }).click();
  await serverXp(page, 20);
  await expect(page.getByText('Complete', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Edit Get a plant', exact: true }).click();
  await page.getByRole('dialog').getByLabel('Name', { exact: true }).fill('Get a tiny plant');
  await page.getByRole('dialog').getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.getByText('Get a tiny plant', { exact: true })).toBeVisible();
  const archiveButton = page.getByRole('button', { name: 'Archive Get a tiny plant', exact: true });
  await archiveButton.click();
  const archiving = page.getByRole('dialog', { name: 'Archive', exact: true });
  await archiving.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(archiveButton).toBeFocused();
  await expect(page.getByText('Get a tiny plant', { exact: true })).toBeVisible();
  await archiveButton.click();
  await archiving.getByRole('button', { name: 'Archive', exact: true }).click();
  await expect(page.getByText('Get a tiny plant', { exact: true })).toHaveCount(0);
  const saved = await readSnapshot(page);
  expect(saved.document.goals[0].steps.map((step) => step.title)).toEqual([
    'Get a tiny plant',
    'Tidy one shelf',
  ]);
  expect(saved.document.goals[0].steps[0].archivedAt).not.toBeNull();
  expect(Object.values(saved.document.completions)).toHaveLength(2);
  await serverXp(page, 20);
  await page.getByRole('checkbox', { name: 'Archived', exact: true }).check();
  await expect(page.getByRole('heading', { name: 'A cozy home', exact: true })).toBeVisible();
  await expect(page.getByText('Get a tiny plant', { exact: true })).toBeVisible();
  await expect(page.getByText('Tidy one shelf', { exact: true })).toHaveCount(0);
  await expect(page.locator('.step-tools')).toHaveCount(0);
  await page.getByRole('checkbox', { name: 'Archived', exact: true }).uncheck();
  await expect(page.getByText('Get a tiny plant', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Tidy one shelf', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Archive A cozy home', exact: true }).click();
  const confirmation = page.getByRole('dialog', { name: 'Archive', exact: true });
  await confirmation.getByRole('button', { name: 'Archive', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'A cozy home', exact: true })).toHaveCount(0);
  await serverXp(page, 20);
  await page.getByRole('checkbox', { name: 'Archived', exact: true }).check();
  await expect(page.getByText('Get a tiny plant', { exact: true })).toBeVisible();
  await expect(page.getByText('Tidy one shelf', { exact: true })).toBeVisible();
});
test('gift unlock, claiming and achievements', async ({ page }) => {
  await onboard(page);
  const dayRewards = page.getByRole('region', { name: 'Rewards', exact: true });
  await expect(dayRewards.getByRole('link', { name: 'Add a habit' })).toHaveAttribute(
    'href',
    '/habits',
  );
  await addHabit(page);
  await dayRewards.getByRole('button', { name: 'Add a gift', exact: true }).click();
  await page.getByRole('dialog').getByLabel('Name', { exact: true }).fill('New shoes');
  await page.getByLabel('Target', { exact: true }).fill('1');
  await page.getByRole('dialog').getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(dayRewards).toContainText('New shoes');
  await expect(dayRewards).toContainText('Just 1 more completion to unlock this reward.');
  await expect(dayRewards.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0');
  await dayRewards.screenshot({
    path: `test-results/day-rewards-locked-${test.info().project.name}.png`,
  });
  await page.getByRole('button', { name: 'Complete Take a little walk', exact: true }).click();
  await serverXp(page, 10);
  const reached = page.getByRole('region', { name: 'Achievements reached on this day' });
  await expect(reached).toContainText('The first step');
  await expect(reached.getByRole('link', { name: /The first step/ })).toHaveAttribute(
    'href',
    '/achievements',
  );
  await expect(page.getByRole('link', { name: 'See all achievements' })).toHaveAttribute(
    'href',
    '/achievements',
  );
  await expect(dayRewards.getByRole('link', { name: 'See all gifts' })).toHaveAttribute(
    'href',
    '/gifts',
  );
  await expect(page.locator('.achievements-count')).toHaveText('1 / 8');
  await page.screenshot({ path: `test-results/achievements-${test.info().project.name}.png` });
  await expect(dayRewards).toContainText('1 ready');
  await expect(dayRewards.getByRole('progressbar')).toHaveCount(0);
  await dayRewards.screenshot({
    path: `test-results/day-rewards-ready-${test.info().project.name}.png`,
  });
  await page.getByRole('button', { name: 'Previous day', exact: true }).click();
  await expect(reached).toHaveCount(0);
  await dayRewards.getByRole('button', { name: 'I treated myself', exact: true }).click();
  const confirmation = page.getByRole('dialog', { name: 'I treated myself', exact: true });
  await expect(confirmation).toContainText('Mark “New shoes” as claimed?');
  await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dayRewards.getByText('Ready for you', { exact: true })).toBeVisible();
  await dayRewards.getByRole('button', { name: 'I treated myself', exact: true }).click();
  await confirmation.getByRole('button', { name: 'I treated myself', exact: true }).click();
  await expect(dayRewards).toContainText('Your latest treat');
  await expect(dayRewards).toContainText('Enjoyed');
  await expect(dayRewards).toContainText('New shoes');
  await dayRewards.screenshot({
    path: `test-results/day-rewards-claimed-${test.info().project.name}.png`,
  });
  await page.goto('/rewards');
  await expect(page).toHaveURL(/\/gifts$/);
  await expect(page.getByRole('heading', { name: 'Gifts', exact: true })).toBeVisible();
  await expect(page.getByText('Enjoyed', { exact: true })).toBeVisible();
  await expect(page.locator('.badge-card')).toHaveCount(0);
  await expect(page.locator('.stats-row')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Your next little reward' })).toHaveCount(0);
  await page.screenshot({
    path: `test-results/gifts-page-${test.info().project.name}.png`,
    fullPage: true,
  });
  await page
    .locator('nav:visible')
    .getByRole('link', { name: 'Achievements', exact: true })
    .click();
  await expect(page).toHaveURL(/\/achievements$/);
  await expect(page.getByRole('heading', { name: 'Achievements', exact: true })).toBeVisible();
  await expect(page.locator('.badge-card')).toHaveCount(8);
  await expect(page.locator('.badge-card.earned')).toHaveCount(1);
  await expect(page.locator('.gift-card')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Add a gift' })).toHaveCount(0);
  await page.screenshot({
    path: `test-results/achievements-page-${test.info().project.name}.png`,
    fullPage: true,
  });
  await page.reload();
  await expect(page.locator('.badge-card.earned')).toHaveCount(1);
  await page.goto('/');
  await page.getByRole('button', { name: 'Undo Take a little walk', exact: true }).click();
  await serverXp(page, 0);
  await expect(page.getByRole('region', { name: 'Achievements reached on this day' })).toHaveCount(
    0,
  );
  await expect(page.locator('.achievements-count')).toHaveText('0 / 8');
  await page.goto('/gifts');
  await expect(page.getByText('Enjoyed', { exact: true })).toBeVisible();
  await page.goto('/achievements');
  await expect(page.locator('.badge-card.earned')).toHaveCount(0);
  await page.goto('/gifts');
  await page.getByRole('button', { name: 'Archive New shoes', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Archive', exact: true })
    .getByRole('button', { name: 'Archive', exact: true })
    .click();
  await expect(page.getByRole('heading', { name: 'New shoes', exact: true })).toHaveCount(0);
  await page.goto('/');
  await expect(dayRewards).toContainText('What are you looking forward to?');
  await expect(dayRewards.getByRole('button', { name: 'Add a gift' })).toBeVisible();
});

for (const language of ['en', 'de'] as const) {
  test(`day rewards explain partial goals and broken streaks in ${language}`, async ({ page }) => {
    await onboard(page);
    const { document: doc, today } = await readSnapshot(page);
    doc.preferences.language = language;
    doc.preferences.theme = language === 'de' ? 'dark' : 'light';
    const habitId = crypto.randomUUID();
    const goalId = crypto.randomUUID();
    doc.habits = [
      {
        id: habitId,
        title: 'Reading',
        description: '',
        color: 'sage',
        archivedAt: null,
        schedules: [
          {
            from: addDays(today, -4),
            weekdays: [0, 1, 2, 3, 4, 5, 6],
            timezone: doc.preferences.timezone,
          },
        ],
      },
    ];
    doc.goals = [
      {
        id: goalId,
        title: 'A cozy home',
        description: '',
        color: 'lavender',
        archivedAt: null,
        steps: ['Tidy', 'Clean', 'Paint', 'Decorate'].map((title) => ({
          id: crypto.randomUUID(),
          title,
          date: null,
          archivedAt: null,
        })),
      },
    ];
    for (const step of doc.goals[0]!.steps.slice(0, 3)) {
      applyCompletion(doc, {
        operationId: crypto.randomUUID(),
        targetType: 'step',
        targetId: step.id,
        date: today,
        timezone: doc.preferences.timezone,
        completed: true,
        expectedVersion: 0,
      });
    }
    for (const daysAgo of [4, 3]) {
      applyCompletion(doc, {
        operationId: crypto.randomUUID(),
        targetType: 'habit',
        targetId: habitId,
        date: addDays(today, -daysAgo),
        timezone: doc.preferences.timezone,
        completed: true,
        expectedVersion: 0,
      });
    }
    doc.gifts = [
      {
        id: crypto.randomUUID(),
        title: 'A new book',
        targetType: 'habitStreak',
        targetId: habitId,
        threshold: 5,
        archivedAt: null,
        claimedAt: null,
      },
      {
        id: crypto.randomUUID(),
        title: 'A lovely dinner',
        targetType: 'goal',
        targetId: goalId,
        threshold: 1,
        archivedAt: null,
        claimedAt: null,
      },
    ];
    async function seed() {
      const response = await page.request.post('/api/test/seed', {
        headers: { origin: base, 'X-Machbar-User': doc.userId },
        data: doc,
      });
      expect(response.ok()).toBe(true);
      await page.reload();
    }
    await seed();
    const card = page.getByRole('region', {
      name: language === 'de' ? 'Belohnungen' : 'Rewards',
      exact: true,
    });
    await expect(card).toContainText('A lovely dinner');
    await expect(card.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '3');
    await expect(card.getByRole('progressbar')).toHaveAttribute('aria-valuemax', '4');
    await expect(card).toContainText(language === 'de' ? 'Nur noch 1 Schritt' : 'Just 1 more step');
    await expect(card.locator('.day-gift-target')).toHaveAttribute('href', '/goals');
    await card.screenshot({
      path: `test-results/day-rewards-goal-${language}-${test.info().project.name}.png`,
    });
    doc.gifts[1]!.archivedAt = new Date().toISOString();
    await seed();
    await expect(card).toContainText('A new book');
    await expect(card).toContainText(language === 'de' ? 'Beste Serie' : 'Best streak');
    await expect(card).toContainText(language === 'de' ? 'Aktuelle Serie: 0' : 'Current streak: 0');
    await expect(card.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '2');
    await expect(card.getByRole('progressbar')).toHaveAttribute('aria-valuemax', '5');
    await expect(card.locator('.day-gift-target')).toHaveAttribute('href', '/habits');
    await card.screenshot({
      path: `test-results/day-rewards-streak-${language}-${test.info().project.name}.png`,
    });
    doc.gifts.push({
      id: crypto.randomUUID(),
      title: 'A quiet afternoon',
      targetType: 'habitCount',
      targetId: habitId,
      threshold: 2,
      archivedAt: null,
      claimedAt: null,
    });
    await seed();
    await expect(card).toContainText('A quiet afternoon');
    await expect(
      card.getByRole('button', {
        name: language === 'de' ? 'Habe ich mir gegönnt' : 'I treated myself',
      }),
    ).toBeVisible();
    await expect(card.getByRole('progressbar')).toHaveCount(0);
    const accessibility = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
      .analyze();
    expect(accessibility.violations.map((violation) => violation.id)).toEqual([]);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  });
}

test('archive confirmations cancel safely, restore focus and preserve progress', async ({
  page,
}) => {
  const nativeDialogs: string[] = [];
  page.on('dialog', async (dialog) => {
    nativeDialogs.push(dialog.type());
    await dialog.dismiss();
  });
  await onboard(page);
  await addHabit(page);
  await page.getByRole('button', { name: 'Complete Take a little walk', exact: true }).click();
  await serverXp(page, 10);
  await page.goto('/habits');
  const trigger = page.getByRole('button', { name: 'Archive Take a little walk', exact: true });
  const confirmation = page.getByRole('dialog', { name: 'Archive', exact: true });
  await trigger.click();
  await expect(confirmation).toContainText(
    'Archive “Take a little walk”? Your progress history will be kept.',
  );
  await expect(confirmation.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
  const accessibility = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
    .analyze();
  expect(accessibility.violations.map((violation) => violation.id)).toEqual([]);
  await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(confirmation).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await trigger.click();
  await page.keyboard.press('Escape');
  await expect(confirmation).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await trigger.click();
  await page.mouse.click(2, 2);
  await expect(confirmation).toHaveCount(0);
  await expect(trigger).toBeVisible();
  await trigger.click();
  await page.screenshot({ path: `test-results/confirmation-${test.info().project.name}.png` });
  await confirmation.getByRole('button', { name: 'Archive', exact: true }).click();
  await expect(confirmation).toHaveCount(0);
  await expect(trigger).toHaveCount(0);
  await page.getByLabel('Archived', { exact: true }).check();
  await expect(page.getByText('Take a little walk', { exact: true })).toBeVisible();
  await serverXp(page, 10);
  expect(nativeDialogs).toEqual([]);
});

test('the day page hides archived habits, goals and steps on today and past days', async ({
  page,
}) => {
  await onboard(page);
  const { document: doc, today } = await readSnapshot(page);
  const yesterday = addDays(today, -1);
  const habit: Habit = {
    id: crypto.randomUUID(),
    title: 'Active habit',
    description: '',
    color: 'sage',
    schedules: [
      {
        from: addDays(today, -3),
        weekdays: [0, 1, 2, 3, 4, 5, 6],
        timezone: doc.preferences.timezone,
      },
    ],
    archivedAt: null,
  };
  const archivedHabit = { ...habit, id: crypto.randomUUID(), title: 'Archived habit' };
  const uncheckedHabit = { ...habit, id: crypto.randomUUID(), title: 'Archived unchecked habit' };
  doc.habits = [habit, archivedHabit, uncheckedHabit];
  const step = (title: string, date: string | null) => ({
    id: crypto.randomUUID(),
    title,
    date,
    archivedAt: null as string | null,
  });
  const goal = (title: string, steps: ReturnType<typeof step>[] = []) => ({
    id: crypto.randomUUID(),
    title,
    description: '',
    color: 'sage' as const,
    steps,
    archivedAt: null as string | null,
  });
  const archivedDueStep = step('Archived dated step', yesterday);
  const archivedOptionalStep = step('Archived undated step', null);
  const activeGoal = goal('Active goal', [
    step('Active dated step', yesterday),
    step('Active undated step', null),
    archivedDueStep,
    archivedOptionalStep,
  ]);
  const archivedGoal = goal('Archived goal', [
    step('Dated step of archived goal', yesterday),
    step('Undated step of archived goal', null),
  ]);
  const archivedTodayGoal = goal('Archived completed goal');
  const archivedPastGoal = goal('Archived past completed goal');
  doc.goals = [activeGoal, archivedGoal, archivedTodayGoal, archivedPastGoal];
  for (const [type, id, date] of [
    ['habit', archivedHabit.id, today],
    ['habit', archivedHabit.id, yesterday],
    ['step', archivedDueStep.id, today],
    ['step', archivedOptionalStep.id, yesterday],
    ['goal', archivedTodayGoal.id, today],
    ['goal', archivedPastGoal.id, yesterday],
  ] as const) {
    applyCompletion(doc, {
      operationId: crypto.randomUUID(),
      targetType: type,
      targetId: id,
      date,
      timezone: doc.preferences.timezone,
      completed: true,
      expectedVersion: 0,
    });
  }
  const archivedItems = [
    archivedHabit,
    uncheckedHabit,
    archivedDueStep,
    archivedOptionalStep,
    archivedGoal,
    archivedTodayGoal,
    archivedPastGoal,
  ];
  for (const item of archivedItems) item.archivedAt = new Date().toISOString();
  expect(
    (
      await page.request.post('/api/test/seed', {
        headers: { origin: base, 'X-Machbar-User': '00000000-0000-4000-8000-000000000001' },
        data: doc,
      })
    ).ok(),
  ).toBe(true);
  await page.reload();
  for (const date of [today, yesterday]) {
    await expect(page.getByLabel('Selected date', { exact: true })).toHaveAttribute(
      'datetime',
      date,
    );
    for (const item of [...archivedItems, ...archivedGoal.steps]) {
      await expect(page.getByText(item.title, { exact: true })).toHaveCount(0);
    }
    await expect(
      page.getByRole('button', { name: 'Complete Active habit', exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Complete Active dated step', exact: true }),
    ).toBeVisible();
    await expect(page.locator('.daily-hero')).toContainText('0 of 2 challenges');
    if (date === today) {
      await expect(
        page.getByRole('button', { name: 'Complete Active undated step', exact: true }),
      ).toBeVisible();
      await page.getByRole('button', { name: 'Previous day', exact: true }).click();
    }
  }
  expect((await readSnapshot(page)).progress.xp).toBe(60);
});

test('sync errors preserve locally archived data and stay in the background', async ({ page }) => {
  await onboard(page);
  await addHabit(page);
  await page.getByRole('button', { name: 'Complete Take a little walk', exact: true }).click();
  await readSnapshot(page);
  await page.goto('/habits');
  await page.route('**/api/sync', (route) =>
    route.fulfill({ status: 500, json: { code: 'INTERNAL_ERROR' } }),
  );
  const failedSync = page.waitForResponse(
    (response) => response.url().endsWith('/api/sync') && response.status() === 500,
  );
  await page.getByRole('button', { name: 'Archive Take a little walk', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Archive', exact: true })
    .getByRole('button', { name: 'Archive', exact: true })
    .click();
  await failedSync;
  const alert = page.getByRole('alertdialog', { name: 'Something needs your attention' });
  await expect(alert).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Archive Take a little walk', exact: true }),
  ).toHaveCount(0);
  expect((await localEntry(page)).snapshot.document.habits[0].archivedAt).not.toBeNull();
  expect((await localEntry(page)).queue.length).toBeGreaterThan(0);
  await page.unroute('**/api/sync');
  // Manual sync now lives on the sync log page.
  await page.goto('/settings/sync-log');
  await page.getByRole('button', { name: 'Sync now', exact: true }).click();
  expect((await readSnapshot(page)).document.habits[0].archivedAt).not.toBeNull();
});
test('offline reload preserves queued checkoffs and reconnect syncs exactly once', async ({
  page,
  context,
}) => {
  await onboard(page);
  await addHabit(page);
  await serviceWorker(page);
  await context.setOffline(true);
  await page.getByRole('button', { name: 'Complete Take a little walk', exact: true }).click();
  await expect.poll(async () => (await localEntry(page)).queue.length).toBe(1);
  await page.reload();
  await expect(
    page.getByRole('button', { name: 'Undo Take a little walk', exact: true }),
  ).toBeVisible();
  await context.setOffline(false);
  await serverXp(page, 10);
  expect((await localEntry(page)).queue).toHaveLength(0);
  await page.getByRole('button', { name: 'Undo Take a little walk', exact: true }).click();
  await serverXp(page, 0);
});
test('settings apply immediately and persist without a save button', async ({ page }) => {
  await onboard(page);
  await page.goto('/settings');
  await expect(page.getByRole('button', { name: 'Save changes', exact: true })).toHaveCount(0);
  const name = page.getByLabel('What should we call you?');
  await name.clear();
  await page.getByRole('button', { name: 'Dark', exact: true }).click();
  await expect(page.locator('html')).toHaveClass(/dark/);
  await expect(name).toHaveValue('Alex');
  await name.fill('Sam');
  await name.pressSequentially(' Taylor');
  await page.getByLabel('Timezone', { exact: true }).selectOption('UTC');
  await expect
    .poll(async () => (await readSnapshot(page)).document.preferences)
    .toMatchObject({ name: 'Sam Taylor', timezone: 'UTC', theme: 'dark' });
  await name.press('Enter');
  await page.reload();
  await expect(name).toHaveValue('Sam Taylor');
  await expect(page.getByLabel('Timezone', { exact: true })).toHaveValue('UTC');
  await expect(page.locator('html')).toHaveClass(/dark/);
  await page.getByRole('button', { name: 'Light', exact: true }).click();
  await expect(page.locator('html')).not.toHaveClass(/dark/);
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.getByRole('button', { name: 'Follow system', exact: true }).click();
  await expect(page.locator('html')).toHaveClass(/dark/);
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('html')).not.toHaveClass(/dark/);
  await expect(page.getByRole('alert')).toHaveCount(0);
});
test('name saves once after typing pauses and flushes on blur', async ({ page, context }) => {
  await onboard(page);
  await readSnapshot(page);
  await page.goto('/settings');
  await context.setOffline(true);
  const now = new Date();
  await page.clock.install({ time: now });
  // Installing the clock takes real time; pause ahead of it, never in the past.
  await page.clock.pauseAt(new Date(now.getTime() + 1000));
  const name = page.getByLabel('What should we call you?');
  await name.fill('Sam');
  await page.clock.runFor(400);
  expect((await localEntry(page)).queue).toHaveLength(0);
  await name.pressSequentially(' Taylor');
  await page.clock.runFor(400);
  expect((await localEntry(page)).queue).toHaveLength(0);
  await page.clock.runFor(100);
  await expect.poll(async () => (await localEntry(page)).queue.length).toBe(1);
  expect((await localEntry(page)).snapshot.document.preferences.name).toBe('Sam Taylor');
  await name.fill('Sam Smith');
  await page.getByRole('button', { name: 'Dark', exact: true }).click();
  await expect
    .poll(async () => (await localEntry(page)).snapshot.document.preferences)
    .toMatchObject({ name: 'Sam Smith', theme: 'dark' });
  await page.clock.runFor(500);
  expect((await localEntry(page)).queue).toHaveLength(3);
  await name.fill('   ');
  await page.clock.runFor(500);
  expect((await localEntry(page)).queue).toHaveLength(3);
  await name.fill('Sam Smith');
  await page.clock.runFor(500);
  expect((await localEntry(page)).queue).toHaveLength(3);
});
test('settings save automatically offline and sync on reconnect', async ({ page, context }) => {
  await onboard(page);
  await serviceWorker(page);
  await readSnapshot(page);
  await page.goto('/settings');
  await context.setOffline(true);
  await page.getByLabel('What should we call you?').fill('Offline Sam');
  await page.getByLabel('Timezone', { exact: true }).selectOption('UTC');
  await page.getByRole('button', { name: 'Dark', exact: true }).click();
  await page.getByLabel('Language', { exact: true }).selectOption('de');
  const preferences = { name: 'Offline Sam', timezone: 'UTC', theme: 'dark', language: 'de' };
  await expect
    .poll(async () => (await localEntry(page)).snapshot.document.preferences)
    .toMatchObject(preferences);
  expect((await localEntry(page)).queue.length).toBeGreaterThan(0);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Einstellungen', exact: true })).toBeVisible();
  await expect(page.locator('.profile-form input')).toHaveValue('Offline Sam');
  await expect(page.locator('html')).toHaveClass(/dark/);
  await context.setOffline(false);
  await expect
    .poll(async () => (await readSnapshot(page)).document.preferences)
    .toMatchObject(preferences);
});
test('English/German, dark mode and reduced motion', async ({ page }) => {
  await onboard(page);
  await page.goto('/settings');
  await page.getByRole('button', { name: 'Dark', exact: true }).click();
  await page.getByLabel('Language', { exact: true }).selectOption('de');
  await expect(page.getByRole('heading', { name: 'Einstellungen', exact: true })).toBeVisible();
  await expect(page.locator('html')).toHaveClass(/dark/);
  await expect(page.locator('html')).toHaveAttribute('lang', 'de');
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Einstellungen', exact: true })).toBeVisible();
  await page.locator('nav:visible').getByRole('link', { name: 'Geschenke', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Geschenke', exact: true })).toBeVisible();
  await page
    .locator('nav:visible')
    .getByRole('link', { name: 'Auszeichnungen', exact: true })
    .click();
  await expect(page.getByRole('heading', { name: 'Auszeichnungen', exact: true })).toBeVisible();
  await expect(page.locator('.badge-card')).toHaveCount(8);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  expect(
    await page.locator('.floating-check').evaluate((el) => getComputedStyle(el).animationName),
  ).toBe('none');
});
test('install action uses a supported browser prompt and falls back to instructions', async ({
  page,
}) => {
  await onboard(page);
  await page.goto('/settings');
  await page.evaluate(() => {
    const event = new Event('beforeinstallprompt', { cancelable: true }) as Event & {
      prompt: () => Promise<void>;
      userChoice: Promise<{ outcome: string }>;
    };
    event.prompt = async () => {
      document.body.dataset.installPrompt = 'called';
    };
    event.userChoice = Promise.resolve({ outcome: 'accepted' });
    window.dispatchEvent(event);
  });
  await page.getByRole('button', { name: 'Install Machbar', exact: true }).click();
  await expect(page.locator('body')).toHaveAttribute('data-install-prompt', 'called');
  await page.getByRole('button', { name: 'Install Machbar', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Keep small wins close' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
});
test('stale task edits merge automatically with server values winning ties', async ({ page }) => {
  await onboard(page);
  await addHabit(page);
  await page.goto('/habits');
  await page.getByRole('button', { name: 'Edit Take a little walk', exact: true }).click();
  const snapshot = (await readSnapshot(page)).document;
  snapshot.habits[0].title = 'Another device’s title';
  await writeSnapshot(page, snapshot);
  await page.getByRole('dialog').getByLabel('Name', { exact: true }).fill('My title');
  await page.getByRole('dialog').getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect
    .poll(async () => (await readSnapshot(page)).document.habits[0].title)
    .toBe('Another device’s title');
  await expect(page.getByText('Another device’s title', { exact: true })).toBeVisible();
});
test('layout and accessible controls', async ({ page }) => {
  await onboard(page);
  await addHabit(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
    .analyze();
  expect(
    results.violations.map((v) => ({ id: v.id, nodes: v.nodes.map((n) => n.target) })),
  ).toEqual([]);
  await page.screenshot({
    path: `test-results/machbar-${test.info().project.name}.png`,
    fullPage: true,
  });
  const manifest = await (await page.request.get('/manifest.webmanifest')).json();
  expect(manifest.display).toBe('standalone');
  expect(manifest.icons).toHaveLength(3);
  for (const route of ['/goals', '/habits', '/gifts', '/achievements', '/settings']) {
    await page.goto(route);
    await expect(page.locator('.page-heading')).toBeVisible();
    const result = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
      .analyze();
    expect(
      result.violations.map((v) => ({ route, id: v.id, nodes: v.nodes.map((n) => n.target) })),
    ).toEqual([]);
  }
  await page.getByRole('button', { name: 'Dark', exact: true }).click();
  await expect(page.locator('html')).toHaveClass(/dark/);
  for (const route of ['/', '/goals', '/habits', '/gifts', '/achievements', '/settings']) {
    await page.goto(route);
    await expect(page.locator(route === '/' ? '.daily-hero' : '.page-heading')).toBeVisible();
    const result = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
      .analyze();
    expect(
      result.violations.map((v) => ({ route, id: v.id, nodes: v.nodes.map((n) => n.target) })),
    ).toEqual([]);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  }
  await page.goto('/');
  await expect(page.locator('.daily-hero')).toBeVisible();
  await page.screenshot({
    path: `test-results/machbar-${test.info().project.name}-dark.png`,
    fullPage: true,
  });
});
test('conflicting undo automatically keeps a remote recompletion', async ({ page, context }) => {
  await onboard(page);
  await addHabit(page);
  await page.getByRole('button', { name: 'Complete Take a little walk', exact: true }).click();
  await serverXp(page, 10);
  await serviceWorker(page);
  const snapshot = (await readSnapshot(page)).document;
  await context.setOffline(true);
  await page.getByRole('button', { name: 'Undo Take a little walk', exact: true }).click();
  const h = snapshot.habits[0],
    date = Object.values(snapshot.completions)[0].date;
  for (const completed of [false, true]) {
    applyCompletion(snapshot, {
      operationId: crypto.randomUUID(),
      targetType: 'habit',
      targetId: h.id,
      date,
      timezone: snapshot.preferences.timezone,
      completed,
      expectedVersion: Object.values(snapshot.completions)[0].version,
    });
  }
  await writeSnapshot(page, snapshot);
  await context.setOffline(false);
  await serverXp(page, 10);
  await expect(
    page.getByRole('button', { name: 'Undo Take a little walk', exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/This challenge changed on another device/)).toHaveCount(0);
});
test('profile changes preserve pending checkoffs without replaying them into another profile', async ({
  page,
  context,
  browser,
}) => {
  await onboard(page, 'Alice');
  await addHabit(page, 'Alice habit');
  const alice = (await readSnapshot(page)).document.userId;
  const otherContext = await browser.newContext({ locale: 'en-US', storageState: dismissedHints });
  let bob: string;
  try {
    const other = await otherContext.newPage();
    await onboard(other, 'Bob');
    bob = (await readSnapshot(other)).document.userId;
  } finally {
    await otherContext.close();
  }
  const switchTo = async (userId: string) => {
    await page.getByRole('button', { name: 'Profile menu', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Switch User', exact: true }).click();
    await page.getByLabel('Existing user ID').fill(userId);
    await page.getByRole('button', { name: 'Switch profile', exact: true }).click();
    await expect(page.getByLabel('Current user ID')).toHaveValue(userId);
    await page.getByRole('link', { name: 'Today', exact: true }).filter({ visible: true }).click();
  };
  await switchTo(bob);
  await switchTo(alice);
  await serviceWorker(page);
  await context.setOffline(true);
  await page.getByRole('button', { name: 'Complete Alice habit', exact: true }).click();
  await expect.poll(async () => (await localEntry(page)).queue.length).toBe(1);
  // Simulate a profile selection in another tab while this profile has unsynced checkoffs.
  await page.evaluate((id) => localStorage.setItem('machbar-user-id', id), bob);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Hey, Bob', exact: true })).toBeVisible();
  await expect(page.getByText('Alice habit', { exact: true })).toHaveCount(0);
  await context.setOffline(false);
  await serverXp(page, 0);
  await switchTo(alice);
  await expect(page.getByRole('button', { name: 'Undo Alice habit', exact: true })).toBeVisible();
  await serverXp(page, 10);
  const response = await page.request.get('/api/bootstrap', { headers: { 'X-Machbar-User': bob } });
  expect(Object.values((await response.json()).document.completions)).toHaveLength(0);
});
