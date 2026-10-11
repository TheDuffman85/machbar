import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { DomainError, userDocumentSchema, type UserDocument } from '@machbar/shared';
import { stateSchema, type State } from './push-state.js';
import { avatarFields } from './database-schema.js';

export type RecordKind = 'profile' | 'push';
type Row = Record<string, SQLInputValue>;
const optional = (key: string, value: SQLInputValue) => (value === null ? {} : { [key]: value });

// Callers own the transaction so the entire reconstructed document is a snapshot.
export function readRecord(db: DatabaseSync, kind: RecordKind, key: string): string | undefined {
  if (kind === 'push') {
    if (!db.prepare('SELECT singleton FROM push_state').get()) return undefined;
    const bindings = db
      .prepare('SELECT * FROM push_bindings ORDER BY position')
      .all()
      .map((b) => ({
        id: b.id,
        userId: b.user_id,
        subscription: {
          endpoint: b.endpoint,
          keys: { p256dh: b.p256dh, auth: b.auth },
          ...(b.expiration_present ? { expirationTime: b.expiration_time } : {}),
        },
        ...optional('lastTestAt', b.last_test_at),
      }));
    const dispatches = Object.fromEntries(
      db
        .prepare('SELECT * FROM push_dispatches ORDER BY rowid')
        .all()
        .map((d) => [
          d.key,
          {
            expiresAt: d.expires_at,
            attempts: d.attempts,
            retryAt: d.retry_at,
          },
        ]),
    );
    return JSON.stringify({ bindings, dispatches });
  }
  const profile = db.prepare('SELECT * FROM profiles WHERE user_id = ?').get(key);
  if (!profile) return undefined;
  const rows = (table: string, order = 'position') =>
    db.prepare(`SELECT * FROM ${table} WHERE user_id = ? ORDER BY ${order}`).all(key);
  const avatar = db.prepare('SELECT * FROM profile_avatars WHERE user_id = ?').get(key);
  if (profile.avatar_mode === 2 && !avatar) throw new DomainError('DATA_CORRUPT', 500);
  const schedules = rows('habit_schedules', 'habit_id, position');
  const weekdays = rows('schedule_weekdays', 'habit_id, schedule_position, position');
  const scheduleMap = new Map<string, Row[]>();
  for (const schedule of schedules) {
    const list = scheduleMap.get(String(schedule.habit_id)) ?? [];
    list.push(schedule);
    scheduleMap.set(String(schedule.habit_id), list);
  }
  const weekdayMap = new Map<string, SQLInputValue[]>();
  for (const day of weekdays) {
    const scheduleKey = `${day.habit_id}:${day.schedule_position}`;
    const list = weekdayMap.get(scheduleKey) ?? [];
    list.push(day.weekday);
    weekdayMap.set(scheduleKey, list);
  }
  const steps = rows('steps', 'goal_id, position');
  const stepMap = new Map<string, Row[]>();
  for (const step of steps) {
    const list = stepMap.get(String(step.goal_id)) ?? [];
    list.push(step);
    stepMap.set(String(step.goal_id), list);
  }
  return JSON.stringify({
    schemaVersion: 1,
    revision: profile.revision,
    userId: profile.user_id,
    preferences: {
      name: profile.name,
      language: profile.language,
      theme: profile.theme,
      timezone: profile.timezone,
      avatarSeed: profile.avatar_seed,
      ...(profile.avatar_mode === 0
        ? {}
        : {
            avatarOptions:
              profile.avatar_mode === 1
                ? null
                : Object.fromEntries(
                    avatarFields
                      .filter((field) => avatar![field] !== null)
                      .map((field) => [field, avatar![field]]),
                  ),
          }),
      onboarded: Boolean(profile.onboarded),
      ...(profile.check_in_reminder === null
        ? {}
        : { checkInReminder: Boolean(profile.check_in_reminder) }),
      ...optional('checkInReminderTime', profile.check_in_reminder_time),
    },
    habits: rows('habits').map((h) => ({
      title: h.title,
      ...(h.reminder_present ? { reminderTime: h.reminder_time } : {}),
      description: h.description,
      color: h.color,
      ...optional('icon', h.icon),
      id: h.id,
      schedules: (scheduleMap.get(String(h.id)) ?? []).map((s) => ({
        from: s.from_date,
        weekdays: weekdayMap.get(`${h.id}:${s.position}`) ?? [],
        timezone: s.timezone,
        ...(s.recurrence_unit === null
          ? {}
          : {
              recurrence: {
                unit: s.recurrence_unit,
                every: s.recurrence_every,
                anchor: s.recurrence_anchor,
              },
            }),
        ...(s.reset_streak === null ? {} : { resetStreak: Boolean(s.reset_streak) }),
      })),
      archivedAt: h.archived_at,
    })),
    goals: rows('goals').map((g) => ({
      title: g.title,
      ...(g.date_present ? { date: g.date } : {}),
      ...(g.reminder_present ? { reminderTime: g.reminder_time } : {}),
      description: g.description,
      color: g.color,
      ...optional('icon', g.icon),
      id: g.id,
      steps: (stepMap.get(String(g.id)) ?? []).map((s) => ({
        title: s.title,
        date: s.date,
        ...(s.reminder_present ? { reminderTime: s.reminder_time } : {}),
        ...optional('icon', s.icon),
        id: s.id,
        archivedAt: s.archived_at,
      })),
      archivedAt: g.archived_at,
    })),
    gifts: rows('gifts').map((g) => ({
      title: g.title,
      ...optional('description', g.description),
      ...optional('icon', g.icon),
      targetType: g.target_type,
      targetId: g.goal_id ?? g.habit_id,
      threshold: g.threshold,
      id: g.id,
      claimedAt: g.claimed_at,
      archivedAt: g.archived_at,
    })),
    completions: Object.fromEntries(
      rows('completions', 'rowid').map((c) => [
        c.key,
        {
          key: c.key,
          targetType: c.habit_id !== null ? 'habit' : c.goal_id !== null ? 'goal' : 'step',
          targetId: c.habit_id ?? c.goal_id ?? c.step_id,
          date: c.date,
          timezone: c.timezone,
          completed: Boolean(c.completed),
          ...optional('periodStart', c.period_start),
          version: c.version,
          updatedAt: c.updated_at,
        },
      ]),
    ),
    operations: Object.fromEntries(
      rows('operations', 'rowid').map((o) => [
        o.id,
        {
          fingerprint: o.fingerprint,
          version: o.version,
        },
      ]),
    ),
  });
}

export function recordBytes(db: DatabaseSync, kind: RecordKind, key: string): number {
  const row =
    kind === 'profile'
      ? db.prepare('SELECT logical_bytes FROM profiles WHERE user_id = ?').get(key)
      : db.prepare('SELECT logical_bytes FROM push_state').get();
  return Number(row?.logical_bytes ?? 0);
}

// Logical payload bytes are a quota cache, maintained in the same transaction as
// relational data. Imports retain their original byte charge, including whitespace.
// Imports pass a null write time because their creation and sync times are unknown.
export function writeRecord(
  db: DatabaseSync,
  kind: RecordKind,
  key: string,
  contents: string,
  writtenAt: string | null = new Date().toISOString(),
) {
  const bytes = Buffer.byteLength(contents);
  if (kind === 'push') {
    if (key !== '') throw new Error('Invalid push record key');
    writePush(db, stateSchema.parse(JSON.parse(contents)), bytes);
  } else {
    const doc = userDocumentSchema.parse(JSON.parse(contents));
    if (doc.userId !== key) throw new Error('Profile ID does not match record key');
    writeProfile(db, doc, bytes, writtenAt);
  }
}
function inserter(db: DatabaseSync) {
  const statements = new Map<string, ReturnType<DatabaseSync['prepare']>>();
  return (table: string, row: Row) => {
    let statement = statements.get(table);
    if (!statement) {
      const columns = Object.keys(row);
      statement = db.prepare(
        `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
      );
      statements.set(table, statement);
    }
    statement.run(...Object.values(row));
  };
}
function writeProfile(
  db: DatabaseSync,
  doc: UserDocument,
  bytes: number,
  writtenAt: string | null,
) {
  const p = doc.preferences;
  db.prepare(
    `INSERT INTO profiles (user_id, revision, name, language, theme, timezone,
    avatar_seed, avatar_mode, onboarded, check_in_reminder, check_in_reminder_time,
    logical_bytes, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (user_id) DO UPDATE SET revision = excluded.revision, name = excluded.name,
    language = excluded.language, theme = excluded.theme, timezone = excluded.timezone,
    avatar_seed = excluded.avatar_seed, avatar_mode = excluded.avatar_mode,
    onboarded = excluded.onboarded, check_in_reminder = excluded.check_in_reminder,
    check_in_reminder_time = excluded.check_in_reminder_time,
    logical_bytes = excluded.logical_bytes, updated_at = excluded.updated_at`,
  ).run(
    doc.userId,
    doc.revision,
    p.name,
    p.language,
    p.theme,
    p.timezone,
    p.avatarSeed,
    p.avatarOptions === undefined ? 0 : p.avatarOptions === null ? 1 : 2,
    Number(p.onboarded),
    p.checkInReminder === undefined ? null : Number(p.checkInReminder),
    p.checkInReminderTime ?? null,
    bytes,
    writtenAt,
    writtenAt,
  );
  // Remove referring rows before their targets. All deletes and inserts commit
  // together; a failed replacement leaves the previous document intact.
  for (const table of ['completions', 'gifts', 'operations', 'habits', 'goals', 'profile_avatars'])
    db.prepare(`DELETE FROM ${table} WHERE user_id = ?`).run(doc.userId);
  const insert = inserter(db);
  const user = { user_id: doc.userId };
  if (p.avatarOptions)
    insert('profile_avatars', {
      ...user,
      ...Object.fromEntries(avatarFields.map((field) => [field, p.avatarOptions![field] ?? null])),
    });
  doc.habits.forEach((h, position) => {
    insert('habits', {
      ...user,
      id: h.id,
      position,
      title: h.title,
      description: h.description,
      color: h.color,
      icon: h.icon ?? null,
      reminder_time: h.reminderTime ?? null,
      reminder_present: Number(h.reminderTime !== undefined),
      archived_at: h.archivedAt,
    });
    h.schedules.forEach((s, position) => {
      insert('habit_schedules', {
        ...user,
        habit_id: h.id,
        position,
        from_date: s.from,
        timezone: s.timezone,
        recurrence_unit: s.recurrence?.unit ?? null,
        recurrence_every: s.recurrence?.every ?? null,
        recurrence_anchor: s.recurrence?.anchor ?? null,
        reset_streak: s.resetStreak === undefined ? null : Number(s.resetStreak),
      });
      s.weekdays.forEach((weekday, dayPosition) =>
        insert('schedule_weekdays', {
          ...user,
          habit_id: h.id,
          schedule_position: position,
          position: dayPosition,
          weekday,
        }),
      );
    });
  });
  doc.goals.forEach((g, position) => {
    insert('goals', {
      ...user,
      id: g.id,
      position,
      title: g.title,
      description: g.description,
      color: g.color,
      date: g.date ?? null,
      date_present: Number(g.date !== undefined),
      reminder_time: g.reminderTime ?? null,
      reminder_present: Number(g.reminderTime !== undefined),
      icon: g.icon ?? null,
      archived_at: g.archivedAt,
    });
    g.steps.forEach((s, position) =>
      insert('steps', {
        ...user,
        id: s.id,
        goal_id: g.id,
        position,
        title: s.title,
        date: s.date,
        reminder_time: s.reminderTime ?? null,
        reminder_present: Number(s.reminderTime !== undefined),
        icon: s.icon ?? null,
        archived_at: s.archivedAt,
      }),
    );
  });
  doc.gifts.forEach((g, position) =>
    insert('gifts', {
      ...user,
      id: g.id,
      position,
      title: g.title,
      description: g.description ?? null,
      icon: g.icon ?? null,
      target_type: g.targetType,
      goal_id: g.targetType === 'goal' ? g.targetId : null,
      habit_id: g.targetType === 'goal' ? null : g.targetId,
      threshold: g.threshold,
      claimed_at: g.claimedAt,
      archived_at: g.archivedAt,
    }),
  );
  for (const [key, c] of Object.entries(doc.completions)) {
    if (key !== c.key) throw new Error('Completion key does not match record key');
    insert('completions', {
      ...user,
      key,
      habit_id: c.targetType === 'habit' ? c.targetId : null,
      goal_id: c.targetType === 'goal' ? c.targetId : null,
      step_id: c.targetType === 'step' ? c.targetId : null,
      date: c.date,
      timezone: c.timezone,
      completed: Number(c.completed),
      period_start: c.periodStart ?? null,
      version: c.version,
      updated_at: c.updatedAt,
    });
  }
  for (const [id, o] of Object.entries(doc.operations))
    insert('operations', { ...user, id, fingerprint: o.fingerprint, version: o.version });
}
function writePush(db: DatabaseSync, state: State, bytes: number) {
  db.prepare(
    `INSERT INTO push_state (singleton, logical_bytes) VALUES (1, ?)
    ON CONFLICT (singleton) DO UPDATE SET logical_bytes = excluded.logical_bytes`,
  ).run(bytes);
  db.exec('DELETE FROM push_bindings; DELETE FROM push_dispatches;');
  const insert = inserter(db);
  state.bindings.forEach((b, position) =>
    insert('push_bindings', {
      id: b.id,
      position,
      user_id: b.userId,
      endpoint: b.subscription.endpoint,
      p256dh: b.subscription.keys.p256dh,
      auth: b.subscription.keys.auth,
      expiration_time: b.subscription.expirationTime ?? null,
      expiration_present: Number(b.subscription.expirationTime !== undefined),
      last_test_at: b.lastTestAt ?? null,
    }),
  );
  for (const [key, d] of Object.entries(state.dispatches))
    insert('push_dispatches', {
      key,
      expires_at: d.expiresAt,
      attempts: d.attempts,
      retry_at: d.retryAt,
    });
}
