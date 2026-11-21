import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SearchPalette } from './SearchPalette';

const mocks = vi.hoisted(() => ({
  searchAll: vi.fn(),
}));

vi.mock('../services/core-api', () => ({
  searchAll: mocks.searchAll,
}));

async function settle(ms = 260): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

describe('SearchPalette', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.searchAll.mockResolvedValue({
      query: 'group',
      conversations: [
        { id: 'conv-a', title: '统计 group 目录', updated_at: '2026-11-21T10:00:00.000Z' },
      ],
      messages: [
        {
          message_id: 'm2',
          conversation_id: 'conv-b',
          conversation_title: '整理下载文件夹',
          sender_kind: 'agent',
          snippet: 'group 目录共 12 个文件',
          created_at: '2026-11-21T09:00:00.000Z',
        },
      ],
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('输入后按关键词搜索，标题和内容分组显示', async () => {
    render(<SearchPalette open onClose={() => undefined} onOpenConversation={() => undefined} />);

    fireEvent.change(screen.getByPlaceholderText('搜索对话标题和聊过的内容'), {
      target: { value: 'group' },
    });
    await settle();

    expect(mocks.searchAll).toHaveBeenCalledWith('group');
    expect(screen.getByText('对话')).toBeTruthy();
    expect(screen.getByText('统计 group 目录')).toBeTruthy();
    expect(screen.getByText('group 目录共 12 个文件')).toBeTruthy();
  });

  it('回车打开当前选中的结果，并关闭面板', async () => {
    const onOpenConversation = vi.fn();
    const onClose = vi.fn();

    render(<SearchPalette open onClose={onClose} onOpenConversation={onOpenConversation} />);

    const input = screen.getByPlaceholderText('搜索对话标题和聊过的内容');
    fireEvent.change(input, { target: { value: 'group' } });
    await settle();

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onOpenConversation).toHaveBeenCalledWith('conv-b');
    expect(onClose).toHaveBeenCalled();
  });

  it('空关键词不发请求', async () => {
    render(<SearchPalette open onClose={() => undefined} onOpenConversation={() => undefined} />);

    fireEvent.change(screen.getByPlaceholderText('搜索对话标题和聊过的内容'), {
      target: { value: '   ' },
    });
    await settle();

    expect(mocks.searchAll).not.toHaveBeenCalled();
  });

  it('关闭时不渲染面板', () => {
    const { container } = render(
      <SearchPalette open={false} onClose={() => undefined} onOpenConversation={() => undefined} />,
    );

    expect(container.querySelector('.search-panel')).toBeNull();
  });
});
