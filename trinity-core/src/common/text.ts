/**
 * Length budgets in this project are UTF-16 code units — the unit
 * `String#length` reports — so a budget of 200 always fits a 200-unit column.
 * An emoji occupies two units, so a cut that would land between the halves of
 * one moves back a single unit instead of leaving a lone surrogate behind.
 */
export function safeSlice(value: string, max: number): string {
  if (max <= 0) return '';
  if (value.length <= max) return value;

  const last = value.charCodeAt(max - 1);
  const splitsPair = last >= 0xd800 && last <= 0xdbff;

  return value.slice(0, splitsPair ? max - 1 : max);
}

/** Human-facing counts are code points: one emoji is one character. */
export function countCharacters(value: string): number {
  let count = 0;

  for (const _ of value) count += 1;

  return count;
}
