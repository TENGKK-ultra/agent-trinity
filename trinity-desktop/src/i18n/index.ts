import { useCallback, useSyncExternalStore } from 'react';
import { MESSAGES, type Language, type MessageKey } from './messages.ts';

const STORAGE_KEY = 'trinity.language';

const listeners = new Set<() => void>();

function isLanguage(value: unknown): value is Language {
  return value === 'zh' || value === 'en';
}

function readInitial(): Language {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (isLanguage(raw)) return raw;
  } catch {
    // 隐私模式下读不到存储，退回中文
  }

  // 默认中文。不去猜浏览器语言——这个项目的第一批用户就是说中文的人，
  // 猜错了反而要他们先去找开关。
  return 'zh';
}

let current: Language = readInitial();

function applyToDocument(language: Language): void {
  if (typeof document !== 'undefined') {
    document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en';
  }
}

applyToDocument(current);

export function getLanguage(): Language {
  return current;
}

export function setLanguage(next: Language): void {
  if (next === current) return;

  current = next;
  applyToDocument(next);

  try {
    window.localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // 存不下也不影响本次会话的选择
  }

  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useLanguage(): Language {
  return useSyncExternalStore(subscribe, getLanguage, getLanguage);
}

/** 没登记的键原样返回 key，方便一眼看出哪里还没翻。 */
export function translate(language: Language, key: MessageKey): string {
  return MESSAGES[key][language];
}

export function useT(): (key: MessageKey) => string {
  const language = useLanguage();
  return useCallback((key: MessageKey) => translate(language, key), [language]);
}
