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
  const growth = page.locator('.hero-growth');
  const ring = growth.getByRole('progressbar');
  await expect(growth.locator('strong')).toHaveText('Level 1');
  await expect(growth.locator('.hero-total-xp')).toHaveText('Total XP: 0 XP');
  await expect(growth.locator('.hero-next-level')).toHaveText('100 XP to the next level');
  await expect(ring).toHaveAccessibleName('Level 1 · Progress');
  await expect(ring).toHaveAttribute('aria-valuenow', '0');
  await expect(ring).toHaveAttribute('aria-valuemin', '0');
  await expect(ring).toHaveAttribute('aria-valuemax', '100');
  await expect(growth.locator('.hero-ring-fill')).toHaveAttribute('visibility', 'hidden');
  await expect(page.locator('.level-card')).toHaveCount(0);
  await page.locator('nav:visible').getByRole('link', { name: 'Habits', exact: true }).click();
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
  await page.goto('/');
  const plant = page.locator('.daily-hero .sprout-art');
  await expect(plant).toHaveAttribute('data-level', '1');
  await expect(plant).toHaveAccessibleName('Level 1 plant with 1 leaves and 0 blossom petals');
  await expect(growth.locator('.hero-total-xp')).toHaveText('Total XP: 90 XP');
  await expect(growth.locator('.hero-next-level')).toHaveText('10 XP to the next level');
  await expect(ring).toHaveAttribute('aria-valuenow', '90');
  await expect(growth.locator('.hero-ring-fill')).toHaveAttribute('stroke-dashoffset', '10');
  await expect(growth.locator('.hero-ring-fill')).toHaveAttribute('visibility', 'visible');
  const bannerLayout = () =>
    page.locator('.daily-hero').evaluate((hero) =>
      [hero, ...hero.querySelectorAll('.hero-copy p, .hero-plant-ring, .hero-level-copy')].map(
        (element) => {
          const { x, y, width, height } = element.getBoundingClientRect();
          return { x: x + window.scrollX, y: y + window.scrollY, width, height };
        },
      ),
    );
  const initialLayout = await bannerLayout();
  await page.getByRole('button', { name: 'Complete Water my plant', exact: true }).click();
  await expect(plant).toHaveAttribute('data-level', '2');
  await expect(plant.locator('.plant-leaf')).toHaveCount(2);
  await expect(growth.locator('strong')).toHaveText('Level 2');
  await expect(growth.locator('.hero-total-xp')).toHaveText('Total XP: 100 XP');
  await expect(growth.locator('.hero-next-level')).toHaveText('100 XP to the next level');
  await expect(ring).toHaveAccessibleName('Level 2 · Progress');
  await expect(ring).toHaveAttribute('aria-valuenow', '0');
  await expect(page.locator('.hero-copy p span')).toHaveText('10 XP');
  expect(await bannerLayout()).toEqual(initialLayout);
  await page.reload();
  await expect(plant).toHaveAttribute('data-level', '2');
  await expect(ring).toHaveAttribute('aria-valuenow', '0');
  await page.getByRole('button', { name: 'Undo Water my plant', exact: true }).click();
  await expect(plant).toHaveAttribute('data-level', '1');
  await expect(growth.locator('strong')).toHaveText('Level 1');
  await expect(growth.locator('.hero-total-xp')).toHaveText('Total XP: 90 XP');
  await expect(growth.locator('.hero-next-level')).toHaveText('10 XP to the next level');
  await expect(ring).toHaveAttribute('aria-valuenow', '90');
  expect(await bannerLayout()).toEqual(initialLayout);
});
