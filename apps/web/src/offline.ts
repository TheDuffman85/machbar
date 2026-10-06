import { openDB, type DBSchema, type IDBPDatabase, type IDBPTransaction } from 'idb';
import { newId } from './uuid';
import { getLocalUserId, localUserIdKey } from './identity';
import {
  applyCompletion,
  bootstrapFor,
  operationKey,
  DomainError,
  localUserIdSchema,
  mergeDocuments,
  mutateDocument,
  same,
  type CompletionOperation,
  type SyncSnapshot,
} from '@machbar/shared';
import { migrateEntry, type Entry, type LegacyEntry, type SyncOperation } from './cache';
export type { Entry, SyncOperation } from './cache';

export class ApiError extends Error {
  constructor(
    public code: string,
    public status = 0,
  ) {
    super(code);
  }
}
interface CacheDB extends DBSchema {
  accounts: { key: string; value: Entry | LegacyEntry };
  syncLog: { key: string; value: SyncOperation[] };
}
function storageDeadline<T>(work: Promise<T>, expire: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      expire();
      reject(new ApiError('STORAGE_UNAVAILABLE'));
    }, 5_000);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

let db: Promise<IDBPDatabase<CacheDB>> | undefined;
function database(): Promise<IDBPDatabase<CacheDB>> {
  if (db) return db;
  let expired = false;
  const opening = openDB<CacheDB>('machbar', 3, {
    upgrade(database, oldVersion, _newVersion, transaction) {
      if (oldVersion < 3) database.createObjectStore('syncLog');
      if (oldVersion === 0) database.createObjectStore('accounts');
      else if (oldVersion < 2) {
        void (async () => {
          let cursor = await transaction.objectStore('accounts').openCursor();
          while (cursor) {
            await cursor.update(migrateEntry(cursor.value));
            cursor = await cursor.continue();
          }
        })().catch(() => transaction.abort());
      }
    },
    blocking() {
      if (db === pending) db = undefined;
      void opening.then((connection) => connection.close());
    },
    terminated() {
      if (db === pending) db = undefined;
    },
  });
  const pending = storageDeadline(opening, () => {
    expired = true;
    if (db === pending) db = undefined;
  });
  // An IndexedDB open cannot be cancelled. Close a late connection so it cannot
  // block a future upgrade, and let Retry open a fresh connection.
  void opening.then(
    (connection) => {
      if (expired) connection.close();
    },
    () => {},
  );
  void pending.catch(() => {
    if (db === pending) db = undefined;
  });
  db = pending;
  return pending;
}

async function transact<
  T,
  Store extends 'accounts' | 'syncLog',
  Mode extends 'readonly' | 'readwrite',
>(
  store: Store,
  mode: Mode,
  run: (tx: IDBPTransaction<CacheDB, [Store], Mode>) => Promise<T>,
  committed?: (result: T) => void,
): Promise<T> {
  const connection = await database();
  const current = db;
  const tx = connection.transaction(store, mode);
  let expired = false;
  const abort = () => {
    try {
      tx.abort();
    } catch {
      /* Already committed or aborted. */
    }
  };
  try {
    return await storageDeadline(
      (async () => {
        const result = await run(tx);
        await tx.done;
        if (expired) throw new ApiError('STORAGE_UNAVAILABLE');
        committed?.(result);
        return result;
      })(),
      () => {
        expired = true;
        abort();
        connection.close();
        if (db === current) db = undefined;
      },
    );
  } catch (error) {
    abort();
    // Do not wait on a stalled transaction while reporting a storage timeout.
    void tx.done.catch(() => {});
    throw error;
  }
}
const channel =
  typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('machbar-data') : undefined;
export function subscribeEntries(listener: () => void): () => void {
  const receive = (event: MessageEvent) => {
    if (typeof event.data === 'string') listener();
  };
  channel?.addEventListener('message', receive);
  return () => channel?.removeEventListener('message', receive);
}
const logListeners = new Set<(userId: string) => void>();
channel?.addEventListener('message', (event) => {
  if (event.data?.kind === 'sync-log')
    for (const listener of logListeners) listener(event.data.userId);
});
export function subscribeSyncLog(userId: string, listener: () => void): () => void {
  const receive = (id: string) => {
    if (id === userId) listener();
  };
  logListeners.add(receive);
  return () => {
    logListeners.delete(receive);
  };
}
export async function loadSyncLog(userId: string): Promise<SyncOperation[]> {
  return (await transact('syncLog', 'readonly', (tx) => tx.store.get(userId))) ?? [];
}
async function recordSync(userId: string, operation: SyncOperation): Promise<void> {
  await transact('syncLog', 'readwrite', async (tx) => {
    const previous = (await tx.store.get(userId)) ?? [];
    await tx.store.put([operation, ...previous].slice(0, 50), userId);
  });
  for (const listener of logListeners) listener(userId);
  channel?.postMessage({ kind: 'sync-log', userId });
}
export async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body !== undefined) headers.set('Content-Type', 'application/json');
  const localId = localStorage.getItem(localUserIdKey);
  if (path.startsWith('/api/') && localId && !headers.has('X-Machbar-User'))
    headers.set('X-Machbar-User', localId);
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) abort();
  const timer = setTimeout(abort, 10_000);
  try {
    const response = await fetch(path, {
      ...options,
      credentials: 'same-origin',
      headers,
      signal: controller.signal,
    });
    if (!response.ok) {
      const error = await response.json().catch((error: unknown) => {
        if (controller.signal.aborted) throw error;
        return { code: 'INTERNAL_ERROR' };
      });
      throw new ApiError(error.code ?? 'INTERNAL_ERROR', response.status);
    }
    return await response.json();
  } catch (error) {
    if (error instanceof ApiError || error instanceof SyntaxError) throw error;
    throw new ApiError('OFFLINE');
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
  }
}
async function readEntry(id: string): Promise<Entry | undefined> {
  const value = await transact('accounts', 'readonly', (tx) => tx.store.get(id));
  return value ? migrateEntry(value) : undefined;
}
// Read-modify-write transactions coordinate local edits across windows.
async function updateEntry(
  id: string,
  change: (entry: Entry | undefined) => Entry,
): Promise<Entry> {
  const next = await transact('accounts', 'readwrite', async (tx) => {
    const value = await tx.store.get(id);
    const next = change(value ? migrateEntry(value) : undefined);
    await tx.store.put(next, id);
    return next;
  });
  channel?.postMessage(id);
  return next;
}
function initial(snapshot: SyncSnapshot): Entry {
  return { base: snapshot.document, snapshot: bootstrapFor(snapshot), queue: [] };
}
function checkIdentity(id: string) {
  if (getLocalUserId() !== id) throw new ApiError('ACCOUNT_CHANGED', 409);
}
export async function loadEntry(): Promise<Entry> {
  const id = getLocalUserId();
  const cached = await readEntry(id);
  if (cached) return cached;
  const snapshot = await request<SyncSnapshot>('/api/bootstrap', {
    headers: { 'X-Machbar-User': id },
  });
  checkIdentity(id);
  if (snapshot.document.userId !== id) throw new ApiError('ACCOUNT_CHANGED', 409);
  return updateEntry(id, (existing) => existing ?? initial(snapshot));
}
const syncing = new Map<string, Promise<Entry>>();
export function syncEntry(): Promise<Entry> {
  const id = getLocalUserId();
  const running = syncing.get(id);
  if (running) return running;
  const started = Date.now();
  const operation: SyncOperation = {
    id: newId(),
    startedAt: new Date(started).toISOString(),
    durationMs: 0,
    status: 'success',
    changes: 0,
    attempts: 0,
    uploaded: false,
  };
  const run = async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const captured = await readEntry(id);
      if (!captured) return loadEntry();
      operation.changes = captured.queue.length;
      if (captured.recovery?.length) {
        operation.status = 'blocked';
        operation.error = captured.conflict ?? 'COMPLETION_CONFLICT';
        return captured;
      }
      operation.attempts++;

      const remote = await request<SyncSnapshot>('/api/bootstrap', {
        headers: { 'X-Machbar-User': id },
      });
      if (remote.document.userId !== id) throw new ApiError('ACCOUNT_CHANGED', 409);
      const document = mergeDocuments(captured.base, captured.snapshot.document, remote.document);
      let acknowledged = remote;
      try {
        if (!same(document, remote.document)) {
          acknowledged = await request<SyncSnapshot>('/api/sync', {
            method: 'PUT',
            headers: { 'X-Machbar-User': id, 'If-Match': String(remote.document.revision) },
            body: JSON.stringify(document),
          });
          operation.uploaded = true;
        }
      } catch (error) {
        if (error instanceof ApiError && error.code === 'DOCUMENT_CONFLICT') continue;
        throw error;
      }
      if (acknowledged.document.userId !== id) throw new ApiError('ACCOUNT_CHANGED', 409);
      operation.revision = acknowledged.document.revision;
      const batch = new Set(captured.queue.map((op) => op.operationId));
      const next = await updateEntry(id, (latest) => {
        if (!latest) throw new ApiError('INVALID_IDENTITY', 400);
        if (latest.base.revision > acknowledged.document.revision) return latest;
        const queue = latest.queue.filter((op) => !batch.has(op.operationId));
        const rebased = queue.length
          ? mergeDocuments(
              captured.snapshot.document,
              latest.snapshot.document,
              acknowledged.document,
            )
          : acknowledged.document;
        return {
          ...latest,
          base: acknowledged.document,
          snapshot: bootstrapFor({ ...acknowledged, document: rebased }),
          queue,
          conflict: undefined,
        };
      });
      // Persist acknowledgments only under the captured account, never the new active profile.
      checkIdentity(id);
      return next;
    }
    throw new ApiError('DOCUMENT_CONFLICT', 409);
  };
  // Server revision checks resolve concurrent uploads. Holding a Web Lock over
  // network I/O can leave another PWA window waiting on a suspended mobile tab.
  const promise = run()
    .catch((error: unknown) => {
      operation.status = 'failed';
      operation.error =
        error instanceof ApiError || error instanceof DomainError ? error.code : 'INTERNAL_ERROR';
      throw error;
    })
    .finally(() => {
      operation.durationMs = Date.now() - started;
      syncing.delete(id);
      // Diagnostics must never delay a local save, sync acknowledgment, or retry.
      void recordSync(id, operation).catch(() => {});
    });
  syncing.set(id, promise);
  return promise;
}
export function visibleSnapshot(entry: Entry) {
  return bootstrapFor(entry.snapshot);
}
function locally(change: (entry: Entry) => Entry, expectedUserId?: string): Promise<Entry> {
  const id = expectedUserId ?? getLocalUserId();
  return updateEntry(id, (entry) => {
    checkIdentity(id);
    if (!entry) throw new ApiError('INVALID_IDENTITY', 400);
    try {
      return change(entry);
    } catch (error) {
      if (error instanceof DomainError) throw new ApiError(error.code, error.status);
      if (error instanceof Error && error.name === 'ZodError')
        throw new ApiError('VALIDATION_ERROR', 400);
      throw error;
    }
  });
}
export function toggleCompletion(
  type: CompletionOperation['targetType'],
  targetId: string,
  date: string,
  timezone: string,
  expectedUserId?: string,
): Promise<Entry> {
  const operationId = newId();
  return locally((entry) => {
    const document = structuredClone(entry.snapshot.document);
    const current = document.completions[operationKey(document, type, targetId, date)];
    const operation: CompletionOperation = {
      operationId,
      targetType: type,
      targetId,
      date,
      timezone,
      completed: !current?.completed,
      expectedVersion: current?.version ?? 0,
    };
    applyCompletion(document, operation);
    return {
      ...entry,
      snapshot: bootstrapFor({ ...entry.snapshot, document }),
      queue: [...entry.queue, operation],
    };
  }, expectedUserId);
}
export function mutate(
  path: string,
  method: string,
  body?: unknown,
  expectedUserId?: string,
): Promise<Entry> {
  const operationId = newId();
  const now = new Date();
  return locally((entry) => {
    const document = structuredClone(entry.snapshot.document);
    mutateDocument(document, path, method, body, operationId, now);
    return {
      ...entry,
      snapshot: bootstrapFor({ ...entry.snapshot, document }),
      queue: [...entry.queue, { operationId, path, method, body, at: now.toISOString() }],
    };
  }, expectedUserId);
}
export async function discardQueue(): Promise<Entry> {
  const id = getLocalUserId();
  const snapshot = await request<SyncSnapshot>('/api/bootstrap', {
    headers: { 'X-Machbar-User': id },
  });
  return updateEntry(id, () => {
    checkIdentity(id);
    return initial(snapshot);
  });
}
export async function switchLocalUser(userId: string): Promise<Entry> {
  const parsed = localUserIdSchema.safeParse(userId.trim());
  if (!parsed.success) throw new ApiError('INVALID_IDENTITY', 400);
  if (!navigator.onLine) throw new ApiError('ONLINE_REQUIRED');
  const id = getLocalUserId();
  if ((await readEntry(id))?.queue.length) throw new ApiError('PENDING_CHANGES', 409);
  const snapshot = await request<SyncSnapshot>('/api/local-user', {
    method: 'POST',
    headers: { 'X-Machbar-User': id },
    body: JSON.stringify({ userId: parsed.data }),
  });
  if (snapshot.document.userId !== parsed.data) throw new ApiError('ACCOUNT_CHANGED', 409);
  // Recheck after the network request, in the same transaction that changes identity.
  return transact(
    'accounts',
    'readwrite',
    async (tx) => {
      const current = await tx.store.get(id);
      if (current?.queue.length) throw new ApiError('PENDING_CHANGES', 409);
      checkIdentity(id);
      const saved = await tx.store.get(parsed.data);
      const previous = saved ? migrateEntry(saved) : undefined;
      const next = previous
        ? {
            ...previous,
            base: snapshot.document,
            snapshot: bootstrapFor({
              ...snapshot,
              document: mergeDocuments(
                previous.base,
                previous.snapshot.document,
                snapshot.document,
              ),
            }),
          }
        : initial(snapshot);
      await tx.store.put(next, parsed.data);
      return next;
    },
    () => {
      // Commit the identity without an asynchronous gap after the transaction.
      checkIdentity(id);
      localStorage.setItem(localUserIdKey, parsed.data);
      channel?.postMessage(parsed.data);
    },
  );
}
