import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  advanceLastReadAt,
  buildSharedHistory,
  compareCursors,
  cursorOf,
  encodeCursor,
  parseCursor,
} from '../src/harnesses/context.service.ts';
import { findSession } from '../src/harnesses/session.service.ts';
import { activateBinding } from '../src/harnesses/session.service.ts';
import { createConversation } from '../src/conversations/conversation.service.ts';
import { createTempDatabase, type TempDatabase } from './helpers.ts';

function fixture() {
  const temp = createTempDatabase();
  const conversation = createConversation(temp.db, { title: '共享记录' });

  for (const agent of ['claude', 'codex'] as const) {
    activateBinding(temp.db, conversation.id, {
      harnessType: agent,
      cwd: temp.dir,
      model: null,
    });
  }

  return { temp, conversationId: conversation.id };
}

function insertMessage(
  temp: TempDatabase,
  conversationId: string,
  input: {
    id?: string;
    createdAt: string;
    senderKind?: 'user' | 'agent' | 'system';
    senderId?: string | null;
    messageType?: string;
    content: string;
  },
): { id: string; created_at: string } {
  const id = input.id ?? randomUUID();
  const senderKind = input.senderKind ?? 'agent';
  const messageType =
    input.messageType ??
    (senderKind === 'user' ? 'user_message' : senderKind === 'system' ? 'system_event' : 'agent_final');

  temp.db
    .prepare(
      `INSERT INTO messages
         (id, conversation_id, sender_kind, sender_id, message_type, content, metadata_json,
          parent_message_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?)`,
    )
    .run(id, conversationId, senderKind, input.senderId ?? null, messageType, input.content, input.createdAt);

  return { id, created_at: input.createdAt };
}

function setCursor(
  temp: TempDatabase,
  conversationId: string,
  agent: 'claude' | 'codex',
  cursor: { created_at: string; id: string },
): void {
  const session = findSession(temp.db, conversationId, agent);

  assert.ok(session);
  assert.equal(advanceLastReadAt(temp.db, session.id, encodeCursor(cursorOf(cursor))), true);
}

test('游标：编码、解析与同毫秒比较', () => {
  const cursor = { createdAt: '2026-11-20T10:00:00.000Z', id: 'msg-1' };

  assert.deepEqual(parseCursor(encodeCursor(cursor)), cursor);
  assert.equal(parseCursor('not-a-cursor'), null);
  assert.equal(parseCursor(''), null);
  assert.equal(parseCursor(null), null);

  const sameTimeEarlier = { createdAt: cursor.createdAt, id: 'msg-0' };
  assert.equal(compareCursors(sameTimeEarlier, cursor), -1);
  assert.equal(compareCursors(cursor, sameTimeEarlier), 1);
  assert.equal(compareCursors(cursor, cursor), 0);
});

test('共享记录：只包含游标之后、当前输入之前的外部对话', () => {
  const { temp, conversationId } = fixture();

  try {
    const oldUser = insertMessage(temp, conversationId, {
      createdAt: '2026-11-20T10:00:00.000Z',
      senderKind: 'user',
      content: '旧用户消息',
    });
    insertMessage(temp, conversationId, {
      createdAt: '2026-11-20T10:00:01.000Z',
      senderId: 'Claude Code',
      content: 'Claude 自己的旧回复',
    });
    insertMessage(temp, conversationId, {
      createdAt: '2026-11-20T10:00:02.000Z',
      senderId: 'Codex',
      content: 'Codex 的结论',
    });
    insertMessage(temp, conversationId, {
      createdAt: '2026-11-20T10:00:03.000Z',
      senderId: 'Codex',
      messageType: 'tool_call',
      content: 'Read a file',
    });
    const currentInput = insertMessage(temp, conversationId, {
      createdAt: '2026-11-20T10:00:04.000Z',
      senderKind: 'user',
      content: '当前用户输入',
    });
    insertMessage(temp, conversationId, {
      createdAt: '2026-11-20T10:00:05.000Z',
      senderKind: 'system',
      content: '系统事件',
    });

    setCursor(temp, conversationId, 'claude', oldUser);

    const history = buildSharedHistory(
      temp.db,
      conversationId,
      'claude',
      cursorOf(currentInput),
    );

    assert.match(history, /Codex 的结论/);
    assert.doesNotMatch(history, /旧用户消息/);
    assert.doesNotMatch(history, /Claude 自己的旧回复/);
    assert.doesNotMatch(history, /当前用户输入/);
    assert.doesNotMatch(history, /Read a file/);
    assert.doesNotMatch(history, /系统事件/);
  } finally {
    temp.cleanup();
  }
});

test('共享记录：同毫秒消息按 ID 精确切分，不漏也不重', () => {
  const { temp, conversationId } = fixture();

  try {
    const sameTime = '2026-11-20T10:00:00.000Z';
    const first = insertMessage(temp, conversationId, {
      id: 'msg-a',
      createdAt: sameTime,
      senderId: 'Codex',
      content: '同毫秒第一条',
    });
    insertMessage(temp, conversationId, {
      id: 'msg-b',
      createdAt: sameTime,
      senderId: 'Codex',
      content: '同毫秒第二条',
    });

    setCursor(temp, conversationId, 'claude', first);

    const history = buildSharedHistory(temp.db, conversationId, 'claude', null);

    assert.match(history, /同毫秒第二条/);
    assert.doesNotMatch(history, /同毫秒第一条/);
  } finally {
    temp.cleanup();
  }
});

test('共享记录：最多 20 条且每条最多 600 字', () => {
  const { temp, conversationId } = fixture();

  try {
    for (let index = 0; index < 25; index += 1) {
      insertMessage(temp, conversationId, {
        createdAt: `2026-11-20T10:00:${String(index).padStart(2, '0')}.000Z`,
        senderId: 'Codex',
        content: `第 ${index} 条`,
      });
    }

    insertMessage(temp, conversationId, {
      createdAt: '2026-11-20T10:01:00.000Z',
      senderId: 'Codex',
      content: 'x'.repeat(700),
    });

    const history = buildSharedHistory(temp.db, conversationId, 'claude', null);
    const lines = history.split('\n').filter((line) => line.startsWith('Codex：'));

    assert.equal(lines.length, 20);
    assert.match(history, /第 24 条/, '保留最新的记录');
    assert.doesNotMatch(history, /第 0 条/, '超出上限的旧记录本轮不注入');

    const longLine = lines.find((line) => line.includes('x'.repeat(20)));
    assert.ok(longLine);
    assert.equal(longLine.length, 'Codex：'.length + 600 + 1, '600 字后加省略号');
    assert.ok(longLine.endsWith('…'));
  } finally {
    temp.cleanup();
  }
});

test('游标：推进后不重复，且只前进不后退', () => {
  const { temp, conversationId } = fixture();

  try {
    const first = insertMessage(temp, conversationId, {
      createdAt: '2026-11-20T10:00:00.000Z',
      senderId: 'Codex',
      content: '第一条',
    });
    const second = insertMessage(temp, conversationId, {
      createdAt: '2026-11-20T10:00:01.000Z',
      senderId: 'Codex',
      content: '第二条',
    });

    const session = findSession(temp.db, conversationId, 'claude');
    assert.ok(session);

    assert.equal(advanceLastReadAt(temp.db, session.id, encodeCursor(cursorOf(second))), true);
    assert.equal(
      advanceLastReadAt(temp.db, session.id, encodeCursor(cursorOf(first))),
      false,
      '旧位置不能覆盖新位置',
    );

    const history = buildSharedHistory(temp.db, conversationId, 'claude', null);
    assert.doesNotMatch(history, /第一条/);
    assert.doesNotMatch(history, /第二条/);
  } finally {
    temp.cleanup();
  }
});

test('游标：两个 Agent 互不影响', () => {
  const { temp, conversationId } = fixture();

  try {
    const message = insertMessage(temp, conversationId, {
      createdAt: '2026-11-20T10:00:00.000Z',
      senderKind: 'user',
      content: '一条记录',
    });

    setCursor(temp, conversationId, 'claude', message);

    const claude = findSession(temp.db, conversationId, 'claude');
    const codex = findSession(temp.db, conversationId, 'codex');

    assert.ok(claude && codex);
    assert.notEqual(claude.last_read_at, null);
    assert.equal(codex.last_read_at, null);

    assert.equal(buildSharedHistory(temp.db, conversationId, 'claude', null), '');
    const history = buildSharedHistory(temp.db, conversationId, 'codex', null);
    assert.match(history, /一条记录/);
  } finally {
    temp.cleanup();
  }
});
