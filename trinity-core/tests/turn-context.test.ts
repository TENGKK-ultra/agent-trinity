import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import test from 'node:test';
import { createConversation } from '../src/conversations/conversation.service.ts';
import { parseCursor } from '../src/harnesses/context.service.ts';
import { parseClaudeLine } from '../src/harnesses/claude.adapter.ts';
import { parseCodexLine } from '../src/harnesses/codex.adapter.ts';
import type { CoreRuntime } from '../src/harnesses/runtime.ts';
import { activateBinding, findSession } from '../src/harnesses/session.service.ts';
import { sendTurn } from '../src/harnesses/turn.service.ts';
import type { HarnessAdapter } from '../src/harnesses/types.ts';
import { startGroupTurn } from '../src/group/group.service.ts';
import { createTempDatabase, type TempDatabase } from './helpers.ts';

const EMIT = resolve(import.meta.dirname, 'fixtures', 'emit-group-reply.mjs');

function recordingAdapter(
  kind: 'claude' | 'codex',
  text: string,
  sink: string[],
): HarnessAdapter {
  return {
    type: kind,
    displayName: kind === 'claude' ? 'Claude Code' : 'Codex',
    resolveExecutable: () => ({ file: process.execPath, source: 'test' }),
    buildCommand: (input: { prompt: string }) => {
      sink.push(input.prompt);
      return { file: process.execPath, args: [EMIT, kind, text], env: {} };
    },
    parseLine: kind === 'claude' ? parseClaudeLine : parseCodexLine,
  } as unknown as HarnessAdapter;
}

function runtimeFor(adapters: Partial<Record<'claude' | 'codex', HarnessAdapter>>): CoreRuntime {
  return {
    getAdapter: (type) => {
      const adapter = adapters[type as 'claude' | 'codex'];
      if (!adapter) throw new Error(`no adapter for ${type}`);
      return adapter;
    },
  };
}

function insertMessage(
  temp: TempDatabase,
  conversationId: string,
  input: {
    createdAt: string;
    senderKind?: 'user' | 'agent';
    senderId?: string | null;
    content: string;
  },
): { id: string; created_at: string } {
  const id = randomUUID();
  temp.db
    .prepare(
      `INSERT INTO messages
         (id, conversation_id, sender_kind, sender_id, message_type, content, metadata_json,
          parent_message_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?)`,
    )
    .run(
      id,
      conversationId,
      input.senderKind ?? 'agent',
      input.senderId ?? null,
      input.senderKind === 'user' ? 'user_message' : 'agent_final',
      input.content,
      input.createdAt,
    );

  return { id, created_at: input.createdAt };
}

async function waitIdle(
  temp: TempDatabase,
  conversationId: string,
  agent: 'claude' | 'codex',
): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    const session = findSession(temp.db, conversationId, agent);
    if (session && session.status !== 'running') return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }

  throw new Error('turn did not settle');
}

async function waitCursor(
  temp: TempDatabase,
  conversationId: string,
  agent: 'claude' | 'codex',
): Promise<string | null> {
  for (let i = 0; i < 40; i += 1) {
    const session = findSession(temp.db, conversationId, agent);
    if (session && session.last_read_at !== null) return session.last_read_at;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }

  return null;
}

test('普通回合：带上未参与时的共享记录，完成后游标停在本次输入', async () => {
  const temp = createTempDatabase();
  const conversation = createConversation(temp.db, { title: '共享上下文' });
  const sink: string[] = [];

  try {
    activateBinding(temp.db, conversation.id, { harnessType: 'claude', cwd: temp.dir, model: null });
    activateBinding(temp.db, conversation.id, { harnessType: 'codex', cwd: temp.dir, model: null });
    activateBinding(temp.db, conversation.id, { harnessType: 'claude', cwd: temp.dir, model: null });

    insertMessage(temp, conversation.id, {
      createdAt: '2026-11-20T10:00:00.000Z',
      senderKind: 'user',
      content: '项目目标',
    });
    insertMessage(temp, conversation.id, {
      createdAt: '2026-11-20T10:00:01.000Z',
      senderId: 'Claude Code',
      content: 'Claude 的旧回复',
    });
    insertMessage(temp, conversation.id, {
      createdAt: '2026-11-20T10:00:02.000Z',
      senderId: 'Codex',
      content: 'Codex 的结论',
    });

    const runtime = runtimeFor({ claude: recordingAdapter('claude', '收到', sink) });

    sendTurn(temp.db, conversation.id, '第一轮问题', {
      adapter: runtime.getAdapter('claude'),
      timeoutMs: 15_000,
      cwd: temp.dir,
    });

    await waitIdle(temp, conversation.id, 'claude');

    assert.equal(sink.length, 1);
    assert.match(sink[0]!, /Codex 的结论/);
    assert.match(sink[0]!, /项目目标/);
    assert.doesNotMatch(sink[0]!, /Claude 的旧回复/);
    assert.match(sink[0]!, /第一轮问题$/);

    const cursor = await waitCursor(temp, conversation.id, 'claude');
    assert.ok(cursor, '完成后游标应前进');
    assert.ok(parseCursor(cursor) !== null);

    const userMessage = temp.db
      .prepare("SELECT id, created_at FROM messages WHERE content = '第一轮问题'")
      .get() as { id: string; created_at: string };
    assert.equal(cursor, `${userMessage.created_at}|${userMessage.id}`);

    sink.length = 0;
    sendTurn(temp.db, conversation.id, '第二轮问题', {
      adapter: runtime.getAdapter('claude'),
      timeoutMs: 15_000,
      cwd: temp.dir,
    });
    await waitIdle(temp, conversation.id, 'claude');

    assert.equal(sink.length, 1);
    assert.doesNotMatch(sink[0]!, /Codex 的结论/, '已经读过的记录不得重复注入');
    assert.match(sink[0]!, /第二轮问题$/);

    insertMessage(temp, conversation.id, {
      createdAt: new Date().toISOString(),
      senderId: 'Codex',
      content: 'Codex 的新结论',
    });
    // Let the next user message get a later timestamp than the new record.
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));

    sink.length = 0;
    sendTurn(temp.db, conversation.id, '第三轮问题', {
      adapter: runtime.getAdapter('claude'),
      timeoutMs: 15_000,
      cwd: temp.dir,
    });
    await waitIdle(temp, conversation.id, 'claude');

    assert.equal(sink.length, 1);
    assert.match(sink[0]!, /Codex 的新结论/, '回合之后产生的新消息必须补进来');
  } finally {
    temp.cleanup();
  }
});

test('普通回合：启动失败不推进游标，重试仍能补回记录', async () => {
  const temp = createTempDatabase();
  const conversation = createConversation(temp.db, { title: '失败游标' });

  try {
    activateBinding(temp.db, conversation.id, { harnessType: 'claude', cwd: temp.dir, model: null });

    insertMessage(temp, conversation.id, {
      createdAt: '2026-11-20T10:00:00.000Z',
      senderKind: 'user',
      content: '之前的目标',
    });

    const crashing = {
      type: 'claude',
      displayName: 'Claude Code',
      resolveExecutable: () => ({ file: process.execPath, source: 'test' }),
      buildCommand: () => ({
        file: process.execPath,
        args: [resolve(import.meta.dirname, 'fixtures', 'exit-nonzero.mjs')],
        env: {},
      }),
      parseLine: () => null,
    } as unknown as HarnessAdapter;

    sendTurn(temp.db, conversation.id, '失败的一轮', {
      adapter: crashing,
      timeoutMs: 15_000,
      cwd: temp.dir,
    });
    await waitIdle(temp, conversation.id, 'claude');

    assert.equal(
      findSession(temp.db, conversation.id, 'claude')?.last_read_at,
      null,
      '失败回合不得推进游标',
    );

    const sink: string[] = [];
    const runtime = runtimeFor({ claude: recordingAdapter('claude', '收到', sink) });

    sendTurn(temp.db, conversation.id, '重试', {
      adapter: runtime.getAdapter('claude'),
      timeoutMs: 15_000,
      cwd: temp.dir,
    });
    await waitIdle(temp, conversation.id, 'claude');

    assert.match(sink[0] ?? '', /之前的目标/);
  } finally {
    temp.cleanup();
  }
});

test('普通回合：两个 Agent 的游标互相独立', async () => {
  const temp = createTempDatabase();
  const conversation = createConversation(temp.db, { title: '独立游标' });
  const sink: string[] = [];

  try {
    activateBinding(temp.db, conversation.id, { harnessType: 'claude', cwd: temp.dir, model: null });
    activateBinding(temp.db, conversation.id, { harnessType: 'codex', cwd: temp.dir, model: null });
    activateBinding(temp.db, conversation.id, { harnessType: 'claude', cwd: temp.dir, model: null });

    const runtime = runtimeFor({ claude: recordingAdapter('claude', '收到', sink) });

    sendTurn(temp.db, conversation.id, '给 Claude 的问题', {
      adapter: runtime.getAdapter('claude'),
      timeoutMs: 15_000,
      cwd: temp.dir,
    });
    await waitIdle(temp, conversation.id, 'claude');
    await waitCursor(temp, conversation.id, 'claude');

    assert.notEqual(findSession(temp.db, conversation.id, 'claude')?.last_read_at, null);
    assert.equal(
      findSession(temp.db, conversation.id, 'codex')?.last_read_at,
      null,
      '另一个 Agent 的游标不得被覆盖',
    );
  } finally {
    temp.cleanup();
  }
});

test('群聊后再单聊：不重复注入已读过的群聊记录', async () => {
  const temp = createTempDatabase();
  const conversation = createConversation(temp.db, { title: '群聊游标' });
  const sink: string[] = [];

  try {
    activateBinding(temp.db, conversation.id, { harnessType: 'claude', cwd: temp.dir, model: null });
    activateBinding(temp.db, conversation.id, { harnessType: 'codex', cwd: temp.dir, model: null });

    insertMessage(temp, conversation.id, {
      createdAt: '2026-11-20T10:00:00.000Z',
      senderKind: 'user',
      content: '群聊之前的旧记录',
    });

    const runtime = runtimeFor({
      claude: recordingAdapter('claude', 'claude 群聊回复', sink),
      codex: recordingAdapter('codex', 'codex 群聊回复', sink),
    });

    const group = startGroupTurn(temp.db, conversation.id, '群聊消息', {
      runtime,
      targets: ['claude', 'codex'],
      timeoutMs: 15_000,
    });
    await group.completion;

    assert.notEqual(findSession(temp.db, conversation.id, 'claude')?.last_read_at, null);
    assert.notEqual(findSession(temp.db, conversation.id, 'codex')?.last_read_at, null);

    activateBinding(temp.db, conversation.id, { harnessType: 'claude', cwd: temp.dir, model: null });
    sink.length = 0;

    sendTurn(temp.db, conversation.id, '群聊后的单聊', {
      adapter: runtime.getAdapter('claude'),
      timeoutMs: 15_000,
      cwd: temp.dir,
    });
    await waitIdle(temp, conversation.id, 'claude');

    assert.equal(sink.length, 1);
    assert.doesNotMatch(sink[0]!, /群聊之前的旧记录/, '群聊快照已经读过的记录不得重复');
  } finally {
    temp.cleanup();
  }
});
