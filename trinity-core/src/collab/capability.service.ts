import type { DatabaseSync } from 'node:sqlite';
import * as sessionService from '../harnesses/session.service.ts';
import { HARNESS_TYPES, type HarnessType } from '../harnesses/types.ts';
import type { CapabilityResolver, CapabilityVerdict } from './dispatch.service.ts';

/**
 * Capability is judged from what this workspace has actually seen, never from a
 * table of claims about each vendor. Three answers, and the third one is real:
 *
 *   yes      — this agent has completed at least one task of this type here
 *   no       — the agent cannot run at all in this conversation (not bound)
 *   unknown  — it is bound, but no task of this type has finished yet
 *
 * A failure is *not* evidence of inability: a timeout says nothing about
 * whether the agent can do the work. That is why only completions count.
 */
export interface CapabilityEvidence {
  agent: HarnessType;
  taskType: string;
  bound: boolean;
  completed: number;
  failed: number;
}

export function evidenceOf(
  db: DatabaseSync,
  conversationId: string,
  agent: HarnessType,
  taskType: string,
): CapabilityEvidence {
  const bound = sessionService.findSession(db, conversationId, agent) !== undefined;

  const row = db
    .prepare(
      `SELECT
         SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
         SUM(CASE WHEN status IN ('failed', 'timeout') THEN 1 ELSE 0 END) AS failed
       FROM agent_tasks
       WHERE target_agent = ? AND task_type = ?`,
    )
    .get(agent, taskType) as { completed: number | null; failed: number | null } | undefined;

  return {
    agent,
    taskType,
    bound,
    completed: Number(row?.completed ?? 0),
    failed: Number(row?.failed ?? 0),
  };
}

export function verdictOf(evidence: CapabilityEvidence): CapabilityVerdict {
  if (!evidence.bound) return 'no';
  if (evidence.completed > 0) return 'yes';

  return 'unknown';
}

export function describeEvidence(evidence: CapabilityEvidence): string {
  if (!evidence.bound) return `${evidence.agent} 未绑定此会话`;
  if (evidence.completed > 0) {
    return `${evidence.agent} 完成过 ${evidence.completed} 项「${evidence.taskType}」任务`;
  }

  return `尚无 ${evidence.agent} 的「${evidence.taskType}」完成记录`;
}

/** The resolver the dispatcher consumes, backed by the database above. */
export function createCapabilityResolver(
  db: DatabaseSync,
  conversationId: string,
): CapabilityResolver & { evidence(agent: HarnessType, taskType: string): CapabilityEvidence } {
  return {
    evidence: (agent, taskType) => evidenceOf(db, conversationId, agent, taskType),
    verdict: (agent, taskType) => verdictOf(evidenceOf(db, conversationId, agent, taskType)),
  };
}

export function isHarness(value: string): value is HarnessType {
  return (HARNESS_TYPES as readonly string[]).includes(value);
}
