import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { withTransaction } from '../database/transaction.ts';
import * as sessionService from '../harnesses/session.service.ts';
import { HARNESS_TYPES, type HarnessType } from '../harnesses/types.ts';
import { appError } from '../types/index.ts';

export type MessageKind = 'utterance' | 'notice' | 'assignment';

export type MessageState =
  | 'queued'
  | 'delivered'
  | 'consumed'
  | 'task_running'
  | 'task_completed'
  | 'task_failed'
  | 'refused'
  | 'expired'
  | 'failed'
  | 'uncertain';

export interface AgentMessageRow {
  id: string;
  round_id: string;
  conversation_id: string;
  kind: MessageKind;
  from_agent: string;
  reason: string | null;
  assigned_by: string | null;
  to_agent: string | null;
  content: string;
  parent_message_id: string | null;
  task_id: string | null;
  request_id: string;
  fingerprint: string;
  state: MessageState;
  refusal_reason: string | null;
  hop: number;
  presented_count: number;
  created_at: string;
  delivered_at: string | null;
  consumed_at: string | null;
}

export interface RoundRow {
  id: string;
  conversation_id: string;
  goal: string;
  status: string;
  outcome: string | null;
  coordinator: string | null;
  review_required: number;
  /** Distinct agents the user requires before the round may call itself done. */
  min_assignments: number;
  blocked_phase: string | null;
  budget_hops: number;
  hops_used: number;
  budget_exec: number;
  exec_used: number;
  budget_usage_tokens: number | null;
  blocked_reason: string | null;
  wake_condition: string | null;
  blocked_at: string | null;
  delivery_message_id: string | null;
  created_at: string;
  closed_at: string | null;
}

/**
 * A sender the Core has already vouched for. The brand is a private symbol, not
 * a type trick: a caller that builds `{ agent: 'claude' }` by hand fails the
 * runtime check, so hiding a request parameter is not the only defence.
 */
const TRUSTED_SENDER = Symbol('trinity.trusted-sender');

/** The user is a sender too; their words carry `from_agent = 'user'`. */
export type SenderAgent = HarnessType | 'user';

export interface TrustedSender {
  readonly [TRUSTED_SENDER]: true;
  readonly agent: SenderAgent;
  readonly conversationId: string;
}

const MAX_CONTENT_LENGTH = 8000;

function isHarness(value: string): value is HarnessType {
  return (HARNESS_TYPES as readonly string[]).includes(value);
}

/** The only way to obtain a sender: the agent must exist and be bound here. */
export function trustedSender(
  db: DatabaseSync,
  conversationId: string,
  agent: string,
): TrustedSender {
  if (!isHarness(agent)) {
    throw appError('invalid_agent', `Unknown agent: ${agent}`, 400);
  }

  if (!sessionService.findSession(db, conversationId, agent)) {
    throw appError('sender_not_bound', `${agent} is not bound to this conversation`, 409);
  }

  return { [TRUSTED_SENDER]: true, agent, conversationId };
}

/**
 * The user speaks through Core, never through an agent. Their messages are
 * branded the same way, so a forged `{ agent: 'user' }` is rejected too.
 */
export function trustedUser(db: DatabaseSync, conversationId: string): TrustedSender {
  const exists = db
    .prepare('SELECT 1 AS ok FROM conversations WHERE id = ?')
    .get(conversationId) as { ok: number } | undefined;

  if (!exists) {
    throw appError('conversation_not_found', 'Conversation not found', 404);
  }

  return { [TRUSTED_SENDER]: true, agent: 'user', conversationId };
}

function assertTrusted(sender: unknown): asserts sender is TrustedSender {
  if (
    typeof sender !== 'object' ||
    sender === null ||
    (sender as Record<symbol, unknown>)[TRUSTED_SENDER] !== true
  ) {
    throw appError('untrusted_sender', 'Sender identity must come from Core', 400);
  }
}

export function fingerprintOf(
  kind: MessageKind,
  fromAgent: string,
  toAgent: string | null,
  content: string,
): string {
  return createHash('sha256')
    .update([kind, fromAgent, toAgent ?? '', content].join('\n'))
    .digest('hex');
}

export function findRound(db: DatabaseSync, roundId: string): RoundRow | undefined {
  return db.prepare('SELECT * FROM collab_rounds WHERE id = ?').get(roundId) as
    | RoundRow
    | undefined;
}

export function createRound(
  db: DatabaseSync,
  conversationId: string,
  input: {
    goal: string;
    coordinator?: string | null;
    budgetHops?: number;
    budgetExec?: number;
    budgetUsageTokens?: number | null;
    reviewRequired?: boolean;
    minAssignments?: number;
  },
): RoundRow {
  const goal = input.goal.trim();

  if (goal === '') {
    throw appError('invalid_goal', 'goal must not be empty', 400);
  }

  const row: RoundRow = {
    id: randomUUID(),
    conversation_id: conversationId,
    goal,
    status: 'created',
    outcome: null,
    coordinator: input.coordinator ?? null,
    review_required: input.reviewRequired ? 1 : 0,
    min_assignments: input.minAssignments ?? 0,
    blocked_phase: null,
    budget_hops: input.budgetHops ?? 10,
    hops_used: 0,
    budget_exec: input.budgetExec ?? 12,
    exec_used: 0,
    budget_usage_tokens: input.budgetUsageTokens ?? null,
    blocked_reason: null,
    wake_condition: null,
    blocked_at: null,
    delivery_message_id: null,
    created_at: new Date().toISOString(),
    closed_at: null,
  };

  db.prepare(
    `INSERT INTO collab_rounds
       (id, conversation_id, goal, status, outcome, coordinator,
        review_required, min_assignments, blocked_phase,
        budget_hops, hops_used, budget_exec, exec_used,
        budget_usage_tokens, blocked_reason, wake_condition, blocked_at,
        delivery_message_id, created_at, closed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.conversation_id,
    row.goal,
    row.status,
    row.outcome,
    row.coordinator,
    row.review_required,
    row.min_assignments,
    row.blocked_phase,
    row.budget_hops,
    row.hops_used,
    row.budget_exec,
    row.exec_used,
    row.budget_usage_tokens,
    row.blocked_reason,
    row.wake_condition,
    row.blocked_at,
    row.delivery_message_id,
    row.created_at,
    row.closed_at,
  );

  return row;
}

export interface RecordMessageInput {
  roundId: string;
  kind: MessageKind;
  toAgent?: string | null;
  content: string;
  parentMessageId?: string | null;
  taskId?: string | null;
  /** Defaults to a fresh uuid; a retry of the same send must reuse it. */
  requestId?: string;
  hop?: number;
  /** Why this message went to this agent. Required for assignments. */
  reason?: string | null;
  assignedBy?: string | null;
  /**
   * An assignment that already produced a task starts in `task_running`, so it
   * never looks like a pending request waiting to be accepted again.
   */
  initialState?: 'queued' | 'task_running';
}

export interface RecordMessageResult {
  message: AgentMessageRow;
  created: boolean;
}

export function findMessageByRequestId(
  db: DatabaseSync,
  requestId: string,
): AgentMessageRow | undefined {
  return db.prepare('SELECT * FROM agent_messages WHERE request_id = ?').get(requestId) as
    | AgentMessageRow
    | undefined;
}

/**
 * The round's conversation as the next agent should read it: what others said
 * (utterances) and what they reported (notices), oldest first. This is context,
 * never work — it changes no state and starts nothing on its own.
 */
export function contextOf(
  db: DatabaseSync,
  roundId: string,
  limit = 20,
): AgentMessageRow[] {
  const rows = db
    .prepare(
      `SELECT * FROM agent_messages
        WHERE round_id = ? AND kind IN ('utterance', 'notice')
        ORDER BY created_at DESC, rowid DESC
        LIMIT ?`,
    )
    .all(roundId, limit) as unknown as AgentMessageRow[];

  return rows.reverse();
}

export function findMessage(db: DatabaseSync, id: string): AgentMessageRow | undefined {
  return db.prepare('SELECT * FROM agent_messages WHERE id = ?').get(id) as
    | AgentMessageRow
    | undefined;
}

/**
 * Records one agent message. The same request id with the same words returns
 * the first message; with different words it is a conflict, never a second row.
 */
export function recordMessage(
  db: DatabaseSync,
  sender: TrustedSender,
  input: RecordMessageInput,
): RecordMessageResult {
  assertTrusted(sender);

  const content = input.content ?? '';

  if (content.trim() === '') {
    throw appError('invalid_content', 'content must not be empty', 400);
  }

  if (content.length > MAX_CONTENT_LENGTH) {
    throw appError('invalid_content', `content must be at most ${MAX_CONTENT_LENGTH} characters`, 400);
  }

  if (input.kind === 'assignment' && (input.reason ?? '').trim() === '') {
    throw appError('invalid_reason', 'An assignment must say why it was made', 400);
  }

  const toAgent = input.toAgent ?? null;

  if (toAgent !== null && !isHarness(toAgent)) {
    throw appError('invalid_agent', `Unknown recipient: ${toAgent}`, 400);
  }

  const round = findRound(db, input.roundId);

  if (!round) {
    throw appError('round_not_found', 'Round not found', 404);
  }

  if (round.conversation_id !== sender.conversationId) {
    throw appError('round_not_in_conversation', 'Round belongs to another conversation', 409);
  }

  const requestId = input.requestId ?? randomUUID();
  const fingerprint = fingerprintOf(input.kind, sender.agent, toAgent, content);

  return withTransaction(db, () => {
    const existing = findMessageByRequestId(db, requestId);

    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw appError(
          'request_id_conflict',
          'This request id was already used for different content',
          409,
        );
      }

      return { message: existing, created: false };
    }

    if (input.kind === 'assignment' && toAgent !== null) {
      const duplicate = db
        .prepare(
          `SELECT id FROM agent_messages
            WHERE round_id = ? AND to_agent = ? AND fingerprint = ? AND kind = 'assignment'`,
        )
        .get(round.id, toAgent, fingerprint) as { id: string } | undefined;

      if (duplicate) {
        throw appError(
          'duplicate_assignment',
          'This assignment was already sent in this round',
          409,
        );
      }
    }

    const row: AgentMessageRow = {
      id: randomUUID(),
      round_id: round.id,
      conversation_id: sender.conversationId,
      kind: input.kind,
      from_agent: sender.agent,
      reason: input.reason ?? null,
      assigned_by: input.assignedBy ?? null,
      to_agent: toAgent,
      content,
      parent_message_id: input.parentMessageId ?? null,
      task_id: input.taskId ?? null,
      request_id: requestId,
      fingerprint,
      state: input.initialState ?? 'queued',
      refusal_reason: null,
      hop: input.hop ?? 1,
      presented_count: 0,
      created_at: new Date().toISOString(),
      delivered_at: null,
      consumed_at: null,
    };

    try {
      db.prepare(
        `INSERT INTO agent_messages
           (id, round_id, conversation_id, kind, from_agent, reason, assigned_by,
            to_agent, content, parent_message_id, task_id, request_id, fingerprint,
            state, refusal_reason, hop, created_at, delivered_at, consumed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        row.id,
        row.round_id,
        row.conversation_id,
        row.kind,
        row.from_agent,
        row.reason,
        row.assigned_by,
        row.to_agent,
        row.content,
        row.parent_message_id,
        row.task_id,
        row.request_id,
        row.fingerprint,
        row.state,
        row.refusal_reason,
        row.hop,
        row.created_at,
        row.delivered_at,
        row.consumed_at,
      );
    } catch (err) {
      const message = String((err as Error).message);

      if (message.includes('idx_agent_messages_assignment_once')) {
        throw appError(
          'duplicate_assignment',
          'This assignment was already sent in this round',
          409,
        );
      }

      throw err;
    }

    return { message: row, created: true };
  });
}

/**
 * Read-only: what is waiting for this agent to *decide*. Utterances are context,
 * not work, so they never appear here — including them would wake an agent for
 * a comment and, worse, keep waking it once consumed.
 */
export function inbox(
  db: DatabaseSync,
  conversationId: string,
  agent: HarnessType,
  roundId?: string,
): AgentMessageRow[] {
  if (roundId !== undefined) {
    return db
      .prepare(
        `SELECT * FROM agent_messages
          WHERE conversation_id = ? AND to_agent = ? AND round_id = ?
            AND kind IN ('notice', 'assignment')
            AND state IN ('queued', 'delivered')
          ORDER BY created_at, rowid`,
      )
      .all(conversationId, agent, roundId) as unknown as AgentMessageRow[];
  }

  return db
    .prepare(
      `SELECT * FROM agent_messages
        WHERE conversation_id = ? AND to_agent = ?
          AND kind IN ('notice', 'assignment')
          AND state IN ('queued', 'delivered')
        ORDER BY created_at, rowid`,
    )
    .all(conversationId, agent) as unknown as AgentMessageRow[];
}

/** Distinct agents this round has already assigned work to. */
export function distinctAssignees(db: DatabaseSync, roundId: string): string[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT to_agent FROM agent_messages
        WHERE round_id = ? AND kind = 'assignment' AND to_agent IS NOT NULL
        ORDER BY to_agent`,
    )
    .all(roundId) as Array<{ to_agent: string }>;

  return rows.map((row) => row.to_agent);
}

/** Marks a queued message as handed to the recipient's turn. */
export function markDelivered(db: DatabaseSync, messageId: string): boolean {
  const result = db
    .prepare(
      `UPDATE agent_messages
          SET state = 'delivered', delivered_at = ?
        WHERE id = ? AND state = 'queued'`,
    )
    .run(new Date().toISOString(), messageId);

  return Number(result.changes) === 1;
}

/**
 * Consumes one message. The conditional update is the whole defence: two
 * checkpoints racing for the same row both run this, and exactly one changes it.
 */
export function consume(db: DatabaseSync, messageId: string): boolean {
  const result = db
    .prepare(
      `UPDATE agent_messages
          SET state = 'consumed', consumed_at = ?
        WHERE id = ? AND state IN ('queued', 'delivered')`,
    )
    .run(new Date().toISOString(), messageId);

  return Number(result.changes) === 1;
}

/** How many checkpoint turns may show one undecided request before it expires. */
export const MAX_PRESENTATIONS = 2;

/**
 * Counts one checkpoint presentation of a message. Bounded on purpose: a request
 * nobody decides must stop waking an agent (§8.1.1), otherwise the exec budget
 * is spent re-asking the same question.
 */
export function markPresented(db: DatabaseSync, messageId: string): number {
  return withTransaction(db, () => {
    db.prepare(
      'UPDATE agent_messages SET presented_count = presented_count + 1 WHERE id = ?',
    ).run(messageId);

    const row = db
      .prepare('SELECT presented_count FROM agent_messages WHERE id = ?')
      .get(messageId) as { presented_count: number } | undefined;

    return row?.presented_count ?? 0;
  });
}

/** A request that has had its chances and is still undecided stops being work. */
export function expireAssignment(db: DatabaseSync, messageId: string, reason: string): boolean {
  const result = db
    .prepare(
      `UPDATE agent_messages
          SET state = 'expired', refusal_reason = ?, consumed_at = ?
        WHERE id = ? AND kind = 'assignment' AND task_id IS NULL
          AND state IN ('queued', 'delivered')`,
    )
    .run(reason, new Date().toISOString(), messageId);

  return Number(result.changes) === 1;
}

/**
 * The task behind an assignment finished. This is the one place the message
 * learns the outcome; it is conditional so a late settlement cannot overwrite
 * a state another writer already recorded.
 */
export function settleAssignmentState(
  db: DatabaseSync,
  messageId: string,
  state: 'task_completed' | 'task_failed',
): boolean {
  const result = db
    .prepare(
      `UPDATE agent_messages
          SET state = ?, consumed_at = ?
        WHERE id = ? AND kind = 'assignment' AND state = 'task_running'`,
    )
    .run(state, new Date().toISOString(), messageId);

  return Number(result.changes) === 1;
}

/**
 * Ties an assignment to the task it produced. Called with the same task twice is
 * fine; a second, different task for one assignment is refused.
 */
export function linkTask(db: DatabaseSync, messageId: string, taskId: string): AgentMessageRow {
  return withTransaction(db, () => {
    const message = findMessage(db, messageId);

    if (!message) {
      throw appError('message_not_found', 'Message not found', 404);
    }

    if (message.kind !== 'assignment') {
      throw appError('invalid_task_link', 'Only an assignment can produce a task', 409);
    }

    if (message.task_id === taskId) return message;

    const result = db
      .prepare(
        `UPDATE agent_messages
            SET task_id = ?, state = 'task_running'
          WHERE id = ? AND kind = 'assignment' AND task_id IS NULL`,
      )
      .run(taskId, messageId);

    if (Number(result.changes) === 0) {
      throw appError('assignment_already_linked', 'This assignment already has a task', 409);
    }

    return findMessage(db, messageId) as AgentMessageRow;
  });
}
