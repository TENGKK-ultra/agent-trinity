import assert from 'node:assert/strict';
import test from 'node:test';
import { createConversation } from '../src/conversations/conversation.service.ts';
import {
  completeTask,
  createTask,
  markTaskRunning,
} from '../src/harnesses/task.service.ts';
import { addMessage } from '../src/messages/message.service.ts';
import { createTempDatabase, startTestServer } from './helpers.ts';

async function getJson(url: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(url);
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

test('Dashboard API：活动按 seq 返回，DTO 只带白名单字段', async () => {
  const temp = createTempDatabase();
  const server = await startTestServer(temp.db);

  try {
    const conversation = createConversation(temp.db, { title: '活动' });
    addMessage(temp.db, conversation.id, { content: '聊天消息不进活动流' });
    addMessage(temp.db, conversation.id, {
      message_type: 'tool_call',
      sender_kind: 'agent',
      sender_id: 'Claude Code',
      content: 'x'.repeat(600),
      metadata: {
        turn_id: 'turn-1',
        tool: 'Read',
        ref: 'call_1',
        input: { secret: 'should-not-leave-core' },
        secret_field: 'nope',
      },
    });

    const { status, body } = await getJson(
      `${server.baseUrl}/api/conversations/${conversation.id}/activity`,
    );

    assert.equal(status, 200);
    const items = body.items as Array<Record<string, unknown>>;
    assert.equal(items.length, 1, '聊天消息不能出现在活动流里');

    const item = items[0]!;
    assert.equal(item.kind, 'tool_call');
    assert.equal(item.agent, 'claude');
    assert.equal(String(item.content_preview).length, 200, '预览必须被截断');

    const metadata = item.metadata as Record<string, unknown>;
    assert.deepEqual(Object.keys(metadata).sort(), ['ref', 'tool', 'turn_id']);
    assert.equal(JSON.stringify(body).includes('should-not-leave-core'), false);
    assert.equal(
      Number(body.head_seq),
      item.seq,
      'head_seq 只统计活动；聊天消息的变更序号不得算进来',
    );
    assert.equal(body.has_more, false);
  } finally {
    await server.close();
    temp.cleanup();
  }
});

test('Dashboard API：summary 经过清理后返回，input 仍不可见', async () => {
  const temp = createTempDatabase();
  const server = await startTestServer(temp.db);

  try {
    const conversation = createConversation(temp.db, { title: '摘要' });
    addMessage(temp.db, conversation.id, {
      message_type: 'tool_call',
      content: 'file_change',
      metadata: {
        tool: 'file_change',
        summary: ` 新增 a.ts\n${'x'.repeat(300)}`,
        input: { secret: 'nope' },
      },
    });

    const { status, body } = await getJson(
      `${server.baseUrl}/api/conversations/${conversation.id}/activity`,
    );

    assert.equal(status, 200);
    const item = (body.items as Array<Record<string, unknown>>)[0]!;
    const metadata = item.metadata as Record<string, unknown>;

    assert.equal(String(metadata.summary).includes('\n'), false, '换行必须被清理');
    assert.ok(String(metadata.summary).startsWith('新增 a.ts'));
    assert.ok(String(metadata.summary).length <= 120);
    assert.equal('input' in metadata, false);
    assert.equal(JSON.stringify(body).includes('nope'), false);
  } finally {
    await server.close();
    temp.cleanup();
  }
});

test('Dashboard API：tool 字段出口再清洗并封顶 60 字', async () => {
  const temp = createTempDatabase();
  const server = await startTestServer(temp.db);

  try {
    const conversation = createConversation(temp.db, { title: '工具名' });
    addMessage(temp.db, conversation.id, {
      message_type: 'tool_call',
      content: 'x',
      metadata: { tool: `powershell.exe\n${'x'.repeat(200)}` },
    });

    const { body } = await getJson(
      `${server.baseUrl}/api/conversations/${conversation.id}/activity`,
    );
    const tool = String(((body.items as Array<Record<string, unknown>>)[0]!.metadata as Record<string, unknown>).tool);

    assert.ok(tool.length <= 60, '工具名必须封顶');
    assert.equal(tool.includes('\n'), false, '工具名必须是单行');
    assert.ok(tool.startsWith('powershell.exe'));
  } finally {
    await server.close();
    temp.cleanup();
  }
});

test('Dashboard API：三条读取路径都不返回原始命令', async () => {
  const temp = createTempDatabase();
  const server = await startTestServer(temp.db);

  try {
    const conversation = createConversation(temp.db, { title: '命令存储' });
    const message = addMessage(temp.db, conversation.id, {
      message_type: 'tool_call',
      content: 'powershell.exe',
      metadata: { tool: 'powershell.exe', ref: 'item_1' },
    });

    temp.db
      .prepare(
        `INSERT INTO command_debug
           (id, conversation_id, message_id, turn_id, agent, program, command, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'dbg-1',
        conversation.id,
        message.id,
        'turn-1',
        'Codex',
        'powershell.exe',
        'powershell.exe -Command "Get-ChildItem env:"',
        new Date().toISOString(),
      );

    const list = await getJson(`${server.baseUrl}/api/conversations/${conversation.id}/activity`);
    const detail = await getJson(
      `${server.baseUrl}/api/conversations/${conversation.id}/activity/${message.id}`,
    );
    const messages = await getJson(
      `${server.baseUrl}/api/conversations/${conversation.id}/messages?include_activity=true`,
    );

    for (const body of [list.body, detail.body, messages.body]) {
      assert.equal(JSON.stringify(body).includes('Get-ChildItem'), false);
    }
  } finally {
    await server.close();
    temp.cleanup();
  }
});

test('Dashboard API：预览折叠为单行，控制字符不进入时间线', async () => {
  const temp = createTempDatabase();
  const server = await startTestServer(temp.db);

  try {
    const conversation = createConversation(temp.db, { title: '单行' });
    addMessage(temp.db, conversation.id, {
      message_type: 'tool_result',
      content: '  first line\r\nsecond\t\tline\u0000third  ',
    });

    const { body } = await getJson(
      `${server.baseUrl}/api/conversations/${conversation.id}/activity`,
    );
    const item = (body.items as Array<Record<string, unknown>>)[0]!;

    assert.equal(item.content_preview, 'first line second line third');
    assert.equal(String(item.content_preview).includes('\n'), false);
    assert.equal(String(item.content_preview).includes('\r'), false);
  } finally {
    await server.close();
    temp.cleanup();
  }
});

test('Dashboard API：单条活动详情返回完整正文，聊天消息不可取', async () => {
  const temp = createTempDatabase();
  const server = await startTestServer(temp.db);

  try {
    const conversation = createConversation(temp.db, { title: '活动详情' });
    const saved = addMessage(temp.db, conversation.id, {
      message_type: 'tool_result',
      content: 'y'.repeat(800),
      metadata: { tool: 'Read', input: { secret: 'must-not-leave' } },
    });

    const detail = await getJson(
      `${server.baseUrl}/api/conversations/${conversation.id}/activity/${saved.id}`,
    );

    assert.equal(detail.status, 200);
    assert.equal(String(detail.body.content).length, 800, '详情必须给出完整正文');
    assert.equal(String(detail.body.content_preview).length, 200);
    assert.equal(JSON.stringify(detail.body).includes('must-not-leave'), false);

    const chat = addMessage(temp.db, conversation.id, { content: '聊天消息' });
    const notActivity = await fetch(
      `${server.baseUrl}/api/conversations/${conversation.id}/activity/${chat.id}`,
    );
    assert.equal(notActivity.status, 404, '聊天消息不是活动');

    const missing = await fetch(
      `${server.baseUrl}/api/conversations/${conversation.id}/activity/nope`,
    );
    assert.equal(missing.status, 404);
  } finally {
    await server.close();
    temp.cleanup();
  }
});

test('Dashboard API：after_seq 只返回新增活动', async () => {
  const temp = createTempDatabase();
  const server = await startTestServer(temp.db);

  try {
    const conversation = createConversation(temp.db, { title: '增量' });
    addMessage(temp.db, conversation.id, { message_type: 'tool_call', content: '一' });

    const first = await getJson(
      `${server.baseUrl}/api/conversations/${conversation.id}/activity`,
    );
    const firstItems = first.body.items as Array<{ seq: number }>;
    const lastSeq = firstItems.at(-1)!.seq;

    addMessage(temp.db, conversation.id, { message_type: 'tool_result', content: '二' });
    addMessage(temp.db, conversation.id, { message_type: 'tool_result', content: '三' });

    const next = await getJson(
      `${server.baseUrl}/api/conversations/${conversation.id}/activity?after_seq=${lastSeq}`,
    );
    const nextItems = next.body.items as Array<{ seq: number; content_preview: string }>;

    assert.equal(nextItems.length, 2);
    assert.ok(nextItems.every((row) => row.seq > lastSeq));
    assert.deepEqual(nextItems.map((row) => row.content_preview), ['二', '三']);
  } finally {
    await server.close();
    temp.cleanup();
  }
});

test('Dashboard API：分页与游标互斥、limit 生效', async () => {
  const temp = createTempDatabase();
  const server = await startTestServer(temp.db);

  try {
    const conversation = createConversation(temp.db, { title: '分页' });

    for (let i = 0; i < 5; i += 1) {
      addMessage(temp.db, conversation.id, { message_type: 'tool_call', content: `活动 ${i}` });
    }

    const page = await getJson(
      `${server.baseUrl}/api/conversations/${conversation.id}/activity?limit=2`,
    );
    assert.equal((page.body.items as unknown[]).length, 2);
    assert.equal(page.body.has_more, true, '还有更早的活动');

    const both = await fetch(
      `${server.baseUrl}/api/conversations/${conversation.id}/activity?after_seq=1&before_seq=5`,
    );
    assert.equal(both.status, 400);
  } finally {
    await server.close();
    temp.cleanup();
  }
});

test('Dashboard API：任务列表分页、详情带结果预览', async () => {
  const temp = createTempDatabase();
  const server = await startTestServer(temp.db);

  try {
    const conversation = createConversation(temp.db, { title: '任务' });
    const task = createTask(temp.db, {
      conversationId: conversation.id,
      sourceAgent: 'claude',
      sourceTurnId: 'turn-1',
      targetAgent: 'deepseek',
      instruction: '检查迁移文件并报告',
    });

    markTaskRunning(temp.db, task.id, 'turn-target');
    const result = addMessage(temp.db, conversation.id, {
      message_type: 'agent_final',
      sender_kind: 'agent',
      sender_id: 'DeepSeek Harness',
      content: '迁移文件没有问题',
    });
    completeTask(temp.db, task.id, result.id);

    const list = await getJson(`${server.baseUrl}/api/conversations/${conversation.id}/tasks`);
    const items = list.body.items as Array<Record<string, unknown>>;

    assert.equal(list.body.total, 1);
    assert.equal(items[0]!.id, task.id);
    assert.equal('instruction' in items[0]!, false, '列表不能返回完整指令');
    assert.equal(items[0]!.instruction_preview, '检查迁移文件并报告');

    const detail = await getJson(
      `${server.baseUrl}/api/conversations/${conversation.id}/tasks/${task.id}`,
    );
    assert.equal(detail.status, 200);

    const detailTask = detail.body.task as Record<string, unknown>;
    assert.equal(detailTask.status, 'completed');
    assert.equal(detailTask.instruction_length, '检查迁移文件并报告'.length);

    const resultDto = detail.body.result as Record<string, unknown>;
    assert.equal(resultDto.message_id, result.id);
    assert.equal(resultDto.content_preview, '迁移文件没有问题');

    const missing = await fetch(
      `${server.baseUrl}/api/conversations/${conversation.id}/tasks/nope`,
    );
    assert.equal(missing.status, 404);
  } finally {
    await server.close();
    temp.cleanup();
  }
});

test('Dashboard API：全局任务列表跨会话并带会话标题', async () => {
  const temp = createTempDatabase();
  const server = await startTestServer(temp.db);

  try {
    const alpha = createConversation(temp.db, { title: 'Alpha' });
    const beta = createConversation(temp.db, { title: 'Beta' });

    createTask(temp.db, {
      conversationId: alpha.id,
      sourceAgent: 'claude',
      targetAgent: 'deepseek',
      instruction: '第一个',
    });
    createTask(temp.db, {
      conversationId: beta.id,
      sourceAgent: 'claude',
      targetAgent: 'codex',
      instruction: '第二个',
    });

    const all = await getJson(`${server.baseUrl}/api/tasks`);
    const items = all.body.items as Array<Record<string, unknown>>;

    assert.equal(all.body.total, 2);
    assert.deepEqual(
      items.map((row) => row.conversation_title).sort(),
      ['Alpha', 'Beta'],
    );
    assert.equal('instruction' in items[0]!, false);

    const missing = await fetch(`${server.baseUrl}/api/conversations/missing/activity`);
    assert.equal(missing.status, 404);
  } finally {
    await server.close();
    temp.cleanup();
  }
});
