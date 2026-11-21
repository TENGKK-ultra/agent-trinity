/** Unknown is shown as an em dash; only a real provider number becomes a figure. */
export function formatTokens(value: number | null): string {
  return value === null ? '—' : value.toLocaleString('zh-CN');
}

/**
 * Providers report cost in USD; the screen shows an estimated CNY figure.
 * The rate is a fixed reference for now — a later settings entry can replace it
 * without touching the stored value, which always stays in USD.
 */
export const USD_TO_CNY = 6.69;

export const COST_NOTE = `人民币成本按 1 USD ≈ ${USD_TO_CNY} CNY 估算`;

export function formatCost(value: number | null): string {
  if (value === null) return '—';
  return `¥${(value * USD_TO_CNY).toFixed(2)}`;
}
