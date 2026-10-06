import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const image = 'machbar:docker-test';
const directory = mkdtempSync(join(tmpdir(), 'machbar-docker-'));
const container = `machbar-docker-${randomUUID()}`;
const userId = randomUUID();
const mount = ['--mount', `type=bind,src=${directory},dst=/app/data`];
const security = [
  '--read-only',
  '--tmpfs',
  '/tmp',
  '--security-opt',
  'no-new-privileges:true',
  '--cap-drop',
  'ALL',
];
const capabilities = ['CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'SETUID', 'SETGID'].flatMap((cap) => [
  '--cap-add',
  cap,
]);
const docker = (args) => execFileSync('docker', args, { encoding: 'utf8' });
let imageBuilt = false;
let containerCreated = false;
const nodeCheck = `
  const assert = require('node:assert/strict');
  const fs = require('node:fs');
  assert.equal(process.getuid(), 1000);
  assert.equal(process.getgid(), 1000);
  const status = fs.readFileSync('/proc/self/status', 'utf8');
  assert.match(status, /^CapEff:\\s+0+$/m);
`;

try {
  execFileSync('docker', ['build', '-t', image, '.'], { stdio: 'inherit' });
  imageBuilt = true;

  // Reproduce unreadable existing profiles and a directory owned by root.
  docker([
    'run',
    '--rm',
    '--user',
    '0:0',
    '--entrypoint',
    'node',
    ...mount,
    image,
    '--input-type=module',
    '-e',
    `
      import { createUser } from '/app/api/node_modules/@machbar/shared/dist/index.js';
      import { writeFileSync, chmodSync, chownSync, symlinkSync } from 'node:fs';
      const doc = createUser('${userId}');
      doc.preferences.name = 'Existing profile';
      const profile = '/app/data/${userId}.json';
      writeFileSync(profile, JSON.stringify(doc));
      chmodSync(profile, 0);
      writeFileSync('/app/data/untouched.txt', 'keep original ownership and permissions');
      chmodSync('/app/data/untouched.txt', 0o444);
      symlinkSync('untouched.txt', '/app/data/symlink.json');
      chownSync('/app/data', 0, 0);
      chmodSync('/app/data', 0);
    `,
  ]);

  // Starting directly as node cannot repair an inaccessible mount.
  assert.throws(
    () => docker(['run', '--rm', '--user', '1000:1000', ...security, ...mount, image, 'true']),
    (error) => error.status !== 0 && /DATA_DIR.*not writable/.test(error.stderr),
  );

  docker(['run', '-d', '--name', container, ...security, ...capabilities, ...mount, image]);
  containerCreated = true;
  docker([
    'exec',
    '--user',
    '1000:1000',
    container,
    'node',
    '--input-type=module',
    '-e',
    `
      import assert from 'node:assert/strict';
      import { readFileSync } from 'node:fs';
      const status = readFileSync('/proc/1/status', 'utf8');
      assert.match(status, /^Uid:\\s+1000\\s+1000\\s+1000\\s+1000$/m);
      assert.match(status, /^Gid:\\s+1000\\s+1000\\s+1000\\s+1000$/m);
      assert.match(status, /^CapEff:\\s+0+$/m);
      for (let attempt = 0; ; attempt++) {
        try {
          assert.equal((await fetch('http://localhost:3000/health')).status, 200);
          break;
        } catch (error) {
          if (attempt === 100) throw error;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
      const headers = { 'X-Machbar-User': '${userId}' };
      const loaded = await fetch('http://localhost:3000/api/bootstrap', { headers });
      assert.equal(loaded.status, 200);
      const { document } = await loaded.json();
      assert.equal(document.preferences.name, 'Existing profile');
      document.preferences.name = 'Synced profile';
      const saved = await fetch('http://localhost:3000/api/sync', {
        method: 'PUT',
        headers: {
          ...headers,
          Origin: 'http://localhost:3000',
          'Content-Type': 'application/json',
          'If-Match': String(document.revision),
        },
        body: JSON.stringify(document),
      });
      assert.equal(saved.status, 200, await saved.text());
      const stored = JSON.parse(readFileSync('/app/data/${userId}.json', 'utf8'));
      assert.equal(stored.preferences.name, 'Synced profile');
      assert.equal(stored.revision, document.revision + 1);
    `,
  ]);
  docker([
    'exec',
    '--user',
    '0:0',
    container,
    'node',
    '-e',
    `
    const assert = require('node:assert/strict');
    const { statSync, readFileSync } = require('node:fs');
    assert.equal(statSync('/app/data').uid, 1000);
    assert.equal(statSync('/app/data/${userId}.json').uid, 1000);
    const untouched = '/app/data/untouched.txt';
    assert.equal(statSync(untouched).uid, 0);
    assert.equal(statSync(untouched).mode & 0o777, 0o444);
    assert.equal(readFileSync(untouched, 'utf8'), 'keep original ownership and permissions');
  `,
  ]);
  docker(['stop', '-t', '5', container]);

  // A prepared mount supports a non-root container with all capabilities dropped.
  docker([
    'run',
    '--rm',
    '--user',
    '1000:1000',
    ...security,
    ...mount,
    image,
    'node',
    '-e',
    nodeCheck,
  ]);
  // Custom absolute DATA_DIR paths receive the same repair and privilege drop.
  docker([
    'run',
    '--rm',
    ...security,
    ...capabilities,
    '--tmpfs',
    '/custom-data:mode=700',
    '-e',
    'DATA_DIR=/custom-data',
    image,
    'node',
    '-e',
    nodeCheck,
  ]);
  assert.throws(
    () =>
      docker([
        'run',
        '--rm',
        ...security,
        ...capabilities,
        '--mount',
        `type=bind,src=${directory},dst=/app/data,readonly`,
        image,
        'true',
      ]),
    (error) => error.status !== 0 && /cannot prepare DATA_DIR/.test(error.stderr),
  );
  console.log(
    'Docker checks passed: permission repair, persisted sync, non-root runtime, custom DATA_DIR, symlink preservation, and unwritable-mount errors.',
  );
} finally {
  if (containerCreated) docker(['rm', '-f', container]);
  // Also restore access if a failed check left the fixture root-owned.
  if (imageBuilt)
    docker([
      'run',
      '--rm',
      '--user',
      '0:0',
      '--entrypoint',
      'sh',
      ...mount,
      image,
      '-c',
      `chown -R ${process.getuid()}:${process.getgid()} /app/data && chmod -R u+rwX /app/data`,
    ]);
  rmSync(directory, { recursive: true, force: true });
}
