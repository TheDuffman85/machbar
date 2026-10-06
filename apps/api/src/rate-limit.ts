import type { FastifyInstance } from 'fastify';
import { localUserIdSchema } from '@machbar/shared';
import type { Config } from './config.js';
import { isApiRequest } from './api-request.js';

export function registerRateLimits(app: FastifyInstance, config: Config) {
  // One fixed window per process. Bound memory and fail closed when full;
  // evicting active counters would let rotating identities bypass the limits.
  const counters = new Map<string, number>();
  const maxCounters = 10_000;
  let resetAt = Date.now() + config.rateLimitWindowSeconds * 1000;
  const consume = (key: string, limit: number) => {
    const count = counters.get(key);
    if (count === undefined && counters.size >= maxCounters) return false;
    if ((count ?? 0) >= limit) return false;
    counters.set(key, (count ?? 0) + 1);
    return true;
  };
  app.addHook('onRequest', async (request, reply) => {
    if (!isApiRequest(request)) return;
    const now = Date.now();
    if (now >= resetAt) {
      counters.clear();
      resetAt = now + config.rateLimitWindowSeconds * 1000;
    }
    const identity = localUserIdSchema.safeParse(request.headers['x-machbar-user']);
    // Fastify uses the socket address by default. Do not trust client-supplied
    // forwarding headers: neither they nor rotating UUIDs may bypass IP limits.
    const allowed =
      consume(`ip:${request.ip}`, config.rateLimitMaxPerIp) &&
      (identity.success
        ? consume(`user:${identity.data}`, config.rateLimitMaxPerUser)
        : consume(`anonymous:${request.ip}`, config.rateLimitMaxAnonymous));
    if (!allowed)
      return reply
        .code(429)
        .header('Retry-After', String(Math.max(1, Math.ceil((resetAt - now) / 1000))))
        .send({ code: 'RATE_LIMITED' });
  });
  app.addHook('onClose', async () => counters.clear());
}
