import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { createConversation } from '../src/conversations/conversation.service.ts';
import { activateBinding } from '../src/harnesses/session.service.ts';
import { sendTurn } from '../src/harnesses/turn.service.ts';
import type { HarnessAdapter } from '../src/harnesses/types.ts';
import { createWorkspace, listWorkspaces } from '../src/workspaces/workspace.service.ts';
import { createTempDatabase, startTestServer } from './helpers.ts';

function codeIs(expected: string) {
  return (err: unknown) => (err as { code?: string }).code === expected;
}

test('工作区：新建会创建目录，并按名称列出', () => {
  const temp = createTempDatabase();

  try {
    const path = resolve(temp.dir, 'claude-ws');
    const row = createWorkspace(temp.db, { name: 'Claude 工作区', path });

    assert.equal(row.path, path);
    assert.ok(existsSync(path), '目录应当被创建');

    assert.deepEqual(
      listWorkspaces(temp.db).map((workspace) => workspace.name),
      ['Claude 工作区'],
    );
  } finally {
    temp.cleanup();
  }
});

test('工作区：绝对路径是硬要求，引擎目录不能当工作区', () => {
  const temp = createTempDatabase();

  try {
    assert.throws(
      () => createWorkspace(temp.db, { name: '相对', path: 'relative/ws' }),
      codeIs('invalid_path'),
    );

    const coreDir = resolve(import.meta.dirname, '..');
    assert.throws(
      () => createWorkspace(temp.db, { name: '引擎', path: coreDir }),
      codeIs('workspace_forbidden'),
    );
    assert.throws(
      () => createWorkspace(temp.db, { name: '引擎内', path: resolve(coreDir, 'src') }),
      codeIs('workspace_forbidden'),
    );
  } finally {
    temp.cleanup();
  }
});

test('工作区：同一个目录不能登记两次', () => {
  const temp = createTempDatabase();

  try {
    const path = resolve(temp.dir, 'dup');

    createWorkspace(temp.db, { name: '第一次', path });

    assert.throws(
      () => createWorkspace(temp.db, { name: '第二次', path }),
      codeIs('workspace_exists'),
    );
  } finally {
    temp.cleanup();
  }
});

test('工作区 API：列表与新建', async () => {
  const temp = createTempDatabase();
  const server = await startTestServer(temp.db);

  try {
    const path = resolve(temp.dir, 'dsh-ws');
    const created = await fetch(`${server.baseUrl}/api/workspaces`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'DSH 工作区', path }),
    });

    assert.equal(created.status, 201);
    const row = (await created.json()) as { name: string; path: string };
    assert.equal(row.name, 'DSH 工作区');
    assert.equal(row.path, path);

    const listed = await fetch(`${server.baseUrl}/api/workspaces`);
    assert.equal(listed.status, 200);
    assert.equal(((await listed.json()) as { items: unknown[] }).items.length, 1);

    const missing = await fetch(`${server.baseUrl}/api/workspaces`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '缺路径' }),
    });
    assert.equal(missing.status, 400);
  } finally {
    await server.close();
    temp.cleanup();
  }
});

test('回合：Agent 没有工作区时明确拒绝，不再回落到 Core 目录', () => {
  const temp = createTempDatabase();

  try {
    const conversation = createConversation(temp.db, { title: '没有工作区' });

    activateBinding(temp.db, conversation.id, {
      harnessType: 'claude',
      cwd: null,
      model: null,
      makeActive: true,
    });

    const adapter = {
      type: 'claude',
      displayName: 'Claude Code',
    } as unknown as HarnessAdapter;

    assert.throws(
      () =>
        sendTurn(temp.db, conversation.id, '你好', {
          adapter,
          timeoutMs: 1_000,
          cwd: temp.dir,
        }),
      codeIs('workspace_missing'),
    );
  } finally {
    temp.cleanup();
  }
});
