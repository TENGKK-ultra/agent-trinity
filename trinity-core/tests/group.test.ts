import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import { createConversation } from '../src/conversations/conversation.service.ts';
import { startGroupTurn } from '../src/group/group.service.ts';
import type { GroupAgent } from '../src/group/mentions.ts';
import { sweepTasksOnStartup } from '../src/harnesses/task.service.ts';
import { parseClaudeLine } from '../src/harnesses/claude.adapter.ts';
import { parseCodexLine } from '../src/harnesses/codex.adapter.ts';
import { parseDshLine } from '../src/harnesses/dsh.adapter.ts';
import { activateBinding } from '../src/harnesses/session.service.ts';
import type { CoreRuntime } from '../src/harnesses/runtime.ts';
import type { HarnessAdapter } from '../src/harnesses/types.ts';
import { createTempDatabase } from './helpers.ts';

const EMIT = resolve(import.meta.dirname, 'fixtures', 'emit-group-reply.mjs');

const DISPLAY_NAMES: Record<GroupAgent, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  deepseek: 'DeepSeek Harness',
};

function replyAdapter(kind: GroupAgent, text: string, delayMs = 0): HarnessAdapter {
  return {
    type: kind,
    displayName: DISPLAY_NAMES[kind],
    resolveExecutable: () => ({ file: process.execPath, source: 'test' }),
    buildCommand: () => ({
      file: process.execPath,
      args: [EMIT, kind, text, String(delayMs)],
      env: {},
    }),
    parseLine:
      kind === 'claude' ? parseClaudeLine : kind === 'codex' ? parseCodexLine : parseDshLine,
  } as unknown as HarnessAdapter;
}

/** Same reply, but keeps the prompt and system rules Core actually handed over. */
function recordingAdapter(
  kind: GroupAgent,
  text: string,
  sink: string[],
  systems?: string[],
  tools?: string[][],
): HarnessAdapter {
  return {
    type: kind,
    displayName: DISPLAY_NAMES[kind],
    resolveExecutable: () => ({ file: process.execPath, source: 'test' }),
    buildCommand: (input: { prompt: string; systemAppend?: string; allowedTools?: string[] }) => {
      sink.push(input.prompt);
      if (systems !== undefined && input.systemAppend !== undefined) {
        systems.push(input.systemAppend);
      }
      if (tools !== undefined && input.allowedTools !== undefined) {
        tools.push(input.allowedTools);
      }
      return { file: process.execPath, args: [EMIT, kind, text], env: {} };
    },
    parseLine:
      kind === 'claude' ? parseClaudeLine : kind === 'codex' ? parseCodexLine : parseDshLine,
  } as unknown as HarnessAdapter;
}

function runtimeFor(adapters: Partial<Record<GroupAgent, HarnessAdapter>>): CoreRuntime {
  return {
    getAdapter: (type) => {
      const adapter = adapters[type as GroupAgent];
      if (!adapter) throw new Error(`no adapter for ${type}`);
      return adapter;
    },
  };
}

function tasks(db: ReturnType<typeof createTempDatabase>['db']) {
  return db
    .prepare(
      `SELECT target_agent, depth, chain_id, status, source_agent, delivery_status
         FROM agent_tasks ORDER BY rowid ASC`,
    )
    .all() as Array<Record<string, unknown>>;
}

test('群聊：@Claude 开始，Claude 转给 Codex，两步都真实执行', async () => {
  const temp = createTempDatabase();

  try {
    const conversation = createConversation(temp.db, { title: '群聊' });
    activateBinding(temp.db, conversation.id, { harnessType: 'claude', cwd: temp.dir, model: null });
    activateBinding(temp.db, conversation.id, { harnessType: 'codex', cwd: temp.dir, model: null });

    const runtime = runtimeFor({
      claude: replyAdapter('claude', '我让 @Codex 处理，请执行。'),
      codex: replyAdapter('codex', '完成。'),
    });

    const started = startGroupTurn(temp.db, conversation.id, '@Claude 请开始', {
      runtime,
      timeoutMs: 15_000,
    });

    assert.deepEqual(started.targets, ['claude']);

    const outcome = await started.completion;
    assert.equal(outcome.runs, 2);
    assert.equal(outcome.failed, 0);

    const rows = tasks(temp.db);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((row) => row.target_agent), ['claude', 'codex']);
    assert.deepEqual(rows.map((row) => row.depth), [0, 1]);
    assert.equal(rows[0]!.chain_id, rows[1]!.chain_id);
    assert.ok(rows.every((row) => row.status === 'completed'));
    assert.ok(
      rows.every((row) => row.delivery_status === 'delivered'),
      '群聊结果写进对话就算送达，重启扫描不应再报未送达',
    );

    assert.deepEqual(
      sweepTasksOnStartup(temp.db),
      { failed: 0, undelivered: 0 },
      '重启扫描对已完成的群聊任务无事可做',
    );

    const finals = temp.db
      .prepare(
        "SELECT sender_id FROM messages WHERE message_type = 'agent_final' ORDER BY rowid ASC",
      )
      .all() as Array<{ sender_id: string | null }>;

    assert.deepEqual(
      finals.map((row) => row.sender_id),
      ['Claude Code', 'Codex'],
    );
  } finally {
    temp.cleanup();
  }
});

test('群聊：Agent 提及自己不产生新的一轮', async () => {
  const temp = createTempDatabase();

  try {
    const conversation = createConversation(temp.db, { title: '自指' });
    activateBinding(temp.db, conversation.id, { harnessType: 'claude', cwd: temp.dir, model: null });

    const runtime = runtimeFor({
      claude: replyAdapter('claude', '@Claude 我继续想想。'),
    });

    const outcome = await startGroupTurn(temp.db, conversation.id, '@Claude 开始', {
      runtime,
      timeoutMs: 15_000,
    }).completion;

    assert.equal(outcome.runs, 1);
    assert.equal(tasks(temp.db).length, 1);
  } finally {
    temp.cleanup();
  }
});

test('群聊：一轮内每个 Agent 只执行一次，初始目标与转交合并去重', async () => {
  const temp = createTempDatabase();

  try {
    const conversation = createConversation(temp.db, { title: '去重' });
    activateBinding(temp.db, conversation.id, { harnessType: 'claude', cwd: temp.dir, model: null });
    activateBinding(temp.db, conversation.id, { harnessType: 'codex', cwd: temp.dir, model: null });

    const runtime = runtimeFor({
      claude: replyAdapter('claude', '收到。@Codex 你来补充。'),
      codex: replyAdapter('codex', '补充完毕。'),
    });

    // Claude 的回复再次提及 Codex，而 Codex 已经是本轮初始目标。
    const started = startGroupTurn(temp.db, conversation.id, '@Claude @Codex 你好', {
      runtime,
      timeoutMs: 15_000,
    });

    assert.deepEqual(started.targets, ['claude', 'codex']);

    const outcome = await started.completion;
    assert.equal(outcome.runs, 2);
    assert.deepEqual(
      tasks(temp.db).map((row) => row.target_agent),
      ['claude', 'codex'],
      'Codex 不因被重复提及而执行第二次',
    );
  } finally {
    temp.cleanup();
  }
});

test('群聊：用户点名的首批 Agent 并发执行，不互相排队', async () => {
  const temp = createTempDatabase();

  try {
    const conversation = createConversation(temp.db, { title: '并发' });
    activateBinding(temp.db, conversation.id, { harnessType: 'claude', cwd: temp.dir, model: null });
    activateBinding(temp.db, conversation.id, { harnessType: 'codex', cwd: temp.dir, model: null });

    const runtime = runtimeFor({
      claude: replyAdapter('claude', '在。', 500),
      codex: replyAdapter('codex', '在。', 500),
    });

    const started = Date.now();
    const outcome = await startGroupTurn(temp.db, conversation.id, '@Claude @Codex 在吗', {
      runtime,
      timeoutMs: 15_000,
    }).completion;
    const elapsed = Date.now() - started;

    assert.equal(outcome.runs, 2);
    assert.equal(outcome.failed, 0);
    assert.ok(elapsed < 900, `两个 500ms 的首批回合应并发完成，实际用了 ${elapsed}ms`);
  } finally {
    temp.cleanup();
  }
});

test('群聊：首批 Agent 读同一份快照，看不到同批的回复', async () => {
  const temp = createTempDatabase();

  try {
    const conversation = createConversation(temp.db, { title: '快照' });
    activateBinding(temp.db, conversation.id, { harnessType: 'claude', cwd: temp.dir, model: null });
    activateBinding(temp.db, conversation.id, { harnessType: 'codex', cwd: temp.dir, model: null });

    const claudePrompts: string[] = [];
    const codexPrompts: string[] = [];

    const runtime = runtimeFor({
      claude: recordingAdapter('claude', 'CLAUDE-MARK 我这边先答。', claudePrompts),
      codex: recordingAdapter('codex', '收到。', codexPrompts),
    });

    await startGroupTurn(temp.db, conversation.id, '@Claude @Codex 你们好', {
      runtime,
      timeoutMs: 15_000,
    }).completion;

    assert.equal(claudePrompts.length, 1);
    assert.equal(codexPrompts.length, 1);
    assert.match(claudePrompts[0]!, /你们好/, '两人都读到用户消息');
    assert.match(codexPrompts[0]!, /你们好/);
    assert.doesNotMatch(codexPrompts[0]!, /CLAUDE-MARK/, '同批的回复不得进入对方的上下文');
    assert.match(claudePrompts[0]!, /Claude Code/);
  } finally {
    temp.cleanup();
  }
});

test('群聊：转交要等上游回复，仍然串行', async () => {
  const temp = createTempDatabase();

  try {
    const conversation = createConversation(temp.db, { title: '串行' });
    activateBinding(temp.db, conversation.id, { harnessType: 'claude', cwd: temp.dir, model: null });
    activateBinding(temp.db, conversation.id, { harnessType: 'codex', cwd: temp.dir, model: null });

    const runtime = runtimeFor({
      claude: replyAdapter('claude', '@Codex 你来接手。', 400),
      codex: replyAdapter('codex', '已完成。', 400),
    });

    const started = Date.now();
    const outcome = await startGroupTurn(temp.db, conversation.id, '@Claude 开工', {
      runtime,
      timeoutMs: 15_000,
    }).completion;
    const elapsed = Date.now() - started;

    assert.equal(outcome.runs, 2);
    assert.ok(elapsed >= 750, `转交必须等上游回复，两段各 400ms，实际 ${elapsed}ms`);
  } finally {
    temp.cleanup();
  }
});

test('群聊：Claude → Codex → DSH 三者各执行一次', async () => {
  const temp = createTempDatabase();

  try {
    const conversation = createConversation(temp.db, { title: '三级转交' });
    for (const harnessType of ['claude', 'codex', 'deepseek'] as const) {
      activateBinding(temp.db, conversation.id, { harnessType, cwd: temp.dir, model: null });
    }

    const runtime = runtimeFor({
      claude: replyAdapter('claude', '@Codex 请你接手。'),
      codex: replyAdapter('codex', '我交给 @DSH。'),
      deepseek: replyAdapter('deepseek', '好，我处理完了。'),
    });

    const outcome = await startGroupTurn(temp.db, conversation.id, '@Claude 开工', {
      runtime,
      timeoutMs: 15_000,
    }).completion;

    assert.equal(outcome.runs, 3);
    assert.equal(outcome.failed, 0);
    assert.deepEqual(
      tasks(temp.db).map((row) => row.target_agent),
      ['claude', 'codex', 'deepseek'],
    );
    assert.deepEqual(
      tasks(temp.db).map((row) => row.depth),
      [0, 1, 2],
    );
  } finally {
    temp.cleanup();
  }
});

test('群聊：转交回本轮已发言的 Agent 不再执行，也不当成深度触顶', async () => {
  const temp = createTempDatabase();

  try {
    const conversation = createConversation(temp.db, { title: '回环' });
    activateBinding(temp.db, conversation.id, { harnessType: 'claude', cwd: temp.dir, model: null });
    activateBinding(temp.db, conversation.id, { harnessType: 'codex', cwd: temp.dir, model: null });

    const runtime = runtimeFor({
      claude: replyAdapter('claude', '@Codex 你来。'),
      codex: replyAdapter('codex', '@Claude 还是你来。'),
    });

    const outcome = await startGroupTurn(temp.db, conversation.id, '@Claude 开始', {
      runtime,
      timeoutMs: 15_000,
    }).completion;

    assert.equal(outcome.runs, 2);
    assert.deepEqual(
      tasks(temp.db).map((row) => row.target_agent),
      ['claude', 'codex'],
      'Claude 已经说过一次，回环不产生第二次执行',
    );

    const notice = temp.db
      .prepare("SELECT COUNT(*) AS total FROM messages WHERE message_type = 'system_event'")
      .get() as { total: number };
    assert.equal(notice.total, 0, '这不是被上限拦下的指派，不制造噪音提示');
  } finally {
    temp.cleanup();
  }
});

test('群聊：寒暄级联收敛为每人一次', async () => {
  const temp = createTempDatabase();

  try {
    const conversation = createConversation(temp.db, { title: '寒暄' });
    for (const harnessType of ['claude', 'codex', 'deepseek'] as const) {
      activateBinding(temp.db, conversation.id, { harnessType, cwd: temp.dir, model: null });
    }

    const runtime = runtimeFor({
      claude: replyAdapter('claude', '你好！@Codex 也打个招呼。'),
      codex: replyAdapter('codex', '你好。@DSH 你好。'),
      deepseek: replyAdapter('deepseek', '你好。@Claude 你好。'),
    });

    const started = startGroupTurn(temp.db, conversation.id, '@Claude 你好', {
      runtime,
      timeoutMs: 15_000,
    });

    const outcome = await started.completion;
    assert.equal(outcome.runs, 3);
    assert.equal(outcome.failed, 0);
    assert.deepEqual(
      tasks(temp.db).map((row) => row.target_agent).sort(),
      ['claude', 'codex', 'deepseek'],
      '互相 @ 不会让任何人跑第二遍',
    );
  } finally {
    temp.cleanup();
  }
});

test('群聊：去重只在一轮之内，新的一轮可以再次执行同一个 Agent', async () => {
  const temp = createTempDatabase();

  try {
    const conversation = createConversation(temp.db, { title: '跨轮' });
    activateBinding(temp.db, conversation.id, { harnessType: 'claude', cwd: temp.dir, model: null });

    const runtime = runtimeFor({
      claude: replyAdapter('claude', '收到。'),
    });

    const first = await startGroupTurn(temp.db, conversation.id, '@Claude 第一轮', {
      runtime,
      timeoutMs: 15_000,
    }).completion;

    const second = await startGroupTurn(temp.db, conversation.id, '@Claude 第二轮', {
      runtime,
      timeoutMs: 15_000,
    }).completion;

    assert.equal(first.runs, 1);
    assert.equal(second.runs, 1);
    assert.notEqual(first.groupTurnId, second.groupTurnId);

    const rows = tasks(temp.db);
    assert.equal(rows.length, 2, '两轮各执行一次');
    assert.equal(new Set(rows.map((row) => row.chain_id)).size, 2, '两轮各自成链');
  } finally {
    temp.cleanup();
  }
});

test('群聊：轮次 id 持久化，重启后仍能找回同一轮的任务', async () => {
  const temp = createTempDatabase();

  try {
    const conversation = createConversation(temp.db, { title: '持久化' });
    activateBinding(temp.db, conversation.id, { harnessType: 'claude', cwd: temp.dir, model: null });
    activateBinding(temp.db, conversation.id, { harnessType: 'codex', cwd: temp.dir, model: null });

    const runtime = runtimeFor({
      claude: replyAdapter('claude', '交给 @Codex。'),
      codex: replyAdapter('codex', '完成。'),
    });

    const outcome = await startGroupTurn(temp.db, conversation.id, '@Claude 开始', {
      runtime,
      timeoutMs: 15_000,
    }).completion;

    const byChain = temp.db
      .prepare('SELECT id FROM agent_tasks WHERE chain_id = ?')
      .all(outcome.groupTurnId) as Array<{ id: string }>;
    assert.equal(byChain.length, 2, '任务链 id 就是群聊轮次 id');

    const userMessage = temp.db
      .prepare(
        "SELECT metadata_json FROM messages WHERE message_type = 'user_message' ORDER BY rowid DESC LIMIT 1",
      )
      .get() as { metadata_json: string };
    assert.equal(
      JSON.parse(userMessage.metadata_json).group_turn_id,
      outcome.groupTurnId,
      '发起这一轮的用户消息也带着轮次 id',
    );

    // Close and reopen the same file: nothing here depends on the process.
    temp.close();
    const reopened = temp.reopen();

    const after = reopened
      .prepare('SELECT COUNT(*) AS total FROM agent_tasks WHERE chain_id = ?')
      .get(outcome.groupTurnId) as { total: number };
    assert.equal(after.total, 2);
  } finally {
    temp.cleanup();
  }
});

test('群聊：提及未绑定的 Agent 时拒绝，不悄悄换人', () => {
  const temp = createTempDatabase();

  try {
    const conversation = createConversation(temp.db, { title: '未绑定' });
    activateBinding(temp.db, conversation.id, { harnessType: 'claude', cwd: temp.dir, model: null });

    assert.throws(
      () => startGroupTurn(temp.db, conversation.id, '@DeepSeek 处理一下', { runtime: runtimeFor({}) }),
      (err: unknown) => (err as { code?: string }).code === 'no_bound_target',
    );
  } finally {
    temp.cleanup();
  }
});

test('群聊：没有提及时交给当前 Agent', async () => {
  const temp = createTempDatabase();

  try {
    const conversation = createConversation(temp.db, { title: '普通消息' });
    activateBinding(temp.db, conversation.id, { harnessType: 'claude', cwd: temp.dir, model: null });
    activateBinding(temp.db, conversation.id, { harnessType: 'codex', cwd: temp.dir, model: null });

    const runtime = runtimeFor({
      codex: replyAdapter('codex', '收到。'),
    });

    const started = startGroupTurn(temp.db, conversation.id, '你好', {
      runtime,
      timeoutMs: 15_000,
    });

    assert.deepEqual(started.targets, ['codex'], '当前激活的是 Codex');

    const outcome = await started.completion;
    assert.equal(outcome.runs, 1);
  } finally {
    temp.cleanup();
  }
});

test('群聊：显式参与集合只执行这些 Agent', async () => {
  const temp = createTempDatabase();

  try {
    const conversation = createConversation(temp.db, { title: '显式集合' });

    for (const agent of ['claude', 'codex', 'deepseek'] as const) {
      activateBinding(temp.db, conversation.id, { harnessType: agent, cwd: temp.dir, model: null });
    }

    const runtime = runtimeFor({
      claude: replyAdapter('claude', 'claude 回复'),
      codex: replyAdapter('codex', 'codex 回复'),
      deepseek: replyAdapter('deepseek', 'deepseek 回复'),
    });

    const started = startGroupTurn(temp.db, conversation.id, '一起看一下', {
      runtime,
      targets: ['claude', 'codex'],
      timeoutMs: 15_000,
    });

    assert.deepEqual(started.targets, ['claude', 'codex']);

    const outcome = await started.completion;
    assert.equal(outcome.runs, 2);

    const rows = (
      temp.db
        .prepare('SELECT target_agent FROM agent_tasks WHERE chain_id = ? ORDER BY target_agent')
        .all(started.groupTurnId) as Array<{ target_agent: string }>
    ).map((row) => row.target_agent);

    assert.deepEqual(rows, ['claude', 'codex'], '未参与本轮的其他 Agent 不得被执行');
  } finally {
    temp.cleanup();
  }
});

test('群聊：显式参与集合优先于文本中的提及', async () => {
  const temp = createTempDatabase();

  try {
    const conversation = createConversation(temp.db, { title: '提及冲突' });

    for (const agent of ['claude', 'codex', 'deepseek'] as const) {
      activateBinding(temp.db, conversation.id, { harnessType: agent, cwd: temp.dir, model: null });
    }

    const runtime = runtimeFor({
      claude: replyAdapter('claude', '收到'),
      codex: replyAdapter('codex', '收到'),
      deepseek: replyAdapter('deepseek', '收到'),
    });

    const started = startGroupTurn(temp.db, conversation.id, '@DSH 看一下', {
      runtime,
      targets: ['claude'],
      timeoutMs: 15_000,
    });

    assert.deepEqual(started.targets, ['claude']);
    await started.completion;

    const rows = temp.db
      .prepare('SELECT target_agent FROM agent_tasks WHERE chain_id = ?')
      .all(started.groupTurnId) as Array<{ target_agent: string }>;

    assert.deepEqual(
      rows.map((row) => row.target_agent),
      ['claude'],
    );
  } finally {
    temp.cleanup();
  }
});

test('群聊：显式集合适用于未绑定的 Agent 时被拒绝', () => {
  const temp = createTempDatabase();

  try {
    const conversation = createConversation(temp.db, { title: '未绑定目标' });
    activateBinding(temp.db, conversation.id, { harnessType: 'claude', cwd: temp.dir, model: null });

    const runtime = runtimeFor({ claude: replyAdapter('claude', '收到') });

    assert.throws(
      () =>
        startGroupTurn(temp.db, conversation.id, '你好', {
          runtime,
          targets: ['codex'],
        }),
      (err: unknown) => (err as { code?: string }).code === 'no_bound_target',
    );
  } finally {
    temp.cleanup();
  }
});

test('群聊：混合提及只执行已绑定的被提及者', async () => {
  const temp = createTempDatabase();

  try {
    const conversation = createConversation(temp.db, { title: '混合提及' });
    activateBinding(temp.db, conversation.id, { harnessType: 'claude', cwd: temp.dir, model: null });

    const runtime = runtimeFor({ claude: replyAdapter('claude', '收到') });

    const started = startGroupTurn(temp.db, conversation.id, '@Claude 和 @DSH 一起看', {
      runtime,
      timeoutMs: 15_000,
    });

    assert.deepEqual(started.targets, ['claude'], '未绑定的 DSH 被忽略，不拒绝整条发送');
    await started.completion;

    const rows = temp.db
      .prepare('SELECT target_agent FROM agent_tasks WHERE chain_id = ?')
      .all(started.groupTurnId) as Array<{ target_agent: string }>;

    assert.deepEqual(
      rows.map((row) => row.target_agent),
      ['claude'],
    );
  } finally {
    temp.cleanup();
  }
});

test('团队模式：只叫决策者，其余在场待命，决策者收到一次回报', async () => {
  const temp = createTempDatabase();

  try {
    const conversation = createConversation(temp.db, { title: '团队模式' });

    for (const agent of ['claude', 'codex', 'deepseek'] as const) {
      activateBinding(temp.db, conversation.id, {
        harnessType: agent,
        cwd: temp.dir,
        model: null,
        makeActive: false,
      });
    }

    const prompts: string[] = [];
    const systems: string[] = [];
    const tools: string[][] = [];
    const runtime = runtimeFor({
      codex: recordingAdapter(
        'codex',
        '先分派：@Claude 请实现 add(a,b) 并运行测试。',
        prompts,
        systems,
        tools,
      ),
      claude: recordingAdapter(
        'claude',
        '已实现并测试，@Codex 结果通过。',
        prompts,
        systems,
        tools,
      ),
    });

    const started = startGroupTurn(temp.db, conversation.id, '实现一个加法函数并测试', {
      runtime,
      timeoutMs: 15_000,
      targets: ['claude', 'codex', 'deepseek'],
      mode: 'team',
      dispatcher: 'codex',
    });

    assert.deepEqual(started.targets, ['claude', 'codex', 'deepseek']);
    assert.deepEqual(started.waiting, ['claude', 'deepseek'], 'CC 和 DSH 先待命，不花回合');

    const outcome = await started.completion;
    assert.equal(outcome.runs, 3, 'Codex 分派 → Claude 执行 → Codex 收口');
    assert.equal(outcome.failed, 0);

    const rows = tasks(temp.db);
    assert.deepEqual(rows.map((row) => row.target_agent), ['codex', 'claude', 'codex']);
    assert.deepEqual(rows.map((row) => row.depth), [0, 1, 2]);

    assert.match(prompts[0] ?? '', /\[团队章程\]/);
    assert.match(prompts[0] ?? '', /本轮决策者：Codex/);
    assert.match(prompts[0] ?? '', /即使任务很小，也要先分派/);
    assert.match(prompts[1] ?? '', /第一工程师/);
    assert.match(prompts[1] ?? '', /@Codex 把结果/);
    assert.match(prompts[1] ?? '', /\[本轮指派\]/, '指派正文必须完整送达成员');
    assert.match(prompts[1] ?? '', /实现 add\(a,b\) 并运行测试/, '指派不能只靠被截断的群聊记录');
    assert.match(prompts[2] ?? '', /已实现并测试/, '决策者的收口回合能看到成员的结果');

    // The role rules ride in the system/developer prompt, above the task text.
    assert.match(systems[0] ?? '', /\[硬规则\]/);
    assert.match(systems[0] ?? '', /你只负责分发/);
    assert.match(systems[0] ?? '', /不要使用任何文件/);
    assert.match(systems[1] ?? '', /被指派的执行者/);
    assert.match(systems[2] ?? '', /收口回合/);
    assert.deepEqual(tools[0], ['Read', 'Glob', 'Grep'], '执行者的只读工具自动放行');
  } finally {
    temp.cleanup();
  }
});

test('团队模式：决策者未绑定时明确拒绝，且不创建任务', async () => {
  const temp = createTempDatabase();

  try {
    const conversation = createConversation(temp.db, { title: '无决策者' });
    activateBinding(temp.db, conversation.id, {
      harnessType: 'claude',
      cwd: temp.dir,
      model: null,
    });

    const runtime = runtimeFor({ claude: replyAdapter('claude', '收到') });

    await assert.rejects(
      async () => {
        startGroupTurn(temp.db, conversation.id, '做一个任务', {
          runtime,
          targets: ['claude'],
          mode: 'team',
          dispatcher: 'codex',
        });
      },
      (err: unknown) => (err as { code?: string }).code === 'dispatcher_not_bound',
    );

    assert.equal(tasks(temp.db).length, 0);
  } finally {
    temp.cleanup();
  }
});
