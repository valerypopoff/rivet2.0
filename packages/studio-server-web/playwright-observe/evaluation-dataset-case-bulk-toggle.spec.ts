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

    const caseToggleControls = frame.locator('.evaluation-case-enabled-control .scalable-toggle');
    const caseToggleInputs = frame.locator('.evaluation-case-enabled-control input');
    const firstCaseControl = caseToggleControls.nth(0);
    const secondCaseControl = caseToggleControls.nth(1);
    const firstCaseInput = caseToggleInputs.nth(0);
    const secondCaseInput = caseToggleInputs.nth(1);
    await expect(firstCaseInput).toBeChecked();
    await expect(secondCaseInput).toBeChecked();

    const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
    await firstCaseControl.click({ modifiers: [modifier] });
    await expect(firstCaseInput).not.toBeChecked();
    await expect(secondCaseInput).not.toBeChecked();

    await secondCaseControl.click();
    await expect(firstCaseInput).not.toBeChecked();
    await expect(secondCaseInput).toBeChecked();

    await firstCaseControl.click({ modifiers: [modifier] });
    await expect(firstCaseInput).toBeChecked();
    await expect(secondCaseInput).toBeChecked();
  });
});
