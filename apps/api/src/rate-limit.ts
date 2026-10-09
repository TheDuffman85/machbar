import type { FastifyInstance } from 'fastify';
import { localUserIdSchema } from '@machbar/shared';
import type { Config } from './config.js';
import { isApiRequest } from './api-request.js';

export type RateLimitScope = 'ip' | 'user' | 'anonymous' | 'creation';
// A counter that has reached its limit; its requests get 429 until resetAt.
export type RateLimitBlock = { scope: RateLimitScope; key: string; count: number; limit: number };
export type RateLimitStatus = {
  resetAt: number;
  tracked: number;
  capacity: number;
  blocked: RateLimitBlock[];
};
export type RateLimiter = {
  admitUser(ip: string): boolean;
  status(): RateLimitStatus;
};

export function registerRateLimits(app: FastifyInstance, config: Config): RateLimiter {
  // One fixed window per process. Bound memory and fail closed when full;
  // evicting active counters would let rotating identities bypass the limits.
  const counters = new Map<string, number>();
  const maxCounters = 10_000;
  let resetAt = Date.now() + config.rateLimitWindowSeconds * 1000;
  const consume = (limits: Array<[string, number]>) => {
    // Admit all counters together. Already-rejected traffic must not drain
    // another allowance, including when several clients share an address.
    let newCounters = 0;
    for (const [key, limit] of limits) {
      const count = counters.get(key);
      if ((count ?? 0) >= limit) return false;
      if (count === undefined) newCounters++;
    }
    if (counters.size + newCounters > maxCounters) return false;
    for (const [key] of limits) counters.set(key, (counters.get(key) ?? 0) + 1);
    return true;
  };
  const reset = () => {
    if (Date.now() >= resetAt) {
      counters.clear();
      resetAt = Date.now() + config.rateLimitWindowSeconds * 1000;
    }
  };
  app.addHook('onRequest', async (request, reply) => {
    if (!isApiRequest(request)) return;
    const now = Date.now();
    reset();
    const identity = localUserIdSchema.safeParse(request.headers['x-machbar-user']);
    // request.ip only honors forwarding through explicitly trusted proxy hops.
    const allowed = consume([
      [`ip:${request.ip}`, config.rateLimitMaxPerIp],
      identity.success
        ? [`user:${identity.data}`, config.rateLimitMaxPerUser]
        : [`anonymous:${request.ip}`, config.rateLimitMaxAnonymous],
    ]);
    if (!allowed)
      return reply
        .code(429)
        .header('Retry-After', String(Math.max(1, Math.ceil((resetAt - now) / 1000))))
        .send({ code: 'RATE_LIMITED' });
  });
  app.addHook('onClose', async () => counters.clear());
  const limits: Record<RateLimitScope, number> = {
    ip: config.rateLimitMaxPerIp,
    user: config.rateLimitMaxPerUser,
    anonymous: config.rateLimitMaxAnonymous,
    creation: config.rateLimitMaxNewUsers,
  };
  return {
    admitUser: (ip) => {
      reset();
      // Global admission also bounds creation spread across addresses and UUIDs.
      return consume([
        ['creation:global', config.rateLimitMaxNewUsers],
        [`creation:${ip}`, config.rateLimitMaxNewUsers],
      ]);
    },
    status: () => {
      reset();
      const blocked: RateLimitBlock[] = [];
      for (const [counter, count] of counters) {
        const split = counter.indexOf(':');
        const scope = counter.slice(0, split) as RateLimitScope;
        if (count >= limits[scope])
          blocked.push({ scope, key: counter.slice(split + 1), count, limit: limits[scope] });
      }
      return { resetAt, tracked: counters.size, capacity: maxCounters, blocked };
    },
  };
}
