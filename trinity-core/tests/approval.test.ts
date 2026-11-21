import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { createConversation } from '../src/conversations/conversation.service.ts';
import { openDatabase } from '../src/database/connection.ts';
import {
  findApproval,
  listApprovals,
  cancelPendingForTurn,
  createApproval,
  sweepPendingOnStartup,
} from '../src/harnesses/approval.service.ts';
import {
  createPendingApproval,
  resolveApproval,
  resolveApprovalTimeout,
  toView,
  type ApprovalTurnContext,
} from '../src/harnesses/approval.flow.ts';
import { activateBinding } from '../src/harnesses/session.service.ts';
import { sendTurn } from '../src/harnesses/turn.service.ts';
import {
  formatClaudeApprovalDecision,
  parseClaudeLine,
} from '../src/harnesses/claude.adapter.ts';
import type {
  HarnessAdapter,
  HarnessApprovalDecision,
  HarnessApprovalRequest,
  HarnessCommand,
  HarnessStreamFrame,
  HarnessTurnInput,
} from '../src/harnesses/types.ts';
import type { DatabaseSync } from 'node:sqlite';
import { createTempDatabase, type TempDatabase } from './helpers.ts';

const FIXTURES = resolve(import.meta.dirname, 'fixtures');
const APPROVAL_SCRIPT = join(FIXTURES, 'emit-approval.mjs');

const REQUEST: HarnessApprovalRequest = {
  requestId: 'req-1',
  kind: 'tool_approval',
  toolName: 'Write',
  toolUseId: 'tu-1',
  input: { file_path: 'probe.txt', content: 'hello' },
  description: 'probe.txt',
};

class ApprovalScriptAdapter implements HarnessAdapter {
  readonly type = 'claude' as const;
  readonly displayName = 'Claude Code';
  readonly inputs: HarnessTurnInput[] = [];

  private readonly script: string;

  constructor(script: string) {
    this.script = script;
  }

  resolveExecutable(): { file: string; source: string } {
    return { file: process.execPath, source: 'test' };
  }

  buildCommand(input: HarnessTurnInput): HarnessCommand {
    this.inputs.push(input);

    return {
      file: process.execPath,
      args: [this.script],
      env: {},
      stdin: 'pipe',
      initialInput: [
        JSON.stringify({
          type: 'user',
          message: { role: 'user', content: input.prompt },
          parent_tool_use_id: null,
        }),
      ],
    };
  }

  parseLine(line: string): HarnessStreamFrame | null {
    return parseClaudeLine(line);
  }

  formatApprovalDecision(
    request: HarnessApprovalRequest,
    decision: HarnessApprovalDecision,
  ): string {
    return formatClaudeApprovalDecision(request, decision);
  }
}

interface Fixture {
  db: DatabaseSync;
  dir: string;
  conversationId: string;
  sessionId: string;
}

function makeFixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'trinity-approval-'));
  const db = openDatabase(join(dir, 'test.db'));
  const conversation = createConversation(db, { title: '审批' });
  const { session } = activateBinding(db, conversation.id, {
    harnessType: 'claude',
    // A turn now requires a workspace; the fixture's own temp dir is one.
    cwd: dir,
    model: null,
  });

  return { db, dir, conversationId: conversation.id, sessionId: session.id };
}

function cleanup(fixture: Fixture): void {
  fixture.db.close();
  rmSync(fixture.dir, { recursive: true, force: true });
}

function makeContext(
  fixture: Fixture,
  overrides: Partial<ApprovalTurnContext> = {},
): { ctx: ApprovalTurnContext; writes: string[] } {
  const writes: string[] = [];

  return {
    writes,
    ctx: {
      db: fixture.db,
      conversationId: fixture.conversationId,
      harnessSessionId: fixture.sessionId,
      turnId: 'turn-1',
      adapter: new ApprovalScriptAdapter(APPROVAL_SCRIPT),
      handle: {
        pid: null,
        write(line: string): boolean {
          writes.push(line);
          return true;
        },
        endInput(): void {
          // nothing to close in a unit test
        },
      },
      timeoutMs: 60_000,
      ...overrides,
    },
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 8000): Promise<void> {
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await new Promise((done) => setTimeout(done, 20));
  }

  throw new Error('waitFor timed out');
}

function messagesOf(db: DatabaseSync, conversationId: string): Array<Record<string, unknown>> {
  return db
    .prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC, rowid ASC')
    .all(conversationId) as Array<Record<string, unknown>>;
}

function withDb(run: (temp: TempDatabase) => void): void {
  const temp = createTempDatabase();
  try {
    run(temp);
  } finally {
    temp.cleanup();
  }
}

test('D3.5.2a 日志：创建审批写入 pending 与一条 change_log，且不记录命令正文', () => {
  withDb((temp) => {
    const conversation = createConversation(temp.db, { title: '日志' });
    const { session } = activateBinding(temp.db, conversation.id, {
      harnessType: 'claude',
      cwd: null,
      model: null,
    });

    const { row, created } = createApproval(temp.db, {
      conversationId: conversation.id,
      harnessSessionId: session.id,
      turnId: 'turn-1',
      agent: 'claude',
      kind: 'tool_approval',
      nativeRequestId: 'req-1',
      toolUseId: 'tu-1',
      toolName: 'Write',
      payload: { tool_name: 'Write', input: { file_path: 'secret.txt', content: '机密' } },
      expiresAt: null,
    });

    assert.equal(created, true);
    assert.equal(row.status, 'pending');

    const entries = temp.db
      .prepare("SELECT * FROM change_log WHERE entity_type = 'approval'")
      .all() as Array<{ operation: string; payload_json: string }>;

    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.operation, 'insert');
    assert.equal(JSON.stringify(entries[0]?.payload_json).includes('机密'), false);
  });
});

test('D3.5.2a 数据最小化：工具正文不进入 payload，只留展示信息', () => {
  const fixture = makeFixture();

  try {
    const body = 'x'.repeat(50_000);
    const { ctx } = makeContext(fixture);

    const row = createPendingApproval(ctx, {
      requestId: 'req-big',
      kind: 'tool_approval',
      toolName: 'Write',
      toolUseId: 'tu-big',
      input: { file_path: 'huge.txt', content: body },
      description: 'huge.txt',
    });
    assert.ok(row);

    const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
    assert.equal(payload.detail, 'huge.txt');
    assert.deepEqual(payload.input_keys, ['file_path', 'content']);
    assert.equal(row.payload_json.includes('xxxx'), false, '文件正文不得落库');
    assert.ok(row.payload_json.length < 512, `payload 应保持很小，实际 ${row.payload_json.length}`);

    // 正文仍在内存里，批准时原样回传给 CLI
    const decided = resolveApproval(fixture.db, row.id, {
      conversationId: fixture.conversationId,
      agent: 'claude',
      decision: 'approve',
    });
    assert.equal(decided.delivery_status, 'delivered');
  } finally {
    cleanup(fixture);
  }
});

test('D3.5.3b.3 审批卡片：委派请求显示目标 Agent 与指令摘要', () => {
  const fixture = makeFixture();

  try {
    const { ctx } = makeContext(fixture);
    const row = createPendingApproval(ctx, {
      requestId: 'req-delegate',
      kind: 'tool_approval',
      toolName: 'mcp__trinity__delegate_task',
      toolUseId: 'tu-delegate',
      input: { target_agent: 'codex', instruction: '检查迁移文件并报告结论', title: '迁移检查' },
      description: null,
    });
    assert.ok(row);

    const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
    assert.equal(payload.label, '委派任务给 codex');
    assert.equal(payload.detail, '检查迁移文件并报告结论');
    assert.equal(Object.hasOwn(payload, 'input'), false, '仍然不保存原始参数');
  } finally {
    cleanup(fixture);
  }
});

test('D3.5.2a 数据最小化：展示路径隐藏账户目录', () => {
  const home = (process.env.USERPROFILE ?? process.env.HOME ?? '').trim();
  if (home === '') return;

  const fixture = makeFixture();

  try {
    const { ctx } = makeContext(fixture);
    const row = createPendingApproval(ctx, {
      requestId: 'req-home',
      kind: 'tool_approval',
      toolName: 'Write',
      toolUseId: null,
      input: { file_path: `${home}\\notes\\a.txt`, content: 'x' },
      description: 'a.txt',
    });
    assert.ok(row);

    const payload = JSON.parse(row.payload_json) as { detail: string };
    assert.ok(payload.detail.startsWith('~'), payload.detail);
    assert.equal(payload.detail.toLowerCase().includes(home.toLowerCase()), false);
  } finally {
    cleanup(fixture);
  }
});

test('D3.5.2a 数据最小化：提问只保留问题与选项', () => {
  const fixture = makeFixture();

  try {
    const { ctx } = makeContext(fixture);
    const row = createPendingApproval(ctx, {
      requestId: 'req-q',
      kind: 'question',
      toolName: 'AskUserQuestion',
      toolUseId: 'tu-q',
      input: {
        questions: [
          {
            question: '选哪个？',
            header: '选择',
            options: [{ label: 'A', description: '甲' }, { label: 'B' }],
            multiSelect: false,
          },
        ],
        extra: 'not needed',
      },
      description: null,
    });
    assert.ok(row);

    const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
    assert.equal(Object.hasOwn(payload, 'input'), false);
    assert.equal(Object.hasOwn(payload, 'extra'), false);

    const questions = payload.questions as Array<Record<string, unknown>>;
    assert.equal(questions.length, 1);
    assert.equal(questions[0]?.question, '选哪个？');
    assert.equal((questions[0]?.options as unknown[]).length, 2);
  } finally {
    cleanup(fixture);
  }
});

test('D3.5.2a 日志：同一个原生请求重复到达不会建两行', () => {
  withDb((temp) => {
    const conversation = createConversation(temp.db, { title: '重复' });
    const { session } = activateBinding(temp.db, conversation.id, {
      harnessType: 'claude',
      cwd: null,
      model: null,
    });

    const input = {
      conversationId: conversation.id,
      harnessSessionId: session.id,
      turnId: 'turn-1',
      agent: 'claude' as const,
      kind: 'tool_approval' as const,
      nativeRequestId: 'req-1',
      toolUseId: 'tu-1',
      toolName: 'Write',
      payload: {},
      expiresAt: null,
    };

    const first = createApproval(temp.db, input);
    const second = createApproval(temp.db, input);

    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(second.row.id, first.row.id);
    assert.equal(listApprovals(temp.db, conversation.id).length, 1);
  });
});

test('D3.5.2a 决策：批准后状态为 approved，重复批准被拒绝', () => {
  const fixture = makeFixture();

  try {
    const { ctx, writes } = makeContext(fixture);
    const row = createPendingApproval(ctx, REQUEST);
    assert.ok(row);

    const decided = resolveApproval(fixture.db, row.id, {
      conversationId: fixture.conversationId,
      agent: 'claude',
      decision: 'approve',
    });

    assert.equal(decided.status, 'approved');
    assert.equal(decided.delivery_status, 'delivered');
    assert.equal(writes.length, 1);

    const payload = JSON.parse(writes[0]!) as {
      type: string;
      response: { request_id: string; response: { behavior: string } };
    };
    assert.equal(payload.type, 'control_response');
    assert.equal(payload.response.request_id, 'req-1');
    assert.equal(payload.response.response.behavior, 'allow');

    assert.throws(
      () =>
        resolveApproval(fixture.db, row.id, {
          conversationId: fixture.conversationId,
          agent: 'claude',
          decision: 'approve',
        }),
      /no longer pending/,
    );
  } finally {
    cleanup(fixture);
  }
});

test('D3.5.2a 安全：别的对话或别的 Agent 不能替这一条决策', () => {
  const fixture = makeFixture();

  try {
    const { ctx } = makeContext(fixture);
    const row = createPendingApproval(ctx, REQUEST);
    assert.ok(row);

    assert.throws(
      () =>
        resolveApproval(fixture.db, row.id, {
          conversationId: 'other-conversation',
          agent: 'claude',
          decision: 'approve',
        }),
      /Approval not found/,
    );

    assert.throws(
      () =>
        resolveApproval(fixture.db, row.id, {
          conversationId: fixture.conversationId,
          agent: 'codex',
          decision: 'approve',
        }),
      /Approval not found/,
    );

    assert.equal(findApproval(fixture.db, row.id)?.status, 'pending');
  } finally {
    cleanup(fixture);
  }
});

test('D3.5.2a 超时：先落库为 expired，再回传拒绝；迟到的批准返回 409', async () => {
  const fixture = makeFixture();

  try {
    const { ctx, writes } = makeContext(fixture, { timeoutMs: 40 });
    const row = createPendingApproval(ctx, REQUEST);
    assert.ok(row);

    await waitFor(() => findApproval(fixture.db, row.id)?.status === 'expired', 2000);

    assert.equal(writes.length, 1);
    assert.match(writes[0]!, /"deny"/);

    assert.throws(
      () =>
        resolveApproval(fixture.db, row.id, {
          conversationId: fixture.conversationId,
          agent: 'claude',
          decision: 'approve',
        }),
      /no longer pending/,
    );
  } finally {
    cleanup(fixture);
  }
});

test('D3.5.2a 生命周期：turn 结束与 Core 重启都会取消未决请求', () => {
  withDb((temp) => {
    const conversation = createConversation(temp.db, { title: '清理' });
    const { session } = activateBinding(temp.db, conversation.id, {
      harnessType: 'claude',
      cwd: null,
      model: null,
    });

    const make = (turnId: string, requestId: string) =>
      createApproval(temp.db, {
        conversationId: conversation.id,
        harnessSessionId: session.id,
        turnId,
        agent: 'claude',
        kind: 'tool_approval',
        nativeRequestId: requestId,
        toolUseId: null,
        toolName: 'Write',
        payload: {},
        expiresAt: null,
      });

    const first = make('turn-1', 'req-1');
    const second = make('turn-2', 'req-2');

    const cancelled = cancelPendingForTurn(temp.db, 'turn-1', 'turn_finished');
    assert.equal(cancelled.length, 1);
    assert.equal(findApproval(temp.db, first.row.id)?.status, 'cancelled');
    assert.equal(findApproval(temp.db, second.row.id)?.status, 'pending');

    assert.equal(sweepPendingOnStartup(temp.db), 1);
    assert.equal(findApproval(temp.db, second.row.id)?.status, 'cancelled');
  });
});

test('D3.5.2a 视图：payload 以对象返回，不含内部列', () => {
  const fixture = makeFixture();

  try {
    const { ctx } = makeContext(fixture);
    const row = createPendingApproval(ctx, REQUEST);
    assert.ok(row);

    const view = toView(row) as Record<string, unknown>;
    assert.equal(view.kind, 'tool_approval');
    assert.equal(typeof view.payload, 'object');
    assert.equal(Object.hasOwn(view, 'payload_json'), false);
    assert.equal(Object.hasOwn(view, 'native_request_id'), false);

    const payload = view.payload as Record<string, unknown>;
    assert.equal(payload.detail, 'probe.txt');
    assert.equal(Object.hasOwn(payload, 'input'), false);
  } finally {
    cleanup(fixture);
  }
});

test('D3.5.2a 解析：can_use_tool 变成审批事件，AskUserQuestion 判为提问', () => {
  const frame = parseClaudeLine(
    JSON.stringify({
      type: 'control_request',
      request_id: 'req-9',
      request: {
        subtype: 'can_use_tool',
        tool_name: 'Write',
        display_name: 'Write',
        input: { file_path: 'a.txt' },
        description: 'a.txt',
        tool_use_id: 'tu-9',
      },
    }),
  );

  const approval = frame?.events?.[0];
  assert.equal(approval?.type, 'approval_request');
  if (approval?.type !== 'approval_request') throw new Error('expected an approval event');
  assert.deepEqual(approval.approval, {
    requestId: 'req-9',
    kind: 'tool_approval',
    toolName: 'Write',
    toolUseId: 'tu-9',
    input: { file_path: 'a.txt' },
    description: 'a.txt',
  });

  const question = parseClaudeLine(
    JSON.stringify({
      type: 'control_request',
      request_id: 'req-10',
      request: {
        subtype: 'can_use_tool',
        tool_name: 'AskUserQuestion',
        input: { questions: [] },
        requires_user_interaction: true,
      },
    }),
  );

  const event = question?.events?.[0];
  if (event?.type !== 'approval_request') throw new Error('expected an approval event');
  assert.equal(event.approval.kind, 'question');
  assert.equal(event.approval.toolUseId, null);
});

test('D3.5.2a 解析：应答构造与超时参数', () => {
  const line = formatClaudeApprovalDecision(REQUEST, {
    behavior: 'deny',
    message: '不要',
  });

  assert.deepEqual(JSON.parse(line), {
    type: 'control_response',
    response: {
      subtype: 'success',
      request_id: 'req-1',
      response: { behavior: 'deny', message: '不要' },
    },
  });

  assert.equal(resolveApprovalTimeout({} as NodeJS.ProcessEnv), 5 * 60 * 1000);
  assert.equal(resolveApprovalTimeout({ TRINITY_APPROVAL_TIMEOUT_MS: '1500' } as NodeJS.ProcessEnv), 1500);
  assert.equal(
    resolveApprovalTimeout({ TRINITY_APPROVAL_TIMEOUT_MS: 'nonsense' } as NodeJS.ProcessEnv),
    5 * 60 * 1000,
  );
});

test('D3.5.2a 闭环：批准后原任务继续并产出最终消息', async () => {
  const fixture = makeFixture();
  const adapter = new ApprovalScriptAdapter(APPROVAL_SCRIPT);

  try {
    const started = sendTurn(fixture.db, fixture.conversationId, '写个文件', {
      adapter,
      timeoutMs: 15_000,
      cwd: fixture.dir,
      approvalTimeoutMs: 15_000,
    });

    assert.ok(started.turnId);
    assert.equal(adapter.inputs.length, 1, '提示词通过 stdin 作为首条消息发出');

    await waitFor(() => listApprovals(fixture.db, fixture.conversationId, 'pending').length === 1);
    const pending = listApprovals(fixture.db, fixture.conversationId, 'pending')[0]!;

    assert.equal(pending.tool_name, 'Write');
    assert.equal(pending.agent, 'claude');

    const decided = resolveApproval(fixture.db, pending.id, {
      conversationId: fixture.conversationId,
      agent: 'claude',
      decision: 'approve',
    });

    assert.equal(decided.status, 'approved');
    assert.equal(decided.delivery_status, 'delivered', '决策必须到达子进程');

    await waitFor(() => {
      const rows = messagesOf(fixture.db, fixture.conversationId);
      return rows.some((row) => row.message_type === 'agent_final');
    });

    const finals = messagesOf(fixture.db, fixture.conversationId).filter(
      (row) => row.message_type === 'agent_final',
    );
    assert.equal(finals.length, 1);
    assert.equal(finals[0]?.content, '已写入');

    const session = fixture.db
      .prepare('SELECT * FROM harness_sessions WHERE id = ?')
      .get(fixture.sessionId) as { status: string };
    assert.equal(session.status, 'idle');
  } finally {
    cleanup(fixture);
  }
});

test('D3.5.2a 闭环：拒绝后 Agent 收到拒绝原因而不是执行', async () => {
  const fixture = makeFixture();
  const adapter = new ApprovalScriptAdapter(APPROVAL_SCRIPT);

  try {
    sendTurn(fixture.db, fixture.conversationId, '写个文件', {
      adapter,
      timeoutMs: 15_000,
      cwd: fixture.dir,
      approvalTimeoutMs: 15_000,
    });

    await waitFor(() => listApprovals(fixture.db, fixture.conversationId, 'pending').length === 1);
    const pending = listApprovals(fixture.db, fixture.conversationId, 'pending')[0]!;

    const decided = resolveApproval(fixture.db, pending.id, {
      conversationId: fixture.conversationId,
      agent: 'claude',
      decision: 'deny',
    });

    assert.equal(decided.status, 'denied');
    assert.equal(decided.delivery_status, 'delivered');

    await waitFor(() => {
      const rows = messagesOf(fixture.db, fixture.conversationId);
      return rows.some((row) => row.message_type === 'agent_final');
    });

    const toolResults = messagesOf(fixture.db, fixture.conversationId).filter(
      (row) => row.message_type === 'tool_result',
    );
    assert.equal(toolResults.length, 1);
    assert.match(String(toolResults[0]?.content), /denied/);

    const finals = messagesOf(fixture.db, fixture.conversationId).filter(
      (row) => row.message_type === 'agent_final',
    );
    assert.equal(finals[0]?.content, '没有写入');
  } finally {
    cleanup(fixture);
  }
});
