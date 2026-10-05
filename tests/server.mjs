import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildServer } from '../apps/api/dist/server.js';
import { JsonStore } from '../apps/api/dist/store.js';
import { readConfig } from '../apps/api/dist/config.js';
import { userDocumentSchema } from '../packages/shared/dist/index.js';
const directory = await mkdtemp(join(tmpdir(), 'machbar-browser-'));
const store = new JsonStore(directory);
const app = await buildServer({
  config: {
    ...readConfig({ APP_URL: 'http://localhost:3100' }),
    dataDir: directory,
    webDir: resolve('apps/web/dist'),
  },
  store,
});
// Test-only fixtures. These routes are never included in the production server.
app.post('/test/reset', async () => {
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
  return { ok: true };
});
app.post('/test/seed', async (request) => {
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
