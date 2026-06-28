import { expect, test } from '@playwright/test';
import { authenticateIfNeeded, waitForDashboardReady } from './helpers/hostedEditorObserve';
import {
  cleanupWorkflowProject,
  createWorkflowFolder,
  createWorkflowProject,
  deleteWorkflowFolder,
  ensureFolderExpanded,
  renameWorkflowFolderInline,
  requireManagedMutationOptIn,
} from './helpers/workflowLibraryObserve';

test.describe('Hosted open-project cache after rename', () => {
  test('switching back to a renamed inactive open project does not reload it', async ({ page }) => {
    test.slow();
    requireManagedMutationOptIn();

    const unique = `codex-open-cache-${Date.now()}`;
    const initialFolderName = `${unique}-folder`;
    const renamedFolderName = `${unique}-folder-renamed`;
    const nestedProjectName = `${unique}-nested`;
    const rootProjectName = `${unique}-root`;

    let folderRelativePath = '';
    let nestedProjectRelativePath = '';
    let rootProjectRelativePath = '';

    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await authenticateIfNeeded(page);
    await waitForDashboardReady(page);

    try {
      const folder = await createWorkflowFolder(page, initialFolderName);
      const nestedProject = await createWorkflowProject(page, folder.relativePath, nestedProjectName);
      const rootProject = await createWorkflowProject(page, '', rootProjectName);

      folderRelativePath = folder.relativePath;
      nestedProjectRelativePath = nestedProject.relativePath;
      rootProjectRelativePath = rootProject.relativePath;

      await page.reload({ waitUntil: 'domcontentloaded' });
      await authenticateIfNeeded(page);
      await waitForDashboardReady(page);
      const editorFrame = page.frameLocator('iframe.dashboard-editor-frame');
      const activeNestedEditorTab = editorFrame.locator('.projects-container .project.active', { hasText: nestedProjectName });
      const activeRootEditorTab = editorFrame.locator('.projects-container .project.active', { hasText: rootProjectName });

      await ensureFolderExpanded(page, initialFolderName, nestedProjectName);
      await page.locator('.project-row', { hasText: nestedProjectName }).dblclick();
      await expect(page.locator('.active-project-name')).toHaveText(nestedProjectName, { timeout: 120_000 });
      await expect(activeNestedEditorTab).toBeVisible({ timeout: 120_000 });
      await expect(page.locator('.active-project-save-button')).toHaveCount(0, { timeout: 120_000 });

      await page.locator('.project-row', { hasText: rootProjectName }).dblclick();
      await expect(page.locator('.active-project-name')).toHaveText(rootProjectName, { timeout: 120_000 });
      await expect(activeRootEditorTab).toBeVisible({ timeout: 120_000 });
      await expect(page.locator('.active-project-save-button')).toHaveCount(0, { timeout: 120_000 });

      await renameWorkflowFolderInline(page, initialFolderName, renamedFolderName);

      folderRelativePath = renamedFolderName;
      nestedProjectRelativePath = `${renamedFolderName}/${nestedProjectName}.rivet-project`;

      await ensureFolderExpanded(page, renamedFolderName, nestedProjectName);

      let loadRequestCount = 0;
      const handleRequest = (request: { method: () => string; url: () => string }) => {
        if (request.method() !== 'POST') {
          return;
        }

        const url = new URL(request.url());
        if (url.pathname === '/api/projects/load') {
          loadRequestCount += 1;
        }
      };

      page.on('request', handleRequest);
      try {
        await page.locator('.project-row', { hasText: nestedProjectName }).dblclick();
        await expect(page.locator('.active-project-name')).toHaveText(nestedProjectName, { timeout: 30_000 });
        await expect(activeNestedEditorTab).toBeVisible({ timeout: 30_000 });
        await expect(page.locator('.active-project-save-button')).toHaveCount(0, { timeout: 30_000 });
        await page.waitForTimeout(750);
      } finally {
        page.off('request', handleRequest);
      }

      expect(loadRequestCount).toBe(0);
    } finally {
      if (rootProjectRelativePath) {
        await cleanupWorkflowProject(page, rootProjectRelativePath).catch(() => {});
      }
      if (nestedProjectRelativePath) {
        await cleanupWorkflowProject(page, nestedProjectRelativePath).catch(() => {});
      }
      if (folderRelativePath) {
        await deleteWorkflowFolder(page, folderRelativePath).catch(() => {});
      }
    }
  });
});
