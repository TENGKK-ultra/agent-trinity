import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../src/database/connection.ts';
import { createApp } from '../src/server.ts';
import type { CoreRuntime } from '../src/harnesses/runtime.ts';

// The title call is a background child process; in tests it would still hold
// the fixture's temp directory when cleanup runs.
process.env.TRINITY_DISABLE_AUTO_TITLE = '1';

export interface TempDatabase {
  readonly db: DatabaseSync;
  readonly path: string;
  readonly dir: string;
  close(): void;
  reopen(): DatabaseSync;
  cleanup(): void;
}

export function createTempDatabase(): TempDatabase {
  const dir = mkdtempSync(join(tmpdir(), 'trinity-core-test-'));
  const dbPath = join(dir, 'trinity.db');
  let db = openDatabase(dbPath);

  return {
    get db(): DatabaseSync {
      return db;
    },
    path: dbPath,
    dir,
    close(): void {
      db.close();
    },
    reopen(): DatabaseSync {
      db = openDatabase(dbPath);
      return db;
    },
    cleanup(): void {
      try {
        db.close();
      } catch {
        // already closed
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export interface TestServer {
  readonly baseUrl: string;
  close(): Promise<void>;
}

export async function startTestServer(
  db: DatabaseSync,
  runtime?: CoreRuntime,
): Promise<TestServer> {
  const server: Server = createApp(db, runtime);

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    async close(): Promise<void> {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
