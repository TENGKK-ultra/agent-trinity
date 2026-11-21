import assert from 'node:assert/strict';
import test from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import { createConversation } from '../src/conversations/conversation.service.ts';
import { withTransaction } from '../src/database/transaction.ts';
import {
  assertDelegationAllowed,
  cancelChain,
  cancelTask,
  completeTask,
  createTask,
  failTask,
  findTask,
  listTasks,
  markTaskRunning,
  setDeliveryStatus,
  sweepTasksOnStartup,
  timeoutTask,
} from '../src/harnesses/task.service.ts';
import { addMessage } from '../src/messages/message.service.ts';
import { createTempDatabase, startTestServer, type TempDatabase } from './helpers.ts';

interface Fixture {
  temp: TempDatabase;
  conversationId: string;
}

function withFixture(run: (fixture: Fixture) => void | Promise<void>): () => Promise<void> {
  return async () => {
    const temp = createTempDatabase();
    try {
      const conversation = createConversation(temp.db, { title: '任务' });
      await run({ temp, conversationId: conversation.id });
    } finally {
      temp.cleanup();
    }
  };
}

function baseTask(conversationId: string, overrides: Record<string, unknown> = {}) {
  return {
    conversationId,
    sourceAgent: 'claude',
    sourceTurnId: 'turn-source',
    targetAgent: 'codex',
    instruction: '检查数据库迁移是否完整，并报告结论',
    ...overrides,
  };
}

function changeLogOf(db: DatabaseSync): Array<{ operation: string; payload_json: string }> {
  return db
    .prepare("SELECT operation, payload_json FROM change_log WHERE entity_type = 'agent_task' ORDER BY seq")
    .all() as unknown as Array<{ operation: string; payload_json: string }>;
}

test('D3.5.3a 创建：写入 queued、记录 source_turn_id，target_turn_id 为空', withFixture(({ temp, conversationId }) => {
  const row = createTask(temp.db, baseTask(conversationId));

  assert.equal(row.status, 'queued');
  assert.equal(row.delivery_status, 'pending');
  assert.equal(row.source_turn_id, 'turn-source');
  assert.equal(row.target_turn_id, null);
  assert.equal(row.chain_id, row.id, '首个任务的 chain 根就是它自己');
  assert.equal(row.depth, 0);

  const logs = changeLogOf(temp.db);
  assert.equal(logs.length, 1);
  assert.equal(logs[0]?.operation, 'insert');
  assert.equal(JSON.stringify(logs[0]?.payload_json).includes('检查数据库'), false, '日志不记指令正文');
}));

test('D3.5.3a 创建：标题缺省取指令前 30 字，显式标题优先', withFixture(({ temp, conversationId }) => {
  const long = '一'.repeat(50);
  const derived = createTask(temp.db, baseTask(conversationId, { instruction: long }));
  assert.equal(Array.from(derived.title).length, 30);

  const explicit = createTask(temp.db, baseTask(conversationId, { instruction: long, title: '  代码审查  ' }));
  assert.equal(explicit.title, '代码审查');

  const blankTitle = createTask(temp.db, baseTask(conversationId, { instruction: long, title: '   ' }));
  assert.equal(Array.from(blankTitle.title).length, 30, '空白标题回退到指令');
}));

test('D3.5.3a 创建：空白指令、自委派、未知目标都被拒绝', withFixture(({ temp, conversationId }) => {
  assert.throws(() => createTask(temp.db, baseTask(conversationId, { instruction: '   ' })), /must not be empty/);
  assert.throws(
    () => createTask(temp.db, baseTask(conversationId, { targetAgent: 'claude' })),
    /cannot delegate to itself/,
  );
  assert.throws(
    () => createTask(temp.db, baseTask(conversationId, { targetAgent: 'gemini' })),
    /Unknown target agent/,
  );
}));

test('D3.5.3a 创建：普通委派仍只能一层，群聊用显式深度', withFixture(({ temp, conversationId }) => {
  const root = createTask(temp.db, baseTask(conversationId));

  assert.throws(
    () =>
      createTask(temp.db, {
        conversationId,
        sourceAgent: 'codex',
        targetAgent: 'deepseek',
        instruction: '普通委派不能再往下',
        parentTaskId: root.id,
      }),
    /Delegation depth limit is 0/,
    '不传 maxDepth 时保持原来的单层限制',
  );

  const child = createTask(temp.db, {
    conversationId,
    sourceAgent: 'codex',
    targetAgent: 'deepseek',
    instruction: '第二层',
    parentTaskId: root.id,
    maxDepth: 2,
  });
  assert.equal(child.depth, 1, '群聊显式深度允许第一层');

  // A fourth level needs a parent at depth 2 in a chain that has not already
  // used the target; seed one so the depth check is what rejects it.
  temp.db
    .prepare(
      `INSERT INTO agent_tasks
         (id, conversation_id, parent_task_id, chain_id, depth, source_agent,
          source_turn_id, target_agent, target_turn_id, title, instruction,
          status, delivery_status, result_message_id, error_text,
          created_at, started_at, finished_at)
       VALUES ('deep-task', ?, NULL, 'deep-chain', 2, 'claude', NULL, 'codex', NULL,
               '深层', '深层', 'cancelled', 'pending', NULL, NULL, ?, NULL, NULL)`,
    )
    .run(conversationId, new Date().toISOString());

  assert.throws(
    () =>
      createTask(temp.db, {
        conversationId,
        sourceAgent: 'codex',
        targetAgent: 'deepseek',
        instruction: '超过上限',
        parentTaskId: 'deep-task',
        maxDepth: 2,
      }),
    /Delegation depth limit is 2/,
  );
}));

test('D3.5.3a 创建：普通委派仍是根任务，不受群聊放开深度影响', withFixture(({ temp, conversationId }) => {
  const root = createTask(temp.db, baseTask(conversationId));

  assert.equal(root.depth, 0);
  assert.equal(root.chain_id, root.id, '没有 parent 时链名仍是根任务 id');

  const named = createTask(temp.db, {
    ...baseTask(conversationId),
    chainId: 'round-1',
  });
  assert.equal(named.chain_id, 'round-1', '显式 chainId 只在群聊轮次里使用');
}));

test('D3.5.3a 创建：链内禁止重入（3b 开放 depth 后的防线）', withFixture(({ temp, conversationId }) => {
  const root = createTask(temp.db, baseTask(conversationId));

  // depth=0 时同链不可能有第二个任务，这里直接构造一个运行中的同链成员，
  // 验证守卫本身：它拦的是"目标已在链上"，那正是会死锁的方向。
  temp.db
    .prepare(
      `INSERT INTO agent_tasks
         (id, conversation_id, chain_id, depth, source_agent, target_agent,
          title, instruction, status, delivery_status, created_at)
       VALUES ('synthetic', ?, ?, 0, 'codex', 'codex', 't', 'i', 'running', 'pending', ?)`,
    )
    .run(conversationId, root.chain_id, new Date().toISOString());

  assert.throws(
    () => assertDelegationAllowed(temp.db, root.chain_id, 'codex'),
    /already part of this delegation chain/,
  );

  assert.doesNotThrow(() => assertDelegationAllowed(temp.db, root.chain_id, 'deepseek'));

  const other = createTask(temp.db, baseTask(conversationId, { targetAgent: 'deepseek' }));
  assert.notEqual(other.chain_id, root.chain_id, '不同委派各自成链');
}));

test('D3.5.3a 状态机：queued → running → completed', withFixture(({ temp, conversationId }) => {
  const row = createTask(temp.db, baseTask(conversationId));
  const running = markTaskRunning(temp.db, row.id, 'turn-target');

  assert.equal(running?.status, 'running');
  assert.equal(running?.target_turn_id, 'turn-target');
  assert.equal(running?.source_turn_id, 'turn-source', '两个 turn 互不覆盖');

  assert.equal(markTaskRunning(temp.db, row.id, 'turn-again'), null, '不能重复启动');

  const message = addMessage(temp.db, conversationId, {
    content: '任务结果',
    message_type: 'agent_final',
    sender_kind: 'agent',
    sender_id: 'codex',
  });

  const done = completeTask(temp.db, row.id, message.id);
  assert.equal(done?.status, 'completed');
  assert.equal(done?.result_message_id, message.id);

  assert.equal(completeTask(temp.db, row.id, message.id), null, '终态不可再变');
}));

test('D3.5.3a 约束：completed 必须有 result_message_id（数据库强制）', withFixture(({ temp, conversationId }) => {
  const row = createTask(temp.db, baseTask(conversationId));
  markTaskRunning(temp.db, row.id, 'turn-target');

  assert.throws(
    () =>
      temp.db
        .prepare("UPDATE agent_tasks SET status = 'completed' WHERE id = ?")
        .run(row.id),
    /CHECK constraint failed/,
    '绕过业务代码也必须被数据库拒绝',
  );
}));

test('D3.5.3a 约束：结果消息必须属于同一对话', withFixture(({ temp, conversationId }) => {
  const other = createConversation(temp.db, { title: '别的对话' });
  const foreign = addMessage(temp.db, other.id, { content: '别处的结果' });

  const row = createTask(temp.db, baseTask(conversationId));
  markTaskRunning(temp.db, row.id, 'turn-target');

  assert.throws(() => completeTask(temp.db, row.id, foreign.id), /same conversation/);
  assert.equal(findTask(temp.db, row.id)?.status, 'running', '拒绝后状态不变');
}));

test('D3.5.3a 状态机：失败、超时、取消各自只能从合法状态出发', withFixture(({ temp, conversationId }) => {
  const queued = createTask(temp.db, baseTask(conversationId));
  assert.equal(timeoutTask(temp.db, queued.id), null, 'queued 不能直接超时');

  assert.equal(failTask(temp.db, queued.id, 'agent_unavailable')?.status, 'failed');

  const running = createTask(temp.db, baseTask(conversationId));
  markTaskRunning(temp.db, running.id, 'turn-target');
  assert.equal(timeoutTask(temp.db, running.id)?.status, 'timeout');

  const cancelled = createTask(temp.db, baseTask(conversationId));
  assert.equal(cancelTask(temp.db, cancelled.id, 'user_cancelled')?.status, 'cancelled');
  assert.equal(cancelTask(temp.db, cancelled.id, 'again'), null);
}));

test('D3.5.3a 取消：整条链一起取消', withFixture(({ temp, conversationId }) => {
  const root = createTask(temp.db, baseTask(conversationId));

  // depth=0 时同链只有一个任务；插入一个同链成员来验证 cancelChain 的作用域。
  temp.db
    .prepare(
      `INSERT INTO agent_tasks
         (id, conversation_id, chain_id, depth, source_agent, target_agent,
          title, instruction, status, delivery_status, created_at)
       VALUES ('child', ?, ?, 1, 'codex', 'deepseek', 't', 'i', 'running', 'pending', ?)`,
    )
    .run(conversationId, root.chain_id, new Date().toISOString());

  const unrelated = createTask(temp.db, baseTask(conversationId, { targetAgent: 'deepseek' }));

  assert.equal(cancelChain(temp.db, root.chain_id, 'parent_cancelled'), 2);
  assert.equal(findTask(temp.db, root.id)?.status, 'cancelled');
  assert.equal(findTask(temp.db, 'child')?.status, 'cancelled');
  assert.equal(findTask(temp.db, unrelated.id)?.status, 'queued', '别的链不受影响');
}));

test('D3.5.3a 交付：只能从 pending 变更，重复回调不覆盖', withFixture(({ temp, conversationId }) => {
  const row = createTask(temp.db, baseTask(conversationId));

  assert.equal(setDeliveryStatus(temp.db, row.id, 'delivered')?.delivery_status, 'delivered');
  assert.equal(setDeliveryStatus(temp.db, row.id, 'failed'), null, '已交付不被改写');
  assert.equal(findTask(temp.db, row.id)?.delivery_status, 'delivered');
}));

test('D3.5.3a 事务：任务写入与 change_log 一起回滚', withFixture(({ temp, conversationId }) => {
  const before = listTasks(temp.db, conversationId).length;

  assert.throws(() => {
    withTransaction(temp.db, () => {
      createTask(temp.db, baseTask(conversationId));
      throw new Error('boom');
    });
  }, /boom/);

  assert.equal(listTasks(temp.db, conversationId).length, before);
  assert.equal(changeLogOf(temp.db).length, 0);
}));

test('D3.5.3a 恢复：只改该改的行，且可重复执行', withFixture(({ temp, conversationId }) => {
  const queued = createTask(temp.db, baseTask(conversationId));

  const running = createTask(temp.db, baseTask(conversationId));
  markTaskRunning(temp.db, running.id, 'turn-target');

  const completedMessage = addMessage(temp.db, conversationId, {
    content: '已完成的结果',
    message_type: 'agent_final',
    sender_kind: 'agent',
    sender_id: 'codex',
  });
  const completed = createTask(temp.db, baseTask(conversationId));
  markTaskRunning(temp.db, completed.id, 'turn-target');
  completeTask(temp.db, completed.id, completedMessage.id);

  const delivered = createTask(temp.db, baseTask(conversationId));
  markTaskRunning(temp.db, delivered.id, 'turn-target');
  completeTask(temp.db, delivered.id, completedMessage.id);
  setDeliveryStatus(temp.db, delivered.id, 'delivered');

  const first = sweepTasksOnStartup(temp.db);
  assert.deepEqual(first, { failed: 2, undelivered: 1 });

  assert.equal(findTask(temp.db, queued.id)?.status, 'failed');
  assert.equal(findTask(temp.db, queued.id)?.error_text, 'core_restart');
  assert.equal(findTask(temp.db, running.id)?.status, 'failed');

  const done = findTask(temp.db, completed.id);
  assert.equal(done?.status, 'completed', '已完成的任务不得被改成失败');
  assert.equal(done?.result_message_id, completedMessage.id, '结果引用不得丢失');
  assert.equal(done?.delivery_status, 'failed', '未送达的结果如实标记');

  assert.equal(findTask(temp.db, delivered.id)?.delivery_status, 'delivered', '已交付的不回退');

  const second = sweepTasksOnStartup(temp.db);
  assert.deepEqual(second, { failed: 0, undelivered: 0 }, '第二次扫描无事可做');
  assert.equal(findTask(temp.db, completed.id)?.delivery_status, 'failed');
}));

test('D3.5.3a API：列出任务、可过滤、错误输入被拒绝', async () => {
  const temp = createTempDatabase();
  const server = await startTestServer(temp.db);

  try {
    const conversation = createConversation(temp.db, { title: '接口' });
    const first = createTask(temp.db, baseTask(conversation.id));
    const second = createTask(temp.db, baseTask(conversation.id, { targetAgent: 'deepseek' }));
    failTask(temp.db, second.id, 'agent_unavailable');

    const all = await fetch(
      `${server.baseUrl}/api/conversations/${conversation.id}/tasks`,
    ).then((res) => res.json() as Promise<{ items: Array<{ id: string }> }>);
    assert.equal(all.items.length, 2);

    const failed = await fetch(
      `${server.baseUrl}/api/conversations/${conversation.id}/tasks?status=failed`,
    ).then((res) => res.json() as Promise<{ items: Array<{ id: string; status: string }> }>);
    assert.equal(failed.items.length, 1);
    assert.equal(failed.items[0]?.id, second.id);

    const badStatus = await fetch(
      `${server.baseUrl}/api/conversations/${conversation.id}/tasks?status=nope`,
    );
    assert.equal(badStatus.status, 400);

    const unknown = await fetch(`${server.baseUrl}/api/conversations/missing/tasks`);
    assert.equal(unknown.status, 404);

    assert.ok(first.id);
  } finally {
    await server.close();
    temp.cleanup();
  }
});
