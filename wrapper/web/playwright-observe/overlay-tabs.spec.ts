import { expect, test } from '@playwright/test';
import { authenticateIfNeeded, waitForDashboardReady } from './helpers/hostedEditorObserve';

test.describe('Workspace navigation', () => {
  test('toggles current Rivet workspace panels through the upstream tab row', async ({ page }) => {
    test.slow();

    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await authenticateIfNeeded(page);
    await waitForDashboardReady(page);

    const firstFolder = page.locator('.folder-row').first();
    await expect(firstFolder).toBeVisible({ timeout: 120_000 });
    await firstFolder.click();

    const firstProject = page.locator('.project-row').first();
    await expect(firstProject).toBeVisible({ timeout: 30_000 });
    await firstProject.dblclick();

    const iframe = page.locator('iframe.dashboard-editor-frame');
    await expect(iframe).toBeVisible({ timeout: 120_000 });

    const frame = page.frameLocator('iframe.dashboard-editor-frame');
    const workspaceNav = frame.getByRole('navigation', { name: 'Workspace navigation' });
    const trivetTab = workspaceNav.getByRole('button', { name: 'Trivet Tests' });
    const dataStudioTab = workspaceNav.getByRole('button', { name: 'Data Studio' });
    const dataStudioMenuItem = workspaceNav.locator('.menu-item.data-studio');
    const trivetMenuItem = workspaceNav.locator('.menu-item.trivet-menu');

    await expect(workspaceNav).toBeVisible({ timeout: 120_000 });
    await expect(trivetTab).toBeVisible();
    await expect(dataStudioTab).toBeVisible();

    await dataStudioTab.click();
    await expect(dataStudioMenuItem).toHaveClass(/active/);

    await dataStudioTab.click();
    await expect(dataStudioMenuItem).not.toHaveClass(/active/);

    await trivetTab.click();
    await expect(trivetMenuItem).toHaveClass(/active/);

    await trivetTab.click();
    await expect(trivetMenuItem).not.toHaveClass(/active/);
  });
});
