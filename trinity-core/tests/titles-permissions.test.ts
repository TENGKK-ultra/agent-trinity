import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import {
  createConversation,
  getConversation,
  updateConversation,
} from '../src/conversations/conversation.service.ts';
import { autoTitleAfterFirstTurn, sanitizeTitle } from '../src/conversations/title.service.ts';
import { ClaudeAdapter, parseClaudeLine } from '../src/harnesses/claude.adapter.ts';
import { activateBinding } from '../src/harnesses/session.service.ts';
import type { HarnessAdapter } from '../src/harnesses/types.ts';
import * as messageService from '../src/messages/message.service.ts';
import { createTempDatabase, startTestServer, type TempDatabase } from './helpers.ts';

const EMIT = resolve(import.meta.dirname, 'fixtures', 'emit-group-reply.mjs');

function say(temp: TempDatabase, conversationId: string, content: string): void {
  messageService.addMessage(temp.db, conversationId, {
    content,
    message_type: 'user_message',
    sender_kind: 'user',
  });
}

function fakeTitleAdapter(text: string): HarnessAdapter {
  return {
    type: 'claude',
    displayName: 'Claude Code',
    resolveExecutable: () => ({ file: process.execPath, source: 'test' }),
    buildCommand: () => ({ file: process.execPath, args: [EMIT, 'claude', text], env: {} }),
    parseLine: parseClaudeLine,
  } as unknown as HarnessAdapter;
}

test('标题：只取第一行，去掉引号与“标题：”前缀', () => {
  assert.equal(sanitizeTitle('"统计文件数量"'), '统计文件数量');
  assert.equal(sanitizeTitle('  《修复登录》 \n说明'), '修复登录');
  assert.equal(sanitizeTitle('标题：梳理迁移\n理由'), '梳理迁移');
  assert.equal(sanitizeTitle('   \n  '), null);
});

test('标题：首个指令后用 Agent 的输出命名，并记为 auto', async () => {
  const temp = createTempDatabase();

  try {
    const conversation = createConversation(temp.db, { title: '新对话 11-21' });
    say(temp, conversation.id, '统计 group 目录的文件数和行数');

    await autoTitleAfterFirstTurn(
      temp.db,
      conversation.id,
      fakeTitleAdapter('"统计文件数量"'),
      { cwd: temp.dir, model: null },
      '统计 group 目录的文件数和行数',
    );

    const updated = getConversation(temp.db, conversation.id);
    assert.equal(updated.title, '统计文件数量');
    assert.equal(updated.title_source, 'auto');
  } finally {
    temp.cleanup();
  }
});

test('标题：用户手动命名后，自动命名不再覆盖', async () => {
  const temp = createTempDatabase();

  try {
    const conversation = createConversation(temp.db, { title: '新对话' });
    updateConversation(temp.db, conversation.id, { title: '我的标题' });
    say(temp, conversation.id, '做点什么');

    let built = false;
    const adapter = {
      buildCommand: () => {
        built = true;
        throw new Error('must not run');
      },
    } as unknown as HarnessAdapter;

    await autoTitleAfterFirstTurn(temp.db, conversation.id, adapter, {
      cwd: temp.dir,
      model: null,
    }, '做点什么');

    assert.equal(built, false);
    assert.equal(getConversation(temp.db, conversation.id).title, '我的标题');
  } finally {
    temp.cleanup();
  }
});

test('权限：接口写入会话，非法值被拒绝', async () => {
  const temp = createTempDatabase();
  const server = await startTestServer(temp.db);

  try {
    const conversation = createConversation(temp.db, { title: '权限' });

    activateBinding(temp.db, conversation.id, {
      harnessType: 'claude',
      cwd: temp.dir,
      model: null,
      makeActive: true,
    });

    const response = await fetch(
      `${server.baseUrl}/api/conversations/${conversation.id}/permission`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'acceptEdits' }),
      },
    );

    assert.equal(response.status, 200);
    const state = (await response.json()) as {
      bindings: Array<{ permission_mode: string | null }>;
    };
    assert.equal(state.bindings[0]?.permission_mode, 'acceptEdits');

    const bad = await fetch(
      `${server.baseUrl}/api/conversations/${conversation.id}/permission`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'root' }),
      },
    );
    assert.equal(bad.status, 400);
  } finally {
    await server.close();
    temp.cleanup();
  }
});

test('权限：Claude 命令按会话模式携带 --permission-mode', () => {
  const dir = mkdtempSync(join(tmpdir(), 'trinity-perm-'));

  try {
    const bin = join(dir, 'claude.cmd');
    writeFileSync(bin, '');

    const adapter = new ClaudeAdapter({
      TRINITY_CLAUDE_BIN: bin,
      TRINITY_CLAUDE_AUTH_TOKEN: 'token_1234567890',
      TRINITY_CLAUDE_BASE_URL: 'https://example.invalid',
    } as NodeJS.ProcessEnv);

    const withMode = adapter.buildCommand({
      prompt: 'p',
      cwd: dir,
      nativeSessionId: null,
      model: null,
      permissionMode: 'acceptEdits',
    });

    assert.equal(withMode.args[withMode.args.indexOf('--permission-mode') + 1], 'acceptEdits');

    const without = adapter.buildCommand({
      prompt: 'p',
      cwd: dir,
      nativeSessionId: null,
      model: null,
    });

    assert.equal(without.args.includes('--permission-mode'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
