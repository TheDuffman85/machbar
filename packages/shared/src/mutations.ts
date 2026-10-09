import { canDeleteItem, deleteItem, type RemovableKind } from './removal.js';
import { z } from 'zod';
import {
  alignAnchor,
  scheduleChangeDate,
  scheduleRhythm,
  same,
  DomainError,
  giftInputSchema,
  goalInputSchema,
  habitInputSchema,
  localDate,
  preferencesSchema,
  progressFor,
  stepInputSchema,
  type UserDocument,
} from './index.js';

/** Apply a local command. IDs and timestamps are captured before persistence/retry. */
export function mutateDocument(
  doc: UserDocument,
  path: string,
  method: string,
  body: unknown,
  newId: string,
  now = new Date(),
): void {
  const parts = path.split('/').filter(Boolean);
  const [, kind, id, action] = parts;
  if (parts[0] !== 'api') throw new DomainError('NOT_FOUND', 404);
  const activeGoal = () => {
    const goal = doc.goals.find((g) => g.id === id && !g.archivedAt);
    if (!goal) throw new DomainError('NOT_FOUND', 404);
    return goal;
  };
  if (kind === 'preferences' && method === 'PATCH') {
    const input = preferencesSchema.partial().strict().parse(body);
    if (input.timezone && input.timezone !== doc.preferences.timezone) {
      for (const habit of doc.habits.filter((h) => !h.archivedAt)) {
        if (habit.schedules[0]!.from > localDate(habit.schedules[0]!.timezone, now)) {
          for (const schedule of habit.schedules) schedule.timezone = input.timezone;
          continue;
        }
        const from = scheduleChangeDate(habit, now);
        const active = habit.schedules.filter((s) => s.from < from).at(-1) ?? habit.schedules[0]!;
        const pending = habit.schedules.find((s) => s.from >= from);
        if (!pending || pending.from > from) {
          const schedule = { ...active, from, timezone: input.timezone };
          delete schedule.resetStreak;
          setSchedule(habit.schedules, schedule);
        }
        for (const schedule of habit.schedules.filter((s) => s.from >= from))
          schedule.timezone = input.timezone;
      }
    }
    Object.assign(doc.preferences, input);
  } else if (method === 'DELETE' && ['habits', 'goals', 'steps', 'gifts'].includes(kind)) {
    const items =
      kind === 'steps'
        ? doc.goals.filter((g) => !g.archivedAt).flatMap((g) => g.steps)
        : doc[kind as 'habits' | 'goals' | 'gifts'];
    const item = items.find((i) => i.id === id);
    if (!item) throw new DomainError('NOT_FOUND', 404);
    if (canDeleteItem(doc, kind as RemovableKind, id)) deleteItem(doc, kind as RemovableKind, id);
    else item.archivedAt ??= now.toISOString();
  } else if (kind === 'habits' && method === 'POST' && !id) {
    const { weekdays, recurrence, startDate, ...input } = habitInputSchema.parse(body);
    const today = localDate(doc.preferences.timezone, now);
    if (startDate && startDate < today) throw new DomainError('VALIDATION_ERROR');
    const from = startDate ?? today;
    doc.habits.push({
      ...input,
      id: newId,
      archivedAt: null,
      schedules: [
        {
          from,
          weekdays,
          timezone: doc.preferences.timezone,
          ...(recurrence
            ? {
                recurrence: {
                  ...recurrence,
                  anchor: alignAnchor(recurrence.anchor, recurrence.unit),
                },
              }
            : {}),
        },
      ],
    });
  } else if (kind === 'habits' && method === 'PATCH') {
    const { weekdays, recurrence, startDate, ...input } = onlySupplied(
      habitInputSchema.partial().parse(body),
      body,
    );
    const habit = doc.habits.find((h) => h.id === id && !h.archivedAt);
    if (!habit) throw new DomainError('NOT_FOUND', 404);
    Object.assign(habit, input);
    const latest = habit.schedules.at(-1)!;
    const nextRecurrence = recurrence === undefined ? latest.recurrence : (recurrence ?? undefined);
    const normalized = nextRecurrence
      ? { ...nextRecurrence, anchor: alignAnchor(nextRecurrence.anchor, nextRecurrence.unit) }
      : undefined;
    const nextWeekdays = weekdays ?? latest.weekdays;
    if (
      !same(latest.recurrence, normalized) ||
      !same([...latest.weekdays].sort(), [...nextWeekdays].sort()) ||
      startDate !== undefined
    ) {
      const boundary = scheduleChangeDate(habit, now);
      if (startDate && startDate < boundary) throw new DomainError('VALIDATION_ERROR');
      const active = habit.schedules.filter((s) => s.from < boundary).at(-1);
      const schedule = {
        from: startDate ?? boundary,
        weekdays: nextWeekdays,
        timezone: doc.preferences.timezone,
        ...(normalized ? { recurrence: normalized } : {}),
      };
      const resetStreak = active && scheduleRhythm(active) !== scheduleRhythm(schedule);
      // Replace a pending edit rather than appending a second future schedule.
      habit.schedules = habit.schedules.filter((s) => s.from < boundary);
      setSchedule(habit.schedules, {
        ...schedule,
        ...(resetStreak ? { resetStreak: true } : {}),
      });
    }
  } else if (kind === 'goals' && method === 'POST' && !id) {
    doc.goals.push({ ...goalInputSchema.parse(body), id: newId, steps: [], archivedAt: null });
  } else if (kind === 'goals' && method === 'PATCH' && !action) {
    Object.assign(activeGoal(), onlySupplied(goalInputSchema.partial().parse(body), body));
  } else if (kind === 'goals' && action === 'steps' && method === 'POST') {
    activeGoal().steps.push({ ...stepInputSchema.parse(body), id: newId, archivedAt: null });
  } else if (kind === 'steps' && method === 'PATCH') {
    const step = doc.goals
      .filter((g) => !g.archivedAt)
      .flatMap((g) => g.steps)
      .find((s) => s.id === id && !s.archivedAt);
    if (!step) throw new DomainError('NOT_FOUND', 404);
    Object.assign(step, onlySupplied(stepInputSchema.partial().parse(body), body));
  } else if (kind === 'goals' && action === 'order' && method === 'PUT') {
    const order = z.array(z.string().uuid()).max(1000).parse(body);
    const goal = activeGoal();
    if (
      order.length !== goal.steps.length ||
      new Set(order).size !== order.length ||
      order.some((id) => !goal.steps.some((s) => s.id === id))
    )
      throw new DomainError('VALIDATION_ERROR');
    goal.steps = order.map((id) => goal.steps.find((s) => s.id === id)!);
  } else if (kind === 'gifts' && method === 'POST' && !id) {
    const input = giftInputSchema.parse(body);
    if (
      !(input.targetType === 'goal' ? doc.goals : doc.habits).some(
        (i) => i.id === input.targetId && !i.archivedAt,
      )
    )
      throw new DomainError('NOT_FOUND', 404);
    doc.gifts.push({
      ...input,
      threshold: input.targetType === 'goal' ? 1 : input.threshold,
      id: newId,
      claimedAt: null,
      archivedAt: null,
    });
  } else if (kind === 'gifts' && method === 'PATCH' && !action) {
    const gift = doc.gifts.find((g) => g.id === id && !g.archivedAt);
    if (!gift) throw new DomainError('NOT_FOUND', 404);
    if (gift.claimedAt) throw new DomainError('GIFT_CLAIMED', 409);
    const changes = onlySupplied(giftInputSchema.partial().parse(body), body);
    const input = giftInputSchema.parse({
      title: gift.title,
      description: gift.description,
      icon: gift.icon,
      targetType: gift.targetType,
      targetId: gift.targetId,
      threshold: gift.threshold,
      ...changes,
    });
    const targetChanged = input.targetType !== gift.targetType || input.targetId !== gift.targetId;
    if (
      !(input.targetType === 'goal' ? doc.goals : doc.habits).some(
        (item) => item.id === input.targetId && (!targetChanged || !item.archivedAt),
      )
    )
      throw new DomainError('NOT_FOUND', 404);
    Object.assign(gift, changes, { threshold: input.targetType === 'goal' ? 1 : input.threshold });
  } else if (kind === 'gifts' && action === 'claim' && method === 'POST') {
    const gift = doc.gifts.find((g) => g.id === id && !g.archivedAt);
    if (!gift) throw new DomainError('NOT_FOUND', 404);
    if (progressFor(doc, now).gifts[id]!.state === 'locked')
      throw new DomainError('GIFT_LOCKED', 409);
    gift.claimedAt ??= now.toISOString();
  } else throw new DomainError('NOT_FOUND', 404);
}
function setSchedule<T extends { from: string }>(schedules: T[], schedule: T) {
  const index = schedules.findIndex((s) => s.from === schedule.from);
  if (index < 0) schedules.push(schedule);
  else schedules[index] = schedule;
  schedules.sort((a, b) => a.from.localeCompare(b.from));
}

function onlySupplied<T extends object>(parsed: T, body: unknown): T {
  for (const key of Object.keys(parsed)) {
    if (!Object.prototype.hasOwnProperty.call(body, key))
      delete (parsed as Record<string, unknown>)[key];
  }
  return parsed;
}
