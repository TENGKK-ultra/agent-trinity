import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { ensureObject, requireString } from '../../common/validation.ts';
import { startGroupTurn } from '../../group/group.service.ts';
import type { GroupAgent } from '../../group/mentions.ts';
import { HARNESS_TYPES } from '../../harnesses/types.ts';
import type { CoreRuntime } from '../../harnesses/runtime.ts';
import { appError } from '../../types/index.ts';
import { readJsonBody, sendJson } from '../http-utils.ts';

const MAX_CONTENT_LENGTH = 8000;

export async function handleGroup(
  db: DatabaseSync,
  req: IncomingMessage,
  res: ServerResponse,
  conversationId: string,
  runtime: CoreRuntime,
): Promise<void> {
  if (req.method !== 'POST') {
    throw appError('method_not_allowed', `Method ${req.method} is not allowed`, 405);
  }

  const body = ensureObject(await readJsonBody(req));
  const content = requireString(body.content, 'content', MAX_CONTENT_LENGTH);

  let targets: GroupAgent[] | undefined;

  if (body.targets !== undefined) {
    if (!Array.isArray(body.targets)) {
      throw appError('invalid_targets', 'targets must be an array', 400);
    }

    targets = body.targets.map((value) => {
      if (typeof value !== 'string' || !(HARNESS_TYPES as readonly string[]).includes(value)) {
        throw appError('invalid_targets', 'targets must contain supported agents', 400);
      }

      return value as GroupAgent;
    });

    if (targets.length === 0) {
      throw appError('invalid_targets', 'targets must contain at least one agent', 400);
    }
  }

  const mode = body.mode === undefined ? undefined : body.mode;

  if (mode !== undefined && mode !== 'broadcast' && mode !== 'team') {
    throw appError('invalid_mode', "mode must be 'broadcast' or 'team'", 400);
  }

  let dispatcher: GroupAgent | undefined;

  if (body.dispatcher !== undefined) {
    if (
      typeof body.dispatcher !== 'string' ||
      !(HARNESS_TYPES as readonly string[]).includes(body.dispatcher)
    ) {
      throw appError('invalid_dispatcher', 'dispatcher must be a supported agent', 400);
    }

    dispatcher = body.dispatcher as GroupAgent;
  }

  const result = startGroupTurn(db, conversationId, content, {
    runtime,
    targets,
    ...(mode === undefined ? {} : { mode }),
    ...(dispatcher === undefined ? {} : { dispatcher }),
  });

  sendJson(res, 202, {
    group_turn_id: result.groupTurnId,
    mode: mode ?? 'broadcast',
    targets: result.targets,
    waiting: result.waiting,
  });
}
