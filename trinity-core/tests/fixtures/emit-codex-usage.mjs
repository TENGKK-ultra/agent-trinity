const [input, cached, output] = process.argv.slice(2).map(Number);

const duplicate = process.env.PROBE_DUPLICATE === '1';
const noThread = process.env.PROBE_NO_THREAD === '1';
const thread = process.env.PROBE_THREAD ?? 'thread-test';

if (!noThread) {
  process.stdout.write(`${JSON.stringify({ type: 'thread.started', thread_id: thread })}\n`);
}

process.stdout.write(
  `${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'ok' } })}\n`,
);

const completed = `${JSON.stringify({
  type: 'turn.completed',
  usage: {
    input_tokens: input,
    cached_input_tokens: cached,
    cache_write_input_tokens: 0,
    output_tokens: output,
    reasoning_output_tokens: 0,
  },
})}\n`;

process.stdout.write(completed);
if (duplicate) process.stdout.write(completed);
