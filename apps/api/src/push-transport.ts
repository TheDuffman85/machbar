import { lookup } from 'node:dns/promises';
import { Agent, request } from 'node:https';
import { BlockList, isIP } from 'node:net';
import webpush from 'web-push';
import { z } from 'zod';
import { DomainError } from '@machbar/shared';
import type { Config } from './config.js';

const blocked = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 3],
] as const)
  blocked.addSubnet(address, prefix, 'ipv4');
const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');
blocked.addSubnet('2001::', 32, 'ipv6'); // Teredo and mapped IPv4 routes.
blocked.addSubnet('2001:db8::', 32, 'ipv6');
blocked.addSubnet('2002::', 16, 'ipv6'); // 6to4 can encode private IPv4 destinations.

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  return family === 4
    ? !blocked.check(address, 'ipv4')
    : family === 6 && globalV6.check(address, 'ipv6') && !blocked.check(address, 'ipv6');
}

export const subscriptionSchema = z
  .object({
    endpoint: z
      .string()
      .max(2048)
      .refine((value) => {
        try {
          const url = new URL(value);
          const hostname = url.hostname.replace(/^\[|\]$/g, '');
          return (
            url.protocol === 'https:' &&
            (!url.port || url.port === '443') &&
            !url.username &&
            !url.password &&
            !url.hash &&
            (isIP(hostname)
              ? isPublicAddress(hostname)
              : hostname.includes('.') && !hostname.endsWith('.localhost'))
          );
        } catch {
          return false;
        }
      }),
    expirationTime: z.number().nonnegative().nullable().optional(),
    keys: z
      .object({
        p256dh: z
          .string()
          .regex(/^[A-Za-z0-9_-]{87}=?$/)
          .refine((value) => {
            const key = Buffer.from(value, 'base64url');
            if (key.length !== 65 || key[0] !== 4) return false;
            try {
              webpush.generateRequestDetails(
                {
                  endpoint: 'https://example.com',
                  keys: { p256dh: value, auth: 'AAAAAAAAAAAAAAAAAAAAAA' },
                },
                'check',
              );
              return true;
            } catch {
              return false;
            }
          }),
        auth: z.string().regex(/^[A-Za-z0-9_-]{22}(?:==)?$/),
      })
      .strict(),
  })
  .strict();
export type Subscription = z.infer<typeof subscriptionSchema>;
export type PushPayload = {
  version: 1;
  bindingId: string;
  title: string;
  body: string;
  tag: string;
  expiresAt: number;
};
export type PushSender = (
  subscription: Subscription,
  payload: PushPayload,
  ttl: number,
  topic: string,
) => Promise<void>;
export type EndpointValidator = (endpoint: string) => Promise<void>;

async function destination(endpoint: string) {
  const hostname = new URL(endpoint).hostname.replace(/^\[|\]$/g, '');
  let timer: ReturnType<typeof setTimeout> | undefined;
  const addresses = isIP(hostname)
    ? [{ address: hostname, family: isIP(hostname) }]
    : await Promise.race([
        lookup(hostname, { all: true }),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('Push DNS lookup timed out.')), 5000);
        }),
      ]).finally(() => clearTimeout(timer));
  if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address)))
    throw new DomainError('VALIDATION_ERROR', 400);
  return addresses[0]!;
}
export const validateEndpoint: EndpointValidator = async (endpoint) => {
  await destination(endpoint);
};

export function createPushSender(vapid: NonNullable<Config['vapid']>): PushSender {
  return async (subscription, payload, ttl, topic) => {
    // Pin the validated address for this request: a second DNS lookup cannot rebind it.
    const address = await destination(subscription.endpoint).catch((error: unknown) => {
      if (error instanceof DomainError) throw error;
      throw Object.assign(new Error('Push DNS lookup failed.'), { retryable: true });
    });
    const agent = new Agent({
      lookup: (_hostname, options, callback) => {
        if (typeof options === 'object' && options.all)
          callback(null, [{ address: address.address, family: address.family }]);
        else callback(null, address.address, address.family);
      },
    });
    try {
      const details = webpush.generateRequestDetails(subscription, JSON.stringify(payload), {
        vapidDetails: vapid,
        TTL: ttl,
        topic,
        urgency: 'high',
        timeout: 10_000,
        agent,
      });
      // Read only response headers. Never follow redirects or retain provider bodies
      // (which may contain endpoints, credentials, or unbounded response content).
      await new Promise<void>((resolve, reject) => {
        let connected = false;
        const req = request(
          subscription.endpoint,
          {
            method: details.method,
            headers: details.headers,
            agent,
          },
          (response) => {
            const statusCode = response.statusCode ?? 502;
            response.destroy();
            if (statusCode >= 200 && statusCode < 300) resolve();
            else
              reject(
                Object.assign(new Error('Push service rejected the message.'), { statusCode }),
              );
          },
        );
        const timer = setTimeout(() => req.destroy(new Error('Push request timed out.')), 10_000);
        req.once('socket', (socket) => {
          socket.once('secureConnect', () => {
            connected = true;
          });
        });
        req.once('error', (error) =>
          reject(
            Object.assign(
              new Error(
                error.message === 'Push request timed out.'
                  ? error.message
                  : 'Push request failed.',
              ),
              { retryable: !connected },
            ),
          ),
        );
        req.once('close', () => clearTimeout(timer));
        req.end(details.body);
      });
    } finally {
      agent.destroy();
    }
  };
}
