import { expect, test } from '@playwright/test';

import { authenticateIfNeeded, waitForDashboardReady } from './helpers/hostedEditorObserve';
import { seedHostedEditorProject } from './helpers/hostedEditorStorage';

test.describe('Evaluation workspace save shortcut', () => {
  test('does not save the open project whether the editor or dashboard owns Ctrl/Cmd+S', async ({ page }) => {
    test.slow();
    await seedHostedEditorProject(page, {
      graphId: 'evaluation-save-shortcut-graph',
      loaded: true,
      projectId: 'evaluation-save-shortcut-project',
      projectPath: '/workflows/Evaluation save shortcut.rivet-project',
      title: 'Evaluation save shortcut',
    });

    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await authenticateIfNeeded(page);
    await waitForDashboardReady(page);

    const iframe = page.locator('iframe.dashboard-editor-frame');
    await expect(iframe).toBeVisible({ timeout: 120_000 });
    const frame = page.frameLocator('iframe.dashboard-editor-frame');
    const evaluationsTab = frame.getByRole('navigation', { name: 'Workspace navigation' }).getByRole('button', {
      name: 'Evaluations',
    });
    await evaluationsTab.click();
    await expect(evaluationsTab).toHaveAttribute('aria-pressed', 'true');

    let projectSaveRequests = 0;
    page.on('request', (request) => {
      if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/projects/save') {
        projectSaveRequests += 1;
      }
    });

    const saveShortcut = process.platform === 'darwin' ? 'Meta+S' : 'Control+S';

    // The iframe owns this keydown when focus remains inside Evaluations.
    await evaluationsTab.press(saveShortcut);
    await page.waitForTimeout(500);

    // The outer dashboard owns this keydown because its sidebar has focus.
    await page.locator('aside.dashboard-sidebar').click();
    await page.keyboard.press(saveShortcut);
    await page.waitForTimeout(500);

    expect(projectSaveRequests).toBe(0);
  });
});
