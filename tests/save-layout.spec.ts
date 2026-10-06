import { expect, test, type Page } from '@playwright/test';
import { readSnapshot } from './helpers.js';

test.beforeEach(async ({ request, page }) => {
  await request.post('/test/reset', { headers: { origin: 'http://localhost:3100' } });
  await page.goto('/');
  await page.getByLabel('What should we call you?').fill('Alex');
  await page.getByRole('button', { name: 'Let’s begin' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await readSnapshot(page);
});

async function holdSync(page: Page) {
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route('**/api/sync', async (route) => {
    await held;
    await route.continue();
  });
  return release;
}

async function position(page: Page) {
  return page.locator('.page-heading').evaluate((heading) => ({
    top: heading.getBoundingClientRect().top + window.scrollY,
    scroll: window.scrollY,
    height: document.documentElement.scrollHeight,
  }));
}

for (const scrolled of [false, true]) {
  test(`settings stay in place while saving ${scrolled ? 'after scrolling' : 'at the top'}`, async ({
    page,
  }) => {
    await page.setViewportSize({ ...page.viewportSize()!, height: 600 });
    await page.goto('/settings');
    const dark = page.getByRole('button', { name: 'Dark', exact: true });
    if (scrolled) await dark.scrollIntoViewIfNeeded();
    else await page.evaluate(() => window.scrollTo(0, 0));
    const before = await position(page);
    if (scrolled) expect(before.scroll).toBeGreaterThan(0);
    const release = await holdSync(page);
    try {
      // Dispatch without Playwright scrolling the control into view.
      await dark.dispatchEvent('click');
      await expect(page.getByText('Syncing your changes…', { exact: true })).toBeVisible();
      expect(await position(page)).toEqual(before);
      release();
      await readSnapshot(page);
      await expect(page.getByText('Syncing your changes…', { exact: true })).toHaveCount(0);
      expect(await position(page)).toEqual(before);
    } finally {
      release();
    }
  });
}

test('checkoffs keep the page in place and show celebration alongside sync status', async ({
  page,
}) => {
  await page.locator('nav:visible').getByRole('link', { name: 'Habits', exact: true }).click();
  await page.getByRole('button', { name: 'Add a habit', exact: true }).first().click();
  await page.getByRole('dialog').getByLabel('Name', { exact: true }).fill('Take a walk');
  await page.getByRole('dialog').getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await readSnapshot(page);
  await page.locator('nav:visible').getByRole('link', { name: 'Today', exact: true }).click();
  const complete = page.getByRole('button', { name: 'Complete Take a walk', exact: true });
  await complete.scrollIntoViewIfNeeded();
  const before = await position(page);
  const release = await holdSync(page);
  try {
    await complete.click();
    const sync = page.locator('.notice').filter({ hasText: 'Syncing your changes…' });
    const toast = page.locator('.toast');
    await expect(sync).toBeVisible();
    await expect(toast).toBeVisible();
    expect((await position(page)).top).toBe(before.top);
    const syncBox = (await sync.boundingBox())!;
    const toastBox = (await toast.boundingBox())!;
    expect(toastBox.y + toastBox.height).toBeLessThanOrEqual(syncBox.y);
    await page.screenshot({
      path: `test-results/save-notifications-${test.info().project.name}.png`,
    });
    release();
    await readSnapshot(page);
    await expect(sync).toHaveCount(0);
    expect((await position(page)).top).toBe(before.top);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      page.viewportSize()!.width,
    );
  } finally {
    release();
  }
});
