import { statfs } from 'node:fs/promises';
import { DomainError } from '@machbar/shared';
import { SqliteDatabase, type RecordKind } from './database.js';
import { readRecord, recordBytes, writeRecord } from './database-records.js';

export const storageDefaults = {
  maxProfiles: 100,
  maxStorageBytes: 256 * 1024 * 1024,
  storageReserveBytes: 64 * 1024 * 1024,
};
export type StorageLimits = typeof storageDefaults;

// Account for logical UTF-8 payload bytes, excluding SQLite overhead and legacy
// recovery snapshots. Quota checks and writes share one database transaction.
export class StorageBudget {
  readonly database: SqliteDatabase;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(
    private directory: string,
    private limits: StorageLimits = storageDefaults,
  ) {
    this.database = new SqliteDatabase(directory);
  }
  async commit(
    kind: RecordKind,
    key: string,
    contents: string,
    validate?: (previous: string | undefined) => void,
  ): Promise<void> {
    const next = this.queue
      .catch(() => {})
      .then(async () => {
        const db = await this.database.ready();
        const bytes = Buffer.byteLength(contents);
        const disk = await statfs(this.directory, { bigint: true });
        db.exec('BEGIN IMMEDIATE');
        try {
          const previous = readRecord(db, kind, key);
          if (
            kind === 'profile' &&
            previous === undefined &&
            db.prepare('SELECT 1 FROM deleted_profiles WHERE user_id = ?').get(key)
          )
            throw new DomainError('PROFILE_DELETED', 410);
          validate?.(previous);
          const size = recordBytes(db, kind, key);
          // A shrinking document still journals the larger previous payload.
          // Reserve room for both journal pages and the replacement payload.
          if (
            disk.bavail * disk.bsize <
            BigInt(this.limits.storageReserveBytes) +
              BigInt(bytes + Math.max(bytes, size) + 64 * 1024)
          )
            throw new DomainError('STORAGE_LIMIT', 507);
          const used = Number(
            db
              .prepare(
                `SELECT (SELECT COALESCE(SUM(logical_bytes), 0) FROM profiles) +
                  (SELECT COALESCE(SUM(logical_bytes), 0) FROM push_state) AS bytes`,
              )
              .get()!.bytes,
          );
          const profiles = Number(
            db.prepare('SELECT COUNT(*) AS count FROM profiles').get()!.count,
          );
          if (kind === 'profile' && previous === undefined && profiles >= this.limits.maxProfiles)
            throw new DomainError('PROFILE_LIMIT', 507);
          if (used - size + bytes > this.limits.maxStorageBytes && bytes > size)
            throw new DomainError('STORAGE_LIMIT', 507);
          writeRecord(db, kind, key, contents);
          db.exec('COMMIT');
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        }
      });
    this.queue = next;
    return next;
  }
  // Deletes a profile in the write queue, so it cannot interleave with a commit.
  // The tombstone commits with the deletion and blocks recreating the profile.
  async removeProfile(userId: string): Promise<boolean> {
    const next = this.queue
      .catch(() => {})
      .then(async () => {
        const db = await this.database.ready();
        db.exec('BEGIN IMMEDIATE');
        try {
          // Remove referring rows before their targets, as profile writes do.
          for (const table of ['completions', 'gifts', 'operations', 'habits', 'goals'])
            db.prepare(`DELETE FROM ${table} WHERE user_id = ?`).run(userId);
          const { changes } = db.prepare('DELETE FROM profiles WHERE user_id = ?').run(userId);
          if (changes > 0)
            db.prepare(
              'INSERT OR IGNORE INTO deleted_profiles (user_id, deleted_at) VALUES (?, ?)',
            ).run(userId, new Date().toISOString());
          db.exec('COMMIT');
          return changes > 0;
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        }
      });
    this.queue = next;
    return next;
  }
  async close() {
    await this.queue.catch(() => {});
    await this.database.close();
  }
}
