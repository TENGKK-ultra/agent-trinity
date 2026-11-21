import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { locateOnPath } from './locator.ts';
import { scanObjectKeys } from './duplicate-keys.ts';
import { buildSummary, sanitizeToolName } from './activity-summary.ts';
import {
  HarnessLocateError,
  type HarnessAdapter,
  type HarnessCommand,
  type HarnessEvent,
  type HarnessStreamFrame,
  type HarnessTurnInput,
  type HarnessUsage,
  type ResolvedExecutable,
} from './types.ts';

const BINARY_NAME = 'codex';
const SANDBOX_HELPER = 'codex-windows-sandbox-setup.exe';

/**
 * Only these two are accepted. `danger-full-access` is deliberately absent:
 * a delegated task never gets to remove the sandbox because someone approved
 * the delegation itself.
 */
export const CODEX_SANDBOX_MODES = ['read-only', 'workspace-write'] as const;
export type CodexSandboxMode = (typeof CODEX_SANDBOX_MODES)[number];

export function resolveCodexSandbox(env: NodeJS.ProcessEnv = process.env): CodexSandboxMode {
  const raw = env.TRINITY_CODEX_SANDBOX?.trim();
  if (!raw) return 'read-only';

  const mode = CODEX_SANDBOX_MODES.find((candidate) => candidate === raw);
  if (!mode) {
    throw new Error(
      `TRINITY_CODEX_SANDBOX must be one of: ${CODEX_SANDBOX_MODES.join(', ')} (got "${raw}")`,
    );
  }

  return mode;
}

/**
 * `sandbox_mode` is a configuration key rather than a flag because `exec resume`
 * does not accept `-s`; `-c` works on both subcommands.
 */
export function buildCodexArgs(input: HarnessTurnInput, sandbox: CodexSandboxMode): string[] {
  const args = input.nativeSessionId
    ? ['exec', 'resume', input.nativeSessionId, '--json', '--skip-git-repo-check']
    : ['exec', '--json', '--skip-git-repo-check', '-C', input.cwd];

  args.push('-c', `sandbox_mode="${sandbox}"`);

  // developer_instructions is a developer-role message in the model input, so
  // a role rule lands above the user prompt. The value is a TOML string; JSON
  // escaping is compatible (quotes and newlines are escaped the same way).
  if (input.systemAppend) {
    args.push('-c', `developer_instructions=${JSON.stringify(input.systemAppend)}`);
  }

  if (input.model) args.push('-m', input.model);
  args.push(input.prompt);

  return args;
}

interface Candidate {
  file: string;
  source: string;
  complete: boolean;
}

function isCompleteInstall(file: string): boolean {
  return existsSync(join(file, '..', SANDBOX_HELPER));
}

/**
 * A partial copy of the CLI lives in `.sandbox-bin` without the sandbox setup
 * helper, so Codex launched from there cannot provision its Windows sandbox.
 * Complete installs are preferred; an incomplete one is only used to report why.
 */
export function locateCodexBinary(env: NodeJS.ProcessEnv = process.env): {
  found: Candidate | null;
  probes: string[];
} {
  const probes: string[] = [];
  let incompleteInstall: Candidate | null = null;

  const override = env.TRINITY_CODEX_BIN?.trim();
  if (override) {
    if (existsSync(override)) {
      return { found: { file: override, source: 'env:TRINITY_CODEX_BIN', complete: isCompleteInstall(override) }, probes };
    }
    return { found: null, probes: [`TRINITY_CODEX_BIN does not exist: ${override}`] };
  }

  const cliPath = env.CODEX_CLI_PATH?.trim();
  if (cliPath) {
    if (existsSync(cliPath)) {
      return { found: { file: cliPath, source: 'env:CODEX_CLI_PATH', complete: isCompleteInstall(cliPath) }, probes };
    }
    probes.push(`CODEX_CLI_PATH does not exist: ${cliPath}`);
  }

  const localAppData = env.LOCALAPPDATA?.trim();
  if (localAppData) {
    const binRoot = join(localAppData, 'OpenAI', 'Codex', 'bin');
    let entries: string[] = [];

    try {
      entries = readdirSync(binRoot);
    } catch {
      entries = [];
    }

    const candidates: Array<Candidate & { mtime: number }> = [];

    for (const entry of entries) {
      const file = join(binRoot, entry, 'codex.exe');

      if (!existsSync(file)) continue;

      let mtime = 0;
      try {
        mtime = statSync(file).mtimeMs;
      } catch {
        mtime = 0;
      }

      candidates.push({ file, source: `install:${entry}`, complete: isCompleteInstall(file), mtime });
    }

    const complete = candidates.filter((entry) => entry.complete).sort((a, b) => b.mtime - a.mtime);

    if (complete[0]) {
      return { found: complete[0], probes };
    }

    const incomplete = candidates[0];
    if (incomplete) {
      probes.push(`install without ${SANDBOX_HELPER}: ${incomplete.file}`);
      incompleteInstall = incomplete;
    }
  }

  const fromPath = locateOnPath(BINARY_NAME, env);
  if (fromPath.found) {
    return {
      found: { ...fromPath.found, complete: isCompleteInstall(fromPath.found.file) },
      probes: [...probes, ...fromPath.probes],
    };
  }

  probes.push(...fromPath.probes);

  // Last resort: a partial install can still answer text prompts, it just
  // cannot provision the Windows sandbox. The caller sees `complete: false`.
  if (incompleteInstall) {
    return { found: incompleteInstall, probes };
  }

  return { found: null, probes };
}

function stringField(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

interface CodexItem {
  type?: unknown;
  id?: unknown;
  text?: unknown;
  message?: unknown;
  command?: unknown;
  aggregated_output?: unknown;
  exit_code?: unknown;
  changes?: unknown;
  server?: unknown;
  tool?: unknown;
  status?: unknown;
  query?: unknown;
}

const CHANGE_SUMMARY_LIMIT = 3;

function itemIdOf(item: CodexItem): string | null {
  return stringField(item.id);
}

function countField(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * Codex reports a thread-running total and counts cached tokens inside the
 * input; both facts are stated here so the ledger never has to guess.
 */
export function codexUsage(raw: unknown): HarnessUsage | null {
  if (typeof raw !== 'object' || raw === null) return null;

  const usage = raw as Record<string, unknown>;
  const inputTokens = countField(usage.input_tokens);
  const outputTokens = countField(usage.output_tokens);
  const cacheReadTokens = countField(usage.cached_input_tokens);
  const cacheWriteTokens = countField(usage.cache_write_input_tokens);
  const reasoningOutputTokens = countField(usage.reasoning_output_tokens);

  if (inputTokens === null && outputTokens === null && cacheReadTokens === null) return null;

  return {
    scope: 'turn',
    counterScope: 'thread',
    cacheInInput: true,
    inputTokens,
    outputTokens,
    reasoningOutputTokens,
    cacheReadTokens,
    cacheWriteTokens,
  };
}

/**
 * Only the program name may enter a message. The command line itself is
 * evidence, not activity: it is handed to the debug store and kept out of
 * every column and DTO the dashboard reads.
 */
export function normalizeCommandName(command: string | null): string {
  if (command === null) return 'command';

  const raw = command.trim();
  if (raw === '') return 'command';

  const quote = raw[0];
  let first: string;

  if (quote === '"' || quote === "'") {
    const end = raw.indexOf(quote, 1);
    first = end === -1 ? raw.slice(1) : raw.slice(1, end);
  } else {
    const space = raw.search(/\s/);
    first = space === -1 ? raw : raw.slice(0, space);
  }

  const base = first.split(/[\\/]/).pop() ?? '';

  return sanitizeToolName(base) ?? 'command';
}

/** Names the changed paths only; contents and diffs never enter a summary. */
function summarizeFileChange(item: CodexItem): string | null {
  if (!Array.isArray(item.changes)) return null;

  const labels: string[] = [];

  for (const change of item.changes) {
    if (labels.length === CHANGE_SUMMARY_LIMIT) break;
    if (typeof change !== 'object' || change === null) continue;

    const record = change as Record<string, unknown>;
    const path = stringField(record.path);
    if (path === null) continue;

    const kind = stringField(record.kind) ?? stringField(record.type);
    const verb =
      kind === 'add'
        ? '新增'
        : kind === 'delete'
          ? '删除'
          : kind === 'update' || kind === 'modify'
            ? '修改'
            : '变更';

    labels.push(`${verb} ${path}`);
  }

  if (labels.length === 0) return null;

  if (item.changes.length > labels.length) labels.push(`等 ${item.changes.length} 个文件`);

  return buildSummary(labels);
}

function itemEvents(item: CodexItem): HarnessEvent[] {
  const kind = stringField(item.type);

  if (kind === 'agent_message') {
    const text = stringField(item.text) ?? stringField(item.message);
    return text === null ? [] : [{ type: 'assistant_text', text }];
  }

  if (kind === 'reasoning') {
    const text = stringField(item.text);
    return text === null ? [] : [{ type: 'thinking', text }];
  }

  if (kind === 'command_execution' || kind === 'command') {
    const raw = stringField(item.command);
    const name = normalizeCommandName(raw);
    const output = stringField(item.aggregated_output);
    const ref = itemIdOf(item);
    const events: HarnessEvent[] = [
      {
        type: 'tool_call',
        name,
        input: null,
        ref,
        ...(raw === null || raw.trim() === '' ? {} : { rawCommand: raw }),
      },
    ];

    if (output !== null) {
      const exitCode = typeof item.exit_code === 'number' ? item.exit_code : null;
      const summary = exitCode === null ? null : buildSummary([`退出码 ${exitCode}`]);

      events.push({
        type: 'tool_result',
        name,
        content: output,
        ref,
        ...(summary !== null ? { summary } : {}),
      });
    }

    return events;
  }

  // A completed file change, not an invocation: it is mapped onto tool_call
  // only because the neutral model has no file-change event. The `tool` name
  // and summary carry that distinction.
  if (kind === 'file_change') {
    const summary = summarizeFileChange(item);
    const ref = itemIdOf(item);

    return [
      {
        type: 'tool_call',
        name: 'file_change',
        input: null,
        ref,
        ...(summary !== null ? { summary } : {}),
      },
    ];
  }

  if (kind === 'mcp_tool_call') {
    const server = stringField(item.server);
    const tool = stringField(item.tool);
    const target = server !== null && tool !== null ? `${server}/${tool}` : (tool ?? server);
    const summary = buildSummary([target, stringField(item.status)]);
    const ref = itemIdOf(item);

    return [
      {
        type: 'tool_call',
        name: 'mcp_call',
        input: null,
        ref,
        ...(summary !== null ? { summary } : {}),
      },
    ];
  }

  if (kind === 'web_search') {
    const query = stringField(item.query);
    const summary = buildSummary([query !== null && query !== '' ? `搜索：${query}` : '搜索']);
    const ref = itemIdOf(item);

    return [
      {
        type: 'tool_call',
        name: 'web_search',
        input: null,
        ref,
        ...(summary !== null ? { summary } : {}),
      },
    ];
  }

  // Codex reports configuration warnings as error items while the turn still
  // succeeds, so they must never be treated as a failed run.
  if (kind === 'error') {
    return [{ type: 'unknown', rawType: 'error_item' }];
  }

  return [{ type: 'unknown', rawType: kind ?? 'untyped_item' }];
}

/**
 * Codex's `web_search` item carries two `id` keys: the item id and the call id.
 * `JSON.parse` keeps the last one and discards the first without a word, so the
 * raw text has to be examined before parsing to keep the evidence.
 */
function itemAnomalies(line: string): string[] | undefined {
  if (!line.includes('"item"')) return undefined;

  const scan = scanObjectKeys(line, 'item', ['id']);
  if (scan.duplicates.length === 0) return undefined;

  return scan.duplicates.map(
    (key) =>
      `duplicate_json_key:item.${key}(first=${scan.firstValues[key] ?? '?'},last=${
        scan.firstValues[`${key}#last`] ?? '?'
      })`,
  );
}

export function parseCodexLine(line: string): HarnessStreamFrame | null {
  let parsed: unknown;

  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null) return null;

  const envelope = parsed as Record<string, unknown>;
  const type = stringField(envelope.type);
  const anomalies = itemAnomalies(line);

  if (type === 'thread.started') {
    const threadId = stringField(envelope.thread_id);
    return threadId ? { sessionId: threadId } : null;
  }

  if (type === 'item.completed' || type === 'item.updated') {
    const item = envelope.item;

    if (typeof item !== 'object' || item === null) return null;

    const events = itemEvents(item as CodexItem);

    if (events.length === 0) {
      return anomalies ? { events, anomalies } : null;
    }

    return anomalies ? { events, anomalies } : { events };
  }

  if (type === 'turn.completed') {
    const usage = codexUsage(envelope.usage);

    return {
      terminal: { nativeSessionId: null, finalText: '', isError: false, errorMessage: null },
      ...(usage === null ? {} : { usage }),
    };
  }

  if (type === 'turn.failed' || type === 'error') {
    const message =
      stringField(envelope.message) ??
      stringField((envelope.error as Record<string, unknown> | undefined)?.message) ??
      type ??
      'Codex reported a failed turn';

    return {
      terminal: { nativeSessionId: null, finalText: '', isError: true, errorMessage: message },
    };
  }

  return {
    events: [{ type: 'unknown', rawType: type ?? 'untyped' }],
    ...(anomalies ? { anomalies } : {}),
  };
}

export class CodexAdapter implements HarnessAdapter {
  readonly type = 'codex' as const;
  readonly displayName = 'Codex';
  private readonly env: NodeJS.ProcessEnv;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.env = env;
  }

  resolveExecutable(): ResolvedExecutable {
    const { found, probes } = locateCodexBinary(this.env);

    if (!found) {
      throw new HarnessLocateError('Could not find a usable "codex" executable.', probes);
    }

    const warnings = found.complete
      ? undefined
      : [
          `This Codex install is missing ${SANDBOX_HELPER}; it can answer prompts but cannot run commands.`,
        ];

    return { file: found.file, source: found.source, warnings };
  }

  buildCommand(input: HarnessTurnInput): HarnessCommand {
    // Resolved before anything is spawned: an invalid setting must stop the run,
    // not silently fall back to something wider or narrower.
    const sandbox = resolveCodexSandbox(this.env);
    const executable = this.resolveExecutable();
    const args = buildCodexArgs(input, sandbox);

    return {
      file: executable.file,
      args,
      env: {
        // Without this the CLI falls back to ~/.codex, which is a stale home.
        CODEX_HOME: this.env.CODEX_HOME?.trim() || join(homedir(), '.codex'),
      },
    };
  }

  parseLine(line: string): HarnessStreamFrame | null {
    return parseCodexLine(line);
  }
}
