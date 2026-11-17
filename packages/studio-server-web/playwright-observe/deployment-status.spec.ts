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
      if (name === '/api/deployment-status/resources')
        return route.fulfill({
          json: {
            available: true,
            error: null,
            period: '1h',
            from: Date.now() - 3600000,
            to: Date.now(),
            generatedAt: Date.now(),
            sampleIntervalMs: 5000,
            staleAfterMs: 90000,
            percentile: 'approximate-duration-weighted',
            instances: [],
            pools: [],
            omittedInstances: 0,
          },
        });
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

test('resource monitoring distinguishes container and process data, unknown allocations and stale samples', async ({
  page,
}) => {
  const now = Date.now(),
    periods: string[] = [];
  let hang = false;
  const releaseRequests: Array<() => void> = [];
  const stat = { average: 1250, p95: 1800, peak: 2000, coverageMs: 3500000 };
  const point = {
    at: now,
    cpuMillicores: 1250,
    memoryBytes: 512 * 1024 ** 2,
    workingSetBytes: 400 * 1024 ** 2,
    activeRuns: 7,
    runLimit: 32,
    reporters: 1,
    complete: true,
  };
  const identity = {
    installation: 'fixture/rivet',
    incarnation: 'container-one',
    name: 'execution-one',
    role: 'execution',
    source: 'cgroup-v2',
  };
  const instance = {
    identity,
    allocation: {
      cpuRequestMillicores: 2000,
      memoryRequestBytes: 4 * 1024 ** 3,
      cpuLimitMillicores: null,
      memoryLimitBytes: null,
    },
    firstSampleAt: now - 3600000,
    lastSampleAt: now,
    latest: { ...point, durationMs: 5000, lifetimeMemoryPeakBytes: 1024 ** 3 },
    droppedSamples: 0,
    cpu: stat,
    memory: { ...stat, average: 512 * 1024 ** 2, peak: 800 * 1024 ** 2, p95: 600 * 1024 ** 2 },
    workingSet: stat,
    points: [point],
  };
  await page.route('**/api/deployment-status', (route) =>
    route.fulfill({ json: { topology: 'replicated', apiProfile: 'control', replicaReadiness: null } }),
  );
  await page.route('**/api/deployment-status/resources?*', async (route) => {
    const period = new URL(route.request().url()).searchParams.get('period')!;
    periods.push(period);
    if (hang) {
      await new Promise<void>((resolve) => releaseRequests.push(resolve));
      await route.abort().catch(() => {});
      return;
    }
    return route.fulfill({
      json: {
        available: true,
        error: null,
        period,
        from: now - 3600000,
        to: now,
        generatedAt: now,
        sampleIntervalMs: 5000,
        staleAfterMs: 90000,
        percentile: 'approximate-duration-weighted',
        omittedInstances: period === '24h' ? 2 : 0,
        instances: [
          instance,
          {
            ...instance,
            identity: {
              ...identity,
              incarnation: 'fallback-two',
              name: 'control-two',
              role: 'control',
              source: 'node-process',
            },
            lastSampleAt: now - 120000,
            latest: { ...instance.latest, at: now - 120000, workingSetBytes: null, lifetimeMemoryPeakBytes: null },
            allocation: {
              cpuRequestMillicores: null,
              memoryRequestBytes: null,
              cpuLimitMillicores: null,
              memoryLimitBytes: null,
            },
          },
        ],
        pools: [
          {
            scope: 'container',
            role: 'execution',
            cpu: stat,
            memory: instance.memory,
            latest: point,
            points: [point],
          },
        ],
      },
    });
  });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await authenticateIfNeeded(page);
  await waitForDashboardReady(page);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const modal = page.locator('[data-testid="app-settings-modal"]');
  await modal.getByRole('tab', { name: 'Deployment', exact: true }).click();
  const panel = modal.getByRole('region', { name: 'Resource monitoring' });
  await expect(panel).toContainText('1 currently reporting instances');
  await expect(panel).toContainText('7 / 32');
  await expect(panel.locator('.resource-instance').filter({ hasText: 'control-two' })).toContainText(
    'Stale / unavailable',
  );
  await expect(panel.locator('.resource-instance').filter({ hasText: 'control-two' })).toContainText('Not configured');
  await panel.getByRole('combobox', { name: 'Resource history instance' }).selectOption('fallback-two');
  await expect(panel.getByRole('heading', { name: 'Node process RSS', exact: true })).toBeVisible();
  await panel.getByRole('button', { name: '24 hours', exact: true }).click();
  await expect.poll(() => periods.includes('24h')).toBe(true);
  await expect(panel).toContainText('At least 2 additional instance histories');
  await expect(panel.locator('option').filter({ hasText: 'Execution pool' })).toHaveText(/1 in latest observation/);
  await expect(modal.getByRole('spinbutton', { name: 'Concurrent runs per execution Pod' })).toHaveValue('32');
  // A lost network response must not freeze the last values in a fresh state.
  await page.clock.install();
  hang = true;
  try {
    await panel.getByRole('button', { name: '7 days', exact: true }).click();
    await expect.poll(() => periods.includes('7d')).toBe(true);
    await page.clock.fastForward(10100);
    await expect(panel).toContainText('Monitoring request timed out.');
    await page.clock.fastForward(120000);
    await expect(panel.locator('.resource-instance').filter({ hasText: 'execution-one' })).toContainText(
      'Stale / unavailable',
    );
    await expect(modal.getByRole('spinbutton', { name: 'Concurrent runs per execution Pod' })).toHaveValue('32');
  } finally {
    releaseRequests.forEach((release) => release());
  }
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
