import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import {
  consume,
  createRound,
  inbox,
  linkTask,
  markDelivered,
  recordMessage,
  trustedSender,
  type TrustedSender,
} from '../src/collab/messages.service.ts';
import { createConversation } from '../src/conversations/conversation.service.ts';
import { openDatabase } from '../src/database/connection.ts';
import { activateBinding } from '../src/harnesses/session.service.ts';
import { createTask } from '../src/harnesses/task.service.ts';
import { createTempDatabase, type TempDatabase } from './helpers.ts';

function fixture(): { temp: TempDatabase; conversationId: string; sender: TrustedSender } {
  const temp = createTempDatabase();
  const conversation = createConversation(temp.db, { title: '协作总线' });

  for (const harnessType of ['claude', 'codex', 'deepseek'] as const) {
    activateBinding(temp.db, conversation.id, { harnessType, cwd: temp.dir, model: null });
  }

  const sender = trustedSender(temp.db, conversation.id, 'claude');

  return { temp, conversationId: conversation.id, sender };
}

function count(db: DatabaseSync): number {
  return (db.prepare('SELECT COUNT(*) AS total FROM agent_messages').get() as { total: number })
    .total;
}

test('P1 迁移：五张表、外键、部分唯一索引都在', () => {
  const { temp } = fixture();

  try {
    const tables = (
      temp.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
        name: string;
      }>
    ).map((row) => row.name);

    for (const table of [
      'collab_rounds',
      'agent_messages',
      'round_roles',
      'role_events',
      'round_reviews',
    ]) {
      assert.ok(tables.includes(table), `${table} 应存在`);
    }

    const index = temp.db
      .prepare("SELECT sql FROM sqlite_master WHERE name = 'idx_agent_messages_assignment_once'")
      .get() as { sql: string } | undefined;

    assert.ok(index, '部分唯一索引应存在');
    assert.match(index.sql, /WHERE kind = 'assignment'/);

    assert.throws(
      () =>
        temp.db
          .prepare(
            `INSERT INTO agent_messages
               (id, round_id, conversation_id, kind, from_agent, to_agent, content,
                request_id, fingerprint, state, hop, created_at)
             VALUES ('bad', 'missing-round', ?, 'notice', 'claude', 'codex', 'x',
                     'req-bad', 'fp-bad', 'queued', 1, ?)`,
          )
          .run(temp.dir, new Date().toISOString()),
      /FOREIGN KEY constraint failed/,
      '外键必须生效',
    );
  } finally {
    temp.cleanup();
  }
});

test('P1 入账：同 request_id 同内容返回原消息', () => {
  const { temp, conversationId, sender } = fixture();

  try {
    const round = createRound(temp.db, conversationId, { goal: '写一份简报' });

    const first = recordMessage(temp.db, sender, {
      roundId: round.id,
      kind: 'notice',
      toAgent: 'codex',
      content: '我开始查资料了',
      requestId: 'req-1',
    });

    const second = recordMessage(temp.db, sender, {
      roundId: round.id,
      kind: 'notice',
      toAgent: 'codex',
      content: '我开始查资料了',
      requestId: 'req-1',
    });

    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(second.message.id, first.message.id);
    assert.equal(count(temp.db), 1);
  } finally {
    temp.cleanup();
  }
});

test('P1 入账：同 request_id 不同内容被拒绝', () => {
  const { temp, conversationId, sender } = fixture();

  try {
    const round = createRound(temp.db, conversationId, { goal: '写一份简报' });

    recordMessage(temp.db, sender, {
      roundId: round.id,
      kind: 'notice',
      toAgent: 'codex',
      content: '第一版内容',
      requestId: 'req-2',
    });

    assert.throws(
      () =>
        recordMessage(temp.db, sender, {
          roundId: round.id,
          kind: 'notice',
          toAgent: 'codex',
          content: '换了内容',
          requestId: 'req-2',
        }),
      (err: unknown) => (err as { code?: string }).code === 'request_id_conflict',
    );

    assert.equal(count(temp.db), 1, '冲突不得写入第二条');
  } finally {
    temp.cleanup();
  }
});

test('P1 指派：同一轮同目标的重复指派被唯一索引挡住', () => {
  const { temp, conversationId, sender } = fixture();

  try {
    const round = createRound(temp.db, conversationId, { goal: '做 PPT' });

    recordMessage(temp.db, sender, {
      roundId: round.id,
      kind: 'assignment',
      toAgent: 'deepseek',
      content: '搜集资料',
      reason: '需要资料',
      requestId: 'req-a1',
    });

    assert.throws(
      () =>
        recordMessage(temp.db, sender, {
          roundId: round.id,
          kind: 'assignment',
          toAgent: 'deepseek',
          content: '搜集资料',
          reason: '需要资料',
          requestId: 'req-a2',
        }),
      (err: unknown) => (err as { code?: string }).code === 'duplicate_assignment',
    );

    assert.equal(count(temp.db), 1);
  } finally {
    temp.cleanup();
  }
});

test('P1 指派：部分唯一索引不影响通知与发言', () => {
  const { temp, conversationId, sender } = fixture();

  try {
    const round = createRound(temp.db, conversationId, { goal: '做 PPT' });

    recordMessage(temp.db, sender, {
      roundId: round.id,
      kind: 'notice',
      toAgent: 'deepseek',
      content: '同一句话',
      requestId: 'req-n1',
    });

    recordMessage(temp.db, sender, {
      roundId: round.id,
      kind: 'notice',
      toAgent: 'deepseek',
      content: '同一句话',
      requestId: 'req-n2',
    });

    recordMessage(temp.db, sender, {
      roundId: round.id,
      kind: 'utterance',
      toAgent: 'deepseek',
      content: '同一句话',
      requestId: 'req-u1',
    });

    assert.equal(count(temp.db), 3, '通知与发言可以重复同样的内容');
  } finally {
    temp.cleanup();
  }
});

test('P1 消费：条件更新只成功一次', () => {
  const { temp, conversationId, sender } = fixture();

  try {
    const round = createRound(temp.db, conversationId, { goal: '做 PPT' });
    const { message } = recordMessage(temp.db, sender, {
      roundId: round.id,
      kind: 'notice',
      toAgent: 'codex',
      content: '资料到位',
      requestId: 'req-c1',
    });

    assert.equal(consume(temp.db, message.id), true);
    assert.equal(consume(temp.db, message.id), false, '第二次消费不得再成功');
  } finally {
    temp.cleanup();
  }
});

test('P1 消费：两个连接争同一条消息，只有一个成功', () => {
  const { temp, conversationId, sender } = fixture();
  let second: DatabaseSync | null = null;

  try {
    const round = createRound(temp.db, conversationId, { goal: '做 PPT' });
    const { message } = recordMessage(temp.db, sender, {
      roundId: round.id,
      kind: 'notice',
      toAgent: 'codex',
      content: '资料到位',
      requestId: 'req-c2',
    });

    second = openDatabase(temp.path);

    const results = [consume(temp.db, message.id), consume(second, message.id)];

    assert.deepEqual(results.sort(), [false, true], '必须有且只有一个成功');
  } finally {
    second?.close();
    temp.cleanup();
  }
});

test('P1 投递：queued → delivered 只发生一次', () => {
  const { temp, conversationId, sender } = fixture();

  try {
    const round = createRound(temp.db, conversationId, { goal: '做 PPT' });
    const { message } = recordMessage(temp.db, sender, {
      roundId: round.id,
      kind: 'notice',
      toAgent: 'codex',
      content: '资料到位',
      requestId: 'req-d1',
    });

    assert.equal(markDelivered(temp.db, message.id), true);
    assert.equal(markDelivered(temp.db, message.id), false);
    assert.equal(consume(temp.db, message.id), true, '送达后仍可被消费');
  } finally {
    temp.cleanup();
  }
});

test('P1 任务关联：同一条指派只能挂一个任务', () => {
  const { temp, conversationId, sender } = fixture();

  try {
    const round = createRound(temp.db, conversationId, { goal: '做 PPT' });
    const { message } = recordMessage(temp.db, sender, {
      roundId: round.id,
      kind: 'assignment',
      toAgent: 'deepseek',
      content: '搜集资料',
      reason: '需要资料',
      requestId: 'req-l1',
    });

    const first = createTask(temp.db, {
      conversationId,
      sourceAgent: 'claude',
      targetAgent: 'deepseek',
      instruction: '搜集资料',
      chainId: round.id,
      maxDepth: 2,
    });

    const linked = linkTask(temp.db, message.id, first.id);
    assert.equal(linked.task_id, first.id);
    assert.equal(linked.state, 'task_running');

    assert.equal(linkTask(temp.db, message.id, first.id).task_id, first.id, '重复挂同一个任务是幂等的');

    const secondTask = createTask(temp.db, {
      conversationId,
      sourceAgent: 'claude',
      targetAgent: 'codex',
      instruction: '另一个任务',
      chainId: round.id,
      maxDepth: 2,
    });

    assert.throws(
      () => linkTask(temp.db, message.id, secondTask.id),
      (err: unknown) => (err as { code?: string }).code === 'assignment_already_linked',
    );
  } finally {
    temp.cleanup();
  }
});

test('P1 身份：伪造的发送者与未绑定 Agent 都被拒绝', () => {
  const { temp, conversationId, sender } = fixture();

  try {
    const round = createRound(temp.db, conversationId, { goal: '做 PPT' });

    const forged = { agent: 'claude', conversationId } as unknown as TrustedSender;

    assert.throws(
      () =>
        recordMessage(temp.db, forged, {
          roundId: round.id,
          kind: 'notice',
          toAgent: 'codex',
          content: '我是 claude',
        }),
      (err: unknown) => (err as { code?: string }).code === 'untrusted_sender',
    );

    assert.throws(
      () => trustedSender(temp.db, conversationId, 'gemini'),
      (err: unknown) => (err as { code?: string }).code === 'invalid_agent',
    );

    const other = createConversation(temp.db, { title: '另一个会话' });

    assert.throws(
      () => trustedSender(temp.db, other.id, 'claude'),
      (err: unknown) => (err as { code?: string }).code === 'sender_not_bound',
    );

    const otherRound = createRound(temp.db, other.id, { goal: '别人的目标' });

    assert.throws(
      () =>
        recordMessage(temp.db, sender, {
          roundId: otherRound.id,
          kind: 'notice',
          toAgent: 'codex',
          content: '越界',
        }),
      (err: unknown) => (err as { code?: string }).code === 'round_not_in_conversation',
    );

    assert.equal(count(temp.db), 0);
  } finally {
    temp.cleanup();
  }
});

test('P1 收件箱：空收件箱只读不写', () => {
  const { temp, conversationId, sender } = fixture();

  try {
    const round = createRound(temp.db, conversationId, { goal: '做 PPT' });

    const before = count(temp.db);
    const items = inbox(temp.db, conversationId, 'codex');

    assert.deepEqual(items, []);
    assert.equal(count(temp.db), before, '查询不得写库，更不得触发任何 Agent');

    const { message } = recordMessage(temp.db, sender, {
      roundId: round.id,
      kind: 'notice',
      toAgent: 'codex',
      content: '有消息了',
      requestId: 'req-i1',
    });

    assert.equal(inbox(temp.db, conversationId, 'codex').length, 1);

    consume(temp.db, message.id);
    assert.equal(inbox(temp.db, conversationId, 'codex').length, 0, '已消费的不再出现在收件箱');
    assert.equal(inbox(temp.db, conversationId, 'codex', round.id).length, 0);
  } finally {
    temp.cleanup();
  }
});

test('P1 事务：入账失败不留半条消息', () => {
  const { temp, conversationId, sender } = fixture();

  try {
    const round = createRound(temp.db, conversationId, { goal: '做 PPT' });

    assert.throws(() =>
      recordMessage(temp.db, sender, {
        roundId: round.id,
        kind: 'notice',
        toAgent: 'codex',
        content: '引用一个不存在的任务',
        taskId: 'not-a-task',
        requestId: 'req-t1',
      }),
    );

    assert.equal(count(temp.db), 0, '外键失败后不得留下消息');

    const ok = recordMessage(temp.db, sender, {
      roundId: round.id,
      kind: 'notice',
      toAgent: 'codex',
      content: '这次不挂任务',
      requestId: 'req-t2',
    });

    assert.equal(ok.created, true);
  } finally {
    temp.cleanup();
  }
});

test('P1 重启：幂等与消费状态在重开后仍然成立', () => {
  const { temp, conversationId, sender } = fixture();

  try {
    const round = createRound(temp.db, conversationId, { goal: '做 PPT' });
    const { message } = recordMessage(temp.db, sender, {
      roundId: round.id,
      kind: 'notice',
      toAgent: 'codex',
      content: '重启前写下的',
      requestId: 'req-r1',
    });

    consume(temp.db, message.id);
    temp.close();

    const reopened = temp.reopen();
    const again = recordMessage(reopened, trustedSender(reopened, conversationId, 'claude'), {
      roundId: round.id,
      kind: 'notice',
      toAgent: 'codex',
      content: '重启前写下的',
      requestId: 'req-r1',
    });

    assert.equal(again.created, false, '重启后同一请求仍返回原消息');
    assert.equal(count(reopened), 1);
    assert.equal(consume(reopened, message.id), false, '已消费的消息重启后仍不可再消费');
  } finally {
    temp.cleanup();
  }
});
