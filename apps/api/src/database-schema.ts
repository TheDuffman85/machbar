import { avatarChoices } from '@machbar/shared';

export const avatarFields = Object.keys(avatarChoices) as (keyof typeof avatarChoices)[];

// The wire document is assembled from these tables; no document blobs are kept.
export const normalizedSchema = `
CREATE TABLE profiles (
  user_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL CHECK (revision >= 0),
  name TEXT NOT NULL,
  language TEXT NOT NULL CHECK (language IN ('en', 'de')),
  theme TEXT NOT NULL CHECK (theme IN ('light', 'dark', 'system')),
  timezone TEXT NOT NULL,
  avatar_seed TEXT NOT NULL,
  avatar_mode INTEGER NOT NULL CHECK (avatar_mode IN (0, 1, 2)),
  onboarded INTEGER NOT NULL CHECK (onboarded IN (0, 1)),
  logical_bytes INTEGER NOT NULL CHECK (logical_bytes >= 0),
  -- Server write times for the admin page; NULL for profiles imported before v3.
  created_at TEXT,
  updated_at TEXT
) STRICT;
CREATE TABLE profile_avatars (
  user_id TEXT PRIMARY KEY REFERENCES profiles(user_id) ON DELETE CASCADE,
  ${avatarFields.map((field) => `${field} TEXT`).join(',\n  ')}
) STRICT;
CREATE TABLE habits (
  user_id TEXT NOT NULL REFERENCES profiles(user_id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0),
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  color TEXT NOT NULL,
  icon TEXT,
  reminder_time TEXT,
  reminder_present INTEGER NOT NULL CHECK (reminder_present IN (0, 1)),
  archived_at TEXT,
  PRIMARY KEY (user_id, id), UNIQUE (user_id, position)
) STRICT;
CREATE TABLE habit_schedules (
  user_id TEXT NOT NULL,
  habit_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0),
  from_date TEXT NOT NULL,
  timezone TEXT NOT NULL,
  recurrence_unit TEXT CHECK (recurrence_unit IN ('day', 'week', 'month')),
  recurrence_every INTEGER CHECK (recurrence_every BETWEEN 1 AND 365),
  recurrence_anchor TEXT,
  reset_streak INTEGER CHECK (reset_streak IN (0, 1)),
  PRIMARY KEY (user_id, habit_id, position),
  FOREIGN KEY (user_id, habit_id) REFERENCES habits(user_id, id) ON DELETE CASCADE,
  CHECK ((recurrence_unit IS NULL AND recurrence_every IS NULL AND recurrence_anchor IS NULL)
    OR (recurrence_unit IS NOT NULL AND recurrence_every IS NOT NULL AND recurrence_anchor IS NOT NULL))
) STRICT;
CREATE TABLE schedule_weekdays (
  user_id TEXT NOT NULL,
  habit_id TEXT NOT NULL,
  schedule_position INTEGER NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0),
  weekday INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  PRIMARY KEY (user_id, habit_id, schedule_position, weekday),
  UNIQUE (user_id, habit_id, schedule_position, position),
  FOREIGN KEY (user_id, habit_id, schedule_position)
    REFERENCES habit_schedules(user_id, habit_id, position) ON DELETE CASCADE
) STRICT;
CREATE TABLE goals (
  user_id TEXT NOT NULL REFERENCES profiles(user_id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0),
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  color TEXT NOT NULL,
  icon TEXT,
  date TEXT,
  date_present INTEGER NOT NULL CHECK (date_present IN (0, 1)),
  reminder_time TEXT,
  reminder_present INTEGER NOT NULL CHECK (reminder_present IN (0, 1)),
  archived_at TEXT,
  PRIMARY KEY (user_id, id), UNIQUE (user_id, position)
) STRICT;
CREATE TABLE steps (
  user_id TEXT NOT NULL,
  id TEXT NOT NULL,
  goal_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0),
  title TEXT NOT NULL,
  date TEXT,
  reminder_time TEXT,
  reminder_present INTEGER NOT NULL CHECK (reminder_present IN (0, 1)),
  icon TEXT,
  archived_at TEXT,
  PRIMARY KEY (user_id, id), UNIQUE (user_id, goal_id, position),
  FOREIGN KEY (user_id, goal_id) REFERENCES goals(user_id, id) ON DELETE CASCADE
) STRICT;
CREATE TABLE gifts (
  user_id TEXT NOT NULL REFERENCES profiles(user_id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0),
  title TEXT NOT NULL,
  target_type TEXT NOT NULL CHECK (target_type IN ('goal', 'habitCount', 'habitStreak')),
  goal_id TEXT,
  habit_id TEXT,
  threshold INTEGER NOT NULL CHECK (threshold BETWEEN 1 AND 10000),
  claimed_at TEXT,
  archived_at TEXT,
  PRIMARY KEY (user_id, id), UNIQUE (user_id, position),
  FOREIGN KEY (user_id, goal_id) REFERENCES goals(user_id, id),
  FOREIGN KEY (user_id, habit_id) REFERENCES habits(user_id, id),
  CHECK ((target_type = 'goal' AND goal_id IS NOT NULL AND habit_id IS NULL)
    OR (target_type != 'goal' AND habit_id IS NOT NULL AND goal_id IS NULL))
) STRICT;
CREATE TABLE completions (
  user_id TEXT NOT NULL REFERENCES profiles(user_id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  habit_id TEXT,
  goal_id TEXT,
  step_id TEXT,
  date TEXT NOT NULL,
  timezone TEXT NOT NULL,
  completed INTEGER NOT NULL CHECK (completed IN (0, 1)),
  period_start TEXT,
  version INTEGER NOT NULL CHECK (version >= 1),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, key),
  FOREIGN KEY (user_id, habit_id) REFERENCES habits(user_id, id),
  FOREIGN KEY (user_id, goal_id) REFERENCES goals(user_id, id),
  FOREIGN KEY (user_id, step_id) REFERENCES steps(user_id, id),
  CHECK ((habit_id IS NOT NULL) + (goal_id IS NOT NULL) + (step_id IS NOT NULL) = 1),
  CHECK (period_start IS NULL OR (habit_id IS NOT NULL AND period_start <= date))
) STRICT;
CREATE TABLE operations (
  user_id TEXT NOT NULL REFERENCES profiles(user_id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  version INTEGER NOT NULL,
  PRIMARY KEY (user_id, id)
) STRICT;
-- Profiles removed by an administrator. Their IDs can never be saved again,
-- so devices that still hold a local copy cannot recreate them.
CREATE TABLE deleted_profiles (
  user_id TEXT PRIMARY KEY,
  deleted_at TEXT NOT NULL
) STRICT;
CREATE TABLE push_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  logical_bytes INTEGER NOT NULL CHECK (logical_bytes >= 0)
) STRICT;
-- Push state historically permits subscriptions for missing profiles and
-- receipts after a binding disappears. Keep both independent of profile lifetime.
CREATE TABLE push_bindings (
  id TEXT PRIMARY KEY,
  position INTEGER NOT NULL UNIQUE CHECK (position >= 0),
  user_id TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  expiration_time REAL,
  expiration_present INTEGER NOT NULL CHECK (expiration_present IN (0, 1)),
  last_test_at REAL
) STRICT;
CREATE INDEX push_bindings_user ON push_bindings(user_id);
CREATE TABLE push_dispatches (
  key TEXT PRIMARY KEY,
  expires_at REAL NOT NULL,
  attempts REAL NOT NULL,
  retry_at REAL
) STRICT;
CREATE INDEX push_dispatches_expiry ON push_dispatches(expires_at);
`;
