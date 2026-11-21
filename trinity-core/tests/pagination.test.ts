import assert from 'node:assert/strict';
import test from 'node:test';
import { createConversation } from '../src/conversations/conversation.service.ts';
import { addMessage, listMessages } from '../src/messages/message.service.ts';
import { createTempDatabase } from './helpers.ts';

test('消息分页：25 条按每页 10 条读取，无重复无遗漏', () => {
  const temp = createTempDatabase();

  try {
    const conversation = createConversation(temp.db, { title: '分页测试' });
    const insertedIds: string[] = [];

    for (let index = 0; index < 25; index += 1) {
      const message = addMessage(temp.db, conversation.id, { content: `消息 ${index}` });
      insertedIds.push(message.id);
    }

    const collected: string[] = [];

    for (let offset = 0; offset < 25; offset += 10) {
      const page = listMessages(temp.db, conversation.id, { limit: 10, offset });
      assert.equal(page.total, 25);
      collected.push(...page.items.map((item) => item.id));
    }

    assert.equal(collected.length, 25);
    assert.deepEqual(collected, insertedIds);
    assert.equal(new Set(collected).size, 25);
  } finally {
    temp.cleanup();
  }
});

test('消息分页：超出范围的 offset 返回空列表但总数正确', () => {
  const temp = createTempDatabase();

  try {
    const conversation = createConversation(temp.db, { title: '越界分页' });
    addMessage(temp.db, conversation.id, { content: '只有一条' });

    const page = listMessages(temp.db, conversation.id, { limit: 10, offset: 50 });

    assert.equal(page.items.length, 0);
    assert.equal(page.total, 1);
    assert.equal(page.offset, 50);
  } finally {
    temp.cleanup();
  }
});

test('消息分页：筛选后总数按筛选结果计算', () => {
  const temp = createTempDatabase();

  try {
    const conversation = createConversation(temp.db, { title: '筛选分页' });

    for (let index = 0; index < 6; index += 1) {
      addMessage(temp.db, conversation.id, {
        message_type: 'agent_message',
        content: `代理消息 ${index}`,
      });
    }

    addMessage(temp.db, conversation.id, { content: '用户消息' });

    const agentPage = listMessages(temp.db, conversation.id, {
      message_type: 'agent_message',
      limit: 4,
      offset: 0,
    });

    assert.equal(agentPage.total, 6);
    assert.equal(agentPage.items.length, 4);
  } finally {
    temp.cleanup();
  }
});

test('消息分页：非法分页参数被拒绝', () => {
  const temp = createTempDatabase();

  try {
    const conversation = createConversation(temp.db, { title: '非法分页' });

    assert.throws(
      () => listMessages(temp.db, conversation.id, { limit: 0 }),
      (err) => Boolean(err && (err as { code?: string }).code === 'invalid_limit'),
    );

    assert.throws(
      () => listMessages(temp.db, conversation.id, { limit: 1000 }),
      (err) => Boolean(err && (err as { code?: string }).code === 'invalid_limit'),
    );

    assert.throws(
      () => listMessages(temp.db, conversation.id, { offset: -1 }),
      (err) => Boolean(err && (err as { code?: string }).code === 'invalid_offset'),
    );
  } finally {
    temp.cleanup();
  }
});
