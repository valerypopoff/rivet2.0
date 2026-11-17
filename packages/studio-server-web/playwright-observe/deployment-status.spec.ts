import { expect, test } from '@playwright/test';

import { authenticateIfNeeded, mockHostedEditorBootstrap, waitForDashboardReady } from './helpers/hostedEditorObserve';

test.beforeEach(async ({ page }) => {
  await page.route(
    (url) => url.pathname.startsWith('/api/'),
    async (route) => {
      const name = new URL(route.request().url()).pathname;
      if (name === '/api/workflows/tree')
        return route.fulfill({
          json: { root: '/workflows', folders: [], projects: [], sync: { epoch: 'deployment-fixture', revision: 0 } },
        });
      if (name === '/api/app-settings/server-ui-session') return route.fulfill({ json: { mode: 'none', email: null } });
      if (name === '/api/app-settings/local-upgrade/status') return route.fulfill({ json: { available: false } });
      if (name === '/api/app-settings/local-upgrade/setup') return route.fulfill({ json: { eligible: false } });
      if (name === '/api/workflows/scheduled-runs/summary') return route.fulfill({ json: { enabledCount: 0 } });
      if (name === '/api/app-settings/runtime-limits')
        return route.fulfill({
          json: {
            commandTimeoutSeconds: 30,
            maxOutputBytes: 10485760,
            proxyReadTimeoutSeconds: 180,
            webAppActionRequestLimitBytes: 104857600,
            dockerWaitTimeoutSeconds: 1200,
          },
        });
      if (name === '/api/app-settings/published-execution')
        return route.fulfill({
          headers: { ETag: '"1"' },
          json: {
            maxActiveRunsPerPod: null,
            deploymentDefault: 32,
            effectiveMaxActiveRunsPerPod: 32,
            mode: 'enforce',
            source: 'deployment',
            editable: true,
            updatedAt: null,
          },
        });
      return route.fulfill({ status: 503, json: { error: 'No ambient API allowed in the deployment fixture.' } });
    },
  );
  await mockHostedEditorBootstrap(page);
});

test('live execution limits preserve edits on refresh and reconcile saves without replaying writes', async ({
  page,
}) => {
  let revision = 1,
    value: number | null = null,
    writes = 0;
  let failure: 'conflict' | 'lost' | 'unconfirmed' | null = null;
  await page.route('**/api/deployment-status', (route) =>
    route.fulfill({ json: { topology: 'replicated', apiProfile: 'control', replicaReadiness: null } }),
  );
  await page.route('**/api/app-settings/published-execution', async (route) => {
    if (['PUT', 'PATCH'].includes(route.request().method())) {
      writes++;
      expect(route.request().headers()['if-match']).toBe(`"${revision}"`);
      if (failure === 'conflict') {
        revision++;
        value = 64;
        failure = null;
        return route.fulfill({ status: 409, json: { error: 'Changed elsewhere' } });
      }
      if (failure === 'unconfirmed') {
        failure = null;
        return route.abort('failed');
      }
      value = route.request().postDataJSON().maxActiveRunsPerPod;
      revision++;
      if (failure === 'lost') {
        failure = null;
        return route.abort('failed');
      }
    }
    return route.fulfill({
      headers: { ETag: `"${revision}"` },
      json: {
        maxActiveRunsPerPod: value,
        deploymentDefault: 32,
        effectiveMaxActiveRunsPerPod: value ?? 32,
        source: value === null ? 'deployment' : 'app-settings',
        mode: 'enforce',
        editable: true,
        updatedAt: null,
      },
    });
  });
  await page.goto('/');
  await authenticateIfNeeded(page);
  await waitForDashboardReady(page);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const modal = page.getByTestId('app-settings-modal');
  await modal.getByRole('tab', { name: 'Deployment', exact: true }).click();
  const panel = modal.getByRole('region', { name: 'Published execution concurrency' });
  const input = panel.getByRole('spinbutton', { name: 'Concurrent runs per execution Pod' });
  const save = panel.getByRole('button', { name: 'Save', exact: true });
  await expect(input).toHaveValue('32');
  await input.fill('0');
  await expect(save).toBeDisabled();
  await expect(panel.getByRole('button', { name: 'Revert', exact: true })).toBeEnabled();
  await panel.getByRole('button', { name: 'Revert', exact: true }).click();
  await expect(input).toHaveValue('32');
  await input.fill('48');
  await page.waitForResponse((r) => new URL(r.url()).pathname === '/api/deployment-status');
  await expect(input).toHaveValue('48');
  await expect(input).toBeFocused();
  failure = 'lost';
  await save.click();
  await expect(panel).toContainText('Saved. Workers synchronize automatically');
  expect(writes).toBe(1);
  await panel.getByRole('button', { name: 'Use deployment default' }).click();
  await save.click();
  await expect(panel).toContainText('Saved. Workers synchronize automatically');
  await expect(panel).toContainText('Using deployment default');
  expect(value).toBeNull();
  await input.fill('16');
  failure = 'conflict';
  await save.click();
  await expect(panel).toContainText('Settings changed in another session');
  await expect(input).toHaveValue('16');
  failure = 'unconfirmed';
  await save.click();
  await expect(panel.locator('.project-settings-error')).toBeVisible();
  expect(writes).toBe(4);
  await save.click();
  await expect(panel).toContainText('Saved. Workers synchronize automatically');
  expect(value).toBe(16);
  await modal.getByRole('tab', { name: 'Shell execution', exact: true }).click();
  await modal.getByRole('tab', { name: 'Deployment', exact: true }).click();
  await expect(input).toHaveValue('16');
});

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
    await page.getByRole('button', { name: 'Settings', exact: true }).click();

    const appSettingsModal = page.locator('[data-testid="app-settings-modal"]');
    await expect(appSettingsModal).toBeVisible();
    await appSettingsModal.getByRole('tab', { name: 'Deployment' }).click();
    await expect(appSettingsModal.getByRole('tab', { name: 'Deployment' })).toHaveAttribute('aria-selected', 'true');
    await expect(appSettingsModal.getByText('Single-host deployment')).toBeVisible();
    await expect(appSettingsModal.getByText('This server: Combined editor and endpoint server')).toBeVisible();
    await expect(appSettingsModal.getByText('There is no second Rivet replica or automatic failover')).toBeVisible();
    await expect(appSettingsModal.locator('.app-settings-panel-region > .app-settings-actions-row')).toHaveCount(0);

    await appSettingsModal.getByRole('tab', { name: 'Shell execution' }).click();
    await expect(appSettingsModal.getByRole('tab', { name: 'Shell execution' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
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
              replicas: [
                {
                  replicaId: 'endpoint-1',
                  displayName: 'Endpoint 1',
                  syncState: 'ready',
                  isReadyForActiveRelease: true,
                  lastHeartbeatAt: new Date(Date.now() - 1_000).toISOString(),
                  syncedReleaseId: 'release-1',
                  lastError: null,
                },
              ],
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
