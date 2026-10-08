import { lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  createUser,
  DomainError,
  localUserIdSchema,
  userDocumentSchema,
  documentWithinLimits,
  documentLimits,
  type UserDocument,
} from '@machbar/shared';
import { StorageBudget } from './storage-budget.js';

export const maxDocumentBytes = documentLimits.maxBytes;

export class JsonStore {
  private locks = new Map<string, Promise<unknown>>();
  constructor(
    public directory: string,
    private budget = new StorageBudget(directory),
  ) {}
  useBudget(budget: StorageBudget) {
    this.budget = budget;
  }
  async exists(userId: string): Promise<boolean> {
    try {
      const file = await lstat(this.path(userId));
      if (!file.isFile()) throw new DomainError('DATA_CORRUPT', 500);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }
  private path(userId: string) {
    if (!localUserIdSchema.safeParse(userId).success)
      throw new DomainError('INVALID_IDENTITY', 400);
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
  private async load(
    userId: string,
    requireExisting = false,
    allowCreate = true,
  ): Promise<UserDocument> {
    try {
      const raw = await readFile(this.path(userId), 'utf8');
      const parsed = userDocumentSchema.safeParse(JSON.parse(raw));
      if (!parsed.success || parsed.data.userId !== userId)
        throw new DomainError('DATA_CORRUPT', 500);
      return parsed.data;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        if (requireExisting) throw new DomainError('USER_NOT_FOUND', 404);
        if (!allowCreate) throw new DomainError('USER_CREATION_DISABLED', 403);
        return createUser(userId);
      }
      if (error instanceof SyntaxError) throw new DomainError('DATA_CORRUPT', 500);
      throw error;
    }
  }
  private async save(doc: UserDocument) {
    if (!documentWithinLimits(doc)) throw new DomainError('DOCUMENT_LIMIT', 413);
    userDocumentSchema.parse(doc);
    const contents = JSON.stringify(doc);
    const bytes = Buffer.byteLength(contents);
    if (bytes > maxDocumentBytes) throw new DomainError('DOCUMENT_LIMIT', 413);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const target = this.path(doc.userId);
    const temp = `${target}.${randomUUID()}.tmp`;
    return this.budget.commit(target, bytes, async () => {
      try {
        const file = await open(temp, 'wx', 0o600);
        try {
          await file.writeFile(contents);
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
    });
  }
  async read(userId: string, allowCreate = true): Promise<UserDocument> {
    return this.serial(userId, () => this.load(userId, false, allowCreate));
  }
  async readExisting(userId: string): Promise<UserDocument> {
    return this.serial(userId, () => this.load(userId, true));
  }
  async update<T>(
    userId: string,
    action: (doc: UserDocument) => T | Promise<T>,
    expectedRevision?: number,
    allowCreate = true,
  ): Promise<{ document: UserDocument; result: T }> {
    return this.serial(userId, async () => {
      const doc = await this.load(userId, false, allowCreate);
      if (expectedRevision !== undefined && doc.revision !== expectedRevision)
        throw new DomainError('DOCUMENT_CONFLICT', 409);
      const result = await action(doc);
      doc.revision++;
      await this.save(doc);
      return { document: doc, result };
    });
  }
}
