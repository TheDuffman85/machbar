import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildServer } from '../apps/api/dist/server.js';
import { JsonStore } from '../apps/api/dist/store.js';
import { readConfig } from '../apps/api/dist/config.js';
import { userDocumentSchema } from '../packages/shared/dist/index.js';
const directory = await mkdtemp(join(tmpdir(), 'machbar-browser-'));
const store = new JsonStore(directory);
const config = {
  ...readConfig({
    APP_URL: 'http://localhost:3100',
    DISABLE_USER_CREATION: 'false',
    // Browser tests share one IP; rate enforcement has dedicated API tests.
    RATE_LIMIT_MAX_PER_IP: '100000',
    RATE_LIMIT_MAX_PER_USER: '100000',
    RATE_LIMIT_MAX_NEW_USERS: '100000',
  }),
  dataDir: directory,
  webDir: resolve('apps/web/dist'),
};
const app = await buildServer({ config, store });
// Test-only fixtures. These routes are never included in the production server.
app.post('/api/test/config', async (request) => {
  config.disableUserCreation = request.body.disableUserCreation === true;
  return { ok: true };
});
app.post('/api/test/reset', async () => {
  config.disableUserCreation = false;
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
  return { ok: true };
});
app.post('/api/test/seed', async (request) => {
  const document = userDocumentSchema.parse(request.body);
  await store.update(document.userId, (doc) => Object.assign(doc, document));
  return { ok: true };
});
await app.listen({ host: '127.0.0.1', port: 3100 });
const shutdown = async () => {
  await app.close();
  await rm(directory, { recursive: true, force: true });
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
