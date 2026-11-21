import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';

const BASE_ENV_KEYS = [
  'PATH',
  'Path',
  'PATHEXT',
  'SystemRoot',
  'SYSTEMROOT',
  'SYSTEMDRIVE',
  'COMSPEC',
  'WINDIR',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'TEMP',
  'TMP',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
  'OS',
  'LANG',
  'LC_ALL',
];

const MAX_STDERR_BYTES = 8192;

/**
 * The Core is often started from a shell that already carries host-injected
 * Claude/Anthropic variables. Inheriting them makes a child believe it belongs
 * to another session, so only an explicit allow-list is passed through.
 */
export function buildChildEnv(
  extra: Record<string, string>,
  base: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};

  for (const key of BASE_ENV_KEYS) {
    const value = base[key];
    if (typeof value === 'string') env[key] = value;
  }

  for (const [key, value] of Object.entries(extra)) {
    env[key] = value;
  }

  return env;
}

/** What the caller may do to a running child. Both calls are safe after exit. */
export interface ProcessHandle {
  pid: number | null;
  /** Writes one line; false means it never reached the process. */
  write(line: string): boolean;
  endInput(): void;
}

export interface ProcessRunOptions {
  file: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  onLine: (line: string) => void;
  signal?: AbortSignal;
  /**
   * Only an adapter whose provider answers over stdio asks for `pipe`. The
   * default keeps stdin closed, because a piped stdin changes what the other
   * CLIs treat as input.
   */
  stdin?: 'ignore' | 'pipe';
  initialInput?: string[];
  onSpawn?: (handle: ProcessHandle) => void;
  /** How long to wait for `close` after asking a process to die. */
  confirmExitMs?: number;
  /** Substituted in tests to model a process that will not die. */
  terminate?: (child: ChildProcess) => void;
}

export interface ProcessRunResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  aborted: boolean;
  spawnError: string | null;
  stderr: string;
  /**
   * False when a kill was issued and `close` still had not arrived by
   * `confirmExitMs`. The process may still be running; callers must not treat
   * this as a finished run.
   */
  exitConfirmed: boolean;
}

const DEFAULT_CONFIRM_EXIT_MS = 15_000;

const activeChildren = new Set<ChildProcess>();

/** Terminates every agent process this Core started. Safe to call more than once. */
export function killAllActiveProcesses(): void {
  for (const child of [...activeChildren]) {
    killProcessTree(child);
  }
}

export function killProcessTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return;

  if (process.platform === 'win32') {
    // /T terminates descendants; the pid is ours, never a name-based match.
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    });
  }

  try {
    child.kill();
  } catch {
    // Process already gone.
  }
}

export function runProcess(options: ProcessRunOptions): Promise<ProcessRunResult> {
  return new Promise((resolve) => {
    let child: ChildProcess;

    try {
      child = spawn(options.file, options.args, {
        cwd: options.cwd,
        env: options.env,
        windowsHide: true,
        shell: false,
        stdio: [options.stdin === 'pipe' ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      resolve({
        exitCode: null,
        signal: null,
        timedOut: false,
        aborted: false,
        spawnError: err instanceof Error ? err.message : String(err),
        stderr: '',
        exitConfirmed: true,
      });
      return;
    }

    activeChildren.add(child);

    const stdin = child.stdin;
    const handle: ProcessHandle = {
      pid: child.pid ?? null,
      write(line: string): boolean {
        if (!stdin || stdin.destroyed || !stdin.writable) return false;
        try {
          stdin.write(`${line}\n`);
          return true;
        } catch {
          return false;
        }
      },
      endInput(): void {
        if (!stdin || stdin.destroyed) return;
        try {
          stdin.end();
        } catch {
          // Already closed.
        }
      },
    };

    if (options.stdin === 'pipe') {
      for (const line of options.initialInput ?? []) handle.write(line);
      options.onSpawn?.(handle);
    }

    let stderr = '';
    let timedOut = false;
    let aborted = false;
    let settled = false;

    let confirmTimer: ReturnType<typeof setTimeout> | null = null;
    const terminate = options.terminate ?? killProcessTree;

    const finish = (result: ProcessRunResult, keepTracked = false): void => {
      if (settled) return;
      settled = true;

      // An unconfirmed process stays tracked so a later shutdown can try again.
      if (!keepTracked) activeChildren.delete(child);

      clearTimeout(timer);
      if (confirmTimer) clearTimeout(confirmTimer);
      if (options.signal) options.signal.removeEventListener('abort', onAbort);
      resolve(result);
    };

    /** A kill was issued; give the process `confirmExitMs` to actually go away. */
    const awaitExit = (): void => {
      if (settled) return;

      confirmTimer = setTimeout(() => {
        finish(
          {
            exitCode: null,
            signal: null,
            timedOut,
            aborted,
            spawnError: null,
            stderr,
            exitConfirmed: false,
          },
          true,
        );
      }, options.confirmExitMs ?? DEFAULT_CONFIRM_EXIT_MS);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      terminate(child);
      awaitExit();
    }, options.timeoutMs);

    const onAbort = (): void => {
      aborted = true;
      terminate(child);
      awaitExit();
    };

    if (options.signal) {
      if (options.signal.aborted) {
        onAbort();
      } else {
        options.signal.addEventListener('abort', onAbort, { once: true });
      }
    }

    child.on('error', (err) => {
      finish({
        exitCode: null,
        signal: null,
        timedOut,
        aborted,
        spawnError: err.message,
        stderr,
        exitConfirmed: true,
      });
    });

    const stdout = child.stdout as Readable;
    const childStderr = child.stderr as Readable;

    childStderr.setEncoding('utf8');
    childStderr.on('data', (chunk: string) => {
      if (stderr.length >= MAX_STDERR_BYTES) return;
      stderr += chunk.slice(0, MAX_STDERR_BYTES - stderr.length);
    });

    const reader = createInterface({ input: stdout, crlfDelay: Infinity });

    reader.on('line', (line) => {
      const trimmed = line.trim();
      if (trimmed) options.onLine(trimmed);
    });

    child.on('close', (code, signal) => {
      finish({
        exitCode: code,
        signal: signal ?? null,
        timedOut,
        aborted,
        spawnError: null,
        stderr,
        exitConfirmed: true,
      });
    });
  });
}
