import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import * as board from '../../board/board.service.ts';
import { startCrossReview } from '../../board/cross-review.service.ts';
import * as conversationRepository from '../../conversations/conversation.repository.ts';
import { ensureObject, parseBoundedInteger } from '../../common/validation.ts';
import type { CoreRuntime } from '../../harnesses/runtime.ts';
import { appError } from '../../types/index.ts';
import { queryObject, readJsonBody, sendJson } from '../http-utils.ts';

function requireConversation(db: DatabaseSync, conversationId: string): void {
  if (!conversationRepository.findConversation(db, conversationId)) {
    throw appError('conversation_not_found', 'Conversation not found', 404);
  }
}

function optionalText(value: unknown, field: string, max: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw appError(`invalid_${field}`, `${field} must be a string`, 400);

  const text = value.trim();

  if (text === '') return undefined;
  if (text.length > max) throw appError(`invalid_${field}`, `${field} is too long`, 400);

  return text;
}

function jsonList(value: string | null): string[] {
  if (value === null) return [];

  try {
    const parsed = JSON.parse(value) as unknown;

    return Array.isArray(parsed) ? parsed.map((item) => String(item)) : [];
  } catch {
    return [];
  }
}

function cardDto(card: board.CardRow): Record<string, unknown> {
  return {
    id: card.id,
    conversation_id: card.conversation_id,
    title: card.title,
    goal: card.goal,
    inputs: jsonList(card.inputs_json),
    acceptance: jsonList(card.acceptance_json),
    constraints_text: card.constraints_text,
    required_capabilities: jsonList(card.required_capabilities_json),
    status: card.status,
    created_by_kind: card.created_by_kind,
    created_by: card.created_by,
    claimed_by: card.claimed_by,
    claim_expires_at: card.claim_expires_at,
    result_message_id: card.result_message_id,
    execution_task_id: card.execution_task_id,
    requested_agent: card.requested_agent,
    cross_round_limit: card.cross_round_limit,
    cross_round_used: card.cross_round_used,
    cross_phase: card.cross_phase,
    created_at: card.created_at,
    updated_at: card.updated_at,
    closed_at: card.closed_at,
  };
}

function findingDto(row: board.FindingRow): Record<string, unknown> {
  return {
    id: row.id,
    card_id: row.card_id,
    round_no: row.round_no,
    title: row.title,
    detail: row.detail,
    status: row.status,
    raised_by: row.raised_by,
    resolved_by: row.resolved_by,
    created_at: row.created_at,
    resolved_at: row.resolved_at,
  };
}

function eventDto(row: board.BoardEventRow): Record<string, unknown> {
  return {
    id: row.id,
    kind: row.kind,
    actor_kind: row.actor_kind,
    actor: row.actor,
    detail: row.detail_json === null ? null : safeJson(row.detail_json),
    created_at: row.created_at,
  };
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

function messageDto(row: board.BoardMessageRow): Record<string, unknown> {
  return {
    id: row.id,
    card_id: row.card_id,
    kind: row.kind,
    from_kind: row.from_kind,
    from_agent: row.from_agent,
    to_agent: row.to_agent,
    content: row.content,
    parent_message_id: row.parent_message_id,
    hop: row.hop,
    state: row.state,
    created_at: row.created_at,
  };
}

function parseCardStatus(value: string | null): board.CardStatus | undefined {
  if (value === null || value === '') return undefined;

  if (!(board.CARD_STATUSES as readonly string[]).includes(value)) {
    throw appError('invalid_status', `status must be one of: ${board.CARD_STATUSES.join(', ')}`, 400);
  }

  return value as board.CardStatus;
}

async function createCard(
  db: DatabaseSync,
  req: IncomingMessage,
  res: ServerResponse,
  conversationId: string,
): Promise<void> {
  const body = ensureObject(await readJsonBody(req));
  const title = optionalText(body.title, 'title', 200);
  const goal = optionalText(body.goal, 'goal', 8000);

  if (title === undefined) throw appError('invalid_title', 'title must not be empty', 400);
  if (goal === undefined) throw appError('invalid_goal', 'goal must not be empty', 400);

  const card = board.createCard(
    db,
    conversationId,
    {
      title,
      goal,
      inputs: body.inputs,
      acceptance: body.acceptance,
      constraintsText: optionalText(body.constraints_text, 'constraints', 8000),
      requiredCapabilities: body.required_capabilities,
      ...(body.requested_agent === undefined
        ? {}
        : { requestedAgent: body.requested_agent }),
      ...(body.cross_round_limit === undefined
        ? {}
        : { crossRoundLimit: body.cross_round_limit as number }),
    },
    board.boardUser(db, conversationId),
  );

  sendJson(res, 201, { card: cardDto(card) });
}

async function closeCard(
  db: DatabaseSync,
  req: IncomingMessage,
  res: ServerResponse,
  cardId: string,
): Promise<void> {
  const body = ensureObject(await readJsonBody(req));
  const reason = optionalText(body.reason, 'reason', 8000) ?? '用户关闭';

  const card = board.cancelCard(db, cardId, reason);
  sendJson(res, 200, { card: cardDto(card) });
}

/**
 * `/api/conversations/:id/board...` — the user's read/write surface. Claim and
 * renew are deliberately absent: those are agent actions, not user actions.
 */
export async function handleBoard(
  db: DatabaseSync,
  req: IncomingMessage,
  res: ServerResponse,
  segments: string[],
  url: URL,
  runtime: CoreRuntime,
): Promise<void> {
  const conversationId = decodeURIComponent(segments[2] ?? '');

  requireConversation(db, conversationId);

  if (segments.length === 4) {
    if (req.method === 'GET') {
      const cards = board.listCards(db, conversationId, parseCardStatus(url.searchParams.get('status')));
      sendJson(res, 200, { items: cards.map(cardDto) });
      return;
    }

    if (req.method === 'POST') {
      await createCard(db, req, res, conversationId);
      return;
    }

    throw appError('method_not_allowed', `Method ${req.method} is not allowed`, 405);
  }

  if (segments.length >= 5) {
    const cardId = decodeURIComponent(segments[4] ?? '');
    const card = board.findCard(db, cardId);

    if (!card || card.conversation_id !== conversationId) {
      throw appError('card_not_found', 'Card not found', 404);
    }

    if (segments.length === 5) {
      if (req.method !== 'GET') {
        throw appError('method_not_allowed', `Method ${req.method} is not allowed`, 405);
      }

      const detail = board.cardDetail(db, cardId);

      sendJson(res, 200, {
        card: cardDto(detail.card),
        events: detail.events.map(eventDto),
        messages: detail.messages.map(messageDto),
        findings: detail.findings.map(findingDto),
      });
      return;
    }

    if (segments.length === 6 && segments[5] === 'close') {
      if (req.method !== 'POST') {
        throw appError('method_not_allowed', `Method ${req.method} is not allowed`, 405);
      }

      await closeCard(db, req, res, cardId);
      return;
    }

    if (segments.length === 6 && segments[5] === 'start') {
      if (req.method !== 'POST') {
        throw appError('method_not_allowed', `Method ${req.method} is not allowed`, 405);
      }

      const started = startCrossReview(db, conversationId, cardId, { runtime });
      // The loop runs in the background; the caller polls the card detail.
      void started.completion.catch(() => undefined);

      sendJson(res, 202, { card: cardDto(started.card) });
      return;
    }
  }

  throw appError('not_found', 'Not found', 404);
}

/** `/api/board/...` — cross-conversation reads for the shell. */
export async function handleBoardGlobal(
  db: DatabaseSync,
  req: IncomingMessage,
  res: ServerResponse,
  segments: string[],
  url: URL,
): Promise<void> {
  if (req.method !== 'GET') {
    throw appError('method_not_allowed', `Method ${req.method} is not allowed`, 405);
  }

  if (segments.length === 3 && segments[2] === 'status') {
    const active = db
      .prepare(
        `SELECT b.*, c.title AS conversation_title
           FROM board_cards b
           JOIN conversations c ON c.id = b.conversation_id
          WHERE b.cross_phase IN ('dispatched', 'cc_work', 'dsh_review', 'summary')
             OR (b.status IN ('claimed', 'running') AND b.cross_phase = 'idle')
          ORDER BY b.updated_at DESC
          LIMIT 20`,
      )
      .all() as unknown as Array<board.CardRow & { conversation_title: string }>;

    sendJson(res, 200, {
      cross_round_limit: board.crossRoundLimit(db),
      active: active.map((card) => ({
        ...cardDto(card),
        conversation_title: card.conversation_title,
      })),
    });
    return;
  }

  if (segments.length === 3 && segments[2] === 'findings') {
    const params = queryObject(url);
    const limit = parseBoundedInteger(params.limit, 'limit', {
      min: 1,
      max: 200,
      defaultValue: 100,
    });

    const rows = db
      .prepare(
        `SELECT f.*, b.title AS card_title, b.conversation_id, c.title AS conversation_title
           FROM board_findings f
           JOIN board_cards b ON b.id = f.card_id
           JOIN conversations c ON c.id = b.conversation_id
          WHERE f.status IN ('open', 'addressed')
          ORDER BY f.created_at, f.rowid
          LIMIT ?`,
      )
      .all(limit) as unknown as Array<
      board.FindingRow & {
        card_title: string;
        conversation_id: string;
        conversation_title: string;
      }
    >;

    sendJson(res, 200, {
      items: rows.map((row) => ({
        ...findingDto(row),
        card_title: row.card_title,
        conversation_id: row.conversation_id,
        conversation_title: row.conversation_title,
      })),
    });
    return;
  }

  throw appError('not_found', 'Not found', 404);
}

/** `/api/settings/team` — the global cross-review limit. */
export async function handleTeamSettings(
  db: DatabaseSync,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (req.method === 'GET') {
    sendJson(res, 200, { cross_round_limit: board.crossRoundLimit(db) });
    return;
  }

  if (req.method === 'PUT' || req.method === 'PATCH') {
    const body = ensureObject(await readJsonBody(req));
    const value = body.cross_round_limit;

    if (typeof value !== 'number') {
      throw appError('invalid_cross_round_limit', 'cross_round_limit must be a number', 400);
    }

    const saved = board.setCrossRoundLimit(db, value);
    sendJson(res, 200, { cross_round_limit: saved });
    return;
  }

  throw appError('method_not_allowed', `Method ${req.method} is not allowed`, 405);
}
