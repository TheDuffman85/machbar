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

export class SqliteStore {
  private locks = new Map<string, Promise<unknown>>();
  constructor(
    public directory: string,
    private budget = new StorageBudget(directory),
  ) {}
  useBudget(budget: StorageBudget) {
    // A supplied store may already have opened its original connection.
    const previous = this.budget;
    this.budget = budget;
    return previous === budget ? Promise.resolve() : previous.close();
  }
  async ready() {
    await this.budget.database.ready();
  }
  async close() {
    await Promise.allSettled(this.locks.values());
    await this.budget.close();
  }
  async exists(userId: string): Promise<boolean> {
    this.validateId(userId);
    return (await this.budget.database.read('profile', userId)) !== undefined;
  }
  private validateId(userId: string) {
    if (!localUserIdSchema.safeParse(userId).success)
      throw new DomainError('INVALID_IDENTITY', 400);
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
    this.validateId(userId);
    const raw = await this.budget.database.read('profile', userId);
    if (raw === undefined) {
      if (requireExisting) throw new DomainError('USER_NOT_FOUND', 404);
      if (!allowCreate) throw new DomainError('USER_CREATION_DISABLED', 403);
      return createUser(userId);
    }
    return this.parse(userId, raw);
  }
  private parse(userId: string, raw: string): UserDocument {
    try {
      const parsed = userDocumentSchema.safeParse(JSON.parse(raw));
      if (!parsed.success || parsed.data.userId !== userId)
        throw new DomainError('DATA_CORRUPT', 500);
      return parsed.data;
    } catch {
      throw new DomainError('DATA_CORRUPT', 500);
    }
  }
  private async save(doc: UserDocument, previousRevision: number) {
    this.validateId(doc.userId);
    if (!documentWithinLimits(doc)) throw new DomainError('DOCUMENT_LIMIT', 413);
    userDocumentSchema.parse(doc);
    const contents = JSON.stringify(doc);
    if (Buffer.byteLength(contents) > maxDocumentBytes)
      throw new DomainError('DOCUMENT_LIMIT', 413);
    await this.budget.commit('profile', doc.userId, contents, (previous) => {
      const revision = previous === undefined ? 0 : this.parse(doc.userId, previous).revision;
      if (revision !== previousRevision) throw new DomainError('DOCUMENT_CONFLICT', 409);
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
      const previousRevision = doc.revision;
      const result = await action(doc);
      if (doc.userId !== userId) throw new DomainError('ACCOUNT_CHANGED', 409);
      doc.revision++;
      await this.save(doc, previousRevision);
      return { document: doc, result };
    });
  }
}
