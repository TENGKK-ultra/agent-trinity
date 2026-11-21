import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import { createConversation } from '../src/conversations/conversation.service.ts';
import { activateBinding, findActiveSession } from '../src/harnesses/session.service.ts';
import { parseCodexLine } from '../src/harnesses/codex.adapter.ts';
import { startTurn } from '../src/harnesses/turn.service.ts';
import type { HarnessAdapter } from '../src/harnesses/types.ts';
import { createTempDatabase } from './helpers.ts';

const EMIT = resolve(import.meta.dirname, 'fixtures', 'emit-codex-usage.mjs');

function codexAdapter(
  input: number,
  cached: number,
  output: number,
  env: Record<string, string> = {},
): HarnessAdapter {
  return {
    type: 'codex',
    displayName: 'Codex',
    resolveExecutable: () => ({ file: process.execPath, source: 'test' }),
    buildCommand: () => ({
      file: process.execPath,
      args: [EMIT, String(input), String(cached), String(output)],
      env,
    }),
    parseLine: parseCodexLine,
  } as unknown as HarnessAdapter;
}

interface UsageRow {
  turn_id: string;
  provider_session_id: string | null;
  provider_input_tokens: number | null;
  provider_cache_read_tokens: number | null;
  normalized_input_tokens: number | null;
  normalized_total_tokens: number | null;
  anomaly: string | null;
}

function usageRows(db: ReturnType<typeof createTempDatabase>['db']): UsageRow[] {
  return db
    .prepare(
      `SELECT turn_id, provider_session_id, provider_input_tokens, provider_cache_read_tokens,
              normalized_input_tokens, normalized_total_tokens, anomaly
         FROM agent_usage
        ORDER BY rowid ASC`,
    )
    .all() as unknown as UsageRow[];
}

test('Codex 解析：turn.completed 带出线程累计 usage', () => {
  const frame = parseCodexLine(
    JSON.stringify({
      type: 'turn.completed',
      usage: {
        input_tokens: 1000,
        cached_input_tokens: 900,
        cache_write_input_tokens: 0,
        output_tokens: 20,
        reasoning_output_tokens: 3,
      },
    }),
  );

  assert.ok(frame?.usage);
  assert.equal(frame.usage.counterScope, 'thread');
  assert.equal(frame.usage.cacheInInput, true);
  assert.equal(frame.usage.inputTokens, 1000);
  assert.equal(frame.usage.cacheReadTokens, 900);
  assert.equal(frame.usage.outputTokens, 20);
  assert.equal(frame.usage.reasoningOutputTokens, 3);
});

test('Codex 回合：同线程两轮按累计差量入账', async () => {
  const temp = createTempDatabase();

  try {
    const conversation = createConversation(temp.db, { title: '用量' });
    const { session } = activateBinding(temp.db, conversation.id, {
      harnessType: 'codex',
      cwd: temp.dir,
      model: null,
    });

    await startTurn(temp.db, conversation.id, session, 'one', {
      adapter: codexAdapter(1000, 900, 20),
      timeoutMs: 15_000,
      cwd: temp.dir,
    }).completion;

    const resumed = findActiveSession(temp.db, conversation.id);
    assert.ok(resumed);

    await startTurn(temp.db, conversation.id, resumed, 'two', {
      adapter: codexAdapter(2000, 1800, 30),
      timeoutMs: 15_000,
      cwd: temp.dir,
    }).completion;

    const rows = usageRows(temp.db);
    assert.equal(rows.length, 2);

    assert.equal(rows[0]!.provider_session_id, 'thread-test');
    assert.equal(rows[0]!.provider_input_tokens, 1000);
    assert.equal(rows[0]!.normalized_input_tokens, 100);
    assert.equal(rows[0]!.normalized_total_tokens, 1020);

    assert.equal(rows[1]!.provider_session_id, 'thread-test');
    assert.equal(rows[1]!.provider_input_tokens, 2000, '原始仍是线程累计');
    assert.equal(rows[1]!.normalized_input_tokens, 100, '本轮非缓存输入');
    assert.equal(rows[1]!.normalized_total_tokens, 1010);
    assert.notEqual(rows[0]!.turn_id, rows[1]!.turn_id);
  } finally {
    temp.cleanup();
  }
});

test('Codex 回合：同一 turn.completed 重放只写一行', async () => {
  const temp = createTempDatabase();

  try {
    const conversation = createConversation(temp.db, { title: '用量' });
    const { session } = activateBinding(temp.db, conversation.id, {
      harnessType: 'codex',
      cwd: temp.dir,
      model: null,
    });

    await startTurn(temp.db, conversation.id, session, 'one', {
      adapter: codexAdapter(1000, 900, 20, { PROBE_DUPLICATE: '1' }),
      timeoutMs: 15_000,
      cwd: temp.dir,
    }).completion;

    assert.equal(usageRows(temp.db).length, 1);
  } finally {
    temp.cleanup();
  }
});

test('Codex 回合：拿不到线程 id 时记异常，不把累计值当首轮', async () => {
  const temp = createTempDatabase();

  try {
    const conversation = createConversation(temp.db, { title: '用量' });
    const { session } = activateBinding(temp.db, conversation.id, {
      harnessType: 'codex',
      cwd: temp.dir,
      model: null,
    });

    await startTurn(temp.db, conversation.id, session, 'one', {
      adapter: codexAdapter(1000, 900, 20, { PROBE_NO_THREAD: '1' }),
      timeoutMs: 15_000,
      cwd: temp.dir,
    }).completion;

    const rows = usageRows(temp.db);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.provider_session_id, null);
    assert.equal(rows[0]!.anomaly, 'missing_session_for_thread_counter');
    assert.equal(rows[0]!.normalized_input_tokens, null);
    assert.equal(rows[0]!.normalized_total_tokens, null);
  } finally {
    temp.cleanup();
  }
});
