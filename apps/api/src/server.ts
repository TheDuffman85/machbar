import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { access } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  addDays,
  applyCompletion,
  completionOperationSchema,
  DomainError,
  giftInputSchema,
  goalInputSchema,
  habitInputSchema,
  localDate,
  preferencesSchema,
  progressFor,
  stepInputSchema,
} from '@machbar/shared';
import { type Config, readConfig } from './config.js';
import { JsonStore } from './store.js';
import { registerAuth, type OidcAdapter } from './auth.js';

export async function buildServer(
  options: { config?: Config; store?: JsonStore; oidcAdapter?: OidcAdapter; logger?: boolean } = {},
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
    bodyLimit: 64 * 1024,
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
    if (request.url.startsWith('/api/') || request.url.startsWith('/auth/'))
      reply.header('Cache-Control', 'no-store');
    return payload;
  });
  await registerAuth(app, config, store, options.oidcAdapter);
  const bootstrap = (document: Awaited<ReturnType<JsonStore['read']>>) => ({
    document,
    progress: progressFor(document),
    authMode: config.oidc ? 'oidc' : 'single',
    today: localDate(document.preferences.timezone),
  });
  const revision = (headers: Record<string, unknown>) => {
    const value = headers['if-match'];
    if (typeof value !== 'string' || !/^\d+$/.test(value))
      throw new DomainError('REVISION_REQUIRED', 428);
    return Number(value);
  };
  const params = (value: unknown) => z.object({ id: z.string().uuid() }).parse(value).id;
  app.get('/health', async () => ({ status: 'ok' }));
  app.get('/api/bootstrap', async (request) => bootstrap(await store.read(request.userId)));
  app.patch('/api/preferences', async (request) => {
    const input = preferencesSchema.partial().strict().parse(request.body);
    const result = await store.update(
      request.userId,
      (doc) => {
        if (input.timezone && input.timezone !== doc.preferences.timezone) {
          const from = addDays(localDate(doc.preferences.timezone), 1);
          for (const habit of doc.habits.filter((h) => !h.archivedAt)) {
            const latest = habit.schedules.at(-1)!;
            const schedule = { from, weekdays: latest.weekdays, timezone: input.timezone };
            if (latest.from === from) habit.schedules[habit.schedules.length - 1] = schedule;
            else habit.schedules.push(schedule);
          }
        }
        Object.assign(doc.preferences, input);
      },
      revision(request.headers),
    );
    return bootstrap(result.document);
  });
  app.post('/api/habits', async (request) => {
    const { weekdays, ...input } = habitInputSchema.parse(request.body);
    const result = await store.update(
      request.userId,
      (doc) => {
        doc.habits.push({
          ...input,
          id: randomUUID(),
          archivedAt: null,
          schedules: [
            {
              from: localDate(doc.preferences.timezone),
              weekdays,
              timezone: doc.preferences.timezone,
            },
          ],
        });
      },
      revision(request.headers),
    );
    return bootstrap(result.document);
  });
  app.patch('/api/habits/:id', async (request) => {
    const id = params(request.params);
    const { weekdays, ...input } = habitInputSchema.parse(request.body);
    const result = await store.update(
      request.userId,
      (doc) => {
        const habit = doc.habits.find((h) => h.id === id && !h.archivedAt);
        if (!habit) throw new DomainError('NOT_FOUND', 404);
        Object.assign(habit, input);
        const latest = habit.schedules.at(-1)!;
        if (JSON.stringify([...latest.weekdays].sort()) !== JSON.stringify([...weekdays].sort())) {
          const from = addDays(localDate(doc.preferences.timezone), 1);
          const schedule = { from, weekdays, timezone: doc.preferences.timezone };
          if (latest.from === from) habit.schedules[habit.schedules.length - 1] = schedule;
          else habit.schedules.push(schedule);
        }
      },
      revision(request.headers),
    );
    return bootstrap(result.document);
  });
  app.post('/api/goals', async (request) => {
    const input = goalInputSchema.parse(request.body);
    const result = await store.update(
      request.userId,
      (doc) => {
        doc.goals.push({ ...input, id: randomUUID(), steps: [], archivedAt: null });
      },
      revision(request.headers),
    );
    return bootstrap(result.document);
  });
  app.patch('/api/goals/:id', async (request) => {
    const id = params(request.params),
      input = goalInputSchema.parse(request.body);
    const result = await store.update(
      request.userId,
      (doc) => {
        const goal = doc.goals.find((g) => g.id === id && !g.archivedAt);
        if (!goal) throw new DomainError('NOT_FOUND', 404);
        Object.assign(goal, input);
      },
      revision(request.headers),
    );
    return bootstrap(result.document);
  });
  app.post('/api/goals/:id/steps', async (request) => {
    const id = params(request.params),
      input = stepInputSchema.parse(request.body);
    const result = await store.update(
      request.userId,
      (doc) => {
        const goal = doc.goals.find((g) => g.id === id && !g.archivedAt);
        if (!goal) throw new DomainError('NOT_FOUND', 404);
        goal.steps.push({ ...input, id: randomUUID(), archivedAt: null });
      },
      revision(request.headers),
    );
    return bootstrap(result.document);
  });
  app.patch('/api/steps/:id', async (request) => {
    const id = params(request.params),
      input = stepInputSchema.parse(request.body);
    const result = await store.update(
      request.userId,
      (doc) => {
        const goal = doc.goals.find((g) => !g.archivedAt && g.steps.some((s) => s.id === id));
        const step = goal?.steps.find((s) => s.id === id && !s.archivedAt);
        if (!step) throw new DomainError('NOT_FOUND', 404);
        Object.assign(step, input);
      },
      revision(request.headers),
    );
    return bootstrap(result.document);
  });
  app.put('/api/goals/:id/order', async (request) => {
    const id = params(request.params),
      order = z.array(z.string().uuid()).max(1000).parse(request.body);
    const result = await store.update(
      request.userId,
      (doc) => {
        const goal = doc.goals.find((g) => g.id === id && !g.archivedAt);
        if (!goal) throw new DomainError('NOT_FOUND', 404);
        if (
          order.length !== goal.steps.length ||
          new Set(order).size !== order.length ||
          order.some((id) => !goal.steps.some((s) => s.id === id))
        )
          throw new DomainError('VALIDATION_ERROR');
        goal.steps = order.map((id) => goal.steps.find((s) => s.id === id)!);
      },
      revision(request.headers),
    );
    return bootstrap(result.document);
  });
  for (const kind of ['habits', 'goals', 'steps', 'gifts'] as const) {
    app.delete(`/api/${kind}/:id`, async (request) => {
      const id = params(request.params);
      const result = await store.update(
        request.userId,
        (doc) => {
          const items =
            kind === 'steps'
              ? doc.goals.filter((g) => !g.archivedAt).flatMap((g) => g.steps)
              : doc[kind];
          const item = items.find((i) => i.id === id);
          if (!item) throw new DomainError('NOT_FOUND', 404);
          item.archivedAt = new Date().toISOString();
        },
        revision(request.headers),
      );
      return bootstrap(result.document);
    });
  }
  app.post('/api/completions', async (request) => {
    const operation = completionOperationSchema.parse(request.body);
    const result = await store.update(request.userId, (doc) => applyCompletion(doc, operation));
    return { ...bootstrap(result.document), completionVersion: result.result };
  });
  app.post('/api/gifts', async (request) => {
    const input = giftInputSchema.parse(request.body);
    const result = await store.update(
      request.userId,
      (doc) => {
        if (
          !(input.targetType === 'goal' ? doc.goals : doc.habits).some(
            (item) => item.id === input.targetId && !item.archivedAt,
          )
        )
          throw new DomainError('NOT_FOUND', 404);
        doc.gifts.push({
          ...input,
          threshold: input.targetType === 'goal' ? 1 : input.threshold,
          id: randomUUID(),
          claimedAt: null,
          archivedAt: null,
        });
      },
      revision(request.headers),
    );
    return bootstrap(result.document);
  });
  app.post('/api/gifts/:id/claim', async (request) => {
    const id = params(request.params);
    const result = await store.update(
      request.userId,
      (doc) => {
        const gift = doc.gifts.find((g) => g.id === id && !g.archivedAt);
        if (!gift) throw new DomainError('NOT_FOUND', 404);
        if (progressFor(doc).gifts[id]!.state === 'locked')
          throw new DomainError('GIFT_LOCKED', 409);
        gift.claimedAt ??= new Date().toISOString();
      },
      revision(request.headers),
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
        !request.url.startsWith('/api/') &&
        !request.url.startsWith('/auth/') &&
        !request.url.split('?')[0]!.includes('.')
      )
        return reply.type('text/html').sendFile('index.html');
      return reply.code(404).send({ code: 'NOT_FOUND' });
    });
  }
  return app;
}
