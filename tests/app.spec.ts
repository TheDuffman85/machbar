import { expect, test, type Page } from '@playwright/test';
import { AxeBuilder } from '@axe-core/playwright';
const base = 'http://localhost:3100';
test.beforeEach(async ({ request }) => {
  await request.post(`${base}/test/reset`, { headers: { origin: base } });
});
async function onboard(page: Page, name = 'Alex') {
  await page.goto('/');
  await page.getByLabel('What should we call you?').fill(name);
  await page.getByRole('button', { name: 'Let’s begin' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: `Hey, ${name}` })).toBeVisible();
}
async function addHabit(page: Page, name = 'Take a little walk') {
  await page.getByRole('button', { name: 'Add a habit', exact: true }).first().click();
  await page.getByRole('dialog').getByLabel('Name', { exact: true }).fill(name);
  await page.getByRole('dialog').getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: `Complete ${name}`, exact: true })).toBeVisible();
}
async function serverXp(page: Page, xp: number) {
  await expect
    .poll(async () => (await (await page.request.get('/api/bootstrap')).json()).progress.xp)
    .toBe(xp);
}
async function serviceWorker(page: Page) {
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller)
      await new Promise<void>((resolve) =>
        navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), {
          once: true,
        }),
      );
  });
}
test('onboarding, a daily habit, completion and undo survive reload', async ({ page }) => {
  await onboard(page);
  await addHabit(page);
  await page.getByRole('button', { name: 'Complete Take a little walk', exact: true }).click();
  await serverXp(page, 10);
  await expect(page.getByText('1 of 1 challenges', { exact: false })).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: 'Undo Take a little walk', exact: true }).click();
  await serverXp(page, 0);
});
test('German onboarding is centered, scrolls internally and locks the background', async ({
  page,
}) => {
  const viewport = page.viewportSize()!;
  await page.setViewportSize({ ...viewport, height: 650 });
  await page.goto('/');
  await page.getByLabel('Language', { exact: true }).selectOption('de');
  const dialog = page.getByRole('dialog', {
    name: 'Machen wir jeden Tag ein bisschen machbarer.',
  });
  await expect(dialog).toBeVisible();
  await page.addStyleTag({ content: 'body { min-height: 200vh; }' });
  const bounds = (await dialog.boundingBox())!;
  expect(Math.abs(bounds.x + bounds.width / 2 - viewport.width / 2)).toBeLessThan(2);
  expect(Math.abs(bounds.y + bounds.height / 2 - 325)).toBeLessThan(2);
  expect(bounds.y).toBeGreaterThanOrEqual(24);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(626);
  await page.mouse.move(2, 2);
  await page.mouse.wheel(0, 700);
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  await dialog.evaluate((element) => {
    element.scrollTop = 0;
  });
  await page.screenshot({ path: `test-results/onboarding-${test.info().project.name}.png` });
  await dialog.locator('input').fill('Alex');
  await dialog.locator('button[type="submit"]').click();
  await expect(dialog).toHaveCount(0);
  await page.evaluate(() => window.scrollTo(0, 400));
  expect(await page.evaluate(() => window.scrollY)).toBe(400);
  // Opening another dialog must preserve the page position on dismissal.
  await page
    .getByRole('button', { name: 'Gewohnheit hinzufügen', exact: true })
    .first()
    .evaluate((button: HTMLButtonElement) => button.click());
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await page.evaluate(() => window.scrollY)).toBe(400);
});
test('non-localhost HTTP supports onboarding, avatars and completion/undo', async ({ page }) => {
  const external = 'http://machbar.test:3100';
  await page.goto(external);
  expect(await page.evaluate(() => window.isSecureContext)).toBe(false);
  await page.getByRole('button', { name: 'Another little face', exact: true }).click();
  await page.getByLabel('What should we call you?').fill('LAN friend');
  await page.getByRole('button', { name: 'Let’s begin' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Hey, LAN friend' })).toBeVisible();
  await addHabit(page, 'A LAN win');
  await page.getByRole('button', { name: 'Complete A LAN win', exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(async () => (await (await fetch('/api/bootstrap')).json()).progress.xp),
    )
    .toBe(10);
  await page.reload();
  await page.getByRole('button', { name: 'Undo A LAN win', exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(async () => (await (await fetch('/api/bootstrap')).json()).progress.xp),
    )
    .toBe(0);
});
test('goals can be broken into dated and undated steps, reordered, completed and edited', async ({
  page,
}) => {
  await onboard(page);
  await page.goto('/goals');
  await page.getByRole('button', { name: 'New goal', exact: true }).click();
  await page.getByRole('dialog').getByLabel('Name', { exact: true }).fill('A cozy home');
  await page.getByRole('dialog').getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  for (const title of ['Tidy one shelf', 'Get a plant']) {
    await page.getByRole('button', { name: 'Add a step', exact: true }).click();
    await page.getByRole('dialog').getByLabel('Name', { exact: true }).fill(title);
    if (title === 'Tidy one shelf') await page.getByLabel('Date (optional)').fill('2026-01-01');
    await page.getByRole('dialog').getByRole('button', { name: 'Create', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
  }
  await page.getByRole('button', { name: 'Move up Get a plant', exact: true }).click();
  await expect(page.locator('.goal-steps .task-copy strong').first()).toHaveText('Get a plant');
  await page.getByRole('button', { name: 'Complete Tidy one shelf', exact: true }).click();
  await serverXp(page, 10);
  await page.getByRole('button', { name: 'Complete Get a plant', exact: true }).click();
  await serverXp(page, 20);
  await expect(page.getByText('Complete', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Edit Get a plant', exact: true }).click();
  await page.getByRole('dialog').getByLabel('Name', { exact: true }).fill('Get a tiny plant');
  await page.getByRole('dialog').getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.getByText('Get a tiny plant', { exact: true })).toBeVisible();
});
test('gift unlock, claiming and achievements', async ({ page }) => {
  await onboard(page);
  await addHabit(page);
  await page.goto('/rewards');
  await page.getByRole('button', { name: 'Add a gift', exact: true }).click();
  await page.getByRole('dialog').getByLabel('Name', { exact: true }).fill('New shoes');
  await page.getByLabel('Target', { exact: true }).fill('1');
  await page.getByRole('dialog').getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.goto('/');
  await page.getByRole('button', { name: 'Complete Take a little walk', exact: true }).click();
  await serverXp(page, 10);
  await page.goto('/rewards');
  await expect(page.getByText('Ready for you', { exact: true })).toBeVisible();
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'I treated myself', exact: true }).click();
  await expect(page.getByText('Enjoyed', { exact: true })).toBeVisible();
  await expect(page.locator('.badge-card.earned')).toHaveCount(1);
  await page.goto('/');
  await page.getByRole('button', { name: 'Undo Take a little walk', exact: true }).click();
  await serverXp(page, 0);
  await page.goto('/rewards');
  await expect(page.getByText('Enjoyed', { exact: true })).toBeVisible();
  await expect(page.locator('.badge-card.earned')).toHaveCount(0);
});
test('offline reload preserves queued checkoffs and reconnect syncs exactly once', async ({
  page,
  context,
}) => {
  await onboard(page);
  await addHabit(page);
  await serviceWorker(page);
  await context.setOffline(true);
  await page.getByRole('button', { name: 'Complete Take a little walk', exact: true }).click();
  await expect(page.getByText('Pending sync', { exact: true })).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole('button', { name: 'Undo Take a little walk', exact: true }),
  ).toBeVisible();
  await context.setOffline(false);
  await serverXp(page, 10);
  await expect(page.getByText('Pending sync', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Undo Take a little walk', exact: true }).click();
  await serverXp(page, 0);
});
test('English/German, dark mode and reduced motion', async ({ page }) => {
  await onboard(page);
  await page.goto('/settings');
  await page.getByLabel('Language', { exact: true }).selectOption('de');
  await page.getByRole('button', { name: 'Dark', exact: true }).click();
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Einstellungen', exact: true })).toBeVisible();
  await expect(page.locator('html')).toHaveClass(/dark/);
  await expect(page.locator('html')).toHaveAttribute('lang', 'de');
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Einstellungen', exact: true })).toBeVisible();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  expect(
    await page.locator('.floating-check').evaluate((el) => getComputedStyle(el).animationName),
  ).toBe('none');
});
test('install action uses a supported browser prompt and falls back to instructions', async ({
  page,
}) => {
  await onboard(page);
  await page.goto('/settings');
  await page.evaluate(() => {
    const event = new Event('beforeinstallprompt', { cancelable: true }) as Event & {
      prompt: () => Promise<void>;
      userChoice: Promise<{ outcome: string }>;
    };
    event.prompt = async () => {
      document.body.dataset.installPrompt = 'called';
    };
    event.userChoice = Promise.resolve({ outcome: 'accepted' });
    window.dispatchEvent(event);
  });
  await page.getByRole('button', { name: 'Install Machbar', exact: true }).click();
  await expect(page.locator('body')).toHaveAttribute('data-install-prompt', 'called');
  await page.getByRole('button', { name: 'Install Machbar', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Keep small wins close' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
});
test('stale task edits require review before replacing another device’s changes', async ({
  page,
}) => {
  await onboard(page);
  await addHabit(page);
  await page.goto('/goals');
  await page.getByRole('button', { name: 'Habits', exact: true }).click();
  await page.getByRole('button', { name: 'Edit Take a little walk', exact: true }).click();
  const snapshot = (await (await page.request.get('/api/bootstrap')).json()).document;
  const habit = snapshot.habits[0];
  const changed = await page.request.patch(`/api/habits/${habit.id}`, {
    headers: { origin: base, 'x-machbar-user': 'local', 'if-match': String(snapshot.revision) },
    data: { title: 'Another device’s title', weekdays: habit.schedules[0].weekdays },
  });
  expect(changed.status()).toBe(200);
  await page.getByRole('dialog').getByLabel('Name', { exact: true }).fill('My reviewed title');
  await page.getByRole('dialog').getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('Your data changed');
  expect((await (await page.request.get('/api/bootstrap')).json()).document.habits[0].title).toBe(
    'Another device’s title',
  );
  await page.getByRole('dialog').getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByText('My reviewed title', { exact: true })).toBeVisible();
});
test('layout and accessible controls', async ({ page }) => {
  await onboard(page);
  await addHabit(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
    .analyze();
  expect(
    results.violations.map((v) => ({ id: v.id, nodes: v.nodes.map((n) => n.target) })),
  ).toEqual([]);
  await page.screenshot({
    path: `test-results/machbar-${test.info().project.name}.png`,
    fullPage: true,
  });
  const manifest = await (await page.request.get('/manifest.webmanifest')).json();
  expect(manifest.display).toBe('standalone');
  expect(manifest.icons).toHaveLength(3);
  for (const route of ['/goals', '/rewards', '/settings']) {
    await page.goto(route);
    await expect(page.locator('.page-heading')).toBeVisible();
    const result = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
      .analyze();
    expect(
      result.violations.map((v) => ({ route, id: v.id, nodes: v.nodes.map((n) => n.target) })),
    ).toEqual([]);
  }
  await page.getByRole('button', { name: 'Dark', exact: true }).click();
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.locator('html')).toHaveClass(/dark/);
  for (const route of ['/', '/goals', '/rewards', '/settings']) {
    await page.goto(route);
    await expect(page.locator('.page-heading')).toBeVisible();
    const result = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
      .analyze();
    expect(
      result.violations.map((v) => ({ route, id: v.id, nodes: v.nodes.map((n) => n.target) })),
    ).toEqual([]);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  }
  await page.goto('/');
  await expect(page.locator('.page-heading')).toBeVisible();
  await page.screenshot({
    path: `test-results/machbar-${test.info().project.name}-dark.png`,
    fullPage: true,
  });
});
test('a changed server completion requires review before undo', async ({ page, context }) => {
  await onboard(page);
  await addHabit(page);
  await page.getByRole('button', { name: 'Complete Take a little walk', exact: true }).click();
  await serverXp(page, 10);
  await serviceWorker(page);
  const snapshot = (await (await page.request.get('/api/bootstrap')).json()).document;
  await context.setOffline(true);
  await page.getByRole('button', { name: 'Undo Take a little walk', exact: true }).click();
  const h = snapshot.habits[0],
    date = Object.values(snapshot.completions)[0] as { date: string };
  for (const [completed, version] of [
    [false, 1],
    [true, 2],
  ])
    await page.request.post('/api/completions', {
      headers: { origin: base, 'x-machbar-user': 'local' },
      data: {
        operationId: crypto.randomUUID(),
        targetType: 'habit',
        targetId: h.id,
        date: date.date,
        timezone: snapshot.preferences.timezone,
        completed,
        expectedVersion: version,
      },
    });
  await context.setOffline(false);
  await expect(page.getByText(/This challenge changed on another device/)).toBeVisible();
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Use server progress', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Undo Take a little walk', exact: true }),
  ).toBeVisible();
  await serverXp(page, 10);
});
test('account switching never replays another account’s pending changes and logout clears cache', async ({
  page,
  context,
  request,
}) => {
  const authBase = 'http://localhost:3101';
  await request.post(`${authBase}/test/reset`, { headers: { origin: authBase } });
  await page.goto(`${authBase}/auth/login`);
  await page.getByRole('link', { name: 'Alice', exact: true }).click();
  await page.getByRole('button', { name: 'Let’s begin' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Hey, Alice' })).toBeVisible();
  await addHabit(page, 'Alice habit');
  await serviceWorker(page);
  await context.setOffline(true);
  await page.getByRole('button', { name: 'Complete Alice habit', exact: true }).click();
  const secondContext = await context.browser()!.newContext();
  const other = await secondContext.newPage();
  await other.goto(`${authBase}/auth/login`);
  await other.getByRole('link', { name: 'Bob', exact: true }).click();
  await context.addCookies(await secondContext.cookies());
  await secondContext.close();
  await context.setOffline(false);
  await page.reload();
  await page.getByRole('button', { name: 'Let’s begin' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Hey, Bob' })).toBeVisible();
  await expect(page.getByText('Alice habit', { exact: true })).toHaveCount(0);
  expect((await (await page.request.get(`${authBase}/api/bootstrap`)).json()).progress.xp).toBe(0);
  await page.goto(`${authBase}/settings`);
  await page.getByRole('button', { name: 'Log out', exact: true }).click();
  await expect(page.getByRole('link', { name: 'Sign in', exact: true })).toBeVisible();
  expect(
    await page.evaluate(async () => {
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open('machbar');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      return new Promise<number>((resolve) => {
        const req = database.transaction('accounts').objectStore('accounts').count();
        req.onsuccess = () => resolve(req.result);
      });
    }),
  ).toBe(0);
});
