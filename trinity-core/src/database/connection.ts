import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { runMigrations } from './migrations/index.ts';

export const DEFAULT_DB_PATH = resolve(import.meta.dirname, '..', '..', 'data', 'trinity.db');

export function openDatabase(dbPath: string = DEFAULT_DB_PATH): DatabaseSync {
  const isMemory = dbPath === ':memory:';

  if (!isMemory) {
    mkdirSync(dirname(dbPath), { recursive: true });
  }

  const db = new DatabaseSync(dbPath);

  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');

  if (!isMemory) {
    db.exec('PRAGMA journal_mode = WAL');
  }

  runMigrations(db);

  return db;
}

export function closeDatabase(db: DatabaseSync): void {
  db.close();
}
