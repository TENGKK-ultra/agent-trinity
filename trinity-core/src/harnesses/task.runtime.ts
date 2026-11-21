import type { TaskStatus } from './task.service.ts';

export interface TaskOutcome {
  status: TaskStatus;
  resultMessageId: string | null;
  errorText: string | null;
  resultText: string | null;
}

/**
 * Everyone waiting on one task shares the same settlement. There is no cache:
 * a waiter that arrives after the task settled reads the row instead, so this
 * map only ever holds tasks that are still running.
 */
const waiters = new Map<string, Set<(outcome: TaskOutcome) => void>>();

export function waitForTask(taskId: string): Promise<TaskOutcome> {
  return new Promise((resolve) => {
    const set = waiters.get(taskId) ?? new Set();
    set.add(resolve);
    waiters.set(taskId, set);
  });
}

export function settleTask(taskId: string, outcome: TaskOutcome): void {
  const set = waiters.get(taskId);
  if (!set) return;

  for (const resolve of set) resolve(outcome);
  waiters.delete(taskId);
}

/** Test hook: the registry is process-wide. */
export function resetTaskRuntime(): void {
  waiters.clear();
}
