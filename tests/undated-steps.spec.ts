import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import {
  addDays,
  applyCompletion,
  completionKey,
  type Step,
} from '../packages/shared/src/index.js';
import { readSnapshot } from './helpers.js';

const base = 'http://localhost:3100';
const step = (title: string, date: string | null = null): Step => ({
  id: crypto.randomUUID(),
  title,
  date,
  archivedAt: null,
});

test.beforeEach(async ({ request }) => {
  await request.post('/api/test/reset', {
    headers: { origin: base, 'X-Machbar-User': '00000000-0000-4000-8000-000000000001' },
  });
});

async function onboard(page: Page) {
  await page.goto('/');
  await page.getByLabel('What should we call you?').fill('Alex');
  await page.getByRole('button', { name: 'Let’s begin' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  return readSnapshot(page);
}

for (const language of ['en', 'de'] as const) {
  test(`undated suggestions follow goal order, expand and save offline in ${language}`, async ({
    page,
    context,
  }) => {
    const snapshot = await onboard(page);
    const { document: doc, today } = snapshot;
    const first = step('Tidy a shelf');
    const due = step('A scheduled step', today);
    const previous = step('An earlier win');
    doc.preferences.language = language;
    doc.preferences.theme = language === 'de' ? 'dark' : 'light';
    doc.goals = [
      {
        id: crypto.randomUUID(),
        title: 'A cozy home',
        description: '',
        color: 'lavender',
        archivedAt: null,
        steps: [
          { ...step('An archived step'), archivedAt: new Date().toISOString() },
          previous,
          due,
          step('A future step', addDays(today, 1)),
          first,
          step('Water the plants'),
          step('Hang a picture'),
        ],
      },
      {
        id: crypto.randomUUID(),
        title: 'Learn something',
        description: '',
        color: 'blue',
        archivedAt: null,
        steps: [step('Read a chapter')],
      },
      {
        id: crypto.randomUUID(),
        title: 'An archived goal',
        description: '',
        color: 'sage',
        archivedAt: new Date().toISOString(),
        steps: [step('A hidden step')],
      },
    ];
    applyCompletion(doc, {
      operationId: crypto.randomUUID(),
      targetType: 'step',
      targetId: previous.id,
      date: addDays(today, -1),
      timezone: doc.preferences.timezone,
      completed: true,
      expectedVersion: 0,
    });
    expect(
      (
        await page.request.post('/api/test/seed', {
          headers: { origin: base, 'X-Machbar-User': '00000000-0000-4000-8000-000000000001' },
          data: doc,
        })
      ).ok(),
    ).toBe(true);
    await page.reload();
    const labels =
      language === 'de'
        ? {
            heading: 'Wenn du Zeit hast',
            expand: 'Alle Schritte anzeigen',
            collapse: 'Weniger anzeigen',
            complete: 'Tidy a shelf abschließen',
            undo: 'Tidy a shelf rückgängig machen',
            progress: '0 von 1 Aufgaben',
          }
        : {
            heading: 'Whenever you have time',
            expand: 'Show all steps',
            collapse: 'Show less',
            complete: 'Complete Tidy a shelf',
            undo: 'Undo Tidy a shelf',
            progress: '0 of 1 challenges',
          };
    const optional = page.getByRole('region', { name: new RegExp(labels.heading) });
    const titles = optional.locator('.task-copy strong');
    const hero = page.locator('.daily-hero');
    await expect(titles).toHaveText(['Tidy a shelf', 'Read a chapter']);
    await expect(optional.locator('.count-pill')).toHaveText('4');
    await expect(optional).toContainText('A cozy home');
    await expect(hero).toContainText(labels.progress);
    await expect(hero.locator('.hero-copy p span')).toHaveText('0 XP');
    await expect(
      page.locator('.task-copy strong').filter({ hasText: 'A scheduled step' }),
    ).toBeVisible();
    const expand = optional.getByRole('button', { name: labels.expand, exact: true });
    await expect(expand).toHaveAttribute('aria-expanded', 'false');
    await expand.click();
    await expect(titles).toHaveText([
      'Tidy a shelf',
      'Water the plants',
      'Hang a picture',
      'Read a chapter',
    ]);
    await expect(optional.getByRole('button', { name: labels.collapse })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    const accessibility = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
      .analyze();
    expect(accessibility.violations.map((violation) => violation.id)).toEqual([]);
    await optional.screenshot({
      path: `test-results/optional-steps-${language}-${test.info().project.name}.png`,
    });
    await optional.getByRole('button', { name: labels.collapse }).click();
    await expect(titles).toHaveText(['Tidy a shelf', 'Read a chapter']);
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
      if (!navigator.serviceWorker.controller)
        await new Promise<void>((resolve) =>
          navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), {
            once: true,
          }),
        );
    });
    await context.setOffline(true);
    await optional.getByRole('button', { name: labels.complete, exact: true }).click();
    await expect(optional.getByRole('button', { name: labels.undo, exact: true })).toBeVisible();
    await expect(titles).toHaveText(['Tidy a shelf', 'Water the plants', 'Read a chapter']);
    await expect(hero).toContainText(labels.progress);
    await expect(hero.locator('.hero-copy').getByRole('progressbar')).toHaveAttribute(
      'aria-valuenow',
      '0',
    );
    await expect(hero.locator('.hero-copy').getByRole('progressbar')).toHaveAttribute(
      'aria-valuemax',
      '1',
    );
    await expect(hero.locator('.hero-copy p span')).toHaveText('10 XP');
    await page.reload();
    await expect(optional.getByRole('button', { name: labels.undo, exact: true })).toBeVisible();
    await expect(titles).toHaveText(['Tidy a shelf', 'Water the plants', 'Read a chapter']);
    await expect(hero.locator('.hero-copy p span')).toHaveText('10 XP');
    await context.setOffline(false);
    const saved = await readSnapshot(page);
    expect(saved.progress.xp).toBe(20);
    expect(saved.document.completions[completionKey('step', first.id, '')]).toMatchObject({
      completed: true,
      date: today,
    });
    await optional.getByRole('button', { name: labels.undo, exact: true }).click();
    await expect(titles).toHaveText(['Tidy a shelf', 'Read a chapter']);
    await expect(hero.locator('.hero-copy p span')).toHaveText('0 XP');
    expect((await readSnapshot(page)).progress.xp).toBe(10);
  });
}

test('past days show only undated wins from that day and support undo and recompletion', async ({
  page,
}) => {
  const { document: doc, today } = await onboard(page);
  const yesterday = addDays(today, -1);
  const earlier = step('Yesterday’s win');
  const current = step('Today’s win');
  doc.goals = [
    {
      id: crypto.randomUUID(),
      title: 'Small steps',
      description: '',
      color: 'sage',
      archivedAt: null,
      steps: [earlier, current, step('An unfinished step'), step('Another unfinished step')],
    },
  ];
  for (const [target, date] of [
    [earlier, yesterday],
    [current, today],
  ] as const) {
    applyCompletion(doc, {
      operationId: crypto.randomUUID(),
      targetType: 'step',
      targetId: target.id,
      date,
      timezone: doc.preferences.timezone,
      completed: true,
      expectedVersion: 0,
    });
  }
  expect(
    (
      await page.request.post('/api/test/seed', {
        headers: { origin: base, 'X-Machbar-User': '00000000-0000-4000-8000-000000000001' },
        data: doc,
      })
    ).ok(),
  ).toBe(true);
  await page.reload();
  const optional = page.getByRole('region', { name: /Whenever you have time/ });
  const hero = page.locator('.daily-hero');
  await expect(optional.locator('.task-copy strong')).toHaveText([
    'Today’s win',
    'An unfinished step',
  ]);
  await expect(hero).toContainText('0 of 0 challenges');
  await expect(hero.locator('.hero-copy p span')).toHaveText('10 XP');
  await optional.getByRole('button', { name: 'Show all steps' }).click();
  await page.getByRole('button', { name: 'Previous day', exact: true }).click();
  await expect(optional.locator('.task-copy strong')).toHaveText(['Yesterday’s win']);
  await expect(optional.getByRole('button', { name: /Show/ })).toHaveCount(0);
  await expect(hero.locator('.hero-copy p span')).toHaveText('10 XP');
  await optional.getByRole('button', { name: 'Undo Yesterday’s win', exact: true }).click();
  await expect(optional).toHaveCount(0);
  await expect(hero.locator('.hero-copy p span')).toHaveText('0 XP');
  expect((await readSnapshot(page)).progress.xp).toBe(10);
  await page.getByRole('button', { name: 'Next day', exact: true }).click();
  await optional.getByRole('button', { name: 'Complete Yesterday’s win', exact: true }).click();
  await expect(
    optional.getByRole('button', { name: 'Undo Yesterday’s win', exact: true }),
  ).toBeVisible();
  await expect(hero.locator('.hero-copy p span')).toHaveText('20 XP');
  const saved = await readSnapshot(page);
  expect(saved.progress.xp).toBe(20);
  expect(saved.document.completions[completionKey('step', earlier.id, '')]?.date).toBe(today);
  await page.getByRole('button', { name: 'Previous day', exact: true }).click();
  await expect(optional).toHaveCount(0);
  await expect(hero.locator('.hero-copy p span')).toHaveText('0 XP');
  await page.getByRole('button', { name: 'Next day', exact: true }).click();
  await expect(
    optional.getByRole('button', { name: 'Undo Yesterday’s win', exact: true }),
  ).toBeVisible();
});
