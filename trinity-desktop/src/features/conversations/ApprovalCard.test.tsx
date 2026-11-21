import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ApprovalCard } from './ApprovalCard';
import type { ApprovalDto } from '../../services/core-api';

function approval(overrides: Partial<ApprovalDto> = {}): ApprovalDto {
  return {
    id: 'ap-1',
    conversation_id: 'conv-1',
    agent: 'claude',
    kind: 'tool_approval',
    tool_name: 'Bash',
    tool_use_id: 'tu-1',
    payload: { tool_name: 'Bash', detail: 'rm -rf build' },
    status: 'pending',
    delivery_status: 'pending',
    created_at: '2026-11-19T00:00:00.000Z',
    decided_at: null,
    expires_at: null,
    ...overrides,
  };
}

afterEach(() => cleanup());

describe('审批卡片', () => {
  it('展示 Agent、工具名与要执行的命令', () => {
    render(<ApprovalCard approval={approval()} busy={false} onDecide={() => {}} />);

    expect(screen.getByText('Claude Code')).toBeTruthy();
    expect(screen.getByText('请求使用 Bash')).toBeTruthy();
    expect(screen.getByText('rm -rf build')).toBeTruthy();
  });

  it('批准与拒绝分别回传各自的决定', () => {
    const onDecide = vi.fn();
    render(<ApprovalCard approval={approval()} busy={false} onDecide={onDecide} />);

    fireEvent.click(screen.getByText('批准'));
    expect(onDecide).toHaveBeenLastCalledWith('approve');

    fireEvent.click(screen.getByText('拒绝'));
    expect(onDecide).toHaveBeenLastCalledWith('deny');
  });

  it('提问必须先选中选项才能批准，并把答案一并回传', () => {
    const onDecide = vi.fn();

    render(
      <ApprovalCard
        busy={false}
        onDecide={onDecide}
        approval={approval({
          kind: 'question',
          tool_name: 'AskUserQuestion',
          payload: {
            tool_name: 'AskUserQuestion',
            questions: [
              {
                question: '选哪个颜色？',
                header: '颜色',
                options: [
                  { label: '红', description: null },
                  { label: '蓝', description: null },
                ],
                multiSelect: false,
              },
            ],
          },
        })}
      />,
    );

    expect(screen.getByText('想问你一个问题')).toBeTruthy();

    const approve = screen.getByText('批准') as HTMLButtonElement;
    expect(approve.disabled).toBe(true);

    fireEvent.click(screen.getByText('蓝'));
    expect(approve.disabled).toBe(false);

    fireEvent.click(approve);
    expect(onDecide).toHaveBeenLastCalledWith('approve', { '选哪个颜色？': '蓝' });
  });
});
