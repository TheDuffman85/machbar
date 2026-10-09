import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { SyncSnapshot } from '@machbar/shared';
import { buildServer } from './server.js';
import { SqliteStore } from './store.js';
import { StorageBudget } from './storage-budget.js';
import { readConfig } from './config.js';
import webpush from 'web-push';
import { executeDatabase, storedRecord } from '../test-support/database.js';
import {
  hashAdminPassword,
  parseAdminPasswordHash,
  readMinimumAdminPasswordLength,
  verifyAdminPassword,
} from './hash-admin-password.js';

const origin = 'http://localhost:3000';
const password = 'correct horse battery';
const credentials = {
  ADMIN_PASSWORD_HASH: await hashAdminPassword(password),
};
const form = { 'content-type': 'application/x-www-form-urlencoded' };
let directory: string;
let app: Awaited<ReturnType<typeof buildServer>>;
let valid: string;

const login = (password: string, headers: Record<string, string> = { origin }) =>
  app.inject({
    method: 'POST',
    url: '/admin/login',
    headers: { ...form, ...headers },
    payload: new URLSearchParams({ password }).toString(),
  });
async function signIn(appUrl = origin) {
  const response = await login(password, { origin: appUrl });
  expect(response.statusCode).toBe(303);
  return response.headers['set-cookie']!.toString().split(';')[0]!;
}

async function start(env: Record<string, string> = credentials) {
  app = await buildServer({
    config: {
      ...readConfig({ APP_URL: origin, ...env }),
      dataDir: directory,
      webDir: join(directory, 'no-web'),
    },
  });
  if (env.ADMIN_PASSWORD_HASH) valid = await signIn(env.APP_URL);
}
async function saveProfile(name: string) {
  const userId = randomUUID();
  const headers = { 'x-machbar-user': userId };
  const { document } = (await app.inject({ url: '/api/bootstrap', headers })).json<SyncSnapshot>();
  document.preferences.name = name;
  const response = await app.inject({
    method: 'PUT',
    url: '/api/sync',
    headers: { ...headers, origin, 'if-match': '0' },
    payload: document,
  });
  expect(response.statusCode).toBe(200);
  return userId;
}
// The profile cards, without the times shown by the panels above them.
const profileList = (page: string) => page.slice(page.indexOf('<h2 class="section">Profiles'));
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'machbar-admin-'));
});
afterEach(async () => {
  await app.close();
  await rm(directory, { recursive: true, force: true });
});

describe('admin page', () => {
  it('is not served unless credentials are configured', async () => {
    await start({});
    expect((await app.inject({ url: '/admin' })).statusCode).toBe(404);
    expect((await login(password)).statusCode).toBe(404);
  });

  it('shows a login form and keeps the profiles behind a session cookie', async () => {
    await start();
    await saveProfile('Zoe');
    const anonymous = await app.inject({ url: '/admin' });
    expect(anonymous.statusCode).toBe(200);
    expect(anonymous.body).toContain('action="/admin/login"');
    expect(anonymous.body).not.toContain('Zoe');
    expect((await app.inject({ url: '/admin/admin.js' })).statusCode).toBe(401);
    expect(
      (await app.inject({ url: '/admin', headers: { cookie: 'machbar_admin=forged' } })).body,
    ).not.toContain('Zoe');

    expect(valid).toMatch(/^machbar_admin=[\w-]{43}$/);
    const response = await login(password);
    expect(response.headers.location).toBe('/admin');
    expect(response.headers['set-cookie']).toContain('HttpOnly');
    expect(response.headers['set-cookie']).toContain('SameSite=Strict');
    expect(response.headers['set-cookie']).toContain('Path=/admin');
    expect((await app.inject({ url: '/admin', headers: { cookie: valid } })).body).toContain('Zoe');

    const logout = await app.inject({
      method: 'POST',
      url: '/admin/logout',
      headers: { ...form, origin, cookie: valid },
      payload: '',
    });
    expect(logout.statusCode).toBe(303);
    expect(logout.headers['set-cookie']).toContain('Max-Age=0');
    expect((await app.inject({ url: '/admin', headers: { cookie: valid } })).body).not.toContain(
      'Zoe',
    );
  });

  it('rejects wrong and cross-site logins and limits failed attempts', async () => {
    await start();
    expect((await login(password, {})).statusCode).toBe(403);
    for (const secret of ['wrong password!', `${password} `, '']) {
      const failed = await login(secret);
      expect(failed.statusCode).toBe(401);
      expect(failed.headers['set-cookie']).toBeUndefined();
      expect(failed.body).toContain('Wrong password.');
    }
    for (let attempt = 0; attempt < 7; attempt++) await login('b');
    const locked = await login(password);
    expect(locked.statusCode).toBe(429);
    expect(locked.headers['retry-after']).toBeDefined();
    expect(locked.headers['set-cookie']).toBeUndefined();
  });

  it('marks the session cookie Secure when the app is served over HTTPS', async () => {
    await start({ ...credentials, APP_URL: 'https://machbar.example' });
    const response = await login(password, {
      origin: 'https://machbar.example',
    });
    expect(response.headers['set-cookie']).toContain('; Secure');
  });

  it('lists profiles with escaped names, stats, avatars and dates', async () => {
    await start();
    const before = Date.now();
    const userId = await saveProfile('<b>Alice</b>');
    const response = await app.inject({ url: '/admin', headers: { cookie: valid } });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.body).toContain('&lt;b&gt;Alice&lt;/b&gt;');
    expect(response.body).not.toContain('<b>Alice</b>');
    expect(response.body).toContain(`/admin/profiles/${userId}/delete`);
    expect(response.body).toContain('src="data:image/svg+xml');
    expect(response.body).toMatch(/Profiles<\/dt>\s*<dd>1 \/ 100 /);
    const times = [...profileList(response.body).matchAll(/<time datetime="([^"]+)"/g)].map(
      (m) => m[1]!,
    );
    expect(times).toHaveLength(2);
    for (const time of times) expect(Date.parse(time)).toBeGreaterThanOrEqual(before - 1000);
    const script = await app.inject({ url: '/admin/admin.js', headers: { cookie: valid } });
    expect(script.headers['content-type']).toContain('javascript');
  });

  it('keeps the creation time and advances the sync time on later writes', async () => {
    await start();
    const userId = await saveProfile('Bob');
    executeDatabase(
      directory,
      `UPDATE profiles SET created_at = '2020-01-01T00:00:00.000Z',
        updated_at = '2020-01-01T00:00:00.000Z' WHERE user_id = '${userId}'`,
    );
    const headers = { 'x-machbar-user': userId };
    const { document } = (
      await app.inject({ url: '/api/bootstrap', headers })
    ).json<SyncSnapshot>();
    await app.inject({
      method: 'PUT',
      url: '/api/sync',
      headers: { ...headers, origin, 'if-match': String(document.revision) },
      payload: document,
    });
    const body = (await app.inject({ url: '/admin', headers: { cookie: valid } })).body;
    // Rendered as last sync, then created.
    const times = [...profileList(body).matchAll(/<time datetime="([^"]+)"/g)].map((m) => m[1]!);
    expect(times[0]).not.toBe('2020-01-01T00:00:00.000Z');
    expect(times[1]).toBe('2020-01-01T00:00:00.000Z');
  });

  it('opens user creation temporarily while it is disabled', async () => {
    await start({ ...credentials, DISABLE_USER_CREATION: 'true' });
    const toggle = (minutes: string, cookie = valid) =>
      app.inject({
        method: 'POST',
        url: '/admin/user-creation',
        headers: { ...form, origin, cookie },
        payload: new URLSearchParams({ minutes }).toString(),
      });
    const bootstrap = () =>
      app.inject({ url: '/api/bootstrap', headers: { 'x-machbar-user': randomUUID() } });
    expect((await bootstrap()).statusCode).toBe(403);
    let page = (await app.inject({ url: '/admin', headers: { cookie: valid } })).body;
    expect(page).toContain('User creation disabled');
    expect(page).toContain('Open for 1 hour');

    expect((await toggle('60', 'machbar_admin=forged')).headers.location).toBe('/admin');
    expect((await bootstrap()).statusCode).toBe(403);
    expect((await toggle('7')).statusCode).toBe(400);

    const before = Date.now();
    expect((await toggle('60')).statusCode).toBe(303);
    expect((await bootstrap()).statusCode).toBe(200);
    page = (await app.inject({ url: '/admin', headers: { cookie: valid } })).body;
    expect(page).toContain('User creation temporarily open');
    expect(page).toContain('Close now');
    const until = Date.parse(/Until <time datetime="([^"]+)"/.exec(page)![1]!);
    expect(until).toBeGreaterThanOrEqual(before + 60 * 60 * 1000 - 1000);
    expect(until).toBeLessThanOrEqual(Date.now() + 60 * 60 * 1000);

    expect((await toggle('0')).statusCode).toBe(303);
    expect((await bootstrap()).statusCode).toBe(403);
  });

  it('shows the rate limits and the clients they currently block', async () => {
    await start({
      ...credentials,
      RATE_LIMIT_MAX_PER_USER: '2',
      RATE_LIMIT_MAX_ANONYMOUS: '2',
    });
    const page = async () => (await app.inject({ url: '/admin', headers: { cookie: valid } })).body;
    let body = await page();
    expect(body).toContain('No active bans');
    expect(body).toContain('Nobody is blocked right now.');
    expect(body).toContain('Counted in fixed windows of 60 seconds');

    // Bootstrap and the first sync use up the profile's allowance of two requests.
    const userId = await saveProfile('Erin <3');
    for (let attempt = 0; attempt < 3; attempt++) await app.inject({ url: '/api/bootstrap' });
    for (let attempt = 0; attempt < 10; attempt++) await login('wrong password!');
    body = await page();
    expect(body).toContain('3 active bans');
    expect(body).toMatch(
      /API requests per profile<\/span> Erin &lt;3 <code>[\w-]{8}<\/code> <span class="muted">2 \/ 2/,
    );
    expect(body).toContain(`<code>${userId.slice(0, 8)}</code>`);
    expect(body).toMatch(/Requests without a valid ID<\/span> <code>127\.0\.0\.1<\/code>/);
    expect(body).toMatch(
      /Admin sign-in<\/span> <code>127\.0\.0\.1<\/code> <span class="muted">10 failed attempts/,
    );
    expect(body).not.toContain('Nobody is blocked right now.');
  });

  it('remembers the chosen theme in a cookie', async () => {
    await start();
    const choose = (theme: string) =>
      app.inject({
        method: 'POST',
        url: '/admin/theme',
        headers: { ...form, origin },
        payload: new URLSearchParams({ theme }).toString(),
      });
    const dark = await choose('dark');
    expect(dark.statusCode).toBe(303);
    expect(dark.headers['set-cookie']).toContain('machbar_admin_theme=dark');
    expect((await choose('system')).headers['set-cookie']).toContain('Max-Age=0');
    const signedIn = await app.inject({
      url: '/admin',
      headers: { cookie: `${valid}; machbar_admin_theme=dark` },
    });
    expect(signedIn.body).toContain('<html lang="en" data-theme="dark">');
    expect(signedIn.body).toContain('value="dark" aria-pressed="true"');
    const login = await app.inject({ url: '/admin', headers: { cookie: 'machbar_admin_theme=x' } });
    expect(login.body).toContain('<html lang="en">');
    expect(login.body).not.toContain('action="/admin/theme"');
    const darkLogin = await app.inject({
      url: '/admin',
      headers: { cookie: 'machbar_admin_theme=dark' },
    });
    expect(darkLogin.body).toContain('<html lang="en" data-theme="dark">');
  });

  it('deletes a profile and its push subscriptions only from a same-origin form', async () => {
    await start();
    const userId = await saveProfile('Carol');
    const other = await saveProfile('Dave');
    const key = webpush.generateVAPIDKeys().publicKey;
    const auth = 'AAAAAAAAAAAAAAAAAAAAAA';
    executeDatabase(
      directory,
      `INSERT INTO push_state VALUES (1, 0);
      INSERT INTO push_bindings (id, position, user_id, endpoint, p256dh, auth, expiration_present)
        VALUES ('${randomUUID()}', 0, '${userId}', 'https://push.example.com/a', '${key}', '${auth}', 0),
        ('${randomUUID()}', 1, '${other}', 'https://push.example.com/b', '${key}', '${auth}', 0);`,
    );
    const url = `/admin/profiles/${userId}/delete`;
    expect(
      (await app.inject({ method: 'POST', url, headers: { ...form, cookie: valid } })).statusCode,
    ).toBe(403);
    const signedOut = await app.inject({
      method: 'POST',
      url,
      headers: { ...form, origin },
      payload: '',
    });
    expect(signedOut.statusCode).toBe(303);
    expect(signedOut.headers.location).toBe('/admin');
    expect(storedRecord(directory, 'profile', userId)).toBeDefined();

    const deleted = await app.inject({
      method: 'POST',
      url,
      headers: { ...form, origin, cookie: valid },
      payload: '',
    });
    expect(deleted.statusCode).toBe(303);
    expect(deleted.headers.location).toBe('/admin?deleted=1');
    expect(storedRecord(directory, 'profile', userId)).toBeUndefined();
    expect(storedRecord(directory, 'profile', other)).toBeDefined();
    const push = JSON.parse(storedRecord(directory, 'push')!);
    expect(push.bindings.map((b: { userId: string }) => b.userId)).toEqual([other]);

    const again = await app.inject({
      method: 'POST',
      url,
      headers: { ...form, origin, cookie: valid },
      payload: '',
    });
    expect(again.headers.location).toBe('/admin?deleted=0');
    const blocked = { 'x-machbar-user': userId };
    for (const response of [
      await app.inject({ url: '/api/bootstrap', headers: blocked }),
      await app.inject({
        method: 'PUT',
        url: '/api/sync',
        headers: { ...blocked, origin, 'if-match': '0' },
        payload: { userId, revision: 0 },
      }),
      await app.inject({
        method: 'POST',
        url: '/api/local-user',
        headers: { ...blocked, origin },
        payload: { userId },
      }),
    ]) {
      expect(response.statusCode).toBe(410);
      expect(response.json()).toEqual({ code: 'PROFILE_DELETED' });
    }
    const page = await app.inject({ url: '/admin?deleted=1', headers: { cookie: valid } });
    expect(page.body).toContain('<dd>1 <small>deleted ID blocked</small>');
    expect(page.body).toContain('Profile deleted.');
    expect(page.body).not.toContain('Carol');
  });
});

describe('deleted profile IDs', () => {
  it('cannot be saved again, even by a write that started before the deletion', async () => {
    await start();
    const userId = await saveProfile('Erin');
    const { budget, profiles } = (() => {
      const budget = new StorageBudget(directory, readConfig({}));
      return { budget, profiles: new SqliteStore(directory, budget) };
    })();
    try {
      const document = await profiles.readExisting(userId);
      expect(await profiles.remove(userId)).toBe(true);
      await expect(
        budget.commit('profile', userId, JSON.stringify({ ...document, revision: 0 })),
      ).rejects.toMatchObject({ code: 'PROFILE_DELETED', status: 410 });
      await expect(profiles.read(userId)).rejects.toMatchObject({ code: 'PROFILE_DELETED' });
      expect(await profiles.remove(userId)).toBe(false);
    } finally {
      await budget.close();
    }
  });
});

describe('admin configuration', () => {
  it('requires a valid password hash', () => {
    expect(readConfig({}).admin).toBeNull();
    expect(readConfig(credentials).admin).toMatchObject({
      passwordHash: { cost: 15, blockSize: 8, parallelization: 1 },
    });
    const [, , , , salt, key] = credentials.ADMIN_PASSWORD_HASH.split(':');
    for (const env of [
      { ...credentials, ADMIN_PASSWORD_HASH: password },
      { ...credentials, ADMIN_PASSWORD_HASH: `scrypt:30:8:1:${salt}:${key}` },
      { ...credentials, ADMIN_PASSWORD: password },
    ])
      expect(() => readConfig(env)).toThrow('ADMIN_');
  });

  it('hashes passwords with a random salt and verifies them', async () => {
    const hash = parseAdminPasswordHash(credentials.ADMIN_PASSWORD_HASH)!;
    expect(credentials.ADMIN_PASSWORD_HASH).toMatch(/^scrypt:15:8:1:[\w-]{22}:[\w-]{43}$/);
    expect(await hashAdminPassword(password)).not.toBe(credentials.ADMIN_PASSWORD_HASH);
    expect(await verifyAdminPassword(password, hash)).toBe(true);
    expect(await verifyAdminPassword(`${password}!`, hash)).toBe(false);
  });

  it('reads the minimum password length from the environment', () => {
    expect(readMinimumAdminPasswordLength({})).toBe(12);
    expect(readMinimumAdminPasswordLength({ ADMIN_PASSWORD_MIN_LENGTH: '' })).toBe(12);
    expect(readMinimumAdminPasswordLength({ ADMIN_PASSWORD_MIN_LENGTH: '20' })).toBe(20);
    for (const value of ['0', '-1', '1.5', 'twelve', '1025'])
      expect(() => readMinimumAdminPasswordLength({ ADMIN_PASSWORD_MIN_LENGTH: value })).toThrow(
        'ADMIN_PASSWORD_MIN_LENGTH',
      );
  });
});
