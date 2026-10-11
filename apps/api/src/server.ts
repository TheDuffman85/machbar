import Fastify, { type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import { access } from 'node:fs/promises';
import { z } from 'zod';
import {
  DomainError,
  documentWithinLimits,
  localUserIdSchema,
  syncDocumentSchema,
} from '@machbar/shared';
import { type Config, readConfig } from './config.js';
import { SqliteStore, maxDocumentBytes } from './store.js';
import { StorageBudget } from './storage-budget.js';
import { registerIdentity } from './identity.js';
import { registerRateLimits } from './rate-limit.js';
import { isApiRequest } from './api-request.js';
import { registerNotifications, type NotificationOptions } from './notifications.js';
import { adminPostRoutes, registerAdmin } from './admin.js';
import { UserCreation } from './user-creation.js';
import { registerClientVersion } from './client-version.js';

declare module 'fastify' {
  interface FastifyRequest {
    holdsApiSlot: boolean;
    pendingApiWork: number;
    apiResponseFinished: boolean;
  }
}

export async function buildServer(
  options: {
    config?: Config;
    store?: SqliteStore;
    logger?: boolean;
    notifications?: NotificationOptions;
    userCreation?: UserCreation;
  } = {},
) {
  const config = options.config ?? readConfig();
  const budget = new StorageBudget(config.dataDir, config);
  const userCreation = options.userCreation ?? new UserCreation(config);
  const store = options.store ?? new SqliteStore(config.dataDir, budget);
  await store.useBudget(budget);
  await store.ready();
  const activeWork = new Set<Promise<unknown>>();
  const app = Fastify({
    logger: options.logger
      ? {
          serializers: {
            req: (request) => ({
              method: request.method,
              url: request.url?.split('?')[0],
              hostname: request.hostname,
            }),
          },
        }
      : false,
    bodyLimit: maxDocumentBytes,
    requestTimeout: 30_000,
    connectionTimeout: 15_000,
    keepAliveTimeout: 5_000,
    trustProxy: config.trustedProxies.length ? config.trustedProxies : false,
  });
  app.addHook('onClose', async () => {
    // A disconnected client can leave backend work running after its socket
    // closes. Finish that work before closing the SQLite connection.
    await Promise.allSettled(activeWork);
    await store.close();
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof z.ZodError) return reply.code(400).send({ code: 'VALIDATION_ERROR' });
    if (error instanceof DomainError) {
      if (error.status >= 500) app.log.error(error);
      return reply.code(error.status).send({ code: error.code });
    }
    if (
      typeof error === 'object' &&
      error !== null &&
      'statusCode' in error &&
      typeof error.statusCode === 'number' &&
      error.statusCode < 500
    )
      return reply.code(error.statusCode).send({ code: 'VALIDATION_ERROR' });
    app.log.error(error);
    return reply.code(500).send({ code: 'INTERNAL_ERROR' });
  });
  app.addHook('onSend', async (request, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff').header('Referrer-Policy', 'same-origin');
    reply.header(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    );
    if (isApiRequest(request)) reply.header('Cache-Control', 'no-store');
    return payload;
  });
  app.server.maxConnections = 128;
  app.addHook('onRequest', async (request, reply) => {
    // Only API routes accept bodies. Reject other methods before Fastify reads
    // or parses them, including OPTIONS and unknown static/health paths.
    if (
      !isApiRequest(request) &&
      !['GET', 'HEAD'].includes(request.method) &&
      !(request.method === 'POST' && adminPostRoutes.has(request.routeOptions.url ?? ''))
    )
      return reply.code(404).send({ code: 'NOT_FOUND' });
  });
  const rateLimiter = registerRateLimits(app, config);
  registerIdentity(app, config);
  let inFlight = 0;
  app.decorateRequest('holdsApiSlot', false);
  app.decorateRequest('pendingApiWork', 0);
  app.decorateRequest('apiResponseFinished', false);
  const release = (request: FastifyRequest) => {
    if (!request.holdsApiSlot || request.pendingApiWork > 0) return;
    request.holdsApiSlot = false;
    inFlight--;
  };
  const finishResponse = (request: FastifyRequest) => {
    request.apiResponseFinished = true;
    release(request);
  };
  const runApiWork = async <T>(request: FastifyRequest, work: () => T | Promise<T>) => {
    request.pendingApiWork++;
    const pending = Promise.resolve().then(work);
    activeWork.add(pending);
    try {
      return await pending;
    } finally {
      activeWork.delete(pending);
      request.pendingApiWork--;
      if (request.apiResponseFinished) release(request);
    }
  };
  app.addHook('onRequest', async (request, reply) => {
    if (!isApiRequest(request)) return;
    if (inFlight >= 16) throw new DomainError('SERVER_BUSY', 503);
    request.holdsApiSlot = true;
    inFlight++;
    // Closing a response does not cancel storage or push work. Keep its slot
    // until that work settles, including handlers that reject after disconnect.
    reply.raw.once('close', () => finishResponse(request));
  });
  app.addHook('onResponse', async (request) => finishResponse(request));
  app.addHook('onRequestAbort', async (request) => finishResponse(request));
  app.addHook('onTimeout', async (request, reply) => {
    finishResponse(request);
    reply.raw.destroy();
  });
  app.addHook('onRoute', (route) => {
    if (!route.url.startsWith('/api/')) return;
    const handler = route.handler;
    route.handler = async function (request, reply) {
      if (request.apiResponseFinished) {
        reply.hijack();
        return;
      }
      return runApiWork(request, () => handler.call(this, request, reply));
    };
  });
  const push = registerNotifications(app, config, store, options.notifications, budget);
  registerAdmin(app, config, store, budget.database, push, userCreation, rateLimiter);
  registerClientVersion(app, budget.database);
  const bootstrap = (document: Awaited<ReturnType<SqliteStore['read']>>) => ({
    document,
    dailyHistoryDays: config.dailyHistoryDays,
  });
  const revision = (headers: Record<string, unknown>) => {
    const value = headers['if-match'];
    if (typeof value !== 'string' || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)))
      throw new DomainError('REVISION_REQUIRED', 428);
    return Number(value);
  };
  // Reject missing revisions and closed-profile creation before reading/parsing
  // attacker-supplied JSON. Route identity also covers encoded API paths.
  app.addHook('onRequest', async (request, reply) => {
    if (request.routeOptions.url !== '/api/sync' || request.method !== 'PUT') return;
    await runApiWork(request, async () => {
      revision(request.headers);
      if (!(await store.exists(request.userId))) {
        if (await store.deleted(request.userId)) throw new DomainError('PROFILE_DELETED', 410);
        if (!userCreation.allowed()) throw new DomainError('USER_CREATION_DISABLED', 403);
        if (!rateLimiter.admitUser(request.ip))
          return reply
            .code(429)
            .header('Retry-After', String(config.rateLimitWindowSeconds))
            .send({ code: 'RATE_LIMITED' });
      }
    });
    if (request.apiResponseFinished) reply.hijack();
  });
  app.get('/health', async () => ({ status: 'ok' }));
  app.get('/api/bootstrap', async (request) =>
    bootstrap(await store.read(request.userId, userCreation.allowed())),
  );
  app.post('/api/local-user', async (request) => {
    const { userId } = z.object({ userId: localUserIdSchema }).strict().parse(request.body);
    if (userId !== request.userId) throw new DomainError('ACCOUNT_CHANGED', 409);
    return bootstrap(await store.readExisting(request.userId));
  });
  app.put('/api/sync', async (request) => {
    const expectedRevision = revision(request.headers);
    const identity = z
      .object({ userId: localUserIdSchema, revision: z.number().int().nonnegative() })
      .parse(request.body);
    if (identity.userId !== request.userId) throw new DomainError('ACCOUNT_CHANGED', 409);
    if (identity.revision !== expectedRevision) throw new DomainError('DOCUMENT_CONFLICT', 409);
    if (!documentWithinLimits(request.body)) throw new DomainError('DOCUMENT_LIMIT', 413);
    const result = await store.update(
      request.userId,
      (doc) => {
        const incoming = syncDocumentSchema.parse(request.body);
        const received = new Map(
          doc.gifts.filter((gift) => gift.claimedAt).map((gift) => [gift.id, gift]),
        );
        incoming.gifts = incoming.gifts.map((gift) => {
          const saved = received.get(gift.id);
          return saved ? { ...saved, archivedAt: saved.archivedAt || gift.archivedAt } : gift;
        });
        Object.assign(doc, received.size ? syncDocumentSchema.parse(incoming) : incoming);
      },
      expectedRevision,
      userCreation.allowed(),
    );
    return bootstrap(result.document);
  });
  const hasWeb = await access(config.webDir).then(
    () => true,
    () => false,
  );
  if (hasWeb) {
    await app.register(fastifyStatic, {
      root: config.webDir,
      index: 'index.html',
      setHeaders(response, path) {
        if (path.endsWith('sw.js') || path.endsWith('index.html'))
          response.header('Cache-Control', 'no-cache');
      },
    });
    app.setNotFoundHandler((request, reply) => {
      if (
        request.method === 'GET' &&
        !isApiRequest(request) &&
        !request.url.startsWith('/auth/') &&
        !request.url.split('?')[0]!.includes('.')
      )
        return reply.type('text/html').sendFile('index.html');
      return reply.code(404).send({ code: 'NOT_FOUND' });
    });
  }
  return app;
}
