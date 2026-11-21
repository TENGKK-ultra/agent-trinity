import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';
import {
  DEFAULT_DELEGATION_TIMEOUT_MS,
  resolveDelegationTimeout,
  resolveMcpWaitTimeout,
} from '../src/harnesses/delegation.timeouts.ts';

const SERVER_PATH = resolve(import.meta.dirname, '..', 'src', 'mcp', 'server.ts');
const WAIT_MARGIN_MS = 60 * 1000;
const TEST_WAIT_MS = 1500;

async function listen(server: Server): Promise<number> {
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', () => done()));
  const address = server.address();
  return typeof address === 'object' && address !== null ? address.port : 0;
}

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((done) => server.close(() => done()));
}

/** Runs one delegate_task against `port` and reports what the tool returned. */
async function callDelegate(port: number): Promise<{
  text: string;
  isError: boolean;
  elapsedMs: number;
}> {
  const child = spawn(process.execPath, [SERVER_PATH], {
    env: {
      ...process.env,
      TRINITY_CORE_URL: `http://127.0.0.1:${port}`,
      TRINITY_TOKEN: 'test-token-123456',
      TRINITY_MCP_WAIT_MS: String(TEST_WAIT_MS),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  try {
    const lines: string[] = [];
    const reader = createInterface({ input: child.stdout!, crlfDelay: Infinity });
    reader.on('line', (line) => lines.push(line));

    const next = async (timeoutMs: number): Promise<Record<string, unknown>> => {
      const deadline = Date.now() + timeoutMs;

      while (Date.now() < deadline) {
        const index = lines.findIndex((line) => line.includes('"result"') || line.includes('"error"'));
        if (index >= 0) {
          const [line] = lines.splice(index, 1);
          if (line !== undefined) return JSON.parse(line) as Record<string, unknown>;
        }
        await new Promise((r) => setTimeout(r, 25));
      }

      throw new Error('the MCP server never answered');
    };

    child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`);
    await next(5000);

    const started = Date.now();
    child.stdin!.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'delegate_task', arguments: { target_agent: 'codex', instruction: 'x' } },
      })}\n`,
    );

    const response = await next(10_000);
    const elapsedMs = Date.now() - started;
    const result = response.result as { content: Array<{ text: string }>; isError?: boolean };

    return {
      text: result.content[0]?.text ?? '',
      isError: result.isError === true,
      elapsedMs,
    };
  } finally {
    child.kill();
  }
}

test('B1 超时：调用方等待上限默认高于执行上限，且不能被配得更短', () => {
  assert.equal(resolveDelegationTimeout({} as NodeJS.ProcessEnv), DEFAULT_DELEGATION_TIMEOUT_MS);

  assert.equal(
    resolveMcpWaitTimeout({} as NodeJS.ProcessEnv),
    DEFAULT_DELEGATION_TIMEOUT_MS + WAIT_MARGIN_MS,
    '默认等待 = 执行上限 + 1 分钟',
  );

  assert.equal(
    resolveMcpWaitTimeout({
      TRINITY_DELEGATION_TIMEOUT_MS: '600000',
      TRINITY_MCP_WAIT_MS: '650000',
    } as NodeJS.ProcessEnv),
    660000,
    '低于执行上限的等待配置会被抬到执行上限 + 1 分钟',
  );

  assert.equal(
    resolveMcpWaitTimeout({ TRINITY_MCP_WAIT_MS: 'oops' } as NodeJS.ProcessEnv),
    DEFAULT_DELEGATION_TIMEOUT_MS + WAIT_MARGIN_MS,
  );
});

test('B1 超时：Core 不应答时按配置等待，不会等到默认 300 秒', async () => {
  const fakeCore = createServer((req) => {
    req.resume();
  });
  const port = await listen(fakeCore);

  try {
    const result = await callDelegate(port);

    assert.equal(result.isError, true);
    assert.match(result.text, /\[mcp_wait_timeout\]/);
    assert.ok(result.elapsedMs < 5000, `实际耗时 ${result.elapsedMs}ms`);
    assert.ok(result.elapsedMs >= 1000, `不应早于配置的等待上限失败，实际 ${result.elapsedMs}ms`);
  } finally {
    await closeServer(fakeCore);
  }
});

test('B1 超时：即使 Core 持续发送数据，也在绝对上限处停止', async () => {
  // The socket never goes idle, so only an absolute deadline can bound the wait.
  const streamingCore = createServer((req, res) => {
    req.resume();
    res.writeHead(200, { 'content-type': 'application/json' });
    const timer = setInterval(() => res.write(' '), 300);

    res.on('close', () => clearInterval(timer));
  });
  const port = await listen(streamingCore);

  try {
    const result = await callDelegate(port);

    assert.equal(result.isError, true);
    assert.match(result.text, /\[mcp_wait_timeout\]/);
    assert.ok(result.elapsedMs < 5000, `实际耗时 ${result.elapsedMs}ms`);
  } finally {
    await closeServer(streamingCore);
  }
});
