import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { performance } from 'node:perf_hooks';
import { loadProjectAndAttachedDataFromString, serializeProject } from '@valerypopoff/rivet2-node';
import { LocalWorkflowCatalog } from '../local-metadata/workflow-catalog.js';
import { SqliteWorkflowBackend } from '../local-metadata/sqlite-workflow-backend.js';
import { ImmutableLocalArtifactStore } from '../local-metadata/immutable-artifact-store.js';

// Synthetic local fixture only. No production database or caller-supplied root is opened.
const workload = { projects: 100, seedProjects: 1, historicalVersions: 5, descriptionKiB: 128, recordings: 10000 };
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-sqlite-read-benchmark-'));
const options = {
  databasePath: path.join(root, 'catalog.sqlite'),
  artifactRoot: path.join(root, 'objects'),
  virtualRoot: path.join(root, 'workflows'),
  withWrite: async <T>(operation: () => Promise<T>) => operation(),
};
const catalog = new LocalWorkflowCatalog(options);
const backend = new SqliteWorkflowBackend(options);
const originalRead = ImmutableLocalArtifactStore.prototype.read;
let reads = 0,
  bytes = 0;
const results: Array<{ operation: string; ms: number; artifactReads: number; artifactMiB: number }> = [];
async function measure(operation: string, run: () => Promise<unknown>, expectedReads?: number) {
  reads = 0;
  bytes = 0;
  const started = performance.now();
  await run();
  const ms = performance.now() - started;
  if (expectedReads !== undefined) assert.equal(reads, expectedReads, operation);
  results.push({
    operation,
    ms: Number(ms.toFixed(2)),
    artifactReads: reads,
    artifactMiB: Number((bytes / 1048576).toFixed(2)),
  });
}
try {
  catalog.initialize();
  backend.initialize();
  const templateItem = await backend.createWorkflowProjectItem('', 'Template');
  const template = (await catalog.readProject(templateItem.relativePath))!;
  const [project, attached] = loadProjectAndAttachedDataFromString(template.contents);
  const paths: string[] = [];
  for (let i = 0; i < workload.projects; i++) {
    const name = `Project ${String(i).padStart(3, '0')}`;
    const workflowId = `benchmark-project-${i}`;
    project.metadata.id = workflowId as typeof project.metadata.id;
    project.metadata.title = name;
    const contents = (version: string) => {
      project.metadata.description = `${version}:` + 'x'.repeat(workload.descriptionKiB * 1024);
      return serializeProject(project, attached) as string;
    };
    const relativePath = `${name}.rivet-project`;
    paths.push(relativePath);
    await catalog.importProject({
      ...template,
      workflowId,
      relativePath,
      fileName: relativePath,
      name,
      contents: contents('draft'),
      publishedVersions: Array.from({ length: workload.historicalVersions }, (_, version) => ({
        versionId: `${workflowId}-version-${version}`,
        endpointName: `project-${i}`,
        publishedAt: '2026-01-01T00:00:00.000Z',
        isStarred: false,
        comment: '',
        contents: contents(`history-${version}`),
        datasetsContents: null,
      })),
    });
  }
  await catalog.importRecording({
    recordingId: 'template-run',
    workflowId: 'benchmark-project-0',
    sourceProjectRelativePath: paths[0]!,
    sourceProjectName: 'Project 000',
    createdAt: '2026-01-01T00:00:00.000Z',
    runKind: 'editor',
    status: 'succeeded',
    durationMs: 1,
    endpointName: '',
    errorMessage: null,
    recordingContents: '{}',
    replayProjectContents: template.contents,
    replayDatasetContents: null,
  });
  const db = new DatabaseSync(options.databasePath);
  try {
    const row = db.prepare("SELECT metadata_json FROM recordings WHERE recording_id = 'template-run'").get() as {
      metadata_json: string;
    };
    const recording = JSON.parse(row.metadata_json);
    db.exec('BEGIN');
    const insert = db.prepare('INSERT INTO recordings(recording_id, workflow_id, metadata_json) VALUES (?, ?, ?)');
    for (let i = 1; i < workload.recordings; i++) {
      const workflowId = `benchmark-project-${i % workload.projects}`;
      const recordingId = `run-${i}`;
      insert.run(recordingId, workflowId, JSON.stringify({ ...recording, recordingId, workflowId }));
    }
    db.exec('COMMIT');
  } finally {
    db.close();
  }
  ImmutableLocalArtifactStore.prototype.read = async function (...args) {
    const result = await originalRead.apply(this, args);
    reads++;
    bytes += result.length;
    return result;
  };
  await measure('full-snapshot tree baseline', async () => {
    for (const relativePath of catalog.listProjectPaths()) await catalog.readProject(relativePath);
  });
  const baselineSummaries: Array<{
    workflowId: string;
    latestRunAt: string;
    totalRuns: number;
    failedRuns: number;
    suspiciousRuns: number;
  }> = [];
  await measure('full-snapshot recording selector baseline', async () => {
    // The former selector loaded every project (including all historical bodies),
    // then parsed and counted every recording row in JS before returning a list.
    for (const relativePath of catalog.listProjectPaths()) {
      const snapshot = (await catalog.readProject(relativePath))!;
      const rows = catalog.listRecordingMetadata({ workflowId: snapshot.workflowId });
      if (!rows.length) continue;
      baselineSummaries.push({
        workflowId: snapshot.workflowId,
        latestRunAt: rows[0]!.createdAt,
        totalRuns: rows.length,
        failedRuns: rows.filter((row) => row.status === 'failed').length,
        suspiciousRuns: rows.filter((row) => row.status === 'suspicious').length,
      });
    }
  });
  await measure('indexed tree', () => backend.getTree(), 0);
  await measure('project open', () => backend.loadHostedProject(path.join(options.virtualRoot, paths[0]!)), 1);
  await measure('publication history list', () => backend.listWorkflowPublishedVersions(paths[0]), 0);
  await measure(
    'single version preview',
    () => backend.readWorkflowPublishedVersionPreview(paths[0], 'benchmark-project-0-version-0'),
    1,
  );
  const dbLegacy = new DatabaseSync(options.databasePath);
  try {
    dbLegacy.exec("UPDATE projects SET metadata_json = json_remove(metadata_json, '$.treeIndex')");
  } finally {
    dbLegacy.close();
  }
  await measure(
    'recording workflows (SQL aggregates, legacy projects)',
    async () => {
      const { workflows } = await backend.listWorkflowRecordingWorkflows();
      assert.equal(workflows.length, workload.projects);
      assert.deepEqual(
        workflows.map(({ project: _project, ...summary }) => summary),
        baselineSummaries,
        'Compact SQL results preserve the old selector counts and latest timestamps.',
      );
      for (const workflow of workflows) {
        assert.equal(workflow.totalRuns, workload.recordings / workload.projects);
        assert.equal(workflow.failedRuns, 0);
        assert.equal(workflow.suspiciousRuns, 0);
        assert.equal(workflow.latestRunAt, '2026-01-01T00:00:00.000Z');
      }
    },
    0,
  );
  await measure('recording page (20 runs)', () => backend.listWorkflowRecordingRunsPage('', 1, 20), 0);
  await measure('legacy tree cold', () => backend.getTree(), workload.projects + 1);
  await measure('legacy tree warm', () => backend.getTree(), 0);
  console.log(
    JSON.stringify(
      {
        workload,
        runtime: process.version,
        results,
        caveat: 'Synthetic local filesystem measurements, not production VM latency qualification.',
      },
      null,
      2,
    ),
  );
} finally {
  ImmutableLocalArtifactStore.prototype.read = originalRead;
  backend.close();
  catalog.close();
  await fs.rm(root, { recursive: true, force: true });
}
