import { z } from 'zod';

export const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const date = new Date(`${value}T12:00:00Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
  });
const id = z.string().uuid();
const title = z.string().trim().min(1).max(160);
export const weekdaysSchema = z
  .array(z.number().int().min(0).max(6))
  .min(1)
  .max(7)
  .refine((v) => new Set(v).size === v.length);
export const timezoneSchema = z
  .string()
  .max(100)
  .refine((value) => {
    try {
      new Intl.DateTimeFormat('en', { timeZone: value });
      return true;
    } catch {
      return false;
    }
  });
export const preferencesSchema = z.object({
  name: z.string().trim().min(1).max(60),
  language: z.enum(['en', 'de']),
  theme: z.enum(['light', 'dark', 'system']),
  timezone: timezoneSchema,
  avatarSeed: z.string().min(1).max(100),
  onboarded: z.boolean(),
});
export const habitInputSchema = z
  .object({
    title,
    description: z.string().max(500).default(''),
    weekdays: weekdaysSchema,
    color: z.enum(['sage', 'peach', 'lavender', 'blue']).default('sage'),
  })
  .strict();
export const goalInputSchema = z
  .object({
    title,
    description: z.string().max(500).default(''),
    color: z.enum(['sage', 'peach', 'lavender', 'blue']).default('lavender'),
  })
  .strict();
export const stepInputSchema = z
  .object({ title, date: dateSchema.nullable().default(null) })
  .strict();
const scheduleSchema = z.object({
  from: dateSchema,
  weekdays: weekdaysSchema,
  timezone: timezoneSchema,
});
const habitSchema = habitInputSchema
  .omit({ weekdays: true })
  .extend({ id, schedules: z.array(scheduleSchema).min(1), archivedAt: z.string().nullable() });
const stepSchema = stepInputSchema.extend({ id, archivedAt: z.string().nullable() });
const goalSchema = goalInputSchema.extend({
  id,
  steps: z.array(stepSchema),
  archivedAt: z.string().nullable(),
});
export const giftInputSchema = z
  .object({
    title,
    targetType: z.enum(['goal', 'habitCount', 'habitStreak']),
    targetId: id,
    threshold: z.number().int().min(1).max(10000).default(1),
  })
  .strict();
const giftSchema = giftInputSchema.extend({
  id,
  claimedAt: z.string().nullable(),
  archivedAt: z.string().nullable(),
});
const completionSchema = z.object({
  key: z.string(),
  targetType: z.enum(['habit', 'step']),
  targetId: id,
  date: dateSchema,
  timezone: timezoneSchema,
  completed: z.boolean(),
  version: z.number().int().min(1),
  updatedAt: z.string(),
});
export const userDocumentSchema = z.object({
  schemaVersion: z.literal(1),
  revision: z.number().int().min(0),
  userId: z.string(),
  preferences: preferencesSchema,
  habits: z.array(habitSchema),
  goals: z.array(goalSchema),
  gifts: z.array(giftSchema),
  completions: z.record(z.string(), completionSchema),
  operations: z.record(
    z.string(),
    z.object({ fingerprint: z.string(), version: z.number().int() }),
  ),
});
export const completionOperationSchema = z
  .object({
    operationId: id,
    targetType: z.enum(['habit', 'step']),
    targetId: id,
    date: dateSchema,
    timezone: timezoneSchema,
    completed: z.boolean(),
    expectedVersion: z.number().int().min(0),
  })
  .strict();
export type Preferences = z.infer<typeof preferencesSchema>;
export type HabitInput = z.infer<typeof habitInputSchema>;
export type GoalInput = z.infer<typeof goalInputSchema>;
export type StepInput = z.infer<typeof stepInputSchema>;
export type GiftInput = z.infer<typeof giftInputSchema>;
export type Habit = z.infer<typeof habitSchema>;
export type Goal = z.infer<typeof goalSchema>;
export type Step = z.infer<typeof stepSchema>;
export type Gift = z.infer<typeof giftSchema>;
export type Completion = z.infer<typeof completionSchema>;
export type UserDocument = z.infer<typeof userDocumentSchema>;
export type CompletionOperation = z.infer<typeof completionOperationSchema>;
export type Bootstrap = {
  document: UserDocument;
  progress: Progress;
  authMode: 'single' | 'oidc';
  today: string;
};
export type Progress = {
  xp: number;
  level: number;
  levelXp: number;
  wins: number;
  badges: string[];
  habits: Record<string, { count: number; current: number; best: number }>;
  goals: Record<string, { completed: number; total: number; done: boolean }>;
  gifts: Record<
    string,
    { state: 'locked' | 'available' | 'claimed'; current: number; target: number }
  >;
};

export function localDate(timezone: string, now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const part = (type: string) => parts.find((p) => p.type === type)!.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}
export function addDays(date: string, amount: number): string {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + amount);
  return value.toISOString().slice(0, 10);
}
export function weekday(date: string): number {
  return new Date(`${date}T12:00:00Z`).getUTCDay();
}
export function scheduleFor(habit: Habit, date: string) {
  return habit.schedules.filter((s) => s.from <= date).at(-1);
}
export function scheduled(habit: Habit, date: string): boolean {
  return scheduleFor(habit, date)?.weekdays.includes(weekday(date)) ?? false;
}
export function completionKey(type: 'habit' | 'step', targetId: string, date: string): string {
  return type === 'habit' ? `habit:${targetId}:${date}` : `step:${targetId}`;
}
export function createUser(userId: string): UserDocument {
  return {
    schemaVersion: 1,
    revision: 0,
    userId,
    preferences: {
      name: 'Friend',
      language: 'en',
      theme: 'system',
      timezone: 'Europe/Berlin',
      avatarSeed: userId,
      onboarded: false,
    },
    habits: [],
    goals: [],
    gifts: [],
    completions: {},
    operations: {},
  };
}
export function progressFor(doc: UserDocument, now = new Date()): Progress {
  const wins = Object.values(doc.completions).filter((c) => c.completed).length;
  const habits: Progress['habits'] = {};
  for (const habit of doc.habits) {
    let run = 0,
      best = 0,
      count = 0;
    const currentTimezone =
      scheduleFor(habit, localDate(doc.preferences.timezone, now))?.timezone ??
      habit.schedules[0]!.timezone;
    const end = localDate(currentTimezone, habit.archivedAt ? new Date(habit.archivedAt) : now);
    for (let date = habit.schedules[0]!.from; date <= end; date = addDays(date, 1)) {
      if (!scheduled(habit, date)) continue;
      if (doc.completions[completionKey('habit', habit.id, date)]?.completed) {
        count++;
        run++;
        best = Math.max(best, run);
      } else if (date < end) run = 0; // An unfinished current occurrence is still open.
    }
    habits[habit.id] = { count, current: run, best };
  }
  const goals: Progress['goals'] = {};
  for (const goal of doc.goals) {
    const steps = goal.steps.filter((s) => !s.archivedAt);
    const completed = steps.filter(
      (s) => doc.completions[completionKey('step', s.id, '')]?.completed,
    ).length;
    goals[goal.id] = {
      completed,
      total: steps.length,
      done: steps.length > 0 && completed === steps.length,
    };
  }
  const badges: string[] = [];
  for (const threshold of [1, 10, 50, 100]) if (wins >= threshold) badges.push(`wins-${threshold}`);
  if (Object.values(goals).some((g) => g.done)) badges.push('first-goal');
  for (const threshold of [3, 7, 30])
    if (Object.values(habits).some((h) => h.best >= threshold)) badges.push(`streak-${threshold}`);
  const gifts: Progress['gifts'] = {};
  for (const gift of doc.gifts) {
    const current =
      gift.targetType === 'goal'
        ? Number(goals[gift.targetId]?.done ?? false)
        : gift.targetType === 'habitCount'
          ? (habits[gift.targetId]?.count ?? 0)
          : (habits[gift.targetId]?.best ?? 0);
    const target = gift.targetType === 'goal' ? 1 : gift.threshold;
    gifts[gift.id] = {
      state: gift.claimedAt ? 'claimed' : current >= target ? 'available' : 'locked',
      current,
      target,
    };
  }
  const xp = wins * 10;
  return {
    xp,
    wins,
    level: 1 + Math.floor(xp / 100),
    levelXp: xp % 100,
    badges,
    habits,
    goals,
    gifts,
  };
}
export class DomainError extends Error {
  constructor(
    public code: string,
    public status = 400,
  ) {
    super(code);
  }
}
export function applyCompletion(
  doc: UserDocument,
  operation: CompletionOperation,
  now = new Date(),
): number {
  const key = completionKey(operation.targetType, operation.targetId, operation.date);
  const fingerprint = JSON.stringify(operation);
  const previousOperation = doc.operations[operation.operationId];
  if (previousOperation) {
    if (previousOperation.fingerprint !== fingerprint)
      throw new DomainError('OPERATION_REUSED', 409);
    return previousOperation.version;
  }
  const existing = doc.completions[key];
  if (operation.date > localDate(operation.timezone, now))
    throw new DomainError('INVALID_OCCURRENCE');
  if (operation.targetType === 'habit') {
    const habit = doc.habits.find((h) => h.id === operation.targetId);
    if (!habit) throw new DomainError('NOT_FOUND', 404);
    const schedule = scheduleFor(habit, operation.date);
    if (!scheduled(habit, operation.date) || schedule?.timezone !== operation.timezone)
      throw new DomainError('INVALID_OCCURRENCE');
    if (habit.archivedAt && !existing) throw new DomainError('TASK_ARCHIVED', 409);
  } else {
    const goal = doc.goals.find((g) => g.steps.some((s) => s.id === operation.targetId));
    const step = goal?.steps.find((s) => s.id === operation.targetId);
    if (!step) throw new DomainError('NOT_FOUND', 404);
    if ((goal?.archivedAt || step.archivedAt) && !existing)
      throw new DomainError('TASK_ARCHIVED', 409);
  }
  const version = existing?.version ?? 0;
  if ((existing?.completed ?? false) === operation.completed) {
    doc.operations[operation.operationId] = { fingerprint, version };
    return version;
  }
  if (version !== operation.expectedVersion) throw new DomainError('COMPLETION_CONFLICT', 409);
  const nextVersion = version + 1;
  const preserveDate = operation.targetType === 'habit' || !operation.completed;
  doc.completions[key] = {
    key,
    targetType: operation.targetType,
    targetId: operation.targetId,
    date: preserveDate ? (existing?.date ?? operation.date) : operation.date,
    timezone: preserveDate ? (existing?.timezone ?? operation.timezone) : operation.timezone,
    completed: operation.completed,
    version: nextVersion,
    updatedAt: now.toISOString(),
  };
  doc.operations[operation.operationId] = { fingerprint, version: nextVersion };
  return nextVersion;
}
