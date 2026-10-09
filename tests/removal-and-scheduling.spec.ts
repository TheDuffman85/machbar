import { expect, test, type Page } from '@playwright/test';
import { AxeBuilder } from '@axe-core/playwright';
import { addDays } from '../packages/shared/src/index.js';
import { localEntry, readSnapshot } from './helpers.js';
const base = 'http://localhost:3100';
test.beforeEach(async ({ request }) => {
  await request.post(`${base}/api/test/reset`, {
    headers: { origin: base, 'X-Machbar-User': '00000000-0000-4000-8000-000000000001' },
  });
});
async function onboard(page: Page) {
  await page.goto('/');
  await page.getByLabel('What should we call you?').fill('Alex');
  await page.getByRole('button', { name: 'Let’s begin' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  return readSnapshot(page);
}
async function create(page: Page, button: string, title: string) {
  await page.getByRole('button', { name: button, exact: true }).first().click();
  await page.getByRole('dialog').getByLabel('Name', { exact: true }).fill(title);
  await page.getByRole('dialog').getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
}
async function remove(page: Page, title: string, label: 'Delete' | 'Archive') {
  await page.getByRole('button', { name: `${label} ${title}`, exact: true }).click();
  await page
    .getByRole('dialog', { name: label, exact: true })
    .getByRole('button', { name: label, exact: true })
    .click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: `${label} ${title}`, exact: true })).toHaveCount(0);
}

test('unused items delete offline while undone logs can only be archived', async ({
  page,
  context,
}) => {
  await onboard(page);
  await page.goto('/habits');
  await create(page, 'Add a habit', 'Unused walk');
  await readSnapshot(page);
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller)
      await new Promise<void>((resolve) =>
        navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), {
          once: true,
        }),
      );
  });
  await context.setOffline(true);
  const trigger = page.getByRole('button', { name: 'Delete Unused walk', exact: true });
  await trigger.click();
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(trigger).toBeFocused();
  await remove(page, 'Unused walk', 'Delete');
  await page.reload();
  expect((await localEntry(page)).snapshot.document.habits).toEqual([]);
  await page.getByLabel('Archived', { exact: true }).check();
  await expect(page.getByText('Unused walk', { exact: true })).toHaveCount(0);
  await page.getByLabel('Archived', { exact: true }).uncheck();
  await create(page, 'Add a habit', 'Logged walk');
  await page.goto('/');
  await page.getByRole('button', { name: 'Complete Logged walk', exact: true }).click();
  await page.getByRole('button', { name: 'Undo Logged walk', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Complete Logged walk', exact: true }),
  ).toBeVisible();
  await page.goto('/habits');
  await expect(page.getByRole('button', { name: 'Delete Logged walk', exact: true })).toHaveCount(
    0,
  );
  await remove(page, 'Logged walk', 'Archive');
  await page.goto('/goals');
  await create(page, 'New goal', 'Unused home');
  await create(page, 'Add a step', 'Unused shelf');
  await create(page, 'Add a step', 'Unused plant');
  await remove(page, 'Unused shelf', 'Delete');
  await page.goto('/gifts');
  await create(page, 'Add a gift', 'Unused treat');
  await page.goto('/goals');
  await remove(page, 'Unused home', 'Delete');
  await page.reload();
  const local = (await localEntry(page)).snapshot.document;
  expect(local.goals).toEqual([]);
  expect(local.gifts).toEqual([]);
  expect(local.habits[0]!.archivedAt).not.toBeNull();
  expect(Object.values(local.completions)).toHaveLength(1);
  await context.setOffline(false);
  const synced = await readSnapshot(page);
  expect(synced.document.goals).toEqual([]);
  expect(synced.document.gifts).toEqual([]);
  expect(synced.document.habits).toHaveLength(1);
  expect(synced.progress.xp).toBe(0);
});

test('goal dates and goal/step reminders save, edit, clear and schedule Today tasks', async ({
  page,
}, info) => {
  const { today } = await onboard(page);
  await page.goto('/goals');
  await page.getByRole('button', { name: 'New goal', exact: true }).click();
  const form = page.getByRole('dialog');
  await form.getByLabel('Name', { exact: true }).fill('Dated goal');
  await form.getByLabel('Date (optional)', { exact: true }).fill(addDays(today, 1));
  await form.getByLabel('Remind me about this task').check();
  await form.getByLabel('Reminder time', { exact: true }).fill('09:45');
  const accessibility = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
    .analyze();
  expect(accessibility.violations.map((violation) => violation.id)).toEqual([]);
  await page.screenshot({ path: info.outputPath('goal-reminder-form.png'), fullPage: true });
  await form.getByRole('button', { name: 'Create', exact: true }).click();
  await create(page, 'New goal', 'Goal with steps');
  const card = page
    .locator('.goal-card')
    .filter({ has: page.getByRole('heading', { name: 'Goal with steps', exact: true }) });
  await card.getByRole('button', { name: 'Add a step', exact: true }).click();
  await form.getByLabel('Name', { exact: true }).fill('Dated step');
  await form.getByLabel('Date (optional)', { exact: true }).fill(addDays(today, -1));
  await form.getByLabel('Remind me about this task').check();
  await form.getByLabel('Reminder time', { exact: true }).fill('10:30');
  await form.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(form).toHaveCount(0);
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Complete Dated goal', exact: true })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole('button', { name: 'Complete Dated step', exact: true }),
  ).toBeVisible();
  await page.goto('/goals');
  await page.getByRole('button', { name: 'Edit Dated goal', exact: true }).click();
  await expect(form.getByLabel('Date (optional)', { exact: true })).toHaveValue(addDays(today, 1));
  await expect(form.getByLabel('Reminder time', { exact: true })).toHaveValue('09:45');
  await form.getByLabel('Date (optional)', { exact: true }).fill(today);
  await form.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(form).toHaveCount(0);
  await page.goto('/');
  await expect(page.locator('.daily-hero')).toContainText('0 of 2 challenges');
  await page.getByRole('button', { name: 'Complete Dated goal', exact: true }).click();
  await page.getByRole('button', { name: 'Complete Dated step', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Undo Dated step', exact: true })).toBeVisible();
  const saved = await readSnapshot(page);
  expect(saved.progress.xp).toBe(20);
  expect(saved.document.goals[0]).toMatchObject({ date: today, reminderTime: '09:45' });
  expect(saved.document.goals[1]!.steps[0]).toMatchObject({
    date: addDays(today, -1),
    reminderTime: '10:30',
  });
  await page.goto('/goals');
  await page.reload();
  await page.getByRole('button', { name: 'Edit Dated step', exact: true }).click();
  await expect(form.getByLabel('Reminder time', { exact: true })).toHaveValue('10:30');
  await form.getByLabel('Date (optional)', { exact: true }).fill('');
  await form.getByLabel('Remind me about this task').uncheck();
  await form.getByRole('button', { name: 'Save changes', exact: true }).click();
  await page.getByRole('button', { name: 'Edit Dated goal', exact: true }).click();
  await form.getByLabel('Date (optional)', { exact: true }).fill('');
  await form.getByLabel('Remind me about this task').uncheck();
  await form.getByRole('button', { name: 'Save changes', exact: true }).click();
  const cleared = await readSnapshot(page);
  expect(cleared.document.goals[0]).toMatchObject({ date: null, reminderTime: null });
  expect(cleared.document.goals[1]!.steps[0]).toMatchObject({ date: null, reminderTime: null });
  expect(cleared.progress.xp).toBe(20);
});
