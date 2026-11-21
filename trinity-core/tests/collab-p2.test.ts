import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import {
  acceptRequest,
  assignTask,
  decideAssignment,
  rankCandidates,
  refuseAssignment,
  requestHelp,
} from '../src/collab/dispatch.service.ts';
import {
  buildCheckpointPrompt,
  harnessRunner,
  runCheckpoint,
  type CheckpointRunner,
} from '../src/collab/checkpoint.service.ts';
import { contextOf, findRound, recordMessage, trustedSender } from '../src/collab/messages.service.ts';
import {
  blockRound,
  closeRound,
  failRound,
  isTerminalStatus,
  resumeRound,
  setRoundStatus,
} from '../src/collab/rounds.service.ts';
import {
  coordinatorOf,
  grantRole,
  handover,
  initRound,
  listRoles,
  revokeRole,
  roleAt,
  roleEvents,
} from '../src/collab/roles.service.ts';
import { createConversation } from '../src/conversations/conversation.service.ts';
import { parseClaudeLine } from '../src/harnesses/claude.adapter.ts';
import type { CoreRuntime } from '../src/harnesses/runtime.ts';
import { activateBinding } from '../src/harnesses/session.service.ts';
import { listTasks } from '../src/harnesses/task.service.ts';
import type { HarnessAdapter } from '../src/harnesses/types.ts';
import { createTempDatabase, type TempDatabase } from './helpers.ts';

const EMIT = resolve(import.meta.dirname, 'fixtures', 'emit-group-reply.mjs');

interface Fixture {
  temp: TempDatabase;
  conversationId: string;
  roundId: string;
}

function fixture(): Fixture {
  const temp = createTempDatabase();
  const conversation = createConversation(temp.db, { title: 'P2 协作' });

  for (const harnessType of ['claude', 'codex', 'deepseek'] as const) {
    activateBinding(temp.db, conversation.id, { harnessType, cwd: temp.dir, model: null });
  }

  const { round } = initRound(temp.db, {
    conversationId: conversation.id,
    goal: '做一份 PPT',
    coordinator: 'codex',
    contributors: ['claude', 'deepseek'],
  });

  return { temp, conversationId: conversation.id, roundId: round.id };
}

function replyAdapter(text: string, calls: { count: number }): HarnessAdapter {
  return {
    type: 'claude',
    displayName: 'Claude Code',
    resolveExecutable: () => ({ file: process.execPath, source: 'test' }),
    buildCommand: () => {
      calls.count += 1;
      return { file: process.execPath, args: [EMIT, 'claude', text], env: {} };
    },
    parseLine: parseClaudeLine,
  } as unknown as HarnessAdapter;
}

function runtimeFor(adapter: HarnessAdapter): CoreRuntime {
  return { getAdapter: () => adapter };
}

// ---------- 角色 ----------

test('P2 角色：初始化写入协调者与参与者，并各留一条事件', () => {
  const { temp, roundId } = fixture();

  try {
    const roles = listRoles(temp.db, roundId);
    assert.deepEqual(
      roles.map((row) => `${row.agent}:${row.role}`).sort(),
      ['claude:contributor', 'codex:coordinator', 'deepseek:contributor'],
    );
    assert.equal(coordinatorOf(temp.db, roundId), 'codex');

    const events = roleEvents(temp.db, roundId);
    assert.equal(events.length, 3);
    assert.ok(events.every((event) => event.action === 'grant' && event.reason));
  } finally {
    temp.cleanup();
  }
});

test('P2 角色：交接同时更新当前角色与事件历史', () => {
  const { temp, roundId } = fixture();

  try {
    const moved = handover(temp.db, roundId, 'claude', {
      assignedBy: 'user',
      reason: '这一轮需要 Claude 统筹',
    });

    assert.deepEqual(moved, { from: 'codex', to: 'claude' });
    assert.equal(coordinatorOf(temp.db, roundId), 'claude');
    assert.equal(findRound(temp.db, roundId)?.coordinator, 'claude');

    const events = roleEvents(temp.db, roundId);
    const handoverEvent = events.find((event) => event.action === 'handover');
    assert.ok(handoverEvent);
    assert.equal(handoverEvent.agent, 'codex');
    assert.equal(handoverEvent.successor, 'claude');
  } finally {
    temp.cleanup();
  }
});

test('P2 角色：按时间点可以还原当时是谁负责', async () => {
  const { temp, roundId } = fixture();

  try {
    await new Promise((resolve) => setTimeout(resolve, 10));
    const before = new Date().toISOString();
    await new Promise((resolve) => setTimeout(resolve, 10));
    handover(temp.db, roundId, 'claude', { assignedBy: 'user', reason: '换人' });
    const after = new Date(Date.now() + 5).toISOString();

    assert.equal(roleAt(temp.db, roundId, 'codex', before), 'coordinator');
    assert.equal(roleAt(temp.db, roundId, 'claude', before), 'contributor');
    assert.equal(roleAt(temp.db, roundId, 'codex', after), 'contributor');
    assert.equal(roleAt(temp.db, roundId, 'claude', after), 'coordinator');
  } finally {
    temp.cleanup();
  }
});

test('P2 角色：授予与撤销都必须给理由', () => {
  const { temp, roundId } = fixture();

  try {
    assert.throws(
      () => grantRole(temp.db, roundId, 'claude', 'reviewer', { assignedBy: 'codex', reason: '  ' }),
      (err: unknown) => (err as { code?: string }).code === 'invalid_reason',
    );

    grantRole(temp.db, roundId, 'claude', 'reviewer', {
      assignedBy: 'codex',
      reason: '需要独立审查',
    });
    assert.equal(
      roleEvents(temp.db, roundId).filter((event) => event.agent === 'claude').length,
      2,
    );

    revokeRole(temp.db, roundId, 'deepseek', { assignedBy: 'codex', reason: '本轮不需要' });
    const revoke = roleEvents(temp.db, roundId).find((event) => event.action === 'revoke');
    assert.equal(revoke?.agent, 'deepseek');
  } finally {
    temp.cleanup();
  }
});

// ---------- 轮次状态 ----------

test('P2 轮次：合法转移通过，非法转移被拒', () => {
  const { temp, roundId } = fixture();

  try {
    assert.equal(findRound(temp.db, roundId)?.status, 'created');

    setRoundStatus(temp.db, roundId, 'running');
    assert.equal(findRound(temp.db, roundId)?.status, 'running');

    setRoundStatus(temp.db, roundId, 'reviewing');
    assert.equal(findRound(temp.db, roundId)?.status, 'reviewing');

    setRoundStatus(temp.db, roundId, 'running');
    assert.equal(findRound(temp.db, roundId)?.status, 'running');

    assert.throws(
      () => setRoundStatus(temp.db, roundId, 'created'),
      (err: unknown) => (err as { code?: string }).code === 'invalid_transition',
    );
  } finally {
    temp.cleanup();
  }
});

test('P2 轮次：终止状态必须带 outcome，且之后不可再变', () => {
  const { temp, roundId } = fixture();

  try {
    setRoundStatus(temp.db, roundId, 'running');
    closeRound(temp.db, roundId, 'completed');

    const round = findRound(temp.db, roundId);
    assert.equal(round?.status, 'delivered');
    assert.equal(round?.outcome, 'completed');
    assert.ok(round?.closed_at);
    assert.equal(isTerminalStatus(round!.status), true);

    assert.throws(
      () => setRoundStatus(temp.db, roundId, 'running'),
      (err: unknown) => (err as { code?: string }).code === 'round_closed',
    );
  } finally {
    temp.cleanup();
  }
});

test('P2 轮次：delivered 不接受 failed 这类 outcome', () => {
  const { temp, roundId } = fixture();

  try {
    setRoundStatus(temp.db, roundId, 'running');

    assert.throws(
      () => closeRound(temp.db, roundId, 'failed' as never),
      (err: unknown) => (err as { code?: string }).code === 'invalid_outcome',
    );
  } finally {
    temp.cleanup();
  }
});

test('P2 轮次：blocked 必须有解除条件，可恢复，也可超时判失败', () => {
  const { temp, roundId } = fixture();

  try {
    setRoundStatus(temp.db, roundId, 'running');

    assert.throws(
      () => blockRound(temp.db, roundId, { reason: '等审批', wakeCondition: '  ' }),
      (err: unknown) => (err as { code?: string }).code === 'invalid_block',
    );

    blockRound(temp.db, roundId, { reason: '等审批', wakeCondition: '审批通过' });
    assert.equal(findRound(temp.db, roundId)?.status, 'blocked');

    resumeRound(temp.db, roundId);
    const resumed = findRound(temp.db, roundId);
    assert.equal(resumed?.status, 'running');
    assert.equal(resumed?.blocked_reason, null);

    failRound(temp.db, roundId, 'partially_completed');
    assert.equal(findRound(temp.db, roundId)?.outcome, 'partially_completed');
  } finally {
    temp.cleanup();
  }
});

// ---------- 指派 ----------

test('P2 指派：任务与消息在一个事务里同时落库', () => {
  const { temp, conversationId, roundId } = fixture();

  try {
    const { message, task } = assignTask(temp.db, {
      roundId,
      actor: 'codex',
      target: 'deepseek',
      instruction: '搜集资料',
      reason: 'DSH 空闲且擅长检索',
      taskType: 'research',
    });

    assert.equal(message.task_id, task.id);
    assert.equal(message.state, 'task_running', '已产生任务的指派不再等待接受');
    assert.equal(message.assigned_by, 'codex');
    assert.match(message.reason ?? '', /^DSH 空闲且擅长检索（capability: unknown）$/);
    assert.equal(task.chain_id, roundId);
    assert.equal(findRound(temp.db, roundId)?.hops_used, 1);
  } finally {
    temp.cleanup();
  }
});

test('P2 指派：消息入账失败时任务一并回滚', () => {
  const { temp, conversationId, roundId } = fixture();

  try {
    // 先有一条同样内容、同样发送者的指派（尚未关联任务）
    const sender = trustedSender(temp.db, conversationId, 'codex');
    recordMessage(temp.db, sender, {
      roundId,
      kind: 'assignment',
      toAgent: 'deepseek',
      content: '查一下这个主题',
      reason: '先记一条',
    });

    const tasksBefore = listTasks(temp.db, conversationId).length;

    assert.throws(
      () =>
        assignTask(temp.db, {
          roundId,
          actor: 'codex',
          target: 'deepseek',
          instruction: '查一下这个主题',
          reason: '正式指派',
        }),
      (err: unknown) => (err as { code?: string }).code === 'duplicate_assignment',
    );

    assert.equal(
      listTasks(temp.db, conversationId).length,
      tasksBefore,
      '关联失败后不得留下孤儿任务',
    );
  } finally {
    temp.cleanup();
  }
});

test('P2 指派：同一 requestId 重试不会多建任务', () => {
  const { temp, conversationId, roundId } = fixture();

  try {
    const first = assignTask(temp.db, {
      roundId,
      actor: 'codex',
      target: 'deepseek',
      instruction: '搜集资料',
      reason: '第一次',
      requestId: 'req-retry',
    });

    const second = assignTask(temp.db, {
      roundId,
      actor: 'codex',
      target: 'deepseek',
      instruction: '搜集资料',
      reason: '第一次',
      requestId: 'req-retry',
    });

    assert.equal(second.message.id, first.message.id);
    assert.equal(second.task.id, first.task.id);
    assert.equal(listTasks(temp.db, conversationId).length, 1, '重试不得产生第二个任务');
  } finally {
    temp.cleanup();
  }
});

test('P2 指派：只有协调者或用户可以指派', () => {
  const { temp, roundId } = fixture();

  try {
    assert.throws(
      () =>
        assignTask(temp.db, {
          roundId,
          actor: 'claude',
          target: 'deepseek',
          instruction: '你来做',
          reason: '我想推给别人',
        }),
      (err: unknown) => (err as { code?: string }).code === 'not_authorized',
    );

    assert.throws(
      () =>
        assignTask(temp.db, {
          roundId,
          actor: 'codex',
          target: 'codex',
          instruction: '自己来',
          reason: '自派',
        }),
      (err: unknown) => (err as { code?: string }).code === 'self_assignment',
    );
  } finally {
    temp.cleanup();
  }
});

test('P2 指派：能力不匹配与目标不可用都被拒绝', () => {
  const { temp, conversationId, roundId } = fixture();

  try {
    assert.throws(
      () =>
        assignTask(temp.db, {
          roundId,
          actor: 'codex',
          target: 'deepseek',
          instruction: '画一张图',
          reason: '让它画图',
          taskType: 'image',
          capability: { verdict: () => 'no' },
        }),
      (err: unknown) => (err as { code?: string }).code === 'capability_mismatch',
    );

    const { task } = assignTask(temp.db, {
      roundId,
      actor: 'codex',
      target: 'deepseek',
      instruction: '搜集资料',
      reason: '正常指派',
    });

    assert.equal(task.status, 'queued');

    assert.throws(
      () =>
        assignTask(temp.db, {
          roundId,
          actor: 'codex',
          target: 'deepseek',
          instruction: '再查一次',
          reason: '重复使用同一目标',
        }),
      (err: unknown) => {
        const code = (err as { code?: string }).code;
        return code === 'target_unavailable' || code === 'delegation_too_deep';
      },
    );

    assert.equal(listTasks(temp.db, conversationId).length, 1);
  } finally {
    temp.cleanup();
  }
});

test('P2 指派：hop 预算耗尽后拒绝传播，但已有任务照常保留', () => {
  const { temp, conversationId, roundId } = fixture();

  try {
    const { message } = assignTask(temp.db, {
      roundId,
      actor: 'codex',
      target: 'deepseek',
      instruction: '第一跳',
      reason: '第一跳',
      parentMessageId: null,
    });

    // 把轮次预算压到 1，第二跳必须被拒
    temp.db.prepare('UPDATE collab_rounds SET budget_hops = 1 WHERE id = ?').run(roundId);

    assert.throws(
      () =>
        assignTask(temp.db, {
          roundId,
          actor: 'codex',
          target: 'claude',
          instruction: '第二跳',
          reason: '第二跳',
          parentMessageId: message.id,
        }),
      (err: unknown) => (err as { code?: string }).code === 'budget_exhausted',
    );

    const tasks = listTasks(temp.db, conversationId);
    assert.equal(tasks.length, 1, '被拒的消息不得产生任务');
    assert.equal(tasks[0]?.status, 'queued', '已有任务不受影响');
    assert.equal(findRound(temp.db, roundId)?.budget_hops, 1);
  } finally {
    temp.cleanup();
  }
});

test('P2 指派：评分与选择给出可解释理由', () => {
  const { temp, conversationId, roundId } = fixture();

  try {
    const ranked = rankCandidates(temp.db, roundId, conversationId, ['claude', 'deepseek'], {
      cost: { claude: 3, deepseek: 1 },
      preference: { claude: 2 },
    });

    assert.equal(ranked.length, 2);
    assert.ok(ranked.every((candidate) => candidate.reason.length > 0));

    const decision = decideAssignment(temp.db, roundId, conversationId, ['claude', 'deepseek'], {
      capability: { verdict: (_agent, taskType) => (taskType === 'research' ? 'yes' : 'no') },
      taskType: 'research',
    });

    assert.ok(['claude', 'deepseek'].includes(decision.agent));
    assert.ok(decision.reason.includes('历史完成'));
  } finally {
    temp.cleanup();
  }
});

// ---------- 协助请求 ----------

test('P2 协助：请求不建任务，接受时才创建并关联', () => {
  const { temp, conversationId, roundId } = fixture();

  try {
    const request = requestHelp(temp.db, {
      roundId,
      from: 'claude',
      to: 'deepseek',
      instruction: '帮我查资料',
      reason: '我这边没有检索工具',
    });

    assert.equal(request.task_id, null);
    assert.equal(listTasks(temp.db, conversationId).length, 0);

    const task = acceptRequest(temp.db, request.id);
    assert.equal(task.target_agent, 'deepseek');

    const linked = temp.db
      .prepare('SELECT task_id, state FROM agent_messages WHERE id = ?')
      .get(request.id) as { task_id: string; state: string };
    assert.equal(linked.task_id, task.id);
    assert.equal(linked.state, 'task_running');
  } finally {
    temp.cleanup();
  }
});

test('P2 协助：拒绝要写理由，拒绝后不可再接受', () => {
  const { temp, roundId } = fixture();

  try {
    const request = requestHelp(temp.db, {
      roundId,
      from: 'claude',
      to: 'deepseek',
      instruction: '帮我写代码',
      reason: '请求协助',
    });

    assert.throws(
      () => refuseAssignment(temp.db, request.id, '   '),
      (err: unknown) => (err as { code?: string }).code === 'invalid_reason',
    );

    const refused = refuseAssignment(temp.db, request.id, '这不是我的职责');
    assert.equal(refused.state, 'refused');
    assert.equal(refused.refusal_reason, '这不是我的职责');

    assert.throws(
      () => acceptRequest(temp.db, request.id),
      (err: unknown) => (err as { code?: string }).code === 'request_refused',
    );
  } finally {
    temp.cleanup();
  }
});

// ---------- 检查点 ----------

function counterRunner(result: { ok: boolean } = { ok: true }): {
  runner: CheckpointRunner;
  calls: string[];
} {
  const calls: string[] = [];

  return {
    calls,
    runner: async (turn) => {
      calls.push(turn.prompt);
      return { ok: result.ok, text: result.ok ? '好的' : null };
    },
  };
}

test('P2 检查点：空收件箱不启动 Agent', async () => {
  const { temp, roundId } = fixture();

  try {
    const { runner, calls } = counterRunner();
    const result = await runCheckpoint(temp.db, { roundId, agent: 'codex', runner });

    assert.equal(result.ran, false);
    assert.equal(result.reason, 'empty_inbox');
    assert.equal(calls.length, 0, '空收件箱不得调用 Agent');
  } finally {
    temp.cleanup();
  }
});

test('P2 检查点：多条消息合并成一次调用', async () => {
  const { temp, roundId } = fixture();

  try {
    const sender = trustedSender(temp.db, findRound(temp.db, roundId)!.conversation_id, 'claude');

    for (const [index, text] of ['第一条', '第二条', '第三条'].entries()) {
      recordMessage(temp.db, sender, {
        roundId,
        kind: 'notice',
        toAgent: 'codex',
        content: text,
        requestId: `req-batch-${index}`,
      });
    }

    const { runner, calls } = counterRunner();
    const result = await runCheckpoint(temp.db, { roundId, agent: 'codex', runner });

    assert.equal(result.ran, true);
    assert.equal(calls.length, 1, '三条消息只启动一次');
    for (const text of ['第一条', '第二条', '第三条']) {
      assert.ok(calls[0]!.includes(text), `检查点提示应包含 ${text}`);
    }
    assert.equal(result.consumed, 3);
  } finally {
    temp.cleanup();
  }
});

test('P2 检查点：失败不消费，下一次还能看到', async () => {
  const { temp, roundId } = fixture();

  try {
    const sender = trustedSender(temp.db, findRound(temp.db, roundId)!.conversation_id, 'claude');
    recordMessage(temp.db, sender, {
      roundId,
      kind: 'notice',
      toAgent: 'codex',
      content: '重要通知',
      requestId: 'req-fail',
    });

    const failing = counterRunner({ ok: false });
    const first = await runCheckpoint(temp.db, { roundId, agent: 'codex', runner: failing.runner });

    assert.equal(first.ran, true);
    assert.equal(first.consumed, 0);

    const retry = counterRunner();
    const second = await runCheckpoint(temp.db, { roundId, agent: 'codex', runner: retry.runner });

    assert.equal(second.ran, true, '失败的消息仍会被再次处理');
    assert.equal(second.consumed, 1);
  } finally {
    temp.cleanup();
  }
});

test('P2 检查点：已消费的消息不再触发', async () => {
  const { temp, roundId } = fixture();

  try {
    const sender = trustedSender(temp.db, findRound(temp.db, roundId)!.conversation_id, 'claude');
    recordMessage(temp.db, sender, {
      roundId,
      kind: 'notice',
      toAgent: 'codex',
      content: '处理过一次',
      requestId: 'req-once',
    });

    const first = counterRunner();
    await runCheckpoint(temp.db, { roundId, agent: 'codex', runner: first.runner });

    const second = counterRunner();
    const again = await runCheckpoint(temp.db, { roundId, agent: 'codex', runner: second.runner });

    assert.equal(again.ran, false);
    assert.equal(second.calls.length, 0);
  } finally {
    temp.cleanup();
  }
});

test('P2 检查点：轮次结束后不再启动', async () => {
  const { temp, roundId } = fixture();

  try {
    const sender = trustedSender(temp.db, findRound(temp.db, roundId)!.conversation_id, 'claude');
    recordMessage(temp.db, sender, {
      roundId,
      kind: 'notice',
      toAgent: 'codex',
      content: '迟到的消息',
      requestId: 'req-closed',
    });

    setRoundStatus(temp.db, roundId, 'running');
    closeRound(temp.db, roundId, 'completed');

    const { runner, calls } = counterRunner();
    const result = await runCheckpoint(temp.db, { roundId, agent: 'codex', runner });

    assert.equal(result.ran, false);
    assert.equal(result.reason, 'round_closed');
    assert.equal(calls.length, 0);
  } finally {
    temp.cleanup();
  }
});

test('P2 检查点：真实适配器路径下，空收件箱零调用、有消息才跑一次', async () => {
  const { temp, conversationId, roundId } = fixture();
  const calls = { count: 0 };
  const runtime = runtimeFor(replyAdapter('收到，我处理一下。', calls));

  try {
    const empty = await runCheckpoint(temp.db, {
      roundId,
      agent: 'codex',
      runner: harnessRunner(runtime, 15_000),
    });

    assert.equal(empty.ran, false);
    assert.equal(calls.count, 0, '空收件箱不得启动任何进程');

    const sender = trustedSender(temp.db, conversationId, 'claude');
    recordMessage(temp.db, sender, {
      roundId,
      kind: 'notice',
      toAgent: 'codex',
      content: '资料已经准备好',
      requestId: 'req-real',
    });

    const ran = await runCheckpoint(temp.db, {
      roundId,
      agent: 'codex',
      runner: harnessRunner(runtime, 15_000),
    });

    assert.equal(ran.ran, true);
    assert.equal(ran.ok, true);
    assert.equal(ran.consumed, 1);
    assert.equal(calls.count, 1, '有消息时只启动一次');
  } finally {
    temp.cleanup();
  }
});

test('P2 检查点：提示词包含目标、职责、预算与收件箱', () => {
  const { temp, roundId } = fixture();

  try {
    const round = findRound(temp.db, roundId)!;
    const sender = trustedSender(temp.db, round.conversation_id, 'claude');
    const { message } = recordMessage(temp.db, sender, {
      roundId,
      kind: 'notice',
      toAgent: 'codex',
      content: '进度：已完成一半',
      requestId: 'req-prompt',
    });

    const prompt = buildCheckpointPrompt(round, 'codex', [message]);

    assert.match(prompt, /本轮目标：做一份 PPT/);
    assert.match(prompt, /协调者/);
    assert.match(prompt, /剩余传播预算/);
    assert.match(prompt, /进度：已完成一半/);
    assert.match(prompt, /没有后续动作/);
  } finally {
    temp.cleanup();
  }
});

test('P2 事务：接受请求时若建任务失败，消息保持未关联', () => {
  const { temp, conversationId, roundId } = fixture();

  try {
    const request = requestHelp(temp.db, {
      roundId,
      from: 'claude',
      to: 'deepseek',
      instruction: '帮我查资料',
      reason: '请求协助',
    });

    // Make task creation fail for real: the message names an agent Core does
    // not know. (The chain re-entry guard no longer runs for orchestrated
    // tasks — that is the P3 coordinator-lock fix — so it cannot be the trigger.)
    temp.db.prepare("UPDATE agent_messages SET to_agent = 'gemini' WHERE id = ?").run(request.id);

    assert.throws(
      () => acceptRequest(temp.db, request.id),
      (err: unknown) => (err as { code?: string }).code === 'invalid_target_agent',
    );

    const row = temp.db
      .prepare('SELECT task_id, state FROM agent_messages WHERE id = ?')
      .get(request.id) as { task_id: string | null; state: string };

    assert.equal(row.task_id, null, '任务创建失败后不得写入关联');
    assert.notEqual(row.state, 'task_running');
    assert.equal(
      (temp.db.prepare('SELECT COUNT(*) AS n FROM agent_tasks').get() as { n: number }).n,
      0,
      '失败的事务不得留下半个任务',
    );
  } finally {
    temp.cleanup();
  }
});

// ---------- 能力三态 ----------

test('P2 能力：yes 通过并记录，no 拒绝，unknown 默认可派但标注', () => {
  const { temp, conversationId, roundId } = fixture();

  try {
    const yes = assignTask(temp.db, {
      roundId,
      actor: 'codex',
      target: 'deepseek',
      instruction: '查资料',
      reason: '已确认能力',
      capability: { verdict: () => 'yes' },
    });
    assert.match(yes.message.reason ?? '', /capability: yes/);

    assert.throws(
      () =>
        assignTask(temp.db, {
          roundId,
          actor: 'codex',
          target: 'claude',
          instruction: '画图',
          reason: '不匹配',
          capability: { verdict: () => 'no' },
        }),
      (err: unknown) => (err as { code?: string }).code === 'capability_mismatch',
    );

    const unknown = assignTask(temp.db, {
      roundId,
      actor: 'codex',
      target: 'claude',
      instruction: '写总结',
      reason: '默认未知',
    });
    assert.match(unknown.message.reason ?? '', /^默认未知（capability: unknown）$/);
    assert.equal(listTasks(temp.db, conversationId).length, 2);
  } finally {
    temp.cleanup();
  }
});

test('P2 能力：requireKnownCapability 开启后未知被拒绝', () => {
  const { temp, conversationId, roundId } = fixture();

  try {
    assert.throws(
      () =>
        assignTask(temp.db, {
          roundId,
          actor: 'codex',
          target: 'deepseek',
          instruction: '查资料',
          reason: '严格模式',
          requireKnownCapability: true,
        }),
      (err: unknown) => (err as { code?: string }).code === 'capability_unknown',
    );

    assert.equal(listTasks(temp.db, conversationId).length, 0);
  } finally {
    temp.cleanup();
  }
});

// ---------- 检查点消息语义 ----------

test('P2 检查点：完成只消费通知，指派仍可接受', async () => {
  const { temp, conversationId, roundId } = fixture();

  try {
    const sender = trustedSender(temp.db, conversationId, 'claude');
    const notice = recordMessage(temp.db, sender, {
      roundId,
      kind: 'notice',
      toAgent: 'codex',
      content: '进度一半',
      requestId: 'sem-n1',
    });
    const request = requestHelp(temp.db, {
      roundId,
      from: 'claude',
      to: 'codex',
      instruction: '帮我核对',
      reason: '需要核对',
    });

    const { runner } = counterRunner();
    const result = await runCheckpoint(temp.db, { roundId, agent: 'codex', runner });

    assert.equal(result.ran, true);
    assert.equal(result.consumed, 1, '只消费通知');

    const states = Object.fromEntries(
      temp.db
        .prepare('SELECT id, state FROM agent_messages WHERE id IN (?, ?)')
        .all(notice.message.id, request.id)
        .map((row) => [row.id, row.state]),
    );

    assert.equal(states[notice.message.id], 'consumed');
    assert.equal(states[request.id], 'delivered', '指派保持可处理');

    const task = acceptRequest(temp.db, request.id);
    assert.equal(task.target_agent, 'codex');
  } finally {
    temp.cleanup();
  }
});

test('P2 检查点：完成之后指派仍可拒绝', async () => {
  const { temp, roundId } = fixture();

  try {
    const request = requestHelp(temp.db, {
      roundId,
      from: 'claude',
      to: 'codex',
      instruction: '帮我核对',
      reason: '需要核对',
    });

    const { runner } = counterRunner();
    await runCheckpoint(temp.db, { roundId, agent: 'codex', runner });

    const refused = refuseAssignment(temp.db, request.id, '不是我的职责');
    assert.equal(refused.state, 'refused');
  } finally {
    temp.cleanup();
  }
});

test('P2 检查点：发言不进入收件箱，也不会唤醒 Agent', async () => {
  const { temp, conversationId, roundId } = fixture();

  try {
    const sender = trustedSender(temp.db, conversationId, 'claude');
    recordMessage(temp.db, sender, {
      roundId,
      kind: 'utterance',
      toAgent: 'codex',
      content: '我觉得方案 B 更好',
      requestId: 'sem-u1',
    });

    const { runner, calls } = counterRunner();
    const result = await runCheckpoint(temp.db, { roundId, agent: 'codex', runner });

    assert.equal(result.ran, false);
    assert.equal(calls.length, 0, '发言不是工作项，不得唤醒 Agent');

    const row = temp.db
      .prepare("SELECT state FROM agent_messages WHERE request_id = 'sem-u1'")
      .get() as { state: string };
    assert.equal(row.state, 'queued', '发言保持原状态，作为上下文');

    const again = await runCheckpoint(temp.db, { roundId, agent: 'codex', runner });
    assert.equal(again.ran, false);
  } finally {
    temp.cleanup();
  }
});

test('P2 检查点：已关联任务的指派不会再被当成新请求', async () => {
  const { temp, conversationId, roundId } = fixture();

  try {
    const { message } = assignTask(temp.db, {
      roundId,
      actor: 'codex',
      target: 'deepseek',
      instruction: '查资料',
      reason: '正式指派',
    });

    const before = temp.db
      .prepare('SELECT state FROM agent_messages WHERE id = ?')
      .get(message.id) as { state: string };
    assert.equal(before.state, 'task_running', '已产生任务的指派不在待处理状态');

    const { runner } = counterRunner();
    const result = await runCheckpoint(temp.db, { roundId, agent: 'deepseek', runner });

    assert.equal(result.ran, false, '已关联任务的指派不在收件箱里');
  } finally {
    temp.cleanup();
  }
});

// ---------- utterance 上下文 ----------

test('P2 上下文：发言不触发检查点，但会进入后续检查点的提示词', async () => {
  const { temp, conversationId, roundId } = fixture();

  try {
    const sender = trustedSender(temp.db, conversationId, 'claude');
    recordMessage(temp.db, sender, {
      roundId,
      kind: 'utterance',
      toAgent: 'codex',
      content: '我建议先做调研',
      requestId: 'ctx-u1',
    });

    const alone = counterRunner();
    const empty = await runCheckpoint(temp.db, { roundId, agent: 'codex', runner: alone.runner });
    assert.equal(empty.ran, false, '只有发言时不得启动');
    assert.equal(alone.calls.length, 0);

    recordMessage(temp.db, sender, {
      roundId,
      kind: 'notice',
      toAgent: 'codex',
      content: '资料已备好',
      requestId: 'ctx-n1',
    });

    const { runner, calls } = counterRunner();
    const result = await runCheckpoint(temp.db, { roundId, agent: 'codex', runner });

    assert.equal(result.ran, true);
    assert.equal(calls.length, 1);
    assert.ok(calls[0]!.includes('群聊上下文'), '提示词应有独立上下文段');
    assert.ok(calls[0]!.includes('我建议先做调研'), '发言应出现在上下文里');
    assert.ok(calls[0]!.includes('资料已备好'), '通知仍在待处理工作项里');

    assert.ok(
      result.messages.every((message) => message.kind !== 'utterance'),
      '发言不得被当作工作项',
    );
  } finally {
    temp.cleanup();
  }
});

test('P2 上下文：已消费的通知作为历史保留，但不再触发', async () => {
  const { temp, conversationId, roundId } = fixture();

  try {
    const sender = trustedSender(temp.db, conversationId, 'claude');
    const first = recordMessage(temp.db, sender, {
      roundId,
      kind: 'notice',
      toAgent: 'codex',
      content: '第一条通知',
      requestId: 'ctx-n2',
    });

    const initial = counterRunner();
    await runCheckpoint(temp.db, { roundId, agent: 'codex', runner: initial.runner });

    const consumedState = temp.db
      .prepare('SELECT state FROM agent_messages WHERE id = ?')
      .get(first.message.id) as { state: string };
    assert.equal(consumedState.state, 'consumed');

    recordMessage(temp.db, sender, {
      roundId,
      kind: 'notice',
      toAgent: 'codex',
      content: '第二条通知',
      requestId: 'ctx-n3',
    });

    const { runner, calls } = counterRunner();
    const result = await runCheckpoint(temp.db, { roundId, agent: 'codex', runner });

    assert.equal(result.ran, true);
    assert.ok(calls[0]!.includes('第一条通知'), '已消费通知作为历史出现在上下文里');
    assert.equal(result.messages.length, 1, '待处理只剩第二条');
    assert.equal(result.messages[0]?.content, '第二条通知');
  } finally {
    temp.cleanup();
  }
});

test('P2 上下文：查询只读，不改变任何消息状态', () => {
  const { temp, conversationId, roundId } = fixture();

  try {
    const sender = trustedSender(temp.db, conversationId, 'claude');
    recordMessage(temp.db, sender, {
      roundId, kind: 'utterance', toAgent: 'codex', content: '只读检查', requestId: 'ctx-ro',
    });

    const before = temp.db
      .prepare('SELECT state FROM agent_messages WHERE round_id = ? ORDER BY rowid')
      .all(roundId) as Array<{ state: string }>;

    contextOf(temp.db, roundId);

    const after = temp.db
      .prepare('SELECT state FROM agent_messages WHERE round_id = ? ORDER BY rowid')
      .all(roundId) as Array<{ state: string }>;

    assert.deepEqual(after, before);
  } finally {
    temp.cleanup();
  }
});

test('P2 上下文：待处理通知只出现在工作项，消费后才作为历史出现', async () => {
  const { temp, conversationId, roundId } = fixture();

  const occurrences = (text: string, needle: string): number => text.split(needle).length - 1;

  try {
    const sender = trustedSender(temp.db, conversationId, 'claude');
    recordMessage(temp.db, sender, {
      roundId,
      kind: 'notice',
      toAgent: 'codex',
      content: '资料A',
      requestId: 'dup-a',
    });

    const first = counterRunner();
    await runCheckpoint(temp.db, { roundId, agent: 'codex', runner: first.runner });

    const prompt1 = first.calls[0]!;
    assert.equal(occurrences(prompt1, '资料A'), 1, '待处理通知只能出现一次');
    const [context1, work1] = prompt1.split('待处理工作项');
    assert.ok(!context1!.includes('资料A'), '未消费前不得进入上下文段');
    assert.ok(work1!.includes('资料A'), '应出现在工作项段');

    recordMessage(temp.db, sender, {
      roundId,
      kind: 'notice',
      toAgent: 'codex',
      content: '资料B',
      requestId: 'dup-b',
    });

    const second = counterRunner();
    await runCheckpoint(temp.db, { roundId, agent: 'codex', runner: second.runner });

    const prompt2 = second.calls[0]!;
    const [context2, work2] = prompt2.split('待处理工作项');
    assert.ok(context2!.includes('资料A'), '消费后作为历史出现');
    assert.ok(!work2!.includes('资料A'), '消费后不再进入工作项');
    assert.ok(work2!.includes('资料B'));
    assert.ok(!context2!.includes('资料B'), '新通知仍在工作项，不重复');
    assert.equal(occurrences(prompt2, '资料A'), 1);
  } finally {
    temp.cleanup();
  }
});
