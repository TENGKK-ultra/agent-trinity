const mode = process.argv[2] ?? 'normal';

function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function step(turn, number, input, output, cacheRead, cacheWrite, total) {
  return {
    type: 'status',
    phase: 'step_end',
    ...(turn === null ? {} : { turn }),
    ...(number === null ? {} : { step: number }),
    usage: {
      inputTokens: input,
      outputTokens: output,
      cacheReadTokens: cacheRead,
      cacheWriteTokens: cacheWrite,
      totalTokens: total,
    },
  };
}

emit({ type: 'session', sessionId: 'dsh-session-test' });

if (mode === 'normal') {
  emit(step(1, 1, 100, 10, 20, 5, 135));
  emit(step(1, 2, 200, 20, 0, 0, 220));
} else if (mode === 'duplicate') {
  const line = step(1, 1, 100, 10, 20, 5, 135);
  emit(line);
  emit(line);
} else if (mode === 'no-identity') {
  emit(step(null, null, 100, 10, 20, 5, 135));
  emit(step(null, null, 100, 10, 20, 5, 135));
} else if (mode === 'inconsistent') {
  emit(step(1, 1, 100, 10, 20, 5, 9999));
}

emit({ type: 'final', reason: { kind: 'completed' }, text: 'ok', sessionId: 'dsh-session-test' });
