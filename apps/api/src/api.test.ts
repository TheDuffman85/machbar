import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { applyCompletion, createUser, mutateDocument, type SyncSnapshot } from '@machbar/shared';
import { buildServer } from './server.js';
import { JsonStore } from './store.js';
import { readConfig } from './config.js';
let directory: string;
let app: Awaited<ReturnType<typeof buildServer>>;
const origin = 'http://localhost:3000';
const userId = randomUUID();
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
async function snapshot(id = userId): Promise<SyncSnapshot> {
  return (await app.inject({ url: '/api/bootstrap', headers: { 'x-machbar-user': id } })).json();
}
async function sync(
  document: SyncSnapshot['document'],
  revision = document.revision,
  headers = {},
) {
  return app.inject({
    method: 'PUT',
    url: '/api/sync',
    headers: {
      origin,
      'if-match': String(revision),
      'x-machbar-user': document.userId,
      ...headers,
    },
    payload: document,
  });
}
describe('document synchronization API', () => {
  it('roundtrips interval schedules and period completions without stripping their metadata', async () => {
    const doc = (await snapshot()).document;
    const habitId = randomUUID();
    const now = new Date('2026-10-06T12:00:00Z');
    mutateDocument(
      doc,
      '/api/habits',
      'POST',
      {
        title: 'Weekly reading',
        weekdays: [0, 1, 2, 3, 4, 5, 6],
        recurrence: { unit: 'week', every: 2, anchor: '2026-10-06' },
      },
      habitId,
      now,
    );
    applyCompletion(
      doc,
      {
        operationId: randomUUID(),
        targetType: 'habit',
        targetId: habitId,
        date: '2026-10-06',
        timezone: doc.preferences.timezone,
        completed: true,
        expectedVersion: 0,
      },
      now,
    );
    expect((await sync(doc)).statusCode).toBe(200);
    const saved = (await snapshot()).document;
    expect(saved.habits).toEqual(doc.habits);
    expect(saved.completions).toEqual(doc.completions);
    expect(
      JSON.parse(await readFile(join(directory, `${userId}.json`), 'utf8')).completions,
    ).toEqual(doc.completions);
  });
  it('roundtrips icons on habits, goals, and steps and rejects unknown icons', async () => {
    const doc = (await snapshot()).document;
    const habitId = randomUUID();
    const goalId = randomUUID();
    const stepId = randomUUID();
    mutateDocument(
      doc,
      '/api/habits',
      'POST',
      { title: 'Read', weekdays: [1], icon: 'book' },
      habitId,
    );
    mutateDocument(doc, '/api/goals', 'POST', { title: 'Run', icon: 'footprints' }, goalId);
    mutateDocument(
      doc,
      `/api/goals/${goalId}/steps`,
      'POST',
      { title: 'Train', icon: 'dumbbell' },
      stepId,
    );
    expect((await sync(doc)).statusCode).toBe(200);
    const saved = (await snapshot()).document;
    expect(saved.habits[0]!.icon).toBe('book');
    expect(saved.goals[0]!.icon).toBe('footprints');
    expect(saved.goals[0]!.steps[0]!.icon).toBe('dumbbell');
    const invalid = structuredClone(saved);
    Object.assign(invalid.goals[0]!.steps[0]!, { icon: 'unsupported' });
    expect((await sync(invalid)).statusCode).toBe(400);
    expect((await snapshot()).document).toEqual(saved);
  });
  it('blocks all creation paths while allowing existing profiles to switch and sync', async () => {
    await sync((await snapshot()).document);
    await app.close();
    app = await buildServer({
      config: {
        ...readConfig({ APP_URL: origin, DISABLE_USER_CREATION: 'true' }),
        dataDir: directory,
        webDir: join(directory, 'no-web'),
      },
      // The API must enforce the flag even with a supplied store.
      store: new JsonStore(directory),
    });
    const missing = randomUUID();
    const denied = await app.inject({
      url: '/api/bootstrap',
      headers: { 'x-machbar-user': missing },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().code).toBe('USER_CREATION_DISABLED');
    const directWrite = await sync(createUser(missing));
    expect(directWrite.statusCode).toBe(403);
    expect(directWrite.json().code).toBe('USER_CREATION_DISABLED');
    const switchTo = (id: string) =>
      app.inject({
        method: 'POST',
        url: '/api/local-user',
        headers: { origin, 'x-machbar-user': id },
        payload: { userId: id },
      });
    expect((await switchTo(missing)).json().code).toBe('USER_NOT_FOUND');
    expect((await switchTo(userId)).statusCode).toBe(200);
    const existing = (await snapshot()).document;
    existing.preferences.name = 'Still editable';
    expect((await sync(existing)).statusCode).toBe(200);
    expect((await snapshot()).document.preferences.name).toBe('Still editable');
    expect(await readdir(directory)).toEqual([`${userId}.json`]);
  });
  it('bootstraps locally managed profiles without calculated progress or cookies', async () => {
    const response = await app.inject({
      url: '/api/bootstrap',
      headers: { 'x-machbar-user': userId },
    });
    expect(response.json()).toEqual({ document: createUser(userId), dailyHistoryDays: 3 });
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect((await app.inject('/health')).json()).toEqual({ status: 'ok' });
  });
  it('persists complete documents and keeps each user isolated', async () => {
    const alice = (await snapshot()).document;
    alice.preferences.name = 'Alice';
    alice.preferences.onboarded = true;
    expect((await sync(alice)).statusCode).toBe(200);
    const bobId = randomUUID();
    const bob = (await snapshot(bobId)).document;
    bob.preferences.name = 'Bob';
    bob.preferences.avatarOptions = { eyes: 'happy', clothing: 'hoodie' };
    expect((await sync(bob)).statusCode).toBe(200);
    expect((await snapshot()).document.preferences.name).toBe('Alice');
    expect(
      JSON.parse(await readFile(join(directory, `${bobId}.json`), 'utf8')).preferences
        .avatarOptions,
    ).toEqual(bob.preferences.avatarOptions);
    expect((await readdir(directory)).sort()).toEqual([`${userId}.json`, `${bobId}.json`].sort());
  });
  it('switches only to an existing saved profile', async () => {
    await sync((await snapshot()).document);
    const switchTo = (id: string) =>
      app.inject({
        method: 'POST',
        url: '/api/local-user',
        headers: { origin, 'x-machbar-user': id },
        payload: { userId: id },
      });
    expect((await switchTo(userId)).statusCode).toBe(200);
    const missing = randomUUID();
    expect((await switchTo(missing)).json().code).toBe('USER_NOT_FOUND');
    expect(await readdir(directory)).not.toContain(`${missing}.json`);
    for (const id of ['local', '../local', 'a'.repeat(64)]) {
      expect((await switchTo(id)).statusCode).toBe(400);
      expect(
        (await app.inject({ url: '/api/bootstrap', headers: { 'x-machbar-user': id } })).statusCode,
      ).toBe(400);
    }
    expect((await app.inject('/api/bootstrap')).json().code).toBe('INVALID_IDENTITY');
  });
  it('requires revisions, rejects stale or cross-account writes, and serializes races', async () => {
    const doc = (await snapshot()).document;
    const missing = await app.inject({
      method: 'PUT',
      url: '/api/sync',
      headers: { origin, 'x-machbar-user': userId },
      payload: doc,
    });
    expect(missing.json().code).toBe('REVISION_REQUIRED');
    const results = await Promise.all([
      sync(doc),
      sync({ ...doc, preferences: { ...doc.preferences, name: 'Other' } }),
    ]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    expect((await snapshot()).document.revision).toBe(1);
    expect((await sync(doc)).json().code).toBe('DOCUMENT_CONFLICT');
    expect((await sync(doc, 1)).json().code).toBe('DOCUMENT_CONFLICT');
    expect((await sync(doc, 0, { 'x-machbar-user': randomUUID() })).json().code).toBe(
      'ACCOUNT_CHANGED',
    );
  });
  it('validates documents and avatars without modifying saved data', async () => {
    const doc = (await snapshot()).document;
    await sync(doc);
    const invalid = [
      { ...doc, revision: 1, xp: 1000 },
      { ...doc, revision: 1, schemaVersion: 2 },
      {
        ...doc,
        revision: 1,
        preferences: { ...doc.preferences, avatarOptions: { eyes: 'unsupported' } },
      },
      { ...doc, revision: 1, preferences: { ...doc.preferences, timezone: 'invalid-zone' } },
    ];
    for (const payload of invalid) {
      const response = await app.inject({
        method: 'PUT',
        url: '/api/sync',
        headers: { origin, 'x-machbar-user': userId, 'if-match': '1' },
        payload,
      });
      expect(response.statusCode).toBe(400);
    }
    expect((await snapshot()).document.revision).toBe(1);
  });
  it('rejects duplicate entity IDs and invalid completion or gift references', async () => {
    const doc = (await snapshot()).document;
    const entityId = randomUUID();
    const goal = {
      id: entityId,
      title: 'Goal',
      description: '',
      color: 'sage' as const,
      steps: [],
      archivedAt: null,
    };
    const duplicate = { ...doc, goals: [goal, goal] };
    expect((await sync(duplicate)).statusCode).toBe(400);
    const orphanGift = {
      ...doc,
      gifts: [
        {
          id: randomUUID(),
          title: 'Gift',
          targetType: 'goal' as const,
          targetId: entityId,
          threshold: 1,
          claimedAt: null,
          archivedAt: null,
        },
      ],
    };
    expect((await sync(orphanGift)).statusCode).toBe(400);
    const orphanCompletion = {
      ...doc,
      completions: {
        wrong: {
          key: 'wrong',
          targetType: 'step' as const,
          targetId: entityId,
          date: '2026-10-05',
          timezone: 'UTC',
          completed: true,
          version: 1,
          updatedAt: '2026-10-05T12:00:00Z',
        },
      },
    };
    expect((await sync(orphanCompletion)).statusCode).toBe(400);
    expect((await snapshot()).document.revision).toBe(0);
  });
  it('accepts complete documents larger than the old 64 KiB mutation limit', async () => {
    const doc = (await snapshot()).document;
    doc.goals = Array.from({ length: 200 }, () => ({
      id: randomUUID(),
      title: 'Goal',
      description: 'x'.repeat(500),
      color: 'sage' as const,
      steps: [],
      archivedAt: null,
    }));
    expect((await sync(doc)).statusCode).toBe(200);
    expect((await snapshot()).document.goals).toHaveLength(200);
  });
  it('accepts same-origin LAN writes while rejecting foreign or missing origins', async () => {
    for (const host of ['192.168.2.100:3000', 'machbar.example:5173']) {
      const doc = (await snapshot()).document;
      expect((await sync(doc, doc.revision, { host, origin: `http://${host}` })).statusCode).toBe(
        200,
      );
      for (const rejected of [
        { host, origin: 'http://other.example' },
        { host, origin: `http://${host}`, 'sec-fetch-site': 'cross-site' },
      ]) {
        expect((await sync(doc, doc.revision, rejected)).json().code).toBe('ORIGIN_REJECTED');
      }
      expect(
        (
          await app.inject({
            method: 'PUT',
            url: '/api/sync',
            headers: { host, 'x-machbar-user': userId, 'if-match': String(doc.revision) },
            payload: doc,
          })
        ).json().code,
      ).toBe('ORIGIN_REJECTED');
    }
  });
  it('preserves corrupt files instead of replacing them', async () => {
    await writeFile(join(directory, `${userId}.json`), '{broken');
    expect(
      (await app.inject({ url: '/api/bootstrap', headers: { 'x-machbar-user': userId } })).json()
        .code,
    ).toBe('DATA_CORRUPT');
    expect((await sync(createUser(userId))).json().code).toBe('DATA_CORRUPT');
    expect(await readFile(join(directory, `${userId}.json`), 'utf8')).toBe('{broken');
  });
  it('exposes the configured history limit in bootstrap and sync', async () => {
    await app.close();
    app = await buildServer({
      config: {
        ...readConfig({ APP_URL: origin, DAILY_HISTORY_DAYS: '7' }),
        dataDir: directory,
        webDir: join(directory, 'no-web'),
      },
    });
    expect((await snapshot()).dailyHistoryDays).toBe(7);
    expect((await sync((await snapshot()).document)).json().dailyHistoryDays).toBe(7);
  });
  it('removes feature mutation and login endpoints even when serving the UI', async () => {
    await app.close();
    const webDir = join(directory, 'web');
    await mkdir(webDir);
    await writeFile(join(webDir, 'index.html'), '<html><body>Machbar</body></html>');
    app = await buildServer({
      config: { ...readConfig({ APP_URL: origin }), dataDir: directory, webDir },
    });
    for (const url of [
      '/api/habits',
      '/api/goals',
      '/api/completions',
      '/api/gifts',
      '/auth/login',
    ]) {
      expect(
        (
          await app.inject({
            method: 'POST',
            url,
            headers: { origin, 'x-machbar-user': userId },
            payload: {},
          })
        ).statusCode,
      ).toBe(404);
    }
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: '/api/preferences',
          headers: { origin, 'x-machbar-user': userId },
          payload: {},
        })
      ).statusCode,
    ).toBe(404);
  });
});
describe('atomic storage', () => {
  it('serializes concurrent writes and separates user files', async () => {
    const store = new JsonStore(directory);
    const a = randomUUID(),
      b = randomUUID();
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
    await store.update(userId, (doc) => {
      doc.preferences.name = 'Saved';
    });
    await writeFile(join(directory, `${userId}.json.interrupted.tmp`), '{partial');
    expect((await store.read(userId)).preferences.name).toBe('Saved');
  });
  it('leaves saved state intact when a mutation fails', async () => {
    const store = new JsonStore(directory);
    await store.update(userId, (doc) => {
      doc.preferences.name = 'Saved';
    });
    await expect(
      store.update(userId, (doc) => {
        doc.preferences.name = 'Changed';
        throw new Error('failed');
      }),
    ).rejects.toThrow('failed');
    expect((await store.read(userId)).preferences.name).toBe('Saved');
  });
});
