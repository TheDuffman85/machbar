import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest, type ClientRequest } from 'node:http';
import type { Socket } from 'node:net';
import { join } from 'node:path';
import { createUser, documentLimits, type UserDocument } from '@machbar/shared';
import { buildServer } from './server.js';
import { readConfig, type Config } from './config.js';
import { SqliteStore } from './store.js';
import { StorageBudget } from './storage-budget.js';
import { storedRecord } from '../test-support/database.js';
import { PushStore } from './notifications.js';

let directory: string;
let config: Config;
let app: Awaited<ReturnType<typeof buildServer>>;
beforeEach(async () => {
  directory = await mkdtemp('/tmp/machbar-resource-security-');
  config = {
    ...readConfig({ DISABLE_USER_CREATION: 'false' }),
    dataDir: directory,
    webDir: join(directory, 'absent'),
  };
  app = await buildServer({ config });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await app.close();
  await rm(directory, { recursive: true, force: true });
});
async function restart(overrides: Partial<Config>) {
  await app.close();
  config = { ...config, ...overrides };
  app = await buildServer({ config });
}
function sync(doc = createUser(randomUUID()), revision: string | undefined = String(doc.revision)) {
  return app.inject({
    method: 'PUT',
    url: '/api/sync',
    headers: {
      origin: config.appUrl,
      'x-machbar-user': doc.userId,
      ...(revision === undefined ? {} : { 'if-match': revision }),
    },
    payload: doc,
  });
}
function schedules(count: number) {
  const doc = createUser(randomUUID());
  doc.habits.push({
    id: randomUUID(),
    title: 'Read',
    description: '',
    color: 'sage',
    archivedAt: null,
    schedules: Array.from({ length: count }, () => ({
      from: '2026-01-01',
      weekdays: [1],
      timezone: 'Europe/Berlin',
    })),
  });
  return doc;
}

describe('document and request resource limits', () => {
  it('rejects excessive schedules before detailed calendar validation', async () => {
    const formatter = vi.spyOn(Intl, 'DateTimeFormat');
    const response = await sync(schedules(8000));
    expect(response.statusCode).toBe(413);
    expect(response.json().code).toBe('DOCUMENT_LIMIT');
    expect(formatter).not.toHaveBeenCalled();
    expect(await readdir(directory)).toEqual(['data.db']);
  });
  it('checks missing/unsafe revisions before parsing the request body', async () => {
    for (const value of [undefined, '9007199254740992']) {
      const response = await app.inject({
        method: 'PUT',
        url: '/%61pi/sync',
        headers: {
          origin: config.appUrl,
          'x-machbar-user': randomUUID(),
          'content-type': 'application/json',
          ...(value === undefined ? {} : { 'if-match': value }),
        },
        payload: '{broken',
      });
      expect(response.statusCode).toBe(428);
    }
  });
  it('rejects unknown profiles in closed mode before parsing JSON', async () => {
    await restart({ disableUserCreation: true });
    const response = await app.inject({
      method: 'PUT',
      url: '/api/sync',
      headers: {
        origin: config.appUrl,
        'x-machbar-user': randomUUID(),
        'if-match': '0',
        'content-type': 'application/json',
      },
      payload: '{broken',
    });
    expect(response.json().code).toBe('USER_CREATION_DISABLED');
  });
  it('keeps existing oversized documents readable and permits reducing them', async () => {
    const legacy = schedules(8000);
    await app.close();
    await rm(join(directory, 'data.db'));
    await writeFile(join(directory, `${legacy.userId}.json`), JSON.stringify(legacy));
    app = await buildServer({ config });
    const loaded = await app.inject({
      url: '/api/bootstrap',
      headers: { 'x-machbar-user': legacy.userId },
    });
    expect(loaded.statusCode).toBe(200);
    expect(loaded.json().document.habits[0].schedules).toHaveLength(8000);
    legacy.habits[0]!.schedules = legacy.habits[0]!.schedules.slice(0, 1);
    expect((await sync(legacy)).statusCode).toBe(200);
  });
  it('bounds fingerprints and timestamps while accepting real operation receipts', async () => {
    for (const fingerprint of [
      'x'.repeat(documentLimits.fingerprintLength + 1),
      'x'.repeat(1024 * 1024),
    ]) {
      const doc = createUser(randomUUID());
      doc.operations[randomUUID()] = { fingerprint, version: 1 };
      expect((await sync(doc)).statusCode).toBe(413);
    }
    const doc = schedules(1);
    doc.habits[0]!.archivedAt = 'x'.repeat(41);
    expect((await sync(doc)).statusCode).toBe(413);
    doc.habits[0]!.archivedAt = null;
    doc.operations[randomUUID()] = {
      fingerprint: JSON.stringify({ targetId: doc.habits[0]!.id, completed: true }),
      version: 1,
    };
    expect((await sync(doc)).statusCode).toBe(200);
  });
  it('sets finite socket/body deadlines and a connection cap', async () => {
    expect(app.server.requestTimeout).toBe(30_000);
    expect(app.server.timeout).toBe(15_000);
    expect(app.server.keepAliveTimeout).toBe(5_000);
    expect(app.server.maxConnections).toBe(128);
  });
  it('rejects non-API body methods before parsing, with and without static assets', async () => {
    for (const serveWeb of [false, true]) {
      if (serveWeb) {
        await mkdir(config.webDir);
        await writeFile(join(config.webDir, 'index.html'), '<html>Machbar</html>');
      }
      await restart({ rateLimitMaxPerIp: 1, rateLimitMaxAnonymous: 1 });
      const beforeParsing = vi.fn();
      app.addHook('preParsing', async (_request, _reply, payload) => {
        beforeParsing();
        return payload;
      });
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const) {
        for (const url of ['/health', '/', '/index.html', '/missing', '/%68ealth']) {
          const response = await app.inject({
            method,
            url,
            headers: { origin: config.appUrl, 'content-type': 'application/json' },
            // A malformed body exceeding the global limit must still be rejected
            // by the method guard, even with a valid Origin and no identity.
            payload: '{' + 'x'.repeat(documentLimits.maxBytes + 1),
          });
          expect(response.statusCode).toBe(404);
          expect(response.json()).toEqual({ code: 'NOT_FOUND' });
        }
      }
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/health',
            headers: { 'content-type': 'application/json' },
            payload: '{broken',
          })
        ).statusCode,
      ).toBe(404);
      expect(beforeParsing).not.toHaveBeenCalled();
      expect((await app.inject('/api/bootstrap')).statusCode).toBe(401);
      expect((await app.inject('/api/bootstrap')).statusCode).toBe(429);
      expect((await app.inject('/health')).statusCode).toBe(200);
      expect((await app.inject({ method: 'HEAD', url: '/health' })).statusCode).toBe(200);
      if (serveWeb) expect((await app.inject('/')).statusCode).toBe(200);
    }
  });
  it('waits for disconnected backend work before closing SQLite on shutdown', async () => {
    await app.close();
    const store = new SqliteStore(directory);
    app = await buildServer({ config, store });
    const id = randomUUID();
    let release!: () => void;
    let started!: () => void;
    let closingStarted!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const closingHook = new Promise<void>((resolve) => {
      closingStarted = resolve;
    });
    app.get('/api/shutdown-test', async () => {
      started();
      await gate;
      await store.update(id, (doc) => {
        doc.preferences.name = 'Finished during shutdown';
      });
      return { ok: true };
    });
    app.addHook('onClose', async () => {
      closingStarted();
    });
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const client = httpRequest(`${address}/api/shutdown-test`, {
      headers: { 'x-machbar-user': id },
    });
    client.on('error', () => {});
    const disconnected = new Promise<void>((resolve) => client.once('close', resolve));
    let closing: Promise<void> | undefined;
    try {
      client.end();
      await entered;
      client.destroy();
      await disconnected;
      let closed = false;
      closing = app.close().then(() => {
        closed = true;
      });
      await closingHook;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(closed).toBe(false);
      release();
      await closing;
      expect(JSON.parse(storedRecord(directory, 'profile', id)!).preferences.name).toBe(
        'Finished during shutdown',
      );
    } finally {
      release();
      client.destroy();
      await closing;
    }
  });

  it.each([
    { phase: 'handler', termination: 'disconnect', succeeds: true },
    { phase: 'handler', termination: 'disconnect', succeeds: false },
    { phase: 'handler', termination: 'timeout', succeeds: true },
    { phase: 'handler', termination: 'timeout', succeeds: false },
    { phase: 'admission', termination: 'disconnect', succeeds: true },
    { phase: 'admission', termination: 'timeout', succeeds: true },
  ])(
    'retains slots through $termination until $phase work settles (success=$succeeds)',
    async ({ phase, termination, succeeds }) => {
      await app.close();
      const store = new SqliteStore(directory);
      const readExisting = store.readExisting.bind(store);
      let releaseIo!: () => void;
      const io = new Promise<void>((resolve) => {
        releaseIo = resolve;
      });
      let finishedWork = 0;
      const read = vi.spyOn(store, 'readExisting').mockImplementation(async (userId) => {
        await io;
        try {
          return succeeds ? createUser(userId) : await readExisting(userId);
        } finally {
          finishedWork++;
        }
      });
      const work =
        phase === 'handler'
          ? read
          : vi.spyOn(store, 'exists').mockImplementation(async () => {
              await io;
              finishedWork++;
              return true;
            });
      const update = vi.spyOn(store, 'update');
      app = await buildServer({ config, store });
      let closed = 0,
        aborted = 0;
      const sockets: Socket[] = [];
      app.server.on('request', (request, response) => {
        if (['POST', 'PUT'].includes(request.method!)) {
          sockets.push(request.socket);
          response.once('close', () => closed++);
        }
      });
      app.addHook('onRequestAbort', async (_request) => {
        aborted++;
      });
      const releases: Array<() => void> = [];
      app.get(
        '/api/slow',
        () => new Promise<{ ok: true }>((resolve) => releases.push(() => resolve({ ok: true }))),
      );
      const clients: ClientRequest[] = [];
      let pending: Array<Promise<unknown>> = [];
      try {
        const address = await app.listen({ host: '127.0.0.1', port: 0 });
        const disconnected = Array.from({ length: 16 }, () => {
          const userId = randomUUID();
          const request = httpRequest(
            `${address}/api/${phase === 'handler' ? 'local-user' : 'sync'}`,
            {
              method: phase === 'handler' ? 'POST' : 'PUT',
              headers: {
                origin: config.appUrl,
                'x-machbar-user': userId,
                'content-type': 'application/json',
                'if-match': '0',
              },
            },
          );
          clients.push(request);
          request.on('error', () => {});
          const close = new Promise<void>((resolve) => request.once('close', resolve));
          request.end(JSON.stringify(phase === 'handler' ? { userId } : createUser(userId)));
          return close;
        });
        // Delay filesystem completion to terminate clients during backend work,
        // either in the handler or the earlier sync admission hook.
        await vi.waitFor(() => expect(work).toHaveBeenCalledTimes(16));
        expect(
          (await app.inject({ url: '/api/bootstrap', headers: { 'x-machbar-user': randomUUID() } }))
            .statusCode,
        ).toBe(503);
        if (termination === 'disconnect') clients.forEach((request) => request.destroy());
        else sockets.forEach((socket) => socket.setTimeout(25));
        await Promise.all(disconnected);
        await vi.waitFor(() => expect(closed).toBe(16));
        expect(aborted).toBe(phase === 'handler' ? 0 : 16);
        for (let attempt = 0; attempt < 16; attempt++) {
          expect(
            (
              await app.inject({
                url: '/api/bootstrap',
                headers: { 'x-machbar-user': randomUUID() },
              })
            ).statusCode,
          ).toBe(503);
        }
        expect(work).toHaveBeenCalledTimes(16);
        expect(finishedWork).toBe(0);
        releaseIo();
        await vi.waitFor(() => expect(finishedWork).toBe(16));
        expect(update).not.toHaveBeenCalled();
        expect(read).toHaveBeenCalledTimes(phase === 'handler' ? 16 : 0);
        expect(
          (await app.inject({ url: '/api/bootstrap', headers: { 'x-machbar-user': randomUUID() } }))
            .statusCode,
        ).toBe(200);
        // Normal response completion plus response closure must consume/release
        // each slot once; a second full batch must still enforce the limit of 16.
        pending = Array.from({ length: 16 }, () =>
          app.inject({ url: '/api/slow', headers: { 'x-machbar-user': randomUUID() } }),
        );
        await vi.waitFor(() => expect(releases).toHaveLength(16));
        expect(
          (await app.inject({ url: '/api/bootstrap', headers: { 'x-machbar-user': randomUUID() } }))
            .statusCode,
        ).toBe(503);
      } finally {
        releaseIo();
        clients.forEach((request) => request.destroy());
        releases.forEach((resolve) => resolve());
        await Promise.all(pending);
      }
      expect(
        (await app.inject({ url: '/api/bootstrap', headers: { 'x-machbar-user': randomUUID() } }))
          .statusCode,
      ).toBe(200);
    },
  );
  it('reclaims slots when clients abort incomplete bodies before backend work starts', async () => {
    let parsing = 0,
      aborted = 0;
    app.addHook('preParsing', async (_request, _reply, payload) => {
      parsing++;
      return payload;
    });
    app.addHook('onRequestAbort', async (_request) => {
      aborted++;
    });
    const clients: ClientRequest[] = [];
    try {
      const address = await app.listen({ host: '127.0.0.1', port: 0 });
      const disconnected = Array.from({ length: 16 }, () => {
        const request = httpRequest(`${address}/api/local-user`, {
          method: 'POST',
          headers: {
            origin: config.appUrl,
            'x-machbar-user': randomUUID(),
            'content-type': 'application/json',
          },
        });
        clients.push(request);
        request.on('error', () => {});
        const close = new Promise<void>((resolve) => request.once('close', resolve));
        request.write('{');
        return close;
      });
      await vi.waitFor(() => expect(parsing).toBe(16));
      expect(
        (await app.inject({ url: '/api/bootstrap', headers: { 'x-machbar-user': randomUUID() } }))
          .statusCode,
      ).toBe(503);
      clients.forEach((request) => request.destroy());
      await Promise.all(disconnected);
      await vi.waitFor(() => expect(aborted).toBe(16));
      expect(
        (await app.inject({ url: '/api/bootstrap', headers: { 'x-machbar-user': randomUUID() } }))
          .statusCode,
      ).toBe(200);
    } finally {
      clients.forEach((request) => request.destroy());
    }
  });
  it('caps simultaneous API work and releases slots after responses', async () => {
    const releases: Array<() => void> = [];
    app.get(
      '/api/slow',
      () => new Promise<{ ok: true }>((resolve) => releases.push(() => resolve({ ok: true }))),
    );
    const pending = Array.from({ length: 16 }, () =>
      app.inject({ url: '/api/slow', headers: { 'x-machbar-user': randomUUID() } }),
    );
    await vi.waitFor(() => expect(releases).toHaveLength(16));
    expect(
      (await app.inject({ url: '/api/bootstrap', headers: { 'x-machbar-user': randomUUID() } }))
        .statusCode,
    ).toBe(503);
    expect((await app.inject('/health')).statusCode).toBe(200);
    releases.forEach((resolve) => resolve());
    await Promise.all(pending);
    expect(
      (await app.inject({ url: '/api/bootstrap', headers: { 'x-machbar-user': randomUUID() } }))
        .statusCode,
    ).toBe(200);
  });
});

describe('persistent storage and creation limits', () => {
  it('limits new profile admissions across IDs/IPs and keeps saved profiles editable', async () => {
    await restart({ rateLimitMaxNewUsers: 1 });
    const doc = createUser(randomUUID());
    const created = await sync(doc);
    expect(created.statusCode).toBe(200);
    const rejected = await sync();
    expect(rejected.statusCode).toBe(429);
    expect(rejected.headers['retry-after']).toBeDefined();
    const saved: UserDocument = created.json().document;
    saved.preferences.name = 'Still editable';
    expect((await sync(saved)).statusCode).toBe(200);
    const otherIp = await app.inject({
      method: 'PUT',
      url: '/api/sync',
      remoteAddress: '192.0.2.4',
      headers: { origin: config.appUrl, 'x-machbar-user': randomUUID(), 'if-match': '0' },
      payload: {},
    });
    expect(otherIp.statusCode).toBe(429);
  });
  it('enforces profile count atomically and after restart without blocking existing saves', async () => {
    await restart({ maxProfiles: 1 });
    const responses = await Promise.all([sync(), sync()]);
    expect(responses.map((r) => r.statusCode).sort()).toEqual([200, 507]);
    expect(await readdir(directory)).toHaveLength(1);
    const saved: UserDocument = responses.find((r) => r.statusCode === 200)!.json().document;
    await restart({ maxProfiles: 1 });
    expect((await sync()).json().code).toBe('PROFILE_LIMIT');
    expect((await sync(saved)).statusCode).toBe(200);
  });
  it('serializes aggregate storage checks and preserves data on rejected writes', async () => {
    const first = createUser(randomUUID()),
      second = createUser(randomUUID());
    await restart({ maxStorageBytes: 600 });
    const responses = await Promise.all([sync(first), sync(second)]);
    expect(responses.map((r) => r.statusCode).sort()).toEqual([200, 507]);
    const saved: UserDocument = responses.find((r) => r.statusCode === 200)!.json().document;
    const original = storedRecord(directory, 'profile', saved.userId);
    saved.operations[randomUUID()] = { fingerprint: 'x'.repeat(500), version: 1 };
    expect((await sync(saved)).json().code).toBe('STORAGE_LIMIT');
    expect(storedRecord(directory, 'profile', saved.userId)).toBe(original);
    await restart({ maxStorageBytes: 600 });
    expect((await sync()).statusCode).toBe(507);
    delete saved.operations[Object.keys(saved.operations)[0]!];
    expect((await sync(saved)).statusCode).toBe(200);
  });
  it('reserves free space without persisting rejected profiles', async () => {
    await restart({ storageReserveBytes: Number.MAX_SAFE_INTEGER });
    expect((await sync()).json().code).toBe('STORAGE_LIMIT');
    expect(await readdir(directory)).toEqual(['data.db']);
  });
  it('shares the aggregate quota between push state and profile commits', async () => {
    const id = randomUUID();
    const expected = createUser(id);
    expected.revision = 1;
    expected.preferences.name = 'x'.repeat(60);
    const budget = new StorageBudget(directory, {
      ...config,
      maxStorageBytes: Buffer.byteLength(JSON.stringify(expected)),
    });
    const profiles = new SqliteStore(directory, budget),
      push = new PushStore(directory, budget);
    await push.access(() => undefined, true);
    await expect(
      profiles.update(id, (doc) => {
        doc.preferences.name = 'x'.repeat(60);
      }),
    ).rejects.toMatchObject({ code: 'STORAGE_LIMIT' });
    expect(storedRecord(directory, 'profile', id)).toBeUndefined();
    expect(storedRecord(directory, 'push')).toBeDefined();
    await budget.close();
  });
});
