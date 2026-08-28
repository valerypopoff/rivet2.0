import { expect, test, type Request } from '@playwright/test';
import { authenticateIfNeeded, waitForDashboardReady } from './helpers/hostedEditorObserve';
import {
  cleanupWorkflowProject,
  createWorkflowFolder,
  createWorkflowProject,
  deleteWorkflowFolder,
  ensureFolderExpanded,
  renameWorkflowFolderInline,
  requireManagedMutationOptIn,
  requireManagedStorageMode,
} from './helpers/workflowLibraryObserve';

function isProjectSaveRequest(request: Request): boolean {
  if (request.method() !== 'POST') {
    return false;
  }

  const url = new URL(request.url());
  return url.pathname === '/api/projects/save';
}

test.describe('Managed special workflow paths', () => {
  test('folder names with % and _ survive rename, save, and reload', async ({ page }) => {
    test.slow();
    requireManagedStorageMode();
    requireManagedMutationOptIn();

    const unique = `codex-special-${Date.now()}`;
    const initialFolderName = `${unique}-%_source`;
    const renamedFolderName = `${unique}-%_renamed`;
    const nestedProjectName = `${unique}-project`;
    const nestedFileName = `${nestedProjectName}.rivet-project`;

    let folderRelativePath = '';
    let projectRelativePath = '';

    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await authenticateIfNeeded(page);
    await waitForDashboardReady(page);

    try {
      const folder = await createWorkflowFolder(page, initialFolderName);
      const project = await createWorkflowProject(page, folder.relativePath, nestedProjectName);

      folderRelativePath = folder.relativePath;
      projectRelativePath = project.relativePath;

      await page.reload({ waitUntil: 'domcontentloaded' });
      await authenticateIfNeeded(page);
      await waitForDashboardReady(page);

      await ensureFolderExpanded(page, initialFolderName, nestedProjectName);
      await page.locator('.project-row', { hasText: nestedProjectName }).dblclick();
      await expect(page.locator('.active-project-name')).toHaveText(nestedProjectName, { timeout: 120_000 });
      await expect(page.locator('.active-project-save-button')).toHaveText('Save', { timeout: 120_000 });

      await renameWorkflowFolderInline(page, initialFolderName, renamedFolderName);

      await expect(page.locator('.folder-row', { hasText: renamedFolderName })).toBeVisible({ timeout: 30_000 });
      await expect(page.locator('.active-project-name')).toHaveText(nestedProjectName, { timeout: 30_000 });
      await expect(page.locator('.active-project-save-button')).toHaveText('Save', { timeout: 30_000 });

      folderRelativePath = renamedFolderName;
      projectRelativePath = `${renamedFolderName}/${nestedFileName}`;

      const saveRequestPromise = page.waitForRequest(isProjectSaveRequest, { timeout: 30_000 });
      const saveResponsePromise = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return response.request().method() === 'POST' && url.pathname === '/api/projects/save';
      }, { timeout: 30_000 });

      await page.locator('.active-project-save-button').click();

      const saveRequest = await saveRequestPromise;
      const saveResponse = await saveResponsePromise;
      expect(saveResponse.ok()).toBe(true);

      const savePayload = saveRequest.postDataJSON() as {
        path?: string;
        expectedRevisionId?: string | null;
      };

      expect(savePayload.path).toBe(`/managed/workflows/${renamedFolderName}/${nestedFileName}`);
      expect(typeof savePayload.expectedRevisionId).toBe('string');
      expect(savePayload.expectedRevisionId).not.toBe('');

      await page.reload({ waitUntil: 'domcontentloaded' });
      await authenticateIfNeeded(page);
      await waitForDashboardReady(page);

      await expect(page.locator('.folder-row', { hasText: renamedFolderName })).toBeVisible({ timeout: 30_000 });
      await expect(page.locator('.active-project-name')).toHaveText(nestedProjectName, { timeout: 120_000 });
      await expect(page.locator('.active-project-save-button')).toHaveText('Save', { timeout: 120_000 });
    } finally {
      if (projectRelativePath) {
        await cleanupWorkflowProject(page, projectRelativePath).catch(() => {});
      }
      if (folderRelativePath) {
        await deleteWorkflowFolder(page, folderRelativePath).catch(() => {});
      }
    }
  });
});
