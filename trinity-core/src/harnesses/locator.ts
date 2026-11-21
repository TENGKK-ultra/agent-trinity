import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ResolvedExecutable } from './types.ts';

const MAX_SHIM_BYTES = 64 * 1024;

/**
 * npm installs a .cmd shim next to the real binary, and the updater may rename
 * that binary to `name.exe.old.<timestamp>` without restoring it. A shim is
 * therefore only trusted when its target is actually present.
 */
export function expandShimTarget(shimPath: string, contents?: string): string | null {
  let text = contents;

  if (text === undefined) {
    try {
      text = readFileSync(shimPath, 'utf8');
    } catch {
      return null;
    }
  }

  if (text.length > MAX_SHIM_BYTES) return null;

  const match = /"([^"]+\.exe)"/i.exec(text);
  const captured = match?.[1];
  if (!captured) return null;

  return captured.replace(/%dp0%[\\/]?/gi, `${dirname(shimPath)}\\`);
}

export interface LocateResult {
  found: ResolvedExecutable | null;
  probes: string[];
}

export function locateOnPath(
  displayName: string,
  env: NodeJS.ProcessEnv = process.env,
): LocateResult {
  const probes: string[] = [];

  const override = env.TRINITY_CLAUDE_BIN?.trim();
  if (override) {
    if (existsSync(override)) {
      return { found: { file: override, source: 'env:TRINITY_CLAUDE_BIN' }, probes };
    }

    // An explicit override that is wrong must fail loudly. Falling back to PATH
    // would silently run a different binary than the operator asked for.
    return { found: null, probes: [`TRINITY_CLAUDE_BIN does not exist: ${override}`] };
  }

  const pathValue = env.PATH ?? env.Path ?? '';

  for (const dir of pathValue.split(';')) {
    const trimmed = dir.trim().replace(/^"|"$/g, '');
    if (!trimmed) continue;

    const directExe = join(trimmed, `${displayName}.exe`);
    if (existsSync(directExe)) {
      return { found: { file: directExe, source: 'path-exe' }, probes };
    }

    const shimPath = join(trimmed, `${displayName}.cmd`);
    if (!existsSync(shimPath)) continue;

    const target = expandShimTarget(shimPath);

    if (!target) {
      probes.push(`shim unparsable: ${shimPath}`);
      continue;
    }

    if (existsSync(target)) {
      return { found: { file: target, source: `shim:${shimPath}` }, probes };
    }

    // Do not run the renamed leftover: it is a stale binary the updater meant to replace.
    probes.push(`shim target missing: ${target}`);
  }

  return { found: null, probes };
}
