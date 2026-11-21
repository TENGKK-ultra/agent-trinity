import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import { createConversation } from '../src/conversations/conversation.service.ts';
import { parseDshLine } from '../src/harnesses/dsh.adapter.ts';
import { activateBinding } from '../src/harnesses/session.service.ts';
import { startTurn } from '../src/harnesses/turn.service.ts';
import type { HarnessAdapter } from '../src/harnesses/types.ts';
import { createTempDatabase } from './helpers.ts';

const EMIT = resolve(import.meta.dirname, 'fixtures', 'emit-dsh-usage.mjs');

function dshAdapter(mode: string): HarnessAdapter {
  return {
    type: 'deepseek',
    displayName: 'DeepSeek Harness',
    resolveExecutable: () => ({ file: process.execPath, source: 'test' }),
    buildCommand: () => ({ file: process.execPath, args: [EMIT, mode], env: {} }),
    parseLine: parseDshLine,
  } as unknown as HarnessAdapter;
}

interface UsageRow {
  provider_turn: number;
  provider_step: number;
  provider_total_tokens: number | null;
  normalized_input_tokens: number | null;
  normalized_total_tokens: number | null;
  anomaly: string | null;
  counter_scope: string;
}

function usageRows(db: ReturnType<typeof createTempDatabase>['db']): UsageRow[] {
  return db
    .prepare(
      `SELECT provider_turn, provider_step, provider_total_tokens,
              normalized_input_tokens, normalized_total_tokens, anomaly, counter_scope
         FROM agent_usage
        ORDER BY rowid ASC`,
    )
    .all() as unknown as UsageRow[];
}

test('DSH 解析：step_end 带出按步 usage 与步号', () => {
  const frame = parseDshLine(
    JSON.stringify({
      type: 'status',
      phase: 'step_end',
      turn: 1,
      step: 1,
      usage: {
        inputTokens: 666,
        outputTokens: 68,
        cacheReadTokens: 5760,
        cacheWriteTokens: 0,
        totalTokens: 6494,
      },
    }),
  );

  assert.ok(frame?.usage);
  assert.equal(frame.usage.scope, 'step');
  assert.equal(frame.usage.counterScope, 'turn');
  assert.equal(frame.usage.cacheInInput, false);
  assert.equal(frame.usage.providerTurn, 1);
  assert.equal(frame.usage.providerStep, 1);
  assert.equal(frame.usage.totalTokens, 6494);
});

test('DSH 解析：缺步号时标记 identityMissing', () => {
  const frame = parseDshLine(
    JSON.stringify({
      type: 'status',
      phase: 'step_end',
      usage: { inputTokens: 10, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
    }),
  );

  assert.ok(frame?.usage);
  assert.equal(frame.usage.identityMissing, true);
  assert.equal(frame.usage.providerStep, undefined);
});

test('DSH 解析：非法数值按缺失处理', () => {
  const frame = parseDshLine(
    JSON.stringify({
      type: 'status',
      phase: 'step_end',
      turn: 1,
      step: 1,
      usage: { inputTokens: -1, outputTokens: 'x', cacheReadTokens: null },
    }),
  );

  assert.equal(frame, null, '全部无效时不产生 usage 帧');
});

test('DSH 回合：同一 turn 的多个 step 全部入账', async () => {
  const temp = createTempDatabase();

  try {
    const conversation = createConversation(temp.db, { title: '用量' });
    const { session } = activateBinding(temp.db, conversation.id, {
      harnessType: 'deepseek',
      cwd: temp.dir,
      model: null,
    });

    await startTurn(temp.db, conversation.id, session, 'hi', {
      adapter: dshAdapter('normal'),
      timeoutMs: 15_000,
      cwd: temp.dir,
    }).completion;

    const rows = usageRows(temp.db);
    assert.equal(rows.length, 2, '两个 step 都要保留');
    assert.deepEqual(rows.map((row) => row.provider_step), [1, 2]);
    assert.equal(rows[0]!.normalized_input_tokens, 100);
    assert.equal(rows[0]!.normalized_total_tokens, 135);
    assert.equal(rows[1]!.normalized_input_tokens, 200);
    assert.equal(rows[1]!.normalized_total_tokens, 220);
    assert.equal(rows[0]!.counter_scope, 'turn');
  } finally {
    temp.cleanup();
  }
});

test('DSH 回合：重放同一步只写一行', async () => {
  const temp = createTempDatabase();

  try {
    const conversation = createConversation(temp.db, { title: '用量' });
    const { session } = activateBinding(temp.db, conversation.id, {
      harnessType: 'deepseek',
      cwd: temp.dir,
      model: null,
    });

    await startTurn(temp.db, conversation.id, session, 'hi', {
      adapter: dshAdapter('duplicate'),
      timeoutMs: 15_000,
      cwd: temp.dir,
    }).completion;

    assert.equal(usageRows(temp.db).length, 1);
  } finally {
    temp.cleanup();
  }
});

test('DSH 回合：缺步号的两个 step 不被合并，并记异常', async () => {
  const temp = createTempDatabase();

  try {
    const conversation = createConversation(temp.db, { title: '用量' });
    const { session } = activateBinding(temp.db, conversation.id, {
      harnessType: 'deepseek',
      cwd: temp.dir,
      model: null,
    });

    await startTurn(temp.db, conversation.id, session, 'hi', {
      adapter: dshAdapter('no-identity'),
      timeoutMs: 15_000,
      cwd: temp.dir,
    }).completion;

    const rows = usageRows(temp.db);
    assert.equal(rows.length, 2, '没有步号也必须各自入账');
    assert.notEqual(rows[0]!.provider_step, rows[1]!.provider_step);
    assert.ok(rows.every((row) => row.provider_step < 0), '合成步号用负数，与真实步号区分');
    assert.ok(rows.every((row) => row.anomaly === 'missing_step_identity'));
    assert.equal(rows[0]!.normalized_input_tokens, 100, '异常只说明步号，数值仍归一化');
  } finally {
    temp.cleanup();
  }
});

test('DSH 回合：totalTokens 与分量不一致时以分量计算', async () => {
  const temp = createTempDatabase();

  try {
    const conversation = createConversation(temp.db, { title: '用量' });
    const { session } = activateBinding(temp.db, conversation.id, {
      harnessType: 'deepseek',
      cwd: temp.dir,
      model: null,
    });

    await startTurn(temp.db, conversation.id, session, 'hi', {
      adapter: dshAdapter('inconsistent'),
      timeoutMs: 15_000,
      cwd: temp.dir,
    }).completion;

    const row = usageRows(temp.db)[0]!;
    assert.equal(row.provider_total_tokens, 9999, 'Provider 总数原样保留');
    assert.equal(row.normalized_total_tokens, 135, '归一化总量由分量计算');
  } finally {
    temp.cleanup();
  }
});
