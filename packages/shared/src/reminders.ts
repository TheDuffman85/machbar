import { localDate, occurrenceFor, completionKey, type UserDocument } from './index.js';
import { calendarFormatter } from './calendar.js';

export type DueReminder = {
  targetType: 'habit' | 'goal' | 'step';
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

/** All due reminders today; the sender owns per-device dispatch deduplication. */
export function dueReminders(doc: UserDocument, now: Date): DueReminder[] {
  const due: DueReminder[] = [];
  for (const habit of doc.habits) {
    if (habit.archivedAt || !habit.reminderTime) continue;
    const schedule = habit.schedules.filter((s) => s.from <= localDate(s.timezone, now)).at(-1);
    if (!schedule) continue;
    const date = localDate(schedule.timezone, now);
    const occurrence = occurrenceFor(habit, date);
    if (
      !occurrence ||
      occurrence.schedule !== schedule ||
      doc.completions[completionKey('habit', habit.id, occurrence.start)]?.completed
    )
      continue;
    const parts = calendarFormatter(schedule.timezone, true).formatToParts(now);
    const time = `${parts.find((p) => p.type === 'hour')!.value}:${parts.find((p) => p.type === 'minute')!.value}`;
    // Comparing wall times catches up after downtime and missing DST hours.
    if (time < habit.reminderTime) continue;
    due.push({
      targetType: 'habit',
      targetId: habit.id,
      date,
      title: habit.title,
      language: doc.preferences.language,
      expiresAt: nextLocalMidnight(schedule.timezone, now),
    });
  }
  const timezone = doc.preferences.timezone;
  const date = localDate(timezone, now);
  const parts = calendarFormatter(timezone, true).formatToParts(now);
  const time = `${parts.find((p) => p.type === 'hour')!.value}:${parts.find((p) => p.type === 'minute')!.value}`;
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
  return due;
}
