import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { appError } from '../../types/index.ts';
import {
  createWorkspace,
  listWorkspaces,
  WORKSPACES_ROOT,
} from '../../workspaces/workspace.service.ts';
import { readJsonBody, sendJson } from '../http-utils.ts';

export async function handleWorkspaces(
  db: DatabaseSync,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (req.method === 'GET') {
    sendJson(res, 200, { items: listWorkspaces(db), default_root: WORKSPACES_ROOT });
    return;
  }

  if (req.method === 'POST') {
    const body = (await readJsonBody(req)) as Record<string, unknown>;

    sendJson(res, 201, createWorkspace(db, { name: body.name, path: body.path }));
    return;
  }

  throw appError('method_not_allowed', `Method ${req.method} is not allowed`, 405);
}
