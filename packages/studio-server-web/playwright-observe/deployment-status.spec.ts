import { expect, test } from '@playwright/test';

import { authenticateIfNeeded, waitForDashboardReady } from './helpers/hostedEditorObserve';

test.describe('Deployment status settings', () => {
  test('keeps replica heartbeat ages local and confirms stale cleanup', async ({ page }) => {
    // Begin with the single-host response so this test retains the VM/Docker
    // explanation without depending on the local Kubernetes test topology.
    await page.route('**/api/deployment-status', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          topology: 'single-host',
          apiProfile: 'combined',
          replicaReadiness: null,
        }),
      });
    });

    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await authenticateIfNeeded(page);
    await waitForDashboardReady(page);
    await page.getByRole('button', { name: 'App settings' }).click();

    const appSettingsModal = page.locator('[data-testid="app-settings-modal"]');
    await expect(appSettingsModal).toBeVisible();
    await appSettingsModal.getByRole('tab', { name: 'Deployment' }).click();
    await expect(appSettingsModal.getByRole('tab', { name: 'Deployment' })).toHaveAttribute('aria-selected', 'true');
    await expect(appSettingsModal.getByText('Single-host deployment')).toBeVisible();
    await expect(appSettingsModal.getByText('This server: Combined editor and endpoint server')).toBeVisible();
    await expect(appSettingsModal.getByText('There is no second Rivet replica or automatic failover')).toBeVisible();
    await expect(appSettingsModal.locator('.app-settings-panel-region > .app-settings-actions-row')).toHaveCount(0);

    await appSettingsModal.getByRole('tab', { name: 'Shell execution' }).click();
    await expect(appSettingsModal.getByRole('tab', { name: 'Shell execution' })).toHaveAttribute('aria-selected', 'true');
    await page.unroute('**/api/deployment-status');

    let replicatedStatusRequests = 0;
    let staleReplicaWasCleared = false;
    await page.route('**/api/deployment-status', async (route) => {
      replicatedStatusRequests += 1;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          topology: 'replicated',
          apiProfile: 'control',
          replicaReadiness: {
            activeReleaseId: 'release-1',
            heartbeatTtlMs: 30_000,
            endpoint: {
              tier: 'endpoint',
              liveReplicaCount: 1,
              readyReplicaCount: 1,
              staleReplicaCount: staleReplicaWasCleared ? 0 : 1,
              replicas: [{
                replicaId: 'endpoint-1',
                displayName: 'Endpoint 1',
                syncState: 'ready',
                isReadyForActiveRelease: true,
                lastHeartbeatAt: new Date(Date.now() - 1_000).toISOString(),
                syncedReleaseId: 'release-1',
                lastError: null,
              }],
            },
            editor: {
              tier: 'editor',
              liveReplicaCount: 0,
              readyReplicaCount: 0,
              staleReplicaCount: 0,
              replicas: [],
            },
          },
        }),
      });
    });
    await page.route('**/api/deployment-status/replicas/cleanup', async (route) => {
      staleReplicaWasCleared = true;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          deletedReplicaCount: 1,
          deletedReplicaIds: ['stale-endpoint-1'],
          staleBefore: new Date().toISOString(),
        }),
      });
    });

    await appSettingsModal.getByRole('tab', { name: 'Deployment' }).click();
    await expect(appSettingsModal.getByRole('tab', { name: 'Deployment' })).toHaveAttribute('aria-selected', 'true');
    await appSettingsModal.getByRole('button', { name: 'Show replica details' }).click();

    const heartbeatAge = appSettingsModal
      .locator('.deployment-status-replica-detail')
      .filter({ hasText: 'Last synchronization heartbeat:' })
      .first();
    await expect(heartbeatAge).toContainText(/Last synchronization heartbeat: \d+s ago/);
    const firstHeartbeatAge = await heartbeatAge.textContent();
    await page.waitForTimeout(1_100);
    await expect(heartbeatAge).not.toHaveText(firstHeartbeatAge ?? '');
    expect(replicatedStatusRequests).toBe(1);

    await appSettingsModal.getByRole('button', { name: 'Clear stale replicas' }).click();
    await expect(appSettingsModal.getByRole('status')).toHaveText('Cleared 1 stale replica record.');
    await expect(appSettingsModal.getByRole('button', { name: 'Clear stale replicas' })).toHaveCount(0);
  });
});
