import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  createUser,
  habitInputSchema,
  preferencesSchema,
  mutateDocument,
  operationKey,
  userDocumentSchema,
  type UserDocument,
} from './index.js';
import { dueReminders, nextLocalMidnight } from './reminders.js';
import { mergeDocuments } from './merge.js';

function fixture(timezone = 'Europe/Berlin') {
  const doc = createUser(randomUUID());
  doc.preferences.timezone = timezone;
  mutateDocument(
    doc,
    '/api/habits',
    'POST',
    { title: 'Read', weekdays: [0, 1, 2, 3, 4, 5, 6], reminderTime: '09:00' },
    randomUUID(),
    new Date('2026-10-01T06:00:00Z'),
  );
  return doc;
}
function complete(doc: UserDocument, date: string) {
  const habit = doc.habits[0]!;
  const key = operationKey(doc, 'habit', habit.id, date);
  doc.completions[key] = {
    key,
    targetType: 'habit',
    targetId: habit.id,
    date,
    timezone: doc.preferences.timezone,
    completed: true,
    version: 1,
    updatedAt: '2026-10-07T06:00:00Z',
  };
}
describe('habit reminders', () => {
  it('keeps legacy documents valid and disabled; validates clock times', () => {
    const doc = fixture();
    delete doc.habits[0]!.reminderTime;
    expect(userDocumentSchema.parse(doc).habits[0]!.reminderTime).toBeUndefined();
    expect(dueReminders(doc, new Date('2026-10-07T12:00:00Z'))).toEqual([]);
    for (const time of ['24:00', '12:60', '9:00', '09:00:00', ''])
      expect(
        habitInputSchema.safeParse({ title: 'Read', weekdays: [1], reminderTime: time }).success,
      ).toBe(false);
    for (const time of ['00:00', '09:00', '23:59', null])
      expect(
        habitInputSchema.safeParse({ title: 'Read', weekdays: [1], reminderTime: time }).success,
      ).toBe(true);
  });
  it('catches up today, using the active timezone, and suppresses completed or archived habits', () => {
    const doc = fixture();
    doc.preferences.checkInReminder = false;
    expect(dueReminders(doc, new Date('2026-10-07T06:59:00Z'))).toEqual([]);
    expect(dueReminders(doc, new Date('2026-10-07T07:00:00Z'))).toMatchObject([
      { date: '2026-10-07', expiresAt: Date.parse('2026-10-07T22:00:00Z') },
    ]);
    expect(dueReminders(doc, new Date('2026-10-07T20:00:00Z'))).toHaveLength(1);
    complete(doc, '2026-10-07');
    expect(dueReminders(doc, new Date('2026-10-07T20:00:00Z'))).toEqual([]);
    doc.habits[0]!.archivedAt = '2026-10-07T12:00:00Z';
    expect(dueReminders(doc, new Date('2026-10-08T12:00:00Z'))).toEqual([]);
  });
  it('respects weekdays, future starts, and pending schedules', () => {
    const doc = fixture();
    doc.habits[0]!.schedules[0]!.weekdays = [1];
    expect(dueReminders(doc, new Date('2026-10-07T12:00:00Z'))).toEqual([]);
    doc.habits[0]!.schedules[0]!.from = '2026-10-10';
    expect(dueReminders(doc, new Date('2026-10-07T12:00:00Z'))).toEqual([]);
    const other = fixture();
    other.preferences.timezone = 'America/New_York';
    other.habits[0]!.schedules.push({
      from: '2026-10-08',
      weekdays: [0, 1, 2, 3, 4, 5, 6],
      timezone: 'America/New_York',
    });
    expect(dueReminders(other, new Date('2026-10-07T07:00:00Z'))).toHaveLength(1);
    expect(dueReminders(other, new Date('2026-10-08T07:00:00Z'))).toEqual([]);
    expect(dueReminders(other, new Date('2026-10-08T13:00:00Z'))).toHaveLength(1);
  });
  it.each([
    ['day', 3],
    ['week', 1],
    ['month', 1],
  ] as const)('reminds daily for %s periods until done', (unit, every) => {
    const doc = fixture();
    doc.habits[0]!.schedules[0]!.recurrence = { unit, every, anchor: '2026-10-01' };
    expect(dueReminders(doc, new Date('2026-10-07T12:00:00Z'))).toHaveLength(1);
    complete(doc, '2026-10-07');
    expect(dueReminders(doc, new Date('2026-10-08T12:00:00Z'))).toEqual([]);
    expect(dueReminders(doc, new Date('2026-11-02T12:00:00Z'))).toHaveLength(1);
  });
  it('handles missing and repeated DST times and 23/25-hour day expiry', () => {
    const doc = fixture();
    doc.habits[0]!.schedules[0]!.from = '2026-01-01';
    doc.habits[0]!.reminderTime = '02:30';
    expect(dueReminders(doc, new Date('2026-03-29T00:59:00Z'))).toEqual([]);
    expect(dueReminders(doc, new Date('2026-03-29T01:00:00Z'))).toHaveLength(1);
    expect(dueReminders(doc, new Date('2026-10-25T00:30:00Z'))).toHaveLength(1);
    expect(dueReminders(doc, new Date('2026-10-25T01:30:00Z'))).toHaveLength(1);
    expect(nextLocalMidnight('Europe/Berlin', new Date('2026-03-28T23:00:00Z'))).toBe(
      Date.parse('2026-03-29T22:00:00Z'),
    );
    expect(nextLocalMidnight('Europe/Berlin', new Date('2026-10-24T22:00:00Z'))).toBe(
      Date.parse('2026-10-25T23:00:00Z'),
    );
  });
  it('merges reminder edits independently and resolves competing edits in favor of server', () => {
    const base = fixture();
    const local = structuredClone(base),
      server = structuredClone(base);
    local.habits[0]!.reminderTime = '12:00';
    server.habits[0]!.title = 'Read books';
    expect(mergeDocuments(base, local, server).habits[0]).toMatchObject({
      reminderTime: '12:00',
      title: 'Read books',
    });
    server.habits[0]!.reminderTime = null;
    expect(mergeDocuments(base, local, server).habits[0]!.reminderTime).toBeNull();
    mutateDocument(
      local,
      `/api/habits/${local.habits[0]!.id}`,
      'PATCH',
      { reminderTime: null },
      randomUUID(),
    );
    expect(local.habits[0]!.reminderTime).toBeNull();
    expect(local.habits[0]!.schedules).toEqual(base.habits[0]!.schedules);
  });
});

describe('goal and step reminders', () => {
  function tasks() {
    const doc = createUser(randomUUID());
    mutateDocument(
      doc,
      '/api/goals',
      'POST',
      { title: 'Home', date: '2026-10-07', reminderTime: '09:00' },
      randomUUID(),
    );
    mutateDocument(
      doc,
      `/api/goals/${doc.goals[0]!.id}/steps`,
      'POST',
      { title: 'Shelf', reminderTime: '10:00' },
      randomUUID(),
    );
    mutateDocument(
      doc,
      `/api/goals/${doc.goals[0]!.id}/steps`,
      'POST',
      { title: 'Plant', date: '2026-10-08', reminderTime: '11:00' },
      randomUUID(),
    );
    return doc;
  }
  it('supports independent dates and times, catches up after due dates, and uses the profile timezone', () => {
    const doc = tasks();
    expect(dueReminders(doc, new Date('2026-10-06T07:00:00Z'))).toEqual([]);
    expect(dueReminders(doc, new Date('2026-10-06T08:00:00Z')).map((r) => r.title)).toEqual([
      'Shelf',
    ]);
    expect(dueReminders(doc, new Date('2026-10-07T07:00:00Z'))).toMatchObject([
      { targetType: 'goal', targetId: doc.goals[0]!.id, title: 'Home', date: '2026-10-07' },
    ]);
    expect(dueReminders(doc, new Date('2026-10-08T09:00:00Z')).map((r) => r.title)).toEqual([
      'Home',
      'Shelf',
      'Plant',
    ]);
    doc.preferences.timezone = 'America/New_York';
    expect(dueReminders(doc, new Date('2026-10-08T09:00:00Z'))).toEqual([]);
    expect(dueReminders(doc, new Date('2026-10-08T15:00:00Z'))).toHaveLength(3);
  });
  it('suppresses completed steps, completed goals, archived steps and archived parents', () => {
    const doc = tasks(),
      goal = doc.goals[0]!;
    const now = new Date('2026-10-08T12:00:00Z');
    for (const step of goal.steps) {
      const key = `step:${step.id}`;
      doc.completions[key] = {
        key,
        targetType: 'step',
        targetId: step.id,
        completed: true,
        date: '2026-10-08',
        timezone: doc.preferences.timezone,
        updatedAt: now.toISOString(),
        version: 1,
      };
    }
    expect(dueReminders(doc, now)).toEqual([]);
    doc.completions = {};
    goal.steps[0]!.archivedAt = now.toISOString();
    expect(dueReminders(doc, now).map((r) => r.title)).toEqual(['Home', 'Plant']);
    goal.archivedAt = now.toISOString();
    expect(dueReminders(doc, now)).toEqual([]);
  });
  it('keeps legacy defaults disabled and merges dates and reminders independently', () => {
    const base = tasks();
    delete base.goals[0]!.date;
    delete base.goals[0]!.reminderTime;
    for (const step of base.goals[0]!.steps) delete step.reminderTime;
    expect(userDocumentSchema.parse(base).goals[0]!.date).toBeUndefined();
    expect(dueReminders(base, new Date('2026-10-08T12:00:00Z'))).toEqual([]);
    const local = structuredClone(base),
      server = structuredClone(base);
    local.goals[0]!.date = '2026-10-09';
    local.goals[0]!.steps[0]!.reminderTime = '12:00';
    server.goals[0]!.reminderTime = '10:00';
    server.goals[0]!.steps[0]!.date = '2026-10-08';
    const merged = mergeDocuments(base, local, server);
    expect(merged.goals[0]).toMatchObject({ date: '2026-10-09', reminderTime: '10:00' });
    expect(merged.goals[0]!.steps[0]).toMatchObject({ date: '2026-10-08', reminderTime: '12:00' });
  });
});

describe('evening check-in reminder', () => {
  function quiet() {
    const doc = fixture();
    doc.habits[0]!.reminderTime = null;
    return doc;
  }
  const checkIns = (doc: UserDocument, now: string) =>
    dueReminders(doc, new Date(now)).filter((r) => r.targetType === 'checkIn');

  it('is on by default at 20:00 profile time while habits are open and nothing was checked off', () => {
    const doc = quiet();
    expect(checkIns(doc, '2026-10-07T17:59:00Z')).toEqual([]);
    expect(dueReminders(doc, new Date('2026-10-07T18:00:00Z'))).toEqual([
      {
        targetType: 'checkIn',
        targetId: 'check-in',
        date: '2026-10-07',
        title: 'Your habits are still waiting for you today. A small step is enough.',
        language: 'en',
        expiresAt: Date.parse('2026-10-07T22:00:00Z'),
      },
    ]);
    // A checkoff from an earlier day does not count for today.
    complete(doc, '2026-10-06');
    expect(checkIns(doc, '2026-10-07T21:00:00Z')).toHaveLength(1);
    complete(doc, '2026-10-07');
    expect(checkIns(doc, '2026-10-07T21:00:00Z')).toEqual([]);
  });
  it('counts any checkoff today, including goals and steps', () => {
    const doc = quiet();
    mutateDocument(doc, '/api/goals', 'POST', { title: 'Home' }, randomUUID());
    const goal = doc.goals[0]!;
    doc.completions[`goal:${goal.id}`] = {
      key: `goal:${goal.id}`,
      targetType: 'goal',
      targetId: goal.id,
      date: '2026-10-07',
      timezone: 'Europe/Berlin',
      completed: true,
      version: 1,
      updatedAt: '2026-10-07T08:00:00Z',
    };
    expect(checkIns(doc, '2026-10-07T19:00:00Z')).toEqual([]);
    doc.completions[`goal:${goal.id}`]!.completed = false;
    expect(checkIns(doc, '2026-10-07T19:00:00Z')).toHaveLength(1);
  });
  it('needs an open habit today', () => {
    const doc = quiet();
    doc.habits[0]!.schedules[0]!.weekdays = [1];
    expect(checkIns(doc, '2026-10-07T19:00:00Z')).toEqual([]);
    expect(checkIns(doc, '2026-10-05T19:00:00Z')).toHaveLength(1);
    doc.habits[0]!.archivedAt = '2026-10-05T19:30:00Z';
    expect(checkIns(doc, '2026-10-12T19:00:00Z')).toEqual([]);
    // A weekly habit finished earlier in its period is not open anymore.
    const weekly = quiet();
    weekly.habits[0]!.schedules[0]!.recurrence = { unit: 'week', every: 1, anchor: '2026-10-05' };
    expect(checkIns(weekly, '2026-10-07T19:00:00Z')).toHaveLength(1);
    complete(weekly, '2026-10-05');
    expect(checkIns(weekly, '2026-10-07T19:00:00Z')).toEqual([]);
  });
  it('follows the chosen time, language and timezone, or can be turned off', () => {
    const doc = quiet();
    Object.assign(doc.preferences, { checkInReminderTime: '07:15', language: 'de' });
    expect(checkIns(doc, '2026-10-07T05:14:00Z')).toEqual([]);
    expect(checkIns(doc, '2026-10-07T05:15:00Z')).toMatchObject([
      { title: 'Deine Gewohnheiten warten heute noch auf dich. Ein kleiner Schritt reicht.' },
    ]);
    doc.preferences.checkInReminder = false;
    expect(checkIns(doc, '2026-10-07T21:00:00Z')).toEqual([]);
    const ny = quiet();
    ny.preferences.timezone = 'America/New_York';
    expect(checkIns(ny, '2026-10-07T23:59:00Z')).toEqual([]);
    expect(checkIns(ny, '2026-10-08T00:00:00Z')).toMatchObject([{ date: '2026-10-07' }]);
  });
  it('validates preferences and merges both fields independently', () => {
    expect(preferencesSchema.shape.checkInReminderTime.safeParse('20:60').success).toBe(false);
    expect(preferencesSchema.shape.checkInReminderTime.safeParse(null).success).toBe(false);
    const base = quiet();
    const local = structuredClone(base),
      server = structuredClone(base);
    local.preferences.checkInReminderTime = '21:00';
    server.preferences.checkInReminder = false;
    expect(mergeDocuments(base, local, server).preferences).toMatchObject({
      checkInReminder: false,
      checkInReminderTime: '21:00',
    });
  });
});
