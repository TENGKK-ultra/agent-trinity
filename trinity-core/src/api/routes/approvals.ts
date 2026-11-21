import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import * as conversationRepository from '../../conversations/conversation.repository.ts';
import * as approvalService from '../../harnesses/approval.service.ts';
import { resolveApproval, toView } from '../../harnesses/approval.flow.ts';
import { appError } from '../../types/index.ts';
import { readJsonBody, sendJson } from '../http-utils.ts';

function parseStatus(value: string | null): approvalService.ApprovalStatus | undefined {
  if (value === null || value === '') return undefined;

  const status = approvalService.APPROVAL_STATUSES.find((candidate) => candidate === value);
  if (!status) {
    throw appError('invalid_status', `status must be one of: ${approvalService.APPROVAL_STATUSES.join(', ')}`, 400);
  }

  return status;
}

function parseAnswers(value: unknown): Record<string, string> | undefined {
  if (value === undefined || value === null) return undefined;

  if (typeof value !== 'object' || Array.isArray(value)) {
    throw appError('invalid_answers', 'answers must be a JSON object', 400);
  }

  const answers: Record<string, string> = {};

  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry !== 'string') {
      throw appError('invalid_answers', 'every answer must be a string', 400);
    }
    answers[key] = entry;
  }

  return answers;
}

export async function handleApprovals(
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

  if (segments.length === 4) {
    if (req.method !== 'GET') {
      throw appError('method_not_allowed', `Method ${req.method} is not allowed`, 405);
    }

    const status = parseStatus(url.searchParams.get('status'));
    const rows = approvalService.listApprovals(db, conversationId, status);

    sendJson(res, 200, { items: rows.map(toView) });
    return;
  }

  if (segments.length === 5) {
    if (req.method !== 'POST') {
      throw appError('method_not_allowed', `Method ${req.method} is not allowed`, 405);
    }

    const approvalId = decodeURIComponent(segments[4] ?? '');
    if (approvalId === '') throw appError('not_found', 'Not found', 404);

    const parsed = await readJsonBody(req);
    const body = (
      typeof parsed === 'object' && parsed !== null ? parsed : {}
    ) as Record<string, unknown>;
    const decision = body.decision;
    const agent = typeof body.agent === 'string' ? body.agent.trim() : '';

    if (decision !== 'approve' && decision !== 'deny') {
      throw appError('invalid_decision', 'decision must be "approve" or "deny"', 400);
    }

    if (agent === '') {
      throw appError('invalid_agent', 'agent is required', 400);
    }

    const row = resolveApproval(db, approvalId, {
      conversationId,
      agent,
      decision,
      answers: parseAnswers(body.answers),
    });

    sendJson(res, 200, toView(row));
    return;
  }

  throw appError('not_found', 'Not found', 404);
}
