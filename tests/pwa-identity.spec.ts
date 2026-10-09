import { dismissedHints } from './setup-hints.js';
import { expect, test, type Page } from '@playwright/test';
import { createServer } from 'node:http';
import { readSnapshot } from './helpers.js';

test.beforeEach(async ({ request }) => {
  await request.post('/api/test/reset', {
    headers: {
      origin: 'http://localhost:3100',
      'X-Machbar-User': '00000000-0000-4000-8000-000000000001',
    },
  });
});

async function onboard(page: Page, name: string) {
  await page.goto('/');
  await page.getByLabel('What should we call you?').fill(name);
  await page.getByRole('button', { name: 'Let’s begin' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  return (await readSnapshot(page)).document.userId;
}

test('another service on the same hostname receives no profile access key after migration', async ({
  page,
  context,
}) => {
  const id = await onboard(page, 'Alice');
  await context.addCookies([
    {
      name: 'machbar-user-id',
      value: id,
      url: 'http://localhost:3100',
      sameSite: 'Strict',
      expires: Math.floor(Date.now() / 1000) + 3600,
    },
  ]);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Hey, Alice', exact: true })).toBeVisible();
  let receivedCookie = '';
  const other = createServer((request, response) => {
    receivedCookie = request.headers.cookie ?? '';
    response.end('Other service');
  });
  await new Promise<void>((resolve) => other.listen(0, 'localhost', resolve));
  try {
    const address = other.address();
    if (!address || typeof address === 'string') throw new Error('Expected a TCP address');
    await page.goto(`http://localhost:${address.port}/`);
    expect(receivedCookie).not.toContain('machbar-user-id');
    expect(receivedCookie).not.toContain(id);
  } finally {
    await new Promise<void>((resolve, reject) =>
      other.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

for (const switchProfile of [false, true]) {
  test(`a legacy PWA migrates its copied cookie ${switchProfile ? 'after switching profiles' : 'for an existing local profile'}`, async ({
    page,
    context,
    browser,
  }) => {
    let id = await onboard(page, 'Alice');
    let name = 'Alice';
    // Upgraded browser profiles retain their ID without creating a new cookie.
    await context.clearCookies();
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Hey, Alice', exact: true })).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem('machbar-user-id'))).toBe(id);

    if (switchProfile) {
      const other = await browser.newContext({
        baseURL: 'http://localhost:3100',
        storageState: dismissedHints,
      });
      try {
        id = await onboard(await other.newPage(), 'Bob');
        name = 'Bob';
      } finally {
        await other.close();
      }
      await page.getByRole('button', { name: 'Profile menu', exact: true }).click();
      await page.getByRole('menuitem', { name: 'Switch User', exact: true }).click();
      await page.getByLabel('Existing user ID').fill(id);
      await page.getByRole('button', { name: 'Switch profile', exact: true }).click();
      await expect(page.getByLabel('Current user ID')).toHaveValue(id);
    }

    const cookies = await context.cookies();
    expect(cookies.some((cookie) => cookie.name === 'machbar-user-id')).toBe(false);

    // Model an older iOS installation that already copied the legacy cookie.
    const installed = await browser.newContext({
      baseURL: 'http://localhost:3100',
      storageState: dismissedHints,
    });
    try {
      await installed.addCookies([
        {
          name: 'machbar-user-id',
          value: id,
          url: 'http://localhost:3100',
          sameSite: 'Strict',
          expires: Math.floor(Date.now() / 1000) + 3600,
        },
      ]);
      const app = await installed.newPage();
      await app.addInitScript(() => {
        sessionStorage.setItem(
          'pwa-id-before-startup',
          localStorage.getItem('machbar-user-id') ?? 'missing',
        );
      });
      const bootstrap = app.waitForRequest((request) => request.url().endsWith('/api/bootstrap'));
      await app.goto('/');
      expect((await bootstrap).headers()['x-machbar-user']).toBe(id);
      await expect(app.getByRole('heading', { name: `Hey, ${name}`, exact: true })).toBeVisible();
      expect(await app.evaluate(() => sessionStorage.getItem('pwa-id-before-startup'))).toBe(
        'missing',
      );
      expect(await app.evaluate(() => localStorage.getItem('machbar-user-id'))).toBe(id);
      expect((await installed.cookies()).some((cookie) => cookie.name === 'machbar-user-id')).toBe(
        false,
      );
      await app.reload();
      await expect(app.getByRole('heading', { name: `Hey, ${name}`, exact: true })).toBeVisible();
      expect((await readSnapshot(app)).document.userId).toBe(id);
    } finally {
      await installed.close();
    }
  });
}

test('a new PWA restores its profile through Switch User without copying an access-key cookie', async ({
  page,
  context,
  browser,
}) => {
  const id = await onboard(page, 'Alice');
  expect((await context.cookies()).some((cookie) => cookie.name === 'machbar-user-id')).toBe(false);
  const installed = await browser.newContext({
    baseURL: 'http://localhost:3100',
    storageState: dismissedHints,
  });
  try {
    const app = await installed.newPage();
    await app.goto('/');
    await app.getByRole('link', { name: 'Use an existing profile', exact: true }).click();
    await app.getByLabel('Existing user ID').fill(id);
    await app.getByRole('button', { name: 'Switch profile', exact: true }).click();
    await expect(app.getByLabel('Current user ID')).toHaveValue(id);
    await app.goto('/');
    await expect(app.getByRole('heading', { name: 'Hey, Alice', exact: true })).toBeVisible();
    expect(await app.evaluate(() => localStorage.getItem('machbar-user-id'))).toBe(id);
    await app.reload();
    await expect(app.getByRole('heading', { name: 'Hey, Alice', exact: true })).toBeVisible();
    expect((await installed.cookies()).some((cookie) => cookie.name === 'machbar-user-id')).toBe(
      false,
    );
  } finally {
    await installed.close();
  }
});
