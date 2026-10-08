import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createUser } from '@machbar/shared';
import { readConfig, type Config } from './config.js';
import { buildServer } from './server.js';
import { provisionUser } from './provision-user.js';

let directory: string;
let config: Config;
beforeEach(async () => {
  directory = await mkdtemp('/tmp/machbar-provision-');
  config = { ...readConfig({}), dataDir: directory, webDir: join(directory, 'absent') };
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe('administrator profile provisioning', () => {
  it('creates distinct private profiles without opening public registration', async () => {
    const first = await provisionUser(config, ' Alice ');
    const second = await provisionUser(config);
    expect(first).not.toBe(second);
    const profile = JSON.parse(await readFile(join(directory, `${first}.json`), 'utf8'));
    expect(profile).toEqual({
      ...createUser(first),
      revision: 1,
      preferences: { ...createUser(first).preferences, name: 'Alice' },
    });
    expect((await stat(join(directory, `${first}.json`))).mode & 0o777).toBe(0o600);
    expect(config.disableUserCreation).toBe(true);
  });
  it('rejects invalid names and enforces persistent provisioning quotas', async () => {
    await expect(provisionUser(config, '')).rejects.toThrow();
    expect(await readdir(directory)).toEqual([]);
    config.maxProfiles = 1;
    await provisionUser(config);
    await expect(provisionUser(config)).rejects.toMatchObject({ code: 'PROFILE_LIMIT' });
    expect(await readdir(directory)).toHaveLength(1);
  });
  it('denies outsider uploads by default and keeps provisioned profiles editable after restart', async () => {
    config.maxStorageBytes = 2000;
    const userId = await provisionUser(config);
    for (let restart = 0; restart < 2; restart++) {
      const app = await buildServer({ config });
      try {
        const outsider = createUser(randomUUID());
        outsider.operations[randomUUID()] = { fingerprint: 'x'.repeat(2048), version: 1 };
        const rejected = await app.inject({
          method: 'PUT',
          url: '/api/sync',
          headers: {
            origin: config.appUrl,
            'x-machbar-user': outsider.userId,
            'if-match': '0',
          },
          payload: outsider,
        });
        expect(rejected.statusCode).toBe(403);
        expect(rejected.json()).toEqual({ code: 'USER_CREATION_DISABLED' });
        const missing = await app.inject({
          url: '/api/bootstrap',
          headers: { 'x-machbar-user': outsider.userId },
        });
        expect(missing.statusCode).toBe(403);
        const bootstrap = await app.inject({
          url: '/api/bootstrap',
          headers: { 'x-machbar-user': userId },
        });
        expect(bootstrap.statusCode).toBe(200);
        const { document } = bootstrap.json();
        document.operations[randomUUID()] = { fingerprint: 'Saved work', version: 1 };
        const saved = await app.inject({
          method: 'PUT',
          url: '/api/sync',
          headers: {
            origin: config.appUrl,
            'x-machbar-user': userId,
            'if-match': String(document.revision),
          },
          payload: document,
        });
        expect(saved.statusCode).toBe(200);
        expect(await readdir(directory)).toEqual([`${userId}.json`]);
      } finally {
        await app.close();
      }
    }
  });
});
