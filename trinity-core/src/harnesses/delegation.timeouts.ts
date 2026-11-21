/**
 * Two independent limits meet at a delegation: how long Core lets the target
 * agent run, and how long the caller keeps waiting for the answer. They are
 * configured separately on purpose — the caller must outlast the execution,
 * otherwise it gives up on work that is still running.
 */

export const DEFAULT_DELEGATION_TIMEOUT_MS = 5 * 60 * 1000;
export const MAX_DELEGATION_TIMEOUT_MS = 30 * 60 * 1000;

const WAIT_MARGIN_MS = 60 * 1000;
const MAX_WAIT_TIMEOUT_MS = 2 * 60 * 60 * 1000;

export function resolveDelegationTimeout(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.TRINITY_DELEGATION_TIMEOUT_MS;
  if (!raw) return DEFAULT_DELEGATION_TIMEOUT_MS;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1000 || parsed > MAX_DELEGATION_TIMEOUT_MS) {
    return DEFAULT_DELEGATION_TIMEOUT_MS;
  }

  return Math.floor(parsed);
}

/**
 * The caller's wait can be configured, but it is never allowed below the
 * execution timeout plus a margin: a shorter wait would report a failure for a
 * task Core is still running.
 */
export function resolveMcpWaitTimeout(env: NodeJS.ProcessEnv = process.env): number {
  const floor = resolveDelegationTimeout(env) + WAIT_MARGIN_MS;
  const raw = env.TRINITY_MCP_WAIT_MS;
  if (!raw) return floor;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1000 || parsed > MAX_WAIT_TIMEOUT_MS) {
    return floor;
  }

  return Math.max(Math.floor(parsed), floor);
}
