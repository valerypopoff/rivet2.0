import { expect, test } from '@playwright/test';
import { authenticateIfNeeded, waitForDashboardReady } from './helpers/hostedEditorObserve';
import { requireManagedMutationOptIn } from './helpers/workflowLibraryObserve';

test.describe('Runtime library job cancellation', () => {
  test('cancel keeps the terminal failed state visible and does not duplicate streamed logs', async ({ page }) => {
    test.slow();
    requireManagedMutationOptIn();

    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await authenticateIfNeeded(page);
    await waitForDashboardReady(page);
    const modal = page.getByTestId('app-settings-modal');

    const settingsButton = page.getByRole('button', { name: 'Settings', exact: true });
    await expect(settingsButton).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(2_000);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await settingsButton.click({ force: true });
      try {
        await modal.waitFor({ state: 'visible', timeout: 5_000 });
        break;
      } catch (error) {
        if (attempt === 2) {
          throw error;
        }
        await page.waitForTimeout(1_000);
      }
    }

    await modal.getByRole('tab', { name: 'Runtime libraries' }).click();
    const panel = modal.locator('section[aria-label="Runtime libraries"]');
    await expect(panel).toBeVisible();

    const packageNameInput = panel.locator('#runtime-library-package-name');
    if ((await packageNameInput.count()) === 0) {
      const addButton = panel.locator('.runtime-libraries-add-button');
      await addButton.waitFor({ state: 'visible', timeout: 30_000 });
      await addButton.click();
      await packageNameInput.waitFor({ state: 'visible', timeout: 30_000 });
    }

    await packageNameInput.fill('sharp');
    await panel.locator('#runtime-library-package-version').fill('latest');
    await panel.getByRole('button', { name: 'Install' }).click();

    await panel.locator('.runtime-libraries-log-panel').waitFor({ state: 'visible', timeout: 30_000 });
    await panel.locator('.runtime-libraries-log-line').first().waitFor({ state: 'visible', timeout: 30_000 });

    await page.waitForTimeout(1_500);
    await panel.getByRole('button', { name: 'Cancel job' }).click();

    const failedStatus = panel.locator('.runtime-libraries-status.failed', {
      hasText: 'Cancelled by user',
    });
    await expect(failedStatus).toBeVisible({ timeout: 30_000 });
    await expect(failedStatus).toContainText('Cancelled by user');

    const logText = await panel.locator('.runtime-libraries-log-panel').textContent();
    expect((logText?.match(/--- Starting install job ---/g) ?? []).length).toBe(1);
    expect((logText?.match(/Running npm install\.\.\./g) ?? []).length).toBe(1);
  });
});
