import type { DatabaseSync } from 'node:sqlite';
import * as messageService from '../messages/message.service.ts';
import { executeTask } from '../harnesses/delegation.service.ts';
import { defaultRuntime, type CoreRuntime } from '../harnesses/runtime.ts';
import * as sessionService from '../harnesses/session.service.ts';
import * as taskService from '../harnesses/task.service.ts';
import { cancelTask } from '../harnesses/task.service.ts';
import type { HarnessType } from '../harnesses/types.ts';
import { appError } from '../types/index.ts';
import { assertBudgetAllowsWork, execLeft, usageOf } from './budget.service.ts';
import { createCapabilityResolver } from './capability.service.ts';
import { harnessRunner, runCheckpoint, type CheckpointRunner } from './checkpoint.service.ts';
import { acceptRequest, assignTask, refuseAssignment } from './dispatch.service.ts';
import {
  distinctAssignees,
  findRound,
  inbox,
  recordMessage,
  settleAssignmentState,
  trustedSender,
  type AgentMessageRow,
  type RoundRow,
} from './messages.service.ts';
import {
  contributionText,
  contributorsOf,
  listContributions,
  recordContribution,
  type ContributionRow,
} from './contributions.service.ts';
import { parsePlan, type PlannedAssignment, type PlannedResolution } from './plan.ts';
import {
  listReviews,
  recordUnavailableReview,
  runReview,
  type ReviewRow,
} from './review.service.ts';
import { coordinatorOf, initRound, listRoles } from './roles.service.ts';
import {
  blockRound,
  cancelRound,
  failRound,
  isTerminalStatus,
  resumeRound,
  setRoundStatus,
  touchHop,
  type RoundOutcome,
} from './rounds.service.ts';

/** The exec budget is the real stopping rule; this is the second backstop. */
const MAX_ITERATIONS = 40;
const MAX_REVIEW_CYCLES = 2;
const RESULT_EXCERPT = 2000;
const DELIVERABLE_EXCERPT = 4000;

export interface StartCollaborationInput {
  goal: string;
  coordinator?: string;
  /** Agents the user named; they are the first batch, bypassing the plan turn. */
  targets?: string[];
  contributors?: string[];
  reviewRequired?: boolean;
  budgetHops?: number;
  budgetExec?: number;
  budgetUsageTokens?: number | null;
  /** The user requires at least this many distinct agents to take part. */
  minAssignments?: number;
}

export interface OrchestratorOptions {
  runtime?: CoreRuntime;
  timeoutMs?: number;
  runner?: CheckpointRunner;
  /** Run one coordinator turn even with an empty inbox (user-approved resume). */
  forceCoordinatorTurn?: boolean;
}

export interface RoundSummary {
  roundId: string;
  status: string;
  outcome: string | null;
  /** True when the round stopped on the usage budget and waits for the user. */
  blocked: boolean;
  deliveryMessageId: string | null;
}

export interface StartCollaborationResult {
  round: RoundRow;
  goalMessageId: string;
  completion: Promise<RoundSummary>;
}

/** Only one driver may advance a round at a time, even inside one process. */
const activeDrives = new Set<string>();

type Failure = 'budget_usage' | 'budget_exec' | 'closed' | 'other';

function classify(err: unknown): Failure {
  const code = (err as { code?: string }).code;
  const scope = (err as { scope?: string }).scope;

  if (code === 'round_closed') return 'closed';
  if (code === 'budget_exhausted' && scope === 'usage') return 'budget_usage';
  if (code === 'budget_exhausted') return 'budget_exec';

  return 'other';
}

function isClosed(round: RoundRow): boolean {
  return isTerminalStatus(round.status);
}

function currentRound(db: DatabaseSync, roundId: string): RoundRow {
  const round = findRound(db, roundId);

  if (!round) throw appError('round_not_found', 'Round not found', 404);

  return round;
}

function boundAgents(db: DatabaseSync, conversationId: string): HarnessType[] {
  return sessionService
    .listBindings(db, conversationId)
    .map((row) => row.harness_type)
    .filter(
      (type): type is HarnessType =>
        type === 'claude' || type === 'codex' || type === 'deepseek',
    );
}

function excerpt(text: string | null, limit = RESULT_EXCERPT): string {
  if (text === null) return '（没有文本结果）';

  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function addChat(
  db: DatabaseSync,
  conversationId: string,
  content: string,
  metadata: Record<string, unknown>,
): string | null {
  try {
    return messageService.addMessage(db, conversationId, {
      content,
      message_type: 'system_event',
      sender_kind: 'system',
      metadata,
    }).id;
  } catch {
    // The chat is a projection; losing one line must not stop the round.
    return null;
  }
}

function roundTasks(db: DatabaseSync, roundId: string): taskService.TaskRow[] {
  return db
    .prepare('SELECT * FROM agent_tasks WHERE chain_id = ? ORDER BY created_at, rowid')
    .all(roundId) as unknown as taskService.TaskRow[];
}

function queuedRoundTasks(db: DatabaseSync, roundId: string): taskService.TaskRow[] {
  return db
    .prepare(
      `SELECT * FROM agent_tasks
        WHERE chain_id = ? AND status = 'queued'
        ORDER BY created_at, rowid`,
    )
    .all(roundId) as unknown as taskService.TaskRow[];
}

function assignmentOfTask(
  db: DatabaseSync,
  roundId: string,
  taskId: string,
): AgentMessageRow | undefined {
  return db
    .prepare(
      `SELECT * FROM agent_messages
        WHERE round_id = ? AND task_id = ? AND kind = 'assignment'
        ORDER BY rowid DESC LIMIT 1`,
    )
    .get(roundId, taskId) as AgentMessageRow | undefined;
}

function taskResultText(db: DatabaseSync, task: taskService.TaskRow): string | null {
  if (task.result_message_id === null) return null;

  const row = db
    .prepare('SELECT content FROM messages WHERE id = ?')
    .get(task.result_message_id) as { content: string } | undefined;

  return row?.content ?? null;
}

/**
 * What the round produced, as the reviewer and the integrator read it. Task
 * results and the coordinator's own turns are listed separately, so neither can
 * be mistaken for the other and neither is counted twice.
 */
function buildDeliverable(db: DatabaseSync, roundId: string): string {
  const tasks = roundTasks(db, roundId);
  const contributions = listContributions(db, roundId);
  const sections: string[] = [];

  if (tasks.length > 0) {
    sections.push(
      tasks
        .map((task) => {
          const text = excerpt(taskResultText(db, task), DELIVERABLE_EXCERPT);
          const state =
            task.status === 'completed'
              ? '已完成'
              : `${task.status}${task.error_text ? `：${task.error_text}` : ''}`;

          return `- ${task.target_agent}（${task.task_type}，${state}）：${text}`;
        })
        .join('\n\n'),
    );
  }

  if (contributions.length > 0) {
    sections.push(
      [
        '协调者与其他 Agent 在自己回合中的输出：',
        ...contributions.map(
          (row) =>
            `- ${row.agent}（${row.phase}）：${excerpt(row.content, DELIVERABLE_EXCERPT)}`,
        ),
      ].join('\n'),
    );
  }

  return sections.length === 0 ? '（本轮没有产生可交付内容）' : sections.join('\n\n');
}

function budgetLine(db: DatabaseSync, round: RoundRow): string {
  const usage = usageOf(db, round.id);
  const tokens =
    round.budget_usage_tokens === null
      ? `${usage.tokens ?? 0} tokens（不限）`
      : `${usage.tokens ?? 0} / ${round.budget_usage_tokens} tokens`;

  return `预算：传播 ${round.hops_used}/${round.budget_hops} 跳；执行 ${round.exec_used}/${round.budget_exec} 回合；用量 ${tokens}`;
}

function outcomeOf(input: {
  tasks: taskService.TaskRow[];
  contributions: ContributionRow[];
  review: ReviewRow | null;
  reviewRequired: boolean;
  stoppedOnBudget: boolean;
}): RoundOutcome {
  const completed = input.tasks.filter((task) => task.status === 'completed').length;
  const unfinished = input.tasks.filter((task) => task.status !== 'completed').length;
  // The coordinator's own turn is real output even when no task exists.
  const hasOutput = completed > 0 || input.contributions.length > 0;

  if (!hasOutput && (unfinished > 0 || input.stoppedOnBudget)) return 'failed';

  const reviewNotPassed =
    input.reviewRequired && (input.review === null || input.review.status !== 'pass');

  if (unfinished > 0 || input.stoppedOnBudget || reviewNotPassed) return 'partially_completed';

  return 'completed';
}

function deliveryText(
  db: DatabaseSync,
  round: RoundRow,
  outcome: RoundOutcome,
  review: ReviewRow | null,
): string {
  const tasks = roundTasks(db, round.id);
  const contributions = listContributions(db, round.id);
  const done = tasks.filter((task) => task.status === 'completed');
  const missing = tasks.filter((task) => task.status !== 'completed');

  const doneLines = [
    ...done.map((task) => `- ${task.target_agent}（${task.task_type}）：${task.title}`),
    ...contributions.map(
      (row) =>
        `- ${row.agent}（${row.phase === 'planning' ? '协调者输出' : row.phase}）：${excerpt(row.content, 120)}`,
    ),
  ];

  const lines = [
    `【协作交付】${round.goal}`,
    `结论：${outcome}`,
    '',
    doneLines.length === 0 ? '完成：无' : `完成：\n${doneLines.join('\n')}`,
    missing.length === 0
      ? null
      : `未完成：\n${missing
          .map(
            (task) =>
              `- ${task.target_agent}（${task.task_type}）：${task.status}${task.error_text ? ` — ${task.error_text}` : ''}`,
          )
          .join('\n')}`,
    review === null
      ? round.review_required === 1
        ? '审查：未执行'
        : '审查：本轮未要求独立审查'
      : review.status === 'review_unavailable'
        ? '审查：不可用（本轮未经独立审查）'
        : `审查：${review.status}${review.reviewer ? `（${review.reviewer}）` : ''}`,
    budgetLine(db, round),
  ];

  return lines.filter((line): line is string => line !== null).join('\n');
}

interface ExecutedTask {
  assignment: AgentMessageRow | null;
  task: taskService.TaskRow;
  resultText: string | null;
}

interface RunContext {
  db: DatabaseSync;
  round: RoundRow;
  coordinator: HarnessType;
  runner: CheckpointRunner;
  runtime: CoreRuntime;
  capability: ReturnType<typeof createCapabilityResolver>;
  /** Set by anything that stopped new work: hops, exec or usage. */
  stoppedOnBudget: boolean;
  usageExhausted: boolean;
  execExhausted: boolean;
  /** New propagation was refused because the hop budget is spent. */
  hopLimitReached: boolean;
  stopBudget: (kind: 'exec' | 'usage' | 'hops') => void;
}

function executeOne(
  ctx: RunContext,
  task: taskService.TaskRow,
  assignment: AgentMessageRow | null,
): Promise<ExecutedTask> {
  return executeTask(ctx.db, task, {
    adapter: ctx.runtime.getAdapter(task.target_agent),
    prompt: taskPrompt(ctx.round, task.target_agent as HarnessType, task.instruction),
    roundId: ctx.round.id,
  }).then((settled) => ({
    assignment,
    task: settled.task,
    resultText: settled.resultText ?? taskResultText(ctx.db, settled.task),
  }));
}

/**
 * Dispatches a plan's assignments and runs them concurrently. The first batch
 * of a round is the parallel one; every agent works from the same snapshot.
 */
async function runBatch(
  ctx: RunContext,
  assignments: readonly PlannedAssignment[],
  /**
   * The message this batch answers. Chaining it is what makes `hop` a pass
   * counter: without a parent every assignment would start at hop 1 and the
   * budget would never move.
   */
  parentMessageId: string | null = null,
): Promise<ExecutedTask[]> {
  const prepared: Array<{ assignment: AgentMessageRow; task: taskService.TaskRow }> = [];

  for (const planned of assignments) {
    if (isClosed(currentRound(ctx.db, ctx.round.id))) break;

    try {
      assertBudgetAllowsWork(ctx.db, ctx.round.id);
    } catch (err) {
      ctx.stopBudget(classify(err) === 'budget_usage' ? 'usage' : 'exec');
      break;
    }

    try {
      const created = assignTask(ctx.db, {
        roundId: ctx.round.id,
        actor: ctx.coordinator,
        target: planned.to,
        instruction: planned.task,
        reason: planned.reason,
        taskType: planned.type,
        capability: ctx.capability,
        parentMessageId,
      });

      prepared.push({ assignment: created.message, task: created.task });
    } catch (err) {
      const failure = classify(err);

      if (failure === 'budget_usage') {
        ctx.stopBudget('usage');
        break;
      }

      if (failure === 'budget_exec') {
        // Only the hop guard raises this here; exec is claimed above.
        ctx.hopLimitReached = true;
        ctx.stopBudget('hops');
        break;
      }

      // One refused assignment must not stop the rest of the batch.
      addChat(
        ctx.db,
        ctx.round.conversation_id,
        `指派给 ${planned.to} 没有成立：${err instanceof Error ? err.message : String(err)}`,
        { collab_round_id: ctx.round.id, reason: 'assignment_refused' },
      );
    }
  }

  return Promise.all(
    prepared.map((item) => executeOne(ctx, item.task, item.assignment)),
  );
}

/** Tasks a checkpoint delegated via MCP, already queued in this round. */
async function runQueued(ctx: RunContext): Promise<ExecutedTask[]> {
  const prepared: Array<{ assignment: AgentMessageRow | null; task: taskService.TaskRow }> = [];

  for (const task of queuedRoundTasks(ctx.db, ctx.round.id)) {
    try {
      assertBudgetAllowsWork(ctx.db, ctx.round.id);
    } catch (err) {
      ctx.stopBudget(classify(err) === 'budget_usage' ? 'usage' : 'exec');
      break;
    }

    prepared.push({ assignment: assignmentOfTask(ctx.db, ctx.round.id, task.id) ?? null, task });
  }

  return Promise.all(prepared.map((item) => executeOne(ctx, item.task, item.assignment)));
}

/**
 * A notice is how a result travels back to the coordinator. Hop exhaustion does
 * not undo the task — it only means the result is not relayed (§6.4).
 */
function noticeTo(
  ctx: RunContext,
  from: HarnessType,
  to: HarnessType,
  content: string,
  parentMessageId: string | null,
): boolean {
  try {
    let hop = 1;

    if (parentMessageId !== null) {
      const parent = ctx.db
        .prepare('SELECT hop FROM agent_messages WHERE id = ?')
        .get(parentMessageId) as { hop: number } | undefined;
      hop = (parent?.hop ?? 0) + 1;
    }

    // A result is not new propagation: the hop budget stops the coordinator
    // from starting more work, never a finished task from reporting back.
    const sender = trustedSender(ctx.db, ctx.round.conversation_id, from);

    recordMessage(ctx.db, sender, {
      roundId: ctx.round.id,
      kind: 'notice',
      toAgent: to,
      content: content.length > 8000 ? `${content.slice(0, 8000)}…` : content,
      parentMessageId,
      hop,
    });

    touchHop(ctx.db, ctx.round.id, hop);
    return true;
  } catch (err) {
    if (classify(err) === 'budget_exec') ctx.stopBudget('hops');
    return false;
  }
}

/**
 * The coordinator's answer to a peer's request. Accepting turns the request into
 * a task for the coordinator itself; the next loop iteration runs it. Refusing
 * sends the reason back to the requester — a refusal is never silent.
 */
function applyResolutions(ctx: RunContext, resolutions: readonly PlannedResolution[]): number {
  let accepted = 0;

  for (const resolution of resolutions) {
    const pending = ctx.db
      .prepare(
        `SELECT * FROM agent_messages
          WHERE round_id = ? AND kind = 'assignment' AND to_agent = ? AND from_agent = ?
            AND task_id IS NULL AND state IN ('queued', 'delivered')
          ORDER BY created_at, rowid LIMIT 1`,
      )
      .get(ctx.round.id, ctx.coordinator, resolution.from) as AgentMessageRow | undefined;

    if (!pending) continue;

    if (resolution.decision === 'accept') {
      try {
        acceptRequest(ctx.db, pending.id);
        accepted += 1;
      } catch (err) {
        addChat(
          ctx.db,
          ctx.round.conversation_id,
          `接受 ${resolution.from} 的请求失败：${err instanceof Error ? err.message : String(err)}`,
          { collab_round_id: ctx.round.id, reason: 'request_accept_failed' },
        );
      }

      continue;
    }

    try {
      refuseAssignment(ctx.db, pending.id, resolution.reason);
      noticeTo(ctx, ctx.coordinator, resolution.from, `请求被拒绝：${resolution.reason}`, null);
    } catch (err) {
      addChat(
        ctx.db,
        ctx.round.conversation_id,
        `拒绝 ${resolution.from} 的请求失败：${err instanceof Error ? err.message : String(err)}`,
        { collab_round_id: ctx.round.id, reason: 'request_refuse_failed' },
      );
    }
  }

  return accepted;
}

function recordResults(ctx: RunContext, executed: readonly ExecutedTask[]): void {
  // A cancelled round keeps the results it already produced but must not wake a
  // coordinator that is no longer leading anything. The assignment's own state
  // still settles, otherwise it would stay "running" forever.
  const closed = isClosed(currentRound(ctx.db, ctx.round.id));

  for (const item of executed) {
    const { task } = item;

    if (closed) {
      if (item.assignment) {
        settleAssignmentState(
          ctx.db,
          item.assignment.id,
          task.status === 'completed' ? 'task_completed' : 'task_failed',
        );
      }

      continue;
    }

    if (task.status === 'completed') {
      if (item.assignment) settleAssignmentState(ctx.db, item.assignment.id, 'task_completed');

      // The result reached the round; leaving its delivery pending would make
      // the restart sweep report completed work as undelivered.
      taskService.setDeliveryStatus(ctx.db, task.id, 'delivered');

      addChat(ctx.db, ctx.round.conversation_id, `${task.target_agent} 完成了任务：${task.title}`, {
        collab_round_id: ctx.round.id,
        task_id: task.id,
        reason: 'collab_task_completed',
      });

      if (task.target_agent !== ctx.coordinator) {
        noticeTo(
          ctx,
          task.target_agent as HarnessType,
          ctx.coordinator,
          `任务「${task.title}」已完成。结果：${excerpt(item.resultText)}`,
          item.assignment?.id ?? null,
        );
      }
    } else {
      if (item.assignment) settleAssignmentState(ctx.db, item.assignment.id, 'task_failed');

      taskService.setDeliveryStatus(ctx.db, task.id, 'failed');

      addChat(
        ctx.db,
        ctx.round.conversation_id,
        `${task.target_agent} 的任务没有完成：${task.title}（${task.status}${task.error_text ? `：${task.error_text}` : ''}）`,
        { collab_round_id: ctx.round.id, task_id: task.id, reason: 'collab_task_failed' },
      );

      if (task.target_agent !== ctx.coordinator) {
        noticeTo(
          ctx,
          task.target_agent as HarnessType,
          ctx.coordinator,
          `任务「${task.title}」失败（${task.status}）：${task.error_text ?? '没有错误信息'}`,
          item.assignment?.id ?? null,
        );
      }
    }
  }
}

function planningPrompt(round: RoundRow, coordinator: HarnessType, known: HarnessType[]): string {
  const others = known.filter((agent) => agent !== coordinator);

  return [
    '[协作规划]',
    `本轮目标：${round.goal}`,
    `你是 ${coordinator}，本轮协调者。`,
    `可以参与本轮工作的 Agent：${known.join('、')}。`,
    others.length === 0
      ? '本轮只有你一个 Agent：请直接开始完成目标。'
      : `除你之外的可用 Agent：${others.join('、')}。`,
    round.min_assignments > 0
      ? `用户明确要求：本轮至少要由 ${round.min_assignments} 个不同的 Agent 分工完成，你必须用 assign 把工作分出去，不能替其他 Agent 完成他们的部分。`
      : null,
    `预算：传播 ${round.budget_hops} 跳；执行 ${round.budget_exec} 个回合。`,
    '',
    '请先判断如何完成目标。需要别人做时，最后输出一个 ```collab JSON 块（最多 3 个并行任务）：',
    '{"assign":[{"to":"claude","task":"要做什么","type":"research","reason":"为什么"}],"done":false}',
    '不需要分工、或需要一次性结束本轮时输出：{"assign":[],"done":true}',
    '你现在生成的内容本身会被保留，请把它写成对目标有用的阶段性成果。',
    '[/协作规划]',
  ]
    .filter((line): line is string => line !== null)
    .join('\n');
}

interface Shortfall {
  required: number;
  actual: number;
}

/** How far the round is from the user's stated minimum participation. */
function shortfallOf(
  db: DatabaseSync,
  roundId: string,
  planned: readonly HarnessType[] = [],
): Shortfall | null {
  const round = findRound(db, roundId);

  if (!round || round.min_assignments <= 0) return null;

  const agents = new Set<string>([...distinctAssignees(db, roundId), ...planned]);

  if (agents.size >= round.min_assignments) return null;

  return { required: round.min_assignments, actual: agents.size };
}

function replanPrompt(round: RoundRow, shortfall: Shortfall): string {
  return [
    '[协作规划修正]',
    `本轮目标：${round.goal}`,
    `用户明确要求至少由 ${shortfall.required} 个不同的 Agent 分工完成。`,
    `你刚才的计划没有满足：目前只有 ${shortfall.actual} 个 Agent 参与。`,
    '',
    '请重新规划，用 assign 把工作分给其他 Agent（最多 3 个并行任务）。',
    '如果你确实无法满足这个要求，请直接说明原因并输出 {"assign":[],"done":true}；',
    'Core 会把本轮标记为等待用户决定，不会把没有满足要求的结果当成完成。',
    '格式：{"assign":[{"to":"claude","task":"要做什么","type":"general","reason":"为什么"}],"done":false}',
    '[/协作规划修正]',
  ].join('\n');
}

/** The furthest message in a batch is the one a new pass continues from. */
function highestHop(messages: readonly AgentMessageRow[]): string | null {
  let best: AgentMessageRow | null = null;

  for (const message of messages) {
    if (best === null || message.hop > best.hop) best = message;
  }

  return best?.id ?? null;
}

function resumePrompt(db: DatabaseSync, round: RoundRow, coordinator: HarnessType): string {
  const tasks = roundTasks(db, round.id);

  return [
    '[协作续接]',
    `本轮目标：${round.goal}`,
    `你是 ${coordinator}，本轮协调者。`,
    '本轮之前因为消息传播达到上限被暂停，用户已经提高了传播预算，现在可以继续。',
    `已有任务：${
      tasks.length === 0
        ? '无'
        : tasks.map((task) => `${task.target_agent}（${task.status}）`).join('、')
    }`,
    '',
    '请决定下一步：继续指派（assign）、处理他人请求（resolve），或结束本轮（done）。',
    '格式：{"assign":[{"to":"claude","task":"要做什么","type":"general","reason":"为什么"}],"done":false}',
    '没有后续动作时输出 {"assign":[],"done":true}。',
    '[/协作续接]',
  ].join('\n');
}

function taskPrompt(round: RoundRow, agent: HarnessType, instruction: string): string {
  return [
    '[协作任务]',
    `本轮目标：${round.goal}`,
    `你（${agent}）负责：${instruction}`,
    '',
    '请完成上面的工作，并把结果作为你的最终回答输出。不要只描述计划。',
    '[/协作任务]',
  ].join('\n');
}

function integrationPrompt(round: RoundRow, deliverable: string, review: ReviewRow | null): string {
  return [
    '[协作交付]',
    `本轮目标：${round.goal}`,
    '',
    '已完成的工作与结果：',
    deliverable,
    '',
    review === null
      ? '本轮没有独立审查记录。'
      : `审查结论：${review.status}${review.reviewer ? `（审查者 ${review.reviewer}）` : ''}`,
    '',
    '请整合成一份给用户的最终交付：完成了什么、没有完成什么、为什么。',
    '不要重新派发任务，也不要假装完成了没有完成的部分。',
    '[/协作交付]',
  ].join('\n');
}

function findingsText(review: ReviewRow): string {
  if (review.findings_json === null) return '（没有具体条目）';

  try {
    const parsed = JSON.parse(review.findings_json) as unknown;
    return Array.isArray(parsed)
      ? parsed.map((item) => `- ${String(item)}`).join('\n')
      : String(parsed);
  } catch {
    return review.findings_json;
  }
}

/**
 * Chat messages are signed with the adapter's display name ("Codex"), not the
 * harness type ("codex"); matching on the type would silently find nothing.
 */
const DISPLAY_NAME: Record<HarnessType, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  deepseek: 'DeepSeek Harness',
};

function lastFinalMessageId(
  db: DatabaseSync,
  conversationId: string,
  agent: HarnessType,
): string | null {
  const row = db
    .prepare(
      `SELECT id FROM messages
        WHERE conversation_id = ? AND message_type = 'agent_final' AND sender_id = ?
        ORDER BY rowid DESC LIMIT 1`,
    )
    .get(conversationId, DISPLAY_NAME[agent]) as { id: string } | undefined;

  return row?.id ?? null;
}

/**
 * Drives one round until it delivers, blocks, or fails. Every fact it needs is
 * in the database, so resuming a blocked round is the same function with the
 * state it finds — nothing survives in memory between chained turns.
 */
async function drive(
  db: DatabaseSync,
  roundId: string,
  options: OrchestratorOptions,
  targets: HarnessType[] = [],
): Promise<RoundSummary> {
  if (activeDrives.has(roundId)) {
    throw appError('round_busy', 'This round is already being driven', 409);
  }

  activeDrives.add(roundId);

  const runner = options.runner ?? harnessRunner(options.runtime ?? defaultRuntime, options.timeoutMs ?? 300_000);
  const runtime = options.runtime ?? defaultRuntime;

  try {
    let round = currentRound(db, roundId);

    if (isClosed(round)) {
      return {
        roundId,
        status: round.status,
        outcome: round.outcome,
        blocked: round.status === 'blocked',
        deliveryMessageId: round.delivery_message_id,
      };
    }

    const coordinator = coordinatorOf(db, roundId) as HarnessType | undefined;
    const conversationId = round.conversation_id;

    if (!coordinator) {
      failRound(db, roundId, 'failed');
      return {
        roundId,
        status: 'failed',
        outcome: 'failed',
        blocked: false,
        deliveryMessageId: null,
      };
    }

    const known = boundAgents(db, conversationId);

    const ctx: RunContext = {
      db,
      round,
      coordinator,
      runner,
      runtime,
      capability: createCapabilityResolver(db, conversationId),
      stoppedOnBudget: false,
      stopBudget: (kind) => {
        ctx.stoppedOnBudget = true;

        if (kind === 'usage') ctx.usageExhausted = true;
        if (kind === 'exec') ctx.execExhausted = true;
      },
      usageExhausted: false,
      execExhausted: false,
      hopLimitReached: false,
    };

    if (round.status === 'created') round = setRoundStatus(db, roundId, 'planning');

    // A round the user asked to be shared may not finish with fewer agents than
    // requested. The coordinator is asked once more; if it still does not comply,
    // the round waits for the user instead of pretending it is done.
    let replanned = false;

    const blockedSummary = (): RoundSummary => ({
      roundId,
      status: 'blocked',
      outcome: null,
      blocked: true,
      deliveryMessageId: null,
    });

    const blockForDelegation = (
      reason: string,
      phase: 'planning' | 'checkpoint',
    ): { blocked: RoundSummary } => {
      blockRound(db, roundId, {
        reason,
        wakeCondition: 'user_decision',
        phase: phase === 'planning' ? 'planning' : 'work',
      });
      addChat(db, conversationId, `本轮暂停：${reason}。可以在协作页放宽要求后继续。`, {
        collab_round_id: roundId,
        reason: 'delegation_requirement_unmet',
      });

      return { blocked: blockedSummary() };
    };

    const enforceDelegation = async (
      plan: ReturnType<typeof parsePlan>,
      phase: 'planning' | 'checkpoint',
      rawText: string,
    ): Promise<{ plan: ReturnType<typeof parsePlan> } | { blocked: RoundSummary }> => {
      if (!plan.done) return { plan };

      const shortfall = shortfallOf(
        db,
        roundId,
        plan.assignments.map((item) => item.to),
      );

      if (!shortfall) return { plan };

      // The coordinator's own words are what "cannot do it" sounds like; a
      // deterministic reason alone would hide them from the user.
      const explanation = contributionText(rawText);
      const unmet = [
        `用户要求至少 ${shortfall.required} 个 Agent 分工，协调者只派出了 ${shortfall.actual} 个`,
        explanation === '' ? null : `协调者说明：${excerpt(explanation, 120)}`,
      ]
        .filter((part): part is string => part !== null)
        .join('；');

      // Nobody at all has been assigned: the coordinator chose to do everything
      // itself. Paying for a second planning turn to hear the same answer is the
      // expensive path this rule exists to avoid; the user decides instead.
      if (shortfall.actual === 0) return blockForDelegation(unmet, phase);

      if (replanned) return blockForDelegation(unmet, phase);

      replanned = true;

      try {
        assertBudgetAllowsWork(db, roundId);
      } catch (err) {
        if (classify(err) === 'budget_usage') {
          blockRound(db, roundId, {
            reason: '用量预算已耗尽',
            wakeCondition: 'user_approval',
            phase: phase === 'planning' ? 'planning' : 'work',
          });

          return { blocked: blockedSummary() };
        }

        return blockForDelegation(`${unmet}；执行预算已耗尽，无法重新规划`, phase);
      }

      const retried = await runner({
        db,
        agent: coordinator,
        conversationId,
        roundId,
        prompt: replanPrompt(currentRound(db, roundId), shortfall),
      }).catch(() => ({ ok: false, text: null }));

      if (retried.ok && retried.text !== null) {
        recordContribution(db, {
          roundId,
          agent: coordinator,
          phase: 'rework',
          text: retried.text,
          messageId: lastFinalMessageId(db, conversationId, coordinator),
        });

        const next = parsePlan(retried.text, known, coordinator);

        if (!next.done) return { plan: next };

        const still = shortfallOf(
          db,
          roundId,
          next.assignments.map((item) => item.to),
        );

        if (!still) return { plan: next };

        return blockForDelegation(
          `用户要求至少 ${still.required} 个 Agent 分工，协调者仍然只派出了 ${still.actual} 个`,
          phase,
        );
      }

      return blockForDelegation(`${unmet}；重新规划没有产出可用计划`, phase);
    };

    // ---- 1. the first move: the user's named agents, or the coordinator ----
    let batch: PlannedAssignment[] = [];
    let planningFailed = false;

    if (round.status === 'planning') {
      if (targets.length > 0) {
        batch = targets.map((agent) => ({
          to: agent,
          task: round.goal,
          type: 'general',
          reason: '用户点名，优先级最高',
        }));
      } else {
        try {
          assertBudgetAllowsWork(db, roundId);
        } catch (err) {
          const failure = classify(err);

          if (failure === 'budget_usage') {
            blockRound(db, roundId, {
              reason: '用量预算已耗尽',
              wakeCondition: 'user_approval',
            });
            return { roundId, status: 'blocked', outcome: null, blocked: true, deliveryMessageId: null };
          }

          ctx.stoppedOnBudget = true;
          ctx.execExhausted = true;
        }

        if (!ctx.stoppedOnBudget) {
          const planned = await runner({
            db,
            agent: coordinator,
            conversationId,
            roundId,
            prompt: planningPrompt(round, coordinator, known),
          }).catch(() => ({ ok: false, text: null }));

          if (planned.ok && planned.text !== null) {
            recordContribution(db, {
              roundId,
              agent: coordinator,
              phase: 'planning',
              text: planned.text,
              messageId: lastFinalMessageId(db, conversationId, coordinator),
            });

            const guarded = await enforceDelegation(
              parsePlan(planned.text, known, coordinator),
              'planning',
              planned.text,
            );

            if ('blocked' in guarded) return guarded.blocked;

            batch = guarded.plan.assignments;
          } else {
            planningFailed = true;
          }
        }
      }

      round = currentRound(db, roundId);

      if (isClosed(round)) {
        return {
          roundId,
          status: round.status,
          outcome: round.outcome,
          blocked: false,
          deliveryMessageId: round.delivery_message_id,
        };
      }

      if (planningFailed) {
        failRound(db, roundId, 'failed');
        addChat(db, conversationId, '协调者的规划回合失败，本轮无法开始。', {
          collab_round_id: roundId,
          reason: 'planning_failed',
        });

        return { roundId, status: 'failed', outcome: 'failed', blocked: false, deliveryMessageId: null };
      }

      round = setRoundStatus(db, roundId, 'running');
      ctx.round = round;
    }

    // ---- 2. work loop ------------------------------------------------------
    let iterations = 0;
    // The message this batch answers, so hop keeps growing along the chain.
    let batchParent: string | null = null;
    let forcedTurnUsed = false;

    const blockForPropagation = (): RoundSummary => {
      const reason = `propagation_limit_reached：本轮传播 hop 已达上限 ${currentRound(db, roundId).budget_hops}，协调者无法继续传递`;

      blockRound(db, roundId, {
        reason,
        wakeCondition: 'propagation_limit',
        phase: 'work',
      });
      addChat(db, conversationId, reason, {
        collab_round_id: roundId,
        reason: 'propagation_limit_reached',
      });

      return blockedSummary();
    };

    while (iterations < MAX_ITERATIONS) {
      iterations += 1;

      round = currentRound(db, roundId);
      ctx.round = round;

      if (isClosed(round)) break;

      if (batch.length > 0) {
        const executed = await runBatch(ctx, batch, batchParent);

        batch = [];
        batchParent = null;
        recordResults(ctx, executed);

        if (ctx.hopLimitReached) return blockForPropagation();

        continue;
      }

      if (queuedRoundTasks(db, roundId).length > 0) {
        const executed = await runQueued(ctx);

        recordResults(ctx, executed);
        continue;
      }

      const waiting = inbox(db, conversationId, coordinator, roundId);
      const forced =
        options.forceCoordinatorTurn === true && !forcedTurnUsed && waiting.length === 0;

      if (waiting.length === 0 && !forced) break;

      try {
        assertBudgetAllowsWork(db, roundId);
      } catch (err) {
        const failure = classify(err);

        if (failure === 'budget_usage') {
          blockRound(db, roundId, {
            reason: '用量预算已耗尽',
            wakeCondition: 'user_approval',
          });
          return { roundId, status: 'blocked', outcome: null, blocked: true, deliveryMessageId: null };
        }

        ctx.stoppedOnBudget = true;
        ctx.execExhausted = true;
        break;
      }

      let text: string | null = null;
      let prompted: AgentMessageRow[] = [];

      if (forced) {
        // The user raised the propagation ceiling; the coordinator gets one
        // explicit turn to continue, even though its inbox is empty.
        forcedTurnUsed = true;

        const continued = await runner({
          db,
          agent: coordinator,
          conversationId,
          roundId,
          prompt: resumePrompt(db, currentRound(db, roundId), coordinator),
        }).catch(() => ({ ok: false, text: null }));

        if (!continued.ok || continued.text === null) break;

        text = continued.text;
      } else {
        const checkpoint = await runCheckpoint(db, { roundId, agent: coordinator, runner });

        if (!checkpoint.ran || !checkpoint.ok || checkpoint.text === null) break;

        text = checkpoint.text;
        prompted = checkpoint.messages;
      }

      recordContribution(db, {
        roundId,
        agent: coordinator,
        phase: 'checkpoint',
        text,
        messageId: lastFinalMessageId(db, conversationId, coordinator),
      });

      const guarded = await enforceDelegation(
        parsePlan(text, known, coordinator),
        'checkpoint',
        text,
      );

      if ('blocked' in guarded) return guarded.blocked;

      const plan = guarded.plan;
      const accepted = applyResolutions(ctx, plan.resolutions);

      if (plan.assignments.length === 0) {
        if (plan.done && accepted === 0) break;
        if (accepted > 0) continue;
        break;
      }

      batch = plan.assignments;
      batchParent = highestHop(prompted);
    }

    // A task that failed already says the round cannot be complete; the
    // coordinator still decides whether to rework, so we do not stop here.

    // ---- 3. review ---------------------------------------------------------
    round = currentRound(db, roundId);
    ctx.round = round;

    if (isClosed(round)) {
      return {
        roundId,
        status: round.status,
        outcome: round.outcome,
        blocked: false,
        deliveryMessageId: round.delivery_message_id,
      };
    }

    let review: ReviewRow | null = null;
    const settledTasks = roundTasks(db, roundId);
    const contributions = listContributions(db, roundId);
    // A coordinator that produced the deliverable itself is a producer too: its
    // text is reviewable even though it has no task id.
    const producers = [
      ...new Set([
        ...settledTasks
          .filter((task) => task.status === 'completed')
          .map((task) => task.target_agent),
        ...contributorsOf(db, roundId),
      ]),
    ] as HarnessType[];

    if (round.review_required === 1 && (settledTasks.length > 0 || contributions.length > 0)) {
      round = setRoundStatus(db, roundId, 'reviewing');
      ctx.round = round;

      let cycles = 0;

      while (cycles < MAX_REVIEW_CYCLES) {
        cycles += 1;

        try {
          assertBudgetAllowsWork(db, roundId);
        } catch (err) {
          if (classify(err) === 'budget_usage') {
            blockRound(db, roundId, {
              reason: '用量预算已耗尽（审查阶段）',
              wakeCondition: 'user_approval',
              phase: 'review',
            });
            return { roundId, status: 'blocked', outcome: null, blocked: true, deliveryMessageId: null };
          }

          review = recordUnavailableReview(
            db,
            currentRound(db, roundId),
            producers,
            '执行预算耗尽，无法完成独立审查',
          );
          break;
        }

        review = await runReview(db, {
          round: currentRound(db, roundId),
          producers,
          excluded: [coordinator],
          deliverable: buildDeliverable(db, roundId),
          runner,
        });

        if (review.status !== 'needs_changes' || cycles >= MAX_REVIEW_CYCLES) break;

        // Send the findings back; the coordinator decides whether to rework or
        // accept a partial delivery. Either way the decision is on the record.
        const from = (review.reviewer ?? producers[0] ?? coordinator) as HarnessType;
        noticeTo(ctx, from, coordinator, `审查未通过：\n${findingsText(review)}`, null);

        round = setRoundStatus(db, roundId, 'running');
        ctx.round = round;

        try {
          assertBudgetAllowsWork(db, roundId);
        } catch {
          ctx.stoppedOnBudget = true;
          break;
        }

        const checkpoint = await runCheckpoint(db, { roundId, agent: coordinator, runner });

        if (!checkpoint.ran || !checkpoint.ok || checkpoint.text === null) break;

        recordContribution(db, {
          roundId,
          agent: coordinator,
          phase: 'rework',
          text: checkpoint.text,
          messageId: lastFinalMessageId(db, conversationId, coordinator),
        });

        const guarded = await enforceDelegation(
          parsePlan(checkpoint.text, known, coordinator),
          'checkpoint',
          checkpoint.text,
        );

        if ('blocked' in guarded) return guarded.blocked;

        const plan = guarded.plan;
        const accepted = applyResolutions(ctx, plan.resolutions);

        if (plan.assignments.length === 0) {
          if (accepted === 0) break;

          // An accepted request became a queued task for the coordinator; run it
          // before the next review rather than dropping it.
          recordResults(ctx, await runQueued(ctx));
          round = setRoundStatus(db, roundId, 'reviewing');
          ctx.round = round;
          continue;
        }

        const executed = await runBatch(ctx, plan.assignments, highestHop(checkpoint.messages));

        recordResults(ctx, executed);

        if (ctx.hopLimitReached) return blockForPropagation();

        round = setRoundStatus(db, roundId, 'reviewing');
        ctx.round = round;
      }
    }

    // ---- 4. delivery -------------------------------------------------------
    round = currentRound(db, roundId);
    ctx.round = round;

    if (isClosed(round)) {
      return {
        roundId,
        status: round.status,
        outcome: round.outcome,
        blocked: false,
        deliveryMessageId: round.delivery_message_id,
      };
    }

    const finalTasks = roundTasks(db, roundId);
    const finalContributions = listContributions(db, roundId);
    let outcome = outcomeOf({
      tasks: finalTasks,
      contributions: finalContributions,
      review,
      reviewRequired: round.review_required === 1,
      stoppedOnBudget: ctx.stoppedOnBudget,
    });

    // Backstop: the round may never call itself complete while it is still
    // below the participation its user asked for.
    if (
      outcome === 'completed' &&
      round.min_assignments > 0 &&
      distinctAssignees(db, roundId).length < round.min_assignments
    ) {
      outcome = 'partially_completed';
    }

    // The coordinator integrates the real results into the user-facing text.
    // This is the last turn; it is skipped when nothing is left to spend.
    if (outcome !== 'failed' && execLeft(db, roundId) > 0) {
      try {
        assertBudgetAllowsWork(db, roundId);

        await runner({
          db,
          agent: coordinator,
          conversationId,
          roundId,
          prompt: integrationPrompt(round, buildDeliverable(db, roundId), review),
        });
      } catch (err) {
        if (classify(err) === 'budget_usage') {
          blockRound(db, roundId, {
            reason: '用量预算已耗尽（交付阶段）',
            wakeCondition: 'user_approval',
          });

          return { roundId, status: 'blocked', outcome: null, blocked: true, deliveryMessageId: null };
        }

        // Integration is presentation; any other failure does not change facts.
      }
    }

    // The integration turn just spent a turn; the delivery line must report the
    // row as it stands now, not the snapshot taken before that turn.
    const summaryId = addChat(db, conversationId, deliveryText(db, currentRound(db, roundId), outcome, review), {
      collab_round_id: roundId,
      collab_delivery: true,
      outcome,
      ...(review ? { review_status: review.status } : {}),
    });

    if (outcome === 'failed') {
      try {
        failRound(db, roundId, 'failed');
      } catch {
        // Already terminal by another writer.
      }
    } else {
      try {
        setRoundStatus(db, roundId, 'delivered', { outcome });
      } catch {
        // Already terminal by another writer (for example a user cancellation).
      }
    }

    // The structured summary is the delivery of record; the coordinator's
    // integration prose stays in the chat as its own message.
    if (summaryId !== null) {
      db.prepare('UPDATE collab_rounds SET delivery_message_id = ? WHERE id = ?').run(
        summaryId,
        roundId,
      );
    }

    const settled = currentRound(db, roundId);

    return {
      roundId,
      status: settled.status,
      outcome: settled.outcome,
      blocked: false,
      deliveryMessageId: settled.delivery_message_id,
    };
  } catch (err) {
    const failure = classify(err);
    const round = findRound(db, roundId);

    if (round && !isClosed(round)) {
      if (failure === 'budget_usage') {
        blockRound(db, roundId, { reason: '用量预算已耗尽', wakeCondition: 'user_approval' });

        return { roundId, status: 'blocked', outcome: null, blocked: true, deliveryMessageId: null };
      }

      try {
        failRound(db, roundId, 'failed');
      } catch {
        // The round was closed by someone else while this branch ran.
      }
    }

    const closed = findRound(db, roundId);

    return {
      roundId,
      status: closed?.status ?? 'failed',
      outcome: closed?.outcome ?? 'failed',
      blocked: closed?.status === 'blocked',
      deliveryMessageId: closed?.delivery_message_id ?? null,
    };
  } finally {
    activeDrives.delete(roundId);
  }
}

/**
 * Creates a round and starts it. The goal is written to the chat first, so the
 * user can always see what was asked even if every agent fails.
 */
export function startCollaboration(
  db: DatabaseSync,
  conversationId: string,
  input: StartCollaborationInput,
  options: OrchestratorOptions = {},
): StartCollaborationResult {
  const goal = input.goal.trim();

  if (goal === '') throw appError('invalid_goal', 'goal must not be empty', 400);
  if (goal.length > taskService.MAX_INSTRUCTION_LENGTH) {
    throw appError('invalid_goal', 'goal is too long', 400);
  }

  const known = boundAgents(db, conversationId);

  if (known.length === 0) {
    throw appError('no_bound_agent', 'No agent is bound to this conversation', 409);
  }

  const targets = (input.targets ?? []).filter((agent): agent is HarnessType =>
    known.includes(agent as HarnessType),
  );

  const explicit = input.coordinator;

  if (explicit !== undefined && !known.includes(explicit as HarnessType)) {
    throw appError('invalid_coordinator', `${explicit} is not bound to this conversation`, 400);
  }

  const active = sessionService.findActiveSession(db, conversationId);

  const coordinator: HarnessType =
    (explicit as HarnessType | undefined) ??
    targets[0] ??
    ((active?.harness_type as HarnessType | undefined) ?? known[0] as HarnessType);

  const contributors = (input.contributors ?? known).filter(
    (agent): agent is HarnessType => known.includes(agent as HarnessType),
  );

  const { round } = initRound(db, {
    conversationId,
    goal,
    coordinator,
    contributors,
    reviewRequired: input.reviewRequired ?? known.length >= 2,
    budgetHops: input.budgetHops,
    budgetExec: input.budgetExec,
    budgetUsageTokens: input.budgetUsageTokens,
    minAssignments: input.minAssignments,
    assignedBy: 'user',
  });

  const goalMessage = messageService.addMessage(db, conversationId, {
    content: goal,
    message_type: 'user_message',
    sender_kind: 'user',
    metadata: { collab_round_id: round.id, coordinator },
  });

  const completion = drive(db, round.id, options, targets).catch(
    (err): RoundSummary => {
      const current = findRound(db, round.id);

      return {
        roundId: round.id,
        status: current?.status ?? 'failed',
        outcome: current?.outcome ?? 'failed',
        blocked: current?.status === 'blocked',
        deliveryMessageId: current?.delivery_message_id ?? null,
        ...(err === undefined ? {} : {}),
      };
    },
  );

  return { round, goalMessageId: goalMessage.id, completion };
}

/**
 * The user's answer to a blocked round. Raising the ceiling and resuming are one
 * step: resuming without a new ceiling would block again on the next turn.
 */
export function resumeCollaboration(
  db: DatabaseSync,
  roundId: string,
  options: {
    budgetUsageTokens?: number;
    budgetHops?: number;
    minAssignments?: number;
    retryPlanning?: boolean;
  },
  orchestrator: OrchestratorOptions = {},
): { round: RoundRow; completion: Promise<RoundSummary> } {
  const round = currentRound(db, roundId);

  if (round.status !== 'blocked') {
    throw appError('invalid_transition', `Round is ${round.status}, not blocked`, 409);
  }

  // A wallet block cannot be resumed without a new ceiling; a requirement block
  // can be resumed by relaxing the requirement instead.
  if (round.wake_condition === 'user_approval') {
    if (options.budgetUsageTokens === undefined) {
      throw appError(
        'invalid_budget_usage_tokens',
        'budget_usage_tokens is required to resume a blocked round',
        400,
      );
    }
  }

  if (round.wake_condition === 'propagation_limit' && options.budgetHops === undefined) {
    throw appError(
      'invalid_budget_hops',
      'budget_hops is required to resume a propagation-limited round',
      400,
    );
  }

  if (options.budgetHops !== undefined) {
    if (!Number.isInteger(options.budgetHops) || options.budgetHops < 1) {
      throw appError('invalid_budget_hops', 'budget_hops must be a positive integer', 400);
    }

    db.prepare('UPDATE collab_rounds SET budget_hops = ? WHERE id = ?').run(
      options.budgetHops,
      roundId,
    );
  }

  if (options.budgetUsageTokens !== undefined) {
    db.prepare('UPDATE collab_rounds SET budget_usage_tokens = ? WHERE id = ?').run(
      options.budgetUsageTokens,
      roundId,
    );
  }

  if (options.minAssignments !== undefined) {
    if (!Number.isInteger(options.minAssignments) || options.minAssignments < 0) {
      throw appError('invalid_min_assignments', 'min_assignments must be a non-negative integer', 400);
    }

    db.prepare('UPDATE collab_rounds SET min_assignments = ? WHERE id = ?').run(
      options.minAssignments,
      roundId,
    );
  }

  // "Ask the coordinator to plan again" is one user-approved planning turn; the
  // round goes back to planning whatever phase it was blocked in.
  const next =
    options.retryPlanning === true || round.blocked_phase === 'planning'
      ? 'planning'
      : round.blocked_phase === 'review'
        ? 'reviewing'
        : 'running';

  resumeRound(db, roundId, next);

  return {
    round: currentRound(db, roundId),
    completion: drive(db, roundId, {
      ...orchestrator,
      ...(round.wake_condition === 'propagation_limit' && next === 'running'
        ? { forceCoordinatorTurn: true }
        : {}),
    }),
  };
}

/** Stops a round and everything still running under it. */
export function cancelCollaboration(
  db: DatabaseSync,
  roundId: string,
  reason = '用户取消本轮协作',
): RoundRow {
  const round = currentRound(db, roundId);

  if (isTerminalStatus(round.status)) {
    throw appError('round_closed', `Round is already ${round.status}`, 409);
  }

  const completed = roundTasks(db, roundId).filter((task) => task.status === 'completed').length;

  for (const task of roundTasks(db, roundId)) {
    if (task.status === 'queued' || task.status === 'running') {
      cancelTask(db, task.id, reason);
    }
  }

  cancelRound(db, roundId, completed > 0 ? 'partially_completed' : 'cancelled');

  addChat(db, round.conversation_id, `本轮协作已取消：${reason}`, {
    collab_round_id: roundId,
    reason: 'collab_cancelled',
  });

  return currentRound(db, roundId);
}

/**
 * Runs an existing round to completion. `startCollaboration` uses it; tests and
 * a future restart recovery use it to continue a round that already exists.
 */
export function driveRound(
  db: DatabaseSync,
  roundId: string,
  options: OrchestratorOptions = {},
): Promise<RoundSummary> {
  return drive(db, roundId, options);
}

/** The round's visible state, for the API and the desktop. */
export function roundDetail(
  db: DatabaseSync,
  roundId: string,
): {
  round: RoundRow;
  roles: ReturnType<typeof listRoles>;
  tasks: taskService.TaskRow[];
  messages: AgentMessageRow[];
  reviews: ReviewRow[];
  contributions: ContributionRow[];
  usage: ReturnType<typeof usageOf>;
} {
  const round = currentRound(db, roundId);

  return {
    round,
    roles: listRoles(db, roundId),
    tasks: roundTasks(db, roundId),
    contributions: listContributions(db, roundId),
    messages: db
      .prepare(
        `SELECT * FROM agent_messages WHERE round_id = ?
          ORDER BY created_at DESC, rowid DESC LIMIT 100`,
      )
      .all(roundId)
      .reverse() as unknown as AgentMessageRow[],
    reviews: listReviews(db, roundId),
    usage: usageOf(db, roundId),
  };
}

export function listRounds(db: DatabaseSync, conversationId: string, limit = 30): RoundRow[] {
  return db
    .prepare(
      `SELECT * FROM collab_rounds WHERE conversation_id = ?
        ORDER BY created_at DESC, rowid DESC LIMIT ?`,
    )
    .all(conversationId, limit) as unknown as RoundRow[];
}

export function listAllRounds(
  db: DatabaseSync,
  limit = 50,
): Array<RoundRow & { conversation_title: string }> {
  return db
    .prepare(
      `SELECT r.*, c.title AS conversation_title
         FROM collab_rounds r
         JOIN conversations c ON c.id = r.conversation_id
        ORDER BY r.created_at DESC, r.rowid DESC
        LIMIT ?`,
    )
    .all(limit) as unknown as Array<RoundRow & { conversation_title: string }>;
}
