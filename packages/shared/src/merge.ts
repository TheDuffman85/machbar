import { DomainError, type UserDocument, type Completion } from './index.js';

export function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) || Array.isArray(b))
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((value, i) => same(value, b[i]))
    );
  const left = a as RecordValue,
    right = b as RecordValue;
  const keys = Object.keys(left).filter((key) => left[key] !== undefined);
  return (
    keys.length === Object.keys(right).filter((key) => right[key] !== undefined).length &&
    keys.every((key) => same(left[key], right[key]))
  );
}
const pick = <T>(base: T, local: T, server: T): T => (same(server, base) ? local : server);

type RecordValue = Record<string, unknown>;
function fields<T extends object>(base: T | undefined, local: T, server: T): T {
  const result = { ...server } as RecordValue;
  for (const key of Object.keys(local)) {
    const b = (base as RecordValue | undefined)?.[key];
    const l = (local as RecordValue)[key];
    const s = (server as RecordValue)[key];
    result[key] = key === 'archivedAt' || key === 'claimedAt' ? s || l : pick(b, l, s);
  }
  return result as T;
}
function entities<T extends { id: string }>(
  base: T[],
  local: T[],
  server: T[],
  merge: (b: T | undefined, l: T, s: T) => T = fields,
): T[] {
  const byId = new Map(local.map((item) => [item.id, item]));
  const result = server.map((s) => {
    const l = byId.get(s.id);
    byId.delete(s.id);
    return l
      ? merge(
          base.find((b) => b.id === s.id),
          l,
          s,
        )
      : s;
  });
  return [...result, ...byId.values()];
}
function steps(
  base: UserDocument['goals'][number]['steps'],
  local: typeof base,
  server: typeof base,
) {
  const merged = entities(base, local, server);
  // Additions must not masquerade as a reorder of the common baseline steps.
  const common = new Set(
    base
      .filter((b) => local.some((l) => l.id === b.id) && server.some((s) => s.id === b.id))
      .map((b) => b.id),
  );
  const order = (items: typeof base) => items.filter((i) => common.has(i.id)).map((i) => i.id);
  const preferred = same(order(server), order(base)) ? local : server;
  const positions = new Map(preferred.map((s, i) => [s.id, i]));
  return merged.sort(
    (a, b) => (positions.get(a.id) ?? Infinity) - (positions.get(b.id) ?? Infinity),
  );
}
function completion(
  base: Completion | undefined,
  local: Completion,
  server: Completion,
): Completion {
  if (same(local, base) || same(local, server)) return server;
  if (same(server, base)) return local;
  // Versions plus timestamps detect changes even when the final boolean is unchanged.
  const winner = local.completed && !server.completed ? local : server;
  return winner === server
    ? server
    : { ...winner, version: Math.max(local.version, server.version) + 1 };
}

/** Three-way document merge. The server revision is always the CAS baseline. */
export function mergeDocuments(
  base: UserDocument,
  local: UserDocument,
  server: UserDocument,
): UserDocument {
  if (base.userId !== local.userId || local.userId !== server.userId)
    throw new DomainError('ACCOUNT_CHANGED', 409);
  const result = structuredClone(server);
  result.preferences = fields(base.preferences, local.preferences, server.preferences);
  // A timezone conflict also selects its associated schedules; avoid mixed calendar states.
  const zoneConflict =
    local.preferences.timezone !== base.preferences.timezone &&
    server.preferences.timezone !== base.preferences.timezone &&
    local.preferences.timezone !== server.preferences.timezone;
  result.habits = entities(base.habits, local.habits, server.habits, (b, l, s) => {
    const merged = fields(b, l, s);
    const schedules = new Map(s.schedules.map((schedule) => [schedule.from, schedule]));
    for (const schedule of l.schedules) {
      const original = b?.schedules.find((v) => v.from === schedule.from);
      const remote = schedules.get(schedule.from);
      if (!zoneConflict) {
        const effectiveBase =
          original ?? b?.schedules.filter((v) => v.from <= schedule.from).at(-1);
        schedules.set(schedule.from, remote ? fields(effectiveBase, schedule, remote) : schedule);
      }
    }
    merged.schedules = [...schedules.values()].sort((a, b) => a.from.localeCompare(b.from));
    return merged;
  });
  result.goals = entities(base.goals, local.goals, server.goals, (b, l, s) => ({
    ...fields(b, l, s),
    steps: steps(b?.steps ?? [], l.steps, s.steps),
  }));
  result.gifts = entities(base.gifts, local.gifts, server.gifts);
  result.completions = { ...server.completions };
  for (const [key, l] of Object.entries(local.completions)) {
    const s = server.completions[key];
    result.completions[key] = s ? completion(base.completions[key], l, s) : l;
  }
  result.operations = { ...local.operations, ...server.operations };
  return result;
}
