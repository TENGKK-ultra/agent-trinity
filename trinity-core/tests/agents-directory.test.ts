import assert from 'node:assert/strict';
import test from 'node:test';
import { createConversation } from '../src/conversations/conversation.service.ts';
import {
  activateBinding,
  findSession,
  listDirectory,
  setParticipating,
  setStatus,
} from '../src/harnesses/session.service.ts';
import { createTempDatabase, startTestServer } from './helpers.ts';

test('目录：统计绑定、参与、运行状态，未绑定的 Agent 也要出现', () => {
  const temp = createTempDatabase();

  try {
    const first = createConversation(temp.db, { title: '工作区一' });
    const second = createConversation(temp.db, { title: '工作区二' });

    activateBinding(temp.db, first.id, { harnessType: 'claude', cwd: 'E:/one', model: null });
    activateBinding(temp.db, first.id, {
      harnessType: 'codex',
      cwd: 'E:/one',
      model: 'gpt-5',
      makeActive: false,
    });

    activateBinding(temp.db, second.id, { harnessType: 'claude', cwd: 'E:/two', model: null });
    activateBinding(temp.db, second.id, {
      harnessType: 'codex',
      cwd: 'E:/two',
      model: null,
      makeActive: false,
    });
    setParticipating(temp.db, second.id, 'codex', false, { type: 'user' });

    const claudeOne = findSession(temp.db, first.id, 'claude');
    assert.ok(claudeOne);
    setStatus(temp.db, claudeOne.id, 'running');

    const directory = listDirectory(temp.db);
    const byAgent = new Map(directory.map((entry) => [entry.agent, entry]));

    const claude = byAgent.get('claude');
    assert.ok(claude);
    assert.equal(claude.bound_conversations, 2);
    assert.equal(claude.participating_conversations, 2);
    assert.equal(claude.active_conversations, 2, '每个工作区各有一个当前 Agent');
    assert.equal(claude.running_conversations, 1);
    assert.equal(claude.quarantined_conversations, 0);

    const codex = byAgent.get('codex');
    assert.ok(codex);
    assert.equal(codex.bound_conversations, 2);
    assert.equal(codex.participating_conversations, 1, '退出参与的工作区不算参与中');
    assert.equal(codex.active_conversations, 0);

    const deepseek = byAgent.get('deepseek');
    assert.ok(deepseek);
    assert.equal(deepseek.bound_conversations, 0);
    assert.equal(deepseek.last_seen_at, null);
  } finally {
    temp.cleanup();
  }
});

test('API：/api/agents 返回真实目录，并且只接受 GET', async () => {
  const temp = createTempDatabase();
  const server = await startTestServer(temp.db);

  try {
    const conversation = createConversation(temp.db, { title: '目录接口' });
    activateBinding(temp.db, conversation.id, {
      harnessType: 'deepseek',
      cwd: temp.dir,
      model: null,
    });

    const response = await fetch(`${server.baseUrl}/api/agents`);
    assert.equal(response.status, 200);

    const body = (await response.json()) as {
      items: Array<Record<string, unknown>>;
    };

    assert.equal(body.items.length, 3);

    const deepseek = body.items.find((item) => item.agent === 'deepseek');
    assert.ok(deepseek);
    assert.equal(deepseek.display_name, 'DeepSeek Harness');
    assert.equal(deepseek.bound_conversations, 1);
    assert.equal(deepseek.participating_conversations, 1);

    const claude = body.items.find((item) => item.agent === 'claude');
    assert.ok(claude);
    assert.equal(claude.bound_conversations, 0);

    const refused = await fetch(`${server.baseUrl}/api/agents`, { method: 'POST' });
    assert.equal(refused.status, 405);
  } finally {
    await server.close();
    temp.cleanup();
  }
});
