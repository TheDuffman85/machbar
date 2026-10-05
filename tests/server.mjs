import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildServer } from '../apps/api/dist/server.js';
import { readConfig } from '../apps/api/dist/config.js';
const root = await mkdtemp(join(tmpdir(), 'machbar-browser-'));
const apps = [];
for (const [port, mode] of [
  [3100, 'single'],
  [3101, 'oidc'],
]) {
  const appUrl = `http://localhost:${port}`,
    directory = join(root, mode);
  const config = {
    ...readConfig({ APP_URL: appUrl }),
    dataDir: directory,
    webDir: resolve('apps/web/dist'),
  };
  if (mode === 'oidc')
    config.oidc = {
      issuer: 'https://test-identity.example',
      clientId: 'test',
      clientSecret: 'test',
    };
  const app = await buildServer({
    config,
    oidcAdapter: {
      async authorization(tx) {
        return `${appUrl}/test/identity?state=${tx.state}&nonce=${tx.nonce}`;
      },
      async exchange(url, tx) {
        if (url.searchParams.get('nonce') !== tx.nonce) throw new Error('Invalid nonce');
        return {
          issuer: config.oidc.issuer,
          subject: url.searchParams.get('code'),
          name: url.searchParams.get('code'),
        };
      },
    },
  });
  // Test-only fixtures. These routes are never included in the production server.
  app.post('/test/reset', async () => {
    await rm(directory, { recursive: true, force: true });
    await mkdir(directory, { recursive: true });
    return { ok: true };
  });
  if (mode === 'oidc')
    app.get('/test/identity', async (request, reply) => {
      const query = new URL(request.url, appUrl).searchParams;
      const state = encodeURIComponent(query.get('state') ?? ''),
        nonce = encodeURIComponent(query.get('nonce') ?? '');
      return reply
        .type('text/html')
        .send(
          `<html lang="en"><head><title>Test identity</title></head><body><h1>Test identity provider</h1><a href="/auth/callback?code=Alice&state=${state}&nonce=${nonce}">Alice</a><a href="/auth/callback?code=Bob&state=${state}&nonce=${nonce}">Bob</a></body></html>`,
        );
    });
  await app.listen({ host: '127.0.0.1', port });
  apps.push(app);
}
const shutdown = async () => {
  await Promise.all(apps.map((app) => app.close()));
  await rm(root, { recursive: true, force: true });
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
