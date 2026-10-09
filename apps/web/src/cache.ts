import {
  applyCompletion,
  bootstrapFor,
  pruneUnusedArchivedItems,
  type Bootstrap,
  type CompletionOperation,
  type UserDocument,
} from '@machbar/shared';

export type SyncOperation = {
  id: string;
  startedAt: string;
  durationMs: number;
  status: 'success' | 'failed' | 'blocked';
  changes: number;
  attempts: number;
  uploaded: boolean;
  revision?: number;
  error?: string;
};

export type PendingMutation = {
  operationId: string;
  targetType?: CompletionOperation['targetType'];
  targetId?: string;
  date?: string;
  path?: string;
  method?: string;
  body?: unknown;
  at?: string;
};
export type Entry = {
  snapshot: Bootstrap;
  base: UserDocument;
  queue: PendingMutation[];
  conflict?: string;
  recovery?: CompletionOperation[];
};
export type LegacyEntry = { snapshot: Bootstrap; queue: CompletionOperation[]; conflict?: string };

/** Upgrade without silently throwing away a legacy operation that cannot be replayed. */
export function migrateEntry(value: Entry | LegacyEntry): Entry {
  if ('base' in value) {
    const document = structuredClone(value.snapshot.document);
    if (!pruneUnusedArchivedItems(document)) return value;
    return { ...value, snapshot: bootstrapFor({ ...value.snapshot, document }) };
  }
  const document = structuredClone(value.snapshot.document);
  const recovery: CompletionOperation[] = [];
  for (const operation of value.queue) {
    try {
      applyCompletion(document, operation);
    } catch {
      recovery.push(operation);
    }
  }
  pruneUnusedArchivedItems(document);
  return {
    base: value.snapshot.document,
    snapshot: bootstrapFor({ ...value.snapshot, document }),
    queue: value.queue,
    recovery,
    conflict: recovery.length ? 'COMPLETION_CONFLICT' : undefined,
  };
}
