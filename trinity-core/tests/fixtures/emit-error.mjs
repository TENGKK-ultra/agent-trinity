const sid = 'sid-err';

const out = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

out({ type: 'system', subtype: 'init', session_id: sid });
out({
  type: 'assistant',
  session_id: sid,
  message: { content: [{ type: 'text', text: 'partial answer' }] },
});
// Mirrors the real CLI: subtype says success even though the run failed.
out({
  type: 'result',
  subtype: 'success',
  is_error: true,
  result: 'provider rejected the request',
  session_id: sid,
});
