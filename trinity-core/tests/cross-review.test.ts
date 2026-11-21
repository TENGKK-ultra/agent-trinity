import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import * as board from '../src/board/board.service.ts';
import { startCrossReview } from '../src/board/cross-review.service.ts';
import { createConversation } from '../src/conversations/conversation.service.ts';
import { parseClaudeLine } from '../src/harnesses/claude.adapter.ts';
import { parseCodexLine } from '../src/harnesses/codex.adapter.ts';
import { parseDshLine } from '../src/harnesses/dsh.adapter.ts';
import type { CoreRuntime } from '../src/harnesses/runtime.ts';
import { activateBinding } from '../src/harnesses/session.service.ts';
import type { HarnessAdapter, HarnessType } from '../src/harnesses/types.ts';
import { createTempDatabase, type TempDatabase } from './helpers.ts';

const EMIT = resolve(import.meta.dirname, 'fixtures', 'emit-group-reply.mjs');

const DISPLAY: Record<HarnessType, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  deepseek: 'DeepSeek Harness',
};

function parserFor(kind: HarnessType) {
  if (kind === 'claude') return parseClaudeLine;
  if (kind === 'codex') return parseCodexLine;

  return parseDshLine;
}

function scripted(kind: HarnessType, replies: string[], sink?: string[]): HarnessAdapter {
  let index = 0;

  return {
    type: kind,
    displayName: DISPLAY[kind],
    resolveExecutable: () => ({ file: process.execPath, source: 'test' }),
    buildCommand: (input: { prompt: string }) => {
      sink?.push(input.prompt);
      const text = replies[Math.min(index, replies.length - 1)] ?? '';
      index += 1;

      return { file: process.execPath, args: [EMIT, kind, text], env: {} };
    },
    parseLine: parserFor(kind),
  } as unknown as HarnessAdapter;
}

function runtimeFor(adapters: Partial<Record<HarnessType, HarnessAdapter>>): CoreRuntime {
  return {
    getAdapter: (type) => {
      const adapter = adapters[type as HarnessType];

      if (!adapter) throw new Error(`no adapter for ${type}`);

      return adapter;
    },
  };
}

function setup(
  temp: TempDatabase,
  limit: number,
  bind: HarnessType[] = ['codex', 'claude', 'deepseek'],
  requestedAgent?: HarnessType,
) {
  const conversation = createConversation(temp.db, { title: '交叉验证' });

  for (const agent of bind) {
    activateBinding(temp.db, conversation.id, {
      harnessType: agent,
      cwd: temp.dir,
      model: null,
      makeActive: false,
    });
  }

  const card = board.createCard(
    temp.db,
    conversation.id,
    {
      title: '实现 add',
      goal: '实现 add(a,b) 并验证 2+3=5',
      acceptance: ['给出实现', '边界测试通过'],
      crossRoundLimit: limit,
      ...(requestedAgent === undefined ? {} : { requestedAgent }),
    },
    board.boardUser(temp.db, conversation.id),
  );

  return { conversation, card };
}

test('交叉验证：Codex 派发 → CC/DSH 两轮 → Codex 汇总', async () => {
  const temp = createTempDatabase();

  try {
    const { conversation, card } = setup(temp, 2);

    const codexPrompts: string[] = [];
    const runtime = runtimeFor({
      codex: scripted(
        'codex',
        [
          '这项任务交给 Claude。\n@Claude 请实现 add(a,b)，覆盖 2+3 与负数边界，完成后交 DSH 验证。',
          '汇总：\n- 一致：实现与边界验证通过。\n- 改动：Claude 补充了边界测试。\n- 风险：无未决问题。\n- 能力分析：Claude 适合实现，DSH 适合独立验证。\n- 下一步：1. 由用户决定是否合入；2. 由 Claude 补充文档。\n等待用户决定。',
        ],
        codexPrompts,
      ),
      claude: scripted('claude', [
        '已实现初版并自测。\n@DSH 请验证边界。',
        '已补充空输入边界测试并通过。\n[已处理] 边界未覆盖\n@DSH 请复验。',
      ]),
      deepseek: scripted('deepseek', [
        '实现可用，但边界未覆盖。\n[问题] 边界未覆盖 | 空输入没有测试\n[未通过]',
        '边界测试已补充，复验通过。\n[已解决] 边界未覆盖\n[通过]',
      ]),
    });

    const started = startCrossReview(temp.db, conversation.id, card.id, {
      runtime,
      timeoutMs: 20_000,
    });

    const outcome = await started.completion;

    assert.equal(outcome.status, 'waiting_user');
    assert.equal(outcome.rounds, 2);
    assert.ok(outcome.summaryMessageId);

    const fresh = board.findCard(temp.db, card.id);
    assert.ok(fresh);
    assert.equal(fresh.cross_round_used, 2);
    assert.equal(fresh.cross_phase, 'waiting_user');
    assert.equal(fresh.status, 'running');

    const findings = board.listFindings(temp.db, card.id);
    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.title, '边界未覆盖');
    assert.equal(findings[0]?.status, 'resolved');

    const events = board.listEvents(temp.db, card.id).map((event) => event.kind);
    assert.ok(events.includes('round_started'));
    assert.ok(events.includes('reviewed'));
    assert.ok(events.includes('round_limit_reached'));
    assert.ok(events.includes('summarized'));

    const tasks = temp.db
      .prepare('SELECT target_agent, status FROM agent_tasks WHERE chain_id = ? ORDER BY rowid')
      .all(card.id) as Array<{ target_agent: string; status: string }>;

    assert.equal(tasks.length, 6, '派发 + 2×(CC+DSH) + 汇总');
    assert.ok(tasks.every((task) => task.status === 'completed'));

    const messages = board.listMessages(temp.db, card.id);
    assert.equal(messages.filter((message) => message.kind === 'review').length, 2);
    assert.ok(messages.some((message) => message.content.includes('等待用户决定')));

    assert.match(codexPrompts[0] ?? '', /\[交叉验证·派发\]/);
    assert.match(codexPrompts[1] ?? '', /\[交叉验证·汇总\]/);
  } finally {
    temp.cleanup();
  }
});

test('交叉验证：Codex 不派发时停在本轮，不启动 CC/DSH', async () => {
  const temp = createTempDatabase();

  try {
    const { conversation, card } = setup(temp, 5);

    const runtime = runtimeFor({
      codex: scripted('codex', ['这项任务不需要分工，信息已经足够，直接结束。']),
      claude: scripted('claude', ['不应该被调用']),
      deepseek: scripted('deepseek', ['不应该被调用']),
    });

    const outcome = await startCrossReview(temp.db, conversation.id, card.id, {
      runtime,
      timeoutMs: 20_000,
    }).completion;

    assert.equal(outcome.status, 'waiting_user');
    assert.equal(outcome.rounds, 0);

    const tasks = temp.db
      .prepare('SELECT target_agent FROM agent_tasks WHERE chain_id = ?')
      .all(card.id) as Array<{ target_agent: string }>;

    assert.deepEqual(tasks.map((task) => task.target_agent), ['codex']);
    assert.equal(board.findCard(temp.db, card.id)?.cross_phase, 'waiting_user');
  } finally {
    temp.cleanup();
  }
});

test('交叉验证：缺少成员时明确失败，不发 LLM 请求', async () => {
  const temp = createTempDatabase();

  try {
    const { conversation, card } = setup(temp, 5, ['claude', 'deepseek']);

    const runtime = runtimeFor({});

    const outcome = await startCrossReview(temp.db, conversation.id, card.id, {
      runtime,
      timeoutMs: 20_000,
    }).completion;

    assert.equal(outcome.status, 'failed');
    assert.match(outcome.reason ?? '', /codex is not bound/);
    assert.equal(board.findCard(temp.db, card.id)?.cross_phase, 'waiting_user');

    const tasks = temp.db
      .prepare('SELECT COUNT(*) AS total FROM agent_tasks WHERE chain_id = ?')
      .get(card.id) as { total: number };

    assert.equal(tasks.total, 0);
  } finally {
    temp.cleanup();
  }
});

test('交叉验证：用户指定 Claude 时跳过 Codex 派发', async () => {
  const temp = createTempDatabase();

  try {
    const { conversation, card } = setup(temp, 1, undefined, 'claude');

    const runtime = runtimeFor({
      codex: scripted('codex', ['汇总：Claude 已完成，没有未决问题。\n等待用户决定。']),
      claude: scripted('claude', ['已完成统计。\n@DSH 请验证。']),
      deepseek: scripted('deepseek', ['验证通过。\n[通过]']),
    });

    const outcome = await startCrossReview(temp.db, conversation.id, card.id, {
      runtime,
      timeoutMs: 20_000,
    }).completion;

    assert.equal(outcome.status, 'waiting_user');
    assert.equal(outcome.rounds, 1);

    const tasks = temp.db
      .prepare('SELECT target_agent FROM agent_tasks WHERE chain_id = ? ORDER BY rowid')
      .all(card.id) as Array<{ target_agent: string }>;

    assert.deepEqual(
      tasks.map((task) => task.target_agent),
      ['claude', 'deepseek', 'codex'],
      '指定 Claude：执行 → 验证 → 汇总，没有 Codex 派发',
    );

    const messages = board.listMessages(temp.db, card.id);
    assert.equal(messages.filter((message) => message.kind === 'assignment').length, 0);
    assert.ok(messages.some((message) => message.content.includes('用户指定由 Claude Code 执行')));
  } finally {
    temp.cleanup();
  }
});

test('交叉验证：用户指定 Codex 时它亲自执行，DSH 验证', async () => {
  const temp = createTempDatabase();

  try {
    const { conversation, card } = setup(temp, 1, undefined, 'codex');

    const runtime = runtimeFor({
      codex: scripted('codex', [
        '我按用户要求亲自完成。\n@DSH 请验证。',
        '汇总：已由我执行，DSH 验证通过。\n等待用户决定。',
      ]),
      claude: scripted('claude', ['不应被调用']),
      deepseek: scripted('deepseek', ['验证通过。\n[通过]']),
    });

    const outcome = await startCrossReview(temp.db, conversation.id, card.id, {
      runtime,
      timeoutMs: 20_000,
    }).completion;

    assert.equal(outcome.status, 'waiting_user');

    const tasks = temp.db
      .prepare('SELECT target_agent FROM agent_tasks WHERE chain_id = ? ORDER BY rowid')
      .all(card.id) as Array<{ target_agent: string }>;

    assert.deepEqual(
      tasks.map((task) => task.target_agent),
      ['codex', 'deepseek', 'codex'],
      '指定 Codex：执行 → DSH 验证 → 汇总',
    );

    const messages = board.listMessages(temp.db, card.id);
    assert.equal(messages.filter((message) => message.kind === 'assignment').length, 0);
  } finally {
    temp.cleanup();
  }
});
