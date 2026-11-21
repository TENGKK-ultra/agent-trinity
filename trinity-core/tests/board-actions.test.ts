import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import {
  applyBoardActions,
  boardPromptSection,
  parseBoardActions,
} from '../src/board/board-actions.ts';
import {
  beginLoop,
  boardUser,
  claimCard,
  createCard,
  findCard,
  listMessages,
} from '../src/board/board.service.ts';
import { createConversation } from '../src/conversations/conversation.service.ts';
import { parseClaudeLine } from '../src/harnesses/claude.adapter.ts';
import { parseDshLine } from '../src/harnesses/dsh.adapter.ts';
import { activateBinding, findSession } from '../src/harnesses/session.service.ts';
import { sendTurn } from '../src/harnesses/turn.service.ts';
import type { HarnessAdapter } from '../src/harnesses/types.ts';
import { createTempDatabase, type TempDatabase } from './helpers.ts';

const EMIT = resolve(import.meta.dirname, 'fixtures', 'emit-group-reply.mjs');

function openCard(temp: TempDatabase, conversationId: string, title = '统计文件') {
  return createCard(
    temp.db,
    conversationId,
    {
      title,
      goal: '统计 group 目录的文件数与行数',
      acceptance: ['给出准确数字', '不修改文件'],
      requiredCapabilities: ['analysis'],
    },
    boardUser(temp.db, conversationId),
  );
}

test('白板动作：只解析单独一行、合法 JSON 的 claim / pass', () => {
  const text = [
    '我看了白板，可以处理第一张。',
    '[[board]] {"action":"claim","card_id":"card-1"}',
    '[[board]]   {"action":"pass"}  ',
  ].join('\n');

  const parsed = parseBoardActions(text);

  assert.deepEqual(parsed.errors, []);
  assert.deepEqual(parsed.actions, [
    { action: 'claim', cardId: 'card-1' },
    { action: 'pass' },
  ]);
});

test('白板动作：行内提及和坏 JSON 不会被误读', () => {
  const text = [
    '这句话里提到 [[board]] 但不在行首，不应该被解析。',
    '[[board]] 这不是 JSON',
    '[[board]] {"action":"claim"}',
    '[[board]] {"action":"delete","card_id":"x"}',
  ].join('\n');

  const parsed = parseBoardActions(text);

  assert.equal(parsed.actions.length, 0);
  assert.equal(parsed.errors.length, 3);
  assert.match(parsed.errors[0] ?? '', /不是合法 JSON/);
  assert.match(parsed.errors[1] ?? '', /缺少 card_id/);
  assert.match(parsed.errors[2] ?? '', /不支持的动作/);
});

test('白板动作：同一回复里的重复认领只保留一次', () => {
  const parsed = parseBoardActions(
    [
      '[[board]] {"action":"claim","card_id":"a"}',
      '[[board]] {"action":"claim","card_id":"a"}',
    ].join('\n'),
  );

  assert.deepEqual(parsed.actions, [{ action: 'claim', cardId: 'a' }]);
});

test('白板动作：认领生效、事件与通知落库，重复应用不产生第二条', () => {
  const temp = createTempDatabase();

  try {
    const conversation = createConversation(temp.db, { title: '认领' });
    activateBinding(temp.db, conversation.id, {
      harnessType: 'claude',
      cwd: temp.dir,
      model: null,
      makeActive: true,
    });

    const card = openCard(temp, conversation.id);
    const text = `开工。\n[[board]] {"action":"claim","card_id":"${card.id}"}`;

    const first = applyBoardActions(temp.db, conversation.id, 'claude', text, 'msg-1');

    assert.equal(first.length, 1);
    assert.equal(first[0]?.ok, true);

    const claimed = findCard(temp.db, card.id);
    assert.equal(claimed?.status, 'claimed');
    assert.equal(claimed?.claimed_by, 'claude');
    assert.ok(claimed?.claim_expires_at);

    const notices = listMessages(temp.db, card.id);
    assert.equal(notices.length, 1);
    assert.match(notices[0]?.content ?? '', /已认领「统计文件」/);

    const second = applyBoardActions(temp.db, conversation.id, 'claude', text, 'msg-1');
    assert.equal(second[0]?.detail, 'already_applied');
    assert.equal(listMessages(temp.db, card.id).length, 1);
  } finally {
    temp.cleanup();
  }
});

test('白板动作：被占用的卡给出明确失败通知，不改认领人', () => {
  const temp = createTempDatabase();

  try {
    const conversation = createConversation(temp.db, { title: '冲突' });
    const card = openCard(temp, conversation.id);

    claimCard(temp.db, card.id, 'deepseek');

    const applied = applyBoardActions(
      temp.db,
      conversation.id,
      'claude',
      `[[board]] {"action":"claim","card_id":"${card.id}"}`,
      'msg-2',
    );

    assert.equal(applied[0]?.ok, false);
    assert.equal(applied[0]?.detail, 'card_already_claimed');
    assert.equal(findCard(temp.db, card.id)?.claimed_by, 'deepseek');

    const notice = listMessages(temp.db, card.id)[0];
    assert.match(notice?.content ?? '', /已被 deepseek 认领/);
  } finally {
    temp.cleanup();
  }
});

test('白板动作：pass 记为工作区通知，有认领时不写 pass', () => {
  const temp = createTempDatabase();

  try {
    const conversation = createConversation(temp.db, { title: 'pass' });
    const card = openCard(temp, conversation.id);

    const passed = applyBoardActions(
      temp.db,
      conversation.id,
      'claude',
      '[[board]] {"action":"pass"}',
      'msg-3',
    );

    assert.equal(passed[0]?.ok, true);
    assert.equal(findCard(temp.db, card.id)?.status, 'open');

    const rows = temp.db
      .prepare(
        "SELECT card_id, content FROM board_messages WHERE conversation_id = ? AND request_id LIKE 'msg-3:%'",
      )
      .all(conversation.id) as Array<{ card_id: string | null; content: string }>;

    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.card_id, null);
    assert.match(rows[0]?.content ?? '', /本轮不认领/);

    applyBoardActions(
      temp.db,
      conversation.id,
      'claude',
      [
        '[[board]] {"action":"claim","card_id":"' + card.id + '"}',
        '[[board]] {"action":"pass"}',
      ].join('\n'),
      'msg-4',
    );

    const passes = temp.db
      .prepare("SELECT COUNT(*) AS n FROM board_messages WHERE request_id = 'msg-4:pass'")
      .get() as { n: number };

    assert.equal(passes.n, 0);
  } finally {
    temp.cleanup();
  }
});

test('白板动作：别的对话的卡不能被认领', () => {
  const temp = createTempDatabase();

  try {
    const mine = createConversation(temp.db, { title: '我的' });
    const other = createConversation(temp.db, { title: '别人的' });
    const card = openCard(temp, other.id);

    const applied = applyBoardActions(
      temp.db,
      mine.id,
      'claude',
      `[[board]] {"action":"claim","card_id":"${card.id}"}`,
      'msg-5',
    );

    assert.equal(applied[0]?.ok, false);
    assert.equal(applied[0]?.detail, 'card_not_found');
    assert.equal(findCard(temp.db, card.id)?.claimed_by, null);
  } finally {
    temp.cleanup();
  }
});

test('白板提示：只列待认领卡，说明协议，不含推荐', () => {
  const temp = createTempDatabase();

  try {
    const conversation = createConversation(temp.db, { title: '提示' });

    assert.equal(boardPromptSection(temp.db, conversation.id, 'claude'), null);

    const open = openCard(temp, conversation.id);
    const taken = openCard(temp, conversation.id, '已认领的卡');

    claimCard(temp.db, taken.id, 'deepseek');

    const section = boardPromptSection(temp.db, conversation.id, 'claude');

    assert.ok(section);
    assert.match(section, /当前工作区有 1 张待认领的卡/);
    assert.match(section, new RegExp(open.id));
    assert.match(section, /需要能力：analysis/);
    assert.match(section, /验收：给出准确数字；不修改文件/);
    assert.match(section, /\[\[board\]\] \{"action":"claim","card_id":"<卡 id>"\}/);
    assert.doesNotMatch(section, /已认领的卡/);
    assert.doesNotMatch(section, /建议由|推荐/);
  } finally {
    temp.cleanup();
  }
});

interface Captured {
  prompt: string | null;
  systemAppend: string | null;
}

function fakeAdapter(
  kind: 'claude' | 'deepseek',
  text: string,
  captured: Captured,
): HarnessAdapter {
  return {
    type: kind,
    displayName: kind === 'claude' ? 'Claude Code' : 'DeepSeek Harness',
    resolveExecutable: () => ({ file: process.execPath, source: 'test' }),
    buildCommand: (input: { prompt: string; systemAppend?: string }) => {
      captured.prompt = input.prompt;
      captured.systemAppend = input.systemAppend ?? null;

      return { file: process.execPath, args: [EMIT, kind, text], env: {} };
    },
    parseLine: kind === 'claude' ? parseClaudeLine : parseDshLine,
  } as unknown as HarnessAdapter;
}

async function waitIdle(
  temp: TempDatabase,
  conversationId: string,
  agent: 'claude' | 'deepseek',
): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    const session = findSession(temp.db, conversationId, agent);

    if (session && session.status !== 'running') return;

    await new Promise((done) => setTimeout(done, 50));
  }

  throw new Error('turn did not settle');
}

test('回合：Claude 的认领动作在真实回合结束后生效', async () => {
  const temp = createTempDatabase();

  try {
    const conversation = createConversation(temp.db, { title: '回合认领' });

    activateBinding(temp.db, conversation.id, {
      harnessType: 'claude',
      cwd: temp.dir,
      model: null,
      makeActive: true,
    });

    const card = openCard(temp, conversation.id);
    const captured: Captured = { prompt: null, systemAppend: null };
    const text = `我看过白板了。\n[[board]] {"action":"claim","card_id":"${card.id}"}`;

    sendTurn(temp.db, conversation.id, '看看白板上有什么', {
      adapter: fakeAdapter('claude', text, captured),
      timeoutMs: 20_000,
      cwd: temp.dir,
    });

    await waitIdle(temp, conversation.id, 'claude');

    assert.equal(findCard(temp.db, card.id)?.claimed_by, 'claude');
    assert.match(captured.prompt ?? '', /【白板】/);
    assert.match(captured.prompt ?? '', new RegExp(card.id));
    assert.equal(captured.systemAppend, null);
  } finally {
    temp.cleanup();
  }
});

test('回合：DSH 的白板提示放在提示词最前面', async () => {
  const temp = createTempDatabase();

  try {
    const conversation = createConversation(temp.db, { title: 'DSH 回合' });

    activateBinding(temp.db, conversation.id, {
      harnessType: 'deepseek',
      cwd: temp.dir,
      model: null,
      makeActive: true,
    });

    openCard(temp, conversation.id);

    const captured: Captured = { prompt: null, systemAppend: null };

    sendTurn(temp.db, conversation.id, '看看白板', {
      adapter: fakeAdapter('deepseek', '收到了。', captured),
      timeoutMs: 20_000,
      cwd: temp.dir,
    });

    await waitIdle(temp, conversation.id, 'deepseek');

    assert.ok((captured.prompt ?? '').startsWith('【白板】'));
    assert.equal(captured.systemAppend, null);
  } finally {
    temp.cleanup();
  }
});

test('白板：过期认领不会阻塞开始交叉验证', async () => {
  const temp = createTempDatabase();

  try {
    const conversation = createConversation(temp.db, { title: '过期' });
    const card = openCard(temp, conversation.id);

    claimCard(temp.db, card.id, 'claude', 20);
    await new Promise((done) => setTimeout(done, 40));

    const started = beginLoop(temp.db, card.id);

    assert.equal(started.status, 'running');
    assert.equal(started.claimed_by, null);
    assert.equal(started.cross_phase, 'dispatched');
  } finally {
    temp.cleanup();
  }
});

test('白板动作：认领后完成，结果成为一条真实消息', () => {
  const temp = createTempDatabase();

  try {
    const conversation = createConversation(temp.db, { title: '完成流程' });
    const card = openCard(temp, conversation.id);

    const applied = applyBoardActions(
      temp.db,
      conversation.id,
      'claude',
      [
        `[[board]] {"action":"claim","card_id":"${card.id}"}`,
        `[[board]] {"action":"complete","card_id":"${card.id}","result":"统计完成：2 个文件"}`,
      ].join('\n'),
      'msg-done',
    );

    assert.equal(applied.length, 2);
    assert.equal(applied[1]?.ok, true);

    const done = findCard(temp.db, card.id);
    assert.equal(done?.status, 'done');
    assert.ok(done?.result_message_id);

    const row = temp.db
      .prepare('SELECT content, sender_id FROM messages WHERE id = ?')
      .get(done?.result_message_id ?? '') as { content: string; sender_id: string } | undefined;

    assert.match(row?.content ?? '', /统计完成/);
    assert.equal(row?.sender_id, 'Claude Code');
  } finally {
    temp.cleanup();
  }
});

test('白板动作：续租生效，释放回到待认领，非持有者被拒', () => {
  const temp = createTempDatabase();

  try {
    const conversation = createConversation(temp.db, { title: '租约动作' });
    const card = openCard(temp, conversation.id);

    applyBoardActions(
      temp.db,
      conversation.id,
      'claude',
      `[[board]] {"action":"claim","card_id":"${card.id}"}`,
      'msg-claim',
    );

    const before = findCard(temp.db, card.id)?.claim_expires_at;

    applyBoardActions(
      temp.db,
      conversation.id,
      'claude',
      `[[board]] {"action":"renew","card_id":"${card.id}"}`,
      'msg-renew',
    );

    const after = findCard(temp.db, card.id)?.claim_expires_at;
    assert.ok(after && before && after >= before);

    // Someone else holding no lease is refused with a notice, not an exception.
    const other = applyBoardActions(
      temp.db,
      conversation.id,
      'codex',
      `[[board]] {"action":"renew","card_id":"${card.id}"}`,
      'msg-other',
    );
    assert.equal(other[0]?.ok, false);
    assert.equal(findCard(temp.db, card.id)?.claimed_by, 'claude');

    applyBoardActions(
      temp.db,
      conversation.id,
      'claude',
      `[[board]] {"action":"release","card_id":"${card.id}"}`,
      'msg-release',
    );

    assert.equal(findCard(temp.db, card.id)?.status, 'open');
    assert.equal(findCard(temp.db, card.id)?.claimed_by, null);
  } finally {
    temp.cleanup();
  }
});

test('白板动作：失败上报与给卡发消息', () => {
  const temp = createTempDatabase();

  try {
    const conversation = createConversation(temp.db, { title: '失败与发言' });

    activateBinding(temp.db, conversation.id, {
      harnessType: 'claude',
      cwd: temp.dir,
      model: null,
      makeActive: true,
    });

    const card = openCard(temp, conversation.id);

    applyBoardActions(
      temp.db,
      conversation.id,
      'claude',
      `[[board]] {"action":"claim","card_id":"${card.id}"}`,
      'msg-claim-2',
    );

    const posted = applyBoardActions(
      temp.db,
      conversation.id,
      'claude',
      `[[board]] {"action":"post","card_id":"${card.id}","content":"需要先确认口径。","kind":"question"}`,
      'msg-post',
    );
    assert.equal(posted[0]?.ok, true);

    const messages = listMessages(temp.db, card.id);
    assert.ok(messages.some((message) => message.content.includes('确认口径')));

    const failed = applyBoardActions(
      temp.db,
      conversation.id,
      'claude',
      `[[board]] {"action":"fail","card_id":"${card.id}","reason":"缺少输入文件"}`,
      'msg-fail',
    );
    assert.equal(failed[0]?.ok, true);
    assert.equal(findCard(temp.db, card.id)?.status, 'failed');
  } finally {
    temp.cleanup();
  }
});

test('白板提示：列出自己持有租约的卡，并说明全部动作', () => {
  const temp = createTempDatabase();

  try {
    const conversation = createConversation(temp.db, { title: '提示动作' });
    const card = openCard(temp, conversation.id);

    claimCard(temp.db, card.id, 'claude');

    const section = boardPromptSection(temp.db, conversation.id, 'claude');

    assert.ok(section);
    assert.match(section, /你当前持有租约的卡/);
    assert.match(section, new RegExp(card.id));
    assert.match(section, /"action":"complete"/);
    assert.match(section, /"action":"post"/);
    assert.match(section, /"action":"fail"/);
  } finally {
    temp.cleanup();
  }
});

test('白板动作：complete 缺少 result 时明确拒绝解析', () => {
  const parsed = parseBoardActions(`[[board]] {"action":"complete","card_id":"a"}`);

  assert.equal(parsed.actions.length, 0);
  assert.match(parsed.errors[0] ?? '', /缺少 result/);

  const badKind = parseBoardActions(
    `[[board]] {"action":"post","card_id":"a","content":"x","kind":"notice"}`,
  );
  assert.equal(badKind.actions.length, 0);
  assert.match(badKind.errors[0] ?? '', /kind/);
});

test('白板动作：Agent 可以自己建卡', () => {
  const temp = createTempDatabase();

  try {
    const conversation = createConversation(temp.db, { title: '自发建卡' });

    activateBinding(temp.db, conversation.id, {
      harnessType: 'claude',
      cwd: temp.dir,
      model: null,
      makeActive: true,
    });

    const applied = applyBoardActions(
      temp.db,
      conversation.id,
      'claude',
      `[[board]] {"action":"create","title":"补一个边界测试","goal":"为空输入补测试","acceptance":["覆盖空输入"]}`,
      'msg-create',
    );

    assert.equal(applied[0]?.ok, true);

    const row = temp.db
      .prepare('SELECT title, created_by, created_by_kind FROM board_cards WHERE conversation_id = ?')
      .get(conversation.id) as { title: string; created_by: string; created_by_kind: string };

    assert.equal(row.title, '补一个边界测试');
    assert.equal(row.created_by, 'claude');
    assert.equal(row.created_by_kind, 'agent');
  } finally {
    temp.cleanup();
  }
});
