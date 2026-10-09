import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { localEntry, readSnapshot, writeSnapshot } from './helpers.js';

const origin = 'http://localhost:3100';
test.beforeEach(async ({ request }) => {
  await request.post('/api/test/reset', {
    headers: { origin, 'X-Machbar-User': '00000000-0000-4000-8000-000000000001' },
  });
});
async function navigate(page: Page, name: string) {
  await page.locator('nav:visible').getByRole('link', { name, exact: true }).click();
}
async function save(page: Page, name = 'Create') {
  await page.getByRole('dialog').getByRole('button', { name, exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
}

test('gifts keep editable notes, links, icons, milestones and archived claims across offline sync and reload', async ({
  page,
  context,
}) => {
  await page.goto('/');
  await page.getByLabel('What should we call you?').fill('Alex');
  await page.getByRole('button', { name: 'Let’s begin' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await navigate(page, 'Habits');
  await page.getByRole('button', { name: 'Add a habit', exact: true }).first().click();
  await page.getByRole('dialog').getByLabel('Name', { exact: true }).fill('Read');
  await save(page);
  await navigate(page, 'Rewards');
  await page.getByLabel('Archived', { exact: true }).check();
  await expect(page.getByText('No archived gifts yet', { exact: true })).toBeVisible();
  await page.getByLabel('Archived', { exact: true }).uncheck();
  await page.getByRole('button', { name: 'Add a gift', exact: true }).click();
  let dialog = page.getByRole('dialog');
  await dialog.getByLabel('Name', { exact: true }).fill('Concert');
  const notes = 'Choose a concert\nhttps://example.com/tickets?show=1&seats=2';
  await dialog.getByLabel('A little more detail (optional)').fill(notes);
  await dialog.getByRole('button', { name: 'Ticket', exact: true }).click();
  await dialog.getByLabel('Target', { exact: true }).fill('7');
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()).violations,
  ).toEqual([]);
  await page.screenshot({
    path: `test-results/gift-form-${test.info().project.name}.png`,
    fullPage: true,
  });
  await save(page);
  let card = page.locator('.gift-card').filter({ hasText: 'Concert' });
  await expect(card.locator('[data-entity-icon="ticket"]')).toBeVisible();
  await expect(card.getByRole('link')).toHaveAttribute(
    'href',
    'https://example.com/tickets?show=1&seats=2',
  );
  await expect(card.locator('.gift-description')).toHaveText(notes);
  await readSnapshot(page);
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });

  await context.setOffline(true);
  await card.getByRole('button', { name: 'Edit Concert', exact: true }).click();
  dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel('A little more detail (optional)')).toHaveValue(notes);
  await expect(dialog.getByRole('button', { name: 'Ticket', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(dialog.getByLabel('Target', { exact: true })).toHaveValue('7');
  await dialog.getByLabel('Name', { exact: true }).fill('Birthday cake');
  await dialog
    .getByLabel('A little more detail (optional)')
    .fill('Chocolate cake\nhttps://example.com/cake');
  await dialog.getByRole('button', { name: 'Cake', exact: true }).click();
  await dialog.getByLabel('Unlock this gift when…').selectOption('habitStreak');
  await dialog.getByLabel('Target', { exact: true }).fill('1');
  await save(page, 'Save changes');
  await page.reload();
  card = page.locator('.gift-card').filter({ hasText: 'Birthday cake' });
  await expect(card.locator('[data-entity-icon="cake"]')).toBeVisible();
  await navigate(page, 'Today');
  await expect(page.locator('.next-gift-card [data-entity-icon="cake"]')).toBeVisible();
  await expect(page.locator('.next-gift-card .gift-description')).toHaveText(
    'Chocolate cake\nhttps://example.com/cake',
  );
  await page.getByRole('button', { name: 'Complete Read', exact: true }).click();
  await navigate(page, 'Rewards');
  await card.getByRole('button', { name: 'I treated myself', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'I treated myself', exact: true })
    .click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const claimedAt = (await localEntry(page)).snapshot.document.gifts[0]!.claimedAt;
  await card.getByRole('button', { name: 'Edit Birthday cake', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByLabel('A little more detail (optional)')
    .fill('Enjoyed it!\nhttps://example.com/cake');
  await save(page, 'Save changes');
  await card.getByRole('button', { name: 'Archive Birthday cake', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Archive', exact: true }).click();
  await expect(card).toHaveCount(0);
  await page.getByLabel('Archived', { exact: true }).check();
  await expect(card).toBeVisible();
  await expect(card.locator('.claimed-label')).toBeVisible();
  await expect(card.getByRole('button')).toHaveCount(0);
  await expect(card.getByRole('link')).toHaveAttribute('href', 'https://example.com/cake');
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()).violations,
  ).toEqual([]);
  await page.screenshot({
    path: `test-results/gifts-archive-${test.info().project.name}.png`,
    fullPage: true,
  });
  await context.setOffline(false);
  const synced = await readSnapshot(page);
  expect(synced.document.gifts[0]).toMatchObject({
    title: 'Birthday cake',
    icon: 'cake',
    description: 'Enjoyed it!\nhttps://example.com/cake',
    targetType: 'habitStreak',
    threshold: 1,
    claimedAt,
  });
  expect(synced.document.gifts[0]!.archivedAt).not.toBeNull();
  await page.reload();
  await page.getByLabel('Archived', { exact: true }).check();
  await expect(card.locator('[data-entity-icon="cake"]')).toBeVisible();
  await expect(card.locator('.gift-description')).toHaveText(
    'Enjoyed it!\nhttps://example.com/cake',
  );
  await page.getByLabel('Archived', { exact: true }).uncheck();
  await expect(card).toHaveCount(0);
});

test('legacy gifts default to a gift icon and can be edited with an archived goal before changing to a habit', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByLabel('What should we call you?').fill('Alex');
  await page.getByRole('button', { name: 'Let’s begin' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const { document } = await readSnapshot(page);
  const goalId = crypto.randomUUID(),
    habitId = crypto.randomUUID(),
    giftId = crypto.randomUUID();
  const claimedAt = '2026-10-08T12:00:00Z';
  document.goals.push({
    id: goalId,
    title: 'Old goal',
    color: 'sage',
    description: '',
    steps: [],
    archivedAt: claimedAt,
  });
  document.habits.push({
    id: habitId,
    title: 'New habit',
    color: 'sage',
    description: '',
    archivedAt: null,
    schedules: [
      {
        from: '2026-01-01',
        timezone: document.preferences.timezone,
        weekdays: [0, 1, 2, 3, 4, 5, 6],
      },
    ],
  });
  document.gifts.push({
    id: giftId,
    title: 'Old reward',
    targetType: 'goal',
    targetId: goalId,
    threshold: 1,
    archivedAt: null,
    claimedAt,
  });
  await writeSnapshot(page, document);
  await page.reload();
  await navigate(page, 'Rewards');
  const card = page.locator('.gift-card');
  await expect(card.locator('[data-entity-icon="gift"]')).toBeVisible();
  await card.getByRole('button', { name: 'Edit Old reward', exact: true }).click();
  let dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel('Choose a goal')).toHaveValue(goalId);
  await expect(dialog.getByLabel('A little more detail (optional)')).toHaveValue('');
  await expect(dialog.getByRole('button', { name: 'Gift', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await dialog.getByLabel('A little more detail (optional)').fill('Remember this reward');
  await save(page, 'Save changes');
  let saved = (await readSnapshot(page)).document.gifts[0]!;
  expect(saved).toMatchObject({
    targetType: 'goal',
    targetId: goalId,
    claimedAt,
    description: 'Remember this reward',
  });
  await card.getByRole('button', { name: 'Edit Old reward', exact: true }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByLabel('Unlock this gift when…').selectOption('habitCount');
  await expect(dialog.getByLabel('Choose a habit')).toHaveValue(habitId);
  await dialog.getByLabel('Target', { exact: true }).fill('5');
  await dialog.getByRole('button', { name: 'Shopping bag', exact: true }).click();
  await save(page, 'Save changes');
  saved = (await readSnapshot(page)).document.gifts[0]!;
  expect(saved).toMatchObject({
    targetType: 'habitCount',
    targetId: habitId,
    threshold: 5,
    claimedAt,
    icon: 'shoppingBag',
  });
  await expect(card.locator('[data-entity-icon="shoppingBag"]')).toBeVisible();
});
