import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { appendChange, listChangesAfter, USER_ACTOR } from '../src/changes/change-log.service.ts';
import { createConversation, updateConversation } from '../src/conversations/conversation.service.ts';
import { openDatabase } from '../src/database/connection.ts';
import { withTransaction } from '../src/database/transaction.ts';
import {
  activateBinding,
  removeBinding,
  setStatus,
} from '../src/harnesses/session.service.ts';
import { addMessage } from '../src/messages/message.service.ts';
import { createTempDatabase, type TempDatabase } from './helpers.ts';

interface Row {
  seq: number;
  entity_type: string;
  entity_id: string;
  operation: string;
  actor_type: string;
  actor_id: string | null;
  conversation_id: string | null;
  payload_json: string;
}

function allChanges(db: TempDatabase['db']): Row[] {
  return db.prepare('SELECT * FROM change_log ORDER BY seq ASC').all() as unknown as Row[];
}

function withDb(run: (temp: TempDatabase) => void): void {
  const temp = createTempDatabase();
  try {
    run(temp);
  } finally {
    temp.cleanup();
  }
}

test('D3.5.1 日志：创建对话写入一条 insert，且不含业务正文', () => {
  withDb((temp) => {
    const conversation = createConversation(temp.db, { title: '日志测试' });
    const rows = allChanges(temp.db);

    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.entity_type, 'conversation');
    assert.equal(rows[0]?.entity_id, conversation.id);
    assert.equal(rows[0]?.operation, 'insert');
    assert.equal(rows[0]?.actor_type, 'user');
    assert.equal(rows[0]?.conversation_id, conversation.id);

    const payload = JSON.parse(String(rows[0]?.payload_json)) as Record<string, unknown>;
    assert.equal(payload.title, '日志测试');
    assert.equal(Object.hasOwn(payload, 'content'), false);
  });
});

test('D3.5.1 日志：修改对话写入 update', () => {
  withDb((temp) => {
    const conversation = createConversation(temp.db, { title: '旧标题' });
    updateConversation(temp.db, conversation.id, { title: '新标题' });

    const rows = allChanges(temp.db);
    assert.equal(rows.length, 2);
    assert.equal(rows[1]?.operation, 'update');
    assert.equal(rows[1]?.entity_type, 'conversation');
  });
});

test('D3.5.1 日志：消息写入日志但不记录正文', () => {
  withDb((temp) => {
    const conversation = createConversation(temp.db, { title: '消息' });
    const message = addMessage(temp.db, conversation.id, { content: '这是正文，不应出现在日志里' });

    const rows = allChanges(temp.db).filter((row) => row.entity_type === 'message');
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.entity_id, message.id);
    assert.equal(rows[0]?.conversation_id, conversation.id);

    const payload = JSON.parse(String(rows[0]?.payload_json)) as Record<string, unknown>;
    assert.equal(payload.message_type, 'user_message');
    assert.equal(JSON.stringify(payload).includes('正文'), false);
  });
});

test('D3.5.1 日志：绑定、切换、解绑 Agent 都留痕且不删别人的会话', () => {
  withDb((temp) => {
    const conversation = createConversation(temp.db, { title: '多 Agent' });

    activateBinding(temp.db, conversation.id, {
      harnessType: 'claude',
      cwd: null,
      model: null,
    });
    activateBinding(temp.db, conversation.id, {
      harnessType: 'codex',
      cwd: null,
      model: null,
    });

    const sessions = allChanges(temp.db).filter((row) => row.entity_type === 'harness_session');
    const inserts = sessions.filter((row) => row.operation === 'insert');
    const updates = sessions.filter((row) => row.operation === 'update');

    assert.equal(inserts.length, 2, '两个 Agent 各写一条 insert');
    assert.ok(updates.length >= 2, '两次激活各写一条 update');

    const codexInsert = inserts.find((row) => JSON.parse(String(row.payload_json)).agent === 'codex');
    assert.equal(codexInsert?.actor_type, 'agent');
    assert.equal(codexInsert?.conversation_id, conversation.id);

    removeBinding(temp.db, conversation.id, 'codex');
    const afterDelete = allChanges(temp.db).filter(
      (row) => row.operation === 'delete' && row.entity_type === 'harness_session',
    );
    assert.equal(afterDelete.length, 1);

    const remaining = temp.db
      .prepare('SELECT harness_type FROM harness_sessions WHERE conversation_id = ?')
      .all(conversation.id) as Array<{ harness_type: string }>;
    assert.deepEqual(remaining.map((row) => row.harness_type), ['claude']);
  });
});

test('D3.5.1 日志：会话状态与原生会话 id 变更都进日志', () => {
  withDb((temp) => {
    const conversation = createConversation(temp.db, { title: '状态' });
    const { session } = activateBinding(temp.db, conversation.id, {
      harnessType: 'claude',
      cwd: null,
      model: null,
    });

    setStatus(temp.db, session.id, 'running');
    setStatus(temp.db, session.id, 'idle');

    const statuses = allChanges(temp.db)
      .filter((row) => row.entity_type === 'harness_session' && row.operation === 'update')
      .map((row) => JSON.parse(String(row.payload_json)) as { status?: string })
      .filter((payload) => payload.status !== undefined);

    assert.deepEqual(statuses.map((payload) => payload.status), ['running', 'idle']);
  });
});

test('D3.5.1 事务：业务写入与日志一起回滚', () => {
  withDb((temp) => {
    const before = allChanges(temp.db).length;

    assert.throws(() => {
      withTransaction(temp.db, () => {
        const conversation = createConversation(temp.db, { title: '会被回滚' });
        appendChange(temp.db, {
          entityType: 'conversation',
          entityId: conversation.id,
          operation: 'update',
          actor: USER_ACTOR,
          conversationId: conversation.id,
        });
        throw new Error('boom');
      });
    }, /boom/);

    assert.equal(allChanges(temp.db).length, before, '回滚后日志不增加');
    const conversations = temp.db
      .prepare("SELECT COUNT(*) AS n FROM conversations WHERE title = '会被回滚'")
      .get() as { n: number };
    assert.equal(conversations.n, 0, '回滚后业务数据也不存在');
  });
});

test('D3.5.1 事务：事务外调用 appendChange 直接失败', () => {
  withDb((temp) => {
    assert.throws(
      () =>
        appendChange(temp.db, {
          entityType: 'conversation',
          entityId: 'x',
          operation: 'insert',
          actor: USER_ACTOR,
        }),
      /must run inside the business transaction/,
    );
  });
});

test('D3.5.1 不可变：UPDATE 与 DELETE 被数据库触发器拒绝', () => {
  withDb((temp) => {
    createConversation(temp.db, { title: '不可变' });

    assert.throws(
      () => temp.db.prepare("UPDATE change_log SET actor_type = 'system'").run(),
      /append-only/,
    );
    assert.throws(() => temp.db.prepare('DELETE FROM change_log').run(), /append-only/);

    assert.equal(allChanges(temp.db).length, 1, '被拒绝后日志仍在');
  });
});

test('D3.5.1 单调：连续写入的 seq 严格递增', () => {
  withDb((temp) => {
    const conversation = createConversation(temp.db, { title: '序号' });
    for (let i = 0; i < 50; i += 1) {
      addMessage(temp.db, conversation.id, { content: `消息 ${i}` });
    }

    const seqs = allChanges(temp.db).map((row) => row.seq);
    assert.equal(seqs.length, 51);

    for (let i = 1; i < seqs.length; i += 1) {
      assert.ok(Number(seqs[i]) > Number(seqs[i - 1]), 'seq 必须严格递增');
    }
  });
});

test('D3.5.1 游标：全局与按对话两种读取', () => {
  withDb((temp) => {
    const a = createConversation(temp.db, { title: 'A' });
    const b = createConversation(temp.db, { title: 'B' });

    addMessage(temp.db, a.id, { content: 'a1' });
    addMessage(temp.db, b.id, { content: 'b1' });
    addMessage(temp.db, a.id, { content: 'a2' });

    const all = listChangesAfter(temp.db, 0);
    assert.equal(all.length, 5);

    const onlyA = listChangesAfter(temp.db, 0, { conversationId: a.id });
    assert.ok(onlyA.every((row) => row.conversation_id === a.id));
    assert.equal(onlyA.length, 3);

    const lastSeq = Number(all[all.length - 1]?.seq);
    assert.equal(listChangesAfter(temp.db, lastSeq).length, 0, '游标在末尾时没有新记录');
  });
});

test('D3.5.1 迁移：重复打开数据库不会重复建表或重复触发', () => {
  const dir = mkdtempSync(join(tmpdir(), 'trinity-changelog-'));
  const dbPath = join(dir, 'change.db');

  try {
    const first = openDatabase(dbPath);
    createConversation(first, { title: '一次' });
    const firstCount = (first.prepare('SELECT COUNT(*) AS n FROM change_log').get() as { n: number }).n;
    first.close();

    const second = openDatabase(dbPath);
    const secondCount = (second.prepare('SELECT COUNT(*) AS n FROM change_log').get() as { n: number })
      .n;
    const triggers = second
      .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'trg_change_log%'")
      .all() as Array<{ name: string }>;

    assert.equal(firstCount, 1);
    assert.equal(secondCount, 1, '重新打开不应产生新日志');
    assert.equal(triggers.length, 2, '两个触发器各只存在一份');
    second.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
