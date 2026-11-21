import assert from 'node:assert/strict';
import test from 'node:test';
import { createConversation, getConversation, updateConversation } from '../src/conversations/conversation.service.ts';
import { addMessage, listMessages } from '../src/messages/message.service.ts';
import { isAppError, MESSAGE_TYPES } from '../src/types/index.ts';
import { createTempDatabase } from './helpers.ts';

test('发送用户消息：默认类型为 user_message，发送者为 user', () => {
  const temp = createTempDatabase();

  try {
    const conversation = createConversation(temp.db, { title: '消息测试' });
    const message = addMessage(temp.db, conversation.id, { content: '  你好 Trinity  ' });

    assert.ok(message.id);
    assert.equal(message.conversation_id, conversation.id);
    assert.equal(message.message_type, 'user_message');
    assert.equal(message.sender_kind, 'user');
    assert.equal(message.content, '你好 Trinity');
    assert.ok(message.created_at);
  } finally {
    temp.cleanup();
  }
});

test('支持全部七种消息类型的持久化与默认发送者', () => {
  const temp = createTempDatabase();
  const expectedSender: Record<string, string> = {
    user_message: 'user',
    agent_message: 'agent',
    agent_final: 'agent',
    tool_call: 'agent',
    tool_result: 'agent',
    system_event: 'system',
    task_status: 'system',
  };

  try {
    const conversation = createConversation(temp.db, { title: '消息类型' });

    for (const messageType of MESSAGE_TYPES) {
      const saved = addMessage(temp.db, conversation.id, {
        message_type: messageType,
        content: `内容-${messageType}`,
      });

      assert.equal(saved.message_type, messageType);
      assert.equal(saved.sender_kind, expectedSender[messageType]);
    }

    const listed = listMessages(temp.db, conversation.id, {});
    assert.equal(listed.total, MESSAGE_TYPES.length - 3, '默认不返回内部活动消息');

    const withActivity = listMessages(temp.db, conversation.id, { include_activity: '1' });
    assert.equal(withActivity.total, MESSAGE_TYPES.length);
  } finally {
    temp.cleanup();
  }
});

test('可显式指定发送者 ID 与发送者类别', () => {
  const temp = createTempDatabase();

  try {
    const conversation = createConversation(temp.db, { title: '发送者' });
    const message = addMessage(temp.db, conversation.id, {
      message_type: 'agent_message',
      sender_kind: 'agent',
      sender_id: 'claude',
      content: '我是 Claude',
    });

    assert.equal(message.sender_kind, 'agent');
    assert.equal(message.sender_id, 'claude');
  } finally {
    temp.cleanup();
  }
});

test('工具调用与工具结果：metadata 与 parent_message_id 正确关联', () => {
  const temp = createTempDatabase();

  try {
    const conversation = createConversation(temp.db, { title: '工具事件' });

    const toolCall = addMessage(temp.db, conversation.id, {
      message_type: 'tool_call',
      content: '调用 read_file',
      metadata: { tool: 'read_file', arguments: { path: 'src/main.ts' } },
    });

    const toolResult = addMessage(temp.db, conversation.id, {
      message_type: 'tool_result',
      content: '读取成功',
      metadata: { ok: true, bytes: 120 },
      parent_message_id: toolCall.id,
    });

    assert.ok(toolCall.metadata_json);
    assert.deepEqual(JSON.parse(String(toolCall.metadata_json)), {
      tool: 'read_file',
      arguments: { path: 'src/main.ts' },
    });
    assert.equal(toolResult.parent_message_id, toolCall.id);
  } finally {
    temp.cleanup();
  }
});

test('保存消息会更新所属对话的 updated_at', () => {
  const temp = createTempDatabase();

  try {
    const conversation = createConversation(temp.db, { title: '时间戳' });
    const before = getConversation(temp.db, conversation.id).updated_at;

    addMessage(temp.db, conversation.id, { content: '触发更新' });

    const after = getConversation(temp.db, conversation.id).updated_at;
    assert.ok(after >= before);
  } finally {
    temp.cleanup();
  }
});

test('向不存在的对话发送消息：抛出 404', () => {
  const temp = createTempDatabase();

  try {
    assert.throws(
      () => addMessage(temp.db, 'missing-conversation', { content: '你好' }),
      (err) => isAppError(err) && err.code === 'conversation_not_found' && err.status === 404,
    );
  } finally {
    temp.cleanup();
  }
});

test('拒绝空内容、非法消息类型与跨对话父消息', () => {
  const temp = createTempDatabase();

  try {
    const first = createConversation(temp.db, { title: '对话一' });
    const second = createConversation(temp.db, { title: '对话二' });
    const foreignMessage = addMessage(temp.db, second.id, { content: '属于对话二' });

    assert.throws(
      () => addMessage(temp.db, first.id, { content: '   ' }),
      (err) => isAppError(err) && err.code === 'invalid_content',
    );

    assert.throws(
      () => addMessage(temp.db, first.id, { message_type: 'unknown_type', content: 'x' }),
      (err) => isAppError(err) && err.code === 'invalid_message_type',
    );

    assert.throws(
      () =>
        addMessage(temp.db, first.id, {
          content: '错误引用',
          parent_message_id: foreignMessage.id,
        }),
      (err) => isAppError(err) && err.code === 'invalid_parent_message',
    );

    assert.throws(
      () =>
        addMessage(temp.db, first.id, {
          content: '错误 metadata',
          metadata: ['not', 'an', 'object'] as unknown as Record<string, unknown>,
        }),
      (err) => isAppError(err) && err.code === 'invalid_metadata',
    );
  } finally {
    temp.cleanup();
  }
});

test('已归档对话拒绝新消息（409）', () => {
  const temp = createTempDatabase();

  try {
    const conversation = createConversation(temp.db, { title: '将归档' });
    updateConversation(temp.db, conversation.id, { status: 'archived' });

    assert.throws(
      () => addMessage(temp.db, conversation.id, { content: '归档后写入' }),
      (err) => isAppError(err) && err.code === 'conversation_archived' && err.status === 409,
    );
  } finally {
    temp.cleanup();
  }
});

test('消息历史：按插入顺序返回并支持类型筛选', () => {
  const temp = createTempDatabase();

  try {
    const conversation = createConversation(temp.db, { title: '历史顺序' });
    const first = addMessage(temp.db, conversation.id, { content: '第一条' });
    const second = addMessage(temp.db, conversation.id, {
      message_type: 'agent_message',
      content: '第二条',
    });
    const third = addMessage(temp.db, conversation.id, {
      message_type: 'system_event',
      content: '第三条',
    });

    const all = listMessages(temp.db, conversation.id, {});
    assert.deepEqual(
      all.items.map((item) => item.id),
      [first.id, second.id, third.id],
    );

    const agentOnly = listMessages(temp.db, conversation.id, { message_type: 'agent_message' });
    assert.equal(agentOnly.total, 1);
    assert.equal(agentOnly.items[0]?.id, second.id);

    const systemOnly = listMessages(temp.db, conversation.id, { sender_kind: 'system' });
    assert.equal(systemOnly.total, 1);
    assert.equal(systemOnly.items[0]?.id, third.id);
  } finally {
    temp.cleanup();
  }
});
