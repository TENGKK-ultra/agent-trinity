import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { getAdapter } from '../../harnesses/registry.ts';
import { listDirectory } from '../../harnesses/session.service.ts';
import { appError } from '../../types/index.ts';
import { sendJson } from '../http-utils.ts';

/**
 * `/api/agents` — the capability directory as it actually is: which agents are
 * bound, how many workspaces they take part in, and whether any of them is
 * running. It reports state; it never ranks or recommends.
 */
export function handleAgents(
  db: DatabaseSync,
  req: IncomingMessage,
  res: ServerResponse,
): void {
  if (req.method !== 'GET') {
    throw appError('method_not_allowed', `Method ${req.method} is not allowed`, 405);
  }

  sendJson(res, 200, {
    items: listDirectory(db).map((entry) => ({
      ...entry,
      display_name: getAdapter(entry.agent).displayName,
    })),
  });
}
