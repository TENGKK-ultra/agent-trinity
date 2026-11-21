import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventsPage } from './EventsPage';

const mocks = vi.hoisted(() => ({
  listEvents: vi.fn(),
}));

vi.mock('../../services/core-api', () => ({
  listEvents: mocks.listEvents,
}));

const page = {
  items: [
    {
      id: 'm4',
      conversation_id: 'conv-b',
      conversation_title: '整理目录',
      source: 'task' as const,
      reason: null,
      failed: false,
      content: '任务已完成',
      created_at: '2026-11-21T10:15:00.000Z',
    },
    {
      id: 'm2',
      conversation_id: 'conv-a',
      conversation_title: '统计文件',
      source: 'system' as const,
      reason: 'run_failed',
      failed: true,
      content: '进程退出码 1：ENOENT',
      created_at: '2026-11-21T10:05:00.000Z',
    },
  ],
  total: 2,
  limit: 50,
  offset: 0,
  counts: { task: 1, system: 1, error: 1 },
};

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('EventsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listEvents.mockResolvedValue(page);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('列出事件，失败的标红并带上原因', async () => {
    render(<EventsPage />);
    await settle();

    expect(screen.getByText('任务已完成')).toBeTruthy();
    expect(screen.getByText('进程退出码 1：ENOENT')).toBeTruthy();
    expect(screen.getByText('整理目录')).toBeTruthy();
    expect(screen.getByText('run_failed')).toBeTruthy();
    expect(screen.getByText('共 2 条')).toBeTruthy();
  });

  it('点击筛选项会带着对应值重新请求', async () => {
    render(<EventsPage />);
    await settle();

    fireEvent.click(screen.getByRole('button', { name: /错误/ }));
    await settle();

    expect(mocks.listEvents).toHaveBeenLastCalledWith({ filter: 'error', limit: 50, offset: 0 });
  });

  it('没有事件时说明来源，而不是只显示暂无', async () => {
    mocks.listEvents.mockResolvedValue({
      items: [],
      total: 0,
      limit: 50,
      offset: 0,
      counts: { task: 0, system: 0, error: 0 },
    });

    render(<EventsPage />);
    await settle();

    expect(screen.getByText('暂无事件')).toBeTruthy();
    expect(screen.getByText(/事件由 Core 在跑回合时自己写入/)).toBeTruthy();
  });

  it('读取失败时把错误显示出来', async () => {
    mocks.listEvents.mockRejectedValue(new Error('后端没连上'));

    render(<EventsPage />);
    await settle();

    expect(screen.getByText('后端没连上')).toBeTruthy();
  });
});
