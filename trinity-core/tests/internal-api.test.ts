import assert from 'node:assert/strict';
import test from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import { createConversation } from '../src/conversations/conversation.service.ts';
import { issueToken, resetTokens, revokeToken } from '../src/harnesses/token.service.ts';
import { createTempDatabase, startTestServer, type TempDatabase } from './helpers.ts';

interface Ctx {
  temp: TempDatabase;
  baseUrl: string;
  conversationId: string;
  token: string;
}

async function withServer(run: (ctx: Ctx) => Promise<void>): Promise<void> {
  resetTokens();
  const temp = createTempDatabase();
  const server = await startTestServer(temp.db);
  const conversation = createConversation(temp.db, { title: '内部接口' });
  const entry = issueToken({
    conversationId: conversation.id,
    sourceAgent: 'claude',
    sourceTurnId: 'turn-source',
  });

  try {
    await run({
      temp,
      baseUrl: server.baseUrl,
      conversationId: conversation.id,
      token: entry.token,
    });
  } finally {
    await server.close();
    temp.cleanup();
  }
}

function post(baseUrl: string, path: string, token: string | null, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(body),
  });
}

function taskCount(db: DatabaseSync): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM agent_tasks').get() as { n: number }).n;
}

const VALID_BODY = {
  request_id: 'req-1',
  target_agent: 'codex',
  instruction: '检查迁移文件并报告结论',
};

test('D3.5.3b.1 内部接口：没有令牌、伪造令牌、已撤销令牌都是 401', async () => {
  await withServer(async (ctx) => {
    const none = await post(ctx.baseUrl, '/api/internal/tasks', null, VALID_BODY);
    assert.equal(none.status, 401);

    const fake = await post(ctx.baseUrl, '/api/internal/tasks', 'made-up', VALID_BODY);
    assert.equal(fake.status, 401);

    revokeToken(ctx.token);
    const revoked = await post(ctx.baseUrl, '/api/internal/tasks', ctx.token, VALID_BODY);
    assert.equal(revoked.status, 401);

    assert.equal(taskCount(ctx.temp.db), 0, '鉴权失败不留下任务');
  });
});

test('D3.5.3b.1 并发幂等：10 个同 request_id 请求只产生一条任务、消耗一次配额', async () => {
  await withServer(async (ctx) => {
    const responses = await Promise.all(
      Array.from({ length: 10 }, () =>
        post(ctx.baseUrl, '/api/internal/tasks', ctx.token, VALID_BODY),
      ),
    );

    const bodies = await Promise.all(
      responses.map((response) => response.json() as Promise<{ task_id: string }>),
    );

    for (const response of responses) {
      assert.ok(response.status === 200 || response.status === 201, `unexpected ${response.status}`);
    }

    const ids = new Set(bodies.map((body) => body.task_id));
    assert.equal(ids.size, 1, '所有请求必须指向同一个任务');
    assert.equal(taskCount(ctx.temp.db), 1, '数据库只能有一条任务');
  });
});

test('D3.5.3b.1 配额：第 5 个不同 request_id 返回 429', async () => {
  await withServer(async (ctx) => {
    for (let i = 0; i < 4; i += 1) {
      const response = await post(ctx.baseUrl, '/api/internal/tasks', ctx.token, {
        ...VALID_BODY,
        request_id: `req-${i}`,
      });
      assert.equal(response.status, 201, `第 ${i + 1} 次应当成功`);
    }

    const fifth = await post(ctx.baseUrl, '/api/internal/tasks', ctx.token, {
      ...VALID_BODY,
      request_id: 'req-5',
    });

    assert.equal(fifth.status, 429);
    assert.equal(taskCount(ctx.temp.db), 4);
  });
});

test('D3.5.3b.1 身份：请求体里的身份字段被忽略，一切以令牌为准', async () => {
  await withServer(async (ctx) => {
    const other = createConversation(ctx.temp.db, { title: '别的对话' });

    const response = await post(ctx.baseUrl, '/api/internal/tasks', ctx.token, {
      ...VALID_BODY,
      source_agent: 'codex',
      conversation_id: other.id,
      turn_id: 'turn-forged',
    });

    assert.equal(response.status, 201);
    const body = (await response.json()) as { task_id: string };

    const row = ctx.temp.db
      .prepare('SELECT * FROM agent_tasks WHERE id = ?')
      .get(body.task_id) as { conversation_id: string; source_agent: string; source_turn_id: string };

    assert.equal(row.conversation_id, ctx.conversationId, '不能被请求体改到别的对话');
    assert.equal(row.source_agent, 'claude', '不能被请求体冒充成 codex');
    assert.equal(row.source_turn_id, 'turn-source');
  });
});

test('D3.5.3b.1 参数：非法目标、空指令、自委派都被拒绝且不建任务', async () => {
  await withServer(async (ctx) => {
    const badTarget = await post(ctx.baseUrl, '/api/internal/tasks', ctx.token, {
      ...VALID_BODY,
      target_agent: 'gemini',
    });
    assert.equal(badTarget.status, 400);

    const emptyInstruction = await post(ctx.baseUrl, '/api/internal/tasks', ctx.token, {
      ...VALID_BODY,
      instruction: '   ',
    });
    assert.equal(emptyInstruction.status, 400);

    const selfDelegate = await post(ctx.baseUrl, '/api/internal/tasks', ctx.token, {
      ...VALID_BODY,
      target_agent: 'claude',
    });
    assert.equal(selfDelegate.status, 400);

    assert.equal(taskCount(ctx.temp.db), 0);
  });
});

test('D3.5.3b.1 交付确认：幂等，且不允许跨对话', async () => {
  await withServer(async (ctx) => {
    const created = await post(ctx.baseUrl, '/api/internal/tasks', ctx.token, VALID_BODY);
    const { task_id: taskId } = (await created.json()) as { task_id: string };

    const first = await post(ctx.baseUrl, `/api/internal/tasks/${taskId}/delivered`, ctx.token, {});
    assert.equal(first.status, 200);
    assert.equal(((await first.json()) as { delivery_status: string }).delivery_status, 'delivered');

    const again = await post(ctx.baseUrl, `/api/internal/tasks/${taskId}/delivered`, ctx.token, {});
    assert.equal(again.status, 200);
    assert.equal(((await again.json()) as { delivery_status: string }).delivery_status, 'delivered');

    const stranger = issueToken({
      conversationId: 'another-conversation',
      sourceAgent: 'claude',
      sourceTurnId: 'turn-x',
    });
    const foreign = await post(
      ctx.baseUrl,
      `/api/internal/tasks/${taskId}/delivered`,
      stranger.token,
      {},
    );
    assert.equal(foreign.status, 404, '别的对话的令牌不能标记这条任务的交付');
  });
});

test('D3.5.3b.1 边界：令牌不能当通用 Core 凭证使用', async () => {
  await withServer(async (ctx) => {
    // 公共接口本来就不看 Authorization；带上令牌不会获得任何额外能力。
    const withToken = await fetch(`${ctx.baseUrl}/api/conversations?limit=1`, {
      headers: { authorization: `Bearer ${ctx.token}` },
    });
    assert.equal(withToken.status, 200);

    // 内部接口只认它自己的路径，未知路径一律 404。
    const wrongPath = await post(ctx.baseUrl, '/api/internal/conversations', ctx.token, {});
    assert.equal(wrongPath.status, 404);

    const wrongMethod = await fetch(`${ctx.baseUrl}/api/internal/tasks`, {
      headers: { authorization: `Bearer ${ctx.token}` },
    });
    assert.equal(wrongMethod.status, 405);
  });
});
