/**
 * One place builds and validates the short, human-readable line the timeline
 * shows. Adapters pick the allowed pieces; nothing here accepts a raw object,
 * an argument blob or stdout text.
 */

import { safeSlice } from '../common/text.ts';

export const MAX_SUMMARY_CHARS = 120;
export const MAX_TOOL_NAME_CHARS = 60;

/** Strips control characters and collapses whitespace; nothing else is interpreted. */
function clean(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function cap(value: string): string {
  return value.length > MAX_SUMMARY_CHARS
    ? `${safeSlice(value, MAX_SUMMARY_CHARS - 1)}…`
    : value;
}

/** Joins the allowed pieces into one bounded line. Empty parts disappear. */
export function buildSummary(parts: Array<string | null | undefined>): string | null {
  const cleaned = parts
    .filter((part): part is string => typeof part === 'string')
    .map(clean)
    .filter((part) => part !== '');

  if (cleaned.length === 0) return null;

  return cap(cleaned.join(' · '));
}

/**
 * The Core-side gate. Adapters are not trusted to have followed the rules, so
 * every summary is cleaned again before it is stored and before it is served.
 */
export function sanitizeSummary(value: unknown): string | null {
  if (typeof value !== 'string') return null;

  const cleaned = clean(value);
  return cleaned === '' ? null : cap(cleaned);
}

/**
 * A tool name is shown verbatim and was the one metadata field with no bound.
 * Adapters are expected to send a name; this makes that expectation enforceable.
 */
export function sanitizeToolName(value: unknown): string | null {
  if (typeof value !== 'string') return null;

  const cleaned = clean(value);
  if (cleaned === '') return null;

  return cleaned.length > MAX_TOOL_NAME_CHARS
    ? `${safeSlice(cleaned, MAX_TOOL_NAME_CHARS - 1)}…`
    : cleaned;
}
