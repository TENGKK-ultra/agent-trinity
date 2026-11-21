import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createConversation } from '../src/conversations/conversation.service.ts';
import { openDatabase } from '../src/database/connection.ts';
import { migrations } from '../src/database/migrations/index.ts';
import { addMessage, listMessages } from '../src/messages/message.service.ts';
import { createTempDatabase } from './helpers.ts';

test('持久化：关闭并重新打开数据库后历史仍然存在', () => {
  const temp = createTempDatabase();

  try {
    const conversation = createConversation(temp.db, { title: '重启测试' });
    addMessage(temp.db, conversation.id, { content: '重启前的消息' });

    temp.close();
    const reopened = temp.reopen();

    const messages = listMessages(reopened, conversation.id, {});
    assert.equal(messages.total, 1);
    assert.equal(messages.items[0]?.content, '重启前的消息');
  } finally {
    temp.cleanup();
  }
});

test('持久化：重复启动不会重复执行迁移，也不会覆盖数据', () => {
  const temp = createTempDatabase();

  try {
    const conversation = createConversation(temp.db, { title: '重复启动' });
    addMessage(temp.db, conversation.id, { content: '保留我' });

    const countMigrations = (db: ReturnType<typeof openDatabase>): number =>
      (db.prepare('SELECT COUNT(*) AS total FROM schema_migrations').get() as { total: number })
        .total;

    const expectedMigrations = migrations.length;

    assert.equal(countMigrations(temp.db), expectedMigrations);

    temp.close();
    const reopened = temp.reopen();

    assert.equal(countMigrations(reopened), expectedMigrations);
    assert.equal(listMessages(reopened, conversation.id, {}).total, 1);

    reopened.close();
    const reopenedAgain = openDatabase(temp.path);

    assert.equal(countMigrations(reopenedAgain), expectedMigrations);
    assert.equal(listMessages(reopenedAgain, conversation.id, {}).total, 1);
    reopenedAgain.close();
  } finally {
    temp.cleanup();
  }
});

test('持久化：数据库文件不存在时自动创建并建好表结构', () => {
  const dir = mkdtempSync(join(tmpdir(), 'trinity-core-fresh-'));
  const dbPath = join(dir, 'nested', 'fresh.db');

  try {
    assert.equal(existsSync(dbPath), false);

    const db = openDatabase(dbPath);

    assert.equal(existsSync(dbPath), true);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as Array<{ name: string }>;
    const tableNames = tables.map((row) => row.name);

    for (const expected of [
      'conversations',
      'messages',
      'projects',
      'agent_participants',
      'harness_sessions',
      'harness_session_locks',
      'project_memory',
      'context_snapshots',
      'schema_migrations',
    ]) {
      assert.ok(tableNames.includes(expected), `缺少表 ${expected}`);
    }

    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('持久化：数据库层写入失败会抛出错误，且数据库仍可继续使用', () => {
  const temp = createTempDatabase();

  try {
    const conversation = createConversation(temp.db, { title: '约束测试' });
    addMessage(temp.db, conversation.id, { content: '正常消息' });

    assert.throws(() => {
      temp.db
        .prepare(
          `INSERT INTO messages
             (id, conversation_id, sender_kind, sender_id, message_type, content,
              metadata_json, parent_message_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          'bad-id',
          conversation.id,
          'agent',
          null,
          'not_a_valid_type',
          '非法类型',
          null,
          null,
          new Date().toISOString(),
        );
    });

    const afterFailure = addMessage(temp.db, conversation.id, { content: '失败后仍可写入' });
    assert.ok(afterFailure.id);
    assert.equal(listMessages(temp.db, conversation.id, {}).total, 2);
  } finally {
    temp.cleanup();
  }
});

test('持久化：外键约束阻止消息挂到不存在的对话', () => {
  const temp = createTempDatabase();

  try {
    assert.throws(() => {
      temp.db
        .prepare(
          `INSERT INTO messages
             (id, conversation_id, sender_kind, sender_id, message_type, content,
              metadata_json, parent_message_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          'orphan-id',
          'no-such-conversation',
          'user',
          null,
          'user_message',
          '孤儿消息',
          null,
          null,
          new Date().toISOString(),
        );
    });

    assert.equal(
      (temp.db.prepare('SELECT COUNT(*) AS total FROM messages').get() as { total: number }).total,
      0,
    );
  } finally {
    temp.cleanup();
  }
});
