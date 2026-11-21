import type { DatabaseSync } from 'node:sqlite';
import { USER_ACTOR } from '../changes/change-log.service.ts';
import { appError } from '../types/index.ts';
import * as runtime from './approval.runtime.ts';
import * as service from './approval.service.ts';
import { getAdapter, isSupportedHarness } from './registry.ts';
import type {
  HarnessAdapter,
  HarnessApprovalDecision,
  HarnessApprovalRequest,
} from './types.ts';
import type { ProcessHandle } from './runner.ts';

export const DEFAULT_APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;

export function resolveApprovalTimeout(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.TRINITY_APPROVAL_TIMEOUT_MS;
  if (!raw) return DEFAULT_APPROVAL_TIMEOUT_MS;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1000 || parsed > 60 * 60 * 1000) {
    return DEFAULT_APPROVAL_TIMEOUT_MS;
  }

  return Math.floor(parsed);
}

export interface ApprovalTurnContext {
  db: DatabaseSync;
  conversationId: string;
  harnessSessionId: string;
  turnId: string;
  adapter: HarnessAdapter;
  handle: ProcessHandle;
  timeoutMs: number;
}

const DISPLAY_KEYS = ['command', 'file_path', 'path', 'url', 'pattern', 'query'] as const;
const MAX_DETAIL_CHARS = 500;

/**
 * The path is what the user decides on, so it stays — but the account name is
 * not needed to make that decision.
 */
function redactHome(value: string): string {
  const home = (process.env.USERPROFILE ?? process.env.HOME ?? '').trim();
  if (home === '') return value;

  const escaped = home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return value.replace(new RegExp(escaped, 'i'), '~');
}

/** The one value a human needs to recognise the call; never the whole input. */
function describeInput(input: unknown): string | null {
  if (typeof input !== 'object' || input === null) return null;

  const record = input as Record<string, unknown>;

  for (const key of DISPLAY_KEYS) {
    const value = record[key];
    if (typeof value === 'string' && value.trim() !== '') {
      return redactHome(value).slice(0, MAX_DETAIL_CHARS);
    }
  }

  return null;
}

function describeQuestions(input: unknown): Array<Record<string, unknown>> {
  if (typeof input !== 'object' || input === null) return [];

  const raw = (input as Record<string, unknown>).questions;
  if (!Array.isArray(raw)) return [];

  return raw
    .flatMap((item) => {
      if (typeof item !== 'object' || item === null) return [];

      const question = item as Record<string, unknown>;
      if (typeof question.question !== 'string') return [];

      const options = Array.isArray(question.options)
        ? question.options.flatMap((entry) => {
            if (typeof entry !== 'object' || entry === null) return [];

            const option = entry as Record<string, unknown>;
            if (typeof option.label !== 'string') return [];

            return [
              {
                label: option.label.slice(0, 120),
                description:
                  typeof option.description === 'string' ? option.description.slice(0, 240) : null,
              },
            ];
          })
        : [];

      return [
        {
          question: question.question.slice(0, 500),
          header: typeof question.header === 'string' ? question.header.slice(0, 40) : null,
          options,
          multiSelect: question.multiSelect === true,
        },
      ];
    })
    .slice(0, 8);
}

/**
 * Only what the card shows. A Write carries the whole file body in `input`, and
 * persisting that would copy the file into the database.
 */
function buildPayload(request: HarnessApprovalRequest): Record<string, unknown> {
  const base = {
    tool_name: request.toolName,
    description: request.description,
  };

  if (request.kind === 'question') {
    return { ...base, questions: describeQuestions(request.input) };
  }

  const record =
    typeof request.input === 'object' && request.input !== null
      ? (request.input as Record<string, unknown>)
      : {};

  // A delegation must read as "hand this to Codex", never as an opaque tool call.
  const target = typeof record.target_agent === 'string' ? record.target_agent : null;
  const instruction = typeof record.instruction === 'string' ? record.instruction : null;

  if (target !== null && instruction !== null) {
    return {
      ...base,
      label: `委派任务给 ${target}`,
      detail: redactHome(instruction).slice(0, MAX_DETAIL_CHARS),
      input_keys: Object.keys(record).slice(0, 20),
    };
  }

  const keys = Object.keys(record).slice(0, 20);
  return { ...base, detail: describeInput(request.input), input_keys: keys };
}

/**
 * Persists one ask and arms its timeout. Returns null when this exact native
 * request was already seen, so a repeated frame cannot create a second card.
 */
export function createPendingApproval(
  ctx: ApprovalTurnContext,
  request: HarnessApprovalRequest,
): service.ApprovalRow | null {
  const { row, created } = service.createApproval(ctx.db, {
    conversationId: ctx.conversationId,
    harnessSessionId: ctx.harnessSessionId,
    turnId: ctx.turnId,
    agent: ctx.adapter.type,
    kind: request.kind,
    nativeRequestId: request.requestId,
    toolUseId: request.toolUseId,
    toolName: request.toolName,
    payload: buildPayload(request),
    expiresAt: new Date(Date.now() + ctx.timeoutMs).toISOString(),
  });

  if (!created) return null;

  const timer = setTimeout(() => {
    runtime.takeApproval(row.id);

    // Settle the row first: the record of "expired" must exist before anyone
    // could observe the answer that follows it.
    const expired = service.expireApproval(ctx.db, row.id);
    if (!expired) return;

    const delivered = ctx.adapter.formatApprovalDecision
      ? ctx.handle.write(
          ctx.adapter.formatApprovalDecision(request, {
            behavior: 'deny',
            message: 'This request timed out and was denied automatically.',
          }),
        )
      : false;

    service.setDeliveryStatus(ctx.db, row.id, delivered ? 'delivered' : 'failed');
  }, ctx.timeoutMs);

  timer.unref?.();

  runtime.registerApproval(row.id, {
    turnId: ctx.turnId,
    conversationId: ctx.conversationId,
    agent: ctx.adapter.type,
    request,
    respond: (decision) =>
      ctx.adapter.formatApprovalDecision
        ? ctx.handle.write(ctx.adapter.formatApprovalDecision(request, decision))
        : false,
    cancelTimeout: () => clearTimeout(timer),
  });

  return row;
}

export interface ResolveApprovalInput {
  conversationId: string;
  agent: string;
  decision: 'approve' | 'deny';
  /** Question answers keyed by the question text the provider sent. */
  answers?: Record<string, string>;
}

function buildDecision(
  row: service.ApprovalRow,
  input: ResolveApprovalInput,
  live: runtime.ApprovalRuntimeEntry | undefined,
): HarnessApprovalDecision {
  if (input.decision === 'deny') {
    return { behavior: 'deny', message: 'The user denied this request.' };
  }

  // The provider's own input, from the live entry. Without it the reply would
  // reach a tool with no arguments, so delivery fails rather than guesses.
  const base = (live?.request.input ?? {}) as Record<string, unknown>;

  if (row.kind === 'question') {
    return { behavior: 'allow', input: { ...base, answers: input.answers ?? {} } };
  }

  return { behavior: 'allow', input: base };
}

/**
 * Applies a user decision. The database is written first: a decision the user
 * made stays made even when the CLI can no longer be reached.
 */
export function resolveApproval(
  db: DatabaseSync,
  approvalId: string,
  input: ResolveApprovalInput,
): service.ApprovalRow {
  const row = service.findApproval(db, approvalId);

  if (!row || row.conversation_id !== input.conversationId || row.agent !== input.agent) {
    throw appError('approval_not_found', 'Approval not found', 404);
  }

  if (!isSupportedHarness(row.agent)) {
    throw appError('approval_not_found', 'Approval not found', 404);
  }

  // Validate before touching the runtime: a bad request must not cancel the
  // timer of a request that is still answerable.
  if (
    input.decision === 'approve' &&
    row.kind === 'question' &&
    Object.keys(input.answers ?? {}).length === 0
  ) {
    throw appError('answers_required', 'A question approval needs at least one answer', 400);
  }

  const entry = runtime.takeApproval(approvalId);
  const decision = buildDecision(row, input, entry);
  const record = { behavior: decision.behavior };

  const settled =
    input.decision === 'approve'
      ? service.approveApproval(db, approvalId, record, USER_ACTOR)
      : service.denyApproval(db, approvalId, record, USER_ACTOR);

  if (!settled) {
    throw appError('approval_not_pending', 'This approval is no longer pending', 409);
  }

  const delivered = entry ? entry.respond(decision) : false;
  service.setDeliveryStatus(db, approvalId, delivered ? 'delivered' : 'failed');

  return { ...settled, delivery_status: delivered ? 'delivered' : 'failed' };
}

/** Shape sent to the desktop: payload parsed, nothing else transformed. */
export function toView(row: service.ApprovalRow): Record<string, unknown> {
  let payload: unknown = {};

  try {
    payload = JSON.parse(row.payload_json);
  } catch {
    payload = {};
  }

  return {
    id: row.id,
    conversation_id: row.conversation_id,
    agent: row.agent,
    kind: row.kind,
    tool_name: row.tool_name,
    tool_use_id: row.tool_use_id,
    payload,
    status: row.status,
    delivery_status: row.delivery_status,
    created_at: row.created_at,
    decided_at: row.decided_at,
    expires_at: row.expires_at,
  };
}

export function adapterFor(agent: string): HarnessAdapter | null {
  return isSupportedHarness(agent) ? getAdapter(agent) : null;
}
