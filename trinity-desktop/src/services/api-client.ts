import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { coreRequestBase, coreTarget, isTauriRuntime } from './core-config';

const TIMEOUT_MS = 8000;

/** Names the target in failures: a wrong port must never look like a production outage. */
function targetLabel(): string {
  const target = coreTarget();

  return target.url === null ? '未选择连接目标' : `${target.display}（${target.label}）`;
}

export interface ApiError extends Error {
  code: string;
  status: number;
  isApiError: true;
}

export function apiError(code: string, message: string, status: number): ApiError {
  const error = new Error(message) as ApiError;
  error.code = code;
  error.status = status;
  error.isApiError = true;
  return error;
}

export function isApiError(value: unknown): value is ApiError {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { isApiError?: unknown }).isApiError === true
  );
}

export async function request<T>(
  path: string,
  init?: RequestInit,
  timeoutMs = TIMEOUT_MS,
): Promise<T> {
  let base: string;

  // Fail closed: an unusable configuration must never be resolved by guessing
  // an environment. The user chooses a target; until then, nothing connects.
  try {
    base = coreRequestBase();
  } catch (error) {
    throw apiError(
      'invalid_core_config',
      error instanceof Error ? error.message : '连接配置异常：请到设置重新选择连接目标',
      0,
    );
  }

  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);

  try {
    const doFetch = isTauriRuntime() ? tauriFetch : fetch;
    const response = await doFetch(`${base}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
      signal: controller.signal,
    });

    if (!response.ok) {
      let code = 'http_error';
      let message = `Trinity Core 返回 ${response.status}`;

      try {
        const body = (await response.json()) as { error?: { code?: string; message?: string } };
        if (body.error?.code) code = body.error.code;
        if (body.error?.message) message = body.error.message;
      } catch {
        // Response had no JSON body; keep the generic message.
      }

      throw apiError(code, message, response.status);
    }

    return (await response.json()) as T;
  } catch (error) {
    if (isApiError(error)) throw error;

    const aborted = error instanceof DOMException && error.name === 'AbortError';
    throw apiError(
      aborted ? 'timeout' : 'network_error',
      aborted
        ? `连接 Trinity Core 超时（${targetLabel()}）`
        : `无法连接 Trinity Core（${targetLabel()}）`,
      0,
    );
  } finally {
    window.clearTimeout(timer);
  }
}
