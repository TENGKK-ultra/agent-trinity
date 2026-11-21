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
  MESSAGE_TYPES,
  SENDER_KINDS,
} from '../types/index.ts';
import type { Message, MessageType, SenderKind } from '../types/index.ts';
import * as conversationRepository from '../conversations/conversation.repository.ts';
import * as repository from './message.repository.ts';
import { appendChange, USER_ACTOR, type ChangeActor } from '../changes/change-log.service.ts';
import { withTransaction } from '../database/transaction.ts';

const MAX_CONTENT_LENGTH = 100_000;
const MAX_SENDER_ID_LENGTH = 100;
const MAX_PAGE_SIZE = 100;

const DEFAULT_SENDER_KIND: Record<MessageType, SenderKind> = {
  user_message: 'user',
  agent_message: 'agent',
  agent_final: 'agent',
  tool_call: 'agent',
  tool_result: 'agent',
  system_event: 'system',
  task_status: 'system',
};

export interface MessageListResult {
  items: Message[];
  total: number;
  limit: number;
  offset: number;
}

function serializeMetadata(value: unknown): string | null {
  if (value === undefined || value === null) return null;

  if (typeof value !== 'object' || Array.isArray(value)) {
    throw appError('invalid_metadata', 'metadata must be a JSON object', 400);
  }

  try {
    return JSON.stringify(value);
  } catch {
    throw appError('invalid_metadata', 'metadata must be JSON-serializable', 400);
  }
}

export function addMessage(
  db: DatabaseSync,
  conversationId: string,
  input: unknown,
  actor: ChangeActor = USER_ACTOR,
): Message {
  const conversation = conversationRepository.findConversation(db, conversationId);

  if (!conversation) {
    throw appError('conversation_not_found', 'Conversation not found', 404);
  }

  if (conversation.status === 'archived') {
    throw appError('conversation_archived', 'Conversation is archived', 409);
  }

  const body = ensureObject(input);
  const messageType = parseEnumWithDefault(
    body.message_type,
    'message_type',
    MESSAGE_TYPES,
    'user_message',
  );
  const content = requireString(body.content, 'content', MAX_CONTENT_LENGTH);
  const senderKind = parseEnumWithDefault(
    body.sender_kind,
    'sender_kind',
    SENDER_KINDS,
    DEFAULT_SENDER_KIND[messageType],
  );

  let senderId: string | null = null;

  if (body.sender_id !== undefined && body.sender_id !== null) {
    senderId = requireString(body.sender_id, 'sender_id', MAX_SENDER_ID_LENGTH);
  }

  const metadataJson = serializeMetadata(body.metadata);

  let parentMessageId: string | null = null;

  if (body.parent_message_id !== undefined && body.parent_message_id !== null) {
    const parent = repository.findMessage(db, String(body.parent_message_id));

    if (!parent || parent.conversation_id !== conversationId) {
      throw appError(
        'invalid_parent_message',
        'parent_message_id must reference a message in the same conversation',
        400,
      );
    }

    parentMessageId = parent.id;
  }

  const now = new Date().toISOString();

  const message: Message = {
    id: randomUUID(),
    conversation_id: conversationId,
    sender_kind: senderKind,
    sender_id: senderId,
    message_type: messageType,
    content,
    metadata_json: metadataJson,
    parent_message_id: parentMessageId,
    created_at: now,
  };

  withTransaction(db, () => {
    repository.insertMessage(db, message);
    conversationRepository.touchConversation(db, conversationId, now);

    // Metadata only: the body stays in `messages`, which is the source of truth.
    appendChange(db, {
      entityType: 'message',
      entityId: message.id,
      operation: 'insert',
      actor,
      conversationId,
      payload: {
        message_type: message.message_type,
        sender_kind: message.sender_kind,
        sender_id: message.sender_id,
        parent_message_id: message.parent_message_id,
        created_at: message.created_at,
      },
    });
  });

  return message;
}

export function listMessages(
  db: DatabaseSync,
  conversationId: string,
  query: unknown,
): MessageListResult {
  if (!conversationRepository.findConversation(db, conversationId)) {
    throw appError('conversation_not_found', 'Conversation not found', 404);
  }

  const params = (query ?? {}) as Record<string, unknown>;

  const messageType = parseOptionalEnum(params.message_type, 'message_type', MESSAGE_TYPES);
  const senderKind = parseOptionalEnum(params.sender_kind, 'sender_kind', SENDER_KINDS);
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

  const includeActivity =
    params.include_activity === true ||
    params.include_activity === '1' ||
    params.include_activity === 'true';

  // An explicit type filter wins: asking for tool_call must return tool calls.
  // Otherwise the conversation view leaves internal activity out by default.
  const filters = {
    messageType,
    senderKind,
    excludeActivity: !messageType && !includeActivity,
  };

  const items = repository.listMessages(db, conversationId, { ...filters, limit, offset });
  const total = repository.countMessages(db, conversationId, filters);

  return { items, total, limit, offset };
}
