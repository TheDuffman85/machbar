import { expect, test, type Page } from '@playwright/test';

const base = 'http://localhost:3100';
test.beforeEach(async ({ request }) => {
  await request.post(`${base}/api/test/reset`, {
    headers: { origin: base, 'X-Machbar-User': '00000000-0000-4000-8000-000000000001' },
  });
});
async function onboard(page: Page, name = 'Alex') {
  await page.goto('/');
  await page.getByLabel('What should we call you?').fill(name);
  await page.getByRole('button', { name: 'Let’s begin' }).click();
  await expect(page.getByRole('heading', { name: `Hey, ${name}` })).toBeVisible();
}
async function signIn(admin: Page) {
  await admin.goto('/admin');
  await admin.getByLabel('Password').fill('browser-test-admin');
  await admin.getByRole('button', { name: 'Sign in' }).click();
  await expect(admin.getByRole('heading', { name: 'Profiles' })).toBeVisible();
}
// Signs in through the admin login form in a second tab and deletes the profile there.
async function deleteProfile(page: Page, name: string) {
  const admin = await page.context().newPage();
  await signIn(admin);
  await admin.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(admin.getByRole('dialog')).toContainText(name);
  await admin.getByRole('button', { name: 'Delete profile' }).click();
  await expect(admin.getByText('Profile deleted.')).toBeVisible();
  await admin.getByRole('button', { name: 'Sign out' }).click();
  await expect(admin.getByRole('button', { name: 'Sign in' })).toBeVisible();
  await admin.close();
}

test('a profile deleted by the admin cannot be uploaded again from its device', async ({
  page,
}) => {
  await onboard(page);
  const userId = await page.evaluate(() => localStorage.getItem('machbar-user-id')!);
  await expect
    .poll(async () =>
      (await page.request.get('/api/bootstrap', { headers: { 'X-Machbar-User': userId } })).json(),
    )
    .toMatchObject({ document: { revision: 1 } });
  await deleteProfile(page, 'Alex');

  // The next background sync reports the deletion instead of recreating the profile.
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(page.getByText('deleted by the server administrator')).toBeVisible();
  expect(
    (await page.request.get('/api/bootstrap', { headers: { 'X-Machbar-User': userId } })).status(),
  ).toBe(410);
  await page.reload();
  await expect(page.getByText('deleted by the server administrator')).toBeVisible();

  await page.getByRole('button', { name: 'Start a new profile' }).click();
  await expect(page.getByLabel('What should we call you?')).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('machbar-user-id'))).not.toBe(userId);
});

test('the admin can temporarily open user creation and pick a theme', async ({ page, browser }) => {
  await page.request.post(`${base}/api/test/config`, {
    headers: { origin: base, 'X-Machbar-User': '00000000-0000-4000-8000-000000000001' },
    data: { disableUserCreation: true },
  });
  await signIn(page);
  await page.getByRole('button', { name: 'Dark' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.getByRole('button', { name: 'Dark' })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'System' }).click();
  await expect(page.locator('html')).not.toHaveAttribute('data-theme', /./);

  await page.getByRole('button', { name: 'Open for 1 hour' }).click();
  await expect(page.getByText('User creation temporarily open')).toBeVisible();
  const visitor = await browser.newPage();
  await onboard(visitor, 'Newcomer');
  await visitor.close();

  await page.getByRole('button', { name: 'Close now' }).click();
  await expect(page.getByText('User creation disabled')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Newcomer' })).toBeVisible();
});

test('the admin can show and copy a profile ID and its QR code', async ({ page, context }) => {
  await onboard(page);
  const userId = await page.evaluate(() => localStorage.getItem('machbar-user-id')!);
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const admin = await context.newPage();
  await signIn(admin);
  await expect(admin.getByText('Level', { exact: true })).toBeVisible();
  // The app reports its build on every API request.
  await expect(admin.locator('dt:text-is("App version") + dd')).toHaveText(/^\d+\.\d+\.\d+\+\d+$/);
  await expect(admin.getByText(userId)).toBeHidden();
  await admin.getByText('User ID and QR code').click();
  await expect(admin.getByText(userId)).toBeVisible();
  await expect(admin.getByRole('img', { name: 'QR code of the user ID' })).toBeVisible();
  await admin.getByRole('button', { name: 'Copy ID' }).click();
  await expect(admin.getByRole('button', { name: 'Copied' })).toBeVisible();
  expect(await admin.evaluate(() => navigator.clipboard.readText())).toBe(userId);
  await admin.screenshot({ path: test.info().outputPath('admin-identity.png'), fullPage: true });
});
