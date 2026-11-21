import assert from 'node:assert/strict';
import test from 'node:test';
import { createConversation } from '../src/conversations/conversation.service.ts';
import { activateBinding } from '../src/harnesses/session.service.ts';
import type { HarnessType } from '../src/harnesses/types.ts';
import { kindOf, planBlock, runtimeFor, scriptedAdapter } from './collab-helpers.ts';
import { createTempDatabase, startTestServer, type TempDatabase } from './helpers.ts';

async function json(
  url: string,
  init?: RequestInit,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(url, init);
  const text = await response.text();
  const body = text === '' ? {} : (JSON.parse(text) as Record<string, unknown>);

  return { status: response.status, body };
}

function errorCode(body: Record<string, unknown>): string | undefined {
  return (body.error as { code?: string } | undefined)?.code;
}

function post(url: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  return json(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function setup(agents: HarnessType[]): { temp: TempDatabase; conversationId: string } {
  const temp = createTempDatabase();
  const conversation = createConversation(temp.db, { title: '协作接口' });

  for (const agent of agents) {
    activateBinding(temp.db, conversation.id, { harnessType: agent, cwd: temp.dir, model: null });
  }

  return { temp, conversationId: conversation.id };
}

async function waitForRound(
  baseUrl: string,
  conversationId: string,
  roundId: string,
  timeoutMs = 8000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const { body } = await json(
      `${baseUrl}/api/conversations/${conversationId}/collab/rounds/${roundId}`,
    );
    const round = body.round as Record<string, unknown>;

    if (['delivered', 'failed', 'cancelled', 'blocked'].includes(String(round.status))) {
      return body;
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error('round did not settle');
}

test('协作 API：发起一轮协作，桌面端能看到状态、角色、任务与交付', async () => {
  const { temp, conversationId } = setup(['claude', 'codex']);
  const runtime = runtimeFor({
    codex: scriptedAdapter('codex', (prompt) => {
      const kind = kindOf(prompt);

      if (kind === 'plan') {
        return {
          text: planBlock({
            assign: [{ to: 'claude', task: '写提纲', type: 'writing', reason: '主笔' }],
            done: false,
          }),
        };
      }

      if (kind === 'checkpoint') return { text: planBlock({ assign: [], done: true }) };

      return { text: '交付完成。' };
    }),
    claude: scriptedAdapter('claude', () => ({ text: '提纲正文' })),
  });
  const server = await startTestServer(temp.db, runtime);

  try {
    const created = await post(
      `${server.baseUrl}/api/conversations/${conversationId}/collab/rounds`,
      { goal: '写一份提纲', coordinator: 'codex', review_required: false },
    );

    assert.equal(created.status, 202);
    const round = created.body.round as Record<string, unknown>;
    assert.equal(round.status, 'created');
    assert.equal(round.coordinator, 'codex');
    assert.ok(created.body.goal_message_id);

    const detail = await waitForRound(server.baseUrl, conversationId, String(round.id));
    const settled = detail.round as Record<string, unknown>;

    assert.equal(settled.status, 'delivered');
    assert.equal(settled.outcome, 'completed');
    assert.deepEqual(settled.budgets, {
      hops: { used: 2, limit: 10 },
      exec: { used: 4, limit: 12 },
      usage_tokens: { limit: null },
    });

    const roles = detail.roles as Array<Record<string, unknown>>;
    assert.equal(roles.length, 2);
    assert.equal(roles.find((role) => role.agent === 'codex')?.role, 'coordinator');

    const tasks = detail.tasks as Array<Record<string, unknown>>;
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0]?.target_agent, 'claude');
    assert.equal(tasks[0]?.task_type, 'writing');
    assert.equal(tasks[0]?.status, 'completed');

    const messages = detail.messages as Array<Record<string, unknown>>;
    assert.ok(messages.some((message) => message.kind === 'assignment'));
    assert.ok(messages.some((message) => message.kind === 'notice'));

    const delivery = detail.delivery as Record<string, unknown> | null;
    assert.ok(delivery);
    assert.match(String(delivery.content), /交付/);

    const list = await json(`${server.baseUrl}/api/conversations/${conversationId}/collab/rounds`);
    assert.equal(list.status, 200);
    assert.equal((list.body.items as unknown[]).length, 1);

    const all = await json(`${server.baseUrl}/api/collab/rounds`);
    assert.equal(all.status, 200);
    const allItems = all.body.items as Array<Record<string, unknown>>;
    assert.equal(allItems[0]?.conversation_title, '协作接口');
  } finally {
    await server.close();
    temp.cleanup();
  }
});

test('协作 API：非法输入被明确拒绝', async () => {
  const { temp, conversationId } = setup(['codex']);
  const server = await startTestServer(temp.db);

  try {
    const empty = await post(
      `${server.baseUrl}/api/conversations/${conversationId}/collab/rounds`,
      { goal: '   ' },
    );
    assert.equal(empty.status, 400);
    assert.equal(errorCode(empty.body), 'invalid_goal');

    const unknownCoordinator = await post(
      `${server.baseUrl}/api/conversations/${conversationId}/collab/rounds`,
      { goal: '做点事', coordinator: 'claude' },
    );
    assert.equal(unknownCoordinator.status, 400);
    assert.equal(errorCode(unknownCoordinator.body), 'invalid_coordinator');

    const negative = await post(
      `${server.baseUrl}/api/conversations/${conversationId}/collab/rounds`,
      { goal: '做点事', budget_exec: -1 },
    );
    assert.equal(negative.status, 400);

    const missing = await json(
      `${server.baseUrl}/api/conversations/not-a-conversation/collab/rounds`,
    );
    assert.equal(missing.status, 404);
  } finally {
    await server.close();
    temp.cleanup();
  }
});

test('协作 API：可以取消正在进行的轮次', async () => {
  const { temp, conversationId } = setup(['claude', 'codex']);
  const runtime = runtimeFor({
    codex: scriptedAdapter('codex', (prompt) => {
      const kind = kindOf(prompt);

      if (kind === 'plan') {
        return {
          text: planBlock({
            assign: [{ to: 'claude', task: '慢任务', type: 'general', reason: '测试' }],
            done: false,
          }),
        };
      }

      return { text: planBlock({ assign: [], done: true }) };
    }),
    claude: scriptedAdapter('claude', () => ({ text: '慢', delayMs: 1200 })),
  });
  const server = await startTestServer(temp.db, runtime);

  try {
    const created = await post(
      `${server.baseUrl}/api/conversations/${conversationId}/collab/rounds`,
      { goal: '可取消', coordinator: 'codex', review_required: false },
    );
    const roundId = String((created.body.round as Record<string, unknown>).id);

    const deadline = Date.now() + 4000;

    while (Date.now() < deadline) {
      const running = temp.db
        .prepare("SELECT COUNT(*) AS n FROM agent_tasks WHERE status = 'running'")
        .get() as { n: number };

      if (running.n > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    const cancelled = await post(
      `${server.baseUrl}/api/conversations/${conversationId}/collab/rounds/${roundId}/cancel`,
      {},
    );

    assert.equal(cancelled.status, 200);
    assert.equal((cancelled.body.round as Record<string, unknown>).status, 'cancelled');

    const again = await post(
      `${server.baseUrl}/api/conversations/${conversationId}/collab/rounds/${roundId}/cancel`,
      {},
    );
    assert.equal(again.status, 409);

    // The child process outlives the cancellation flag; let it exit before the
    // temp directory is removed (Windows keeps the cwd handle open).
    await new Promise((resolve) => setTimeout(resolve, 1500));
  } finally {
    await server.close();
    temp.cleanup();
  }
});

test('协作 API：分工要求未满足时阻塞，放宽后可恢复并保留协调者贡献', async () => {
  const { temp, conversationId } = setup(['claude', 'codex', 'deepseek']);
  const prose =
    '目标用户是重视隐私、经常离线的知识工作者。核心场景是快速记录、按项目整理和跨设备续写。';
  const runtime = runtimeFor({
    codex: scriptedAdapter('codex', (prompt) => {
      const kind = kindOf(prompt);

      if (kind === 'plan' || kind === 'replan') {
        return { text: `${prose}\n\n${planBlock({ assign: [], done: true })}` };
      }

      return { text: '交付。' };
    }),
    claude: scriptedAdapter('claude', () => ({ text: '不应被调用' })),
    deepseek: scriptedAdapter('deepseek', () => ({ text: '不应被调用' })),
  });
  const server = await startTestServer(temp.db, runtime);

  try {
    const created = await post(
      `${server.baseUrl}/api/conversations/${conversationId}/collab/rounds`,
      { goal: '必须由两个 Agent 分工', coordinator: 'codex', min_assignments: 2, review_required: false },
    );
    const roundId = String((created.body.round as Record<string, unknown>).id);

    const blocked = await waitForRound(server.baseUrl, conversationId, roundId);
    const round = blocked.round as Record<string, unknown>;

    assert.equal(round.status, 'blocked');
    assert.equal(round.wake_condition, 'user_decision');
    assert.equal(round.blocked_phase, 'planning');
    assert.equal(round.min_assignments, 2);

    const retried = await post(
      `${server.baseUrl}/api/conversations/${conversationId}/collab/rounds/${roundId}/resume`,
      { retry_planning: true },
    );
    assert.equal(retried.status, 202);

    const stillBlocked = await waitForRound(server.baseUrl, conversationId, roundId);
    assert.equal((stillBlocked.round as Record<string, unknown>).status, 'blocked');

    const resumed = await post(
      `${server.baseUrl}/api/conversations/${conversationId}/collab/rounds/${roundId}/resume`,
      { min_assignments: 0 },
    );
    assert.equal(resumed.status, 202);

    const settled = await waitForRound(server.baseUrl, conversationId, roundId);
    assert.equal((settled.round as Record<string, unknown>).status, 'delivered');

    const contributions = settled.contributions as Array<Record<string, unknown>>;
    assert.equal(contributions.length, 1);
    assert.equal(contributions[0]?.agent, 'codex');
    assert.match(String(contributions[0]?.content), /目标用户/);
  } finally {
    await server.close();
    temp.cleanup();
  }
});

test('协作 API：传播超限阻塞，必须给出新上限才能恢复', async () => {
  const { temp, conversationId } = setup(['claude', 'codex']);
  const runtime = runtimeFor({
    codex: scriptedAdapter('codex', (prompt) => {
      const kind = kindOf(prompt);

      if (kind === 'plan') {
        return {
          text: planBlock({
            assign: [{ to: 'claude', task: '第一步', type: 'general', reason: '开始' }],
            done: false,
          }),
        };
      }

      if (kind === 'checkpoint') {
        return {
          text: planBlock({
            assign: [{ to: 'claude', task: '继续', type: 'general', reason: '继续' }],
            done: false,
          }),
        };
      }

      if (kind === 'resume') return { text: planBlock({ assign: [], done: true }) };

      return { text: '交付。' };
    }),
    claude: scriptedAdapter('claude', () => ({ text: '完成' })),
  });
  const server = await startTestServer(temp.db, runtime);

  try {
    const created = await post(
      `${server.baseUrl}/api/conversations/${conversationId}/collab/rounds`,
      { goal: '传播', coordinator: 'codex', budget_hops: 2, review_required: false },
    );
    const roundId = String((created.body.round as Record<string, unknown>).id);

    const blocked = await waitForRound(server.baseUrl, conversationId, roundId);
    const round = blocked.round as Record<string, unknown>;

    assert.equal(round.status, 'blocked');
    assert.equal(round.wake_condition, 'propagation_limit');
    assert.match(String(round.blocked_reason), /propagation_limit_reached/);

    const withoutHops = await post(
      `${server.baseUrl}/api/conversations/${conversationId}/collab/rounds/${roundId}/resume`,
      {},
    );
    assert.equal(withoutHops.status, 400);
    assert.equal(errorCode(withoutHops.body), 'invalid_budget_hops');

    const resumed = await post(
      `${server.baseUrl}/api/conversations/${conversationId}/collab/rounds/${roundId}/resume`,
      { budget_hops: 10 },
    );
    assert.equal(resumed.status, 202);

    const settled = await waitForRound(server.baseUrl, conversationId, roundId);
    assert.equal((settled.round as Record<string, unknown>).status, 'delivered');
  } finally {
    await server.close();
    temp.cleanup();
  }
});

test('协作 API：用量预算阻塞后必须带上新上限才能恢复', async () => {
  const { temp, conversationId } = setup(['claude']);
  const runtime = runtimeFor({
    claude: scriptedAdapter('claude', (prompt) =>
      kindOf(prompt) === 'plan'
        ? { text: planBlock({ assign: [], done: true }), usageTokens: 10 }
        : { text: '交付。', usageTokens: 10 },
    ),
  });
  const server = await startTestServer(temp.db, runtime);

  try {
    const created = await post(
      `${server.baseUrl}/api/conversations/${conversationId}/collab/rounds`,
      { goal: '跑一次', budget_usage_tokens: 5 },
    );
    const roundId = String((created.body.round as Record<string, unknown>).id);

    const blocked = await waitForRound(server.baseUrl, conversationId, roundId);
    assert.equal((blocked.round as Record<string, unknown>).status, 'blocked');
    assert.equal((blocked.round as Record<string, unknown>).wake_condition, 'user_approval');

    const withoutBudget = await post(
      `${server.baseUrl}/api/conversations/${conversationId}/collab/rounds/${roundId}/resume`,
      {},
    );
    assert.equal(withoutBudget.status, 400);

    const resumed = await post(
      `${server.baseUrl}/api/conversations/${conversationId}/collab/rounds/${roundId}/resume`,
      { budget_usage_tokens: 1000 },
    );
    assert.equal(resumed.status, 202);

    const settled = await waitForRound(server.baseUrl, conversationId, roundId);
    assert.equal((settled.round as Record<string, unknown>).status, 'delivered');
  } finally {
    await server.close();
    temp.cleanup();
  }
});
