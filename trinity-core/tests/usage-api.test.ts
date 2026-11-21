import assert from 'node:assert/strict';
import test from 'node:test';
import { createConversation } from '../src/conversations/conversation.service.ts';
import { createTask } from '../src/harnesses/task.service.ts';
import {
  recordUsage,
  type ProviderUsage,
  type RecordUsageInput,
} from '../src/usage/usage.service.ts';
import { createTempDatabase, startTestServer } from './helpers.ts';

type Extra = Omit<Partial<RecordUsageInput>, 'usage'> & { usage?: Partial<ProviderUsage> };

function add(
  db: ReturnType<typeof createTempDatabase>['db'],
  conversationId: string,
  turnId: string,
  extra: Extra = {},
): void {
  const { usage, ...rest } = extra;

  recordUsage(db, {
    agent: 'claude',
    conversationId,
    turnId,
    providerSessionId: null,
    taskId: null,
    model: null,
    scope: 'turn',
    counterScope: 'turn',
    usage: {
      inputTokens: 100,
      outputTokens: 10,
      cacheReadTokens: 20,
      cacheWriteTokens: 5,
      cacheInInput: false,
      ...(usage ?? {}),
    },
    ...rest,
  });
}

async function get(url: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(url);
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

test('Usage API：汇总按 Agent 与配置模型分组', async () => {
  const temp = createTempDatabase();
  const server = await startTestServer(temp.db);

  try {
    const conversation = createConversation(temp.db, { title: '用量' });

    add(temp.db, conversation.id, 'turn-1', { model: 'claude-x' });
    add(temp.db, conversation.id, 'turn-2', {
      agent: 'codex',
      model: null,
      counterScope: 'thread',
      providerSessionId: 'thread-a',
      usage: {
        inputTokens: 1000,
        outputTokens: 20,
        cacheReadTokens: 900,
        cacheWriteTokens: 0,
        cacheInInput: true,
      },
    });

    const { status, body } = await get(`${server.baseUrl}/api/usage/summary`);
    assert.equal(status, 200);

    const totals = body.totals as Record<string, number | null>;
    assert.equal(totals.input_tokens, 200, '100 + (1000−900)');
    assert.equal(totals.output_tokens, 30);
    assert.equal(totals.cache_read_tokens, 920);
    assert.equal(totals.cache_write_tokens, 5);
    assert.equal(totals.total_tokens, 1155);
    assert.equal(totals.cost_usd, null, '没有任何 Provider 成本时必须为 NULL');

    const byAgent = body.by_agent as Array<Record<string, unknown>>;
    assert.deepEqual(byAgent.map((row) => row.agent), ['claude', 'codex']);
    assert.equal(byAgent[1]!.input_tokens, 100);

    const byModel = body.by_model as Array<Record<string, unknown>>;
    const withModel = byModel.find((row) => row.configured_model === 'claude-x');
    const withoutModel = byModel.find((row) => row.configured_model === null);
    assert.ok(withModel);
    assert.ok(withoutModel);
  } finally {
    await server.close();
    temp.cleanup();
  }
});

test('Usage API：NULL 与 0 不混淆，reasoning 不进输出', async () => {
  const temp = createTempDatabase();
  const server = await startTestServer(temp.db);

  try {
    const conversation = createConversation(temp.db, { title: '用量' });

    add(temp.db, conversation.id, 'turn-null', {
      model: 'no-cost',
      usage: { costUsd: null, reasoningOutputTokens: 6 },
    });
    add(temp.db, conversation.id, 'turn-zero', { model: 'zero-cost', usage: { costUsd: 0 } });

    const nullOnly = await get(
      `${server.baseUrl}/api/usage/summary?model=no-cost`,
    );
    assert.equal((nullOnly.body.totals as Record<string, unknown>).cost_usd, null);
    assert.equal((nullOnly.body.totals as Record<string, unknown>).output_tokens, 10);

    const zeroOnly = await get(`${server.baseUrl}/api/usage/summary?model=zero-cost`);
    assert.equal((zeroOnly.body.totals as Record<string, unknown>).cost_usd, 0);
  } finally {
    await server.close();
    temp.cleanup();
  }
});

test('Usage API：每日分桶按 Asia/Shanghai（UTC+8）', async () => {
  const temp = createTempDatabase();
  const server = await startTestServer(temp.db);

  try {
    const conversation = createConversation(temp.db, { title: '用量' });

    // 23:59 local on the 20th.
    add(temp.db, conversation.id, 'turn-late', { recordedAt: '2026-11-20T15:59:00.000Z' });
    // 00:30 local on the 21st.
    add(temp.db, conversation.id, 'turn-early', { recordedAt: '2026-11-20T16:30:00.000Z' });

    const { body } = await get(`${server.baseUrl}/api/usage/daily`);
    const days = body.days as Array<Record<string, unknown>>;

    assert.deepEqual(
      days.map((row) => row.date),
      ['2026-11-20', '2026-11-21'],
    );
    assert.equal(days[0]!.input_tokens, 100);
    assert.equal(days[1]!.input_tokens, 100);
  } finally {
    await server.close();
    temp.cleanup();
  }
});

test('Usage API：日期范围、Agent 与模型过滤', async () => {
  const temp = createTempDatabase();
  const server = await startTestServer(temp.db);

  try {
    const conversation = createConversation(temp.db, { title: '用量' });

    add(temp.db, conversation.id, 'turn-old', {
      model: 'm1',
      recordedAt: '2026-11-19T02:00:00.000Z',
    });
    add(temp.db, conversation.id, 'turn-new', {
      model: 'm1',
      recordedAt: '2026-11-20T02:00:00.000Z',
    });
    add(temp.db, conversation.id, 'turn-codex', {
      agent: 'codex',
      model: 'm2',
      counterScope: 'thread',
      providerSessionId: 'thread-a',
      recordedAt: '2026-11-20T03:00:00.000Z',
      usage: {
        inputTokens: 1000,
        outputTokens: 20,
        cacheReadTokens: 900,
        cacheWriteTokens: 0,
        cacheInInput: true,
      },
    });

    const ranged = await get(`${server.baseUrl}/api/usage/summary?from=2026-11-20&to=2026-11-20`);
    assert.equal((ranged.body.totals as Record<string, unknown>).input_tokens, 200);

    const byAgent = await get(`${server.baseUrl}/api/usage/summary?agent=codex`);
    assert.equal((byAgent.body.totals as Record<string, unknown>).input_tokens, 100);

    const byModel = await get(`${server.baseUrl}/api/usage/summary?model=m1`);
    assert.equal((byModel.body.totals as Record<string, unknown>).input_tokens, 200);
  } finally {
    await server.close();
    temp.cleanup();
  }
});

test('Usage API：会话查询隔离、明细白名单与数量上限', async () => {
  const temp = createTempDatabase();
  const server = await startTestServer(temp.db);

  try {
    const alpha = createConversation(temp.db, { title: 'Alpha' });
    const beta = createConversation(temp.db, { title: 'Beta' });

    add(temp.db, alpha.id, 'turn-a');
    add(temp.db, beta.id, 'turn-b');

    const { status, body } = await get(`${server.baseUrl}/api/conversations/${alpha.id}/usage`);
    assert.equal(status, 200);
    assert.equal((body.totals as Record<string, unknown>).input_tokens, 100);

    const items = body.items as Array<Record<string, unknown>>;
    assert.equal(items.length, 1);
    assert.deepEqual(
      Object.keys(items[0]!).sort(),
      [
        'agent',
        'anomaly',
        'cache_read_tokens',
        'cache_write_tokens',
        'configured_model',
        'cost_usd',
        'input_tokens',
        'output_tokens',
        'recorded_at',
        'scope',
        'task_id',
        'total_tokens',
        'turn_id',
      ].sort(),
    );
    assert.equal('provider_session_id' in items[0]!, false);

    const tooMany = await fetch(
      `${server.baseUrl}/api/conversations/${alpha.id}/usage?limit=201`,
    );
    assert.equal(tooMany.status, 400);

    const missing = await fetch(`${server.baseUrl}/api/conversations/missing/usage`);
    assert.equal(missing.status, 404);
  } finally {
    await server.close();
    temp.cleanup();
  }
});

test('Usage API：任务累计与多 step 不合并', async () => {
  const temp = createTempDatabase();
  const server = await startTestServer(temp.db);

  try {
    const conversation = createConversation(temp.db, { title: '任务用量' });
    const task = createTask(temp.db, {
      conversationId: conversation.id,
      sourceAgent: 'claude',
      targetAgent: 'deepseek',
      instruction: '调查',
    });

    add(temp.db, conversation.id, 'turn-task', { taskId: task.id });

    // Two steps in the same turn must both count.
    add(temp.db, conversation.id, 'turn-dsh', {
      agent: 'deepseek',
      scope: 'step',
      providerTurn: 1,
      providerStep: 1,
      usage: { inputTokens: 10, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
    });
    add(temp.db, conversation.id, 'turn-dsh', {
      agent: 'deepseek',
      scope: 'step',
      providerTurn: 1,
      providerStep: 2,
      usage: { inputTokens: 20, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
    });

    const taskUsage = await get(
      `${server.baseUrl}/api/conversations/${conversation.id}/tasks/${task.id}/usage`,
    );
    assert.equal(taskUsage.status, 200);
    assert.equal((taskUsage.body.totals as Record<string, unknown>).input_tokens, 100);

    const all = await get(`${server.baseUrl}/api/conversations/${conversation.id}/usage`);
    assert.equal((all.body.totals as Record<string, unknown>).input_tokens, 130);

    const missing = await fetch(
      `${server.baseUrl}/api/conversations/${conversation.id}/tasks/missing/usage`,
    );
    assert.equal(missing.status, 404);
  } finally {
    await server.close();
    temp.cleanup();
  }
});

test('Usage API：空结果与参数校验', async () => {
  const temp = createTempDatabase();
  const server = await startTestServer(temp.db);

  try {
    const conversation = createConversation(temp.db, { title: '空' });

    const empty = await get(`${server.baseUrl}/api/usage/summary`);
    assert.deepEqual(empty.body.totals, {
      input_tokens: null,
      output_tokens: null,
      cache_read_tokens: null,
      cache_write_tokens: null,
      total_tokens: null,
      cost_usd: null,
    });
    assert.deepEqual(empty.body.by_agent, []);

    const daily = await get(`${server.baseUrl}/api/usage/daily`);
    assert.deepEqual(daily.body.days, []);

    assert.equal((await fetch(`${server.baseUrl}/api/usage/summary?agent=foo`)).status, 400);
    assert.equal((await fetch(`${server.baseUrl}/api/usage/summary?from=2026-13-99`)).status, 400);

    const emptyConversation = await get(`${server.baseUrl}/api/conversations/${conversation.id}/usage`);
    assert.equal((emptyConversation.body.items as unknown[]).length, 0);
  } finally {
    await server.close();
    temp.cleanup();
  }
});
