import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { search } from '../../search/search.service.ts';
import { appError } from '../../types/index.ts';
import { queryObject, sendJson } from '../http-utils.ts';

/** GET /api/search?q=&limit= */
export async function handleSearch(
  db: DatabaseSync,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  if (req.method !== 'GET') {
    throw appError('method_not_allowed', `Method ${req.method} is not allowed`, 405);
  }

  const query = queryObject(url);
  sendJson(res, 200, search(db, query.q, { limit: query.limit }));
}
