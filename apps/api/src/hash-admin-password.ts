import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// ADMIN_PASSWORD_HASH format: scrypt:<log2 N>:<r>:<p>:<salt>:<key>, base64url salt
// and key. Colons instead of `$` so Compose does not interpolate the value from .env.
const prefix = 'scrypt';
const keyLength = 32;
const defaults = { cost: 15, blockSize: 8, parallelization: 1 };
export const defaultMinimumAdminPasswordLength = 12;

export function readMinimumAdminPasswordLength(env = process.env) {
  const value = env.ADMIN_PASSWORD_MIN_LENGTH || String(defaultMinimumAdminPasswordLength);
  const parsed = Number(value);
  if (!/^\d+$/.test(value) || parsed < 1 || parsed > 1024)
    throw new Error('ADMIN_PASSWORD_MIN_LENGTH must be an integer from 1 to 1024.');
  return parsed;
}

export type AdminPasswordHash = {
  cost: number;
  blockSize: number;
  parallelization: number;
  salt: Buffer;
  key: Buffer;
};

const derive = (password: string, { cost, blockSize, parallelization, salt }: AdminPasswordHash) =>
  new Promise<Buffer>((done, fail) => {
    const options: ScryptOptions = {
      N: 2 ** cost,
      r: blockSize,
      p: parallelization,
      maxmem: 256 * 2 ** cost * blockSize,
    };
    scrypt(password.normalize('NFC'), salt, keyLength, options, (error, key) =>
      error ? fail(error) : done(key),
    );
  });

// Bounds keep a typo in the environment from making every login allocate gigabytes.
export function parseAdminPasswordHash(value: string): AdminPasswordHash | null {
  const match = /^scrypt:(\d{1,2}):(\d{1,2}):(\d{1,2}):([\w-]{22,}):([\w-]{43})$/.exec(value);
  if (!match) return null;
  const [cost, blockSize, parallelization] = match.slice(1, 4).map(Number) as [
    number,
    number,
    number,
  ];
  if (cost < 14 || cost > 20 || blockSize < 8 || blockSize > 16) return null;
  if (parallelization < 1 || parallelization > 4) return null;
  const salt = Buffer.from(match[4]!, 'base64url');
  const key = Buffer.from(match[5]!, 'base64url');
  if (salt.length < 16 || key.length !== keyLength) return null;
  return { cost, blockSize, parallelization, salt, key };
}

export async function hashAdminPassword(password: string) {
  const params = { ...defaults, salt: randomBytes(16), key: Buffer.alloc(0) };
  const key = await derive(password, params);
  return [
    prefix,
    params.cost,
    params.blockSize,
    params.parallelization,
    params.salt.toString('base64url'),
    key.toString('base64url'),
  ].join(':');
}

export async function verifyAdminPassword(password: string, hash: AdminPasswordHash) {
  return timingSafeEqual(await derive(password, hash), hash.key);
}

// Reads the password without echo from a terminal, or the first line of piped input.
async function readPassword(prompt: string) {
  const input = process.stdin;
  if (!input.isTTY) {
    let data = '';
    for await (const chunk of input) data += chunk;
    return data.split(/\r?\n/)[0] ?? '';
  }
  process.stderr.write(prompt);
  input.setRawMode(true);
  input.setEncoding('utf8');
  return new Promise<string>((done, fail) => {
    let value = '';
    const finish = (error?: Error) => {
      input.setRawMode(false);
      input.pause();
      input.off('data', onData);
      process.stderr.write('\n');
      if (error) fail(error);
      else done(value);
    };
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === '\r' || char === '\n') return finish();
        if (char === '\u0003') return finish(new Error('Cancelled.'));
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
        else if (char >= ' ') value += char;
      }
    };
    input.on('data', onData);
    input.resume();
  });
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv.length > 2) throw new Error('Usage: node hash-admin-password.js');
  const minimumAdminPasswordLength = readMinimumAdminPasswordLength();
  const password = await readPassword('Admin password: ');
  if (password.length < minimumAdminPasswordLength)
    throw new Error(`The password must have at least ${minimumAdminPasswordLength} characters.`);
  if (process.stdin.isTTY && (await readPassword('Repeat password: ')) !== password)
    throw new Error('The passwords do not match.');
  console.log(await hashAdminPassword(password));
}
