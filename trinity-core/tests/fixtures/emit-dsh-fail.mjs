const sessionId = 'session-dsh-fail';

const out = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

out({ type: 'session', sessionId, cwd: process.cwd() });
out({ type: 'status', phase: 'turn_start', turn: 1 });
out({
  type: 'final',
  sessionId,
  reason: { kind: 'error', error: { message: 'no API key', code: 'MISSING_CREDENTIAL' } },
  text: '',
});
