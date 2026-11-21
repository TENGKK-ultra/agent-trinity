import type { DatabaseSync } from 'node:sqlite';
import * as sessionService from './session.service.ts';
import * as taskService from './task.service.ts';
import * as taskRuntime from './task.runtime.ts';
import { getAdapter, isSupportedHarness } from './registry.ts';
import { startTurn } from './turn.service.ts';
import { resolveDelegationTimeout } from './delegation.timeouts.ts';
import type { HarnessAdapter, HarnessType } from './types.ts';

export interface TaskResult {
  task: taskService.TaskRow;
  resultText: string | null;
}

function resultTextOf(db: DatabaseSync, messageId: string | null): string | null {
  if (!messageId) return null;

  const row = db.prepare('SELECT content FROM messages WHERE id = ?').get(messageId) as
    | { content: string }
    | undefined;

  return row?.content ?? null;
}

function outcomeOf(db: DatabaseSync, task: taskService.TaskRow): taskRuntime.TaskOutcome {
  return {
    status: task.status,
    resultMessageId: task.result_message_id,
    errorText: task.error_text,
    resultText: resultTextOf(db, task.result_message_id),
  };
}

function settleWith(db: DatabaseSync, taskId: string, settled: taskService.TaskRow | null): TaskResult {
  const finalRow = settled ?? taskService.findTask(db, taskId);

  if (!finalRow) {
    throw new Error(`delegation: task ${taskId} disappeared while settling`);
  }

  taskRuntime.settleTask(taskId, outcomeOf(db, finalRow));
  return { task: finalRow, resultText: resultTextOf(db, finalRow.result_message_id) };
}

function failEarly(db: DatabaseSync, task: taskService.TaskRow, code: string): TaskResult {
  return settleWith(db, task.id, taskService.failTask(db, task.id, code));
}

/**
 * Runs the delegated task. Every exit path settles the row and notifies the
 * waiters, so a caller can never be left holding a task that is still
 * `running` in the ledger but has no process behind it.
 */
export async function executeTask(
  db: DatabaseSync,
  task: taskService.TaskRow,
  options: {
    adapter?: HarnessAdapter;
    timeoutMs?: number;
    prompt?: string;
    /** System/developer-level instructions for this turn (role rules). */
    systemAppend?: string;
    /** Read-only tools pre-approved for this turn (no permission ask). */
    allowedTools?: string[];
    /** Tags the run's usage rows with the collaboration round that owns it. */
    roundId?: string;
  } = {},
): Promise<TaskResult> {
  if (!isSupportedHarness(task.target_agent)) {
    return failEarly(db, task, 'target_unknown');
  }

  const target = task.target_agent as HarnessType;
  const session = sessionService.findSession(db, task.conversation_id, target);

  if (!session) {
    return failEarly(db, task, 'target_unbound');
  }

  // A delegated run must have a real working directory; falling back to Core's
  // own directory would let an agent write into the engine.
  if (!session.cwd || session.cwd.trim() === '') {
    return failEarly(db, task, 'target_cwd_missing');
  }

  const adapter = options.adapter ?? getAdapter(target);
  const timeoutMs = options.timeoutMs ?? resolveDelegationTimeout();

  let completion;

  try {
    ({ completion } = startTurn(db, task.conversation_id, session, options.prompt ?? task.instruction, {
      adapter,
      timeoutMs,
      cwd: session.cwd,
      ...(options.systemAppend === undefined ? {} : { systemAppend: options.systemAppend }),
      ...(options.allowedTools === undefined ? {} : { allowedTools: options.allowedTools }),
      metadata: {
        task_id: task.id,
        ...(options.roundId === undefined ? {} : { round_id: options.roundId }),
      },
      onStarted: (turnId) => {
        // Runs after the lock is held and before the process starts, so the
        // ledger can never claim `running` for a run that never began.
        taskService.markTaskRunning(db, task.id, turnId);
      },
    }));
  } catch (err) {
    // The session is busy or quarantined; no process was started.
    const message = err instanceof Error ? err.message : String(err);
    return failEarly(db, task, `target_unavailable: ${message}`);
  }

  const outcome = await completion;

  if (outcome.status === 'completed') {
    if (!outcome.finalMessageId) {
      return settleWith(db, task.id, taskService.failTask(db, task.id, 'result_not_persisted'));
    }

    return settleWith(db, task.id, taskService.completeTask(db, task.id, outcome.finalMessageId));
  }

  if (outcome.status === 'timeout') {
    return settleWith(db, task.id, taskService.timeoutTask(db, task.id, outcome.errorText ?? 'timeout'));
  }

  if (outcome.status === 'cancelled') {
    return settleWith(db, task.id, taskService.cancelTask(db, task.id, 'cancelled'));
  }

  return settleWith(db, task.id, taskService.failTask(db, task.id, outcome.errorText ?? 'agent_failed'));
}

/**
 * Waits for a task to settle. A task that already finished is answered from the
 * ledger, so a late waiter never blocks on a settlement that already happened.
 */
export async function awaitTask(db: DatabaseSync, taskId: string): Promise<TaskResult> {
  const row = taskService.findTask(db, taskId);

  if (!row) {
    throw new Error(`delegation: task ${taskId} not found`);
  }

  if (taskService.isTerminal(row.status)) {
    return { task: row, resultText: resultTextOf(db, row.result_message_id) };
  }

  const outcome = await taskRuntime.waitForTask(taskId);
  const settled = taskService.findTask(db, taskId);

  return {
    task: settled ?? row,
    resultText: outcome.resultText ?? resultTextOf(db, settled?.result_message_id ?? null),
  };
}
