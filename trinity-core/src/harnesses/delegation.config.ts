import { rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { issueToken, revokeToken } from './token.service.ts';
import { resolveMcpWaitTimeout } from './delegation.timeouts.ts';

const MCP_SERVER_PATH = resolve(import.meta.dirname, '..', 'mcp', 'server.ts');

export interface DelegationConfig {
  token: string;
  configPath: string;
}

/**
 * Writes the per-turn MCP configuration. The token travels in the file rather
 * than in argv: a command line is readable by any process of the same user.
 *
 * The file is not a security boundary — Core's own API is unauthenticated — it
 * simply avoids advertising the credential in the process list.
 */
export function writeDelegationConfig(input: {
  conversationId: string;
  sourceTurnId: string;
  roundId?: string | null;
  ttlMs: number;
  coreBaseUrl: string;
}): DelegationConfig {
  const entry = issueToken({
    conversationId: input.conversationId,
    sourceAgent: 'claude',
    sourceTurnId: input.sourceTurnId,
    roundId: input.roundId ?? null,
    ttlMs: input.ttlMs,
  });

  const configPath = join(tmpdir(), `trinity-mcp-${input.sourceTurnId}.json`);

  const config = {
    mcpServers: {
      trinity: {
        command: process.execPath,
        args: [MCP_SERVER_PATH],
        env: {
          TRINITY_TOKEN: entry.token,
          TRINITY_CORE_URL: input.coreBaseUrl,
          // The caller must outlast the run it is waiting for; a shorter wait
          // reports a failure for work that is still going.
          TRINITY_MCP_WAIT_MS: String(resolveMcpWaitTimeout()),
        },
      },
    },
  };

  writeFileSync(configPath, JSON.stringify(config), { encoding: 'utf8', mode: 0o600 });

  return { token: entry.token, configPath };
}

export function removeDelegationConfig(config: DelegationConfig): void {
  revokeToken(config.token);

  try {
    rmSync(config.configPath, { force: true });
  } catch {
    // A leftover file in the temp directory is harmless; the token is already dead.
  }
}

/** Where the MCP server should call back to, when nobody told us explicitly. */
export function defaultCoreBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.TRINITY_CORE_URL?.trim();
  if (explicit) return explicit;

  return `http://127.0.0.1:${env.TRINITY_PORT?.trim() || '3210'}`;
}
