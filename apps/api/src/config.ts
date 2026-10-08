import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createECDH } from 'node:crypto';
import { isIP } from 'node:net';
import { storageDefaults } from './storage-budget.js';
const projectRoot = fileURLToPath(new URL('../../../', import.meta.url));
export type Config = {
  vapid: { publicKey: string; privateKey: string; subject: string } | null;
  appUrl: string;
  port: number;
  host: string;
  trustedProxies: string[];
  dataDir: string;
  webDir: string;
  dailyHistoryDays: number;
  disableUserCreation: boolean;
  rateLimitWindowSeconds: number;
  rateLimitMaxPerIp: number;
  rateLimitMaxPerUser: number;
  rateLimitMaxAnonymous: number;
  rateLimitMaxNewUsers: number;
  maxProfiles: number;
  maxStorageBytes: number;
  storageReserveBytes: number;
};
export function readConfig(env = process.env): Config {
  const vapidValues = [env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY, env.VAPID_SUBJECT];
  let vapid: Config['vapid'] = null;
  if (vapidValues.some((value) => value !== undefined && value !== '')) {
    try {
      const publicKey = env.VAPID_PUBLIC_KEY ?? '';
      const privateKey = env.VAPID_PRIVATE_KEY ?? '';
      const subject = env.VAPID_SUBJECT ?? '';
      if (!/^[A-Za-z0-9_-]{87}$/.test(publicKey) || !/^[A-Za-z0-9_-]{43}$/.test(privateKey))
        throw new Error();
      const key = createECDH('prime256v1');
      key.setPrivateKey(Buffer.from(privateKey, 'base64url'));
      if (key.getPublicKey().toString('base64url') !== publicKey) throw new Error();
      const contact = new URL(subject);
      if (
        !['https:', 'mailto:'].includes(contact.protocol) ||
        contact.username ||
        contact.password ||
        (contact.protocol === 'mailto:'
          ? !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact.pathname)
          : !contact.hostname.includes('.') || contact.hostname.endsWith('.localhost'))
      )
        throw new Error();
      vapid = { publicKey, privateKey, subject };
    } catch {
      throw new Error(
        'VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT must be complete and valid (matching P-256 keys and a public HTTPS or mailto contact).',
      );
    }
  }
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
  const disableUserCreation = env.DISABLE_USER_CREATION ?? 'true';
  if (!['true', 'false'].includes(disableUserCreation))
    throw new Error('DISABLE_USER_CREATION must be true or false.');
  const trustedProxies = env.TRUSTED_PROXIES?.trim()
    ? env.TRUSTED_PROXIES.split(',').map((entry) => entry.trim())
    : [];
  for (const entry of trustedProxies) {
    const [address, prefix, extra] = entry.split('/');
    const version = isIP(address ?? '');
    if (
      !version ||
      extra !== undefined ||
      (prefix !== undefined &&
        (!/^\d+$/.test(prefix) ||
          Number(prefix) < 1 ||
          Number(prefix) > (version === 4 ? 32 : 128)))
    )
      throw new Error('TRUSTED_PROXIES must be a comma-separated IP/CIDR allowlist (no /0).');
  }
  const positiveInteger = (name: string, fallback: number, maximum = Number.MAX_SAFE_INTEGER) => {
    const value = env[name] ?? String(fallback);
    const parsed = Number(value);
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum)
      throw new Error(`${name} must be a positive integer no greater than ${maximum}.`);
    return parsed;
  };
  return {
    vapid,
    appUrl: url.origin,
    port,
    host: env.HOST ?? '0.0.0.0',
    trustedProxies,
    dataDir: resolve(projectRoot, env.DATA_DIR ?? './data'),
    webDir: resolve(projectRoot, env.WEB_DIR ?? './apps/web/dist'),
    dailyHistoryDays,
    disableUserCreation: disableUserCreation === 'true',
    rateLimitWindowSeconds: positiveInteger('RATE_LIMIT_WINDOW_SECONDS', 60, 86_400),
    rateLimitMaxPerIp: positiveInteger('RATE_LIMIT_MAX_PER_IP', 300),
    rateLimitMaxPerUser: positiveInteger('RATE_LIMIT_MAX_PER_USER', 120),
    rateLimitMaxAnonymous: positiveInteger('RATE_LIMIT_MAX_ANONYMOUS', 20),
    rateLimitMaxNewUsers: positiveInteger('RATE_LIMIT_MAX_NEW_USERS', 10),
    maxProfiles: positiveInteger('MAX_PROFILES', storageDefaults.maxProfiles),
    maxStorageBytes: positiveInteger('MAX_STORAGE_BYTES', storageDefaults.maxStorageBytes),
    storageReserveBytes: positiveInteger(
      'STORAGE_RESERVE_BYTES',
      storageDefaults.storageReserveBytes,
    ),
  };
}
