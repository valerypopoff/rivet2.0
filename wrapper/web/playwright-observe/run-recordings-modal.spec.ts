import { expect, test, type Locator, type Page } from '@playwright/test';

import { authenticateIfNeeded, waitForDashboardReady } from './helpers/hostedEditorObserve';
import type {
  WorkflowRecordingFilterStatus,
  WorkflowRecordingInputFilterOperator,
  WorkflowRecordingRunSummary,
  WorkflowRecordingWorkflowSummary,
} from '../../shared/workflow-recording-types';
import { matchesWorkflowRecordingInputFilter } from '../../api/src/routes/workflows/recording-input-filter.js';

type RecordingRun = WorkflowRecordingRunSummary & {
  input?: Record<string, unknown>;
};

function getReplayProjectId(recordingId: string): string {
  return `${recordingId}-replay-project`;
}

function getReplayGraphId(recordingId: string): string {
  return `${recordingId}-main-graph`;
}

function createSerializedRecording(recordingId: string): string {
  const timestamp = Date.now();

  return JSON.stringify({
    version: 1,
    recording: {
      recordingId,
      startTs: timestamp,
      finishTs: timestamp,
      events: [
        {
          type: 'start',
          data: {
            projectId: getReplayProjectId(recordingId),
            inputs: {},
            contextValues: {},
            startGraph: getReplayGraphId(recordingId),
          },
          ts: timestamp,
        },
        {
          type: 'done',
          data: { results: { output: 'ok' } },
          ts: timestamp,
        },
      ],
    },
    assets: {},
    strings: {},
  });
}

function createReplayProject(recordingId: string): string {
  return [
    'version: 4',
    'data:',
    '  metadata:',
    `    id: ${JSON.stringify(getReplayProjectId(recordingId))}`,
    `    title: ${JSON.stringify(`Replay ${recordingId}`)}`,
    '    description: ""',
    `    mainGraphId: ${JSON.stringify(getReplayGraphId(recordingId))}`,
    '  graphs:',
    `    ${JSON.stringify(getReplayGraphId(recordingId))}:`,
    '      metadata:',
    `        id: ${JSON.stringify(getReplayGraphId(recordingId))}`,
    '        name: "Main Graph"',
    '        description: ""',
    '      nodes:',
    '        \'[replay-node-1]:text "Replay Node"\':',
    '          visualData: 520/300/260/null//',
    '          data:',
    '            text: replay',
    '  plugins: []',
    '  references: []',
    '',
  ].join('\n');
}

function createRunRecordingsFixture() {
  const workflows: WorkflowRecordingWorkflowSummary[] = [
    {
      workflowId: 'workflow-a',
      project: {
        id: 'workflow-a',
        name: 'Published Flow',
        fileName: 'Published Flow.rivet-project',
        relativePath: 'Published Flow.rivet-project',
        absolutePath: '/workflows/Published Flow.rivet-project',
        updatedAt: '2026-04-08T10:00:00.000Z',
        settings: {
          status: 'published',
          endpointName: 'published-flow',
          lastPublishedAt: '2026-04-08T09:30:00.000Z',
          publishedWebApps: [],
        },
      },
      latestRunAt: '2026-04-08T09:45:00.000Z',
      totalRuns: 2,
      failedRuns: 1,
      suspiciousRuns: 0,
    },
    {
      workflowId: 'workflow-b',
      project: {
        id: 'workflow-b',
        name: 'Latest Flow',
        fileName: 'Latest Flow.rivet-project',
        relativePath: 'Folder/Latest Flow.rivet-project',
        absolutePath: '/workflows/Folder/Latest Flow.rivet-project',
        updatedAt: '2026-04-08T11:00:00.000Z',
        settings: {
          status: 'unpublished_changes',
          endpointName: 'latest-flow',
          lastPublishedAt: '2026-04-08T08:15:00.000Z',
          publishedWebApps: [],
        },
      },
      latestRunAt: '2026-04-08T11:30:00.000Z',
      totalRuns: 12,
      failedRuns: 2,
      suspiciousRuns: 1,
    },
  ];
  const runsByWorkflow = new Map<string, RecordingRun[]>([
    ['workflow-a', [
      {
        id: 'recording-a-1',
        workflowId: 'workflow-a',
        createdAt: '2026-04-08T09:45:00.000Z',
        runKind: 'published',
        status: 'failed',
        durationMs: 1400,
        endpointNameAtExecution: 'published-flow',
        errorMessage: 'Boom',
        hasReplayDataset: false,
        recordingCompressedBytes: 10,
        recordingUncompressedBytes: 20,
        projectCompressedBytes: 10,
        projectUncompressedBytes: 20,
        datasetCompressedBytes: 0,
        datasetUncompressedBytes: 0,
        input: { foo: 'bar' },
      },
      {
        id: 'recording-a-2',
        workflowId: 'workflow-a',
        createdAt: '2026-04-08T09:40:00.000Z',
        runKind: 'published',
        status: 'succeeded',
        durationMs: 1200,
        endpointNameAtExecution: 'published-flow',
        hasReplayDataset: false,
        recordingCompressedBytes: 10,
        recordingUncompressedBytes: 20,
        projectCompressedBytes: 10,
        projectUncompressedBytes: 20,
        datasetCompressedBytes: 0,
        datasetUncompressedBytes: 0,
        input: { foo: 'baz' },
      },
    ]],
    ['workflow-b', Array.from({ length: 12 }, (_, index) => ({
      id: `recording-b-${index + 1}`,
      workflowId: 'workflow-b',
      createdAt: new Date(Date.UTC(2026, 3, 8, 11, 30 - index, 0)).toISOString(),
      runKind: index % 3 === 0 ? 'latest' : 'published',
      status: index === 1 || index === 7 ? 'failed' : index === 4 ? 'suspicious' : 'succeeded',
      durationMs: 900 + (index * 10),
      endpointNameAtExecution: 'latest-flow',
      errorMessage: index === 1 || index === 7 ? 'Failure' : undefined,
      hasReplayDataset: false,
      recordingCompressedBytes: 10,
      recordingUncompressedBytes: 20,
      projectCompressedBytes: 10,
      projectUncompressedBytes: 20,
      datasetCompressedBytes: 0,
      datasetUncompressedBytes: 0,
      input: {
        foo: index === 2 || index === 5 ? 'bar' : 'baz',
        score: index,
      },
    }))],
  ]);

  return { workflows, runsByWorkflow };
}

function applyInputFilter(run: RecordingRun, url: URL): boolean {
  const inputPath = url.searchParams.get('inputPath');
  const inputOperator = url.searchParams.get('inputOperator');
  const inputValue = url.searchParams.get('inputValue') ?? '';
  if (!inputPath || !inputOperator) {
    return true;
  }

  return matchesWorkflowRecordingInputFilter(run.input, {
    path: inputPath,
    operator: inputOperator as WorkflowRecordingInputFilterOperator,
    value: inputValue,
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function installRunRecordingRoutes(
  page: Page,
  options: { latestFlowRunCount?: number; cursorDelayMs?: number } = {},
) {
  const { workflows, runsByWorkflow } = createRunRecordingsFixture();
  const recordingFetches: string[] = [];
  const replayProjectFetches: string[] = [];
  const runFetches: string[] = [];
  const latestRuns = runsByWorkflow.get('workflow-b');
  if (latestRuns && options.latestFlowRunCount && options.latestFlowRunCount > latestRuns.length) {
    for (let index = latestRuns.length; index < options.latestFlowRunCount; index += 1) {
      latestRuns.push({
        id: `recording-b-${index + 1}`,
        workflowId: 'workflow-b',
        createdAt: new Date(Date.UTC(2026, 3, 8, 11, 30 - index, 0)).toISOString(),
        runKind: index % 3 === 0 ? 'latest' : 'published',
        status: 'succeeded',
        durationMs: 900 + (index * 10),
        endpointNameAtExecution: 'latest-flow',
        hasReplayDataset: false,
        recordingCompressedBytes: 10,
        recordingUncompressedBytes: 20,
        projectCompressedBytes: 10,
        projectUncompressedBytes: 20,
        datasetCompressedBytes: 0,
        datasetUncompressedBytes: 0,
        input: {
          foo: 'baz',
          score: index,
        },
      });
    }

    const latestWorkflow = workflows.find((workflow) => workflow.workflowId === 'workflow-b');
    if (latestWorkflow) {
      latestWorkflow.totalRuns = latestRuns.length;
      latestWorkflow.failedRuns = latestRuns.filter((run) => run.status === 'failed').length;
      latestWorkflow.suspiciousRuns = latestRuns.filter((run) => run.status === 'suspicious').length;
    }
  }

  await page.addInitScript(() => {
    window.confirm = () => true;
  });

  await page.route('**/api/workflows/recordings/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const parts = url.pathname.split('/').filter(Boolean);

    if (request.method() === 'GET' && url.pathname.endsWith('/workflows')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ workflows }),
      });
      return;
    }

    if (request.method() === 'GET' && parts.includes('runs')) {
      runFetches.push(request.url());
      const workflowId = parts[parts.length - 2]!;
      const status = (url.searchParams.get('status') ?? 'all') as WorkflowRecordingFilterStatus;
      const pageNumber = Number(url.searchParams.get('page') ?? '1');
      const pageSize = Number(url.searchParams.get('pageSize') ?? '20');
      const inputCursor = Number(url.searchParams.get('inputCursor') ?? '0');
      const hasInputFilter = url.searchParams.has('inputPath');
      const sourceRuns = runsByWorkflow.get(workflowId) ?? [];
      const filteredRuns = status === 'failed'
        ? sourceRuns.filter((run) => run.status === 'failed' || run.status === 'suspicious')
        : sourceRuns;
      const offset = hasInputFilter ? inputCursor : (pageNumber - 1) * pageSize;
      const candidateRuns = filteredRuns.slice(offset, offset + pageSize);
      const pageRuns = hasInputFilter
        ? candidateRuns.filter((run) => applyInputFilter(run, url))
        : candidateRuns;
      const nextInputCursor = offset + candidateRuns.length;
      const hasMore = hasInputFilter && nextInputCursor < filteredRuns.length;

      if (hasInputFilter && inputCursor > 0) {
        await delay(options.cursorDelayMs ?? 150);
      }

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          workflowId,
          page: pageNumber,
          pageSize,
          totalRuns: hasInputFilter ? pageRuns.length : filteredRuns.length,
          totalRunsExact: !hasInputFilter || !hasMore,
          hasMore,
          nextInputCursor: hasMore ? nextInputCursor : undefined,
          statusFilter: status,
          runs: pageRuns,
        }),
      });
      return;
    }

    if (request.method() === 'DELETE' && parts.length >= 4) {
      const recordingId = decodeURIComponent(parts[3]!);
      for (const [workflowId, runs] of runsByWorkflow.entries()) {
        const nextRuns = runs.filter((run) => run.id !== recordingId);
        if (nextRuns.length === runs.length) {
          continue;
        }

        runsByWorkflow.set(workflowId, nextRuns);
        const workflow = workflows.find((entry) => entry.workflowId === workflowId);
        if (workflow) {
          workflow.totalRuns = nextRuns.length;
          workflow.failedRuns = nextRuns.filter((run) => run.status === 'failed').length;
          workflow.suspiciousRuns = nextRuns.filter((run) => run.status === 'suspicious').length;
          workflow.latestRunAt = nextRuns[0]?.createdAt;
        }
        break;
      }

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ deleted: true }),
      });
      return;
    }

    if (request.method() === 'GET' && parts.length >= 5 && parts[4] === 'recording') {
      const recordingId = decodeURIComponent(parts[3]!);
      recordingFetches.push(recordingId);
      await route.fulfill({
        status: 200,
        contentType: 'text/plain; charset=utf-8',
        body: createSerializedRecording(recordingId),
      });
      return;
    }

    if (request.method() === 'GET' && parts.length >= 5 && parts[4] === 'replay-project') {
      const recordingId = decodeURIComponent(parts[3]!);
      replayProjectFetches.push(recordingId);
      await route.fulfill({
        status: 200,
        contentType: 'text/plain; charset=utf-8',
        body: createReplayProject(recordingId),
      });
      return;
    }

    if (request.method() === 'GET' && parts.length >= 5 && parts[4] === 'replay-dataset') {
      await route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'No replay dataset' }),
      });
      return;
    }

    await route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({
        error: `Unexpected recordings request in Playwright fixture: ${request.method()} ${url.pathname}`,
      }),
    });
  });

  return { recordingFetches, replayProjectFetches, runFetches };
}

async function openLatestFlowRecordings(page: Page, expectedLatestFlowRecordingCount = 12) {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await authenticateIfNeeded(page);
  await waitForDashboardReady(page);

  await page.getByRole('button', { name: 'Run recordings' }).click();
  const modal = page.getByTestId('run-recordings-modal');
  await expect(modal).toBeVisible();

  await modal.locator('.run-recordings-select__control').click();
  await expect(page.locator('.run-recordings-select__option', { hasText: 'Published Flow' })
    .locator('.run-recordings-select-option-count')).toHaveText('2 recordings');
  const latestFlowOption = page.locator('.run-recordings-select__option', { hasText: 'Latest Flow' });
  await expect(latestFlowOption.locator('.run-recordings-select-option-count'))
    .toHaveText(`${expectedLatestFlowRecordingCount} recordings`);
  await latestFlowOption.click();
  await expect(modal.locator('.run-recordings-workflow-name')).toHaveText('Latest Flow');

  return modal;
}

async function choosePageSizeTen(modal: Locator, expectedTotalPages = 2) {
  await modal.getByRole('button', { name: /^All/ }).click();
  await modal.getByRole('button', { name: '10', exact: true }).click();
  await expect(modal.locator('.run-recordings-page-status')).toHaveText(`Page 1 of ${expectedTotalPages}`);
}

test.describe('Run recordings modal', () => {
  test('filters and paginates runs with the operator menu outside modal clipping', async ({ page }) => {
    const { runFetches } = await installRunRecordingRoutes(page);
    const modal = await openLatestFlowRecordings(page);
    const runFilter = modal.getByRole('group', { name: 'Filter runs' });
    await expect(runFilter).toHaveClass(/segmented-control/);
    await expect(runFilter.getByRole('button').first()).toHaveCSS('height', '28px');
    await expect(runFilter.getByRole('button').first()).toHaveAttribute('aria-pressed', 'true');
    await expect(modal.locator('.run-recordings-run').first().locator('.run-recordings-run-endpoint'))
      .toHaveText('Endpoint at execution: latest-flow');

    await modal.getByRole('button', { name: /Bad only/ }).click();
    await expect(modal.locator('.run-recordings-run')).toHaveCount(3);

    await choosePageSizeTen(modal);

    await modal.getByRole('button', { name: 'Filter by input' }).click();
    await modal.getByLabel('Input JSON path').fill('$.foo');
    const operatorControl = modal.locator('.run-recordings-input-filter-operator .run-recordings-select__control');
    await expect(operatorControl).toBeVisible();
    await operatorControl.click();
    await expect(page.locator('body > .run-recordings-select__menu-portal .run-recordings-select__menu')).toBeVisible();
    await page.locator('.run-recordings-select__option').filter({ hasText: /^==$/ }).click();
    await modal.getByLabel('Value').fill('bar');
    await modal.getByRole('button', { name: 'Apply' }).click();
    await expect(modal.locator('.run-recordings-run')).toHaveCount(2);
    await expect(modal.locator('.run-recordings-run-endpoint')).toHaveText([
      'Endpoint at execution: latest-flow',
      'Endpoint at execution: latest-flow',
    ]);
    await expect(modal.locator('.run-recordings-input-search-status')).toContainText('Search complete');
    const filteredRunsRequest = new URL(runFetches.at(-1)!);
    expect(filteredRunsRequest.searchParams.get('inputPath')).toBe('$.foo');
    expect(filteredRunsRequest.searchParams.get('inputOperator')).toBe('==');
    expect(filteredRunsRequest.searchParams.get('inputValue')).toBe('bar');

    await modal.getByRole('button', { name: 'Clear' }).click();
    await expect(modal.locator('.run-recordings-page-status')).toHaveText('Page 1 of 2');

    await modal.getByLabel('Input JSON path').fill('$');
    await operatorControl.click();
    await page.locator('.run-recordings-select__option').filter({ hasText: /^contains$/ }).click();
    await modal.getByLabel('Value').fill("'bar'");
    await modal.getByRole('button', { name: 'Apply' }).click();
    await expect(modal.locator('.run-recordings-run')).toHaveCount(2);
    await expect(modal.locator('.run-recordings-input-search-status')).toContainText('Search complete');
    const rootContainsRequest = new URL(runFetches.at(-1)!);
    expect(rootContainsRequest.searchParams.get('inputPath')).toBe('$');
    expect(rootContainsRequest.searchParams.get('inputOperator')).toBe('contains');
    expect(rootContainsRequest.searchParams.get('inputValue')).toBe("'bar'");

    await modal.getByRole('button', { name: 'Clear' }).click();
    await expect(modal.locator('.run-recordings-page-status')).toHaveText('Page 1 of 2');

    await modal.getByLabel('Input JSON path').fill('$.missing');
    await operatorControl.click();
    await page.locator('.run-recordings-select__option').filter({ hasText: /^!=$/ }).click();
    await modal.getByLabel('Value').fill('bar');
    await modal.getByRole('button', { name: 'Apply' }).click();
    await expect(modal.locator('.run-recordings-run')).toHaveCount(12);
    await expect(modal.locator('.run-recordings-input-search-status')).toContainText('Search complete');
    await expect.poll(() => runFetches.filter((requestUrl) => {
      const request = new URL(requestUrl);
      return request.searchParams.get('inputPath') === '$.missing'
        && request.searchParams.get('inputOperator') === '!=';
    }).length).toBeGreaterThan(1);
    const missingNotEqualsRequest = new URL(runFetches.at(-1)!);
    expect(missingNotEqualsRequest.searchParams.get('inputPath')).toBe('$.missing');
    expect(missingNotEqualsRequest.searchParams.get('inputOperator')).toBe('!=');
    expect(missingNotEqualsRequest.searchParams.get('inputValue')).toBe('bar');

    await operatorControl.click();
    await page.locator('.run-recordings-select__option').filter({ hasText: /^==$/ }).click();
    await modal.getByLabel('Value').fill('undefined');
    await modal.getByRole('button', { name: 'Apply' }).click();
    await expect(modal.locator('.run-recordings-run')).toHaveCount(12);
    await expect(modal.locator('.run-recordings-input-search-status')).toContainText('Search complete');
    const missingEqualsUndefinedRequest = new URL(runFetches.at(-1)!);
    expect(missingEqualsUndefinedRequest.searchParams.get('inputPath')).toBe('$.missing');
    expect(missingEqualsUndefinedRequest.searchParams.get('inputOperator')).toBe('==');
    expect(missingEqualsUndefinedRequest.searchParams.get('inputValue')).toBe('undefined');
  });

  test('deletes a run and opens replay through serialized recorder APIs', async ({ page }) => {
    const { recordingFetches, replayProjectFetches, runFetches } = await installRunRecordingRoutes(page);
    const modal = await openLatestFlowRecordings(page);
    await choosePageSizeTen(modal);

    const firstRun = modal.locator('.run-recordings-run').first();
    await firstRun.hover();
    await firstRun.locator('.run-recordings-run-delete-button').click();
    await expect(modal.locator('.run-recordings-page-status')).toHaveText('Page 1 of 2');
    await expect(modal.locator('.run-recordings-run')).toHaveCount(10);

    await modal.locator('.run-recordings-run').first().locator('.run-recordings-run-open-button').click();
    await expect.poll(() => recordingFetches.length).toBe(1);
    expect(recordingFetches[0]).toBe('recording-b-2');
    await expect.poll(() => replayProjectFetches.length).toBe(1);
    expect(replayProjectFetches[0]).toBe('recording-b-2');
    await expect(page.locator('.dashboard-empty-state')).toBeHidden();
    await expect(page.locator('.Toastify__toast', { hasText: 'Failed to open project' })).toHaveCount(0);
    const editorFrame = page.frameLocator('iframe.dashboard-editor-frame');
    await expect(editorFrame.getByRole('button', { name: 'Play Recording', exact: true })).toBeVisible();
    await expect(editorFrame.getByRole('button', { name: 'Unload Recording', exact: true })).toBeVisible();
    await expect(modal).toBeHidden();
    await expect(page.getByText('Found: 11')).toBeVisible();

    const runFetchCountAfterReplayOpen = runFetches.length;
    await page.getByRole('button', { name: 'Run recordings' }).click();
    await expect(modal).toBeVisible();
    await expect(modal.locator('.run-recordings-page-status')).toHaveText('Page 1 of 2');
    await expect(modal.locator('.run-recordings-run')).toHaveCount(10);
    expect(runFetches.length).toBe(runFetchCountAfterReplayOpen);

    await modal.getByLabel('Close run recordings').click();
    await expect(modal).toBeHidden();
    await expect(page.getByText(/^Found:/)).toHaveCount(0);
  });

  test('stops an active input search when the modal closes', async ({ page }) => {
    const { runFetches } = await installRunRecordingRoutes(page, {
      latestFlowRunCount: 30,
      cursorDelayMs: 2000,
    });
    const modal = await openLatestFlowRecordings(page, 30);
    await choosePageSizeTen(modal, 3);

    await modal.getByRole('button', { name: 'Filter by input' }).click();
    await modal.getByLabel('Input JSON path').fill('$.missing');
    await modal.locator('.run-recordings-input-filter-operator .run-recordings-select__control').click();
    await page.locator('.run-recordings-select__option').filter({ hasText: /^!=$/ }).click();
    await modal.getByLabel('Value').fill('bar');
    await modal.getByRole('button', { name: 'Apply' }).click();
    await expect(modal.locator('.run-recordings-run')).toHaveCount(10);
    await expect(modal.getByRole('button', { name: 'Stop search' })).toBeVisible();
    await expect.poll(() => runFetches.length).toBeGreaterThanOrEqual(2);

    const requestCountAtClose = runFetches.length;
    await modal.getByLabel('Close run recordings').click();
    await expect(modal).toBeHidden();
    await expect(page.getByText(/^Found:/)).toHaveCount(0);
    await delay(700);

    expect(runFetches.length).toBe(requestCountAtClose);
  });
});
