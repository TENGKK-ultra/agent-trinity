import type { DatabaseSync } from 'node:sqlite';

// SQLite has no nested transactions and Core uses a single synchronous
// connection, so a depth counter is enough to let helpers join an outer
// transaction instead of opening a second one.
let depth = 0;

export function isInTransaction(): boolean {
  return depth > 0;
}

/**
 * Runs `fn` inside one transaction. Calls made while a transaction is already
 * open join it rather than starting a nested one, so a service can wrap a write
 * without knowing whether its caller already did.
 */
export function withTransaction<T>(db: DatabaseSync, fn: () => T): T {
  if (depth > 0) return fn();

  db.exec('BEGIN IMMEDIATE');
  depth = 1;

  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    depth = 0;
  }
}
