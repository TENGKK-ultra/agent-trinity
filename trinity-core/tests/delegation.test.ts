import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import { createConversation } from '../src/conversations/conversation.service.ts';
import { openDatabase } from '../src/database/connection.ts';
import { executeTask } from '../src/harnesses/delegation.service.ts';
import { resolveDelegationTimeout } from '../src/harnesses/delegation.timeouts.ts';
import {
  acquireRunLock,
  activateBinding,
  clearQuarantine,
  findSession,
  quarantineSession,
} from '../src/harnesses/session.service.ts';
import { createTask, findTask } from '../src/harnesses/task.service.ts';
import { settleSessionAfterRun } from '../src/harnesses/turn.service.ts';
import { ClaudeAdapter, parseClaudeLine } from '../src/harnesses/claude.adapter.ts';
import { buildCodexArgs, resolveCodexSandbox } from '../src/harnesses/codex.adapter.ts';
import {
  removeDelegationConfig,
  writeDelegationConfig,
} from '../src/harnesses/delegation.config.ts';
import { issueToken, resetTokens, validateToken } from '../src/harnesses/token.service.ts';
import { resetTaskRuntime } from '../src/harnesses/task.runtime.ts';
import type {
  HarnessAdapter,
  HarnessCommand,
  HarnessStreamFrame,
  HarnessTurnInput,
  HarnessType,
} from '../src/harnesses/types.ts';
import { createTempDatabase, startTestServer, type TempDatabase } from './helpers.ts';

const FIXTURES = resolve(import.meta.dirname, 'fixtures');
const STREAM = join(FIXTURES, 'emit-stream.mjs');
const FAIL = join(FIXTURES, 'emit-error.mjs');
const SLOW = join(FIXTURES, 'slow.mjs');

class ScriptAdapter implements HarnessAdapter {
  readonly type = 'codex' as const;
  readonly displayName = 'Codex';
  private readonly script: string;

  constructor(script: string) {
    this.script = script;
  }

  resolveExecutable(): { file: string; source: string } {
    return { file: process.execPath, source: 'test' };
  }

  buildCommand(_input: HarnessTurnInput): HarnessCommand {
    return { file: process.execPath, args: [this.script], env: {} };
  }

  parseLine(line: string): HarnessStreamFrame | null {
    return parseClaudeLine(line);
  }
}

/**
 * Stands in for the Claude CLI on the wire, but records what the turn actually
 * injected. The config file is read synchronously inside buildCommand: it is
 * written just before the spawn and deleted when the run ends, so a later read
 * would race the turn's own cleanup.
 */
class RecordingClaudeAdapter implements HarnessAdapter {
  readonly type = 'claude' as const;
  readonly displayName = 'Claude';
  buildCount = 0;
  injected: { configPath: string; coreUrl: string; token: string } | null = null;

  resolveExecutable(): { file: string; source: string } {
    return { file: process.execPath, source: 'test' };
  }

  buildCommand(input: HarnessTurnInput): HarnessCommand {
    this.buildCount += 1;

    if (input.mcpConfigPath) {
      const raw = JSON.parse(readFileSync(input.mcpConfigPath, 'utf8')) as {
        mcpServers: { trinity: { env: Record<string, string | undefined> } };
      };
      const env = raw.mcpServers.trinity.env;

      this.injected = {
        configPath: input.mcpConfigPath,
        coreUrl: env.TRINITY_CORE_URL ?? '',
        token: env.TRINITY_TOKEN ?? '',
      };
    }

    return { file: process.execPath, args: [STREAM], env: {} };
  }

  parseLine(line: string): HarnessStreamFrame | null {
    return parseClaudeLine(line);
  }
}

/** A caller that controls the Host header, which fetch will not let us set. */
function postTurn(baseUrl: string, conversationId: string, host: string) {
  return new Promise<{ status: number; body: Record<string, unknown> | null }>((done, fail) => {
    const url = new URL(`${baseUrl}/api/conversations/${conversationId}/turns`);
    const payload = JSON.stringify({ content: '你好' });

    const req = httpRequest(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
          host,
        },
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          text += chunk;
        });
        res.on('end', () => {
          done({ status: res.statusCode ?? 0, body: text ? (JSON.parse(text) as Record<string, unknown>) : null });
        });
      },
    );

    req.on('error', fail);
    req.end(payload);
  });
}

async function waitForIdle(db: DatabaseSync, conversationId: string, harness: HarnessType): Promise<void> {
  const deadline = Date.now() + 10_000;

  while (Date.now() < deadline) {
    if (findSession(db, conversationId, harness)?.status !== 'running') return;
    await new Promise((done) => setTimeout(done, 25));
  }

  throw new Error('turn did not finish in time');
}

interface Fixture {
  temp: TempDatabase;
  conversationId: string;
  dir: string;
}


function makeFixture(): Fixture {
  const temp = createTempDatabase();
  const conversation = createConversation(temp.db, { title: '委派' });

  return { temp, conversationId: conversation.id, dir: temp.dir };
}

function bindTarget(fixture: Fixture, cwd: string | null): void {
  activateBinding(fixture.temp.db, fixture.conversationId, {
    harnessType: 'codex',
    cwd,
    model: null,
  });
}

function makeTask(fixture: Fixture) {
  return createTask(fixture.temp.db, {
    conversationId: fixture.conversationId,
    sourceAgent: 'claude',
    sourceTurnId: 'turn-source',
    targetAgent: 'codex',
    instruction: '检查迁移文件并报告结论',
  });
}

function makeAdapter(script: string): HarnessAdapter {
  return new ScriptAdapter(script);
}

test('D3.5.3b.2 委派：目标正常完成，任务 completed 且带真实结果消息', async () => {
  const fixture = makeFixture();
  resetTaskRuntime();

  try {
    bindTarget(fixture, fixture.dir);
    const adapter = makeAdapter(STREAM);

    const task = makeTask(fixture);
    const result = await executeTask(fixture.temp.db, task, { adapter });

    assert.equal(result.task.status, 'completed');
    assert.ok(result.task.result_message_id, '必须有结果消息 id');
    assert.equal(result.task.delivery_status, 'pending', '交付由 MCP Server 确认，不是这里');
    assert.match(String(result.resultText), /第一段/);

    const message = fixture.temp.db
      .prepare('SELECT conversation_id, message_type FROM messages WHERE id = ?')
      .get(result.task.result_message_id) as { conversation_id: string; message_type: string };
    assert.equal(message.conversation_id, fixture.conversationId);
    assert.equal(message.message_type, 'agent_final');

    const session = findSession(fixture.temp.db, fixture.conversationId, 'codex');
    assert.equal(session?.status, 'idle');
    assert.equal(session?.quarantine_reason, null, '正常退出不得隔离');
  } finally {
    fixture.temp.cleanup();
  }
});

test('D3.5.3b.2 委派：目标报错，任务 failed 且原因交回调用方', async () => {
  const fixture = makeFixture();
  resetTaskRuntime();

  try {
    bindTarget(fixture, fixture.dir);
    const adapter = makeAdapter(FAIL);
    const result = await executeTask(fixture.temp.db, makeTask(fixture), { adapter });

    assert.equal(result.task.status, 'failed');
    assert.match(String(result.task.error_text), /provider rejected/);
    assert.equal(result.resultText, null);
  } finally {
    fixture.temp.cleanup();
  }
});

test('D3.5.3b.2 委派：超时写 timeout，进程被正常终止，不进入隔离', async () => {
  const fixture = makeFixture();
  resetTaskRuntime();

  const previous = process.env.TRINITY_DELEGATION_TIMEOUT_MS;
  process.env.TRINITY_DELEGATION_TIMEOUT_MS = '1000';

  try {
    bindTarget(fixture, fixture.dir);
    const adapter = makeAdapter(SLOW);
    const result = await executeTask(fixture.temp.db, makeTask(fixture), { adapter });

    assert.equal(result.task.status, 'timeout');
    assert.equal(result.task.error_text, 'timeout');

    const session = findSession(fixture.temp.db, fixture.conversationId, 'codex');
    assert.equal(session?.quarantine_reason, null, '进程确认退出就不该隔离');
  } finally {
    process.env.TRINITY_DELEGATION_TIMEOUT_MS = previous;
    if (previous === undefined) delete process.env.TRINITY_DELEGATION_TIMEOUT_MS;
    fixture.temp.cleanup();
  }
});

test('D3.5.3b.2 委派：目标未绑定 / 没有工作目录都明确失败', async () => {
  const fixture = makeFixture();
  resetTaskRuntime();

  try {
    const adapter = makeAdapter(STREAM);
    const unbound = await executeTask(fixture.temp.db, makeTask(fixture), { adapter });
    assert.equal(unbound.task.status, 'failed');
    assert.equal(unbound.task.error_text, 'target_unbound');

    bindTarget(fixture, null);
    const noCwd = await executeTask(fixture.temp.db, makeTask(fixture), { adapter });
    assert.equal(noCwd.task.status, 'failed');
    assert.equal(noCwd.task.error_text, 'target_cwd_missing');
  } finally {
    fixture.temp.cleanup();
  }
});

test('D3.5.3b.2 隔离：未确认退出后会话锁保留，TTL 也不解除，重启仍在', () => {
  const temp = createTempDatabase();

  try {
    const conversation = createConversation(temp.db, { title: '隔离' });
    const { session } = activateBinding(temp.db, conversation.id, {
      harnessType: 'codex',
      cwd: temp.dir,
      model: null,
    });

    const lock = acquireRunLock(temp.db, session.id, 'run-1');

    // 模拟 kill 之后 close 一直没到
    settleSessionAfterRun(temp.db, session.id, lock.id, { exitConfirmed: false, pid: 4242 });

    const after = findSession(temp.db, conversation.id, 'codex');
    assert.equal(after?.quarantine_reason, 'process_exit_unconfirmed');
    assert.equal(after?.quarantine_pid, 4242);

    const held = temp.db
      .prepare("SELECT COUNT(*) AS n FROM harness_session_locks WHERE harness_session_id = ? AND status = 'held'")
      .get(session.id) as { n: number };
    assert.equal(held.n, 1, '锁必须保留，不能释放');

    // 把锁的过期时间改到过去：TTL 只管锁，不管隔离
    temp.db
      .prepare("UPDATE harness_session_locks SET expires_at = '2000-01-01T00:00:00.000Z' WHERE harness_session_id = ?")
      .run(session.id);

    assert.throws(() => acquireRunLock(temp.db, session.id, 'run-2'), /quarantined/);

    // 重开数据库：隔离是持久列，仍在
    temp.close();
    const reopened = openDatabase(temp.path);
    try {
      assert.throws(() => acquireRunLock(reopened, session.id, 'run-3'), /quarantined/);

      const cleared = clearQuarantine(reopened, session.id, {
        reason: '人工确认进程已退出',
        actor: { type: 'user' },
      });
      assert.equal(cleared, true);

      assert.doesNotThrow(() => acquireRunLock(reopened, session.id, 'run-4'));
    } finally {
      reopened.close();
    }
  } finally {
    temp.cleanup();
  }
});

test('D3.5.3b.2 隔离：确认退出则正常释放锁，不进隔离', () => {
  const temp = createTempDatabase();

  try {
    const conversation = createConversation(temp.db, { title: '正常' });
    const { session } = activateBinding(temp.db, conversation.id, {
      harnessType: 'codex',
      cwd: temp.dir,
      model: null,
    });

    const lock = acquireRunLock(temp.db, session.id, 'run-1');
    settleSessionAfterRun(temp.db, session.id, lock.id, { exitConfirmed: true, pid: 1 });

    assert.equal(findSession(temp.db, conversation.id, 'codex')?.quarantine_reason, null);
    assert.doesNotThrow(() => acquireRunLock(temp.db, session.id, 'run-2'));
  } finally {
    temp.cleanup();
  }
});

test('D3.5.3b.2 内部接口：POST 阻塞到目标完成并返回结果正文', async () => {
  const temp = createTempDatabase();
  resetTokens();
  resetTaskRuntime();

  const server = await startTestServer(temp.db, { getAdapter: () => makeAdapter(STREAM) });

  try {
    const conversation = createConversation(temp.db, { title: '阻塞' });
    activateBinding(temp.db, conversation.id, {
      harnessType: 'codex',
      cwd: temp.dir,
      model: null,
    });
    const entry = issueToken({
      conversationId: conversation.id,
      sourceAgent: 'claude',
      sourceTurnId: 'turn-source',
    });

    const response = await fetch(`${server.baseUrl}/api/internal/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${entry.token}` },
      body: JSON.stringify({
        request_id: 'req-block',
        target_agent: 'codex',
        instruction: '检查迁移文件',
      }),
    });

    assert.equal(response.status, 201);
    const body = (await response.json()) as Record<string, unknown>;

    assert.equal(body.status, 'completed');
    assert.match(String(body.result), /第一段/);

    const row = findTask(temp.db, String(body.task_id));
    assert.equal(row?.status, 'completed');
    assert.ok(row?.result_message_id);
  } finally {
    await server.close();
    temp.cleanup();
  }
});

test('D3.5.3b.2 委派超时：默认 5 分钟，可配置且拒绝非法值', () => {
  assert.equal(resolveDelegationTimeout({} as NodeJS.ProcessEnv), 5 * 60 * 1000);
  assert.equal(
    resolveDelegationTimeout({ TRINITY_DELEGATION_TIMEOUT_MS: '2000' } as NodeJS.ProcessEnv),
    2000,
  );
  assert.equal(
    resolveDelegationTimeout({ TRINITY_DELEGATION_TIMEOUT_MS: 'oops' } as NodeJS.ProcessEnv),
    5 * 60 * 1000,
  );
});

test('D3.5.3b.3 配置：临时文件带令牌，清理时文件删除且令牌失效', () => {
  resetTokens();

  const config = writeDelegationConfig({
    conversationId: 'conv-x',
    sourceTurnId: 'turn-x',
    ttlMs: 60_000,
    coreBaseUrl: 'http://127.0.0.1:9999',
  });

  const raw = JSON.parse(readFileSync(config.configPath, 'utf8')) as {
    mcpServers: { trinity: { command: string; args: string[]; env: Record<string, string> } };
  };

  assert.equal(raw.mcpServers.trinity.env.TRINITY_CORE_URL, 'http://127.0.0.1:9999');
  assert.equal(raw.mcpServers.trinity.env.TRINITY_TOKEN, config.token);
  assert.ok(raw.mcpServers.trinity.args[0]?.endsWith('server.ts'));
  assert.equal(validateToken(config.token).ok, true);

  removeDelegationConfig(config);

  assert.equal(existsSync(config.configPath), false, '配置文件必须删除');
  assert.equal(validateToken(config.token).ok, false, '令牌必须同时失效');
});

test('D3.5.3b.3 Claude：只有拿到配置时才注入 strict 与 mcp-config', () => {
  const dir = mkdtempSync(join(tmpdir(), 'claude-args-'));
  const bin = join(dir, 'claude.exe');
  writeFileSync(bin, '');

  try {
    const adapter = new ClaudeAdapter({
      TRINITY_CLAUDE_BIN: bin,
      TRINITY_CLAUDE_AUTH_TOKEN: 'token_1234567890',
      TRINITY_CLAUDE_BASE_URL: 'https://example.invalid',
    } as NodeJS.ProcessEnv);

    const withMcp = adapter.buildCommand({
      prompt: 'p',
      cwd: dir,
      nativeSessionId: null,
      model: null,
      mcpConfigPath: 'C:/tmp/cfg.json',
    });

    assert.ok(withMcp.args.includes('--strict-mcp-config'));
    assert.equal(withMcp.args[withMcp.args.indexOf('--mcp-config') + 1], 'C:/tmp/cfg.json');

    const without = adapter.buildCommand({
      prompt: 'p',
      cwd: dir,
      nativeSessionId: null,
      model: null,
    });

    assert.equal(without.args.includes('--mcp-config'), false);
    assert.equal(without.args.includes('--strict-mcp-config'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('系统级角色规则：Claude 追加 system prompt，Codex 走 developer_instructions', () => {
  const dir = mkdtempSync(join(tmpdir(), 'role-args-'));
  const bin = join(dir, 'claude.exe');
  writeFileSync(bin, '');

  try {
    const adapter = new ClaudeAdapter({
      TRINITY_CLAUDE_BIN: bin,
      TRINITY_CLAUDE_AUTH_TOKEN: 'token_1234567890',
      TRINITY_CLAUDE_BASE_URL: 'https://example.invalid',
    } as NodeJS.ProcessEnv);

    const claude = adapter.buildCommand({
      prompt: 'p',
      cwd: dir,
      nativeSessionId: null,
      model: null,
      systemAppend: 'RULE_MARKER',
      allowedTools: ['Read', 'Glob', 'Grep'],
    });

    const at = claude.args.indexOf('--append-system-prompt');
    assert.ok(at >= 0);
    assert.equal(claude.args[at + 1], 'RULE_MARKER');

    const toolsAt = claude.args.indexOf('--allowedTools');
    assert.ok(toolsAt >= 0);
    assert.deepEqual(claude.args.slice(toolsAt + 1, toolsAt + 4), ['Read', 'Glob', 'Grep']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  const codex = buildCodexArgs(
    {
      prompt: 'p',
      cwd: 'C:/w',
      nativeSessionId: null,
      model: null,
      systemAppend: 'RULE_MARKER',
    },
    'read-only',
  );

  const developer = codex.find((arg) => arg.startsWith('developer_instructions='));
  assert.ok(developer, 'Codex 必须收到 developer_instructions');
  assert.ok(developer.includes('RULE_MARKER'));
  assert.equal(codex.at(-1), 'p', '用户提示仍是最后一个参数');
});

test('D3.5.3b.2 Codex 沙箱：默认只读，只有两种合法取值，危险模式被拒', () => {
  assert.equal(resolveCodexSandbox({} as NodeJS.ProcessEnv), 'read-only');
  assert.equal(
    resolveCodexSandbox({ TRINITY_CODEX_SANDBOX: '  workspace-write  ' } as NodeJS.ProcessEnv),
    'workspace-write',
  );

  assert.throws(
    () => resolveCodexSandbox({ TRINITY_CODEX_SANDBOX: 'danger-full-access' } as NodeJS.ProcessEnv),
    /must be one of/,
  );
  assert.throws(
    () => resolveCodexSandbox({ TRINITY_CODEX_SANDBOX: 'nonsense' } as NodeJS.ProcessEnv),
    /must be one of/,
  );
});

test('D3.5.3b.2 Codex 沙箱：新会话与续接都带 sandbox_mode', () => {
  const fresh = buildCodexArgs(
    { prompt: 'p', cwd: 'C:/w', nativeSessionId: null, model: null },
    'read-only',
  );
  assert.deepEqual(fresh.slice(0, 5), ['exec', '--json', '--skip-git-repo-check', '-C', 'C:/w']);
  assert.ok(fresh.includes('sandbox_mode="read-only"'));

  const resumed = buildCodexArgs(
    { prompt: 'p', cwd: 'C:/w', nativeSessionId: 'sid-1', model: null },
    'workspace-write',
  );
  assert.deepEqual(resumed.slice(0, 4), ['exec', 'resume', 'sid-1', '--json']);
  assert.ok(resumed.includes('sandbox_mode="workspace-write"'));
});

test('D3.5.3b.2 隔离：只有显式隔离函数会改状态，普通 setStatus 不会', () => {
  const temp = createTempDatabase();

  try {
    const conversation = createConversation(temp.db, { title: '边界' });
    const { session } = activateBinding(temp.db, conversation.id, {
      harnessType: 'codex',
      cwd: temp.dir,
      model: null,
    });

    quarantineSession(temp.db, session.id, 'manual_test', null);
    assert.equal(findSession(temp.db, conversation.id, 'codex')?.quarantine_reason, 'manual_test');

    // clearQuarantine 对没有隔离的会话返回 false，不写日志
    assert.equal(clearQuarantine(temp.db, session.id, { reason: 'x', actor: { type: 'user' } }), true);
    assert.equal(clearQuarantine(temp.db, session.id, { reason: 'x', actor: { type: 'user' } }), false);

    const logs = temp.db
      .prepare("SELECT COUNT(*) AS n FROM change_log WHERE entity_type = 'harness_session' AND payload_json LIKE '%quarantin%'")
      .get() as { n: number };
    assert.ok(logs.n >= 2, '隔离与解除都要留痕');
  } finally {
    temp.cleanup();
  }
});

test('D3.5.3 安全：伪造 Host 头不能改变 MCP 回调地址', async () => {
  const temp = createTempDatabase();
  resetTokens();
  resetTaskRuntime();

  const adapter = new RecordingClaudeAdapter();
  const server = await startTestServer(temp.db, { getAdapter: () => adapter });

  try {
    const conversation = createConversation(temp.db, { title: 'Host 伪造' });

    // A bound target makes delegation possible, so the turn does inject config.
    activateBinding(temp.db, conversation.id, { harnessType: 'codex', cwd: temp.dir, model: null });
    activateBinding(temp.db, conversation.id, { harnessType: 'claude', cwd: temp.dir, model: null });

    const response = await postTurn(server.baseUrl, conversation.id, 'attacker.example');

    const injected = adapter.injected;
    assert.ok(injected, '有目标 Agent 时必须注入 MCP 配置');
    assert.equal(
      injected.coreUrl,
      server.baseUrl,
      '回调地址必须来自实际监听套接字，而不是请求头',
    );
    assert.equal(injected.coreUrl.includes('attacker'), false);
    assert.ok(injected.token.length > 0, '配置里必须带着本次委派令牌');

    await waitForIdle(temp.db, conversation.id, 'claude');
    assert.equal(existsSync(injected.configPath), false, 'turn 结束后临时配置必须删除');
  } finally {
    await server.close();
    temp.cleanup();
  }
});

test('D3.5.3 行为：只有对话里另有 Agent 时才注入 MCP 配置', async () => {
  const temp = createTempDatabase();
  resetTokens();
  resetTaskRuntime();

  const adapter = new RecordingClaudeAdapter();
  const server = await startTestServer(temp.db, { getAdapter: () => adapter });

  try {
    const solo = createConversation(temp.db, { title: '单 Agent' });
    activateBinding(temp.db, solo.id, { harnessType: 'claude', cwd: temp.dir, model: null });

    const soloTurn = await postTurn(server.baseUrl, solo.id, '127.0.0.1');
    assert.equal(soloTurn.status, 202);
    assert.equal(adapter.buildCount, 1, '单 Agent 对话仍然正常启动');
    assert.equal(adapter.injected, null, '没有委派目标时不得注入配置');
    await waitForIdle(temp.db, solo.id, 'claude');

    const paired = createConversation(temp.db, { title: '双 Agent' });
    activateBinding(temp.db, paired.id, { harnessType: 'codex', cwd: temp.dir, model: null });
    activateBinding(temp.db, paired.id, { harnessType: 'claude', cwd: temp.dir, model: null });

    const pairedTurn = await postTurn(server.baseUrl, paired.id, '127.0.0.1');
    assert.equal(pairedTurn.status, 202);
    assert.equal(adapter.buildCount, 2);
    assert.ok(adapter.injected, '存在其他 Agent 时必须注入配置');
    await waitForIdle(temp.db, paired.id, 'claude');
  } finally {
    await server.close();
    temp.cleanup();
  }
});
