import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { localDate, type Bootstrap } from '@machbar/shared';
import { buildServer } from './server.js';
import { JsonStore, identityKey } from './store.js';
import { readConfig } from './config.js';
let directory: string;
let app: Awaited<ReturnType<typeof buildServer>>;
const origin = 'http://localhost:3000';
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'machbar-api-'));
  app = await buildServer({
    config: {
      ...readConfig({ APP_URL: origin }),
      dataDir: directory,
      webDir: join(directory, 'no-web'),
    },
  });
});
afterEach(async () => {
  await app.close();
  await rm(directory, { recursive: true, force: true });
});
async function snapshot(): Promise<Bootstrap> {
  return (await app.inject({ method: 'GET', url: '/api/bootstrap' })).json();
}
async function change(
  url: string,
  method: 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  payload?: object,
  revision?: number,
) {
  const current = revision ?? (await snapshot()).document.revision;
  return app.inject({
    method,
    url,
    headers: { origin, 'if-match': String(current), 'x-machbar-user': 'local' },
    payload,
  });
}
async function habit() {
  const response = await change('/api/habits', 'POST', {
    title: 'Walk',
    weekdays: [0, 1, 2, 3, 4, 5, 6],
  });
  expect(response.statusCode).toBe(200);
  return (response.json() as Bootstrap).document.habits[0]!;
}
describe('API', () => {
  it('bootstraps one shared profile without login', async () => {
    const result = await snapshot();
    expect(result.document.userId).toBe('local');
    expect(result.authMode).toBe('single');
    expect((await app.inject('/health')).json()).toEqual({ status: 'ok' });
  });
  it('validates inputs, rejects extra fields and origin mismatches', async () => {
    expect((await change('/api/habits', 'POST', { title: '', weekdays: [] })).statusCode).toBe(400);
    expect(
      (await change('/api/habits', 'POST', { title: 'Walk', weekdays: [1], xp: 100 })).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/habits',
          headers: { origin: 'https://other.example' },
          payload: {},
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/habits',
          headers: { origin },
          payload: { title: 'Walk', weekdays: [1] },
        })
      ).json().code,
    ).toBe('ACCOUNT_CHANGED');
  });
  it('requires revisions and rejects stale edits', async () => {
    await habit();
    const response = await change('/api/habits', 'POST', { title: 'Read', weekdays: [1] }, 0);
    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe('DOCUMENT_CONFLICT');
  });
  it('accepts same-origin LAN and proxied writes and rejects foreign or missing origins', async () => {
    for (const host of ['192.168.2.100:3000', 'machbar.example:5173']) {
      const headers = {
        host,
        origin: `http://${host}`,
        'x-machbar-user': 'local',
        'if-match': String((await snapshot()).document.revision),
      };
      const response = await app.inject({
        method: 'POST',
        url: '/api/habits',
        headers,
        payload: { title: 'LAN habit', weekdays: [1] },
      });
      expect(response.statusCode).toBe(200);
      for (const rejected of [
        { ...headers, origin: 'http://other.example' },
        { ...headers, origin: `http://${host}.other.example` },
        { host, 'x-machbar-user': 'local', 'if-match': headers['if-match'] },
        { ...headers, 'sec-fetch-site': 'cross-site' },
      ]) {
        const result = await app.inject({
          method: 'POST',
          url: '/api/habits',
          headers: rejected,
          payload: {},
        });
        expect(result.statusCode).toBe(403);
        expect(result.json().code).toBe('ORIGIN_REJECTED');
      }
    }
  });
  it('records and retries completions with no duplicate XP', async () => {
    const h = await habit();
    const op = {
      operationId: randomUUID(),
      targetType: 'habit',
      targetId: h.id,
      date: localDate('Europe/Berlin'),
      timezone: 'Europe/Berlin',
      completed: true,
      expectedVersion: 0,
    };
    const results = await Promise.all([
      change('/api/completions', 'POST', op),
      change('/api/completions', 'POST', op),
      change('/api/completions', 'POST', { ...op, operationId: randomUUID() }),
    ]);
    expect(results.every((r) => r.statusCode === 200)).toBe(true);
    expect((await snapshot()).progress.xp).toBe(10);
    expect(
      (
        await change('/api/completions', 'POST', {
          ...op,
          operationId: randomUUID(),
          completed: false,
        })
      ).json().code,
    ).toBe('COMPLETION_CONFLICT');
    expect(
      (
        await change('/api/completions', 'POST', {
          ...op,
          operationId: randomUUID(),
          completed: false,
          expectedVersion: 1,
        })
      ).statusCode,
    ).toBe(200);
    expect((await snapshot()).progress.xp).toBe(0);
  });
  it('edits schedule from tomorrow while preserving original schedule', async () => {
    const h = await habit();
    const response = await change(`/api/habits/${h.id}`, 'PATCH', {
      title: 'New walk',
      weekdays: [0],
    });
    const schedules = response.json().document.habits[0].schedules;
    expect(schedules).toHaveLength(2);
    expect(schedules[0].weekdays).toHaveLength(7);
    expect(schedules[1].from > schedules[0].from).toBe(true);
  });
  it('creates, orders, edits and archives goal steps', async () => {
    const g = (await change('/api/goals', 'POST', { title: 'A cozy home' })).json().document
      .goals[0];
    await change(`/api/goals/${g.id}/steps`, 'POST', { title: 'Bookshelf' });
    await change(`/api/goals/${g.id}/steps`, 'POST', { title: 'Plants', date: '2026-10-07' });
    const steps = (await snapshot()).document.goals[0]!.steps;
    expect(
      (await change(`/api/goals/${g.id}/order`, 'PUT', steps.map((s) => s.id).reverse()))
        .statusCode,
    ).toBe(200);
    expect((await snapshot()).document.goals[0]!.steps[0]!.title).toBe('Plants');
    expect(
      (await change(`/api/goals/${g.id}/order`, 'PUT', [steps[0]!.id, steps[0]!.id])).statusCode,
    ).toBe(400);
    await change(`/api/steps/${steps[0]!.id}`, 'PATCH', { title: 'One shelf', date: null });
    await change(`/api/steps/${steps[0]!.id}`, 'DELETE');
    expect(
      (await snapshot()).document.goals[0]!.steps.find((s) => s.id === steps[0]!.id)!.archivedAt,
    ).not.toBeNull();
  });
  it('unlocks gifts server-side and preserves claims after undo', async () => {
    const h = await habit();
    const gift = (
      await change('/api/gifts', 'POST', {
        title: 'Shoes',
        targetType: 'habitCount',
        targetId: h.id,
        threshold: 1,
      })
    ).json().document.gifts[0];
    expect((await change(`/api/gifts/${gift.id}/claim`, 'POST', {})).json().code).toBe(
      'GIFT_LOCKED',
    );
    const op = {
      operationId: randomUUID(),
      targetType: 'habit',
      targetId: h.id,
      date: localDate('Europe/Berlin'),
      timezone: 'Europe/Berlin',
      completed: true,
      expectedVersion: 0,
    };
    await change('/api/completions', 'POST', op);
    expect((await change(`/api/gifts/${gift.id}/claim`, 'POST', {})).statusCode).toBe(200);
    await change('/api/completions', 'POST', {
      ...op,
      operationId: randomUUID(),
      completed: false,
      expectedVersion: 1,
    });
    expect((await snapshot()).progress.gifts[gift.id]!.state).toBe('claimed');
  });
  it('does not overwrite corrupt JSON and uses stable error codes', async () => {
    await habit();
    await writeFile(join(directory, 'local.json'), '{broken');
    const response = await app.inject('/api/bootstrap');
    expect(response.statusCode).toBe(500);
    expect(response.json().code).toBe('DATA_CORRUPT');
    expect(await readFile(join(directory, 'local.json'), 'utf8')).toBe('{broken');
  });
  it('keeps API responses out of browser caches', async () => {
    const response = await app.inject('/api/bootstrap');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
  });
});
describe('atomic storage', () => {
  it('serializes concurrent writes and separates user files', async () => {
    const store = new JsonStore(directory);
    const a = identityKey('https://issuer.example', 'a'),
      b = identityKey('https://issuer.example', 'b');
    await Promise.all(
      Array.from({ length: 15 }, () =>
        store.update(a, (doc) => {
          doc.preferences.name += '.';
        }),
      ),
    );
    await store.update(b, (doc) => {
      doc.preferences.name = 'Another user';
    });
    expect((await store.read(a)).revision).toBe(15);
    expect((await store.read(b)).preferences.name).toBe('Another user');
    expect((await readdir(directory)).filter((f) => f.endsWith('.tmp'))).toHaveLength(0);
  });
  it('ignores interrupted temporary writes and retains the last complete file', async () => {
    const store = new JsonStore(directory);
    await store.update('local', (doc) => {
      doc.preferences.name = 'Saved';
    });
    await writeFile(join(directory, 'local.json.interrupted.tmp'), '{partial');
    expect((await store.read('local')).preferences.name).toBe('Saved');
  });
  it('leaves saved state intact when a mutation fails', async () => {
    const store = new JsonStore(directory);
    await store.update('local', (doc) => {
      doc.preferences.name = 'Saved';
    });
    await expect(
      store.update('local', (doc) => {
        doc.preferences.name = 'Changed';
        throw new Error('failed');
      }),
    ).rejects.toThrow('failed');
    expect((await store.read('local')).preferences.name).toBe('Saved');
  });
});
