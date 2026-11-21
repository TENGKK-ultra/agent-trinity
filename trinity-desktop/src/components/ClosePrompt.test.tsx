import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClosePrompt } from './ClosePrompt';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  isTauriRuntime: vi.fn(() => true),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: mocks.listen }));
vi.mock('../services/core-config', () => ({ isTauriRuntime: mocks.isTauriRuntime }));

let fireClose: (() => void) | null = null;

async function openPrompt(): Promise<void> {
  render(<ClosePrompt />);

  await act(async () => {
    await Promise.resolve();
  });

  act(() => {
    fireClose?.();
  });
}

describe('ClosePrompt', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fireClose = null;
    mocks.invoke.mockResolvedValue(undefined);
    mocks.listen.mockImplementation((_name: string, handler: () => void) => {
      fireClose = handler;
      return Promise.resolve(() => {});
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('窗口发来关闭请求时弹出提示，而不是直接退出', async () => {
    await openPrompt();

    expect(mocks.listen).toHaveBeenCalledWith('trinity-close-requested', expect.any(Function));
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByText('要缩到右下角托盘吗？')).toBeTruthy();
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it('选「缩到托盘」只隐藏窗口，不退出', async () => {
    await openPrompt();

    fireEvent.click(screen.getByRole('button', { name: '缩到托盘' }));

    await act(async () => {
      await Promise.resolve();
    });

    expect(mocks.invoke).toHaveBeenCalledWith('hide_to_tray');
    expect(mocks.invoke).not.toHaveBeenCalledWith('quit_app');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('明确选「退出 Trinity」才会退出', async () => {
    await openPrompt();

    fireEvent.click(screen.getByRole('button', { name: '退出 Trinity' }));

    await act(async () => {
      await Promise.resolve();
    });

    expect(mocks.invoke).toHaveBeenCalledWith('quit_app');
  });

  it('「继续使用」和 Esc 都只是收起提示', async () => {
    await openPrompt();

    fireEvent.click(screen.getByRole('button', { name: '继续使用' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(mocks.invoke).not.toHaveBeenCalled();

    act(() => {
      fireClose?.();
    });
    expect(screen.getByRole('dialog')).toBeTruthy();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('浏览器里没有 Tauri 时不监听，也不显示', async () => {
    mocks.isTauriRuntime.mockReturnValue(false);

    render(<ClosePrompt />);
    await act(async () => {
      await Promise.resolve();
    });

    expect(mocks.listen).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
