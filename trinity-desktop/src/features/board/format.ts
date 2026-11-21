import type {
  BoardCardDto,
  BoardCardStatus,
  CrossPhase,
  BoardFindingDto,
} from '../../services/core-api';

export const CARD_STATUS_LABEL: Record<BoardCardStatus, string> = {
  open: '待认领',
  claimed: '已认领',
  running: '进行中',
  done: '已完成',
  failed: '失败',
  cancelled: '已取消',
};

export const CARD_STATUS_TONE: Record<BoardCardStatus, string> = {
  open: 'chip',
  claimed: 'chip chip-accent',
  running: 'chip chip-accent',
  done: 'chip chip-success',
  failed: 'chip chip-danger',
  cancelled: 'chip',
};

export const PHASE_LABEL: Record<CrossPhase, string> = {
  idle: '待开始',
  dispatched: 'Codex 派发中',
  cc_work: 'Claude 执行中',
  dsh_review: 'DSH 验证中',
  summary: 'Codex 汇总中',
  waiting_user: '等待你决定',
};

export const FINDING_LABEL: Record<BoardFindingDto['status'], string> = {
  open: '未解决',
  addressed: '已处理待验证',
  resolved: '已解决',
  wontfix: '不处理',
};

export const FINDING_TONE: Record<BoardFindingDto['status'], string> = {
  open: 'chip chip-warning',
  addressed: 'chip chip-accent',
  resolved: 'chip chip-success',
  wontfix: 'chip',
};

/**
 * The colour follows the configured limit, not the current round: the limit is
 * what decides how expensive the loop can get.
 */
export function roundTone(limit: number): string {
  if (limit <= 3) return 'chip chip-success';
  if (limit <= 5) return 'chip chip-accent';
  if (limit <= 8) return 'chip chip-warning';

  return 'chip chip-danger';
}

export function isActive(card: BoardCardDto): boolean {
  return (
    card.cross_phase === 'dispatched' ||
    card.cross_phase === 'cc_work' ||
    card.cross_phase === 'dsh_review' ||
    card.cross_phase === 'summary'
  );
}

export function formatTime(value: string): string {
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}

export function truncate(value: string, max = 160): string {
  const line = value.replace(/\s+/g, ' ').trim();

  return line.length > max ? `${line.slice(0, max)}…` : line;
}
