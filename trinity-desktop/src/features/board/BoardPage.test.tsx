import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BoardCardDto, BoardDetailDto } from '../../services/core-api';
import { BoardPage } from './BoardPage';

const mocks = vi.hoisted(() => ({
  listConversations: vi.fn(),
  getTeamSettings: vi.fn(),
  listBoardCards: vi.fn(),
  getBoardCard: vi.fn(),
  createBoardCard: vi.fn(),
  closeBoardCard: vi.fn(),
  startBoardCard: vi.fn(),
}));

vi.mock('../../hooks/useCoreStatus', () => ({
  useCore: () => ({ state: 'connected', lastCheckedAt: 0, lastError: null }),
}));

vi.mock('../../services/core-api', () => ({
  listConversations: mocks.listConversations,
  getTeamSettings: mocks.getTeamSettings,
  listBoardCards: mocks.listBoardCards,
  getBoardCard: mocks.getBoardCard,
  createBoardCard: mocks.createBoardCard,
  closeBoardCard: mocks.closeBoardCard,
  startBoardCard: mocks.startBoardCard,
}));

const card: BoardCardDto = {
  id: 'card-1',
  conversation_id: 'conv-1',
  title: '统计文件',
  goal: '统计 group 目录',
  inputs: [],
  acceptance: ['给出数量'],
  constraints_text: null,
  required_capabilities: [],
  status: 'open',
  created_by_kind: 'user',
  created_by: 'user',
  claimed_by: null,
  claim_expires_at: null,
  result_message_id: null,
  execution_task_id: null,
  requested_agent: null,
  cross_round_limit: 3,
  cross_round_used: 0,
  cross_phase: 'idle',
  created_at: '2026-11-20T00:00:00.000Z',
  updated_at: '2026-11-20T00:00:00.000Z',
  closed_at: null,
};

const detail: BoardDetailDto = {
  card,
  events: [],
  messages: [],
  findings: [],
};

describe('BoardPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listConversations.mockResolvedValue({
      items: [
        {
          id: 'conv-1',
          project_id: null,
          title: '白板工作区',
          status: 'active',
          created_at: '2026-11-20T00:00:00.000Z',
          updated_at: '2026-11-20T00:00:00.000Z',
        },
      ],
      total: 1,
      limit: 100,
      offset: 0,
    });
    mocks.getTeamSettings.mockResolvedValue({ cross_round_limit: 3 });
    mocks.listBoardCards.mockResolvedValue({ items: [card] });
    mocks.getBoardCard.mockResolvedValue(detail);
    mocks.createBoardCard.mockResolvedValue({ card: { ...card, id: 'card-2', title: '新卡' } });
  });

  afterEach(() => {
    cleanup();
  });

  it('显示真实卡片与轮数，开始按钮可用', async () => {
    render(<BoardPage />);

    expect((await screen.findAllByText('统计文件')).length).toBeGreaterThan(0);
    expect(screen.getAllByText('0 / 3 轮').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: /开始交叉验证/ })).toBeTruthy();
  });

  it('新建卡发送标题、目标与验收标准', async () => {
    render(<BoardPage />);

    await screen.findAllByText('统计文件');
    fireEvent.click(screen.getByRole('button', { name: /新建卡/ }));

    fireEvent.change(screen.getByPlaceholderText('标题，例如：实现 add(a,b)'), {
      target: { value: '实现 add' },
    });
    fireEvent.change(screen.getByPlaceholderText('目标：要达成什么'), {
      target: { value: '实现 add(a,b)' },
    });
    fireEvent.change(screen.getByPlaceholderText('验收标准，一行一条'), {
      target: { value: '2+3=5\n负数通过' },
    });

    fireEvent.click(screen.getByRole('button', { name: '创建' }));

    await waitFor(() => {
      expect(mocks.createBoardCard).toHaveBeenCalledWith('conv-1', {
        title: '实现 add',
        goal: '实现 add(a,b)',
        acceptance: ['2+3=5', '负数通过'],
      });
    });
  });
});
