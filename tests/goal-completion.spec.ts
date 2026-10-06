import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import {
  addDays,
  applyCompletion,
  completionKey,
  type Goal,
} from '../packages/shared/src/index.js';
import { readSnapshot } from './helpers.js';

const base = 'http://localhost:3100';
const goal = (title: string): Goal => ({
  id: crypto.randomUUID(),
  title,
  description: '',
  color: 'lavender',
  archivedAt: null,
  steps: [],
});

test.beforeEach(async ({ request }) => {
  await request.post('/test/reset', { headers: { origin: base } });
});

async function onboard(page: Page) {
  await page.goto('/');
  await page.getByLabel('What should we call you?').fill('Alex');
  await page.getByRole('button', { name: 'Let’s begin' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  return readSnapshot(page);
}

for (const language of ['en', 'de'] as const) {
  test(`the archive view shows archived steps even when all steps are archived in ${language}`, async ({
    page,
  }) => {
    const { document: doc } = await onboard(page);
    const step = (title: string, archived: boolean) => ({
      id: crypto.randomUUID(),
      title,
      date: null,
      archivedAt: archived ? new Date().toISOString() : null,
    });
    const active = goal('Active goal with history');
    active.steps = [step('Active step', false), step('Archived step', true)];
    const allArchived = goal('Goal with only archived steps');
    allArchived.steps = [step('Last archived step', true)];
    const archived = goal('Archived goal with history');
    archived.steps = [step('Step of archived goal', false), step('Previously archived step', true)];
    archived.archivedAt = new Date().toISOString();
    doc.preferences.language = language;
    doc.goals = [active, allArchived, archived, goal('Unrelated active goal')];
    await page.request.post('/test/seed', { headers: { origin: base }, data: doc });
    await page.goto('/goals');
    await expect(page.getByText('Active step', { exact: true })).toBeVisible();
    await expect(page.getByText('Archived step', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Last archived step', { exact: true })).toHaveCount(0);
    const checkbox = page.getByRole('checkbox', {
      name: language === 'en' ? 'Archived' : 'Archiviert',
      exact: true,
    });
    await checkbox.check();
    for (const title of [
      'Archived step',
      'Last archived step',
      'Step of archived goal',
      'Previously archived step',
    ]) {
      await expect(page.getByText(title, { exact: true })).toBeVisible();
      await expect(
        page.getByRole('button', {
          name: language === 'en' ? `Complete ${title}` : `${title} abschließen`,
          exact: true,
        }),
      ).toBeDisabled();
    }
    await expect(page.getByText('Active step', { exact: true })).toHaveCount(0);
    await expect(
      page.getByRole('heading', { name: 'Unrelated active goal', exact: true }),
    ).toHaveCount(0);
    await expect(page.locator('.step-tools')).toHaveCount(0);
    await checkbox.uncheck();
    await expect(page.getByText('Active step', { exact: true })).toBeVisible();
    await expect(page.getByText('Last archived step', { exact: true })).toHaveCount(0);
  });

  test(`goals without steps complete offline and are highlighted in ${language}`, async ({
    page,
    context,
  }) => {
    const { document: doc, today } = await onboard(page);
    const target = goal('Send the application');
    if (language === 'de') {
      target.steps = [
        {
          id: crypto.randomUUID(),
          title: 'Archived step',
          date: null,
          archivedAt: new Date().toISOString(),
        },
      ];
    }
    doc.preferences.language = language;
    doc.preferences.theme = language === 'de' ? 'dark' : 'light';
    doc.goals = [target, { ...goal('Archived goal'), archivedAt: new Date().toISOString() }];
    await page.request.post('/test/seed', { headers: { origin: base }, data: doc });
    await page.reload();
    const complete =
      language === 'en' ? 'Complete Send the application' : 'Send the application abschließen';
    const undo =
      language === 'en' ? 'Undo Send the application' : 'Send the application rückgängig machen';
    const heading =
      language === 'en' ? 'Goals completed on this day' : 'An diesem Tag abgeschlossene Ziele';
    const highlight = page.getByRole('region', { name: new RegExp(heading) });
    await expect(page.getByRole('button', { name: complete, exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: /Archived goal/ })).toHaveCount(0);
    await expect(highlight).toHaveCount(0);
    await page.goto('/goals');
    const card = page
      .locator('.goal-card')
      .filter({ has: page.getByRole('heading', { name: target.title }) });
    await expect(card.getByText(target.title, { exact: true })).toHaveCount(1);
    await expect(card.locator('.goal-steps, .goal-progress-label')).toHaveCount(0);
    await expect(card.getByRole('button', { name: complete, exact: true })).toBeVisible();
    await expect(
      card.getByRole('button', {
        name: language === 'en' ? 'Add a step' : 'Schritt hinzufügen',
        exact: true,
      }),
    ).toBeVisible();
    expect(
      (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
        .violations,
    ).toEqual([]);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({
      path: `test-results/standalone-goals-${language}-${test.info().project.name}.png`,
      fullPage: true,
    });
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
    await card.getByRole('button', { name: complete, exact: true }).click();
    await expect(card.getByRole('button', { name: undo, exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(card.locator('.goal-complete-status')).toHaveText(
      language === 'en' ? 'Complete' : 'Abgeschlossen',
    );
    await card.getByRole('button', { name: undo, exact: true }).click();
    await expect(card.locator('.goal-complete-status')).toHaveCount(0);
    await card.getByRole('button', { name: complete, exact: true }).click();
    await page.getByRole('navigation').getByRole('link').first().click();
    await expect(highlight.getByRole('link', { name: /Send the application/ })).toBeVisible();
    await expect(page.locator('.daily-hero .hero-copy p span')).toHaveText('10 XP');
    await page.reload();
    await expect(highlight).toBeVisible();
    await expect(page.getByRole('button', { name: undo, exact: true })).toBeVisible();
    expect(
      (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
        .violations,
    ).toEqual([]);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({
      path: `test-results/completed-goals-${language}-${test.info().project.name}.png`,
      fullPage: true,
    });
    await context.setOffline(false);
    const saved = await readSnapshot(page);
    expect(saved.progress.xp).toBe(10);
    expect(saved.progress.goals[target.id]).toMatchObject({
      completed: 1,
      total: 1,
      done: true,
      completedOn: today,
    });
    expect(saved.document.completions[completionKey('goal', target.id, '')]?.completed).toBe(true);
    await page
      .getByRole('button', {
        name: language === 'en' ? 'Previous day' : 'Vorheriger Tag',
        exact: true,
      })
      .click();
    await expect(highlight).toHaveCount(0);
    await expect(page.getByRole('button', { name: undo, exact: true })).toHaveCount(0);
    await page
      .getByRole('button', { name: language === 'en' ? 'Next day' : 'Nächster Tag', exact: true })
      .click();
    await page.getByRole('button', { name: undo, exact: true }).click();
    await expect(highlight).toHaveCount(0);
    await expect(page.getByRole('button', { name: complete, exact: true })).toBeVisible();
    expect((await readSnapshot(page)).progress.xp).toBe(0);
    await page.getByRole('button', { name: complete, exact: true }).click();
    await expect(highlight).toBeVisible();
    expect((await readSnapshot(page)).progress.xp).toBe(10);
  });
}

test('finishing the final step highlights a goal on its completion day and undo removes it', async ({
  page,
}) => {
  const { document: doc, today } = await onboard(page);
  const yesterday = addDays(today, -1);
  const target = goal('A cozy home');
  target.steps = ['First step', 'Final step'].map((title) => ({
    id: crypto.randomUUID(),
    title,
    date: null,
    archivedAt: null,
  }));
  const previous = goal('Yesterday’s goal');
  doc.goals = [target, previous];
  for (const [type, id] of [
    ['step', target.steps[0]!.id],
    ['goal', previous.id],
  ] as const) {
    applyCompletion(doc, {
      operationId: crypto.randomUUID(),
      targetType: type,
      targetId: id,
      date: yesterday,
      timezone: doc.preferences.timezone,
      completed: true,
      expectedVersion: 0,
    });
  }
  await page.request.post('/test/seed', { headers: { origin: base }, data: doc });
  await page.reload();
  await page.goto('/goals');
  const steppedCard = page
    .locator('.goal-card')
    .filter({ has: page.getByRole('heading', { name: target.title }) });
  await expect(steppedCard.locator('.goal-progress-label')).toContainText('1 / 2 steps');
  await expect(steppedCard.locator('.goal-steps .task-row')).toHaveCount(2);
  await expect(steppedCard.locator('.goal-completion')).toHaveCount(0);
  await page.goto('/');
  const highlight = page.getByRole('region', { name: /Goals completed on this day/ });
  await expect(highlight).toHaveCount(0);
  await page.getByRole('button', { name: 'Complete Final step', exact: true }).click();
  await expect(highlight).toContainText('A cozy home');
  await expect(highlight).not.toContainText('Yesterday’s goal');
  await expect(page.locator('.daily-hero .hero-copy p span')).toHaveText('10 XP');
  expect((await readSnapshot(page)).progress.xp).toBe(30);
  await page.getByRole('button', { name: 'Previous day', exact: true }).click();
  await expect(highlight).toContainText('Yesterday’s goal');
  await expect(highlight).not.toContainText('A cozy home');
  await page.getByRole('button', { name: 'Next day', exact: true }).click();
  await page.getByRole('button', { name: 'Undo Final step', exact: true }).click();
  await expect(highlight).toHaveCount(0);
  expect((await readSnapshot(page)).progress.goals[target.id]!.done).toBe(false);
});
