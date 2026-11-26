import { expect, test, type Locator, type Page } from '@playwright/test';

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

async function expectTimeChartLayout(chart: Locator) {
  await expect.poll(() => chart.evaluate((card) => {
    const header = card.querySelector('.run-statistics-chart-header')!;
    const control = header.querySelector('[role="group"]')!;
    const legend = card.querySelector('.recharts-legend-wrapper')!.getBoundingClientRect();
    const labels = [...card.querySelectorAll<SVGTextElement>('.recharts-xAxis-tick-labels text[aria-label]')];
    const marks = [...card.querySelectorAll('.recharts-xAxis-tick-lines .recharts-cartesian-axis-tick-line')];
    return {
      rightAligned: Math.abs(header.getBoundingClientRect().right - control.getBoundingClientRect().right) < 1,
      twoLines: labels.length > 0 && labels.every((label) => {
        const lines = [...label.querySelectorAll('tspan')];
        return lines.length === 2 && lines.every((line) => Boolean(line.textContent?.trim()))
          && lines[1]!.getBoundingClientRect().top > lines[0]!.getBoundingClientRect().bottom;
      }),
      marked: labels.length > 0 && marks.length === labels.length && marks.every((mark) => {
        return mark.getBoundingClientRect().height >= 5
          && !['none', 'transparent'].includes(getComputedStyle(mark).stroke);
      }),
      labelsFit: labels.every((text) => {
        const svg = text.ownerSVGElement!.getBoundingClientRect();
        const label = text.getBoundingClientRect();
        return label.left >= svg.left - 1 && label.right <= svg.right + 1 && label.bottom <= legend.top;
      }),
    };
  })).toEqual({ rightAligned: true, twoLines: true, marked: true, labelsFit: true });
}

function getStatisticsResponse(request: StatisticsRequest, costMode: CostMode = 'none') {
  const hasMatchingRuns = request.runKind !== 'latest' && request.target.workflowId !== 'workflow-empty';
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

async function installRunStatisticsRoutes(
  page: Page,
  costMode: CostMode = 'none',
  incompleteRuns = 0,
  beforeQuery?: (request: StatisticsRequest) => Promise<void>,
) {
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
          projectRelativePath: 'Reports/Report project.rivet-project',
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
            projectRelativePath: 'Reports/Report project.rivet-project',
            latestRunAt: '2026-08-04T12:00:00.000Z',
            totalRuns: 3,
          },
          {
            target: { surface: 'endpoint', workflowId: 'workflow-b' },
            projectName: 'Archive project',
            projectRelativePath: 'Archive/Archive project.rivet-project',
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
      await beforeQuery?.(body);
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({...getStatisticsResponse(body, costMode), incompleteRuns}) });
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

  for (const empty of [false, true]) {
    test(`Run statistics selects the tree project${empty ? ' without recordings' : ''} and the picker accepts typing`, async ({ page }) => {
      const { statisticsRequests, releaseArchiveStatistics } = await installRunStatisticsRoutes(page, 'available');
      releaseArchiveStatistics();
      const name = empty ? 'Empty project' : 'Archive project';
      const id = empty ? 'workflow-empty' : 'workflow-b';
      await page.route('**/api/workflows/tree', (route) => route.fulfill({ json: {
        root: '/workflows', folders: [], projects: [{
          id, projectMetadataId: id, name, fileName: `${name}.rivet-project`,
          relativePath: `${name}.rivet-project`, absolutePath: `/workflows/${name}.rivet-project`,
          updatedAt: '', settings: { status: 'unpublished', endpointName: '', publishedWebApps: [] },
        }],
      } }));
      let releaseCatalog!: () => void;
      const catalogReady = new Promise<void>((resolve) => { releaseCatalog = resolve; });
      await page.route((url) => url.pathname === '/api/workflows/run-statistics/targets', async (route) => {
        await catalogReady;
        await route.fallback();
      });
      await page.goto('/', { waitUntil: 'domcontentloaded' });
      await authenticateIfNeeded(page);
      await waitForDashboardReady(page);
      await page.locator('.project-row').filter({ hasText: name }).click({ button: 'right' });
      const menu = page.getByRole('menu', { name: `Actions for ${name}` });
      const menuActions = menu.locator('[role="menuitem"], [role="separator"]');
      await expect(menuActions).toHaveCount(9);
      expect(await menuActions.evaluateAll((items) => items.map((item) =>
        item.getAttribute('role') === 'separator' ? '---' : item.textContent?.trim(),
      ))).toEqual([
        'Rename project', '---', 'Download project', 'Duplicate', '---',
        'Inspect recordings', 'Run statistics', '---', 'Delete project',
      ]);
      const inspect = menu.getByRole('menuitem', { name: 'Run statistics', exact: true });
      await expect(inspect.locator('svg')).toHaveCount(1);
      const modal = page.getByTestId('run-statistics-modal');
      try {
        if (empty) {
          await inspect.focus();
          await page.keyboard.press('Enter');
        } else await inspect.click();
        await expect(menu).toBeHidden();
        await expect(modal).toBeVisible();
        await expect(modal.getByText('Loading available runs...')).toBeVisible();
        expect(statisticsRequests).toEqual([]);
      } finally {
        releaseCatalog();
      }
      await expect(modal.locator('.run-statistics-target-select__single-value')).toHaveText(name);
      await expect(modal.locator('.run-statistics-selected-project-path')).toHaveText(
        empty ? 'Empty project.rivet-project' : 'Archive/Archive project.rivet-project',
      );
      expect(await modal.locator('.run-statistics-target-control').evaluate((control) => {
        const picker = control.querySelector('.run-statistics-target-select__control')!.getBoundingClientRect();
        const path = control.querySelector('.run-statistics-selected-project-path')!.getBoundingClientRect();
        return path.top >= picker.bottom;
      })).toBe(true);
      await expect.poll(() => statisticsRequests.map((request) => request.target.workflowId)).toEqual([id]);
      if (empty) {
        await expect(modal.getByText('No runs for this target match the selected period and version.')).toBeVisible();
      } else await expect(modal.getByRole('region', { name: 'Timing statistics' })).toBeVisible();

      await modal.getByRole('button', { name: 'Close run statistics' }).click();
      await page.getByRole('button', { name: 'Run statistics', exact: true }).click();
      await expect(modal.locator('.run-statistics-target-select__single-value')).toHaveText('Report project');
      await expect(modal.locator('.run-statistics-selected-project-path')).toHaveText('Reports/Report project.rivet-project');
      await modal.locator('label[for="run-statistics-target-select"]').click();
      const picker = modal.getByRole('combobox', { name: 'Project', exact: true });
      await expect(picker).toBeFocused();
      await picker.fill('aRCHive');
      const options = page.locator('.run-statistics-target-select__menu');
      await expect(options.locator('.run-statistics-target-option-label')).toHaveText(['Archive project']);
      await picker.press('ArrowDown');
      await picker.press('Enter');
      await expect(modal.locator('.run-statistics-target-select__single-value')).toHaveText('Archive project');
      await expect(modal.locator('.run-statistics-selected-project-path')).toHaveText('Archive/Archive project.rivet-project');
      await expect.poll(() => statisticsRequests.at(-1)?.target.workflowId).toBe('workflow-b');
    });
  }

  test('custom period edits preserve both dates without retaining React events', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    let holdNextQuery = false;
    let releaseQuery = () => {};
    const { statisticsRequests } = await installRunStatisticsRoutes(page, 'none', 0, async () => {
      if (holdNextQuery) {
        holdNextQuery = false;
        await new Promise<void>((resolve) => { releaseQuery = resolve; });
      }
    });
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await authenticateIfNeeded(page);
    await waitForDashboardReady(page);
    await page.getByRole('button', { name: 'Run statistics', exact: true }).click();
    const modal = page.getByTestId('run-statistics-modal');
    await expect(modal.locator('.run-statistics-metric-card').first()).toContainText('1.25 s');
    await modal.getByRole('button', { name: 'Custom', exact: true }).click();
    let expectedPeriod = { ...statisticsRequests.at(-1)!.period };

    for (const [label, key, value] of [
      ['From', 'from', '2026-08-01T09:15'],
      ['To', 'to', '2026-08-15T18:00'],
      ['From', 'from', '2026-07-01T09:15'],
      ['To', 'to', '2026-09-15T18:00'],
    ] as const) {
      const input = modal.getByLabel(label, { exact: true });
      await input.fill(value);
      await expect(input).toHaveValue(value);
      const timestamp = await input.evaluate((element: HTMLInputElement) => new Date(element.value).toISOString());
      expectedPeriod = { ...expectedPeriod, [key]: timestamp };
      await expect.poll(() => statisticsRequests.at(-1)?.period).toEqual(expectedPeriod);
      await expect(modal.locator('.run-statistics-metric-card').first()).toContainText('1.25 s');
    }

    for (const [label, value] of [
      ['From', '2026-07-01T09:15'],
      ['To', '2026-09-15T18:00'],
    ] as const) {
      const input = modal.getByLabel(label, { exact: true });
      const requestsBeforeClear = statisticsRequests.length;
      await input.fill('');
      await expect(modal.getByText('The period end must be after its start.')).toBeVisible();
      await expect(modal.locator('.run-statistics-details')).toHaveAttribute('aria-busy', 'false');
      expect(statisticsRequests).toHaveLength(requestsBeforeClear);
      await input.fill(value);
      await expect(modal.getByText('The period end must be after its start.')).toHaveCount(0);
      await expect(modal.locator('.run-statistics-metric-card').first()).toContainText('1.25 s');
    }

    const from = modal.getByLabel('From', { exact: true });
    const to = modal.getByLabel('To', { exact: true });
    const requestsBeforeInvalid = statisticsRequests.length;
    await from.fill('2026-10-01T09:15');
    await expect(modal.getByText('The period end must be after its start.')).toBeVisible();
    expect(statisticsRequests).toHaveLength(requestsBeforeInvalid);
    await from.fill('2026-07-01T09:15');
    await expect(modal.locator('.run-statistics-metric-card').first()).toContainText('1.25 s');

    holdNextQuery = true;
    try {
      await from.fill('2026-07-02T09:15');
      expectedPeriod.from = await from.evaluate((input: HTMLInputElement) => new Date(input.value).toISOString());
      await expect.poll(() => statisticsRequests.at(-1)?.period).toEqual(expectedPeriod);
      const pendingPeriod = { ...expectedPeriod };
      const cancelled = page.waitForEvent('requestfailed', {
        timeout: 10_000,
        predicate: (request) => request.url().endsWith('/run-statistics/query')
          && request.postDataJSON().period.from === pendingPeriod.from
          && request.postDataJSON().period.to === pendingPeriod.to,
      });
      await to.fill('2026-09-16T18:00');
      expectedPeriod.to = await to.evaluate((input: HTMLInputElement) => new Date(input.value).toISOString());
      await expect.poll(() => statisticsRequests.at(-1)?.period).toEqual(expectedPeriod);
      await expect(modal.locator('.run-statistics-metric-card').first()).toContainText('1.25 s');
      releaseQuery();
      await cancelled;
      await expect(modal.locator('.run-statistics-details')).toHaveAttribute('aria-busy', 'false');
      await expect(from).toHaveValue('2026-07-02T09:15');
      await expect(to).toHaveValue('2026-09-16T18:00');
    } finally {
      releaseQuery();
    }
    expect(errors).toEqual([]);
  });

  test('rounds duration minutes correctly and keeps single-bucket points visible', async ({ page }) => {
    await installRunStatisticsRoutes(page, 'available');
    await page.route('**/api/workflows/run-statistics/query', (route) => {
      const response = getStatisticsResponse(route.request().postDataJSON() as StatisticsRequest, 'available');
      const durations = {
        medianDurationMs: 119_999,
        p95DurationMs: 299_999,
        averageDurationMs: 179_999,
        minDurationMs: 60_000,
        maxDurationMs: 600_001,
      };
      return route.fulfill({ json: {
        ...response,
        current: { ...response.current, ...durations },
        buckets: response.buckets.map((bucket) => ({ ...bucket, ...durations })),
      } });
    });
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await authenticateIfNeeded(page);
    await waitForDashboardReady(page);
    await page.getByRole('button', { name: 'Run statistics', exact: true }).click();
    const modal = page.getByTestId('run-statistics-modal');
    const timing = modal.getByRole('region', { name: 'Timing statistics' });
    await expect(timing.locator('.run-statistics-metric-value')).toHaveText([
      '2 m 0 s', '5 m 0 s', '3 m 0 s', '1 m 0 s', '10 m 0 s',
    ]);
    await timing.getByRole('group', { name: 'Duration chart grouping' })
      .getByRole('button', { name: 'By week' }).click();
    await expect(timing.locator('.recharts-line-dot')).toHaveCount(2);
    await expect(timing.locator('.recharts-line-dot').first()).toBeVisible();
    await expect(timing.locator('.recharts-line-dot').nth(1)).toBeVisible();
    await timing.screenshot({ path: test.info().outputPath('single-bucket-duration.png') });
  });

  test('regroups in place, recovers failed reads, and hides results when filters change', async ({ page }) => {
    let holdQueries = false;
    let releaseQuery = () => {};
    await installRunStatisticsRoutes(page, 'available', 0, async (request) => {
      if (holdQueries && request.runKind === 'published') {
        await new Promise<void>((resolve) => { releaseQuery = resolve; });
      }
    });
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await authenticateIfNeeded(page);
    await waitForDashboardReady(page);
    await page.getByRole('button', { name: 'Run statistics', exact: true }).click();
    const modal = page.getByTestId('run-statistics-modal');
    const details = modal.locator('.run-statistics-details');
    const panels = modal.locator('.run-statistics-section');
    await expect(panels).toHaveCount(2);
    const originalPanels = await panels.elementHandles();
    const expectPanelsMounted = async () => {
      expect(await Promise.all(originalPanels.map((panel) => panel.evaluate((element) => element.isConnected))))
        .toEqual([true, true]);
    };

    try {
      for (const [name, title] of [
        ['Duration chart grouping', 'Duration over time'],
        ['Cost chart grouping', 'Cost over time'],
      ] as const) {
        const grouping = modal.getByRole('group', { name, exact: true });
        const header = grouping.locator('..');
        await expect(header.getByText(title, { exact: true })).toBeVisible();
        await grouping.scrollIntoViewIfNeeded();
        const scrollBefore = await details.evaluate((panel) => panel.scrollTop);
        const week = grouping.getByRole('button', { name: 'By week', exact: true });
        holdQueries = true;
        await week.click();
        await expect(details).toHaveAttribute('aria-busy', 'true');
        await expectPanelsMounted();
        await expect(modal.getByText('Calculating statistics...')).toHaveCount(0);
        expect(await details.evaluate((panel) => panel.scrollTop)).toBeCloseTo(scrollBefore, 0);
        holdQueries = false;
        releaseQuery();
        await expect(details).toHaveAttribute('aria-busy', 'false');
        await expectPanelsMounted();
        await expect(week).toBeFocused();
        expect(await details.evaluate((panel) => panel.scrollTop)).toBeCloseTo(scrollBefore, 0);
      }

      const cost = modal.getByRole('region', { name: 'Cost statistics' });
      const costGrouping = cost.getByRole('group', { name: 'Cost chart grouping' });
      await page.route('**/api/workflows/run-statistics/query', (route) => route.fulfill({
        status: 503, json: { error: 'Regrouping unavailable in fixture' },
      }), { times: 1 });
      await costGrouping.getByRole('button', { name: 'By day' }).click();
      await expect(modal.getByRole('alert')).toContainText('The previous chart grouping is still shown.');
      await expectPanelsMounted();
      await expect(cost.locator('.recharts-xAxis .recharts-cartesian-axis-tick')).toHaveCount(1);
      await modal.getByRole('button', { name: 'Try again', exact: true }).click();
      await expect(modal.getByRole('alert')).toHaveCount(0);
      await expect(cost.locator('.recharts-xAxis .recharts-cartesian-axis-tick')).toHaveCount(2);
      await expectPanelsMounted();

      holdQueries = true;
      await costGrouping.getByRole('button', { name: 'By week' }).click();
      await expect(details).toHaveAttribute('aria-busy', 'true');
      const aborted = page.waitForEvent('requestfailed', {
        timeout: 10_000,
        predicate: (request) => request.url().endsWith('/run-statistics/query')
          && request.postDataJSON().runKind === 'published',
      });
      await modal.getByRole('button', { name: 'Latest', exact: true }).click();
      await expect(modal.getByText('No runs for this target match the selected period and version.')).toBeVisible();
      holdQueries = false;
      releaseQuery();
      await aborted;
      await expect(panels).toHaveCount(0);
    } finally {
      releaseQuery();
    }
  });

  for (const costMode of ['available', 'partial', 'unknown', 'none'] as const) {
    test(`shows ${costMode} cost estimates with shared outcome filters`, async ({ page }) => {
      await installRunStatisticsRoutes(page, costMode);
      await page.goto('/', { waitUntil: 'domcontentloaded' });
      await authenticateIfNeeded(page);
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
        const axes = cost.locator('.recharts-yAxis');
        await expect(axes).toHaveCount(2);
        const ticksForLine = async (lineIndex: number) => {
          const line = cost.locator('.recharts-line').nth(lineIndex).locator('.recharts-line-curve');
          const stroke = await line.getAttribute('stroke');
          const ticks = cost.locator(`.recharts-cartesian-axis-tick-value[fill="${stroke}"]`);
          await expect(ticks.first()).toHaveCSS('fill', await line.evaluate((path) => getComputedStyle(path).stroke));
          return ticks;
        };
        const averageTicks = await ticksForLine(1);
        const subtotalTicks = await ticksForLine(0);
        const leftAxis = await averageTicks.first().boundingBox();
        const rightAxis = await subtotalTicks.first().boundingBox();
        expect(leftAxis!.x + leftAxis!.width).toBeLessThan(rightAxis!.x);
        const maximumTick = async (ticks: Locator) => Math.max(...(await ticks.allTextContents())
          .map((tick) => Number(tick.replace(',', '.').replace(/[^\d.]/g, ''))));
        expect(await maximumTick(averageTicks)).toBeLessThan(await maximumTick(subtotalTicks));
        for (const region of ['Timing statistics', 'Cost statistics']) {
          await expectTimeChartLayout(modal.getByRole('region', { name: region }).locator('.run-statistics-chart-card'));
        }
      } else if (costMode === 'partial') {
        await expect(cost).toContainText('No complete cost estimates to average');
        await expect(cost.locator('.recharts-line').first().locator('.recharts-line-curve')).toHaveAttribute('d', /\S/);
        await expect(cost.locator('.recharts-line').nth(1).locator('.recharts-line-curve')).toHaveCount(0);
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
          for (const region of ['Timing statistics', 'Cost statistics']) {
            await expectTimeChartLayout(modal.getByRole('region', { name: region }).locator('.run-statistics-chart-card'));
          }
          await modal.screenshot({ path: test.info().outputPath(`run-statistics-${width}.png`) });
        }
      }
    });
  }

  test('explains incomplete execution telemetry separately from known cost totals',async({page})=>{
    await installRunStatisticsRoutes(page,'partial',2);
    await page.goto('/',{waitUntil:'domcontentloaded'});
    await waitForDashboardReady(page);
    await page.getByRole('button',{name:'Run statistics',exact:true}).click();
    const modal=page.getByTestId('run-statistics-modal');
    await expect(modal.getByRole('status').filter({hasText:'2 run attempts have incomplete execution telemetry and are excluded from these totals.'})).toBeVisible();
    await expect(modal.getByRole('region',{name:'Cost statistics'})).toContainText('Known subtotal');
    await expect(modal.locator('.run-statistics-period-label')).toHaveText(/^3 runs, .+ to .+$/);
  });

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
    const targetSelect = modal.getByRole('combobox', { name: 'Project', exact: true });
    await expect(targetSelect).toBeVisible();
    await expect(modal.locator('.run-statistics-target-select__single-value')).toHaveText('Report project');
    await modal.locator('.run-statistics-target-select__control').click();
    const endpointTargetMenu = page.locator('.run-statistics-target-select__menu');
    await expect(endpointTargetMenu).toBeVisible();
    await expect(endpointTargetMenu).toContainText('Archive project');
    const reportOption = endpointTargetMenu.locator('.run-statistics-target-option').filter({ hasText: 'Report project' });
    await expect(reportOption.locator(':scope > div')).toHaveText([
      'Report project',
      '3 recorded runs',
      'Reports/Report project.rivet-project',
    ]);
    await expect(endpointTargetMenu).toContainText('Archive/Archive project.rivet-project');
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
    const chartTitle = await chartHeader.getByText('Cost over time', { exact: true }).boundingBox();
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
    await expect(modal.getByRole('combobox', { name: 'Project', exact: true })).toHaveCount(0);
    await expect(modal.locator('.run-statistics-period-label')).toHaveCount(0);
    releaseWebAppCatalog();
    const webAppSelect = modal.getByRole('combobox', { name: 'Web app action' });
    await expect(webAppSelect).toBeVisible();
    await expect(modal.locator('.run-statistics-target-select__single-value')).toHaveText('Summary app - Generate summary');
    await expect(modal.locator('.run-statistics-selected-project-path')).toHaveCount(0);
    await modal.locator('.run-statistics-target-select__control').click();
    const webAppTargetMenu = page.locator('.run-statistics-target-select__menu');
    await expect(webAppTargetMenu).toBeVisible();
    await expect(webAppTargetMenu).toContainText('Summary app - Generate summary');
    await expect(webAppTargetMenu.locator('.run-statistics-target-option > div')).toHaveText([
      'Summary app - Generate summary',
      'Report project - 3 recorded runs',
      'Reports/Report project.rivet-project',
    ]);
    await webAppTargetMenu.getByText('Summary app - Generate summary', { exact: true }).click();
    await expect(modal.locator('.run-statistics-target-select__single-value')).toHaveText('Summary app - Generate summary');
    await expect.poll(() => catalogRequests.at(-1)?.searchParams.get('surface')).toBe('web_app');
    await expect.poll(() => statisticsRequests.at(-1)?.target.surface).toBe('web_app');
    await expect(modal.locator('.run-statistics-period-label')).toHaveText(/^5 runs, .+ to .+$/);
    await expect(cost.locator('.run-statistics-metric-value').first()).toContainText(/0[.,]0012/);
  });
});
