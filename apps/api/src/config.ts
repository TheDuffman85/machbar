import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const projectRoot = fileURLToPath(new URL('../../../', import.meta.url));
export type Config = {
  appUrl: string;
  port: number;
  host: string;
  dataDir: string;
  webDir: string;
  sessionSecret: string;
  oidc?: { issuer: string; clientId: string; clientSecret: string };
};
export function readConfig(env = process.env): Config {
  const keys = ['OIDC_ISSUER_URL', 'OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET'];
  const configured = keys.filter((key) => Boolean(env[key]));
  if (configured.length > 0 && configured.length !== keys.length)
    throw new Error(
      'Incomplete OIDC configuration: set OIDC_ISSUER_URL, OIDC_CLIENT_ID and OIDC_CLIENT_SECRET.',
    );
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
  if (configured.length && (!env.APP_URL || !env.SESSION_SECRET || env.SESSION_SECRET.length < 32))
    throw new Error('OIDC requires APP_URL and SESSION_SECRET (at least 32 characters).');
  if (configured.length && new URL(env.OIDC_ISSUER_URL!).protocol !== 'https:')
    throw new Error('OIDC_ISSUER_URL must use HTTPS.');
  if (env.NODE_ENV === 'production' && (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32))
    throw new Error('Production requires SESSION_SECRET (at least 32 characters).');
  return {
    appUrl: url.origin,
    port,
    host: env.HOST ?? '0.0.0.0',
    dataDir: resolve(projectRoot, env.DATA_DIR ?? './data'),
    webDir: resolve(projectRoot, env.WEB_DIR ?? './apps/web/dist'),
    sessionSecret: env.SESSION_SECRET ?? 'machbar-local-development-only-secret',
    oidc: configured.length
      ? {
          issuer: env.OIDC_ISSUER_URL!,
          clientId: env.OIDC_CLIENT_ID!,
          clientSecret: env.OIDC_CLIENT_SECRET!,
        }
      : undefined,
  };
}
