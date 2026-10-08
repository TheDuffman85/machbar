import { describe, expect, it } from 'vitest';
import { parseNotificationPayload } from './notificationPayload';

const bindingId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const payload = {
  version: 1,
  bindingId,
  title: 'Machbar',
  body: 'Time for a small win: Read',
  tag: `${bindingId}:habit:2026-10-07`,
  expiresAt: 1791410400000,
};
describe('notification payloads', () => {
  it('accepts versioned content without credentials or external click URLs', () => {
    expect(parseNotificationPayload(payload)).toEqual(payload);
  });
  it.each([
    null,
    'bad',
    {},
    { ...payload, version: 2 },
    { ...payload, bindingId: '../profile' },
    { ...payload, tag: 'another-profile' },
    { ...payload, body: 'x'.repeat(513) },
    { ...payload, expiresAt: Infinity },
  ])('rejects malformed payload %j', (value) => {
    expect(parseNotificationPayload(value)).toBeUndefined();
  });
});
