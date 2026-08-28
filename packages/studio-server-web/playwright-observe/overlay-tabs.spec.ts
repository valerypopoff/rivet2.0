import { expect, test } from '@playwright/test';
import { authenticateIfNeeded, waitForDashboardReady } from './helpers/hostedEditorObserve';
import { seedHostedEditorProject } from './helpers/hostedEditorStorage';

test.describe('Workspace navigation', () => {
  test('switches current Rivet workspace panels through the upstream tab row', async ({ page }) => {
    test.slow();

    await seedHostedEditorProject(page, {
      graphId: 'workspace-navigation-graph',
      loaded: true,
      projectId: 'workspace-navigation-project',
      projectPath: '/workflows/Workspace Navigation.rivet-project',
      title: 'Workspace Navigation',
    });

    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await authenticateIfNeeded(page);
    await waitForDashboardReady(page);

    const iframe = page.locator('iframe.dashboard-editor-frame');
    await expect(iframe).toBeVisible({ timeout: 120_000 });

    const frame = page.frameLocator('iframe.dashboard-editor-frame');
    const workspaceNav = frame.getByRole('navigation', { name: 'Workspace navigation' });
    const evaluationsTab = workspaceNav.getByRole('button', { name: 'Evaluations' });
    const dataStudioTab = workspaceNav.getByRole('button', { name: 'Data Studio' });
    const dataStudioMenuItem = workspaceNav.locator('.menu-item.data-studio');
    const evaluationsMenuItem = workspaceNav.locator('.menu-item.evaluations-menu');

    await expect(workspaceNav).toBeVisible({ timeout: 120_000 });
    await expect(evaluationsTab).toBeVisible();
    await expect(dataStudioTab).toBeVisible();

    await dataStudioTab.click();
    await expect(dataStudioMenuItem).toHaveClass(/active/);
    await expect(dataStudioTab).toHaveAttribute('aria-pressed', 'true');

    await evaluationsTab.click();
    await expect(evaluationsMenuItem).toHaveClass(/active/);
    await expect(dataStudioMenuItem).not.toHaveClass(/active/);
    await expect(evaluationsTab).toHaveAttribute('aria-pressed', 'true');

    await dataStudioTab.click();
    await expect(evaluationsMenuItem).not.toHaveClass(/active/);
    await expect(dataStudioMenuItem).toHaveClass(/active/);
  });
});
