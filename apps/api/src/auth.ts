import { createHash, randomBytes } from 'node:crypto';
import secureSession from '@fastify/secure-session';
import * as oidc from 'openid-client';
import type { FastifyInstance } from 'fastify';
import { DomainError } from '@machbar/shared';
import type { Config } from './config.js';
import { identityKey, type JsonStore } from './store.js';

declare module '@fastify/secure-session' {
  interface SessionData {
    userId: string;
    expiresAt: number;
    transaction: { id: string; state: string; nonce: string; verifier: string; expiresAt: number };
  }
}
declare module 'fastify' {
  interface FastifyRequest {
    userId: string;
  }
}
export interface OidcAdapter {
  authorization(transaction: { state: string; nonce: string; verifier: string }): Promise<string>;
  exchange(
    url: URL,
    transaction: { state: string; nonce: string; verifier: string },
  ): Promise<{ issuer: string; subject: string; name?: string }>;
}
async function realAdapter(config: Config): Promise<OidcAdapter> {
  const provider = await oidc.discovery(
    new URL(config.oidc!.issuer),
    config.oidc!.clientId,
    config.oidc!.clientSecret,
  );
  return {
    async authorization(tx) {
      return oidc.buildAuthorizationUrl(provider, {
        redirect_uri: `${config.appUrl}/auth/callback`,
        scope: 'openid profile',
        state: tx.state,
        nonce: tx.nonce,
        code_challenge: await oidc.calculatePKCECodeChallenge(tx.verifier),
        code_challenge_method: 'S256',
      }).href;
    },
    async exchange(url, tx) {
      const tokens = await oidc.authorizationCodeGrant(provider, url, {
        pkceCodeVerifier: tx.verifier,
        expectedState: tx.state,
        expectedNonce: tx.nonce,
        idTokenExpected: true,
      });
      const claims = tokens.claims();
      if (!claims?.sub || claims.iss !== config.oidc!.issuer)
        throw new DomainError('AUTH_FAILED', 401);
      return {
        issuer: claims.iss,
        subject: claims.sub,
        name: typeof claims.name === 'string' ? claims.name : undefined,
      };
    },
  };
}
export async function registerAuth(
  app: FastifyInstance,
  config: Config,
  store: JsonStore,
  injectedAdapter?: OidcAdapter,
) {
  await app.register(secureSession, {
    key: createHash('sha256').update(config.sessionSecret).digest(),
    cookieName: 'machbar_session',
    expiry: 7 * 86400,
    cookie: {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: config.appUrl.startsWith('https:'),
      maxAge: 7 * 86400,
    },
  });
  app.decorateRequest('userId', '');
  app.addHook('onRequest', async (request) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      // Vite preserves the browser-facing Host when proxying requests. Single-user
      // deployments can use their LAN address while retaining same-origin checks.
      const sameOrigin =
        request.headers.origin === config.appUrl ||
        (!config.oidc &&
          request.headers.origin === `${request.protocol}://${request.headers.host}`);
      if (!sameOrigin || request.headers['sec-fetch-site'] === 'cross-site')
        throw new DomainError('ORIGIN_REJECTED', 403);
    }
    if (request.url.startsWith('/api/')) {
      if (!config.oidc) request.userId = 'local';
      else {
        const userId = request.session.get('userId');
        const expiresAt = request.session.get('expiresAt');
        if (!userId || !expiresAt || expiresAt <= Date.now())
          throw new DomainError('AUTH_REQUIRED', 401);
        request.userId = userId;
      }
      if (
        !['GET', 'HEAD', 'OPTIONS'].includes(request.method) &&
        request.headers['x-machbar-user'] !== request.userId
      )
        throw new DomainError('ACCOUNT_CHANGED', 409);
    }
  });
  // Transactions are one-use and expire. They contain no provider tokens.
  const transactions = new Map<string, number>();
  const adapter = config.oidc ? (injectedAdapter ?? (await realAdapter(config))) : undefined;
  app.get('/auth/config', async () => ({ mode: config.oidc ? 'oidc' : 'single' }));
  app.get('/auth/login', async (request, reply) => {
    if (!adapter) return reply.redirect('/');
    for (const [id, expiry] of transactions) if (expiry < Date.now()) transactions.delete(id);
    const transaction = {
      id: randomBytes(24).toString('hex'),
      state: oidc.randomState(),
      nonce: oidc.randomNonce(),
      verifier: oidc.randomPKCECodeVerifier(),
      expiresAt: Date.now() + 10 * 60_000,
    };
    transactions.set(transaction.id, transaction.expiresAt);
    request.session.set('transaction', transaction);
    return reply.redirect(await adapter.authorization(transaction));
  });
  app.get('/auth/callback', async (request, reply) => {
    const transaction = request.session.get('transaction');
    request.session.set('transaction', undefined);
    if (
      !adapter ||
      !transaction ||
      transaction.expiresAt < Date.now() ||
      !transactions.delete(transaction.id)
    )
      return reply.redirect('/?authError=1');
    try {
      const callback = new URL(request.url, config.appUrl);
      if (callback.searchParams.get('state') !== transaction.state)
        throw new DomainError('AUTH_FAILED', 401);
      const identity = await adapter.exchange(callback, transaction);
      if (identity.issuer !== config.oidc!.issuer || !identity.subject)
        throw new DomainError('AUTH_FAILED', 401);
      const userId = identityKey(identity.issuer, identity.subject);
      await store.update(userId, (doc) => {
        if (!doc.preferences.onboarded && identity.name)
          doc.preferences.name = identity.name.slice(0, 60);
      });
      request.session.regenerate();
      request.session.set('userId', userId);
      request.session.set('expiresAt', Date.now() + 7 * 86400_000);
      return reply.redirect('/');
    } catch (error) {
      app.log.warn({ err: error }, 'OIDC callback failed');
      return reply.redirect('/?authError=1');
    }
  });
  app.post('/auth/logout', async (request, reply) => {
    request.session.delete();
    return reply.send({ ok: true });
  });
}
