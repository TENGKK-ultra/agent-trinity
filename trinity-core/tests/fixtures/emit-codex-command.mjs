const command =
  '"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command "Get-ChildItem env:"';
const output = 'y'.repeat(9000);

process.stdout.write(
  `${JSON.stringify({
    type: 'item.completed',
    item: {
      id: 'item_9',
      type: 'command_execution',
      command,
      aggregated_output: output,
      exit_code: 1,
      status: 'completed',
    },
  })}\n`,
);

process.stdout.write(`${JSON.stringify({ type: 'turn.completed' })}\n`);
