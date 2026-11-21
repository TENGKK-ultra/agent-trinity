import assert from 'node:assert/strict';
import test from 'node:test';
import { countCharacters, safeSlice } from '../src/common/text.ts';

/** The project's lib target predates String#isWellFormed. */
function isWellFormed(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);

    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);

      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      i += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }

  return true;
}

test('safeSlice：ASCII 在预算内原样返回，超出按预算截断', () => {
  assert.equal(safeSlice('abc', 3), 'abc');
  assert.equal(safeSlice('abcdef', 3), 'abc');
  assert.equal(safeSlice('abcdef', 0), '');
});

test('safeSlice：截断点正好停在 emoji 之前', () => {
  assert.equal(safeSlice('ab😀cd', 2), 'ab');
});

test('safeSlice：截断点落在代理对中间时退一位，不留下半个字符', () => {
  const value = 'a😀'; // [a, 高代理, 低代理]

  const cut = safeSlice(value, 2);

  assert.equal(cut, 'a');
  assert.equal(isWellFormed(cut), true);
});

test('safeSlice：连续多个 emoji 的每个截断点都保持完整', () => {
  const value = '😀😀😀';

  for (let budget = 1; budget <= value.length; budget += 1) {
    const cut = safeSlice(value, budget);

    assert.ok(cut.length <= budget);
    assert.equal(isWellFormed(cut), true, `budget=${budget}`);
  }
});

test('countCharacters：emoji 按一个字符计数，与截断标记一致', () => {
  assert.equal(countCharacters('abc'), 3);
  assert.equal(countCharacters('a😀'), 2);
  assert.equal(countCharacters('😀😀'), 2);
});
