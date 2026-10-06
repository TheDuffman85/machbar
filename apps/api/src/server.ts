import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { access } from 'node:fs/promises';
import { z } from 'zod';
import { DomainError, localUserIdSchema, syncDocumentSchema } from '@machbar/shared';
import { type Config, readConfig } from './config.js';
import { JsonStore } from './store.js';
import { registerIdentity } from './identity.js';
import { registerRateLimits } from './rate-limit.js';
import { isApiRequest } from './api-request.js';

export async function buildServer(
  options: { config?: Config; store?: JsonStore; logger?: boolean } = {},
) {
  const config = options.config ?? readConfig();
  const store = options.store ?? new JsonStore(config.dataDir);
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
    bodyLimit: 8 * 1024 * 1024,
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
  registerRateLimits(app, config);
  registerIdentity(app, config);
  const bootstrap = (document: Awaited<ReturnType<JsonStore['read']>>) => ({
    document,
    dailyHistoryDays: config.dailyHistoryDays,
  });
  const revision = (headers: Record<string, unknown>) => {
    const value = headers['if-match'];
    if (typeof value !== 'string' || !/^\d+$/.test(value))
      throw new DomainError('REVISION_REQUIRED', 428);
    return Number(value);
  };
  app.get('/health', async () => ({ status: 'ok' }));
  app.get('/api/bootstrap', async (request) =>
    bootstrap(await store.read(request.userId, !config.disableUserCreation)),
  );
  app.post('/api/local-user', async (request) => {
    const { userId } = z.object({ userId: localUserIdSchema }).strict().parse(request.body);
    if (userId !== request.userId) throw new DomainError('ACCOUNT_CHANGED', 409);
    return bootstrap(await store.readExisting(request.userId));
  });
  app.put('/api/sync', async (request) => {
    const document = syncDocumentSchema.parse(request.body);
    if (document.userId !== request.userId) throw new DomainError('ACCOUNT_CHANGED', 409);
    const expectedRevision = revision(request.headers);
    if (document.revision !== expectedRevision) throw new DomainError('DOCUMENT_CONFLICT', 409);
    const result = await store.update(
      request.userId,
      (doc) => {
        Object.assign(doc, document);
      },
      expectedRevision,
      !config.disableUserCreation,
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
          response.setHeader('Cache-Control', 'no-cache');
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
