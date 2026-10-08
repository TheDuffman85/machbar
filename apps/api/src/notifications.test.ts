import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import webpush from 'web-push';
import { createUser, mutateDocument, operationKey } from '@machbar/shared';
import { readConfig } from './config.js';
import { buildServer } from './server.js';
import { SqliteStore } from './store.js';
import { PushStore, ReminderScheduler } from './notifications.js';
import { storedRecord, executeDatabase } from '../test-support/database.js';
import { StorageBudget } from './storage-budget.js';
import {
  isPublicAddress,
  subscriptionSchema,
  type Subscription,
  type PushSender,
} from './push-transport.js';

const origin = 'http://localhost:3000';
const vapid = webpush.generateVAPIDKeys();
const keys = { p256dh: webpush.generateVAPIDKeys().publicKey, auth: 'AAAAAAAAAAAAAAAAAAAAAA' };
const userId = randomUUID(),
  otherId = randomUUID();
let directory: string, profiles: SqliteStore, push: PushStore;
let now: Date;
let app: Awaited<ReturnType<typeof buildServer>>;
const send = vi.fn<PushSender>(async () => {});
const validate = vi.fn(async () => {});
const subscription = (suffix = 'one'): Subscription => ({
  endpoint: `https://push.example.com/${suffix}`,
  keys,
});
const headers = (id = userId) => ({ origin, 'x-machbar-user': id });
beforeEach(async () => {
  now = new Date('2026-10-07T07:00:00Z');
  send.mockReset();
  validate.mockReset();
  directory = await mkdtemp(join(tmpdir(), 'machbar-push-'));
  profiles = new SqliteStore(directory);
  push = new PushStore(directory);
  const doc = createUser(userId);
  doc.preferences.timezone = 'Europe/Berlin';
  mutateDocument(
    doc,
    '/api/habits',
    'POST',
    { title: 'Read', weekdays: [0, 1, 2, 3, 4, 5, 6], reminderTime: '09:00' },
    randomUUID(),
    now,
  );
  await profiles.update(userId, (saved) => Object.assign(saved, doc));
  await profiles.update(otherId, () => {});
  app = await buildServer({
    config: {
      ...readConfig({
        VAPID_PUBLIC_KEY: vapid.publicKey,
        VAPID_PRIVATE_KEY: vapid.privateKey,
        VAPID_SUBJECT: 'mailto:test@example.com',
      }),
      dataDir: directory,
      webDir: join(directory, 'absent'),
    },
    store: profiles,
    notifications: { send, validate, schedule: false, clock: () => now },
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await app.close();
  await push.close();
  await rm(directory, { recursive: true, force: true });
});
async function register(suffix = 'one', id = userId) {
  const response = await app.inject({
    method: 'PUT',
    url: '/api/notifications/subscription',
    headers: headers(id),
    payload: { subscription: subscription(suffix) },
  });
  expect(response.statusCode).toBe(200);
  return response.json<{ bindingId: string }>().bindingId;
}
function scheduler() {
  return new ReminderScheduler(push, profiles, send, () => now);
}

describe('notification API', () => {
  it('rejects nonexistent profiles before loading or rewriting shared push state', async () => {
    await register();
    await app.close();
    app = await buildServer({
      config: { ...readConfig({}), dataDir: directory, webDir: join(directory, 'absent') },
    });
    const access = vi.spyOn(PushStore.prototype, 'access');
    const commit = vi.spyOn(StorageBudget.prototype, 'commit');
    const response = await app.inject({
      method: 'DELETE',
      url: '/api/notifications/subscription',
      headers: headers(randomUUID()),
      payload: { bindingId: randomUUID() },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ code: 'USER_NOT_FOUND' });
    expect(access).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
  });
  it('does not persist missing bindings or idempotent deletion retries', async () => {
    const bindingId = await register();
    await push.access((state) => {
      for (let i = 0; i < 1000; i++)
        state.dispatches[`${bindingId}:reminder-${i}`] = {
          expiresAt: now.getTime() + 86_400_000,
          attempts: 1,
          retryAt: null,
        };
    }, true);
    const commit = vi.spyOn(StorageBudget.prototype, 'commit');
    const remove = (id: string) =>
      app.inject({
        method: 'DELETE',
        url: '/api/notifications/subscription',
        headers: headers(),
        payload: { bindingId: id },
      });
    const initial = storedRecord(directory, 'push');
    expect((await remove(randomUUID())).statusCode).toBe(200);
    expect(commit).not.toHaveBeenCalled();
    expect(storedRecord(directory, 'push')).toBe(initial);
    expect((await remove(bindingId)).statusCode).toBe(200);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(await push.access((state) => state)).toEqual({ bindings: [], dispatches: {} });
    commit.mockClear();
    expect((await remove(bindingId)).statusCode).toBe(200);
    expect(commit).not.toHaveBeenCalled();
  });
  it('does not create a push-state file when a saved profile deletes an unknown binding', async () => {
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: '/api/notifications/subscription',
          headers: headers(),
          payload: { bindingId: randomUUID() },
        })
      ).statusCode,
    ).toBe(200);
    await expect(stat(join(directory, 'push-state.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
  it('exposes only the public key and requires identity and same-origin writes', async () => {
    expect((await app.inject({ url: '/api/notifications/config' })).statusCode).toBe(401);
    const response = await app.inject({ url: '/api/notifications/config', headers: headers() });
    expect(response.json()).toEqual({ available: true, publicKey: vapid.publicKey });
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: '/api/notifications/subscription',
          headers: { ...headers(), origin: 'https://evil.example' },
          payload: { subscription: subscription() },
        })
      ).statusCode,
    ).toBe(403);
  });
  it('registers idempotently, isolates profiles, and removes idempotently', async () => {
    const id = await register();
    expect(await register()).toBe(id);
    const conflict = await app.inject({
      method: 'PUT',
      url: '/api/notifications/subscription',
      headers: headers(otherId),
      payload: { subscription: subscription() },
    });
    expect(conflict.statusCode).toBe(409);
    for (const [method, url] of [
      ['DELETE', '/api/notifications/subscription'],
      ['POST', '/api/notifications/test'],
    ] as const)
      expect(
        (await app.inject({ method, url, headers: headers(otherId), payload: { bindingId: id } }))
          .statusCode,
      ).toBe(404);
    for (let i = 0; i < 2; i++)
      expect(
        (
          await app.inject({
            method: 'DELETE',
            url: '/api/notifications/subscription',
            headers: headers(),
            payload: { bindingId: id },
          })
        ).statusCode,
      ).toBe(200);
    expect(await push.access((state) => state.bindings)).toEqual([]);
    expect((await stat(join(directory, 'data.db'))).mode & 0o777).toBe(0o600);
    expect((await profiles.readExisting(userId)).revision).toBe(1);
  });
  it('rejects invalid keys/endpoints and private-network DNS destinations', async () => {
    for (const endpoint of [
      'http://example.com',
      'https://127.0.0.1/push',
      'https://[::1]/push',
      'https://10.0.0.1',
      'https://example.com:8443',
      'https://a:b@example.com',
      'https://example.com/#fragment',
    ]) {
      const response = await app.inject({
        method: 'PUT',
        url: '/api/notifications/subscription',
        headers: headers(),
        payload: { subscription: { ...subscription(), endpoint } },
      });
      expect(response.statusCode).toBe(400);
    }
    expect(
      subscriptionSchema.safeParse({ ...subscription(), keys: { ...keys, p256dh: 'x'.repeat(87) } })
        .success,
    ).toBe(false);
    validate.mockRejectedValueOnce(new Error('private DNS'));
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: '/api/notifications/subscription',
          headers: headers(),
          payload: { subscription: subscription() },
        })
      ).statusCode,
    ).toBe(400);
    for (const address of [
      '127.0.0.1',
      '169.254.169.254',
      '10.0.0.1',
      '100.64.1.1',
      '192.168.1.1',
      '224.0.0.1',
      '::1',
      '::ffff:127.0.0.1',
      'fc00::1',
      'fe80::1',
      '2001:db8::1',
      '2002:7f00:1::',
    ])
      expect(isPublicAddress(address)).toBe(false);
    expect(isPublicAddress('8.8.8.8')).toBe(true);
    expect(isPublicAddress('2606:4700:4700::1111')).toBe(true);
  });
  it('sends localized tests with no access key and limits repeated test sends', async () => {
    const bindingId = await register();
    await profiles.update(userId, (doc) => {
      doc.preferences.language = 'de';
    });
    const request = {
      method: 'POST' as const,
      url: '/api/notifications/test',
      headers: headers(),
      payload: { bindingId },
    };
    expect((await app.inject(request)).statusCode).toBe(200);
    expect(send).toHaveBeenCalledWith(
      subscription(),
      expect.objectContaining({
        bindingId,
        body: 'Benachrichtigungen sind bereit für deine kleinen Erfolge.',
      }),
      300,
      expect.any(String),
    );
    expect(JSON.stringify(send.mock.calls)).not.toContain(userId);
    expect((await app.inject(request)).statusCode).toBe(429);
    now = new Date(now.getTime() + 60_000);
    send.mockRejectedValueOnce({ statusCode: 410, endpoint: 'secret' });
    expect((await app.inject(request)).statusCode).toBe(502);
    expect(await push.access((state) => state.bindings)).toEqual([]);
  });
  it('handles disabled configuration and still permits subscription cleanup', async () => {
    await app.close();
    app = await buildServer({
      config: { ...readConfig({}), dataDir: directory, webDir: join(directory, 'absent') },
    });
    expect(
      (await app.inject({ url: '/api/notifications/config', headers: headers() })).json(),
    ).toEqual({ available: false, publicKey: null });
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: '/api/notifications/subscription',
          headers: headers(),
          payload: { subscription: subscription() },
        })
      ).statusCode,
    ).toBe(503);
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: '/api/notifications/subscription',
          headers: headers(),
          payload: { bindingId: randomUUID() },
        })
      ).statusCode,
    ).toBe(200);
  });
});
describe('notification scheduler', () => {
  it('rotates after a slow send and retains progress for a 500-reminder backlog', async () => {
    await profiles.update(userId, (doc) => {
      doc.habits = Array.from({ length: 500 }, () => ({ ...doc.habits[0]!, id: randomUUID() }));
    });
    await profiles.update(otherId, (doc) => {
      const other = createUser(otherId);
      other.preferences.timezone = 'Europe/Berlin';
      mutateDocument(
        other,
        '/api/habits',
        'POST',
        {
          title: 'Other profile',
          weekdays: [0, 1, 2, 3, 4, 5, 6],
          reminderTime: '09:00',
        },
        randomUUID(),
        now,
      );
      Object.assign(doc, other);
    });
    await register('slow');
    await register('fast', otherId);
    let elapsed = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => elapsed);
    send.mockImplementation(async (destination) => {
      if (destination.endpoint.endsWith('/slow')) elapsed += 1100;
    });
    const worker = scheduler();
    for (let attempt = 0; attempt < 3; attempt++) await worker.tick();
    expect(send.mock.calls.map((call) => call[0].endpoint)).toEqual([
      subscription('slow').endpoint,
      subscription('fast').endpoint,
      subscription('slow').endpoint,
      subscription('slow').endpoint,
    ]);
    expect(new Set(send.mock.calls.map((call) => call[1].tag)).size).toBe(4);
  });

  it('shares fast-backlog work between devices and resumes after already-claimed receipts', async () => {
    await profiles.update(userId, (doc) => {
      doc.habits = Array.from({ length: 75 }, () => ({ ...doc.habits[0]!, id: randomUUID() }));
    });
    await register('one');
    await register('two');
    vi.spyOn(performance, 'now').mockReturnValue(0);
    const worker = scheduler();
    await worker.tick();
    expect(
      send.mock.calls.filter((call) => call[0].endpoint === subscription('one').endpoint),
    ).toHaveLength(10);
    expect(
      send.mock.calls.filter((call) => call[0].endpoint === subscription('two').endpoint),
    ).toHaveLength(10);
    for (let attempt = 0; attempt < 7; attempt++) await worker.tick();
    expect(send).toHaveBeenCalledTimes(150);
    expect(new Set(send.mock.calls.map((call) => call[1].tag)).size).toBe(150);
    const restarted = scheduler();
    await restarted.tick();
    await profiles.update(userId, (doc) => {
      doc.habits.push({ ...doc.habits[0]!, id: randomUUID() });
    });
    for (let attempt = 0; attempt < 3; attempt++) await restarted.tick();
    expect(send).toHaveBeenCalledTimes(152);
    expect(new Set(send.mock.calls.map((call) => call[1].tag)).size).toBe(152);
  });

  it('bounds dispatch work and resumes later reminders without replaying receipts', async () => {
    await profiles.update(userId, (doc) => {
      const habit = doc.habits[0]!;
      doc.habits = Array.from({ length: 75 }, () => ({ ...habit, id: randomUUID() }));
    });
    await register();
    const worker = scheduler();
    await worker.tick();
    expect(send.mock.calls.length).toBeGreaterThan(0);
    expect(send.mock.calls.length).toBeLessThanOrEqual(50);
    for (let attempt = 0; attempt < 10 && send.mock.calls.length < 75; attempt++)
      await worker.tick();
    expect(send).toHaveBeenCalledTimes(75);
    expect(new Set(send.mock.calls.map((call) => call[1].tag)).size).toBe(75);
    await worker.tick();
    expect(send).toHaveBeenCalledTimes(75);
  });
  it('sends to each device once, survives restart, and ignores same-day edits and undo', async () => {
    await register();
    await register('two');
    const first = scheduler();
    expect(first.tick()).toBe(first.tick());
    await first.tick();
    expect(send).toHaveBeenCalledTimes(2);
    const payload = (
      send.mock.calls as unknown as Array<
        [Subscription, { expiresAt: number; tag: string }, number, string]
      >
    )[0]!;
    expect(payload[1].expiresAt).toBe(Date.parse('2026-10-07T22:00:00Z'));
    expect(payload[2]).toBe(15 * 60 * 60);
    expect(payload[3]).toHaveLength(32);
    await scheduler().tick();
    expect(send).toHaveBeenCalledTimes(2);
    await profiles.update(userId, (doc) => {
      doc.habits[0]!.reminderTime = '08:00';
    });
    await scheduler().tick();
    expect(send).toHaveBeenCalledTimes(2);
    now = new Date('2026-10-08T12:00:00Z');
    await scheduler().tick();
    expect(send).toHaveBeenCalledTimes(4);
    const stopped = scheduler();
    await stopped.stop();
    await stopped.tick();
    expect(send).toHaveBeenCalledTimes(4);
  });
  it('catches up after downtime and suppresses completed habits using synced documents', async () => {
    await register();
    now = new Date('2026-10-07T20:00:00Z');
    await scheduler().tick();
    expect(send).toHaveBeenCalledTimes(1);
    now = new Date('2026-10-08T12:00:00Z');
    await profiles.update(userId, (doc) => {
      const key = operationKey(doc, 'habit', doc.habits[0]!.id, '2026-10-08');
      doc.completions[key] = {
        key,
        targetType: 'habit',
        targetId: doc.habits[0]!.id,
        date: '2026-10-08',
        timezone: 'Europe/Berlin',
        completed: true,
        version: 1,
        updatedAt: now.toISOString(),
      };
    });
    await scheduler().tick();
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('retries explicit transient failures with stable tags and expires previous-day retry records', async () => {
    await register();
    send.mockRejectedValueOnce({ statusCode: 503 });
    await scheduler().tick();
    await scheduler().tick();
    expect(send).toHaveBeenCalledTimes(1);
    now = new Date(now.getTime() + 60_000);
    await scheduler().tick();
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0]![1]).toEqual(send.mock.calls[1]![1]);
    expect(send.mock.calls[0]![3]).toBe(send.mock.calls[1]![3]);
    expect(send.mock.calls[1]![2]).toBe(send.mock.calls[0]![2] - 60);
    now = new Date('2026-10-07T22:00:00Z');
    await scheduler().tick();
    expect(await push.access((state) => state.dispatches)).toEqual({});
  });
  it.each([404, 410])('removes expired subscriptions after %i', async (statusCode) => {
    await register();
    send.mockRejectedValueOnce({ statusCode });
    await scheduler().tick();
    expect(await push.access((state) => state.bindings)).toEqual([]);
  });
  it('retries failures known to occur before a push request could be accepted', async () => {
    await register();
    send.mockRejectedValueOnce({ retryable: true });
    await scheduler().tick();
    expect(send).toHaveBeenCalledTimes(1);
    now = new Date(now.getTime() + 60_000);
    await scheduler().tick();
    expect(send).toHaveBeenCalledTimes(2);
  });
  it('does not retry ambiguous network failures and preserves durable claims before sending', async () => {
    await register();
    send.mockImplementationOnce(async () => {
      const state = JSON.parse(storedRecord(directory, 'push')!);
      expect(Object.keys(state.dispatches)).toHaveLength(1);
      throw new Error('Socket timeout with secret endpoint');
    });
    await scheduler().tick();
    now = new Date(now.getTime() + 3600_000);
    await scheduler().tick();
    expect(send).toHaveBeenCalledTimes(1);
    await push.access((state) => {
      state.bindings = [];
    }, true);
    await scheduler().tick();
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('does not silently replace corrupt saved notification state', async () => {
    const bad = new PushStore(directory);
    await bad.access((state) => {
      state.bindings.push({ id: randomUUID(), userId, subscription: subscription() });
    }, true);
    executeDatabase(directory, "UPDATE push_bindings SET endpoint = 'http://localhost/private'");
    const corrupt = storedRecord(directory, 'push');
    await expect(bad.access(() => {})).rejects.toMatchObject({ code: 'PUSH_DATA_CORRUPT' });
    expect(storedRecord(directory, 'push')).toBe(corrupt);
    await bad.close();
  });
});
