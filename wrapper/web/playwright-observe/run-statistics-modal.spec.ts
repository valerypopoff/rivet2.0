import { expect, test, type Page } from '@playwright/test';

import { authenticateIfNeeded, waitForDashboardReady } from './helpers/hostedEditorObserve';

type StatisticsRequest = {
  target: { surface: string; workflowId: string; uiGraphId?: string; componentId?: string };
  period: { from: string; to: string };
  runKind: string;
  includeFailed: boolean;
  includeWarnings: boolean;
};

function getStatisticsResponse(request: StatisticsRequest) {
  const secondBucketFrom = new Date(Date.parse(request.period.from) + 60 * 60 * 1000).toISOString();
  const includedRunCount = 3 + Number(request.includeFailed) + Number(request.includeWarnings);

  return {
    target: request.target,
    period: request.period,
    current: {
      runCount: includedRunCount,
      medianDurationMs: 1_250,
      p95DurationMs: 2_200,
      averageDurationMs: 1_400,
      minDurationMs: 900,
      maxDurationMs: 2_400,
    },
    currentStatusCounts: { succeeded: 3, failed: 1, suspicious: 1 },
    currentExcludedStatusCounts: {
      succeeded: 0,
      failed: request.includeFailed ? 0 : 1,
      suspicious: request.includeWarnings ? 0 : 1,
    },
    buckets: [
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
    ],
  };
}

async function installRunStatisticsRoutes(page: Page) {
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
          period: { from: url.searchParams.get('from'), to: url.searchParams.get('to') },
          targets,
        }),
      });
      return;
    }

    if (request.method() === 'POST' && url.pathname.endsWith('/query')) {
      const body = request.postDataJSON() as StatisticsRequest;
      statisticsRequests.push(body);
      if (body.target.workflowId === 'workflow-b') await archiveStatisticsReady;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(getStatisticsResponse(body)) });
      return;
    }

    await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Unexpected statistics request' }) });
  });

  return { catalogRequests, releaseArchiveStatistics, releaseWebAppCatalog, statisticsRequests };
}

test.describe('Run statistics modal', () => {
  test('shows all run outcomes before successful-run timing statistics', async ({ page }) => {
    const { catalogRequests, releaseArchiveStatistics, releaseWebAppCatalog, statisticsRequests } = await installRunStatisticsRoutes(page);
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await authenticateIfNeeded(page);
    await waitForDashboardReady(page);

    await page.getByRole('button', { name: 'Run statistics' }).click();
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
    await expect(modal.locator('.run-statistics-target-title')).toHaveText('Report project');
    await expect(modal.locator('.run-statistics-metric-card').first()).toContainText('1.25 s');
    await expect(modal.locator('.run-statistics-metric-delta')).toHaveCount(0);
    await expect(modal.getByText(/faster|slower|no change/i)).toHaveCount(0);
    const metricCardBox = await modal.locator('.run-statistics-metric-card').first().boundingBox();
    expect(metricCardBox?.height).toBeLessThan(82);
    const outcomes = modal.getByRole('region', { name: 'Run outcomes' });
    const timingStatistics = modal.getByRole('region', { name: 'Timing statistics' });
    await expect(outcomes).toContainText('Errors');
    await expect(outcomes).toContainText('20%');
    await expect(timingStatistics).toContainText('Successful runs are included by default.');
    await expect(timingStatistics).toHaveCSS('border-top-width', '1px');
    await expect(timingStatistics).toHaveCSS('padding-top', '18px');
    const outcomesBox = await outcomes.boundingBox();
    const timingStatisticsBox = await timingStatistics.boundingBox();
    expect(outcomesBox?.y).toBeLessThan(timingStatisticsBox?.y ?? Number.POSITIVE_INFINITY);
    await expect(modal.locator('.recharts-line-curve').nth(0)).toHaveAttribute('stroke', '#5aa9ff');
    await expect(modal.locator('.recharts-line-curve').nth(1)).toHaveAttribute('stroke', '#c58aff');
    await expect(outcomes).toContainText('Warnings');
    expect(catalogRequests[0]?.searchParams.get('surface')).toBe('endpoint');
    expect(catalogRequests[0]?.searchParams.get('runKind')).toBe('published');
    expect(statisticsRequests[0]?.includeFailed).toBe(false);

    await targetSelect.press('ArrowDown');
    await targetSelect.press('ArrowDown');
    await targetSelect.press('Enter');
    await expect(modal.locator('.run-statistics-target-title')).toHaveText('Archive project');
    await expect.poll(() => statisticsRequests.at(-1)?.target.workflowId).toBe('workflow-b');
    await expect(modal.getByText('Calculating statistics...')).toBeVisible();
    await expect(modal.locator('.run-statistics-metric-card')).toHaveCount(0);
    await expect(modal.getByRole('region', { name: 'Run outcomes' })).toHaveCount(0);
    releaseArchiveStatistics();
    await expect(modal.locator('.run-statistics-metric-card').first()).toContainText('1.25 s');

    await timingStatistics.getByLabel('Include failed runs').check();
    await expect.poll(() => statisticsRequests.at(-1)?.includeFailed).toBe(true);
    await expect(modal.getByText('4 included runs')).toBeVisible();
    await expect(outcomes).toContainText('20%');

    await timingStatistics.getByLabel('Include runs with warnings').check();
    await expect.poll(() => statisticsRequests.at(-1)?.includeWarnings).toBe(true);
    await expect(modal.getByText('5 included runs')).toBeVisible();
    await expect(outcomes).toContainText('20%');

    await modal.getByRole('button', { name: 'Web apps' }).click();
    await expect(modal.getByText('Loading available runs...')).toBeVisible();
    await expect(modal.getByRole('combobox', { name: 'Workflow endpoint' })).toHaveCount(0);
    await expect(modal.locator('.run-statistics-target-title')).toHaveCount(0);
    releaseWebAppCatalog();
    const webAppSelect = modal.getByRole('combobox', { name: 'Web app action' });
    await expect(webAppSelect).toBeVisible();
    await expect(modal.locator('.run-statistics-target-select__single-value')).toHaveText('Summary app - Generate summary');
    await modal.locator('.run-statistics-target-select__control').click();
    const webAppTargetMenu = page.locator('.run-statistics-target-select__menu');
    await expect(webAppTargetMenu).toBeVisible();
    await expect(webAppTargetMenu).toContainText('Summary app - Generate summary');
    await webAppTargetMenu.getByText('Summary app - Generate summary', { exact: true }).click();
    await expect(modal.locator('.run-statistics-target-title')).toHaveText('Summary app - Generate summary');
    await expect.poll(() => catalogRequests.at(-1)?.searchParams.get('surface')).toBe('web_app');
    await expect.poll(() => statisticsRequests.at(-1)?.target.surface).toBe('web_app');
  });
});
