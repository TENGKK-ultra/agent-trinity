import assert from 'node:assert/strict';
import test from 'node:test';
import { createConversation } from '../src/conversations/conversation.service.ts';
import { createTask } from '../src/harnesses/task.service.ts';
import { addMessage, listMessages } from '../src/messages/message.service.ts';
import { createTempDatabase, startTestServer } from './helpers.ts';

function chat(_conversationId: string, index: number) {
  return {
    message_type: 'user_message' as const,
    content: `聊天 ${index}`,
  };
}

function activity(_conversationId: string, index: number) {
  return index % 2 === 0
    ? { message_type: 'tool_call' as const, content: `工具 ${index}` }
    : { message_type: 'tool_result' as const, content: `结果 ${index}` };
}

test('B4：50 条聊天 + 150 条活动，默认视图只返回 50 条聊天', () => {
  const temp = createTempDatabase();

  try {
    const conversation = createConversation(temp.db, { title: '窗口' });

    for (let i = 0; i < 50; i += 1) addMessage(temp.db, conversation.id, chat(conversation.id, i));
    for (let i = 0; i < 150; i += 1) addMessage(temp.db, conversation.id, activity(conversation.id, i));

    const page = listMessages(temp.db, conversation.id, { limit: 50 });
    assert.equal(page.total, 50, 'count 不得包含活动消息');
    assert.equal(page.items.length, 50);
    assert.ok(page.items.every((row) => row.message_type === 'user_message'));

    const all = listMessages(temp.db, conversation.id, { include_activity: '1', limit: 100 });
    assert.equal(all.total, 200);
  } finally {
    temp.cleanup();
  }
});

test('B4：分页跨越活动密集区时不漏聊天消息', () => {
  const temp = createTempDatabase();

  try {
    const conversation = createConversation(temp.db, { title: '分页' });
    const expected: string[] = [];

    for (let i = 0; i < 40; i += 1) {
      const saved = addMessage(temp.db, conversation.id, chat(conversation.id, i));
      expected.push(saved.id);

      for (let j = 0; j < 3; j += 1) {
        addMessage(temp.db, conversation.id, activity(conversation.id, i * 3 + j));
      }
    }

    const collected: string[] = [];

    for (let offset = 0; offset < 40; offset += 10) {
      const page = listMessages(temp.db, conversation.id, { limit: 10, offset });
      collected.push(...page.items.map((row) => row.id));
    }

    assert.deepEqual(collected, expected);
    assert.equal(listMessages(temp.db, conversation.id, {}).total, 40);
  } finally {
    temp.cleanup();
  }
});

test('B4：内部查询仍可按类型读取活动消息', () => {
  const temp = createTempDatabase();

  try {
    const conversation = createConversation(temp.db, { title: '内部' });
    addMessage(temp.db, conversation.id, chat(conversation.id, 0));
    addMessage(temp.db, conversation.id, { message_type: 'tool_call', content: '调用' });

    const tools = listMessages(temp.db, conversation.id, { message_type: 'tool_call' });
    assert.equal(tools.total, 1, '显式类型过滤必须能读到活动消息');
    assert.equal(tools.items[0]?.content, '调用');
  } finally {
    temp.cleanup();
  }
});

test('B4：任务锚点与任务同事务写入，且默认不出现在聊天视图', () => {
  const temp = createTempDatabase();

  try {
    const conversation = createConversation(temp.db, { title: '锚点' });
    const task = createTask(temp.db, {
      conversationId: conversation.id,
      sourceAgent: 'claude',
      sourceTurnId: 'turn-anchor',
      targetAgent: 'deepseek',
      instruction: '检查迁移文件',
    });

    const anchors = listMessages(temp.db, conversation.id, {
      message_type: 'task_status',
      include_activity: '1',
    });

    assert.equal(anchors.total, 1);
    const anchor = anchors.items[0];
    assert.ok(anchor);
    assert.equal(anchor.sender_kind, 'system');

    const metadata = JSON.parse(String(anchor.metadata_json)) as Record<string, unknown>;
    assert.equal(metadata.task_id, task.id);
    assert.equal(metadata.target_agent, 'deepseek');
    assert.equal(metadata.kind, 'delegation_created');

    const chatView = listMessages(temp.db, conversation.id, {});
    assert.equal(chatView.total, 0, '锚点不得进入普通聊天视图');
  } finally {
    temp.cleanup();
  }
});

test('B4：锚点写入失败时任务一起回滚', () => {
  const temp = createTempDatabase();

  try {
    const conversation = createConversation(temp.db, { title: '回滚' });
    temp.db.prepare("UPDATE conversations SET status = 'archived' WHERE id = ?").run(conversation.id);

    assert.throws(() =>
      createTask(temp.db, {
        conversationId: conversation.id,
        sourceAgent: 'claude',
        sourceTurnId: 'turn-rollback',
        targetAgent: 'deepseek',
        instruction: '检查迁移文件',
      }),
    );

    const tasks = temp.db.prepare('SELECT COUNT(*) AS n FROM agent_tasks').get() as { n: number };
    const messages = temp.db.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number };

    assert.equal(tasks.n, 0, '任务不得留下半成品');
    assert.equal(messages.n, 0, '锚点不得留下半成品');
  } finally {
    temp.cleanup();
  }
});

test('B4：公共 POST 不能伪造内部或系统消息类型', async () => {
  const temp = createTempDatabase();
  const server = await startTestServer(temp.db);

  try {
    const conversation = createConversation(temp.db, { title: '公共入口' });

    for (const messageType of ['task_status', 'tool_call', 'tool_result', 'system_event']) {
      const response = await fetch(`${server.baseUrl}/api/conversations/${conversation.id}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message_type: messageType, content: '伪造' }),
      });

      assert.equal(response.status, 400, `${messageType} 必须被拒绝`);
      const body = (await response.json()) as { error?: { code?: string } };
      assert.equal(body.error?.code, 'message_type_reserved');
    }

    const normal = await fetch(`${server.baseUrl}/api/conversations/${conversation.id}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: '正常聊天' }),
    });

    assert.equal(normal.status, 201);

    // The interface itself applies the contract, not just the service.
    addMessage(temp.db, conversation.id, { message_type: 'tool_call', content: '活动' });
    addMessage(temp.db, conversation.id, { message_type: 'tool_result', content: '活动结果' });

    const page = await fetch(
      `${server.baseUrl}/api/conversations/${conversation.id}/messages?limit=50`,
    );
    const body = (await page.json()) as { total: number; items: Array<{ message_type: string }> };

    assert.equal(body.total, 1, 'HTTP 列表与 count 都必须排除活动消息');
    assert.deepEqual(
      body.items.map((row) => row.message_type),
      ['user_message'],
    );
  } finally {
    await server.close();
    temp.cleanup();
  }
});
