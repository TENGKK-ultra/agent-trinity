import assert from 'node:assert/strict';
import test from 'node:test';
import { findRound, createRound } from '../src/collab/messages.service.ts';
import {
  resumeCollaboration,
  startCollaboration,
} from '../src/collab/orchestrator.service.ts';
import { assertHopWithinBudget } from '../src/collab/rounds.service.ts';
import { createConversation } from '../src/conversations/conversation.service.ts';
import { activateBinding } from '../src/harnesses/session.service.ts';
import type { HarnessType } from '../src/harnesses/types.ts';
import { kindOf, planBlock, runtimeFor, scriptedAdapter } from './collab-helpers.ts';
import { createTempDatabase, type TempDatabase } from './helpers.ts';

function setup(agents: HarnessType[]): { temp: TempDatabase; conversationId: string } {
  const temp = createTempDatabase();
  const conversation = createConversation(temp.db, { title: 'hop 预算' });

  for (const agent of agents) {
    activateBinding(temp.db, conversation.id, { harnessType: agent, cwd: temp.dir, model: null });
  }

  return { temp, conversationId: conversation.id };
}

test('hop 预算：默认上限是 10，第 11 跳被拒绝', () => {
  const { temp, conversationId } = setup(['codex']);

  try {
    const round = createRound(temp.db, conversationId, { goal: '默认值' });

    assert.equal(round.budget_hops, 10);
    assert.doesNotThrow(() => assertHopWithinBudget(temp.db, round.id, 10));
    assert.throws(
      () => assertHopWithinBudget(temp.db, round.id, 11),
      (err: unknown) => (err as { code?: string }).code === 'budget_exhausted',
    );
  } finally {
    temp.cleanup();
  }
});

test('hop 预算：超限拒绝继续传播，结果仍回传，用户提高上限后可继续', async () => {
  const { temp, conversationId } = setup(['claude', 'codex']);
  const kinds: string[] = [];
  let checkpoints = 0;

  try {
    const runtime = runtimeFor({
      codex: scriptedAdapter('codex', (prompt) => {
        const kind = kindOf(prompt);
        kinds.push(kind);

        if (kind === 'plan') {
          return {
            text: planBlock({
              assign: [{ to: 'claude', task: '第一步', type: 'general', reason: '开始' }],
              done: false,
            }),
          };
        }

        if (kind === 'checkpoint') {
          checkpoints += 1;

          return {
            text: planBlock({
              assign: [
                {
                  to: 'claude',
                  task: checkpoints === 1 ? '第二步' : '第三步',
                  type: 'general',
                  reason: '继续',
                },
              ],
              done: false,
            }),
          };
        }

        if (kind === 'resume') return { text: planBlock({ assign: [], done: true }) };

        return { text: '交付。' };
      }),
      claude: scriptedAdapter('claude', () => ({ text: '做完了' })),
    });

    const started = startCollaboration(
      temp.db,
      conversationId,
      {
        goal: '让 hop 到达上限',
        coordinator: 'codex',
        budgetHops: 3,
        reviewRequired: false,
      },
      { runtime },
    );

    const blocked = await started.completion;
    const round = findRound(temp.db, blocked.roundId)!;

    assert.equal(blocked.blocked, true);
    assert.equal(round.status, 'blocked');
    assert.equal(round.wake_condition, 'propagation_limit');
    assert.equal(round.blocked_phase, 'work');
    assert.match(String(round.blocked_reason), /propagation_limit_reached/);

    const tasks = temp.db
      .prepare('SELECT status FROM agent_tasks WHERE chain_id = ?')
      .all(started.round.id) as Array<{ status: string }>;

    assert.equal(tasks.length, 2, '被拒绝的是第三个指派');
    assert.ok(tasks.every((task) => task.status === 'completed'));

    const notices = temp.db
      .prepare(
        "SELECT hop FROM agent_messages WHERE round_id = ? AND kind = 'notice' ORDER BY rowid",
      )
      .all(started.round.id) as Array<{ hop: number }>;

    assert.equal(notices.length, 2, '每个已完成任务的结果都要回传');
    assert.ok(
      notices.some((notice) => notice.hop > round.budget_hops),
      '结果回传不受传播上限拦截',
    );

    const chat = temp.db
      .prepare(
        `SELECT COUNT(*) AS n FROM messages
          WHERE conversation_id = ? AND metadata_json LIKE '%propagation_limit_reached%'`,
      )
      .get(conversationId) as { n: number };

    assert.equal(chat.n, 1, '超限必须留下明确记录');

    const resumed = resumeCollaboration(
      temp.db,
      blocked.roundId,
      { budgetHops: 10 },
      { runtime },
    );
    const summary = await resumed.completion;

    assert.equal(summary.status, 'delivered');
    assert.ok(kinds.includes('resume'), '恢复后协调者获得一次明确的续接回合');
    assert.equal(kinds.filter((kind) => kind === 'checkpoint').length, 2);
  } finally {
    temp.cleanup();
  }
});

test('hop 预算：没有新上限不能恢复传播阻塞', () => {
  const { temp, conversationId } = setup(['claude', 'codex']);

  try {
    const round = createRound(temp.db, conversationId, {
      goal: '阻塞',
      coordinator: 'codex',
      budgetHops: 3,
    });

    temp.db
      .prepare(
        "UPDATE collab_rounds SET status = 'blocked', wake_condition = 'propagation_limit' WHERE id = ?",
      )
      .run(round.id);

    assert.throws(
      () => resumeCollaboration(temp.db, round.id, {}),
      (err: unknown) => (err as { code?: string }).code === 'invalid_budget_hops',
    );
  } finally {
    temp.cleanup();
  }
});
