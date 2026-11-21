import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { createConversation } from '../src/conversations/conversation.service.ts';
import { parseClaudeLine } from '../src/harnesses/claude.adapter.ts';
import { activateBinding } from '../src/harnesses/session.service.ts';
import { resetTaskRuntime } from '../src/harnesses/task.runtime.ts';
import { issueToken, resetTokens } from '../src/harnesses/token.service.ts';
import type {
  HarnessAdapter,
  HarnessCommand,
  HarnessStreamFrame,
  HarnessTurnInput,
} from '../src/harnesses/types.ts';
import { createTempDatabase, startTestServer, type TempDatabase } from './helpers.ts';

const SERVER_PATH = resolve(import.meta.dirname, '..', 'src', 'mcp', 'server.ts');
const STREAM = resolve(import.meta.dirname, 'fixtures', 'emit-stream.mjs');

class ScriptAdapter implements HarnessAdapter {
  readonly type = 'codex' as const;
  readonly displayName = 'Codex';
  resolveExecutable(): { file: string; source: string } {
    return { file: process.execPath, source: 'test' };
  }
  buildCommand(_input: HarnessTurnInput): HarnessCommand {
    return { file: process.execPath, args: [STREAM], env: {} };
  }
  parseLine(line: string): HarnessStreamFrame | null {
    return parseClaudeLine(line);
  }
}

interface Client {
  child: ChildProcess;
  send(message: unknown): void;
  sendRaw(text: string): void;
  next(timeoutMs?: number): Promise<Record<string, unknown>>;
  stderr(): string;
  invalidLines(): string[];
  exit(): Promise<number | null>;
}

function startClient(baseUrl: string, token: string): Client {
  const child = spawn(process.execPath, [SERVER_PATH], {
    env: { ...process.env, TRINITY_CORE_URL: baseUrl, TRINITY_TOKEN: token },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  const queue: string[] = [];
  const waiters: Array<(line: string) => void> = [];
  let stderr = '';
  const invalid: string[] = [];

  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    stderr += chunk;
  });

  const reader = createInterface({ input: child.stdout!, crlfDelay: Infinity });
  reader.on('line', (line) => {
    const trimmed = line.trim();
    if (trimmed === '') return;

    // Every stdout line must be a protocol message; anything else is a defect.
    try {
      JSON.parse(trimmed);
    } catch {
      invalid.push(trimmed);
    }

    const waiter = waiters.shift();
    if (waiter) waiter(trimmed);
    else queue.push(trimmed);
  });

  return {
    child,
    send(message) {
      child.stdin!.write(`${JSON.stringify(message)}\n`);
    },
    sendRaw(text) {
      child.stdin!.write(`${text}\n`);
    },
    next(timeoutMs = 5000) {
      const queued = queue.shift();
      if (queued !== undefined) return Promise.resolve(JSON.parse(queued) as Record<string, unknown>);

      return new Promise((resolveNext, rejectNext) => {
        const timer = setTimeout(() => rejectNext(new Error('timed out waiting for a response')), timeoutMs);

        waiters.push((line) => {
          clearTimeout(timer);
          resolveNext(JSON.parse(line) as Record<string, unknown>);
        });
      });
    },
    stderr: () => stderr,
    invalidLines: () => [...invalid],
    exit() {
      return new Promise((resolveExit) => {
        if (child.exitCode !== null) {
          resolveExit(child.exitCode);
          return;
        }
        child.on('close', (code) => resolveExit(code));
      });
    },
  };
}

async function withServer(run: (ctx: {
  temp: TempDatabase;
  baseUrl: string;
  token: string;
  client: () => Client;
}) => Promise<void>): Promise<void> {
  resetTokens();
  resetTaskRuntime();
  const temp = createTempDatabase();
  const server = await startTestServer(temp.db, { getAdapter: () => new ScriptAdapter() });
  const conversation = createConversation(temp.db, { title: 'MCP' });

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

  const clients: Client[] = [];

  try {
    await run({
      temp,
      baseUrl: server.baseUrl,
      token: entry.token,
      client: () => {
        const client = startClient(server.baseUrl, entry.token);
        clients.push(client);
        return client;
      },
    });
  } finally {
    for (const client of clients) {
      if (client.child.exitCode === null) client.child.kill();
    }
    await server.close();
    temp.cleanup();
  }
}

test('D3.5.3b.1 协议：initialize 返回协议版本与服务器信息', async () => {
  await withServer(async ({ client }) => {
    const mcp = client();
    mcp.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } });

    const response = await mcp.next();
    assert.equal(response.id, 1);

    const result = response.result as Record<string, unknown>;
    assert.equal(result.protocolVersion, '2024-11-05');
    assert.deepEqual(result.capabilities, { tools: {} });
    assert.equal((result.serverInfo as Record<string, unknown>).name, 'trinity');
  });
});

test('D3.5.3b.1 协议：通知不产生响应，紧接的请求正常回复', async () => {
  await withServer(async ({ client }) => {
    const mcp = client();
    mcp.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    mcp.send({ jsonrpc: '2.0', id: 2, method: 'ping' });

    const response = await mcp.next();
    assert.equal(response.id, 2, '第一条回复必须是 ping，通知不得插话');
    assert.deepEqual(response.result, {});
  });
});

test('D3.5.3b.1 协议：tools/list 只暴露 delegate_task', async () => {
  await withServer(async ({ client }) => {
    const mcp = client();
    mcp.send({ jsonrpc: '2.0', id: 3, method: 'tools/list' });

    const response = await mcp.next();
    const tools = (response.result as { tools: Array<Record<string, unknown>> }).tools;

    assert.equal(tools.length, 1);
    assert.equal(tools[0]?.name, 'delegate_task');

    const schema = tools[0]?.inputSchema as { properties: Record<string, unknown>; required: string[] };
    assert.deepEqual(Object.keys(schema.properties).sort(), ['instruction', 'target_agent', 'title']);
    assert.deepEqual(schema.required.sort(), ['instruction', 'target_agent']);
    assert.equal(Object.hasOwn(schema.properties, 'source_agent'), false, '不得接受身份参数');
  });
});

test('D3.5.3b.1 协议：tools/call 走真实 HTTP，任务落库', async () => {
  await withServer(async ({ client, temp }) => {
    const mcp = client();

    mcp.send({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: {
        name: 'delegate_task',
        arguments: { target_agent: 'codex', instruction: '检查数据库迁移', title: '迁移检查' },
      },
    });

    const response = await mcp.next();
    const content = (response.result as { content: Array<{ type: string; text: string }> }).content;

    assert.equal(content[0]?.type, 'text');
    assert.match(String(content[0]?.text), /Task .* completed/);
    assert.match(String(content[0]?.text), /第一段/, '结果正文要回到模型');

    const rows = temp.db.prepare('SELECT * FROM agent_tasks').all() as Array<Record<string, unknown>>;
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.target_agent, 'codex');
    assert.equal(rows[0]?.source_agent, 'claude');
    assert.equal(rows[0]?.title, '迁移检查');
    assert.equal(rows[0]?.status, 'completed');
    assert.ok(rows[0]?.result_message_id);

    // 结果写回 stdout 之后，server 才去确认交付
    for (let i = 0; i < 60; i += 1) {
      const row = temp.db.prepare('SELECT delivery_status FROM agent_tasks').get() as {
        delivery_status: string;
      };
      if (row.delivery_status === 'delivered') break;
      await new Promise((done) => setTimeout(done, 50));
    }

    const delivered = temp.db.prepare('SELECT delivery_status FROM agent_tasks').get() as {
      delivery_status: string;
    };
    assert.equal(delivered.delivery_status, 'delivered');
  });
});

test('D3.5.3b.1 协议：未知工具与未知方法各自返回正确的 JSON-RPC 错误', async () => {
  await withServer(async ({ client }) => {
    const mcp = client();

    mcp.send({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'nope', arguments: {} } });
    const unknownTool = await mcp.next();
    assert.equal((unknownTool.error as { code: number }).code, -32602);

    mcp.send({ jsonrpc: '2.0', id: 6, method: 'does/not/exist' });
    const unknownMethod = await mcp.next();
    assert.equal((unknownMethod.error as { code: number }).code, -32601);
  });
});

test('D3.5.3b.1 协议：非法 JSON 返回 -32700 且 id 为 null', async () => {
  await withServer(async ({ client }) => {
    const mcp = client();
    mcp.sendRaw('{ not json');

    const response = await mcp.next();
    assert.equal(response.id, null);
    assert.equal((response.error as { code: number }).code, -32700);
  });
});

test('D3.5.3b.1 协议：业务失败走 content 而不是协议错误', async () => {
  await withServer(async ({ client }) => {
    const mcp = client();

    mcp.send({
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name: 'delegate_task', arguments: { target_agent: 'gemini', instruction: 'x' } },
    });

    const response = await mcp.next();
    assert.equal(response.error, undefined, '业务失败不应是 JSON-RPC 错误');

    const result = response.result as { content: Array<{ text: string }>; isError?: boolean };
    assert.equal(result.isError, true);
    assert.match(String(result.content[0]?.text), /Delegation refused/);
  });
});

test('D3.5.3b.1 协议：stdin EOF 后正常退出，stdout 全程只有协议消息', async () => {
  await withServer(async ({ client }) => {
    const mcp = client();
    mcp.send({ jsonrpc: '2.0', id: 8, method: 'initialize', params: {} });
    await mcp.next();

    mcp.child.stdin!.end();
    const code = await mcp.exit();

    assert.equal(code, 0);
    assert.deepEqual(mcp.invalidLines(), [], 'stdout 只能有协议消息，任何非 JSON 行都是缺陷');
    assert.equal(mcp.stderr().includes('uncaught'), false);
  });
});
