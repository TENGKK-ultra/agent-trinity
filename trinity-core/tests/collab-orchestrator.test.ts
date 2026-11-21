import assert from 'node:assert/strict';
import test from 'node:test';
import { findRound } from '../src/collab/messages.service.ts';
import {
  cancelCollaboration,
  driveRound,
  resumeCollaboration,
  roundDetail,
  startCollaboration,
} from '../src/collab/orchestrator.service.ts';
import { requestHelp } from '../src/collab/dispatch.service.ts';
import { assignTask, acceptRequest } from '../src/collab/dispatch.service.ts';
import { initRound } from '../src/collab/roles.service.ts';
import { createConversation } from '../src/conversations/conversation.service.ts';
import { activateBinding } from '../src/harnesses/session.service.ts';
import { createTask } from '../src/harnesses/task.service.ts';
import type { HarnessType } from '../src/harnesses/types.ts';
import {
  crashingAdapter,
  kindOf,
  planBlock,
  runtimeFor,
  scriptedAdapter,
} from './collab-helpers.ts';
import { createTempDatabase, type TempDatabase } from './helpers.ts';

function setup(agents: HarnessType[]): { temp: TempDatabase; conversationId: string } {
  const temp = createTempDatabase();
  const conversation = createConversation(temp.db, { title: '自主协作' });

  for (const agent of agents) {
    activateBinding(temp.db, conversation.id, { harnessType: agent, cwd: temp.dir, model: null });
  }

  return { temp, conversationId: conversation.id };
}

function tasksOf(temp: TempDatabase, roundId: string) {
  return temp.db
    .prepare('SELECT * FROM agent_tasks WHERE chain_id = ? ORDER BY rowid')
    .all(roundId) as Array<Record<string, unknown>>;
}

async function waitFor(condition: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error('waitFor timed out');
}

test('P3 编排：单 Agent 协作完成一次真实交付', async () => {
  const { temp, conversationId } = setup(['claude']);

  try {
    const runtime = runtimeFor({
      claude: scriptedAdapter('claude', (prompt) =>
        kindOf(prompt) === 'plan'
          ? { text: planBlock({ assign: [], done: true }) }
          : { text: '最终交付：方案已经写完。' },
      ),
    });

    const started = startCollaboration(temp.db, conversationId, { goal: '写一份方案' }, { runtime });
    const summary = await started.completion;

    assert.equal(summary.status, 'delivered');
    assert.equal(summary.outcome, 'completed');
    assert.equal(tasksOf(temp, summary.roundId).length, 0);

    const delivery = temp.db
      .prepare('SELECT content FROM messages WHERE id = ?')
      .get(summary.deliveryMessageId) as { content: string } | undefined;

    assert.ok(delivery, '对话里必须有交付消息');
    assert.match(delivery.content, /方案/);
  } finally {
    temp.cleanup();
  }
});

test('P3 编排：两个 Agent 并发执行首批任务，结果都写回', async () => {
  const { temp, conversationId } = setup(['claude', 'codex', 'deepseek']);

  try {
    const runtime = runtimeFor({
      codex: scriptedAdapter('codex', (prompt) => {
        const kind = kindOf(prompt);

        if (kind === 'plan') {
          return {
            text: planBlock({
              assign: [
                { to: 'claude', task: '写调研提纲', type: 'research', reason: '结构清晰' },
                { to: 'deepseek', task: '搜集资料', type: 'research', reason: '检索快' },
              ],
              done: false,
            }),
          };
        }

        if (kind === 'checkpoint') return { text: planBlock({ assign: [], done: true }) };

        return { text: '整合完成：两份结果都在。' };
      }),
      claude: scriptedAdapter('claude', () => ({ text: 'claude 的提纲', delayMs: 400 })),
      deepseek: scriptedAdapter('deepseek', () => ({ text: 'deepseek 的资料', delayMs: 400 })),
    });

    const started = startCollaboration(
      temp.db,
      conversationId,
      { goal: '做一份资料综述', coordinator: 'codex', reviewRequired: false },
      { runtime },
    );

    const summary = await started.completion;
    const tasks = tasksOf(temp, summary.roundId);

    assert.equal(tasks.length, 2);
    assert.deepEqual(
      tasks.map((task) => task.status),
      ['completed', 'completed'],
    );
    assert.ok(tasks.every((task) => task.chain_id === summary.roundId));

    // Concurrency evidence: the two runs overlap in wall-clock time.
    const [first, second] = tasks as Array<{
      started_at: string;
      finished_at: string;
    }>;
    assert.ok(first && second);
    assert.ok(
      first.started_at < second.finished_at && second.started_at < first.finished_at,
      `两个任务的时间区间必须重叠：${first.started_at}-${first.finished_at} / ${second.started_at}-${second.finished_at}`,
    );

    assert.equal(summary.status, 'delivered');
    assert.equal(summary.outcome, 'completed');

    const notices = temp.db
      .prepare(
        "SELECT COUNT(*) AS n FROM agent_messages WHERE round_id = ? AND kind = 'notice'",
      )
      .get(summary.roundId) as { n: number };

    assert.equal(notices.n, 2, '每个任务的结果都要回传给协调者');
  } finally {
    temp.cleanup();
  }
});

test('P3 编排：任务完成后自动触发下一轮分工', async () => {
  const { temp, conversationId } = setup(['claude', 'codex']);

  try {
    let checkpoints = 0;

    const runtime = runtimeFor({
      codex: scriptedAdapter('codex', (prompt) => {
        const kind = kindOf(prompt);

        if (kind === 'plan') {
          return {
            text: planBlock({
              assign: [{ to: 'claude', task: '第一步：调研', type: 'research', reason: '先调研' }],
              done: false,
            }),
          };
        }

        if (kind === 'checkpoint') {
          checkpoints += 1;

          return checkpoints === 1
            ? {
                text: planBlock({
                  assign: [{ to: 'claude', task: '第二步：成稿', type: 'writing', reason: '调研完成' }],
                  done: false,
                }),
              }
            : { text: planBlock({ assign: [], done: true }) };
        }

        return { text: '交付完成。' };
      }),
      claude: scriptedAdapter('claude', () => ({ text: '完成。' })),
    });

    const started = startCollaboration(
      temp.db,
      conversationId,
      { goal: '两步完成一份报告', reviewRequired: false },
      { runtime },
    );

    const summary = await started.completion;
    const tasks = tasksOf(temp, summary.roundId) as Array<{
      status: string;
      created_at: string;
      finished_at: string | null;
    }>;

    assert.equal(tasks.length, 2);
    assert.equal(tasks[0]?.status, 'completed');
    assert.equal(tasks[1]?.status, 'completed');
    assert.ok(
      tasks[1]!.created_at >= tasks[0]!.finished_at!,
      '第二个任务只能在第一个任务完成并触发检查点之后创建',
    );
    assert.equal(summary.outcome, 'completed');
  } finally {
    temp.cleanup();
  }
});

test('P3 编排：一个 Agent 失败时同批其他任务不受影响，交付为部分完成', async () => {
  const { temp, conversationId } = setup(['claude', 'codex', 'deepseek']);

  try {
    const runtime = runtimeFor({
      codex: scriptedAdapter('codex', (prompt) => {
        const kind = kindOf(prompt);

        if (kind === 'plan') {
          return {
            text: planBlock({
              assign: [
                { to: 'claude', task: '写提纲', type: 'research', reason: '结构' },
                { to: 'deepseek', task: '跑数据', type: 'research', reason: '计算' },
              ],
              done: false,
            }),
          };
        }

        if (kind === 'checkpoint') return { text: planBlock({ assign: [], done: true }) };

        return { text: '交付说明：一部分完成。' };
      }),
      claude: scriptedAdapter('claude', () => ({ text: '提纲完成' })),
      deepseek: crashingAdapter('deepseek'),
    });

    const started = startCollaboration(
      temp.db,
      conversationId,
      { goal: '做一份数据报告', coordinator: 'codex', reviewRequired: false },
      { runtime },
    );

    const summary = await started.completion;
    const tasks = tasksOf(temp, summary.roundId) as Array<{ target_agent: string; status: string }>;

    assert.equal(
      tasks.find((task) => task.target_agent === 'claude')?.status,
      'completed',
    );
    assert.equal(
      tasks.find((task) => task.target_agent === 'deepseek')?.status,
      'failed',
    );
    assert.equal(summary.status, 'delivered');
    assert.equal(summary.outcome, 'partially_completed');

    const failedNotice = temp.db
      .prepare(
        `SELECT COUNT(*) AS n FROM agent_messages
          WHERE round_id = ? AND kind = 'notice' AND from_agent = 'deepseek'`,
      )
      .get(summary.roundId) as { n: number };

    assert.equal(failedNotice.n, 1, '失败必须被协调者观察到');

    const assignment = temp.db
      .prepare(
        `SELECT state FROM agent_messages
          WHERE round_id = ? AND to_agent = 'deepseek' AND kind = 'assignment'`,
      )
      .get(summary.roundId) as { state: string };

    assert.equal(assignment.state, 'task_failed');
  } finally {
    temp.cleanup();
  }
});

test('P3 编排：审查不通过后返工，再次审查通过才算完成', async () => {
  const { temp, conversationId } = setup(['claude', 'codex', 'deepseek']);

  try {
    let reviews = 0;
    let reworks = 0;

    const runtime = runtimeFor({
      codex: scriptedAdapter('codex', (prompt) => {
        const kind = kindOf(prompt);

        if (kind === 'plan') {
          return {
            text: planBlock({
              assign: [{ to: 'claude', task: '写方案', type: 'writing', reason: '主笔' }],
              done: false,
            }),
          };
        }

        if (kind === 'checkpoint' && prompt.includes('审查未通过')) {
          reworks += 1;

          return {
            text: planBlock({
              assign: [{ to: 'claude', task: '补上缺的数据', type: 'writing', reason: '审查意见' }],
              done: false,
            }),
          };
        }

        if (kind === 'checkpoint') return { text: planBlock({ assign: [], done: true }) };

        return { text: '最终交付：已按审查意见修改。' };
      }),
      claude: scriptedAdapter('claude', () => ({ text: '方案正文' })),
      deepseek: scriptedAdapter('deepseek', () => {
        reviews += 1;

        return {
          text: planBlock({
            review:
              reviews === 1
                ? { status: 'needs_changes', findings: ['缺少数据来源'] }
                : { status: 'pass', findings: [] },
          }),
        };
      }),
    });

    const started = startCollaboration(
      temp.db,
      conversationId,
      { goal: '写一份有依据的方案', coordinator: 'codex', reviewRequired: true },
      { runtime },
    );

    const summary = await started.completion;
    const detail = roundDetail(temp.db, summary.roundId);

    assert.equal(reworks, 1, '审查不通过必须触发一次返工');
    assert.equal(detail.reviews.length, 2);
    assert.equal(detail.reviews[0]?.status, 'needs_changes');
    assert.equal(detail.reviews[1]?.status, 'pass');
    assert.equal(detail.reviews[1]?.reviewer, 'deepseek');
    assert.equal(summary.outcome, 'completed');
    assert.equal(tasksOf(temp, summary.roundId).length, 2);
  } finally {
    temp.cleanup();
  }
});

test('P3 编排：执行预算耗尽时停止新工作，按部分完成交付', async () => {
  const { temp, conversationId } = setup(['claude', 'codex']);

  try {
    const runtime = runtimeFor({
      codex: scriptedAdapter('codex', (prompt) => {
        const kind = kindOf(prompt);

        if (kind === 'plan') {
          return {
            text: planBlock({
              assign: [{ to: 'claude', task: '写一段', type: 'writing', reason: '唯一任务' }],
              done: false,
            }),
          };
        }

        if (kind === 'checkpoint') {
          return {
            text: planBlock({
              assign: [{ to: 'claude', task: '再写一段', type: 'writing', reason: '继续' }],
              done: false,
            }),
          };
        }

        return { text: '交付。' };
      }),
      claude: scriptedAdapter('claude', () => ({ text: '写完了' })),
    });

    const started = startCollaboration(
      temp.db,
      conversationId,
      { goal: '尽量写', reviewRequired: false, budgetExec: 2 },
      { runtime },
    );

    const summary = await started.completion;
    const round = findRound(temp.db, summary.roundId)!;

    assert.equal(round.exec_used, 2, '执行预算按回合精确扣减');
    assert.equal(summary.status, 'delivered');
    assert.equal(summary.outcome, 'partially_completed');

    const delivery = temp.db
      .prepare(
        `SELECT content FROM messages
          WHERE conversation_id = ? AND message_type = 'system_event'
            AND content LIKE '%协作交付%' ORDER BY rowid DESC LIMIT 1`,
      )
      .get(conversationId) as { content: string } | undefined;

    assert.ok(delivery);
    assert.match(delivery.content, /partially_completed/);
    assert.match(delivery.content, /执行 2\/2/);
  } finally {
    temp.cleanup();
  }
});

test('P3 编排：用量预算耗尽会阻塞，用户提高上限后继续完成', async () => {
  const { temp, conversationId } = setup(['claude']);

  try {
    const runtime = runtimeFor({
      claude: scriptedAdapter('claude', (prompt) =>
        kindOf(prompt) === 'plan'
          ? { text: planBlock({ assign: [], done: true }), usageTokens: 10 }
          : { text: '交付。', usageTokens: 10 },
      ),
    });

    const started = startCollaboration(
      temp.db,
      conversationId,
      { goal: '跑一次', budgetUsageTokens: 5 },
      { runtime },
    );

    const blocked = await started.completion;

    assert.equal(blocked.blocked, true);
    assert.equal(blocked.status, 'blocked');
    assert.equal(findRound(temp.db, blocked.roundId)?.outcome, null);

    const resumed = resumeCollaboration(
      temp.db,
      blocked.roundId,
      { budgetUsageTokens: 1000 },
      { runtime },
    );
    const summary = await resumed.completion;

    assert.equal(summary.status, 'delivered');
    assert.equal(summary.outcome, 'completed');
  } finally {
    temp.cleanup();
  }
});

test('P3 编排：用户取消后整轮终止，不再产生交付', async () => {
  const { temp, conversationId } = setup(['claude', 'codex']);

  try {
    const runtime = runtimeFor({
      codex: scriptedAdapter('codex', (prompt) => {
        const kind = kindOf(prompt);

        if (kind === 'plan') {
          return {
            text: planBlock({
              assign: [{ to: 'claude', task: '长任务', type: 'general', reason: '测试取消' }],
              done: false,
            }),
          };
        }

        return { text: planBlock({ assign: [], done: true }) };
      }),
      claude: scriptedAdapter('claude', () => ({ text: '慢', delayMs: 1200 })),
    });

    const started = startCollaboration(
      temp.db,
      conversationId,
      { goal: '可取消的任务', reviewRequired: false },
      { runtime },
    );

    await waitFor(() => {
      const row = temp.db
        .prepare("SELECT COUNT(*) AS n FROM agent_tasks WHERE status = 'running'")
        .get() as { n: number };

      return row.n > 0;
    });

    cancelCollaboration(temp.db, started.round.id);

    const summary = await started.completion;
    const round = findRound(temp.db, started.round.id)!;

    assert.equal(round.status, 'cancelled');
    assert.equal(summary.outcome, 'cancelled');

    const statuses = tasksOf(temp, started.round.id).map((task) => task.status);
    assert.deepEqual(statuses, ['cancelled']);

    const deliveries = temp.db
      .prepare(
        `SELECT COUNT(*) AS n FROM messages
          WHERE conversation_id = ? AND content LIKE '%协作交付%'`,
      )
      .get(conversationId) as { n: number };

    assert.equal(deliveries.n, 0, '取消的轮次不写交付结论');
  } finally {
    temp.cleanup();
  }
});

test('P3 编排：协调者不会被自己发起的活动指派锁死，旧守卫仍然生效', () => {
  const { temp, conversationId } = setup(['claude', 'codex']);

  try {
    const { round } = initRound(temp.db, {
      conversationId,
      goal: '锁',
      coordinator: 'codex',
      contributors: ['claude'],
    });

    // codex is the source of an active task (it assigned work to claude).
    assignTask(temp.db, {
      roundId: round.id,
      actor: 'codex',
      target: 'claude',
      instruction: '先做',
      reason: '第一步',
    });

    const request = requestHelp(temp.db, {
      roundId: round.id,
      from: 'claude',
      to: 'codex',
      instruction: '请核对',
      reason: '需要协调者',
    });

    const task = acceptRequest(temp.db, request.id);
    assert.equal(task.target_agent, 'codex');
    assert.equal(task.status, 'queued');

    // The ordinary guard is untouched: outside a round, a chain that points back
    // at an agent already active in it is still refused.
    createTask(temp.db, {
      conversationId,
      sourceAgent: 'codex',
      targetAgent: 'claude',
      instruction: '普通委派',
      chainId: 'ordinary-chain',
    });

    assert.throws(
      () =>
        createTask(temp.db, {
          conversationId,
          sourceAgent: null,
          targetAgent: 'codex',
          instruction: '指回来源',
          chainId: 'ordinary-chain',
        }),
      (err: unknown) => (err as { code?: string }).code === 'delegation_cycle',
    );
  } finally {
    temp.cleanup();
  }
});

test('P3 编排：协调者接受同行的请求，并真实执行该任务', async () => {
  const { temp, conversationId } = setup(['claude', 'codex']);

  try {
    const { round } = initRound(temp.db, {
      conversationId,
      goal: '核对数据',
      coordinator: 'codex',
      contributors: ['claude'],
    });

    const request = requestHelp(temp.db, {
      roundId: round.id,
      from: 'claude',
      to: 'codex',
      instruction: '帮我核对数据',
      reason: '需要第二双眼睛',
    });

    const runtime = runtimeFor({
      codex: scriptedAdapter('codex', (prompt) => {
        const kind = kindOf(prompt);

        if (kind === 'plan') return { text: planBlock({ assign: [], done: true }) };

        if (kind === 'checkpoint') {
          return {
            text: planBlock({
              assign: [],
              resolve: [{ from: 'claude', decision: 'accept', reason: '我来核对' }],
              done: false,
            }),
          };
        }

        return { text: '核对完成' };
      }),
      claude: scriptedAdapter('claude', () => ({ text: '理论' })),
    });

    const summary = await driveRound(temp.db, round.id, { runtime });
    const tasks = tasksOf(temp, round.id) as Array<{
      target_agent: string;
      source_agent: string | null;
      status: string;
    }>;

    assert.equal(tasks.length, 1);
    assert.equal(tasks[0]?.target_agent, 'codex');
    assert.equal(tasks[0]?.source_agent, 'claude');
    assert.equal(tasks[0]?.status, 'completed');

    const row = temp.db
      .prepare('SELECT task_id, state FROM agent_messages WHERE id = ?')
      .get(request.id) as { task_id: string | null; state: string };

    assert.notEqual(row.task_id, null, '接受请求后消息必须挂上任务');
    assert.equal(row.state, 'task_completed');

    assert.equal(summary.status, 'delivered');
  } finally {
    temp.cleanup();
  }
});
