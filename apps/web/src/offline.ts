import { openDB, type DBSchema } from 'idb';
import { newId } from './uuid';
import {
  applyCompletion,
  completionKey,
  localDate,
  progressFor,
  type Bootstrap,
  type CompletionOperation,
} from '@machbar/shared';

export class ApiError extends Error {
  constructor(
    public code: string,
    public status = 0,
  ) {
    super(code);
  }
}
export type Entry = {
  snapshot: Bootstrap;
  queue: CompletionOperation[];
  authRequired?: boolean;
  conflict?: string;
};
interface CacheDB extends DBSchema {
  accounts: { key: string; value: Entry };
  meta: { key: string; value: string };
}
const db = openDB<CacheDB>('machbar', 1, {
  upgrade(db) {
    db.createObjectStore('accounts');
    db.createObjectStore('meta');
  },
});
let chain: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain
    .catch(() => {})
    .then(async (): Promise<T> =>
      navigator.locks ? await navigator.locks.request('machbar-sync', fn) : await fn(),
    );
  chain = next;
  return next;
}
export async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...options,
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', ...options.headers },
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
async function activeEntry(): Promise<Entry | undefined> {
  const database = await db,
    id = await database.get('meta', 'active');
  return id ? database.get('accounts', id) : undefined;
}
async function persist(entry: Entry) {
  const database = await db;
  const tx = database.transaction(['accounts', 'meta'], 'readwrite');
  await tx.objectStore('accounts').put(entry, entry.snapshot.document.userId);
  await tx.objectStore('meta').put(entry.snapshot.document.userId, 'active');
  await tx.done;
  return entry;
}
async function accept(snapshot: Bootstrap): Promise<Entry> {
  const previous = await activeEntry();
  if (previous && previous.snapshot.document.userId !== snapshot.document.userId) {
    await (await db).delete('accounts', previous.snapshot.document.userId);
  }
  return persist({
    snapshot,
    queue: previous?.snapshot.document.userId === snapshot.document.userId ? previous.queue : [],
    conflict:
      previous?.snapshot.document.userId === snapshot.document.userId
        ? previous.conflict
        : undefined,
  });
}
async function refresh(): Promise<Entry> {
  try {
    return await accept(await request<Bootstrap>('/api/bootstrap'));
  } catch (error) {
    const cached = await activeEntry();
    if (cached && error instanceof ApiError && (error.code === 'OFFLINE' || error.status === 401)) {
      return persist({ ...cached, authRequired: error.status === 401 || cached.authRequired });
    }
    throw error;
  }
}
async function flush(): Promise<Entry> {
  let entry = await refresh();
  if (entry.authRequired || entry.conflict) return entry;
  while (entry.queue.length) {
    try {
      const snapshot = await request<Bootstrap>('/api/completions', {
        method: 'POST',
        headers: { 'X-Machbar-User': entry.snapshot.document.userId },
        body: JSON.stringify(entry.queue[0]),
      });
      // The request was made for the identity verified by refresh. A switched identity must never receive this queue.
      if (snapshot.document.userId !== entry.snapshot.document.userId)
        throw new ApiError('ACCOUNT_CHANGED', 409);
      entry = await persist({ snapshot, queue: entry.queue.slice(1) });
    } catch (error) {
      if (error instanceof ApiError) {
        if (error.code === 'OFFLINE') return entry;
        if (error.status === 401) return persist({ ...entry, authRequired: true });
        return persist({ ...entry, conflict: error.code });
      }
      throw error;
    }
  }
  return entry;
}
export function loadEntry(): Promise<Entry> {
  return serial(flush);
}
export function visibleSnapshot(entry: Entry): Bootstrap {
  const document = structuredClone(entry.snapshot.document);
  for (const operation of entry.queue) {
    try {
      applyCompletion(document, operation);
    } catch {
      // Keep the server snapshot on conflicts; the queue remains reviewable.
    }
  }
  return {
    ...entry.snapshot,
    document,
    today: localDate(document.preferences.timezone),
    progress: progressFor(document),
  };
}
export function toggleCompletion(
  type: 'habit' | 'step',
  targetId: string,
  date: string,
  timezone: string,
): Promise<Entry> {
  return serial(async () => {
    let entry = await activeEntry();
    if (!entry) throw new ApiError('AUTH_REQUIRED', 401);
    if (entry.conflict) throw new ApiError('COMPLETION_CONFLICT', 409);
    if (entry.authRequired) throw new ApiError('AUTH_REQUIRED', 401);
    const current =
      visibleSnapshot(entry).document.completions[completionKey(type, targetId, date)];
    const operation: CompletionOperation = {
      operationId: newId(),
      targetType: type,
      targetId,
      date,
      timezone,
      completed: !current?.completed,
      expectedVersion: current?.version ?? 0,
    };
    entry = await persist({ ...entry, queue: [...entry.queue, operation] });
    return entry;
  });
}
export function mutate(
  path: string,
  method: string,
  body?: unknown,
  expectedRevision?: number,
): Promise<Entry> {
  return serial(async () => {
    const before = await activeEntry();
    const revision = expectedRevision ?? before?.snapshot.document.revision;
    const entry = await flush();
    if (entry.authRequired) throw new ApiError('AUTH_REQUIRED', 401);
    if (entry.queue.length) throw new ApiError(entry.conflict ?? 'PENDING_CHANGES');
    if (!navigator.onLine) throw new ApiError('ONLINE_REQUIRED');
    return accept(
      await request<Bootstrap>(path, {
        method,
        headers: {
          'If-Match': String(revision ?? entry.snapshot.document.revision),
          'X-Machbar-User': entry.snapshot.document.userId,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
  });
}
export function discardQueue(): Promise<Entry> {
  return serial(async () => {
    const snapshot = await request<Bootstrap>('/api/bootstrap');
    const entry = await accept(snapshot);
    return persist({ ...entry, queue: [], conflict: undefined });
  });
}
export function logout(): Promise<void> {
  return serial(async () => {
    await request('/auth/logout', { method: 'POST', body: '{}' });
    const database = await db;
    const tx = database.transaction(['accounts', 'meta'], 'readwrite');
    await tx.objectStore('accounts').clear();
    await tx.objectStore('meta').clear();
    await tx.done;
  });
}
