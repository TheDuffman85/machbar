import { EventEmitter } from 'node:events';
import type { Agent } from 'node:https';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import webpush from 'web-push';
const mock = vi.hoisted(() => ({ lookup: vi.fn(), request: vi.fn() }));
vi.mock('node:dns/promises', () => ({ lookup: mock.lookup }));
vi.mock('node:https', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:https')>()),
  request: mock.request,
}));
import { createPushSender, validateEndpoint } from './push-transport.js';
const vapid = { ...webpush.generateVAPIDKeys(), subject: 'mailto:owner@example.com' };
const subscription = {
  endpoint: 'https://push.example.com/secret-endpoint',
  keys: { p256dh: webpush.generateVAPIDKeys().publicKey, auth: 'AAAAAAAAAAAAAAAAAAAAAA' },
};
const payload = {
  version: 1 as const,
  bindingId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  title: 'Machbar',
  body: 'Read',
  tag: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:read',
  expiresAt: Date.now() + 10000,
};
let statusCode: number, responseClosed: ReturnType<typeof vi.fn>, body: unknown;
beforeEach(() => {
  statusCode = 201;
  responseClosed = vi.fn();
  mock.lookup.mockReset();
  mock.request.mockReset();
  mock.lookup.mockResolvedValue([{ address: '8.8.8.8', family: 4 }]);
  mock.request.mockImplementation((_url, _options, callback) => {
    const req = Object.assign(new EventEmitter(), {
      end: (data: unknown) => {
        body = data;
        if (statusCode)
          queueMicrotask(() => {
            callback({
              statusCode,
              destroy: () => {
                responseClosed();
                req.emit('close');
              },
            });
          });
      },
      destroy: (error: Error) => {
        req.emit('error', error);
        req.emit('close');
      },
    });
    return req;
  });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('Web Push transport', () => {
  it('rejects mixed private/public DNS results before issuing a request', async () => {
    mock.lookup.mockResolvedValue([
      { address: '8.8.8.8', family: 4 },
      { address: '10.0.0.1', family: 4 },
    ]);
    await expect(validateEndpoint(subscription.endpoint)).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    await expect(
      createPushSender(vapid)(subscription, payload, 300, 'topic'),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(mock.request).not.toHaveBeenCalled();
  });
  it('encrypts the payload, pins the validated address, and discards response content', async () => {
    await createPushSender(vapid)(subscription, payload, 300, 'topic');
    expect(Buffer.isBuffer(body)).toBe(true);
    expect(Buffer.from(body as Buffer).toString()).not.toContain('Read');
    const options = mock.request.mock.calls[0]![1] as {
      agent: Agent & {
        options: {
          lookup: (
            hostname: string,
            options: { all: boolean },
            callback: (...args: unknown[]) => void,
          ) => void;
        };
      };
      headers: Record<string, string>;
    };
    expect(options.headers.TTL).toBe(300);
    expect(options.headers.Topic).toBe('topic');
    mock.lookup.mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
    const callback = vi.fn();
    options.agent.options.lookup('push.example.com', { all: false }, callback);
    expect(callback).toHaveBeenCalledWith(null, '8.8.8.8', 4);
    options.agent.options.lookup('push.example.com', { all: true }, callback);
    expect(callback).toHaveBeenLastCalledWith(null, [{ address: '8.8.8.8', family: 4 }]);
    expect(mock.lookup).toHaveBeenCalledTimes(1);
    expect(responseClosed).toHaveBeenCalledTimes(1);
  });
  it.each([302, 410, 429, 503])(
    'rejects %i without following redirects or leaking provider content',
    async (status) => {
      statusCode = status;
      await expect(
        createPushSender(vapid)(subscription, payload, 300, 'topic'),
      ).rejects.toMatchObject({
        statusCode: status,
        message: 'Push service rejected the message.',
      });
      expect(mock.request).toHaveBeenCalledTimes(1);
      expect(responseClosed).toHaveBeenCalledTimes(1);
    },
  );
  it('enforces a total request deadline, including stalled connections', async () => {
    vi.useFakeTimers();
    statusCode = 0;
    const operation = expect(
      createPushSender(vapid)(subscription, payload, 300, 'topic'),
    ).rejects.toThrow('Push request timed out.');
    await vi.advanceTimersByTimeAsync(10_000);
    await operation;
    expect(vi.getTimerCount()).toBe(0);
  });
  it('marks DNS failures as retryable before a request exists', async () => {
    mock.lookup.mockRejectedValueOnce(new Error('DNS unavailable: secret-host'));
    await expect(
      createPushSender(vapid)(subscription, payload, 300, 'topic'),
    ).rejects.toMatchObject({ retryable: true, message: 'Push DNS lookup failed.' });
    expect(mock.request).not.toHaveBeenCalled();
  });
  it('does not retry failures after TLS connects because delivery is ambiguous', async () => {
    mock.request.mockImplementation((_url, _options, _callback) => {
      const req = Object.assign(new EventEmitter(), {
        end: () =>
          queueMicrotask(() => {
            const socket = new EventEmitter();
            req.emit('socket', socket);
            socket.emit('secureConnect');
            req.emit('error', new Error('Socket closed: secret-endpoint'));
            req.emit('close');
          }),
      });
      return req;
    });
    await expect(
      createPushSender(vapid)(subscription, payload, 300, 'topic'),
    ).rejects.toMatchObject({ retryable: false, message: 'Push request failed.' });
  });
});
