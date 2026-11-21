import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { isTauriRuntime } from '../services/core-config';

/**
 * The window's close button asks instead of quitting. The Rust side cancels the
 * close and emits the event; this prompt carries out whichever answer the user
 * gives, so a mis-click never ends the session.
 */
export function ClosePrompt() {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!isTauriRuntime()) return;

    let disposed = false;
    let unlisten: (() => void) | null = null;

    void listen('trinity-close-requested', () => setOpen(true)).then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    if (!open) return;

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false);
    };

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open]);

  if (!open) return null;

  const hideToTray = async (): Promise<void> => {
    setBusy(true);

    try {
      setOpen(false);
      await invoke('hide_to_tray');
    } finally {
      setBusy(false);
    }
  };

  const quit = async (): Promise<void> => {
    setBusy(true);

    try {
      await invoke('quit_app');
    } catch {
      setBusy(false);
    }
  };

  return createPortal(
    <div
      className="close-prompt-backdrop"
      role="presentation"
      onClick={() => !busy && setOpen(false)}
    >
      <div
        className="close-prompt"
        role="dialog"
        aria-modal="true"
        aria-labelledby="close-prompt-title"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id="close-prompt-title">要缩到右下角托盘吗？</h2>
        <p>
          关掉窗口后 Trinity 继续在后台运行，右下角的托盘图标点一下就能回来；不想留就选「退出」。
        </p>

        <div className="close-prompt-actions">
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void hideToTray()}
            disabled={busy}
          >
            缩到托盘
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => setOpen(false)}
            disabled={busy}
          >
            继续使用
          </button>
          <button
            type="button"
            className="btn btn-ghost close-prompt-quit"
            onClick={() => void quit()}
            disabled={busy}
          >
            退出 Trinity
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
