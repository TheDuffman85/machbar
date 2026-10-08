import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { preferencesSchema } from '@machbar/shared';
import { readConfig, type Config } from './config.js';
import { StorageBudget } from './storage-budget.js';
import { SqliteStore } from './store.js';

// Administrator-only provisioning: run with the server stopped so one process
// owns the data directory and its quotas. This is never exposed as an API route.
export async function provisionUser(config: Config, name = 'Friend'): Promise<string> {
  const validName = preferencesSchema.shape.name.parse(name);
  const userId = randomUUID();
  const store = new SqliteStore(config.dataDir, new StorageBudget(config.dataDir, config));
  try {
    await store.update(userId, (doc) => {
      doc.preferences.name = validName;
    });
    return userId;
  } finally {
    await store.close();
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    process.loadEnvFile(fileURLToPath(new URL('../../../.env', import.meta.url)));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (process.argv.length > 3) throw new Error('Usage: node provision-user.js [name]');
  console.log(await provisionUser(readConfig(), process.argv[2]));
}
