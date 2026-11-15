import { expect, test } from '@playwright/test';
import { authenticateIfNeeded, mockHostedEditorBootstrap, waitForDashboardReady } from './helpers/hostedEditorObserve';
import { expectStudioModalSizing } from './helpers/modalSizing';

test('dashboard dialogs share responsive dimensions, including nested schedule editing', async ({ page }) => {
  // No production writes or ambient project state are needed to measure the real shells.
  await page.route(
    (url) => url.pathname.startsWith('/api/'),
    (route) => route.fulfill({ status: 503, json: { error: 'Isolated sizing fixture' } }),
  );
  await mockHostedEditorBootstrap(page);
  await page.route('**/api/workflows/tree', (route) =>
    route.fulfill({
      json: { root: '/workflows', sync: { epoch: 'modal-sizing', revision: 0 }, folders: [], projects: [] },
    }),
  );
  await page.route('**/api/app-settings/local-upgrade/setup', (route) => route.fulfill({ json: { eligible: false } }));
  await page.route('**/api/workflows/scheduled-runs', (route) =>
    route.fulfill({ json: { schedules: [], history: [] } }),
  );
  await page.route('**/?editor', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<script>setInterval(() => parent.postMessage({type:"editor-ready",editorInstanceId:"fixture-editor"}, location.origin), 100)</script>',
    }),
  );
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await authenticateIfNeeded(page);
  await waitForDashboardReady(page);

  // A custom modal's parent is its full-screen backdrop, not an Atlaskit
  // positioner. Exercise the shared CSS against both semantic DOM shapes.
  await page.evaluate(() => {
    const backdrop = document.createElement('div');
    backdrop.dataset.testid = 'custom-modal-backdrop';
    Object.assign(backdrop.style, {
      position: 'fixed',
      inset: '0',
      display: 'grid',
      placeItems: 'center',
      zIndex: '99999',
    });
    const dialog = document.createElement('section');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.textContent = 'Custom modal layout fixture';
    backdrop.append(dialog);
    backdrop.addEventListener('click', (event) => {
      if (event.target === backdrop) backdrop.remove();
    });
    document.body.append(backdrop);
  });
  const customBackdrop = page.getByTestId('custom-modal-backdrop');
  await expectStudioModalSizing(customBackdrop.getByRole('dialog'));
  await expect(customBackdrop).toHaveCSS('width', '1600px');
  await expect(customBackdrop).toHaveCSS('height', '1000px');
  await page.mouse.click(2, 2);
  await expect(customBackdrop).toHaveCount(0);

  await page.setViewportSize({ width: 360, height: 1000 });
  await page.evaluate(() => {
    const drawer = document.createElement('aside');
    drawer.dataset.testid = 'drawer-sizing-fixture';
    drawer.className = 'run-activity-drawer';
    drawer.setAttribute('role', 'dialog');
    drawer.setAttribute('aria-modal', 'true');
    drawer.style.width = '100%';
    document.body.append(drawer);
  });
  await expect(page.getByTestId('drawer-sizing-fixture')).toHaveCSS('width', '360px');
  await page.getByTestId('drawer-sizing-fixture').evaluate((element) => element.remove());

  for (const [link, testId, close] of [
    ['Run recordings', 'run-recordings-modal', 'Close run recordings'],
    ['Run statistics', 'run-statistics-modal', 'Close run statistics'],
    ['Published', 'published-items-modal', 'Close published items'],
    ['Settings', 'app-settings-modal', 'Close app settings'],
    ['Scheduled runs', 'scheduled-runs-modal', 'Close'],
  ]) {
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.locator('.panel-bottom-actions').getByRole('button', { name: link, exact: true }).click();
    const modal = page.getByTestId(testId);
    for (const width of [1600, 740, 360]) {
      await page.setViewportSize({ width, height: 1000 });
      await expectStudioModalSizing(modal);
    }
    if (link === 'Scheduled runs') {
      await modal.getByRole('button', { name: '+ Add scheduled run', exact: true }).click();
      const editor = page.getByTestId('scheduled-run-editor-modal');
      for (const width of [360, 1600]) {
        await page.setViewportSize({ width, height: 1000 });
        await expectStudioModalSizing(editor);
        await expectStudioModalSizing(modal);
        await expect(editor.getByRole('button', { name: 'Save', exact: true })).toBeInViewport();
        await expect(editor.getByRole('button', { name: 'Preview next runs', exact: true })).toBeInViewport();
      }
      await editor.getByRole('button', { name: 'Close', exact: true }).click();
      await expect(editor).toHaveCount(0);
    }
    await modal.getByRole('button', { name: close, exact: true }).click();
    await expect(modal).toHaveCount(0);
  }
});

test('project settings uses vertical sections on wide and narrow viewports', async ({ page }, testInfo) => {
  const project = {
    id: 'vertical-sections',
    projectMetadataId: 'vertical-sections',
    revisionId: 'saved-1',
    name: 'Vertical sections',
    fileName: 'Vertical sections.rivet-project',
    relativePath: 'Vertical sections.rivet-project',
    absolutePath: '/workflows/Vertical sections.rivet-project',
    updatedAt: '',
    settings: {
      status: 'unpublished',
      publicationVersion: '0',
      endpointName: '',
      lastPublishedAt: null,
      publishedWebApps: [],
    },
  };
  await page.route(
    (url) => url.pathname.startsWith('/api/'),
    (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/api/workflows/tree')
        return route.fulfill({ json: { root: '/workflows', folders: [], projects: [project] } });
      if (path === '/api/workflows/projects/web-apps')
        return route.fulfill({
          json: {
            project,
            projectId: project.id,
            draftRevisionId: project.revisionId,
            publicationVersion: '0',
            hasMainGraph: true,
            savedLatestSubgraphProjectIds: [],
            webApps: [],
          },
        });
      return route.fulfill({ status: 503, json: { error: 'Isolated sizing fixture' } });
    },
  );
  await mockHostedEditorBootstrap(page);
  await page.goto('/');
  await authenticateIfNeeded(page);
  await waitForDashboardReady(page);
  await page.locator('.project-row', { hasText: project.name }).click();
  await page.locator('.active-project-more-button').click();
  const modal = page.getByTestId('workflow-project-settings-modal');
  await expect(modal).toBeVisible();
  const tabs = modal.getByRole('tablist', { name: 'Project settings sections' });
  expect(
    await tabs
      .locator(':scope > *')
      .evaluateAll((items) =>
        items.map((item) => (item.getAttribute('role') === 'separator' ? '---' : item.textContent?.trim())),
      ),
  ).toEqual([
    'Endpoint',
    'Web apps',
    '---',
    'LLM profile suspension',
    'Decision AI profile suspension',
    '---',
    'Published version history',
    '---',
    'Danger zone',
  ]);
  for (const viewport of [
    { width: 1600, height: 900 },
    { width: 620, height: 900 },
    { width: 1200, height: 400 },
    { width: 620, height: 400 },
  ]) {
    await page.setViewportSize(viewport);
    await expect(tabs).toHaveAttribute('aria-orientation', 'vertical');
    await modal.getByRole('tab', { name: 'Danger zone', exact: true }).click();
    const deleteProject = modal.getByRole('button', { name: 'Delete project', exact: true });
    await deleteProject.scrollIntoViewIfNeeded();
    await expect(deleteProject).toBeInViewport();
    await modal.getByRole('tab', { name: 'Endpoint', exact: true }).click();
    const endpoint = modal.getByRole('textbox', { name: 'Workflow endpoint path' });
    await endpoint.scrollIntoViewIfNeeded();
    await expect(endpoint).toBeInViewport();
    await expect(modal.getByRole('button', { name: 'Close project settings', exact: true })).toBeInViewport();
    expect(await modal.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
    await page.screenshot({ path: testInfo.outputPath(`project-settings-${viewport.width}-${viewport.height}.png`) });
  }
});
