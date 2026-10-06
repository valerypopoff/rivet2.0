// test-style: fixture-read: checks only this test's catalog, scratch and virtual workflow root.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { LocalWorkflowCatalog } from '../local-metadata/workflow-catalog.js';
import { installLocalMetadataServingSelection } from '../local-metadata/serving-selection.js';
import { createHostedProjectApiServerHarness } from './helpers/workflow-api-harness.js';
import { verifyProjectBundleDownload } from './helpers/project-bundle-download-contract.js';

test('selected local SQLite downloads both root versions with isolated child versions and datasets', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-bundle-sqlite-'));
  const env = {
    RIVET_APP_DATA_ROOT: path.join(root, 'app'),
    RIVET_WORKFLOWS_ROOT: path.join(root, 'virtual-workflows'),
    RIVET_WORKFLOW_RECORDINGS_ROOT: path.join(root, 'recordings'),
    RIVET_RUNTIME_LIBRARIES_ROOT: path.join(root, 'libraries'),
    RIVET_PROJECT_BUNDLE_SCRATCH_ROOT: path.join(root, 'exports'),
    RIVET_LOCAL_METADATA_CONTROL_ROOT: '',
    RIVET_KEY: 'bundle-sqlite-fixture-key',
  };
  const original = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  const catalogDatabasePath = path.join(root, 'metadata', 'catalog.sqlite');
  const artifactRoot = path.join(root, 'objects');
  const catalog = new LocalWorkflowCatalog({ databasePath: catalogDatabasePath, artifactRoot });
  let storage: typeof import('../routes/workflows/storage-backend.js') | undefined;
  let jobs: typeof import('../routes/workflows/project-bundle-jobs.js') | undefined;
  try {
    catalog.initialize();
    catalog.close();
    const { FilesystemRivetLLMProfileHealthStore } = await import('../llm-profile-health/filesystem-store.js');
    const health = new FilesystemRivetLLMProfileHealthStore(
      path.join(root, 'operational', 'llm-profile-health.sqlite'),
    );
    try {
      await health.list();
    } finally {
      await health.dispose();
    }
    installLocalMetadataServingSelection({
      generationId: 'bundle-fixture',
      catalogDatabasePath,
      artifactRoot,
      settingsDatabasePath: path.join(root, 'metadata', 'settings.sqlite'),
      operationalRoot: path.join(root, 'operational'),
      runtimeCacheRoot: path.join(root, 'cache'),
      source: {
        workflows: env.RIVET_WORKFLOWS_ROOT,
        recordings: env.RIVET_WORKFLOW_RECORDINGS_ROOT,
        appData: env.RIVET_APP_DATA_ROOT,
        runtimeLibraries: env.RIVET_RUNTIME_LIBRARIES_ROOT,
      },
    });
    storage = await import('../routes/workflows/storage-backend.js');
    jobs = await import('../routes/workflows/project-bundle-jobs.js');
    const { workflowsRouter } = await import('../routes/workflows/index.js');
    const { projectsRouter } = await import('../routes/projects.js');
    const { getExpectedProxyAuthToken } = await import('../auth.js');
    await createHostedProjectApiServerHarness({
      initializeWorkflowStorage: storage.initializeWorkflowStorage,
      workflowsRouter,
      projectsRouter,
    })(async (urls) => {
      await verifyProjectBundleDownload({ ...urls, headers: { 'x-rivet-proxy-auth': getExpectedProxyAuthToken() } });
    });
    await assert.rejects(fs.stat(env.RIVET_WORKFLOWS_ROOT), { code: 'ENOENT' });
  } finally {
    try {
      await jobs?.projectBundleJobs.dispose();
      await storage?.disposeWorkflowStorage();
    } finally {
      catalog.close();
      for (const [key, value] of Object.entries(original)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await fs.rm(root, { recursive: true, force: true });
    }
  }
});
