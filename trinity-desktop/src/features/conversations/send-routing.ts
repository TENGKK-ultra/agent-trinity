import type { AgentKind, AgentSessionDto } from '../../services/core-api';

export type SendPlan =
  | { mode: 'none'; targets: []; reason: string }
  | { mode: 'solo'; targets: [AgentKind] }
  | { mode: 'group'; targets: AgentKind[] }
  | { mode: 'mention'; targets: AgentKind[] }
  | { mode: 'team'; targets: [AgentKind]; dispatcher: AgentKind };

/** Display and dispatch order; also keeps the plan deterministic in tests. */
export const AGENT_ORDER: AgentKind[] = ['claude', 'codex', 'deepseek'];

const MENTION = /@(claude|codex|dsh|deepseek)\b/gi;

const MENTION_NAME: Record<string, AgentKind> = {
  claude: 'claude',
  codex: 'codex',
  dsh: 'deepseek',
  deepseek: 'deepseek',
};

export function mentionedAgents(content: string): AgentKind[] {
  const found = new Set<AgentKind>();

  for (const match of content.matchAll(MENTION)) {
    const name = match[1]?.toLowerCase();

    if (name !== undefined && MENTION_NAME[name] !== undefined) {
      found.add(MENTION_NAME[name]);
    }
  }

  return AGENT_ORDER.filter((agent) => found.has(agent));
}

/**
 * Mention priority:
 *   - an explicit @agent narrows the round to the mentioned, bound agents
 *   - otherwise the lit (participating) agents decide
 *   - one participant is an ordinary turn; two or three are one group round
 *
 * An unbound agent is never started, whether it was mentioned or lit. A mixed
 * mention keeps the bound ones: `@Claude @DSH` with DSH unbound runs Claude and
 * ignores DSH; only when no mentioned agent is bound is the send refused.
 */
/**
 * The user's three ways to send:
 *   team      — only the dispatcher starts; the rest wait (the default)
 *   broadcast — every lit agent answers independently
 *   codex     — the user explicitly puts Codex to work itself
 */
export type SendMode = 'team' | 'broadcast' | 'codex';

export interface SendOptions {
  mode?: SendMode;
  dispatcher?: AgentKind;
}

export function planSend(
  content: string,
  bindings: readonly AgentSessionDto[],
  options: SendOptions = {},
): SendPlan {
  const bound = new Set(bindings.map((row) => row.agent as AgentKind));
  const mentioned = mentionedAgents(content);

  // An explicit @ is the user speaking over the room; it always wins.
  if (mentioned.length > 0) {
    const targets = mentioned.filter((agent) => bound.has(agent));

    return targets.length === 0
      ? { mode: 'none', targets: [], reason: '被提及的 Agent 尚未绑定' }
      : { mode: 'mention', targets };
  }

  if (options.mode === 'codex') {
    const codex = bindings.find((row) => row.agent === 'codex');

    if (!codex) {
      return { mode: 'none', targets: [], reason: 'Codex 尚未绑定到这个工作区' };
    }

    if (!codex.participating) {
      return { mode: 'none', targets: [], reason: '先在顶部点亮 Codex' };
    }

    // One ordinary turn, not a group round: this is the user's explicit
    // override, so no team rules are attached.
    return { mode: 'solo', targets: ['codex'] };
  }

  const participants = AGENT_ORDER.filter((agent) =>
    bindings.some((row) => row.agent === agent && row.participating),
  );

  if (participants.length === 0) {
    return { mode: 'none', targets: [], reason: '先在顶部点亮至少一个 Agent' };
  }

  if (participants.length === 1) {
    return { mode: 'solo', targets: [participants[0]!] };
  }

  if (options.mode === 'team') {
    const dispatcher = options.dispatcher ?? 'codex';

    // A team with no dispatcher in the room is just a group; do not invent one.
    if (participants.includes(dispatcher)) {
      return { mode: 'team', targets: [dispatcher], dispatcher };
    }
  }

  return { mode: 'group', targets: participants };
}
