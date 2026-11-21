import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createConversation } from '../src/conversations/conversation.service.ts';
import { recordUsage, type RecordUsageInput } from '../src/usage/usage.service.ts';
import { createTempDatabase } from './helpers.ts';

interface UsageRow {
  provider_input_tokens: number | null;
  provider_output_tokens: number | null;
  provider_cache_read_tokens: number | null;
  normalized_input_tokens: number | null;
  normalized_total_tokens: number | null;
  anomaly: string | null;
}

function firstUsageRow(db: DatabaseSync, turnId: string): UsageRow {
  const row = db
    .prepare(
      `SELECT provider_input_tokens, provider_output_tokens, provider_cache_read_tokens,
              normalized_input_tokens, normalized_total_tokens, anomaly
         FROM agent_usage
        WHERE turn_id = ?
        ORDER BY rowid ASC
        LIMIT 1`,
    )
    .get(turnId) as UsageRow | undefined;

  assert.ok(row, `usage row for ${turnId} must exist`);
  return row;
}

function countRows(db: DatabaseSync): number {
  return (db.prepare('SELECT COUNT(*) AS total FROM agent_usage').get() as { total: number }).total;
}

test('Claude：缓存与输入并列，缺失值保持 NULL', () => {
  const temp = createTempDatabase();

  try {
    const conversation = createConversation(temp.db, { title: '用量' });

    const result = recordUsage(temp.db, {
      agent: 'claude',
      conversationId: conversation.id,
      turnId: 'turn-claude-1',
      providerSessionId: null,
      taskId: null,
      scope: 'turn',
      counterScope: 'turn',
      usage: {
        inputTokens: 100,
        outputTokens: 10,
        cacheReadTokens: 20,
        cacheWriteTokens: 5,
        cacheInInput: false,
      },
    });

    assert.equal(result.inserted, true);
    const row = firstUsageRow(temp.db, 'turn-claude-1');
    assert.equal(row.normalized_input_tokens, 100, 'Claude 的输入不含缓存，不做扣除');
    assert.equal(row.normalized_total_tokens, 135);

    recordUsage(temp.db, {
      agent: 'claude',
      conversationId: conversation.id,
      turnId: 'turn-claude-2',
      providerSessionId: null,
      taskId: null,
      scope: 'turn',
      counterScope: 'turn',
      usage: {
        inputTokens: 100,
        outputTokens: 10,
        cacheReadTokens: 20,
        cacheWriteTokens: null,
        cacheInInput: false,
      },
    });

    const second = firstUsageRow(temp.db, 'turn-claude-2');
    assert.equal(second.normalized_input_tokens, 100);
    assert.equal(second.normalized_total_tokens, null, '缺一项即未知，不得当 0 相加');
  } finally {
    temp.cleanup();
  }
});

test('Codex：缓存是输入的子集，归一化时扣除', () => {
  const temp = createTempDatabase();

  try {
    const conversation = createConversation(temp.db, { title: '用量' });

    recordUsage(temp.db, {
      agent: 'codex',
      conversationId: conversation.id,
      turnId: 'turn-codex-1',
      providerSessionId: 'thread-a',
      taskId: null,
      scope: 'turn',
      counterScope: 'thread',
      usage: {
        inputTokens: 1000,
        outputTokens: 20,
        cacheReadTokens: 900,
        cacheWriteTokens: 0,
        cacheInInput: true,
      },
    });

    const row = firstUsageRow(temp.db, 'turn-codex-1');
    assert.equal(row.provider_input_tokens, 1000, '原始累计值原样保留');
    assert.equal(row.normalized_input_tokens, 100, '非缓存输入 = 1000 − 900');
    assert.equal(row.normalized_total_tokens, 1020);
  } finally {
    temp.cleanup();
  }
});

test('Codex：同线程第二轮按差量入库', () => {
  const temp = createTempDatabase();

  try {
    const conversation = createConversation(temp.db, { title: '用量' });

    const base = {
      agent: 'codex' as const,
      conversationId: conversation.id,
      providerSessionId: 'thread-a',
      taskId: null,
      scope: 'turn' as const,
      counterScope: 'thread' as const,
    };

    recordUsage(temp.db, {
      ...base,
      turnId: 'turn-1',
      usage: {
        inputTokens: 1000,
        outputTokens: 20,
        cacheReadTokens: 900,
        cacheWriteTokens: 0,
        cacheInInput: true,
      },
    });

    recordUsage(temp.db, {
      ...base,
      turnId: 'turn-2',
      usage: {
        inputTokens: 2000,
        outputTokens: 30,
        cacheReadTokens: 1800,
        cacheWriteTokens: 0,
        cacheInInput: true,
      },
    });

    const second = firstUsageRow(temp.db, 'turn-2');
    assert.equal(second.provider_input_tokens, 2000, '原始仍是线程累计');
    assert.equal(second.normalized_input_tokens, 100, '本轮非缓存输入 = (2000−1800)');
    assert.equal(second.normalized_total_tokens, 1010, '100 + 10 + 900');
  } finally {
    temp.cleanup();
  }
});

test('Codex：不同线程不共享累计基准', () => {
  const temp = createTempDatabase();

  try {
    const conversation = createConversation(temp.db, { title: '用量' });

    const usage = {
      inputTokens: 1000,
      outputTokens: 20,
      cacheReadTokens: 900,
      cacheWriteTokens: 0,
      cacheInInput: true,
    };

    const base = {
      agent: 'codex' as const,
      conversationId: conversation.id,
      taskId: null,
      scope: 'turn' as const,
      counterScope: 'thread' as const,
    };

    recordUsage(temp.db, { ...base, turnId: 'turn-a', providerSessionId: 'thread-a', usage });
    recordUsage(temp.db, { ...base, turnId: 'turn-b', providerSessionId: 'thread-b', usage });

    const other = firstUsageRow(temp.db, 'turn-b');
    assert.equal(other.normalized_input_tokens, 100, '新线程的首轮直接采用本次值');
    assert.equal(other.normalized_total_tokens, 1020);
  } finally {
    temp.cleanup();
  }
});

test('重复事件被丢弃，且不会推进累计基准', () => {
  const temp = createTempDatabase();

  try {
    const conversation = createConversation(temp.db, { title: '用量' });

    const base = {
      agent: 'codex' as const,
      conversationId: conversation.id,
      providerSessionId: 'thread-a',
      taskId: null,
      scope: 'turn' as const,
      counterScope: 'thread' as const,
    };

    const usage = (input: number, cached: number) => ({
      inputTokens: input,
      outputTokens: 20,
      cacheReadTokens: cached,
      cacheWriteTokens: 0,
      cacheInInput: true,
    });

    recordUsage(temp.db, { ...base, turnId: 'turn-1', usage: usage(1000, 900) });
    const replay = recordUsage(temp.db, { ...base, turnId: 'turn-1', usage: usage(1000, 900) });
    assert.equal(replay.inserted, false);

    // Non-cached input grows by 100: cumulative 100 → 200 while input goes 1000 → 2000.
    recordUsage(temp.db, { ...base, turnId: 'turn-2', usage: usage(2000, 1800) });

    const second = firstUsageRow(temp.db, 'turn-2');
    assert.equal(second.normalized_input_tokens, 100, '基准仍是第一轮的 1000，没有被重放推进');
  } finally {
    temp.cleanup();
  }
});

test('计数器回退：记异常、置 NULL，但基准前进到最新值', () => {
  const temp = createTempDatabase();

  try {
    const conversation = createConversation(temp.db, { title: '用量' });

    const base = {
      agent: 'codex' as const,
      conversationId: conversation.id,
      providerSessionId: 'thread-a',
      taskId: null,
      scope: 'turn' as const,
      counterScope: 'thread' as const,
    };

    const usage = (input: number) => ({
      inputTokens: input,
      outputTokens: 10,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      cacheInInput: true,
    });

    recordUsage(temp.db, { ...base, turnId: 'turn-1', usage: usage(2000) });

    const backwards = recordUsage(temp.db, { ...base, turnId: 'turn-2', usage: usage(1500) });
    assert.equal(backwards.anomaly, 'counter_went_backwards');

    const backtracked = firstUsageRow(temp.db, 'turn-2');
    assert.equal(backtracked.normalized_input_tokens, null);
    assert.equal(backtracked.normalized_total_tokens, null);

    recordUsage(temp.db, { ...base, turnId: 'turn-3', usage: usage(2600) });

    const after = firstUsageRow(temp.db, 'turn-3');
    assert.equal(after.anomaly, null, '基准已前进到 1500，下一轮不再异常');
    assert.equal(after.normalized_input_tokens, 1100, '2600 − 1500');
  } finally {
    temp.cleanup();
  }
});

test('DSH：同一 turn 的多个 step 都保留', () => {
  const temp = createTempDatabase();

  try {
    const conversation = createConversation(temp.db, { title: '用量' });

    const base = {
      agent: 'deepseek' as const,
      conversationId: conversation.id,
      turnId: 'turn-dsh',
      providerSessionId: 'session-1',
      taskId: null,
      scope: 'step' as const,
      counterScope: 'turn' as const,
    };

    recordUsage(temp.db, {
      ...base,
      providerTurn: 1,
      providerStep: 1,
      usage: {
        inputTokens: 666,
        outputTokens: 68,
        cacheReadTokens: 5760,
        cacheWriteTokens: 0,
        cacheInInput: false,
      },
    });

    recordUsage(temp.db, {
      ...base,
      providerTurn: 1,
      providerStep: 2,
      usage: {
        inputTokens: 700,
        outputTokens: 50,
        cacheReadTokens: 100,
        cacheWriteTokens: 0,
        cacheInInput: false,
      },
    });

    assert.equal(countRows(temp.db), 2, '两个 step 不能被当成重复事件');

    const replay = recordUsage(temp.db, {
      ...base,
      providerTurn: 1,
      providerStep: 2,
      usage: {
        inputTokens: 700,
        outputTokens: 50,
        cacheReadTokens: 100,
        cacheWriteTokens: 0,
        cacheInInput: false,
      },
    });

    assert.equal(replay.inserted, false);
    assert.equal(countRows(temp.db), 2);
  } finally {
    temp.cleanup();
  }
});

test('缓存读大于输入：记异常，不产生负数', () => {
  const temp = createTempDatabase();

  try {
    const conversation = createConversation(temp.db, { title: '用量' });

    const result = recordUsage(temp.db, {
      agent: 'codex',
      conversationId: conversation.id,
      turnId: 'turn-bad',
      providerSessionId: 'thread-a',
      taskId: null,
      scope: 'turn',
      counterScope: 'thread',
      usage: {
        inputTokens: 100,
        outputTokens: 10,
        cacheReadTokens: 150,
        cacheWriteTokens: 0,
        cacheInInput: true,
      },
    });

    assert.equal(result.anomaly, 'cache_read_exceeds_input');

    const row = firstUsageRow(temp.db, 'turn-bad');
    assert.equal(row.normalized_input_tokens, null);
    assert.equal(row.normalized_total_tokens, null);
    assert.equal(row.provider_input_tokens, 100, '原始值仍然保留');
  } finally {
    temp.cleanup();
  }
});

test('reasoning 只作明细，不进入总量', () => {
  const temp = createTempDatabase();

  try {
    const conversation = createConversation(temp.db, { title: '用量' });

    recordUsage(temp.db, {
      agent: 'codex',
      conversationId: conversation.id,
      turnId: 'turn-reasoning',
      providerSessionId: 'thread-a',
      taskId: null,
      scope: 'turn',
      counterScope: 'thread',
      usage: {
        inputTokens: 100,
        outputTokens: 10,
        reasoningOutputTokens: 6,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        cacheInInput: true,
      },
    });

    const row = firstUsageRow(temp.db, 'turn-reasoning');
    assert.equal(row.normalized_total_tokens, 110, 'reasoning 是 output 的子集，不得再叠加');

    const stored = temp.db
      .prepare('SELECT provider_reasoning_output_tokens AS r FROM agent_usage WHERE turn_id = ?')
      .get('turn-reasoning') as { r: number | null };
    assert.equal(stored.r, 6, '明细单独保存');
  } finally {
    temp.cleanup();
  }
});
