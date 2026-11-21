import assert from 'node:assert/strict';
import test from 'node:test';
import { openDatabase } from '../src/database/connection.ts';
import { createTempDatabase, startTestServer } from './helpers.ts';

interface JsonRecord {
  [key: string]: unknown;
}

async function json(response: Response): Promise<JsonRecord> {
  return (await response.json()) as JsonRecord;
}

test('API：创建对话、列表、详情、修改标题全链路', async () => {
  const temp = createTempDatabase();
  const server = await startTestServer(temp.db);

  try {
    const created = await fetch(`${server.baseUrl}/api/conversations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'API 对话' }),
    });

    assert.equal(created.status, 201);
    const conversation = await json(created);
    const conversationId = String(conversation.id);
    assert.ok(conversationId);
    assert.equal(conversation.title, 'API 对话');

    const listed = await fetch(`${server.baseUrl}/api/conversations`);
    assert.equal(listed.status, 200);
    const listBody = await json(listed);
    assert.equal(listBody.total, 1);

    const detail = await fetch(`${server.baseUrl}/api/conversations/${conversationId}`);
    assert.equal(detail.status, 200);
    assert.equal((await json(detail)).id, conversationId);

    const patched = await fetch(`${server.baseUrl}/api/conversations/${conversationId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '改名后' }),
    });

    assert.equal(patched.status, 200);
    assert.equal((await json(patched)).title, '改名后');
  } finally {
    await server.close();
    temp.cleanup();
  }
});

test('API：发送消息与查询历史', async () => {
  const temp = createTempDatabase();
  const server = await startTestServer(temp.db);

  try {
    const created = await json(
      await fetch(`${server.baseUrl}/api/conversations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: '消息 API' }),
      }),
    );
    const conversationId = String(created.id);

    const sent = await fetch(`${server.baseUrl}/api/conversations/${conversationId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '来自 API 的消息' }),
    });

    assert.equal(sent.status, 201);
    const message = await json(sent);
    assert.equal(message.message_type, 'user_message');
    assert.equal(message.sender_kind, 'user');

    const history = await json(
      await fetch(`${server.baseUrl}/api/conversations/${conversationId}/messages`),
    );
    assert.equal(history.total, 1);
  } finally {
    await server.close();
    temp.cleanup();
  }
});

test('API：错误处理返回 400 / 404 / 405 且不泄漏内部信息', async () => {
  const temp = createTempDatabase();
  const server = await startTestServer(temp.db);

  try {
    const invalidJson = await fetch(`${server.baseUrl}/api/conversations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-a-json',
    });
    assert.equal(invalidJson.status, 400);
    assert.equal(((await json(invalidJson)).error as JsonRecord).code, 'invalid_json');

    const missing = await fetch(`${server.baseUrl}/api/conversations/does-not-exist`);
    assert.equal(missing.status, 404);
    const missingBody = await json(missing);
    assert.equal((missingBody.error as JsonRecord).code, 'conversation_not_found');
    assert.equal(JSON.stringify(missingBody).includes('E:\\\\'), false);

    const wrongMethod = await fetch(`${server.baseUrl}/api/conversations`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'x' }),
    });
    assert.equal(wrongMethod.status, 405);

    const unknownRoute = await fetch(`${server.baseUrl}/api/unknown`);
    assert.equal(unknownRoute.status, 404);

    const invalidTitle = await fetch(`${server.baseUrl}/api/conversations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '' }),
    });
    assert.equal(invalidTitle.status, 400);
    assert.equal(((await json(invalidTitle)).error as JsonRecord).code, 'invalid_title');
  } finally {
    await server.close();
    temp.cleanup();
  }
});

test('API：两个对话的数据严格隔离', async () => {
  const temp = createTempDatabase();
  const server = await startTestServer(temp.db);

  try {
    const create = async (title: string): Promise<string> => {
      const response = await fetch(`${server.baseUrl}/api/conversations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title }),
      });
      return String((await json(response)).id);
    };

    const alpha = await create('Alpha');
    const beta = await create('Beta');

    await fetch(`${server.baseUrl}/api/conversations/${alpha}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'Alpha 消息' }),
    });

    await fetch(`${server.baseUrl}/api/conversations/${beta}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'Beta 消息 1' }),
    });

    await fetch(`${server.baseUrl}/api/conversations/${beta}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'Beta 消息 2' }),
    });

    const alphaHistory = await json(
      await fetch(`${server.baseUrl}/api/conversations/${alpha}/messages`),
    );
    const betaHistory = await json(
      await fetch(`${server.baseUrl}/api/conversations/${beta}/messages`),
    );

    assert.equal(alphaHistory.total, 1);
    assert.equal(betaHistory.total, 2);
  } finally {
    await server.close();
    temp.cleanup();
  }
});

test('API：重启服务后历史可通过接口重新读取', async () => {
  const temp = createTempDatabase();
  const firstServer = await startTestServer(temp.db);
  let conversationId = '';

  try {
    const created = await json(
      await fetch(`${firstServer.baseUrl}/api/conversations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: '重启前后' }),
      }),
    );
    conversationId = String(created.id);

    await fetch(`${firstServer.baseUrl}/api/conversations/${conversationId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '重启前写入' }),
    });
  } finally {
    await firstServer.close();
    temp.close();
  }

  try {
    const reopened = openDatabase(temp.path);
    const secondServer = await startTestServer(reopened);

    try {
      const history = await json(
        await fetch(`${secondServer.baseUrl}/api/conversations/${conversationId}/messages`),
      );
      assert.equal(history.total, 1);
      assert.equal((history.items as JsonRecord[])[0]?.content, '重启前写入');
    } finally {
      await secondServer.close();
      reopened.close();
    }
  } finally {
    temp.cleanup();
  }
});
