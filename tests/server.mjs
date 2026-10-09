import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildServer } from '../apps/api/dist/server.js';
import { DatabaseSync } from 'node:sqlite';
import { databaseFilename } from '../apps/api/dist/database.js';
import { SqliteStore } from '../apps/api/dist/store.js';
import { readConfig } from '../apps/api/dist/config.js';
import { hashAdminPassword } from '../apps/api/dist/hash-admin-password.js';
import { UserCreation } from '../apps/api/dist/user-creation.js';
import { userDocumentSchema } from '../packages/shared/dist/index.js';
const directory = await mkdtemp(join(tmpdir(), 'machbar-browser-'));
const store = new SqliteStore(directory);
const config = {
  ...readConfig({
    APP_URL: 'http://localhost:3100',
    DISABLE_USER_CREATION: 'false',
    // Browser tests share one IP; rate enforcement has dedicated API tests.
    RATE_LIMIT_MAX_PER_IP: '100000',
    RATE_LIMIT_MAX_PER_USER: '100000',
    RATE_LIMIT_MAX_NEW_USERS: '100000',
    ADMIN_PASSWORD_HASH: await hashAdminPassword('browser-test-admin'),
  }),
  dataDir: directory,
  webDir: resolve('apps/web/dist'),
};
const userCreation = new UserCreation(config);
const app = await buildServer({ config, store, userCreation });
// Test-only fixtures. These routes are never included in the production server.
app.post('/api/test/config', async (request) => {
  config.disableUserCreation = request.body.disableUserCreation === true;
  return { ok: true };
});
app.post('/api/test/reset', async () => {
  config.disableUserCreation = false;
  userCreation.close();
  const database = new DatabaseSync(join(directory, databaseFilename));
  try {
    database.exec(`PRAGMA foreign_keys = ON; BEGIN;
      DELETE FROM completions; DELETE FROM gifts; DELETE FROM profiles; DELETE FROM deleted_profiles;
      DELETE FROM push_bindings; DELETE FROM push_dispatches; DELETE FROM push_state; COMMIT;`);
  } finally {
    database.close();
  }
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
