import { appError } from '../types/index.ts';

export function ensureObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw appError('invalid_body', 'Request body must be a JSON object', 400);
  }
  return value as Record<string, unknown>;
}

export function requireString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string') {
    throw appError(`invalid_${field}`, `${field} must be a string`, 400);
  }

  const trimmed = value.trim();

  if (trimmed.length === 0) {
    throw appError(`invalid_${field}`, `${field} must not be empty`, 400);
  }

  if (trimmed.length > maxLength) {
    throw appError(`invalid_${field}`, `${field} must be at most ${maxLength} characters`, 400);
  }

  return trimmed;
}

export function parseBoundedInteger(
  value: unknown,
  field: string,
  options: { min: number; max: number; defaultValue: number },
): number {
  if (value === undefined || value === null || value === '') {
    return options.defaultValue;
  }

  const parsed = typeof value === 'number' ? value : Number(String(value));

  if (!Number.isInteger(parsed) || parsed < options.min || parsed > options.max) {
    throw appError(
      `invalid_${field}`,
      `${field} must be an integer between ${options.min} and ${options.max}`,
      400,
    );
  }

  return parsed;
}

export function parseEnum<T extends string>(
  value: unknown,
  field: string,
  allowed: readonly T[],
): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw appError(
      `invalid_${field}`,
      `${field} must be one of: ${allowed.join(', ')}`,
      400,
    );
  }

  return value as T;
}

export function parseOptionalEnum<T extends string>(
  value: unknown,
  field: string,
  allowed: readonly T[],
): T | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }

  return parseEnum(value, field, allowed);
}

export function parseEnumWithDefault<T extends string>(
  value: unknown,
  field: string,
  allowed: readonly T[],
  defaultValue: T,
): T {
  if (value === undefined || value === null || value === '') {
    return defaultValue;
  }

  return parseEnum(value, field, allowed);
}
