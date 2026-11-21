/**
 * A targeted scanner for one object inside a JSON line.
 *
 * `JSON.parse` keeps the last value of a duplicated key and says nothing. At
 * least one provider emits such a line: Codex's `web_search` item carries two
 * `id` keys, the item id and the call id. The first is silently lost unless the
 * raw text is examined before parsing.
 *
 * This is not a general JSON parser: it only looks at the members of the object
 * named by `objectKey`, which is all the adapters need.
 */

const MAX_REPORTED_VALUE = 80;

export interface ObjectKeyScan {
  /** Keys that appear more than once at the object's top level. */
  duplicates: string[];
  /** First raw value of each requested key, as it appeared in the text. */
  firstValues: Record<string, string>;
}

function unquote(token: string): string {
  const trimmed = token.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function display(value: string): string {
  const plain = unquote(value);
  return plain.length > MAX_REPORTED_VALUE ? `${plain.slice(0, MAX_REPORTED_VALUE)}…` : plain;
}

export function scanObjectKeys(raw: string, objectKey: string, wanted: readonly string[]): ObjectKeyScan {
  const marker = `"${objectKey}"`;
  const markerAt = raw.indexOf(marker);
  if (markerAt < 0) return { duplicates: [], firstValues: {} };

  let open = markerAt + marker.length;
  while (open < raw.length && raw[open] !== ':') open += 1;
  while (open < raw.length && raw[open] !== '{') open += 1;
  if (open >= raw.length) return { duplicates: [], firstValues: {} };

  const members: Array<{ key: string; value: string }> = [];
  let depth = 0;
  let inString = false;
  let escaped = false;
  let stringStart = -1;
  let currentKey: string | null = null;
  let valueStart = -1;

  for (let i = open; i < raw.length; i += 1) {
    const ch = raw[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;

        if (depth === 1) {
          let j = i + 1;
          while (j < raw.length && (raw[j] === ' ' || raw[j] === '\t')) j += 1;

          if (raw[j] === ':') {
            currentKey = raw.slice(stringStart + 1, i);
            valueStart = j + 1;
          }
        }
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      stringStart = i;
      continue;
    }

    if (ch === '{' || ch === '[') {
      depth += 1;
      continue;
    }

    if (ch === '}' || ch === ']') {
      if (depth === 1 && currentKey !== null) {
        members.push({ key: currentKey, value: raw.slice(valueStart, i) });
        currentKey = null;
      }
      depth -= 1;
      if (depth === 0) break;
      continue;
    }

    if (ch === ',' && depth === 1 && currentKey !== null) {
      members.push({ key: currentKey, value: raw.slice(valueStart, i) });
      currentKey = null;
    }
  }

  const seen = new Map<string, string>();
  const duplicates = new Set<string>();
  const firstValues: Record<string, string> = {};

  for (const member of members) {
    if (wanted.includes(member.key) && firstValues[member.key] === undefined) {
      firstValues[member.key] = display(member.value);
    }

    const previous = seen.get(member.key);
    if (previous !== undefined) {
      duplicates.add(member.key);
      // The second value is what a plain JSON.parse would keep.
      firstValues[`${member.key}#last`] = display(member.value);
    } else {
      seen.set(member.key, member.value);
    }
  }

  return { duplicates: [...duplicates], firstValues };
}
