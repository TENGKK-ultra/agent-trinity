import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { parseBoundedInteger } from '../../common/validation.ts';
import * as conversationRepository from '../../conversations/conversation.repository.ts';
import * as taskService from '../../harnesses/task.service.ts';
import { appError } from '../../types/index.ts';
import { queryObject, sendJson } from '../http-utils.ts';

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;
const MAX_PREVIEW_CHARS = 500;

function parseStatus(value: string | null): taskService.TaskStatus | undefined {
  if (value === null || value === '') return undefined;

  const status = taskService.TASK_STATUSES.find((candidate) => candidate === value);
  if (!status) {
    throw appError(
      'invalid_status',
      `status must be one of: ${taskService.TASK_STATUSES.join(', ')}`,
      400,
    );
  }

  return status;
}

function preview(value: string): string {
  return value.length > MAX_PREVIEW_CHARS ? value.slice(0, MAX_PREVIEW_CHARS) : value;
}

/** The instruction is a user message already; lists carry a preview, not the body. */
function taskDto(row: taskService.TaskRow): Record<string, unknown> {
  const { instruction, ...rest } = row;

  return {
    ...rest,
    instruction_preview: preview(instruction),
    instruction_length: instruction.length,
  };
}

export async function handleTasks(
  db: DatabaseSync,
  req: IncomingMessage,
  res: ServerResponse,
  segments: string[],
  url: URL,
): Promise<void> {
  const conversationId = decodeURIComponent(segments[2] ?? '');

  if (conversationId === '' || !conversationRepository.findConversation(db, conversationId)) {
    throw appError('conversation_not_found', 'Conversation not found', 404);
  }

  if (req.method !== 'GET') {
    throw appError('method_not_allowed', `Method ${req.method} is not allowed`, 405);
  }

  if (segments.length === 5) {
    const taskId = decodeURIComponent(segments[4] ?? '');
    const task = taskService.findTask(db, taskId);

    if (!task || task.conversation_id !== conversationId) {
      throw appError('task_not_found', 'Task not found', 404);
    }

    const result = taskService.findResultMessage(db, task.result_message_id);

    sendJson(res, 200, {
      task: taskDto(task),
      result:
        result === null
          ? null
          : {
              message_id: result.id,
              content_preview: preview(result.content),
              created_at: result.created_at,
            },
    });
    return;
  }

  if (segments.length !== 4) {
    throw appError('not_found', 'Not found', 404);
  }

  const params = queryObject(url);
  const status = parseStatus(url.searchParams.get('status'));
  const limit = parseBoundedInteger(params.limit, 'limit', {
    min: 1,
    max: MAX_PAGE_SIZE,
    defaultValue: DEFAULT_PAGE_SIZE,
  });
  const offset = parseBoundedInteger(params.offset, 'offset', {
    min: 0,
    max: Number.MAX_SAFE_INTEGER,
    defaultValue: 0,
  });

  const page = taskService.listTasksPage(db, conversationId, {
    ...(status ? { status } : {}),
    limit,
    offset,
  });

  sendJson(res, 200, {
    items: page.items.map(taskDto),
    total: page.total,
    limit: page.limit,
    offset: page.offset,
  });
}

/** The Dashboard's task list spans every conversation. */
export async function handleAllTasks(
  db: DatabaseSync,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  if (req.method !== 'GET') {
    throw appError('method_not_allowed', `Method ${req.method} is not allowed`, 405);
  }

  const params = queryObject(url);
  const status = parseStatus(url.searchParams.get('status'));
  const limit = parseBoundedInteger(params.limit, 'limit', {
    min: 1,
    max: MAX_PAGE_SIZE,
    defaultValue: DEFAULT_PAGE_SIZE,
  });
  const offset = parseBoundedInteger(params.offset, 'offset', {
    min: 0,
    max: Number.MAX_SAFE_INTEGER,
    defaultValue: 0,
  });

  const page = taskService.listAllTasksPage(db, { ...(status ? { status } : {}), limit, offset });

  sendJson(res, 200, {
    items: page.items.map((row) => ({
      ...taskDto(row),
      conversation_title: row.conversation_title,
    })),
    total: page.total,
    limit: page.limit,
    offset: page.offset,
  });
}
