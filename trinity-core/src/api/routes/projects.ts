import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import {
  createProject,
  listBackgroundIds,
  listProjectMembers,
  listProjects,
  requireProject,
  setBackground,
  setConversationProject,
} from '../../projects/project.service.ts';
import { appError } from '../../types/index.ts';
import { readJsonBody, sendJson } from '../http-utils.ts';

function requireConversationId(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw appError('invalid_conversation_id', 'conversation_id must be a non-empty string', 400);
  }

  return value.trim();
}

export async function handleProjects(
  db: DatabaseSync,
  req: IncomingMessage,
  res: ServerResponse,
  segments: string[],
): Promise<void> {
  if (segments.length === 2) {
    if (req.method === 'GET') {
      sendJson(res, 200, { items: listProjects(db) });
      return;
    }

    if (req.method === 'POST') {
      const body = (await readJsonBody(req)) as Record<string, unknown>;
      sendJson(
        res,
        201,
        createProject(db, { name: body.name, description: body.description }),
      );
      return;
    }

    throw appError('method_not_allowed', `Method ${req.method} is not allowed`, 405);
  }

  const projectId = decodeURIComponent(segments[2] ?? '');

  if (projectId === '') throw appError('not_found', 'Not found', 404);

  if (segments.length === 3) {
    if (req.method !== 'GET') {
      throw appError('method_not_allowed', `Method ${req.method} is not allowed`, 405);
    }

    requireProject(db, projectId);

    sendJson(res, 200, {
      project: requireProject(db, projectId),
      members: listProjectMembers(db, projectId),
      background: listBackgroundIds(db, projectId),
    });
    return;
  }

  if (segments.length === 4 && (segments[3] === 'members' || segments[3] === 'background')) {
    if (req.method !== 'PUT') {
      throw appError('method_not_allowed', `Method ${req.method} is not allowed`, 405);
    }

    const body = (await readJsonBody(req)) as Record<string, unknown>;
    const conversationId = requireConversationId(body.conversation_id);

    if (typeof body.member !== 'boolean') {
      throw appError('invalid_member', 'member must be a boolean', 400);
    }

    if (segments[3] === 'members') {
      requireProject(db, projectId);

      if (body.member) {
        setConversationProject(db, conversationId, projectId);
      } else {
        const row = db
          .prepare('SELECT project_id FROM conversations WHERE id = ?')
          .get(conversationId) as { project_id: string | null } | undefined;

        if (!row) throw appError('conversation_not_found', 'Conversation not found', 404);

        if (row.project_id === projectId) {
          setConversationProject(db, conversationId, null);
        }
      }

      sendJson(res, 200, {
        project: requireProject(db, projectId),
        members: listProjectMembers(db, projectId),
        background: listBackgroundIds(db, projectId),
      });
      return;
    }

    setBackground(db, projectId, conversationId, body.member);
    sendJson(res, 200, {
      background: listBackgroundIds(db, projectId),
    });
    return;
  }

  throw appError('not_found', 'Not found', 404);
}
