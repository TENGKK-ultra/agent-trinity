import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createConversation,
  getConversation,
  listConversations,
  updateConversation,
} from '../src/conversations/conversation.service.ts';
import { isAppError } from '../src/types/index.ts';
import { createTempDatabase } from './helpers.ts';

test('创建对话：返回独立 ID、默认 active 状态与时间戳', () => {
  const temp = createTempDatabase();

  try {
    const conversation = createConversation(temp.db, { title: '第一个对话' });

    assert.ok(conversation.id);
    assert.equal(conversation.title, '第一个对话');
    assert.equal(conversation.status, 'active');
    assert.equal(conversation.project_id, null);
    assert.ok(conversation.created_at);
    assert.ok(conversation.updated_at);
  } finally {
    temp.cleanup();
  }
});

test('创建多个对话：ID 互不相同且都能独立读取', () => {
  const temp = createTempDatabase();

  try {
    const first = createConversation(temp.db, { title: '对话 A' });
    const second = createConversation(temp.db, { title: '对话 B' });

    assert.notEqual(first.id, second.id);
    assert.equal(getConversation(temp.db, first.id).title, '对话 A');
    assert.equal(getConversation(temp.db, second.id).title, '对话 B');
  } finally {
    temp.cleanup();
  }
});

test('标题会被去除首尾空白', () => {
  const temp = createTempDatabase();

  try {
    const conversation = createConversation(temp.db, { title: '   带空白的标题   ' });
    assert.equal(conversation.title, '带空白的标题');
  } finally {
    temp.cleanup();
  }
});

test('查询不存在的对话：抛出 404 应用错误', () => {
  const temp = createTempDatabase();

  try {
    assert.throws(
      () => getConversation(temp.db, 'missing-id'),
      (err) => isAppError(err) && err.code === 'conversation_not_found' && err.status === 404,
    );
  } finally {
    temp.cleanup();
  }
});

test('更新对话标题与归档状态', () => {
  const temp = createTempDatabase();

  try {
    const created = createConversation(temp.db, { title: '旧标题' });
    const renamed = updateConversation(temp.db, created.id, { title: '新标题' });
    assert.equal(renamed.title, '新标题');

    const archived = updateConversation(temp.db, created.id, { status: 'archived' });
    assert.equal(archived.status, 'archived');
    assert.equal(getConversation(temp.db, created.id).status, 'archived');
  } finally {
    temp.cleanup();
  }
});

test('更新对话：拒绝空更新和非法字段', () => {
  const temp = createTempDatabase();

  try {
    const created = createConversation(temp.db, { title: '待更新' });

    assert.throws(
      () => updateConversation(temp.db, created.id, {}),
      (err) => isAppError(err) && err.code === 'empty_update',
    );

    assert.throws(
      () => updateConversation(temp.db, created.id, { status: 'deleted' }),
      (err) => isAppError(err) && err.code === 'invalid_status',
    );
  } finally {
    temp.cleanup();
  }
});

test('创建对话：拒绝空标题与超长标题', () => {
  const temp = createTempDatabase();

  try {
    assert.throws(
      () => createConversation(temp.db, { title: '   ' }),
      (err) => isAppError(err) && err.code === 'invalid_title',
    );

    assert.throws(
      () => createConversation(temp.db, { title: 'x'.repeat(201) }),
      (err) => isAppError(err) && err.code === 'invalid_title',
    );
  } finally {
    temp.cleanup();
  }
});

test('对话列表：按创建时间排序且支持 asc/desc', () => {
  const temp = createTempDatabase();

  try {
    const first = createConversation(temp.db, { title: '第一个' });
    const second = createConversation(temp.db, { title: '第二个' });

    const ascending = listConversations(temp.db, { sort: 'created', order: 'asc' });
    assert.deepEqual(
      ascending.items.map((item) => item.id),
      [first.id, second.id],
    );

    const descending = listConversations(temp.db, { sort: 'created', order: 'desc' });
    assert.deepEqual(
      descending.items.map((item) => item.id),
      [second.id, first.id],
    );
  } finally {
    temp.cleanup();
  }
});

test('对话列表：支持按状态和标题筛选，并返回总数', () => {
  const temp = createTempDatabase();

  try {
    const alpha = createConversation(temp.db, { title: 'Alpha 讨论' });
    createConversation(temp.db, { title: 'Beta 讨论' });
    updateConversation(temp.db, alpha.id, { status: 'archived' });

    const archived = listConversations(temp.db, { status: 'archived' });
    assert.equal(archived.total, 1);
    assert.equal(archived.items[0]?.id, alpha.id);

    const alphaOnly = listConversations(temp.db, { title: 'Alpha' });
    assert.equal(alphaOnly.total, 1);
    assert.equal(alphaOnly.items[0]?.id, alpha.id);

    const all = listConversations(temp.db, {});
    assert.equal(all.total, 2);
  } finally {
    temp.cleanup();
  }
});

test('对话列表：分页参数生效且总数不受分页影响', () => {
  const temp = createTempDatabase();

  try {
    for (let index = 0; index < 5; index += 1) {
      createConversation(temp.db, { title: `对话 ${index}` });
    }

    const page = listConversations(temp.db, { limit: 2, offset: 2, sort: 'created', order: 'asc' });

    assert.equal(page.limit, 2);
    assert.equal(page.offset, 2);
    assert.equal(page.total, 5);
    assert.equal(page.items.length, 2);
    assert.equal(page.items[0]?.title, '对话 2');
  } finally {
    temp.cleanup();
  }
});
