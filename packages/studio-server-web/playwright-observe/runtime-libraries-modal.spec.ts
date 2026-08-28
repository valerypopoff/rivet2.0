import { expect, test } from '@playwright/test';

import { authenticateIfNeeded, waitForDashboardReady } from './helpers/hostedEditorObserve';

test.describe('Runtime libraries modal', () => {
  test('shows a loading message before the runtime libraries state arrives', async ({ page }) => {
    test.slow();

    let sawLibrariesRequest = false;
    let releaseLibrariesResponse: (() => void) | null = null;
    const librariesResponseReleased = new Promise<void>((resolve) => {
      releaseLibrariesResponse = resolve;
    });

    await page.route('**/api/runtime-libraries*', async (route) => {
      if (route.request().method() !== 'GET') {
        await route.fallback();
        return;
      }

      sawLibrariesRequest = true;
      await librariesResponseReleased;

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          backend: 'managed',
          packages: {},
          hasActiveLibraries: false,
          updatedAt: '2026-04-08T10:00:00.000Z',
          activeJob: null,
          activeReleaseId: null,
          replicaReadiness: null,
        }),
      });
    });

    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await authenticateIfNeeded(page);
    await waitForDashboardReady(page);

    await page.getByRole('button', { name: 'Runtime libraries' }).click();
    const modal = page.getByTestId('runtime-libraries-modal');
    await expect(modal).toBeVisible();
    await expect.poll(() => sawLibrariesRequest).toBe(true);
    await expect(modal.locator('.runtime-libraries-empty-state')).toHaveText('Loading runtime libraries...');
    releaseLibrariesResponse?.();
    await expect(modal.locator('.runtime-libraries-add-button')).toHaveText('Add library...', { timeout: 30_000 });
  });
});
