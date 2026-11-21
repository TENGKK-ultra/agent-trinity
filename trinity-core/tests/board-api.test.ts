import assert from 'node:assert/strict';
import test from 'node:test';
import * as board from '../src/board/board.service.ts';
import { createTempDatabase, startTestServer } from './helpers.ts';

interface Json {
  [key: string]: unknown;
}

async function json(response: Response): Promise<Json> {
  return (await response.json()) as Json;
}

test('白板 API：建卡、列表、详情、关闭与全局设置', async () => {
  const temp = createTempDatabase();
  const server = await startTestServer(temp.db);

  try {
    const conversation = await json(
      await fetch(`${server.baseUrl}/api/conversations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: '白板工作区' }),
      }),
    );
    const conversationId = String(conversation.id);

    const created = await fetch(`${server.baseUrl}/api/conversations/${conversationId}/board`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: '统计文件',
        goal: '统计 group 目录的文件数与行数',
        acceptance: ['给出准确数字', '不修改文件'],
        required_capabilities: ['analysis'],
        requested_agent: 'claude',
      }),
    });

    assert.equal(created.status, 201);
    const cardBody = (await json(created)).card as Json;
    const cardId = String(cardBody.id);

    assert.equal(cardBody.status, 'open');
    assert.equal(cardBody.requested_agent, 'claude');
    assert.equal(cardBody.cross_round_limit, 5);
    assert.equal(cardBody.cross_round_used, 0);
    assert.deepEqual(cardBody.acceptance, ['给出准确数字', '不修改文件']);

    const listed = await json(
      await fetch(`${server.baseUrl}/api/conversations/${conversationId}/board`),
    );
    assert.equal((listed.items as unknown[]).length, 1);

    const detail = await json(
      await fetch(`${server.baseUrl}/api/conversations/${conversationId}/board/${cardId}`),
    );
    assert.equal((detail.card as Json).id, cardId);
    assert.ok((detail.events as unknown[]).length >= 1);
    assert.deepEqual(detail.findings, []);

    const filtered = await fetch(
      `${server.baseUrl}/api/conversations/${conversationId}/board?status=nonsense`,
    );
    assert.equal(filtered.status, 400);

    // The global slider is 1–10 and only affects cards created afterwards.
    const settings = await json(
      await fetch(`${server.baseUrl}/api/settings/team`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cross_round_limit: 7 }),
      }),
    );
    assert.equal(settings.cross_round_limit, 7);

    const readSettings = await json(await fetch(`${server.baseUrl}/api/settings/team`));
    assert.equal(readSettings.cross_round_limit, 7);

    const next = await json(
      await fetch(`${server.baseUrl}/api/conversations/${conversationId}/board`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: '第二张', goal: '目标' }),
      }),
    );
    assert.equal((next.card as Json).cross_round_limit, 7);

    const oldDetail = await json(
      await fetch(`${server.baseUrl}/api/conversations/${conversationId}/board/${cardId}`),
    );
    assert.equal((oldDetail.card as Json).cross_round_limit, 5, '已建卡保持快照');

    const claimed = board.claimCard(temp.db, cardId, 'claude', 60_000);
    assert.ok(claimed.token);

    const status = await json(await fetch(`${server.baseUrl}/api/board/status`));
    assert.equal(status.cross_round_limit, 7);
    const active = status.active as Array<Json>;
    assert.ok(active.some((item) => item.id === cardId));

    board.addFinding(temp.db, cardId, {
      roundNo: 1,
      title: '缺少边界测试',
      raisedBy: 'deepseek',
    });

    const findings = await json(await fetch(`${server.baseUrl}/api/board/findings`));
    const items = findings.items as Array<Json>;
    assert.equal(items.length, 1);
    assert.equal(items[0]?.card_title, '统计文件');
    assert.equal(items[0]?.conversation_title, '白板工作区');

    const closed = await fetch(
      `${server.baseUrl}/api/conversations/${conversationId}/board/${cardId}/close`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: '不需要了' }),
      },
    );

    assert.equal(closed.status, 200);
    assert.equal(((await json(closed)).card as Json).status, 'cancelled');

    const afterClose = await json(await fetch(`${server.baseUrl}/api/board/findings`));
    assert.deepEqual(afterClose.items, [], '取消卡把未决问题转为 wontfix');

    const missing = await fetch(
      `${server.baseUrl}/api/conversations/does-not-exist/board`,
    );
    assert.equal(missing.status, 404);
  } finally {
    await server.close();
    temp.cleanup();
  }
});

test('白板 API：用户不能通过接口替 Agent 认领', async () => {
  const temp = createTempDatabase();
  const server = await startTestServer(temp.db);

  try {
    const conversation = await json(
      await fetch(`${server.baseUrl}/api/conversations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: '只读白板' }),
      }),
    );
    const conversationId = String(conversation.id);

    const created = await json(
      await fetch(`${server.baseUrl}/api/conversations/${conversationId}/board`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: '卡', goal: '目标' }),
      }),
    );

    const response = await fetch(
      `${server.baseUrl}/api/conversations/${conversationId}/board/${(created.card as Json).id}/claim`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
    );

    assert.equal(response.status, 404, '认领没有用户入口');
  } finally {
    await server.close();
    temp.cleanup();
  }
});
