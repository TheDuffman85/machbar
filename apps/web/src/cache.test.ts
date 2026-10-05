import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  bootstrapFor,
  createUser,
  mutateDocument,
  type CompletionOperation,
} from '@machbar/shared';
import { migrateEntry } from './cache';
const now = new Date();
function fixture() {
  const doc = createUser(randomUUID());
  mutateDocument(
    doc,
    '/api/habits',
    'POST',
    { title: 'Walk', weekdays: [0, 1, 2, 3, 4, 5, 6] },
    randomUUID(),
    now,
  );
  const snapshot = bootstrapFor({ document: doc, dailyHistoryDays: 3 }, now);
  const operation: CompletionOperation = {
    operationId: randomUUID(),
    targetType: 'habit',
    targetId: doc.habits[0]!.id,
    date: snapshot.today,
    timezone: doc.preferences.timezone,
    completed: true,
    expectedVersion: 0,
  };
  return { snapshot, queue: [operation] };
}
describe('offline cache migration', () => {
  it('preserves the server baseline and applies legacy pending checkoffs once', () => {
    const legacy = fixture();
    const entry = migrateEntry(legacy);
    expect(entry.base).toEqual(legacy.snapshot.document);
    expect(entry.snapshot.progress.xp).toBe(10);
    expect(entry.queue).toEqual(legacy.queue);
    expect(entry.recovery).toEqual([]);
    expect(migrateEntry(entry)).toBe(entry);
  });
  it('retains unreplayable legacy operations for explicit recovery', () => {
    const legacy = fixture();
    legacy.queue[0]!.targetId = randomUUID();
    const entry = migrateEntry(legacy);
    expect(entry.recovery).toEqual(legacy.queue);
    expect(entry.conflict).toBe('COMPLETION_CONFLICT');
    expect(entry.snapshot.progress.xp).toBe(0);
  });
});
