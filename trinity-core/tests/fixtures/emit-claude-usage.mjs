const [input, output, cacheRead, cacheWrite, cost] = process.argv
  .slice(2)
  .map(Number);

const payload = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: 'ok',
  session_id: 'claude-session-test',
  total_cost_usd: cost,
  usage: {
    input_tokens: input,
    output_tokens: output,
    cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: cacheWrite,
    output_tokens_details: { thinking_tokens: 4 },
  },
  // Present on purpose: the adapter must not add this to the totals.
  modelUsage: {
    'claude-test': { input_tokens: input, output_tokens: output },
  },
};

process.stdout.write(`${JSON.stringify(payload)}\n`);
