import { parseMentions } from '../group/mentions.ts';
import type { HarnessType } from '../harnesses/types.ts';

export interface PlannedAssignment {
  to: HarnessType;
  task: string;
  type: string;
  reason: string;
}

/** The coordinator's answer to a peer's help request. */
export interface PlannedResolution {
  from: HarnessType;
  decision: 'accept' | 'refuse';
  reason: string;
}

export interface Plan {
  assignments: PlannedAssignment[];
  resolutions: PlannedResolution[];
  /** The coordinator says it is finished; no further work should be started. */
  done: boolean;
  summary: string | null;
  source: 'json' | 'mentions' | 'none';
}

/** One planning turn may start at most this many tasks in parallel. */
export const MAX_PLAN_ASSIGNMENTS = 3;
const MAX_TASK_CHARS = 4000;

const BLOCK = /```(?:collab|json)\s*\n([\s\S]*?)```/i;

function excerpt(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > MAX_TASK_CHARS ? `${line.slice(0, MAX_TASK_CHARS)}…` : line;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/**
 * Reads the coordinator's free text with the three-level fallback of §7.2:
 * a `collab` JSON block, then @mentions, then "nothing more to do". The last
 * fallback ends the round rather than continuing it, because a loop that cannot
 * read its own output must converge, not spin.
 */
export function parsePlan(
  text: string,
  known: readonly HarnessType[],
  self: HarnessType,
): Plan {
  const match = BLOCK.exec(text);

  if (match) {
    try {
      const parsed = JSON.parse(match[1] ?? '') as Record<string, unknown>;
      const raw = Array.isArray(parsed.assign) ? parsed.assign : [];
      const seen = new Set<HarnessType>();
      const assignments: PlannedAssignment[] = [];

      for (const item of raw) {
        if (typeof item !== 'object' || item === null) continue;

        const record = item as Record<string, unknown>;
        const to = asString(record.to) as HarnessType | null;
        const task = asString(record.task);

        if (to === null || task === null) continue;
        if (!known.includes(to) || to === self || seen.has(to)) continue;

        seen.add(to);
        assignments.push({
          to,
          task: excerpt(task),
          type: asString(record.type) ?? 'general',
          reason: asString(record.reason) ?? '协调者分配',
        });

        if (assignments.length >= MAX_PLAN_ASSIGNMENTS) break;
      }

      return {
        assignments,
        resolutions: parseResolutions(parsed.resolve, known, self),
        done: parsed.done === true || assignments.length === 0,
        summary: asString(parsed.summary),
        source: 'json',
      };
    } catch {
      // A broken block falls through to mentions: the text still says what to do.
    }
  }

  const mentioned = parseMentions(text).filter(
    (agent) => agent !== self && known.includes(agent),
  );

  if (mentioned.length > 0) {
    const unique = [...new Set(mentioned)].slice(0, MAX_PLAN_ASSIGNMENTS);

    return {
      assignments: unique.map((agent) => ({
        to: agent,
        task: excerpt(text),
        type: 'general',
        reason: '回复中明确提及',
      })),
      resolutions: [],
      done: false,
      summary: null,
      source: 'mentions',
    };
  }

  return { assignments: [], resolutions: [], done: true, summary: null, source: 'none' };
}

/**
 * `{"resolve":[{"from":"claude","decision":"accept","reason":"我来做"}]}` is how
 * a coordinator answers a peer's request. A decision is only honoured for a
 * known agent other than the coordinator itself.
 */
function parseResolutions(
  value: unknown,
  known: readonly HarnessType[],
  self: HarnessType,
): PlannedResolution[] {
  if (!Array.isArray(value)) return [];

  const resolutions: PlannedResolution[] = [];

  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue;

    const record = item as Record<string, unknown>;
    const from = asString(record.from) as HarnessType | null;
    const decision = record.decision;
    const reason = asString(record.reason) ?? (decision === 'accept' ? '接受请求' : '拒绝请求');

    if (from === null || from === self || !known.includes(from)) continue;
    if (decision !== 'accept' && decision !== 'refuse') continue;

    resolutions.push({ from, decision, reason });
  }

  return resolutions;
}
