import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

let offline: typeof import('./offline');
beforeAll(async () => {
  vi.stubGlobal('BroadcastChannel', undefined);
  vi.stubGlobal('localStorage', { getItem: () => null });
  offline = await import('./offline');
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
afterAll(() => vi.unstubAllGlobals());

describe('API request recovery', () => {
  it.each([200, 503])(
    'times out a stalled %i response body even with a caller signal',
    async (status) => {
      vi.useFakeTimers();
      const caller = new AbortController();
      let signal!: AbortSignal;
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (_path, options) => {
        signal = options!.signal!;
        return {
          ok: status === 200,
          status,
          json: () =>
            new Promise((_resolve, reject) => {
              signal.addEventListener('abort', () => reject(signal.reason), { once: true });
            }),
        } as Response;
      });
      const result = expect(
        offline.request('/api/bootstrap', { signal: caller.signal }),
      ).rejects.toMatchObject({ code: 'OFFLINE' });
      await vi.advanceTimersByTimeAsync(10_000);
      await result;
      expect(signal.aborted).toBe(true);
      expect(caller.signal.aborted).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('honors caller cancellation and clears its request timeout', async () => {
    vi.useFakeTimers();
    const caller = new AbortController();
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      (_path, options) =>
        new Promise((_resolve, reject) => {
          options!.signal!.addEventListener('abort', () => reject(options!.signal!.reason));
        }),
    );
    const result = expect(
      offline.request('/api/bootstrap', { signal: caller.signal }),
    ).rejects.toMatchObject({ code: 'OFFLINE' });
    caller.abort();
    await result;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('preserves revision conflicts and releases the timeout', async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ code: 'DOCUMENT_CONFLICT' }), { status: 409 }),
    );
    await expect(offline.request('/api/sync')).rejects.toMatchObject({
      code: 'DOCUMENT_CONFLICT',
      status: 409,
    });
    expect(vi.getTimerCount()).toBe(0);
  });
});
