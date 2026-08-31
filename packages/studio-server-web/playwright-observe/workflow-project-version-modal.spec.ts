import { expect, test, type Page } from '@playwright/test';
import { authenticateIfNeeded, waitForDashboardReady } from './helpers/hostedEditorObserve';

type MockWorkflowProjectItem = {
  id: string;
  name: string;
  fileName: string;
  relativePath: string;
  absolutePath: string;
  updatedAt: string;
  settings: {
    status: 'unpublished' | 'published' | 'unpublished_changes';
    endpointName: string;
    lastPublishedAt: string | null;
    publishedWebApps: [];
  };
};

function createVersionChooserFixture(name: string): MockWorkflowProjectItem {
  return {
    id: 'workflow-version-modal-fixture',
    name,
    fileName: `${name}.rivet-project`,
    relativePath: `${name}.rivet-project`,
    absolutePath: `/managed/workflows/${name}.rivet-project`,
    updatedAt: '2026-04-08T11:00:00.000Z',
    settings: {
      status: 'unpublished_changes',
      endpointName: 'codex-version-modal-endpoint',
      lastPublishedAt: '2026-04-08T10:15:00.000Z',
      publishedWebApps: [],
    },
  };
}

async function installVersionChooserRoutes(page: Page, project: MockWorkflowProjectItem): Promise<void> {
  await page.route('**/api/workflows/tree', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        root: '/managed/workflows',
        sync: { epoch: 'playwright-fixture', revision: 0 },
        folders: [],
        projects: [project],
      }),
    });
  });
}

test.describe('Workflow project version chooser', () => {
  test('unpublished_changes uses the saved-version chooser for download and duplicate', async ({ page }) => {
    test.slow();

    const unique = 'codex-version-modal-fixture';
    const project = createVersionChooserFixture(unique);
    await installVersionChooserRoutes(page, project);

    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await authenticateIfNeeded(page);
    await waitForDashboardReady(page);

    const projectRow = page.locator('.project-row', { hasText: unique });
    const chooserModal = page.getByTestId('workflow-project-version-modal');

    await projectRow.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Download' }).click();
    await expect(chooserModal).toHaveCount(1);
    await expect(chooserModal).toBeVisible();
    await expect(chooserModal.locator('.project-settings-modal-title')).toHaveText('Download');
    await expect(page.getByRole('button', { name: 'Download "Published"' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Download "Unpublished changes"' })).toBeVisible();
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(chooserModal).toHaveCount(0);

    await projectRow.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Duplicate' }).click();
    await expect(chooserModal).toHaveCount(1);
    await expect(chooserModal).toBeVisible();
    await expect(chooserModal.locator('.project-settings-modal-title')).toHaveText('Duplicate');
    await expect(page.getByRole('button', { name: 'Duplicate "Published"' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Duplicate "Unpublished changes"' })).toBeVisible();
  });
});
