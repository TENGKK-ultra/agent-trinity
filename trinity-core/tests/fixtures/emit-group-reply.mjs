const kind = process.argv[2];
const text = process.argv[3] ?? '';
const delay = Number(process.argv[4] ?? 0);

if (delay > 0) {
  await new Promise((resolve) => setTimeout(resolve, delay));
}

if (kind === 'claude') {
  process.stdout.write(
    `${JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: text,
      session_id: 'group-claude',
    })}\n`,
  );
} else if (kind === 'deepseek') {
  const out = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

  out({ type: 'session', sessionId: 'group-dsh', cwd: process.cwd() });
  out({ type: 'status', phase: 'turn_start', turn: 1 });
  out({ type: 'text', text });
  out({ type: 'status', phase: 'turn_end', turn: 1, reason: { kind: 'completed' } });
  out({ type: 'final', sessionId: 'group-dsh', reason: { kind: 'completed' }, text });
} else {
  process.stdout.write(
    `${JSON.stringify({ type: 'thread.started', thread_id: 'group-codex' })}\n`,
  );
  process.stdout.write(
    `${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text } })}\n`,
  );
  process.stdout.write(`${JSON.stringify({ type: 'turn.completed' })}\n`);
}
