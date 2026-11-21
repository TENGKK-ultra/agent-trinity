import type { HarnessApprovalDecision, HarnessApprovalRequest } from './types.ts';

export interface ApprovalRuntimeEntry {
  turnId: string;
  conversationId: string;
  agent: string;
  /**
   * The provider's full ask, kept only in memory. The row holds a display view;
   * a restart cancels pending requests, so the full input never has to survive
   * on disk.
   */
  request: HarnessApprovalRequest;
  /** Returns true only when the line actually reached the child's stdin. */
  respond: (decision: HarnessApprovalDecision) => boolean;
  cancelTimeout: () => void;
}

/**
 * Live requests only. The database is the record; this map is how a decision
 * taken over HTTP reaches the child process that is blocked waiting for it.
 * A missing entry is normal — the process may have exited — and is reported as
 * a failed delivery rather than treated as an error.
 */
const entries = new Map<string, ApprovalRuntimeEntry>();

export function registerApproval(id: string, entry: ApprovalRuntimeEntry): void {
  entries.set(id, entry);
}

export function hasApproval(id: string): boolean {
  return entries.has(id);
}

export function takeApproval(id: string): ApprovalRuntimeEntry | undefined {
  const entry = entries.get(id);
  if (!entry) return undefined;

  entries.delete(id);
  entry.cancelTimeout();
  return entry;
}

export function liveApprovalIdsForTurn(turnId: string): string[] {
  const ids: string[] = [];

  for (const [id, entry] of entries) {
    if (entry.turnId === turnId) ids.push(id);
  }

  return ids;
}

/**
 * Called when a turn ends: an unanswered request has no process left to answer.
 * One that already settled keeps its decision; only its timer is dropped.
 */
export function clearTurn(turnId: string): string[] {
  const removed: string[] = [];

  for (const [id, entry] of entries) {
    if (entry.turnId !== turnId) continue;
    entry.cancelTimeout();
    entries.delete(id);
    removed.push(id);
  }

  return removed;
}

export function resetApprovals(): void {
  for (const entry of entries.values()) entry.cancelTimeout();
  entries.clear();
}
