import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { readSnapshot } from './helpers.js';

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

test('habits, goals, and steps keep their chosen icons through edits, offline saves, and reloads', async ({
  page,
  context,
}) => {
  await page.goto('/');
  await page.getByLabel('What should we call you?').fill('Alex');
  await page.getByRole('button', { name: 'Let’s begin' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await readSnapshot(page);

  await navigate(page, 'Habits');
  await page.getByRole('button', { name: 'Add a habit', exact: true }).first().click();
  let dialog = page.getByRole('dialog');
  await dialog.getByLabel('Name', { exact: true }).fill('Read every day');
  await dialog.getByRole('button', { name: 'Book', exact: true }).click();
  await dialog.getByRole('button', { name: 'Blue', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Book', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()).violations,
  ).toEqual([]);
  await page.screenshot({
    path: `test-results/icon-picker-${test.info().project.name}.png`,
    fullPage: true,
  });
  await save(page);
  const habit = page.locator('.habit-card').filter({ hasText: 'Read every day' });
  await expect(habit.locator('.task-icon.blue [data-entity-icon="book"]')).toBeVisible();

  await navigate(page, 'Goals');
  await page.getByRole('button', { name: 'New goal', exact: true }).first().click();
  dialog = page.getByRole('dialog');
  await dialog.getByLabel('Name', { exact: true }).fill('Get stronger');
  await dialog.getByRole('button', { name: 'Dumbbell', exact: true }).click();
  await save(page);
  const goal = page.locator('.goal-card').filter({ hasText: 'Get stronger' });
  await expect(goal.locator('.goal-card-heading [data-entity-icon="dumbbell"]')).toBeVisible();
  await goal.getByRole('button', { name: 'Add a step', exact: true }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByLabel('Name', { exact: true }).fill('Go for a ride');
  await dialog.getByRole('button', { name: 'Bike', exact: true }).click();
  await save(page);
  await expect(goal.locator('.task-row [data-entity-icon="bike"]')).toBeVisible();
  await readSnapshot(page);

  await context.setOffline(true);
  await goal.getByRole('button', { name: 'Edit Go for a ride', exact: true }).click();
  dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('button', { name: 'Bike', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await dialog.getByRole('button', { name: 'Footprints', exact: true }).click();
  await save(page, 'Save changes');
  await navigate(page, 'Habits');
  await habit.getByRole('button', { name: 'Edit Read every day', exact: true }).click();
  dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('button', { name: 'Book', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await dialog.getByRole('button', { name: 'Coffee', exact: true }).click();
  await save(page, 'Save changes');
  await navigate(page, 'Today');
  await expect(
    page
      .locator('.task-row')
      .filter({ hasText: 'Read every day' })
      .locator('[data-entity-icon="coffee"]'),
  ).toBeVisible();
  await expect(
    page
      .locator('.task-row')
      .filter({ hasText: 'Go for a ride' })
      .locator('[data-entity-icon="footprints"]'),
  ).toBeVisible();
  await context.setOffline(false);
  const snapshot = await readSnapshot(page);
  expect(snapshot.document.habits[0].icon).toBe('coffee');
  expect(snapshot.document.goals[0].icon).toBe('dumbbell');
  expect(snapshot.document.goals[0].steps[0].icon).toBe('footprints');
  await page.reload();
  await expect(
    page
      .locator('.task-row')
      .filter({ hasText: 'Read every day' })
      .locator('[data-entity-icon="coffee"]'),
  ).toBeVisible();
  await navigate(page, 'Goals');
  await goal.getByRole('button', { name: 'Edit Get stronger', exact: true }).click();
  dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('button', { name: 'Dumbbell', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await dialog.getByRole('button', { name: 'Star', exact: true }).click();
  await save(page, 'Save changes');
  await expect(goal.locator('.goal-card-heading [data-entity-icon="star"]')).toBeVisible();
  expect((await readSnapshot(page)).document.goals[0].icon).toBe('star');
});
