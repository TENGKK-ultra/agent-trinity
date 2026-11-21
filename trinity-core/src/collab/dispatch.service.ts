import type { DatabaseSync } from 'node:sqlite';
import { withTransaction } from '../database/transaction.ts';
import * as taskService from '../harnesses/task.service.ts';
import { HARNESS_TYPES, type HarnessType } from '../harnesses/types.ts';
import { appError } from '../types/index.ts';
import {
  findMessageByRequestId,
  findRound,
  fingerprintOf,
  linkTask,
  recordMessage,
  trustedSender,
  trustedUser,
  type AgentMessageRow,
} from './messages.service.ts';
import { assertHopWithinBudget, touchHop } from './rounds.service.ts';
import { coordinatorOf, roleOf } from './roles.service.ts';

export type CapabilityVerdict = 'yes' | 'no' | 'unknown';

export interface CapabilityResolver {
  verdict(agent: HarnessType, taskType: string): CapabilityVerdict;
}

/**
 * No adapter profile exists yet, so the honest answer is "unknown" — not "yes".
 * An unknown verdict still lets the assignment through, but it says so on the
 * record instead of pretending the capability was checked.
 */
export const UNKNOWN_CAPABILITY: CapabilityResolver = { verdict: () => 'unknown' };

function capabilityNote(verdict: CapabilityVerdict): string {
  return `（capability: ${verdict}）`;
}

export interface Candidate {
  agent: HarnessType;
  score: number;
  reason: string;
}

export interface RankOptions {
  taskType?: string;
  capability?: CapabilityResolver;
  /** Relative cost per agent; lower is better. */
  cost?: Partial<Record<HarnessType, number>>;
  /** Preference weight per agent from the default profile. */
  preference?: Partial<Record<HarnessType, number>>;
}

function busy(db: DatabaseSync, roundId: string, agent: HarnessType): boolean {
  const row = db
    .prepare(
      `SELECT 1 AS busy FROM agent_tasks
        WHERE chain_id = ? AND target_agent = ? AND status IN ('queued', 'running')
        LIMIT 1`,
    )
    .get(roundId, agent) as { busy: number } | undefined;

  return row !== undefined;
}

function completedCount(db: DatabaseSync, conversationId: string, agent: HarnessType): number {
  return (
    db
      .prepare(
        `SELECT COUNT(*) AS total FROM agent_tasks
          WHERE conversation_id = ? AND target_agent = ? AND status = 'completed'`,
      )
      .get(conversationId, agent) as { total: number }
  ).total;
}

/**
 * Ranks the agents that could take this task, with a sentence for each. The
 * order is the decision; the sentences are why it can be argued with later.
 */
export function rankCandidates(
  db: DatabaseSync,
  roundId: string,
  conversationId: string,
  candidates: readonly HarnessType[],
  options: RankOptions = {},
): Candidate[] {
  const capability = options.capability ?? UNKNOWN_CAPABILITY;
  const taskType = options.taskType ?? 'general';
  const ranked: Candidate[] = [];

  for (const agent of candidates) {
    const verdict = capability.verdict(agent, taskType);

    if (verdict === 'no') continue;

    const isBusy = busy(db, roundId, agent);
    const history = completedCount(db, conversationId, agent);
    const cost = options.cost?.[agent] ?? 1;
    const preference = options.preference?.[agent] ?? 0;

    const score = (isBusy ? 0 : 10) + Math.min(history, 5) + preference - cost;

    ranked.push({
      agent,
      score,
      reason: [
        isBusy ? '正在执行其他任务' : '当前空闲',
        `历史完成 ${history} 项`,
        `成本档 ${cost}`,
        preference === 0 ? null : `偏好 ${preference}`,
        verdict === 'unknown' ? '能力未验证' : '能力已确认',
      ]
        .filter((part): part is string => part !== null)
        .join('；'),
    });
  }

  return ranked.sort((a, b) => b.score - a.score || a.agent.localeCompare(b.agent));
}

export function decideAssignment(
  db: DatabaseSync,
  roundId: string,
  conversationId: string,
  candidates: readonly HarnessType[],
  options: RankOptions = {},
): Candidate {
  const ranked = rankCandidates(db, roundId, conversationId, candidates, options);

  if (ranked.length === 0) {
    throw appError('no_candidate', 'No agent can take this task', 409);
  }

  return ranked[0]!;
}

export interface AssignInput {
  roundId: string;
  /** 'user' or an agent name; only the coordinator may assign. */
  actor: string;
  target: string;
  instruction: string;
  reason: string;
  taskType?: string;
  capability?: CapabilityResolver;
  requireKnownCapability?: boolean;
  parentMessageId?: string | null;
  requestId?: string;
}

function assertHarness(agent: string): asserts agent is HarnessType {
  if (!(HARNESS_TYPES as readonly string[]).includes(agent)) {
    throw appError('invalid_agent', `Unknown agent: ${agent}`, 400);
  }
}

function hopFor(
  db: DatabaseSync,
  roundId: string,
  parentMessageId: string | null | undefined,
): number {
  if (!parentMessageId) return 1;

  const parent = db
    .prepare('SELECT hop FROM agent_messages WHERE id = ?')
    .get(parentMessageId) as { hop: number } | undefined;

  if (!parent) {
    throw appError('message_not_found', 'Parent message not found', 404);
  }

  return parent.hop + 1;
}

/**
 * A formal assignment: the task and the message that explains it are written in
 * one transaction, so a crash can never leave a task nobody asked for.
 */
export function assignTask(
  db: DatabaseSync,
  input: AssignInput,
): { message: AgentMessageRow; task: taskService.TaskRow } {
  assertHarness(input.target);

  const round = findRound(db, input.roundId);

  if (!round) {
    throw appError('round_not_found', 'Round not found', 404);
  }

  if (round.status === 'delivered' || round.status === 'failed' || round.status === 'cancelled') {
    throw appError('round_closed', `Round is already ${round.status}`, 409);
  }

  if (input.actor !== 'user' && input.target === input.actor) {
    throw appError('self_assignment', 'An agent cannot assign work to itself', 400);
  }

  const coordinator = coordinatorOf(db, input.roundId);

  if (input.actor !== 'user' && input.actor !== coordinator) {
    throw appError('not_authorized', 'Only the coordinator or the user may assign work', 403);
  }

  if (input.actor !== 'user') {
    assertHarness(input.actor);

    if (!roleOf(db, input.roundId, input.actor)) {
      throw appError('not_authorized', 'The assigning agent holds no role in this round', 403);
    }
  }

  const senderAgent = input.actor === 'user' ? 'user' : input.actor;

  // A retry of the same request returns what the first attempt produced. This
  // must run before the busy check: the first task is still queued then.
  if (input.requestId) {
    const existing = findMessageByRequestId(db, input.requestId);

    if (existing) {
      const expected = fingerprintOf('assignment', senderAgent, input.target, input.instruction);

      if (existing.fingerprint !== expected) {
        throw appError(
          'request_id_conflict',
          'This request id was already used for different content',
          409,
        );
      }

      if (!existing.task_id) {
        throw appError('request_not_task', 'This request has no task yet', 409);
      }

      const task = taskService.findTask(db, existing.task_id);

      if (!task) {
        throw appError('task_not_found', 'The task of this request is missing', 409);
      }

      return { message: existing, task };
    }
  }

  const capability = input.capability ?? UNKNOWN_CAPABILITY;
  const verdict = capability.verdict(input.target, input.taskType ?? 'general');

  if (verdict === 'no') {
    throw appError(
      'capability_mismatch',
      `${input.target} cannot take a ${input.taskType ?? 'general'} task`,
      409,
    );
  }

  if (verdict === 'unknown' && input.requireKnownCapability) {
    throw appError(
      'capability_unknown',
      `No capability data for ${input.target} on a ${input.taskType ?? 'general'} task`,
      409,
    );
  }

  if (busy(db, input.roundId, input.target)) {
    throw appError('target_unavailable', `${input.target} is already working in this round`, 409);
  }

  const hop = hopFor(db, input.roundId, input.parentMessageId);
  assertHopWithinBudget(db, input.roundId, hop);

  const sender =
    senderAgent === 'user'
      ? trustedUser(db, round.conversation_id)
      : trustedSender(db, round.conversation_id, senderAgent);

  return withTransaction(db, () => {
    const task = taskService.createTask(db, {
      conversationId: round.conversation_id,
      sourceAgent: input.actor === 'user' ? null : input.actor,
      targetAgent: input.target,
      instruction: input.instruction,
      chainId: round.id,
      taskType: input.taskType ?? 'general',
      orchestrated: true,
    });

    const { message } = recordMessage(db, sender, {
      roundId: round.id,
      kind: 'assignment',
      toAgent: input.target,
      content: input.instruction,
      parentMessageId: input.parentMessageId ?? null,
      taskId: task.id,
      requestId: input.requestId,
      hop,
      reason: `${input.reason}${capabilityNote(verdict)}`,
      assignedBy: input.actor,
      initialState: 'task_running',
    });

    touchHop(db, round.id, hop);

    return { message, task };
  });
}

/**
 * A peer asking for help. It creates a message, not a task: the receiver decides
 * at its checkpoint, so one agent cannot conscript another.
 */
export function requestHelp(
  db: DatabaseSync,
  input: {
    roundId: string;
    from: HarnessType;
    to: string;
    instruction: string;
    reason: string;
    parentMessageId?: string | null;
    requestId?: string;
  },
): AgentMessageRow {
  assertHarness(input.to);

  const round = findRound(db, input.roundId);

  if (!round) {
    throw appError('round_not_found', 'Round not found', 404);
  }

  if (input.to === input.from) {
    throw appError('self_assignment', 'An agent cannot ask itself for help', 400);
  }

  if (!roleOf(db, input.roundId, input.from)) {
    throw appError('not_authorized', 'The requesting agent holds no role in this round', 403);
  }

  const hop = hopFor(db, input.roundId, input.parentMessageId);
  assertHopWithinBudget(db, input.roundId, hop);

  const sender = trustedSender(db, round.conversation_id, input.from);

  return withTransaction(db, () => {
    const { message } = recordMessage(db, sender, {
      roundId: round.id,
      kind: 'assignment',
      toAgent: input.to,
      content: input.instruction,
      parentMessageId: input.parentMessageId ?? null,
      requestId: input.requestId,
      hop,
      reason: input.reason,
      assignedBy: input.from,
    });

    touchHop(db, round.id, hop);

    return message;
  });
}

/** Accepting a help request is where its task is created — and linked atomically. */
export function acceptRequest(db: DatabaseSync, messageId: string): taskService.TaskRow {
  return withTransaction(db, () => {
    const message = db
      .prepare('SELECT * FROM agent_messages WHERE id = ?')
      .get(messageId) as AgentMessageRow | undefined;

    if (!message) {
      throw appError('message_not_found', 'Message not found', 404);
    }

    if (message.kind !== 'assignment' || message.task_id !== null) {
      throw appError('not_a_request', 'Only an unaccepted assignment can be accepted', 409);
    }

    if (message.state === 'refused') {
      throw appError('request_refused', 'This request was already refused', 409);
    }

    const round = findRound(db, message.round_id) as NonNullable<ReturnType<typeof findRound>>;

    const task = taskService.createTask(db, {
      conversationId: message.conversation_id,
      sourceAgent: message.from_agent === 'user' ? null : (message.from_agent as HarnessType),
      targetAgent: message.to_agent as HarnessType,
      instruction: message.content,
      chainId: message.round_id,
      orchestrated: true,
    });

    linkTask(db, messageId, task.id);

    return task;
  });
}

export function refuseAssignment(
  db: DatabaseSync,
  messageId: string,
  reason: string,
): AgentMessageRow {
  const text = reason.trim();

  if (text === '') {
    throw appError('invalid_reason', 'A refusal must say why', 400);
  }

  const result = db
    .prepare(
      `UPDATE agent_messages
          SET state = 'refused', refusal_reason = ?, consumed_at = ?
        WHERE id = ? AND kind = 'assignment' AND task_id IS NULL
          AND state IN ('queued', 'delivered')`,
    )
    .run(text, new Date().toISOString(), messageId);

  if (Number(result.changes) === 0) {
    throw appError('cannot_refuse', 'Only an unaccepted, unprocessed assignment can be refused', 409);
  }

  return db.prepare('SELECT * FROM agent_messages WHERE id = ?').get(messageId) as unknown as AgentMessageRow;
}
