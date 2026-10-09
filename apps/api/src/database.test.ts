import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import webpush from 'web-push';
import { completionKey, createUser, mutateDocument, type UserDocument } from '@machbar/shared';
import { databaseFilename, migrationBackupDirectory, SqliteDatabase } from './database.js';
import { SqliteStore } from './store.js';
import { PushStore, ReminderScheduler } from './notifications.js';
import { StorageBudget } from './storage-budget.js';
import { readConfig } from './config.js';
import { buildServer } from './server.js';
import { storedRecord } from '../test-support/database.js';

let directory: string;
const budgets: StorageBudget[] = [];
beforeEach(async () => {
  directory = await mkdtemp('/tmp/machbar-sqlite-');
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const budget of budgets.splice(0)) await budget.close();
  await rm(directory, { recursive: true, force: true });
});
function stores(limits = {}) {
  const budget = new StorageBudget(directory, { ...readConfig({}), ...limits });
  budgets.push(budget);
  return {
    budget,
    profiles: new SqliteStore(directory, budget),
    push: new PushStore(directory, budget),
  };
}
function inspect<T>(action: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(join(directory, databaseFilename));
  try {
    db.exec('PRAGMA foreign_keys = ON');
    return action(db);
  } finally {
    db.close();
  }
}

describe('legacy JSON migration', () => {
  it('preserves complete profiles and push receipts across upgrade, sync, and restart', async () => {
    const now = new Date('2026-10-07T07:00:00Z');
    const doc = createUser(randomUUID());
    doc.preferences.timezone = 'Europe/Berlin';
    doc.preferences.name = 'Existing profile';
    doc.revision = 42;
    mutateDocument(
      doc,
      '/api/habits',
      'POST',
      {
        title: 'Read',
        weekdays: [0, 1, 2, 3, 4, 5, 6],
        reminderTime: '09:00',
      },
      randomUUID(),
      now,
    );
    const other = createUser(randomUUID());
    const bindingId = randomUUID();
    const receipt = `${bindingId}:${doc.habits[0]!.id}:2026-10-07`;
    const state = {
      bindings: [
        {
          id: bindingId,
          userId: doc.userId,
          lastTestAt: now.getTime(),
          subscription: {
            endpoint: 'https://push.example.com/legacy',
            keys: { p256dh: webpush.generateVAPIDKeys().publicKey, auth: 'AAAAAAAAAAAAAAAAAAAAAA' },
          },
        },
      ],
      dispatches: {
        [receipt]: { expiresAt: now.getTime() + 86_400_000, attempts: 1, retryAt: null },
      },
    };
    const raw = JSON.stringify(doc, null, 2);
    await writeFile(join(directory, `${doc.userId}.json`), raw);
    await writeFile(join(directory, `${other.userId}.json`), JSON.stringify(other));
    await writeFile(join(directory, 'push-state.json'), JSON.stringify(state));
    await writeFile(join(directory, `${doc.userId}.json.interrupted.tmp`), '{partial');
    const first = stores({ maxProfiles: 1, maxStorageBytes: 1 });
    expect(await first.profiles.readExisting(doc.userId)).toEqual(doc);
    expect(await first.profiles.readExisting(other.userId)).toEqual(other);
    expect(await first.push.access((saved) => saved)).toEqual(state);
    const send = vi.fn(async () => {});
    const scheduler = new ReminderScheduler(first.push, first.profiles, send, () => now);
    await scheduler.tick();
    expect(send).not.toHaveBeenCalled();
    await scheduler.stop();
    await first.budget.close();
    const second = stores();
    await second.profiles.update(
      doc.userId,
      (saved) => {
        saved.preferences.name = 'Updated';
      },
      42,
    );
    await second.budget.close();
    // Even corrupting an old recovery snapshot cannot replace committed data.
    await writeFile(join(directory, migrationBackupDirectory, `${other.userId}.json`), '{obsolete');
    const third = stores();
    expect((await third.profiles.readExisting(doc.userId)).preferences.name).toBe('Updated');
    expect((await third.profiles.readExisting(doc.userId)).revision).toBe(43);
    expect(await third.profiles.readExisting(other.userId)).toEqual(other);
    expect(await third.push.access((saved) => saved)).toEqual(state);
    expect(
      await readFile(join(directory, migrationBackupDirectory, `${doc.userId}.json`), 'utf8'),
    ).toBe(raw);
    await expect(stat(join(directory, `${doc.userId}.json`))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect((await stat(join(directory, migrationBackupDirectory))).mode & 0o777).toBe(0o700);
    expect((await readdir(join(directory, migrationBackupDirectory))).sort()).toEqual(
      [`${doc.userId}.json`, `${other.userId}.json`, 'push-state.json'].sort(),
    );
    expect((await stat(join(directory, databaseFilename))).mode & 0o777).toBe(0o600);
  });

  it.each(['{broken', JSON.stringify(createUser(randomUUID()))])(
    'refuses corrupt or mismatched profiles, then retries after repair: %s',
    async (invalid) => {
      const doc = createUser(randomUUID());
      const path = join(directory, `${doc.userId}.json`);
      await writeFile(path, invalid);
      const failed = stores();
      await expect(failed.profiles.ready()).rejects.toThrow('original file preserved');
      expect(await readFile(path, 'utf8')).toBe(invalid);
      expect(inspect((db) => db.prepare('PRAGMA user_version').get()!.user_version)).toBe(0);
      expect(
        inspect((db) => db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()),
      ).toEqual([]);
      await writeFile(path, JSON.stringify(doc));
      expect(await stores().profiles.readExisting(doc.userId)).toEqual(doc);
    },
  );

  it('refuses corrupt push state even with notifications disabled and leaves profiles untouched', async () => {
    const doc = createUser(randomUUID());
    await writeFile(join(directory, `${doc.userId}.json`), JSON.stringify(doc));
    await writeFile(join(directory, 'push-state.json'), '{broken');
    await expect(
      buildServer({ config: { ...readConfig({}), dataDir: directory } }),
    ).rejects.toThrow('push-state.json');
    expect(await readFile(join(directory, `${doc.userId}.json`), 'utf8')).toBe(JSON.stringify(doc));
    expect(await readFile(join(directory, 'push-state.json'), 'utf8')).toBe('{broken');
    await writeFile(
      join(directory, 'push-state.json'),
      JSON.stringify({ bindings: [], dispatches: {} }),
    );
    expect(await stores().profiles.readExisting(doc.userId)).toEqual(doc);
  });

  it('rolls back a database failure halfway through import and safely retries', async () => {
    const docs = [createUser(randomUUID()), createUser(randomUUID())];
    for (const doc of docs)
      await writeFile(join(directory, `${doc.userId}.json`), JSON.stringify(doc));
    const prepare = DatabaseSync.prototype.prepare;
    let calls = 0;
    const spy = vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function (
      this: DatabaseSync,
      sql: string,
    ) {
      const statement = prepare.call(this, sql);
      if (sql.startsWith('INSERT INTO profiles')) {
        const run = statement.run.bind(statement);
        vi.spyOn(statement, 'run').mockImplementation((...args) => {
          if (++calls === 2) throw new Error('simulated disk failure');
          return run(...args);
        });
      }
      return statement;
    });
    await expect(stores().profiles.ready()).rejects.toMatchObject({
      cause: { message: 'simulated disk failure' },
    });
    spy.mockRestore();
    expect(inspect((db) => db.prepare('PRAGMA user_version').get()!.user_version)).toBe(0);
    expect(
      inspect((db) => db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()),
    ).toEqual([]);
    const retry = stores();
    for (const doc of docs) expect(await retry.profiles.readExisting(doc.userId)).toEqual(doc);
  });

  it('uses an existing backup folder and matching snapshots without replacing unrelated files', async () => {
    const backup = join(directory, migrationBackupDirectory);
    await mkdir(backup, { mode: 0o755 });
    await writeFile(join(backup, 'keep.txt'), 'Existing backup');
    const doc = createUser(randomUUID());
    await writeFile(join(backup, `${doc.userId}.json`), JSON.stringify(doc));
    await writeFile(join(directory, `${doc.userId}.json`), JSON.stringify(doc));
    expect(await stores().profiles.readExisting(doc.userId)).toEqual(doc);
    expect(await readFile(join(backup, 'keep.txt'), 'utf8')).toBe('Existing backup');
    expect(await readFile(join(backup, `${doc.userId}.json`), 'utf8')).toBe(JSON.stringify(doc));
    expect((await stat(join(backup, `${doc.userId}.json`))).mode & 0o777).toBe(0o600);
  });

  it('preserves conflicting backups and resumes archiving without reimporting stale data', async () => {
    const doc = createUser(randomUUID());
    const name = `${doc.userId}.json`;
    const backup = join(directory, migrationBackupDirectory);
    await mkdir(backup);
    await writeFile(join(backup, name), 'Different existing backup');
    await writeFile(join(directory, name), JSON.stringify(doc));
    await expect(stores().profiles.ready()).rejects.toThrow('Cannot archive');
    expect(storedRecord(directory, 'profile', doc.userId)).toBe(JSON.stringify(doc));
    expect(await readFile(join(directory, name), 'utf8')).toBe(JSON.stringify(doc));
    expect(await readFile(join(backup, name), 'utf8')).toBe('Different existing backup');
    const updated = { ...doc, revision: 7 };
    inspect((db) =>
      db
        .prepare('UPDATE profiles SET revision = ? WHERE user_id = ?')
        .run(updated.revision, doc.userId),
    );
    await rm(join(backup, name));
    expect(await stores().profiles.readExisting(doc.userId)).toEqual(updated);
    expect(await readFile(join(backup, name), 'utf8')).toBe(JSON.stringify(doc));
    await expect(stat(join(directory, name))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('resumes a move interrupted after archiving the file but before acknowledging it', async () => {
    const docs = [createUser(randomUUID()), createUser(randomUUID())];
    for (const doc of docs)
      await writeFile(join(directory, `${doc.userId}.json`), JSON.stringify(doc));
    const prepare = DatabaseSync.prototype.prepare;
    const spy = vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function (
      this: DatabaseSync,
      sql: string,
    ) {
      const statement = prepare.call(this, sql);
      if (sql.startsWith('DELETE FROM migration_files'))
        vi.spyOn(statement, 'run').mockImplementation(() => {
          throw new Error('Interrupted archive');
        });
      return statement;
    });
    await expect(stores().profiles.ready()).rejects.toThrow('Cannot archive');
    spy.mockRestore();
    expect(await readdir(join(directory, migrationBackupDirectory))).toHaveLength(1);
    expect(inspect((db) => db.prepare('SELECT name FROM migration_files').all())).toHaveLength(2);
    const retry = stores();
    for (const doc of docs) expect(await retry.profiles.readExisting(doc.userId)).toEqual(doc);
    expect(inspect((db) => db.prepare('SELECT name FROM migration_files').all())).toEqual([]);
    for (const doc of docs) {
      expect(
        await readFile(join(directory, migrationBackupDirectory, `${doc.userId}.json`), 'utf8'),
      ).toBe(JSON.stringify(doc));
      await expect(stat(join(directory, `${doc.userId}.json`))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    }
  });

  it('rejects a symlinked backup directory and leaves the imported originals in place', async () => {
    const target = join(directory, 'untouched-directory');
    await mkdir(target);
    await symlink(target, join(directory, migrationBackupDirectory));
    const doc = createUser(randomUUID());
    const source = join(directory, `${doc.userId}.json`);
    await writeFile(source, JSON.stringify(doc));
    await expect(stores().profiles.ready()).rejects.toThrow('migration-backup must be a directory');
    expect(await readFile(source, 'utf8')).toBe(JSON.stringify(doc));
    expect(await readdir(target)).toEqual([]);
    await rm(join(directory, migrationBackupDirectory));
    expect(await stores().profiles.readExisting(doc.userId)).toEqual(doc);
  });

  it('rejects symlinked profiles and database files without modifying their targets', async () => {
    const doc = createUser(randomUUID());
    const target = join(directory, 'untouched');
    await writeFile(target, JSON.stringify(doc));
    const profile = join(directory, `${doc.userId}.json`);
    await symlink(target, profile);
    await expect(stores().profiles.ready()).rejects.toThrow('Cannot migrate');
    await rm(profile);
    await rm(join(directory, databaseFilename));
    await symlink(target, join(directory, databaseFilename));
    await expect(stores().profiles.ready()).rejects.toThrow('regular files');
    expect(await readFile(target, 'utf8')).toBe(JSON.stringify(doc));
  });
});

describe('SQLite durability and compatibility', () => {
  it('does not recreate a missing SQLite profile from its old JSON snapshot', async () => {
    const doc = createUser(randomUUID());
    await writeFile(join(directory, `${doc.userId}.json`), JSON.stringify(doc));
    const first = stores();
    await first.profiles.ready();
    await first.budget.close();
    inspect((db) => db.prepare('DELETE FROM profiles').run());
    await expect(stores().profiles.readExisting(doc.userId)).rejects.toMatchObject({
      code: 'USER_NOT_FOUND',
    });
  });

  it('rolls back rejected SQL writes without changing persisted state or consuming quota', async () => {
    const { profiles } = stores({ maxProfiles: 1 });
    const id = randomUUID();
    await profiles.update(id, () => {});
    const before = storedRecord(directory, 'profile', id);
    inspect((db) =>
      db.exec(
        "CREATE TRIGGER reject_write BEFORE UPDATE ON profiles BEGIN SELECT RAISE(ABORT, 'write failed'); END",
      ),
    );
    await expect(
      profiles.update(id, (doc) => {
        doc.preferences.name = 'Changed';
      }),
    ).rejects.toThrow('write failed');
    expect(storedRecord(directory, 'profile', id)).toBe(before);
    inspect((db) => db.exec('DROP TRIGGER reject_write'));
    await profiles.update(id, (doc) => {
      doc.preferences.name = 'Saved';
    });
    expect((await profiles.readExisting(id)).revision).toBe(2);
    expect((await readdir(directory)).filter((name) => name.endsWith('-journal'))).toEqual([]);
  });

  it('rejects revisions that became stale on another SQLite connection', async () => {
    const first = stores(),
      second = stores();
    const id = randomUUID();
    await first.profiles.update(id, () => {});
    await expect(
      first.profiles.update(
        id,
        async (doc) => {
          await second.profiles.update(id, (other) => {
            other.preferences.name = 'Won';
          });
          doc.preferences.name = 'Stale';
        },
        1,
      ),
    ).rejects.toMatchObject({ code: 'DOCUMENT_CONFLICT' });
    expect((await first.profiles.readExisting(id)).preferences.name).toBe('Won');
  });

  it('finishes pending mutations before closing the database', async () => {
    const { profiles } = stores();
    const id = randomUUID();
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const update = profiles.update(id, async (doc) => {
      started();
      await gate;
      doc.preferences.name = 'Saved before shutdown';
    });
    await entered;
    let closed = false;
    const closing = profiles.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    release();
    await update;
    await closing;
    expect(JSON.parse(storedRecord(directory, 'profile', id)!).preferences.name).toBe(
      'Saved before shutdown',
    );
    await expect(profiles.read(id)).rejects.toThrow('SQLite database is closed');
  });

  it('preserves a corrupt database and refuses to fall back to legacy files', async () => {
    const doc = createUser(randomUUID());
    await writeFile(join(directory, `${doc.userId}.json`), JSON.stringify(doc));
    await writeFile(join(directory, databaseFilename), 'not a SQLite database');
    await expect(stores().profiles.ready()).rejects.toThrow();
    expect(await readFile(join(directory, databaseFilename), 'utf8')).toBe('not a SQLite database');
    expect(await readFile(join(directory, `${doc.userId}.json`), 'utf8')).toBe(JSON.stringify(doc));
  });

  it('fails safely for a newer database schema and never falls back to JSON', async () => {
    const first = stores();
    await first.profiles.ready();
    await first.budget.close();
    inspect((db) => db.exec('PRAGMA user_version = 99'));
    const database = new SqliteDatabase(directory);
    await expect(database.ready()).rejects.toThrow('Unsupported SQLite schema version');
    expect(inspect((db) => db.prepare('PRAGMA user_version').get()!.user_version)).toBe(99);
  });
});

function richProfile(): UserDocument {
  const doc = createUser(randomUUID());
  const habit = randomUUID(),
    goal = randomUUID(),
    step = randomUUID();
  doc.revision = 73;
  doc.preferences.avatarOptions = { top: 'shortFlat', eyes: 'happy', skinColor: 'ffdbb4' };
  doc.preferences.onboarded = true;
  doc.habits = [
    {
      id: habit,
      title: 'Weekly',
      description: 'History',
      color: 'sage',
      icon: 'book',
      reminderTime: '09:00',
      archivedAt: '2026-10-08T12:00:00Z',
      schedules: [
        { from: '2026-09-01', weekdays: [5, 1, 3], timezone: 'Europe/Berlin' },
        {
          from: '2026-10-01',
          weekdays: [2, 0],
          timezone: 'America/New_York',
          recurrence: { unit: 'week', every: 2, anchor: '2026-10-01' },
          resetStreak: false,
        },
        { from: '2026-11-01', weekdays: [6], timezone: 'UTC', resetStreak: true },
      ],
    },
    {
      id: randomUUID(),
      title: 'No reminder',
      description: '',
      color: 'blue',
      reminderTime: null,
      archivedAt: null,
      schedules: [{ from: '2026-10-01', weekdays: [0], timezone: 'UTC' }],
    },
    {
      id: randomUUID(),
      title: 'Legacy',
      description: '',
      color: 'peach',
      archivedAt: null,
      schedules: [{ from: '2026-10-01', weekdays: [1], timezone: 'UTC' }],
    },
  ];
  doc.goals = [
    {
      id: goal,
      title: 'Goal',
      description: '',
      color: 'lavender',
      icon: 'target',
      archivedAt: null,
      steps: [
        { id: step, title: 'Undated', date: null, icon: 'star', archivedAt: null },
        {
          id: randomUUID(),
          title: 'Archived',
          date: '2026-10-07',
          archivedAt: '2026-10-08T12:00:00Z',
        },
      ],
    },
    {
      id: randomUUID(),
      title: 'Empty',
      description: '',
      color: 'peach',
      archivedAt: null,
      steps: [],
    },
  ];
  doc.gifts = ['goal', 'habitCount', 'habitStreak'].map((type, index) => ({
    id: randomUUID(),
    title: `Gift ${index}`,
    targetType: type as 'goal' | 'habitCount' | 'habitStreak',
    targetId: type === 'goal' ? goal : habit,
    threshold: index + 1,
    claimedAt: index === 0 ? '2026-10-08T12:00:00Z' : null,
    archivedAt: null,
  }));
  for (const [type, targetId] of [
    ['habit', habit],
    ['step', step],
    ['goal', goal],
  ] as const) {
    const key = completionKey(type, targetId, '2026-10-01');
    doc.completions[key] = {
      key,
      targetType: type,
      targetId,
      date: '2026-10-07',
      timezone: 'UTC',
      completed: type !== 'goal',
      version: 5,
      updatedAt: '2026-10-07T12:00:00Z',
      ...(type === 'habit' ? { periodStart: '2026-10-01' } : {}),
    };
  }
  doc.operations[randomUUID()] = { fingerprint: 'opaque receipt', version: 0 };
  return doc;
}
function versionOne(profiles: { key: string; contents: string }[], push?: string) {
  inspect((db) => {
    db.exec(`CREATE TABLE records (kind TEXT NOT NULL, key TEXT NOT NULL, contents TEXT NOT NULL,
      PRIMARY KEY (kind, key)) STRICT;
      CREATE TABLE migration_files (name TEXT PRIMARY KEY, sha256 TEXT NOT NULL) STRICT;
      PRAGMA user_version = 1;`);
    const insert = db.prepare('INSERT INTO records VALUES (?, ?, ?)');
    for (const profile of profiles) insert.run('profile', profile.key, profile.contents);
    if (push !== undefined) insert.run('push', '', push);
  });
}

describe('normalized SQLite schema', () => {
  it('upgrades version 1 with full history, receipts, ordering, and quota charges intact', async () => {
    const doc = richProfile();
    const raw = JSON.stringify(doc, null, 2);
    const push = {
      bindings: [
        {
          id: randomUUID(),
          userId: doc.userId,
          subscription: {
            endpoint: 'https://push.example.com/old',
            expirationTime: null,
            keys: { p256dh: webpush.generateVAPIDKeys().publicKey, auth: 'AAAAAAAAAAAAAAAAAAAAAA' },
          },
          lastTestAt: 123.5,
        },
        {
          id: randomUUID(),
          userId: randomUUID(),
          subscription: {
            endpoint: 'https://push.example.com/orphan',
            expirationTime: 12345,
            keys: { p256dh: webpush.generateVAPIDKeys().publicKey, auth: 'AAAAAAAAAAAAAAAAAAAAAA' },
          },
        },
        {
          id: randomUUID(),
          userId: doc.userId,
          subscription: {
            endpoint: 'https://push.example.com/optional',
            keys: { p256dh: webpush.generateVAPIDKeys().publicKey, auth: 'AAAAAAAAAAAAAAAAAAAAAA' },
          },
        },
      ],
      dispatches: {
        'detached:receipt': { expiresAt: 999.5, attempts: 2, retryAt: null },
        'retry:receipt': { expiresAt: 9999, attempts: 3, retryAt: 800 },
      },
    };
    const pushRaw = JSON.stringify(push, null, 2);
    versionOne([{ key: doc.userId, contents: raw }], pushRaw);
    const first = stores({ maxProfiles: 1, maxStorageBytes: 1 });
    expect(await first.profiles.readExisting(doc.userId)).toEqual(doc);
    expect(await first.push.access((state) => state)).toEqual(push);
    expect(inspect((db) => db.prepare('PRAGMA user_version').get()!.user_version)).toBe(3);
    expect(
      inspect((db) => db.prepare("SELECT name FROM sqlite_master WHERE name = 'records'").get()),
    ).toBeUndefined();
    expect(
      inspect((db) => db.prepare('SELECT logical_bytes FROM profiles').get()!.logical_bytes),
    ).toBe(Buffer.byteLength(raw));
    expect(
      inspect((db) => db.prepare('SELECT logical_bytes FROM push_state').get()!.logical_bytes),
    ).toBe(Buffer.byteLength(pushRaw));
    expect(inspect((db) => db.prepare('PRAGMA foreign_key_check').all())).toEqual([]);
    await first.budget.close();
    const second = stores();
    await second.profiles.update(
      doc.userId,
      (saved) => {
        saved.habits.reverse();
        saved.goals[0]!.steps.reverse();
      },
      73,
    );
    doc.habits.reverse();
    doc.goals[0]!.steps.reverse();
    doc.revision++;
    expect(await second.profiles.readExisting(doc.userId)).toEqual(doc);
    expect(await second.push.access((state) => state)).toEqual(push);
  });

  it('upgrades version 2 with unknown creation and sync times and deletion tombstones', async () => {
    const doc = richProfile();
    const first = stores();
    await first.budget.commit('profile', doc.userId, JSON.stringify(doc));
    await first.budget.close();
    inspect((db) =>
      db.exec(`ALTER TABLE profiles DROP COLUMN created_at;
        ALTER TABLE profiles DROP COLUMN updated_at; DROP TABLE deleted_profiles;
        PRAGMA user_version = 2;`),
    );
    const second = stores();
    expect(await second.profiles.readExisting(doc.userId)).toEqual(doc);
    expect(inspect((db) => db.prepare('PRAGMA user_version').get()!.user_version)).toBe(3);
    expect(inspect((db) => db.prepare('SELECT * FROM deleted_profiles').all())).toEqual([]);
    expect(
      inspect((db) => ({ ...db.prepare('SELECT created_at, updated_at FROM profiles').get() })),
    ).toEqual({ created_at: null, updated_at: null });
    await second.profiles.update(doc.userId, () => {});
    const times = inspect((db) => db.prepare('SELECT created_at, updated_at FROM profiles').get()!);
    expect(times.created_at).toBeNull();
    expect(typeof times.updated_at).toBe('string');
  });

  it.each([undefined, null, {}, { mouth: 'smile' } as const])(
    'round-trips avatar presence: %s',
    async (avatarOptions) => {
      const doc = createUser(randomUUID());
      if (avatarOptions !== undefined) doc.preferences.avatarOptions = avatarOptions;
      const { budget, profiles } = stores();
      await budget.commit('profile', doc.userId, JSON.stringify(doc));
      expect(await profiles.readExisting(doc.userId)).toEqual(doc);
    },
  );

  it('imports full JSON history directly into relational tables', async () => {
    const doc = richProfile();
    await writeFile(join(directory, `${doc.userId}.json`), JSON.stringify(doc));
    expect(await stores().profiles.readExisting(doc.userId)).toEqual(doc);
    expect(
      inspect((db) => db.prepare('SELECT COUNT(*) AS count FROM habit_schedules').get()!.count),
    ).toBe(5);
    expect(
      inspect((db) => db.prepare('SELECT COUNT(*) AS count FROM completions').get()!.count),
    ).toBe(3);
  });

  it('rolls back the entire version 1 upgrade on corrupt data and retries after repair', async () => {
    const doc = richProfile(),
      other = createUser(randomUUID());
    versionOne([
      { key: doc.userId, contents: JSON.stringify(doc) },
      { key: other.userId, contents: '{broken' },
    ]);
    await expect(stores().profiles.ready()).rejects.toThrow('original database preserved');
    expect(inspect((db) => db.prepare('PRAGMA user_version').get()!.user_version)).toBe(1);
    expect(
      inspect((db) => db.prepare("SELECT name FROM sqlite_master WHERE name = 'profiles'").get()),
    ).toBeUndefined();
    expect(
      inspect(
        (db) => db.prepare('SELECT contents FROM records WHERE key = ?').get(doc.userId)!.contents,
      ),
    ).toBe(JSON.stringify(doc));
    inspect((db) =>
      db
        .prepare('UPDATE records SET contents = ? WHERE key = ?')
        .run(JSON.stringify(other), other.userId),
    );
    const retry = stores();
    expect(await retry.profiles.readExisting(doc.userId)).toEqual(doc);
    expect(await retry.profiles.readExisting(other.userId)).toEqual(other);
  });

  it('resumes version 1 pending JSON archives without replacing newer SQLite state', async () => {
    const original = createUser(randomUUID());
    const raw = JSON.stringify(original, null, 2);
    const updated = {
      ...original,
      revision: 8,
      preferences: { ...original.preferences, name: 'Newer SQLite data' },
    };
    versionOne([{ key: updated.userId, contents: JSON.stringify(updated) }]);
    const name = `${original.userId}.json`;
    await writeFile(join(directory, name), raw);
    inspect((db) =>
      db
        .prepare('INSERT INTO migration_files VALUES (?, ?)')
        .run(name, createHash('sha256').update(raw).digest('hex')),
    );
    expect(await stores().profiles.readExisting(updated.userId)).toEqual(updated);
    expect(await readFile(join(directory, migrationBackupDirectory, name), 'utf8')).toBe(raw);
    expect(inspect((db) => db.prepare('SELECT * FROM migration_files').all())).toEqual([]);
    await expect(stat(join(directory, name))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects dangling legacy references without removing the version 1 records', async () => {
    const doc = richProfile();
    doc.gifts[0]!.targetId = randomUUID();
    versionOne([{ key: doc.userId, contents: JSON.stringify(doc) }]);
    await expect(stores().profiles.ready()).rejects.toThrow('original database preserved');
    expect(inspect((db) => db.prepare('PRAGMA user_version').get()!.user_version)).toBe(1);
  });

  it('rejects references to another profile and rolls back all changed rows and byte accounting', async () => {
    const doc = richProfile(),
      other = createUser(randomUUID());
    const { budget, profiles } = stores();
    await budget.commit('profile', doc.userId, JSON.stringify(doc));
    await budget.commit('profile', other.userId, JSON.stringify(other));
    const before = inspect(
      (db) =>
        db.prepare('SELECT logical_bytes FROM profiles WHERE user_id = ?').get(other.userId)!
          .logical_bytes,
    );
    await expect(
      profiles.update(other.userId, (saved) => {
        saved.gifts.push(doc.gifts[0]!);
      }),
    ).rejects.toThrow('FOREIGN KEY');
    expect(await profiles.readExisting(other.userId)).toEqual(other);
    expect(await profiles.readExisting(doc.userId)).toEqual(doc);
    expect(
      inspect(
        (db) =>
          db.prepare('SELECT logical_bytes FROM profiles WHERE user_id = ?').get(other.userId)!
            .logical_bytes,
      ),
    ).toBe(before);
  });

  it('rolls back a failed child insert after deleting the previous history', async () => {
    const doc = richProfile();
    const { budget, profiles } = stores();
    await budget.commit('profile', doc.userId, JSON.stringify(doc));
    inspect((db) =>
      db.exec(
        "CREATE TRIGGER reject_step BEFORE INSERT ON steps BEGIN SELECT RAISE(ABORT, 'step write failed'); END",
      ),
    );
    await expect(
      profiles.update(doc.userId, (saved) => {
        saved.preferences.name = 'Changed';
        saved.goals[0]!.steps[0]!.title = 'Changed';
      }),
    ).rejects.toThrow('step write failed');
    expect(await profiles.readExisting(doc.userId)).toEqual(doc);
    expect(inspect((db) => db.prepare('PRAGMA foreign_key_check').all())).toEqual([]);
  });
});
