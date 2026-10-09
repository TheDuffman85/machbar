import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createUser, mutateDocument, progressFor, syncDocumentSchema } from './index.js';
import { mergeDocuments } from './merge.js';

const now = new Date('2026-10-09T12:00:00Z');
function fixture() {
  const doc = createUser(randomUUID());
  const habitId = randomUUID(),
    goalId = randomUUID(),
    giftId = randomUUID();
  mutateDocument(
    doc,
    '/api/habits',
    'POST',
    {
      title: 'Walk',
      weekdays: [0, 1, 2, 3, 4, 5, 6],
    },
    habitId,
    now,
  );
  mutateDocument(doc, '/api/goals', 'POST', { title: 'Read' }, goalId, now);
  mutateDocument(
    doc,
    '/api/gifts',
    'POST',
    {
      title: 'A treat',
      description: 'Ideas\nhttps://example.com/treat',
      icon: 'cake',
      targetType: 'habitCount',
      targetId: habitId,
      threshold: 7,
    },
    giftId,
    now,
  );
  const edit = (body: unknown) =>
    mutateDocument(doc, `/api/gifts/${giftId}`, 'PATCH', body, randomUUID(), now);
  return { doc, habitId, goalId, giftId, edit };
}

describe('gift editing', () => {
  it('edits supplied fields without resetting the milestone, icon, notes or claim history', () => {
    const { doc, edit } = fixture();
    const gift = doc.gifts[0]!;
    gift.claimedAt = now.toISOString();
    edit({ title: 'Birthday treat' });
    expect(gift).toMatchObject({
      title: 'Birthday treat',
      description: 'Ideas\nhttps://example.com/treat',
      icon: 'cake',
      targetType: 'habitCount',
      threshold: 7,
      claimedAt: now.toISOString(),
    });
    edit({ description: '', icon: 'ticket' });
    expect(gift).toMatchObject({ description: '', icon: 'ticket', claimedAt: now.toISOString() });
  });

  it('recalculates unlock progress and normalizes goal thresholds when changing milestones', () => {
    const { doc, goalId, giftId, edit } = fixture();
    edit({ threshold: 3, targetType: 'habitStreak' });
    expect(progressFor(doc, now).gifts[giftId]).toMatchObject({ target: 3, state: 'locked' });
    edit({ targetType: 'goal', targetId: goalId });
    expect(doc.gifts[0]).toMatchObject({ targetType: 'goal', targetId: goalId, threshold: 1 });
  });

  it('rejects missing, wrong-kind and archived replacement targets without modifying the gift', () => {
    const { doc, goalId, edit } = fixture();
    const before = structuredClone(doc);
    for (const body of [
      { targetId: randomUUID() },
      { targetId: goalId },
      { threshold: 0 },
      { description: 'a'.repeat(2001) },
      { icon: 'unknown' },
      { claimedAt: now.toISOString() },
    ]) {
      expect(() => edit(body)).toThrow();
      expect(doc).toEqual(before);
    }
    doc.goals[0]!.archivedAt = now.toISOString();
    expect(() => edit({ targetType: 'goal', targetId: goalId })).toThrow('NOT_FOUND');
  });

  it('allows details to change when the existing target is archived, but rejects archived gift edits', () => {
    const { doc, edit } = fixture();
    doc.habits[0]!.archivedAt = now.toISOString();
    edit({ title: 'Still saved' });
    expect(doc.gifts[0]!.title).toBe('Still saved');
    doc.gifts[0]!.archivedAt = now.toISOString();
    expect(() => edit({ title: 'Cannot change' })).toThrow('NOT_FOUND');
  });

  it('keeps legacy gifts valid without an icon or description', () => {
    const { doc, edit } = fixture();
    delete doc.gifts[0]!.description;
    delete doc.gifts[0]!.icon;
    expect(syncDocumentSchema.safeParse(doc).success).toBe(true);
    edit({ description: 'New notes', icon: 'gift' });
    expect(syncDocumentSchema.safeParse(doc).success).toBe(true);
  });

  it('keeps conflicting milestone edits together instead of mixing goal and habit references', () => {
    const { doc: base, giftId, goalId } = fixture();
    const local = structuredClone(base),
      server = structuredClone(base);
    const otherHabitId = randomUUID();
    mutateDocument(
      server,
      '/api/habits',
      'POST',
      {
        title: 'Another habit',
        weekdays: [0, 1, 2, 3, 4, 5, 6],
      },
      otherHabitId,
      now,
    );
    mutateDocument(
      local,
      `/api/gifts/${giftId}`,
      'PATCH',
      {
        targetType: 'goal',
        targetId: goalId,
        description: 'Local notes',
      },
      randomUUID(),
      now,
    );
    mutateDocument(
      server,
      `/api/gifts/${giftId}`,
      'PATCH',
      {
        targetId: otherHabitId,
        threshold: 3,
      },
      randomUUID(),
      now,
    );
    const result = mergeDocuments(base, local, server);
    expect(result.gifts[0]).toMatchObject({
      targetType: 'habitCount',
      targetId: otherHabitId,
      threshold: 3,
      description: 'Local notes',
    });
    expect(syncDocumentSchema.safeParse(result).success).toBe(true);
  });

  it('merges offline metadata edits with remote milestone edits, claims and archives', () => {
    const { doc: base, giftId } = fixture();
    const local = structuredClone(base),
      server = structuredClone(base);
    mutateDocument(
      local,
      `/api/gifts/${giftId}`,
      'PATCH',
      { description: 'Local link', icon: 'ticket' },
      randomUUID(),
      now,
    );
    mutateDocument(server, `/api/gifts/${giftId}`, 'PATCH', { threshold: 4 }, randomUUID(), now);
    server.gifts[0]!.claimedAt = now.toISOString();
    server.gifts[0]!.archivedAt = now.toISOString();
    const result = mergeDocuments(base, local, server);
    expect(result.gifts[0]).toMatchObject({
      description: 'Local link',
      icon: 'ticket',
      threshold: 4,
      claimedAt: now.toISOString(),
      archivedAt: now.toISOString(),
    });
    expect(syncDocumentSchema.safeParse(result).success).toBe(true);
  });
});
