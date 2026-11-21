import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createConversation,
  listConversations,
  updateConversation,
} from '../src/conversations/conversation.service.ts';
import { addMessage, listMessages } from '../src/messages/message.service.ts';
import { createTempDatabase } from './helpers.ts';

test('对话隔离：两个对话的消息互不可见', () => {
  const temp = createTempDatabase();

  try {
    const alpha = createConversation(temp.db, { title: 'Alpha' });
    const beta = createConversation(temp.db, { title: 'Beta' });

    addMessage(temp.db, alpha.id, { content: 'Alpha 的第一条' });
    addMessage(temp.db, alpha.id, { content: 'Alpha 的第二条' });
    addMessage(temp.db, beta.id, { content: 'Beta 的唯一一条' });

    const alphaMessages = listMessages(temp.db, alpha.id, {});
    const betaMessages = listMessages(temp.db, beta.id, {});

    assert.equal(alphaMessages.total, 2);
    assert.equal(betaMessages.total, 1);
    assert.equal(betaMessages.items[0]?.content, 'Beta 的唯一一条');

    for (const message of alphaMessages.items) {
      assert.equal(message.conversation_id, alpha.id);
    }
  } finally {
    temp.cleanup();
  }
});

test('对话隔离：归档一个对话不影响另一个对话', () => {
  const temp = createTempDatabase();

  try {
    const alpha = createConversation(temp.db, { title: 'Alpha' });
    const beta = createConversation(temp.db, { title: 'Beta' });

    addMessage(temp.db, beta.id, { content: 'Beta 仍在工作' });
    updateConversation(temp.db, alpha.id, { status: 'archived' });

    const active = listConversations(temp.db, { status: 'active' });
    assert.equal(active.total, 1);
    assert.equal(active.items[0]?.id, beta.id);

    const appended = addMessage(temp.db, beta.id, { content: 'Beta 可以继续写' });
    assert.equal(appended.conversation_id, beta.id);
    assert.equal(listMessages(temp.db, beta.id, {}).total, 2);
  } finally {
    temp.cleanup();
  }
});

test('对话隔离：切换对话不会串线', () => {
  const temp = createTempDatabase();

  try {
    const first = createConversation(temp.db, { title: '会话一' });
    const second = createConversation(temp.db, { title: '会话二' });

    const firstMessage = addMessage(temp.db, first.id, { content: '会话一的消息' });
    const secondMessage = addMessage(temp.db, second.id, { content: '会话二的消息' });

    assert.notEqual(firstMessage.id, secondMessage.id);

    const backToFirst = listMessages(temp.db, first.id, {});
    assert.equal(backToFirst.total, 1);
    assert.equal(backToFirst.items[0]?.id, firstMessage.id);
  } finally {
    temp.cleanup();
  }
});
