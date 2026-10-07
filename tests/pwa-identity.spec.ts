import { expect, test, type Page } from '@playwright/test';
import { readSnapshot } from './helpers.js';

test.beforeEach(async ({ request }) => {
  await request.post('/test/reset', { headers: { origin: 'http://localhost:3100' } });
});

async function onboard(page: Page, name: string) {
  await page.goto('/');
  await page.getByLabel('What should we call you?').fill(name);
  await page.getByRole('button', { name: 'Let’s begin' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  return (await readSnapshot(page)).document.userId;
}

for (const switchProfile of [false, true]) {
  test(`a fresh PWA restores copied cookies ${switchProfile ? 'after switching profiles' : 'for an existing local profile'}`, async ({
    page,
    context,
    browser,
  }) => {
    let id = await onboard(page, 'Alice');
    let name = 'Alice';
    // Model an existing installation of the website that predates cookie backup.
    await context.clearCookies();
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Hey, Alice', exact: true })).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem('machbar-user-id'))).toBe(id);

    if (switchProfile) {
      const other = await browser.newContext({ baseURL: 'http://localhost:3100' });
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
    const identity = cookies.find((cookie) => cookie.name === 'machbar-user-id');
    expect(identity).toMatchObject({ value: id, path: '/', sameSite: 'Strict' });
    expect(identity!.expires).toBeGreaterThan(Date.now() / 1000);

    // iOS installation copies cookies into an isolated store, excluding localStorage
    // and IndexedDB. A new context models that handoff without sharing profile data.
    const installed = await browser.newContext({ baseURL: 'http://localhost:3100' });
    try {
      await installed.addCookies(cookies);
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
      await app.reload();
      await expect(app.getByRole('heading', { name: `Hey, ${name}`, exact: true })).toBeVisible();
      expect((await readSnapshot(app)).document.userId).toBe(id);
    } finally {
      await installed.close();
    }
  });
}
