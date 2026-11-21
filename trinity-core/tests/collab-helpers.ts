import { resolve } from 'node:path';
import { parseClaudeLine } from '../src/harnesses/claude.adapter.ts';
import { parseCodexLine } from '../src/harnesses/codex.adapter.ts';
import { parseDshLine } from '../src/harnesses/dsh.adapter.ts';
import type { CoreRuntime } from '../src/harnesses/runtime.ts';
import type { HarnessAdapter, HarnessType, HarnessTurnInput } from '../src/harnesses/types.ts';

const EMIT = resolve(import.meta.dirname, 'fixtures', 'emit-collab-reply.mjs');
const CRASH = resolve(import.meta.dirname, 'fixtures', 'exit-nonzero.mjs');

export type Reply = {
  text: string;
  delayMs?: number;
  usageTokens?: number;
};

export type Responder = (prompt: string) => Reply;

const PARSERS: Record<HarnessType, (line: string) => unknown> = {
  claude: parseClaudeLine,
  codex: parseCodexLine,
  deepseek: parseDshLine,
};

const DISPLAY: Record<HarnessType, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  deepseek: 'DeepSeek Harness',
};

/**
 * An adapter that answers with whatever the test's responder returns for the
 * prompt. Every turn still goes through the real child-process path: the reply
 * is a scripted process, not a mocked service call.
 */
export function scriptedAdapter(kind: HarnessType, respond: Responder): HarnessAdapter {
  return {
    type: kind,
    displayName: DISPLAY[kind],
    resolveExecutable: () => ({ file: process.execPath, source: 'test' }),
    buildCommand: (input: HarnessTurnInput) => {
      const reply = respond(input.prompt);

      return {
        file: process.execPath,
        args: [
          EMIT,
          kind,
          reply.text,
          String(reply.delayMs ?? 0),
          String(reply.usageTokens ?? 0),
        ],
        env: {},
      };
    },
    parseLine: (line: string) => PARSERS[kind](line) as never,
  } as unknown as HarnessAdapter;
}

/** A harness that dies without a result: the turn is a real failure. */
export function crashingAdapter(kind: HarnessType): HarnessAdapter {
  return {
    type: kind,
    displayName: DISPLAY[kind],
    resolveExecutable: () => ({ file: process.execPath, source: 'test' }),
    buildCommand: () => ({ file: process.execPath, args: [CRASH], env: {} }),
    parseLine: () => null,
  } as unknown as HarnessAdapter;
}

export function runtimeFor(
  adapters: Partial<Record<HarnessType, HarnessAdapter>>,
): CoreRuntime {
  return {
    getAdapter: (type) => {
      const adapter = adapters[type as HarnessType];

      if (!adapter) throw new Error(`no adapter for ${type}`);

      return adapter;
    },
  };
}

/** Answers by turn kind, which is what the orchestrator's prompts make visible. */
export function kindOf(
  prompt: string,
): 'plan' | 'replan' | 'checkpoint' | 'resume' | 'task' | 'review' | 'delivery' {
  if (prompt.includes('[协作规划修正]')) return 'replan';
  if (prompt.includes('[协作续接]')) return 'resume';
  if (prompt.includes('[协作规划]')) return 'plan';
  if (prompt.includes('[协作检查点]')) return 'checkpoint';
  if (prompt.includes('[协作任务]')) return 'task';
  if (prompt.includes('[独立审查]')) return 'review';
  if (prompt.includes('[协作交付]')) return 'delivery';

  return 'task';
}

export function planBlock(plan: Record<string, unknown>): string {
  return `\`\`\`collab\n${JSON.stringify(plan)}\n\`\`\``;
}
