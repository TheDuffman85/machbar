import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  createUser,
  documentLimits,
  documentWithinLimits,
  syncDocumentSchema,
  timezoneSchema,
} from './index.js';

describe('document complexity limits', () => {
  it('checks oversized top-level arrays before inspecting their elements', () => {
    const doc = createUser(randomUUID());
    for (const field of ['habits', 'goals', 'gifts'] as const) {
      const value = { ...doc, [field]: Array(documentLimits[field] + 1).fill(null) };
      expect(documentWithinLimits(value)).toBe(false);
      expect(syncDocumentSchema.safeParse(value).success).toBe(false);
    }
  });
  it('bounds total schedules and steps across individually valid collections', () => {
    const doc = createUser(randomUUID());
    const schedules = Array(documentLimits.schedulesPerHabit).fill({});
    const steps = Array(documentLimits.stepsPerGoal).fill({});
    expect(documentWithinLimits({ ...doc, habits: Array(17).fill({ schedules }) })).toBe(false);
    expect(documentWithinLimits({ ...doc, goals: Array(11).fill({ steps }) })).toBe(false);
  });
  it('bounds operation/completion counts, keys, and timestamps before schema traversal', () => {
    const doc = createUser(randomUUID());
    for (const field of ['operations', 'completions'] as const) {
      const entries = Object.fromEntries(
        Array.from({ length: documentLimits[field] + 1 }, (_, i) => [
          String(i),
          { fingerprint: 'ok' },
        ]),
      );
      expect(documentWithinLimits({ ...doc, [field]: entries })).toBe(false);
      expect(
        documentWithinLimits({ ...doc, [field]: { ['x'.repeat(161)]: { fingerprint: 'ok' } } }),
      ).toBe(false);
    }
    expect(
      documentWithinLimits({ ...doc, completions: { entry: { updatedAt: 'x'.repeat(41) } } }),
    ).toBe(false);
  });
  it('accepts normal documents, timezone aliases and case variants', () => {
    const doc = createUser(randomUUID());
    expect(syncDocumentSchema.parse(doc)).toEqual(doc);
    for (const timezone of ['Europe/Berlin', 'europe/berlin', 'UTC', 'US/Eastern', 'Asia/Calcutta'])
      expect(timezoneSchema.safeParse(timezone).success).toBe(true);
    expect(timezoneSchema.safeParse('Unknown/Zone').success).toBe(false);
  });
  it('bounds distinct timezone checks even when calendar values are invalid', () => {
    const doc = createUser(randomUUID());
    const completions = Object.fromEntries(
      Array.from({ length: documentLimits.timezones + 1 }, (_, i) => [
        String(i),
        { timezone: `Invalid/Zone${i}` },
      ]),
    );
    expect(documentWithinLimits({ ...doc, completions })).toBe(false);
    expect(syncDocumentSchema.safeParse({ ...doc, completions }).success).toBe(false);
  });
});
