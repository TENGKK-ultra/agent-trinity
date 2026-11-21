import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { parseDshLine } from '../src/harnesses/dsh.adapter.ts';

const FIXTURE = resolve(import.meta.dirname, 'fixtures', 'dsh-activity.jsonl');

const LINES = readFileSync(FIXTURE, 'utf8')
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line !== '');

function lineAt(index: number): string {
  const value = LINES[index];
  if (value === undefined) throw new Error(`fixture line ${index} is missing`);
  return value;
}

test('DSH：tool_call 解析为工具调用，保留 callId 与工具名', () => {
  const frame = parseDshLine(lineAt(0));

  assert.ok(frame?.events);
  const event = frame.events[0];

  assert.equal(event?.type, 'tool_call');
  if (event?.type !== 'tool_call') throw new Error('unexpected event');
  assert.equal(event.name, 'read');
  assert.equal(event.ref, 'call_00_ET_wYBMnGDFvJj2NsZcE4oh0971');
  assert.deepEqual(event.input, { file_path: 'tests/fixtures/fake.txt' });
});

test('DSH：tool_result 与调用使用同一个 callId，并带完成摘要', () => {
  const frame = parseDshLine(lineAt(1));

  assert.ok(frame?.events);
  const event = frame.events[0];

  assert.equal(event?.type, 'tool_result');
  if (event?.type !== 'tool_result') throw new Error('unexpected event');
  assert.equal(event.ref, 'call_00_ET_wYBMnGDFvJj2NsZcE4oh0971');
  assert.equal(event.summary, '完成');
  assert.match(event.content, /DSH_PROBE_OK/);
});

test('DSH：工具失败写进摘要，正文保留原始错误', () => {
  const frame = parseDshLine(lineAt(2));

  assert.ok(frame?.events);
  const event = frame.events[0];

  assert.equal(event?.type, 'tool_result');
  if (event?.type !== 'tool_result') throw new Error('unexpected event');
  assert.equal(event.summary, '失败 · FS_NOT_FOUND');
  assert.equal(event.content, 'Error: cannot read');
});

test('DSH：step 状态不进入活动流，只带出用量', () => {
  const frame = parseDshLine(lineAt(3));

  assert.ok(frame);
  assert.equal(frame.events, undefined, 'step 不产生活动事件');
  assert.equal(frame.terminal, undefined);
  assert.ok(frame.usage, '用完量帧承载');
});

test('DSH：缺少 callId 时不编造关联', () => {
  const frame = parseDshLine('{"type":"tool_call","tool":"read","input":{}}');

  assert.ok(frame?.events);
  const event = frame.events[0];

  assert.equal(event?.type, 'tool_call');
  if (event?.type !== 'tool_call') throw new Error('unexpected event');
  assert.equal(event.ref, null);
});
