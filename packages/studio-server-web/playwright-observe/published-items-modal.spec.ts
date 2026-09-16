import { expect, test } from '@playwright/test';
import { serializeProject, type GraphId, type Project, type ProjectId } from '@valerypopoff/rivet2-core';
import { authenticateIfNeeded, waitForDashboardReady } from './helpers/hostedEditorObserve';
import { seedHostedEditorProject } from './helpers/hostedEditorStorage';

test('published catalog lists endpoint and app references and opens their project', async ({ page }) => {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  const sourceId = 'published-catalog-source' as ProjectId;
  const sourceGraphId = 'published-catalog-source-graph' as GraphId;
  const sourcePath = '/workflows/Catalog Source.rivet-project';
  const targetId = 'published-catalog-target' as ProjectId;
  const targetGraphId = 'published-catalog-target-graph' as GraphId;
  const targetPath = '/workflows/Published Target.rivet-project';
  const targetProject: Project = {
    metadata: { id: targetId, title: 'Published Target', mainGraphId: targetGraphId },
    graphs: {
      [targetGraphId]: {
        metadata: { id: targetGraphId, name: 'Main Graph' },
        nodes: [],
        connections: [],
      },
    },
    plugins: [],
  } as Project;
  const extraEndpointProjects = Array.from({ length: 12 }, (_, index) => ({
    id: `published-catalog-extra-${index}`,
    projectMetadataId: `published-catalog-extra-${index}`,
    name: `Published endpoint ${index + 1}`,
    fileName: `Published endpoint ${index + 1}.rivet-project`,
    relativePath: `Published endpoint ${index + 1}.rivet-project`,
    absolutePath: `/workflows/Published endpoint ${index + 1}.rivet-project`,
    updatedAt: '2026-09-16T00:00:00.000Z',
    settings: {
      status: 'published',
      publicationStatus: 'published',
      endpointName: `extra-endpoint-${index + 1}`,
      lastPublishedAt: '2026-09-16T00:00:00.000Z',
      publishedWebApps: [],
    },
  }));

  await seedHostedEditorProject(page, {
    graphId: sourceGraphId,
    loaded: true,
    projectId: sourceId,
    projectPath: sourcePath,
    title: 'Catalog Source',
  });

  await page.route('**/api/workflows/tree', (route) =>
    route.fulfill({
      json: {
        folders: [],
        projects: [
          {
            id: sourceId,
            projectMetadataId: sourceId,
            name: 'Catalog Source',
            fileName: 'Catalog Source.rivet-project',
            relativePath: 'Catalog Source.rivet-project',
            absolutePath: sourcePath,
            updatedAt: '2026-09-16T00:00:00.000Z',
            settings: {
              status: 'unpublished',
              publicationStatus: 'unpublished',
              endpointName: '',
              lastPublishedAt: null,
              publishedWebApps: [],
            },
          },
          {
            id: targetId,
            projectMetadataId: targetId,
            name: 'Published Target',
            fileName: 'Published Target.rivet-project',
            relativePath: 'Published Target.rivet-project',
            absolutePath: targetPath,
            updatedAt: '2026-09-16T00:00:00.000Z',
            settings: {
              status: 'unpublished_changes',
              publicationStatus: 'unpublished_changes',
              endpointName: 'story-endpoint',
              lastPublishedAt: '2026-09-16T00:00:00.000Z',
              publishedWebApps: [
                {
                  uiGraphId: 'published-catalog-app',
                  uiGraphName: 'Story console',
                  slug: 'story-console',
                  publishedAt: '2026-09-16T00:00:00.000Z',
                  allowedEmails: [],
                  status: 'published',
                },
              ],
            },
          },
          ...extraEndpointProjects,
        ],
        root: '/workflows',
        sync: { epoch: 'published-catalog', revision: 0 },
      },
    }),
  );

  await page.route('**/api/projects/load', async (route) => {
    const request = route.request().postDataJSON() as { path: string };
    expect(request.path).toBe(targetPath);
    await route.fulfill({
      json: {
        contents: serializeProject(targetProject),
        datasetsContents: null,
        revisionId: 'published-catalog-target-revision',
      },
    });
  });

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await authenticateIfNeeded(page);
  await waitForDashboardReady(page);

  const serverSidebar = page.locator('.dashboard-sidebar');
  await page.getByRole('button', { name: 'Published', exact: true }).focus();
  await page.keyboard.press('Tab');
  await expect(serverSidebar).toHaveClass(/dashboard-sidebar-collapsed/);
  await page.keyboard.press('Tab');
  await expect(serverSidebar).not.toHaveClass(/dashboard-sidebar-collapsed/);

  await page.getByRole('button', { name: 'Published', exact: true }).click();
  const modal = page.getByTestId('published-items-modal');
  await expect(modal).toBeVisible();
  const endpointsTab = modal.getByRole('tab', { name: 'Endpoints (13)' });
  const webAppsTab = modal.getByRole('tab', { name: 'Web apps (1)' });
  const changedStatus = modal.locator('.published-item-status-unpublished_changes');
  const endpointRoute = modal.getByRole('button', { name: 'Copy /workflows/story-endpoint' });
  const appRoute = modal.getByRole('button', { name: 'Copy /apps/story-console' });
  await expect(endpointsTab).toHaveAttribute('aria-selected', 'true');
  await expect(webAppsTab).toHaveAttribute('aria-selected', 'false');
  await expect(changedStatus).toBeVisible();
  await expect(endpointRoute).toBeVisible();
  await expect(appRoute).toHaveCount(0);
  await endpointsTab.focus();
  await page.keyboard.press('Shift');
  await expect(endpointsTab).toHaveCSS('outline-style', 'none');
  await modal.focus();
  await page.keyboard.press('Shift');
  await expect(modal).toHaveCSS('outline-style', 'none');
  const endpointCopyIcon = endpointRoute.locator('.published-item-route-copy-icon');
  await expect(endpointCopyIcon).toHaveCSS('opacity', '0');
  await endpointRoute.hover();
  await expect(endpointCopyIcon).toHaveCSS('opacity', '1');

  const header = page.getByTestId('published-items-modal--header');
  const closeButton = modal.getByRole('button', { name: 'Close published items' });
  await expect
    .poll(() => closeButton.evaluate((element) => getComputedStyle(element, '::before').content))
    .toBe('"×"');
  const firstEndpointItem = modal.locator('.published-item').first();
  const modalScrollableContent = page.getByTestId('published-items-modal--scrollable');
  const [headerBox, closeButtonBox, firstEndpointItemBox, scrollableContentBox] = await Promise.all([
    header.boundingBox(),
    closeButton.boundingBox(),
    firstEndpointItem.boundingBox(),
    modalScrollableContent.boundingBox(),
  ]);
  expect(headerBox).not.toBeNull();
  expect(closeButtonBox).not.toBeNull();
  expect(firstEndpointItemBox).not.toBeNull();
  expect(scrollableContentBox).not.toBeNull();
  expect(closeButtonBox!.x + closeButtonBox!.width).toBeCloseTo(headerBox!.x + headerBox!.width, 0);
  expect(closeButtonBox!.y).toBeCloseTo(headerBox!.y, 0);
  expect(firstEndpointItemBox!.x).toBeGreaterThan(scrollableContentBox!.x + 12);
  expect(firstEndpointItemBox!.x + firstEndpointItemBox!.width).toBeLessThan(
    scrollableContentBox!.x + scrollableContentBox!.width - 12,
  );

  const endpointName = modal.getByText('story-endpoint', { exact: true });
  const endpointProject = modal.getByRole('button', { name: 'Project: Published Target' });
  await expect(endpointProject.locator('.published-item-project-label')).toHaveCSS('color', 'rgb(187, 187, 187)');
  await expect(endpointProject.locator('.published-item-project-name')).toHaveCSS('color', 'rgb(255, 255, 255)');
  const [endpointNameBox, endpointProjectBox, changedStatusBox] = await Promise.all([
    endpointName.boundingBox(),
    endpointProject.boundingBox(),
    changedStatus.boundingBox(),
  ]);
  expect(endpointNameBox).not.toBeNull();
  expect(endpointProjectBox).not.toBeNull();
  expect(changedStatusBox).not.toBeNull();
  expect(endpointProjectBox!.x).toBeCloseTo(endpointNameBox!.x, 0);
  expect(changedStatusBox!.x).toBeCloseTo(endpointNameBox!.x, 0);
  expect(changedStatusBox!.y).toBeGreaterThan(endpointProjectBox!.y);

  const tabBeforeScroll = await endpointsTab.boundingBox();
  const scrollMetrics = await modalScrollableContent.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
  }));
  expect(scrollMetrics.scrollHeight).toBeGreaterThan(scrollMetrics.clientHeight);
  await modalScrollableContent.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect.poll(() => modalScrollableContent.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  const tabAfterScroll = await endpointsTab.boundingBox();
  expect(tabBeforeScroll).not.toBeNull();
  expect(tabAfterScroll).not.toBeNull();
  expect(tabAfterScroll!.y).toBeCloseTo(tabBeforeScroll!.y, 0);

  const changedStatusColors = await changedStatus.evaluate((element) => {
    const style = getComputedStyle(element);
    return { background: style.backgroundColor, color: style.color };
  });

  await webAppsTab.click();
  await expect(webAppsTab).toHaveAttribute('aria-selected', 'true');
  await expect(endpointRoute).toHaveCount(0);
  await expect(appRoute).toBeVisible();
  const publishedStatus = modal.locator('.published-item-status-published');
  await expect(publishedStatus).toBeVisible();
  const publishedStatusColors = await publishedStatus.evaluate((element) => {
    const style = getComputedStyle(element);
    return { background: style.backgroundColor, color: style.color };
  });
  expect(publishedStatusColors).not.toEqual(changedStatusColors);
  await appRoute.click();
  await expect(appRoute).toHaveText('Copied: /apps/story-console');
  const expectedCopiedUrl = await page.evaluate(() =>
    new URL('/apps/story-console', window.location.origin).toString(),
  );
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(expectedCopiedUrl);

  await modal.getByRole('button', { name: 'Project: Published Target' }).first().click();
  await expect(modal).toHaveCount(0);
  const editor = page.frameLocator('iframe.dashboard-editor-frame');
  await expect(editor.locator('.project-tree-header-title')).toHaveText('Published Target', { timeout: 120_000 });
  await expect(editor.locator('.project-tree-header-label')).toHaveCSS('color', 'rgb(187, 187, 187)');
  await expect(editor.locator('.project-tree-header-title')).toHaveCSS('color', 'rgb(255, 255, 255)');
  const canvas = editor.locator('.node-canvas').first();
  await canvas.click({ position: { x: 450, y: 250 } });
  const editorSidebar = editor.locator('#graph-tree-sidebar');
  await page.keyboard.press('Tab');
  await expect(editorSidebar).toHaveAttribute('style', /translateX\(-100%\)/);
  await expect(serverSidebar).not.toHaveClass(/dashboard-sidebar-collapsed/);
  await page.keyboard.press('Tab');
  await expect(editorSidebar).toHaveAttribute('style', /translateX\(0(px)?\)/);
});
