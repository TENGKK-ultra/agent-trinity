import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import * as activityService from '../../harnesses/activity.service.ts';
import { appError } from '../../types/index.ts';
import { queryObject, sendJson } from '../http-utils.ts';

export async function handleActivity(
  db: DatabaseSync,
  req: IncomingMessage,
  res: ServerResponse,
  segments: string[],
  url: URL,
): Promise<void> {
  if (req.method !== 'GET') {
    throw appError('method_not_allowed', `Method ${req.method} is not allowed`, 405);
  }

  const conversationId = decodeURIComponent(segments[2] ?? '');

  if (segments.length === 5) {
    const messageId = decodeURIComponent(segments[4] ?? '');
    sendJson(res, 200, activityService.getActivityItem(db, conversationId, messageId));
    return;
  }

  sendJson(res, 200, activityService.listActivity(db, conversationId, queryObject(url)));
}
