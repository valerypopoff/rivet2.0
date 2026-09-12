import { expect, test, type Locator, type Page } from '@playwright/test';

import { authenticateIfNeeded, waitForDashboardReady } from './helpers/hostedEditorObserve';
import type {
  WorkflowRecordingFilterStatus,
  WorkflowRecordingInputFilterOperator,
  WorkflowRecordingRunSummary,
  WorkflowRecordingWorkflowSummary,
} from '../../studio-server-shared/workflow-recording-types';
import { matchesWorkflowRecordingInputFilter } from '../../studio-server-api/src/routes/workflows/recording-input-filter.js';

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
  if (recordingId === 'recording-b-inspector') {
    return createResponseInspectorRecording(recordingId);
  }
  if (recordingId === 'recording-a-1') {
    return createFailedLlmOutputRecording(recordingId);
  }

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

function createFailedLlmOutputRecording(recordingId: string): string {
  const startedAt = Date.UTC(2026, 3, 8, 9, 45, 0);
  const finishedAt = startedAt + 15_000;
  const graphId = getReplayGraphId(recordingId);
  const execution = {
    graphId,
    graphRunId: `${recordingId}-graph-run`,
    rootRunId: `${recordingId}-root-run`,
  };
  const nodeId = 'replay-llm';
  const processId = 'replay-llm-process';

  return JSON.stringify({
    version: 1,
    recording: {
      recordingId,
      startTs: startedAt,
      finishTs: finishedAt,
      events: [
        {
          type: 'start',
          data: {
            projectId: getReplayProjectId(recordingId),
            inputs: {},
            contextValues: {},
            startGraph: graphId,
            execution,
          },
          ts: startedAt,
        },
        { type: 'graphStart', data: { graphId, inputs: {}, execution }, ts: startedAt },
        { type: 'nodeStart', data: { nodeId, inputs: {}, processId, execution }, ts: startedAt },
        {
          type: 'nodeError',
          data: {
            nodeId,
            error: 'AbortError: Aborted',
            outputs: {
              requestBody: { type: 'object', value: { requestId: 'preserved-failure-request' } },
              llmAttempts: {
                type: 'object[]',
                value: [{ kind: 'request', status: 'aborted', requestId: 'preserved-failure-attempt' }],
              },
            },
            processId,
            durationMs: 15_000,
            execution,
          },
          ts: finishedAt,
        },
        {
          type: 'graphAbort',
          data: { graphId, error: 'AbortError: Aborted', successful: false, execution },
          ts: finishedAt,
        },
        { type: 'done', data: { results: {} }, ts: finishedAt },
      ],
    },
    assets: {},
    strings: {},
  });
}

function createResponseInspectorRecording(recordingId: string): string {
  const startedAt = Date.UTC(2026, 3, 8, 11, 0, 0);
  const finishedAt = startedAt + 95_000;
  const graphId = getReplayGraphId(recordingId);
  const execution = {
    graphId,
    graphRunId: `${recordingId}-graph-run`,
    rootRunId: `${recordingId}-root-run`,
  };
  const nodeId = 'replay-llm';
  const processId = 'replay-llm-process';

  return JSON.stringify({
    version: 1,
    recording: {
      recordingId,
      startTs: startedAt,
      finishTs: finishedAt,
      events: [
        {
          type: 'start',
          data: {
            projectId: getReplayProjectId(recordingId),
            inputs: {},
            contextValues: {},
            startGraph: graphId,
            execution,
          },
          ts: startedAt,
        },
        { type: 'graphStart', data: { graphId, inputs: {}, execution }, ts: startedAt },
        {
          type: 'nodeStart',
          data: { nodeId, inputs: {}, processId, execution },
          ts: startedAt,
        },
        {
          type: 'llmCallFinished',
          data: {
            callId: 'fallback-one',
            attemptIndex: 0,
            profileIndex: 0,
            profileName: 'First fallback',
            nodeId,
            processId,
            provider: 'openai',
            model: 'gpt-5',
            outcome: 'provider-failure',
            pricing: { status: 'unknown' },
            startedAt,
            durationMs: 40_000,
            execution,
          },
          ts: startedAt + 40_000,
        },
        {
          type: 'llmCallFinished',
          data: {
            callId: 'fallback-two',
            attemptIndex: 1,
            profileIndex: 1,
            profileName: 'Second fallback',
            nodeId,
            processId,
            provider: 'openai',
            model: 'gpt-5',
            outcome: 'provider-failure',
            pricing: { status: 'unknown' },
            startedAt: startedAt + 40_000,
            durationMs: 40_000,
            execution,
          },
          ts: startedAt + 80_000,
        },
        {
          type: 'llmCallFinished',
          data: {
            callId: 'successful-response',
            attemptIndex: 2,
            profileIndex: 2,
            profileName: 'Successful fallback',
            nodeId,
            processId,
            provider: 'openai',
            model: 'gpt-5',
            outcome: 'success',
            pricing: { status: 'unknown' },
            startedAt: startedAt + 80_000,
            durationMs: 15_000,
            execution,
          },
          ts: finishedAt,
        },
        {
          type: 'nodeFinish',
          data: {
            nodeId,
            outputs: { response: { type: 'string', value: 'Recorded response' } },
            processId,
            durationMs: 95_000,
            execution,
          },
          ts: finishedAt,
        },
        { type: 'graphFinish', data: { graphId, outputs: {}, execution }, ts: finishedAt },
        { type: 'done', data: { results: {} }, ts: finishedAt },
      ],
    },
    assets: {},
    strings: {},
  });
}

function createReplayProject(recordingId: string): string {
  const node =
    recordingId === 'recording-b-inspector' || recordingId === 'recording-a-1'
      ? [
          '        \'[replay-llm]:llmChatV2 "Recorded response"\':',
          '          visualData: 520/300/340/null//',
          '          data:',
          '            configurationMode: inline',
          '            provider: openai',
          '            model: gpt-5',
          '            responseFormat: text',
          '            useToolCalling: false',
          '            autoContinueToolCalls: false',
          '            outputLLMAttempts: true',
          '            outputRequestBody: true',
          '            outputResponseBody: true',
        ]
      : [
          '        \'[replay-node-1]:text "Replay Node"\':',
          '          visualData: 520/300/260/null//',
          '          data:',
          '            text: replay',
        ];

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
    ...node,
    '  plugins: []',
    '  references: []',
    '',
  ].join('\n');
}

async function openAdditionalProjectTab(page: Page, path: string) {
  await page.route('**/api/projects/load', async (route) => {
    const requestPath = (route.request().postDataJSON() as { path?: string }).path;
    if (requestPath !== path) {
      await route.fallback();
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        contents: createReplayProject('ordinary-project'),
        datasetsContents: null,
        revisionId: 'ordinary-project-revision',
      }),
    });
  });

  await page.locator('iframe.dashboard-editor-frame').evaluate(
    (frame, command) => {
      const editorWindow = (frame as HTMLIFrameElement).contentWindow;
      if (!editorWindow) {
        throw new Error('Hosted editor frame is unavailable.');
      }

      editorWindow.postMessage(command, window.location.origin);
    },
    {
      type: 'open-project',
      path,
      replaceCurrent: false,
    },
  );
}

function createRunRecordingsFixture(includeResponseInspectorRun = false) {
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
    [
      'workflow-a',
      [
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
      ],
    ],
    [
      'workflow-b',
      Array.from({ length: 12 }, (_, index) => ({
        id: `recording-b-${index + 1}`,
        workflowId: 'workflow-b',
        createdAt: new Date(Date.UTC(2026, 3, 8, 11, 30 - index, 0)).toISOString(),
        runKind: index % 3 === 0 ? 'latest' : 'published',
        status: index === 1 || index === 7 ? 'failed' : index === 4 ? 'suspicious' : 'succeeded',
        durationMs: 900 + index * 10,
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
      })),
    ],
  ]);

  if (includeResponseInspectorRun) {
    const latestRuns = runsByWorkflow.get('workflow-b')!;
    latestRuns.push({
      id: 'recording-b-inspector',
      workflowId: 'workflow-b',
      createdAt: '2026-04-08T10:00:00.000Z',
      runKind: 'latest',
      status: 'succeeded',
      durationMs: 95_000,
      endpointNameAtExecution: 'latest-flow',
      hasReplayDataset: false,
      recordingCompressedBytes: 10,
      recordingUncompressedBytes: 20,
      projectCompressedBytes: 10,
      projectUncompressedBytes: 20,
      datasetCompressedBytes: 0,
      datasetUncompressedBytes: 0,
      input: { foo: 'inspector' },
    });
    const latestWorkflow = workflows.find((workflow) => workflow.workflowId === 'workflow-b')!;
    latestWorkflow.totalRuns = latestRuns.length;
  }

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
  options: {
    includeResponseInspectorRun?: boolean;
    latestFlowRunCount?: number;
    cursorDelayMs?: number;
    deletionGate?: Promise<void>;
    beforeDelete?: (recordingId: string) => Promise<number | void>;
    beforeRuns?: (url: URL) => Promise<void>;
    inputSearchError?: string;
  } = {},
) {
  // Keep mocked recordings tests independent of a live API/key gate. The actual
  // built editor still boots and supplies its normal ready/replay bridge.
  await page.route('**/api/config', (route) =>
    route.fulfill({
      json: {
        executorWsUrl: 'ws://127.0.0.1:8081/ws/executor/internal',
        remoteDebuggerDefaultWs: 'ws://127.0.0.1:8081/ws/latest-debugger',
        publishedWorkflowsBasePath: '/workflows',
        latestWorkflowsBasePath: '/workflows-latest',
        publishedAppsBasePath: '/apps',
        latestAppsBasePath: '/apps-latest',
        webAppsAuthMode: 'ui-gate',
      },
    }),
  );
  await page.route('**/api/workflows/evaluation-runs/library', (route) =>
    route.fulfill({
      json: {
        revision: 0,
        resourceVersions: { suites: {}, datasets: {} },
        library: {
          version: 1,
          data: { version: 1, suites: [], baselines: [] },
          datasets: [],
          migratedLegacyProjectIds: [],
        },
      },
    }),
  );
  await page.route('**/api/workflows/tree', (route) =>
    route.fulfill({
      json: {
        root: '/workflows',
        folders: [],
        projects: [],
        sync: { epoch: 'recording-search-test', revision: 0 },
      },
    }),
  );
  const { workflows, runsByWorkflow } = createRunRecordingsFixture(options.includeResponseInspectorRun);
  const recordingFetches: string[] = [];
  const replayProjectFetches: string[] = [];
  const runFetches: string[] = [];
  const latestRuns = runsByWorkflow.get('workflow-b');
  if (latestRuns && options.latestFlowRunCount != null) {
    latestRuns.splice(options.latestFlowRunCount);
    for (let index = latestRuns.length; index < options.latestFlowRunCount; index += 1) {
      latestRuns.push({
        id: `recording-b-${index + 1}`,
        workflowId: 'workflow-b',
        createdAt: new Date(Date.UTC(2026, 3, 8, 11, 30 - index, 0)).toISOString(),
        runKind: index % 3 === 0 ? 'latest' : 'published',
        status: 'succeeded',
        durationMs: 900 + index * 10,
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
      await options.beforeRuns?.(url);
      if (url.searchParams.has('inputPath') && options.inputSearchError) {
        await route.fulfill({ status: 500, json: { error: options.inputSearchError } });
        return;
      }
      const workflowId = parts[parts.length - 2]!;
      const status = (url.searchParams.get('status') ?? 'all') as WorkflowRecordingFilterStatus;
      const pageNumber = Number(url.searchParams.get('page') ?? '1');
      const pageSize = Number(url.searchParams.get('pageSize') ?? '20');
      const inputCursor = Number(url.searchParams.get('inputCursor') ?? '0');
      const inputAfter = url.searchParams.get('inputAfter');
      const hasInputFilter = url.searchParams.has('inputPath');
      const sourceRuns = runsByWorkflow.get(workflowId) ?? [];
      const filteredRuns =
        status === 'failed'
          ? sourceRuns.filter((run) => run.status === 'failed' || run.status === 'suspicious')
          : sourceRuns;
      const opaqueOffset = inputAfter?.startsWith('fixture:') ? Number(inputAfter.slice('fixture:'.length)) : undefined;
      const offset =
        hasInputFilter && Number.isFinite(opaqueOffset)
          ? opaqueOffset!
          : hasInputFilter
            ? inputCursor
            : (pageNumber - 1) * pageSize;
      const candidateRuns = filteredRuns.slice(offset, offset + pageSize);
      const pageRuns = hasInputFilter ? candidateRuns.filter((run) => applyInputFilter(run, url)) : candidateRuns;
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
          nextInputAfter: hasMore ? `fixture:${nextInputCursor}` : undefined,
          statusFilter: status,
          runs: pageRuns,
        }),
      });
      return;
    }

    if (request.method() === 'DELETE' && parts.length >= 4) {
      await options.deletionGate;
      const recordingId = decodeURIComponent(parts[3]!);
      const failureStatus = await options.beforeDelete?.(recordingId);
      if (failureStatus) {
        await route.fulfill({ status: failureStatus, json: { error: 'Delayed deletion failed' } });
        return;
      }
      for (const [workflowId, runs] of runsByWorkflow.entries()) {
        const nextRuns = runs.filter((run) => run.id !== recordingId);
        if (nextRuns.length === runs.length) {
          continue;
        }

        runsByWorkflow.set(workflowId, nextRuns);
        const workflow = workflows.find((entry) => entry.workflowId === workflowId);
        if (workflow && nextRuns.length === 0) {
          workflows.splice(workflows.indexOf(workflow), 1);
        } else if (workflow) {
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
  await expect(
    page
      .locator('.run-recordings-select__option', { hasText: 'Published Flow' })
      .locator('.run-recordings-select-option-count'),
  ).toHaveText('2 recordings');
  const latestFlowOption = page.locator('.run-recordings-select__option', { hasText: 'Latest Flow' });
  await expect(latestFlowOption.locator('.run-recordings-select-option-count')).toHaveText(
    `${expectedLatestFlowRecordingCount} recording${expectedLatestFlowRecordingCount === 1 ? '' : 's'}`,
  );
  await latestFlowOption.click();
  await expect(modal.locator('.run-recordings-workflow-name')).toHaveText('Latest Flow');

  return modal;
}

async function choosePageSizeTen(modal: Locator, expectedTotalPages = 2) {
  await modal.getByRole('button', { name: /^All/ }).click();
  await modal.getByRole('button', { name: '10', exact: true }).click();
  await expect(modal.locator('.run-recordings-page-status')).toHaveText(`Page 1 of ${expectedTotalPages}`);
}

function responseGate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function selectPublishedFlow(page: Page, modal: Locator) {
  await modal.locator('.run-recordings-selector-section .run-recordings-select__control').click();
  await page.locator('.run-recordings-select__option', { hasText: 'Published Flow' }).click();
  await expect(modal.locator('.run-recordings-workflow-name')).toHaveText('Published Flow');
}

async function deleteFirstRun(page: Page, modal: Locator) {
  const first = modal.locator('.run-recordings-run').first();
  await first.hover();
  const started = page.waitForRequest((request) => request.method() === 'DELETE');
  await first.getByRole('button', { name: 'Delete', exact: true }).click();
  return started;
}

test.describe('Run recordings modal', () => {
  test('deletions are serialized within a view and an older deletion cannot clear a newer one', async ({ page }) => {
    const oldDeletion = responseGate();
    const newDeletion = responseGate();
    const deletions: string[] = [];
    await installRunRecordingRoutes(page, {
      beforeDelete: async (id) => {
        deletions.push(id);
        await (id.startsWith('recording-b') ? oldDeletion.promise : newDeletion.promise);
      },
    });
    const modal = await openLatestFlowRecordings(page);
    await deleteFirstRun(page, modal);
    try {
      for (const button of await modal.getByRole('button', { name: 'Delete', exact: true }).all()) {
        await expect(button).toBeDisabled();
      }
      expect(deletions).toHaveLength(1);
      await selectPublishedFlow(page, modal);
      await expect(modal.locator('.run-recordings-run')).toHaveCount(2);
      await deleteFirstRun(page, modal);
      const oldResponse = page.waitForResponse(
        (response) => response.request().method() === 'DELETE' && response.url().includes('recording-b'),
      );
      oldDeletion.release();
      await oldResponse;
      await delay(200);
      for (const button of await modal.getByRole('button', { name: 'Delete', exact: true }).all()) {
        await expect(button).toBeDisabled();
      }
      newDeletion.release();
      await expect(modal.locator('.run-recordings-run')).toHaveCount(1);
      await expect(modal.getByRole('button', { name: 'Delete', exact: true })).toBeEnabled();
      expect(deletions).toHaveLength(2);
    } finally {
      oldDeletion.release();
      newDeletion.release();
    }
  });

  for (const transition of ['switch workflow', 'close and reopen'] as const) {
    test(`a late failed deletion cannot affect a new view after ${transition}`, async ({ page }) => {
      const deletion = responseGate();
      const loading = responseGate();
      let holdPublishedRuns = false;
      await installRunRecordingRoutes(page, {
        beforeDelete: async () => {
          await deletion.promise;
          return 500;
        },
        beforeRuns: async (url) => {
          if (holdPublishedRuns && url.pathname.includes('workflow-a/runs')) await loading.promise;
        },
      });
      const modal = await openLatestFlowRecordings(page);
      await deleteFirstRun(page, modal);
      try {
        holdPublishedRuns = true;
        const replacement = page.waitForRequest((request) => request.url().includes('workflow-a/runs'));
        if (transition === 'close and reopen') {
          await modal.getByLabel('Close run recordings').click();
          await expect(modal).toBeHidden();
          await page.getByRole('button', { name: 'Run recordings' }).click();
        } else {
          await selectPublishedFlow(page, modal);
        }
        await replacement;
        await expect(modal.getByText('Loading runs...', { exact: true })).toBeVisible();
        const deleted = page.waitForResponse((response) => response.request().method() === 'DELETE');
        deletion.release();
        await deleted;
        await delay(200);
        await expect(modal.locator('.run-recordings-error')).toHaveCount(0);
        await expect(modal.getByText('Loading runs...', { exact: true })).toBeVisible();
        loading.release();
        await expect(modal.locator('.run-recordings-run')).toHaveCount(2);
        await expect(modal.locator('.run-recordings-workflow-name')).toHaveText('Published Flow');
      } finally {
        deletion.release();
        loading.release();
      }
    });
  }

  test('deleting the final recording selects a remaining workflow', async ({ page }) => {
    await installRunRecordingRoutes(page, { latestFlowRunCount: 1 });
    const modal = await openLatestFlowRecordings(page, 1);
    await deleteFirstRun(page, modal);
    await expect(modal.locator('.run-recordings-workflow-name')).toHaveText('Published Flow');
    await expect(modal.locator('.run-recordings-run')).toHaveCount(2);
    await expect(modal.locator('.run-recordings-error')).toHaveCount(0);
  });

  test('malformed artifact errors stop the search without claiming there were no matches', async ({ page }) => {
    await installRunRecordingRoutes(page, {
      inputSearchError: 'Malformed recording artifact: expected valid JSON with a recording object.',
    });
    const modal = await openLatestFlowRecordings(page);
    await modal.getByRole('button', { name: 'Filter by input' }).click();
    await modal.getByLabel('Input JSON path').fill('$.foo');
    await modal.getByLabel('Value').fill('bar');
    await modal.getByRole('button', { name: 'Apply' }).click();
    await expect(modal.locator('.run-recordings-error')).toContainText('Malformed recording artifact');
    await expect(modal.locator('.run-recordings-input-search-status')).toContainText('Search stopped');
    await expect(modal.getByText('No runs match this input filter.', { exact: true })).toHaveCount(0);
    await expect(modal.getByText('Search stopped. Results may be incomplete.', { exact: true })).toBeVisible();
    await expect(modal.getByRole('button', { name: 'Apply' })).toBeEnabled();
  });

  test('deleting the final row of a page loads the preceding page once', async ({ page }) => {
    const { runFetches } = await installRunRecordingRoutes(page, { latestFlowRunCount: 21 });
    const modal = await openLatestFlowRecordings(page, 21);
    await choosePageSizeTen(modal, 3);
    await modal.getByRole('button', { name: 'Next', exact: true }).click();
    await expect(modal.locator('.run-recordings-page-status')).toHaveText('Page 2 of 3');
    await modal.getByRole('button', { name: 'Next', exact: true }).click();
    await expect(modal.locator('.run-recordings-run')).toHaveCount(1);
    const precedingPageRequests = () =>
      runFetches.filter((url) => new URL(url).searchParams.get('page') === '2').length;
    const before = precedingPageRequests();
    const lastRun = modal.locator('.run-recordings-run');
    await lastRun.hover();
    await lastRun.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(modal.locator('.run-recordings-page-status')).toHaveText('Page 2 of 2');
    await expect(modal.locator('.run-recordings-run').first()).toBeVisible();
    expect(precedingPageRequests() - before).toBe(1);
  });

  for (const deletionFails of [false, true]) {
    test(`a delayed ${deletionFails ? 'failed' : 'successful'} deletion cannot stop a replacement input search`, async ({
      page,
    }) => {
      let releaseDeletion!: () => void;
      const deletionGate = new Promise<void>((resolve) => {
        releaseDeletion = resolve;
      });
      await installRunRecordingRoutes(page, {
        latestFlowRunCount: 30,
        cursorDelayMs: 500,
        deletionGate,
        beforeDelete: async () => (deletionFails ? 500 : undefined),
      });
      const modal = await openLatestFlowRecordings(page, 30);
      await choosePageSizeTen(modal, 3);
      await modal.getByRole('button', { name: 'Filter by input' }).click();
      await modal.getByLabel('Input JSON path').fill('$.missing');
      const operatorControl = modal.locator('.run-recordings-input-filter-operator .run-recordings-select__control');
      await operatorControl.click();
      await page.locator('.run-recordings-select__option').filter({ hasText: /^!=$/ }).click();
      await modal.getByLabel('Value').fill('bar');
      await modal.getByRole('button', { name: 'Apply' }).click();
      await expect(modal.getByRole('button', { name: 'Stop search' })).toBeVisible();
      const first = modal.locator('.run-recordings-run').first();
      await first.hover();
      const deletionStarted = page.waitForRequest((request) => request.method() === 'DELETE');
      await first.getByRole('button', { name: 'Delete' }).click();
      await deletionStarted;
      try {
        await modal.getByRole('button', { name: 'Clear', exact: true }).click();
        await expect(modal.getByRole('button', { name: 'Apply' })).toBeEnabled();
        await modal.getByLabel('Input JSON path').fill('$.foo');
        await operatorControl.click();
        await page.locator('.run-recordings-select__option').filter({ hasText: /^==$/ }).click();
        await modal.getByLabel('Value').fill('bar');
        await modal.getByRole('button', { name: 'Apply' }).click();
        const status = modal.locator('.run-recordings-input-search-status');
        await expect(status).toHaveText('Search complete, 2 matches found');
        const deleted = page.waitForResponse((response) => response.request().method() === 'DELETE');
        releaseDeletion();
        await deleted;
        // Flush the response's state updates, including a possible metadata fetch.
        await delay(200);
        await expect(status).toHaveText('Search complete, 2 matches found');
        await expect(modal.locator('.run-recordings-run')).toHaveCount(2);
        await expect(modal.locator('.run-recordings-error')).toHaveCount(0);
      } finally {
        releaseDeletion();
      }
    });
  }

  test('progressive results preserve scrolling and replacement searches discard late batches', async ({ page }) => {
    const { runFetches } = await installRunRecordingRoutes(page, { latestFlowRunCount: 120, cursorDelayMs: 500 });
    const modal = await openLatestFlowRecordings(page, 120);
    await modal.getByRole('button', { name: 'Filter by input' }).click();
    await modal.getByLabel('Input JSON path').fill('$.missing');
    await modal.locator('.run-recordings-input-filter-operator .run-recordings-select__control').click();
    await page.locator('.run-recordings-select__option').filter({ hasText: /^!=$/ }).click();
    await modal.getByLabel('Value').fill('bar');
    await modal.getByRole('button', { name: 'Apply' }).click();
    const list = modal.locator('.run-recordings-list');
    await expect(list).toBeVisible();
    await expect.poll(() => runFetches.filter((url) => url.includes('inputCursor=20')).length).toBeGreaterThan(0);
    await list.evaluate((element) => {
      element.scrollTop = 350;
    });
    await expect.poll(() => list.evaluate((element) => element.scrollTop)).toBe(350);
    await expect.poll(() => runFetches.filter((url) => url.includes('inputCursor=40')).length).toBeGreaterThan(0);
    await expect.poll(() => list.evaluate((element) => element.scrollTop)).toBe(350);
    await modal.getByLabel('Input JSON path').fill('$.foo');
    await modal.locator('.run-recordings-input-filter-operator .run-recordings-select__control').click();
    await page.locator('.run-recordings-select__option').filter({ hasText: /^==$/ }).click();
    await modal.getByRole('button', { name: 'Apply' }).click();
    await expect(modal.locator('.run-recordings-input-search-status')).toContainText('Search complete');
    await expect(modal.locator('.run-recordings-run')).toHaveCount(2);
    await page.setViewportSize({ width: 1100, height: 850 });
    await expect(modal.locator('.run-recordings-run').last()).toBeVisible();
    await modal.locator('.run-recordings-run').first().hover();
    await modal.locator('.run-recordings-run').first().getByRole('button', { name: 'Delete' }).click();
    await expect(modal.locator('.run-recordings-run')).toHaveCount(1);
  });

  test('filters and paginates runs with the operator menu outside modal clipping', async ({ page }) => {
    const { runFetches } = await installRunRecordingRoutes(page);
    const modal = await openLatestFlowRecordings(page);
    const runFilter = modal.getByRole('group', { name: 'Filter runs' });
    await expect(runFilter).toHaveClass(/segmented-control/);
    await expect(runFilter.getByRole('button').first()).toHaveCSS('height', '28px');
    await expect(runFilter.getByRole('button').first()).toHaveAttribute('aria-pressed', 'true');
    await expect(modal.locator('.run-recordings-run').first().locator('.run-recordings-run-endpoint')).toHaveText(
      'Endpoint at execution: latest-flow',
    );

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
    expect(runFetches.some((requestUrl) => new URL(requestUrl).searchParams.get('inputAfter') === 'fixture:10')).toBe(
      true,
    );

    await modal.getByRole('button', { name: 'Clear' }).click();
    await expect(modal.locator('.run-recordings-page-status')).toHaveText('Page 1 of 2');

    await modal.getByLabel('Input JSON path').fill('$');
    await operatorControl.click();
    await page
      .locator('.run-recordings-select__option')
      .filter({ hasText: /^contains$/ })
      .click();
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
    await expect(modal.locator('.run-recordings-input-search-status')).toContainText('12 matches found');
    await expect(modal.locator('.run-recordings-input-search-status')).toContainText('Search complete');
    await expect
      .poll(
        () =>
          runFetches.filter((requestUrl) => {
            const request = new URL(requestUrl);
            return (
              request.searchParams.get('inputPath') === '$.missing' &&
              request.searchParams.get('inputOperator') === '!='
            );
          }).length,
      )
      .toBeGreaterThan(1);
    const missingNotEqualsRequest = new URL(runFetches.at(-1)!);
    expect(missingNotEqualsRequest.searchParams.get('inputPath')).toBe('$.missing');
    expect(missingNotEqualsRequest.searchParams.get('inputOperator')).toBe('!=');
    expect(missingNotEqualsRequest.searchParams.get('inputValue')).toBe('bar');

    await operatorControl.click();
    await page.locator('.run-recordings-select__option').filter({ hasText: /^==$/ }).click();
    await modal.getByLabel('Value').fill('undefined');
    await modal.getByRole('button', { name: 'Apply' }).click();
    await expect(modal.locator('.run-recordings-input-search-status')).toContainText('12 matches found');
    await expect(modal.locator('.run-recordings-input-search-status')).toContainText('Search complete');
    const missingEqualsUndefinedRequest = new URL(runFetches.at(-1)!);
    expect(missingEqualsUndefinedRequest.searchParams.get('inputPath')).toBe('$.missing');
    expect(missingEqualsUndefinedRequest.searchParams.get('inputOperator')).toBe('==');
    expect(missingEqualsUndefinedRequest.searchParams.get('inputValue')).toBe('undefined');
  });

  test('deletes a run and opens replay through serialized recorder APIs', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('recoil-persist', JSON.stringify({ defaultExecutor: 'nodejs' }));
    });
    const { recordingFetches, replayProjectFetches, runFetches } = await installRunRecordingRoutes(page);
    const modal = await openLatestFlowRecordings(page);
    await choosePageSizeTen(modal);

    const firstRun = modal.locator('.run-recordings-run').first();
    await firstRun.hover();
    await firstRun.locator('.run-recordings-run-delete-button').click();
    await expect(modal.locator('.run-recordings-page-status')).toHaveText('Page 1 of 2');
    await expect(modal.locator('.run-recordings-run').first()).toBeVisible();

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
    await expect(editorFrame.locator('.recording-border')).toBeVisible();
    await editorFrame.locator('.more-menu').click();
    await expect(editorFrame.getByText('Not used during recording playback', { exact: true })).toBeVisible();
    await expect(editorFrame.getByRole('group', { name: 'Executor mode' })).toHaveCount(0);
    await editorFrame.locator('.more-menu').click();

    await openAdditionalProjectTab(page, '/workflows/Ordinary project.rivet-project');
    const ordinaryProjectTab = editorFrame.locator('.project').filter({ hasText: 'Ordinary project' });
    await expect(ordinaryProjectTab).toHaveClass(/active/);
    await expect(editorFrame.locator('.recording-border')).toHaveCount(0);
    await expect(editorFrame.getByRole('button', { name: 'Play Recording', exact: true })).toHaveCount(0);
    await expect(editorFrame.getByRole('button', { name: 'Unload Recording', exact: true })).toHaveCount(0);

    await editorFrame.locator('.project').filter({ hasText: 'Replay recording-b-2' }).click();
    await expect(editorFrame.locator('.recording-border')).toBeVisible();
    await expect(editorFrame.getByRole('button', { name: 'Play Recording', exact: true })).toBeVisible();
    await expect(editorFrame.getByRole('button', { name: 'Unload Recording', exact: true })).toBeVisible();

    await editorFrame.getByRole('button', { name: 'Unload Recording', exact: true }).click();
    await expect(editorFrame.getByRole('button', { name: 'Play Recording', exact: true })).toHaveCount(0);
    await editorFrame.locator('.more-menu').click();
    const executorMode = editorFrame.getByRole('group', { name: 'Executor mode' });
    await expect(executorMode).toBeVisible();
    await expect(executorMode.getByRole('button', { name: 'Node', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(modal).toBeHidden();
    await expect(page.getByText('Found: 11')).toBeVisible();

    const runFetchCountAfterReplayOpen = runFetches.length;
    await page.getByRole('button', { name: 'Run recordings' }).click();
    await expect(modal).toBeVisible();
    await expect(modal.locator('.run-recordings-page-status')).toHaveText('Page 1 of 2');
    await expect(modal.locator('.run-recordings-run').first()).toBeVisible();
    expect(runFetches.length).toBe(runFetchCountAfterReplayOpen);

    await modal.getByLabel('Close run recordings').click();
    await expect(modal).toBeHidden();
    await expect(page.getByText(/^Found:/)).toHaveCount(0);
  });

  test('shows recorded LLM response duration instead of accelerated replay time', async ({ page }) => {
    const { recordingFetches, replayProjectFetches } = await installRunRecordingRoutes(page, {
      includeResponseInspectorRun: true,
    });
    const modal = await openLatestFlowRecordings(page, 13);

    const inspectorRun = modal.locator('.run-recordings-run').filter({
      has: page.locator('.run-recordings-run-duration', { hasText: '1m 35s' }),
    });
    await expect
      .poll(async () => {
        await modal.locator('.run-recordings-list').evaluate((element) => {
          element.scrollTop = element.scrollHeight;
        });
        return inspectorRun.count();
      })
      .toBe(1);
    await expect(inspectorRun).toHaveCount(1);
    await inspectorRun.locator('.run-recordings-run-open-button').click();
    await expect.poll(() => recordingFetches).toEqual(['recording-b-inspector']);
    await expect.poll(() => replayProjectFetches).toEqual(['recording-b-inspector']);

    const editorFrame = page.frameLocator('iframe.dashboard-editor-frame');
    await editorFrame.getByRole('button', { name: 'Play Recording', exact: true }).click();
    const inspectorButton = editorFrame.locator('.response-inspector-button');
    await expect(inspectorButton).toBeVisible();
    await inspectorButton.click();

    await expect(editorFrame.getByText('Response inspector', { exact: true })).toBeVisible();
    await expect(editorFrame.getByText('95.0 sec', { exact: true })).toBeVisible();
    await expect(editorFrame.getByText('0.00 sec', { exact: true })).toHaveCount(0);
    await expect(editorFrame.getByText(/^15\.0 sec/)).toBeVisible();

    await editorFrame.getByRole('button', { name: 'Close modal', exact: true }).click();
    await editorFrame.getByRole('button', { name: 'Open Run Activity', exact: true }).click();
    await expect(editorFrame.locator('[aria-label="Run Activity"]')).toContainText('Completed / 1m 35.00s');
  });

  test('keeps captured LLM failure outputs visible alongside a replayed error', async ({ page }) => {
    const { recordingFetches, replayProjectFetches } = await installRunRecordingRoutes(page);
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await authenticateIfNeeded(page);
    await waitForDashboardReady(page);

    await page.getByRole('button', { name: 'Run recordings' }).click();
    const modal = page.getByTestId('run-recordings-modal');
    await expect(modal).toBeVisible();
    await modal.locator('.run-recordings-select__control').click();
    await page.locator('.run-recordings-select__option', { hasText: 'Published Flow' }).click();
    await expect(modal.locator('.run-recordings-workflow-name')).toHaveText('Published Flow');

    const failedRun = modal.locator('.run-recordings-run').filter({
      has: page.locator('.run-recordings-badge.failed', { hasText: 'Failed' }),
    });
    await expect(failedRun).toHaveCount(1);
    await failedRun.locator('.run-recordings-run-open-button').click();
    await expect.poll(() => recordingFetches).toEqual(['recording-a-1']);
    await expect.poll(() => replayProjectFetches).toEqual(['recording-a-1']);

    const editorFrame = page.frameLocator('iframe.dashboard-editor-frame');
    await editorFrame.getByRole('button', { name: 'Play Recording', exact: true }).click();
    const failedNodeOutput = editorFrame.locator('.node[data-nodeid="replay-llm"] .node-output');
    await expect(failedNodeOutput).toContainText('AbortError: Aborted');
    await expect(failedNodeOutput).toContainText('preserved-failure-request');
    await failedNodeOutput.hover();
    await failedNodeOutput.locator('.expand-button').click();
    const fullscreenOutput = editorFrame.getByTestId('fullscreen-output-modal');
    await expect(fullscreenOutput).toContainText('AbortError: Aborted');
    await expect(fullscreenOutput).toContainText('preserved-failure-request');
    await expect(fullscreenOutput).toContainText('preserved-failure-attempt');
  });

  test('saves the loaded recording artifact after playback instead of a replay timeline', async ({ page }) => {
    await page.addInitScript(() => {
      const savedFiles: Array<{ suggestedName: string; content: string }> = [];
      Object.defineProperty(window, 'showSaveFilePicker', {
        configurable: true,
        value: async ({ suggestedName }: { suggestedName: string }) => ({
          createWritable: async () => ({
            write: async (content: string) => {
              savedFiles.push({ suggestedName, content });
            },
            close: async () => {},
          }),
        }),
      });
      (window as typeof window & { __rivetSavedRecordingFiles?: typeof savedFiles }).__rivetSavedRecordingFiles =
        savedFiles;
    });
    await installRunRecordingRoutes(page, { includeResponseInspectorRun: true });
    const modal = await openLatestFlowRecordings(page, 13);
    const inspectorRun = modal.locator('.run-recordings-run').filter({
      has: page.locator('.run-recordings-run-duration', { hasText: '1m 35s' }),
    });
    await expect
      .poll(async () => {
        await modal.locator('.run-recordings-list').evaluate((element) => {
          element.scrollTop = element.scrollHeight;
        });
        return inspectorRun.count();
      })
      .toBe(1);
    await inspectorRun.locator('.run-recordings-run-open-button').click();

    const editorFrame = page.frameLocator('iframe.dashboard-editor-frame');
    const editorElement = page.locator('iframe.dashboard-editor-frame');
    const savedFiles = () =>
      editorElement.evaluate((frame) => {
        const editorWindow = (frame as HTMLIFrameElement).contentWindow as
          | (Window & { __rivetSavedRecordingFiles?: Array<{ content: string }> })
          | null;
        return editorWindow?.__rivetSavedRecordingFiles ?? [];
      });

    await editorFrame.getByRole('button', { name: 'Save Recording', exact: true }).click();
    await expect.poll(async () => (await savedFiles()).length).toBe(1);
    const savedBeforePlayback = (await savedFiles())[0]?.content;
    const firstRecording = JSON.parse(savedBeforePlayback!) as {
      recording: { startTs: number; finishTs: number; events: Array<{ type: string; data: { durationMs?: number } }> };
    };
    expect(firstRecording.recording.finishTs - firstRecording.recording.startTs).toBe(95_000);
    expect(firstRecording.recording.events.find((event) => event.type === 'nodeFinish')?.data.durationMs).toBe(95_000);

    await editorFrame.getByRole('button', { name: 'Play Recording', exact: true }).click();
    await expect(editorFrame.locator('.response-inspector-button')).toBeVisible();
    await editorFrame.getByRole('button', { name: 'Save Recording', exact: true }).click();
    await expect.poll(async () => (await savedFiles()).length).toBe(2);
    expect((await savedFiles())[1]?.content).toBe(savedBeforePlayback);
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
    await expect(modal.locator('.run-recordings-input-search-status')).toContainText('10 matches found');
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
