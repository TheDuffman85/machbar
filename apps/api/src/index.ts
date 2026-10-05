import { readConfig } from './config.js';
import { buildServer } from './server.js';
import { fileURLToPath } from 'node:url';
try {
  process.loadEnvFile(fileURLToPath(new URL('../../../.env', import.meta.url)));
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
}
const config = readConfig();
const app = await buildServer({ config, logger: true });
const shutdown = async () => {
  await app.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
await app.listen({ host: config.host, port: config.port });
