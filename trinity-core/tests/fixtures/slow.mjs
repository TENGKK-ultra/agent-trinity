const sid = 'sid-slow';

process.stdout.write(`${JSON.stringify({ type: 'system', subtype: 'init', session_id: sid })}\n`);

setTimeout(() => {
  process.stdout.write(
    `${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'late', session_id: sid })}\n`,
  );
  process.exit(0);
}, 60_000);

setInterval(() => {}, 1_000);
