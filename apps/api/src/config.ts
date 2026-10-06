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
  disableUserCreation: boolean;
  rateLimitWindowSeconds: number;
  rateLimitMaxPerIp: number;
  rateLimitMaxPerUser: number;
  rateLimitMaxAnonymous: number;
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
  const disableUserCreation = env.DISABLE_USER_CREATION ?? 'false';
  if (!['true', 'false'].includes(disableUserCreation))
    throw new Error('DISABLE_USER_CREATION must be true or false.');
  const positiveInteger = (name: string, fallback: number, maximum = Number.MAX_SAFE_INTEGER) => {
    const value = env[name] ?? String(fallback);
    const parsed = Number(value);
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum)
      throw new Error(`${name} must be a positive integer no greater than ${maximum}.`);
    return parsed;
  };
  return {
    appUrl: url.origin,
    port,
    host: env.HOST ?? '0.0.0.0',
    dataDir: resolve(projectRoot, env.DATA_DIR ?? './data'),
    webDir: resolve(projectRoot, env.WEB_DIR ?? './apps/web/dist'),
    dailyHistoryDays,
    disableUserCreation: disableUserCreation === 'true',
    rateLimitWindowSeconds: positiveInteger('RATE_LIMIT_WINDOW_SECONDS', 60, 86_400),
    rateLimitMaxPerIp: positiveInteger('RATE_LIMIT_MAX_PER_IP', 300),
    rateLimitMaxPerUser: positiveInteger('RATE_LIMIT_MAX_PER_USER', 120),
    rateLimitMaxAnonymous: positiveInteger('RATE_LIMIT_MAX_ANONYMOUS', 20),
  };
}
