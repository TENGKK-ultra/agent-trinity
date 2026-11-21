/**
 * Which Core this desktop talks to.
 *
 * The production instance stays the default and the only address that can be
 * reached by accident: a stored override is validated against a fixed allowlist
 * of loopback URLs. A corrupt or invalid stored value never silently falls back
 * to another environment — it fails closed and asks the user to choose again,
 * otherwise a broken test configuration would quietly reconnect to production.
 */
export const PROD_CORE_URL = 'http://127.0.0.1:3210';
export const TEST_CORE_URL = 'http://127.0.0.1:3211';

export const CORE_TARGETS = [
  { url: PROD_CORE_URL, label: '生产', detail: '127.0.0.1:3210' },
  { url: TEST_CORE_URL, label: 'P3 测试', detail: '127.0.0.1:3211' },
] as const;

const STORAGE_KEY = 'trinity.core-url';

const ALLOWED = new Set([
  PROD_CORE_URL,
  TEST_CORE_URL,
  'http://localhost:3210',
  'http://localhost:3211',
]);

// Replaced at build/dev time by Vite; `typeof` keeps tests without the define safe.
declare const __TRINITY_DEV_CORE_TARGET__: string;

export function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

function normalize(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

export function isAllowedCoreUrl(url: string): boolean {
  return ALLOWED.has(normalize(url));
}

export type CoreConfig =
  | { kind: 'default'; url: string }
  | { kind: 'configured'; url: string }
  | { kind: 'invalid'; raw: string | null };

/**
 * The three states that matter:
 *   default    — nothing was ever chosen; production is the safe default
 *   configured — a valid stored choice, kept as chosen
 *   invalid    — something is stored but it is not usable; refuse to connect
 */
export function resolveCoreConfig(): CoreConfig {
  let raw: string | null;

  try {
    raw = window.localStorage.getItem(STORAGE_KEY);
  } catch {
    // Storage itself is unreadable, so the stored choice cannot be trusted.
    return { kind: 'invalid', raw: null };
  }

  if (raw === null) return { kind: 'default', url: PROD_CORE_URL };

  return isAllowedCoreUrl(raw)
    ? { kind: 'configured', url: normalize(raw) }
    : { kind: 'invalid', raw };
}

/** The stored choice, or null when it must not be used. */
export function getCoreUrl(): string | null {
  const config = resolveCoreConfig();

  return config.kind === 'invalid' ? null : config.url;
}

export function setCoreUrl(url: string): string {
  const next = normalize(url);

  if (!isAllowedCoreUrl(next)) {
    throw new Error('只允许连接本机回环地址的 3210（生产）或 3211（P3 测试）');
  }

  window.localStorage.setItem(STORAGE_KEY, next);
  return next;
}

export function resetCoreUrl(): void {
  window.localStorage.removeItem(STORAGE_KEY);
}

/**
 * The address requests go to. In the packaged desktop this is the configured
 * absolute URL; in a browser preview it is empty so the dev server proxy carries
 * `/api` to the same Core, which also keeps real-browser verification possible.
 * An unusable configuration throws instead of guessing an environment.
 */
export function coreRequestBase(): string {
  if (!isTauriRuntime()) return '';

  const config = resolveCoreConfig();

  if (config.kind === 'invalid') {
    throw new Error('连接配置异常：请到设置重新选择连接目标');
  }

  return config.url;
}

/** The address actually being talked to, or null when the configuration is unusable. */
export function coreTargetUrl(): string | null {
  if (isTauriRuntime()) {
    const config = resolveCoreConfig();
    return config.kind === 'invalid' ? null : config.url;
  }

  return typeof __TRINITY_DEV_CORE_TARGET__ === 'string' &&
    isAllowedCoreUrl(__TRINITY_DEV_CORE_TARGET__)
    ? normalize(__TRINITY_DEV_CORE_TARGET__)
    : null;
}

export interface CoreTarget {
  url: string | null;
  /** 生产 or 测试; null means the target is unusable and must be chosen again. */
  label: '生产' | '测试' | null;
  display: string;
}

export function coreTarget(): CoreTarget {
  const url = coreTargetUrl();

  if (url === null) {
    return { url: null, label: null, display: '连接目标无效' };
  }

  const test = url.startsWith(TEST_CORE_URL) || url.startsWith('http://localhost:3211');

  return {
    url,
    label: test ? '测试' : '生产',
    display: url.replace(/^https?:\/\//, ''),
  };
}
