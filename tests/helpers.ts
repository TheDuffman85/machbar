import { expect, type Page } from '@playwright/test';
import {
  bootstrapFor,
  type Bootstrap,
  type SyncSnapshot,
  type UserDocument,
} from '../packages/shared/src/index.js';

export async function localEntry(page: Page) {
  return page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const opening = indexedDB.open('machbar');
      opening.onsuccess = () => resolve(opening.result);
      opening.onerror = () => reject(opening.error);
    });
    try {
      return await new Promise<{
        queue: { operationId: string }[];
        snapshot: Bootstrap;
        base: UserDocument;
      }>((resolve, reject) => {
        const request = database
          .transaction('accounts')
          .objectStore('accounts')
          .get(localStorage.getItem('machbar-user-id')!);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    } finally {
      database.close();
    }
  });
}
export async function readSnapshot(page: Page): Promise<Bootstrap> {
  // UI actions acknowledge local persistence; fixtures need the eventual server state.
  if (await page.evaluate(() => navigator.onLine)) {
    await expect.poll(async () => (await localEntry(page))?.queue.length ?? 0).toBe(0);
  }
  const id = await page.evaluate(() => localStorage.getItem('machbar-user-id'));
  const response = await page.request.get('/api/bootstrap', {
    headers: id ? { 'X-Machbar-User': id } : {},
  });
  if (!response.ok()) throw new Error(`Bootstrap failed: ${response.status()}`);
  return bootstrapFor((await response.json()) as SyncSnapshot);
}
export async function writeSnapshot(page: Page, document: UserDocument): Promise<Bootstrap> {
  const response = await page.request.put('/api/sync', {
    headers: {
      origin: 'http://localhost:3100',
      'X-Machbar-User': document.userId,
      'If-Match': String(document.revision),
    },
    data: document,
  });
  expect(response.status()).toBe(200);
  return bootstrapFor((await response.json()) as SyncSnapshot);
}
