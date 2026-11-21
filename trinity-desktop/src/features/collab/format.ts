import type {
  CollabOutcome,
  CollabReviewDto,
  CollabRoundStatus,
} from '../../services/core-api';

export type Tone = 'default' | 'accent' | 'warning' | 'danger' | 'success';

export const ROUND_STATUS: Record<CollabRoundStatus, string> = {
  created: '已创建',
  planning: '规划中',
  running: '执行中',
  reviewing: '审查中',
  blocked: '等待中',
  delivered: '已交付',
  failed: '失败',
  cancelled: '已取消',
};

export const OUTCOME_LABEL: Record<CollabOutcome, string> = {
  completed: '完成',
  partially_completed: '部分完成',
  failed: '失败',
  cancelled: '已取消',
};

export const ROLE_LABEL: Record<string, string> = {
  coordinator: '协调者',
  contributor: '参与者',
  reviewer: '审查者',
  observer: '观察者',
};

export const TASK_STATUS: Record<string, string> = {
  queued: '排队',
  running: '执行中',
  completed: '完成',
  failed: '失败',
  timeout: '超时',
  cancelled: '已取消',
};

export const REVIEW_STATUS: Record<CollabReviewDto['status'], string> = {
  pass: '通过',
  needs_changes: '需要修改',
  review_unavailable: '不可用',
};

export const MESSAGE_KIND: Record<string, string> = {
  assignment: '指派',
  notice: '通知',
  utterance: '发言',
};

export const TERMINAL_STATUSES: CollabRoundStatus[] = ['delivered', 'failed', 'cancelled'];

export function isTerminal(status: CollabRoundStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

export function roundTone(status: CollabRoundStatus): Tone {
  switch (status) {
    case 'delivered':
      return 'success';
    case 'failed':
      return 'danger';
    case 'blocked':
      return 'warning';
    case 'running':
    case 'reviewing':
      return 'accent';
    default:
      return 'default';
  }
}

export function outcomeTone(outcome: CollabOutcome | null): Tone {
  switch (outcome) {
    case 'completed':
      return 'success';
    case 'partially_completed':
      return 'warning';
    case 'failed':
      return 'danger';
    default:
      return 'default';
  }
}

export function taskTone(status: string): Tone {
  switch (status) {
    case 'completed':
      return 'success';
    case 'failed':
    case 'timeout':
      return 'danger';
    case 'running':
      return 'accent';
    default:
      return 'default';
  }
}

export function reviewTone(status: CollabReviewDto['status']): Tone {
  switch (status) {
    case 'pass':
      return 'success';
    case 'needs_changes':
      return 'warning';
    default:
      return 'default';
  }
}

export function chipClass(tone: Tone): string {
  return tone === 'default' ? 'chip' : `chip chip-${tone}`;
}

export function agentLabel(agent: string | null): string {
  switch (agent) {
    case 'claude':
      return 'Claude Code';
    case 'codex':
      return 'Codex';
    case 'deepseek':
      return 'DeepSeek Harness';
    case 'user':
      return '用户';
    default:
      return agent ?? '未知';
  }
}

export function budgetPercent(used: number, limit: number): number {
  if (limit <= 0) return used > 0 ? 100 : 0;

  return Math.min(Math.round((used / limit) * 100), 100);
}

export function budgetTone(used: number, limit: number): Tone {
  if (limit <= 0) return used > 0 ? 'danger' : 'default';
  if (used >= limit) return 'danger';
  if (used / limit >= 0.8) return 'warning';

  return 'default';
}

export function usageLabel(tokens: number | null, limit: number | null): string {
  const used = tokens === null ? '统计中' : `${tokens}`;

  return limit === null ? `${used} tokens（不限）` : `${used} / ${limit} tokens`;
}

export function formatTime(iso: string | null): string {
  if (iso === null) return '—';

  const date = new Date(iso);

  if (Number.isNaN(date.getTime())) return iso;

  const pad = (value: number): string => String(value).padStart(2, '0');

  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(
    date.getMinutes(),
  )}:${pad(date.getSeconds())}`;
}

export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
