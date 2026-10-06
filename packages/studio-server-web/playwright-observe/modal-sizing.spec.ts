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
      await modal.getByRole('button', { name: 'Add scheduled run', exact: true }).click();
      const editor = page.getByTestId('scheduled-run-editor-modal');
      for (const width of [360, 1600]) {
        await page.setViewportSize({ width, height: 1000 });
        await expectStudioModalSizing(editor);
        await expectStudioModalSizing(modal);
      }
      await editor.getByRole('button', { name: 'Cancel editing', exact: true }).click();
      await expect(editor).toHaveCount(0);
    }
    await modal.getByRole('button', { name: close, exact: true }).click();
    await expect(modal).toHaveCount(0);
  }
});
