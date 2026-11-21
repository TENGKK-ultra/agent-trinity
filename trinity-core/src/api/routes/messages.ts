import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import * as messageService from '../../messages/message.service.ts';
import { appError, isActivityMessageType } from '../../types/index.ts';
import { queryObject, readJsonBody, sendJson } from '../http-utils.ts';

/**
 * These types describe what Core observed, not what a client said. Accepting
 * them from an unauthenticated caller would let any local process fabricate a
 * task anchor or a tool result.
 */
function isInternalOnlyType(value: unknown): boolean {
  return typeof value === 'string' && (isActivityMessageType(value) || value === 'system_event');
}

export async function handleMessages(
  db: DatabaseSync,
  req: IncomingMessage,
  res: ServerResponse,
  segments: string[],
  url: URL,
): Promise<void> {
  const conversationId = decodeURIComponent(segments[2] ?? '');

  if (conversationId === '') {
    throw appError('not_found', 'Not found', 404);
  }

  if (req.method === 'GET') {
    sendJson(res, 200, messageService.listMessages(db, conversationId, queryObject(url)));
    return;
  }

  if (req.method === 'POST') {
    const body = await readJsonBody(req);
    const requestedType = (body as Record<string, unknown>).message_type;

    if (isInternalOnlyType(requestedType)) {
      throw appError(
        'message_type_reserved',
        `message_type "${String(requestedType)}" can only be written by Core`,
        400,
      );
    }

    sendJson(res, 201, messageService.addMessage(db, conversationId, body));
    return;
  }

  throw appError('method_not_allowed', `Method ${req.method} is not allowed`, 405);
}
