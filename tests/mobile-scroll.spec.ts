import { expect, test, type Page } from '@playwright/test';

async function swipeUp(page: Page) {
  const session = await page.context().newCDPSession(page);
  const { width, height } = page.viewportSize()!;
  const x = Math.round(width / 2);
  const startY = Math.round(height * 0.75);
  await session.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x, y: startY }],
  });
  for (let step = 1; step <= 12; step++) {
    await session.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x, y: startY - Math.round((height * 0.5 * step) / 12) }],
    });
    await page.waitForTimeout(20);
  }
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await session.detach();
}

test.beforeEach(async ({ request, isMobile }) => {
  test.skip(!isMobile, 'Verifies mobile touch scrolling');
  await request.post('/test/reset', { headers: { origin: 'http://localhost:3100' } });
});

test('switch-user page scrolls after leaving onboarding', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('link', { name: 'Use an existing profile', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await swipeUp(page);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(100);
  await expect(page.getByLabel('Existing user ID')).toBeInViewport();
});

test('switch-user and settings pages scroll after avatar onboarding', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Edit avatar', exact: true }).click();
  await page.getByRole('button', { name: 'Use this avatar', exact: true }).click();
  await page.getByLabel('What should we call you?').fill('Alex');
  await page.getByRole('button', { name: 'Let’s begin' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  for (const route of ['Switch User', 'Settings']) {
    await page.getByRole('button', { name: 'Profile menu', exact: true }).click();
    await page.getByRole('menuitem', { name: route, exact: true }).click();
    await page.evaluate(() => window.scrollTo(0, 0));
    await swipeUp(page);
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(100);
  }
});

test('closing onboarding and avatar dialogs together releases page scrolling', async ({
  page,
  context,
  browser,
}) => {
  const otherContext = await browser.newContext({ locale: 'en-US' });
  try {
    const other = await otherContext.newPage();
    await other.goto('http://localhost:3100');
    await other.getByLabel('What should we call you?').fill('Existing friend');
    await other.getByRole('button', { name: 'Let’s begin' }).click();
    await expect(other.getByRole('dialog')).toHaveCount(0);
    const id = await other.evaluate(() => localStorage.getItem('machbar-user-id'));

    await page.goto('/');
    await page.getByRole('button', { name: 'Edit avatar', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(2);
    const tab = await context.newPage();
    await tab.goto('/user-id');
    await tab.getByLabel('Existing user ID').fill(id!);
    await tab.getByRole('button', { name: 'Switch profile', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await tab.close();
    await page.getByRole('button', { name: 'Profile menu', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Switch User', exact: true }).click();
    await swipeUp(page);
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(100);
  } finally {
    await otherContext.close();
  }
});
