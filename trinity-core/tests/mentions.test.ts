import assert from 'node:assert/strict';
import test from 'node:test';
import { parseMentions } from '../src/group/mentions.ts';

test('提及：识别三种 Agent 与 DSH 别名', () => {
  assert.deepEqual(parseMentions('@Claude 看一下，然后 @codex 实现，最后 @DSH 验证'), [
    'claude',
    'codex',
    'deepseek',
  ]);
});

test('提及：同一个 Agent 只出现一次', () => {
  assert.deepEqual(parseMentions('@claude 和 @CLAUDE 都算同一个人'), ['claude']);
});

test('提及：普通文字不触发', () => {
  assert.deepEqual(parseMentions('用 Claude 和 Codex 比较一下'), []);
  assert.deepEqual(parseMentions('@unknown 你好'), []);
});
