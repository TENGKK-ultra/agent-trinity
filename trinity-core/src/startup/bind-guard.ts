const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

export function normalizeBindHost(host: string): string {
  const trimmed = host.trim().toLowerCase();
  return trimmed.replace(/^\[/, '').replace(/\]$/, '');
}

export function isLoopbackBindHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(normalizeBindHost(host));
}

export interface BindGuardResult {
  allowed: boolean;
  reason?: string;
}

export function evaluateBindHost(
  host: string,
  env: NodeJS.ProcessEnv = process.env,
): BindGuardResult {
  if (isLoopbackBindHost(host)) {
    return { allowed: true };
  }

  // Strict equality on purpose: "true", "yes", " 1 " and similar must not authorise.
  if (env.TRINITY_ALLOW_REMOTE === '1') {
    return { allowed: true, reason: `listening on non-loopback address "${host}"` };
  }

  return { allowed: false, reason: `refusing to listen on non-loopback address "${host}"` };
}

export function assertBindHostAllowed(
  host: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const result = evaluateBindHost(host, env);

  if (!result.allowed) {
    throw new Error(
      `[trinity-core] ${result.reason}. The API has no authentication. ` +
        'Set TRINITY_ALLOW_REMOTE=1 to override.',
    );
  }

  if (result.reason) {
    console.warn(
      `[trinity-core] WARNING: ${result.reason}. TRINITY_ALLOW_REMOTE=1 is set, ` +
        'but the API has NO authentication. Do not expose it to untrusted networks.',
    );
  }
}
