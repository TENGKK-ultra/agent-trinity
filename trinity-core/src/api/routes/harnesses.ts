import { statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import * as conversationRepository from '../../conversations/conversation.repository.ts';
import { USER_ACTOR } from '../../changes/change-log.service.ts';
import { getAdapter, isSupportedHarness, SUPPORTED_HARNESSES } from '../../harnesses/registry.ts';
import type { CoreRuntime } from '../../harnesses/runtime.ts';
import * as sessionService from '../../harnesses/session.service.ts';
import { DEFAULT_TURN_TIMEOUT_MS, sendTurn } from '../../harnesses/turn.service.ts';
import { appError } from '../../types/index.ts';
import { readJsonBody, sendJson } from '../http-utils.ts';

const MAX_CONTENT_LENGTH = 100_000;
const MAX_CWD_LENGTH = 1024;
const MAX_MODEL_LENGTH = 128;
const DEFAULT_HARNESS = 'claude';

function requireConversation(db: DatabaseSync, conversationId: string): void {
  if (!conversationId) {
    throw appError('not_found', 'Not found', 404);
  }

  if (!conversationRepository.findConversation(db, conversationId)) {
    throw appError('conversation_not_found', 'Conversation not found', 404);
  }
}

function optionalString(value: unknown, field: string, maxLength: number): string | null {
  if (value === undefined || value === null || value === '') return null;

  if (typeof value !== 'string') {
    throw appError(`invalid_${field}`, `${field} must be a string`, 400);
  }

  const trimmed = value.trim();
  if (trimmed === '') return null;

  if (trimmed.length > maxLength) {
    throw appError(`invalid_${field}`, `${field} is too long`, 400);
  }

  return trimmed;
}

function displayNameOf(harnessType: string): string {
  return isSupportedHarness(harnessType) ? getAdapter(harnessType).displayName : harnessType;
}

/**
 * A conversation can keep one session per harness; `agent` mirrors the active
 * one for older callers, `bindings` is the full picture.
 */
function describeState(db: DatabaseSync, conversationId: string): Record<string, unknown> {
  const rows = sessionService.listBindings(db, conversationId);
  const active = rows.find((row) => row.active === 1) ?? null;

  return {
    agent: active?.harness_type ?? null,
    active_agent: active?.harness_type ?? null,
    available: SUPPORTED_HARNESSES,
    bindings: rows.map((row) => ({
      agent: row.harness_type,
      display_name: displayNameOf(row.harness_type),
      active: row.active === 1,
      participating: row.participating === 1,
      status: row.status,
      native_session_id: row.native_session_id || null,
      cwd: row.cwd,
      model: row.model,
      permission_mode: row.permission_mode ?? null,
      last_seen_at: row.last_seen_at,
      created_at: row.created_at,
    })),
  };
}

function resolveTimeout(): number {
  const raw = process.env.TRINITY_TURN_TIMEOUT_MS;
  if (!raw) return DEFAULT_TURN_TIMEOUT_MS;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1000 || parsed > 2 * 60 * 60 * 1000) {
    return DEFAULT_TURN_TIMEOUT_MS;
  }

  return Math.floor(parsed);
}

/**
 * Moving or dropping the active agent while it is still working leaves a real
 * process with no visible owner. The lock is the authority, not `status`.
 */
function hasLiveRunLock(db: DatabaseSync, sessionId: string): boolean {
  const lock = sessionService.findHeldLock(db, sessionId);
  if (!lock) return false;

  return !lock.expires_at || lock.expires_at > new Date().toISOString();
}

/** Binding must not pretend to succeed when the CLI cannot be found. */
function checkAvailable(harnessType: string): string | null {
  const adapter = getAdapter(harnessType);

  try {
    const executable = adapter.resolveExecutable();
    return executable.warnings && executable.warnings.length > 0
      ? executable.warnings.join(' ')
      : null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const probes = (err as { probes?: unknown }).probes;
    const detail =
      Array.isArray(probes) && probes.length > 0
        ? `${message} ${probes.slice(0, 3).join('; ')}`
        : message;

    throw appError('harness_unavailable', `${adapter.displayName} is not available: ${detail}`, 422);
  }
}

async function handleAgent(
  db: DatabaseSync,
  req: IncomingMessage,
  res: ServerResponse,
  conversationId: string,
  url: URL,
): Promise<void> {
  requireConversation(db, conversationId);

  if (req.method === 'GET') {
    sendJson(res, 200, describeState(db, conversationId));
    return;
  }

  if (req.method === 'POST') {
    const body = (await readJsonBody(req)) as Record<string, unknown>;
    const requested = optionalString(body.agent, 'agent', 32) ?? DEFAULT_HARNESS;

    if (!isSupportedHarness(requested)) {
      throw appError(
        'unsupported_harness',
        `Harness "${requested}" is not supported. Available: ${SUPPORTED_HARNESSES.join(', ')}`,
        400,
      );
    }

    const cwd = optionalString(body.cwd, 'cwd', MAX_CWD_LENGTH);
    const model = optionalString(body.model, 'model', MAX_MODEL_LENGTH);
    // Joining the conversation must be possible without taking the current slot
    // from the agent that already holds it.
    const makeActive = body.active !== false;

    if (cwd) {
      let isDirectory = false;

      try {
        isDirectory = statSync(cwd).isDirectory();
      } catch {
        isDirectory = false;
      }

      if (!isDirectory) {
        throw appError('invalid_cwd', 'cwd must be an existing directory', 400);
      }
    }

    const current = sessionService.findActiveSession(db, conversationId);

    if (
      makeActive &&
      current &&
      current.harness_type !== requested &&
      hasLiveRunLock(db, current.id)
    ) {
      throw appError(
        'turn_in_progress',
        'The current agent is still running; wait for it to finish before switching',
        409,
      );
    }

    const warning = checkAvailable(requested);

    const { created } = sessionService.activateBinding(
      db,
      conversationId,
      { harnessType: requested, cwd, model, makeActive },
      USER_ACTOR,
    );

    sendJson(res, created ? 201 : 200, {
      ...describeState(db, conversationId),
      warning,
    });
    return;
  }

  if (req.method === 'PATCH') {
    const body = (await readJsonBody(req)) as Record<string, unknown>;
    const requested = optionalString(body.agent, 'agent', 32);

    if (!requested || !isSupportedHarness(requested)) {
      throw appError('invalid_agent', 'agent must be a supported harness', 400);
    }

    if (typeof body.participating !== 'boolean') {
      throw appError('invalid_participating', 'participating must be a boolean', 400);
    }

    const target = sessionService.findSession(db, conversationId, requested);

    if (!target) {
      throw appError('agent_not_bound', `${requested} is not bound to this conversation`, 404);
    }

    if (!body.participating && hasLiveRunLock(db, target.id)) {
      throw appError(
        'turn_in_progress',
        'This agent is still running; wait for it to finish before leaving the conversation',
        409,
      );
    }

    const session = sessionService.setParticipating(
      db,
      conversationId,
      requested,
      body.participating,
      USER_ACTOR,
    );

    sendJson(res, 200, {
      ...describeState(db, conversationId),
      agent: requested,
      participating: session.participating === 1,
    });
    return;
  }

  if (req.method === 'DELETE') {
    const requested = optionalString(url.searchParams.get('agent'), 'agent', 32);

    if (!requested || !isSupportedHarness(requested)) {
      throw appError('invalid_agent', 'Query parameter "agent" is required', 400);
    }

    const target = sessionService.findSession(db, conversationId, requested);

    if (target && hasLiveRunLock(db, target.id)) {
      throw appError(
        'turn_in_progress',
        'This agent is still running; wait for it to finish before unbinding',
        409,
      );
    }

    const { removed, wasActive, promoted } = sessionService.removeBinding(
      db,
      conversationId,
      requested,
      USER_ACTOR,
    );

    sendJson(res, 200, {
      ...describeState(db, conversationId),
      removed,
      was_active: wasActive,
      promoted,
    });
    return;
  }

  throw appError('method_not_allowed', `Method ${req.method} is not allowed`, 405);
}

async function handleTurn(
  db: DatabaseSync,
  req: IncomingMessage,
  res: ServerResponse,
  conversationId: string,
  runtime: CoreRuntime,
  coreBaseUrl?: string,
): Promise<void> {
  if (req.method !== 'POST') {
    throw appError('method_not_allowed', `Method ${req.method} is not allowed`, 405);
  }

  requireConversation(db, conversationId);

  const body = (await readJsonBody(req)) as Record<string, unknown>;
  const content = typeof body.content === 'string' ? body.content : '';

  if (content.trim() === '') {
    throw appError('invalid_content', 'content must be a non-empty string', 400);
  }

  if (content.length > MAX_CONTENT_LENGTH) {
    throw appError('invalid_content', 'content is too long', 400);
  }

  const active = sessionService.findActiveSession(db, conversationId);
  const activeType =
    active && isSupportedHarness(active.harness_type) ? active.harness_type : DEFAULT_HARNESS;

  const result = sendTurn(db, conversationId, content, {
    adapter: runtime.getAdapter(activeType),
    timeoutMs: resolveTimeout(),
    cwd: process.cwd(),
    // The agent's MCP server has to reach this instance, whatever port it bound.
    coreBaseUrl,
  });

  sendJson(res, result.turnId ? 202 : 201, {
    message: result.message,
    turn_id: result.turnId,
    agent: result.turnId ? activeType : null,
  });
}

export async function handleHarnesses(
  db: DatabaseSync,
  req: IncomingMessage,
  res: ServerResponse,
  segments: string[],
  url: URL,
  runtime: CoreRuntime,
  coreBaseUrl?: string,
): Promise<void> {
  const conversationId = decodeURIComponent(segments[2] ?? '');
  const resource = segments[3];

  if (resource === 'agent') {
    await handleAgent(db, req, res, conversationId, url);
    return;
  }

  if (resource === 'turns') {
    await handleTurn(db, req, res, conversationId, runtime, coreBaseUrl);
    return;
  }

  if (resource === 'permission') {
    await handlePermission(db, req, res, conversationId);
    return;
  }

  throw appError('not_found', 'Not found', 404);
}

async function handlePermission(
  db: DatabaseSync,
  req: IncomingMessage,
  res: ServerResponse,
  conversationId: string,
): Promise<void> {
  if (req.method !== 'PUT') {
    throw appError('method_not_allowed', `Method ${req.method} is not allowed`, 405);
  }

  requireConversation(db, conversationId);

  const body = (await readJsonBody(req)) as Record<string, unknown>;
  const raw = body.mode;

  if (
    raw !== null &&
    (typeof raw !== 'string' ||
      !(sessionService.PERMISSION_MODES as readonly string[]).includes(raw))
  ) {
    throw appError(
      'invalid_permission_mode',
      'mode must be manual, acceptEdits, plan, bypassPermissions, or null',
      400,
    );
  }

  sessionService.setConversationPermissionMode(
    db,
    conversationId,
    raw as sessionService.PermissionMode | null,
    USER_ACTOR,
  );

  sendJson(res, 200, describeState(db, conversationId));
}
