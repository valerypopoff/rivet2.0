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
  await page.setViewportSize({ width: 1280, height: 720 });
  const now = Date.now(),
    periods: string[] = [];
  let deploymentStatusRequests = 0;
  let hang = false;
  let holdPeriod = false;
  let releasePeriod!: () => void;
  const periodGate = new Promise<void>((resolve) => {
    releasePeriod = resolve;
  });
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
  // The API averages only valid total samples. A bin can retain those averages
  // while complete=false reports that other samples in the bin were missing.
  const partialPoints = Array.from({ length: 5 }, (_, index) => ({
    ...point,
    at: now - (4 - index) * 60000,
    cpuMillicores: index === 2 ? null : 500 + index * 200,
    memoryBytes: index === 2 ? null : (256 + index * 64) * 1024 ** 2,
    complete: false,
  }));
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
    points: partialPoints.map((p) => ({ ...p, complete: p.cpuMillicores !== null })),
  };
  const control = {
    ...instance,
    identity: { ...identity, incarnation: 'control-container', name: 'control-one', role: 'control' },
    latest: { ...instance.latest, cpuMillicores: 250, memoryBytes: 1024 ** 3, activeRuns: null, runLimit: null },
    cpu: { ...stat, average: 250, p95: 300, peak: 400 },
    memory: { ...stat, average: 1024 ** 3, p95: 1024 ** 3, peak: 1024 ** 3 },
    points: [{ ...point, cpuMillicores: 250, memoryBytes: 1024 ** 3, activeRuns: null, runLimit: null }],
  };
  await page.route('**/api/deployment-status', (route) => {
    deploymentStatusRequests++;
    return route.fulfill({ json: { topology: 'replicated', apiProfile: 'control', replicaReadiness: null } });
  });
  await page.route('**/api/deployment-status/resources?*', async (route) => {
    const period = new URL(route.request().url()).searchParams.get('period')!;
    periods.push(period);
    if (hang) {
      await new Promise<void>((resolve) => releaseRequests.push(resolve));
      await route.abort().catch(() => {});
      return;
    }
    if (holdPeriod && period === '24h') await periodGate;
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
          control,
          {
            ...instance,
            identity: { ...identity, incarnation: 'previous-session' },
            lastSampleAt: now - 120000,
            latest: { ...instance.latest, at: now - 120000 },
          },
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
            latest: {
              ...instance.latest,
              at: now - 120000,
              workingSetBytes: null,
              lifetimeMemoryPeakBytes: null,
              activeRuns: null,
              runLimit: null,
            },
            allocation: {
              cpuRequestMillicores: null,
              memoryRequestBytes: null,
              cpuLimitMillicores: null,
              memoryLimitBytes: null,
            },
          },
        ]
          .filter((i) => period === '24h' || i.identity.incarnation !== 'fallback-two')
          .sort((a, b) => (period === '24h' ? a.identity.role.localeCompare(b.identity.role) : 0)),
        pools: [
          {
            scope: 'container',
            role: 'execution',
            cpu: stat,
            memory: instance.memory,
            latest: point,
            points: partialPoints,
          },
          {
            scope: 'container',
            role: 'control',
            cpu: control.cpu,
            memory: control.memory,
            latest: { ...control.latest, reporters: 1 },
            points: control.points.map((p) => ({ ...p, complete: false })),
          },
        ].sort((a, b) => (period === '24h' ? a.role.localeCompare(b.role) : 0)),
      },
    });
  });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await authenticateIfNeeded(page);
  await waitForDashboardReady(page);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const modal = page.locator('[data-testid="app-settings-modal"]');
  const navigation = modal.getByRole('tablist', { name: 'App settings sections' });
  await expect(navigation.getByRole('tab')).toHaveText([
    'General',
    'Endpoints',
    'Web apps',
    'Environment variables',
    'Run recordings',
    'Shell execution',
    'Node executor proxy',
    'Runtime libraries',
    'OAuth',
    'Rivet Server UI access',
    'Storage',
    'Docker',
    'Deployment',
    'CPU and RAM monitoring',
  ]);
  const separators = navigation.locator('[role="separator"]');
  await expect(separators).toHaveCount(3);
  await expect(separators.first()).toHaveCSS('border-top-width', '1px');
  expect(
    await separators.evaluateAll((elements) =>
      elements.map((element) => [
        element.previousElementSibling?.textContent?.trim(),
        element.nextElementSibling?.textContent?.trim(),
      ]),
    ),
  ).toEqual([
    ['General', 'Endpoints'],
    ['Environment variables', 'Run recordings'],
    ['OAuth', 'Rivet Server UI access'],
  ]);
  expect(periods).toEqual([]);
  await modal.getByRole('complementary', { name: 'Settings navigation' }).hover();
  await page.mouse.wheel(0, 800);
  const monitoringTab = modal.getByRole('tab', { name: 'CPU and RAM monitoring', exact: true });
  await expect(monitoringTab).toBeInViewport({ ratio: 1 });
  const tabSpacing = await monitoringTab.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const text = range.getBoundingClientRect();
    const button = element.getBoundingClientRect();
    return { lines: range.getClientRects().length, above: text.top - button.top, below: button.bottom - text.bottom };
  });
  expect(tabSpacing.lines).toBeGreaterThan(1);
  expect(tabSpacing.above).toBeGreaterThanOrEqual(6);
  expect(tabSpacing.below).toBeGreaterThanOrEqual(6);
  await monitoringTab.click();
  const panel = modal.getByRole('region', { name: 'Resource monitoring' });
  await expect(panel).toContainText(
    '2 monitoring sessions reported within the last 90 seconds · 3 sessions available for this period.',
  );
  await expect(panel).toContainText('Each start of a monitored server process creates a new monitoring session.');
  await expect(panel).toContainText('1000m = 1 CPU core');
  await expect(panel).toContainText('95% of sampled time');
  const cpuChart = panel
    .locator('.resource-chart')
    .filter({ has: page.getByRole('heading', { name: 'CPU usage (millicores)', exact: true }) });
  const memoryChart = panel
    .locator('.resource-chart')
    .filter({ has: page.getByRole('heading', { name: 'Container RAM usage', exact: true }) });
  for (const chart of [cpuChart, memoryChart]) {
    const curve = chart.locator('.recharts-line-curve');
    await expect(curve).toHaveAttribute('d', /L/);
    expect((await curve.getAttribute('d'))?.match(/M/g)).toHaveLength(2);
    await chart.scrollIntoViewIfNeeded();
    await chart.locator('svg.recharts-surface').hover({ position: { x: 100, y: 50 } });
    const timestamp = chart.locator('.recharts-tooltip-label');
    await expect(timestamp).toHaveText(
      await page.evaluate((at) => new Date(at).toLocaleString(), partialPoints[0]!.at),
    );
    const contrast = await timestamp.evaluate((element) => {
      const luminance = (color: string) => {
        const channels = color
          .match(/[\d.]+/g)!
          .slice(0, 3)
          .map(Number)
          .map((value) => {
            const channel = value / 255;
            return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
          });
        return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
      };
      const foreground = luminance(getComputedStyle(element).color);
      const background = luminance(getComputedStyle(element.closest('.recharts-default-tooltip')!).backgroundColor);
      return (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05);
    });
    expect(contrast).toBeGreaterThanOrEqual(4.5);
  }
  const resourceView = panel.getByRole('group', { name: 'Resource view', exact: true });
  const periodControl = panel.getByRole('group', { name: 'Resource history period', exact: true });
  await expect(periodControl).toHaveClass(/segmented-control/);
  await expect(periodControl.getByRole('button')).toHaveText(['1 hour', '24 hours', '7 days']);
  await expect(panel.getByRole('combobox', { name: 'Resource view' })).toHaveCount(0);
  await expect(resourceView).toHaveClass(/segmented-control/);
  await expect(resourceView.getByRole('button')).toHaveText(['Execution replicas', 'Editor and dashboard replicas']);
  await expect(resourceView.getByRole('button', { name: 'Execution replicas', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  const sessionCards = panel.locator('.resource-instance');
  await expect(sessionCards).toHaveCount(2);
  await expect(sessionCards.filter({ hasText: 'control-one' })).toHaveCount(0);
  await expect(sessionCards.filter({ hasText: 'control-two' })).toHaveCount(0);
  const currentExecution = panel.locator('.resource-instance').filter({ hasText: 'Monitoring session containe' });
  const previousExecution = panel.locator('.resource-instance').filter({ hasText: 'Monitoring session previous' });
  await expect(currentExecution).toContainText('Execution replica');
  await expect(currentExecution).toContainText('Recent samples');
  await expect(previousExecution).toContainText('execution-one');
  await expect(previousExecution).toContainText('No recent samples');
  await expect(currentExecution).toContainText('Container lifetime RAM peak');
  await expect(currentExecution).toContainText('Across the container lifetime, not just the selected period.');
  expect(deploymentStatusRequests).toBe(0);
  await expect(modal.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0);
  await expect(modal.getByRole('button', { name: 'Revert', exact: true })).toHaveCount(0);
  await expect(panel).toContainText('7 / 32');
  const executionStats = await panel.locator('.resource-stats').innerText();
  const requestsBeforeViewChange = periods.length;
  const controlView = resourceView.getByRole('button', { name: 'Editor and dashboard replicas', exact: true });
  await controlView.focus();
  const pendingView = await controlView.evaluate(async (element) => {
    (element as HTMLButtonElement).click();
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    return {
      selected: element.getAttribute('aria-pressed'),
      busy: element.getAttribute('aria-busy'),
      spinner: element.querySelector('.segmented-control-spinner') !== null,
      spinnerOpacity: getComputedStyle(element.querySelector('.segmented-control-spinner')!).opacity,
      labelOpacity: getComputedStyle(element.querySelector('.segmented-control-loading-label')!).opacity,
    };
  });
  expect(pendingView).toEqual({
    selected: 'true',
    busy: 'true',
    spinner: true,
    spinnerOpacity: '0',
    labelOpacity: '1',
  });
  await expect(controlView).toHaveAttribute('aria-pressed', 'true');
  await expect(resourceView.getByRole('button', { name: 'Execution replicas', exact: true })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  await expect(sessionCards).toHaveCount(1);
  await expect(sessionCards.first()).toContainText('control-one');
  await expect(panel.locator('.resource-stats').first()).toContainText('Average 250m');
  await expect(controlView).not.toHaveAttribute('aria-busy', 'true');
  await expect(controlView.locator('.segmented-control-spinner')).toHaveCount(0);
  await expect(panel.locator('.resource-stats')).not.toHaveText(executionStats, { useInnerText: true });
  for (const chart of [cpuChart, memoryChart]) {
    await expect(chart.locator('.recharts-line-dot')).toHaveCount(1);
  }
  await resourceView.getByRole('button', { name: 'Execution replicas', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(panel.locator('.resource-stats')).toContainText('Average 1,250m');
  await controlView.click();
  await expect(panel.locator('.resource-stats')).toContainText('Average 250m');
  expect(periods).toHaveLength(requestsBeforeViewChange);
  const day = periodControl.getByRole('button', { name: '24 hours', exact: true });
  const hour = periodControl.getByRole('button', { name: '1 hour', exact: true });
  const periodButtonWidth = (await day.boundingBox())!.width;
  const layout = () =>
    panel.evaluate((element) => {
      const top = element.getBoundingClientRect().top;
      return [
        ...element.querySelectorAll('.app-settings-field-label, .resource-views, .resource-stats, .resource-chart'),
      ].map((item) => item.getBoundingClientRect().top - top);
    });
  const beforeLoading = await layout();
  holdPeriod = true;
  try {
    await day.click();
    await expect(day).toHaveAttribute('aria-pressed', 'true');
    await expect(day).toHaveAttribute('aria-busy', 'true');
    expect(await layout()).toEqual(beforeLoading);
    const appearanceAt = (elapsed: number) =>
      day.evaluate((element, at) => {
        const spinner = element.querySelector('.segmented-control-spinner')!;
        const label = element.querySelector('.segmented-control-loading-label')!;
        for (const target of [spinner, label])
          for (const animation of target.getAnimations()) {
            animation.pause();
            animation.currentTime = at;
          }
        return { spinner: getComputedStyle(spinner).opacity, label: getComputedStyle(label).opacity };
      }, elapsed);
    expect(await appearanceAt(149)).toEqual({ spinner: '0', label: '1' });
    expect(await appearanceAt(151)).toEqual({ spinner: '1', label: '0' });
    await expect(day).toBeEnabled();
    expect((await day.boundingBox())!.width).toBe(periodButtonWidth);
    await expect(panel.locator('.resource-chart')).toHaveCount(2);
    expect(await layout()).toEqual(beforeLoading);
    await hour.click();
    await expect(hour).toHaveAttribute('aria-pressed', 'true');
    await expect(hour).not.toHaveAttribute('aria-busy', 'true');
    await expect(day).not.toHaveAttribute('aria-busy', 'true');
    await expect(day.locator('.segmented-control-spinner')).toHaveCount(0);
    expect(await layout()).toEqual(beforeLoading);
  } finally {
    holdPeriod = false;
    releasePeriod();
  }
  await day.click();
  await expect.poll(() => periods.includes('24h')).toBe(true);
  await expect(panel).toContainText('At least 2 additional monitoring sessions are not shown.');
  await expect(day).not.toHaveAttribute('aria-busy', 'true');
  expect((await layout()).slice(0, 2)).toEqual(beforeLoading.slice(0, 2));
  await expect(resourceView.getByRole('button')).toHaveText([
    'Execution replicas',
    'Editor and dashboard replicas',
    'Editor and dashboard replicas — server process only (RSS)',
  ]);
  await resourceView
    .getByRole('button', { name: 'Editor and dashboard replicas — server process only (RSS)', exact: true })
    .click();
  await expect(sessionCards).toHaveCount(1);
  await expect(sessionCards.first()).toContainText('control-two');
  await expect(sessionCards.first()).toContainText('No recent samples');
  await expect(panel.locator('.resource-instance').filter({ hasText: 'control-two' })).toContainText(
    'Editor and dashboard replica',
  );
  await expect(panel.locator('.resource-instance').filter({ hasText: 'control-two' })).toContainText('Not reported');
  await expect(sessionCards.first()).toContainText('Server process only (RSS)');
  await expect(panel).toContainText(
    'Historical totals are not available yet. Latest session readings are shown below.',
  );
  await expect(panel.locator('.resource-chart')).toHaveCount(0);
  await expect(modal.getByRole('spinbutton', { name: 'Concurrent runs per execution replica' })).toHaveCount(0);
  await panel.getByRole('button', { name: '1 hour', exact: true }).click();
  await expect(resourceView.getByRole('button')).toHaveText(['Execution replicas', 'Editor and dashboard replicas']);
  await expect(resourceView.getByRole('button', { name: 'Execution replicas', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(sessionCards).toHaveCount(2);
  await expect(cpuChart.locator('.recharts-line-curve')).toHaveAttribute('d', /L/);
  await page.setViewportSize({ width: 560, height: 720 });
  await resourceView.scrollIntoViewIfNeeded();
  for (const button of await resourceView.getByRole('button').all()) await expect(button).toBeInViewport();
  expect(await resourceView.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.setViewportSize({ width: 1280, height: 720 });
  // A lost network response must not freeze the last values in a fresh state.
  await page.clock.install();
  hang = true;
  try {
    const week = periodControl.getByRole('button', { name: '7 days', exact: true });
    const beforeTimeout = await layout();
    await week.click();
    await expect.poll(() => periods.includes('7d')).toBe(true);
    await expect(week).toHaveAttribute('aria-busy', 'true');
    await expect(week.locator('.segmented-control-spinner')).toHaveCSS('opacity', '1');
    expect(await layout()).toEqual(beforeTimeout);
    await page.clock.fastForward(10100);
    await expect(panel).toContainText('Monitoring request timed out.');
    await expect(week).not.toHaveAttribute('aria-busy', 'true');
    const beforeRetry = await layout();
    await hour.click();
    await expect(hour).toHaveAttribute('aria-busy', 'true');
    await expect(panel).toContainText('Monitoring request timed out.');
    expect(await layout()).toEqual(beforeRetry);
    await page.clock.fastForward(120000);
    await expect(currentExecution).toContainText('No recent samples');
    await expect(panel).toContainText('0 monitoring sessions reported within the last 90 seconds');
  } finally {
    releaseRequests.forEach((release) => release());
  }
  await modal.getByRole('tab', { name: 'Deployment', exact: true }).click();
  await expect(modal.getByRole('spinbutton', { name: 'Concurrent runs per execution replica' })).toHaveValue('32');
  await expect(modal.locator('.deployment-status-panel .app-settings-section-title')).toHaveText([
    'Deployment topology',
    'Code runtime synchronization',
    'Published execution concurrency',
  ]);
  await expect(panel).toHaveCount(0);
  const requestsAfterLeavingMonitoring = periods.length;
  await page.clock.fastForward(60000);
  expect(periods).toHaveLength(requestsAfterLeavingMonitoring);
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
  const input = panel.getByRole('spinbutton', { name: 'Concurrent runs per execution replica' });
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
  await modal.getByRole('tab', { name: 'CPU and RAM monitoring', exact: true }).click();
  await modal.getByRole('tab', { name: 'Deployment', exact: true }).click();
  await expect(input).toHaveValue('48');
  failure = 'lost';
  await save.click();
  await expect(panel).toContainText('Saved. Execution replicas synchronize automatically');
  expect(writes).toBe(1);
  await expect(panel.getByRole('button', { name: 'Use deployment default' })).toHaveCount(0);
  await expect(panel).not.toContainText('Custom limit');
  await expect(panel).not.toContainText('deployment default:');
  await input.fill('32');
  await save.click();
  await expect(panel).toContainText('Saved. Execution replicas synchronize automatically');
  expect(value).toBe(32);
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
  await expect(panel).toContainText('Saved. Execution replicas synchronize automatically');
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
    await expect(appSettingsModal.locator('.deployment-status-panel .app-settings-section-title')).toHaveText([
      'Deployment topology',
    ]);
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
    await expect(appSettingsModal.locator('.deployment-status-panel .app-settings-section-title')).toHaveText([
      'Deployment topology',
      'Code runtime synchronization',
      'Published execution concurrency',
    ]);
    await expect(
      appSettingsModal.locator('.deployment-status-replica-tier').filter({ hasText: 'Execution replicas' }),
    ).toContainText('1 / 1 synchronized');
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
