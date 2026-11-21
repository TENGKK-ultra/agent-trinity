import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { isApiError } from '../services/api-client';
import { probeCore } from '../services/core-api';

export type CoreState = 'connecting' | 'connected' | 'disconnected';

interface CoreContextValue {
  state: CoreState;
  lastCheckedAt: number | null;
  lastError: string | null;
  refresh: () => Promise<boolean>;
}

const CoreContext = createContext<CoreContextValue | null>(null);

const CONNECTED_INTERVAL_MS = 15000;
const DISCONNECTED_INTERVAL_MS = 5000;

export function CoreProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<CoreState>('connecting');
  const [lastCheckedAt, setLastCheckedAt] = useState<number | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<boolean> => {
    try {
      await probeCore();
      setState('connected');
      setLastError(null);
      return true;
    } catch (error) {
      setState('disconnected');
      setLastError(isApiError(error) ? error.message : '无法连接 Trinity Core');
      return false;
    } finally {
      setLastCheckedAt(Date.now());
    }
  }, []);

  useEffect(() => {
    let alive = true;
    let timer: number | undefined;

    const loop = async (): Promise<void> => {
      const connected = await refresh();
      if (!alive) return;
      timer = window.setTimeout(
        () => void loop(),
        connected ? CONNECTED_INTERVAL_MS : DISCONNECTED_INTERVAL_MS,
      );
    };

    void loop();

    const onFocus = (): void => {
      void refresh();
    };
    window.addEventListener('focus', onFocus);

    return () => {
      alive = false;
      window.clearTimeout(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [refresh]);

  const value = useMemo<CoreContextValue>(
    () => ({ state, lastCheckedAt, lastError, refresh }),
    [state, lastCheckedAt, lastError, refresh],
  );

  return <CoreContext.Provider value={value}>{children}</CoreContext.Provider>;
}

export function useCore(): CoreContextValue {
  const value = useContext(CoreContext);
  if (!value) throw new Error('useCore must be used inside CoreProvider');
  return value;
}
