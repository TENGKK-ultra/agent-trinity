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

function seed(db: DatabaseSync): void {
  db.prepare(
    `INSERT INTO conversations (id, project_id, title, status, created_at, updated_at)
     VALUES ('conv-a', NULL, '统计 group 目录', 'active', '2026-11-21T10:00:00.000Z', '2026-11-21T10:00:00.000Z')`,
  ).run();
  db.prepare(
    `INSERT INTO conversations (id, project_id, title, status, created_at, updated_at)
     VALUES ('conv-b', NULL, '整理下载文件夹', 'active', '2026-11-21T09:00:00.000Z', '2026-11-21T09:00:00.000Z')`,
  ).run();

  const insert = db.prepare(
    `INSERT INTO messages
       (id, conversation_id, sender_kind, sender_id, message_type, content,
        metadata_json, parent_message_id, created_at)
     VALUES (?, ?, ?, NULL, ?, ?, NULL, NULL, ?)`,
  );

  insert.run('m1', 'conv-a', 'user', 'user_message', '帮我统计 group 目录里有多少行', '2026-11-21T10:01:00.000Z');
  insert.run('m2', 'conv-a', 'agent', 'agent_message', 'group 目录共 12 个文件、3481 行。', '2026-11-21T10:02:00.000Z');
  insert.run('m3', 'conv-b', 'agent', 'tool_call', 'grep group 的调用记录', '2026-11-21T09:30:00.000Z');
  insert.run('m4', 'conv-b', 'user', 'user_message', '把下载文件夹里的临时文件删掉', '2026-11-21T09:40:00.000Z');
}

test('搜索：标题与正文都能命中，按时间倒序', async () => {
  const temp = createTempDatabase();
  const server = await startTestServer(temp.db);
  seed(temp.db);

  try {
    const body = await json(await fetch(`${server.baseUrl}/api/search?q=group`));

    assert.deepEqual((body.conversations as Array<Record<string, unknown>>).map((c) => c.id), ['conv-a']);

    const messages = body.messages as Array<Record<string, unknown>>;
    assert.deepEqual(messages.map((m) => m.message_id), ['m2', 'm1']);
    assert.match(String(messages[0]?.snippet), /3481 行/);
    assert.equal(messages[0]?.conversation_title, '统计 group 目录');
  } finally {
    await server.close();
    temp.cleanup();
  }
});

test('搜索：工具调用这类内部记录不参与', async () => {
  const temp = createTempDatabase();
  const server = await startTestServer(temp.db);
  seed(temp.db);

  try {
    const body = await json(await fetch(`${server.baseUrl}/api/search?q=grep`));
    assert.deepEqual(body.messages, []);
    assert.deepEqual(body.conversations, []);
  } finally {
    await server.close();
    temp.cleanup();
  }
});

test('搜索：通配符被转义，搜不到东西就是搜不到', async () => {
  const temp = createTempDatabase();
  const server = await startTestServer(temp.db);
  seed(temp.db);

  try {
    const percent = await json(await fetch(`${server.baseUrl}/api/search?q=%25`));
    assert.deepEqual(percent.messages, []);
    assert.deepEqual(percent.conversations, []);

    const underscore = await json(await fetch(`${server.baseUrl}/api/search?q=_`));
    assert.deepEqual(underscore.conversations, []);
  } finally {
    await server.close();
    temp.cleanup();
  }
});

test('搜索：英文不区分大小写，空查询返回空', async () => {
  const temp = createTempDatabase();
  const server = await startTestServer(temp.db);
  seed(temp.db);

  try {
    const upper = await json(await fetch(`${server.baseUrl}/api/search?q=GROUP`));
    assert.equal((upper.messages as unknown[]).length, 2);

    const empty = await json(await fetch(`${server.baseUrl}/api/search?q=`));
    assert.deepEqual(empty.messages, []);
    assert.deepEqual(empty.conversations, []);
  } finally {
    await server.close();
    temp.cleanup();
  }
});
