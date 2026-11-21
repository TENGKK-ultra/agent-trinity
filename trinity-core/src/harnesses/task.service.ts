import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import * as conversationRepository from '../conversations/conversation.repository.ts';
import {
  appendChange,
  SYSTEM_ACTOR,
  type ChangeActor,
} from '../changes/change-log.service.ts';
import { withTransaction } from '../database/transaction.ts';
import * as messageService from '../messages/message.service.ts';
import { appError } from '../types/index.ts';
import { HARNESS_TYPES, type HarnessType } from './types.ts';

export const TASK_STATUSES = [
  'queued',
  'running',
  'completed',
  'failed',
  'timeout',
  'cancelled',
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_DELIVERY_STATUSES = ['pending', 'delivered', 'failed'] as const;

export type TaskDeliveryStatus = (typeof TASK_DELIVERY_STATUSES)[number];

const ACTIVE_STATUSES: TaskStatus[] = ['queued', 'running'];
const TERMINAL_STATUSES: TaskStatus[] = ['completed', 'failed', 'timeout', 'cancelled'];

export const MAX_INSTRUCTION_LENGTH = 8000;
export const MAX_TITLE_LENGTH = 120;
export const TITLE_FALLBACK_CHARS = 30;

/**
 * Ordinary delegation allows one hop: a task may not delegate further. Group
 * chat relays a message along a chain, so it passes its own limit explicitly
 * instead of widening this default for every caller.
 */
export const MAX_TASK_DEPTH = 0;

export interface TaskRow {
  id: string;
  conversation_id: string;
  parent_task_id: string | null;
  chain_id: string;
  depth: number;
  source_agent: string | null;
  source_turn_id: string | null;
  target_agent: string;
  target_turn_id: string | null;
  title: string;
  instruction: string;
  task_type: string;
  status: TaskStatus;
  delivery_status: TaskDeliveryStatus;
  result_message_id: string | null;
  error_text: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface CreateTaskInput {
  conversationId: string;
  sourceAgent: string | null;
  sourceTurnId?: string | null;
  targetAgent: string;
  instruction: string;
  title?: string | null;
  parentTaskId?: string | null;
  /** Usually the root task id; a group round supplies its own id so the
      round can be recognised again after a restart. */
  chainId?: string;
  /** Deepest level this chain may reach. Only group chat raises it. */
  maxDepth?: number;
  /** What kind of work this is; capability evidence is counted per type. */
  taskType?: string;
  /**
   * Set when a collaboration round creates the task through its coordinator
   * rather than from inside a running turn. The delegating turn does not exist
   * here, so the chain's source-agent guard would only lock the coordinator out
   * of its own round; the round's busy check is the guard that applies.
   */
  orchestrated?: boolean;
}

function isHarness(value: string): value is HarnessType {
  return (HARNESS_TYPES as readonly string[]).includes(value);
}

export function findTask(db: DatabaseSync, id: string): TaskRow | undefined {
  return db.prepare('SELECT * FROM agent_tasks WHERE id = ?').get(id) as TaskRow | undefined;
}

export function listTasks(
  db: DatabaseSync,
  conversationId: string,
  status?: TaskStatus,
): TaskRow[] {
  if (status) {
    return db
      .prepare(
        'SELECT * FROM agent_tasks WHERE conversation_id = ? AND status = ? ORDER BY created_at ASC, rowid ASC',
      )
      .all(conversationId, status) as unknown as TaskRow[];
  }

  return db
    .prepare(
      'SELECT * FROM agent_tasks WHERE conversation_id = ? ORDER BY created_at ASC, rowid ASC',
    )
    .all(conversationId) as unknown as TaskRow[];
}

export interface TaskPage {
  items: TaskRow[];
  total: number;
  limit: number;
  offset: number;
}

export function listTasksPage(
  db: DatabaseSync,
  conversationId: string,
  options: { status?: TaskStatus; limit: number; offset: number },
): TaskPage {
  const where = options.status
    ? 'WHERE conversation_id = ? AND status = ?'
    : 'WHERE conversation_id = ?';
  const params = options.status
    ? [conversationId, options.status]
    : [conversationId];

  const items = db
    .prepare(
      `SELECT * FROM agent_tasks ${where} ORDER BY created_at ASC, rowid ASC LIMIT ? OFFSET ?`,
    )
    .all(...params, options.limit, options.offset) as unknown as TaskRow[];

  const counted = db
    .prepare(`SELECT COUNT(*) AS n FROM agent_tasks ${where}`)
    .get(...params) as { n: number };

  return { items, total: Number(counted.n), limit: options.limit, offset: options.offset };
}

export interface GlobalTaskRow extends TaskRow {
  conversation_title: string;
}

export function listAllTasksPage(
  db: DatabaseSync,
  options: { status?: TaskStatus; limit: number; offset: number },
): { items: GlobalTaskRow[]; total: number; limit: number; offset: number } {
  const where = options.status ? 'WHERE t.status = ?' : '';
  const params = options.status ? [options.status] : [];

  const items = db
    .prepare(
      `SELECT t.*, c.title AS conversation_title
         FROM agent_tasks t
         JOIN conversations c ON c.id = t.conversation_id
         ${where}
         ORDER BY t.created_at DESC, t.rowid DESC
         LIMIT ? OFFSET ?`,
    )
    .all(...params, options.limit, options.offset) as unknown as GlobalTaskRow[];

  const counted = db
    .prepare(`SELECT COUNT(*) AS n FROM agent_tasks t ${where}`)
    .get(...params) as { n: number };

  return { items, total: Number(counted.n), limit: options.limit, offset: options.offset };
}

export function findResultMessage(
  db: DatabaseSync,
  messageId: string | null,
): { id: string; content: string; created_at: string } | null {
  if (messageId === null) return null;

  const row = db
    .prepare('SELECT id, content, created_at FROM messages WHERE id = ?')
    .get(messageId) as { id: string; content: string; created_at: string } | undefined;

  return row ?? null;
}

function deriveTitle(instruction: string, provided: string | null | undefined): string {
  const explicit = provided?.trim();

  if (explicit) {
    if (explicit.length > MAX_TITLE_LENGTH) {
      throw appError('invalid_title', `title must be at most ${MAX_TITLE_LENGTH} characters`, 400);
    }

    return explicit;
  }

  return Array.from(instruction).slice(0, TITLE_FALLBACK_CHARS).join('');
}

/**
 * A delegation chain may never point back at an agent that is already part of
 * it: that agent's run lock is held by the turn waiting for this task, so the
 * child turn could never start.
 */
export function assertDelegationAllowed(
  db: DatabaseSync,
  chainId: string,
  targetAgent: string,
): void {
  const active = db
    .prepare(
      `SELECT source_agent, target_agent FROM agent_tasks
       WHERE chain_id = ? AND status IN ('queued', 'running')`,
    )
    .all(chainId) as Array<{ source_agent: string | null; target_agent: string }>;

  for (const row of active) {
    if (row.target_agent === targetAgent || row.source_agent === targetAgent) {
      throw appError(
        'delegation_cycle',
        `"${targetAgent}" is already part of this delegation chain`,
        409,
      );
    }
  }
}

export function createTask(
  db: DatabaseSync,
  input: CreateTaskInput,
  actor: ChangeActor = SYSTEM_ACTOR,
): TaskRow {
  if (!conversationRepository.findConversation(db, input.conversationId)) {
    throw appError('conversation_not_found', 'Conversation not found', 404);
  }

  const instruction = input.instruction.trim();

  if (instruction === '') {
    throw appError('invalid_instruction', 'instruction must not be empty', 400);
  }

  if (instruction.length > MAX_INSTRUCTION_LENGTH) {
    throw appError(
      'invalid_instruction',
      `instruction must be at most ${MAX_INSTRUCTION_LENGTH} characters`,
      400,
    );
  }

  if (!isHarness(input.targetAgent)) {
    throw appError('invalid_target_agent', `Unknown target agent: ${input.targetAgent}`, 400);
  }

  if (input.sourceAgent !== null && !isHarness(input.sourceAgent)) {
    throw appError('invalid_source_agent', `Unknown source agent: ${input.sourceAgent}`, 400);
  }

  if (input.sourceAgent !== null && input.sourceAgent === input.targetAgent) {
    throw appError('invalid_target_agent', 'An agent cannot delegate to itself', 400);
  }

  const parent = input.parentTaskId ? findTask(db, input.parentTaskId) : undefined;

  if (input.parentTaskId && (!parent || parent.conversation_id !== input.conversationId)) {
    throw appError('invalid_parent_task', 'parent_task_id must reference a task in this conversation', 400);
  }

  const depth = parent ? parent.depth + 1 : 0;
  const depthLimit = input.maxDepth ?? MAX_TASK_DEPTH;

  if (depth > depthLimit) {
    throw appError('delegation_too_deep', `Delegation depth limit is ${depthLimit}`, 409);
  }

  // A chain is normally named after its root task; a group round passes its own
  // id instead, so the round survives a restart without a new table.
  const id = randomUUID();
  const chainId = parent?.chain_id ?? input.chainId ?? id;

  if (!input.orchestrated) {
    assertDelegationAllowed(db, chainId, input.targetAgent);
  }

  const now = new Date().toISOString();
  const row: TaskRow = {
    id,
    conversation_id: input.conversationId,
    parent_task_id: parent?.id ?? null,
    chain_id: chainId,
    depth,
    source_agent: input.sourceAgent,
    source_turn_id: input.sourceTurnId ?? null,
    target_agent: input.targetAgent,
    target_turn_id: null,
    title: deriveTitle(instruction, input.title),
    instruction,
    task_type: (input.taskType ?? 'general').trim() || 'general',
    status: 'queued',
    delivery_status: 'pending',
    result_message_id: null,
    error_text: null,
    created_at: now,
    started_at: null,
    finished_at: null,
  };

  return withTransaction(db, () => {
    db.prepare(
      `INSERT INTO agent_tasks
         (id, conversation_id, parent_task_id, chain_id, depth,
          source_agent, source_turn_id, target_agent, target_turn_id,
          title, instruction, task_type, status, delivery_status, result_message_id,
          error_text, created_at, started_at, finished_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.id,
      row.conversation_id,
      row.parent_task_id,
      row.chain_id,
      row.depth,
      row.source_agent,
      row.source_turn_id,
      row.target_agent,
      row.target_turn_id,
      row.title,
      row.instruction,
      row.task_type,
      row.status,
      row.delivery_status,
      row.result_message_id,
      row.error_text,
      row.created_at,
      row.started_at,
      row.finished_at,
    );

    appendChange(db, {
      entityType: 'agent_task',
      entityId: row.id,
      operation: 'insert',
      actor,
      conversationId: row.conversation_id,
      // Metadata only: the title is derived from the instruction, so it stays out too.
      payload: {
        source_agent: row.source_agent,
        target_agent: row.target_agent,
        status: row.status,
      },
    });

    // The authoritative anchor: without it a timeline would have to guess the
    // task from the model's result text. It is written in this transaction, so
    // a task can never exist without its anchor or the other way round.
    messageService.addMessage(
      db,
      row.conversation_id,
      {
        message_type: 'task_status',
        sender_kind: 'system',
        content: `委派任务给 ${row.target_agent}：${row.title}`,
        metadata: {
          task_id: row.id,
          source_turn_id: row.source_turn_id,
          source_agent: row.source_agent,
          target_agent: row.target_agent,
          kind: 'delegation_created',
        },
      },
      SYSTEM_ACTOR,
    );

    return row;
  });
}

interface Settlement {
  status: TaskStatus;
  error?: string;
  resultMessageId?: string;
}

/**
 * Moves one task out of an active state. Returns null when another writer got
 * there first, so a late timer can never overwrite a finished task.
 */
function settle(
  db: DatabaseSync,
  id: string,
  from: TaskStatus[],
  to: Settlement,
  actor: ChangeActor,
): TaskRow | null {
  return withTransaction(db, () => {
    const row = findTask(db, id);
    if (!row || !from.includes(row.status)) return null;

    const now = new Date().toISOString();
    const result = db
      .prepare(
        `UPDATE agent_tasks
            SET status = ?, error_text = ?, result_message_id = ?, finished_at = ?
          WHERE id = ? AND status IN (${from.map(() => '?').join(', ')})`,
      )
      .run(
        to.status,
        to.error ?? null,
        to.resultMessageId ?? null,
        now,
        id,
        ...from,
      );

    if (Number(result.changes) === 0) return null;

    appendChange(db, {
      entityType: 'agent_task',
      entityId: id,
      operation: 'update',
      actor,
      conversationId: row.conversation_id,
      payload: {
        source_agent: row.source_agent,
        target_agent: row.target_agent,
        status: to.status,
      },
    });

    return {
      ...row,
      status: to.status,
      error_text: to.error ?? null,
      result_message_id: to.resultMessageId ?? null,
      finished_at: now,
    };
  });
}

export function markTaskRunning(
  db: DatabaseSync,
  id: string,
  targetTurnId: string,
): TaskRow | null {
  return withTransaction(db, () => {
    const row = findTask(db, id);
    if (!row || row.status !== 'queued') return null;

    const now = new Date().toISOString();
    const result = db
      .prepare(
        `UPDATE agent_tasks SET status = 'running', target_turn_id = ?, started_at = ?
         WHERE id = ? AND status = 'queued'`,
      )
      .run(targetTurnId, now, id);

    if (Number(result.changes) === 0) return null;

    appendChange(db, {
      entityType: 'agent_task',
      entityId: id,
      operation: 'update',
      actor: SYSTEM_ACTOR,
      conversationId: row.conversation_id,
      payload: {
        source_agent: row.source_agent,
        target_agent: row.target_agent,
        status: 'running',
      },
    });

    return { ...row, status: 'running', target_turn_id: targetTurnId, started_at: now };
  });
}

export function completeTask(
  db: DatabaseSync,
  id: string,
  resultMessageId: string,
  actor: ChangeActor = SYSTEM_ACTOR,
): TaskRow | null {
  const message = db
    .prepare('SELECT conversation_id FROM messages WHERE id = ?')
    .get(resultMessageId) as { conversation_id: string } | undefined;

  const row = findTask(db, id);

  if (!row || !message || message.conversation_id !== row.conversation_id) {
    throw appError(
      'invalid_result_message',
      'result_message_id must reference a message in the same conversation',
      400,
    );
  }

  return settle(db, id, ['running'], { status: 'completed', resultMessageId }, actor);
}

export function failTask(
  db: DatabaseSync,
  id: string,
  error: string,
  actor: ChangeActor = SYSTEM_ACTOR,
): TaskRow | null {
  return settle(db, id, ACTIVE_STATUSES, { status: 'failed', error }, actor);
}

export function timeoutTask(
  db: DatabaseSync,
  id: string,
  error = 'timeout',
): TaskRow | null {
  return settle(db, id, ['running'], { status: 'timeout', error }, SYSTEM_ACTOR);
}

export function cancelTask(
  db: DatabaseSync,
  id: string,
  reason = 'cancelled',
  actor: ChangeActor = SYSTEM_ACTOR,
): TaskRow | null {
  return settle(db, id, ACTIVE_STATUSES, { status: 'cancelled', error: reason }, actor);
}

/** Cancels every task still active in one delegation chain. Returns how many. */
export function cancelChain(
  db: DatabaseSync,
  chainId: string,
  reason = 'parent_cancelled',
): number {
  const rows = db
    .prepare(
      `SELECT id FROM agent_tasks WHERE chain_id = ? AND status IN ('queued', 'running')`,
    )
    .all(chainId) as Array<{ id: string }>;

  let cancelled = 0;
  for (const row of rows) {
    if (cancelTask(db, row.id, reason)) cancelled += 1;
  }

  return cancelled;
}

/**
 * Records whether the result reached the caller's transport. Only a pending
 * delivery may change: a duplicate callback must never rewrite the answer.
 */
export function setDeliveryStatus(
  db: DatabaseSync,
  id: string,
  delivery: Exclude<TaskDeliveryStatus, 'pending'>,
): TaskRow | null {
  return withTransaction(db, () => {
    const row = findTask(db, id);
    if (!row || row.delivery_status !== 'pending') return null;

    const result = db
      .prepare(`UPDATE agent_tasks SET delivery_status = ? WHERE id = ? AND delivery_status = 'pending'`)
      .run(delivery, id);

    if (Number(result.changes) === 0) return null;

    appendChange(db, {
      entityType: 'agent_task',
      entityId: id,
      operation: 'update',
      actor: SYSTEM_ACTOR,
      conversationId: row.conversation_id,
      payload: {
        source_agent: row.source_agent,
        target_agent: row.target_agent,
        status: row.status,
        delivery_status: delivery,
      },
    });

    return { ...row, delivery_status: delivery };
  });
}

/**
 * Startup recovery. It restores the task ledger and nothing else: it cannot
 * find or kill child processes that outlived a crash.
 *
 * Idempotent by construction — every update is conditional on the state it
 * leaves behind, so running it twice changes nothing.
 */
export function sweepTasksOnStartup(db: DatabaseSync): {
  failed: number;
  undelivered: number;
} {
  return withTransaction(db, () => {
    const now = new Date().toISOString();

    const stuck = db
      .prepare(`SELECT * FROM agent_tasks WHERE status IN ('queued', 'running')`)
      .all() as unknown as TaskRow[];

    for (const row of stuck) {
      const result = db
        .prepare(
          `UPDATE agent_tasks
              SET status = 'failed', error_text = 'core_restart',
                  delivery_status = 'failed', finished_at = ?
            WHERE id = ? AND status IN ('queued', 'running')`,
        )
        .run(now, row.id);

      if (Number(result.changes) === 0) continue;

      appendChange(db, {
        entityType: 'agent_task',
        entityId: row.id,
        operation: 'update',
        actor: SYSTEM_ACTOR,
        conversationId: row.conversation_id,
        payload: {
          source_agent: row.source_agent,
          target_agent: row.target_agent,
          status: 'failed',
          reason: 'core_restart',
        },
      });
    }

    // A completed task keeps its status; only its delivery is settled.
    const undelivered = db
      .prepare(
        `SELECT * FROM agent_tasks
          WHERE delivery_status = 'pending'
            AND status IN ('completed', 'failed', 'timeout', 'cancelled')`,
      )
      .all() as unknown as TaskRow[];

    for (const row of undelivered) {
      const result = db
        .prepare(`UPDATE agent_tasks SET delivery_status = 'failed' WHERE id = ? AND delivery_status = 'pending'`)
        .run(row.id);

      if (Number(result.changes) === 0) continue;

      appendChange(db, {
        entityType: 'agent_task',
        entityId: row.id,
        operation: 'update',
        actor: SYSTEM_ACTOR,
        conversationId: row.conversation_id,
        payload: {
          source_agent: row.source_agent,
          target_agent: row.target_agent,
          status: row.status,
          delivery_status: 'failed',
          reason: 'core_restart',
        },
      });
    }

    return { failed: stuck.length, undelivered: undelivered.length };
  });
}

export function isTerminal(status: TaskStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}
