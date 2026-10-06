import type { FastifyInstance } from 'fastify';
import { DomainError, localUserIdSchema } from '@machbar/shared';
import type { Config } from './config.js';
import { isApiRequest } from './api-request.js';

declare module 'fastify' {
  interface FastifyRequest {
    userId: string;
  }
}

export function registerIdentity(app: FastifyInstance, config: Config) {
  app.decorateRequest('userId', '');
  app.addHook('onRequest', async (request) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      // Vite preserves the browser-facing Host when proxying requests. Accept
      // LAN addresses while retaining same-origin checks for profile writes.
      const sameOrigin =
        request.headers.origin === config.appUrl ||
        request.headers.origin === `${request.protocol}://${request.headers.host}`;
      if (!sameOrigin || request.headers['sec-fetch-site'] === 'cross-site')
        throw new DomainError('ORIGIN_REJECTED', 403);
    }
    if (isApiRequest(request)) {
      const identity = localUserIdSchema.safeParse(request.headers['x-machbar-user']);
      if (!identity.success)
        throw new DomainError(
          'INVALID_IDENTITY',
          request.headers['x-machbar-user'] === undefined ? 401 : 400,
        );
      request.userId = identity.data;
    }
  });
}
