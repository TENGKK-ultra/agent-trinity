import type { IncomingMessage, ServerResponse } from 'node:http';
import { appError, isAppError } from '../types/index.ts';

const MAX_BODY_BYTES = 1_000_000;

export async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;

    if (size > MAX_BODY_BYTES) {
      throw appError('payload_too_large', 'Request body too large', 413);
    }

    chunks.push(buffer);
  }

  if (size === 0) return {};

  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (raw === '') return {};

  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw appError('invalid_json', 'Request body must be valid JSON', 400);
  }
}

export function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

export function sendError(res: ServerResponse, err: unknown): void {
  if (res.headersSent) {
    res.end();
    return;
  }

  if (isAppError(err)) {
    sendJson(res, err.status, { error: { code: err.code, message: err.message } });
    return;
  }

  // Only the message is logged: stack traces and SQL text can carry local paths or data.
  console.error(
    '[trinity-core] internal error:',
    err instanceof Error ? err.message : String(err),
  );

  sendJson(res, 500, { error: { code: 'internal_error', message: 'Internal server error' } });
}

export function queryObject(url: URL): Record<string, string> {
  const result: Record<string, string> = {};

  for (const [key, value] of url.searchParams) {
    result[key] = value;
  }

  return result;
}
