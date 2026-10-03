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
    subgraphRun?: boolean;
    relatedSubgraphRuns?: boolean;
    latestFlowDurationMs?: number | null;
    latestFlowRunCount?: number;
    cursorDelayMs?: number;
    deletionGate?: Promise<void>;
    recordingError?: string;
    recordingGate?: Promise<void>;
    beforeDelete?: (recordingId: string) => Promise<number | void>;
    beforeRuns?: (url: URL) => Promise<void>;
    inputSearchError?: string;
    missingSourceProject?: boolean;
    staleCatalog?: boolean;
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
  const initialWorkflows = workflows.map((workflow) => ({ ...workflow }));
  const initialRuns = [...runsByWorkflow.values()].flat();
  if (options.subgraphRun) {
    const run = runsByWorkflow.get('workflow-a')![0]!;
    run.runKind = 'editor';
    run.endpointNameAtExecution = 'Subgraph: Extract facts';
    run.executionIdentity = {
      surface: 'subgraph_project',
      graphId: 'extract-facts',
      correlationId: 'rvt-related-example-12345',
    };
  }
  if (options.relatedSubgraphRuns) {
    const root = runsByWorkflow.get('workflow-a')![0]!;
    root.executionIdentity = { surface: 'workflow_endpoint', correlationId: 'rvt-root-caller-12345' };
    const child = runsByWorkflow.get('workflow-b')![0]!;
    child.executionIdentity = {
      surface: 'subgraph_project',
      correlationId: 'rvt-root-caller-12345',
      graphName: 'Extract facts',
    };
    child.endpointNameAtExecution = 'Subgraph: Extract facts';
    child.sourceProjectRelativePath = 'Latest Flow.rivet-project';
    child.status = 'failed';
    child.input = { score: 99 };
  }
  const recordingFetches: string[] = [];
  const replayProjectFetches: string[] = [];
  const runFetches: string[] = [];
  const latestRuns = runsByWorkflow.get('workflow-b');
  if (latestRuns?.[0] && 'latestFlowDurationMs' in options) {
    // Deliberately allow malformed legacy API timing data in these fixtures.
    latestRuns[0].durationMs = options.latestFlowDurationMs as number;
  }
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
      const allRuns = options.staleCatalog ? initialRuns : [...runsByWorkflow.values()].flat();
      const catalogWorkflows = options.staleCatalog ? initialWorkflows : workflows;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          workflows: options.missingSourceProject
            ? catalogWorkflows.filter((workflow) => workflow.workflowId !== 'workflow-a')
            : catalogWorkflows,
          totals: {
            totalRuns: allRuns.length,
            failedRuns: allRuns.filter((run) => run.status === 'failed').length,
            suspiciousRuns: allRuns.filter((run) => run.status === 'suspicious').length,
          },
        }),
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
      const workflowId = url.pathname.endsWith('/recordings/runs') ? '' : parts[parts.length - 2]!;
      const status = (url.searchParams.get('status') ?? 'all') as WorkflowRecordingFilterStatus;
      const pageNumber = Number(url.searchParams.get('page') ?? '1');
      const pageSize = Number(url.searchParams.get('pageSize') ?? '20');
      const inputCursor = Number(url.searchParams.get('inputCursor') ?? '0');
      const inputAfter = url.searchParams.get('inputAfter');
      const hasInputFilter = url.searchParams.has('inputPath');
      const allRuns = [...runsByWorkflow.values()].flat();
      const rootKeys = new Set(
        allRuns
          .filter((run) => run.workflowId === workflowId && run.executionIdentity?.surface !== 'subgraph_project')
          .map((run) => run.executionIdentity?.correlationId)
          .filter(Boolean),
      );
      const sourceRuns = allRuns
        .filter(
          (run) =>
            !workflowId ||
            run.workflowId === workflowId ||
            (url.searchParams.get('includeSubgraphRuns') === 'true' &&
              run.executionIdentity?.surface === 'subgraph_project' &&
              rootKeys.has(run.executionIdentity.correlationId)),
        )
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
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
          ...(workflowId && options.relatedSubgraphRuns
            ? {
                scopeCounts: {
                  totalRuns: sourceRuns.length,
                  failedRuns: sourceRuns.filter((run) => run.status === 'failed').length,
                  suspiciousRuns: sourceRuns.filter((run) => run.status === 'suspicious').length,
                },
              }
            : {}),
          page: pageNumber,
          pageSize,
          totalRuns: hasInputFilter ? pageRuns.length : filteredRuns.length,
          totalRunsExact: !hasInputFilter || !hasMore,
          hasMore,
          nextInputCursor: hasMore ? nextInputCursor : undefined,
          inputSearchAnalyzedRuns: hasInputFilter ? nextInputCursor : undefined,
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
      await options.recordingGate;
      if (options.recordingError) {
        await route.fulfill({ status: 404, json: { error: options.recordingError } });
        return;
      }
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
  ).toHaveText('2 recordings in this project');
  const latestFlowOption = page.locator('.run-recordings-select__option', { hasText: 'Latest Flow' });
  await expect(latestFlowOption.locator('.run-recordings-select-option-count')).toHaveText(
    `${expectedLatestFlowRecordingCount} recording${expectedLatestFlowRecordingCount === 1 ? '' : 's'} in this project`,
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
  for (const [durationMs, expected] of [
    [2.8421670000243466, '2.84 ms'],
    [0, '0.00 ms'],
    [12345.678, '12.35 s'],
    [59999, '1m 0.00s'],
    [59995, '1m 0.00s'],
    [95432.1, '1m 35.43s'],
    [119999, '2m 0.00s'],
    [null, 'Unavailable'],
    [undefined, 'Unavailable'],
    [-1, 'Unavailable'],
    [Number.NaN, 'Unavailable'],
    [Number.POSITIVE_INFINITY, 'Unavailable'],
  ] as const) {
    test(`rounds recording duration ${durationMs} to ${expected}`, async ({ page }) => {
      await installRunRecordingRoutes(page, { latestFlowDurationMs: durationMs });
      const modal = await openLatestFlowRecordings(page);
      await expect(modal.locator('.run-recordings-run-duration').first()).toHaveText(expected);
    });
  }

  test('a fresh session defaults to Any after closing a workflow-specific view', async ({ page }) => {
    await installRunRecordingRoutes(page);
    const modal = await openLatestFlowRecordings(page);
    await modal.getByLabel('Close run recordings').click();
    await expect(modal).toBeHidden();
    await page.getByRole('button', { name: 'Run recordings' }).click();
    await expect(modal.locator('.run-recordings-selector-section .run-recordings-select__single-value')).toHaveText(
      'Any',
    );
    await expect(modal.locator('.run-recordings-workflow-summary')).toHaveCount(0);
    await expect(modal.locator('.run-recordings-runs-title')).toHaveText('14 Runs');
  });

  test('Any remains available when no workflows have recordings', async ({ page }) => {
    await installRunRecordingRoutes(page);
    await page.route('**/api/workflows/recordings/**', async (route) => {
      const url = new URL(route.request().url());
      await route.fulfill({
        json: url.pathname.endsWith('/workflows')
          ? { workflows: [] }
          : {
              workflowId: '',
              page: 1,
              pageSize: 20,
              totalRuns: 0,
              totalRunsExact: true,
              hasMore: false,
              statusFilter: 'all',
              runs: [],
            },
      });
    });
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await authenticateIfNeeded(page);
    await waitForDashboardReady(page);
    await page.getByRole('button', { name: 'Run recordings' }).click();
    const modal = page.getByTestId('run-recordings-modal');
    await expect(modal.locator('.run-recordings-workflow-summary')).toHaveCount(0);
    await modal.locator('.run-recordings-select__control').click();
    await expect(page.locator('.run-recordings-select__option')).toHaveCount(1);
    await expect(page.locator('.run-recordings-select__option').first()).toContainText('Any');
    await page.locator('.run-recordings-select__option').first().click();
    await modal.getByRole('button', { name: /^Bad only/ }).click();
    await expect(modal.locator('.run-recordings-run')).toHaveCount(0);
  });

  test('Any is first and filters, paginates and deletes runs across workflows', async ({ page }) => {
    await installRunRecordingRoutes(page);
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await authenticateIfNeeded(page);
    await waitForDashboardReady(page);
    await page.getByRole('button', { name: 'Run recordings' }).click();
    const modal = page.getByTestId('run-recordings-modal');
    await expect(modal.locator('.run-recordings-workflow-summary')).toHaveCount(0);
    await expect(modal.locator('.run-recordings-runs-title')).toHaveText('14 Runs');
    await expect(modal.locator('.run-recordings-run').first()).toBeVisible();
    await expect(modal.locator('.run-recordings-details')).toHaveCSS('grid-template-rows', /^[\d.]+px$/);
    await modal.locator('.run-recordings-select__control').click();
    await expect(page.locator('.run-recordings-select__option').first()).toContainText('Any');
    await page.locator('.run-recordings-select__option').first().click();
    await choosePageSizeTen(modal);
    await modal.getByRole('button', { name: 'Next', exact: true }).click();
    await expect(modal.locator('.run-recordings-run')).toHaveCount(4);
    await modal.getByRole('button', { name: /^Bad only/ }).click();
    await expect(modal.locator('.run-recordings-run')).toHaveCount(4);
    await modal.getByRole('button', { name: /^All/ }).click();
    await modal.getByRole('button', { name: 'Filter by input', exact: true }).click();
    await modal.getByPlaceholder('$.foo').fill('$.foo');
    await modal.getByPlaceholder('bar', { exact: true }).fill('bar');
    await modal.getByRole('button', { name: 'Apply', exact: true }).click();
    await expect(modal).toContainText('Search complete, 3 matches found');
    await deleteFirstRun(page, modal);
    await expect(modal).toContainText('Search complete, 2 matches found');
    await selectPublishedFlow(page, modal);
    await expect(modal.locator('.run-recordings-workflow-summary')).toBeVisible();
    await expect(modal.locator('.run-recordings-workflow-summary')).toContainText('Endpoint');
    await expect(modal.locator('.run-recordings-workflow-summary')).toContainText('Project path');
    await modal.locator('.run-recordings-selector-section .run-recordings-select__control').click();
    await page.locator('.run-recordings-select__option').first().click();
    await expect(modal.locator('.run-recordings-workflow-summary')).toHaveCount(0);
    await expect(modal).toContainText('Search complete, 2 matches found');
  });

  test('Any counts and searches retained runs whose project is missing from the tree', async ({ page }) => {
    await installRunRecordingRoutes(page, { missingSourceProject: true });
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await authenticateIfNeeded(page);
    await waitForDashboardReady(page);
    await page.getByRole('button', { name: 'Run recordings' }).click();
    const modal = page.getByTestId('run-recordings-modal');
    await expect(modal.getByRole('button', { name: /^All/ })).toContainText('14');
    await expect(modal.getByRole('button', { name: /^Bad only/ })).toContainText('4');
    await modal.getByRole('button', { name: 'Filter by input', exact: true }).click();
    await modal.getByPlaceholder('$.foo').fill('$.foo');
    await modal.getByPlaceholder('bar', { exact: true }).fill('bar');
    await modal.getByRole('button', { name: 'Apply', exact: true }).click();
    await expect(modal).toContainText('Search complete, 3 matches found');
    await expect(modal).toContainText('14 of 14');
    await deleteFirstRun(page, modal);
    await expect(modal.getByRole('button', { name: /^All/ })).toContainText('13');
    await expect(modal).toContainText('13 of 13');
  });

  test('workflow details and recording controls remain reachable on a narrow screen', async ({ page }) => {
    await page.setViewportSize({ width: 700, height: 800 });
    await installRunRecordingRoutes(page);
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await authenticateIfNeeded(page);
    await waitForDashboardReady(page);
    await page.getByRole('button', { name: 'Run recordings' }).click();
    const modal = page.getByTestId('run-recordings-modal');
    const scrollModal = async (delta: number) => {
      await modal.hover({ position: { x: 10, y: 100 } });
      await page.mouse.wheel(0, delta);
    };
    await expect(modal.locator('.run-recordings-workflow-summary')).toHaveCount(0);
    await choosePageSizeTen(modal);
    await scrollModal(2000);
    await expect(modal.locator('.run-recordings-pagination-footer')).toBeInViewport({ ratio: 1 });
    await scrollModal(-2000);
    await modal.locator('.run-recordings-selector-section .run-recordings-select__control').click();
    await page.locator('.run-recordings-select__option', { hasText: 'Latest Flow' }).click();
    await expect(modal.locator('.run-recordings-workflow-summary')).toBeVisible();
    await scrollModal(2000);
    await expect(modal.locator('.run-recordings-pagination-footer')).toBeInViewport({ ratio: 1 });
    await scrollModal(-2000);
    await modal.getByRole('button', { name: 'Filter by input' }).click();
    await scrollModal(400);
    await expect(modal.getByRole('button', { name: 'Apply', exact: true })).toBeInViewport({ ratio: 1 });
    await scrollModal(2000);
    await expect(modal.locator('.run-recordings-pagination-footer')).toBeInViewport({ ratio: 1 });
    await scrollModal(-2000);
    await modal.locator('.run-recordings-selector-section .run-recordings-select__control').click();
    await page.locator('.run-recordings-select__option').first().click();
    await expect(modal.locator('.run-recordings-workflow-summary')).toHaveCount(0);
    await scrollModal(2000);
    await expect(modal.locator('.run-recordings-pagination-footer')).toBeInViewport({ ratio: 1 });
  });

  test('stale catalog counts do not pull Any pagination back to an earlier page', async ({ page }) => {
    await installRunRecordingRoutes(page, { latestFlowRunCount: 30, staleCatalog: true });
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await authenticateIfNeeded(page);
    await waitForDashboardReady(page);
    await page.getByRole('button', { name: 'Run recordings' }).click();
    const modal = page.getByTestId('run-recordings-modal');
    await choosePageSizeTen(modal, 4);
    await modal.getByRole('button', { name: 'Next', exact: true }).click();
    await expect(modal.locator('.run-recordings-page-status')).toHaveText('Page 2 of 4');
    await modal.getByRole('button', { name: 'Next', exact: true }).click();
    await expect(modal.locator('.run-recordings-page-status')).toHaveText('Page 3 of 4');
    await modal.getByRole('button', { name: 'Next', exact: true }).click();
    await expect(modal.locator('.run-recordings-page-status')).toHaveText('Page 4 of 4');
    await expect(modal.locator('.run-recordings-run')).toHaveCount(2);
  });

  for (const runCount of [5, 30]) {
    test(`stale catalog counts do not falsify search progress after ${runCount} workflow runs`, async ({ page }) => {
      await installRunRecordingRoutes(page, { latestFlowRunCount: runCount, staleCatalog: true });
      await page.goto('/', { waitUntil: 'domcontentloaded' });
      await authenticateIfNeeded(page);
      await waitForDashboardReady(page);
      await page.getByRole('button', { name: 'Run recordings' }).click();
      const modal = page.getByTestId('run-recordings-modal');
      await modal.getByRole('button', { name: 'Filter by input' }).click();
      await modal.getByLabel('Input JSON path').fill('$.foo');
      await modal.getByLabel('Value').fill('bar');
      await modal.getByRole('button', { name: 'Apply' }).click();
      await expect(modal.locator('.run-recordings-input-search-status')).toContainText('Search complete');
      await expect(modal.getByRole('progressbar')).toHaveAttribute(
        'aria-valuetext',
        `Analyzed ${runCount + 2} of ${runCount + 2} available runs (100%)`,
      );
    });
  }

  test('remembers applied input paths without duplicates and supports selection and permanent deletion', async ({
    page,
  }, testInfo) => {
    await installRunRecordingRoutes(page);
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await authenticateIfNeeded(page);
    await waitForDashboardReady(page);
    await page.getByRole('button', { name: 'Run recordings' }).click();
    const modal = page.getByTestId('run-recordings-modal');
    await modal.getByRole('button', { name: 'Filter by input' }).click();
    const path = modal.getByRole('combobox', { name: 'Input JSON path' });
    const apply = modal.getByRole('button', { name: 'Apply', exact: true });
    const history = modal.getByRole('dialog', { name: 'Saved input JSON paths' });
    await path.fill('not-a-path');
    await apply.click();
    await expect(modal.locator('.run-recordings-input-filter-error')).toHaveText('JSON path must start with $');
    await path.click();
    await expect(history).toHaveCount(0);
    await modal.getByLabel('Value', { exact: true }).fill('bar');
    for (const value of [' $.foo ', '$.foo', '$.missing']) {
      await path.fill(value);
      await apply.click();
      await expect(modal.locator('.run-recordings-input-search-status')).toContainText('Search complete');
    }
    await path.click();
    await expect(history.locator('.run-recordings-input-path-select')).toHaveText(['$.missing', '$.foo']);
    await page.screenshot({ path: testInfo.outputPath('input-path-history.png') });
    await history.getByRole('button', { name: '$.foo', exact: true }).click();
    await expect(path).toHaveValue('$.foo');
    await expect(history).toHaveCount(0);
    // Choosing a suggestion only edits the draft; it does not start another search.
    await expect(modal.locator('.run-recordings-input-search-status')).toContainText('0 matches found');
    await path.press('ArrowDown');
    await expect(history.getByRole('button', { name: '$.missing', exact: true })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(path).toBeFocused();
    await expect(history).toHaveCount(0);
    await path.click();
    await history.getByRole('button', { name: 'Delete saved path $.missing', exact: true }).click();
    await expect(path).toHaveValue('$.foo');
    await expect(history.locator('.run-recordings-input-path-select')).toHaveText(['$.foo']);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForDashboardReady(page);
    await page.getByRole('button', { name: 'Run recordings' }).click();
    await modal.getByRole('button', { name: 'Filter by input' }).click();
    await path.click();
    await expect(history.locator('.run-recordings-input-path-select')).toHaveText(['$.foo']);
    await selectPublishedFlow(page, modal);
    await path.click();
    await expect(history.locator('.run-recordings-input-path-select')).toHaveText(['$.foo']);
    await history.getByRole('button', { name: 'Delete saved path $.foo', exact: true }).click();
    await expect(history).toHaveCount(0);
    await expect(path).toBeFocused();
  });

  test('input path history remains usable when browser storage writes are denied', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('rivet.run-recordings.input-path-history.v1', JSON.stringify(['$.old']));
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) {
        if (
          key === 'rivet.run-recordings.input-path-history.v1' &&
          localStorage.getItem('history-write-enabled') !== '1'
        ) {
          throw new Error('Storage denied');
        }
        original.call(this, key, value);
      };
    });
    await installRunRecordingRoutes(page);
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await authenticateIfNeeded(page);
    await waitForDashboardReady(page);
    await page.getByRole('button', { name: 'Run recordings' }).click();
    const modal = page.getByTestId('run-recordings-modal');
    await modal.getByRole('button', { name: 'Filter by input' }).click();
    const path = modal.getByRole('combobox', { name: 'Input JSON path' });
    await path.fill('$.foo');
    await modal.getByLabel('Value', { exact: true }).fill('bar');
    await modal.getByRole('button', { name: 'Apply', exact: true }).click();
    await expect(modal.locator('.run-recordings-input-search-status')).toContainText('Search complete');
    await path.click();
    const history = modal.getByRole('dialog', { name: 'Saved input JSON paths' });
    await expect(history.locator('.run-recordings-input-path-select')).toHaveText(['$.foo', '$.old']);
    await expect(history.getByRole('button', { name: '$.foo', exact: true })).toBeVisible();
    await history.getByRole('button', { name: 'Delete saved path $.foo', exact: true }).click();
    await history.getByRole('button', { name: 'Delete saved path $.old', exact: true }).click();
    await expect(history).toHaveCount(0);
    await modal.getByLabel('Value', { exact: true }).click();
    await path.click();
    await expect(history).toHaveCount(0);
    await expect(path).toHaveValue('$.foo');
    await modal.getByLabel('Close run recordings').click();
    await page.getByRole('button', { name: 'Run recordings' }).click();
    await modal.getByRole('button', { name: 'Filter by input' }).click();
    await path.click();
    await expect(history).toHaveCount(0);
    await page.evaluate(() => localStorage.setItem('history-write-enabled', '1'));
    await modal.getByLabel('Value', { exact: true }).click();
    await path.click();
    await expect(history).toHaveCount(0);
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem('rivet.run-recordings.input-path-history.v1')))
      .toBe('[]');
  });

  test('pending input path edits preserve unrelated changes from another browser tab', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('rivet.run-recordings.input-path-history.v1', JSON.stringify(['$.base']));
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) {
        if (
          key === 'rivet.run-recordings.input-path-history.v1' &&
          localStorage.getItem('history-write-enabled') !== '1'
        ) {
          throw new Error('Storage denied');
        }
        original.call(this, key, value);
      };
    });
    const openFilter = async (target: Page) => {
      await installRunRecordingRoutes(target);
      await target.goto('/', { waitUntil: 'domcontentloaded' });
      await authenticateIfNeeded(target);
      await waitForDashboardReady(target);
      await target.getByRole('button', { name: 'Run recordings' }).click();
      const modal = target.getByTestId('run-recordings-modal');
      await modal.getByRole('button', { name: 'Filter by input' }).click();
      await modal.getByLabel('Value', { exact: true }).fill('bar');
      return modal;
    };
    const modal = await openFilter(page);
    const path = modal.getByRole('combobox', { name: 'Input JSON path' });
    await path.fill('$.foo');
    await modal.getByRole('button', { name: 'Apply', exact: true }).click();
    await expect(modal.locator('.run-recordings-input-search-status')).toContainText('Search complete');
    const other = await page.context().newPage();
    try {
      const otherModal = await openFilter(other);
      const otherPath = otherModal.getByRole('combobox', { name: 'Input JSON path' });
      await otherPath.fill('$.remote');
      await otherModal.getByRole('button', { name: 'Apply', exact: true }).click();
      await expect(otherModal.locator('.run-recordings-input-search-status')).toContainText('Search complete');
      await otherPath.click();
      await otherModal.getByRole('button', { name: 'Delete saved path $.base', exact: true }).click();
      await path.click();
      const history = modal.getByRole('dialog', { name: 'Saved input JSON paths' });
      await expect(history.locator('.run-recordings-input-path-select')).toHaveText(['$.foo', '$.remote']);
      await page.evaluate(() => localStorage.setItem('history-write-enabled', '1'));
      await modal.getByLabel('Value', { exact: true }).click();
      await path.click();
      await expect
        .poll(() => other.evaluate(() => localStorage.getItem('rivet.run-recordings.input-path-history.v1')))
        .toBe('["$.foo","$.remote"]');
    } finally {
      await other.close();
    }
  });

  test('long input path history can be focused and scrolled without dismissing the dropdown', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem(
        'rivet.run-recordings.input-path-history.v1',
        JSON.stringify(Array.from({ length: 40 }, (_, index) => `$.field_${index}`)),
      );
    });
    await installRunRecordingRoutes(page);
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await authenticateIfNeeded(page);
    await waitForDashboardReady(page);
    await page.getByRole('button', { name: 'Run recordings' }).click();
    const modal = page.getByTestId('run-recordings-modal');
    await modal.getByRole('button', { name: 'Filter by input' }).click();
    const path = modal.getByRole('combobox', { name: 'Input JSON path' });
    await path.click();
    const history = modal.getByRole('dialog', { name: 'Saved input JSON paths' });
    await history.click({ position: { x: 2, y: 2 } });
    await expect(history).toBeFocused();
    await history.hover();
    await page.mouse.wheel(0, 2000);
    const lastPath = history.getByRole('button', { name: '$.field_39', exact: true });
    await expect(lastPath).toBeInViewport();
    await lastPath.click();
    await expect(path).toHaveValue('$.field_39');
    await expect(history).toHaveCount(0);
  });

  test('a failed deletion stops an interrupted input search without losing its results', async ({ page }) => {
    const continuation = responseGate();
    await installRunRecordingRoutes(page, {
      latestFlowRunCount: 30,
      beforeRuns: async (url) => {
        if (url.searchParams.has('inputAfter')) await continuation.promise;
      },
      beforeDelete: async () => 500,
    });
    const modal = await openLatestFlowRecordings(page, 30);
    await choosePageSizeTen(modal, 3);
    await modal.getByRole('button', { name: 'Filter by input' }).click();
    await modal.getByLabel('Input JSON path').fill('$.foo');
    await modal.getByLabel('Value').fill('bar');
    await modal.getByRole('button', { name: 'Apply' }).click();
    try {
      await expect(modal.getByRole('button', { name: 'Stop search' })).toBeVisible();
      await expect(modal.locator('.run-recordings-run')).toHaveCount(2);
      await deleteFirstRun(page, modal);
      await expect(modal.locator('.run-recordings-error')).toContainText('Delayed deletion failed');
      await expect(modal.locator('.run-recordings-input-search-status')).toContainText(
        'Search stopped, 2 matches found',
      );
      await expect(modal.getByRole('button', { name: 'Stop search' })).toHaveCount(0);
      await expect(modal.locator('.run-recordings-run')).toHaveCount(2);
      await expect(modal.getByRole('button', { name: 'Apply' })).toBeEnabled();
    } finally {
      continuation.release();
    }
  });

  test('labels a called-project recording as a Subgraph run', async ({ page }) => {
    await installRunRecordingRoutes(page, { subgraphRun: true });
    const modal = await openLatestFlowRecordings(page);
    await selectPublishedFlow(page, modal);
    const run = modal.locator('.run-recordings-run').first();
    await expect(run).toContainText('Subgraph · Local editor');
    await expect(run.locator('.run-recordings-run-endpoint').filter({ hasText: 'Called graph:' })).toContainText(
      'Called graph: Extract facts',
    );
    await expect(run).toContainText('Related run key: rvt-related-example-12345');
  });

  test('caller recordings include linked cross-project children with counts, input filtering and deletion', async ({
    page,
  }) => {
    const { runFetches } = await installRunRecordingRoutes(page, { relatedSubgraphRuns: true });
    const modal = await openLatestFlowRecordings(page);
    await selectPublishedFlow(page, modal);
    await expect(modal.locator('.run-recordings-runs-title')).toHaveText('3 Runs');
    await expect(modal.getByRole('button', { name: 'Bad only (2)', exact: true })).toBeVisible();
    const child = modal.locator('.run-recordings-run').filter({ hasText: 'Called graph: Extract facts' });
    await expect(child).toHaveCount(1);
    await expect(child).toContainText('Project: Latest Flow.rivet-project');
    await expect(child).toContainText('Subgraph · Latest');
    await expect(child).toContainText('Related run key: rvt-root-caller-12345');
    expect(runFetches.some((url) => url.includes('workflow-a/runs') && url.includes('includeSubgraphRuns=true'))).toBe(
      true,
    );
    await modal.getByRole('button', { name: 'Bad only (2)', exact: true }).click();
    await expect(modal.locator('.run-recordings-run')).toHaveCount(2);
    await expect(child).toBeVisible();
    await modal.getByRole('button', { name: 'Filter by input', exact: true }).click();
    await modal.getByRole('combobox', { name: 'Input JSON path' }).fill('$.score');
    await modal.getByLabel('Value', { exact: true }).fill('99');
    await modal.getByRole('button', { name: 'Apply', exact: true }).click();
    await expect(modal.locator('.run-recordings-input-search-status')).toContainText('Search complete, 1 match found');
    await expect(modal.locator('.run-recordings-run')).toHaveCount(1);
    await expect(child).toBeVisible();
    await child.hover();
    await child.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(modal.locator('.run-recordings-runs-title')).toHaveText('2 Runs');
    await expect(modal.getByRole('button', { name: 'Bad only (1)', exact: true })).toBeVisible();
    await expect(child).toHaveCount(0);
    await modal.getByRole('button', { name: 'Clear', exact: true }).click();
    await expect(modal.locator('.run-recordings-run')).toHaveCount(1);
  });

  test('deleting a root refreshes filtered caller membership without deleting its child recording', async ({
    page,
  }) => {
    await installRunRecordingRoutes(page, { relatedSubgraphRuns: true });
    const modal = await openLatestFlowRecordings(page);
    await selectPublishedFlow(page, modal);
    await modal.getByRole('button', { name: 'Filter by input', exact: true }).click();
    await modal.getByRole('combobox', { name: 'Input JSON path' }).fill('$');
    await modal.locator('.run-recordings-input-filter-operator .run-recordings-select__control').click();
    await page
      .locator('.run-recordings-select__option')
      .filter({ hasText: /^exists$/ })
      .click();
    await modal.getByRole('button', { name: 'Apply', exact: true }).click();
    await expect(modal.locator('.run-recordings-input-search-status')).toContainText(
      'Search complete, 3 matches found',
    );
    const child = modal.locator('.run-recordings-run').filter({ hasText: 'Called graph: Extract facts' });
    await expect(child).toHaveCount(1);
    const root = modal
      .locator('.run-recordings-run')
      .filter({ hasText: 'Endpoint at execution: published-flow' })
      .filter({ hasText: 'Related run key: rvt-root-caller-12345' });
    await root.hover();
    await root.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(modal.locator('.run-recordings-input-search-status')).toContainText('Search complete, 1 match found');
    await expect(modal.locator('.run-recordings-runs-title')).toHaveText('1 Run');
    await expect(modal.locator('.run-recordings-run')).toHaveCount(1);
    await expect(child).toHaveCount(0);
    await modal.locator('.run-recordings-selector-section .run-recordings-select__control').click();
    await page.locator('.run-recordings-select__option').filter({ hasText: /^Any/ }).click();
    await expect(modal.locator('.run-recordings-input-search-status')).toContainText(
      'Search complete, 13 matches found',
    );
    await expect(child).toHaveCount(1);
  });

  test('a confirmed child deletion remains visible as successful when refreshing its scope fails', async ({ page }) => {
    await installRunRecordingRoutes(page, { relatedSubgraphRuns: true });
    const modal = await openLatestFlowRecordings(page);
    await selectPublishedFlow(page, modal);
    await modal.getByRole('button', { name: 'Filter by input', exact: true }).click();
    await modal.getByRole('combobox', { name: 'Input JSON path' }).fill('$.score');
    await modal.getByLabel('Value', { exact: true }).fill('99');
    await modal.getByRole('button', { name: 'Apply', exact: true }).click();
    await expect(modal.locator('.run-recordings-input-search-status')).toContainText('Search complete, 1 match found');
    await page.route('**/api/workflows/recordings/workflows/workflow-a/runs?*', (route) =>
      route.fulfill({ status: 503, json: { error: 'Scope refresh unavailable' } }),
    );
    await deleteFirstRun(page, modal);
    await expect(modal.locator('.run-recordings-run')).toHaveCount(0);
    await expect(modal).toContainText('Recording deleted, but refreshing the list failed: Scope refresh unavailable');
    await expect(modal.getByRole('button', { name: 'Apply', exact: true })).toBeEnabled();
  });

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
          // Explicit close starts a fresh session on Any. Select the workflow
          // whose replacement request this race fixture deliberately holds.
          await selectPublishedFlow(page, modal);
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

  test('deleting the final recording returns to Any', async ({ page }) => {
    await installRunRecordingRoutes(page, { latestFlowRunCount: 1 });
    const modal = await openLatestFlowRecordings(page, 1);
    await deleteFirstRun(page, modal);
    await expect(modal.locator('.run-recordings-workflow-summary')).toHaveCount(0);
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
        await expect(status).toContainText('Search complete, 2 matches found');
        const deleted = page.waitForResponse((response) => response.request().method() === 'DELETE');
        releaseDeletion();
        await deleted;
        // Flush the response's state updates, including a possible metadata fetch.
        await delay(200);
        await expect(status).toContainText('Search complete, 2 matches found');
        await expect(modal.locator('.run-recordings-run')).toHaveCount(2);
        await expect(modal.locator('.run-recordings-error')).toHaveCount(0);
      } finally {
        releaseDeletion();
      }
    });
  }

  test('progressive results preserve scrolling and replacement searches discard late batches', async ({ page }) => {
    const { runFetches } = await installRunRecordingRoutes(page, { latestFlowRunCount: 240, cursorDelayMs: 500 });
    const modal = await openLatestFlowRecordings(page, 240);
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
    await expect.poll(() => runFetches.filter((url) => url.includes('inputCursor=120')).length).toBeGreaterThan(0);
    const searchRequests = runFetches.map((url) => new URL(url)).filter((url) => url.searchParams.has('inputPath'));
    expect(searchRequests[0]!.searchParams.get('pageSize')).toBe('20');
    expect(searchRequests.slice(1).every((url) => url.searchParams.get('pageSize') === '100')).toBe(true);
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

  test('reports how many available runs an input search has analyzed', async ({ page }) => {
    await installRunRecordingRoutes(page, { latestFlowRunCount: 30, cursorDelayMs: 750 });
    const modal = await openLatestFlowRecordings(page, 30);
    await choosePageSizeTen(modal, 3);

    await modal.getByRole('button', { name: 'Filter by input' }).click();
    await modal.getByLabel('Input JSON path').fill('$.missing');
    await modal.locator('.run-recordings-input-filter-operator .run-recordings-select__control').click();
    await page.locator('.run-recordings-select__option').filter({ hasText: /^!=$/ }).click();
    await modal.getByLabel('Value').fill('bar');
    await modal.getByRole('button', { name: 'Apply' }).click();

    const progress = modal.getByRole('progressbar', { name: 'Input search progress' });
    await expect(progress).toHaveAttribute('aria-valuetext', 'Analyzed 10 of 30 available runs (33%)');
    await expect(progress).toHaveAttribute('aria-valuenow', '10');
    await expect(progress).toHaveAttribute('aria-valuemax', '30');

    await expect(modal.locator('.run-recordings-input-search-status')).toContainText('Search complete');
    await expect(progress).toHaveAttribute('aria-valuetext', 'Analyzed 30 of 30 available runs (100%)');
    await expect(progress).toHaveAttribute('aria-valuenow', '30');
  });

  test('keeps the last analyzed-run progress after stopping a search', async ({ page }) => {
    await installRunRecordingRoutes(page, { latestFlowRunCount: 30, cursorDelayMs: 500 });
    const modal = await openLatestFlowRecordings(page, 30);
    await choosePageSizeTen(modal, 3);

    await modal.getByRole('button', { name: 'Filter by input' }).click();
    await modal.getByLabel('Input JSON path').fill('$.missing');
    await modal.locator('.run-recordings-input-filter-operator .run-recordings-select__control').click();
    await page.locator('.run-recordings-select__option').filter({ hasText: /^!=$/ }).click();
    await modal.getByLabel('Value').fill('bar');
    await modal.getByRole('button', { name: 'Apply' }).click();

    const progress = modal.getByRole('progressbar', { name: 'Input search progress' });
    await expect(progress).toHaveAttribute('aria-valuetext', 'Analyzed 10 of 30 available runs (33%)');
    await modal.getByRole('button', { name: 'Stop search' }).click();

    await expect(modal.locator('.run-recordings-input-search-status')).toContainText('Search stopped');
    await expect(progress).toHaveAttribute('aria-valuetext', 'Analyzed 10 of 30 available runs (33%)');
    await delay(700);
    await expect(progress).toHaveAttribute('aria-valuetext', 'Analyzed 10 of 30 available runs (33%)');
  });

  test('filters and paginates runs with the operator menu outside modal clipping', async ({ page }) => {
    const { runFetches } = await installRunRecordingRoutes(page);
    const modal = await openLatestFlowRecordings(page);
    const runFilter = modal.getByRole('group', { name: 'Filter runs' });
    await expect(runFilter).toHaveClass(/segmented-control/);
    await expect(runFilter.getByRole('button').first()).toHaveCSS('height', '28px');
    await expect(runFilter.getByRole('button').first()).toHaveAttribute('aria-pressed', 'true');
    await expect(
      modal
        .locator('.run-recordings-run')
        .first()
        .locator('.run-recordings-run-endpoint')
        .filter({ hasText: 'Endpoint at execution:' }),
    ).toHaveText('Endpoint at execution: latest-flow');

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
    await expect(
      modal.locator('.run-recordings-run-endpoint').filter({ hasText: 'Endpoint at execution:' }),
    ).toHaveText(['Endpoint at execution: latest-flow', 'Endpoint at execution: latest-flow']);
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

  test('keeps the recordings dialog open with progress while a replay loads', async ({ page }) => {
    const recordingGate = responseGate();
    const { recordingFetches, replayProjectFetches } = await installRunRecordingRoutes(page, {
      recordingGate: recordingGate.promise,
    });
    const modal = await openLatestFlowRecordings(page);
    const run = modal.locator('.run-recordings-run').first();
    const otherRun = modal.locator('.run-recordings-run').nth(1);

    await run.locator('.run-recordings-run-open-button').click();
    await expect.poll(() => recordingFetches).toEqual(['recording-b-1']);
    await expect(modal).toBeVisible();
    await expect(modal.locator('.run-recordings-shell')).toHaveAttribute('aria-busy', 'true');
    await expect(run.locator('.run-recordings-run-open-button')).toBeDisabled();
    await expect(run.locator('.run-recordings-run-delete-button')).toBeDisabled();
    await expect(run.getByRole('status')).toHaveText('Opening…');
    await expect(otherRun.getByText('Opening…', { exact: true })).toHaveCount(0);
    await expect(otherRun.locator('.run-recordings-run-open-button')).toBeDisabled();
    await expect(otherRun.locator('.run-recordings-run-delete-button')).toBeDisabled();

    recordingGate.release();
    await expect.poll(() => replayProjectFetches).toEqual(['recording-b-1']);
    await expect(modal).toBeHidden();
    await expect(
      page.frameLocator('iframe.dashboard-editor-frame').getByRole('button', { name: 'Play Recording', exact: true }),
    ).toBeVisible();
  });

  test('keeps the recordings dialog open and restores its controls when opening fails', async ({ page }) => {
    const { recordingFetches } = await installRunRecordingRoutes(page, {
      recordingError: 'The recording is no longer available.',
    });
    const modal = await openLatestFlowRecordings(page);
    const run = modal.locator('.run-recordings-run').first();

    await run.locator('.run-recordings-run-open-button').click();
    await expect.poll(() => recordingFetches).toEqual(['recording-b-1']);
    await expect(modal).toBeVisible();
    await expect(modal.locator('.run-recordings-error')).toContainText('The recording is no longer available.');
    await expect(modal.locator('.run-recordings-shell')).toHaveAttribute('aria-busy', 'false');
    await expect(run.locator('.run-recordings-run-open-button')).toBeEnabled();
    await expect(run.locator('.run-recordings-run-delete-button')).toBeEnabled();
  });

  test('shows recorded LLM response duration instead of accelerated replay time', async ({ page }) => {
    const { recordingFetches, replayProjectFetches } = await installRunRecordingRoutes(page, {
      includeResponseInspectorRun: true,
    });
    const modal = await openLatestFlowRecordings(page, 13);

    const inspectorRun = modal.locator('.run-recordings-run').filter({
      has: page.locator('.run-recordings-run-duration', { hasText: '1m 35.00s' }),
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
      const exportState = {
        cancelNextSave: false,
        fallbackDownloads: 0,
        savedFiles: [] as Array<{ suggestedName: string; content: string }>,
      };
      Object.defineProperty(window, 'showSaveFilePicker', {
        configurable: true,
        value: async ({ suggestedName }: { suggestedName: string }) => {
          if (exportState.cancelNextSave) {
            exportState.cancelNextSave = false;
            throw new DOMException('The user aborted a request.', 'AbortError');
          }

          return {
            createWritable: async () => ({
              write: async (content: string) => {
                exportState.savedFiles.push({ suggestedName, content });
              },
              close: async () => {},
            }),
          };
        },
      });
      const originalAnchorClick = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function click() {
        if (this.download.endsWith('.rivet-recording')) {
          exportState.fallbackDownloads += 1;
          return;
        }
        originalAnchorClick.call(this);
      };
      (window as typeof window & { __rivetRecordingExportState?: typeof exportState }).__rivetRecordingExportState =
        exportState;
    });
    await installRunRecordingRoutes(page, { includeResponseInspectorRun: true });
    const modal = await openLatestFlowRecordings(page, 13);
    const inspectorRun = modal.locator('.run-recordings-run').filter({
      has: page.locator('.run-recordings-run-duration', { hasText: '1m 35.00s' }),
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
    const recordingExportState = () =>
      editorElement.evaluate((frame) => {
        const editorWindow = (frame as HTMLIFrameElement).contentWindow as
          | (Window & {
              __rivetRecordingExportState?: {
                cancelNextSave: boolean;
                fallbackDownloads: number;
                savedFiles: Array<{ content: string }>;
              };
            })
          | null;
        return editorWindow?.__rivetRecordingExportState;
      });

    await expect(editorFrame.getByRole('button', { name: 'Save Recording', exact: true })).toHaveCount(0);
    await editorFrame.locator('button.more-menu').click();
    await editorFrame.getByRole('button', { name: 'Export recording', exact: true }).click();
    await expect.poll(async () => (await recordingExportState())?.savedFiles.length).toBe(1);
    const savedBeforePlayback = (await recordingExportState())?.savedFiles[0]?.content;
    const firstRecording = JSON.parse(savedBeforePlayback!) as {
      recording: { startTs: number; finishTs: number; events: Array<{ type: string; data: { durationMs?: number } }> };
    };
    expect(firstRecording.recording.finishTs - firstRecording.recording.startTs).toBe(95_000);
    expect(firstRecording.recording.events.find((event) => event.type === 'nodeFinish')?.data.durationMs).toBe(95_000);

    await editorFrame.getByRole('button', { name: 'Play Recording', exact: true }).click();
    await expect(editorFrame.locator('.response-inspector-button')).toBeVisible();
    await expect(editorFrame.getByRole('button', { name: 'Save Recording', exact: true })).toHaveCount(0);
    await editorFrame.locator('button.more-menu').click();
    await editorFrame.getByRole('button', { name: 'Export recording', exact: true }).click();
    await expect.poll(async () => (await recordingExportState())?.savedFiles.length).toBe(2);
    expect((await recordingExportState())?.savedFiles[1]?.content).toBe(savedBeforePlayback);

    await editorElement.evaluate((frame) => {
      const editorWindow = (frame as HTMLIFrameElement).contentWindow as
        | (Window & { __rivetRecordingExportState?: { cancelNextSave: boolean } })
        | null;
      if (editorWindow?.__rivetRecordingExportState) {
        editorWindow.__rivetRecordingExportState.cancelNextSave = true;
      }
    });
    await editorFrame.locator('button.more-menu').click();
    await editorFrame.getByRole('button', { name: 'Export recording', exact: true }).click();
    await expect
      .poll(async () => await recordingExportState())
      .toMatchObject({
        fallbackDownloads: 0,
        savedFiles: [{ content: savedBeforePlayback }, { content: savedBeforePlayback }],
      });
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
