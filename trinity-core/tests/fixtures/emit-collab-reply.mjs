// One scripted reply for a collaboration turn, in the provider's own stream
// format. The text is chosen by the test's adapter, which reads the prompt.
//
//   node emit-collab-reply.mjs <kind> <text> [delayMs] [usageTokens]

const kind = process.argv[2];
const text = process.argv[3] ?? '';
const delay = Number(process.argv[4] ?? 0);
const usageTokens = Number(process.argv[5] ?? 0);

if (delay > 0) {
  await new Promise((resolve) => setTimeout(resolve, delay));
}

const out = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

if (kind === 'claude') {
  if (usageTokens > 0) {
    out({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: text,
      session_id: 'collab-claude',
      total_cost_usd: 0,
      usage: {
        input_tokens: usageTokens,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    });
  } else {
    out({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: text,
      session_id: 'collab-claude',
    });
  }
} else if (kind === 'deepseek') {
  out({ type: 'session', sessionId: 'collab-dsh', cwd: process.cwd() });
  out({ type: 'text', text });
  out({ type: 'final', sessionId: 'collab-dsh', reason: { kind: 'completed' }, text });
} else {
  out({ type: 'thread.started', thread_id: 'collab-codex' });
  out({ type: 'item.completed', item: { type: 'agent_message', text } });
  out({ type: 'turn.completed' });
}
