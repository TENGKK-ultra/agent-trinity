import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { parseBoundedInteger } from '../../common/validation.ts';
import * as conversationRepository from '../../conversations/conversation.repository.ts';
import * as taskService from '../../harnesses/task.service.ts';
import { appError } from '../../types/index.ts';
import {
  conversationUsage,
  taskUsage,
  usageDaily,
  usageSummary,
  type UsageFilters,
} from '../../usage/usage.query.ts';
import { sendJson } from '../http-utils.ts';

const AGENTS = ['claude', 'codex', 'deepseek'] as const;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const MAX_MODEL_LENGTH = 120;

function parseFilters(url: URL): UsageFilters {
  const filters: UsageFilters = {};

  const agent = url.searchParams.get('agent');
  if (agent !== null && agent !== '') {
    if (!(AGENTS as readonly string[]).includes(agent)) {
      throw appError('invalid_agent', `agent must be one of: ${AGENTS.join(', ')}`, 400);
    }
    filters.agent = agent;
  }

  const model = url.searchParams.get('model');
  if (model !== null && model !== '') {
    if (model.length > MAX_MODEL_LENGTH) {
      throw appError('invalid_model', `model must be at most ${MAX_MODEL_LENGTH} characters`, 400);
    }
    filters.model = model;
  }

  const from = url.searchParams.get('from');
  if (from !== null && from !== '') filters.from = from;

  const to = url.searchParams.get('to');
  if (to !== null && to !== '') filters.to = to;

  return filters;
}

function echoFilters(filters: UsageFilters): Record<string, string | null> {
  return {
    from: filters.from ?? null,
    to: filters.to ?? null,
    agent: filters.agent ?? null,
    configured_model: filters.model ?? null,
  };
}

export async function handleUsage(
  db: DatabaseSync,
  req: IncomingMessage,
  res: ServerResponse,
  segments: string[],
  url: URL,
): Promise<void> {
  if (req.method !== 'GET') {
    throw appError('method_not_allowed', `Method ${req.method} is not allowed`, 405);
  }

  const kind = segments[2];
  const filters = parseFilters(url);

  if (kind === 'summary') {
    sendJson(res, 200, { filters: echoFilters(filters), ...usageSummary(db, filters) });
    return;
  }

  if (kind === 'daily') {
    sendJson(res, 200, { filters: echoFilters(filters), days: usageDaily(db, filters) });
    return;
  }

  throw appError('not_found', 'Not found', 404);
}

export async function handleConversationUsage(
  db: DatabaseSync,
  req: IncomingMessage,
  res: ServerResponse,
  conversationId: string,
  url: URL,
): Promise<void> {
  if (req.method !== 'GET') {
    throw appError('method_not_allowed', `Method ${req.method} is not allowed`, 405);
  }

  if (!conversationRepository.findConversation(db, conversationId)) {
    throw appError('conversation_not_found', 'Conversation not found', 404);
  }

  const filters = parseFilters(url);
  const limit = parseBoundedInteger(url.searchParams.get('limit') ?? undefined, 'limit', {
    min: 1,
    max: MAX_LIMIT,
    defaultValue: DEFAULT_LIMIT,
  });
  const offset = parseBoundedInteger(url.searchParams.get('offset') ?? undefined, 'offset', {
    min: 0,
    max: Number.MAX_SAFE_INTEGER,
    defaultValue: 0,
  });

  const result = conversationUsage(db, conversationId, filters, limit, offset);

  sendJson(res, 200, {
    conversation_id: conversationId,
    filters: echoFilters(filters),
    ...result,
    limit,
    offset,
  });
}

export async function handleTaskUsage(
  db: DatabaseSync,
  req: IncomingMessage,
  res: ServerResponse,
  conversationId: string,
  taskId: string,
  url: URL,
): Promise<void> {
  if (req.method !== 'GET') {
    throw appError('method_not_allowed', `Method ${req.method} is not allowed`, 405);
  }

  const task = taskService.findTask(db, taskId);
  if (!task || task.conversation_id !== conversationId) {
    throw appError('task_not_found', 'Task not found', 404);
  }

  const filters = parseFilters(url);

  sendJson(res, 200, {
    task_id: taskId,
    conversation_id: conversationId,
    filters: echoFilters(filters),
    ...taskUsage(db, taskId, filters),
  });
}
