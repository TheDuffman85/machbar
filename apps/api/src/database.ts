import { constants } from 'node:fs';
import { chmod, link, lstat, mkdir, open, readFile, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { localUserIdSchema, userDocumentSchema, pruneUnusedArchivedItems } from '@machbar/shared';
import { stateSchema } from './push-state.js';
import { normalizedSchema } from './database-schema.js';
import { readRecord, writeRecord, type RecordKind } from './database-records.js';
export type { RecordKind } from './database-records.js';

export const databaseFilename = 'data.db';
export const migrationBackupDirectory = 'migration-backup';
const schemaVersion = 5;

// Relational rows own persistence. JSON is only the API encoding and legacy
// import format; archived files remain immutable recovery snapshots.
export class SqliteDatabase {
  private connection?: DatabaseSync;
  private closed = false;
  private initialization?: Promise<DatabaseSync>;
  constructor(public directory: string) {}

  ready(): Promise<DatabaseSync> {
    if (this.closed) return Promise.reject(new Error('SQLite database is closed'));
    return (this.initialization ??= this.initialize());
  }
  private async initialize(): Promise<DatabaseSync> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const path = join(this.directory, databaseFilename);
    // Do not let a data-volume symlink redirect database writes elsewhere.
    for (const suffix of ['', '-journal', '-wal', '-shm']) {
      const entry = await lstat(path + suffix).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
        return undefined;
      });
      if (entry && !entry.isFile()) throw new Error('SQLite storage must be regular files');
    }
    const file = await open(
      path,
      constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await file.chmod(0o600);
    } finally {
      await file.close();
    }
    const db = new DatabaseSync(path, { timeout: 5000 });
    try {
      // Rollback journals keep stopped-server backups to one database file.
      // EXTRA also syncs the directory after journal removal on commit.
      const version = () => Number(db.prepare('PRAGMA user_version').get()!.user_version);
      if (version() > schemaVersion) throw new Error('Unsupported SQLite schema version');
      db.exec(
        'PRAGMA journal_mode = DELETE; PRAGMA synchronous = EXTRA; PRAGMA foreign_keys = ON;',
      );
      if (version() === 0) {
        if (db.prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").get())
          throw new Error('Unrecognized SQLite database; refusing to overwrite it');
        const legacy = await this.legacyRecords();
        // Tables, imported data, and the migration marker commit together. A
        // failed or interrupted import can be retried without partial profiles.
        db.exec('BEGIN IMMEDIATE');
        try {
          if (version() === 0) {
            db.exec(normalizedSchema);
            db.exec(
              'CREATE TABLE migration_files (name TEXT PRIMARY KEY, sha256 TEXT NOT NULL) STRICT',
            );
            const archive = db.prepare('INSERT INTO migration_files (name, sha256) VALUES (?, ?)');
            for (const record of legacy) {
              try {
                writeRecord(
                  db,
                  record.kind,
                  record.key,
                  migrationContents(record.kind, record.contents),
                  null,
                );
              } catch (cause) {
                throw new Error(
                  `Cannot migrate ${record.name}; original file preserved. Repair it and restart.`,
                  { cause },
                );
              }
              archive.run(record.name, createHash('sha256').update(record.contents).digest('hex'));
            }
            db.exec(`PRAGMA user_version = ${schemaVersion}`);
          }
          db.exec('COMMIT');
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        }
      }
      if (version() === 1) {
        db.exec('BEGIN IMMEDIATE');
        try {
          if (version() === 1) {
            db.exec(normalizedSchema);
            for (const record of db
              .prepare('SELECT kind, key, contents FROM records ORDER BY kind, key')
              .all()) {
              try {
                if (record.kind !== 'profile' && record.kind !== 'push')
                  throw new Error('Unknown record kind');
                writeRecord(
                  db,
                  record.kind,
                  String(record.key),
                  migrationContents(record.kind, String(record.contents)),
                  null,
                );
              } catch (cause) {
                throw new Error(
                  `Cannot normalize SQLite ${record.kind} record ${record.key}; original database preserved.`,
                  { cause },
                );
              }
            }
            db.exec(`DROP TABLE records; PRAGMA user_version = ${schemaVersion}`);
          }
          db.exec('COMMIT');
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        }
      }
      if (version() === 2) {
        db.exec('BEGIN IMMEDIATE');
        try {
          if (version() === 2)
            db.exec(`ALTER TABLE profiles ADD COLUMN created_at TEXT;
              ALTER TABLE profiles ADD COLUMN updated_at TEXT;
              CREATE TABLE deleted_profiles (user_id TEXT PRIMARY KEY, deleted_at TEXT NOT NULL) STRICT;
              PRAGMA user_version = 3;`);
          db.exec('COMMIT');
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        }
      }
      if (version() === 3) {
        db.exec('BEGIN IMMEDIATE');
        try {
          if (version() === 3) {
            db.exec(`ALTER TABLE gifts ADD COLUMN description TEXT;
              ALTER TABLE gifts ADD COLUMN icon TEXT;
              ALTER TABLE goals ADD COLUMN date TEXT;
              ALTER TABLE goals ADD COLUMN date_present INTEGER NOT NULL DEFAULT 0 CHECK (date_present IN (0, 1));
              ALTER TABLE goals ADD COLUMN reminder_time TEXT;
              ALTER TABLE goals ADD COLUMN reminder_present INTEGER NOT NULL DEFAULT 0 CHECK (reminder_present IN (0, 1));
              ALTER TABLE steps ADD COLUMN reminder_time TEXT;
              ALTER TABLE steps ADD COLUMN reminder_present INTEGER NOT NULL DEFAULT 0 CHECK (reminder_present IN (0, 1));`);
            for (const row of db.prepare('SELECT user_id, updated_at FROM profiles').all()) {
              const key = String(row.user_id);
              const contents = readRecord(db, 'profile', key)!;
              const migrated = migrationContents('profile', contents);
              if (migrated !== contents)
                writeRecord(
                  db,
                  'profile',
                  key,
                  migrated,
                  row.updated_at === null ? null : String(row.updated_at),
                );
            }
            db.exec(`PRAGMA user_version = ${schemaVersion}`);
          }
          db.exec('COMMIT');
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        }
      }
      if (version() === 4) {
        db.exec('BEGIN IMMEDIATE');
        try {
          if (version() === 4)
            db.exec(`ALTER TABLE gifts ADD COLUMN description TEXT;
              ALTER TABLE gifts ADD COLUMN icon TEXT;
              PRAGMA user_version = ${schemaVersion};`);
          db.exec('COMMIT');
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        }
      }
      if (db.prepare('PRAGMA quick_check').get()!.quick_check !== 'ok')
        throw new Error('SQLite integrity check failed');
      // Verify the schema before advertising a healthy server.
      for (const table of [
        'profiles',
        'profile_avatars',
        'habits',
        'habit_schedules',
        'schedule_weekdays',
        'goals',
        'steps',
        'gifts',
        'completions',
        'operations',
        'deleted_profiles',
        'push_state',
        'push_bindings',
        'push_dispatches',
        'migration_files',
      ])
        db.prepare(`SELECT * FROM ${table} LIMIT 0`).all();
      if (db.prepare('PRAGMA foreign_key_check').get())
        throw new Error('SQLite foreign key integrity check failed');
      await this.archiveLegacyFiles(db);
      this.connection = db;
      return db;
    } catch (error) {
      db.close();
      throw error;
    }
  }
  private async legacyRecords() {
    const records: { name: string; kind: RecordKind; key: string; contents: string }[] = [];
    for (const name of (await readdir(this.directory)).sort()) {
      const isPush = name === 'push-state.json';
      const key = name.slice(0, -5);
      if (!isPush && !(name.endsWith('.json') && localUserIdSchema.safeParse(key).success))
        continue;
      try {
        const path = join(this.directory, name);
        if (!(await lstat(path)).isFile()) throw new Error('Expected a regular legacy file');
        const contents = await readFile(path, 'utf8');
        const value: unknown = JSON.parse(contents);
        if (isPush) stateSchema.parse(value);
        else if (userDocumentSchema.parse(value).userId !== key)
          throw new Error('Profile ID does not match filename');
        // Preserve the original bytes for archiving and quota accounting.
        // New-write limits must never prevent an upgrade.
        records.push({ name, kind: isPush ? 'push' : 'profile', key: isPush ? '' : key, contents });
      } catch (cause) {
        throw new Error(`Cannot migrate ${name}; original file preserved. Repair it and restart.`, {
          cause,
        });
      }
    }
    return records;
  }
  private async archiveLegacyFiles(db: DatabaseSync) {
    const pending = db.prepare('SELECT name, sha256 FROM migration_files ORDER BY name').all();
    if (!pending.length) return;
    const backup = join(this.directory, migrationBackupDirectory);
    try {
      await mkdir(backup, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    if (!(await lstat(backup)).isDirectory())
      throw new Error('migration-backup must be a directory, not a symlink or file');
    await chmod(backup, 0o700);
    const digest = async (path: string): Promise<string | undefined> => {
      const entry = await lstat(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
        return undefined;
      });
      if (!entry) return undefined;
      if (!entry.isFile()) throw new Error('Migration backup files must be regular files');
      return createHash('sha256')
        .update(await readFile(path))
        .digest('hex');
    };
    const syncDirectory = async (path: string) => {
      const directory = await open(path, 'r');
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    };
    for (const record of pending) {
      const name = String(record.name);
      if (!(
        name === 'push-state.json' ||
        (name.endsWith('.json') && localUserIdSchema.safeParse(name.slice(0, -5)).success)
      ))
        throw new Error('Invalid migration backup filename');
      const source = join(this.directory, name);
      const target = join(backup, name);
      try {
        const sourceDigest = await digest(source);
        const targetDigest = await digest(target);
        if (sourceDigest !== undefined && sourceDigest !== record.sha256)
          throw new Error('Original JSON changed after import');
        if (targetDigest !== undefined && targetDigest !== record.sha256)
          throw new Error('Backup destination already contains different data');
        if (sourceDigest === undefined && targetDigest === undefined)
          throw new Error('Original JSON and its backup are both missing');
        if (sourceDigest !== undefined) {
          await chmod(source, 0o600);
          // An exclusive hard link followed by unlink moves the original bytes
          // without overwriting an existing backup. Sync the backup first so a
          // crash can never remove the only durable copy of the JSON file.
          if (targetDigest === undefined) await link(source, target);
        }
        const archived = await open(target, constants.O_RDWR | constants.O_NOFOLLOW);
        try {
          await archived.chmod(0o600);
          await archived.sync();
        } finally {
          await archived.close();
        }
        await syncDirectory(backup);
        if (sourceDigest !== undefined) {
          await unlink(source);
          await syncDirectory(this.directory);
        }
        // The durable queue lets a restart finish a partially completed move
        // without importing old JSON over newer SQLite state.
        db.prepare('DELETE FROM migration_files WHERE name = ?').run(name);
      } catch (cause) {
        throw new Error(
          `Cannot archive ${name} into migration-backup; SQLite import is saved. Resolve the backup problem and restart.`,
          { cause },
        );
      }
    }
  }
  async read(kind: RecordKind, key: string): Promise<string | undefined> {
    const db = await this.ready();
    db.exec('BEGIN');
    try {
      const contents = readRecord(db, kind, key);
      db.exec('COMMIT');
      return contents;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  async deleted(userId: string): Promise<boolean> {
    const db = await this.ready();
    return !!db.prepare('SELECT 1 FROM deleted_profiles WHERE user_id = ?').get(userId);
  }

  async close() {
    if (this.initialization) await this.initialization.catch(() => {});
    this.connection?.close();
    this.connection = undefined;
    this.closed = true;
  }
}

function migrationContents(kind: RecordKind, contents: string): string {
  if (kind !== 'profile') return contents;
  const doc = userDocumentSchema.parse(JSON.parse(contents));
  if (!pruneUnusedArchivedItems(doc)) return contents;
  doc.revision++;
  return JSON.stringify(doc);
}
