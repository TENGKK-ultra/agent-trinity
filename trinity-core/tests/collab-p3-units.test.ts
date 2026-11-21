import assert from 'node:assert/strict';
import test from 'node:test';
import { assertBudgetAllowsWork, claimExec, execLeft, raiseUsageBudget, usageLeft, usageOf } from '../src/collab/budget.service.ts';
import { createCapabilityResolver, evidenceOf, verdictOf } from '../src/collab/capability.service.ts';
import { parsePlan } from '../src/collab/plan.ts';
import { parseReviewOutput, runReview, selectReviewer } from '../src/collab/review.service.ts';
import { initRound, listRoles, type InitRoundInput } from '../src/collab/roles.service.ts';
import { findRound } from '../src/collab/messages.service.ts';
import { createConversation } from '../src/conversations/conversation.service.ts';
import { recordUsage } from '../src/usage/usage.service.ts';
import { markTaskRunning, completeTask, createTask } from '../src/harnesses/task.service.ts';
import { activateBinding } from '../src/harnesses/session.service.ts';
import { addMessage } from '../src/messages/message.service.ts';
import { createTempDatabase, type TempDatabase } from './helpers.ts';

function fixture(agents: Array<'claude' | 'codex' | 'deepseek'> = ['claude', 'codex', 'deepseek']) {
  const temp = createTempDatabase();
  const conversation = createConversation(temp.db, { title: 'P3 单元' });

  for (const harnessType of agents) {
    activateBinding(temp.db, conversation.id, { harnessType, cwd: temp.dir, model: null });
  }

  return { temp, conversationId: conversation.id };
}

function roundFor(
  temp: TempDatabase,
  conversationId: string,
  goal: string,
  coordinator: 'claude' | 'codex' | 'deepseek' = 'codex',
  extra: Partial<InitRoundInput> = {},
) {
  return initRound(temp.db, {
    conversationId,
    goal,
    coordinator,
    contributors: ['claude', 'codex', 'deepseek'].filter((agent) => agent !== coordinator) as Array<
      'claude' | 'codex' | 'deepseek'
    >,
    ...extra,
  }).round;
}

function useTokens(
  temp: TempDatabase,
  conversationId: string,
  roundId: string,
  tokens: number,
  taskId: string | null = null,
): void {
  recordUsage(temp.db, {
    agent: 'claude',
    conversationId,
    turnId: `turn-${Math.random().toString(16).slice(2)}`,
    providerSessionId: null,
    taskId,
    roundId,
    model: null,
    scope: 'turn',
    counterScope: 'turn',
    usage: {
      inputTokens: tokens,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      cacheInInput: false,
    },
  });
}

// ---------- 预算 ----------

test('P3 预算：执行预算按回合扣减，耗尽后拒绝新回合', () => {
  const { temp, conversationId } = fixture(['codex']);
  const round = roundFor(temp, conversationId, '预算', 'codex', { budgetExec: 2 });

  try {
    assert.equal(execLeft(temp.db, round.id), 2);
    assert.equal(claimExec(temp.db, round.id), true);
    assert.equal(claimExec(temp.db, round.id), true);
    assert.equal(claimExec(temp.db, round.id), false, '第三个回合不得再占用');
    assert.equal(execLeft(temp.db, round.id), 0);

    assert.throws(
      () => assertBudgetAllowsWork(temp.db, round.id),
      (err: unknown) => (err as { scope?: string }).scope === 'exec',
    );
  } finally {
    temp.cleanup();
  }
});

test('P3 预算：用量预算读取同一本账，任务的用量也算进本轮', () => {
  const { temp, conversationId } = fixture(['claude', 'codex']);
  const round = roundFor(temp, conversationId, '用量', 'codex', { budgetUsageTokens: 100 });

  try {
    assert.equal(usageOf(temp.db, round.id).tokens, null, '没有记录时是未知，不是 0');
    assert.equal(usageLeft(temp.db, round.id), 100);

    const task = createTask(temp.db, {
      conversationId,
      sourceAgent: null,
      targetAgent: 'claude',
      instruction: '探索',
      chainId: round.id,
      orchestrated: true,
    });

    useTokens(temp, conversationId, round.id, 30, null);
    useTokens(temp, conversationId, round.id, 20, task.id);

    assert.equal(usageOf(temp.db, round.id).tokens, 50);
    assert.equal(usageLeft(temp.db, round.id), 50);

    assertBudgetAllowsWork(temp.db, round.id);

    useTokens(temp, conversationId, round.id, 60, null);
    assert.equal(usageOf(temp.db, round.id).tokens, 110);

    assert.throws(
      () => assertBudgetAllowsWork(temp.db, round.id),
      (err: unknown) => (err as { scope?: string }).scope === 'usage',
    );

    raiseUsageBudget(temp.db, round.id, 200);
    assert.equal(findRound(temp.db, round.id)?.budget_usage_tokens, 200);
    assertBudgetAllowsWork(temp.db, round.id);
  } finally {
    temp.cleanup();
  }
});

test('P3 预算：终态轮次不能再占用回合', () => {
  const { temp, conversationId } = fixture(['codex']);
  const round = roundFor(temp, conversationId, '终态', 'codex', { budgetExec: 5 });

  try {
    temp.db
      .prepare("UPDATE collab_rounds SET status = 'delivered', outcome = 'completed' WHERE id = ?")
      .run(round.id);

    assert.equal(claimExec(temp.db, round.id), false);
  } finally {
    temp.cleanup();
  }
});

// ---------- 能力 ----------

test('P3 能力：未绑定是 no，无完成记录是 unknown，有完成记录才是 yes', () => {
  const { temp, conversationId } = fixture(['claude', 'codex']);

  try {
    assert.equal(verdictOf(evidenceOf(temp.db, conversationId, 'deepseek', 'general')), 'no');
    assert.equal(verdictOf(evidenceOf(temp.db, conversationId, 'claude', 'research')), 'unknown');

    const task = createTask(temp.db, {
      conversationId,
      sourceAgent: null,
      targetAgent: 'claude',
      instruction: '查资料',
      taskType: 'research',
      orchestrated: true,
    });

    markTaskRunning(temp.db, task.id, 'turn-1');
    const result = addMessage(temp.db, conversationId, {
      content: '资料在这里',
      message_type: 'agent_final',
      sender_kind: 'agent',
      sender_id: 'claude',
    });
    completeTask(temp.db, task.id, result.id);

    const evidence = evidenceOf(temp.db, conversationId, 'claude', 'research');
    assert.equal(evidence.completed, 1);
    assert.equal(verdictOf(evidence), 'yes');
    assert.equal(
      verdictOf(evidenceOf(temp.db, conversationId, 'claude', 'general')),
      'unknown',
      '证据按任务类型计，不得跨类型冒充',
    );

    const resolver = createCapabilityResolver(temp.db, conversationId);
    assert.equal(resolver.verdict('claude', 'research'), 'yes');
    assert.equal(resolver.verdict('codex', 'research'), 'unknown');
  } finally {
    temp.cleanup();
  }
});

test('P3 能力：失败次数不构成 no，也不构成 yes', () => {
  const { temp, conversationId } = fixture(['claude']);
  const round = roundFor(temp, conversationId, '失败', 'claude', { budgetExec: 5 });

  try {
    for (let i = 0; i < 3; i += 1) {
      const task = createTask(temp.db, {
        conversationId,
        sourceAgent: null,
        targetAgent: 'claude',
        instruction: `失败 ${i}`,
        taskType: 'research',
        chainId: round.id,
        orchestrated: true,
      });
      temp.db.prepare("UPDATE agent_tasks SET status = 'failed' WHERE id = ?").run(task.id);
    }

    const evidence = evidenceOf(temp.db, conversationId, 'claude', 'research');
    assert.equal(evidence.failed, 3);
    assert.equal(evidence.completed, 0);
    assert.equal(verdictOf(evidence), 'unknown', '失败不是能力结论');
  } finally {
    temp.cleanup();
  }
});

// ---------- 计划解析 ----------

test('P3 计划：JSON 块最多三项，去重，跳过自己和未知 Agent', () => {
  const plan = parsePlan(
    [
      '先分工。',
      '```collab',
      JSON.stringify({
        assign: [
          { to: 'deepseek', task: '查资料', type: 'research', reason: '擅长检索' },
          { to: 'deepseek', task: '重复', type: 'research', reason: '重复' },
          { to: 'claude', task: '做视觉', type: 'design' },
          { to: 'codex', task: '自指派' },
          { to: 'gemini', task: '不存在的 Agent' },
          { to: 'claude', task: '第二个任务' },
        ],
        done: false,
      }),
      '```',
    ].join('\n'),
    ['claude', 'codex', 'deepseek'],
    'codex',
  );

  assert.equal(plan.source, 'json');
  assert.equal(plan.done, false);
  assert.deepEqual(plan.assignments.map((item) => item.to), ['deepseek', 'claude']);
  assert.equal(plan.assignments[0]?.type, 'research');
  assert.equal(plan.assignments[1]?.reason, '协调者分配');
});

test('P3 计划：损坏的 JSON 回退到 @提及，没有动作则结束', () => {
  const mentioned = parsePlan('我让 @Claude 接手核对', ['claude', 'codex'], 'codex');
  assert.equal(mentioned.source, 'mentions');
  assert.deepEqual(mentioned.assignments.map((item) => item.to), ['claude']);

  const broken = parsePlan('```collab\n{ not json }\n```\n请 @Claude 看一下', ['claude'], 'codex');
  assert.equal(broken.source, 'mentions');

  const none = parsePlan('我现在就结束，没有后续动作。', ['claude'], 'codex');
  assert.equal(none.source, 'none');
  assert.equal(none.done, true);
  assert.equal(none.assignments.length, 0);
});

test('P3 计划：协调者可以接受或拒绝请求，但只能针对已知 Agent', () => {
  const plan = parsePlan(
    [
      '```collab',
      JSON.stringify({
        assign: [],
        resolve: [
          { from: 'claude', decision: 'accept', reason: '我来做' },
          { from: 'codex', decision: 'refuse', reason: '不能自己拒绝自己' },
          { from: 'deepseek', decision: 'maybe' },
          { from: 'gemini', decision: 'accept' },
        ],
        done: false,
      }),
      '```',
    ].join('\n'),
    ['claude', 'codex', 'deepseek'],
    'codex',
  );

  assert.deepEqual(
    plan.resolutions.map((item) => [item.from, item.decision]),
    [['claude', 'accept']],
  );
});

// ---------- 审查 ----------

test('P3 审查：结论只接受 pass / needs_changes，其余记为不可用', () => {
  assert.equal(
    parseReviewOutput('```collab\n{"review":{"status":"pass","findings":[]}}\n```').status,
    'pass',
  );

  const needs = parseReviewOutput(
    '```collab\n{"review":{"status":"needs_changes","findings":["缺少来源"]}}\n```',
  );
  assert.equal(needs.status, 'needs_changes');
  assert.deepEqual(needs.items, ['缺少来源']);

  assert.equal(parseReviewOutput('看起来基本可以').status, 'review_unavailable');
  assert.equal(
    parseReviewOutput('```collab\n{"review":{"status":"ok"}}\n```').status,
    'review_unavailable',
  );
});

test('P3 审查：审查者不能是产出者，也不能是协调者，优先不同 Provider', () => {
  const { temp, conversationId } = fixture();
  const round = roundFor(temp, conversationId, '审查者', 'codex');

  try {
    assert.equal(selectReviewer(temp.db, round.id, ['claude'], ['codex']), 'deepseek');
    assert.equal(selectReviewer(temp.db, round.id, ['claude', 'deepseek'], ['codex']), null);
    assert.equal(selectReviewer(temp.db, round.id, [], ['codex']), 'claude', '同 Provider 也优于没有');
  } finally {
    temp.cleanup();
  }
});

test('P3 审查：没有独立审查者时记为 review_unavailable，不伪造通过', async () => {
  const { temp, conversationId } = fixture(['claude']);
  const round = roundFor(temp, conversationId, '不可用', 'claude');

  try {
    let called = false;
    const row = await runReview(temp.db, {
      round,
      producers: ['claude'],
      excluded: ['claude'],
      deliverable: '成果',
      runner: async () => {
        called = true;
        return { ok: true, text: '```collab\n{"review":{"status":"pass"}}\n```' };
      },
    });

    assert.equal(called, false, '没有独立审查者时不得启动审查回合');
    assert.equal(row.status, 'review_unavailable');
    assert.equal(row.reviewer, null);
  } finally {
    temp.cleanup();
  }
});

test('P3 审查：记录审查者、模型与是否同 Provider，结论来自真实输出', async () => {
  const { temp, conversationId } = fixture();
  const round = roundFor(temp, conversationId, '审查', 'codex');

  try {
    let seen = '';
    const row = await runReview(temp.db, {
      round,
      producers: ['claude'],
      excluded: ['codex'],
      deliverable: '成果',
      runner: async (turn) => {
        seen = turn.prompt;
        return { ok: true, text: '```collab\n{"review":{"status":"needs_changes","findings":["缺数据"]}}\n```' };
      },
    });

    assert.match(seen, /独立审查/);
    assert.equal(row.reviewer, 'deepseek');
    assert.equal(row.producer, 'claude');
    assert.equal(row.same_provider, 0, 'deepseek 与 claude 不是同一 Provider');
    assert.equal(row.status, 'needs_changes');
    assert.match(row.findings_json ?? '', /缺数据/);
  } finally {
    temp.cleanup();
  }
});

test('P3 审查：审查回合失败也算不可用，不是通过', async () => {
  const { temp, conversationId } = fixture();
  const round = roundFor(temp, conversationId, '审查失败', 'codex');

  try {
    const row = await runReview(temp.db, {
      round,
      producers: ['claude'],
      excluded: ['codex'],
      deliverable: '成果',
      runner: async () => ({ ok: false, text: null }),
    });

    assert.equal(row.status, 'review_unavailable');
    assert.ok(row.reviewer !== null, '审查者被选中了，只是回合失败');
  } finally {
    temp.cleanup();
  }
});

test('P3 角色：一轮里三个 Agent 都有角色记录', () => {
  const { temp, conversationId } = fixture();
  const round = roundFor(temp, conversationId, '角色', 'codex');

  try {
    const roles = listRoles(temp.db, round.id);
    assert.equal(roles.length, 3);
    assert.equal(roles.find((row) => row.agent === 'codex')?.role, 'coordinator');
  } finally {
    temp.cleanup();
  }
});
