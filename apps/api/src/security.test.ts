import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createUser } from '@machbar/shared';
import { readConfig } from './config.js';
import { buildServer } from './server.js';
import { SqliteStore } from './store.js';

const origin = 'http://localhost:3000';
const extraStores: SqliteStore[] = [];
let directory: string;
let app: Awaited<ReturnType<typeof buildServer>>;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'machbar-security-'));
  app = await buildServer({
    config: {
      ...readConfig({
        APP_URL: origin,
        DISABLE_USER_CREATION: 'false',
        RATE_LIMIT_MAX_PER_IP: '6',
        RATE_LIMIT_MAX_PER_USER: '3',
        RATE_LIMIT_MAX_ANONYMOUS: '2',
      }),
      dataDir: directory,
      webDir: join(directory, 'no-web'),
    },
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await app.close();
  for (const store of extraStores.splice(0)) await store.close();
  await rm(directory, { recursive: true, force: true });
});

describe('profile access keys', () => {
  it('protects encoded API paths and prevents caching their responses', async () => {
    expect((await app.inject('/%61pi/bootstrap')).statusCode).toBe(401);
    const response = await app.inject({
      url: '/%61pi/bootstrap',
      headers: { 'x-machbar-user': randomUUID() },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
  });
  it.each(['/api/bootstrap', '/api/local-user', '/api/sync'])(
    'requires a header credential for %s, even with an ID in the URL or body',
    async (url) => {
      const id = randomUUID();
      const store = new SqliteStore(directory);
      extraStores.push(store);
      await store.update(id, (doc) => {
        doc.preferences.name = 'Private';
      });
      const response = await app.inject({
        method: url === '/api/bootstrap' ? 'GET' : url === '/api/sync' ? 'PUT' : 'POST',
        url: `${url}?userId=${id}`,
        headers: { origin, 'if-match': '1' },
        ...(url === '/api/bootstrap'
          ? {}
          : { payload: url === '/api/sync' ? createUser(id) : { userId: id } }),
      });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ code: 'INVALID_IDENTITY' });
      expect((await store.readExisting(id)).preferences.name).toBe('Private');
    },
  );

  it('cannot read or overwrite another profile through a mismatched body credential', async () => {
    const alice = randomUUID();
    const bob = randomUUID();
    const store = new SqliteStore(directory);
    extraStores.push(store);
    await store.update(bob, (doc) => {
      doc.preferences.name = 'Private';
    });
    const headers = { origin, 'x-machbar-user': alice, 'if-match': '0' };
    for (const [url, method, payload] of [
      ['/api/local-user', 'POST', { userId: bob }],
      ['/api/sync', 'PUT', createUser(bob)],
    ] as const) {
      const response = await app.inject({ url, method, headers, payload });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({ code: 'ACCOUNT_CHANGED' });
    }
    expect((await store.readExisting(bob)).preferences.name).toBe('Private');
    expect(await readdir(directory)).toEqual(['data.db']);
    const authorized = await app.inject({
      method: 'POST',
      url: '/api/local-user',
      headers: { origin, 'x-machbar-user': bob.toUpperCase() },
      payload: { userId: bob },
    });
    expect(authorized.statusCode).toBe(200);
    expect(authorized.json().document.preferences.name).toBe('Private');
  });
});

describe('API rate limits', () => {
  it('does not charge rejected anonymous or per-user traffic to the shared IP allowance', async () => {
    for (let index = 0; index < 30; index++)
      expect((await app.inject('/api/bootstrap')).statusCode).toBe(index < 2 ? 401 : 429);
    const userId = randomUUID();
    for (let index = 0; index < 30; index++)
      expect(
        (await app.inject({ url: '/api/bootstrap', headers: { 'x-machbar-user': userId } }))
          .statusCode,
      ).toBe(index < 3 ? 200 : 429);
    expect(
      (await app.inject({ url: '/api/bootstrap', headers: { 'x-machbar-user': randomUUID() } }))
        .statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ url: '/api/bootstrap', headers: { 'x-machbar-user': randomUUID() } }))
        .statusCode,
    ).toBe(429);
  });

  it.each(['192.0.2.1', '192.0.2.0/24', '::1', '2001:db8::/32'])(
    'isolates forwarded clients through the trusted proxy %s',
    async (TRUSTED_PROXIES) => {
      await app.close();
      app = await buildServer({
        config: {
          ...readConfig({ TRUSTED_PROXIES, DISABLE_USER_CREATION: 'false' }),
          dataDir: directory,
          webDir: join(directory, 'no-web'),
        },
      });
      const remoteAddress = TRUSTED_PROXIES.split('/')[0]!;
      for (let index = 0; index < 300; index++)
        expect(
          (
            await app.inject({
              url: '/api/bootstrap',
              remoteAddress,
              headers: { 'x-forwarded-for': '198.51.100.1' },
            })
          ).statusCode,
        ).toBe(index < 20 ? 401 : 429);
      expect(
        (
          await app.inject({
            url: '/api/bootstrap',
            remoteAddress,
            headers: { 'x-forwarded-for': '198.51.100.2', 'x-machbar-user': randomUUID() },
          })
        ).statusCode,
      ).toBe(200);
      // Rotating UUIDs from one forwarded client still exhaust its IP budget.
      for (let index = 0; index < 280; index++)
        expect(
          (
            await app.inject({
              url: '/api/bootstrap',
              remoteAddress,
              headers: { 'x-forwarded-for': '198.51.100.1', 'x-machbar-user': randomUUID() },
            })
          ).statusCode,
        ).toBe(200);
      expect(
        (
          await app.inject({
            url: '/api/bootstrap',
            remoteAddress,
            headers: { 'x-forwarded-for': '198.51.100.1', 'x-machbar-user': randomUUID() },
          })
        ).statusCode,
      ).toBe(429);
    },
  );

  it('ignores spoofed forwarding from direct clients and stops at the first untrusted hop', async () => {
    await app.close();
    app = await buildServer({
      config: {
        ...readConfig({
          TRUSTED_PROXIES: '192.0.2.1',
          RATE_LIMIT_MAX_PER_IP: '2',
          DISABLE_USER_CREATION: 'false',
        }),
        dataDir: directory,
        webDir: join(directory, 'no-web'),
      },
    });
    for (const remoteAddress of ['203.0.113.1', '192.0.2.1']) {
      for (let index = 0; index < 3; index++) {
        const spoofed = `198.51.100.${index + 1}`;
        expect(
          (
            await app.inject({
              url: '/api/bootstrap',
              remoteAddress,
              headers: {
                'x-machbar-user': randomUUID(),
                'x-forwarded-for':
                  remoteAddress === '192.0.2.1' ? `${spoofed}, 203.0.113.2` : spoofed,
              },
            })
          ).statusCode,
        ).toBe(index < 2 ? 200 : 429);
      }
    }
  });

  it('counts missing and invalid IDs together before identity checks or body parsing', async () => {
    expect((await app.inject('/api/bootstrap')).statusCode).toBe(401);
    expect(
      (await app.inject({ url: '/api/bootstrap', headers: { 'x-machbar-user': 'invalid' } }))
        .statusCode,
    ).toBe(400);
    const limited = await app.inject({
      method: 'PUT',
      url: '/api/sync',
      headers: { 'content-type': 'application/json' },
      payload: '{broken',
    });
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toEqual({ code: 'RATE_LIMITED' });
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    expect(limited.headers['cache-control']).toBe('no-store');
    expect(await readdir(directory)).toEqual(['data.db']);
    expect(
      (await app.inject({ url: '/api/bootstrap', headers: { 'x-machbar-user': randomUUID() } }))
        .statusCode,
    ).toBe(200);
  });

  it('shares a user limit across endpoints, IPs, and UUID casing', async () => {
    const userId = randomUUID();
    for (let index = 0; index < 3; index++) {
      expect(
        (
          await app.inject({
            url: '/api/bootstrap',
            headers: { 'x-machbar-user': userId },
            remoteAddress: `192.0.2.${index + 1}`,
          })
        ).statusCode,
      ).toBe(200);
    }
    const limited = await app.inject({
      method: 'POST',
      url: '/api/local-user',
      headers: { origin, 'x-machbar-user': userId.toUpperCase() },
      payload: { userId },
      remoteAddress: '192.0.2.4',
    });
    expect(limited.statusCode).toBe(429);
    expect(
      (await app.inject({ url: '/api/bootstrap', headers: { 'x-machbar-user': randomUUID() } }))
        .statusCode,
    ).toBe(200);
  });

  it('cannot bypass the IP limit by rotating IDs, URLs, or forwarding headers', async () => {
    for (let index = 0; index < 6; index++) {
      expect(
        (
          await app.inject({
            url: `/api/bootstrap?attempt=${index}`,
            headers: { 'x-machbar-user': randomUUID(), 'x-forwarded-for': `192.0.2.${index + 1}` },
          })
        ).statusCode,
      ).toBe(200);
    }
    expect(
      (
        await app.inject({
          url: '/api/bootstrap',
          headers: { 'x-machbar-user': randomUUID(), 'x-forwarded-for': '198.51.100.1' },
        })
      ).statusCode,
    ).toBe(429);
    expect(
      (
        await app.inject({
          url: '/api/bootstrap',
          headers: { 'x-machbar-user': randomUUID() },
          remoteAddress: '192.0.2.100',
        })
      ).statusCode,
    ).toBe(200);
    expect((await app.inject('/health')).statusCode).toBe(200);
  });

  it('limits unknown API endpoints too and restores the allowance after the window', async () => {
    const clock = vi.spyOn(Date, 'now');
    const now = Date.now();
    clock.mockReturnValue(now);
    for (let index = 0; index < 2; index++)
      expect((await app.inject('/api/unknown')).statusCode).toBe(401);
    expect((await app.inject('/%61pi/bootstrap')).statusCode).toBe(429);
    clock.mockReturnValue(now + 60_000);
    expect((await app.inject('/api/bootstrap')).statusCode).toBe(401);
    expect((await app.inject('/api/bootstrap')).statusCode).toBe(401);
    expect((await app.inject('/api/bootstrap')).statusCode).toBe(429);
  });
});
