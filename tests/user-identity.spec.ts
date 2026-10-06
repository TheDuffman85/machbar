import { expect, test, type Page } from '@playwright/test';
import { AxeBuilder } from '@axe-core/playwright';
import { readSnapshot } from './helpers.js';

const base = 'http://localhost:3100';
test.beforeEach(async ({ request }) => {
  await request.post(`${base}/test/reset`, { headers: { origin: base } });
});

async function onboard(page: Page, name: string) {
  await page.goto(base);
  await page.getByLabel('What should we call you?').fill(name);
  await page.getByRole('button', { name: 'Let’s begin' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
}

async function openIdentity(page: Page) {
  await page.getByRole('button', { name: 'Profile menu', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Switch User', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Switch User', exact: true })).toBeVisible();
}

test('a previously stored special local ID is replaced with a persistent UUID', async ({
  page,
}) => {
  await page.addInitScript(() => {
    if (!localStorage.getItem('machbar-user-id')) localStorage.setItem('machbar-user-id', 'local');
  });
  await onboard(page, 'New user');
  const id = (await readSnapshot(page)).document.userId;
  expect(id).toMatch(/^[a-f0-9-]{36}$/);
  await openIdentity(page);
  await expect(page.getByLabel('Current user ID')).toHaveValue(id);
  await page.reload();
  await expect(page.getByLabel('Current user ID')).toHaveValue(id);
  expect(await page.evaluate(() => localStorage.getItem('machbar-user-id'))).toBe(id);
});

test('browser IDs persist, isolate progress, and can switch manually or by QR image', async ({
  page,
  browser,
}) => {
  await onboard(page, 'Alice');
  const alice = (await readSnapshot(page)).document.userId;
  expect(alice).toMatch(/^[a-f0-9-]{36}$/);
  await page.locator('nav:visible').getByRole('link', { name: 'Habits', exact: true }).click();
  await page.getByRole('button', { name: 'Add a habit', exact: true }).first().click();
  await page.getByRole('dialog').getByLabel('Name', { exact: true }).fill('Alice’s habit');
  await page.getByRole('dialog').getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await openIdentity(page);
  await expect(page.getByLabel('Current user ID')).toHaveValue(alice);
  const image = page.getByRole('img', { name: 'QR code for your user ID' });
  await expect(image).toHaveAttribute('src', /^data:image\/png;base64,/);
  const qr = (await image.getAttribute('src'))!;
  await page.reload();
  await expect(page.getByLabel('Current user ID')).toHaveValue(alice);
  expect((await readSnapshot(page)).document.habits[0].title).toBe('Alice’s habit');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const accessibility = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  expect(accessibility.violations).toEqual([]);
  await page.screenshot({
    path: `test-results/user-id-${test.info().project.name}.png`,
    fullPage: true,
  });

  const otherContext = await browser.newContext({ locale: 'en-US' });
  try {
    const other = await otherContext.newPage();
    await onboard(other, 'Bob');
    const bob = (await readSnapshot(other)).document.userId;
    expect(bob).not.toBe(alice);
    expect((await readSnapshot(other)).document.habits).toEqual([]);
    await openIdentity(other);
    const input = other.getByLabel('Existing user ID');
    const switchButton = other.getByRole('button', { name: 'Switch profile', exact: true });
    await input.fill('../local');
    await switchButton.click();
    await expect(other.getByRole('alert')).toContainText('Enter a valid user ID');
    await input.fill('local');
    await switchButton.click();
    await expect(other.getByRole('alert')).toHaveText('Enter a valid user ID.');
    await expect(other.getByLabel('Current user ID')).toHaveValue(bob);
    await input.fill(crypto.randomUUID());
    await switchButton.click();
    await expect(other.getByRole('alert')).toContainText('No saved profile');
    await expect(other.getByLabel('Current user ID')).toHaveValue(bob);
    await input.fill(`  ${alice.toUpperCase()}  `);
    await switchButton.click();
    await expect(other.getByLabel('Current user ID')).toHaveValue(alice);
    await expect
      .poll(async () => (await readSnapshot(other)).document.preferences.name)
      .toBe('Alice');
    await other.goto(`${base}/`);
    await expect(
      other.getByRole('button', { name: 'Complete Alice’s habit', exact: true }),
    ).toBeVisible();
    await openIdentity(other);
    await input.fill(bob);
    await switchButton.click();
    await expect(other.getByLabel('Current user ID')).toHaveValue(bob);
    expect((await readSnapshot(other)).document.habits).toEqual([]);
    await other.locator('input[type="file"]').setInputFiles({
      name: 'alice.png',
      mimeType: 'image/png',
      buffer: Buffer.from(qr.split(',')[1], 'base64'),
    });
    await expect(input).toHaveValue(alice);
    await expect(other.getByRole('status')).toContainText('User ID found');
    // A QR scan fills the form; switching still requires the user's explicit action.
    await expect(other.getByLabel('Current user ID')).toHaveValue(bob);
    await switchButton.click();
    await expect(other.getByLabel('Current user ID')).toHaveValue(alice);
    await other.reload();
    await expect(other.getByLabel('Current user ID')).toHaveValue(alice);
    expect(await other.evaluate(() => localStorage.getItem('machbar-user-id'))).toBe(alice);
  } finally {
    await otherContext.close();
  }
});

test('camera scans the generated QR code and releases the camera after reading and navigation', async ({
  page,
}) => {
  await onboard(page, 'Alex');
  await openIdentity(page);
  const image = page.getByRole('img', { name: 'QR code for your user ID' });
  await expect(image).toHaveAttribute('src', /^data:image\/png;base64,/);
  const qr = (await image.getAttribute('src'))!;
  await page.evaluate((data) => {
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      configurable: true,
      value: async () => {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 256;
        const image = new Image();
        image.src = data;
        await image.decode();
        canvas.getContext('2d')!.drawImage(image, 0, 0);
        const stream = canvas.captureStream(10);
        for (const track of stream.getTracks()) {
          const stop = track.stop.bind(track);
          track.stop = () => {
            document.body.dataset.cameraStopped = 'true';
            stop();
          };
        }
        return stream;
      },
    });
  }, qr);
  await page.getByRole('button', { name: 'Scan QR code', exact: true }).click();
  await expect(page.getByLabel('Existing user ID')).toHaveValue(
    (await readSnapshot(page)).document.userId,
  );
  await expect(page.locator('video')).toHaveCount(0);
  await expect(page.locator('body')).toHaveAttribute('data-camera-stopped', 'true');

  await page.evaluate(() => {
    delete document.body.dataset.cameraStopped;
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      configurable: true,
      value: async () => {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 256;
        const stream = canvas.captureStream(10);
        for (const track of stream.getTracks()) {
          const stop = track.stop.bind(track);
          track.stop = () => {
            document.body.dataset.cameraStopped = 'true';
            stop();
          };
        }
        document.body.dataset.cameraOpened = 'true';
        return stream;
      },
    });
  });
  await page.getByRole('button', { name: 'Scan QR code', exact: true }).click();
  await expect(page.locator('body')).toHaveAttribute('data-camera-opened', 'true');
  await page.getByRole('button', { name: 'Profile menu', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
  await expect(page.locator('body')).toHaveAttribute('data-camera-stopped', 'true');
});

test('an existing profile can be restored during onboarding, and switching is blocked with offline changes', async ({
  page,
  browser,
  context,
}) => {
  await onboard(page, 'Alex');
  const id = (await readSnapshot(page)).document.userId;
  const otherContext = await browser.newContext({ locale: 'en-US' });
  try {
    const other = await otherContext.newPage();
    await other.goto(base);
    await other.getByRole('link', { name: 'Use an existing profile', exact: true }).click();
    await expect(other.getByRole('dialog')).toHaveCount(0);
    await other.getByLabel('Existing user ID').fill(id);
    await other.getByRole('button', { name: 'Switch profile', exact: true }).click();
    await expect(other.getByLabel('Current user ID')).toHaveValue(id);
    await other.goto(base);
    await expect(other.getByRole('heading', { name: 'Hey, Alex' })).toBeVisible();
  } finally {
    await otherContext.close();
  }
  await page.locator('nav:visible').getByRole('link', { name: 'Habits', exact: true }).click();
  await page.getByRole('button', { name: 'Add a habit', exact: true }).first().click();
  await page.getByRole('dialog').getByLabel('Name', { exact: true }).fill('Offline habit');
  await page.getByRole('dialog').getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.locator('nav:visible').getByRole('link', { name: 'Today', exact: true }).click();
  await context.setOffline(true);
  await page.getByRole('button', { name: 'Complete Offline habit', exact: true }).click();
  await openIdentity(page);
  await expect(
    page.getByText('Sync or discard pending changes before switching profiles.'),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Switch profile', exact: true })).toBeDisabled();
  await expect(page.getByLabel('Existing user ID')).toBeDisabled();
  await context.setOffline(false);
  await expect(page.getByLabel('Existing user ID')).toBeEnabled();
  await expect.poll(async () => (await readSnapshot(page)).progress.xp).toBe(10);
});

test('switching profiles updates other tabs without mixing their data', async ({
  page,
  context,
  browser,
}) => {
  await onboard(page, 'Alice');
  const alice = (await readSnapshot(page)).document.userId;
  const otherContext = await browser.newContext({ locale: 'en-US' });
  try {
    const other = await otherContext.newPage();
    await onboard(other, 'Bob');
    const bob = (await readSnapshot(other)).document.userId;
    const tab = await context.newPage();
    await tab.goto(base);
    await expect(tab.getByRole('heading', { name: 'Hey, Alice', exact: true })).toBeVisible();
    await openIdentity(page);
    await page.getByLabel('Existing user ID').fill(bob);
    await page.getByRole('button', { name: 'Switch profile', exact: true }).click();
    await expect(tab.getByRole('heading', { name: 'Hey, Bob', exact: true })).toBeVisible();
    await tab.locator('nav:visible').getByRole('link', { name: 'Habits', exact: true }).click();
    await tab.getByRole('button', { name: 'Add a habit', exact: true }).first().click();
    await tab.getByRole('dialog').getByLabel('Name', { exact: true }).fill('Bob’s habit');
    await tab.getByRole('dialog').getByRole('button', { name: 'Create', exact: true }).click();
    await expect(tab.getByRole('dialog')).toHaveCount(0);
    await tab.locator('nav:visible').getByRole('link', { name: 'Today', exact: true }).click();
    expect((await readSnapshot(other)).document.habits[0].title).toBe('Bob’s habit');
    await page.getByLabel('Existing user ID').fill(alice);
    await page.getByRole('button', { name: 'Switch profile', exact: true }).click();
    await expect(tab.getByRole('heading', { name: 'Hey, Alice', exact: true })).toBeVisible();
    expect((await readSnapshot(tab)).document.habits).toEqual([]);
    expect((await readSnapshot(other)).document.habits).toHaveLength(1);
  } finally {
    await otherContext.close();
  }
});

test('LAN HTTP offers QR uploads when the camera is unavailable and rejects unreadable images', async ({
  page,
}) => {
  await page.goto('http://machbar.test:3100');
  await page.getByLabel('What should we call you?').fill('LAN friend');
  await page.getByRole('button', { name: 'Let’s begin' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await openIdentity(page);
  const id = await page.getByLabel('Current user ID').inputValue();
  await page.getByRole('button', { name: 'Scan QR code', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Could not open the camera');
  const blank = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 256;
    const context = canvas.getContext('2d')!;
    context.fillStyle = 'white';
    context.fillRect(0, 0, 256, 256);
    return canvas.toDataURL();
  });
  await page.locator('input[type="file"]').setInputFiles({
    name: 'blank.png',
    mimeType: 'image/png',
    buffer: Buffer.from(blank.split(',')[1], 'base64'),
  });
  await expect(page.getByRole('alert')).toContainText('No QR code was found');
  await expect(page.getByLabel('Current user ID')).toHaveValue(id);
  await expect(page.getByLabel('Existing user ID')).toBeEmpty();
  await expect(page.getByRole('button', { name: 'Switch profile', exact: true })).toBeDisabled();
});
