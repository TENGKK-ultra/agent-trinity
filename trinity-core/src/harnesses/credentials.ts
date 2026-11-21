import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** A secret is one line of bounded length; anything else is treated as absent. */
const MAX_SECRET_BYTES = 4096;

/**
 * Credentials live outside the repository. Anything inside the workspace can be
 * found by an agent that scans files, and `.gitignore` is not an access boundary.
 */
export function defaultCredentialDir(env: NodeJS.ProcessEnv = process.env): string | null {
  const localAppData = env.LOCALAPPDATA?.trim();
  return localAppData ? join(localAppData, 'Trinity', 'credentials') : null;
}

export function defaultCredentialFile(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const dir = defaultCredentialDir(env);
  return dir === null ? null : join(dir, name);
}

/**
 * Reads one secret file. Missing, unreadable, oversized, empty or multi-line
 * content is "no credential": the caller must fail loudly rather than send a
 * value nobody can vouch for.
 */
export function readSecretFile(path: string | null): string | null {
  if (path === null) return null;

  let raw: string;

  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return null;
  }

  if (raw.length > MAX_SECRET_BYTES) return null;

  const value = raw.trim();
  if (value === '' || /[\r\n]/.test(value)) return null;

  return value;
}
