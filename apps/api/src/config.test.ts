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
