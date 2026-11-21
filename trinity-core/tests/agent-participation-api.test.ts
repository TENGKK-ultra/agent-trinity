import assert from 'node:assert/strict';
import test from 'node:test';
import { createConversation } from '../src/conversations/conversation.service.ts';
import { activateBinding } from '../src/harnesses/session.service.ts';
import { createTempDatabase, startTestServer } from './helpers.ts';

async function json(
  url: string,
  init?: RequestInit,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(url, init);
  const text = await response.text();

  return {
    status: response.status,
    body: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>),
  };
}

function patch(url: string, body: unknown) {
  return json(url, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function bindingsOf(body: Record<string, unknown>) {
  return body.bindings as Array<Record<string, unknown>>;
}

test('Agent API：参与状态与当前 Agent 的切换', async () => {
  const temp = createTempDatabase();
  const conversation = createConversation(temp.db, { title: '参与 API' });
  activateBinding(temp.db, conversation.id, { harnessType: 'claude', cwd: temp.dir, model: null });
  activateBinding(temp.db, conversation.id, { harnessType: 'codex', cwd: temp.dir, model: null });

  const server = await startTestServer(temp.db);
  const base = `${server.baseUrl}/api/conversations/${conversation.id}/agent`;

  try {
    const initial = await json(base);
    assert.equal(initial.status, 200);
    assert.equal((initial.body.active_agent as string), 'codex');
    assert.ok(bindingsOf(initial.body).every((row) => row.participating === true));

    const left = await patch(base, { agent: 'codex', participating: false });
    assert.equal(left.status, 200);
    assert.equal(left.body.active_agent as string, 'claude', '当前交给剩余参与者');

    const codex = bindingsOf(left.body).find((row) => row.agent === 'codex');
    assert.equal(codex?.participating, false);
    assert.equal(codex?.active, false);

    const unbound = await patch(base, { agent: 'deepseek', participating: true });
    assert.equal(unbound.status, 404);
    assert.equal(
      (unbound.body.error as { code?: string } | undefined)?.code,
      'agent_not_bound',
    );

    const removed = await json(`${base}?agent=claude`, { method: 'DELETE' });
    assert.equal(removed.status, 200);
    assert.equal(removed.body.active_agent as string, 'codex', '解绑当前后交给剩余绑定');
  } finally {
    await server.close();
    temp.cleanup();
  }
});
