import { resolve } from 'node:path';

/**
 * A test instance exists to stay away from production. Two mistakes are easy to
 * make from a shell — pointing it at the real database, or taking the real port
 * — and both are refused here, before anything is opened or bound.
 */
export interface TestInstanceInput {
  env: string | undefined;
  dbPath: string;
  port: number;
  defaultDbPath: string;
  defaultPort?: number;
}

export function assertTestInstanceIsolated(input: TestInstanceInput): void {
  const env = (input.env ?? '').trim().toLowerCase();

  if (env !== 'test') return;

  if (resolve(input.dbPath) === resolve(input.defaultDbPath)) {
    throw new Error(
      '拒绝启动：测试实例不能使用生产数据库路径。请设置 TRINITY_DB_PATH 指向独立文件。',
    );
  }

  if (input.port === (input.defaultPort ?? 3210)) {
    throw new Error(
      '拒绝启动：测试实例不能监听生产端口 3210。请设置 TRINITY_PORT（例如 3211）。',
    );
  }
}
