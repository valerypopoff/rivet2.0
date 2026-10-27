import { expect, test, type Page } from '@playwright/test';

import { authenticateIfNeeded, mockHostedEditorBootstrap, waitForDashboardReady } from './helpers/hostedEditorObserve';

type StatisticsRequest = {
  target: { surface: string; workflowId: string; uiGraphId?: string; componentId?: string };
  period: { from: string; to: string };
  runKind: string;
  includeFailed: boolean;
  includeWarnings: boolean;
  aggregation: 'auto' | 'day' | 'week';
  costAggregation?: 'auto' | 'day' | 'week';
};
type CostMode = 'available' | 'partial' | 'unknown' | 'none';

function getStatisticsResponse(request: StatisticsRequest, costMode: CostMode = 'none') {
  const hasMatchingRuns = request.runKind !== 'latest';
  const secondBucketFrom = new Date(Date.parse(request.period.from) + 60 * 60 * 1000).toISOString();
  const includedRunCount = hasMatchingRuns
    ? 3 + Number(request.includeFailed) + Number(request.includeWarnings)
    : 0;

  const cost = costMode === 'available'
    ? { runCount: includedRunCount, completeCount: 3, partialCount: Number(request.includeFailed), unknownCount: Number(request.includeWarnings), knownCostUsd: 0.0009 + (request.includeFailed ? 0.0003 : 0), averageCompleteCostUsd: 0.0003 }
    : costMode === 'partial'
      ? { runCount: includedRunCount, completeCount: 0, partialCount: includedRunCount, unknownCount: 0, knownCostUsd: 0.0003 * includedRunCount, averageCompleteCostUsd: null }
      : { runCount: includedRunCount, completeCount: 0, partialCount: 0, unknownCount: includedRunCount, knownCostUsd: null, averageCompleteCostUsd: null };
  if (costMode === 'available' && request.target.workflowId === 'workflow-b') {
    Object.assign(cost, { completeCount: 2, partialCount: 0, unknownCount: includedRunCount - 2, knownCostUsd: 0.012, averageCompleteCostUsd: 0.006 });
  }
  return {
    target: request.target,
    period: request.period,
    current: {
      runCount: includedRunCount,
      medianDurationMs: hasMatchingRuns ? 1_250 : null,
      p95DurationMs: hasMatchingRuns ? 2_200 : null,
      averageDurationMs: hasMatchingRuns ? 1_400 : null,
      minDurationMs: hasMatchingRuns ? 900 : null,
      maxDurationMs: hasMatchingRuns ? 2_400 : null,
    },
    currentStatusCounts: hasMatchingRuns ? { succeeded: 3, failed: 1, suspicious: 1 } : { succeeded: 0, failed: 0, suspicious: 0 },
    currentExcludedStatusCounts: {
      succeeded: 0,
      failed: request.includeFailed ? 0 : 1,
      suspicious: request.includeWarnings ? 0 : 1,
    },
    buckets: hasMatchingRuns ? [
      {
        from: request.period.from,
        to: secondBucketFrom,
        runCount: 3,
        medianDurationMs: 1_250,
        p95DurationMs: 2_200,
        averageDurationMs: 1_400,
        minDurationMs: 900,
        maxDurationMs: 2_400,
      },
      {
        from: secondBucketFrom,
        to: request.period.to,
        runCount: 2,
        medianDurationMs: 1_100,
        p95DurationMs: 1_900,
        averageDurationMs: 1_300,
        minDurationMs: 800,
        maxDurationMs: 2_000,
      },
    ].slice(0, request.aggregation === 'week' ? 1 : 2) : [],
    ...(hasMatchingRuns && costMode !== 'none' ? {
      cost,
      costBuckets: [
        { from: request.period.from, to: secondBucketFrom, ...cost },
        { from: secondBucketFrom, to: request.period.to, ...cost },
      ].slice(0, (request.costAggregation ?? request.aggregation) === 'week' ? 1 : 2),
    } : {}),
  };
}

async function installRunStatisticsRoutes(page: Page, costMode: CostMode = 'none') {
  const catalogRequests: URL[] = [];
  const statisticsRequests: StatisticsRequest[] = [];
  let releaseWebAppCatalog = () => {};
  let releaseArchiveStatistics = () => {};
  const webAppCatalogReady = new Promise<void>((resolve) => {
    releaseWebAppCatalog = resolve;
  });
  const archiveStatisticsReady = new Promise<void>((resolve) => {
    releaseArchiveStatistics = resolve;
  });

  await page.route('**/api/workflows/run-statistics/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === 'GET' && url.pathname.endsWith('/targets')) {
      catalogRequests.push(url);
      const surface = url.searchParams.get('surface');
      const targets = surface === 'web_app'
        ? [{
          target: { surface: 'web_app', workflowId: 'workflow-a', uiGraphId: 'ui-report', componentId: 'generate' },
          projectName: 'Report project',
          uiGraphName: 'Summary app',
          componentType: 'button',
          componentLabel: 'Generate summary',
          latestRunAt: '2026-08-04T12:00:00.000Z',
          totalRuns: 3,
        }]
        : [
          {
            target: { surface: 'endpoint', workflowId: 'workflow-a' },
            projectName: 'Report project',
            latestRunAt: '2026-08-04T12:00:00.000Z',
            totalRuns: 3,
          },
          {
            target: { surface: 'endpoint', workflowId: 'workflow-b' },
            projectName: 'Archive project',
            latestRunAt: '2026-08-04T11:00:00.000Z',
            totalRuns: 2,
          },
        ];
      if (surface === 'web_app') await webAppCatalogReady;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          surface,
          targets,
        }),
      });
      return;
    }

    if (request.method() === 'POST' && url.pathname.endsWith('/query')) {
      const body = request.postDataJSON() as StatisticsRequest;
      statisticsRequests.push(body);
      if (body.target.workflowId === 'workflow-b') await archiveStatisticsReady;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(getStatisticsResponse(body, costMode)) });
      return;
    }

    await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Unexpected statistics request' }) });
  });

  return { catalogRequests, releaseArchiveStatistics, releaseWebAppCatalog, statisticsRequests };
}

test.describe('Run statistics modal', () => {
  test.beforeEach(async ({ page }) => {
    await page.route((url) => url.pathname.startsWith('/api/'), (route) => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === '/api/workflows/tree') return route.fulfill({ json: { root: '/workflows', folders: [], projects: [] } });
      return route.fulfill({ status: 503, json: { error: 'Unavailable in isolated UI fixture' } });
    });
    await mockHostedEditorBootstrap(page);
  });

  for (const costMode of ['available', 'partial', 'unknown', 'none'] as const) {
    test(`shows ${costMode} cost estimates with shared outcome filters`, async ({ page }) => {
      await installRunStatisticsRoutes(page, costMode);
      await page.goto('/', { waitUntil: 'domcontentloaded' });
      await waitForDashboardReady(page);
      await page.getByRole('button', { name: 'Run statistics', exact: true }).click();
      const modal = page.getByTestId('run-statistics-modal');
      const cost = modal.getByRole('region', { name: 'Cost statistics' });
      await expect(cost).toBeVisible();
      await expect(modal.locator('.run-statistics-period-label')).toHaveText(/^3 runs, .+ to .+$/);
      await expect(modal.getByText(/^\d+ (complete|partial|unknown)/)).toHaveCount(0);
      if (costMode === 'available') {
        await expect(cost).toContainText('Known subtotal');
        await expect(cost).toContainText('Cost over time');
        await expect(cost).toContainText(/0[.,]0009/);
        await expect(cost.getByRole('group', { name: 'Cost chart metric' })).toHaveCount(0);
        await expect(cost.locator('.recharts-legend-item-text')).toHaveText(['Average per complete run', 'Known subtotal']);
        await expect(cost.locator('.recharts-line')).toHaveCount(2);
      } else if (costMode === 'partial') {
        await expect(cost).toContainText('No complete cost estimates to average');
        await expect(cost.locator('.recharts-line').first().locator('.recharts-line-curve')).toHaveAttribute('d', /\S/);
        await expect(cost.locator('.recharts-line').nth(1).locator('.recharts-line-curve')).not.toHaveAttribute('d', /\S/);
      } else if (costMode === 'unknown') {
        await expect(cost).toContainText('No known cost estimates');
        await expect(cost).not.toContainText('Cost over time');
      } else {
        await expect(cost).toContainText('Cost statistics are not available from this server yet.');
        await expect(modal.getByTestId('cost-coverage')).toHaveCount(0);
      }
      const included = modal.getByRole('group', { name: 'Included runs', exact: true });
      await included.getByLabel('Include failed runs').check();
      await expect(modal.getByRole('region', { name: 'Timing statistics' }).getByLabel('Include failed runs')).toHaveCount(0);
      await expect(cost.getByLabel('Include failed runs')).toHaveCount(0);
      await expect(modal.locator('.run-statistics-period-label')).toHaveText(/^4 runs, .+ to .+$/);
      await expect(modal.getByText(/^\d+ (complete|partial|unknown)/)).toHaveCount(0);
      await expect(modal.getByText(/\d+ included runs\./)).toHaveCount(0);
      if (costMode === 'available') {
        // Cost adds a second chart: wheel scrolling must still reach its controls
        // on smaller windows, without relying on programmatic scrollIntoView.
        for (const width of [850, 390]) {
          await page.setViewportSize({ width, height: 700 });
          await modal.locator('.run-statistics-details').evaluate((panel) => { panel.scrollTop = 0; });
          await modal.locator('.run-statistics-details').hover();
          const grouping = cost.getByRole('button', { name: 'By week' });
          await expect.poll(async () => {
            await page.mouse.wheel(0, 120);
            return grouping.evaluate((button) => new Promise<boolean>((resolve) => {
              const observer = new IntersectionObserver(([entry]) => {
                observer.disconnect();
                resolve((entry?.intersectionRatio ?? 0) >= 0.99);
              });
              observer.observe(button);
            }));
          }, { timeout: 10_000, intervals: [75] }).toBe(true);
          await expect.poll(() => cost.getByRole('group', { name: 'Cost chart grouping' }).evaluate((group) =>
            Array.from(group.querySelectorAll('button')).every((button) => button.scrollWidth <= button.clientWidth),
          )).toBe(true);
          await modal.locator('.run-statistics-details').evaluate((panel) => { panel.scrollTop = panel.scrollHeight; });
          for (const label of ['Known subtotal', 'Average per complete run']) {
            await expect(cost.locator('.recharts-legend-item-text').filter({ hasText: label })).toBeInViewport();
          }
          await modal.screenshot({ path: test.info().outputPath(`run-statistics-${width}.png`) });
        }
      }
    });
  }

  test('shows only enabled outcome cards and centers shared filters beside the switchers', async ({ page }) => {
    const { catalogRequests, releaseArchiveStatistics, releaseWebAppCatalog, statisticsRequests } = await installRunStatisticsRoutes(page, 'available');
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await authenticateIfNeeded(page);
    await waitForDashboardReady(page);

    await page.getByRole('button', { name: 'Run statistics', exact: true }).click();
    const modal = page.getByTestId('run-statistics-modal');
    await expect(modal).toBeVisible();
    await expect(page.getByTestId('run-statistics-modal--blanket')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0.56)');
    await expect(modal).toHaveCSS('background-color', 'rgb(31, 31, 34)');
    await expect(page.getByTestId('run-statistics-modal--body')).toHaveCSS('padding-top', '0px');
    await expect(modal.locator('.run-statistics-header-row')).toHaveCSS('padding-bottom', '14px');
    const runTypeSwitcher = modal.locator('.run-statistics-header-row').getByRole('group', { name: 'Run type' });
    await expect(runTypeSwitcher).toBeVisible();
    await expect(runTypeSwitcher).toHaveClass(/segmented-control/);
    await expect(runTypeSwitcher.getByRole('button', { name: 'Endpoints' })).toHaveCSS('height', '28px');
    await expect(runTypeSwitcher.getByRole('button', { name: 'Endpoints' })).toHaveAttribute('aria-pressed', 'true');
    await expect(modal.locator('.run-statistics-content').getByRole('group', { name: 'Run type' })).toHaveCount(0);
    const headerLeadBox = await modal.locator('.run-statistics-help').boundingBox();
    const switcherBox = await runTypeSwitcher.boundingBox();
    expect(switcherBox?.y).toBeGreaterThan(headerLeadBox?.y ?? Number.POSITIVE_INFINITY);
    expect(switcherBox?.x).toBeCloseTo(headerLeadBox?.x ?? Number.NaN, 0);
    const targetSelect = modal.getByRole('combobox', { name: 'Workflow endpoint' });
    await expect(targetSelect).toBeVisible();
    await expect(modal.locator('.run-statistics-target-select__single-value')).toHaveText('Report project');
    await modal.locator('.run-statistics-target-select__control').click();
    const endpointTargetMenu = page.locator('.run-statistics-target-select__menu');
    await expect(endpointTargetMenu).toBeVisible();
    await expect(endpointTargetMenu).toContainText('Archive project');
    await endpointTargetMenu.getByText('Report project', { exact: true }).click();
    await expect(modal.locator('.run-statistics-sidebar')).toHaveCount(0);
    const targetControlBox = await modal.locator('.run-statistics-target-control').boundingBox();
    const filtersBox = await modal.locator('.run-statistics-controls').boundingBox();
    expect(targetControlBox?.y).toBeLessThan(filtersBox?.y ?? Number.POSITIVE_INFINITY);
    await expect(modal.locator('.run-statistics-target-title')).toHaveCount(0);
    const cost = modal.getByRole('region', { name: 'Cost statistics' });
    await expect(modal.getByTestId('cost-coverage')).toHaveCount(0);
    await expect(cost.locator('.run-statistics-metric-value').first()).toContainText(/0[.,]0009/);
    await expect(modal.locator('.run-statistics-metric-card').first()).toContainText('1.25 s');
    await expect(modal.locator('.run-statistics-metric-delta')).toHaveCount(0);
    await expect(modal.getByText(/faster|slower|no change/i)).toHaveCount(0);
    const metricCardBox = await modal.locator('.run-statistics-metric-card').first().boundingBox();
    expect(metricCardBox?.height).toBeLessThan(82);
    const outcomes = modal.getByRole('region', { name: 'Run outcomes' });
    const timingStatistics = modal.getByRole('region', { name: 'Timing statistics' });
    await expect(outcomes).toHaveCount(0);
    await expect(timingStatistics.getByText('Duration', { exact: true })).toBeVisible();
    await expect(cost.getByText('Cost', { exact: true })).toBeVisible();
    for (const box of [timingStatistics, cost]) {
      await expect(box).toHaveCSS('border-width', '1px');
      await expect(box).toHaveCSS('border-radius', '12px');
    }
    const included = modal.getByRole('group', { name: 'Included runs', exact: true });
    const includedBox = await included.boundingBox();
    const periodBox = await modal.locator('.run-statistics-period-label').boundingBox();
    expect(includedBox!.y + includedBox!.height).toBeLessThan(periodBox!.y);
    await expect(modal.locator('.run-statistics-controls').getByRole('group', { name: 'Included runs' })).toHaveCount(1);
    await expect(modal.locator('.run-statistics-period-label')).toHaveText(/^3 runs, .+ to .+$/);
    const versionSwitcher = await modal.getByRole('group', { name: 'Version', exact: true }).boundingBox();
    const periodSwitcher = await modal.getByRole('group', { name: 'Period', exact: true }).boundingBox();
    for (const label of ['Include failed runs', 'Include runs with warnings']) {
      const checkbox = await included.getByLabel(label).boundingBox();
      for (const switcher of [versionSwitcher, periodSwitcher]) {
        expect(Math.abs(checkbox!.y + checkbox!.height / 2 - (switcher!.y + switcher!.height / 2))).toBeLessThanOrEqual(1);
      }
    }
    await expect(modal.getByRole('button', { name: 'Auto', exact: true })).toHaveCount(0);
    const durationBox = await timingStatistics.boundingBox();
    const costBox = await cost.boundingBox();
    expect(includedBox!.y + includedBox!.height).toBeLessThan(durationBox!.y);
    await expect(timingStatistics.getByTestId('cost-coverage')).toHaveCount(0);
    await expect(cost.getByTestId('cost-coverage')).toHaveCount(0);
    expect(durationBox!.y + durationBox!.height).toBeLessThan(costBox!.y);
    await modal.screenshot({ path: test.info().outputPath('run-statistics-panels.png') });
    await expect(modal.locator('.recharts-line-curve').nth(0)).toHaveAttribute('stroke', '#5aa9ff');
    await expect(modal.locator('.recharts-line-curve').nth(1)).toHaveAttribute('stroke', '#c58aff');
    expect(catalogRequests[0]?.searchParams.get('surface')).toBe('endpoint');
    expect(catalogRequests[0]?.searchParams.get('from')).toBeNull();
    expect(catalogRequests[0]?.searchParams.get('to')).toBeNull();
    expect(catalogRequests[0]?.searchParams.get('runKind')).toBeNull();
    expect(statisticsRequests[0]?.includeFailed).toBe(false);
    expect(statisticsRequests[0]?.aggregation).toBe('day');
    expect(statisticsRequests).toHaveLength(1);

    await modal.getByRole('button', { name: 'Latest' }).click();
    await expect(modal.getByText('No runs for this target match the selected period and version.')).toBeVisible();
    await expect(modal.locator('.run-statistics-target-select__single-value')).toHaveText('Report project');
    expect(catalogRequests).toHaveLength(1);
    await modal.getByRole('button', { name: 'Published' }).click();
    await expect(modal.locator('.run-statistics-metric-card').first()).toContainText('1.25 s');

    const durationGrouping = timingStatistics.getByRole('group', { name: 'Duration chart grouping' });
    const costGrouping = cost.getByRole('group', { name: 'Cost chart grouping' });
    await expect(durationGrouping.getByRole('button', { name: 'By day' })).toHaveAttribute('aria-pressed', 'true');
    await expect(costGrouping.getByRole('button', { name: 'By day' })).toHaveAttribute('aria-pressed', 'true');
    const beforeSeparateGrouping = statisticsRequests.length;
    await durationGrouping.getByRole('button', { name: 'By week' }).click();
    await expect(timingStatistics.locator('.recharts-xAxis .recharts-cartesian-axis-tick')).toHaveCount(1);
    await expect(cost.locator('.recharts-xAxis .recharts-cartesian-axis-tick')).toHaveCount(2);
    expect(
      statisticsRequests.slice(beforeSeparateGrouping).map(({ aggregation, costAggregation }) =>
        [aggregation, costAggregation]),
    ).toEqual([['week', 'day']]);
    await expect(costGrouping.getByRole('button', { name: 'By day' })).toHaveAttribute('aria-pressed', 'true');
    const beforeMatchingGrouping = statisticsRequests.length;
    await costGrouping.getByRole('button', { name: 'By week' }).click();
    await expect(cost.locator('.recharts-xAxis .recharts-cartesian-axis-tick')).toHaveCount(1);
    await expect(durationGrouping.getByRole('button', { name: 'By week' })).toHaveAttribute('aria-pressed', 'true');
    expect(
      statisticsRequests.slice(beforeMatchingGrouping).map(({ aggregation, costAggregation }) =>
        [aggregation, costAggregation]),
    ).toEqual([['week', 'week']]);

    await targetSelect.press('ArrowDown');
    await targetSelect.press('ArrowDown');
    await targetSelect.press('Enter');
    await expect(modal.locator('.run-statistics-target-select__single-value')).toHaveText('Archive project');
    await expect.poll(() => statisticsRequests.at(-1)?.target.workflowId).toBe('workflow-b');
    await expect(modal.getByText('Calculating statistics...')).toBeVisible();
    await expect(modal.locator('.run-statistics-metric-card')).toHaveCount(0);
    await expect(modal.getByRole('region', { name: 'Run outcomes' })).toHaveCount(0);
    await expect(cost).toHaveCount(0);
    releaseArchiveStatistics();
    await expect(modal.locator('.run-statistics-metric-card').first()).toContainText('1.25 s');
    await expect(modal.locator('.run-statistics-period-label')).toHaveText(/^3 runs, .+ to .+$/);
    await expect(cost.locator('.run-statistics-metric-value').first()).toContainText(/0[.,]012/);
    await expect(cost.locator('.run-statistics-metric-value').nth(1)).toContainText(/0[.,]006/);
    await expect(cost.locator('.recharts-line')).toHaveCount(2);
    const chartHeader = cost.locator('.run-statistics-chart-header');
    const chartTitle = await chartHeader.getByText('Cost', { exact: true }).boundingBox();
    const chartControls = await chartHeader.getByRole('group', { name: 'Cost chart grouping' }).boundingBox();
    expect(chartControls!.x).toBeGreaterThan(chartTitle!.x + chartTitle!.width);
    expect(Math.abs(chartControls!.y - chartTitle!.y)).toBeLessThan(12);
    await expect(modal.getByTestId('cost-coverage')).toHaveCount(0);
    await expect(cost.getByTestId('cost-coverage')).toHaveCount(0);
    await chartHeader.scrollIntoViewIfNeeded();
    await modal.screenshot({ path: test.info().outputPath('run-statistics-cost-header.png') });

    for (const [failed, warnings, percentages] of [
      [false, false, [null, null, null]],
      [true, false, ['75%', '25%', null]],
      [false, true, ['75%', null, '25%']],
      [true, true, ['60%', '20%', '20%']],
    ] as const) {
      await included.getByLabel('Include failed runs').setChecked(failed);
      await included.getByLabel('Include runs with warnings').setChecked(warnings);
      await expect(modal.getByRole('region', { name: 'Timing statistics' })).toBeVisible();
      if (failed || warnings) await expect(outcomes).toBeVisible();
      else await expect(outcomes).toHaveCount(0);
      for (const [index, tone] of ['succeeded', 'failed', 'warning'].entries()) {
        const card = outcomes.locator(`.run-statistics-outcome-card.${tone}`);
        const value = outcomes.locator(`.${tone} .run-statistics-outcome-value`);
        if (percentages[index] === null) await expect(card).toHaveCount(0);
        else {
          await expect(card).toHaveCount(1);
          await expect(value).toHaveText(percentages[index]!);
        }
      }
    }

    await modal.getByRole('button', { name: 'Web apps' }).click();
    await expect(modal.getByText('Loading available runs...')).toBeVisible();
    await expect(modal.getByRole('combobox', { name: 'Workflow endpoint' })).toHaveCount(0);
    await expect(modal.locator('.run-statistics-period-label')).toHaveCount(0);
    releaseWebAppCatalog();
    const webAppSelect = modal.getByRole('combobox', { name: 'Web app action' });
    await expect(webAppSelect).toBeVisible();
    await expect(modal.locator('.run-statistics-target-select__single-value')).toHaveText('Summary app - Generate summary');
    await modal.locator('.run-statistics-target-select__control').click();
    const webAppTargetMenu = page.locator('.run-statistics-target-select__menu');
    await expect(webAppTargetMenu).toBeVisible();
    await expect(webAppTargetMenu).toContainText('Summary app - Generate summary');
    await webAppTargetMenu.getByText('Summary app - Generate summary', { exact: true }).click();
    await expect(modal.locator('.run-statistics-target-select__single-value')).toHaveText('Summary app - Generate summary');
    await expect.poll(() => catalogRequests.at(-1)?.searchParams.get('surface')).toBe('web_app');
    await expect.poll(() => statisticsRequests.at(-1)?.target.surface).toBe('web_app');
    await expect(modal.locator('.run-statistics-period-label')).toHaveText(/^5 runs, .+ to .+$/);
    await expect(cost.locator('.run-statistics-metric-value').first()).toContainText(/0[.,]0012/);
  });
});
