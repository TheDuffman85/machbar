import { openDB, type DBSchema } from 'idb';
import { newId } from './uuid';
import { getLocalUserId, localUserIdKey } from './identity';
import {
  applyCompletion,
  bootstrapFor,
  completionKey,
  DomainError,
  localUserIdSchema,
  mergeDocuments,
  mutateDocument,
  same,
  type CompletionOperation,
  type SyncSnapshot,
} from '@machbar/shared';
import { migrateEntry, type Entry, type LegacyEntry } from './cache';
export type { Entry } from './cache';

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
}
const db = openDB<CacheDB>('machbar', 2, {
  upgrade(database, oldVersion, _newVersion, transaction) {
    if (oldVersion === 0) database.createObjectStore('accounts');
    else {
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
    void db.then((database) => database.close());
  },
});
const channel =
  typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('machbar-data') : undefined;
export function subscribeEntries(listener: () => void): () => void {
  const receive = () => listener();
  channel?.addEventListener('message', receive);
  return () => channel?.removeEventListener('message', receive);
}
export async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body !== undefined) headers.set('Content-Type', 'application/json');
  const localId = localStorage.getItem(localUserIdKey);
  if (path.startsWith('/api/') && localId && !headers.has('X-Machbar-User'))
    headers.set('X-Machbar-User', localId);
  let response: Response;
  try {
    response = await fetch(path, {
      ...options,
      credentials: 'same-origin',
      headers,
      signal: options.signal ?? AbortSignal.timeout(10_000),
    });
  } catch {
    throw new ApiError('OFFLINE');
  }
  if (!response.ok) {
    const error = await response.json().catch(() => ({ code: 'INTERNAL_ERROR' }));
    throw new ApiError(error.code ?? 'INTERNAL_ERROR', response.status);
  }
  return response.json();
}
async function readEntry(id: string): Promise<Entry | undefined> {
  const value = await (await db).get('accounts', id);
  return value ? migrateEntry(value) : undefined;
}
// The read-modify-write transaction also coordinates browsers without Web Locks.
async function updateEntry(
  id: string,
  change: (entry: Entry | undefined) => Entry,
): Promise<Entry> {
  const tx = (await db).transaction('accounts', 'readwrite');
  const value = await tx.store.get(id);
  let next: Entry;
  try {
    next = change(value ? migrateEntry(value) : undefined);
    await tx.store.put(next, id);
    await tx.done;
  } catch (error) {
    try {
      tx.abort();
    } catch {
      /* Already committed. */
    }
    await tx.done.catch(() => {});
    throw error;
  }
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
  const run = async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const captured = await readEntry(id);
      if (!captured) return loadEntry();
      if (captured.recovery?.length) return captured;
      const remote = await request<SyncSnapshot>('/api/bootstrap', {
        headers: { 'X-Machbar-User': id },
      });
      if (remote.document.userId !== id) throw new ApiError('ACCOUNT_CHANGED', 409);
      const document = mergeDocuments(captured.base, captured.snapshot.document, remote.document);
      let acknowledged = remote;
      try {
        if (!same(document, remote.document))
          acknowledged = await request<SyncSnapshot>('/api/sync', {
            method: 'PUT',
            headers: { 'X-Machbar-User': id, 'If-Match': String(remote.document.revision) },
            body: JSON.stringify(document),
          });
      } catch (error) {
        if (error instanceof ApiError && error.code === 'DOCUMENT_CONFLICT') continue;
        throw error;
      }
      if (acknowledged.document.userId !== id) throw new ApiError('ACCOUNT_CHANGED', 409);
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
  const promise = (async () =>
    navigator.locks
      ? await navigator.locks.request(`machbar-sync:${id}`, run)
      : await run())().finally(() => syncing.delete(id));
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
  type: 'habit' | 'step',
  targetId: string,
  date: string,
  timezone: string,
  expectedUserId?: string,
): Promise<Entry> {
  const operationId = newId();
  return locally((entry) => {
    const document = structuredClone(entry.snapshot.document);
    const current = document.completions[completionKey(type, targetId, date)];
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
  const tx = (await db).transaction('accounts', 'readwrite');
  try {
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
            document: mergeDocuments(previous.base, previous.snapshot.document, snapshot.document),
          }),
        }
      : initial(snapshot);
    await tx.store.put(next, parsed.data);
    await tx.done;
    // No asynchronous gap after the final identity/queue check and storage commit.
    localStorage.setItem(localUserIdKey, parsed.data);
    channel?.postMessage(parsed.data);
    return next;
  } catch (error) {
    try {
      tx.abort();
    } catch {
      /* Already committed. */
    }
    await tx.done.catch(() => {});
    throw error;
  }
}
