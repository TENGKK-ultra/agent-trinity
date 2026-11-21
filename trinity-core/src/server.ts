import { createServer, type Server } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { route } from './api/router.ts';
import { DEFAULT_DB_PATH, openDatabase } from './database/connection.ts';
import { killAllActiveProcesses } from './harnesses/runner.ts';
import { sweepPendingOnStartup } from './harnesses/approval.service.ts';
import { sweepTasksOnStartup } from './harnesses/task.service.ts';
import { defaultRuntime, type CoreRuntime } from './harnesses/runtime.ts';
import { assertBindHostAllowed } from './startup/bind-guard.ts';
import { assertTestInstanceIsolated } from './startup/test-guard.ts';
import { expireLeases } from './board/board.service.ts';

export function createApp(db: DatabaseSync, runtime: CoreRuntime = defaultRuntime): Server {
  // The agent's MCP server calls back to this instance. The address comes from
  // the socket, never from the Host header: a caller must not be able to point
  // a delegation token at a host of their choosing.
  const server = createServer((req, res) => {
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : null;

    void route(db, req, res, runtime, port === null ? undefined : `http://127.0.0.1:${port}`);
  });

  return server;
}

export interface StartOptions {
  dbPath?: string;
  port?: number;
  host?: string;
}

export interface RunningServer {
  server: Server;
  db: DatabaseSync;
}

export function startServer(options: StartOptions = {}): RunningServer {
  const dbPath = options.dbPath ?? process.env.TRINITY_DB_PATH ?? DEFAULT_DB_PATH;
  const port = options.port ?? Number(process.env.TRINITY_PORT ?? 3210);
  const host = options.host ?? process.env.TRINITY_HOST ?? '127.0.0.1';
  const envLabel = process.env.TRINITY_ENV?.trim() || 'prod';

  // Both checks run before the database is opened, so a refused start leaves
  // no files and no locks behind.
  assertBindHostAllowed(host);
  assertTestInstanceIsolated({ env: envLabel, dbPath, port, defaultDbPath: DEFAULT_DB_PATH });

  const db = openDatabase(dbPath);

  // A lease is a deadline, not a lock: a claim that was not renewed before the
  // process stopped must not keep a card held forever.
  const expiredClaims = expireLeases(db);

  if (expiredClaims > 0) {
    console.log(`[trinity-core] released ${expiredClaims} expired board claim(s)`);
  }

  const leaseSweep = setInterval(() => {
    try {
      expireLeases(db);
    } catch {
      console.warn('[trinity-core] board lease sweep failed');
    }
  }, 60_000);

  leaseSweep.unref();

  // The bot asks its console to switch voice/image on and off by writing a file.
  // A test instance must not answer those calls: two instances would race.

  // Every child process died with the previous instance, so nothing can still
  // answer a request that was pending when it stopped.
  sweepPendingOnStartup(db);

  // Restores the task ledger only. Surviving child processes are a separate
  // problem this sweep does not claim to solve.
  sweepTasksOnStartup(db);

  const server = createApp(db);

  server.on('close', () => {
    clearInterval(leaseSweep);
  });

  server.listen(port, host, () => {
    // The environment and database are part of the line on purpose: a test
    // instance and the production instance must be distinguishable at a glance.
    console.log(
      `[trinity-core] listening on http://${host}:${port} (env=${envLabel}, db=${dbPath})`,
    );
  });

  const shutdown = (): void => {
    // Agent processes are children of this process; leaving them running after
    // Core exits would strand a CLI that no one can reach or stop.
    killAllActiveProcesses();

    server.close(() => {
      db.close();
      process.exit(0);
    });
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('exit', killAllActiveProcesses);

  return { server, db };
}
