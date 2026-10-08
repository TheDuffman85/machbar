import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { databaseFilename, type RecordKind } from '../src/database.js';
import { readRecord } from '../src/database-records.js';

export function storedRecord(directory: string, kind: RecordKind, key = ''): string | undefined {
  const db = new DatabaseSync(join(directory, databaseFilename), { readOnly: true });
  try {
    return readRecord(db, kind, key);
  } finally {
    db.close();
  }
}
export function executeDatabase(directory: string, sql: string) {
  const db = new DatabaseSync(join(directory, databaseFilename));
  try {
    db.exec('PRAGMA foreign_keys = ON');
    db.exec(sql);
  } finally {
    db.close();
  }
}
