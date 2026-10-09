import { expect, test } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { LocalWorkflowCatalog } from '../../studio-server-api/src/local-metadata/workflow-catalog';
import { SqliteWorkflowBackend } from '../../studio-server-api/src/local-metadata/sqlite-workflow-backend';
import { ImmutableLocalArtifactStore } from '../../studio-server-api/src/local-metadata/immutable-artifact-store';
import { startAsyncWorkflowProcess } from '../../studio-server-api/src/tests/helpers/workflow-async-process';
import { authenticateIfNeeded, waitForDashboardReady } from './helpers/hostedEditorObserve';

let api: Awaited<ReturnType<typeof startAsyncWorkflowProcess>>;
test.beforeAll(async () => {
  api = await startAsyncWorkflowProcess();
});
test.afterAll(async () => {
  await api?.close();
});

test('SQLite tree and a large recordings selector render without unrelated artifact reads', async ({ page }) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-browser-tree-'));
  const options = {
    databasePath: path.join(root, 'catalog.sqlite'),
    artifactRoot: path.join(root, 'objects'),
    virtualRoot: path.join(root, 'workflows'),
    withWrite: async <T>(operation: () => Promise<T>) => operation(),
  };
  const catalog = new LocalWorkflowCatalog(options);
  const backend = new SqliteWorkflowBackend(options);
  const originalRead = ImmutableLocalArtifactStore.prototype.read;
  let treeReads = 0;
  let readingTree = false;
  let treeRequests = 0;
  let readingRecordings = false;
  let recordingReads = 0;
  try {
    catalog.initialize();
    catalog.close();
    backend.initialize();
    await backend.createWorkflowProjectItem('', 'Indexed project');
    const legacy = await backend.createWorkflowProjectItem('', 'Existing project');
    catalog.initialize();
    const saved = (await catalog.readProject(legacy.relativePath))!;
    await catalog.importRecording({
      recordingId: 'browser-recording',
      workflowId: saved.workflowId,
      sourceProjectRelativePath: saved.relativePath,
      sourceProjectName: saved.name,
      createdAt: '2026-01-01T00:00:00.000Z',
      runKind: 'editor',
      status: 'succeeded',
      durationMs: 1,
      endpointName: '',
      errorMessage: null,
      recordingContents: '{}',
      replayProjectContents: saved.contents,
      replayDatasetContents: null,
    });
    catalog.close();
    const db = new DatabaseSync(options.databasePath);
    try {
      const row = db.prepare("SELECT metadata_json FROM recordings WHERE recording_id = 'browser-recording'").get() as {
        metadata_json: string;
      };
      const metadata = JSON.parse(row.metadata_json);
      const insert = db.prepare('INSERT INTO recordings(recording_id, workflow_id, metadata_json) VALUES (?, ?, ?)');
      db.exec('BEGIN');
      for (let i = 1; i < 10000; i++) {
        const recordingId = `browser-run-${i}`;
        insert.run(recordingId, saved.workflowId, JSON.stringify({ ...metadata, recordingId }));
      }
      db.exec('COMMIT');
      db.prepare(
        "UPDATE projects SET metadata_json = json_remove(metadata_json, '$.treeIndex') WHERE workflow_id = ?",
      ).run(legacy.projectMetadataId!);
    } finally {
      db.close();
    }
    ImmutableLocalArtifactStore.prototype.read = async function (...args) {
      if (readingTree) treeReads++;
      if (readingRecordings) recordingReads++;
      return originalRead.apply(this, args);
    };
    const token = createHash('sha256').update('async-fixture-key:proxy-auth').digest('hex');
    await page.route('**/api/**', async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === '/api/workflows/tree') {
        readingTree = true;
        let tree;
        try {
          tree = await backend.getTree();
        } finally {
          readingTree = false;
        }
        treeRequests++;
        await route.fulfill({ json: { ...tree, sync: { epoch: 'sqlite-browser-fixture', revision: 0 } } });
        return;
      }
      if (url.pathname === '/api/workflows/recordings/workflows' || url.pathname.endsWith('/runs')) {
        readingRecordings = true;
        try {
          const result = url.pathname.endsWith('/runs')
            ? await backend.listWorkflowRecordingRunsPage(
                url.pathname === '/api/workflows/recordings/runs'
                  ? ''
                  : decodeURIComponent(url.pathname.split('/').at(-2)!),
                Number(url.searchParams.get('page') ?? 1),
                Number(url.searchParams.get('pageSize') ?? 20),
              )
            : await backend.listWorkflowRecordingWorkflows();
          await route.fulfill({ json: result });
        } finally {
          readingRecordings = false;
        }
        return;
      }
      const response = await route.fetch({
        url: `${api.baseUrl}${url.pathname}${url.search}`,
        headers: { ...route.request().headers(), 'x-rivet-proxy-auth': token },
      });
      await route.fulfill({ response });
    });
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt === 0) await page.goto('/', { waitUntil: 'domcontentloaded' });
      else await page.reload({ waitUntil: 'domcontentloaded' });
      await authenticateIfNeeded(page);
      await waitForDashboardReady(page);
      await expect(
        page.locator('.workflow-library-panel').getByText('Loading folders...', { exact: true }),
      ).toBeHidden();
      await expect(page.locator('.project-row', { hasText: 'Indexed project' })).toBeVisible();
      await expect(page.locator('.project-row', { hasText: 'Existing project' })).toBeVisible();
      expect(treeReads).toBe(1);
    }
    expect(treeRequests).toBeGreaterThanOrEqual(2);
    await page.getByRole('button', { name: 'Run recordings', exact: true }).click();
    const modal = page.getByRole('dialog', { name: 'Run recordings', exact: true });
    await expect(modal).toBeVisible();
    await modal.locator('.run-recordings-select__control').click();
    await expect(modal.locator('.run-recordings-select__option', { hasText: 'Existing project' })).toBeVisible();
    await expect(modal.getByText('10,000 recordings in this project', { exact: true })).toBeVisible();
    await modal.locator('.run-recordings-select__option', { hasText: 'Existing project' }).click();
    await expect(modal.getByText('Page 1 of 500', { exact: true })).toBeVisible();
    await modal.getByRole('button', { name: 'Next', exact: true }).click();
    await expect(modal.getByText('Page 2 of 500', { exact: true })).toBeVisible();
    expect(recordingReads).toBe(0);
  } finally {
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    ImmutableLocalArtifactStore.prototype.read = originalRead;
    backend.close();
    catalog.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
