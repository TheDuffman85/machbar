import { expect, test, type Page } from '@playwright/test';
import { AxeBuilder } from '@axe-core/playwright';
import { readSnapshot, writeSnapshot } from './helpers.js';

const base = 'http://localhost:3100';
test.beforeEach(async ({ request }) => {
  await request.post(`${base}/test/reset`, { headers: { origin: base } });
});
async function onboard(page: Page) {
  await page.goto('/');
  await page.getByLabel('What should we call you?').fill('Alex');
  await page.getByRole('button', { name: 'Let’s begin' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
}
async function openEditor(page: Page) {
  if (new URL(page.url()).pathname !== '/settings') {
    await page.getByRole('button', { name: 'Profile menu', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
  }
  await page.getByRole('button', { name: 'Edit avatar', exact: true }).click();
  return page.getByRole('dialog', { name: 'Edit avatar', exact: true });
}

test('avatar preview, cycling, randomize, reset and cancel preserve saved data', async ({
  page,
}) => {
  await onboard(page);
  const before = (await readSnapshot(page)).document.preferences;
  const headerAvatar = page.locator('.profile-menu-trigger img');
  const beforeImage = await headerAvatar.getAttribute('src');
  const dialog = await openEditor(page);
  await expect(dialog.getByRole('button', { name: 'Another little face' })).toBeFocused();
  const preview = dialog.getByRole('img', { name: 'Avatar preview' });
  const original = await preview.getAttribute('src');
  await dialog.getByLabel('Hair & headwear', { exact: true }).selectOption('longButNotTooLong');
  await dialog.getByLabel('Facial hair', { exact: true }).selectOption('none');
  await dialog.getByLabel('Accessories', { exact: true }).selectOption('none');
  await dialog.getByLabel('Skin tone', { exact: true }).selectOption('614335');
  await expect(preview).not.toHaveAttribute('src', original!);
  await dialog.getByRole('button', { name: 'Next Eyes option', exact: true }).click();
  await expect(dialog.getByLabel('Eyes', { exact: true })).toHaveValue('default');
  await dialog.getByRole('button', { name: 'Previous Eyes option', exact: true }).click();
  await expect(dialog.getByLabel('Eyes', { exact: true })).toHaveValue('');
  await dialog.getByRole('button', { name: 'Another little face' }).click();
  await expect(preview).not.toHaveAttribute('src', original!);
  await dialog.getByRole('button', { name: 'Reset', exact: true }).click();
  await expect(preview).toHaveAttribute('src', original!);
  await expect(dialog.getByLabel('Skin tone', { exact: true })).toHaveValue('');
  await dialog.getByLabel('Background', { exact: true }).selectOption('ded4ed');
  await expect(preview).toBeInViewport();
  await dialog.getByRole('button', { name: 'Reset', exact: true }).click();
  const accessibility = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  expect(accessibility.violations).toEqual([]);
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await dialog.evaluate((element) => {
    element.scrollTop = 0;
  });
  await page.screenshot({ path: `test-results/avatar-${test.info().project.name}.png` });
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Edit avatar', exact: true })).toBeFocused();
  expect((await readSnapshot(page)).document.preferences).toEqual(before);
  await expect(headerAvatar).toHaveAttribute('src', beforeImage!);
  await openEditor(page);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
});

test('saved avatar survives reload, updates settings, and keeps other profile edits', async ({
  page,
}) => {
  await onboard(page);
  let dialog = await openEditor(page);
  await dialog.getByLabel('Eyes', { exact: true }).selectOption('happy');
  await dialog.getByLabel('Clothing', { exact: true }).selectOption('graphicShirt');
  await dialog.getByLabel('Shirt graphic', { exact: true }).selectOption('pizza');
  await dialog.getByLabel('Facial hair', { exact: true }).selectOption('none');
  await dialog.getByLabel('Accessories', { exact: true }).selectOption('none');
  const image = await dialog.getByRole('img', { name: 'Avatar preview' }).getAttribute('src');
  await dialog.getByRole('button', { name: 'Save avatar', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.profile-menu-trigger img')).toHaveAttribute('src', image!);
  await page.reload();
  await expect(page.locator('.profile-menu-trigger img')).toHaveAttribute('src', image!);
  const saved = (await readSnapshot(page)).document.preferences.avatarOptions;
  expect(saved).toMatchObject({
    eyes: 'happy',
    clothing: 'graphicShirt',
    clothingGraphic: 'pizza',
    facialHair: 'none',
    accessories: 'none',
  });

  await page.goto('/settings');
  await page.getByLabel('What should we call you?').fill('New name');
  await page.getByRole('button', { name: 'Edit avatar', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'Edit avatar', exact: true });
  await expect(dialog.getByLabel('Eyes', { exact: true })).toHaveValue('happy');
  await dialog.getByLabel('Eyes', { exact: true }).selectOption('wink');
  await dialog.getByRole('button', { name: 'Reset', exact: true }).click();
  await expect(dialog.getByLabel('Eyes', { exact: true })).toHaveValue('happy');
  await dialog.getByLabel('Eyes', { exact: true }).selectOption('wink');
  await dialog.getByRole('button', { name: 'Save avatar', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect((await readSnapshot(page)).document.preferences.name).toBe('Alex');
  await expect(page.getByLabel('What should we call you?')).toHaveValue('New name');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect
    .poll(async () => (await readSnapshot(page)).document.preferences.name)
    .toBe('New name');
  expect((await readSnapshot(page)).document.preferences.avatarOptions?.eyes).toBe('wink');
  await page.getByLabel('What should we call you?').fill('Still editing');
  dialog = await openEditor(page);
  await dialog.getByLabel('Eyes', { exact: true }).selectOption('happy');
  await dialog.getByRole('button', { name: 'Save avatar', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByLabel('What should we call you?')).toHaveValue('Still editing');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect
    .poll(async () => (await readSnapshot(page)).document.preferences.name)
    .toBe('Still editing');
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
});

test('onboarding applies an avatar draft without submitting its parent form', async ({ page }) => {
  await page.goto('/');
  // Leave the required name empty while customizing.
  await page.getByRole('button', { name: 'Edit avatar', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'Edit avatar', exact: true });
  await editor.getByLabel('Hair & headwear', { exact: true }).selectOption('bob');
  await editor.getByLabel('Eyes', { exact: true }).selectOption('happy');
  const image = await editor.getByRole('img', { name: 'Avatar preview' }).getAttribute('src');
  await editor.getByRole('button', { name: 'Use this avatar', exact: true }).click();
  await expect(editor).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(1);
  expect((await readSnapshot(page)).document.preferences.avatarOptions).toBeUndefined();
  await expect(page.locator('.profile-form img')).toHaveAttribute('src', image!);
  await page.getByLabel('What should we call you?').fill('Alex');
  await page.getByRole('button', { name: 'Let’s begin' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.profile-menu-trigger img')).toHaveAttribute('src', image!);
  expect((await readSnapshot(page)).document.preferences.avatarOptions).toMatchObject({
    top: 'bob',
    eyes: 'happy',
  });
});

test('avatar saves offline and merges without overwriting other preferences', async ({
  page,
  context,
}) => {
  await onboard(page);
  const current = (await readSnapshot(page)).document;
  const dialog = await openEditor(page);
  await dialog.getByLabel('Eyes', { exact: true }).selectOption('hearts');
  await context.setOffline(true);
  await expect(dialog.getByRole('button', { name: 'Save avatar', exact: true })).toBeEnabled();
  current.preferences.name = 'Updated elsewhere';
  await writeSnapshot(page, current);
  await dialog.getByRole('button', { name: 'Save avatar', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await context.setOffline(false);
  const preferences = (await readSnapshot(page)).document.preferences;
  expect(preferences.name).toBe('Updated elsewhere');
  expect(preferences.avatarOptions?.eyes).toBe('hearts');
});
