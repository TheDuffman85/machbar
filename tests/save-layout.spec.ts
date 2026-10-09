import { expect, test, type Page } from '@playwright/test';
import { readSnapshot } from './helpers.js';

test.beforeEach(async ({ request, page }) => {
  await request.post('/api/test/reset', {
    headers: {
      origin: 'http://localhost:3100',
      'X-Machbar-User': '00000000-0000-4000-8000-000000000001',
    },
  });
  await page.goto('/');
  await page.getByLabel('What should we call you?').fill('Alex');
  await page.getByRole('button', { name: 'Let’s begin' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await readSnapshot(page);
});

// Holds uploads until released. `started` resolves once an upload is in flight.
async function holdSync(page: Page) {
  let release!: () => void;
  let start!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const started = new Promise<void>((resolve) => (start = resolve));
  await page.route('**/api/sync', async (route) => {
    start();
    await held;
    await route.continue();
  });
  return { release, started };
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
    const { release, started } = await holdSync(page);
    try {
      // Dispatch without Playwright scrolling the control into view.
      await dark.dispatchEvent('click');
      await started;
      // Sync runs in the background without inserting a notice above the page.
      await expect(page.locator('.notifications .notice')).toHaveCount(0);
      expect(await position(page)).toEqual(before);
      release();
      await readSnapshot(page);
      expect(await position(page)).toEqual(before);
    } finally {
      release();
    }
  });
}

test('checkoffs keep the page in place and sync without a notice or toast', async ({ page }) => {
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
  const { release, started } = await holdSync(page);
  try {
    await complete.click();
    await started;
    const notice = page.locator('.notifications .notice');
    const toast = page.locator('.toast');
    await expect(notice).toHaveCount(0);
    await expect(toast).toHaveCount(0);
    expect((await position(page)).top).toBe(before.top);
    await page.screenshot({
      path: `test-results/save-notifications-${test.info().project.name}.png`,
    });
    release();
    await readSnapshot(page);
    await expect(notice).toHaveCount(0);
    expect((await position(page)).top).toBe(before.top);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      page.viewportSize()!.width,
    );
  } finally {
    release();
  }
});
