const sessionId = 'session-dsh-1';

const out = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

out({ type: 'session', sessionId, cwd: process.cwd() });
out({ type: 'status', phase: 'turn_start', turn: 1 });
out({ type: 'status', phase: 'step_start', turn: 1, step: 1 });
out({ type: 'thinking', text: '' });
out({ type: 'text', text: '第一段\n第二段' });
out({
  type: 'status',
  phase: 'step_end',
  turn: 1,
  step: 1,
  usage: { inputTokens: 10, outputTokens: 4 },
});
out({ type: 'status', phase: 'turn_end', turn: 1, reason: { kind: 'completed' } });
out({ type: 'final', sessionId, reason: { kind: 'completed' }, text: '第一段\n第二段' });
