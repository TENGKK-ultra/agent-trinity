import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { appendChange, SYSTEM_ACTOR, type ChangeActor } from '../changes/change-log.service.ts';
import { withTransaction } from '../database/transaction.ts';
import { HARNESS_TYPES, type HarnessType } from '../harnesses/types.ts';
import { appError } from '../types/index.ts';

export const CARD_STATUSES = [
  'open',
  'claimed',
  'running',
  'done',
  'failed',
  'cancelled',
] as const;
export type CardStatus = (typeof CARD_STATUSES)[number];

export const CROSS_PHASES = [
  'idle',
  'dispatched',
  'cc_work',
  'dsh_review',
  'summary',
  'waiting_user',
] as const;
export type CrossPhase = (typeof CROSS_PHASES)[number];

export const FINDING_STATUSES = ['open', 'addressed', 'resolved', 'wontfix'] as const;
export type FindingStatus = (typeof FINDING_STATUSES)[number];

export const MESSAGE_KINDS = [
  'utterance',
  'notice',
  'assignment',
  'question',
  'result',
  'review',
] as const;
export type MessageKind = (typeof MESSAGE_KINDS)[number];

const MAX_TITLE = 200;
const MAX_GOAL = 8000;
const MAX_LIST_ITEMS = 20;
const MAX_ITEM_CHARS = 500;
const MAX_MESSAGE = 8000;
const DEFAULT_LEASE_MS = 10 * 60 * 1000;
const MAX_LEASES_PER_AGENT = 2;
const CROSS_ROUND_KEY = 'cross_round_limit';
const DEFAULT_CROSS_ROUNDS = 5;

export interface CardRow {
  id: string;
  conversation_id: string;
  title: string;
  goal: string;
  inputs_json: string | null;
  acceptance_json: string | null;
  constraints_text: string | null;
  required_capabilities_json: string | null;
  status: CardStatus;
  created_by_kind: 'user' | 'agent';
  created_by: string;
  claimed_by: string | null;
  claim_token: string | null;
  claim_expires_at: string | null;
  result_message_id: string | null;
  execution_task_id: string | null;
  /** The user named the executor; the loop skips the Codex dispatch turn. */
  requested_agent: string | null;
  cross_round_limit: number;
  cross_round_used: number;
  cross_phase: CrossPhase;
  cross_pass_streak: number;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
}

export interface BoardEventRow {
  id: string;
  card_id: string;
  kind: string;
  actor_kind: 'user' | 'agent' | 'system';
  actor: string;
  detail_json: string | null;
  created_at: string;
}

export interface BoardMessageRow {
  id: string;
  conversation_id: string;
  card_id: string | null;
  kind: MessageKind;
  from_kind: 'user' | 'agent' | 'system';
  from_agent: string | null;
  to_agent: string | null;
  content: string;
  parent_message_id: string | null;
  request_id: string;
  fingerprint: string;
  hop: number;
  state: 'queued' | 'delivered' | 'consumed' | 'expired';
  created_at: string;
  delivered_at: string | null;
  consumed_at: string | null;
}

export interface FindingRow {
  id: string;
  card_id: string;
  round_no: number;
  title: string;
  detail: string | null;
  status: FindingStatus;
  raised_by: string;
  resolved_by: string | null;
  created_at: string;
  resolved_at: string | null;
}

/** A sender the Core has already checked. The brand is not constructible by hand. */
const TRUSTED = Symbol('trinity.board-sender');

export interface BoardSender {
  readonly [TRUSTED]: true;
  readonly kind: 'user' | 'agent' | 'system';
  readonly agent: string | null;
  readonly conversationId: string;
}

export function boardUser(db: DatabaseSync, conversationId: string): BoardSender {
  const row = db
    .prepare('SELECT 1 AS ok FROM conversations WHERE id = ?')
    .get(conversationId) as { ok: number } | undefined;

  if (!row) throw appError('conversation_not_found', 'Conversation not found', 404);

  return { [TRUSTED]: true, kind: 'user', agent: null, conversationId };
}

export function boardAgent(
  db: DatabaseSync,
  conversationId: string,
  agent: string,
): BoardSender {
  if (!(HARNESS_TYPES as readonly string[]).includes(agent)) {
    throw appError('invalid_agent', `Unknown agent: ${agent}`, 400);
  }

  const bound = db
    .prepare(
      'SELECT 1 AS ok FROM harness_sessions WHERE conversation_id = ? AND harness_type = ? LIMIT 1',
    )
    .get(conversationId, agent) as { ok: number } | undefined;

  if (!bound) {
    throw appError('sender_not_bound', `${agent} is not bound to this conversation`, 409);
  }

  return { [TRUSTED]: true, kind: 'agent', agent, conversationId };
}

export function boardSystem(db: DatabaseSync, conversationId: string): BoardSender {
  const row = db
    .prepare('SELECT 1 AS ok FROM conversations WHERE id = ?')
    .get(conversationId) as { ok: number } | undefined;

  if (!row) throw appError('conversation_not_found', 'Conversation not found', 404);

  return { [TRUSTED]: true, kind: 'system', agent: null, conversationId };
}

function assertSender(sender: unknown): asserts sender is BoardSender {
  if (
    typeof sender !== 'object' ||
    sender === null ||
    (sender as Record<symbol, unknown>)[TRUSTED] !== true
  ) {
    throw appError('untrusted_sender', 'Sender identity must come from Core', 400);
  }
}

function stringList(value: unknown, field: string): string[] | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) {
    throw appError(`invalid_${field}`, `${field} must be an array`, 400);
  }

  if (value.length > MAX_LIST_ITEMS) {
    throw appError(`invalid_${field}`, `${field} has too many entries`, 400);
  }

  const items = value.map((entry) => {
    if (typeof entry !== 'string') {
      throw appError(`invalid_${field}`, `${field} must contain strings`, 400);
    }

    const text = entry.trim();

    if (text === '' || text.length > MAX_ITEM_CHARS) {
      throw appError(`invalid_${field}`, `${field} has an empty or oversized entry`, 400);
    }

    return text;
  });

  return items.length === 0 ? null : items;
}

function requireText(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string') {
    throw appError(`invalid_${field}`, `${field} must be a string`, 400);
  }

  const text = value.trim();

  if (text === '') throw appError(`invalid_${field}`, `${field} must not be empty`, 400);
  if (text.length > max) {
    throw appError(`invalid_${field}`, `${field} is too long`, 400);
  }

  return text;
}

export function findCard(db: DatabaseSync, cardId: string): CardRow | undefined {
  return db.prepare('SELECT * FROM board_cards WHERE id = ?').get(cardId) as
    | CardRow
    | undefined;
}

function requireCard(db: DatabaseSync, cardId: string): CardRow {
  const card = findCard(db, cardId);

  if (!card) throw appError('card_not_found', 'Card not found', 404);

  return card;
}

export function listCards(
  db: DatabaseSync,
  conversationId: string,
  status?: CardStatus,
): CardRow[] {
  if (status) {
    return db
      .prepare(
        'SELECT * FROM board_cards WHERE conversation_id = ? AND status = ? ORDER BY created_at DESC, rowid DESC',
      )
      .all(conversationId, status) as unknown as CardRow[];
  }

  return db
    .prepare(
      'SELECT * FROM board_cards WHERE conversation_id = ? ORDER BY created_at DESC, rowid DESC',
    )
    .all(conversationId) as unknown as CardRow[];
}

export function listActiveCards(db: DatabaseSync): CardRow[] {
  return db
    .prepare(
      `SELECT * FROM board_cards
        WHERE cross_phase IN ('dispatched', 'cc_work', 'dsh_review', 'summary')
           OR (status IN ('claimed', 'running') AND cross_phase = 'idle')
        ORDER BY updated_at DESC, rowid DESC
        LIMIT 20`,
    )
    .all() as unknown as CardRow[];
}

function eventActor(actor: ChangeActor): { kind: 'user' | 'agent' | 'system'; id: string } {
  if (actor.type === 'agent') return { kind: 'agent', id: actor.id ?? 'agent' };
  if (actor.type === 'user') return { kind: 'user', id: actor.id ?? 'user' };

  return { kind: 'system', id: actor.id ?? 'core' };
}

function appendEvent(
  db: DatabaseSync,
  cardId: string,
  kind: string,
  actor: ChangeActor,
  detail: Record<string, unknown> | null = null,
): void {
  const who = eventActor(actor);

  db.prepare(
    `INSERT INTO board_events (id, card_id, kind, actor_kind, actor, detail_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    randomUUID(),
    cardId,
    kind,
    who.kind,
    who.id,
    detail === null ? null : JSON.stringify(detail),
    new Date().toISOString(),
  );
}

export function listEvents(db: DatabaseSync, cardId: string): BoardEventRow[] {
  return db
    .prepare('SELECT * FROM board_events WHERE card_id = ? ORDER BY created_at, rowid')
    .all(cardId) as unknown as BoardEventRow[];
}

// ---------- global settings ----------

export function getSetting(db: DatabaseSync, key: string): string | null {
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined;

  return row?.value ?? null;
}

export function crossRoundLimit(db: DatabaseSync): number {
  const raw = getSetting(db, CROSS_ROUND_KEY);
  const parsed = raw === null ? NaN : Number(raw);

  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 10 ? parsed : DEFAULT_CROSS_ROUNDS;
}

export function setCrossRoundLimit(
  db: DatabaseSync,
  value: number,
  actor: ChangeActor = SYSTEM_ACTOR,
): number {
  if (!Number.isInteger(value) || value < 1 || value > 10) {
    throw appError('invalid_cross_round_limit', 'cross_round_limit must be an integer from 1 to 10', 400);
  }

  return withTransaction(db, () => {
    const now = new Date().toISOString();

    db.prepare(
      `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).run(CROSS_ROUND_KEY, String(value), now);

    appendChange(db, {
      entityType: 'app_setting',
      entityId: CROSS_ROUND_KEY,
      operation: 'update',
      actor,
      conversationId: null,
      payload: { value },
    });

    return value;
  });
}

// ---------- cards ----------

export interface CreateCardInput {
  title: string;
  goal: string;
  inputs?: unknown;
  acceptance?: unknown;
  constraintsText?: unknown;
  requiredCapabilities?: unknown;
  crossRoundLimit?: number;
  /** When set, this agent executes the card; Codex does not dispatch. */
  requestedAgent?: unknown;
}

export function createCard(
  db: DatabaseSync,
  conversationId: string,
  input: CreateCardInput,
  sender: BoardSender,
): CardRow {
  assertSender(sender);

  if (sender.kind === 'system') {
    throw appError('invalid_creator', 'A system sender cannot create a card', 400);
  }

  if (sender.conversationId !== conversationId) {
    throw appError('card_in_other_conversation', 'Sender belongs to another conversation', 409);
  }

  const title = requireText(input.title, 'title', MAX_TITLE);
  const goal = requireText(input.goal, 'goal', MAX_GOAL);
  const inputs = stringList(input.inputs, 'inputs');
  const acceptance = stringList(input.acceptance, 'acceptance');
  const capabilities = stringList(input.requiredCapabilities, 'required_capabilities');

  const constraintsText =
    input.constraintsText === undefined || input.constraintsText === null
      ? null
      : requireText(input.constraintsText, 'constraints', MAX_GOAL);

  const requestedAgent =
    input.requestedAgent === undefined || input.requestedAgent === null
      ? null
      : (() => {
          if (
            typeof input.requestedAgent !== 'string' ||
            !(HARNESS_TYPES as readonly string[]).includes(input.requestedAgent)
          ) {
            throw appError(
              'invalid_requested_agent',
              'requested_agent must be a supported agent',
              400,
            );
          }

          return input.requestedAgent as HarnessType;
        })();

  const limit =
    input.crossRoundLimit === undefined
      ? crossRoundLimit(db)
      : (() => {
          if (!Number.isInteger(input.crossRoundLimit) || input.crossRoundLimit < 1 || input.crossRoundLimit > 10) {
            throw appError(
              'invalid_cross_round_limit',
              'cross_round_limit must be an integer from 1 to 10',
              400,
            );
          }

          return input.crossRoundLimit;
        })();

  const now = new Date().toISOString();

  return withTransaction(db, () => {
    const id = randomUUID();

    db.prepare(
      `INSERT INTO board_cards
         (id, conversation_id, title, goal, inputs_json, acceptance_json, constraints_text,
          required_capabilities_json, status, created_by_kind, created_by, requested_agent,
          cross_round_limit, cross_round_used, cross_phase, cross_pass_streak,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, 0, 'idle', 0, ?, ?)`,
    ).run(
      id,
      conversationId,
      title,
      goal,
      inputs === null ? null : JSON.stringify(inputs),
      acceptance === null ? null : JSON.stringify(acceptance),
      constraintsText,
      capabilities === null ? null : JSON.stringify(capabilities),
      sender.kind,
      sender.agent ?? 'user',
      requestedAgent,
      limit,
      now,
      now,
    );

    appendEvent(db, id, 'created', sender.kind === 'user' ? { type: 'user' } : { type: 'agent', id: sender.agent });

    appendChange(db, {
      entityType: 'board_card',
      entityId: id,
      operation: 'insert',
      actor: sender.kind === 'user' ? { type: 'user' } : { type: 'agent', id: sender.agent },
      conversationId,
      payload: { title, status: 'open', cross_round_limit: limit },
    });

    return findCard(db, id) as CardRow;
  });
}

export interface ClaimResult {
  card: CardRow;
  token: string;
}

export function claimCard(
  db: DatabaseSync,
  cardId: string,
  agent: HarnessType,
  leaseMs = DEFAULT_LEASE_MS,
): ClaimResult {
  return withTransaction(db, () => {
    const card = requireCard(db, cardId);

    if (card.status === 'done' || card.status === 'failed' || card.status === 'cancelled') {
      throw appError('card_closed', `Card is already ${card.status}`, 409);
    }

    const held = db
      .prepare(
        `SELECT COUNT(*) AS total FROM board_cards
          WHERE claimed_by = ? AND claim_expires_at > ? AND status IN ('claimed', 'running')`,
      )
      .get(agent, new Date().toISOString()) as { total: number };

    if (Number(held.total) >= MAX_LEASES_PER_AGENT) {
      throw appError('too_many_leases', `An agent may hold at most ${MAX_LEASES_PER_AGENT} claims`, 409);
    }

    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + leaseMs).toISOString();
    const token = randomUUID();
    const previous = card.claimed_by;
    const previousExpiry = card.claim_expires_at;

    const result = db
      .prepare(
        `UPDATE board_cards
            SET status = 'claimed', claimed_by = ?, claim_token = ?, claim_expires_at = ?,
                updated_at = ?
          WHERE id = ?
            AND status IN ('open', 'claimed')
            AND (claimed_by IS NULL OR claim_expires_at <= ?)`,
      )
      .run(agent, token, expiresAt, now, cardId, now);

    if (Number(result.changes) !== 1) {
      throw appError('card_already_claimed', 'Another agent holds this card', 409);
    }

    if (previous !== null && previousExpiry !== null && previousExpiry <= now) {
      appendEvent(db, cardId, 'expired', SYSTEM_ACTOR, {
        agent: previous,
        expired_at: previousExpiry,
      });
    }

    appendEvent(db, cardId, 'claimed', { type: 'agent', id: agent }, {
      expires_at: expiresAt,
    });

    return { card: requireCard(db, cardId), token };
  });
}

function requireHolder(card: CardRow, agent: string, token: string): void {
  if (card.claimed_by !== agent || card.claim_token !== token) {
    throw appError('lease_lost', 'The claim token is not the active one', 409);
  }

  if (card.claim_expires_at === null || card.claim_expires_at <= new Date().toISOString()) {
    throw appError('lease_lost', 'The lease has expired', 409);
  }
}

export function renewCard(
  db: DatabaseSync,
  cardId: string,
  agent: HarnessType,
  token: string,
  leaseMs = DEFAULT_LEASE_MS,
): CardRow {
  return withTransaction(db, () => {
    const card = requireCard(db, cardId);

    requireHolder(card, agent, token);

    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + leaseMs).toISOString();
    const result = db
      .prepare(
        `UPDATE board_cards SET claim_expires_at = ?, updated_at = ?
          WHERE id = ? AND claimed_by = ? AND claim_token = ?`,
      )
      .run(expiresAt, now, cardId, agent, token);

    if (Number(result.changes) !== 1) {
      throw appError('lease_lost', 'The lease is no longer held', 409);
    }

    appendEvent(db, cardId, 'renewed', { type: 'agent', id: agent }, { expires_at: expiresAt });

    return requireCard(db, cardId);
  });
}

export function releaseCard(
  db: DatabaseSync,
  cardId: string,
  agent: HarnessType,
  token: string,
): CardRow {
  return withTransaction(db, () => {
    const card = requireCard(db, cardId);

    requireHolder(card, agent, token);

    const now = new Date().toISOString();
    const result = db
      .prepare(
        `UPDATE board_cards
            SET status = 'open', claimed_by = NULL, claim_token = NULL,
                claim_expires_at = NULL, updated_at = ?
          WHERE id = ? AND claimed_by = ? AND claim_token = ?`,
      )
      .run(now, cardId, agent, token);

    if (Number(result.changes) !== 1) {
      throw appError('lease_lost', 'The lease is no longer held', 409);
    }

    appendEvent(db, cardId, 'released', { type: 'agent', id: agent });

    return requireCard(db, cardId);
  });
}

export function startCard(
  db: DatabaseSync,
  cardId: string,
  agent: HarnessType,
  token: string,
): CardRow {
  return withTransaction(db, () => {
    const card = requireCard(db, cardId);

    requireHolder(card, agent, token);

    const now = new Date().toISOString();
    const result = db
      .prepare(
        `UPDATE board_cards SET status = 'running', updated_at = ?
          WHERE id = ? AND claimed_by = ? AND claim_token = ? AND status = 'claimed'`,
      )
      .run(now, cardId, agent, token);

    if (Number(result.changes) !== 1) {
      throw appError('invalid_transition', 'Only a claimed card can start', 409);
    }

    return requireCard(db, cardId);
  });
}

export function linkExecutionTask(
  db: DatabaseSync,
  cardId: string,
  taskId: string,
  agent: HarnessType,
): CardRow {
  return withTransaction(db, () => {
    const card = requireCard(db, cardId);
    const task = db
      .prepare('SELECT conversation_id, target_agent FROM agent_tasks WHERE id = ?')
      .get(taskId) as { conversation_id: string; target_agent: string } | undefined;

    if (!task || task.conversation_id !== card.conversation_id) {
      throw appError('invalid_task_link', 'Task must belong to the card conversation', 400);
    }

    if (task.target_agent !== agent) {
      throw appError('invalid_task_link', 'Task target must be the claimant', 400);
    }

    const result = db
      .prepare('UPDATE board_cards SET execution_task_id = ?, updated_at = ? WHERE id = ? AND execution_task_id IS NULL')
      .run(taskId, new Date().toISOString(), cardId);

    if (Number(result.changes) !== 1) {
      throw appError('task_already_linked', 'This card already has an execution task', 409);
    }

    return requireCard(db, cardId);
  });
}

export function completeCard(
  db: DatabaseSync,
  cardId: string,
  agent: HarnessType,
  token: string,
  resultMessageId: string,
): CardRow {
  return withTransaction(db, () => {
    const card = requireCard(db, cardId);

    requireHolder(card, agent, token);

    const message = db
      .prepare('SELECT conversation_id FROM messages WHERE id = ?')
      .get(resultMessageId) as { conversation_id: string } | undefined;

    if (!message || message.conversation_id !== card.conversation_id) {
      throw appError(
        'invalid_result_message',
        'result_message_id must reference a message in the card conversation',
        400,
      );
    }

    const now = new Date().toISOString();
    const result = db
      .prepare(
        `UPDATE board_cards
            SET status = 'done', result_message_id = ?, updated_at = ?, closed_at = ?
          WHERE id = ? AND claimed_by = ? AND claim_token = ?
            AND status IN ('claimed', 'running')`,
      )
      .run(resultMessageId, now, now, cardId, agent, token);

    if (Number(result.changes) !== 1) {
      throw appError('invalid_transition', 'Only a claimed running card can complete', 409);
    }

    appendEvent(db, cardId, 'completed', { type: 'agent', id: agent }, {
      result_message_id: resultMessageId,
    });

    appendChange(db, {
      entityType: 'board_card',
      entityId: cardId,
      operation: 'update',
      actor: { type: 'agent', id: agent },
      conversationId: card.conversation_id,
      payload: { status: 'done' },
    });

    return requireCard(db, cardId);
  });
}

export function failCard(
  db: DatabaseSync,
  cardId: string,
  agent: HarnessType,
  token: string,
  reason: string,
): CardRow {
  const text = requireText(reason, 'reason', MAX_GOAL);

  return withTransaction(db, () => {
    const card = requireCard(db, cardId);

    requireHolder(card, agent, token);

    const now = new Date().toISOString();
    const result = db
      .prepare(
        `UPDATE board_cards SET status = 'failed', updated_at = ?, closed_at = ?
          WHERE id = ? AND claimed_by = ? AND claim_token = ?
            AND status IN ('claimed', 'running')`,
      )
      .run(now, now, cardId, agent, token);

    if (Number(result.changes) !== 1) {
      throw appError('invalid_transition', 'Only a claimed card can fail', 409);
    }

    appendEvent(db, cardId, 'failed', { type: 'agent', id: agent }, { reason: text });

    return requireCard(db, cardId);
  });
}

export function cancelCard(
  db: DatabaseSync,
  cardId: string,
  reason: string,
  actor: ChangeActor = { type: 'user' },
): CardRow {
  const text = requireText(reason, 'reason', MAX_GOAL);

  return withTransaction(db, () => {
    const card = requireCard(db, cardId);

    if (card.status === 'done' || card.status === 'cancelled') {
      throw appError('card_closed', `Card is already ${card.status}`, 409);
    }

    const now = new Date().toISOString();
    db.prepare(
      `UPDATE board_cards
          SET status = 'cancelled', claimed_by = NULL, claim_token = NULL,
              claim_expires_at = NULL, updated_at = ?, closed_at = ?
        WHERE id = ?`,
    ).run(now, now, cardId);

    appendEvent(db, cardId, 'cancelled', actor, { reason: text });

    db.prepare(
      "UPDATE board_findings SET status = 'wontfix', resolved_at = ?, resolved_by = ? WHERE card_id = ? AND status IN ('open', 'addressed')",
    ).run(now, 'user', cardId);

    return requireCard(db, cardId);
  });
}

/** Expires stale leases. Idempotent; safe to call on every read or at startup. */
export function expireLeases(db: DatabaseSync): number {
  return withTransaction(db, () => {
    const now = new Date().toISOString();
    const stale = db
      .prepare(
        `SELECT * FROM board_cards
          WHERE status IN ('claimed', 'running')
            AND claim_expires_at IS NOT NULL
            AND claim_expires_at <= ?`,
      )
      .all(now) as unknown as CardRow[];

    let expired = 0;

    for (const card of stale) {
      const result = db
        .prepare(
          `UPDATE board_cards
              SET status = 'open', claimed_by = NULL, claim_token = NULL,
                  claim_expires_at = NULL, updated_at = ?
            WHERE id = ? AND claim_expires_at = ?`,
        )
        .run(now, card.id, card.claim_expires_at);

      if (Number(result.changes) !== 1) continue;

      expired += 1;
      appendEvent(db, card.id, 'expired', SYSTEM_ACTOR, {
        agent: card.claimed_by,
        expired_at: card.claim_expires_at,
      });
    }

    return expired;
  });
}

// ---------- cross-review rounds ----------

/**
 * Puts a card into the user-triggered cross-review loop. A card already held
 * by a claimant is someone else's work; the loop must not steal it.
 */
export function beginLoop(db: DatabaseSync, cardId: string): CardRow {
  // A lease that has lapsed is no longer a claimant; clear it before deciding.
  expireLeases(db);

  return withTransaction(db, () => {
    const card = requireCard(db, cardId);

    if (card.status === 'done' || card.status === 'failed' || card.status === 'cancelled') {
      throw appError('card_closed', `Card is already ${card.status}`, 409);
    }

    if (card.claimed_by !== null) {
      throw appError('card_claimed', 'A claimant is already working on this card', 409);
    }

    if (card.cross_phase !== 'idle' && card.cross_phase !== 'waiting_user') {
      throw appError('loop_already_running', `Cross-review is at ${card.cross_phase}`, 409);
    }

    const now = new Date().toISOString();
    db.prepare(
      `UPDATE board_cards
          SET status = 'running', cross_phase = 'dispatched', cross_round_used = 0,
              cross_pass_streak = 0, updated_at = ?
        WHERE id = ?`,
    ).run(now, cardId);

    appendEvent(db, cardId, 'round_started', SYSTEM_ACTOR, { round: 1 });

    return requireCard(db, cardId);
  });
}

export function setCrossPhase(
  db: DatabaseSync,
  cardId: string,
  phase: CrossPhase,
  actor: ChangeActor = SYSTEM_ACTOR,
): CardRow {
  return withTransaction(db, () => {
    requireCard(db, cardId);

    db.prepare('UPDATE board_cards SET cross_phase = ?, updated_at = ? WHERE id = ?').run(
      phase,
      new Date().toISOString(),
      cardId,
    );

    return requireCard(db, cardId);
  });
}

export interface ReviewResult {
  card: CardRow;
  reachedLimit: boolean;
}

/**
 * Counts one verifier review. The platform only counts; whether the review
 * passed or not is recorded, never acted on in v1.
 */
export function recordReview(
  db: DatabaseSync,
  cardId: string,
  options: { passed: boolean; actor: ChangeActor },
): ReviewResult {
  if (
    options.actor.type !== 'agent' ||
    (options.actor.id !== 'deepseek' && options.actor.id !== 'claude')
  ) {
    throw appError('not_the_verifier', 'Only a verifier may record a review', 403);
  }

  return withTransaction(db, () => {
    const card = requireCard(db, cardId);

    if (card.cross_round_used >= card.cross_round_limit) {
      return { card, reachedLimit: true };
    }

    const used = card.cross_round_used + 1;
    const streak = options.passed ? card.cross_pass_streak + 1 : 0;
    const reached = used >= card.cross_round_limit;
    const now = new Date().toISOString();

    db.prepare(
      `UPDATE board_cards
          SET cross_round_used = ?, cross_pass_streak = ?, cross_phase = ?,
              updated_at = ?
        WHERE id = ?`,
    ).run(used, streak, reached ? 'summary' : 'cc_work', now, cardId);

    appendEvent(db, cardId, 'reviewed', options.actor, {
      round: used,
      passed: options.passed,
    });

    if (reached) {
      appendEvent(db, cardId, 'round_limit_reached', SYSTEM_ACTOR, {
        limit: card.cross_round_limit,
      });
    }

    return { card: requireCard(db, cardId), reachedLimit: reached };
  });
}

export function markSummarized(
  db: DatabaseSync,
  cardId: string,
  summaryMessageId: string,
): CardRow {
  return withTransaction(db, () => {
    requireCard(db, cardId);

    const now = new Date().toISOString();
    db.prepare(
      `UPDATE board_cards SET cross_phase = 'waiting_user', updated_at = ? WHERE id = ?`,
    ).run(now, cardId);

    appendEvent(db, cardId, 'summarized', SYSTEM_ACTOR, {
      message_id: summaryMessageId,
    });

    return requireCard(db, cardId);
  });
}

// ---------- findings ----------

export function addFinding(
  db: DatabaseSync,
  cardId: string,
  input: { roundNo: number; title: string; detail?: string | null; raisedBy: string },
): FindingRow {
  const title = requireText(input.title, 'title', MAX_TITLE);

  if (!Number.isInteger(input.roundNo) || input.roundNo < 1) {
    throw appError('invalid_round', 'round_no must be a positive integer', 400);
  }

  return withTransaction(db, () => {
    requireCard(db, cardId);

    const id = randomUUID();
    const now = new Date().toISOString();

    db.prepare(
      `INSERT INTO board_findings
         (id, card_id, round_no, title, detail, status, raised_by, created_at)
       VALUES (?, ?, ?, ?, ?, 'open', ?, ?)`,
    ).run(
      id,
      cardId,
      input.roundNo,
      title,
      input.detail === undefined || input.detail === null ? null : requireText(input.detail, 'detail', MAX_GOAL),
      input.raisedBy,
      now,
    );

    return db.prepare('SELECT * FROM board_findings WHERE id = ?').get(id) as unknown as FindingRow;
  });
}

export function listFindings(
  db: DatabaseSync,
  cardId: string,
  status?: FindingStatus,
): FindingRow[] {
  if (status) {
    return db
      .prepare(
        'SELECT * FROM board_findings WHERE card_id = ? AND status = ? ORDER BY round_no, created_at, rowid',
      )
      .all(cardId, status) as unknown as FindingRow[];
  }

  return db
    .prepare(
      'SELECT * FROM board_findings WHERE card_id = ? ORDER BY round_no, created_at, rowid',
    )
    .all(cardId) as unknown as FindingRow[];
}

export function listOpenFindings(db: DatabaseSync, limit = 100): FindingRow[] {
  return db
    .prepare(
      `SELECT * FROM board_findings
        WHERE status IN ('open', 'addressed')
        ORDER BY created_at, rowid
        LIMIT ?`,
    )
    .all(limit) as unknown as FindingRow[];
}

export function setFindingStatus(
  db: DatabaseSync,
  findingId: string,
  status: Exclude<FindingStatus, 'open'>,
  by: string,
): FindingRow {
  return withTransaction(db, () => {
    const finding = db.prepare('SELECT * FROM board_findings WHERE id = ?').get(findingId) as
      | FindingRow
      | undefined;

    if (!finding) throw appError('finding_not_found', 'Finding not found', 404);

    // Only a verifier may declare a finding resolved; the author may mark it
    // addressed. With a user-named executor the verifier can be Claude, so both
    // verifier roles are accepted. This is about roles, not about the code.
    if (status === 'resolved' && by !== 'deepseek' && by !== 'claude') {
      throw appError('not_the_verifier', 'Only a verifier may resolve a finding', 403);
    }

    if (status === 'addressed' && by !== 'claude' && by !== 'deepseek' && by !== 'user') {
      throw appError('not_authorized', 'Only the author or verifier may mark this addressed', 403);
    }

    const now = new Date().toISOString();
    const result = db
      .prepare(
        `UPDATE board_findings SET status = ?, resolved_by = ?, resolved_at = ?
          WHERE id = ? AND status <> 'resolved' AND status <> 'wontfix'`,
      )
      .run(status, by, status === 'resolved' ? now : null, findingId);

    if (Number(result.changes) !== 1) {
      throw appError('invalid_transition', 'This finding is already closed', 409);
    }

    return db.prepare('SELECT * FROM board_findings WHERE id = ?').get(findingId) as unknown as FindingRow;
  });
}

// ---------- board messages ----------

export function fingerprintOf(
  kind: MessageKind,
  from: string,
  to: string | null,
  content: string,
): string {
  return createHash('sha256').update([kind, from, to ?? '', content].join('\n')).digest('hex');
}

export interface PostMessageInput {
  cardId?: string | null;
  kind: MessageKind;
  toAgent?: string | null;
  content: string;
  parentMessageId?: string | null;
  requestId?: string;
  hop?: number;
}

export function postMessage(
  db: DatabaseSync,
  conversationId: string,
  sender: BoardSender,
  input: PostMessageInput,
): BoardMessageRow {
  assertSender(sender);

  if (sender.conversationId !== conversationId) {
    throw appError('message_in_other_conversation', 'Sender belongs to another conversation', 409);
  }

  if (!(MESSAGE_KINDS as readonly string[]).includes(input.kind)) {
    throw appError('invalid_kind', 'Unknown message kind', 400);
  }

  const content = input.content ?? '';

  if (content.trim() === '') throw appError('invalid_content', 'content must not be empty', 400);
  if (content.length > MAX_MESSAGE) {
    throw appError('invalid_content', `content must be at most ${MAX_MESSAGE} characters`, 400);
  }

  const toAgent = input.toAgent ?? null;

  if (toAgent !== null && !(HARNESS_TYPES as readonly string[]).includes(toAgent)) {
    throw appError('invalid_agent', `Unknown recipient: ${toAgent}`, 400);
  }

  if (input.cardId) {
    const card = findCard(db, input.cardId);

    if (!card || card.conversation_id !== conversationId) {
      throw appError('card_not_found', 'Card not found in this conversation', 404);
    }
  }

  const requestId = input.requestId ?? randomUUID();
  const from = sender.kind === 'user' ? 'user' : (sender.agent as string);
  const fingerprint = fingerprintOf(input.kind, from, toAgent, content);

  return withTransaction(db, () => {
    const existing = db
      .prepare('SELECT * FROM board_messages WHERE request_id = ?')
      .get(requestId) as BoardMessageRow | undefined;

    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw appError(
          'request_id_conflict',
          'This request id was already used for different content',
          409,
        );
      }

      return existing;
    }

    const row: BoardMessageRow = {
      id: randomUUID(),
      conversation_id: conversationId,
      card_id: input.cardId ?? null,
      kind: input.kind,
      from_kind: sender.kind,
      from_agent: sender.agent,
      to_agent: toAgent,
      content,
      parent_message_id: input.parentMessageId ?? null,
      request_id: requestId,
      fingerprint,
      hop: input.hop ?? 0,
      state: 'queued',
      created_at: new Date().toISOString(),
      delivered_at: null,
      consumed_at: null,
    };

    db.prepare(
      `INSERT INTO board_messages
         (id, conversation_id, card_id, kind, from_kind, from_agent, to_agent, content,
          parent_message_id, request_id, fingerprint, hop, state, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?)`,
    ).run(
      row.id,
      row.conversation_id,
      row.card_id,
      row.kind,
      row.from_kind,
      row.from_agent,
      row.to_agent,
      row.content,
      row.parent_message_id,
      row.request_id,
      row.fingerprint,
      row.hop,
      row.created_at,
    );

    return row;
  });
}

export function listMessages(db: DatabaseSync, cardId: string): BoardMessageRow[] {
  return db
    .prepare('SELECT * FROM board_messages WHERE card_id = ? ORDER BY created_at, rowid')
    .all(cardId) as unknown as BoardMessageRow[];
}

export function listInbox(
  db: DatabaseSync,
  conversationId: string,
  agent: HarnessType,
  limit = 50,
): BoardMessageRow[] {
  return db
    .prepare(
      `SELECT * FROM board_messages
        WHERE conversation_id = ? AND to_agent = ? AND state IN ('queued', 'delivered')
        ORDER BY created_at, id
        LIMIT ?`,
    )
    .all(conversationId, agent, limit) as unknown as BoardMessageRow[];
}

export function markMessageState(
  db: DatabaseSync,
  messageId: string,
  state: 'delivered' | 'consumed' | 'expired',
): boolean {
  const first = 'queued';
  const second = state === 'consumed' ? 'delivered' : 'queued';
  const result = db
    .prepare(
      `UPDATE board_messages
          SET state = ?, delivered_at = COALESCE(delivered_at, ?), consumed_at = ?
        WHERE id = ? AND state IN (?, ?)`,
    )
    .run(
      state,
      new Date().toISOString(),
      state === 'consumed' ? new Date().toISOString() : null,
      messageId,
      first,
      second,
    );

  return Number(result.changes) === 1;
}

export interface CardDetail {
  card: CardRow;
  events: BoardEventRow[];
  messages: BoardMessageRow[];
  findings: FindingRow[];
}

export function cardDetail(db: DatabaseSync, cardId: string): CardDetail {
  return {
    card: requireCard(db, cardId),
    events: listEvents(db, cardId),
    messages: listMessages(db, cardId),
    findings: listFindings(db, cardId),
  };
}
