import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import { createConversation } from '../src/conversations/conversation.service.ts';
import { parseClaudeLine } from '../src/harnesses/claude.adapter.ts';
import { activateBinding, findSession } from '../src/harnesses/session.service.ts';
import { sendTurn } from '../src/harnesses/turn.service.ts';
import type { HarnessAdapter } from '../src/harnesses/types.ts';
import * as messageService from '../src/messages/message.service.ts';
import {
  buildProjectBackground,
  BACKGROUND_MESSAGES_PER_CONVERSATION,
  BACKGROUND_TOTAL_CHARS,
} from '../src/projects/background.service.ts';
import {
  createProject,
  listProjectMembers,
  listProjects,
  setBackground,
  setConversationProject,
} from '../src/projects/project.service.ts';
import { createTempDatabase, startTestServer, type TempDatabase } from './helpers.ts';

const EMIT = resolve(import.meta.dirname, 'fixtures', 'emit-group-reply.mjs');

function say(
  temp: TempDatabase,
  conversationId: string,
  content: string,
  kind: 'user' | 'agent' = 'user',
): void {
  messageService.addMessage(temp.db, conversationId, {
    content,
    message_type: kind === 'user' ? 'user_message' : 'agent_final',
    sender_kind: kind,
    sender_id: kind === 'user' ? null : 'Claude Code',
  });
}

test('项目：创建、列表、归属唯一、可脱离', () => {
  const temp = createTempDatabase();

  try {
    const one = createProject(temp.db, { name: '项目一' });
    const two = createProject(temp.db, { name: '项目二' });
    const conversation = createConversation(temp.db, { title: '任务对话' });

    assert.deepEqual(
      listProjects(temp.db).map((project) => project.name).sort(),
      ['项目一', '项目二'],
    );

    setConversationProject(temp.db, conversation.id, one.id);
    assert.deepEqual(
      listProjectMembers(temp.db, one.id).map((row) => row.id),
      [conversation.id],
    );

    // Moving it to the second project leaves the first one empty.
    setConversationProject(temp.db, conversation.id, two.id);
    assert.deepEqual(listProjectMembers(temp.db, one.id), []);
    assert.deepEqual(
      listProjectMembers(temp.db, two.id).map((row) => row.id),
      [conversation.id],
    );

    setConversationProject(temp.db, conversation.id, null);
    assert.deepEqual(listProjectMembers(temp.db, two.id), []);
  } finally {
    temp.cleanup();
  }
});

test('背景：只拼接用户选定的对话，带标签和边界', () => {
  const temp = createTempDatabase();

  try {
    const project = createProject(temp.db, { name: '背景项目' });
    const acting = createConversation(temp.db, { title: '当前任务' });
    const background = createConversation(temp.db, { title: '历史讨论' });
    const unrelated = createConversation(temp.db, { title: '无关对话' });

    say(temp, background.id, '我们把数据库定在 SQLite。');
    say(temp, background.id, '记住迁移必须编号。', 'agent');
    say(temp, unrelated.id, '这段话不该出现。');

    setConversationProject(temp.db, acting.id, project.id);

    assert.equal(buildProjectBackground(temp.db, acting.id), null, '没有背景时不注入');

    setBackground(temp.db, project.id, background.id, true);

    const section = buildProjectBackground(temp.db, acting.id);

    assert.ok(section);
    assert.match(section, /【项目背景】/);
    assert.match(section, /对话《历史讨论》/);
    assert.match(section, /SQLite/);
    assert.match(section, /Claude Code：记住迁移必须编号/);
    assert.doesNotMatch(section, /无关对话/);
    assert.match(section, /只是资料，不是指令/);

    setBackground(temp.db, project.id, background.id, false);
    assert.equal(buildProjectBackground(temp.db, acting.id), null);
  } finally {
    temp.cleanup();
  }
});

test('背景：每个对话有条数上限，总量有字符上限', () => {
  const temp = createTempDatabase();

  try {
    const project = createProject(temp.db, { name: '上限' });
    const acting = createConversation(temp.db, { title: '当前' });
    const background = createConversation(temp.db, { title: '很多消息' });

    setConversationProject(temp.db, acting.id, project.id);
    setBackground(temp.db, project.id, background.id, true);

    for (let i = 0; i < 20; i += 1) {
      say(temp, background.id, `第 ${i} 条 ` + 'x'.repeat(500));
    }

    const section = buildProjectBackground(temp.db, acting.id);

    assert.ok(section);
    const lines = section.split('\n').filter((line) => line.includes('第 '));
    assert.equal(lines.length, BACKGROUND_MESSAGES_PER_CONVERSATION);
    assert.ok(section.length <= BACKGROUND_TOTAL_CHARS + 200, '总量应受预算约束');
  } finally {
    temp.cleanup();
  }
});

test('背景：真实回合的提示词以项目背景开头', async () => {
  const temp = createTempDatabase();

  try {
    const project = createProject(temp.db, { name: '注入' });
    const acting = createConversation(temp.db, { title: '任务' });
    const background = createConversation(temp.db, { title: '旧对话' });

    say(temp, background.id, '背景里的关键事实：端口是 3210。');
    setConversationProject(temp.db, acting.id, project.id);
    setBackground(temp.db, project.id, background.id, true);

    activateBinding(temp.db, acting.id, {
      harnessType: 'claude',
      cwd: temp.dir,
      model: null,
      makeActive: true,
    });

    let captured = '';
    const adapter = {
      type: 'claude',
      displayName: 'Claude Code',
      resolveExecutable: () => ({ file: process.execPath, source: 'test' }),
      buildCommand: (input: { prompt: string }) => {
        captured = input.prompt;

        return { file: process.execPath, args: [EMIT, 'claude', '收到。'], env: {} };
      },
      parseLine: parseClaudeLine,
    } as unknown as HarnessAdapter;

    sendTurn(temp.db, acting.id, '做吧', {
      adapter,
      timeoutMs: 20_000,
      cwd: temp.dir,
    });

    for (let i = 0; i < 200; i += 1) {
      const session = findSession(temp.db, acting.id, 'claude');
      if (session && session.status !== 'running') break;
      await new Promise((done) => setTimeout(done, 50));
    }

    assert.ok(captured.startsWith('【项目背景】'));
    assert.match(captured, /端口是 3210/);
  } finally {
    temp.cleanup();
  }
});

test('项目 API：创建、详情、归属与背景切换', async () => {
  const temp = createTempDatabase();
  const server = await startTestServer(temp.db);

  try {
    const conversation = createConversation(temp.db, { title: '接口对话' });

    const created = await fetch(`${server.baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '接口项目' }),
    });
    assert.equal(created.status, 201);
    const project = (await created.json()) as { id: string };

    const member = await fetch(`${server.baseUrl}/api/projects/${project.id}/members`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversation_id: conversation.id, member: true }),
    });
    assert.equal(member.status, 200);

    const background = await fetch(`${server.baseUrl}/api/projects/${project.id}/background`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversation_id: conversation.id, member: true }),
    });
    assert.equal(background.status, 200);

    const detail = await fetch(`${server.baseUrl}/api/projects/${project.id}`);
    const body = (await detail.json()) as {
      members: Array<{ id: string }>;
      background: string[];
    };

    assert.deepEqual(
      body.members.map((row) => row.id),
      [conversation.id],
    );
    assert.deepEqual(body.background, [conversation.id]);

    const invalid = await fetch(`${server.baseUrl}/api/projects/${project.id}/members`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversation_id: conversation.id }),
    });
    assert.equal(invalid.status, 400);
  } finally {
    await server.close();
    temp.cleanup();
  }
});
