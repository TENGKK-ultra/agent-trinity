import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import * as delegation from '../../harnesses/delegation.service.ts';
import { resolveDelegationTimeout } from '../../harnesses/delegation.timeouts.ts';
import type { CoreRuntime } from '../../harnesses/runtime.ts';
import * as taskService from '../../harnesses/task.service.ts';
import * as tokenService from '../../harnesses/token.service.ts';
import { HARNESS_TYPES } from '../../harnesses/types.ts';
import { appError } from '../../types/index.ts';
import { readJsonBody, sendJson } from '../http-utils.ts';

const MAX_INSTRUCTION_LENGTH = taskService.MAX_INSTRUCTION_LENGTH;

function readBearer(req: IncomingMessage): string | null {
  const header = req.headers.authorization;

  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return null;

  const token = header.slice('Bearer '.length).trim();
  return token === '' ? null : token;
}

function requireEntry(req: IncomingMessage): tokenService.DelegationTokenEntry {
  const result = tokenService.validateToken(readBearer(req));

  if (!result.ok) {
    // Same shape for every rejection: a caller learns nothing from the reason.
    throw appError('unauthorized', 'A valid delegation token is required', 401);
  }

  return result.entry;
}

function requireString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string') {
    throw appError(`invalid_${field}`, `${field} must be a string`, 400);
  }

  const trimmed = value.trim();

  if (trimmed === '') {
    throw appError(`invalid_${field}`, `${field} must not be empty`, 400);
  }

  if (trimmed.length > maxLength) {
    throw appError(`invalid_${field}`, `${field} is too long`, 400);
  }

  return trimmed;
}

async function handleCreate(
  db: DatabaseSync,
  req: IncomingMessage,
  res: ServerResponse,
  entry: tokenService.DelegationTokenEntry,
  runtime: CoreRuntime,
): Promise<void> {
  const body = (await readJsonBody(req)) as Record<string, unknown>;

  const requestId = requireString(body.request_id, 'request_id', 128);
  const instruction = requireString(body.instruction, 'instruction', MAX_INSTRUCTION_LENGTH);
  const targetAgent = requireString(body.target_agent, 'target_agent', 32);

  if (!(HARNESS_TYPES as readonly string[]).includes(targetAgent)) {
    throw appError('invalid_target_agent', `Unknown target agent: ${targetAgent}`, 400);
  }

  const title =
    typeof body.title === 'string' && body.title.trim() !== '' ? body.title.trim() : null;

  const claim = tokenService.claimRequest(entry, requestId);

  if (claim.type === 'quota_exceeded') {
    throw appError('delegation_quota_exceeded', 'This turn has used its delegation allowance', 429);
  }

  if (claim.type === 'reuse') {
    const existing = taskService.findTask(db, claim.taskId);

    if (!existing) {
      throw appError('task_missing', 'The task for this request id no longer exists', 409);
    }

    sendTask(res, 200, await delegation.awaitTask(db, existing.id));
    return;
  }

  if (claim.type === 'wait') {
    const outcome = await claim.result;

    if (!outcome.ok) {
      throw appError(
        'delegation_failed',
        outcome.error instanceof Error ? outcome.error.message : 'Delegation could not be created',
        502,
      );
    }

    sendTask(res, 200, await delegation.awaitTask(db, outcome.taskId));
    return;
  }

  // Identity comes from the token only. Anything the body says about who is
  // calling, or which conversation this is, is ignored.
  let task: taskService.TaskRow;

  try {
    task = taskService.createTask(db, {
      conversationId: entry.conversationId,
      sourceAgent: entry.sourceAgent,
      sourceTurnId: entry.sourceTurnId,
      targetAgent,
      instruction,
      title,
      // A delegation made from a collaboration checkpoint belongs to that round:
      // it joins the round's chain so the orchestrator picks it up and the usage
      // budget sees it. Outside a round, the ordinary one-hop rule applies.
      ...(entry.roundId === null ? {} : { chainId: entry.roundId, orchestrated: true }),
    });

    claim.settle({ ok: true, taskId: task.id, error: null });
  } catch (err) {
    claim.settle({ ok: false, taskId: '', error: err });
    throw err;
  }

  // The execution budget is stated here rather than inherited from a service
  // default: the caller's wait is configured from the same value.
  sendTask(
    res,
    201,
    await delegation.executeTask(db, task, {
      adapter: runtime.getAdapter(targetAgent),
      timeoutMs: resolveDelegationTimeout(),
    }),
  );
}

function sendTask(
  res: ServerResponse,
  status: number,
  result: delegation.TaskResult,
): void {
  const { task, resultText } = result;

  sendJson(res, status, {
    task_id: task.id,
    status: task.status,
    ...(resultText !== null ? { result: resultText } : {}),
    ...(task.error_text ? { error: task.error_text } : {}),
  });
}

function handleDelivered(
  db: DatabaseSync,
  res: ServerResponse,
  entry: tokenService.DelegationTokenEntry,
  taskId: string,
): void {
  const task = taskService.findTask(db, taskId);

  if (!task || task.conversation_id !== entry.conversationId) {
    throw appError('task_not_found', 'Task not found', 404);
  }

  // Only a pending delivery may move; a repeat call reports the same state.
  taskService.setDeliveryStatus(db, taskId, 'delivered');
  const updated = taskService.findTask(db, taskId);

  sendJson(res, 200, {
    task_id: taskId,
    delivery_status: updated?.delivery_status ?? 'pending',
  });
}

export async function handleInternal(
  db: DatabaseSync,
  req: IncomingMessage,
  res: ServerResponse,
  segments: string[],
  url: URL,
  runtime: CoreRuntime,
): Promise<void> {
  const entry = requireEntry(req);

  if (segments.length === 3 && segments[2] === 'tasks') {
    if (req.method !== 'POST') {
      throw appError('method_not_allowed', `Method ${req.method} is not allowed`, 405);
    }

    await handleCreate(db, req, res, entry, runtime);
    return;
  }

  if (segments.length === 5 && segments[2] === 'tasks' && segments[4] === 'delivered') {
    if (req.method !== 'POST') {
      throw appError('method_not_allowed', `Method ${req.method} is not allowed`, 405);
    }

    handleDelivered(db, res, entry, decodeURIComponent(segments[3] ?? ''));
    return;
  }

  throw appError('not_found', 'Not found', 404);
}
