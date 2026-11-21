import { HARNESS_TYPES, type HarnessType } from '../harnesses/types.ts';

export type GroupAgent = HarnessType;

const ALIASES: Record<string, GroupAgent> = {
  claude: 'claude',
  codex: 'codex',
  deepseek: 'deepseek',
  dsh: 'deepseek',
};

const MENTION = /@([A-Za-z][A-Za-z0-9_-]*)/g;

/**
 * Finds the agents a message hands work to. Only an explicit `@name` counts:
 * ordinary prose that happens to mention a product never starts a run.
 */
export function parseMentions(text: string): GroupAgent[] {
  const found: GroupAgent[] = [];

  for (const match of text.matchAll(MENTION)) {
    const agent = ALIASES[(match[1] ?? '').toLowerCase()];

    if (agent !== undefined && !found.includes(agent) && HARNESS_TYPES.includes(agent)) {
      found.push(agent);
    }
  }

  return found;
}
