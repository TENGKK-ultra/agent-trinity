import { locateOnPath } from './locator.ts';
import { defaultCredentialFile, readSecretFile } from './credentials.ts';
import {
  HarnessLocateError,
  type HarnessAdapter,
  type HarnessApprovalDecision,
  type HarnessApprovalRequest,
  type HarnessCommand,
  type HarnessEvent,
  type HarnessStreamFrame,
  type HarnessTurnInput,
  type HarnessUsage,
  type ResolvedExecutable,
} from './types.ts';

const BINARY_NAME = 'claude';
const DEFAULT_BASE_URL = 'https://api.deepseek.com/anthropic';
const DEFAULT_KEY_NAME = 'claude.key';

export interface ClaudeCredentials {
  baseUrl: string;
  authToken: string;
  source: string;
}

/**
 * Credentials never come from the ambient environment: the desktop host injects
 * its own token per request, which a spawned child cannot see. The file source
 * sits outside the repository, because anything inside it is findable by an
 * agent that scans files.
 */
export function resolveClaudeCredentials(env: NodeJS.ProcessEnv = process.env): ClaudeCredentials {
  const baseUrl = env.TRINITY_CLAUDE_BASE_URL?.trim() || DEFAULT_BASE_URL;

  const direct = env.TRINITY_CLAUDE_AUTH_TOKEN?.trim();
  if (direct) {
    return { baseUrl, authToken: direct, source: 'env:TRINITY_CLAUDE_AUTH_TOKEN' };
  }

  const configured = env.TRINITY_CLAUDE_KEY_FILE?.trim();
  const keyFile = configured || defaultCredentialFile(DEFAULT_KEY_NAME, env);
  const fromFile = readSecretFile(keyFile);

  if (fromFile) {
    return {
      baseUrl,
      authToken: fromFile,
      source: configured ? 'file:configured' : 'file:default',
    };
  }

  throw new Error(
    `Claude credentials are missing. Set TRINITY_CLAUDE_AUTH_TOKEN or place a key file at ${
      keyFile ?? '%LOCALAPPDATA%\\Trinity\\credentials\\claude.key'
    }.`,
  );
}

/** Tokens are printable ASCII without spaces; anything else cannot be sent in a header. */
export function isPlausibleToken(token: string): boolean {
  return /^[\x21-\x7e]{8,}$/.test(token);
}

export function maskToken(token: string): string {
  if (token.length <= 8) return '***';
  return `${token.slice(0, 3)}***${token.slice(-4)}`;
}

function stringField(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

interface ContentBlock {
  type?: unknown;
  text?: unknown;
  thinking?: unknown;
  name?: unknown;
  input?: unknown;
  content?: unknown;
  tool_use_id?: unknown;
  id?: unknown;
}

function blockEvents(block: ContentBlock): HarnessEvent[] {
  const kind = stringField(block.type);

  if (kind === 'text') {
    const text = stringField(block.text);
    return text === null ? [] : [{ type: 'assistant_text', text }];
  }

  if (kind === 'thinking' || kind === 'redacted_thinking') {
    const text = stringField(block.text) ?? stringField(block.thinking);
    return text === null ? [] : [{ type: 'thinking', text }];
  }

  if (kind === 'tool_use') {
    return [
      {
        type: 'tool_call',
        name: stringField(block.name) ?? 'tool',
        input: block.input ?? null,
        ref: stringField(block.id),
      },
    ];
  }

  if (kind === 'tool_result') {
    const content = block.content;
    const text =
      typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content
              .map((item) =>
                typeof item === 'object' && item !== null
                  ? (stringField((item as ContentBlock).text) ?? '')
                  : '',
              )
              .join('\n')
          : '';

    return [
      {
        type: 'tool_result',
        name: null,
        content: text,
        ref: stringField(block.tool_use_id),
      },
    ];
  }

  return [];
}

/**
 * A permission ask arrives as a control request on stdout and is answered by
 * writing a control response to stdin, so the request id is the only key the
 * reply may quote.
 */
function parseApprovalRequest(envelope: Record<string, unknown>): HarnessApprovalRequest | null {
  const request = envelope.request;

  if (typeof request !== 'object' || request === null) return null;

  const body = request as Record<string, unknown>;
  if (stringField(body.subtype) !== 'can_use_tool') return null;

  const requestId = stringField(envelope.request_id);
  if (!requestId) return null;

  const toolName = stringField(body.tool_name) ?? 'tool';

  return {
    requestId,
    kind: toolName === 'AskUserQuestion' ? 'question' : 'tool_approval',
    toolName,
    toolUseId: stringField(body.tool_use_id),
    input: body.input ?? null,
    description: stringField(body.description),
  };
}

export function formatClaudeApprovalDecision(
  request: HarnessApprovalRequest,
  decision: HarnessApprovalDecision,
): string {
  return JSON.stringify({
    type: 'control_response',
    response: {
      subtype: 'success',
      request_id: request.requestId,
      response:
        decision.behavior === 'allow'
          ? { behavior: 'allow', updatedInput: decision.input }
          : { behavior: 'deny', message: decision.message },
    },
  });
}

function nonNegativeNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * Claude reports per-turn usage with cache beside input, and states the cost
 * itself. `modelUsage` is deliberately not read: it is a per-model breakdown
 * of the same calls, and adding it would count the same tokens twice.
 */
export function claudeUsage(envelope: Record<string, unknown>): HarnessUsage | null {
  const raw = envelope.usage;
  if (typeof raw !== 'object' || raw === null) return null;

  const usage = raw as Record<string, unknown>;
  const details = usage.output_tokens_details;
  const thinking =
    typeof details === 'object' && details !== null
      ? nonNegativeNumber((details as Record<string, unknown>).thinking_tokens)
      : null;

  const inputTokens = nonNegativeNumber(usage.input_tokens);
  const outputTokens = nonNegativeNumber(usage.output_tokens);
  const cacheReadTokens = nonNegativeNumber(usage.cache_read_input_tokens);
  const cacheWriteTokens = nonNegativeNumber(usage.cache_creation_input_tokens);
  const costUsd = nonNegativeNumber(envelope.total_cost_usd);

  const nothingReported =
    inputTokens === null &&
    outputTokens === null &&
    cacheReadTokens === null &&
    cacheWriteTokens === null &&
    costUsd === null;

  if (nothingReported) return null;

  return {
    scope: 'turn',
    counterScope: 'turn',
    cacheInInput: false,
    inputTokens,
    outputTokens,
    reasoningOutputTokens: thinking,
    cacheReadTokens,
    cacheWriteTokens,
    costUsd,
  };
}

export function parseClaudeLine(line: string): HarnessStreamFrame | null {
  let parsed: unknown;

  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null) return null;

  const envelope = parsed as Record<string, unknown>;
  const type = stringField(envelope.type);
  const sessionId = stringField(envelope.session_id);

  if (type === 'control_request') {
    const approval = parseApprovalRequest(envelope);
    return approval ? { events: [{ type: 'approval_request', approval }] } : null;
  }

  if (type === 'system') {
    return sessionId ? { sessionId } : null;
  }

  if (type === 'assistant' || type === 'user') {
    const message = envelope.message;
    if (typeof message !== 'object' || message === null) return null;

    const content = (message as Record<string, unknown>).content;
    if (!Array.isArray(content)) return null;

    const events: HarnessEvent[] = [];
    for (const block of content) {
      if (typeof block !== 'object' || block === null) continue;
      events.push(...blockEvents(block as ContentBlock));
    }

    if (events.length === 0) return null;
    return { events, sessionId: sessionId ?? undefined };
  }

  if (type === 'result') {
    // The provider writes subtype "success" even for failed runs; is_error is the
    // only trustworthy field, and it is cross-checked against the exit code.
    const isError = envelope.is_error === true;
    const resultText = stringField(envelope.result) ?? '';
    const errorMessage = isError ? resultText : null;
    const usage = claudeUsage(envelope);

    return {
      terminal: {
        nativeSessionId: sessionId,
        finalText: isError ? '' : resultText,
        isError,
        errorMessage: errorMessage && errorMessage.length > 0 ? errorMessage : null,
      },
      sessionId: sessionId ?? undefined,
      ...(usage === null ? {} : { usage }),
    };
  }

  return { events: [{ type: 'unknown', rawType: type ?? 'untyped' }] };
}

export class ClaudeAdapter implements HarnessAdapter {
  readonly type = 'claude' as const;
  readonly displayName = 'Claude Code';
  private readonly env: NodeJS.ProcessEnv;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.env = env;
  }

  resolveExecutable(): ResolvedExecutable {
    const { found, probes } = locateOnPath(BINARY_NAME, this.env);

    if (!found) {
      throw new HarnessLocateError(
        `Could not find a usable "${BINARY_NAME}" executable on PATH.`,
        probes,
      );
    }

    return found;
  }

  buildCommand(input: HarnessTurnInput): HarnessCommand {
    const executable = this.resolveExecutable();
    const credentials = resolveClaudeCredentials(this.env);

    if (!isPlausibleToken(credentials.authToken)) {
      throw new Error('The configured Claude credential is not a valid token.');
    }

    // The prompt travels on stdin, not argv: keeping stdin open is what lets a
    // permission ask reach this process and its answer travel back.
    const args = [
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--input-format',
      'stream-json',
      // Without this the CLI answers permission asks itself, which means denying them.
      '--permission-prompt-tool',
      'stdio',
    ];

    // Strict mode keeps the user's own MCP servers out of a turn that only
    // needs Trinity's; the config file is written and removed per turn.
    if (input.mcpConfigPath) {
      args.push('--strict-mcp-config', '--mcp-config', input.mcpConfigPath);
    }

    if (input.nativeSessionId) args.push('--resume', input.nativeSessionId);
    if (input.model) args.push('--model', input.model);

    // A role rule has to sit above the user prompt; appending it here keeps it
    // in the system prompt instead of competing with the task text.
    if (input.systemAppend) args.push('--append-system-prompt', input.systemAppend);

    // Read-only analysis should not need a human click. Anything not listed
    // here still goes through the normal approval card.
    if (input.allowedTools && input.allowedTools.length > 0) {
      args.push('--allowedTools', ...input.allowedTools);
    }

    // The conversation's approval mode. Omitted means the CLI default.
    if (input.permissionMode) {
      args.push('--permission-mode', input.permissionMode);
    }

    return {
      file: executable.file,
      args,
      env: {
        ANTHROPIC_BASE_URL: credentials.baseUrl,
        ANTHROPIC_AUTH_TOKEN: credentials.authToken,
      },
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
