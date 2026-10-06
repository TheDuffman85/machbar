import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  applyCompletion,
  completionKey,
  createUser,
  mergeDocuments,
  mutateDocument,
  progressFor,
  same,
  syncDocumentSchema,
  type UserDocument,
} from './index.js';
const now = new Date('2026-10-05T12:00:00Z');
function fixture() {
  const doc = createUser(randomUUID());
  mutateDocument(
    doc,
    '/api/habits',
    'POST',
    { title: 'Walk', weekdays: [0, 1, 2, 3, 4, 5, 6], description: 'Outside', color: 'blue' },
    randomUUID(),
    now,
  );
  mutateDocument(doc, '/api/goals', 'POST', { title: 'Home' }, randomUUID(), now);
  for (const title of ['Shelf', 'Plant'])
    mutateDocument(
      doc,
      `/api/goals/${doc.goals[0]!.id}/steps`,
      'POST',
      { title },
      randomUUID(),
      now,
    );
  return { base: doc, local: structuredClone(doc), server: structuredClone(doc) };
}
function complete(doc: UserDocument, completed: boolean) {
  const targetId = doc.habits[0]!.id;
  applyCompletion(
    doc,
    {
      operationId: randomUUID(),
      targetType: 'habit',
      targetId,
      date: '2026-10-05',
      timezone: 'Europe/Berlin',
      completed,
      expectedVersion: Object.values(doc.completions)[0]?.version ?? 0,
    },
    now,
  );
}
describe('three-way merge', () => {
  it.each(['local', 'server'] as const)(
    'keeps %s step archiving through concurrent edits, completions and additions',
    (side) => {
      const { base, local, server } = fixture();
      const id = base.goals[0]!.steps[0]!.id;
      const archiving = side === 'local' ? local : server;
      const editing = side === 'local' ? server : local;
      mutateDocument(archiving, `/api/steps/${id}`, 'DELETE', undefined, randomUUID(), now);
      editing.goals[0]!.steps[0]!.title = 'Changed on another device';
      editing.goals[0]!.steps.reverse();
      applyCompletion(
        editing,
        {
          operationId: randomUUID(),
          targetType: 'step',
          targetId: id,
          date: '2026-10-05',
          timezone: 'Europe/Berlin',
          completed: true,
          expectedVersion: 0,
        },
        now,
      );
      mutateDocument(
        editing,
        `/api/goals/${base.goals[0]!.id}/steps`,
        'POST',
        { title: 'New step' },
        randomUUID(),
        now,
      );
      const result = mergeDocuments(base, local, server);
      expect(result.goals[0]!.steps.map((s) => s.title)).toEqual([
        'Plant',
        'Changed on another device',
        'New step',
      ]);
      expect(result.goals[0]!.steps.find((s) => s.id === id)!.archivedAt).toBe(now.toISOString());
      expect(result.completions[completionKey('step', id, '')]?.completed).toBe(true);
      expect(progressFor(result, now).xp).toBe(10);
      expect(syncDocumentSchema.safeParse(result).success).toBe(true);
      expect(same(result, mergeDocuments(base, local, result))).toBe(true);
    },
  );
  it('unions additions, combines independent fields and uses server values for ties', () => {
    const { base, local, server } = fixture();
    local.habits[0]!.title = 'Local';
    server.habits[0]!.title = 'Server';
    local.habits[0]!.description = 'Local description';
    server.preferences.name = 'Remote';
    mutateDocument(local, '/api/goals', 'POST', { title: 'Local new' }, randomUUID(), now);
    mutateDocument(server, '/api/goals', 'POST', { title: 'Server new' }, randomUUID(), now);
    const result = mergeDocuments(base, local, server);
    expect(result.habits[0]).toMatchObject({ title: 'Server', description: 'Local description' });
    expect(result.preferences.name).toBe('Remote');
    expect(result.goals).toHaveLength(3);
    expect(same(result, mergeDocuments(base, local, result))).toBe(true);
  });
  it('allows sequential undo with no remote completion change', () => {
    const { base } = fixture();
    complete(base, true);
    const local = structuredClone(base);
    complete(local, false);
    expect(progressFor(mergeDocuments(base, local, base), now).xp).toBe(0);
  });
  it('completed wins a conflict with a remote undo/recompletion', () => {
    const { base } = fixture();
    complete(base, true);
    const local = structuredClone(base),
      server = structuredClone(base);
    complete(local, false);
    complete(server, false);
    complete(server, true);
    const result = mergeDocuments(base, local, server);
    expect(progressFor(result, now).xp).toBe(10);
    expect(same(result, mergeDocuments(base, local, result))).toBe(true);
  });
  it('a local completion wins a remote undo and retains its original date', () => {
    const { base } = fixture();
    complete(base, true);
    const local = structuredClone(base),
      server = structuredClone(base);
    complete(local, false);
    complete(local, true);
    complete(server, false);
    const result = mergeDocuments(base, local, server);
    expect(Object.values(result.completions)[0]).toMatchObject({
      completed: true,
      date: '2026-10-05',
    });
    expect(progressFor(result, now).xp).toBe(10);
    expect(same(result, mergeDocuments(base, local, result))).toBe(true);
  });
  it('concurrent completions award XP once and preserve operation receipts', () => {
    const { base, local, server } = fixture();
    complete(local, true);
    complete(server, true);
    const result = mergeDocuments(base, local, server);
    expect(progressFor(result, now).xp).toBe(10);
    expect(Object.keys(result.operations)).toHaveLength(2);
  });
  it('archives and claims survive concurrent edits and undo', () => {
    const { base } = fixture();
    complete(base, true);
    mutateDocument(
      base,
      '/api/gifts',
      'POST',
      { title: 'Treat', targetType: 'habitCount', targetId: base.habits[0]!.id, threshold: 1 },
      randomUUID(),
      now,
    );
    const local = structuredClone(base),
      server = structuredClone(base);
    mutateDocument(local, `/api/gifts/${local.gifts[0]!.id}/claim`, 'POST', {}, randomUUID(), now);
    mutateDocument(
      local,
      `/api/habits/${local.habits[0]!.id}`,
      'DELETE',
      undefined,
      randomUUID(),
      now,
    );
    server.habits[0]!.title = 'Remote title';
    complete(server, false);
    const result = mergeDocuments(base, local, server);
    expect(result.habits[0]!.archivedAt).toBe(now.toISOString());
    expect(progressFor(result, now).gifts[result.gifts[0]!.id]!.state).toBe('claimed');
  });
  it('preserves independent step additions and the selected ordering', () => {
    const { base, local, server } = fixture();
    local.goals[0]!.steps.reverse();
    mutateDocument(
      local,
      `/api/goals/${local.goals[0]!.id}/steps`,
      'POST',
      { title: 'Local new' },
      randomUUID(),
      now,
    );
    mutateDocument(
      server,
      `/api/goals/${server.goals[0]!.id}/steps`,
      'POST',
      { title: 'Server new' },
      randomUUID(),
      now,
    );
    expect(mergeDocuments(base, local, server).goals[0]!.steps.map((s) => s.title)).toEqual([
      'Plant',
      'Shelf',
      'Local new',
      'Server new',
    ]);
  });
  it('server ordering wins competing reorderings without losing local additions', () => {
    const { base, local, server } = fixture();
    mutateDocument(
      base,
      `/api/goals/${base.goals[0]!.id}/steps`,
      'POST',
      { title: 'Third' },
      randomUUID(),
      now,
    );
    local.goals[0]!.steps = structuredClone(base.goals[0]!.steps).reverse();
    server.goals[0]!.steps = [
      base.goals[0]!.steps[1]!,
      base.goals[0]!.steps[0]!,
      base.goals[0]!.steps[2]!,
    ];
    expect(mergeDocuments(base, local, server).goals[0]!.steps.map((s) => s.title)).toEqual([
      'Plant',
      'Shelf',
      'Third',
    ]);
  });
  it('merges schedules by date and keeps timezone conflicts consistent', () => {
    const { base, local, server } = fixture();
    mutateDocument(local, '/api/preferences', 'PATCH', { timezone: 'UTC' }, randomUUID(), now);
    mutateDocument(
      server,
      '/api/preferences',
      'PATCH',
      { timezone: 'America/New_York' },
      randomUUID(),
      now,
    );
    const result = mergeDocuments(base, local, server);
    expect(result.preferences.timezone).toBe('America/New_York');
    expect(result.habits[0]!.schedules).toEqual(server.habits[0]!.schedules);
  });
  it('combines a timezone change with independent weekday edits on the same effective date', () => {
    const { base, local, server } = fixture();
    mutateDocument(local, '/api/preferences', 'PATCH', { timezone: 'UTC' }, randomUUID(), now);
    mutateDocument(
      server,
      `/api/habits/${server.habits[0]!.id}`,
      'PATCH',
      { weekdays: [1] },
      randomUUID(),
      now,
    );
    const result = mergeDocuments(base, local, server);
    expect(result.preferences.timezone).toBe('UTC');
    expect(result.habits[0]!.schedules.at(-1)).toEqual({
      from: '2026-10-06',
      weekdays: [1],
      timezone: 'UTC',
      resetStreak: true,
    });
  });
  it('retains edits made after a sync batch was captured', () => {
    const { base, local, server } = fixture();
    local.habits[0]!.title = 'Uploaded';
    server.preferences.name = 'Elsewhere';
    const captured = structuredClone(local);
    const uploaded = mergeDocuments(base, captured, server);
    local.habits[0]!.description = 'While syncing';
    const result = mergeDocuments(captured, local, uploaded);
    expect(result.habits[0]).toMatchObject({ title: 'Uploaded', description: 'While syncing' });
    expect(result.preferences.name).toBe('Elsewhere');
  });
  it('never merges different identities', () => {
    const { base, local, server } = fixture();
    server.userId = randomUUID();
    expect(() => mergeDocuments(base, local, server)).toThrow('ACCOUNT_CHANGED');
  });
});
describe('local feature mutations', () => {
  it('archives steps and preserves history, leaving a goal with no active steps completable', () => {
    const { base } = fixture();
    const goal = base.goals[0]!;
    const id = goal.steps[0]!.id;
    applyCompletion(
      base,
      {
        operationId: randomUUID(),
        targetType: 'step',
        targetId: id,
        date: '2026-10-05',
        timezone: 'Europe/Berlin',
        completed: true,
        expectedVersion: 0,
      },
      now,
    );
    expect(progressFor(base, now).xp).toBe(10);
    mutateDocument(base, `/api/steps/${id}`, 'DELETE', undefined, randomUUID(), now);
    expect(goal.steps.map((s) => s.title)).toEqual(['Shelf', 'Plant']);
    expect(goal.steps[0]!.archivedAt).toBe(now.toISOString());
    expect(progressFor(base, now).xp).toBe(10);
    expect(base.completions[completionKey('step', id, '')]?.completed).toBe(true);
    // Repeated archiving must preserve the original timestamp and history.
    mutateDocument(
      base,
      `/api/steps/${id}`,
      'DELETE',
      undefined,
      randomUUID(),
      new Date('2026-10-06T12:00:00Z'),
    );
    expect(goal.steps[0]!.archivedAt).toBe(now.toISOString());
    mutateDocument(base, `/api/steps/${goal.steps[1]!.id}`, 'DELETE', undefined, randomUUID(), now);
    expect(goal.steps).toHaveLength(2);
    expect(goal.steps.every((s) => s.archivedAt)).toBe(true);
    applyCompletion(
      base,
      {
        operationId: randomUUID(),
        targetType: 'goal',
        targetId: goal.id,
        date: '2026-10-05',
        timezone: 'Europe/Berlin',
        completed: true,
        expectedVersion: 0,
      },
      now,
    );
    expect(progressFor(base, now).goals[goal.id]!.done).toBe(true);
    expect(syncDocumentSchema.safeParse(base).success).toBe(true);
  });
  it('partial edits never inject input defaults into untouched fields', () => {
    const { base } = fixture();
    mutateDocument(
      base,
      `/api/habits/${base.habits[0]!.id}`,
      'PATCH',
      { title: 'Updated' },
      randomUUID(),
      now,
    );
    expect(base.habits[0]).toMatchObject({ description: 'Outside', color: 'blue' });
  });
  it('validates gift availability locally and retains claims after undo', () => {
    const { base } = fixture();
    mutateDocument(
      base,
      '/api/gifts',
      'POST',
      { title: 'Treat', targetType: 'habitCount', targetId: base.habits[0]!.id },
      randomUUID(),
      now,
    );
    const path = `/api/gifts/${base.gifts[0]!.id}/claim`;
    expect(() => mutateDocument(base, path, 'POST', {}, randomUUID(), now)).toThrow('GIFT_LOCKED');
    complete(base, true);
    mutateDocument(base, path, 'POST', {}, randomUUID(), now);
    complete(base, false);
    expect(progressFor(base, now).gifts[base.gifts[0]!.id]!.state).toBe('claimed');
  });
  it('uses captured dates for schedule creation and tomorrow-effective edits', () => {
    const { base } = fixture();
    mutateDocument(
      base,
      `/api/habits/${base.habits[0]!.id}`,
      'PATCH',
      { weekdays: [1] },
      randomUUID(),
      now,
    );
    expect(base.habits[0]!.schedules.map((s) => s.from)).toEqual(['2026-10-05', '2026-10-06']);
  });
});
