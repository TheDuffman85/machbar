// Check collection sizes before Zod visits every element. A byte limit alone
// does not bound the amount of calendar validation or reminder work.
export const documentLimits = {
  maxBytes: 8 * 1024 * 1024,
  habits: 500,
  goals: 500,
  gifts: 1000,
  stepsPerGoal: 500,
  totalSteps: 5000,
  schedulesPerHabit: 256,
  totalSchedules: 4096,
  completions: 20000,
  operations: 20000,
  fingerprintLength: 2048,
  timezones: 32,
} as const;

export function documentWithinLimits(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const doc = value as Record<string, unknown>;
  const timezones = new Set<string>();
  const timezone = (value: unknown): boolean => {
    if (typeof value !== 'string') return true; // Schema validation handles missing/wrong types.
    if (value.length > 100) return false;
    timezones.add(value.toLowerCase());
    return timezones.size <= documentLimits.timezones;
  };
  if (!timezone((doc.preferences as { timezone?: unknown } | null)?.timezone)) return false;
  for (const field of ['habits', 'goals', 'gifts'] as const)
    if (!Array.isArray(doc[field]) || doc[field].length > documentLimits[field]) return false;
  let schedules = 0;
  for (const habit of doc.habits as unknown[]) {
    if (!shortTimestamps(habit)) return false;
    const list = (habit as { schedules?: unknown } | null)?.schedules;
    if (!Array.isArray(list) || list.length > documentLimits.schedulesPerHabit) return false;
    schedules += list.length;
    if (schedules > documentLimits.totalSchedules) return false;
    if (!list.every((schedule) => timezone((schedule as { timezone?: unknown } | null)?.timezone)))
      return false;
  }
  let steps = 0;
  for (const goal of doc.goals as unknown[]) {
    if (!shortTimestamps(goal)) return false;
    const list = (goal as { steps?: unknown } | null)?.steps;
    if (!Array.isArray(list) || list.length > documentLimits.stepsPerGoal) return false;
    steps += list.length;
    if (steps > documentLimits.totalSteps) return false;
    if (!list.every(shortTimestamps)) return false;
  }
  if (!(doc.gifts as unknown[]).every(shortTimestamps)) return false;
  for (const field of ['completions', 'operations'] as const) {
    const entries = doc[field];
    if (!entries || typeof entries !== 'object' || Array.isArray(entries)) return false;
    let count = 0;
    for (const key in entries) {
      if (!Object.hasOwn(entries, key)) continue;
      if (++count > documentLimits[field] || key.length > 160) return false;
      const entry = (entries as Record<string, unknown>)[key];
      if (!shortTimestamps(entry)) return false;
      if (!timezone((entry as { timezone?: unknown } | null)?.timezone)) return false;
      if (field === 'operations') {
        const fingerprint = (entries as Record<string, { fingerprint?: unknown } | null>)[key]
          ?.fingerprint;
        if (
          typeof fingerprint !== 'string' ||
          fingerprint.length > documentLimits.fingerprintLength
        )
          return false;
      }
    }
  }
  return true;
}

function shortTimestamps(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return ['archivedAt', 'claimedAt', 'updatedAt', 'key'].every(
    (field) =>
      typeof item[field] !== 'string' || item[field].length <= (field === 'key' ? 160 : 40),
  );
}
