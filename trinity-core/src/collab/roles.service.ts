import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { withTransaction } from '../database/transaction.ts';
import { HARNESS_TYPES, type HarnessType } from '../harnesses/types.ts';
import { appError } from '../types/index.ts';
import { createRound, findRound, type RoundRow } from './messages.service.ts';

export type Role = 'coordinator' | 'contributor' | 'reviewer' | 'observer';
export type RoleAction = 'grant' | 'revoke' | 'handover';

export interface RoleRow {
  round_id: string;
  agent: string;
  role: Role;
  assigned_by: string;
  reason: string | null;
  assigned_at: string;
}

export interface RoleEventRow {
  id: string;
  round_id: string;
  agent: string;
  role: Role;
  action: RoleAction;
  successor: string | null;
  assigned_by: string;
  reason: string | null;
  created_at: string;
}

const ROLES: readonly Role[] = ['coordinator', 'contributor', 'reviewer', 'observer'];

function isHarness(value: string): value is HarnessType {
  return (HARNESS_TYPES as readonly string[]).includes(value);
}

function assertAgent(agent: string): asserts agent is HarnessType {
  if (!isHarness(agent)) {
    throw appError('invalid_agent', `Unknown agent: ${agent}`, 400);
  }
}

function assertRole(role: string): asserts role is Role {
  if (!(ROLES as readonly string[]).includes(role)) {
    throw appError('invalid_role', `Unknown role: ${role}`, 400);
  }
}

function requireReason(reason: string | undefined | null): string {
  const text = (reason ?? '').trim();

  if (text === '') {
    throw appError('invalid_reason', 'A role change must say why', 400);
  }

  return text;
}

function appendEvent(
  db: DatabaseSync,
  input: {
    roundId: string;
    agent: string;
    role: Role;
    action: RoleAction;
    successor?: string | null;
    assignedBy: string;
    reason: string;
  },
): void {
  db.prepare(
    `INSERT INTO role_events
       (id, round_id, agent, role, action, successor, assigned_by, reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    randomUUID(),
    input.roundId,
    input.agent,
    input.role,
    input.action,
    input.successor ?? null,
    input.assignedBy,
    input.reason,
    new Date().toISOString(),
  );
}

function putRole(
  db: DatabaseSync,
  roundId: string,
  agent: HarnessType,
  role: Role,
  assignedBy: string,
  reason: string,
): void {
  db.prepare(
    `INSERT INTO round_roles (round_id, agent, role, assigned_by, reason, assigned_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (round_id, agent) DO UPDATE SET
       role = excluded.role,
       assigned_by = excluded.assigned_by,
       reason = excluded.reason,
       assigned_at = excluded.assigned_at`,
  ).run(roundId, agent, role, assignedBy, reason, new Date().toISOString());
}

export interface InitRoundInput {
  conversationId: string;
  goal: string;
  coordinator: string;
  contributors?: string[];
  reviewRequired?: boolean;
  budgetHops?: number;
  budgetExec?: number;
  budgetUsageTokens?: number | null;
  /** The user requires at least this many distinct agents to take part. */
  minAssignments?: number;
  assignedBy?: string;
}

export interface InitRoundResult {
  round: RoundRow;
  roles: RoleRow[];
}

/**
 * Opens a round and grants the first roles in one transaction: a round without
 * a coordinator is a round nobody can explain later.
 */
export function initRound(db: DatabaseSync, input: InitRoundInput): InitRoundResult {
  assertAgent(input.coordinator);
  const coordinator: HarnessType = input.coordinator;

  const contributors: HarnessType[] = [];

  for (const agent of input.contributors ?? []) {
    assertAgent(agent);
    contributors.push(agent);
  }

  const assignedBy = input.assignedBy ?? 'user';
  const reason = `本轮由 ${input.coordinator} 负责`;

  return withTransaction(db, () => {
    const round = createRound(db, input.conversationId, {
      goal: input.goal,
      coordinator,
      budgetHops: input.budgetHops,
      budgetExec: input.budgetExec,
      budgetUsageTokens: input.budgetUsageTokens,
      reviewRequired: input.reviewRequired ?? false,
      minAssignments: input.minAssignments,
    });

    putRole(db, round.id, coordinator, 'coordinator', assignedBy, reason);
    appendEvent(db, {
      roundId: round.id,
      agent: coordinator,
      role: 'coordinator',
      action: 'grant',
      assignedBy,
      reason,
    });

    for (const agent of contributors) {
      if (agent === coordinator) continue;

      putRole(db, round.id, agent, 'contributor', assignedBy, '默认参与本轮');
      appendEvent(db, {
        roundId: round.id,
        agent,
        role: 'contributor',
        action: 'grant',
        assignedBy,
        reason: '默认参与本轮',
      });
    }

    return { round, roles: listRoles(db, round.id) };
  });
}

export function listRoles(db: DatabaseSync, roundId: string): RoleRow[] {
  return db
    .prepare('SELECT * FROM round_roles WHERE round_id = ? ORDER BY assigned_at, rowid')
    .all(roundId) as unknown as RoleRow[];
}

export function roleOf(db: DatabaseSync, roundId: string, agent: string): RoleRow | undefined {
  return db
    .prepare('SELECT * FROM round_roles WHERE round_id = ? AND agent = ?')
    .get(roundId, agent) as RoleRow | undefined;
}

export function coordinatorOf(db: DatabaseSync, roundId: string): string | undefined {
  const row = db
    .prepare("SELECT agent FROM round_roles WHERE round_id = ? AND role = 'coordinator'")
    .get(roundId) as { agent: string } | undefined;

  return row?.agent;
}

export function grantRole(
  db: DatabaseSync,
  roundId: string,
  agent: string,
  role: string,
  options: { assignedBy: string; reason: string },
): RoleRow {
  assertAgent(agent);
  assertRole(role);

  const reason = requireReason(options.reason);

  if (!findRound(db, roundId)) {
    throw appError('round_not_found', 'Round not found', 404);
  }

  return withTransaction(db, () => {
    putRole(db, roundId, agent, role, options.assignedBy, reason);
    appendEvent(db, {
      roundId,
      agent,
      role,
      action: 'grant',
      assignedBy: options.assignedBy,
      reason,
    });

    return roleOf(db, roundId, agent) as RoleRow;
  });
}

/**
 * Moves coordination from one agent to another. Both the current row and the
 * append-only event are written together, so "who was in charge then" can be
 * answered later without guessing.
 */
export function handover(
  db: DatabaseSync,
  roundId: string,
  toAgent: string,
  options: { assignedBy: string; reason: string },
): { from: string; to: string } {
  assertAgent(toAgent);

  const reason = requireReason(options.reason);
  const round = findRound(db, roundId);

  if (!round) {
    throw appError('round_not_found', 'Round not found', 404);
  }

  const from = coordinatorOf(db, roundId);

  if (!from) {
    throw appError('no_coordinator', 'This round has no coordinator to hand over from', 409);
  }

  if (from === toAgent) {
    throw appError('invalid_handover', 'The coordinator cannot hand over to itself', 400);
  }

  if (!isHarness(from)) {
    throw appError('invalid_agent', `Round coordinator is not a known agent: ${from}`, 409);
  }

  const fromAgent: HarnessType = from;

  return withTransaction(db, () => {
    putRole(db, roundId, fromAgent, 'contributor', options.assignedBy, `让位给 ${toAgent}`);
    putRole(db, roundId, toAgent, 'coordinator', options.assignedBy, reason);

    appendEvent(db, {
      roundId,
      agent: from,
      role: 'coordinator',
      action: 'handover',
      successor: toAgent,
      assignedBy: options.assignedBy,
      reason,
    });
    // The outgoing agent keeps a role; recording it separately means "who was
    // in charge then" reads a role, not a handover row.
    appendEvent(db, {
      roundId,
      agent: fromAgent,
      role: 'contributor',
      action: 'grant',
      assignedBy: options.assignedBy,
      reason: `让位给 ${toAgent}`,
    });
    appendEvent(db, {
      roundId,
      agent: toAgent,
      role: 'coordinator',
      action: 'grant',
      assignedBy: options.assignedBy,
      reason,
    });

    db.prepare('UPDATE collab_rounds SET coordinator = ? WHERE id = ?').run(toAgent, roundId);

    return { from, to: toAgent };
  });
}

export function revokeRole(
  db: DatabaseSync,
  roundId: string,
  agent: string,
  options: { assignedBy: string; reason: string },
): void {
  assertAgent(agent);

  const reason = requireReason(options.reason);
  const current = roleOf(db, roundId, agent);

  if (!current) {
    throw appError('role_not_found', 'This agent holds no role in the round', 404);
  }

  withTransaction(db, () => {
    db.prepare('DELETE FROM round_roles WHERE round_id = ? AND agent = ?').run(roundId, agent);
    appendEvent(db, {
      roundId,
      agent,
      role: current.role,
      action: 'revoke',
      assignedBy: options.assignedBy,
      reason,
    });
  });
}

/** The role this agent held at a past moment, read from the event log. */
export function roleAt(
  db: DatabaseSync,
  roundId: string,
  agent: string,
  atIso: string,
): Role | undefined {
  const events = db
    .prepare(
      `SELECT * FROM role_events
        WHERE round_id = ? AND agent = ? AND created_at <= ?
        ORDER BY created_at DESC, rowid DESC`,
    )
    .all(roundId, agent, atIso) as unknown as RoleEventRow[];

  for (const event of events) {
    if (event.action === 'revoke') return undefined;
    return event.role;
  }

  return undefined;
}

export function roleEvents(db: DatabaseSync, roundId: string): RoleEventRow[] {
  return db
    .prepare('SELECT * FROM role_events WHERE round_id = ? ORDER BY created_at, rowid')
    .all(roundId) as unknown as RoleEventRow[];
}
