import { createHash } from 'node:crypto';
import { NodeDatasetProvider, deserializeDatasets, loadProjectAndAttachedDataFromString, type SubgraphProjectRun, type SubgraphProjectTarget } from '@valerypopoff/rivet2-node';

import { startAppExecutor } from '../../app-executor/bin/executorHost.mjs';
import { createHttpRivetLLMProfileHealthStore } from '../../studio-server-shared/llmProfileHealthHttpStore.js';
import { createHostedClientAuthorizer } from './clientAuthorization.mjs';

function createProxyAuthenticationHeaders(): HeadersInit {
  const sharedKey = process.env.RIVET_KEY?.trim();
  if (!sharedKey) return {};
  return {
    'x-rivet-proxy-auth': createHash('sha256').update(`${sharedKey}:proxy-auth`).digest('hex'),
    'x-rivet-executor-auth': createHash('sha256').update(`${sharedKey}:executor-internal`).digest('hex'),
  };
}

const healthServiceUrl =
  process.env.RIVET_LLM_PROFILE_HEALTH_API_URL?.trim() || 'http://127.0.0.1:3100/api/workflows/llm-profile-health';
const healthStore = createHttpRivetLLMProfileHealthStore({
  baseUrl: healthServiceUrl,
  headers: createProxyAuthenticationHeaders,
});

const executionEnvironmentServiceUrl =
  process.env.RIVET_EXECUTION_ENVIRONMENT_API_URL?.trim() || 'http://api:80/api/workflows/execution-environment';

async function readExecutionEnvironment(): Promise<Readonly<Record<string, string>>> {
  const response = await fetch(executionEnvironmentServiceUrl, {
    headers: createProxyAuthenticationHeaders(),
    cache: 'no-store',
  });
  if (!response.ok) {
    throw new Error(`Execution environment service failed (${response.status} ${response.statusText})`);
  }

  const body = (await response.json()) as { environment?: unknown };
  if (!body.environment || typeof body.environment !== 'object' || Array.isArray(body.environment)) {
    throw new Error('Execution environment service returned an invalid response');
  }

  return Object.freeze(
    Object.fromEntries(
      Object.entries(body.environment).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
    ),
  );
}

async function loadSubgraphTarget(target: SubgraphProjectTarget) {
  const url = new URL(
    `/api/workflows/subgraph-projects/${encodeURIComponent(target.projectId)}/execution`,
    executionEnvironmentServiceUrl,
  );
  url.searchParams.set('version', target.version);
  const response = await fetch(url, {
    headers: createProxyAuthenticationHeaders(),
    cache: 'no-store',
  });
  if (!response.ok) {
    throw new Error(`Subgraph project ${target.projectId} (${target.version}) could not be loaded (${response.status}).`);
  }
  const body = await response.json() as {
    projectContents: string;
    datasetsContents?: string;
    revisionKey?: string;
    sourceProjectPath?: string;
  };
  if (typeof body.projectContents !== 'string') {
    throw new Error('Subgraph project service returned no saved artifact.');
  }
  const [project] = loadProjectAndAttachedDataFromString(body.projectContents);
  if (project.metadata.id !== target.projectId) {
    throw new Error('Subgraph project service returned an invalid target.');
  }
  return {
    project,
    datasetProvider: new NodeDatasetProvider(body.datasetsContents ? deserializeDatasets(body.datasetsContents) : []),
    revisionKey: body.revisionKey,
    projectContents: body.projectContents,
    datasetsContents: body.datasetsContents,
    sourceProjectPath: body.sourceProjectPath,
  };
}

async function persistSubgraphRun(run: SubgraphProjectRun): Promise<void> {
  if (!run.resolved.projectContents) throw new Error('Subgraph replay has no saved project snapshot.');
  const response = await fetch(new URL('/api/workflows/local-editor-recordings/subgraph-run', executionEnvironmentServiceUrl), {
    method: 'POST',
    signal: AbortSignal.timeout(60_000),
    headers: { ...createProxyAuthenticationHeaders(), 'content-type': 'application/json' },
    body: JSON.stringify({
      projectId: run.target.projectId,
      projectContents: run.resolved.projectContents,
      datasetsContents: run.resolved.datasetsContents,
      recordingSerialized: run.recorder.serialize(),
      graphId: run.graphId,
      revisionKey: run.resolved.revisionKey,
      correlationId: run.correlationId,
      status: run.status,
      durationMs: run.durationMs,
      errorMessage: run.errorMessage,
    }),
  });
  if (!response.ok) throw new Error(`Could not persist Subgraph replay (${response.status}).`);
}

void startAppExecutor({
  authorizeClient: createHostedClientAuthorizer({
    url: new URL('/ui-auth/check', executionEnvironmentServiceUrl),
    getProxyToken: () => (createProxyAuthenticationHeaders() as Record<string, string>)['x-rivet-proxy-auth'] ?? '',
  }),
  createProcessorOptions: async ({ llmProfileHealthExecutionCorrelationId, recordSubgraphProjectRuns }) => ({
    executionEnvironment: await readExecutionEnvironment(),
    llmProfileHealthStore: healthStore,
    subgraphProjectLoader: { loadTarget: loadSubgraphTarget },
    onSubgraphProjectRun: recordSubgraphProjectRuns ? persistSubgraphRun : undefined,
    ...(llmProfileHealthExecutionCorrelationId == null ? {} : { llmProfileHealthExecutionCorrelationId }),
  }),
}).catch((error) => {
  console.error('[rivet-executor] Failed to start:', error);
  process.exitCode = 1;
});
