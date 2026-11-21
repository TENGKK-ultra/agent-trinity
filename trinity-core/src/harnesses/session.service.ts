import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { appError } from '../types/index.ts';
import {
  appendChange,
  agentActor,
  SYSTEM_ACTOR,
  type ChangeActor,
} from '../changes/change-log.service.ts';
import { withTransaction } from '../database/transaction.ts';
import { HARNESS_TYPES, type HarnessSessionStatus, type HarnessType } from './types.ts';

export interface HarnessSessionRow {
  id: string;
  harness_type: string;
  native_session_id: string;
  project_id: string | null;
  conversation_id: string | null;
  source: string | null;
  last_read_at: string | null;
  last_summary_version: number | null;
  created_at: string;
  updated_at: string;
  status: string;
  last_seen_at: string | null;
  cwd: string | null;
  model: string | null;
  active: number;
  /** 1 when this agent takes part in the conversation; independent of active. */
  participating: number;
  /** Non-null means this session may not run again until a human clears it. */
  quarantine_reason: string | null;
  quarantined_at: string | null;
  quarantine_pid: number | null;
  /** Null keeps the harness default (every tool asks). */
  permission_mode: string | null;
}

export const PERMISSION_MODES = [
  'manual',
  'acceptEdits',
  'plan',
  'bypassPermissions',
] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

export interface HarnessLockRow {
  id: string;
  harness_session_id: string;
  owner_task_id: string;
  acquired_at: string;
  expires_at: string | null;
  status: string;
}

const DEFAULT_LOCK_TTL_MS = 30 * 60 * 1000;

export function findSession(
  db: DatabaseSync,
  conversationId: string,
  harnessType: HarnessType,
): HarnessSessionRow | undefined {
  return db
    .prepare(
      `SELECT * FROM harness_sessions
       WHERE conversation_id = ? AND harness_type = ?
       ORDER BY created_at DESC
       LIMIT 1`,
    )
    .get(conversationId, harnessType) as HarnessSessionRow | undefined;
}

export function findActiveSession(
  db: DatabaseSync,
  conversationId: string,
): HarnessSessionRow | undefined {
  return db
    .prepare('SELECT * FROM harness_sessions WHERE conversation_id = ? AND active = 1')
    .get(conversationId) as HarnessSessionRow | undefined;
}

export function listBindings(db: DatabaseSync, conversationId: string): HarnessSessionRow[] {
  return db
    .prepare('SELECT * FROM harness_sessions WHERE conversation_id = ? ORDER BY harness_type')
    .all(conversationId) as unknown as HarnessSessionRow[];
}

export interface AgentDirectoryEntry {
  agent: HarnessType;
  bound_conversations: number;
  participating_conversations: number;
  active_conversations: number;
  running_conversations: number;
  quarantined_conversations: number;
  last_seen_at: string | null;
  cwd: string | null;
  model: string | null;
}

/**
 * Read-only view of who is reachable. Every harness appears even with no
 * binding: "not bound anywhere" is a fact the UI must be able to show.
 */
export function listDirectory(db: DatabaseSync): AgentDirectoryEntry[] {
  const counts = db
    .prepare(
      `SELECT harness_type,
              COUNT(*) AS bound,
              SUM(CASE WHEN participating = 1 THEN 1 ELSE 0 END) AS participating,
              SUM(CASE WHEN active = 1 THEN 1 ELSE 0 END) AS active,
              SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running,
              SUM(CASE WHEN quarantine_reason IS NOT NULL THEN 1 ELSE 0 END) AS quarantined,
              MAX(COALESCE(last_seen_at, updated_at)) AS last_seen_at
         FROM harness_sessions
        GROUP BY harness_type`,
    )
    .all() as Array<{
    harness_type: string;
    bound: number;
    participating: number | null;
    active: number | null;
    running: number | null;
    quarantined: number | null;
    last_seen_at: string | null;
  }>;

  const byAgent = new Map(counts.map((row) => [row.harness_type, row]));

  return HARNESS_TYPES.map((agent) => {
    const row = byAgent.get(agent);
    const latest = db
      .prepare(
        `SELECT cwd, model FROM harness_sessions
          WHERE harness_type = ?
          ORDER BY updated_at DESC, rowid DESC
          LIMIT 1`,
      )
      .get(agent) as { cwd: string | null; model: string | null } | undefined;

    return {
      agent,
      bound_conversations: Number(row?.bound ?? 0),
      participating_conversations: Number(row?.participating ?? 0),
      active_conversations: Number(row?.active ?? 0),
      running_conversations: Number(row?.running ?? 0),
      quarantined_conversations: Number(row?.quarantined ?? 0),
      last_seen_at: row?.last_seen_at ?? null,
      cwd: latest?.cwd ?? null,
      model: latest?.model ?? null,
    };
  });
}

export function ensureSession(
  db: DatabaseSync,
  conversationId: string,
  options: { harnessType: HarnessType; cwd: string | null; model: string | null },
): HarnessSessionRow {
  const existing = findSession(db, conversationId, options.harnessType);
  if (existing) return existing;

  const now = new Date().toISOString();
  const row: HarnessSessionRow = {
    id: randomUUID(),
    harness_type: options.harnessType,
    native_session_id: '',
    project_id: null,
    conversation_id: conversationId,
    source: 'trinity',
    last_read_at: null,
    last_summary_version: null,
    created_at: now,
    updated_at: now,
    status: 'idle',
    last_seen_at: null,
    cwd: options.cwd,
    model: options.model,
    active: 0,
    participating: 1,
    quarantine_reason: null,
    quarantined_at: null,
    quarantine_pid: null,
    permission_mode: null,
  };

  withTransaction(db, () => {
    db.prepare(
      `INSERT INTO harness_sessions
         (id, harness_type, native_session_id, project_id, conversation_id, source,
          last_read_at, last_summary_version, created_at, updated_at, status, last_seen_at,
          cwd, model, participating)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
    row.id,
    row.harness_type,
    row.native_session_id,
    row.project_id,
    row.conversation_id,
    row.source,
    row.last_read_at,
    row.last_summary_version,
    row.created_at,
    row.updated_at,
    row.status,
    row.last_seen_at,
      row.cwd,
      row.model,
      row.participating,
    );

    appendChange(db, {
      entityType: 'harness_session',
      entityId: row.id,
      operation: 'insert',
      actor: agentActor(options.harnessType),
      conversationId: conversationId,
      payload: { agent: row.harness_type, status: row.status, active: false },
    });
  });

  return row;
}

/**
 * Makes one harness the active one for a conversation. The other harnesses keep
 * their rows (and their native session ids) untouched, so switching back later
 * resumes the original provider session.
 *
 * Deactivation and activation happen in one transaction: a conversation can
 * never end up with two active agents, nor with none because of a failure.
 */
export function activateBinding(
  db: DatabaseSync,
  conversationId: string,
  options: {
    harnessType: HarnessType;
    cwd: string | null;
    model: string | null;
    /** false joins without taking the "current" slot from another agent. */
    makeActive?: boolean;
  },
  actor: ChangeActor = SYSTEM_ACTOR,
): { session: HarnessSessionRow; created: boolean } {
  const existing = findSession(db, conversationId, options.harnessType);
  const now = new Date().toISOString();
  const makeActive = options.makeActive ?? true;

  return withTransaction(db, () => {
    const session = ensureSession(db, conversationId, options);

    if (existing && options.cwd) setCwd(db, session.id, options.cwd);

    if (makeActive) {
      db.prepare(
        'UPDATE harness_sessions SET active = 0 WHERE conversation_id = ? AND id <> ?',
      ).run(conversationId, session.id);

      db.prepare(
        'UPDATE harness_sessions SET active = 1, participating = 1, updated_at = ? WHERE id = ?',
      ).run(now, session.id);
    } else {
      // Joining keeps the current agent; if nobody holds it, this one takes it.
      const otherActive =
        db
          .prepare(
            'SELECT 1 AS ok FROM harness_sessions WHERE conversation_id = ? AND active = 1 AND id <> ?',
          )
          .get(conversationId, session.id) !== undefined;

      db.prepare(
        'UPDATE harness_sessions SET participating = 1, active = ?, updated_at = ? WHERE id = ?',
      ).run(otherActive ? 0 : 1, now, session.id);
    }

    const updated = findSession(db, conversationId, options.harnessType) as HarnessSessionRow;

    appendChange(db, {
      entityType: 'harness_session',
      entityId: session.id,
      operation: 'update',
      actor,
      conversationId,
      payload: {
        agent: options.harnessType,
        active: updated.active === 1,
        participating: true,
      },
    });

    return {
      session: { ...updated, cwd: options.cwd ?? updated.cwd },
      created: !existing,
    };
  });
}

/**
 * Turns one agent's participation on or off without deleting its binding. When
 * the current agent leaves, the current slot moves to another participant; when
 * the last participant leaves, the conversation has no current agent — but never
 * an active one that is not bound.
 */
export function setParticipating(
  db: DatabaseSync,
  conversationId: string,
  harnessType: HarnessType,
  participating: boolean,
  actor: ChangeActor = SYSTEM_ACTOR,
): HarnessSessionRow {
  const session = findSession(db, conversationId, harnessType);

  if (!session) {
    throw appError('agent_not_bound', `${harnessType} is not bound to this conversation`, 404);
  }

  const now = new Date().toISOString();

  return withTransaction(db, () => {
    db.prepare(
      'UPDATE harness_sessions SET participating = ?, updated_at = ? WHERE id = ?',
    ).run(participating ? 1 : 0, now, session.id);

    if (!participating && session.active === 1) {
      db.prepare('UPDATE harness_sessions SET active = 0 WHERE id = ?').run(session.id);

      const next = db
        .prepare(
          `SELECT id FROM harness_sessions
            WHERE conversation_id = ? AND participating = 1 AND id <> ?
            ORDER BY created_at, rowid LIMIT 1`,
        )
        .get(conversationId, session.id) as { id: string } | undefined;

      if (next) {
        db.prepare('UPDATE harness_sessions SET active = 1, updated_at = ? WHERE id = ?').run(
          now,
          next.id,
        );
      }
    } else if (participating && !findActiveSession(db, conversationId)) {
      db.prepare('UPDATE harness_sessions SET active = 1, updated_at = ? WHERE id = ?').run(
        now,
        session.id,
      );
    }

    const updated = findSession(db, conversationId, harnessType) as HarnessSessionRow;

    appendChange(db, {
      entityType: 'harness_session',
      entityId: session.id,
      operation: 'update',
      actor,
      conversationId,
      payload: {
        agent: harnessType,
        participating: updated.participating === 1,
        active: updated.active === 1,
      },
    });

    return updated;
  });
}

/**
 * Removes one harness binding. Other harnesses are untouched, and nothing on
 * disk is deleted — the provider keeps its own session files.
 *
 * If the removed binding held the current slot, it moves to a remaining binding
 * (a participant first). The conversation is never left with an active agent
 * that has no row, and deleting the last binding simply leaves none.
 */
export function removeBinding(
  db: DatabaseSync,
  conversationId: string,
  harnessType: HarnessType,
  actor: ChangeActor = SYSTEM_ACTOR,
): { removed: boolean; wasActive: boolean; promoted: string | null } {
  const session = findSession(db, conversationId, harnessType);
  if (!session) return { removed: false, wasActive: false, promoted: null };

  let promoted: string | null = null;

  withTransaction(db, () => {
    db.prepare('DELETE FROM harness_sessions WHERE id = ?').run(session.id);

    if (session.active === 1) {
      const next = db
        .prepare(
          `SELECT id, harness_type FROM harness_sessions
            WHERE conversation_id = ?
            ORDER BY participating DESC, created_at, rowid LIMIT 1`,
        )
        .get(conversationId) as { id: string; harness_type: string } | undefined;

      if (next) {
        db.prepare('UPDATE harness_sessions SET active = 1 WHERE id = ?').run(next.id);
        promoted = next.harness_type;
      }
    }

    appendChange(db, {
      entityType: 'harness_session',
      entityId: session.id,
      operation: 'delete',
      actor,
      conversationId,
      payload: { agent: harnessType },
    });
  });

  return { removed: true, wasActive: session.active === 1, promoted };
}

function sessionMeta(
  db: DatabaseSync,
  sessionId: string,
): { harness_type: string; conversation_id: string | null } | undefined {
  return db
    .prepare('SELECT harness_type, conversation_id FROM harness_sessions WHERE id = ?')
    .get(sessionId) as { harness_type: string; conversation_id: string | null } | undefined;
}

export function setStatus(
  db: DatabaseSync,
  sessionId: string,
  status: HarnessSessionStatus,
  actor: ChangeActor = SYSTEM_ACTOR,
): void {
  const now = new Date().toISOString();
  const meta = sessionMeta(db, sessionId);

  withTransaction(db, () => {
    db.prepare(
      `UPDATE harness_sessions SET status = ?, last_seen_at = ?, updated_at = ? WHERE id = ?`,
    ).run(status, now, now, sessionId);

    appendChange(db, {
      entityType: 'harness_session',
      entityId: sessionId,
      operation: 'update',
      actor,
      conversationId: meta?.conversation_id ?? null,
      payload: { agent: meta?.harness_type ?? null, status },
    });
  });
}

export function setNativeSessionId(
  db: DatabaseSync,
  sessionId: string,
  nativeSessionId: string,
  actor: ChangeActor = SYSTEM_ACTOR,
): void {
  if (nativeSessionId === '') return;

  const meta = sessionMeta(db, sessionId);

  withTransaction(db, () => {
    db.prepare(
      `UPDATE harness_sessions SET native_session_id = ?, updated_at = ? WHERE id = ?`,
    ).run(nativeSessionId, new Date().toISOString(), sessionId);

    appendChange(db, {
      entityType: 'harness_session',
      entityId: sessionId,
      operation: 'update',
      actor,
      conversationId: meta?.conversation_id ?? null,
      payload: { agent: meta?.harness_type ?? null, native_session_id: nativeSessionId },
    });
  });
}

/** Applies to every binding in the conversation, so switching agents keeps it. */
export function setConversationPermissionMode(
  db: DatabaseSync,
  conversationId: string,
  mode: PermissionMode | null,
  actor: ChangeActor = SYSTEM_ACTOR,
): void {
  withTransaction(db, () => {
    db.prepare(
      'UPDATE harness_sessions SET permission_mode = ?, updated_at = ? WHERE conversation_id = ?',
    ).run(mode, new Date().toISOString(), conversationId);

    appendChange(db, {
      entityType: 'conversation',
      entityId: conversationId,
      operation: 'update',
      actor,
      conversationId,
      payload: { permission_mode: mode },
    });
  });
}

export function setCwd(
  db: DatabaseSync,
  sessionId: string,
  cwd: string,
  actor: ChangeActor = SYSTEM_ACTOR,
): void {
  const meta = sessionMeta(db, sessionId);

  withTransaction(db, () => {
    db.prepare(`UPDATE harness_sessions SET cwd = ?, updated_at = ? WHERE id = ?`).run(
      cwd,
      new Date().toISOString(),
      sessionId,
    );

    appendChange(db, {
      entityType: 'harness_session',
      entityId: sessionId,
      operation: 'update',
      actor,
      conversationId: meta?.conversation_id ?? null,
      payload: { agent: meta?.harness_type ?? null, cwd },
    });
  });
}

export function quarantineSession(
  db: DatabaseSync,
  sessionId: string,
  reason: string,
  pid: number | null,
  actor: ChangeActor = SYSTEM_ACTOR,
): void {
  const meta = sessionMeta(db, sessionId);
  const now = new Date().toISOString();

  withTransaction(db, () => {
    db.prepare(
      `UPDATE harness_sessions
          SET quarantine_reason = ?, quarantined_at = ?, quarantine_pid = ?, updated_at = ?
        WHERE id = ?`,
    ).run(reason, now, pid, now, sessionId);

    appendChange(db, {
      entityType: 'harness_session',
      entityId: sessionId,
      operation: 'update',
      actor,
      conversationId: meta?.conversation_id ?? null,
      payload: { agent: meta?.harness_type ?? null, quarantined: reason, pid },
    });
  });
}

/**
 * The only way out of quarantine that keeps the binding. Callers must have
 * confirmed the process is gone; this function cannot check that for them.
 */
export function clearQuarantine(
  db: DatabaseSync,
  sessionId: string,
  input: { reason: string; actor: ChangeActor },
): boolean {
  const meta = sessionMeta(db, sessionId);

  return withTransaction(db, () => {
    const result = db
      .prepare(
        `UPDATE harness_sessions
            SET quarantine_reason = NULL, quarantined_at = NULL, quarantine_pid = NULL,
                updated_at = ?
          WHERE id = ? AND quarantine_reason IS NOT NULL`,
      )
      .run(new Date().toISOString(), sessionId);

    if (Number(result.changes) === 0) return false;

    appendChange(db, {
      entityType: 'harness_session',
      entityId: sessionId,
      operation: 'update',
      actor: input.actor,
      conversationId: meta?.conversation_id ?? null,
      payload: { agent: meta?.harness_type ?? null, quarantine_cleared: input.reason },
    });

    return true;
  });
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Error && /UNIQUE constraint failed/i.test(err.message);
}

/**
 * `owner_task_id` predates any task system and is deliberately left unchanged.
 * Trinity has no tasks table yet, so the column carries the *execution run* id
 * (a UUID minted per turn). It must not be read as a task reference.
 */
export function acquireRunLock(
  db: DatabaseSync,
  sessionId: string,
  runId: string,
  now: Date = new Date(),
  ttlMs: number = DEFAULT_LOCK_TTL_MS,
): HarnessLockRow {
  const nowIso = now.toISOString();
  const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
  const lock: HarnessLockRow = {
    id: randomUUID(),
    harness_session_id: sessionId,
    owner_task_id: runId,
    acquired_at: nowIso,
    expires_at: expiresAt,
    status: 'held',
  };

  db.exec('BEGIN IMMEDIATE');
  try {
    // Quarantine outranks everything, including lock expiry: a process we could
    // not confirm dead must never share this session with a new run.
    const guarded = db
      .prepare('SELECT quarantine_reason FROM harness_sessions WHERE id = ?')
      .get(sessionId) as { quarantine_reason: string | null } | undefined;

    if (guarded?.quarantine_reason) {
      throw appError(
        'session_quarantined',
        `This session is quarantined (${guarded.quarantine_reason}); it must be cleared explicitly`,
        409,
      );
    }

    db.prepare(
      `UPDATE harness_session_locks
       SET status = 'expired'
       WHERE harness_session_id = ? AND status = 'held'
         AND expires_at IS NOT NULL AND expires_at < ?`,
    ).run(sessionId, nowIso);

    db.prepare(
      `INSERT INTO harness_session_locks
         (id, harness_session_id, owner_task_id, acquired_at, expires_at, status)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(lock.id, lock.harness_session_id, lock.owner_task_id, lock.acquired_at, lock.expires_at, lock.status);

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');

    if (isUniqueViolation(err)) {
      throw appError('turn_in_progress', 'This agent session already has a running turn', 409);
    }

    throw err;
  }

  return lock;
}

export function releaseRunLock(db: DatabaseSync, lockId: string): void {
  db.prepare(
    `UPDATE harness_session_locks SET status = 'released' WHERE id = ? AND status = 'held'`,
  ).run(lockId);
}

export function findHeldLock(db: DatabaseSync, sessionId: string): HarnessLockRow | undefined {
  return db
    .prepare(
      `SELECT * FROM harness_session_locks WHERE harness_session_id = ? AND status = 'held'`,
    )
    .get(sessionId) as HarnessLockRow | undefined;
}
