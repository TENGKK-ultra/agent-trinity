import assert from 'node:assert/strict';
import test from 'node:test';
import {
  contributionText,
  listContributions,
  recordContribution,
} from '../src/collab/contributions.service.ts';
import { findRound, recordMessage, trustedSender } from '../src/collab/messages.service.ts';
import {
  driveRound,
  resumeCollaboration,
  startCollaboration,
} from '../src/collab/orchestrator.service.ts';
import { initRound } from '../src/collab/roles.service.ts';
import { createConversation } from '../src/conversations/conversation.service.ts';
import { activateBinding } from '../src/harnesses/session.service.ts';
import type { HarnessType } from '../src/harnesses/types.ts';
import { kindOf, planBlock, runtimeFor, scriptedAdapter } from './collab-helpers.ts';
import { createTempDatabase, type TempDatabase } from './helpers.ts';

function setup(agents: HarnessType[]): { temp: TempDatabase; conversationId: string } {
  const temp = createTempDatabase();
  const conversation = createConversation(temp.db, { title: 'D1/D2' });

  for (const agent of agents) {
    activateBinding(temp.db, conversation.id, { harnessType: agent, cwd: temp.dir, model: null });
  }

  return { temp, conversationId: conversation.id };
}

const PROSE =
  '目标用户是重视隐私、经常离线的知识工作者。核心场景是快速记录、按项目整理、跨设备续写。' +
  '关键功能包括本地加密存储、双向链接与全文检索、可选同步；风险是密钥丢失与冲突合并。';

function tasksOf(temp: TempDatabase, roundId: string) {
  return temp.db
    .prepare('SELECT * FROM agent_tasks WHERE chain_id = ? ORDER BY rowid')
    .all(roundId) as Array<Record<string, unknown>>;
}

// ---------- D1：贡献的持久化与解析 ----------

test('D1 贡献：计划块被剥离，只有散文才成为贡献', () => {
  const text = `${PROSE}\n\n${planBlock({ assign: [], done: true })}`;

  assert.ok(!contributionText(text).includes('```collab'));
  assert.ok(contributionText(text).includes('目标用户'));

  const onlyPlan = planBlock({ assign: [], done: true });
  assert.equal(contributionText(onlyPlan), '', '纯计划不是贡献');
});

test('D1 贡献：持久化、去重、上限，且不产生任何任务', () => {
  const { temp, conversationId } = setup(['codex']);
  const { round } = initRound(temp.db, {
    conversationId,
    goal: '贡献',
    coordinator: 'codex',
    contributors: [],
  });

  try {
    const first = recordContribution(temp.db, {
      roundId: round.id,
      agent: 'codex',
      phase: 'planning',
      text: PROSE,
    });

    assert.ok(first);
    assert.equal(listContributions(temp.db, round.id).length, 1);

    const duplicate = recordContribution(temp.db, {
      roundId: round.id,
      agent: 'codex',
      phase: 'checkpoint',
      text: PROSE,
    });

    assert.equal(duplicate, null, '同一份输出不得重复计入');
    assert.equal(listContributions(temp.db, round.id).length, 1);

    for (let i = 0; i < 20; i += 1) {
      recordContribution(temp.db, {
        roundId: round.id,
        agent: 'codex',
        phase: 'checkpoint',
        text: `${PROSE}（第 ${i} 次补充）`,
      });
    }

    assert.equal(listContributions(temp.db, round.id).length, 10, '每轮最多保留 10 条');
    assert.equal(tasksOf(temp, round.id).length, 0, '贡献不是任务');
  } finally {
    temp.cleanup();
  }
});

// ---------- D1：协调者自己完成也能交付与审查 ----------

test('D1 编排：协调者自己完成时，输出进入交付并接受独立审查', async () => {
  const { temp, conversationId } = setup(['claude', 'codex', 'deepseek']);
  let reviewPrompt = '';

  try {
    const runtime = runtimeFor({
      codex: scriptedAdapter('codex', (prompt) => {
        const kind = kindOf(prompt);

        if (kind === 'plan') {
          return { text: `${PROSE}\n\n${planBlock({ assign: [], done: true })}` };
        }

        return { text: '整合完成。' };
      }),
      claude: scriptedAdapter('claude', (prompt) => {
        reviewPrompt = prompt;
        return { text: planBlock({ review: { status: 'pass', findings: [] } }) };
      }),
      deepseek: scriptedAdapter('deepseek', () => ({ text: '不应被调用' })),
    });

    const started = startCollaboration(
      temp.db,
      conversationId,
      { goal: '写一份简报', coordinator: 'codex', reviewRequired: true },
      { runtime },
    );

    const summary = await started.completion;
    const contributions = listContributions(temp.db, summary.roundId);
    const reviews = temp.db
      .prepare('SELECT * FROM round_reviews WHERE round_id = ?')
      .all(summary.roundId) as Array<Record<string, unknown>>;

    assert.equal(tasksOf(temp, summary.roundId).length, 0, '没有任务，但工作确实发生了');
    assert.equal(contributions.length, 1);
    assert.equal(contributions[0]?.agent, 'codex');
    assert.match(String(contributions[0]?.content), /目标用户/);

    assert.equal(reviews.length, 1, '没有任务的输出也必须被审查');
    assert.equal(reviews[0]?.producer, 'codex');
    assert.equal(reviews[0]?.reviewer, 'claude');
    assert.equal(reviews[0]?.status, 'pass');
    assert.match(reviewPrompt, /目标用户/, '审查素材必须包含协调者的真实输出');

    assert.equal(summary.status, 'delivered');
    assert.equal(summary.outcome, 'completed');

    const delivery = temp.db
      .prepare('SELECT content FROM messages WHERE id = ?')
      .get(summary.deliveryMessageId) as { content: string };

    assert.ok(!delivery.content.includes('完成：无'), '真实产出不得被写成没有成果');
    assert.match(delivery.content, /协调者输出/);
    assert.match(delivery.content, /pass/);
  } finally {
    temp.cleanup();
  }
});

// ---------- D2：用户明确要求分工时的 Core 校验 ----------

test('D2 校验：部分满足时自动重新规划一次，不满足则继续阻塞', async () => {
  const { temp, conversationId } = setup(['claude', 'codex', 'deepseek']);
  const kinds: string[] = [];

  try {
    const runtime = runtimeFor({
      codex: scriptedAdapter('codex', (prompt) => {
        const kind = kindOf(prompt);
        kinds.push(kind);

        if (kind === 'plan') {
          // One agent is already delegation — a nudge is worth one turn.
          return {
            text: planBlock({
              assign: [{ to: 'claude', task: '先做 A', type: 'writing', reason: '分工' }],
              done: true,
            }),
          };
        }

        if (kind === 'replan') {
          return {
            text: planBlock({
              assign: [
                { to: 'claude', task: '写 A 部分', type: 'writing', reason: '分工' },
                { to: 'deepseek', task: '写 B 部分', type: 'writing', reason: '分工' },
              ],
              done: false,
            }),
          };
        }

        if (kind === 'checkpoint') return { text: planBlock({ assign: [], done: true }) };

        return { text: '整合完成。' };
      }),
      claude: scriptedAdapter('claude', () => ({ text: 'A 完成' })),
      deepseek: scriptedAdapter('deepseek', () => ({ text: 'B 完成' })),
    });

    const started = startCollaboration(
      temp.db,
      conversationId,
      {
        goal: 'A、B 必须由不同 Agent 完成',
        coordinator: 'codex',
        minAssignments: 2,
        reviewRequired: false,
      },
      { runtime },
    );

    const summary = await started.completion;
    const tasks = tasksOf(temp, summary.roundId);

    assert.deepEqual(kinds.slice(0, 2), ['plan', 'replan'], '必须先拒绝再重新规划');
    assert.equal(tasks.length, 2);
    assert.deepEqual(
      tasks.map((task) => task.target_agent).sort(),
      ['claude', 'deepseek'],
    );
    assert.equal(summary.status, 'delivered');
    assert.equal(summary.outcome, 'completed');
  } finally {
    temp.cleanup();
  }
});

test('D2 校验：完全没有分工时直接阻塞，不自动重规划；用户批准后才重规划', async () => {
  const { temp, conversationId } = setup(['claude', 'codex', 'deepseek']);
  const kinds: string[] = [];

  try {
    const runtime = runtimeFor({
      codex: scriptedAdapter('codex', (prompt) => {
        const kind = kindOf(prompt);
        kinds.push(kind);

        if (kind === 'plan' || kind === 'replan') {
          return { text: `${PROSE}\n\n${planBlock({ assign: [], done: true })}` };
        }

        return { text: '整合完成。' };
      }),
      claude: scriptedAdapter('claude', () => ({ text: '不应被调用' })),
      deepseek: scriptedAdapter('deepseek', () => ({ text: '不应被调用' })),
    });

    const started = startCollaboration(
      temp.db,
      conversationId,
      {
        goal: '必须分工',
        coordinator: 'codex',
        minAssignments: 2,
        reviewRequired: false,
      },
      { runtime },
    );

    const blocked = await started.completion;
    const round = findRound(temp.db, blocked.roundId)!;

    assert.equal(blocked.blocked, true);
    assert.equal(round.wake_condition, 'user_decision');
    assert.equal(round.blocked_phase, 'planning');
    assert.match(String(round.blocked_reason), /至少 2 个/);
    assert.match(String(round.blocked_reason), /协调者说明/, '阻塞原因要带上协调者自己的话');
    assert.deepEqual(kinds, ['plan'], '完全拒绝分工时不得自动重规划');

    const retried = resumeCollaboration(
      temp.db,
      blocked.roundId,
      { retryPlanning: true },
      { runtime },
    );
    const again = await retried.completion;

    assert.equal(again.blocked, true);
    assert.deepEqual(kinds, ['plan', 'plan'], '用户批准后只多一个规划回合');
    assert.equal(findRound(temp.db, blocked.roundId)?.status, 'blocked');

    const relaxed = resumeCollaboration(
      temp.db,
      blocked.roundId,
      { minAssignments: 0 },
      { runtime },
    );
    const summary = await relaxed.completion;

    assert.equal(summary.status, 'delivered', '放宽要求后可以正常交付');
    assert.equal(tasksOf(temp, blocked.roundId).length, 0);
    assert.ok(listContributions(temp.db, blocked.roundId).length > 0);
  } finally {
    temp.cleanup();
  }
});

test('D2 校验：部分满足后重规划仍不足，进入阻塞', async () => {
  const { temp, conversationId } = setup(['claude', 'codex', 'deepseek']);
  const kinds: string[] = [];

  try {
    const runtime = runtimeFor({
      codex: scriptedAdapter('codex', (prompt) => {
        const kind = kindOf(prompt);
        kinds.push(kind);

        if (kind === 'plan') {
          return {
            text: planBlock({
              assign: [{ to: 'claude', task: '第一版', type: 'writing', reason: '分工' }],
              done: true,
            }),
          };
        }

        if (kind === 'replan') {
          return {
            text: planBlock({
              assign: [{ to: 'claude', task: '第二版', type: 'writing', reason: '还是自己人' }],
              done: true,
            }),
          };
        }

        return { text: '整合完成。' };
      }),
      claude: scriptedAdapter('claude', () => ({ text: '不应被调用' })),
      deepseek: scriptedAdapter('deepseek', () => ({ text: '不应被调用' })),
    });

    const started = startCollaboration(
      temp.db,
      conversationId,
      { goal: '必须两人', coordinator: 'codex', minAssignments: 2, reviewRequired: false },
      { runtime },
    );

    const summary = await started.completion;

    assert.equal(summary.blocked, true);
    assert.deepEqual(kinds, ['plan', 'replan']);
    assert.equal(tasksOf(temp, started.round.id).length, 0, '未满足要求的计划不得执行');
  } finally {
    temp.cleanup();
  }
});

test('D2 校验：普通任务不会被强迫多人参与', async () => {
  const { temp, conversationId } = setup(['claude', 'codex']);

  try {
    const runtime = runtimeFor({
      codex: scriptedAdapter('codex', (prompt) => {
        const kind = kindOf(prompt);

        if (kind === 'plan') {
          return { text: `${PROSE}\n\n${planBlock({ assign: [], done: true })}` };
        }

        return { text: '交付。' };
      }),
      claude: scriptedAdapter('claude', () => ({ text: '不应被调用' })),
    });

    const started = startCollaboration(
      temp.db,
      conversationId,
      { goal: '一个简单问题', coordinator: 'codex', reviewRequired: false },
      { runtime },
    );

    const summary = await started.completion;

    assert.equal(summary.status, 'delivered');
    assert.equal(summary.outcome, 'completed');
  } finally {
    temp.cleanup();
  }
});

test('D2 提交：贡献不会因为重规划而丢失，也不会被当成任务', async () => {
  const { temp, conversationId } = setup(['claude', 'codex']);

  try {
    const { round } = initRound(temp.db, {
      conversationId,
      goal: '贡献归属',
      coordinator: 'codex',
      contributors: ['claude'],
    });

    const sender = trustedSender(temp.db, conversationId, 'codex');
    recordMessage(temp.db, sender, {
      roundId: round.id,
      kind: 'notice',
      toAgent: 'claude',
      content: '占位',
      requestId: 'd2-1',
    });

    recordContribution(temp.db, {
      roundId: round.id,
      agent: 'codex',
      phase: 'planning',
      text: PROSE,
    });

    assert.equal(tasksOf(temp, round.id).length, 0);
    assert.equal(listContributions(temp.db, round.id)[0]?.agent, 'codex');
  } finally {
    temp.cleanup();
  }
});
