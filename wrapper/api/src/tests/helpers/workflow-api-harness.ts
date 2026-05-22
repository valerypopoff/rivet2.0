import http from 'node:http';
import type { TestContext } from 'node:test';
import express from 'express';
import type { NextFunction, Request, Response as ExpressResponse, Router } from 'express';

import { listenTestServer } from './http-server-harness.js';

type InitializeWorkflowStorage = () => Promise<void>;

type WorkflowApiServerHarnessOptions = {
  initializeWorkflowStorage: InitializeWorkflowStorage;
  workflowsRouter: Router;
};

type WorkflowExecutionServerHarnessOptions = WorkflowApiServerHarnessOptions & {
  publishedWorkflowsRouter: Router;
  latestWorkflowsRouter: Router;
};

type WorkflowExecutionServerUrls = {
  apiBaseUrl: string;
  publishedBaseUrl: string;
  latestBaseUrl: string;
};

type FilesystemExecutionCacheProbe = {
  markIndexDirty(): void;
  invalidateProjectMaterializations(projectPaths: Iterable<string>): void;
};

type WorkflowRecordingRunsPage = {
  totalRuns: number;
};

type ListWorkflowRecordingRunsPage<TPage extends WorkflowRecordingRunsPage> = (
  root: string,
  workflowId: string,
  page: number,
  pageSize: number,
  status: 'all',
) => Promise<TPage>;

function attachJsonFallbackHandlers(app: express.Express) {
  app.use((_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });
  app.use((err: Error, _req: Request, res: ExpressResponse, _next: NextFunction) => {
    res.status((err as { status?: number }).status ?? 500).json({ error: err.message });
  });
}

export function observeFilesystemExecutionInvalidations(t: TestContext, cache: FilesystemExecutionCacheProbe) {
  const calls = {
    markedIndexDirty: false,
    invalidatedMaterializationPathCalls: [] as string[][],
  };
  const originalMarkIndexDirty = cache.markIndexDirty.bind(cache);
  const originalInvalidateMaterializations = cache.invalidateProjectMaterializations.bind(cache);

  t.mock.method(cache, 'markIndexDirty', () => {
    calls.markedIndexDirty = true;
    originalMarkIndexDirty();
  });
  t.mock.method(cache, 'invalidateProjectMaterializations', (projectPaths: Iterable<string>) => {
    const projectPathList = [...projectPaths];
    calls.invalidatedMaterializationPathCalls.push(projectPathList);
    originalInvalidateMaterializations(projectPathList);
  });

  return calls;
}

export async function withEnvOverride(
  name: string,
  value: string | undefined,
  run: () => Promise<void>,
) {
  const previousValue = process.env[name];

  if (value == null) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }

  try {
    await run();
  } finally {
    if (previousValue == null) {
      delete process.env[name];
    } else {
      process.env[name] = previousValue;
    }
  }
}

export function createWorkflowApiServerHarness(options: WorkflowApiServerHarnessOptions) {
  return async function withWorkflowApiServer(run: (baseUrl: string) => Promise<void>) {
    await options.initializeWorkflowStorage();

    const app = express();
    app.use(express.json({ strict: false }));
    app.use('/workflows', options.workflowsRouter);
    attachJsonFallbackHandlers(app);

    const server = http.createServer(app);
    const listener = await listenTestServer(server);

    try {
      await run(`${listener.baseUrl}/workflows`);
    } finally {
      await listener.close();
    }
  };
}

export function createWorkflowExecutionServerHarness(options: WorkflowExecutionServerHarnessOptions) {
  return async function withWorkflowExecutionServer(run: (urls: WorkflowExecutionServerUrls) => Promise<void>) {
    await options.initializeWorkflowStorage();

    const app = express();
    app.use(express.json({ strict: false }));
    app.use('/api/workflows', options.workflowsRouter);
    app.use('/workflows', options.publishedWorkflowsRouter);
    app.use('/workflows-latest', options.latestWorkflowsRouter);
    attachJsonFallbackHandlers(app);

    const server = http.createServer(app);
    const listener = await listenTestServer(server);

    try {
      await run({
        apiBaseUrl: `${listener.baseUrl}/api/workflows`,
        publishedBaseUrl: `${listener.baseUrl}/workflows`,
        latestBaseUrl: `${listener.baseUrl}/workflows-latest`,
      });
    } finally {
      await listener.close();
    }
  };
}

export async function readJson<T>(response: globalThis.Response): Promise<T> {
  const body = await response.json() as T;
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${JSON.stringify(body)}`);
  }

  return body;
}

export async function waitForRecordingWorkflows(
  apiBaseUrl: string,
  predicate: (workflows: Array<{ workflowId: string; totalRuns: number }>) => boolean,
  timeoutMs = 5000,
) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const response = await readJson<{
      workflows: Array<{ workflowId: string; totalRuns: number }>;
    }>(await fetch(`${apiBaseUrl}/recordings/workflows`));

    if (predicate(response.workflows)) {
      return response;
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error('Timed out waiting for workflow recordings');
}

export async function waitForWorkflowRecordingRunCount<TPage extends WorkflowRecordingRunsPage>(
  listRunsPage: ListWorkflowRecordingRunsPage<TPage>,
  root: string,
  workflowId: string,
  expectedTotalRuns: number,
  timeoutMs = 5000,
): Promise<TPage> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const response = await listRunsPage(root, workflowId, 1, 100, 'all');
    if (response.totalRuns === expectedTotalRuns) {
      return response;
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error(`Timed out waiting for workflow ${workflowId} to reach ${expectedTotalRuns} recording runs`);
}
