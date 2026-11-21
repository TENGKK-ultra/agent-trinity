import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  ensureObject,
  parseBoundedInteger,
  parseEnumWithDefault,
  parseOptionalEnum,
  requireString,
} from '../common/validation.ts';
import {
  appError,
  CONVERSATION_STATUSES,
} from '../types/index.ts';
import type { Conversation, ConversationStatus } from '../types/index.ts';
import * as repository from './conversation.repository.ts';
import { appendChange, USER_ACTOR, type ChangeActor } from '../changes/change-log.service.ts';
import { withTransaction } from '../database/transaction.ts';

const MAX_TITLE_LENGTH = 200;
const MAX_PAGE_SIZE = 100;

export interface ConversationListResult {
  items: Conversation[];
  total: number;
  limit: number;
  offset: number;
}

function optionalQueryString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') {
    throw appError(`invalid_${field}`, `${field} must be a string`, 400);
  }
  return value;
}

export function createConversation(
  db: DatabaseSync,
  input: unknown,
  actor: ChangeActor = USER_ACTOR,
): Conversation {
  const body = ensureObject(input);
  const title = requireString(body.title, 'title', MAX_TITLE_LENGTH);

  let projectId: string | null = null;

  if (body.project_id !== undefined && body.project_id !== null) {
    if (typeof body.project_id !== 'string' || body.project_id.trim() === '') {
      throw appError('invalid_project_id', 'project_id must be a non-empty string', 400);
    }

    const project = db
      .prepare('SELECT id FROM projects WHERE id = ?')
      .get(body.project_id) as { id: string } | undefined;

    if (!project) {
      throw appError('project_not_found', 'Project not found', 404);
    }

    projectId = body.project_id;
  }

  const now = new Date().toISOString();

  const conversation: Conversation = {
    id: randomUUID(),
    project_id: projectId,
    title,
    title_source: 'default',
    status: 'active',
    created_at: now,
    updated_at: now,
  };

  withTransaction(db, () => {
    repository.insertConversation(db, conversation);
    appendChange(db, {
      entityType: 'conversation',
      entityId: conversation.id,
      operation: 'insert',
      actor,
      conversationId: conversation.id,
      payload: {
        title: conversation.title,
        project_id: conversation.project_id,
        status: conversation.status,
      },
    });
  });

  return conversation;
}

export function getConversation(db: DatabaseSync, id: string): Conversation {
  const conversation = repository.findConversation(db, id);

  if (!conversation) {
    throw appError('conversation_not_found', 'Conversation not found', 404);
  }

  return conversation;
}

export function listConversations(db: DatabaseSync, query: unknown): ConversationListResult {
  const params = (query ?? {}) as Record<string, unknown>;

  const status = parseOptionalEnum(params.status, 'status', CONVERSATION_STATUSES);
  const title = optionalQueryString(params.title, 'title');
  const sort = parseEnumWithDefault(params.sort, 'sort', ['created', 'updated'] as const, 'updated');
  const order = parseEnumWithDefault(params.order, 'order', ['asc', 'desc'] as const, 'desc');
  const limit = parseBoundedInteger(params.limit, 'limit', {
    min: 1,
    max: MAX_PAGE_SIZE,
    defaultValue: 20,
  });
  const offset = parseBoundedInteger(params.offset, 'offset', {
    min: 0,
    max: Number.MAX_SAFE_INTEGER,
    defaultValue: 0,
  });

  const items = repository.listConversations(db, {
    status,
    title,
    sort,
    order,
    limit,
    offset,
  });

  const total = repository.countConversations(db, { status, title });

  return { items, total, limit, offset };
}

export function updateConversation(
  db: DatabaseSync,
  id: string,
  input: unknown,
  actor: ChangeActor = USER_ACTOR,
): Conversation {
  getConversation(db, id);
  const body = ensureObject(input);

  if (body.title === undefined && body.status === undefined) {
    throw appError('empty_update', 'Provide at least one of: title, status', 400);
  }

  const title =
    body.title === undefined ? undefined : requireString(body.title, 'title', MAX_TITLE_LENGTH);

  const status: ConversationStatus | undefined = parseOptionalEnum(
    body.status,
    'status',
    CONVERSATION_STATUSES,
  );

  withTransaction(db, () => {
    repository.updateConversation(db, id, {
      title,
      status,
      updated_at: new Date().toISOString(),
    });

    // A title typed through the API is the user's; an auto title must stop
    // replacing it.
    if (title !== undefined) {
      db.prepare("UPDATE conversations SET title_source = 'user' WHERE id = ?").run(id);
    }

    appendChange(db, {
      entityType: 'conversation',
      entityId: id,
      operation: 'update',
      actor,
      conversationId: id,
      payload: { title: title ?? null, status: status ?? null },
    });
  });

  return getConversation(db, id);
}
