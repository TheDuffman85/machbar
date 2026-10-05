import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { createUser, DomainError, userDocumentSchema, type UserDocument } from '@machbar/shared';

export function identityKey(issuer: string, subject: string): string {
  return createHash('sha256')
    .update(JSON.stringify([issuer, subject]))
    .digest('hex');
}
export class JsonStore {
  private locks = new Map<string, Promise<unknown>>();
  constructor(public directory: string) {}
  private path(userId: string) {
    if (!/^(local|[a-f0-9]{64})$/.test(userId)) throw new DomainError('INVALID_IDENTITY');
    return join(this.directory, `${userId}.json`);
  }
  private async serial<T>(userId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(userId) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(action);
    this.locks.set(userId, next);
    try {
      return await next;
    } finally {
      if (this.locks.get(userId) === next) this.locks.delete(userId);
    }
  }
  private async load(userId: string): Promise<UserDocument> {
    try {
      const raw = await readFile(this.path(userId), 'utf8');
      const parsed = userDocumentSchema.safeParse(JSON.parse(raw));
      if (!parsed.success || parsed.data.userId !== userId)
        throw new DomainError('DATA_CORRUPT', 500);
      return parsed.data;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return createUser(userId);
      if (error instanceof SyntaxError) throw new DomainError('DATA_CORRUPT', 500);
      throw error;
    }
  }
  private async save(doc: UserDocument) {
    userDocumentSchema.parse(doc);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const target = this.path(doc.userId);
    const temp = `${target}.${randomUUID()}.tmp`;
    try {
      const file = await open(temp, 'wx', 0o600);
      try {
        await file.writeFile(JSON.stringify(doc, null, 2));
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temp, target);
      const directory = await open(this.directory, 'r');
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } finally {
      await unlink(temp).catch(() => {});
    }
  }
  async read(userId: string): Promise<UserDocument> {
    return this.serial(userId, () => this.load(userId));
  }
  async update<T>(
    userId: string,
    action: (doc: UserDocument) => T | Promise<T>,
    expectedRevision?: number,
  ): Promise<{ document: UserDocument; result: T }> {
    return this.serial(userId, async () => {
      const doc = await this.load(userId);
      if (expectedRevision !== undefined && doc.revision !== expectedRevision)
        throw new DomainError('DOCUMENT_CONFLICT', 409);
      const result = await action(doc);
      doc.revision++;
      await this.save(doc);
      return { document: doc, result };
    });
  }
}
