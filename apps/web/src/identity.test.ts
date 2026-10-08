import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getLocalUserId, localUserIdKey, setLocalUserId } from './identity';

const alice = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const bob = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
let storage: Map<string, string>;
let cookie: string;
let writtenCookie: string;

beforeEach(() => {
  storage = new Map();
  cookie = '';
  writtenCookie = '';
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  });
  vi.stubGlobal('location', { protocol: 'https:' });
  vi.stubGlobal('document', {
    get cookie() {
      return cookie;
    },
    set cookie(value: string) {
      writtenCookie = value;
      cookie = value.split(';')[0]!;
    },
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('profile identity persistence', () => {
  it('preserves an existing local ID and deletes the stale host-wide cookie', () => {
    storage.set(localUserIdKey, alice.toUpperCase());
    cookie = `${localUserIdKey}=${bob}`;
    expect(getLocalUserId()).toBe(alice);
    expect(storage.get(localUserIdKey)).toBe(alice);
    expect(writtenCookie).toBe(`${localUserIdKey}=; Path=/; Max-Age=0; SameSite=Strict; Secure`);
  });

  it.each([undefined, 'local'])('migrates a legacy cookie when the local ID is %s', (local) => {
    if (local) storage.set(localUserIdKey, local);
    cookie = `other=value; ${localUserIdKey}=${bob.toUpperCase()}; another=value`;
    expect(getLocalUserId()).toBe(bob);
    expect(storage.get(localUserIdKey)).toBe(bob);
    expect(writtenCookie).toContain('Max-Age=0');
    expect(writtenCookie).not.toContain(bob);
    expect(getLocalUserId()).toBe(bob);
  });

  it.each(['', 'local', '%E0%A4%A'])('ignores an invalid cookie value %s', (value) => {
    cookie = `${localUserIdKey}=${value}`;
    const id = getLocalUserId();
    expect(id).toMatch(/^[a-f0-9-]{36}$/);
    expect(storage.get(localUserIdKey)).toBe(id);
    expect(getLocalUserId()).toBe(id);
  });

  it('keeps profile switches in origin-scoped storage', () => {
    setLocalUserId(alice);
    setLocalUserId(bob);
    expect(getLocalUserId()).toBe(bob);
    expect(writtenCookie).not.toContain(bob);
    storage.clear();
    expect(getLocalUserId()).not.toBe(bob);
  });

  it('clears the legacy cookie on LAN HTTP', () => {
    vi.stubGlobal('location', { protocol: 'http:' });
    setLocalUserId(alice);
    expect(writtenCookie).toBe(`${localUserIdKey}=; Path=/; Max-Age=0; SameSite=Strict`);
  });

  it('still uses local storage when cookies are blocked', () => {
    vi.stubGlobal('document', {
      get cookie(): string {
        throw new Error('Cookies blocked');
      },
      set cookie(_value: string) {
        throw new Error('Cookies blocked');
      },
    });
    const id = getLocalUserId();
    expect(storage.get(localUserIdKey)).toBe(id);
    expect(getLocalUserId()).toBe(id);
    setLocalUserId(bob);
    expect(getLocalUserId()).toBe(bob);
  });
});
