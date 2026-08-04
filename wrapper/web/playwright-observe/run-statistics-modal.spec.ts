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
  return {
    target: request.target,
    period: request.period,
    comparisonPeriod: request.period,
    current: {
      runCount: request.includeFailed ? 4 : 3,
      medianDurationMs: 1_250,
      p95DurationMs: 2_200,
      averageDurationMs: 1_400,
      minDurationMs: 900,
      maxDurationMs: 2_400,
    },
    previous: {
      runCount: 2,
      medianDurationMs: 1_750,
      p95DurationMs: 2_600,
      averageDurationMs: 1_900,
      minDurationMs: 1_200,
      maxDurationMs: 2_600,
    },
    medianDelta: { absoluteMs: -500, percent: -28.57 },
    p95Delta: { absoluteMs: -400, percent: -15.38 },
    currentStatusCounts: { succeeded: 3, failed: 1, suspicious: 0 },
    previousStatusCounts: { succeeded: 2, failed: 0, suspicious: 0 },
    currentExcludedStatusCounts: request.includeFailed
      ? { succeeded: 0, failed: 0, suspicious: 0 }
      : { succeeded: 0, failed: 1, suspicious: 0 },
    previousExcludedStatusCounts: { succeeded: 0, failed: 0, suspicious: 0 },
    buckets: [
      { from: request.period.from, to: request.period.to, runCount: 3, medianDurationMs: 1_250, p95DurationMs: 2_200, averageDurationMs: 1_400, minDurationMs: 900, maxDurationMs: 2_400 },
    ],
  };
}

async function installRunStatisticsRoutes(page: Page) {
  const catalogRequests: URL[] = [];
  const statisticsRequests: StatisticsRequest[] = [];

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
        : [{
          target: { surface: 'endpoint', workflowId: 'workflow-a' },
          projectName: 'Report project',
          latestRunAt: '2026-08-04T12:00:00.000Z',
          totalRuns: 3,
        }];
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
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(getStatisticsResponse(body)) });
      return;
    }

    await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Unexpected statistics request' }) });
  });

  return { catalogRequests, statisticsRequests };
}

test.describe('Run statistics modal', () => {
  test('compares endpoint and web-app action execution timing with status filters', async ({ page }) => {
    const { catalogRequests, statisticsRequests } = await installRunStatisticsRoutes(page);
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await authenticateIfNeeded(page);
    await waitForDashboardReady(page);

    await page.getByRole('button', { name: 'Run statistics' }).click();
    const modal = page.getByTestId('run-statistics-modal');
    await expect(modal).toBeVisible();
    await expect(page.getByTestId('run-statistics-modal--blanket')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0.56)');
    await expect(modal).toHaveCSS('background-color', 'rgb(31, 31, 34)');
    await expect(page.getByTestId('run-statistics-modal--body')).toHaveCSS('padding-top', '0px');
    await expect(modal.locator('.run-statistics-target-title')).toHaveText('Report project');
    await expect(modal.locator('.run-statistics-metric-card').first()).toContainText('1.25 s');
    await expect(modal.getByText('500 ms faster')).toBeVisible();
    await expect(modal.getByRole('region', { name: 'Run outcomes' })).toContainText('Errors');
    await expect(modal.getByRole('region', { name: 'Run outcomes' })).toContainText('25%');
    await expect(modal.getByRole('region', { name: 'Run outcomes' })).toContainText('Warnings');
    expect(catalogRequests[0]?.searchParams.get('surface')).toBe('endpoint');
    expect(catalogRequests[0]?.searchParams.get('runKind')).toBe('published');
    expect(statisticsRequests[0]?.includeFailed).toBe(false);

    await modal.getByLabel('Include failed runs').check();
    await expect.poll(() => statisticsRequests.at(-1)?.includeFailed).toBe(true);
    await expect(modal.getByText('4 included runs')).toBeVisible();

    await modal.getByRole('button', { name: 'Web apps' }).click();
    await expect(modal.locator('.run-statistics-target-title')).toHaveText('Summary app - Generate summary');
    await expect.poll(() => catalogRequests.at(-1)?.searchParams.get('surface')).toBe('web_app');
    await expect.poll(() => statisticsRequests.at(-1)?.target.surface).toBe('web_app');
  });
});
