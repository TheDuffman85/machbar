import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const projectRoot = fileURLToPath(new URL('../../../', import.meta.url));
export type Config = {
  appUrl: string;
  port: number;
  host: string;
  dataDir: string;
  webDir: string;
  dailyHistoryDays: number;
};
export function readConfig(env = process.env): Config {
  const appUrl = env.APP_URL ?? 'http://localhost:3000';
  const url = new URL(appUrl);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  )
    throw new Error('APP_URL must be an HTTP(S) origin.');
  const port = Number(env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT.');
  const dailyHistoryDays = Number(env.DAILY_HISTORY_DAYS ?? 3);
  if (
    !Number.isSafeInteger(dailyHistoryDays) ||
    dailyHistoryDays < 0 ||
    (env.DAILY_HISTORY_DAYS !== undefined && !/^\d+$/.test(env.DAILY_HISTORY_DAYS))
  )
    throw new Error('DAILY_HISTORY_DAYS must be a non-negative integer.');
  return {
    appUrl: url.origin,
    port,
    host: env.HOST ?? '0.0.0.0',
    dataDir: resolve(projectRoot, env.DATA_DIR ?? './data'),
    webDir: resolve(projectRoot, env.WEB_DIR ?? './apps/web/dist'),
    dailyHistoryDays,
  };
}
