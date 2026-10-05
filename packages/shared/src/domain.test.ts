import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  addDays,
  applyCompletion,
  completionKey,
  completionOperationSchema,
  createUser,
  dateSchema,
  localDate,
  progressFor,
  scheduled,
  type CompletionOperation,
  type UserDocument,
} from './index.js';
const now = new Date('2026-10-05T12:00:00Z');
function fixture() {
  const doc = createUser(randomUUID());
  const id = randomUUID();
  doc.habits.push({
    id,
    title: 'Walk',
    description: '',
    color: 'sage',
    archivedAt: null,
    schedules: [{ from: '2026-10-01', weekdays: [1, 2, 3, 4, 5], timezone: 'Europe/Berlin' }],
  });
  return { doc, id };
}
function operation(
  id: string,
  date: string,
  completed = true,
  expectedVersion = 0,
): CompletionOperation {
  return {
    operationId: randomUUID(),
    targetType: 'habit',
    targetId: id,
    date,
    timezone: 'Europe/Berlin',
    completed,
    expectedVersion,
  };
}
function check(doc: UserDocument, id: string, date: string) {
  applyCompletion(doc, operation(id, date), now);
}
describe('calendar and scheduling', () => {
  it('rejects impossible calendar dates', () => {
    expect(dateSchema.safeParse('2026-02-30').success).toBe(false);
    expect(dateSchema.safeParse('2028-02-29').success).toBe(true);
  });
  it('uses the user timezone rather than host timezone', () => {
    expect(localDate('America/Los_Angeles', new Date('2026-10-05T00:30:00Z'))).toBe('2026-10-04');
    expect(localDate('Asia/Tokyo', new Date('2026-10-05T23:30:00Z'))).toBe('2026-10-06');
  });
  it('handles DST and calendar arithmetic', () => {
    expect(localDate('Europe/Berlin', new Date('2026-03-29T01:30:00Z'))).toBe('2026-03-29');
    expect(addDays('2026-03-29', 1)).toBe('2026-03-30');
  });
  it('respects selected weekdays and schedule history', () => {
    const { doc, id } = fixture();
    const habit = doc.habits[0]!;
    habit.schedules.push({ from: '2026-10-06', weekdays: [0], timezone: 'UTC' });
    expect(scheduled(habit, '2026-10-05')).toBe(true);
    expect(scheduled(habit, '2026-10-06')).toBe(false);
    check(doc, id, '2026-10-02');
    expect(progressFor(doc, now).habits[id]!.count).toBe(1);
  });
});
describe('completion operations', () => {
  it('is idempotent across retries and devices', () => {
    const { doc, id } = fixture();
    const op = operation(id, '2026-10-02');
    applyCompletion(doc, op, now);
    applyCompletion(doc, op, now);
    applyCompletion(doc, operation(id, '2026-10-02'), now);
    expect(progressFor(doc, now).xp).toBe(10);
  });
  it('rejects a reused operation id with a different payload', () => {
    const { doc, id } = fixture();
    const op = operation(id, '2026-10-02');
    applyCompletion(doc, op, now);
    expect(() => applyCompletion(doc, { ...op, completed: false }, now)).toThrow(
      'OPERATION_REUSED',
    );
  });
  it('detects stale undo without undoing the other device', () => {
    const { doc, id } = fixture();
    check(doc, id, '2026-10-02');
    expect(() => applyCompletion(doc, operation(id, '2026-10-02', false, 0), now)).toThrow(
      'COMPLETION_CONFLICT',
    );
    expect(progressFor(doc, now).xp).toBe(10);
  });
  it('keeps the original date when offline changes arrive later', () => {
    const { doc, id } = fixture();
    check(doc, id, '2026-10-02');
    expect(doc.completions[completionKey('habit', id, '2026-10-02')]!.date).toBe('2026-10-02');
  });
  it('rejects unscheduled, future and wrong-timezone occurrences', () => {
    const { doc, id } = fixture();
    for (const op of [
      operation(id, '2026-10-03'),
      operation(id, '2026-10-06'),
      { ...operation(id, '2026-10-02'), timezone: 'UTC' },
    ])
      expect(() => applyCompletion(doc, op, now)).toThrow('INVALID_OCCURRENCE');
  });
  it('rejects client-supplied awards', () => {
    expect(
      completionOperationSchema.safeParse({ ...operation(randomUUID(), '2026-10-02'), xp: 1000 })
        .success,
    ).toBe(false);
  });
});
describe('progress, streaks and rewards', () => {
  it('skips unscheduled days and leaves today open', () => {
    const { doc, id } = fixture();
    check(doc, id, '2026-10-01');
    check(doc, id, '2026-10-02');
    expect(progressFor(doc, now).habits[id]).toEqual({ count: 2, current: 2, best: 2 });
    check(doc, id, '2026-10-05');
    expect(progressFor(doc, now).habits[id]!.current).toBe(3);
  });
  it('breaks a streak after a missed scheduled occurrence', () => {
    const { doc, id } = fixture();
    check(doc, id, '2026-10-01');
    check(doc, id, '2026-10-05');
    expect(progressFor(doc, now).habits[id]).toEqual({ count: 2, current: 1, best: 1 });
  });
  it('recalculates XP, streaks, badges and gifts on undo', () => {
    const { doc, id } = fixture();
    ['2026-10-01', '2026-10-02', '2026-10-05'].forEach((date) => check(doc, id, date));
    const giftId = randomUUID();
    doc.gifts.push({
      id: giftId,
      title: 'Shoes',
      targetType: 'habitStreak',
      targetId: id,
      threshold: 3,
      claimedAt: null,
      archivedAt: null,
    });
    expect(progressFor(doc, now).badges).toContain('streak-3');
    expect(progressFor(doc, now).gifts[giftId]!.state).toBe('available');
    applyCompletion(doc, operation(id, '2026-10-02', false, 1), now);
    expect(progressFor(doc, now).xp).toBe(20);
    expect(progressFor(doc, now).badges).not.toContain('streak-3');
    expect(progressFor(doc, now).gifts[giftId]!.state).toBe('locked');
    doc.gifts[0]!.claimedAt = now.toISOString();
    expect(progressFor(doc, now).gifts[giftId]!.state).toBe('claimed');
  });
  it('does not complete empty goals or award duplicate goal XP', () => {
    const doc = createUser(randomUUID()),
      id = randomUUID(),
      stepId = randomUUID();
    doc.goals.push({
      id,
      title: 'Home',
      description: '',
      color: 'lavender',
      archivedAt: null,
      steps: [],
    });
    expect(progressFor(doc, now).goals[id]!.done).toBe(false);
    doc.goals[0]!.steps.push({ id: stepId, title: 'Tidy', date: null, archivedAt: null });
    applyCompletion(doc, { ...operation(stepId, '2026-10-05'), targetType: 'step' }, now);
    expect(progressFor(doc, now).goals[id]!.done).toBe(true);
    expect(progressFor(doc, now).xp).toBe(10);
    expect(progressFor(doc, now).badges).toContain('first-goal');
  });
  it('starts at level one and advances each 100 XP', () => {
    const { doc, id } = fixture();
    doc.habits[0]!.schedules[0]!.weekdays = [0, 1, 2, 3, 4, 5, 6];
    doc.habits[0]!.schedules[0]!.from = '2026-09-01';
    expect(progressFor(doc, now).level).toBe(1);
    for (let i = 0; i < 10; i++) check(doc, id, addDays('2026-09-01', i));
    expect(progressFor(doc, now)).toMatchObject({ xp: 100, level: 2, levelXp: 0 });
  });
  it('dates a re-completed goal step on the new day without double XP', () => {
    const doc = createUser(randomUUID()),
      id = randomUUID();
    doc.goals.push({
      id: randomUUID(),
      title: 'Home',
      description: '',
      color: 'sage',
      archivedAt: null,
      steps: [{ id, title: 'Tidy', date: null, archivedAt: null }],
    });
    applyCompletion(doc, { ...operation(id, '2026-10-02'), targetType: 'step' }, now);
    applyCompletion(doc, { ...operation(id, '2026-10-02', false, 1), targetType: 'step' }, now);
    applyCompletion(doc, { ...operation(id, '2026-10-05', true, 2), targetType: 'step' }, now);
    expect(doc.completions[completionKey('step', id, '')]!.date).toBe('2026-10-05');
    expect(progressFor(doc, now).xp).toBe(10);
  });
  it('preserves archived history and permits correcting it', () => {
    const { doc, id } = fixture();
    check(doc, id, '2026-10-02');
    doc.habits[0]!.archivedAt = now.toISOString();
    expect(progressFor(doc, now).xp).toBe(10);
    expect(() => check(doc, id, '2026-10-05')).toThrow('TASK_ARCHIVED');
    applyCompletion(doc, operation(id, '2026-10-02', false, 1), now);
    expect(progressFor(doc, now).xp).toBe(0);
  });
});
