import fs from 'node:fs/promises';
import {
  createHostedProjectApiServerHarness,
  createWorkflowApiServerHarness,
  createWorkflowExecutionServerHarness,
} from './workflow-api-harness.js';
import { createWorkflowTestRoots, resetWorkflowTestRoots } from './workflow-fixtures.js';

export async function createFilesystemWorkflowSuiteHarness() {
  const roots = await createWorkflowTestRoots('rivet-workflows-');
  function applyRootEnv() {
    process.env.RIVET_WORKFLOWS_ROOT = roots.workflowsRoot;
    process.env.RIVET_WORKFLOW_RECORDINGS_ROOT = roots.recordingsRoot;
    process.env.RIVET_APP_DATA_ROOT = roots.appDataRoot;
  }

  applyRootEnv();

  const workflowMutations = await import('../../routes/workflows/workflow-mutations.js');
  const workflowQuery = await import('../../routes/workflows/workflow-query.js');
  const workflowFs = await import('../../routes/workflows/fs-helpers.js');
  const workflowDownload = await import('../../routes/workflows/workflow-download.js');
  const workflowPublication = await import('../../routes/workflows/publication.js');
  const workflowRecordings = await import('../../routes/workflows/recordings.js');
  const workflowExecution = await import('../../routes/workflows/execution.js');
  const workflowRoutes = await import('../../routes/workflows/index.js');
  const projectRoutes = await import('../../routes/projects.js');
  const workflowStorageBackend = await import('../../routes/workflows/storage-backend.js');
  const filesystemExecutionCache = await import('../../routes/workflows/filesystem-execution-cache.js');
  const workflowEndpointAuthSettings = await import('../../workflow-endpoint-auth-settings.js');
  const webAppActionWebSockets = await import('../../web-app-action-websocket.js');
  const rivetNode = await import('@valerypopoff/rivet2-node');

  const withWorkflowApiServer = createWorkflowApiServerHarness({
    initializeWorkflowStorage: workflowStorageBackend.initializeWorkflowStorage,
    workflowsRouter: workflowRoutes.workflowsRouter,
  });
  const withHostedProjectApiServer = createHostedProjectApiServerHarness({
    initializeWorkflowStorage: workflowStorageBackend.initializeWorkflowStorage,
    projectsRouter: projectRoutes.projectsRouter,
    workflowsRouter: workflowRoutes.workflowsRouter,
  });

  const withWorkflowExecutionServer = createWorkflowExecutionServerHarness({
    initializeWebAppActionWebSockets: webAppActionWebSockets.initializeWebAppActionWebSockets,
    initializeWorkflowStorage: workflowStorageBackend.initializeWorkflowStorage,
    workflowsRouter: workflowRoutes.workflowsRouter,
    latestWebAppsRouter: workflowRoutes.latestWebAppsRouter,
    publishedWebAppsRouter: workflowRoutes.publishedWebAppsRouter,
    publishedWorkflowsRouter: workflowRoutes.publishedWorkflowsRouter,
    latestWorkflowsRouter: workflowRoutes.latestWorkflowsRouter,
  });

  async function resetWorkflowsRoot() {
    applyRootEnv();
    filesystemExecutionCache.resetFilesystemExecutionCacheForTests();
    await workflowRecordings.resetWorkflowRecordingStorageForTests();
    await workflowStorageBackend.disposeWorkflowStorage();
    await resetWorkflowTestRoots({
      workflowsRoot: roots.workflowsRoot,
      recordingsRoot: roots.recordingsRoot,
      appDataRoot: roots.appDataRoot,
    });
    await workflowEndpointAuthSettings.writeWorkflowEndpointAuthSettings({
      requireBearerAuth: false,
    });
  }

  async function resetAndEnsureWorkflowsRoot() {
    await resetWorkflowsRoot();
    await workflowFs.ensureWorkflowsRoot();
  }

  async function cleanupWorkflowSuite() {
    await workflowRecordings.resetWorkflowRecordingStorageForTests();
    await workflowStorageBackend.disposeWorkflowStorage();
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
    withHostedProjectApiServer,
    withWorkflowExecutionServer,
    resetWorkflowsRoot,
    resetAndEnsureWorkflowsRoot,
    cleanupWorkflowSuite,
  };
}
