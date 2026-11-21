import { startServer } from './server.ts';

try {
  startServer();
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
