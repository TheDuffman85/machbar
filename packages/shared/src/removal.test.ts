import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  applyCompletion,
  canDeleteItem,
  createUser,
  mergeDocuments,
  mutateDocument,
  progressFor,
  pruneUnusedArchivedItems,
  syncDocumentSchema,
  type UserDocument,
  type CompletionOperation,
} from './index.js';
const now = new Date('2026-10-05T12:00:00Z');
function fixture() {
  const doc = createUser(randomUUID());
  mutateDocument(doc, '/api/habits', 'POST', { title: 'Walk', weekdays: [1] }, randomUUID(), now);
  mutateDocument(doc, '/api/goals', 'POST', { title: 'Home' }, randomUUID(), now);
  mutateDocument(
    doc,
    `/api/goals/${doc.goals[0]!.id}/steps`,
    'POST',
    { title: 'Shelf' },
    randomUUID(),
    now,
  );
  return doc;
}
function log(doc: UserDocument, targetType: CompletionOperation['targetType'], targetId: string) {
  const operation = {
    operationId: randomUUID(),
    targetType,
    targetId,
    date: '2026-10-05',
    timezone: 'Europe/Berlin',
    completed: true,
    expectedVersion: 0,
  };
  applyCompletion(doc, operation, now);
  return operation;
}
function remove(doc: UserDocument, kind: string, id: string) {
  mutateDocument(doc, `/api/${kind}/${id}`, 'DELETE', undefined, randomUUID(), now);
}
describe('removal and migration', () => {
  it('deletes unused items and dependent unclaimed gifts without dangling references', () => {
    const doc = fixture();
    const habit = doc.habits[0]!,
      goal = doc.goals[0]!;
    for (const [targetType, targetId] of [
      ['goal', goal.id],
      ['habitCount', habit.id],
    ] as const)
      mutateDocument(
        doc,
        '/api/gifts',
        'POST',
        { title: 'Treat', targetType, targetId },
        randomUUID(),
        now,
      );
    remove(doc, 'steps', goal.steps[0]!.id);
    expect(goal.steps).toEqual([]);
    remove(doc, 'goals', goal.id);
    remove(doc, 'habits', habit.id);
    expect(doc.goals).toEqual([]);
    expect(doc.habits).toEqual([]);
    expect(doc.gifts).toEqual([]);
    expect(syncDocumentSchema.safeParse(doc).success).toBe(true);
  });
  it('archives logged items even after undo and counts nested step history for goals', () => {
    const doc = fixture(),
      habit = doc.habits[0]!,
      goal = doc.goals[0]!,
      step = goal.steps[0]!;
    const operation = log(doc, 'habit', habit.id);
    applyCompletion(
      doc,
      { ...operation, operationId: randomUUID(), completed: false, expectedVersion: 1 },
      now,
    );
    log(doc, 'step', step.id);
    remove(doc, 'habits', habit.id);
    remove(doc, 'steps', step.id);
    remove(doc, 'goals', goal.id);
    expect([habit, goal, step].map((item) => item.archivedAt)).toEqual(
      Array(3).fill(now.toISOString()),
    );
    expect(Object.values(doc.completions)).toHaveLength(2);
    expect(progressFor(doc, now).xp).toBe(10);
  });
  it('preserves claimed gifts and their target even if all its steps were unused', () => {
    const doc = fixture(),
      goal = doc.goals[0]!;
    mutateDocument(
      doc,
      '/api/gifts',
      'POST',
      { title: 'Treat', targetType: 'goal', targetId: goal.id },
      randomUUID(),
      now,
    );
    const gift = doc.gifts[0]!;
    gift.claimedAt = now.toISOString();
    expect(canDeleteItem(doc, 'goals', goal.id)).toBe(false);
    remove(doc, 'goals', goal.id);
    remove(doc, 'gifts', gift.id);
    expect(goal.archivedAt).toBe(now.toISOString());
    expect(gift.archivedAt).toBe(now.toISOString());
    expect(syncDocumentSchema.safeParse(doc).success).toBe(true);
  });
  it('cleans unused archived items while retaining undone logs and active children of retained goals', () => {
    const doc = fixture(),
      goal = doc.goals[0]!;
    goal.archivedAt = now.toISOString();
    const operation = log(doc, 'habit', doc.habits[0]!.id);
    applyCompletion(
      doc,
      { ...operation, operationId: randomUUID(), completed: false, expectedVersion: 1 },
      now,
    );
    doc.habits[0]!.archivedAt = now.toISOString();
    expect(pruneUnusedArchivedItems(doc)).toBe(true);
    expect(doc.goals).toEqual([]);
    expect(doc.habits).toHaveLength(1);
    expect(pruneUnusedArchivedItems(doc)).toBe(false);
    expect(syncDocumentSchema.safeParse(doc).success).toBe(true);
  });
  it.each(['habits', 'goals', 'steps'] as const)(
    'sync keeps %s deletion through concurrent edits in either direction',
    (kind) => {
      const base = fixture();
      const id =
        kind === 'habits'
          ? base.habits[0]!.id
          : kind === 'goals'
            ? base.goals[0]!.id
            : base.goals[0]!.steps[0]!.id;
      const local = structuredClone(base),
        server = structuredClone(base);
      remove(local, kind, id);
      const item = kind === 'steps' ? server.goals[0]!.steps[0]! : server[kind][0]!;
      item.title = 'Edited elsewhere';
      for (const [left, right] of [
        [local, server],
        [server, local],
      ]) {
        const result = mergeDocuments(base, left!, right!);
        expect(kind === 'steps' ? result.goals[0]!.steps : result[kind]).toEqual([]);
        expect(syncDocumentSchema.safeParse(result).success).toBe(true);
        expect(mergeDocuments(base, left!, result)).toEqual(result);
      }
    },
  );
  it.each(['habits', 'goals', 'steps'] as const)(
    'a concurrent %s checkoff converts deletion to archive',
    (kind) => {
      const base = fixture();
      const id =
        kind === 'habits'
          ? base.habits[0]!.id
          : kind === 'goals'
            ? base.goals[0]!.id
            : base.goals[0]!.steps[0]!.id;
      const local = structuredClone(base),
        server = structuredClone(base);
      remove(local, kind, id);
      log(
        server,
        kind === 'habits' ? 'habit' : 'step',
        kind === 'habits' ? id : base.goals[0]!.steps[0]!.id,
      );
      for (const [left, right] of [
        [local, server],
        [server, local],
      ]) {
        const result = mergeDocuments(base, left!, right!);
        const item = kind === 'steps' ? result.goals[0]!.steps[0]! : result[kind][0]!;
        expect(item.archivedAt).toBe(now.toISOString());
        expect(progressFor(result, now).xp).toBe(10);
        expect(syncDocumentSchema.safeParse(result).success).toBe(true);
        expect(mergeDocuments(base, left!, result)).toEqual(result);
      }
    },
  );
});
