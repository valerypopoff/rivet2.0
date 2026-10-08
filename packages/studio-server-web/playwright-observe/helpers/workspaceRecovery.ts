import type { Page } from '@playwright/test';

/** Read the selected, committed record without flushing or changing recovery.
 * Resolve the iframe each time: a retained Frame is detached after reload. */
export async function readCommittedWorkspaceCheckpoint(page: Page): Promise<string | undefined> {
  return page
    .frameLocator('iframe.dashboard-editor-frame')
    .locator('body')
    .evaluate(async () => {
      const key = sessionStorage.getItem('rivet-workspace-recovery-v1');
      if (!key) return undefined;
      const request = indexedDB.open('jotai-store');
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      try {
        const read = db.transaction('state', 'readonly').objectStore('state').get(key);
        return await new Promise<string | undefined>((resolve, reject) => {
          read.onsuccess = () => resolve(read.result);
          read.onerror = () => reject(read.error);
        });
      } finally {
        db.close();
      }
    });
}
