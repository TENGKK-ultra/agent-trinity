import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { createConversation } from '../src/conversations/conversation.service.ts';
import { openDatabase } from '../src/database/connection.ts';
import { createTempDatabase, startTestServer } from './helpers.ts';
import { parseClaudeLine } from '../src/harnesses/claude.adapter.ts';
import { locateCodexBinary, parseCodexLine } from '../src/harnesses/codex.adapter.ts';
import { locateDsh, parseDshLine } from '../src/harnesses/dsh.adapter.ts';
import { expandShimTarget, locateOnPath } from '../src/harnesses/locator.ts';
import { killAllActiveProcesses, runProcess } from '../src/harnesses/runner.ts';
import {
  acquireRunLock,
  activateBinding,
  findSession,
} from '../src/harnesses/session.service.ts';
import { sendTurn } from '../src/harnesses/turn.service.ts';
import type {
  HarnessAdapter,
  HarnessStreamFrame,
  HarnessTurnInput,
  HarnessType,
} from '../src/harnesses/types.ts';
import type { DatabaseSync } from 'node:sqlite';

const FIXTURES = resolve(import.meta.dirname, 'fixtures');
const STREAM = join(FIXTURES, 'emit-stream.mjs');
const ERROR = join(FIXTURES, 'emit-error.mjs');
const CRASH = join(FIXTURES, 'exit-nonzero.mjs');
const SLOW = join(FIXTURES, 'slow.mjs');
const CODEX_STREAM = join(FIXTURES, 'emit-codex.mjs');
const CODEX_FAIL = join(FIXTURES, 'emit-codex-fail.mjs');
const DSH_STREAM = join(FIXTURES, 'emit-dsh.mjs');
const DSH_FAIL = join(FIXTURES, 'emit-dsh-fail.mjs');

class ScriptAdapter implements HarnessAdapter {
  readonly displayName = 'Script Adapter';
  readonly type: HarnessType;
  readonly inputs: HarnessTurnInput[] = [];
  private readonly script: string;
  private readonly parse: (line: string) => HarnessStreamFrame | null;

  constructor(
    script: string,
    type: HarnessType = 'claude',
    parse: (line: string) => HarnessStreamFrame | null = parseClaudeLine,
  ) {
    this.script = script;
    this.type = type;
    this.parse = parse;
  }

  resolveExecutable(): { file: string; source: string } {
    return { file: process.execPath, source: 'test' };
  }

  buildCommand(input: HarnessTurnInput): { file: string; args: string[]; env: Record<string, string> } {
    this.inputs.push(input);
    return { file: process.execPath, args: [this.script], env: {} };
  }

  parseLine(line: string): HarnessStreamFrame | null {
    return this.parse(line);
  }
}

interface Fixture {
  db: DatabaseSync;
  dir: string;
  conversationId: string;
}

function makeFixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'trinity-d3-'));
  const db = openDatabase(join(dir, 'test.db'));
  const conversation = createConversation(db, { title: 'D3 test' });

  return { db, dir, conversationId: conversation.id };
}

function cleanup(fixture: Fixture): void {
  fixture.db.close();
  rmSync(fixture.dir, { recursive: true, force: true });
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
    .prepare(
      `SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC, rowid ASC`,
    )
    .all(conversationId) as Array<Record<string, unknown>>;
}

test('D3 解析：is_error 为真时，即使 subtype=success 也判为失败', () => {
  const frame = parseClaudeLine(
    JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: true,
      result: 'Not logged in · Please run /login',
      session_id: 'sid-1',
    }),
  );

  assert.equal(frame?.terminal?.isError, true);
  assert.equal(frame?.terminal?.finalText, '');
  assert.match(String(frame?.terminal?.errorMessage), /Not logged in/);
});

test('D3 解析：一行内的多个内容块全部保留', () => {
  const frame = parseClaudeLine(
    JSON.stringify({
      type: 'assistant',
      session_id: 'sid-1',
      message: { content: [{ type: 'text', text: 'A' }, { type: 'text', text: 'B' }] },
    }),
  );

  assert.equal(frame?.events?.length, 2);
});

test('D3 解析：非 JSON 行被忽略而不是抛错', () => {
  assert.equal(parseClaudeLine('not json at all'), null);
});

test('D3 定位：shim 指向缺失的可执行文件时不会被采用', () => {
  const dir = mkdtempSync(join(tmpdir(), 'trinity-shim-'));
  const shimPath = join(dir, 'claude.cmd');
  const target = join(dir, 'claude.exe');

  try {
    const contents = `"%dp0%\\claude.exe" %*`;
    assert.equal(expandShimTarget(shimPath, contents), target);

    // Target missing: the shim must report nothing usable, and say why.
    writeFileSync(shimPath, contents);
    const missing = locateOnPath('claude', { PATH: dir } as NodeJS.ProcessEnv);
    assert.equal(missing.found, null);
    assert.ok(missing.probes.some((probe) => probe.includes('shim target missing')));

    // Target present: the shim resolves.
    writeFileSync(target, '');
    const found = locateOnPath('claude', { PATH: dir } as NodeJS.ProcessEnv);
    assert.equal(found.found?.file, target);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('D3 定位：显式指定的 TRINITY_CLAUDE_BIN 无效时直接失败，不回退到 PATH', () => {
  const dir = mkdtempSync(join(tmpdir(), 'trinity-override-'));

  try {
    const real = join(dir, 'claude.exe');
    writeFileSync(real, '');

    const result = locateOnPath('claude', {
      PATH: dir,
      TRINITY_CLAUDE_BIN: join(dir, 'missing.exe'),
    } as NodeJS.ProcessEnv);

    assert.equal(result.found, null, '不得静默回退到 PATH 中的其它 claude');
    assert.ok(result.probes.some((probe) => probe.includes('TRINITY_CLAUDE_BIN')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('D3 进程：可执行文件不存在时立即失败，不挂起', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'trinity-spawn-'));

  try {
    const result = await runProcess({
      file: join(dir, 'does-not-exist.exe'),
      args: [],
      cwd: dir,
      env: {},
      timeoutMs: 2000,
      onLine: () => {},
    });

    assert.equal(result.exitCode, null);
    assert.ok(typeof result.spawnError === 'string' && result.spawnError.length > 0);
    assert.equal(result.timedOut, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('D3 进程：超时会被终止并报告 timedOut', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'trinity-timeout-'));

  try {
    const started = Date.now();
    const result = await runProcess({
      file: process.execPath,
      args: [SLOW],
      cwd: dir,
      env: {},
      timeoutMs: 400,
      onLine: () => {},
    });

    assert.equal(result.timedOut, true);
    assert.ok(Date.now() - started < 10_000, '超时后应立即返回');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('D3 进程：Core 退出时终止所有已启动的子进程，不留孤儿', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'trinity-reap-'));

  try {
    const running = runProcess({
      file: process.execPath,
      args: [SLOW],
      cwd: dir,
      env: {},
      timeoutMs: 60_000,
      onLine: () => {},
    });

    // Let the child actually start before asking Core to shut down.
    await new Promise((done) => setTimeout(done, 400));

    const startedAt = Date.now();
    killAllActiveProcesses();
    const result = await running;

    assert.ok(Date.now() - startedAt < 5000, '退出清理应立即生效');
    assert.equal(result.timedOut, false, '不是超时导致的结束');
    assert.equal(result.aborted, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('D3 往返：流式事件按轮次聚合，来源正确区分，会话 id 落库', async () => {
  const fixture = makeFixture();
  const adapter = new ScriptAdapter(STREAM);

  try {
    activateBinding(fixture.db, fixture.conversationId, {
      harnessType: 'claude',
      cwd: fixture.dir,
      model: null,
    });

    const started = sendTurn(fixture.db, fixture.conversationId, '你好', {
      adapter,
      timeoutMs: 20_000,
      cwd: fixture.dir,
    });

    assert.ok(started.turnId, '应返回 turn id');

    await waitFor(() => {
      const session = findSession(fixture.db, fixture.conversationId, 'claude');
      return session?.status !== 'running';
    });

    const rows = messagesOf(fixture.db, fixture.conversationId);
    const user = rows.filter((row) => row.message_type === 'user_message');
    const finals = rows.filter((row) => row.message_type === 'agent_final');
    const tools = rows.filter((row) => row.message_type === 'tool_call');
    const results = rows.filter((row) => row.message_type === 'tool_result');

    assert.equal(user.length, 1);
    assert.equal(String(user[0]?.sender_kind), 'user');

    assert.equal(finals.length, 1, '多段文本应聚合成一条最终回复');
    assert.equal(String(finals[0]?.sender_kind), 'agent');
    assert.equal(String(finals[0]?.content), '第一段\n第二段甲第二段乙');

    assert.equal(tools.length, 1);
    assert.equal(results.length, 1);

    const session = findSession(fixture.db, fixture.conversationId, 'claude');
    assert.equal(session?.native_session_id, 'sid-test-1');
    assert.equal(session?.status, 'idle');

    const second = sendTurn(fixture.db, fixture.conversationId, '第二轮', {
      adapter,
      timeoutMs: 20_000,
      cwd: fixture.dir,
    });

    assert.ok(second.turnId);
    assert.equal(adapter.inputs.length, 2);
    assert.equal(adapter.inputs[1]?.nativeSessionId, 'sid-test-1', '第二轮应复用会话');

    await waitFor(() => {
      const current = findSession(fixture.db, fixture.conversationId, 'claude');
      return current?.status !== 'running';
    });
  } finally {
    cleanup(fixture);
  }
});

test('D3 失败：CLI 报告 is_error 时写入 system_event 且无最终回复', async () => {
  const fixture = makeFixture();
  const adapter = new ScriptAdapter(ERROR);

  try {
    activateBinding(fixture.db, fixture.conversationId, {
      harnessType: 'claude',
      cwd: fixture.dir,
      model: null,
    });

    sendTurn(fixture.db, fixture.conversationId, '你好', {
      adapter,
      timeoutMs: 20_000,
      cwd: fixture.dir,
    });

    await waitFor(
      () => findSession(fixture.db, fixture.conversationId, 'claude')?.status !== 'running',
    );

    const rows = messagesOf(fixture.db, fixture.conversationId);
    const systems = rows.filter((row) => row.message_type === 'system_event');

    assert.equal(rows.filter((row) => row.message_type === 'agent_final').length, 0);
    assert.equal(systems.length, 1);
    assert.match(String(systems[0]?.content), /provider rejected the request/);
    assert.equal(findSession(fixture.db, fixture.conversationId, 'claude')?.status, 'error');
  } finally {
    cleanup(fixture);
  }
});

test('D3 失败：非零退出码写入 system_event', async () => {
  const fixture = makeFixture();
  const adapter = new ScriptAdapter(CRASH);

  try {
    activateBinding(fixture.db, fixture.conversationId, {
      harnessType: 'claude',
      cwd: fixture.dir,
      model: null,
    });

    sendTurn(fixture.db, fixture.conversationId, '你好', {
      adapter,
      timeoutMs: 20_000,
      cwd: fixture.dir,
    });

    await waitFor(
      () => findSession(fixture.db, fixture.conversationId, 'claude')?.status !== 'running',
    );

    const systems = messagesOf(fixture.db, fixture.conversationId).filter(
      (row) => row.message_type === 'system_event',
    );

    assert.equal(systems.length, 1);
    assert.match(String(systems[0]?.content), /退出码 3/);
  } finally {
    cleanup(fixture);
  }
});

test('D3 并发：同一会话的第二个轮次返回 409，不静默丢弃', async () => {
  const fixture = makeFixture();
  const adapter = new ScriptAdapter(STREAM);

  try {
    const { session } = activateBinding(fixture.db, fixture.conversationId, {
      harnessType: 'claude',
      cwd: fixture.dir,
      model: null,
    });

    acquireRunLock(fixture.db, session.id, 'run-1');

    assert.throws(
      () =>
        sendTurn(fixture.db, fixture.conversationId, '并发', {
          adapter,
          timeoutMs: 5000,
          cwd: fixture.dir,
        }),
      (err: unknown) => (err as { status?: number }).status === 409,
    );

    const rows = messagesOf(fixture.db, fixture.conversationId);
    assert.equal(rows.length, 0, '被拒绝的轮次不应留下用户消息');
  } finally {
    cleanup(fixture);
  }
});

test('D3 并发：数据库层面拒绝第二个 held 锁', () => {
  const fixture = makeFixture();

  try {
    const { session } = activateBinding(fixture.db, fixture.conversationId, {
      harnessType: 'claude',
      cwd: fixture.dir,
      model: null,
    });

    acquireRunLock(fixture.db, session.id, 'run-a');

    assert.throws(
      () => acquireRunLock(fixture.db, session.id, 'run-b'),
      (err: unknown) => (err as { status?: number }).status === 409,
    );

    const held = fixture.db
      .prepare(
        `SELECT COUNT(*) AS n FROM harness_session_locks WHERE harness_session_id = ? AND status = 'held'`,
      )
      .get(session.id) as { n: number };

    assert.equal(held.n, 1);
  } finally {
    cleanup(fixture);
  }
});

test('D3 迁移：003 添加状态列并安装单轮次唯一索引', () => {
  const fixture = makeFixture();

  try {
    const columns = fixture.db
      .prepare('SELECT name FROM pragma_table_info(?)')
      .all('harness_sessions') as Array<{ name: string }>;
    const names = columns.map((entry) => entry.name);

    for (const column of ['status', 'last_seen_at', 'cwd', 'model']) {
      assert.ok(names.includes(column), `缺少列 ${column}`);
    }

    const indexes = fixture.db
      .prepare('SELECT name FROM pragma_index_list(?)')
      .all('harness_session_locks') as Array<{ name: string }>;

    assert.ok(
      indexes.some((entry) => entry.name === 'idx_harness_locks_single_held'),
      '缺少单轮次唯一索引',
    );
  } finally {
    cleanup(fixture);
  }
});

test('D3.1 Codex 解析：thread、agent_message 与 turn 事件', () => {
  const started = parseCodexLine(JSON.stringify({ type: 'thread.started', thread_id: 't-1' }));
  assert.equal(started?.sessionId, 't-1');

  const message = parseCodexLine(
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'hi' } }),
  );
  assert.deepEqual(message?.events, [{ type: 'assistant_text', text: 'hi' }]);

  // A config warning arrives as an error item; it must not end the turn.
  const warning = parseCodexLine(
    JSON.stringify({ type: 'item.completed', item: { type: 'error', message: 'ignoring settings' } }),
  );
  assert.equal(warning?.terminal, undefined);

  const done = parseCodexLine(JSON.stringify({ type: 'turn.completed' }));
  assert.equal(done?.terminal?.isError, false);

  const failed = parseCodexLine(JSON.stringify({ type: 'turn.failed', message: 'model not found' }));
  assert.equal(failed?.terminal?.isError, true);
  assert.match(String(failed?.terminal?.errorMessage), /model not found/);
});

test('D3.1 Codex 定位：优先选择带沙箱安装程序的完整目录', () => {
  const root = mkdtempSync(join(tmpdir(), 'trinity-codex-'));

  try {
    const binRoot = join(root, 'OpenAI', 'Codex', 'bin');
    const partial = join(binRoot, 'partial');
    const complete = join(binRoot, 'complete');
    mkdirSync(partial, { recursive: true });
    mkdirSync(complete, { recursive: true });

    writeFileSync(join(partial, 'codex.exe'), '');
    writeFileSync(join(complete, 'codex.exe'), '');
    writeFileSync(join(complete, 'codex-windows-sandbox-setup.exe'), '');

    const result = locateCodexBinary({ LOCALAPPDATA: root, PATH: '' } as NodeJS.ProcessEnv);
    assert.equal(result.found?.file, join(complete, 'codex.exe'));
    assert.equal(result.found?.complete, true);

    rmSync(join(complete, 'codex-windows-sandbox-setup.exe'));

    const onlyPartial = locateCodexBinary({ LOCALAPPDATA: root, PATH: '' } as NodeJS.ProcessEnv);
    assert.equal(onlyPartial.found?.complete, false, '只有残缺目录时应标记为不完整');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('D3.1 Codex 定位：显式指定的 TRINITY_CODEX_BIN 无效时直接失败', () => {
  const root = mkdtempSync(join(tmpdir(), 'trinity-codex-override-'));

  try {
    const real = join(root, 'codex.exe');
    writeFileSync(real, '');

    const result = locateCodexBinary({
      TRINITY_CODEX_BIN: join(root, 'missing.exe'),
      LOCALAPPDATA: root,
      PATH: '',
    } as NodeJS.ProcessEnv);

    assert.equal(result.found, null);
    assert.ok(result.probes.some((probe) => probe.includes('TRINITY_CODEX_BIN')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('D3.1 Codex 往返：事件聚合、会话 id 落库、配置告警不产生系统错误', async () => {
  const fixture = makeFixture();
  const adapter = new ScriptAdapter(CODEX_STREAM, 'codex', parseCodexLine);

  try {
    activateBinding(fixture.db, fixture.conversationId, {
      harnessType: 'codex',
      cwd: fixture.dir,
      model: null,
    });

    sendTurn(fixture.db, fixture.conversationId, '你好', {
      adapter,
      timeoutMs: 20_000,
      cwd: fixture.dir,
    });

    await waitFor(
      () => findSession(fixture.db, fixture.conversationId, 'codex')?.status !== 'running',
    );

    const rows = messagesOf(fixture.db, fixture.conversationId);
    const finals = rows.filter((row) => row.message_type === 'agent_final');
    const systems = rows.filter((row) => row.message_type === 'system_event');

    assert.equal(finals.length, 1);
    assert.equal(String(finals[0]?.content), '第一段\n\n第二段');
    assert.equal(systems.length, 0, '配置告警不得变成系统错误');

    const session = findSession(fixture.db, fixture.conversationId, 'codex');
    assert.equal(session?.native_session_id, 'cx-thread-1');
    assert.equal(session?.status, 'idle');
  } finally {
    cleanup(fixture);
  }
});

test('D3.1 Codex 失败：turn.failed 写入 system_event', async () => {
  const fixture = makeFixture();
  const adapter = new ScriptAdapter(CODEX_FAIL, 'codex', parseCodexLine);

  try {
    activateBinding(fixture.db, fixture.conversationId, {
      harnessType: 'codex',
      cwd: fixture.dir,
      model: null,
    });

    sendTurn(fixture.db, fixture.conversationId, '你好', {
      adapter,
      timeoutMs: 20_000,
      cwd: fixture.dir,
    });

    await waitFor(
      () => findSession(fixture.db, fixture.conversationId, 'codex')?.status !== 'running',
    );

    const systems = messagesOf(fixture.db, fixture.conversationId).filter(
      (row) => row.message_type === 'system_event',
    );

    assert.equal(systems.length, 1);
    assert.match(String(systems[0]?.content), /model not found/);
    assert.equal(findSession(fixture.db, fixture.conversationId, 'codex')?.status, 'error');
  } finally {
    cleanup(fixture);
  }
});

test('D3.3 API：多 Agent 会话保留、切换续接与单 Agent 解绑', async () => {
  const temp = createTempDatabase();
  const server = await startTestServer(temp.db);
  const dir = mkdtempSync(join(tmpdir(), 'trinity-bind-'));
  const claudeBin = join(dir, 'claude.exe');
  const codexBin = join(dir, 'codex.exe');
  writeFileSync(claudeBin, '');
  writeFileSync(codexBin, '');

  const previousClaude = process.env.TRINITY_CLAUDE_BIN;
  const previousCodex = process.env.TRINITY_CODEX_BIN;
  process.env.TRINITY_CLAUDE_BIN = claudeBin;
  process.env.TRINITY_CODEX_BIN = codexBin;

  const agentUrl = (id: string, query = ''): string =>
    `${server.baseUrl}/api/conversations/${id}/agent${query}`;

  const bind = (id: string, agent: string): Promise<Response> =>
    fetch(agentUrl(id), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent }),
    });

  interface State {
    agent: string | null;
    active_agent: string | null;
    bindings: Array<{ agent: string; active: boolean; native_session_id: string | null }>;
    removed?: boolean;
    was_active?: boolean;
  }

  try {
    const created = await fetch(`${server.baseUrl}/api/conversations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '绑定测试' }),
    });
    const conversationId = String(((await created.json()) as { id: string }).id);

    const bindClaude = await bind(conversationId, 'claude');
    assert.equal(bindClaude.status, 201);
    let state = (await bindClaude.json()) as State;
    assert.equal(state.active_agent, 'claude');

    const bindCodex = await bind(conversationId, 'codex');
    assert.equal(bindCodex.status, 201);
    state = (await bindCodex.json()) as State;
    assert.equal(state.active_agent, 'codex');
    assert.equal(state.bindings.length, 2, '切换不得删除 Claude 的会话');
    assert.equal(state.bindings.find((row) => row.agent === 'claude')?.active, false);

    temp.db
      .prepare(
        "UPDATE harness_sessions SET native_session_id = 'sid-claude' WHERE conversation_id = ? AND harness_type = 'claude'",
      )
      .run(conversationId);

    const backToClaude = await bind(conversationId, 'claude');
    assert.equal(backToClaude.status, 200);
    state = (await backToClaude.json()) as State;
    assert.equal(state.active_agent, 'claude');
    assert.equal(
      state.bindings.find((row) => row.agent === 'claude')?.native_session_id,
      'sid-claude',
      '切回来必须保留原会话 id',
    );
    assert.equal(state.bindings.length, 2);

    const activeRows = temp.db
      .prepare('SELECT COUNT(*) AS n FROM harness_sessions WHERE conversation_id = ? AND active = 1')
      .get(conversationId) as { n: number };
    assert.equal(activeRows.n, 1, '一个对话最多一个活动 Agent');

    process.env.TRINITY_CODEX_BIN = join(dir, 'missing.exe');
    const broken = await bind(conversationId, 'codex');
    assert.equal(broken.status, 422);
    assert.equal(((await broken.json()) as { error: { code: string } }).error.code, 'harness_unavailable');

    const unchanged = (await (await fetch(agentUrl(conversationId))).json()) as State;
    assert.equal(unchanged.active_agent, 'claude', '失败的绑定不得改变活动 Agent');
    assert.equal(unchanged.bindings.length, 2);

    const removed = await fetch(agentUrl(conversationId, '?agent=codex'), { method: 'DELETE' });
    state = (await removed.json()) as State;
    assert.equal(state.removed, true);
    assert.equal(state.bindings.length, 1);
    assert.equal(state.active_agent, 'claude', '解绑其他 Agent 不影响活动 Agent');

    const removeActive = await fetch(agentUrl(conversationId, '?agent=claude'), { method: 'DELETE' });
    state = (await removeActive.json()) as State;
    assert.equal(state.was_active, true);
    assert.equal(state.active_agent, null, '解绑活动 Agent 后不再有活动 Agent');
    assert.equal(state.bindings.length, 0);

    const missingParam = await fetch(agentUrl(conversationId), { method: 'DELETE' });
    assert.equal(missingParam.status, 400);
  } finally {
    if (previousClaude === undefined) delete process.env.TRINITY_CLAUDE_BIN;
    else process.env.TRINITY_CLAUDE_BIN = previousClaude;

    if (previousCodex === undefined) delete process.env.TRINITY_CODEX_BIN;
    else process.env.TRINITY_CODEX_BIN = previousCodex;

    await server.close();
    temp.cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('D3.3 存储：数据库拒绝同一个对话出现两个活动 Agent', () => {
  const fixture = makeFixture();

  try {
    activateBinding(fixture.db, fixture.conversationId, {
      harnessType: 'claude',
      cwd: fixture.dir,
      model: null,
    });
    activateBinding(fixture.db, fixture.conversationId, {
      harnessType: 'codex',
      cwd: fixture.dir,
      model: null,
    });

    assert.throws(
      () =>
        fixture.db
          .prepare("UPDATE harness_sessions SET active = 1 WHERE conversation_id = ? AND harness_type = 'claude'")
          .run(fixture.conversationId),
      /UNIQUE constraint failed/i,
    );
  } finally {
    cleanup(fixture);
  }
});

test('D3.2 DSH 解析：session、完整 text 与 final 事件', () => {
  const session = parseDshLine(JSON.stringify({ type: 'session', sessionId: 's-1' }));
  assert.equal(session?.sessionId, 's-1');

  const text = parseDshLine(JSON.stringify({ type: 'text', text: '整段回答' }));
  assert.deepEqual(text?.events, [{ type: 'assistant_text', text: '整段回答' }]);

  const done = parseDshLine(
    JSON.stringify({ type: 'final', sessionId: 's-1', reason: { kind: 'completed' }, text: '整段回答' }),
  );
  assert.equal(done?.terminal?.isError, false);
  assert.equal(done?.terminal?.finalText, '整段回答');

  const failed = parseDshLine(
    JSON.stringify({
      type: 'final',
      sessionId: 's-1',
      reason: { kind: 'error', error: { message: 'no API key' } },
      text: '',
    }),
  );
  assert.equal(failed?.terminal?.isError, true);
  assert.match(String(failed?.terminal?.errorMessage), /no API key/);
});

test('D3.2 DSH 定位：显式指定的 TRINITY_DSH_CLI 必须指向真实 CLI', () => {
  const root = mkdtempSync(join(tmpdir(), 'trinity-dsh-'));

  try {
    const cli = join(
      root,
      'resources',
      'app',
      'dsh',
      'node_modules',
      '@deepseek-ai',
      'dsh',
      'lib',
      'bin.js',
    );
    mkdirSync(join(cli, '..'), { recursive: true });
    writeFileSync(cli, '');

    const found = locateDsh({ TRINITY_DSH_CLI: root } as NodeJS.ProcessEnv);
    assert.equal(found.found?.cli, cli);

    const missing = locateDsh({ TRINITY_DSH_CLI: join(root, 'nowhere') } as NodeJS.ProcessEnv);
    assert.equal(missing.found, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('D3.2 DSH 往返：完整文本落库、会话 id 持久化', async () => {
  const fixture = makeFixture();
  const adapter = new ScriptAdapter(DSH_STREAM, 'deepseek', parseDshLine);

  try {
    activateBinding(fixture.db, fixture.conversationId, {
      harnessType: 'deepseek',
      cwd: fixture.dir,
      model: null,
    });

    sendTurn(fixture.db, fixture.conversationId, '你好', {
      adapter,
      timeoutMs: 20_000,
      cwd: fixture.dir,
    });

    await waitFor(
      () => findSession(fixture.db, fixture.conversationId, 'deepseek')?.status !== 'running',
    );

    const finals = messagesOf(fixture.db, fixture.conversationId).filter(
      (row) => row.message_type === 'agent_final',
    );

    assert.equal(finals.length, 1);
    assert.equal(String(finals[0]?.content), '第一段\n第二段');

    const session = findSession(fixture.db, fixture.conversationId, 'deepseek');
    assert.equal(session?.native_session_id, 'session-dsh-1');
    assert.equal(session?.status, 'idle');
  } finally {
    cleanup(fixture);
  }
});

test('D3.2 DSH 失败：final 的 error 原因写入 system_event', async () => {
  const fixture = makeFixture();
  const adapter = new ScriptAdapter(DSH_FAIL, 'deepseek', parseDshLine);

  try {
    activateBinding(fixture.db, fixture.conversationId, {
      harnessType: 'deepseek',
      cwd: fixture.dir,
      model: null,
    });

    sendTurn(fixture.db, fixture.conversationId, '你好', {
      adapter,
      timeoutMs: 20_000,
      cwd: fixture.dir,
    });

    await waitFor(
      () => findSession(fixture.db, fixture.conversationId, 'deepseek')?.status !== 'running',
    );

    const systems = messagesOf(fixture.db, fixture.conversationId).filter(
      (row) => row.message_type === 'system_event',
    );

    assert.equal(systems.length, 1);
    assert.match(String(systems[0]?.content), /no API key/);
    assert.equal(findSession(fixture.db, fixture.conversationId, 'deepseek')?.status, 'error');
  } finally {
    cleanup(fixture);
  }
});

test('D3 持久化：数据库重开后会话绑定仍在', () => {
  const dir = mkdtempSync(join(tmpdir(), 'trinity-restart-'));
  const dbPath = join(dir, 'restart.db');

  try {
    const first = openDatabase(dbPath);
    const conversation = createConversation(first, { title: 'restart' });
    const { session } = activateBinding(first, conversation.id, {
      harnessType: 'claude',
      cwd: dir,
      model: null,
    });
    first
      .prepare('UPDATE harness_sessions SET native_session_id = ? WHERE id = ?')
      .run('sid-persisted', session.id);
    first.close();

    const second = openDatabase(dbPath);
    const restored = findSession(second, conversation.id, 'claude');
    assert.equal(restored?.native_session_id, 'sid-persisted');
    second.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
