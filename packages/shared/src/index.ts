import { z } from 'zod';
import { avatarOptionsSchema } from './avatar.js';
export { avatarChoices, avatarOptionsSchema, type AvatarOptions } from './avatar.js';

export const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const date = new Date(`${value}T12:00:00Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
  });
const id = z.string().uuid();
export const localUserIdSchema = z.string().uuid().toLowerCase();
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
  avatarOptions: avatarOptionsSchema.nullable().optional(),
  onboarded: z.boolean(),
});
export const recurrenceSchema = z
  .object({
    unit: z.enum(['day', 'week', 'month']),
    every: z.number().int().min(1).max(365),
    anchor: dateSchema,
  })
  .strict();
export type Recurrence = z.infer<typeof recurrenceSchema>;
export const iconChoices = [
  'leaf',
  'target',
  'heart',
  'star',
  'book',
  'dumbbell',
  'bike',
  'footprints',
  'droplet',
  'coffee',
  'moon',
  'sun',
  'music',
  'pencil',
  'briefcase',
  'sprout',
] as const;
export const iconSchema = z.enum(iconChoices);
export type EntityIcon = z.infer<typeof iconSchema>;
export const habitInputSchema = z
  .object({
    title,
    description: z.string().max(500).default(''),
    weekdays: weekdaysSchema,
    recurrence: recurrenceSchema.nullable().optional(),
    startDate: dateSchema.optional(),
    color: z.enum(['sage', 'peach', 'lavender', 'blue']).default('sage'),
    icon: iconSchema.optional(),
  })
  .strict();
export const goalInputSchema = z
  .object({
    title,
    description: z.string().max(500).default(''),
    color: z.enum(['sage', 'peach', 'lavender', 'blue']).default('lavender'),
    icon: iconSchema.optional(),
  })
  .strict();
export const stepInputSchema = z
  .object({ title, date: dateSchema.nullable().default(null), icon: iconSchema.optional() })
  .strict();
const scheduleSchema = z.object({
  from: dateSchema,
  weekdays: weekdaysSchema,
  timezone: timezoneSchema,
  recurrence: recurrenceSchema.optional(),
  resetStreak: z.boolean().optional(),
});
export type HabitSchedule = z.infer<typeof scheduleSchema>;
const habitSchema = habitInputSchema
  .omit({ weekdays: true, recurrence: true, startDate: true })
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
  targetType: z.enum(['habit', 'step', 'goal']),
  targetId: id,
  date: dateSchema,
  timezone: timezoneSchema,
  completed: z.boolean(),
  periodStart: dateSchema.optional(),
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
// Sync validates document integrity, while all feature rules remain in the client.
export const syncDocumentSchema = userDocumentSchema.strict().superRefine((doc, context) => {
  const habits = new Set(doc.habits.map((h) => h.id));
  const goals = new Set(doc.goals.map((g) => g.id));
  const steps = new Set(doc.goals.flatMap((g) => g.steps.map((s) => s.id)));
  const allIds = [
    ...doc.habits,
    ...doc.goals,
    ...doc.goals.flatMap((g) => g.steps),
    ...doc.gifts,
  ].map((i) => i.id);
  if (new Set(allIds).size !== allIds.length)
    context.addIssue({ code: 'custom', message: 'Duplicate entity ID' });
  for (const [key, completion] of Object.entries(doc.completions)) {
    if (
      key !== completion.key ||
      key !==
        completionKey(
          completion.targetType,
          completion.targetId,
          completion.periodStart ?? completion.date,
        ) ||
      (completion.periodStart !== undefined &&
        (completion.targetType !== 'habit' || completion.periodStart > completion.date)) ||
      !(
        completion.targetType === 'habit'
          ? habits
          : completion.targetType === 'goal'
            ? goals
            : steps
      ).has(completion.targetId)
    )
      context.addIssue({
        code: 'custom',
        path: ['completions', key],
        message: 'Invalid completion reference',
      });
  }
  for (const gift of doc.gifts) {
    if (!(gift.targetType === 'goal' ? goals : habits).has(gift.targetId))
      context.addIssue({ code: 'custom', path: ['gifts'], message: 'Invalid gift reference' });
  }
});
export const completionOperationSchema = z
  .object({
    operationId: id,
    targetType: z.enum(['habit', 'step', 'goal']),
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
  today: string;
  dailyHistoryDays: number;
};
export type Progress = {
  xp: number;
  level: number;
  levelXp: number;
  wins: number;
  badges: string[];
  habits: Record<string, { count: number; current: number; best: number }>;
  goals: Record<
    string,
    { completed: number; total: number; done: boolean; completedOn: string | null }
  >;
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
/** Calendar arithmetic uses date-only UTC values, independent of DST. */
export function alignAnchor(date: string, unit: Recurrence['unit']): string {
  if (unit === 'week') return addDays(date, -((weekday(date) + 6) % 7));
  return unit === 'month' ? `${date.slice(0, 7)}-01` : date;
}
function monthIndex(date: string): number {
  return Number(date.slice(0, 4)) * 12 + Number(date.slice(5, 7)) - 1;
}
function monthDate(index: number): string {
  return `${String(Math.floor(index / 12)).padStart(4, '0')}-${String((index % 12) + 1).padStart(2, '0')}-01`;
}
export function periodFor(schedule: HabitSchedule, date: string): { start: string; end: string } {
  const recurrence = schedule.recurrence;
  if (!recurrence) return { start: date, end: date };
  const anchor = alignAnchor(recurrence.anchor, recurrence.unit);
  let start: string, next: string;
  if (recurrence.unit === 'month') {
    const first = monthIndex(anchor);
    const offset = Math.floor((monthIndex(date) - first) / recurrence.every) * recurrence.every;
    start = monthDate(first + offset);
    next = monthDate(first + offset + recurrence.every);
  } else {
    const days = recurrence.every * (recurrence.unit === 'week' ? 7 : 1);
    const difference =
      (Date.parse(`${date}T12:00:00Z`) - Date.parse(`${anchor}T12:00:00Z`)) / 86400000;
    start = addDays(anchor, Math.floor(difference / days) * days);
    next = addDays(start, days);
  }
  return { start: start < schedule.from ? schedule.from : start, end: addDays(next, -1) };
}
export function occurrenceFor(habit: Habit, date: string) {
  const schedule = scheduleFor(habit, date);
  if (!schedule || (!schedule.recurrence && !schedule.weekdays.includes(weekday(date))))
    return undefined;
  const period = periodFor(schedule, date);
  const nextSchedule = habit.schedules.find((s) => s.from > date);
  if (nextSchedule && nextSchedule.from <= period.end) period.end = addDays(nextSchedule.from, -1);
  return { ...period, timezone: schedule.timezone, schedule };
}
export function scheduled(habit: Habit, date: string): boolean {
  return !!occurrenceFor(habit, date);
}
export function isPeriodHabit(schedule: HabitSchedule): boolean {
  return (
    !!schedule.recurrence && (schedule.recurrence.unit !== 'day' || schedule.recurrence.every > 1)
  );
}
export function scheduleRhythm(schedule: HabitSchedule): string {
  return JSON.stringify(schedule.recurrence ?? [...schedule.weekdays].sort());
}
/** Next edit boundary uses the active schedule, even if a replacement is pending. */
export function scheduleChangeDate(habit: Habit, now = new Date()): string {
  const schedule = habit.schedules.filter((s) => s.from <= localDate(s.timezone, now)).at(-1);
  if (!schedule) return localDate(habit.schedules[0]!.timezone, now);
  return addDays(periodFor(schedule, localDate(schedule.timezone, now)).end, 1);
}
export function operationKey(
  doc: UserDocument,
  type: Completion['targetType'],
  targetId: string,
  date: string,
): string {
  const habit = type === 'habit' ? doc.habits.find((h) => h.id === targetId) : undefined;
  return completionKey(type, targetId, habit ? (occurrenceFor(habit, date)?.start ?? date) : date);
}
export function completionKey(
  type: Completion['targetType'],
  targetId: string,
  date: string,
): string {
  return type === 'habit' ? `habit:${targetId}:${date}` : `${type}:${targetId}`;
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
    const endTime = habit.archivedAt ? new Date(habit.archivedAt) : now;
    const currentTimezone =
      habit.schedules.filter((s) => s.from <= localDate(s.timezone, endTime)).at(-1)?.timezone ??
      habit.schedules[0]!.timezone;
    const end = localDate(currentTimezone, endTime);
    let previousSchedule: HabitSchedule | undefined;
    for (let date = habit.schedules[0]!.from; date <= end;) {
      const schedule = scheduleFor(habit, date)!;
      // Legacy history carries streaks across weekday edits. Only new edits
      // explicitly request a reset, once when their schedule starts.
      if (previousSchedule && previousSchedule !== schedule && schedule.resetStreak) run = 0;
      previousSchedule = schedule;
      const occurrence = occurrenceFor(habit, date);
      if (!occurrence) {
        date = addDays(date, 1);
        continue;
      }
      if (doc.completions[completionKey('habit', habit.id, occurrence.start)]?.completed) {
        count++;
        run++;
        best = Math.max(best, run);
      } else if (occurrence.end < end) run = 0;
      date = addDays(occurrence.end, 1);
    }
    habits[habit.id] = { count, current: run, best };
  }
  const goals: Progress['goals'] = {};
  for (const goal of doc.goals) {
    const steps = goal.steps.filter((s) => !s.archivedAt);
    const completions = steps.length
      ? steps.map((s) => doc.completions[completionKey('step', s.id, '')])
      : [doc.completions[completionKey('goal', goal.id, '')]];
    const completed = completions.filter((c) => c?.completed).length;
    const total = completions.length;
    const done = completed === total;
    goals[goal.id] = {
      completed,
      total,
      done,
      completedOn: done
        ? completions
            .map((c) => c!.date)
            .sort()
            .at(-1)!
        : null,
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
  const key = operationKey(doc, operation.targetType, operation.targetId, operation.date);
  const fingerprint = JSON.stringify(operation);
  const previousOperation = doc.operations[operation.operationId];
  if (previousOperation) {
    if (previousOperation.fingerprint !== fingerprint)
      throw new DomainError('OPERATION_REUSED', 409);
    return previousOperation.version;
  }
  const existing = doc.completions[key];
  let periodStart: string | undefined;
  if (operation.date > localDate(operation.timezone, now))
    throw new DomainError('INVALID_OCCURRENCE');
  if (operation.targetType === 'habit') {
    const habit = doc.habits.find((h) => h.id === operation.targetId);
    if (!habit) throw new DomainError('NOT_FOUND', 404);
    const occurrence = occurrenceFor(habit, operation.date);
    if (!occurrence || occurrence.timezone !== operation.timezone)
      throw new DomainError('INVALID_OCCURRENCE');
    if (occurrence.schedule.recurrence) periodStart = occurrence.start;
    if (habit.archivedAt && !existing) throw new DomainError('TASK_ARCHIVED', 409);
  } else if (operation.targetType === 'goal') {
    const goal = doc.goals.find((g) => g.id === operation.targetId);
    if (!goal) throw new DomainError('NOT_FOUND', 404);
    if (goal.archivedAt && !existing) throw new DomainError('TASK_ARCHIVED', 409);
    if (goal.steps.some((s) => !s.archivedAt)) throw new DomainError('GOAL_HAS_STEPS', 409);
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
    ...(periodStart ? { periodStart } : {}),
    version: nextVersion,
    updatedAt: now.toISOString(),
  };
  doc.operations[operation.operationId] = { fingerprint, version: nextVersion };
  return nextVersion;
}

export { mutateDocument } from './mutations.js';
export { mergeDocuments, same } from './merge.js';
export type SyncSnapshot = Pick<Bootstrap, 'document' | 'dailyHistoryDays'>;
export function bootstrapFor(snapshot: SyncSnapshot, now = new Date()): Bootstrap {
  return {
    ...snapshot,
    today: localDate(snapshot.document.preferences.timezone, now),
    progress: progressFor(snapshot.document, now),
  };
}
