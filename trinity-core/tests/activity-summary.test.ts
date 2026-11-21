import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_SUMMARY_CHARS,
  buildSummary,
  sanitizeSummary,
} from '../src/harnesses/activity-summary.ts';

test('summary：拼接允许的片段，空片段被丢弃', () => {
  assert.equal(buildSummary(['新增 a.ts', null, '', undefined, '修改 b.ts']), '新增 a.ts · 修改 b.ts');
  assert.equal(buildSummary([null, '']), null);
});

test('summary：去掉控制字符与换行，折叠空白', () => {
  assert.equal(buildSummary([' 新增\n\ta.ts \r\n ', '完成']), '新增 a.ts · 完成');
  assert.equal(buildSummary(['a\u0000b\u001fc']), 'a b c');
});

test('summary：超长时截断并带省略号', () => {
  const summary = buildSummary(['x'.repeat(300)]);

  assert.ok(summary !== null);
  assert.equal(summary.length, MAX_SUMMARY_CHARS);
  assert.ok(summary.endsWith('…'));
});

test('sanitizeSummary：只接受字符串，其余视为无效', () => {
  assert.equal(sanitizeSummary('  完成  '), '完成');
  assert.equal(sanitizeSummary(''), null);
  assert.equal(sanitizeSummary('   '), null);
  assert.equal(sanitizeSummary(42), null);
  assert.equal(sanitizeSummary({ text: 'x' }), null);
  assert.equal(sanitizeSummary(null), null);
});

test('sanitizeSummary：再次清理并封顶', () => {
  const dirty = ` 新增\n${'y'.repeat(300)} `;
  const cleaned = sanitizeSummary(dirty);

  assert.ok(cleaned !== null);
  assert.equal(cleaned.includes('\n'), false);
  assert.equal(cleaned.length, MAX_SUMMARY_CHARS);
});
