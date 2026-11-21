import { useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { isTauriRuntime } from '../services/core-config';
import { BootSplash } from './BootSplash';

/**
 * The separate, transparent splash window. When the animation ends the window
 * closes and the already-loaded main window is revealed underneath.
 */
export function SplashScreen() {
  useEffect(() => {
    document.documentElement.classList.add('splash-window');

    return () => document.documentElement.classList.remove('splash-window');
  }, []);

  return (
    <BootSplash
      onFinish={() => {
        if (isTauriRuntime()) {
          void invoke('finish_splash');
          return;
        }

        // Browser preview: move on to the app itself.
        window.location.hash = '#/overview';
      }}
    />
  );
}
