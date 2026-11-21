import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  appendChange,
  agentActor,
  SYSTEM_ACTOR,
  type ChangeActor,
} from '../changes/change-log.service.ts';
import { withTransaction } from '../database/transaction.ts';
import type { HarnessApprovalKind } from './types.ts';

export const APPROVAL_STATUSES = [
  'pending',
  'approved',
  'denied',
  'expired',
  'cancelled',
] as const;

export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

export type ApprovalDeliveryStatus = 'pending' | 'delivered' | 'failed';

export interface ApprovalRow {
  id: string;
  conversation_id: string;
  harness_session_id: string;
  turn_id: string;
  agent: string;
  kind: HarnessApprovalKind;
  native_request_id: string;
  tool_use_id: string | null;
  tool_name: string | null;
  payload_json: string;
  status: ApprovalStatus;
  delivery_status: ApprovalDeliveryStatus;
  decision_json: string | null;
  created_at: string;
  decided_at: string | null;
  expires_at: string | null;
}

export interface CreateApprovalInput {
  conversationId: string;
  harnessSessionId: string;
  turnId: string;
  agent: string;
  kind: HarnessApprovalKind;
  nativeRequestId: string;
  toolUseId: string | null;
  toolName: string | null;
  /** What the card shows to decide: tool name, command, question options. */
  payload: Record<string, unknown>;
  expiresAt: string | null;
}

export function findApproval(db: DatabaseSync, id: string): ApprovalRow | undefined {
  return db.prepare('SELECT * FROM approvals WHERE id = ?').get(id) as ApprovalRow | undefined;
}

function findByNativeId(
  db: DatabaseSync,
  harnessSessionId: string,
  nativeRequestId: string,
): ApprovalRow | undefined {
  return db
    .prepare('SELECT * FROM approvals WHERE harness_session_id = ? AND native_request_id = ?')
    .get(harnessSessionId, nativeRequestId) as ApprovalRow | undefined;
}

/**
 * The provider may repeat a request; the unique index makes the second attempt
 * a read rather than a duplicate row (and a duplicate log entry).
 */
export function createApproval(
  db: DatabaseSync,
  input: CreateApprovalInput,
): { row: ApprovalRow; created: boolean } {
  return withTransaction(db, () => {
    const existing = findByNativeId(db, input.harnessSessionId, input.nativeRequestId);
    if (existing) return { row: existing, created: false };

    const row: ApprovalRow = {
      id: randomUUID(),
      conversation_id: input.conversationId,
      harness_session_id: input.harnessSessionId,
      turn_id: input.turnId,
      agent: input.agent,
      kind: input.kind,
      native_request_id: input.nativeRequestId,
      tool_use_id: input.toolUseId,
      tool_name: input.toolName,
      payload_json: JSON.stringify(input.payload),
      status: 'pending',
      delivery_status: 'pending',
      decision_json: null,
      created_at: new Date().toISOString(),
      decided_at: null,
      expires_at: input.expiresAt,
    };

    db.prepare(
      `INSERT INTO approvals
         (id, conversation_id, harness_session_id, turn_id, agent, kind,
          native_request_id, tool_use_id, tool_name, payload_json,
          status, delivery_status, decision_json, created_at, decided_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.id,
      row.conversation_id,
      row.harness_session_id,
      row.turn_id,
      row.agent,
      row.kind,
      row.native_request_id,
      row.tool_use_id,
      row.tool_name,
      row.payload_json,
      row.status,
      row.delivery_status,
      row.decision_json,
      row.created_at,
      row.decided_at,
      row.expires_at,
    );

    appendChange(db, {
      entityType: 'approval',
      entityId: row.id,
      operation: 'insert',
      actor: agentActor(row.agent),
      conversationId: row.conversation_id,
      payload: { agent: row.agent, kind: row.kind, status: row.status, tool_name: row.tool_name },
    });

    return { row, created: true };
  });
}

export function listApprovals(
  db: DatabaseSync,
  conversationId: string,
  status?: ApprovalStatus,
): ApprovalRow[] {
  if (status) {
    return db
      .prepare('SELECT * FROM approvals WHERE conversation_id = ? AND status = ? ORDER BY created_at ASC, rowid ASC')
      .all(conversationId, status) as unknown as ApprovalRow[];
  }

  return db
    .prepare('SELECT * FROM approvals WHERE conversation_id = ? ORDER BY created_at ASC, rowid ASC')
    .all(conversationId) as unknown as ApprovalRow[];
}

/**
 * Moves one request out of `pending`. Returns null when another writer already
 * settled it — the caller turns that into 409 rather than overwriting a
 * decision the user (or the timer) already made.
 */
function settle(
  db: DatabaseSync,
  id: string,
  status: ApprovalStatus,
  decision: Record<string, unknown> | null,
  actor: ChangeActor,
): ApprovalRow | null {
  return withTransaction(db, () => {
    const row = findApproval(db, id);
    if (!row || row.status !== 'pending') return null;

    const now = new Date().toISOString();
    const decisionJson = decision === null ? null : JSON.stringify(decision);

    db.prepare(
      `UPDATE approvals
         SET status = ?, decision_json = ?, decided_at = ?
       WHERE id = ? AND status = 'pending'`,
    ).run(status, decisionJson, now, id);

    appendChange(db, {
      entityType: 'approval',
      entityId: id,
      operation: 'update',
      actor,
      conversationId: row.conversation_id,
      payload: { agent: row.agent, kind: row.kind, status, tool_name: row.tool_name },
    });

    return { ...row, status, decision_json: decisionJson, decided_at: now };
  });
}

export function approveApproval(
  db: DatabaseSync,
  id: string,
  decision: Record<string, unknown>,
  actor: ChangeActor,
): ApprovalRow | null {
  return settle(db, id, 'approved', decision, actor);
}

export function denyApproval(
  db: DatabaseSync,
  id: string,
  decision: Record<string, unknown>,
  actor: ChangeActor,
): ApprovalRow | null {
  return settle(db, id, 'denied', decision, actor);
}

export function expireApproval(db: DatabaseSync, id: string): ApprovalRow | null {
  return settle(db, id, 'expired', { reason: 'timeout' }, SYSTEM_ACTOR);
}

/**
 * Not every settlement reaches the CLI. This records which ones did; it never
 * changes `status`, because the user's decision stands either way.
 */
export function setDeliveryStatus(
  db: DatabaseSync,
  id: string,
  delivery: ApprovalDeliveryStatus,
): void {
  db.prepare('UPDATE approvals SET delivery_status = ? WHERE id = ?').run(delivery, id);
}

/** A finished turn takes its unanswered requests with it. */
export function cancelPendingForTurn(
  db: DatabaseSync,
  turnId: string,
  reason: string,
): ApprovalRow[] {
  return withTransaction(db, () => {
    const rows = db
      .prepare("SELECT * FROM approvals WHERE turn_id = ? AND status = 'pending'")
      .all(turnId) as unknown as ApprovalRow[];

    const now = new Date().toISOString();

    for (const row of rows) {
      db.prepare(
        `UPDATE approvals SET status = 'cancelled', decision_json = ?, decided_at = ?
         WHERE id = ? AND status = 'pending'`,
      ).run(JSON.stringify({ reason }), now, row.id);

      appendChange(db, {
        entityType: 'approval',
        entityId: row.id,
        operation: 'update',
        actor: SYSTEM_ACTOR,
        conversationId: row.conversation_id,
        payload: { agent: row.agent, kind: row.kind, status: 'cancelled', reason },
      });
    }

    return rows.map((row) => ({
      ...row,
      status: 'cancelled' as ApprovalStatus,
      decision_json: JSON.stringify({ reason }),
      decided_at: now,
    }));
  });
}

/**
 * Core restarts kill every child process, so no pending request can still be
 * answered. Runs once at startup, before the server accepts traffic.
 */
export function sweepPendingOnStartup(db: DatabaseSync): number {
  const rows = db
    .prepare("SELECT id FROM approvals WHERE status = 'pending'")
    .all() as Array<{ id: string }>;

  for (const row of rows) {
    settle(db, row.id, 'cancelled', { reason: 'core_restart' }, SYSTEM_ACTOR);
  }

  return rows.length;
}
