import { expect, test } from '@playwright/test';

import { authenticateIfNeeded, waitForDashboardReady } from './helpers/hostedEditorObserve';
import { seedHostedEditorProject } from './helpers/hostedEditorStorage';

test.describe('Evaluation dataset case bulk enable toggle', () => {
  test('Ctrl/Cmd+click applies the switch target state to every case while a plain click changes only one', async ({
    page,
  }) => {
    test.slow();
    await seedHostedEditorProject(page, {
      graphId: 'evaluation-dataset-case-bulk-toggle-graph',
      loaded: true,
      projectId: 'evaluation-dataset-case-bulk-toggle-project',
      projectPath: '/workflows/Evaluation dataset case bulk toggle.rivet-project',
      title: 'Evaluation dataset case bulk toggle',
    });

    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await authenticateIfNeeded(page);
    await waitForDashboardReady(page);

    const iframe = page.locator('iframe.dashboard-editor-frame');
    await expect(iframe).toBeVisible({ timeout: 120_000 });
    const frame = page.frameLocator('iframe.dashboard-editor-frame');
    await frame
      .getByRole('navigation', { name: 'Workspace navigation' })
      .getByRole('button', { name: 'Evaluations' })
      .click();

    await frame
      .locator('.evaluation-sidebar-actions')
      .getByRole('button', { name: 'Create evaluation dataset' })
      .click();
    await frame.getByRole('button', { name: '+ Add case' }).click();
    await frame.getByRole('button', { name: '+ Add case' }).click();

    const caseToggles = frame.locator('.evaluation-case-enabled-control input');
    const firstCase = caseToggles.nth(0);
    const secondCase = caseToggles.nth(1);
    await expect(firstCase).toBeChecked();
    await expect(secondCase).toBeChecked();

    const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
    await firstCase.click({ modifiers: [modifier] });
    await expect(firstCase).not.toBeChecked();
    await expect(secondCase).not.toBeChecked();

    await secondCase.click();
    await expect(firstCase).not.toBeChecked();
    await expect(secondCase).toBeChecked();

    await firstCase.click({ modifiers: [modifier] });
    await expect(firstCase).toBeChecked();
    await expect(secondCase).toBeChecked();
  });
});
