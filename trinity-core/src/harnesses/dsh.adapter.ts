import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { defaultCredentialFile, readSecretFile } from './credentials.ts';
import { buildSummary } from './activity-summary.ts';
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

const CLI_RELATIVE = join('resources', 'app', 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
const DEFAULT_KEY_NAME = 'deepseek.key';

interface LocatedDsh {
  cli: string;
  source: string;
}

let cachedInstall: LocatedDsh | null | undefined;

function installLocationFromRegistry(): string | null {
  if (process.platform !== 'win32') return null;

  const script =
    "Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'," +
    "'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' -ErrorAction SilentlyContinue | " +
    "Where-Object { $_.DisplayName -like '*DeepSeek Harness*' } | " +
    'Select-Object -First 1 -ExpandProperty InstallLocation';

  try {
    const output = execFileSync('powershell', ['-NoProfile', '-Command', script], {
      encoding: 'utf8',
      timeout: 10_000,
      windowsHide: true,
    }).trim();

    return output === '' ? null : output;
  } catch {
    return null;
  }
}

/**
 * The headless entry lives inside the desktop install: `resources/app/dsh`.
 * An explicit override wins, then the uninstall registry entry, then the usual
 * install roots.
 */
export function locateDsh(env: NodeJS.ProcessEnv = process.env): {
  found: LocatedDsh | null;
  probes: string[];
} {
  const probes: string[] = [];

  const override = env.TRINITY_DSH_CLI?.trim();
  if (override) {
    const cli = override.endsWith('.js') ? override : join(override, CLI_RELATIVE);

    if (existsSync(cli)) return { found: { cli, source: 'env:TRINITY_DSH_CLI' }, probes };

    return { found: null, probes: [`TRINITY_DSH_CLI does not resolve to a CLI: ${cli}`] };
  }

  if (cachedInstall !== undefined) {
    return { found: cachedInstall, probes };
  }

  const roots: string[] = [];

  const registryLocation = installLocationFromRegistry();
  if (registryLocation) roots.push(registryLocation);
  else probes.push('registry: no DeepSeek Harness uninstall entry');

  const localAppData = env.LOCALAPPDATA?.trim();
  if (localAppData) roots.push(join(localAppData, 'Programs', 'DeepSeek Harness'));

  const programFiles = env.ProgramFiles?.trim();
  if (programFiles) roots.push(join(programFiles, 'DeepSeek Harness'));

  for (const root of roots) {
    const cli = join(root, CLI_RELATIVE);

    if (existsSync(cli)) {
      cachedInstall = { cli, source: `install:${root}` };
      return { found: cachedInstall, probes };
    }

    probes.push(`not found under ${root}`);
  }

  cachedInstall = null;
  return { found: null, probes };
}

export function resolveDshKey(env: NodeJS.ProcessEnv = process.env): {
  apiKey: string;
  source: string;
} {
  const direct = env.TRINITY_DSH_API_KEY?.trim();
  if (direct) return { apiKey: direct, source: 'env:TRINITY_DSH_API_KEY' };

  const configured = env.TRINITY_DSH_KEY_FILE?.trim();
  const keyFile = configured || defaultCredentialFile(DEFAULT_KEY_NAME, env);
  const fromFile = readSecretFile(keyFile);

  if (fromFile) {
    return { apiKey: fromFile, source: configured ? 'file:configured' : 'file:default' };
  }

  throw new Error(
    `DeepSeek credentials are missing. Set TRINITY_DSH_API_KEY or place a key file at ${
      keyFile ?? '%LOCALAPPDATA%\\Trinity\\credentials\\deepseek.key'
    }.`,
  );
}

function stringField(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/**
 * `text` events carry the whole message, not a delta. `final` repeats it and
 * adds the terminal reason, so the final text is authoritative.
 */
function nonNegativeNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

/**
 * DSH reports usage per step, with cache read and write beside the input. The
 * stream has no turn-level usage at all, so every step is its own row and the
 * turn figure is a sum. A step whose number is missing cannot be merged into
 * another, so the frame says so and the caller synthesises a unique slot.
 */
export function dshUsage(event: Record<string, unknown>): HarnessUsage | null {
  const raw = event.usage;
  if (typeof raw !== 'object' || raw === null) return null;

  const usage = raw as Record<string, unknown>;
  const inputTokens = nonNegativeNumber(usage.inputTokens);
  const outputTokens = nonNegativeNumber(usage.outputTokens);
  const cacheReadTokens = nonNegativeNumber(usage.cacheReadTokens);
  const cacheWriteTokens = nonNegativeNumber(usage.cacheWriteTokens);
  const totalTokens = nonNegativeNumber(usage.totalTokens);

  if (
    inputTokens === null &&
    outputTokens === null &&
    cacheReadTokens === null &&
    cacheWriteTokens === null &&
    totalTokens === null
  ) {
    return null;
  }

  const providerTurn = nonNegativeInteger(event.turn);
  const providerStep = nonNegativeInteger(event.step);
  const identityMissing = providerTurn === null || providerStep === null;

  return {
    scope: 'step',
    counterScope: 'turn',
    cacheInInput: false,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens,
    ...(identityMissing ? { identityMissing: true } : { providerTurn, providerStep }),
  };
}

export function parseDshLine(line: string): HarnessStreamFrame | null {
  let parsed: unknown;

  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null) return null;

  const event = parsed as Record<string, unknown>;
  const type = stringField(event.type);

  if (type === 'session') {
    const sessionId = stringField(event.sessionId);
    return sessionId ? { sessionId } : null;
  }

  if (type === 'text') {
    const text = stringField(event.text);
    return text === null ? null : { events: [{ type: 'assistant_text', text }] };
  }

  if (type === 'thinking') {
    const text = stringField(event.text);
    return text && text.length > 0 ? { events: [{ type: 'thinking', text }] } : null;
  }

  if (type === 'final') {
    const reason = event.reason;

    if (typeof reason !== 'object' || reason === null) return null;

    const kind = stringField((reason as Record<string, unknown>).kind);
    const error = (reason as Record<string, unknown>).error;
    const message =
      typeof error === 'object' && error !== null
        ? stringField((error as Record<string, unknown>).message)
        : null;

    const isError = kind !== 'completed';
    const text = stringField(event.text) ?? '';

    return {
      terminal: {
        nativeSessionId: stringField(event.sessionId),
        finalText: isError ? '' : text,
        isError,
        errorMessage: isError ? (message ?? kind ?? 'DeepSeek Harness reported a failure') : null,
      },
      sessionId: stringField(event.sessionId) ?? undefined,
    };
  }

  if (type === 'status') {
    // Turn bookkeeping carries no content; a finished step carries its usage.
    if (stringField(event.phase) !== 'step_end') return null;

    const usage = dshUsage(event);
    return usage === null ? null : { usage };
  }

  if (type === 'tool_call') {
    const tool = stringField(event.tool) ?? 'tool';

    return {
      events: [
        {
          type: 'tool_call',
          name: tool,
          input: event.input ?? null,
          ref: stringField(event.callId),
        },
      ],
    };
  }

  if (type === 'tool_result') {
    const status = stringField(event.status);
    const result = stringField(event.result) ?? '';
    const error =
      typeof event.error === 'object' && event.error !== null
        ? (event.error as Record<string, unknown>)
        : null;
    const code = error === null ? null : stringField(error.code);
    const summary = status === 'error' ? buildSummary(['失败', code]) : buildSummary(['完成']);

    return {
      events: [
        {
          type: 'tool_result',
          name: null,
          // An empty result is still an event; dropping it would hide the call.
          content: result.trim() === '' ? '(无输出)' : result,
          ref: stringField(event.callId),
          ...(summary !== null ? { summary } : {}),
        },
      ],
    };
  }

  return { events: [{ type: 'unknown', rawType: type ?? 'untyped' }] };
}

export class DshAdapter implements HarnessAdapter {
  readonly type = 'deepseek' as const;
  readonly displayName = 'DeepSeek Harness';
  private readonly env: NodeJS.ProcessEnv;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.env = env;
  }

  resolveExecutable(): ResolvedExecutable {
    const { found, probes } = locateDsh(this.env);

    if (!found) {
      throw new HarnessLocateError(
        'Could not find the DeepSeek Harness headless CLI.',
        probes,
      );
    }

    return { file: found.cli, source: found.source };
  }

  buildCommand(input: HarnessTurnInput): HarnessCommand {
    const cli = this.resolveExecutable().file;
    const credentials = resolveDshKey(this.env);

    // The CLI is a Node program, so the interpreter is the running Node itself.
    const args = [cli, 'headless', '--json'];

    if (input.nativeSessionId) args.push('--session-id', input.nativeSessionId);
    args.push(input.prompt);

    return {
      file: process.execPath,
      args,
      env: {
        DEEPSEEK_API_KEY: credentials.apiKey,
        DSH_HOME: this.env.DSH_HOME?.trim() || join(homedir(), '.dsh'),
      },
    };
  }

  parseLine(line: string): HarnessStreamFrame | null {
    return parseDshLine(line);
  }
}
