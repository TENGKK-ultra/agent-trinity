import { invoke } from '@tauri-apps/api/core';
import { isTauriRuntime } from './core-config';

/**
 * Opens a local service page in the user's own browser. A webview cannot be
 * navigated away from the app, so the desktop opens it through the shell.
 */
export async function openExternal(url: string): Promise<void> {
  if (isTauriRuntime()) {
    try {
      await invoke('open_external_url', { url });
      return;
    } catch {
      // Fall through to window.open; in a browser dev server that is the right path.
    }
  }

  window.open(url, '_blank', 'noopener,noreferrer');
}
