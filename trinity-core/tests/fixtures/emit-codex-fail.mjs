const out = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

out({ type: 'thread.started', thread_id: 'cx-thread-fail' });
out({ type: 'turn.started' });
out({ type: 'turn.failed', message: 'model not found' });
