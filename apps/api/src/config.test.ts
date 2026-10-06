import { describe, expect, it } from 'vitest';
import { readConfig } from './config.js';

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
  it('allows new users by default and with an explicit false', () => {
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
