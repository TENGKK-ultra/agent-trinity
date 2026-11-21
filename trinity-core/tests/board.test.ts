import assert from 'node:assert/strict';
import test from 'node:test';
import {
  addFinding,
  boardAgent,
  boardUser,
  cancelCard,
  cardDetail,
  claimCard,
  completeCard,
  createCard,
  crossRoundLimit,
  expireLeases,
  findCard,
  listActiveCards,
  listCards,
  listEvents,
  listFindings,
  listInbox,
  listMessages,
  listOpenFindings,
  markMessageState,
  postMessage,
  recordReview,
  releaseCard,
  renewCard,
  setCrossRoundLimit,
  setFindingStatus,
  startCard,
} from '../src/board/board.service.ts';
import { createConversation } from '../src/conversations/conversation.service.ts';
import { openDatabase } from '../src/database/connection.ts';
import { activateBinding } from '../src/harnesses/session.service.ts';
import * as messageService from '../src/messages/message.service.ts';
import { createTempDatabase, type TempDatabase } from './helpers.ts';

function codeIs(expected: string) {
  return (err: unknown) => (err as { code?: string }).code === expected;
}

function fresh(temp: TempDatabase) {
  const conversation = createConversation(temp.db, { title: '白板' });

  for (const agent of ['claude', 'codex', 'deepseek'] as const) {
    activateBinding(temp.db, conversation.id, {
      harnessType: agent,
      cwd: temp.dir,
      model: null,
      makeActive: false,
    });
  }

  return {
    conversation,
    user: boardUser(temp.db, conversation.id),
    claude: boardAgent(temp.db, conversation.id, 'claude'),
  };
}

function resultMessage(temp: TempDatabase, conversationId: string): string {
  return messageService.addMessage(temp.db, conversationId, {
    content: '完成结果',
    message_type: 'agent_final',
    sender_kind: 'agent',
    sender_id: 'Claude Code',
  }).id;
}

test('白板：迁移 017 建表、默认轮数与事件只追加', () => {
  const db = openDatabase(':memory:');

  try {
    const tables = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all() as Array<{ name: string }>
    ).map((row) => row.name);

    for (const name of [
      'board_cards',
      'board_events',
      'board_messages',
      'board_findings',
      'app_settings',
    ]) {
      assert.ok(tables.includes(name), `缺少表 ${name}`);
    }

    assert.equal(crossRoundLimit(db), 5);

    const conversation = createConversation(db, { title: '内存白板' });
    const card = createCard(
      db,
      conversation.id,
      { title: '卡', goal: '目标' },
      boardUser(db, conversation.id),
    );

    assert.equal(card.cross_round_limit, 5);
    assert.equal(card.cross_round_used, 0);
    assert.equal(card.status, 'open');

    const event = db
      .prepare('SELECT id FROM board_events WHERE card_id = ? LIMIT 1')
      .get(card.id) as { id: string };

    assert.throws(
      () => db.prepare('UPDATE board_events SET actor = ? WHERE id = ?').run('x', event.id),
      /append-only/,
    );
  } finally {
    db.close();
  }
});

test('白板：认领是原子的，租约令牌不可伪造', () => {
  const temp = createTempDatabase();

  try {
    const { conversation, user } = fresh(temp);
    const card = createCard(temp.db, conversation.id, { title: '统计', goal: '统计文件数' }, user);

    const first = claimCard(temp.db, card.id, 'claude', 60_000);
    assert.ok(first.token);
    assert.equal(first.card.status, 'claimed');
    assert.equal(first.card.claimed_by, 'claude');

    assert.throws(
      () => claimCard(temp.db, card.id, 'codex', 60_000),
      codeIs('card_already_claimed'),
      '同一张卡不能有两个有效认领',
    );

    assert.throws(
      () => renewCard(temp.db, card.id, 'claude', 'wrong-token'),
      codeIs('lease_lost'),
    );

    const renewed = renewCard(temp.db, card.id, 'claude', first.token, 60_000);
    assert.ok(renewed.claim_expires_at);

    const released = releaseCard(temp.db, card.id, 'claude', first.token);
    assert.equal(released.status, 'open');
    assert.equal(released.claimed_by, null);

    const again = claimCard(temp.db, card.id, 'codex', 60_000);
    assert.equal(again.card.claimed_by, 'codex');

    const kinds = listEvents(temp.db, card.id).map((event) => event.kind);
    assert.deepEqual(kinds, ['created', 'claimed', 'renewed', 'released', 'claimed']);
  } finally {
    temp.cleanup();
  }
});

test('白板：租约到期后可被重新认领，并留下 expired 事件', async () => {
  const temp = createTempDatabase();

  try {
    const { conversation, user } = fresh(temp);
    const card = createCard(temp.db, conversation.id, { title: '过期', goal: '目标' }, user);

    claimCard(temp.db, card.id, 'claude', 20);
    await new Promise((resolve) => setTimeout(resolve, 40));

    assert.equal(expireLeases(temp.db), 1);
    assert.equal(findCard(temp.db, card.id)?.status, 'open');

    const next = claimCard(temp.db, card.id, 'codex', 60_000);
    assert.equal(next.card.claimed_by, 'codex');

    const kinds = listEvents(temp.db, card.id).map((event) => event.kind);
    assert.ok(kinds.includes('expired'));
  } finally {
    temp.cleanup();
  }
});

test('白板：完成必须带同会话的真实结果消息', () => {
  const temp = createTempDatabase();

  try {
    const { conversation, user } = fresh(temp);
    const card = createCard(temp.db, conversation.id, { title: '完成', goal: '目标' }, user);
    const claim = claimCard(temp.db, card.id, 'claude', 60_000);

    startCard(temp.db, card.id, 'claude', claim.token);

    assert.throws(
      () => completeCard(temp.db, card.id, 'claude', claim.token, 'missing-message'),
      codeIs('invalid_result_message'),
    );

    const messageId = resultMessage(temp, conversation.id);
    const done = completeCard(temp.db, card.id, 'claude', claim.token, messageId);

    assert.equal(done.status, 'done');
    assert.equal(done.result_message_id, messageId);
    assert.ok(done.closed_at);

    const kinds = listEvents(temp.db, card.id).map((event) => event.kind);
    assert.ok(kinds.includes('completed'));
  } finally {
    temp.cleanup();
  }
});

test('白板：用户指定执行者，非法值被拒绝', () => {
  const temp = createTempDatabase();

  try {
    const { conversation, user } = fresh(temp);

    const card = createCard(
      temp.db,
      conversation.id,
      { title: '指定', goal: '目标', requestedAgent: 'claude' },
      user,
    );

    assert.equal(card.requested_agent, 'claude');

    const plain = createCard(
      temp.db,
      conversation.id,
      { title: '默认', goal: '目标' },
      user,
    );
    assert.equal(plain.requested_agent, null);

    assert.throws(
      () =>
        createCard(
          temp.db,
          conversation.id,
          { title: '非法', goal: '目标', requestedAgent: 'gpt' },
          user,
        ),
      codeIs('invalid_requested_agent'),
    );
  } finally {
    temp.cleanup();
  }
});

test('白板：全局轮数滑杆 1–10，建卡时快照', () => {
  const temp = createTempDatabase();

  try {
    const { conversation, user } = fresh(temp);

    assert.equal(crossRoundLimit(temp.db), 5);

    const before = createCard(temp.db, conversation.id, { title: '旧卡', goal: '目标' }, user);

    setCrossRoundLimit(temp.db, 7);
    assert.equal(crossRoundLimit(temp.db), 7);

    const after = createCard(temp.db, conversation.id, { title: '新卡', goal: '目标' }, user);

    assert.equal(before.cross_round_limit, 5, '已建卡不随设置变化');
    assert.equal(after.cross_round_limit, 7, '新卡使用当前设置');

    assert.throws(() => setCrossRoundLimit(temp.db, 0), codeIs('invalid_cross_round_limit'));
    assert.throws(() => setCrossRoundLimit(temp.db, 11), codeIs('invalid_cross_round_limit'));
    assert.throws(
      () =>
        createCard(
          temp.db,
          conversation.id,
          { title: '越界', goal: '目标', crossRoundLimit: 12 },
          user,
        ),
      codeIs('invalid_cross_round_limit'),
    );
  } finally {
    temp.cleanup();
  }
});

test('白板：轮数只由验证者记录，到顶后不再增加', () => {
  const temp = createTempDatabase();

  try {
    const { conversation, user } = fresh(temp);
    const card = createCard(
      temp.db,
      conversation.id,
      { title: '三轮', goal: '目标', crossRoundLimit: 3 },
      user,
    );

    assert.throws(
      () => recordReview(temp.db, card.id, { passed: true, actor: { type: 'agent', id: 'codex' } }),
      codeIs('not_the_verifier'),
    );

    const first = recordReview(temp.db, card.id, {
      passed: false,
      actor: { type: 'agent', id: 'deepseek' },
    });
    assert.equal(first.reachedLimit, false);

    recordReview(temp.db, card.id, { passed: true, actor: { type: 'agent', id: 'deepseek' } });
    const third = recordReview(temp.db, card.id, {
      passed: true,
      actor: { type: 'agent', id: 'deepseek' },
    });

    assert.equal(third.reachedLimit, true);
    assert.equal(third.card.cross_round_used, 3);
    assert.equal(third.card.cross_phase, 'summary');

    const fourth = recordReview(temp.db, card.id, {
      passed: true,
      actor: { type: 'agent', id: 'deepseek' },
    });
    assert.equal(fourth.reachedLimit, true);
    assert.equal(fourth.card.cross_round_used, 3, '到顶后不再增加');

    const kinds = listEvents(temp.db, card.id).map((event) => event.kind);
    assert.ok(kinds.includes('round_limit_reached'));
  } finally {
    temp.cleanup();
  }
});

test('白板：未决问题只能由验证者标记解决', () => {
  const temp = createTempDatabase();

  try {
    const { conversation, user } = fresh(temp);
    const card = createCard(temp.db, conversation.id, { title: '问题', goal: '目标' }, user);

    const finding = addFinding(temp.db, card.id, {
      roundNo: 1,
      title: '缺少边界测试',
      detail: '空输入没有覆盖',
      raisedBy: 'deepseek',
    });

    assert.equal(finding.status, 'open');

    const addressed = setFindingStatus(temp.db, finding.id, 'addressed', 'claude');
    assert.equal(addressed.status, 'addressed');

    assert.throws(
      () => setFindingStatus(temp.db, finding.id, 'resolved', 'user'),
      codeIs('not_the_verifier'),
      '用户不能替验证者宣布解决',
    );

    const resolved = setFindingStatus(temp.db, finding.id, 'resolved', 'deepseek');
    assert.equal(resolved.status, 'resolved');
    assert.ok(resolved.resolved_at);
    assert.deepEqual(listFindings(temp.db, card.id, 'open'), []);
    assert.deepEqual(listOpenFindings(temp.db), []);
  } finally {
    temp.cleanup();
  }
});

test('白板：取消卡会把未决问题转为 wontfix', () => {
  const temp = createTempDatabase();

  try {
    const { conversation, user } = fresh(temp);
    const card = createCard(temp.db, conversation.id, { title: '取消', goal: '目标' }, user);

    addFinding(temp.db, card.id, { roundNo: 1, title: '问题', raisedBy: 'deepseek' });
    claimCard(temp.db, card.id, 'claude', 60_000);

    const cancelled = cancelCard(temp.db, card.id, '用户取消');
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(listOpenFindings(temp.db).length, 0);
    assert.equal(listFindings(temp.db, card.id)[0]?.status, 'wontfix');
  } finally {
    temp.cleanup();
  }
});

test('白板：消息幂等、收件箱有序、身份来自 Core', () => {
  const temp = createTempDatabase();

  try {
    const { conversation, user, claude } = fresh(temp);
    const card = createCard(temp.db, conversation.id, { title: '消息', goal: '目标' }, user);

    const first = postMessage(temp.db, conversation.id, claude, {
      cardId: card.id,
      kind: 'assignment',
      toAgent: 'deepseek',
      content: '请验证边界',
      requestId: 'req-1',
    });

    const replay = postMessage(temp.db, conversation.id, claude, {
      cardId: card.id,
      kind: 'assignment',
      toAgent: 'deepseek',
      content: '请验证边界',
      requestId: 'req-1',
    });

    assert.equal(replay.id, first.id, '同一 request_id 不产生第二条');

    assert.throws(
      () =>
        postMessage(temp.db, conversation.id, claude, {
          cardId: card.id,
          kind: 'assignment',
          toAgent: 'deepseek',
          content: '换了内容',
          requestId: 'req-1',
        }),
      codeIs('request_id_conflict'),
    );

    postMessage(temp.db, conversation.id, user, {
      cardId: card.id,
      kind: 'question',
      toAgent: 'deepseek',
      content: '第二个问题',
      requestId: 'req-2',
    });

    const inbox = listInbox(temp.db, conversation.id, 'deepseek');
    assert.deepEqual(
      inbox.map((row) => row.request_id),
      ['req-1', 'req-2'],
    );

    assert.equal(markMessageState(temp.db, first.id, 'delivered'), true);
    assert.equal(markMessageState(temp.db, first.id, 'consumed'), true);
    assert.equal(markMessageState(temp.db, first.id, 'consumed'), false);

    assert.equal(listMessages(temp.db, card.id).length, 2);
  } finally {
    temp.cleanup();
  }
});

test('白板：列表、详情与活动卡', () => {
  const temp = createTempDatabase();

  try {
    const { conversation, user } = fresh(temp);
    const open = createCard(temp.db, conversation.id, { title: '待认领', goal: '目标' }, user);
    const claimed = createCard(temp.db, conversation.id, { title: '进行中', goal: '目标' }, user);

    claimCard(temp.db, claimed.id, 'claude', 60_000);

    assert.deepEqual(
      listCards(temp.db, conversation.id).map((card) => card.id).sort(),
      [open.id, claimed.id].sort(),
    );
    assert.deepEqual(
      listCards(temp.db, conversation.id, 'claimed').map((card) => card.id),
      [claimed.id],
    );
    assert.ok(listActiveCards(temp.db).some((card) => card.id === claimed.id));

    const detail = cardDetail(temp.db, claimed.id);
    assert.equal(detail.card.id, claimed.id);
    assert.ok(detail.events.length >= 2);
    assert.deepEqual(detail.findings, []);
  } finally {
    temp.cleanup();
  }
});
