import { readSnapshot } from './helpers.js';
import { expect, test, type Page } from '@playwright/test';
import { addDays, completionKey, type Bootstrap } from '../packages/shared/src/index.js';

const base = 'http://localhost:3100';

async function onboard(page: Page) {
  await page.request.post('/test/reset', { headers: { origin: base } });
  await page.goto('/');
  await page.getByLabel('What should we call you?').fill('Alex');
  await page.getByRole('button', { name: 'Let’s begin' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
}

test('earned level changes and undo update the plant automatically', async ({ page }) => {
  await onboard(page);
  await page.getByRole('button', { name: 'Add a habit', exact: true }).first().click();
  await page.getByRole('dialog').getByLabel('Name', { exact: true }).fill('Water my plant');
  await page.getByRole('dialog').getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const snapshot = (await readSnapshot(page)) as Bootstrap;
  const habit = snapshot.document.habits[0];
  habit.schedules[0].from = addDays(snapshot.today, -9);
  for (let day = 1; day <= 9; day++) {
    const date = addDays(snapshot.today, -day);
    snapshot.document.completions[completionKey('habit', habit.id, date)] = {
      key: completionKey('habit', habit.id, date),
      targetType: 'habit',
      targetId: habit.id,
      date,
      timezone: snapshot.document.preferences.timezone,
      completed: true,
      version: 1,
      updatedAt: new Date().toISOString(),
    };
  }
  expect(
    (
      await page.request.post('/test/seed', { headers: { origin: base }, data: snapshot.document })
    ).ok(),
  ).toBe(true);
  await page.reload();
  const plant = page.locator('.daily-hero .sprout-art');
  await expect(plant).toHaveAttribute('data-level', '1');
  await page.getByRole('button', { name: 'Complete Water my plant', exact: true }).click();
  await expect(plant).toHaveAttribute('data-level', '2');
  await expect(plant.locator('.plant-leaf')).toHaveCount(2);
  await page.reload();
  await expect(plant).toHaveAttribute('data-level', '2');
  await page.getByRole('button', { name: 'Undo Water my plant', exact: true }).click();
  await expect(plant).toHaveAttribute('data-level', '1');
});
