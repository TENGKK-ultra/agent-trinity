import assert from 'node:assert/strict';
import test from 'node:test';
import { createConversation } from '../src/conversations/conversation.service.ts';
import {
  activateBinding,
  findActiveSession,
  findSession,
  listBindings,
  removeBinding,
  setParticipating,
} from '../src/harnesses/session.service.ts';
import { createTempDatabase } from './helpers.ts';

function fixture() {
  const temp = createTempDatabase();
  const conversation = createConversation(temp.db, { title: '参与状态' });

  const bind = (agent: 'claude' | 'codex' | 'deepseek', makeActive = true) =>
    activateBinding(temp.db, conversation.id, {
      harnessType: agent,
      cwd: temp.dir,
      model: null,
      makeActive,
    });

  return { temp, conversationId: conversation.id, bind };
}

function activeOf(temp: ReturnType<typeof createTempDatabase>, conversationId: string) {
  return findActiveSession(temp.db, conversationId)?.harness_type ?? null;
}

test('绑定：加入但不抢占当前 Agent', () => {
  const { temp, conversationId, bind } = fixture();

  try {
    bind('claude');
    bind('codex', false);

    assert.equal(activeOf(temp, conversationId), 'claude');
    assert.equal(findSession(temp.db, conversationId, 'codex')?.participating, 1);
    assert.equal(findSession(temp.db, conversationId, 'codex')?.active, 0);
  } finally {
    temp.cleanup();
  }
});

test('绑定：当前为空时，新加入的 Agent 自动成为当前', () => {
  const { temp, conversationId, bind } = fixture();

  try {
    bind('codex', false);
    assert.equal(activeOf(temp, conversationId), 'codex');
  } finally {
    temp.cleanup();
  }
});

test('参与：当前 Agent 退出时，当前交给剩余参与者', () => {
  const { temp, conversationId, bind } = fixture();

  try {
    bind('claude');
    bind('codex', false);

    const updated = setParticipating(temp.db, conversationId, 'claude', false);

    assert.equal(updated.participating, 0);
    assert.equal(updated.active, 0);
    assert.equal(activeOf(temp, conversationId), 'codex');
    assert.equal(findSession(temp.db, conversationId, 'claude')?.participating, 0, '绑定仍然保留');
  } finally {
    temp.cleanup();
  }
});

test('参与：最后一个参与者退出时没有当前 Agent，但保持绑定', () => {
  const { temp, conversationId, bind } = fixture();

  try {
    bind('claude');
    setParticipating(temp.db, conversationId, 'claude', false);

    assert.equal(activeOf(temp, conversationId), null);
    assert.equal(listBindings(temp.db, conversationId).length, 1);

    setParticipating(temp.db, conversationId, 'claude', true);
    assert.equal(activeOf(temp, conversationId), 'claude');
  } finally {
    temp.cleanup();
  }
});

test('参与：非当前 Agent 加入不抢占当前', () => {
  const { temp, conversationId, bind } = fixture();

  try {
    bind('claude');
    bind('codex', false);

    setParticipating(temp.db, conversationId, 'codex', false);
    setParticipating(temp.db, conversationId, 'codex', true);

    assert.equal(activeOf(temp, conversationId), 'claude');
  } finally {
    temp.cleanup();
  }
});

test('解绑：当前 Agent 被解绑后，当前交给剩余绑定中的一个', () => {
  const { temp, conversationId, bind } = fixture();

  try {
    bind('claude');
    bind('codex', false);
    bind('deepseek', false);
    setParticipating(temp.db, conversationId, 'deepseek', false);

    const result = removeBinding(temp.db, conversationId, 'claude');

    assert.deepEqual(result, { removed: true, wasActive: true, promoted: 'codex' });
    assert.equal(activeOf(temp, conversationId), 'codex');
  } finally {
    temp.cleanup();
  }
});

test('解绑：非当前 Agent 不影响当前', () => {
  const { temp, conversationId, bind } = fixture();

  try {
    bind('claude');
    bind('codex', false);

    const result = removeBinding(temp.db, conversationId, 'codex');

    assert.equal(result.promoted, null);
    assert.equal(activeOf(temp, conversationId), 'claude');
  } finally {
    temp.cleanup();
  }
});

test('解绑：全部解绑后不存在没有绑定的当前 Agent', () => {
  const { temp, conversationId, bind } = fixture();

  try {
    bind('claude');
    removeBinding(temp.db, conversationId, 'claude');

    assert.equal(listBindings(temp.db, conversationId).length, 0);
    assert.equal(findActiveSession(temp.db, conversationId), undefined);
  } finally {
    temp.cleanup();
  }
});

test('参与：未绑定的 Agent 不能设置参与状态', () => {
  const { temp, conversationId } = fixture();

  try {
    assert.throws(
      () => setParticipating(temp.db, conversationId, 'claude', true),
      (err: unknown) => (err as { code?: string }).code === 'agent_not_bound',
    );
  } finally {
    temp.cleanup();
  }
});

test('参与状态：重开数据库后点亮与当前仍然正确', () => {
  const { temp, conversationId, bind } = fixture();

  try {
    bind('claude');
    bind('codex', false);
    setParticipating(temp.db, conversationId, 'claude', false);

    temp.close();

    const db = temp.reopen();
    const claude = findSession(db, conversationId, 'claude');
    const codex = findSession(db, conversationId, 'codex');

    assert.equal(claude?.participating, 0);
    assert.equal(claude?.active, 0);
    assert.equal(codex?.participating, 1);
    assert.equal(codex?.active, 1);
  } finally {
    temp.cleanup();
  }
});
