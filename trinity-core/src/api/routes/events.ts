import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { listEvents } from '../../events/event.service.ts';
import { appError } from '../../types/index.ts';
import { queryObject, sendJson } from '../http-utils.ts';

/** GET /api/events?filter=all|task|system|error&limit=&offset= */
export async function handleEvents(
  db: DatabaseSync,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  if (req.method !== 'GET') {
    throw appError('method_not_allowed', `Method ${req.method} is not allowed`, 405);
  }

  const query = queryObject(url);
  sendJson(
    res,
    200,
    listEvents(db, { filter: query.filter, limit: query.limit, offset: query.offset }),
  );
}
