import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import { createConversation } from '../src/conversations/conversation.service.ts';
import { parseClaudeLine } from '../src/harnesses/claude.adapter.ts';
import { activateBinding } from '../src/harnesses/session.service.ts';
import { startTurn } from '../src/harnesses/turn.service.ts';
import type { HarnessAdapter } from '../src/harnesses/types.ts';
import { createTempDatabase } from './helpers.ts';

const EMIT = resolve(import.meta.dirname, 'fixtures', 'emit-claude-usage.mjs');

function claudeAdapter(
  input: number,
  output: number,
  cacheRead: number,
  cacheWrite: number,
  cost: number,
): HarnessAdapter {
  return {
    type: 'claude',
    displayName: 'Claude Code',
    resolveExecutable: () => ({ file: process.execPath, source: 'test' }),
    buildCommand: () => ({
      file: process.execPath,
      args: [
        EMIT,
        String(input),
        String(output),
        String(cacheRead),
        String(cacheWrite),
        String(cost),
      ],
      env: {},
    }),
    parseLine: parseClaudeLine,
  } as unknown as HarnessAdapter;
}

function resultLine(usage: unknown, cost?: number): string {
  return JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'ok',
    session_id: 'claude-session-test',
    ...(cost === undefined ? {} : { total_cost_usd: cost }),
    usage,
    modelUsage: { 'claude-test': { input_tokens: 999, output_tokens: 999 } },
  });
}

test('Claude 解析：result.usage 与成本，modelUsage 不参与', () => {
  const frame = parseClaudeLine(
    resultLine(
      {
        input_tokens: 100,
        output_tokens: 10,
        cache_read_input_tokens: 20,
        cache_creation_input_tokens: 5,
        output_tokens_details: { thinking_tokens: 4 },
      },
      0.0123,
    ),
  );

  assert.ok(frame?.usage);
  assert.equal(frame.usage.counterScope, 'turn');
  assert.equal(frame.usage.cacheInInput, false);
  assert.equal(frame.usage.inputTokens, 100, '只能取顶层 usage，不能叠加 modelUsage');
  assert.equal(frame.usage.outputTokens, 10);
  assert.equal(frame.usage.cacheReadTokens, 20);
  assert.equal(frame.usage.cacheWriteTokens, 5);
  assert.equal(frame.usage.reasoningOutputTokens, 4);
  assert.equal(frame.usage.costUsd, 0.0123);
});

test('Claude 解析：缺失字段保持 NULL', () => {
  const frame = parseClaudeLine(resultLine({ input_tokens: 100 }));

  assert.ok(frame?.usage);
  assert.equal(frame.usage.inputTokens, 100);
  assert.equal(frame.usage.outputTokens, null);
  assert.equal(frame.usage.cacheReadTokens, null);
  assert.equal(frame.usage.cacheWriteTokens, null);
  assert.equal(frame.usage.reasoningOutputTokens, null);
  assert.equal(frame.usage.costUsd, null);
});

test('Claude 解析：负数与非数字按缺失处理', () => {
  const frame = parseClaudeLine(
    resultLine({ input_tokens: -5, output_tokens: 'many', cache_read_input_tokens: null }),
  );

  assert.equal(frame?.usage, undefined, '全部无效时不产生 usage 帧');
});

test('Claude 解析：只有成本时也记录成本', () => {
  const frame = parseClaudeLine(resultLine({}, 0.5));

  assert.ok(frame?.usage);
  assert.equal(frame.usage.costUsd, 0.5);
  assert.equal(frame.usage.inputTokens, null);
});

test('Claude 回合：按 turn 口径入账，两轮之间不做差量', async () => {
  const temp = createTempDatabase();

  try {
    const conversation = createConversation(temp.db, { title: '用量' });
    const { session } = activateBinding(temp.db, conversation.id, {
      harnessType: 'claude',
      cwd: temp.dir,
      model: null,
    });

    await startTurn(temp.db, conversation.id, session, 'one', {
      adapter: claudeAdapter(100, 10, 20, 5, 0.0123),
      timeoutMs: 15_000,
      cwd: temp.dir,
    }).completion;

    const rows = temp.db
      .prepare(
        `SELECT provider_input_tokens, provider_cache_read_tokens,
                provider_reasoning_output_tokens, provider_cost_usd,
                cache_in_input, counter_scope,
                normalized_input_tokens, normalized_total_tokens, anomaly
           FROM agent_usage
          ORDER BY rowid ASC`,
      )
      .all() as Array<Record<string, unknown>>;

    assert.equal(rows.length, 1);
    const row = rows[0]!;
    assert.equal(row.cache_in_input, 0);
    assert.equal(row.counter_scope, 'turn');
    assert.equal(row.normalized_input_tokens, 100, 'Claude 的输入不含缓存');
    assert.equal(row.normalized_total_tokens, 135);
    assert.equal(row.provider_cost_usd, 0.0123);
    assert.equal(row.provider_reasoning_output_tokens, 4);
    assert.equal(row.anomaly, null);
  } finally {
    temp.cleanup();
  }
});
