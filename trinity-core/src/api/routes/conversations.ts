import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import * as conversationService from '../../conversations/conversation.service.ts';
import { appError } from '../../types/index.ts';
import { queryObject, readJsonBody, sendJson } from '../http-utils.ts';

export async function handleConversations(
  db: DatabaseSync,
  req: IncomingMessage,
  res: ServerResponse,
  segments: string[],
  url: URL,
): Promise<void> {
  if (segments.length === 2) {
    if (req.method === 'GET') {
      sendJson(res, 200, conversationService.listConversations(db, queryObject(url)));
      return;
    }

    if (req.method === 'POST') {
      const body = await readJsonBody(req);
      sendJson(res, 201, conversationService.createConversation(db, body));
      return;
    }

    throw appError('method_not_allowed', `Method ${req.method} is not allowed`, 405);
  }

  const conversationId = decodeURIComponent(segments[2] ?? '');

  if (conversationId === '') {
    throw appError('not_found', 'Not found', 404);
  }

  if (req.method === 'GET') {
    sendJson(res, 200, conversationService.getConversation(db, conversationId));
    return;
  }

  if (req.method === 'PATCH') {
    const body = await readJsonBody(req);
    sendJson(res, 200, conversationService.updateConversation(db, conversationId, body));
    return;
  }

  throw appError('method_not_allowed', `Method ${req.method} is not allowed`, 405);
}
