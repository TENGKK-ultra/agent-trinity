import assert from 'node:assert/strict';
import test from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import { createTempDatabase, startTestServer } from './helpers.ts';

interface Json {
  [key: string]: unknown;
}

async function json(response: Response): Promise<Json> {
  return (await response.json()) as Json;
}

function seedConversation(db: DatabaseSync, id: string, title: string): void {
  db.prepare(
    `INSERT INTO conversations (id, project_id, title, status, created_at, updated_at)
     VALUES (?, NULL, ?, 'active', ?, ?)`,
  ).run(id, title, '2026-11-21T00:00:00.000Z', '2026-11-21T00:00:00.000Z');
}

function seedMessage(
  db: DatabaseSync,
  input: {
    id: string;
    conversationId: string;
    type: 'system_event' | 'task_status' | 'user_message';
    content: string;
    createdAt: string;
    metadata?: Record<string, unknown>;
  },
): void {
  db.prepare(
    `INSERT INTO messages
       (id, conversation_id, sender_kind, sender_id, message_type, content,
        metadata_json, parent_message_id, created_at)
     VALUES (?, ?, ?, NULL, ?, ?, ?, NULL, ?)`,
  ).run(
    input.id,
    input.conversationId,
    input.type === 'user_message' ? 'user' : 'system',
    input.type,
    input.content,
    input.metadata ? JSON.stringify(input.metadata) : null,
    input.createdAt,
  );
}

function seed(db: DatabaseSync): void {
  seedConversation(db, 'conv-a', '统计文件');
  seedConversation(db, 'conv-b', '整理目录');

  seedMessage(db, {
    id: 'm1',
    conversationId: 'conv-a',
    type: 'task_status',
    content: '任务已开始',
    createdAt: '2026-11-21T10:00:00.000Z',
    metadata: { task_id: 't1' },
  });
  seedMessage(db, {
    id: 'm2',
    conversationId: 'conv-a',
    type: 'system_event',
    content: '进程退出码 1：ENOENT',
    createdAt: '2026-11-21T10:05:00.000Z',
    metadata: { reason: 'run_failed' },
  });
  seedMessage(db, {
    id: 'm3',
    conversationId: 'conv-b',
    type: 'system_event',
    content: '群组回合里有一条交接被丢弃',
    createdAt: '2026-11-21T10:10:00.000Z',
    metadata: { reason: 'handoff_dropped' },
  });
  seedMessage(db, {
    id: 'm4',
    conversationId: 'conv-b',
    type: 'task_status',
    content: '任务已完成',
    createdAt: '2026-11-21T10:15:00.000Z',
    metadata: { task_id: 't2' },
  });
  // 普通聊天不该出现在事件流里
  seedMessage(db, {
    id: 'm5',
    conversationId: 'conv-a',
    type: 'user_message',
    content: '帮我看看',
    createdAt: '2026-11-21T10:20:00.000Z',
  });
}

test('事件 API：只列出 Core 自己写下的事件，按时间倒序', async () => {
  const temp = createTempDatabase();
  const server = await startTestServer(temp.db);
  seed(temp.db);

  try {
    const body = await json(await fetch(`${server.baseUrl}/api/events`));
    const items = body.items as Array<Record<string, unknown>>;

    assert.equal(body.total, 4);
    assert.deepEqual(
      items.map((item) => item.id),
      ['m4', 'm3', 'm2', 'm1'],
    );
    assert.equal(items[0]?.conversation_title, '整理目录');
    assert.equal(items[0]?.source, 'task');
    assert.equal(items[2]?.reason, 'run_failed');
    assert.equal(items[2]?.failed, true);
    assert.equal(items[1]?.failed, false);
  } finally {
    await server.close();
    temp.cleanup();
  }
});

test('事件 API：按任务、系统、错误筛选，并给出各类计数', async () => {
  const temp = createTempDatabase();
  const server = await startTestServer(temp.db);
  seed(temp.db);

  try {
    const tasks = await json(await fetch(`${server.baseUrl}/api/events?filter=task`));
    assert.deepEqual((tasks.items as Array<Record<string, unknown>>).map((i) => i.id), ['m4', 'm1']);

    const system = await json(await fetch(`${server.baseUrl}/api/events?filter=system`));
    assert.deepEqual((system.items as Array<Record<string, unknown>>).map((i) => i.id), ['m3', 'm2']);

    const errors = await json(await fetch(`${server.baseUrl}/api/events?filter=error`));
    assert.deepEqual((errors.items as Array<Record<string, unknown>>).map((i) => i.id), ['m2']);

    assert.deepEqual(errors.counts, { task: 2, system: 2, error: 1 });
  } finally {
    await server.close();
    temp.cleanup();
  }
});

test('事件 API：分页不改变总数', async () => {
  const temp = createTempDatabase();
  const server = await startTestServer(temp.db);
  seed(temp.db);

  try {
    const page = await json(await fetch(`${server.baseUrl}/api/events?limit=2&offset=1`));
    assert.equal(page.total, 4);
    assert.equal(page.limit, 2);
    assert.equal(page.offset, 1);
    assert.deepEqual((page.items as Array<Record<string, unknown>>).map((i) => i.id), ['m3', 'm2']);
  } finally {
    await server.close();
    temp.cleanup();
  }
});

test('事件 API：筛选值不合法时明确报错', async () => {
  const temp = createTempDatabase();
  const server = await startTestServer(temp.db);

  try {
    const response = await fetch(`${server.baseUrl}/api/events?filter=nope`);
    assert.equal(response.status, 400);
  } finally {
    await server.close();
    temp.cleanup();
  }
});

test('事件 API：元数据坏掉不影响整页', async () => {
  const temp = createTempDatabase();
  const server = await startTestServer(temp.db);
  seedConversation(temp.db, 'conv-a', '统计文件');
  temp.db
    .prepare(
      `INSERT INTO messages
         (id, conversation_id, sender_kind, sender_id, message_type, content,
          metadata_json, parent_message_id, created_at)
       VALUES ('bad', 'conv-a', 'system', NULL, 'system_event', '坏掉的元数据', '{not json', NULL, '2026-11-21T11:00:00.000Z')`,
    )
    .run();

  try {
    const body = await json(await fetch(`${server.baseUrl}/api/events`));
    const items = body.items as Array<Record<string, unknown>>;
    assert.equal(items.length, 1);
    assert.equal(items[0]?.reason, null);
    assert.equal(items[0]?.failed, false);
  } finally {
    await server.close();
    temp.cleanup();
  }
});
