import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import * as conversationRepository from '../conversations/conversation.repository.ts';
import { executeTask } from '../harnesses/delegation.service.ts';
import { defaultRuntime, type CoreRuntime } from '../harnesses/runtime.ts';
import * as sessionService from '../harnesses/session.service.ts';
import * as taskService from '../harnesses/task.service.ts';
import * as messageService from '../messages/message.service.ts';
import { appError } from '../types/index.ts';
import {
  advanceLastReadAt,
  cursorOf,
  encodeCursor,
} from '../harnesses/context.service.ts';
import { parseMentions, type GroupAgent } from './mentions.ts';

export const MAX_GROUP_RUNS = 8;

/**
 * The deepest agent a chain may relay to: starting at 0, a value of 2 allows
 * three runs (0 → 1 → 2). The task ledger's own cap is 3, one level higher, so
 * the orchestrator always stops first and the ledger is the backstop.
 */
export const MAX_GROUP_DEPTH = 2;

/**
 * Team mode allows one more round — dispatcher → member → dispatcher → member —
 * because a report back is not the end of the work.
 */
const TEAM_MAX_DEPTH = 3;

export type GroupMode = 'broadcast' | 'team';
const TRANSCRIPT_LIMIT = 12;
const TRANSCRIPT_BODY_CHARS = 600;
const INSTRUCTION_EXCERPT_CHARS = 140;
const INSTRUCTION_FULL_CHARS = 2000;

const DISPLAY: Record<GroupAgent, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  deepseek: 'DeepSeek Harness',
};

interface QueueItem {
  agent: GroupAgent;
  instruction: string;
  parentTaskId: string | null;
  depth: number;
  sourceAgent: GroupAgent | null;
}

export interface GroupOptions {
  runtime?: CoreRuntime;
  timeoutMs?: number;
  /**
   * Who takes part in this round. The desktop sends this when the user has
   * selected agents and wrote no mention; an explicit target set overrides
   * mention-based routing for the first batch.
   */
  targets?: readonly GroupAgent[];
  /**
   * `broadcast` (default): every selected agent answers from one snapshot.
   * `team`: only the dispatcher starts; the others are present and are woken
   * by the dispatcher's @ mentions. The roster is injected verbatim.
   */
  mode?: GroupMode;
  /** Who dispatches in team mode. Defaults to Codex. */
  dispatcher?: GroupAgent;
}

export interface GroupOutcome {
  groupTurnId: string;
  runs: number;
  failed: number;
}

export interface GroupStartResult {
  groupTurnId: string;
  /** Everyone in the room for this round. */
  targets: GroupAgent[];
  /** Present but not started: they wait for the dispatcher's assignment. */
  waiting: GroupAgent[];
  completion: Promise<GroupOutcome>;
}

interface TranscriptRow {
  id: string;
  created_at: string;
  sender_kind: string;
  sender_id: string | null;
  content: string;
}

interface Transcript {
  text: string;
  /** The newest message included; only a participant that saw this snapshot advances to it. */
  cutoff: string | null;
}

/** The shared chat, as the next agent will see it. */
function transcript(db: DatabaseSync, conversationId: string): Transcript {
  const rows = db
    .prepare(
      `SELECT id, created_at, sender_kind, sender_id, content
         FROM messages
        WHERE conversation_id = ?
          AND message_type NOT IN ('tool_call', 'tool_result', 'task_status', 'system_event')
        ORDER BY created_at DESC, rowid DESC
        LIMIT ?`,
    )
    .all(conversationId, TRANSCRIPT_LIMIT) as unknown as TranscriptRow[];

  const ordered = rows.reverse();
  const newest = ordered.at(-1) ?? null;

  const text = ordered
    .map((row) => {
      const who = row.sender_kind === 'user' ? '用户' : (row.sender_id ?? 'Agent');
      const body =
        row.content.length > TRANSCRIPT_BODY_CHARS
          ? `${row.content.slice(0, TRANSCRIPT_BODY_CHARS)}…`
          : row.content;

      return `${who}：${body}`;
    })
    .join('\n');

  return { text, cutoff: newest === null ? null : encodeCursor(cursorOf(newest)) };
}

/**
 * The user's working agreement, delivered verbatim. The platform does not act
 * on it: it only makes sure every participant reads the same rules.
 */
function teamCharter(dispatcher: GroupAgent): string {
  return [
    '[团队章程]',
    '这个工作区按真实小组的方式协作。',
    `- 本轮决策者：${DISPLAY[dispatcher]}。负责理解目标、拆解工作、做出指派、决定下一步；不亲自包办全部工作。`,
    '- Claude Code：第一工程师。负责实现、运行与验证；执行中发现错误或风险，立即在群里报告现象、复现步骤与影响，并做阶段性汇报。',
    '- DeepSeek Harness（DSH）：故障分析。默认不改代码；收到明确错误或被点名时，读取错误与日志，给出原因、影响和修复建议，交回决策者。',
    '- 指派必须写清：做什么、完成标准、边界与约束；用 @Claude 或 @DSH 点名。',
    '- 一次只推进当前最重要的一步，等结果回来再继续；不要重复派同一件事。',
    '- 即使任务很小，决策者也必须先分派；只有确实无人可派时才自己做，并说明理由。',
    '- 在成员回报之前，决策者不得宣布结果、不得引用具体数据；它只负责分发、追问与汇总。',
    '- 决策者只能看到自己回合开始前的记录，成员的回复下一回合才出现；不要模拟成员的回复，也不要替他们写结果。',
    '- 决策者不得替成员完成他们的部分。',
    '- 不确定时先问，不要猜。',
    '[/团队章程]',
  ].join('\n');
}

/**
 * The hard rules ride in the system/developer prompt, not the task text: a
 * dispatcher with shell access will otherwise finish the work itself and write
 * a story about it, no matter what the user message says.
 */
function teamSystemRules(
  agent: GroupAgent,
  dispatcher: GroupAgent,
  isWrapUp: boolean,
): string {
  if (agent !== dispatcher) {
    return [
      '[硬规则]',
      '你是本回合被指派的执行者，不是决策者。',
      '只完成[本轮指派]里的工作；不要重新规划整个目标，不要把工作再转给别人。',
      '只读分析优先使用 Read/Glob/Grep；不要用 shell（PowerShell/Bash）做只读统计。',
      `执行中遇到错误、阻塞或需要决策时，立即在回复里说明，并用 @${DISPLAY[dispatcher]} 交回。`,
      `完成后给出可核对的结果，并用 @${DISPLAY[dispatcher]} 汇报。`,
      '[/硬规则]',
    ].join('\n');
  }

  if (isWrapUp) {
    return [
      '[硬规则]',
      '你是本轮决策者的收口回合。',
      '只根据群聊记录里成员已经给出的结果做汇总；不得补充记录里没有的数据，不得声称完成了记录里没有的工作。',
      '如果仍有缺口，说明缺口并 @ 对应成员，或明确结束本轮。',
      '不要使用任何工具去补做工作。',
      '[/硬规则]',
    ].join('\n');
  }

  return [
    '[硬规则]',
    '你只负责分发，不负责执行。',
    '不要使用任何文件、shell、编辑、补丁、网络或部署工具来完成目标；即使你完全知道答案，也不要在本轮给出结果。',
    '本回合的输出只能是一份分发计划：说明需要谁做、做什么、完成标准与边界，并用 @Claude 或 @DSH 点名。',
    '你看不到成员本回合的回复；不得声明任何“已完成”，不得替成员写结果，不得把功劳归给任何人。',
    '如果你无法分派，明确说明原因并结束本回合。',
    '[/硬规则]',
  ].join('\n');
}

function buildPrompt(
  agent: GroupAgent,
  transcriptText: string,
  team: { dispatcher: GroupAgent } | null,
  assignment?: string | null,
): string {
  const lines: string[] = [];
  const brief = (assignment ?? '').trim();

  if (team !== null) {
    lines.push(teamCharter(team.dispatcher), '');
    lines.push(
      agent === team.dispatcher
        ? `你是本轮的决策者 ${DISPLAY[agent]}。先读目标与群聊记录，给出分发计划；需要别人做时用 @Claude 或 @DSH 指派。即使任务很小，也要先分派；只有确实无人可派时才自己做，并说明理由。本轮只输出分发计划与 @指派，不要给出任何结果数据，也不要假装看到成员的回复。`
        : `你是本轮团队成员 ${DISPLAY[agent]}。按团队章程承担职责；完成被指派的工作后，用 @${DISPLAY[team.dispatcher]} 把结果与发现的问题交回决策者。`,
    );
    lines.push('');

    // The transcript is deliberately excerpted, so the assignment is delivered
    // in full here: a cut-off brief used to make the member answer "待命".
    if (agent !== team.dispatcher && brief !== '') {
      lines.push('[本轮指派]', brief, '[/本轮指派]', '');
    }
  }

  lines.push(
    '[群聊记录]',
    transcriptText,
    '[/群聊记录]',
    '',
    `你是 ${DISPLAY[agent]}，正在 Trinity 的多人协作群聊里。`,
    team === null
      ? '请针对上面最新的内容给出你的回复。'
      : '请优先完成上面的[本轮指派]；指派为空时，只回复「待命」。',
    team === null
      ? '如果需要其他 Agent 接手，请用 @Claude、@Codex 或 @DSH 明确指派，并说明要做什么。'
      : '需要别人接手时，用 @ 明确指派，并写清任务与完成标准。',
  );

  return lines.join('\n');
}

function excerpt(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > INSTRUCTION_EXCERPT_CHARS
    ? `接手处理：${line.slice(0, INSTRUCTION_EXCERPT_CHARS)}…`
    : `接手处理：${line}`;
}

/**
 * In team mode the dispatcher writes a real brief; cutting it to 140 chars
 * would drop the assignment itself.
 */
function fullInstruction(text: string): string {
  const line = text.trim();
  return line.length > INSTRUCTION_FULL_CHARS
    ? `${line.slice(0, INSTRUCTION_FULL_CHARS)}…`
    : line;
}

/**
 * One group message may produce several runs, chained by the mentions each
 * reply contains. Runs are sequential: the transcript the next agent reads must
 * already contain the previous reply. Every run is a real task, so the task
 * ledger and activity stream show the same work the chat shows.
 */
export function startGroupTurn(
  db: DatabaseSync,
  conversationId: string,
  content: string,
  options: GroupOptions = {},
): GroupStartResult {
  const conversation = conversationRepository.findConversation(db, conversationId);

  if (!conversation) {
    throw appError('conversation_not_found', 'Conversation not found', 404);
  }

  if (conversation.status === 'archived') {
    throw appError('conversation_archived', 'Conversation is archived', 409);
  }

  const text = content.trim();

  if (text === '') {
    throw appError('invalid_content', 'content must not be empty', 400);
  }

  if (text.length > taskService.MAX_INSTRUCTION_LENGTH) {
    throw appError(
      'invalid_content',
      `content must be at most ${taskService.MAX_INSTRUCTION_LENGTH} characters`,
      400,
    );
  }

  const bindings = sessionService.listBindings(db, conversationId);
  const bound = new Set(bindings.map((row) => row.harness_type));
  const mentions = parseMentions(text);

  let targets: GroupAgent[];

  if (options.targets !== undefined) {
    // Explicit participants are authoritative; an unbound or unknown name is
    // never started and never silently replaced by another agent.
    targets = [...new Set(options.targets)].filter((agent) => bound.has(agent));

    if (targets.length === 0) {
      throw appError('no_bound_target', 'None of the selected agents is bound here', 409);
    }
  } else {
    targets = mentions.filter((agent) => bound.has(agent));

    if (mentions.length > 0 && targets.length === 0) {
      throw appError('no_bound_target', 'None of the mentioned agents is bound here', 409);
    }

    if (mentions.length === 0) {
      const active = sessionService.findActiveSession(db, conversationId);

      if (!active) {
        throw appError('no_target_agent', 'No agent is bound in this conversation', 409);
      }

      targets = [active.harness_type as GroupAgent];
    }
  }

  const mode: GroupMode = options.mode ?? 'broadcast';
  let dispatcher: GroupAgent | null = null;

  if (mode === 'team') {
    const wanted = options.dispatcher ?? 'codex';

    if (!bound.has(wanted)) {
      throw appError(
        'dispatcher_not_bound',
        `本轮决策者 ${wanted} 尚未绑定到该会话`,
        409,
      );
    }

    dispatcher = wanted;

    // The dispatcher must be in the room even if the caller lit only others.
    if (!targets.includes(dispatcher)) targets = [...targets, dispatcher];
  }

  const present = [...new Set(targets)];
  const execution: GroupAgent[] = dispatcher === null ? present : [dispatcher];
  const waiting = dispatcher === null ? [] : present.filter((agent) => agent !== dispatcher);
  const depthLimit = dispatcher === null ? MAX_GROUP_DEPTH : TEAM_MAX_DEPTH;

  const groupTurnId = randomUUID();
  // One agent speaks at most once per round. In team mode only the dispatcher
  // counts as started; the waiting members must stay available for its @.
  const dispatched = new Set<GroupAgent>(execution);

  // The round id is stored twice, both durable: on the user message that began
  // it and as the chain id of every task it produced. Nothing depends on the
  // process that created it still being alive.
  messageService.addMessage(db, conversationId, {
    content: text,
    message_type: 'user_message',
    sender_kind: 'user',
    metadata: { group_turn_id: groupTurnId, ...(dispatcher === null ? {} : { mode, dispatcher }) },
  });
  const runtime = options.runtime ?? defaultRuntime;
  const queue: QueueItem[] = execution.map((agent) => ({
    agent,
    instruction: text,
    parentTaskId: null,
    depth: 0,
    sourceAgent: null,
  }));

  const completion = (async (): Promise<GroupOutcome> => {
    let runs = 0;
    let failed = 0;
    // In team mode the dispatcher gets one wrap-up turn after a member reports
    // back; without it the round ends before the decision maker sees the result.
    let dispatcherRepeatUsed = false;
    const notices = new Set<string>();

    // A limit that silently swallows a hand-off is a bug from the user's side;
    // every stop gets one visible line in the chat.
    const notice = (key: string, content: string, reason: string): void => {
      if (notices.has(key)) return;
      notices.add(key);

      try {
        messageService.addMessage(db, conversationId, {
          content,
          message_type: 'system_event',
          sender_kind: 'system',
          metadata: { group_turn_id: groupTurnId, reason },
        });
      } catch {
        // The chat is the record; failing to add a notice must not end the run.
      }
    };

    interface Outcome {
      item: QueueItem;
      task: taskService.TaskRow;
      text: string;
    }

    const runItem = async (item: QueueItem, snapshot: Transcript): Promise<Outcome | null> => {
      const session = sessionService.findSession(db, conversationId, item.agent);

      if (!session || !session.cwd) {
        failed += 1;
        return null;
      }

      let task: taskService.TaskRow;

      try {
        task = taskService.createTask(db, {
          conversationId,
          sourceAgent: item.sourceAgent,
          targetAgent: item.agent,
          instruction: item.instruction,
          parentTaskId: item.parentTaskId,
          chainId: groupTurnId,
          maxDepth: MAX_GROUP_DEPTH,
        });
      } catch {
        failed += 1;
        return null;
      }

      let result;
      const systemAppend =
        dispatcher === null
          ? undefined
          : `${teamCharter(dispatcher)}\n\n${teamSystemRules(
              item.agent,
              dispatcher,
              item.depth > 0,
            )}`;

      try {
        result = await executeTask(db, task, {
          adapter: runtime.getAdapter(item.agent),
          prompt: buildPrompt(
            item.agent,
            snapshot.text,
            dispatcher === null ? null : { dispatcher },
            item.instruction,
          ),
          ...(systemAppend === undefined ? {} : { systemAppend }),
          ...(dispatcher !== null && item.agent === 'claude'
            ? { allowedTools: ['Read', 'Glob', 'Grep'] }
            : {}),
          ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        });
      } catch {
        failed += 1;
        return null;
      }

      if (result.task.status !== 'completed' || result.resultText === null) {
        failed += 1;
        return null;
      }

      // This participant actually received the snapshot; its cursor may move to
      // the snapshot's newest message. Messages produced during the round are
      // newer and stay unread for its next turn.
      if (snapshot.cutoff !== null) {
        const session = sessionService.findSession(db, conversationId, item.agent);

        if (session) {
          try {
            advanceLastReadAt(db, session.id, snapshot.cutoff);
          } catch {
            console.warn(
              `[trinity-core] shared-history cursor write failed (agent=${item.agent})`,
            );
          }
        }
      }

      // A group task's result is delivered by being in the chat. Leaving it
      // pending would make the restart sweep report it as undelivered work.
      taskService.setDeliveryStatus(db, task.id, 'delivered');

      return { item, task, text: result.resultText };
    };

    const absorb = (outcome: Outcome): void => {
      const { item, task, text } = outcome;

      if (item.depth >= depthLimit) {
        // Only a hand-off that would have started a *new* agent is worth
        // reporting; one back to an agent that already spoke this round is not
        // a dropped request.
        const blocked = parseMentions(text).filter(
          (agent) => agent !== item.agent && bound.has(agent) && !dispatched.has(agent),
        );

        if (blocked.length > 0) {
          notice(
            'depth',
            `群聊已到达协作深度上限（${depthLimit}），以下指派没有执行：${blocked
              .map((agent) => `@${DISPLAY[agent]}`)
              .join('、')}。`,
            'group_depth_limit',
          );
        }
        return;
      }

      for (const agent of parseMentions(text)) {
        if (agent === item.agent || !bound.has(agent)) continue;

        const dispatcherRepeat =
          dispatcher !== null &&
          agent === dispatcher &&
          !dispatcherRepeatUsed &&
          !queue.some((pending) => pending.agent === agent);

        if (dispatched.has(agent) && !dispatcherRepeat) continue;
        if (dispatcherRepeat) dispatcherRepeatUsed = true;

        // Registered before the task exists, so nothing else in this round can
        // queue the same agent behind this one.
        dispatched.add(agent);
        queue.push({
          agent,
          instruction: dispatcher === null ? excerpt(text) : fullInstruction(text),
          parentTaskId: task.id,
          depth: item.depth + 1,
          sourceAgent: item.agent,
        });
      }
    };

    // The agents the user named answer one message as independent experts: they
    // share the snapshot taken here and start together, so a slow first answer
    // never delays the others and none of them reads a reply from this batch.
    const firstBatch = queue.splice(0, queue.length).slice(0, MAX_GROUP_RUNS);
    runs += firstBatch.length;

    if (firstBatch.length > 0) {
      const snapshot = transcript(db, conversationId);
      const firstResults = await Promise.all(
        firstBatch.map((item) => runItem(item, snapshot)),
      );


      for (const outcome of firstResults) {
        if (outcome !== null) absorb(outcome);
      }
    }

    // Everything after the first batch is a hand-off: its instruction is the
    // reply that asked for it, so these run one at a time.
    while (queue.length > 0 && runs < MAX_GROUP_RUNS) {
      const item = queue.shift();

      if (item === undefined) break;

      runs += 1;

      const outcome = await runItem(item, transcript(db, conversationId));

      if (outcome !== null) absorb(outcome);
    }

    if (queue.length > 0) {
      notice(
        'runs',
        `本轮群聊达到运行次数上限（${MAX_GROUP_RUNS}），还有 ${queue.length} 个指派没有执行。`,
        'group_runs_limit',
      );
    }

    return { groupTurnId, runs, failed };
  })();

  completion.catch(() => undefined);

  return { groupTurnId, targets: present, waiting, completion };
}
