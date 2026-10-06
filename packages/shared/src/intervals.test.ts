import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  applyCompletion,
  createUser,
  mergeDocuments,
  mutateDocument,
  occurrenceFor,
  operationKey,
  periodFor,
  progressFor,
  scheduleChangeDate,
  scheduleFor,
  scheduled,
  syncDocumentSchema,
  userDocumentSchema,
  type HabitSchedule,
  type Recurrence,
  type UserDocument,
} from './index.js';

const now = new Date('2026-10-06T12:00:00Z');
function fixture(unit: Recurrence['unit'] = 'week', every = 1, start = '2026-10-06') {
  const doc = createUser(randomUUID());
  doc.preferences.timezone = 'UTC';
  const id = randomUUID();
  mutateDocument(
    doc,
    '/api/habits',
    'POST',
    {
      title: 'Read',
      weekdays: [0, 1, 2, 3, 4, 5, 6],
      recurrence: { unit, every, anchor: start },
    },
    id,
    new Date(`${start}T12:00:00Z`),
  );
  return { doc, id, habit: doc.habits[0]! };
}
function check(doc: UserDocument, id: string, date: string, completed = true) {
  const key = operationKey(doc, 'habit', id, date);
  applyCompletion(
    doc,
    {
      operationId: randomUUID(),
      targetType: 'habit',
      targetId: id,
      date,
      timezone: scheduleFor(
        doc.habits.find((h) => h.id === id)!,
        date,
      )!.timezone,
      completed,
      expectedVersion: doc.completions[key]?.version ?? 0,
    },
    new Date(`${date}T20:00:00Z`),
  );
}

describe('calendar periods', () => {
  it.each([
    ['week', 1, '2026-10-06', '2026-10-11', '2026-10-06', '2026-10-11'],
    ['week', 1, '2026-10-06', '2026-10-12', '2026-10-12', '2026-10-18'],
    ['week', 2, '2026-10-06', '2026-10-18', '2026-10-06', '2026-10-18'],
    ['week', 2, '2026-10-06', '2026-10-19', '2026-10-19', '2026-11-01'],
    ['day', 3, '2026-10-06', '2026-10-08', '2026-10-06', '2026-10-08'],
    ['day', 3, '2026-10-06', '2026-10-09', '2026-10-09', '2026-10-11'],
    ['month', 1, '2024-02-15', '2024-02-29', '2024-02-15', '2024-02-29'],
    ['month', 1, '2025-02-15', '2025-02-28', '2025-02-15', '2025-02-28'],
    ['month', 2, '2026-12-15', '2027-01-31', '2026-12-15', '2027-01-31'],
    ['month', 2, '2026-12-15', '2027-02-01', '2027-02-01', '2027-03-31'],
    ['week', 1, '2026-12-30', '2027-01-01', '2026-12-30', '2027-01-03'],
  ] as const)('%s every %i: %s through %s', (unit, every, from, date, start, end) => {
    const schedule: HabitSchedule = {
      from,
      weekdays: [0],
      timezone: 'Europe/Berlin',
      recurrence: { unit, every, anchor: from },
    };
    expect(periodFor(schedule, date)).toEqual({ start, end });
  });

  it('keeps a future start unavailable, including the earlier portion of its calendar period', () => {
    const { doc, habit } = fixture();
    mutateDocument(
      doc,
      '/api/habits',
      'POST',
      {
        title: 'Later',
        weekdays: [0],
        startDate: '2026-11-18',
        recurrence: { unit: 'month', every: 1, anchor: '2026-11-18' },
      },
      randomUUID(),
      now,
    );
    const later = doc.habits[1]!;
    expect(scheduled(later, '2026-11-17')).toBe(false);
    expect(occurrenceFor(later, '2026-11-18')).toMatchObject({
      start: '2026-11-18',
      end: '2026-11-30',
    });
    expect(scheduled(habit, '2026-10-05')).toBe(false);
  });

  it('rejects invalid intervals and past start dates', () => {
    for (const every of [0, 366, 1.5]) {
      expect(() => fixture('day', every)).toThrow();
    }
    const { doc } = fixture();
    expect(() =>
      mutateDocument(
        doc,
        '/api/habits',
        'POST',
        {
          title: 'Past',
          weekdays: [0],
          startDate: '2026-10-05',
        },
        randomUUID(),
        now,
      ),
    ).toThrow('VALIDATION_ERROR');
  });
});

describe('period completions and streaks', () => {
  it('counts one win per period and retains the actual checkoff date on retries', () => {
    const { doc, id } = fixture();
    check(doc, id, '2026-10-07');
    check(doc, id, '2026-10-10');
    expect(Object.keys(doc.completions)).toEqual([`habit:${id}:2026-10-06`]);
    expect(Object.values(doc.completions)[0]).toMatchObject({
      date: '2026-10-07',
      periodStart: '2026-10-06',
      version: 1,
    });
    expect(progressFor(doc, new Date('2026-10-11T12:00:00Z'))).toMatchObject({
      xp: 10,
      habits: { [id]: { count: 1, current: 1, best: 1 } },
    });
    expect(syncDocumentSchema.safeParse(doc).success).toBe(true);
  });

  it('leaves an unfinished current period open and resets after a whole missed period', () => {
    const { doc, id } = fixture();
    check(doc, id, '2026-10-07');
    expect(progressFor(doc, new Date('2026-10-18T23:00:00Z')).habits[id]!.current).toBe(1);
    expect(progressFor(doc, new Date('2026-10-19T00:00:00Z')).habits[id]!.current).toBe(0);
    check(doc, id, '2026-10-20');
    expect(progressFor(doc, new Date('2026-10-20T22:00:00Z')).habits[id]).toEqual({
      count: 2,
      current: 1,
      best: 1,
    });
  });

  it('undoes through any day in the period and recalculates XP, badges and gifts', () => {
    const { doc, id } = fixture();
    for (const date of ['2026-10-07', '2026-10-14', '2026-10-21']) check(doc, id, date);
    const giftId = randomUUID();
    doc.gifts.push({
      id: giftId,
      title: 'Book',
      targetType: 'habitStreak',
      targetId: id,
      threshold: 3,
      archivedAt: null,
      claimedAt: null,
    });
    const end = new Date('2026-10-25T12:00:00Z');
    expect(progressFor(doc, end).badges).toContain('streak-3');
    expect(progressFor(doc, end).gifts[giftId]!.state).toBe('available');
    check(doc, id, '2026-10-16', false);
    expect(progressFor(doc, end)).toMatchObject({
      xp: 20,
      habits: { [id]: { count: 2, current: 1, best: 1 } },
    });
    expect(progressFor(doc, end).gifts[giftId]!.state).toBe('locked');
    check(doc, id, '2026-10-18');
    expect(doc.completions[operationKey(doc, 'habit', id, '2026-10-18')]!.date).toBe('2026-10-14');
    expect(progressFor(doc, end).habits[id]!.best).toBe(3);
  });

  it('freezes an archived habit without discarding its current period or XP', () => {
    const { doc, id, habit } = fixture('month');
    check(doc, id, '2026-10-07');
    habit.archivedAt = '2026-10-12T12:00:00Z';
    expect(progressFor(doc, new Date('2027-01-01T12:00:00Z'))).toMatchObject({
      xp: 10,
      habits: { [id]: { count: 1, current: 1, best: 1 } },
    });
  });
});

describe('schedule history and synchronization', () => {
  it('preserves legacy streaks across old weekday edits and resets only newly edited rhythms', () => {
    const { doc, id, habit } = fixture('day', 1, '2026-10-01');
    delete habit.schedules[0]!.recurrence;
    habit.schedules.push({ from: '2026-10-05', weekdays: [1], timezone: 'UTC' });
    for (const date of ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05'])
      check(doc, id, date);
    expect(progressFor(doc, now).habits[id]).toEqual({ count: 5, current: 5, best: 5 });
    mutateDocument(
      doc,
      `/api/habits/${id}`,
      'PATCH',
      { weekdays: [0, 1, 2, 3, 4, 5, 6] },
      randomUUID(),
      now,
    );
    expect(habit.schedules[2]).toMatchObject({ from: '2026-10-07', resetStreak: true });
    expect(progressFor(doc, new Date('2026-10-07T12:00:00Z')).habits[id]).toEqual({
      count: 5,
      current: 0,
      best: 5,
    });
    check(doc, id, '2026-10-07');
    mutateDocument(
      doc,
      '/api/preferences',
      'PATCH',
      { timezone: 'Europe/Berlin' },
      randomUUID(),
      new Date('2026-10-07T12:00:00Z'),
    );
    expect(habit.schedules.at(-1)!.resetStreak).toBeUndefined();
    expect(progressFor(doc, new Date('2026-10-08T12:00:00Z')).habits[id]).toEqual({
      count: 6,
      current: 1,
      best: 5,
    });
  });

  it('allows a future habit to move its start earlier without making timezone edits activate it', () => {
    const { doc, id, habit } = fixture('month', 1, '2026-11-01');
    expect(scheduleChangeDate(habit, now)).toBe('2026-10-06');
    mutateDocument(
      doc,
      '/api/preferences',
      'PATCH',
      { timezone: 'Europe/Berlin' },
      randomUUID(),
      now,
    );
    expect(habit.schedules).toHaveLength(1);
    expect(habit.schedules[0]!.from).toBe('2026-11-01');
    mutateDocument(
      doc,
      `/api/habits/${id}`,
      'PATCH',
      {
        startDate: '2026-10-12',
        recurrence: { unit: 'week', every: 2, anchor: '2026-10-12' },
      },
      randomUUID(),
      now,
    );
    expect(habit.schedules).toHaveLength(1);
    expect(habit.schedules[0]).toMatchObject({ from: '2026-10-12', timezone: 'Europe/Berlin' });
    expect(scheduled(habit, '2026-10-11')).toBe(false);
  });

  it('does not resurrect a replaced future start from the cached sync baseline', () => {
    const { doc: base, id } = fixture();
    mutateDocument(
      base,
      `/api/habits/${id}`,
      'PATCH',
      {
        startDate: '2026-11-01',
        recurrence: { unit: 'month', every: 2, anchor: '2026-11-01' },
      },
      randomUUID(),
      now,
    );
    const local = structuredClone(base),
      server = structuredClone(base);
    mutateDocument(
      local,
      `/api/habits/${id}`,
      'PATCH',
      {
        startDate: '2026-10-12',
        recurrence: { unit: 'week', every: 2, anchor: '2026-10-12' },
      },
      randomUUID(),
      now,
    );
    const merged = mergeDocuments(base, local, server);
    expect(merged.habits[0]!.schedules).toEqual(local.habits[0]!.schedules);
    expect(mergeDocuments(base, server, local).habits[0]!.schedules).toEqual(
      local.habits[0]!.schedules,
    );
  });

  it('starts an interval change after the current period, resetting current but retaining best', () => {
    const { doc, id, habit } = fixture('week', 1, '2026-09-28');
    check(doc, id, '2026-09-29');
    check(doc, id, '2026-10-06');
    mutateDocument(
      doc,
      `/api/habits/${id}`,
      'PATCH',
      { recurrence: { unit: 'month', every: 1, anchor: '2026-10-12' } },
      randomUUID(),
      now,
    );
    expect(habit.schedules.at(-1)!.from).toBe('2026-10-12');
    expect(progressFor(doc, now).habits[id]!.current).toBe(2);
    expect(progressFor(doc, new Date('2026-10-12T12:00:00Z')).habits[id]).toEqual({
      count: 2,
      current: 0,
      best: 2,
    });
    expect(occurrenceFor(habit, '2026-10-12')).toMatchObject({
      start: '2026-10-12',
      end: '2026-10-31',
    });
    check(doc, id, '2026-10-15');
    expect(progressFor(doc, new Date('2026-10-15T22:00:00Z')).habits[id]).toEqual({
      count: 3,
      current: 1,
      best: 2,
    });
  });

  it('replaces a pending edit and preserves timezone changes without resetting the rhythm', () => {
    const { doc, id, habit } = fixture();
    check(doc, id, '2026-10-06');
    for (const unit of ['month', 'day'] as const)
      mutateDocument(
        doc,
        `/api/habits/${id}`,
        'PATCH',
        {
          recurrence: { unit, every: 2, anchor: '2026-10-12' },
        },
        randomUUID(),
        now,
      );
    expect(habit.schedules).toHaveLength(2);
    expect(habit.schedules[1]).toMatchObject({
      from: '2026-10-12',
      recurrence: { unit: 'day', every: 2 },
    });
    expect(scheduleChangeDate(habit, now)).toBe('2026-10-12');
    const timezoneOnly = fixture();
    check(timezoneOnly.doc, timezoneOnly.id, '2026-10-06');
    mutateDocument(
      timezoneOnly.doc,
      '/api/preferences',
      'PATCH',
      { timezone: 'Europe/Berlin' },
      randomUUID(),
      now,
    );
    expect(timezoneOnly.habit.schedules[1]).toMatchObject({
      from: '2026-10-12',
      timezone: 'Europe/Berlin',
      recurrence: timezoneOnly.habit.schedules[0]!.recurrence,
    });
    expect(
      progressFor(timezoneOnly.doc, new Date('2026-10-12T12:00:00Z')).habits[timezoneOnly.id]!
        .current,
    ).toBe(1);
  });

  it('preserves the boundary and anchor over DST and uses the schedule timezone at midnight', () => {
    const { doc, id, habit } = fixture('week', 1, '2026-10-19');
    habit.schedules[0]!.timezone = 'Europe/Berlin';
    doc.preferences.timezone = 'Europe/Berlin';
    check(doc, id, '2026-10-19');
    expect(scheduleChangeDate(habit, new Date('2026-10-25T21:00:00Z'))).toBe('2026-10-26');
    expect(occurrenceFor(habit, '2026-10-25')).toMatchObject({
      start: '2026-10-19',
      end: '2026-10-25',
    });
    expect(progressFor(doc, new Date('2026-11-01T22:59:00Z')).habits[id]!.current).toBe(1);
    expect(progressFor(doc, new Date('2026-11-01T23:00:00Z')).habits[id]!.current).toBe(0);
  });

  it('merges concurrent checkoffs on different dates into one period win', () => {
    const { doc: base, id } = fixture();
    const local = structuredClone(base),
      server = structuredClone(base);
    check(local, id, '2026-10-07');
    check(server, id, '2026-10-09');
    const merged = mergeDocuments(base, local, server);
    expect(progressFor(merged, new Date('2026-10-10T12:00:00Z')).xp).toBe(10);
    expect(Object.values(merged.completions)[0]!.date).toBe('2026-10-09');
    check(local, id, '2026-10-10', false);
    expect(Object.values(mergeDocuments(base, local, server).completions)[0]!.completed).toBe(true);
  });

  it('merges recurrence and weekday selection atomically on an effective-date conflict', () => {
    const { doc: base, id } = fixture();
    const local = structuredClone(base),
      server = structuredClone(base);
    mutateDocument(
      local,
      `/api/habits/${id}`,
      'PATCH',
      { recurrence: { unit: 'month', every: 2, anchor: '2026-10-12' } },
      randomUUID(),
      now,
    );
    mutateDocument(
      server,
      `/api/habits/${id}`,
      'PATCH',
      { recurrence: null, weekdays: [1] },
      randomUUID(),
      now,
    );
    expect(mergeDocuments(base, local, server).habits[0]!.schedules[1]).toEqual(
      server.habits[0]!.schedules[1],
    );
  });

  it('reads legacy documents without rewriting daily identities and validates period references', () => {
    const { doc, id, habit } = fixture();
    delete habit.schedules[0]!.recurrence;
    check(doc, id, '2026-10-06');
    expect(userDocumentSchema.parse(doc)).toEqual(doc);
    expect(doc.completions[`habit:${id}:2026-10-06`]!.periodStart).toBeUndefined();
    expect(syncDocumentSchema.safeParse(doc).success).toBe(true);
    doc.completions[`habit:${id}:2026-10-06`]!.periodStart = '2026-10-07';
    expect(syncDocumentSchema.safeParse(doc).success).toBe(false);
  });
});
