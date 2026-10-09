import type { UserDocument } from './index.js';

export type RemovableKind = 'habits' | 'goals' | 'steps' | 'gifts';

/** Even an undone checkoff is history. Goals also own their steps' history. */
export function canDeleteItem(doc: UserDocument, kind: RemovableKind, id: string): boolean {
  if (kind === 'gifts') return !doc.gifts.find((gift) => gift.id === id)?.claimedAt;
  const ids = new Set([id]);
  if (kind === 'goals')
    for (const step of doc.goals.find((goal) => goal.id === id)?.steps ?? []) ids.add(step.id);
  return (
    !Object.values(doc.completions).some((completion) => ids.has(completion.targetId)) &&
    !doc.gifts.some((gift) => gift.targetId === id && gift.claimedAt)
  );
}

/** Caller must check history first. Unclaimed dependent gifts cannot outlive their target. */
export function deleteItem(doc: UserDocument, kind: RemovableKind, id: string): void {
  if (kind === 'steps') {
    for (const goal of doc.goals) goal.steps = goal.steps.filter((step) => step.id !== id);
  } else if (kind === 'gifts') doc.gifts = doc.gifts.filter((gift) => gift.id !== id);
  else {
    if (kind === 'habits') doc.habits = doc.habits.filter((habit) => habit.id !== id);
    else doc.goals = doc.goals.filter((goal) => goal.id !== id);
    doc.gifts = doc.gifts.filter((gift) => gift.targetId !== id);
  }
}

/** Upgrade archived, unused items without discarding checkoffs or claimed rewards. */
export function pruneUnusedArchivedItems(doc: UserDocument): boolean {
  let changed = false;
  for (const kind of ['gifts', 'steps', 'goals', 'habits'] as const) {
    const items = kind === 'steps' ? doc.goals.flatMap((goal) => goal.steps) : doc[kind];
    for (const item of items) {
      if (item.archivedAt && canDeleteItem(doc, kind, item.id)) {
        deleteItem(doc, kind, item.id);
        changed = true;
      }
    }
  }
  return changed;
}
