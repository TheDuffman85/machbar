import {
  completionKey,
  defaultCheckInReminderTime,
  localDate,
  occurrenceFor,
  type Habit,
  type UserDocument,
} from './index.js';
import { calendarFormatter } from './calendar.js';

export type DueReminder = {
  /** checkIn: habits are open today and nothing was checked off by the chosen time. */
  targetType: 'habit' | 'goal' | 'step' | 'checkIn';
  targetId: string;
  date: string;
  title: string;
  language: UserDocument['preferences']['language'];
  expiresAt: number;
};

/** Find the next local date boundary, including DST changes and skipped midnights. */
export function nextLocalMidnight(timezone: string, now: Date): number {
  const date = localDate(timezone, now);
  let low = now.getTime();
  let high = low + 48 * 60 * 60 * 1000;
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (localDate(timezone, new Date(middle)) === date) low = middle;
    else high = middle;
  }
  return high;
}

function wallTime(timezone: string, now: Date): string {
  const parts = calendarFormatter(timezone, true).formatToParts(now);
  return `${parts.find((p) => p.type === 'hour')!.value}:${parts.find((p) => p.type === 'minute')!.value}`;
}

/** The habit's local day today, if it is scheduled and not yet completed. */
function openHabitDay(
  doc: UserDocument,
  habit: Habit,
  now: Date,
): { date: string; timezone: string } | undefined {
  if (habit.archivedAt) return;
  const schedule = habit.schedules.filter((s) => s.from <= localDate(s.timezone, now)).at(-1);
  if (!schedule) return;
  const date = localDate(schedule.timezone, now);
  const occurrence = occurrenceFor(habit, date);
  if (
    !occurrence ||
    occurrence.schedule !== schedule ||
    doc.completions[completionKey('habit', habit.id, occurrence.start)]?.completed
  )
    return;
  return { date, timezone: schedule.timezone };
}

const checkInTitles: Record<UserDocument['preferences']['language'], string> = {
  en: 'Your habits are still waiting for you today. A small step is enough.',
  de: 'Deine Gewohnheiten warten heute noch auf dich. Ein kleiner Schritt reicht.',
};

/** All due reminders today; the sender owns per-device dispatch deduplication. */
export function dueReminders(doc: UserDocument, now: Date): DueReminder[] {
  const due: DueReminder[] = [];
  for (const habit of doc.habits) {
    if (!habit.reminderTime) continue;
    const day = openHabitDay(doc, habit, now);
    // Comparing wall times catches up after downtime and missing DST hours.
    if (!day || wallTime(day.timezone, now) < habit.reminderTime) continue;
    due.push({
      targetType: 'habit',
      targetId: habit.id,
      date: day.date,
      title: habit.title,
      language: doc.preferences.language,
      expiresAt: nextLocalMidnight(day.timezone, now),
    });
  }
  const timezone = doc.preferences.timezone;
  const date = localDate(timezone, now);
  const time = wallTime(timezone, now);
  for (const goal of doc.goals) {
    if (goal.archivedAt) continue;
    const activeSteps = goal.steps.filter((step) => !step.archivedAt);
    const completed = activeSteps.length
      ? activeSteps.every((step) => doc.completions[completionKey('step', step.id, '')]?.completed)
      : !!doc.completions[completionKey('goal', goal.id, '')]?.completed;
    const tasks = [
      { ...goal, targetType: 'goal' as const, completed },
      ...goal.steps.map((step) => ({
        ...step,
        targetType: 'step' as const,
        completed: !!doc.completions[completionKey('step', step.id, '')]?.completed,
      })),
    ];
    for (const task of tasks) {
      if (
        task.archivedAt ||
        task.completed ||
        !task.reminderTime ||
        (task.date && task.date > date) ||
        time < task.reminderTime
      )
        continue;
      due.push({
        targetType: task.targetType,
        targetId: task.id,
        date,
        title: task.title,
        language: doc.preferences.language,
        expiresAt: nextLocalMidnight(timezone, now),
      });
    }
  }
  const { checkInReminder, checkInReminderTime } = doc.preferences;
  if (
    checkInReminder !== false &&
    time >= (checkInReminderTime ?? defaultCheckInReminderTime) &&
    doc.habits.some((habit) => openHabitDay(doc, habit, now)) &&
    // Any checkoff today, including goals and steps, counts as showing up.
    !Object.values(doc.completions).some((c) => c.completed && c.date === date)
  )
    due.push({
      targetType: 'checkIn',
      targetId: 'check-in',
      date,
      title: checkInTitles[doc.preferences.language],
      language: doc.preferences.language,
      expiresAt: nextLocalMidnight(timezone, now),
    });
  return due;
}
