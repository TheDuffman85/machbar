import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildServer } from './server.js';
import { readConfig } from './config.js';
import type { OidcAdapter } from './auth.js';
const origin = 'http://localhost:3000',
  issuer = 'https://identity.example';
let directory: string,
  app: Awaited<ReturnType<typeof buildServer>>,
  subject: string,
  invalidNonce: boolean;
let lastTransaction: { state: string; nonce: string; verifier: string };
const adapter: OidcAdapter = {
  async authorization(tx) {
    lastTransaction = tx;
    return `${issuer}/authorize?state=${tx.state}&nonce=${tx.nonce}`;
  },
  async exchange(_url, tx) {
    expect(tx.verifier).toBe(lastTransaction.verifier);
    expect(tx.nonce).toBe(lastTransaction.nonce);
    if (invalidNonce) throw new Error('nonce mismatch');
    return { issuer, subject, name: subject };
  },
};
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'machbar-auth-'));
  subject = 'Alice';
  invalidNonce = false;
  app = await buildServer({
    config: {
      ...readConfig({
        APP_URL: origin,
        OIDC_ISSUER_URL: issuer,
        OIDC_CLIENT_ID: 'client',
        OIDC_CLIENT_SECRET: 'secret',
        SESSION_SECRET: 'test-secret-'.repeat(5),
      }),
      dataDir: directory,
      webDir: join(directory, 'no-web'),
    },
    oidcAdapter: adapter,
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await app.close();
  await rm(directory, { recursive: true, force: true });
});
function cookie(response: Awaited<ReturnType<typeof app.inject>>) {
  return response.cookies.map((c) => `${c.name}=${encodeURIComponent(c.value)}`).join('; ');
}
async function login() {
  const started = await app.inject('/auth/login');
  const state = lastTransaction.state;
  const callback = await app.inject({
    url: `/auth/callback?code=valid&state=${state}`,
    headers: { cookie: cookie(started) },
  });
  return { started, callback, state, session: cookie(callback) };
}
describe('OIDC', () => {
  it('requires the configured origin even when the Host matches an alternate origin', async () => {
    const { session } = await login();
    const response = await app.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: {
        host: '192.168.2.100:3000',
        origin: 'http://192.168.2.100:3000',
        cookie: session,
      },
      payload: {},
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe('ORIGIN_REJECTED');
  });
  it('requires authentication and provisions isolated users', async () => {
    expect((await app.inject('/api/bootstrap')).statusCode).toBe(401);
    const alice = await login();
    expect(alice.callback.headers.location).toBe('/');
    const response = await app.inject({
      url: '/api/bootstrap',
      headers: { cookie: alice.session },
    });
    expect(response.statusCode).toBe(200);
    const a = response.json();
    expect(a.document.preferences.name).toBe('Alice');
    subject = 'Bob';
    const bob = await login();
    const b = (
      await app.inject({ url: '/api/bootstrap', headers: { cookie: bob.session } })
    ).json();
    expect(b.document.userId).not.toBe(a.document.userId);
    const mismatch = await app.inject({
      method: 'POST',
      url: '/api/completions',
      headers: { origin, cookie: bob.session, 'x-machbar-user': a.document.userId },
      payload: {},
    });
    expect(mismatch.json().code).toBe('ACCOUNT_CHANGED');
  });
  it('rejects invalid state and nonce and does not establish a session', async () => {
    const started = await app.inject('/auth/login');
    const response = await app.inject({
      url: '/auth/callback?state=wrong&code=x',
      headers: { cookie: cookie(started) },
    });
    expect(response.headers.location).toBe('/?authError=1');
    invalidNonce = true;
    const { callback, session } = await login();
    expect(callback.headers.location).toBe('/?authError=1');
    expect(
      (await app.inject({ url: '/api/bootstrap', headers: { cookie: session } })).statusCode,
    ).toBe(401);
  });
  it('consumes transactions once', async () => {
    const { started, state } = await login();
    const repeat = await app.inject({
      url: `/auth/callback?state=${state}&code=valid`,
      headers: { cookie: cookie(started) },
    });
    expect(repeat.headers.location).toBe('/?authError=1');
  });
  it('rejects expired sessions', async () => {
    const { session } = await login();
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 8 * 86400_000);
    expect(
      (await app.inject({ url: '/api/bootstrap', headers: { cookie: session } })).statusCode,
    ).toBe(401);
  });
  it('logs out and rejects tampered cookies', async () => {
    const { session } = await login();
    const tampered = session.replace(/.$/, 'x');
    expect(
      (await app.inject({ url: '/api/bootstrap', headers: { cookie: tampered } })).statusCode,
    ).toBe(401);
    const response = await app.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: { origin, cookie: session },
      payload: {},
    });
    expect(response.cookies[0]!.value).toBe('');
  });
});
describe('configuration', () => {
  it('rejects partial OIDC configuration and short secrets', () => {
    expect(() => readConfig({ OIDC_CLIENT_ID: 'x' })).toThrow('Incomplete');
    expect(() =>
      readConfig({
        OIDC_ISSUER_URL: issuer,
        OIDC_CLIENT_ID: 'x',
        OIDC_CLIENT_SECRET: 'y',
        APP_URL: origin,
        SESSION_SECRET: 'short',
      }),
    ).toThrow('SESSION_SECRET');
  });
  it('requires an origin URL and production secrets', () => {
    expect(() => readConfig({ APP_URL: `${origin}/path` })).toThrow('origin');
    expect(() => readConfig({ NODE_ENV: 'production' })).toThrow('SESSION_SECRET');
  });
});
