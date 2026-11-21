import { useCallback, useEffect, useRef, useState } from 'react';
import type { ResolvedTheme, ThemeChoice } from '../types';

const STORAGE_KEY = 'trinity.theme';
const TRANSITION_CLASS = 'theme-changing';
const TRANSITION_MS = 260;

function readStoredChoice(): ThemeChoice {
  const raw = window.localStorage.getItem(STORAGE_KEY);
  return raw === 'light' || raw === 'dark' || raw === 'system' ? raw : 'system';
}

export function useTheme(): {
  choice: ThemeChoice;
  resolved: ResolvedTheme;
  setChoice: (next: ThemeChoice) => void;
  cycle: () => void;
} {
  const [choice, setChoiceState] = useState<ThemeChoice>(readStoredChoice);
  const [systemDark, setSystemDark] = useState<boolean>(
    () => window.matchMedia('(prefers-color-scheme: dark)').matches,
  );
  const isFirstRender = useRef(true);
  const transitionTimer = useRef<number | undefined>(undefined);
  const resolvedRef = useRef<ResolvedTheme>('light');

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (event: MediaQueryListEvent): void => setSystemDark(event.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);

  const resolved: ResolvedTheme = choice === 'system' ? (systemDark ? 'dark' : 'light') : choice;

  useEffect(() => {
    const root = document.documentElement;
    const previous = resolvedRef.current;
    const firstPaint = isFirstRender.current;

    resolvedRef.current = resolved;

    if (firstPaint) {
      isFirstRender.current = false;
      root.dataset.theme = resolved;
      return;
    }

    if (previous === resolved) return;

    const frame = window.requestAnimationFrame(() => {
      root.dataset.theme = resolved;
      root.classList.add(TRANSITION_CLASS);

      window.clearTimeout(transitionTimer.current);
      transitionTimer.current = window.setTimeout(() => {
        root.classList.remove(TRANSITION_CLASS);
      }, TRANSITION_MS);
    });

    return () => window.cancelAnimationFrame(frame);
  }, [resolved]);

  const setChoice = useCallback((next: ThemeChoice) => {
    window.localStorage.setItem(STORAGE_KEY, next);
    setChoiceState(next);
  }, []);

  const cycle = useCallback(() => {
    const order: ThemeChoice[] = ['system', 'light', 'dark'];
    const index = order.indexOf(choice);
    setChoice(order[(index + 1) % order.length] as ThemeChoice);
  }, [choice, setChoice]);

  return { choice, resolved, setChoice, cycle };
}
