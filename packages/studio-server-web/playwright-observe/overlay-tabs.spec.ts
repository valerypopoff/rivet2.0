import { expect, test } from '@playwright/test';
import { authenticateIfNeeded, mockHostedEditorBootstrap, waitForDashboardReady } from './helpers/hostedEditorObserve';
import { seedHostedEditorProject } from './helpers/hostedEditorStorage';

test.describe('Workspace navigation', () => {
  test('keeps workspace tabs at the right edge when project tabs overflow', async ({ page }) => {
    await mockHostedEditorBootstrap(page);
    await seedHostedEditorProject(page, {
      graphId: 'overflow-graph',
      loaded: true,
      projectId: 'overflow-project',
      projectPath: '/workflows/Overflow.rivet-project',
      title: 'Overflow',
      extraOpenedProjects: Array.from({ length: 29 }, (_, index) => ({
        graphId: `overflow-graph-${index}`,
        projectId: `overflow-project-${index}`,
        projectPath: `/workflows/Long project title ${index}.rivet-project`,
        title: `Long project title ${index}`,
      })),
    });
    await page.goto('/?editor', { waitUntil: 'domcontentloaded' });
    const navigation = page.getByRole('navigation', { name: 'Workspace navigation' });
    const tabs = page.locator('.projects-container .project');
    await expect(tabs).toHaveCount(30);

    for (const width of [1280, 768, 640]) {
      await page.setViewportSize({ width, height: 900 });
      await expect
        .poll(async () => {
          const box = await navigation.boundingBox();
          return box ? Math.abs(box.x + box.width - width) : Infinity;
        })
        .toBeLessThanOrEqual(1);
      await expect
        .poll(() => navigation.locator('.left-menu').evaluate((element) => element.scrollWidth <= element.clientWidth))
        .toBe(true);
      for (const name of ['Evaluations', 'Data Studio']) {
        await expect(navigation.getByRole('button', { name, exact: true })).toBeInViewport({ ratio: 1 });
        await navigation.getByRole('button', { name, exact: true }).click();
        await expect(navigation.getByRole('button', { name, exact: true })).toHaveAttribute('aria-pressed', 'true');
      }
      const projects = page.locator('.projects-container .projects');
      await projects.evaluate((element) => {
        element.scrollLeft = element.scrollWidth;
      });
      await expect(tabs.last()).toBeInViewport();
      const box = await navigation.boundingBox();
      expect(box!.x + box!.width).toBeCloseTo(width, 0);
    }
  });

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
