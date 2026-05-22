import fs from 'node:fs/promises';
import {
  createWorkflowApiServerHarness,
  createWorkflowExecutionServerHarness,
} from './workflow-api-harness.js';
import { createWorkflowTestRoots, resetWorkflowTestRoots } from './workflow-fixtures.js';

export async function createFilesystemWorkflowSuiteHarness() {
  const roots = await createWorkflowTestRoots('rivet-workflows-');
  process.env.RIVET_WORKFLOWS_ROOT = roots.workflowsRoot;
  process.env.RIVET_WORKFLOW_RECORDINGS_ROOT = roots.recordingsRoot;
  process.env.RIVET_APP_DATA_ROOT = roots.appDataRoot;

  const workflowMutations = await import('../../routes/workflows/workflow-mutations.js');
  const workflowQuery = await import('../../routes/workflows/workflow-query.js');
  const workflowFs = await import('../../routes/workflows/fs-helpers.js');
  const workflowDownload = await import('../../routes/workflows/workflow-download.js');
  const workflowPublication = await import('../../routes/workflows/publication.js');
  const workflowRecordings = await import('../../routes/workflows/recordings.js');
  const workflowExecution = await import('../../routes/workflows/execution.js');
  const workflowRoutes = await import('../../routes/workflows/index.js');
  const workflowStorageBackend = await import('../../routes/workflows/storage-backend.js');
  const filesystemExecutionCache = await import('../../routes/workflows/filesystem-execution-cache.js');
  const rivetNode = await import('@valerypopoff/rivet2-node');

  const withWorkflowApiServer = createWorkflowApiServerHarness({
    initializeWorkflowStorage: workflowStorageBackend.initializeWorkflowStorage,
    workflowsRouter: workflowRoutes.workflowsRouter,
  });

  const withWorkflowExecutionServer = createWorkflowExecutionServerHarness({
    initializeWorkflowStorage: workflowStorageBackend.initializeWorkflowStorage,
    workflowsRouter: workflowRoutes.workflowsRouter,
    publishedWorkflowsRouter: workflowRoutes.publishedWorkflowsRouter,
    latestWorkflowsRouter: workflowRoutes.latestWorkflowsRouter,
  });

  async function resetWorkflowsRoot() {
    filesystemExecutionCache.resetFilesystemExecutionCacheForTests();
    await workflowRecordings.resetWorkflowRecordingStorageForTests();
    await resetWorkflowTestRoots({
      workflowsRoot: roots.workflowsRoot,
      recordingsRoot: roots.recordingsRoot,
      appDataRoot: roots.appDataRoot,
    });
  }

  async function resetAndEnsureWorkflowsRoot() {
    await resetWorkflowsRoot();
    await workflowFs.ensureWorkflowsRoot();
  }

  async function cleanupWorkflowSuite() {
    await workflowRecordings.resetWorkflowRecordingStorageForTests();
    await fs.rm(roots.tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }

  return {
    ...roots,
    workflowMutations,
    workflowQuery,
    workflowFs,
    workflowDownload,
    workflowPublication,
    workflowRecordings,
    workflowExecution,
    workflowStorageBackend,
    filesystemExecutionCache,
    rivetNode,
    withWorkflowApiServer,
    withWorkflowExecutionServer,
    resetWorkflowsRoot,
    resetAndEnsureWorkflowsRoot,
    cleanupWorkflowSuite,
  };
}
