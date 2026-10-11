import type { FastifyInstance } from 'fastify';
import type { SqliteDatabase } from './database.js';
import { isApiRequest } from './api-request.js';

// Build versions look like 1.0.0+20261011120000123; anything else is ignored.
const versionPattern = /^[\w.+-]{1,64}$/;

// Remembers the app build that last called the API per profile, for the admin page.
// Older clients send no header. Only successful requests count, so rejected and
// rate-limited ones never write, and each profile is written once per new version.
export function registerClientVersion(app: FastifyInstance, database: SqliteDatabase) {
  const recorded = new Map<string, string>();
  app.addHook('onResponse', async (request, reply) => {
    const version = request.headers['x-machbar-version'];
    if (
      !isApiRequest(request) ||
      !request.userId ||
      reply.statusCode >= 400 ||
      typeof version !== 'string' ||
      !versionPattern.test(version) ||
      recorded.get(request.userId) === version
    )
      return;
    try {
      // Nothing changes before the first sync creates the profile row.
      if (await database.recordClientVersion(request.userId, version))
        recorded.set(request.userId, version);
    } catch (error) {
      request.log.warn({ err: error }, 'Could not record the client version');
    }
  });
}
