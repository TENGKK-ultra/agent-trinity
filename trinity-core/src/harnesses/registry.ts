import { appError } from '../types/index.ts';
import { ClaudeAdapter } from './claude.adapter.ts';
import { CodexAdapter } from './codex.adapter.ts';
import { DshAdapter } from './dsh.adapter.ts';
import type { HarnessAdapter, HarnessType } from './types.ts';

const cache = new Map<HarnessType, HarnessAdapter>();

export const SUPPORTED_HARNESSES: HarnessType[] = ['claude', 'codex', 'deepseek'];

export function isSupportedHarness(value: string): value is HarnessType {
  return (SUPPORTED_HARNESSES as string[]).includes(value);
}

export function getAdapter(type: string): HarnessAdapter {
  if (!isSupportedHarness(type)) {
    throw appError(
      'unsupported_harness',
      `Harness "${type}" is not supported. Available: ${SUPPORTED_HARNESSES.join(', ')}`,
      400,
    );
  }

  const cached = cache.get(type);
  if (cached) return cached;

  const adapter: HarnessAdapter =
    type === 'claude' ? new ClaudeAdapter() : type === 'codex' ? new CodexAdapter() : new DshAdapter();
  cache.set(type, adapter);
  return adapter;
}
