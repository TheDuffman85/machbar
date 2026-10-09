import { expect, test } from '@playwright/test';

const base = 'http://localhost:3100';
// Every other spec starts with the hints dismissed; this one starts fresh.
test.use({ storageState: { cookies: [], origins: [] } });
test.beforeEach(async ({ request }) => {
  await request.post(`${base}/api/test/reset`, {
    headers: { origin: base, 'X-Machbar-User': '00000000-0000-4000-8000-000000000001' },
  });
});

test('the install hint appears once after onboarding and stays dismissed', async ({ page }) => {
  await page.goto('/');
  const hint = page.getByRole('status').filter({ hasText: 'Install Machbar' });
  await expect(page.getByLabel('What should we call you?')).toBeVisible();
  await expect(hint).toHaveCount(0);
  await page.getByLabel('What should we call you?').fill('Alex');
  await page.getByRole('button', { name: 'Let’s begin' }).click();
  await expect(hint).toBeVisible();
  await hint.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(hint).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Hey, Alex' })).toBeVisible();
  await expect(hint).toHaveCount(0);
});
