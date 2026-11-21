import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { executeTask } from '../harnesses/delegation.service.ts';
import { defaultRuntime, type CoreRuntime } from '../harnesses/runtime.ts';
import * as sessionService from '../harnesses/session.service.ts';
import * as taskService from '../harnesses/task.service.ts';
import type { HarnessType } from '../harnesses/types.ts';
import { appError } from '../types/index.ts';
import * as board from './board.service.ts';

/*
 * The cross-review loop is a user-defined protocol, not a planner:
 *   Codex dispatches → Claude works → DSH verifies → count a round → repeat.
 * The platform only assembles the next prompt, counts verifier reviews, and
 * stops at the limit. It never decides which answer is right.
 */

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const activeLoops = new Set<string>();

const DISPLAY: Record<HarnessType, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  deepseek: 'DeepSeek Harness',
};

const MENTION: Record<HarnessType, string> = {
  claude: 'Claude',
  codex: 'Codex',
  deepseek: 'DSH',
};

export interface CrossReviewOptions {
  runtime?: CoreRuntime;
  timeoutMs?: number;
}

export interface CrossReviewOutcome {
  cardId: string;
  status: 'waiting_user' | 'failed';
  rounds: number;
  summaryMessageId: string | null;
  reason: string | null;
}

export interface CrossReviewStart {
  card: board.CardRow;
  completion: Promise<CrossReviewOutcome>;
}

interface LoopContext {
  db: DatabaseSync;
  card: board.CardRow;
  runtime: CoreRuntime;
  timeoutMs: number;
}

interface TurnResult {
  ok: boolean;
  text: string;
  taskId: string | null;
  messageId: string | null;
}

function boundAgents(db: DatabaseSync, conversationId: string): Set<string> {
  return new Set(
    sessionService.listBindings(db, conversationId).map((row) => row.harness_type),
  );
}

function requireAgents(ctx: LoopContext, agents: HarnessType[]): void {
  const bound = boundAgents(ctx.db, ctx.card.conversation_id);

  for (const agent of new Set(agents)) {
    if (!bound.has(agent)) {
      throw appError('agent_not_bound', `${agent} is not bound to this workspace`, 409);
    }
  }
}

function cardBrief(card: board.CardRow): string {
  const acceptance = parseList(card.acceptance_json);
  const constraints = card.constraints_text?.trim();

  return [
    `卡片：${card.title}`,
    `目标：${card.goal}`,
    acceptance.length === 0 ? null : `验收：${acceptance.join('；')}`,
    constraints ? `约束：${constraints}` : null,
  ]
    .filter((line): line is string => line !== null)
    .join('\n');
}

function parseList(raw: string | null): string[] {
  if (raw === null) return [];

  try {
    const parsed = JSON.parse(raw) as unknown;

    return Array.isArray(parsed) ? parsed.map((item) => String(item)) : [];
  } catch {
    return [];
  }
}

function findingsText(rows: board.FindingRow[]): string {
  if (rows.length === 0) return '（无）';

  return rows.map((row) => `- #${row.id.slice(0, 8)} [${row.status}] ${row.title}`).join('\n');
}

const DISPATCHER_RULES = [
  '[硬规则]',
  '你是本轮决策者，只负责分发。',
  '不要使用任何文件、shell、编辑、网络工具去执行任务；即使知道答案也不要在本轮给出。',
  '需要 Claude 执行时，用 @Claude 点名，并写清做什么、完成标准与边界；不需要时说明原因并结束。',
  '你看不到成员本回合的回复；不得声称任何“已完成”。',
  '[/硬规则]',
].join('\n');

const AUTHOR_RULES = [
  '[硬规则]',
  '你是第一工程师，只完成本轮指派的工作。',
  '可以读文件、修改代码、运行验证；不要重新规划整个目标，不要把工作转给别人。',
  '发现问题立即报告；结束时用 @DSH 交回验证。',
  '不要宣布“通过”，不要替验证者下结论。',
  '[/硬规则]',
].join('\n');

const VERIFIER_RULES = [
  '[硬规则]',
  '你是独立验证者，只读，不修改任何文件，不接管实现。',
  '只核对本轮工作是否满足卡片的验收标准，并指出具体问题。',
  '不要替执行者写代码，不要重新规划目标。',
  '[/硬规则]',
].join('\n');

const SUMMARY_RULES = [
  '[硬规则]',
  '你是本轮决策者，现在只做汇总，不执行任何工作。',
  '只引用记录里真实出现的内容；没有证据的“已完成”不得写入。',
  '可以分析各 Agent 的能力与分工是否合适，并给出下一步建议（建议谁做、为什么）。',
  '建议不是执行：不要派活、不要调用工具、不要声称已经安排。',
  '最后一句必须是“等待用户决定”。',
  '[/硬规则]',
].join('\n');

function dispatcherPrompt(card: board.CardRow): string {
  return [
    '[交叉验证·派发]',
    cardBrief(card),
    '',
    '可用成员：Claude（第一工程师，负责实现与验证）、DSH（独立验证者）。',
    '请判断这项任务是否需要 Claude 执行：',
    '- 需要：用 @Claude 指派，写清做什么、完成标准与边界；',
    '- 不需要：说明原因并结束本轮。',
    '不要自己执行任务，不要给出结果。',
    '[/交叉验证·派发]',
  ].join('\n');
}

function authorPrompt(
  card: board.CardRow,
  round: number,
  previousReview: string,
  findings: board.FindingRow[],
  author: HarnessType,
  verifier: HarnessType,
  userAssigned: boolean,
): string {
  return [
    `[交叉验证·第 ${round} 轮·执行]`,
    cardBrief(card),
    userAssigned ? `用户指定本轮由你（${DISPLAY[author]}）执行。` : null,
    '',
    previousReview === ''
      ? '上一轮验证意见：（这是第一轮）'
      : `上一轮 ${DISPLAY[verifier]} 的验证意见：\n${previousReview}`,
    '',
    '当前未决问题：',
    findingsText(findings),
    '',
    '请完成本轮工作：读必要的文件、给出判断或实现修改、运行你能运行的验证。',
    `结束后用 @${MENTION[verifier]} 交回，并在最后用 \`[已处理] 问题标题\` 逐行标记你认为已处理的问题（标题必须与上面一致）。`,
    '不要宣布通过；不要修改卡片状态。',
    '[/交叉验证·第 ' + String(round) + ' 轮·执行]',
  ]
    .filter((line): line is string => line !== null)
    .join('\n');
}

function verifierPrompt(
  card: board.CardRow,
  round: number,
  authorText: string,
  findings: board.FindingRow[],
  author: HarnessType,
  verifier: HarnessType,
): string {
  return [
    `[交叉验证·第 ${round} 轮·验证]`,
    cardBrief(card),
    '',
    `${DISPLAY[author]} 本轮的工作：\n${authorText.slice(0, 6000)}`,
    '',
    '当前未决问题：',
    findingsText(findings),
    '',
    `你是独立验证者 ${DISPLAY[verifier]}。请只读验证：是否满足验收标准？指出具体问题。不要修改任何文件。`,
    '输出格式（每行一条）：',
    '[问题] 标题 | 详情',
    '[已解决] 问题标题',
    '最后一行写 [通过] 或 [未通过]。',
    '[/交叉验证·第 ' + String(round) + ' 轮·验证]',
  ].join('\n');
}

function summaryPrompt(
  card: board.CardRow,
  authorText: string,
  reviewText: string,
  findings: board.FindingRow[],
): string {
  return [
    '[交叉验证·汇总]',
    cardBrief(card),
    `轮数：${card.cross_round_used} / ${card.cross_round_limit}`,
    '',
    `上一轮 Claude 的工作：\n${authorText.slice(0, 5000)}`,
    '',
    `上一轮 DSH 的验证：\n${reviewText.slice(0, 5000)}`,
    '',
    '未决问题：',
    findingsText(findings),
    '',
    '请汇总：',
    '1. 双方一致与分歧的观点；',
    '2. 本轮实际改了什么（只写记录里出现的）；',
    '3. 未决问题与风险；',
    '4. 结合各 Agent 的能力，评价本次分工是否合适；',
    '5. 给出 2–3 个下一步选项，每个写明建议谁做、为什么。',
    '不要执行、不要派活，最后写“等待用户决定”。',
    '[/交叉验证·汇总]',
  ].join('\n');
}

function markers(text: string): {
  findings: string[];
  resolved: string[];
  addressed: string[];
  passed: boolean;
} {
  const collect = (pattern: RegExp): string[] => {
    const values: string[] = [];

    for (const match of text.matchAll(pattern)) {
      const value = (match[1] ?? '').trim();

      if (value !== '') values.push(value);
    }

    return values;
  };

  return {
    findings: collect(/^\s*\[问题\]\s*(.+)$/gm),
    resolved: collect(/^\s*\[已解决\]\s*(.+)$/gm),
    addressed: collect(/^\s*\[已处理\]\s*(.+)$/gm),
    passed: /^\s*\[通过\]\s*$/m.test(text) && !/^\s*\[未通过\]\s*$/m.test(text),
  };
}

function normalizeTitle(value: string): string {
  return value.trim().toLowerCase();
}

function applyAddressed(
  db: DatabaseSync,
  cardId: string,
  text: string,
  author: HarnessType,
): void {
  const { addressed } = markers(text);

  if (addressed.length === 0) return;

  const open = board.listFindings(db, cardId).filter((row) => row.status === 'open');

  for (const title of addressed) {
    const match = open.find((row) => normalizeTitle(row.title) === normalizeTitle(title));

    if (match) {
      try {
        board.setFindingStatus(db, match.id, 'addressed', author);
      } catch {
        // A finding another writer already moved is not a loop failure.
      }
    }
  }
}

function applyReview(
  db: DatabaseSync,
  cardId: string,
  round: number,
  text: string,
  verifier: HarnessType,
): void {
  const { findings, resolved } = markers(text);

  for (const line of findings) {
    const [rawTitle, ...rest] = line.split('|');
    const title = (rawTitle ?? '').trim();

    if (title === '') continue;

    const detail = rest.join('|').trim();

    try {
      board.addFinding(db, cardId, {
        roundNo: round,
        title,
        detail: detail === '' ? null : detail,
        raisedBy: verifier,
      });
    } catch {
      // Duplicate or malformed finding: keep the round moving.
    }
  }

  const open = board
    .listFindings(db, cardId)
    .filter((row) => row.status === 'open' || row.status === 'addressed');

  for (const title of resolved) {
    const match = open.find((row) => normalizeTitle(row.title) === normalizeTitle(title));

    if (match) {
      try {
        board.setFindingStatus(db, match.id, 'resolved', verifier);
      } catch {
        // Already resolved by another writer.
      }
    }
  }
}

async function runTurn(
  ctx: LoopContext,
  input: {
    agent: HarnessType;
    prompt: string;
    systemAppend: string;
    kind: board.MessageKind;
    sourceAgent: HarnessType | null;
    titleSuffix: string;
  },
): Promise<TurnResult> {
  const { db, card } = ctx;

  let task: taskService.TaskRow;

  try {
    task = taskService.createTask(db, {
      conversationId: card.conversation_id,
      sourceAgent: input.sourceAgent,
      targetAgent: input.agent,
      instruction: input.prompt,
      title: `${card.title.slice(0, 60)} · ${input.titleSuffix}`,
      chainId: card.id,
      taskType: 'cross_review',
      orchestrated: true,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    board.postMessage(db, card.conversation_id, board.boardSystem(db, card.conversation_id), {
      cardId: card.id,
      kind: 'notice',
      content: `无法启动 ${input.agent}：${message}`,
      requestId: randomUUID(),
    });

    return { ok: false, text: '', taskId: null, messageId: null };
  }

  // The rules travel with the prompt for every agent. The Claude CLI silently
  // drops --append-system-prompt on a resumed session, and a role rule that
  // disappears because the conversation already ran once is worse than a
  // duplicated one; the system layer still carries them where it works.
  const prompt = `${input.systemAppend}\n\n${input.prompt}`;

  const result = await executeTask(db, task, {
    adapter: ctx.runtime.getAdapter(input.agent),
    prompt,
    systemAppend: input.systemAppend,
    ...(input.agent === 'claude' ? { allowedTools: ['Read', 'Glob', 'Grep'] } : {}),
    timeoutMs: ctx.timeoutMs,
  });

  if (result.task.status !== 'completed' || result.resultText === null) {
    board.postMessage(db, card.conversation_id, board.boardSystem(db, card.conversation_id), {
      cardId: card.id,
      kind: 'notice',
      content: `${input.agent} 的回合没有完成（${result.task.status}${result.task.error_text ? `：${result.task.error_text}` : ''}）`,
      requestId: randomUUID(),
    });

    return { ok: false, text: '', taskId: task.id, messageId: null };
  }

  board.postMessage(
    db,
    card.conversation_id,
    board.boardAgent(db, card.conversation_id, input.agent),
    {
      cardId: card.id,
      kind: input.kind,
      content: result.resultText.slice(0, 8000),
      requestId: randomUUID(),
      hop: 0,
    },
  );

  return {
    ok: true,
    text: result.resultText,
    taskId: task.id,
    messageId: result.task.result_message_id,
  };
}

function stop(ctx: LoopContext, reason: string): CrossReviewOutcome {
  board.setCrossPhase(ctx.db, ctx.card.id, 'waiting_user');
  board.postMessage(
    ctx.db,
    ctx.card.conversation_id,
    board.boardSystem(ctx.db, ctx.card.conversation_id),
    {
      cardId: ctx.card.id,
      kind: 'notice',
      content: `交叉验证中止：${reason}`,
      requestId: randomUUID(),
    },
  );

  return {
    cardId: ctx.card.id,
    status: 'failed',
    rounds: board.findCard(ctx.db, ctx.card.id)?.cross_round_used ?? 0,
    summaryMessageId: null,
    reason,
  };
}

async function loop(ctx: LoopContext): Promise<CrossReviewOutcome> {
  const card = ctx.card;
  const requested =
    card.requested_agent === null ? null : (card.requested_agent as HarnessType);
  const author: HarnessType = requested ?? 'claude';
  const verifier: HarnessType = author === 'deepseek' ? 'claude' : 'deepseek';
  const summarizer: HarnessType = 'codex';

  requireAgents(ctx, [author, verifier, summarizer]);

  let lastAuthor = '';
  let lastReview = '';

  // 1. Default: Codex reads the card and dispatches. If the user named an
  // executor, the platform skips this turn — the user's choice wins.
  if (requested === null) {
    board.setCrossPhase(ctx.db, card.id, 'dispatched');
    const dispatch = await runTurn(ctx, {
      agent: 'codex',
      prompt: dispatcherPrompt(card),
      systemAppend: DISPATCHER_RULES,
      kind: 'assignment',
      sourceAgent: null,
      titleSuffix: '派发',
    });

    if (!dispatch.ok) return stop(ctx, 'Codex 的派发回合失败');

    if (!/@claude\b/i.test(dispatch.text)) {
      // No assignment: the dispatcher's message is the round's result.
      board.setCrossPhase(ctx.db, card.id, 'waiting_user');
      return {
        cardId: card.id,
        status: 'waiting_user',
        rounds: 0,
        summaryMessageId: dispatch.messageId,
        reason: null,
      };
    }
  } else {
    board.postMessage(
      ctx.db,
      card.conversation_id,
      board.boardSystem(ctx.db, card.conversation_id),
      {
        cardId: card.id,
        kind: 'notice',
        content: `用户指定由 ${DISPLAY[requested]} 执行；本轮跳过 Codex 派发。`,
        requestId: randomUUID(),
      },
    );
    board.setCrossPhase(ctx.db, card.id, 'cc_work');
  }

  // 2. Fixed rounds: the author works, the verifier checks. The platform only counts.
  for (let round = 1; round <= card.cross_round_limit; round += 1) {
    board.setCrossPhase(ctx.db, card.id, 'cc_work');

    const findingsBefore = board
      .listFindings(ctx.db, card.id)
      .filter((row) => row.status === 'open' || row.status === 'addressed');

    const authorTurn = await runTurn(ctx, {
      agent: author,
      prompt: authorPrompt(card, round, lastReview, findingsBefore, author, verifier, requested !== null),
      systemAppend: AUTHOR_RULES,
      kind: 'result',
      sourceAgent: requested === null ? 'codex' : null,
      titleSuffix: `执行 ${round}`,
    });

    if (!authorTurn.ok) {
      return stop(ctx, `第 ${round} 轮 ${DISPLAY[author]} 的回合失败`);
    }

    lastAuthor = authorTurn.text;
    applyAddressed(ctx.db, card.id, authorTurn.text, author);

    board.setCrossPhase(ctx.db, card.id, 'dsh_review');

    const reviewTurn = await runTurn(ctx, {
      agent: verifier,
      prompt: verifierPrompt(card, round, authorTurn.text, findingsBefore, author, verifier),
      systemAppend: VERIFIER_RULES,
      kind: 'review',
      sourceAgent: author,
      titleSuffix: `验证 ${round}`,
    });

    if (!reviewTurn.ok) {
      return stop(ctx, `第 ${round} 轮 ${DISPLAY[verifier]} 的验证失败`);
    }

    lastReview = reviewTurn.text;
    applyReview(ctx.db, card.id, round, reviewTurn.text, verifier);

    const counted = board.recordReview(ctx.db, card.id, {
      passed: markers(reviewTurn.text).passed,
      actor: { type: 'agent', id: verifier },
    });

    if (counted.reachedLimit) break;
  }

  // 3. Summary: the last round becomes a decision brief for the user.
  board.setCrossPhase(ctx.db, card.id, 'summary');

  const openFindings = board
    .listFindings(ctx.db, card.id)
    .filter((row) => row.status === 'open' || row.status === 'addressed');

  const summary = await runTurn(ctx, {
    agent: summarizer,
    prompt: summaryPrompt(
      board.findCard(ctx.db, card.id) as board.CardRow,
      lastAuthor,
      lastReview,
      openFindings,
    ),
    systemAppend: SUMMARY_RULES,
    kind: 'result',
    sourceAgent: null,
    titleSuffix: '汇总',
  });

  if (!summary.ok) return stop(ctx, `${DISPLAY[summarizer]} 的汇总回合失败`);

  const fresh = board.findCard(ctx.db, card.id) as board.CardRow;
  board.markSummarized(ctx.db, card.id, summary.messageId ?? '');

  return {
    cardId: card.id,
    status: 'waiting_user',
    rounds: fresh.cross_round_used,
    summaryMessageId: summary.messageId,
    reason: null,
  };
}

/**
 * Starts the loop. It runs in the background; the caller gets the card back and
 * polls the card detail for progress.
 */
export function startCrossReview(
  db: DatabaseSync,
  conversationId: string,
  cardId: string,
  options: CrossReviewOptions = {},
): CrossReviewStart {
  if (activeLoops.has(cardId)) {
    throw appError('loop_busy', 'This card is already running a cross-review loop', 409);
  }

  const card = board.findCard(db, cardId);

  if (!card || card.conversation_id !== conversationId) {
    throw appError('card_not_found', 'Card not found', 404);
  }

  const started = board.beginLoop(db, cardId);

  activeLoops.add(cardId);

  const ctx: LoopContext = {
    db,
    card: started,
    runtime: options.runtime ?? defaultRuntime,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  };

  const completion = loop(ctx)
    .catch((err): CrossReviewOutcome => {
      const message = err instanceof Error ? err.message : String(err);
      return stop(ctx, message);
    })
    .finally(() => {
      activeLoops.delete(cardId);
    });

  completion.catch(() => undefined);

  return { card: board.findCard(db, cardId) as board.CardRow, completion };
}
