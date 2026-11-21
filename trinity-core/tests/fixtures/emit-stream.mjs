const sid = 'sid-test-1';

const out = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

out({ type: 'system', subtype: 'init', session_id: sid });
out({
  type: 'assistant',
  session_id: sid,
  message: { content: [{ type: 'thinking', thinking: 'thinking about it' }] },
});
out({
  type: 'assistant',
  session_id: sid,
  message: { content: [{ type: 'text', text: '第一段' }] },
});
out({
  type: 'assistant',
  session_id: sid,
  message: {
    content: [
      { type: 'tool_use', id: 'tu1', name: 'Read', input: { file: 'a.txt' } },
    ],
  },
});
out({
  type: 'user',
  session_id: sid,
  message: {
    content: [
      { type: 'tool_result', tool_use_id: 'tu1', content: [{ type: 'text', text: 'file body' }] },
    ],
  },
});
out({
  type: 'assistant',
  session_id: sid,
  message: {
    content: [
      { type: 'text', text: '第二段甲' },
      { type: 'text', text: '第二段乙' },
    ],
  },
});
out({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: '第一段\n第二段甲第二段乙',
  session_id: sid,
});
