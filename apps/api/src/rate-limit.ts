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
  return (ip: string): boolean => {
    reset();
    // Global admission also bounds creation spread across addresses and UUIDs.
    return consume([
      ['creation:global', config.rateLimitMaxNewUsers],
      [`creation:${ip}`, config.rateLimitMaxNewUsers],
    ]);
  };
}
