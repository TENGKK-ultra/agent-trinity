import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { createInterface } from 'node:readline';

/*
 * Minimal MCP stdio server. It speaks newline-delimited JSON-RPC on stdin and
 * stdout, exposes exactly one tool, and never touches anything but the Core
 * internal endpoint.
 *
 * stdout carries protocol messages only. Every diagnostic goes to stderr —
 * one stray console.log on stdout corrupts the stream for the client.
 */

const CORE_URL = (process.env.TRINITY_CORE_URL ?? '').trim() || 'http://127.0.0.1:3210';
const TOKEN = (process.env.TRINITY_TOKEN ?? '').trim();

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_INFO = { name: 'trinity', version: '0.1.0' };
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'timeout', 'cancelled']);

/*
 * The wait limit is explicit. Node's fetch applies a silent 300s response-header
 * timeout that cannot be configured without a dispatcher, which killed every
 * delegation longer than five minutes while the task kept running.
 */
const DEFAULT_WAIT_MS = 35 * 60 * 1000;
const MAX_WAIT_MS = 2 * 60 * 60 * 1000;

function resolveWaitMs(env: NodeJS.ProcessEnv): number {
  const parsed = Number(env.TRINITY_MCP_WAIT_MS ?? '');
  if (!Number.isFinite(parsed) || parsed < 1000 || parsed > MAX_WAIT_MS) {
    return DEFAULT_WAIT_MS;
  }

  return Math.floor(parsed);
}

const WAIT_MS = resolveWaitMs(process.env);

const DELEGATE_TOOL = {
  name: 'delegate_task',
  description:
    'Ask another agent in this conversation to complete a self-contained task, and return its result. Blocks until that agent finishes, fails or times out. Give the complete instruction, including absolute paths when files are involved.',
  inputSchema: {
    type: 'object',
    properties: {
      target_agent: {
        type: 'string',
        enum: ['codex', 'deepseek'],
        description: 'The agent that should do the work.',
      },
      instruction: {
        type: 'string',
        description: 'The complete task, written so the agent can act without asking back.',
      },
      title: {
        type: 'string',
        description: 'Short label shown on the task card.',
      },
    },
    required: ['target_agent', 'instruction'],
  },
};

if (TOKEN === '') {
  console.error('trinity-mcp: TRINITY_TOKEN is not set; refusing to start');
  process.exit(1);
}

function write(message: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    process.stdout.write(`${JSON.stringify(message)}\n`, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

process.stdout.on('error', (err) => {
  console.error('trinity-mcp: stdout failed, the protocol is broken:', err.message);
  process.exit(1);
});

interface DelegateOutcome {
  ok: boolean;
  text: string;
  taskId: string | null;
  terminal: boolean;
}

function describe(body: Record<string, unknown>): string {
  const taskId = String(body.task_id ?? '');
  const status = String(body.status ?? 'unknown');
  const result = typeof body.result === 'string' ? body.result : null;

  if (result !== null) return `Task ${taskId} ${status}.\n\n${result}`;

  return `Task ${taskId} created with status ${status}.`;
}

interface CoreResponse {
  status: number;
  body: Record<string, unknown> | null;
}

function postJson(path: string, payload: unknown, timeoutMs: number): Promise<CoreResponse> {
  return new Promise((resolve, reject) => {
    const url = new URL(CORE_URL);
    const body = JSON.stringify(payload);
    const port = url.port === '' ? 80 : Number(url.port);

    let settled = false;
    let deadline: ReturnType<typeof setTimeout> | null = null;

    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      if (deadline) clearTimeout(deadline);
      fn();
    };

    const req = httpRequest(
      {
        hostname: url.hostname,
        port,
        path,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          authorization: `Bearer ${TOKEN}`,
        },
        // Idle guard only: a server that keeps sending bytes resets it.
        timeout: timeoutMs,
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          text += chunk;
        });
        res.on('end', () => {
          let parsed: Record<string, unknown> | null = null;

          try {
            parsed = text === '' ? null : (JSON.parse(text) as Record<string, unknown>);
          } catch {
            parsed = null;
          }

          settle(() => resolve({ status: res.statusCode ?? 0, body: parsed }));
        });
        res.on('error', (err) => settle(() => reject(err)));
      },
    );

    // Absolute deadline: the wait is bounded even while data is still arriving.
    deadline = setTimeout(() => {
      settle(() => reject(new Error('mcp_wait_timeout')));
      req.destroy();
    }, timeoutMs);

    req.on('timeout', () => {
      settle(() => reject(new Error('mcp_wait_timeout')));
      req.destroy();
    });
    req.on('error', (err) => settle(() => reject(err)));
    req.end(body);
  });
}

async function delegate(args: Record<string, unknown>): Promise<DelegateOutcome> {
  let response: CoreResponse;

  try {
    response = await postJson(
      '/api/internal/tasks',
      {
        request_id: randomUUID(),
        target_agent: args.target_agent,
        instruction: args.instruction,
        title: args.title,
      },
      WAIT_MS,
    );
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);

    if (detail === 'mcp_wait_timeout') {
      return {
        ok: false,
        text: `[mcp_wait_timeout] The delegated task did not finish within ${Math.round(
          WAIT_MS / 1000,
        )}s. It may still be running; do not submit it again as a new task.`,
        taskId: null,
        terminal: false,
      };
    }

    return {
      ok: false,
      text: `[mcp_unreachable] Could not reach Trinity Core: ${detail}`,
      taskId: null,
      terminal: false,
    };
  }

  const { status, body } = response;

  if (status < 200 || status >= 300 || body === null) {
    const error = (body?.error ?? {}) as Record<string, unknown>;
    const code = String(error.code ?? 'http_error');
    const message = String(error.message ?? `status ${status}`);
    return { ok: false, text: `Delegation refused (${code}): ${message}`, taskId: null, terminal: false };
  }

  return {
    ok: true,
    text: describe(body),
    taskId: String(body.task_id ?? ''),
    terminal: TERMINAL_STATUSES.has(String(body.status ?? '')),
  };
}

/**
 * Only called after the tool result has been written to stdout. That write is
 * the last thing this process can observe, so it is the only honest moment to
 * claim delivery.
 */
async function confirmDelivered(taskId: string): Promise<void> {
  try {
    await fetch(`${CORE_URL}/api/internal/tasks/${encodeURIComponent(taskId)}/delivered`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
  } catch {
    // Nothing the model should see: an unconfirmed delivery is recorded by the
    // startup sweep as failed, which is the truthful outcome.
  }
}

async function handleMessage(raw: string): Promise<void> {
  let message: Record<string, unknown>;

  try {
    message = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    await write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }

  if (typeof message !== 'object' || message === null || typeof message.method !== 'string') {
    if ('id' in message) {
      await write({
        jsonrpc: '2.0',
        id: (message.id as string | number | null) ?? null,
        error: { code: -32600, message: 'Invalid Request' },
      });
    }
    return;
  }

  const hasId = message.id !== undefined && message.id !== null;
  const id = message.id as string | number;

  switch (message.method) {
    case 'initialize':
      if (!hasId) return;
      await write({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        },
      });
      return;

    case 'notifications/initialized':
      return;

    case 'ping':
      if (hasId) await write({ jsonrpc: '2.0', id, result: {} });
      return;

    case 'tools/list':
      if (hasId) await write({ jsonrpc: '2.0', id, result: { tools: [DELEGATE_TOOL] } });
      return;

    case 'tools/call': {
      if (!hasId) return;

      const params = (message.params ?? {}) as Record<string, unknown>;

      if (params.name !== 'delegate_task') {
        await write({
          jsonrpc: '2.0',
          id,
          error: { code: -32602, message: `Unknown tool: ${String(params.name)}` },
        });
        return;
      }

      const args =
        typeof params.arguments === 'object' && params.arguments !== null
          ? (params.arguments as Record<string, unknown>)
          : {};

      const outcome = await delegate(args);

      await write({
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: outcome.text }],
          ...(outcome.ok ? {} : { isError: true }),
        },
      });

      if (outcome.ok && outcome.terminal && outcome.taskId) {
        await confirmDelivered(outcome.taskId);
      }
      return;
    }

    default:
      if (hasId) {
        await write({
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `Unknown method: ${String(message.method)}` },
        });
      }
  }
}

const inflight = new Set<Promise<void>>();
const reader = createInterface({ input: process.stdin, crlfDelay: Infinity });

reader.on('line', (line) => {
  const trimmed = line.trim();
  if (trimmed === '') return;

  const task = handleMessage(trimmed).catch((err: unknown) => {
    console.error('trinity-mcp: handler failed:', err instanceof Error ? err.message : String(err));
  });

  inflight.add(task);
  void task.finally(() => inflight.delete(task));
});

reader.on('close', () => {
  void (async () => {
    await Promise.allSettled([...inflight]);
    process.exit(0);
  })();
});

process.on('uncaughtException', (err) => {
  console.error('trinity-mcp: uncaught exception:', err.message);
  process.exit(1);
});

process.on('unhandledRejection', (err) => {
  console.error('trinity-mcp: unhandled rejection:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
