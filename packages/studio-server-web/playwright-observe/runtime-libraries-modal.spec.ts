import { expect, test } from '@playwright/test';

import { authenticateIfNeeded, waitForDashboardReady } from './helpers/hostedEditorObserve';

test.describe('Runtime libraries settings tab', () => {
  test('shows a loading message before the runtime libraries state arrives', async ({ page }) => {
    test.slow();

    let librariesRequestCount = 0;
    let releaseLibrariesResponse: (() => void) | null = null;
    const librariesResponseReleased = new Promise<void>((resolve) => {
      releaseLibrariesResponse = resolve;
    });

    await page.route('**/api/runtime-libraries*', async (route) => {
      if (route.request().method() !== 'GET') {
        await route.fallback();
        return;
      }

      librariesRequestCount += 1;
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

    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const modal = page.getByTestId('app-settings-modal');
    await modal.getByRole('tab', { name: 'Runtime libraries' }).click();
    const panel = modal.locator('section[aria-label="Runtime libraries"]');
    await expect(panel).toBeVisible();
    await expect.poll(() => librariesRequestCount).toBe(1);
    await expect(panel.locator('.runtime-libraries-empty-state')).toHaveText('Loading runtime libraries...');
    releaseLibrariesResponse?.();
    await expect(panel.locator('.runtime-libraries-add-button')).toHaveText('Add library...', { timeout: 30_000 });

    await modal.getByRole('tab', { name: 'General' }).click();
    await expect(panel).toHaveCount(0);
    await modal.getByRole('tab', { name: 'Runtime libraries' }).click();
    await expect.poll(() => librariesRequestCount).toBe(2);
    await expect(modal.locator('section[aria-label="Runtime libraries"] .runtime-libraries-add-button')).toHaveText(
      'Add library...',
      { timeout: 30_000 },
    );
  });

  test('does not leak a job stream when an install response settles after leaving the tab', async ({ page }) => {
    let installStarted = false;
    let installSettled = false;
    let jobCompleted = false;
    let streamRequestCount = 0;
    let releaseInstallResponse: (() => void) | null = null;
    const installResponseReleased = new Promise<void>((resolve) => {
      releaseInstallResponse = resolve;
    });
    const job = {
      id: 'runtime-library-job-1',
      type: 'install',
      status: 'queued',
      packages: [{ name: 'example-package', version: 'latest' }],
      logs: [],
      logEntries: [],
      createdAt: '2026-09-16T10:00:00.000Z',
      lastProgressAt: '2026-09-16T10:00:00.000Z',
      cancelRequestedAt: null,
    };

    await page.route('**/api/runtime-libraries**', async (route) => {
      const url = new URL(route.request().url());
      if (route.request().method() === 'POST' && url.pathname.endsWith('/install')) {
        installStarted = true;
        await installResponseReleased;
        installSettled = true;
        await route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify(job) });
        return;
      }

      if (route.request().method() === 'GET' && url.pathname.endsWith('/stream')) {
        streamRequestCount += 1;
        jobCompleted = true;
        await route.fulfill({
          status: 200,
          contentType: 'text/event-stream',
          body: `data: ${JSON.stringify({
            type: 'done',
            status: 'succeeded',
            createdAt: '2026-09-16T10:00:01.000Z',
          })}\n\n`,
        });
        return;
      }

      if (route.request().method() === 'GET' && url.pathname.endsWith('/runtime-libraries')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            backend: 'managed',
            packages: {},
            hasActiveLibraries: false,
            updatedAt: '2026-09-16T10:00:00.000Z',
            activeJob: installSettled && !jobCompleted ? job : null,
            activeReleaseId: null,
            replicaReadiness: null,
          }),
        });
        return;
      }

      await route.fallback();
    });

    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await authenticateIfNeeded(page);
    await waitForDashboardReady(page);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const modal = page.getByTestId('app-settings-modal');
    await modal.getByRole('tab', { name: 'Runtime libraries' }).click();
    const panel = modal.locator('section[aria-label="Runtime libraries"]');
    await panel.locator('.runtime-libraries-add-button').click();
    await panel.locator('#runtime-library-package-name').fill('example-package');
    const installResponse = page.waitForResponse((response) => (
      response.request().method() === 'POST' && new URL(response.url()).pathname.endsWith('/install')
    ));
    await panel.getByRole('button', { name: 'Install' }).click();
    await expect.poll(() => installStarted).toBe(true);

    await modal.getByRole('tab', { name: 'General' }).click();
    releaseInstallResponse?.();
    await installResponse;
    await page.evaluate(() => new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    }));
    expect(streamRequestCount).toBe(0);

    await modal.getByRole('tab', { name: 'Runtime libraries' }).click();
    await expect.poll(() => streamRequestCount).toBe(1);
  });
});
