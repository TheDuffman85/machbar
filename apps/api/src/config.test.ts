import { describe, expect, it } from 'vitest';
import { readConfig } from './config.js';
import webpush from 'web-push';

describe('Web Push configuration', () => {
  it('is disabled with absent or empty values', () => {
    expect(readConfig({}).vapid).toBeNull();
    expect(
      readConfig({ VAPID_PUBLIC_KEY: '', VAPID_PRIVATE_KEY: '', VAPID_SUBJECT: '' }).vapid,
    ).toBeNull();
  });
  it('accepts matching P-256 keys and a public contact', () => {
    const keys = webpush.generateVAPIDKeys();
    expect(
      readConfig({
        VAPID_PUBLIC_KEY: keys.publicKey,
        VAPID_PRIVATE_KEY: keys.privateKey,
        VAPID_SUBJECT: 'mailto:owner@example.com',
      }).vapid,
    ).toEqual({ ...keys, subject: 'mailto:owner@example.com' });
  });
  it('rejects incomplete, mismatched, malformed keys and local contacts', () => {
    const keys = webpush.generateVAPIDKeys();
    const valid = {
      VAPID_PUBLIC_KEY: keys.publicKey,
      VAPID_PRIVATE_KEY: keys.privateKey,
      VAPID_SUBJECT: 'mailto:owner@example.com',
    };
    for (const env of [
      { VAPID_PUBLIC_KEY: keys.publicKey },
      { ...valid, VAPID_PRIVATE_KEY: webpush.generateVAPIDKeys().privateKey },
      { ...valid, VAPID_PUBLIC_KEY: 'bad' },
      { ...valid, VAPID_SUBJECT: 'https://localhost' },
      { ...valid, VAPID_SUBJECT: 'mailto:owner@localhost' },
      { ...valid, VAPID_SUBJECT: 'ftp://example.com' },
    ])
      expect(() => readConfig(env)).toThrow('VAPID');
  });
});

describe('Daily page history configuration', () => {
  it('defaults to three days', () => {
    expect(readConfig({}).dailyHistoryDays).toBe(3);
  });

  it.each(['0', '1', '7'])('accepts %s days', (value) => {
    expect(readConfig({ DAILY_HISTORY_DAYS: value }).dailyHistoryDays).toBe(Number(value));
  });

  it.each(['', '-1', '1.5', 'abc', 'Infinity', '9007199254740992'])(
    'rejects invalid limit %j',
    (value) => {
      expect(() => readConfig({ DAILY_HISTORY_DAYS: value })).toThrow('DAILY_HISTORY_DAYS');
    },
  );
});

describe('Server configuration', () => {
  it('ignores forwarding by default and accepts explicit IPv4/IPv6 proxies', () => {
    expect(readConfig({}).trustedProxies).toEqual([]);
    expect(readConfig({ TRUSTED_PROXIES: '  ' }).trustedProxies).toEqual([]);
    expect(
      readConfig({ TRUSTED_PROXIES: '192.0.2.1, 198.51.100.0/24, ::1, 2001:db8::/32' })
        .trustedProxies,
    ).toEqual(['192.0.2.1', '198.51.100.0/24', '::1', '2001:db8::/32']);
  });

  it.each([
    'true',
    'false',
    '*',
    'loopback',
    'proxy.example.com',
    '192.0.2.999',
    '192.0.2.1,',
    '192.0.2.1,,::1',
    '0.0.0.0/0',
    '::/0',
    '192.0.2.0/33',
    '::1/129',
    '::1/-1',
    '::1/1.5',
    '::1/',
    '::1/64/1',
  ])('rejects unsafe or invalid proxy allowlists %s', (TRUSTED_PROXIES) => {
    expect(() => readConfig({ TRUSTED_PROXIES })).toThrow('TRUSTED_PROXIES');
  });

  it('starts in production without a session secret', () => {
    expect(readConfig({ NODE_ENV: 'production' })).toEqual(readConfig({}));
  });

  it.each([
    'ftp://example.com',
    'https://example.com/path',
    'https://example.com/?query=1',
    'https://example.com/#hash',
    'https://user:password@example.com',
  ])('rejects invalid public origins %s', (APP_URL) => {
    expect(() => readConfig({ APP_URL })).toThrow('APP_URL');
  });
});

describe('User creation configuration', () => {
  it('permits public registration by default and with explicit false', () => {
    expect(readConfig({}).disableUserCreation).toBe(false);
    expect(readConfig({ DISABLE_USER_CREATION: 'false' }).disableUserCreation).toBe(false);
  });
  it('disables new users with true', () => {
    expect(readConfig({ DISABLE_USER_CREATION: 'true' }).disableUserCreation).toBe(true);
  });
  it.each(['', '1', '0', 'yes', 'TRUE'])('rejects invalid values %j', (value) => {
    expect(() => readConfig({ DISABLE_USER_CREATION: value })).toThrow('DISABLE_USER_CREATION');
  });
});

describe('API rate limit configuration', () => {
  it('uses stricter anonymous limits by default', () => {
    expect(readConfig({})).toMatchObject({
      rateLimitWindowSeconds: 60,
      rateLimitMaxPerIp: 300,
      rateLimitMaxPerUser: 120,
      rateLimitMaxAnonymous: 20,
    });
  });
  it.each([
    ['RATE_LIMIT_WINDOW_SECONDS', 'rateLimitWindowSeconds'],
    ['RATE_LIMIT_MAX_PER_IP', 'rateLimitMaxPerIp'],
    ['RATE_LIMIT_MAX_PER_USER', 'rateLimitMaxPerUser'],
    ['RATE_LIMIT_MAX_ANONYMOUS', 'rateLimitMaxAnonymous'],
    ['RATE_LIMIT_MAX_NEW_USERS', 'rateLimitMaxNewUsers'],
    ['MAX_PROFILES', 'maxProfiles'],
    ['MAX_STORAGE_BYTES', 'maxStorageBytes'],
    ['STORAGE_RESERVE_BYTES', 'storageReserveBytes'],
  ])('validates %s and accepts custom limits', (name, property) => {
    expect(readConfig({ [name]: '7' })).toHaveProperty(property, 7);
    for (const value of ['', '0', '-1', '1.5', 'abc', 'Infinity', '9007199254740992'])
      expect(() => readConfig({ [name]: value })).toThrow(name);
  });
  it('bounds the window duration', () => {
    expect(() => readConfig({ RATE_LIMIT_WINDOW_SECONDS: '86401' })).toThrow(
      'RATE_LIMIT_WINDOW_SECONDS',
    );
  });
});
