import { lstat, mkdir, readdir, statfs } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { DomainError, localUserIdSchema } from '@machbar/shared';

export const storageDefaults = {
  maxProfiles: 100,
  maxStorageBytes: 256 * 1024 * 1024,
  storageReserveBytes: 64 * 1024 * 1024,
};
export type StorageLimits = typeof storageDefaults;

// Profiles and push state share a budget and a commit queue. Recount from disk
// so quotas survive restarts and rejected/failed writes never consume capacity.
// One application instance must own the directory, as with profile revisions.
export class StorageBudget {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(
    private directory: string,
    private limits: StorageLimits = storageDefaults,
  ) {}
  async commit<T>(target: string, bytes: number, write: () => Promise<T>): Promise<T> {
    const next = this.queue
      .catch(() => {})
      .then(async () => {
        await mkdir(this.directory, { recursive: true, mode: 0o700 });
        let used = 0,
          profiles = 0,
          previous = 0,
          exists = false;
        for (const entry of await readdir(this.directory, { withFileTypes: true })) {
          const file = await lstat(join(this.directory, entry.name));
          if (!file.isFile()) continue;
          used += file.size;
          if (
            entry.name.endsWith('.json') &&
            localUserIdSchema.safeParse(entry.name.slice(0, -5)).success
          )
            profiles++;
          if (entry.name === basename(target)) {
            exists = true;
            previous = file.size;
          }
        }
        const isProfile = localUserIdSchema.safeParse(basename(target).slice(0, -5)).success;
        if (isProfile && !exists && profiles >= this.limits.maxProfiles)
          throw new DomainError('PROFILE_LIMIT', 507);
        if (used - previous + bytes > this.limits.maxStorageBytes && bytes > previous)
          throw new DomainError('STORAGE_LIMIT', 507);
        const disk = await statfs(this.directory, { bigint: true });
        // Atomic replacement requires room for the complete temporary file.
        if (disk.bavail * disk.bsize < BigInt(this.limits.storageReserveBytes) + BigInt(bytes))
          throw new DomainError('STORAGE_LIMIT', 507);
        return write();
      });
    this.queue = next;
    return next;
  }
}
