import { localDate, occurrenceFor, completionKey, type UserDocument } from './index.js';

export type DueReminder = {
  habitId: string;
  date: string;
  title: string;
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
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: schedule.timezone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(now);
    const time = `${parts.find((p) => p.type === 'hour')!.value}:${parts.find((p) => p.type === 'minute')!.value}`;
    // Comparing wall times catches up after downtime and missing DST hours.
    if (time < habit.reminderTime) continue;
    due.push({
      habitId: habit.id,
      date,
      title: habit.title,
      expiresAt: nextLocalMidnight(schedule.timezone, now),
    });
  }
  return due;
}
