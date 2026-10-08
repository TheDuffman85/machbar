import { expect, test, type Page } from '@playwright/test';

async function expectFitsViewport(page: Page) {
  const viewport = await page.evaluate(() => ({
    width: document.documentElement.scrollWidth,
    viewport: document.documentElement.clientWidth,
    scale: window.visualViewport?.scale,
  }));
  expect(viewport.width).toBeLessThanOrEqual(viewport.viewport);
  expect(viewport.scale).toBe(1);
}

async function expectReadableControls(page: Page) {
  const controls = page.locator(
    'input:not([type="checkbox"]):not([type="file"]):visible, select:visible, textarea:visible',
  );
  await expect(controls.first()).toBeVisible();
  const sizes = await controls.evaluateAll((elements) =>
    elements.map((element) => parseFloat(getComputedStyle(element).fontSize)),
  );
  for (const size of sizes) {
    expect(size).toBeGreaterThanOrEqual(16);
  }
  await expectFitsViewport(page);
}

test.beforeEach(async ({ request, page, isMobile }) => {
  test.skip(!isMobile, 'Verifies mobile form sizing and touch navigation');
  await request.post('/api/test/reset', {
    headers: {
      origin: 'http://localhost:3100',
      'X-Machbar-User': '00000000-0000-4000-8000-000000000001',
    },
  });
  await page.goto('/');
});

async function onboard(page: Page) {
  await page.getByLabel('What should we call you?').fill('Alex');
  await page.getByRole('button', { name: 'Let’s begin' }).tap();
  await expect(page.getByRole('dialog')).toHaveCount(0);
}

test('profile menu supports taps, dismissal, and keyboard navigation', async ({ page }) => {
  await onboard(page);
  const trigger = page.getByRole('button', { name: 'Profile menu', exact: true });
  const menu = page.getByRole('menu');

  for (const route of ['Settings', 'Switch User']) {
    await trigger.tap();
    await expect(menu).toBeVisible();
    await page.getByRole('menuitem', { name: route, exact: true }).tap();
    await expect(page.getByRole('heading', { name: route, exact: true })).toBeVisible();
    await expect(menu).toHaveCount(0);
    await expectFitsViewport(page);
  }

  await trigger.tap();
  await trigger.tap();
  await expect(menu).toHaveCount(0);
  await trigger.tap();
  await page.locator('.mobile-brand').tap();
  await expect(menu).toHaveCount(0);

  await trigger.focus();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('menuitem', { name: 'Settings', exact: true })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('menuitem', { name: 'Switch User', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('End');
  await page.keyboard.press('Tab');
  await expect(menu).toHaveCount(0);
});

test('a menu tap can clear focus without dismissing its navigation links', async ({ page }) => {
  await onboard(page);
  await page.getByRole('button', { name: 'Profile menu', exact: true }).tap();
  const settings = page.getByRole('menuitem', { name: 'Settings', exact: true });
  await expect(settings).toBeFocused();
  // iOS can clear focus with a null relatedTarget before delivering the link's click.
  await settings.evaluate((element: HTMLElement) => element.blur());
  await expect(page.getByRole('menu')).toBeVisible();
  await page.getByRole('menuitem', { name: 'Switch User', exact: true }).tap();
  await expect(page.getByRole('heading', { name: 'Switch User', exact: true })).toBeVisible();
});

test('forms stay readable and fit the viewport from onboarding through editing', async ({
  page,
}) => {
  await expectReadableControls(page);
  await page.getByRole('button', { name: 'Edit avatar', exact: true }).tap();
  await expectReadableControls(page);
  await page.getByRole('button', { name: 'Use this avatar', exact: true }).tap();
  await onboard(page);

  for (const route of ['Settings', 'Switch User']) {
    await page.getByRole('button', { name: 'Profile menu', exact: true }).tap();
    await page.getByRole('menuitem', { name: route, exact: true }).tap();
    await expect(page.getByRole('heading', { name: route, exact: true })).toBeVisible();
    await expectReadableControls(page);
  }
  await page.getByLabel('Existing user ID').tap();
  await expectFitsViewport(page);
  await page.getByRole('heading', { name: 'Switch User', exact: true }).tap();
  await expectFitsViewport(page);

  for (const route of ['Today', 'Habits', 'Goals', 'Rewards']) {
    const link = page.locator('nav:visible').getByRole('link', { name: route, exact: true });
    await link.tap();
    await expect(link).toHaveAttribute('aria-current', 'page');
    await expectFitsViewport(page);
  }
  await page.locator('nav:visible').getByRole('link', { name: 'Habits', exact: true }).tap();
  await page.getByRole('button', { name: 'Add a habit', exact: true }).first().tap();
  await expectReadableControls(page);
  await page.getByRole('button', { name: 'Close', exact: true }).tap();

  const portrait = page.viewportSize()!;
  await page.setViewportSize({ width: portrait.height, height: portrait.width });
  for (const route of ['Settings', 'Switch User']) {
    await page.getByRole('button', { name: 'Profile menu', exact: true }).tap();
    await page.getByRole('menuitem', { name: route, exact: true }).tap();
    await expect(page.getByRole('heading', { name: route, exact: true })).toBeVisible();
    await expectReadableControls(page);
  }
});

test('notification settings explain iOS installation and fit mobile screens', async ({ page }) => {
  await onboard(page);
  await page.getByRole('button', { name: 'Profile menu', exact: true }).tap();
  await page.getByRole('menuitem', { name: 'Settings', exact: true }).tap();
  await expect(page.getByRole('heading', { name: 'Notifications', exact: true })).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Enable notifications', exact: true }),
  ).toBeDisabled();
  if (test.info().project.name === 'iphone') {
    await expect(page.getByText(/^On iPhone and iPad \(iOS 16\.4 or later\)/)).toBeVisible();
  }
  await expectFitsViewport(page);
  await page.locator('nav:visible').getByRole('link', { name: 'Habits', exact: true }).tap();
  await page.getByRole('button', { name: 'Add a habit', exact: true }).first().tap();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('checkbox', { name: 'Remind me about this habit', exact: true }).check();
  await expect(dialog.getByLabel('Reminder time', { exact: true })).toHaveValue('09:00');
  await expectReadableControls(page);
  await dialog.getByLabel('Reminder time', { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({
    path: `test-results/reminder-form-${test.info().project.name}.png`,
    fullPage: true,
  });
});
