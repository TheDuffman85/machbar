import { expect, test } from '@playwright/test';
import { readSnapshot } from './helpers.js';
import { readFileSync } from 'node:fs';

test('settings show the installed build with localized dates, including offline', async ({
  page,
  context,
  request,
}) => {
  await request.post('/test/reset', { headers: { origin: 'http://localhost:3100' } });
  await page.goto('/');
  await page.getByLabel('What should we call you?').fill('Alex');
  await page.getByRole('button', { name: 'Let’s begin' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.goto('/settings');

  const info = page.locator('.build-info');
  await expect(info.locator('dt')).toHaveText(['Version', 'Build date']);
  const version = await info.locator('dd').first().innerText();
  const builtAt = await info.locator('time').getAttribute('datetime');
  expect(builtAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  expect(version).toBe(`${pkg.version}+${builtAt!.replace(/\D/g, '')}`);
  const snapshot = await readSnapshot(page);
  await expect(info.locator('time')).toHaveText(
    new Intl.DateTimeFormat('en', {
      dateStyle: 'medium',
      timeStyle: 'long',
      timeZone: snapshot.document.preferences.timezone,
    }).format(new Date(builtAt!)),
  );

  await page.getByLabel('Timezone', { exact: true }).selectOption('UTC');
  await page.getByLabel('Language', { exact: true }).selectOption('de');
  await expect(info.locator('dt')).toHaveText(['Version', 'Build-Datum']);
  const localizedDate = new Intl.DateTimeFormat('de', {
    dateStyle: 'medium',
    timeStyle: 'long',
    timeZone: 'UTC',
  }).format(new Date(builtAt!));
  await expect(info.locator('time')).toHaveText(localizedDate);
  await readSnapshot(page);
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  await page.clock.setFixedTime(new Date('2040-01-01T00:00:00Z'));
  await context.setOffline(true);
  await page.reload();
  await expect(info.locator('dd').first()).toHaveText(version);
  await expect(info.locator('time')).toHaveAttribute('datetime', builtAt!);
  await expect(info.locator('time')).toHaveText(localizedDate);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    page.viewportSize()!.width,
  );
});
