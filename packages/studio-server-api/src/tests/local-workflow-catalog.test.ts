// test-style: fixture-read: reads only generated project fixtures to verify read-only diagnosis preserves source bytes.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';

import {
  LocalWorkflowCatalog,
  type LocalRuntimeLibraryState,
  type LocalRecordingCatalogSnapshot,
  type LocalWorkflowCatalogSnapshot,
} from '../local-metadata/workflow-catalog.js';
import { stageFrozenRecordingCatalog, stageFrozenWorkflowCatalog } from '../local-metadata/stage-workflow-catalog.js';
import { checkLocalWorkflowSource, collectSourceWorkflows } from '../local-metadata/filesystem-workflow-source.js';
import {
  collectSourceRecordings,
  iterateSourceRecordingImports,
} from '../local-metadata/filesystem-recording-source.js';
import {
  createBlankProjectFile,
  getWorkflowDatasetPath,
  getWorkflowProjectSettingsPath,
} from '../routes/workflows/fs-helpers.js';
import {
  readFilesystemPublishedVersionsForMigration,
  validateFilesystemPublishedVersionArchiveForMigration,
} from '../routes/workflows/published-versions.js';
import { createWorkflowPublicationStateHashFromContents } from '../routes/workflows/publication.js';
import { getRecordingArtifactPath } from '../routes/workflows/recordings-artifacts.js';
import { decodeMigrationSourceUtf8 } from '../scripts/migration-source-utf8.js';
import { ImmutableLocalArtifactStore } from '../local-metadata/immutable-artifact-store.js';
import { withEnvOverride } from './helpers/workflow-api-harness.js';
import { localUpgradeFailure, localUpgradeSourceReference } from '../local-metadata/upgrade-diagnostics.js';
import { verifySqliteWorkflowServing } from '../local-metadata/verify-serving-candidate.js';

function project(overrides: Partial<LocalWorkflowCatalogSnapshot> = {}): LocalWorkflowCatalogSnapshot {
  const relativePath = overrides.relativePath ?? 'folder/story.rivet-project';
  return {
    workflowId: 'project-id',
    relativePath,
    name: path.posix.basename(relativePath, '.rivet-project'),
    fileName: path.posix.basename(relativePath),
    updatedAt: '2026-01-02T03:04:05.000Z',
    contents: '{"project":"draft"}',
    datasetsContents: '{"dataset":1}',
    endpointName: 'story-latest',
    endpointAccess: 'internal',
    endpointStatus: 'unpublished_changes',
    publicationVersion: '2',
    publishedEndpointName: 'story',
    publishedVersionId: 'publish-2',
    lastPublishedAt: '2026-01-02T03:04:00.000Z',
    publishedContents: '{"project":"published-2"}',
    publishedDatasetsContents: null,
    publishedVersions: [
      {
        versionId: 'publish-1',
        endpointName: 'story-old',
        publishedAt: '2026-01-01T00:00:00.000Z',
        isStarred: true,
        comment: 'First version',
        contents: '{"project":"published-1"}',
        datasetsContents: null,
      },
      {
        versionId: 'publish-2',
        endpointName: 'story',
        publishedAt: '2026-01-02T03:04:00.000Z',
        isStarred: false,
        comment: '',
        contents: '{"project":"published-2"}',
        datasetsContents: null,
      },
    ],
    publishedWebApps: [
      {
        appId: 'app-id',
        uiGraphId: 'graph-id',
        uiGraphName: 'Story UI',
        slug: 'story-ui',
        allowedEmails: ['operator@example.com'],
        publishedAt: '2026-01-02T03:04:00.000Z',
        contents: '{"project":"webapp"}',
        datasetsContents: '{"dataset":2}',
      },
    ],
    ...overrides,
  };
}

function recording(overrides: Partial<LocalRecordingCatalogSnapshot> = {}): LocalRecordingCatalogSnapshot {
  return {
    recordingId: 'run-1',
    workflowId: 'project-id',
    sourceProjectRelativePath: 'folder/story.rivet-project',
    sourceProjectName: 'story',
    createdAt: '2026-01-03T00:00:00.000Z',
    runKind: 'published',
    status: 'succeeded',
    durationMs: 120,
    endpointName: 'story',
    errorMessage: null,
    executionIdentity: { surface: 'workflow_endpoint' },
    recordingContents: '{"input":1}',
    replayProjectContents: '{"project":"published-2"}',
    replayDatasetContents: null,
    ...overrides,
  };
}

async function fixture(run: (catalog: LocalWorkflowCatalog, root: string) => Promise<void>): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-local-catalog-'));
  const catalog = new LocalWorkflowCatalog({
    databasePath: path.join(root, 'catalog.sqlite'),
    artifactRoot: path.join(root, 'objects'),
  });
  try {
    catalog.initialize();
    await run(catalog, root);
  } finally {
    catalog.close();
    await fs.rm(root, { recursive: true, force: true });
  }
}

function useLegacyCatalogSchema(file: string, version: number): void {
  const db = new DatabaseSync(file);
  try {
    db.exec(`BEGIN;
      DROP INDEX projects_endpoint_name_unique;
      CREATE UNIQUE INDEX projects_endpoint_name_unique ON projects(endpoint_name) WHERE endpoint_name <> '';
      ALTER TABLE web_apps RENAME TO current_web_apps;
      CREATE TABLE web_apps (
        app_id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL REFERENCES projects(workflow_id) ON DELETE CASCADE,
        slug TEXT NOT NULL UNIQUE,
        metadata_json TEXT NOT NULL
      );
      INSERT INTO web_apps(rowid, app_id, workflow_id, slug, metadata_json)
        SELECT rowid, app_id, workflow_id, slug, metadata_json FROM current_web_apps;
      DROP TABLE current_web_apps;
      PRAGMA user_version=${version}; COMMIT`);
  } finally {
    db.close();
  }
}

test('recording imports require canonical UTC dates before writing artifacts', async (t) => {
  await fixture(async (catalog) => {
    catalog.importFolder('folder');
    await catalog.importProject(project());
    const writes = t.mock.method(ImmutableLocalArtifactStore.prototype, 'putBytes');
    for (const createdAt of [
      'now',
      '2026',
      '2026-02-30T00:00:00.000Z',
      '2026-10-08T24:00:00.000Z',
      '2026-10-08T24:01:00.000Z',
      '2026-10-08T02:00:00.000+02:00',
      '2026-10-08T00:00:00Z',
    ]) {
      await assert.rejects(catalog.importRecording(recording({ createdAt })), /canonical UTC timestamp/);
    }
    assert.equal(writes.mock.callCount(), 0);
    for (const createdAt of ['2026-03-01T00:00:00.001Z', '2026-03-01T00:00:00.999Z', '2024-02-29T00:00:00.000Z']) {
      await catalog.importRecording(recording({ recordingId: createdAt, createdAt }));
    }
    const [summary] = catalog.readRecordingWorkflowProjection();
    assert.equal(summary!.totalRuns, 3);
    assert.equal(summary!.latestRunAt, '2026-03-01T00:00:00.999Z');
    assert.equal(catalog.listRecordingMetadata()[0]!.createdAt, summary!.latestRunAt);
  });
});

test('recording picker counts and owner metadata share one snapshot under a competing connection', async (t) => {
  await fixture(async (catalog, root) => {
    catalog.importFolder('folder');
    const owner = project({ endpointAccess: 'public' });
    await catalog.importProject(owner);
    await catalog.importRecording(recording());
    const db = new DatabaseSync(path.join(root, 'catalog.sqlite'));
    try {
      db.exec('PRAGMA journal_mode = WAL');
      const prepare = DatabaseSync.prototype.prepare;
      let competingWrite = true;
      t.mock.method(DatabaseSync.prototype, 'prepare', function (this: DatabaseSync, sql: string) {
        const statement = prepare.call(this, sql);
        if (/\bFROM recordings\b/i.test(sql)) {
          const all = statement.all;
          t.mock.method(statement, 'all', (...args: Parameters<typeof all>) => {
            const result = all.apply(statement, args);
            if (competingWrite) {
              competingWrite = false;
              db.exec('BEGIN IMMEDIATE');
              db.prepare(
                "UPDATE projects SET metadata_json = json_set(metadata_json, '$.endpointAccess', 'internal')",
              ).run();
              db.prepare("UPDATE recordings SET metadata_json = json_set(metadata_json, '$.status', 'failed')").run();
              db.exec('COMMIT');
            }
            return result;
          });
        }
        return statement;
      });
      const [before] = catalog.readRecordingWorkflowProjection();
      assert.equal(competingWrite, false);
      assert.equal(before!.failedRuns, 0);
      assert.equal(before!.project.endpointAccess, owner.endpointAccess);
      const [after] = catalog.readRecordingWorkflowProjection();
      assert.equal(after!.failedRuns, 1);
      assert.equal(after!.project.endpointAccess, 'internal');
    } finally {
      db.close();
    }
  });
});

test('reference scans read only current draft and active publications, not datasets or archived history', async () => {
  await fixture(async (catalog, root) => {
    const source = project();
    await catalog.importProject(source);
    const catalogBefore = catalog.listProjectReferenceCatalog();
    // Removing unrelated payloads proves this read does not materialize them.
    for (const contents of [
      source.datasetsContents!,
      source.publishedWebApps[0]!.datasetsContents!,
      source.publishedVersions[0]!.contents,
    ]) {
      const hash = createHash('sha256').update(contents).digest('hex');
      await fs.rm(path.join(root, 'objects', hash.slice(0, 2), hash), { force: true });
    }
    assert.deepEqual(await catalog.readProjectReferenceSnapshots(source.relativePath), [
      { source: { kind: 'saved-latest' }, contents: source.contents },
      { source: { kind: 'published-endpoint', label: 'story' }, contents: source.publishedContents },
      { source: { kind: 'published-web-app', label: 'story-ui' }, contents: source.publishedWebApps[0]!.contents },
    ]);
    assert.deepEqual(catalog.listProjectReferenceCatalog(), catalogBefore);
  });
});

test('local catalog moves preserve recording rows and reject structural phantom writes', async () => {
  await fixture(async (catalog) => {
    catalog.importFolder('folder');
    const before = project();
    await catalog.importProject(before);
    await catalog.importRecording(recording());
    const other = project({
      workflowId: 'other',
      relativePath: 'folder/other.rivet-project',
      fileName: 'other.rivet-project',
      name: 'other',
      endpointName: '',
      publishedEndpointName: '',
      publishedContents: null,
      publishedDatasetsContents: null,
      publishedVersionId: null,
      lastPublishedAt: null,
      endpointStatus: 'unpublished',
      publishedVersions: [],
      publishedWebApps: [],
    });
    await catalog.importProject(other);
    await assert.rejects(
      catalog.applyChanges({
        expectedFolders: ['folder'],
        expectedProjectPaths: [before.relativePath],
        folders: ['moved'],
        projects: [{ before, after: { ...before, relativePath: 'moved/story.rivet-project' } }],
      }),
      /changed concurrently/,
    );
    assert.deepEqual(catalog.listFolders(), ['folder']);
    assert.ok(await catalog.readRecording('run-1'));
    await catalog.applyChanges({
      expectedFolders: ['folder'],
      expectedProjectPaths: [before.relativePath, other.relativePath],
      folders: ['moved'],
      projects: [before, other].map((before) => ({
        before,
        after: { ...before, relativePath: before.relativePath.replace('folder/', 'moved/') },
      })),
    });
    assert.equal((await catalog.readRecording('run-1'))?.sourceProjectRelativePath, before.relativePath);
    assert.equal(catalog.findProjectPathById(before.workflowId), 'moved/story.rivet-project');
  });
});

test('local catalog change stamp detects same-owner and separate-connection commits', async () => {
  await fixture(async (catalog, root) => {
    const initial = catalog.changeStamp();
    catalog.importFolder('first');
    assert.notEqual(catalog.changeStamp(), initial);
    const other = new LocalWorkflowCatalog({
      databasePath: path.join(root, 'catalog.sqlite'),
      artifactRoot: path.join(root, 'objects'),
    });
    try {
      other.initialize({ requireExisting: true });
      const before = catalog.changeStamp();
      other.importFolder('second');
      assert.notEqual(catalog.changeStamp(), before);
      await other.importProject(project());
      const treeStamp = catalog.changeStamp();
      await other.importRecording(recording());
      assert.equal(catalog.changeStamp(), treeStamp, 'Recording traffic does not invalidate the project tree');
      const beforeHistory = (await other.readProject('folder/story.rivet-project'))!;
      const editedHistory = structuredClone(beforeHistory);
      editedHistory.publishedVersions[0]!.comment = 'Historical comment only';
      await other.replaceProject(beforeHistory, editedHistory);
      assert.equal(catalog.changeStamp(), treeStamp, 'Unrelated historical edits do not invalidate the project tree');
    } finally {
      other.close();
    }
  });
});

test('local catalog late route failure rolls back folder and project changes together', async () => {
  await fixture(async (catalog) => {
    catalog.importFolder('folder');
    const before = project();
    await catalog.importProject(before);
    const other = project({
      workflowId: 'other',
      relativePath: 'folder/other.rivet-project',
      fileName: 'other.rivet-project',
      name: 'other',
      endpointName: 'other',
      publishedEndpointName: '',
      publishedContents: null,
      publishedDatasetsContents: null,
      publishedVersionId: null,
      lastPublishedAt: null,
      endpointStatus: 'unpublished',
      publishedVersions: [],
      publishedWebApps: [],
    });
    await catalog.importProject(other);
    await assert.rejects(
      catalog.applyChanges({
        expectedFolders: ['folder'],
        expectedProjectPaths: [before.relativePath, other.relativePath],
        folders: ['folder', 'new'],
        projects: [
          {
            before: other,
            after: {
              ...other,
              relativePath: 'new/other.rivet-project',
              endpointName: 'STORY',
              publishedEndpointName: 'other',
              publishedContents: other.contents,
              publishedDatasetsContents: other.datasetsContents,
              endpointStatus: 'unpublished_changes',
              lastPublishedAt: before.lastPublishedAt,
            },
          },
        ],
      }),
      /collision/,
    );
    await catalog.verifyExact(['folder'], [before, other]);
  });
});

test('local runtime activation persists its archive before CAS and refuses competing or read-only writes', async () => {
  await fixture(async (catalog, root) => {
    const before: LocalRuntimeLibraryState = { manifest: { packages: {}, updatedAt: '' }, archive: null };
    await catalog.importRuntimeLibraryState(before);
    const next: LocalRuntimeLibraryState = {
      manifest: {
        packages: { fixture: { name: 'fixture', version: '1.0.0' } },
        updatedAt: '2026-01-02T00:00:00.000Z',
        activeReleaseId: 'release-1',
      },
      archive: Buffer.from('immutable archive'),
    };
    const attempts = await Promise.allSettled([
      catalog.replaceRuntimeLibraryState(before, next),
      catalog.replaceRuntimeLibraryState(before, next),
    ]);
    assert.equal(attempts.filter((attempt) => attempt.status === 'fulfilled').length, 1);
    assert.deepEqual(await catalog.readRuntimeLibraryState(), next);
    const readOnly = new LocalWorkflowCatalog({
      databasePath: path.join(root, 'catalog.sqlite'),
      artifactRoot: path.join(root, 'objects'),
    });
    try {
      readOnly.initialize({ verifyOnly: true });
      await assert.rejects(readOnly.replaceRuntimeLibraryState(next, before), /verification only/);
      assert.deepEqual(await readOnly.readRuntimeLibraryState(), next);
    } finally {
      readOnly.close();
    }
    await catalog.replaceRuntimeLibraryState(next, before);
    assert.deepEqual(await catalog.readRuntimeLibraryState(), before);
  });
});

test('local recording retention is bounded, deterministic and removes references without deleting shared bytes', async () => {
  await fixture(async (catalog, root) => {
    await catalog.importProject(project());
    for (let index = 1; index <= 4; index++)
      await catalog.importRecording(
        recording({
          recordingId: `run-${index}`,
          createdAt: `2026-01-0${index}T00:00:00.000Z`,
        }),
      );
    const all = catalog.listRecordingMetadata();
    const policy = {
      now: Date.parse('2026-01-05T00:00:00Z'),
      retentionDays: 0,
      maxRunsPerEndpoint: 2,
      maxTotalBytes: 0,
      batchSize: 1,
    };
    assert.equal(catalog.pruneRecordings(policy)[0]!.recordingId, 'run-1');
    assert.equal(catalog.pruneRecordings(policy)[0]!.recordingId, 'run-2');
    assert.equal(catalog.pruneRecordings(policy).length, 0);
    assert.deepEqual(catalog.listRecordingIds(), ['run-3', 'run-4']);
    const store = new ImmutableLocalArtifactStore(path.join(root, 'objects'));
    assert.ok(await store.read(all[0]!.recordingHash));
    assert.throws(() => catalog.pruneRecordings({ ...policy, batchSize: 0 }), /Invalid/);
    assert.equal(
      catalog.pruneRecordings({ ...policy, maxRunsPerEndpoint: 0, retentionDays: 1 })[0]!.recordingId,
      'run-3',
    );
  });
});

test('recording gzip artifacts round-trip through reopen, replay and decoded metadata without expanded files', async () => {
  await fixture(async (catalog, root) => {
    await catalog.importProject(project());
    const snapshot = recording({
      recordingContents: '\ufeff' + JSON.stringify({ input: 'x'.repeat(1024 * 1024) }),
      replayProjectContents: JSON.stringify({ project: 'y'.repeat(1024 * 1024) }),
      replayDatasetContents: JSON.stringify({ dataset: 'z'.repeat(1024 * 1024) }),
    });
    await catalog.importRecording(snapshot);
    const metadata = catalog.listRecordingMetadata()[0]!;
    assert.ok(metadata.recordingBytes < 4096);
    assert.equal(metadata.recordingDecodedBytes, Buffer.byteLength(snapshot.recordingContents));
    assert.equal(metadata.projectDecodedBytes, Buffer.byteLength(snapshot.replayProjectContents));
    assert.equal(metadata.datasetDecodedBytes, Buffer.byteLength(snapshot.replayDatasetContents!));
    const store = new ImmutableLocalArtifactStore(path.join(root, 'objects'));
    const bytes = await store.read(metadata.recordingHash);
    assert.equal(bytes.length, metadata.recordingBytes);
    assert.equal(bytes[0], 0x1f);
    assert.equal(bytes[1], 0x8b);
    catalog.close();
    catalog.initialize({ verifyOnly: true, requireExisting: true });
    assert.deepEqual(await catalog.readRecording('run-1'), snapshot);
    assert.equal(await catalog.readRecordingArtifact('run-1', 'replay-dataset'), snapshot.replayDatasetContents);
    await catalog.verifyRecordingsExact([snapshot]);
  });
});

test('legacy recording catalogs, including a premature v4 marker, upgrade with a new recording write', async () => {
  for (const version of [2, 3, 4]) {
    await fixture(async (catalog, root) => {
      await catalog.importProject(project());
      const snapshot = recording({ recordingContents: 'original-recording'.repeat(1000) });
      await catalog.importRecording(snapshot, { compression: version === 2 ? 'identity' : 'gzip' });
      catalog.close();
      const file = path.join(root, 'catalog.sqlite');
      useLegacyCatalogSchema(file, version);
      catalog.initialize({ verifyOnly: true });
      assert.deepEqual(await catalog.readRecording('run-1'), snapshot);
      catalog.checkHealth();
      catalog.close();
      const before = new DatabaseSync(file, { readOnly: true });
      assert.equal(before.prepare('PRAGMA user_version').get()!.user_version, version);
      before.close();
      catalog.initialize({ requireExisting: true });
      await catalog.importRecording(recording({ recordingId: 'run-2', recordingContents: 'x'.repeat(10000) }));
      const after = new DatabaseSync(file, { readOnly: true });
      assert.equal(after.prepare('PRAGMA user_version').get()!.user_version, 4);
      after.close();
      assert.deepEqual(await catalog.readRecording('run-1'), snapshot);
      catalog.close();
      catalog.initialize({ verifyOnly: true });
      await catalog.verifyRecordingsExact([
        snapshot,
        recording({ recordingId: 'run-2', recordingContents: 'x'.repeat(10000) }),
      ]);
    });
  }
});

test('new recording writes honor identity encoding and the selected gzip level', async () => {
  await fixture(async (catalog, root) => {
    await catalog.importProject(project());
    const snapshot = recording({ recordingContents: 'recording'.repeat(10000) });
    await catalog.importRecording(snapshot, { compression: 'identity' });
    const plain = catalog.listRecordingMetadata({ recordingId: 'run-1' })[0]!;
    assert.equal(plain.recordingBytes, Buffer.byteLength(snapshot.recordingContents));
    assert.equal(plain.recordingDecodedBytes, plain.recordingBytes);
    const store = new ImmutableLocalArtifactStore(path.join(root, 'objects'));
    assert.deepEqual(await store.read(plain.recordingHash), Buffer.from(snapshot.recordingContents));
    for (const level of [0, 1, 9]) {
      const value = recording({ ...snapshot, recordingId: `gzip-${level}` });
      await catalog.importRecording(value, { compression: 'gzip', gzipLevel: level });
      const row = catalog.listRecordingMetadata({ recordingId: value.recordingId })[0]!;
      const gzip = gzipSync(value.recordingContents, { level });
      const expected = gzip.length < plain.recordingBytes ? gzip : Buffer.from(value.recordingContents);
      assert.deepEqual(await store.read(row.recordingHash), expected);
      assert.deepEqual(await catalog.readRecording(value.recordingId), value);
    }
  });
});

test('migrated empty gzip payloads retain their compressed bytes and zero decoded size', async () => {
  await fixture(async (catalog, root) => {
    await catalog.importProject(project());
    const file = path.join(root, 'empty.gz');
    const bytes = gzipSync('');
    await fs.writeFile(file, bytes);
    const source = { path: file, encoding: 'gzip' as const, decodedSize: 0 };
    const snapshot = recording({ recordingContents: '', replayProjectContents: '', replayDatasetContents: '' });
    await catalog.importRecording(snapshot, {
      sources: { recordingContents: source, replayProjectContents: source, replayDatasetContents: source },
    });
    const row = catalog.listRecordingMetadata()[0]!;
    assert.equal(row.recordingBytes, bytes.length);
    assert.equal(row.recordingDecodedBytes, 0);
    assert.equal(row.projectDecodedBytes, 0);
    assert.equal(row.datasetDecodedBytes, 0);
    assert.equal(row.hasReplayDataset, true);
    assert.deepEqual(await catalog.readRecording('run-1'), snapshot);
    catalog.close();
    catalog.initialize({ verifyOnly: true });
    await catalog.verifyRecordingsExact([snapshot]);
  });
});

test('compressed recording references reject invalid encoding, corrupt gzip and incorrect decoded sizes', async () => {
  await fixture(async (catalog, root) => {
    await catalog.importProject(project());
    await catalog.importRecording(recording({ recordingContents: 'x'.repeat(10000) }));
    const db = new DatabaseSync(path.join(root, 'catalog.sqlite'));
    const original = JSON.parse(db.prepare('SELECT metadata_json FROM recordings').get()!.metadata_json as string);
    try {
      for (const changes of [{ encoding: 'zip' }, { decodedSize: -1 }, { decodedSize: 1 }, { decodedSize: 10001 }]) {
        const data = structuredClone(original);
        Object.assign(data.recordingContents, changes);
        db.prepare('UPDATE recordings SET metadata_json=?').run(JSON.stringify(data));
        await assert.rejects(catalog.readRecording('run-1'));
      }
      const store = new ImmutableLocalArtifactStore(path.join(root, 'objects'));
      const corrupt = await store.putBytes(Buffer.from('not gzip'));
      original.recordingContents = { ...corrupt, encoding: 'gzip', decodedSize: 10000 };
      db.prepare('UPDATE recordings SET metadata_json=?').run(JSON.stringify(original));
      await assert.rejects(catalog.readRecording('run-1'), /gzip|header/i);
    } finally {
      db.close();
    }
  });
});

test('local recording byte quotas count only rows retained by age and per-workflow policy', async () => {
  await fixture(async (catalog) => {
    await catalog.importProject(project());
    await catalog.importProject(
      project({
        workflowId: 'other',
        relativePath: 'folder/other.rivet-project',
        name: 'other',
        fileName: 'other.rivet-project',
        endpointName: '',
        publishedEndpointName: '',
        publishedContents: null,
        publishedDatasetsContents: null,
        publishedVersionId: null,
        lastPublishedAt: null,
        endpointStatus: 'unpublished',
        publishedVersions: [],
        publishedWebApps: [],
      }),
    );
    await catalog.importRecording(recording({ recordingId: 'newest', createdAt: '2026-01-04T00:00:00.000Z' }));
    await catalog.importRecording(
      recording({
        recordingId: 'rank-excluded',
        createdAt: '2026-01-03T00:00:00.000Z',
        recordingContents: 'x'.repeat(5000),
      }),
    );
    await catalog.importRecording(
      recording({ recordingId: 'other-retained', workflowId: 'other', createdAt: '2026-01-02T00:00:00.000Z' }),
    );
    const row = catalog.listRecordingMetadata({ recordingId: 'newest' })[0]!;
    const deleted = catalog.pruneRecordings({
      now: Date.parse('2026-01-05T00:00:00Z'),
      retentionDays: 0,
      maxRunsPerEndpoint: 1,
      maxTotalBytes: 2 * (row.recordingBytes + row.projectBytes + row.datasetBytes),
      batchSize: 100,
    });
    assert.deepEqual(
      deleted.map((row) => row.recordingId),
      ['rank-excluded'],
    );
    assert.deepEqual(catalog.listRecordingIds(), ['newest', 'other-retained']);
  });
});

test('diagnostic recording holds bypass age, count and byte retention without consuming the unheld quota', async () => {
  await fixture(async (catalog) => {
    await catalog.importProject(project());
    for (let index = 1; index <= 4; index++) {
      await catalog.importRecording(
        recording({
          recordingId: `run-${index}`,
          createdAt: `2026-01-0${index}T00:00:00.000Z`,
        }),
      );
    }
    const newest = catalog.listRecordingMetadata({ recordingId: 'run-4' })[0]!;
    const policy = {
      now: Date.parse('2026-01-05T00:00:00Z'),
      retentionDays: 0,
      maxRunsPerEndpoint: 1,
      maxTotalBytes: newest.recordingBytes + newest.projectBytes + newest.datasetBytes,
      batchSize: 100,
      heldRecordingIds: new Set(['run-1', 'run-3']),
    };
    assert.deepEqual(
      catalog.pruneRecordings(policy).map((row) => row.recordingId),
      ['run-2'],
    );
    assert.deepEqual(catalog.listRecordingIds(), ['run-1', 'run-3', 'run-4']);
    assert.deepEqual(
      catalog
        .pruneRecordings({ ...policy, retentionDays: 1, now: Date.parse('2026-02-01T00:00:00Z') })
        .map((row) => row.recordingId),
      ['run-4'],
    );
    assert.deepEqual(catalog.listRecordingIds(), ['run-1', 'run-3']);
    assert.throws(() => catalog.pruneRecordings({ ...policy, heldRecordingIds: new Set(['']) }), /Invalid/);
  });
});

test('migration UTF-8 decoding preserves BOM bytes and rejects lossy replacement', () => {
  const source = Buffer.from([0xef, 0xbb, 0xbf, 0x41]);
  assert.deepEqual(Buffer.from(decodeMigrationSourceUtf8(source, 'fixture')), source);
  assert.throws(() => decodeMigrationSourceUtf8(Buffer.from([0xff]), 'fixture'), /not valid UTF-8/);
});

test('workflow diagnostics identify malformed projects and duplicate IDs without changing source bytes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-workflow-diagnostic-'));
  try {
    const first = path.join(root, 'a.rivet-project');
    const second = path.join(root, 'b.rivet-project');
    const contents = createBlankProjectFile('fixture');
    await fs.writeFile(first, contents);
    await fs.writeFile(second, contents);
    await withEnvOverride('RIVET_EXTRA_ROOTS', root, async () => {
      await assert.rejects(collectSourceWorkflows(root), (error) => {
        const failure = localUpgradeFailure('workflows', error);
        assert.equal(failure.reason, 'project-id-duplicate');
        assert.ok(
          ['a.rivet-project', 'b.rivet-project'].map(localUpgradeSourceReference).includes(failure.sourceReference!),
        );
        return true;
      });
      assert.equal(await fs.readFile(first, 'utf8'), contents);
      assert.equal(await fs.readFile(second, 'utf8'), contents);
      await fs.writeFile(second, 'password=never-serialize-this-invalid-project');
      await assert.rejects(collectSourceWorkflows(root), (error) => {
        const failure = localUpgradeFailure('workflows', error);
        assert.equal(failure.reason, 'project-parse-failed');
        assert.equal(failure.sourceReference, localUpgradeSourceReference('b.rivet-project'));
        assert.equal(JSON.stringify(failure).includes('password'), false);
        return true;
      });
      assert.equal(await fs.readFile(second, 'utf8'), 'password=never-serialize-this-invalid-project');
      await assert.rejects(checkLocalWorkflowSource(root), (error) => {
        assert.equal(localUpgradeFailure('workflows', error).reason, 'project-parse-failed');
        return true;
      });
      const otherContents = createBlankProjectFile('other');
      await fs.writeFile(second, otherContents);
      await fs.mkdir(path.join(root, 'empty-folder'));
      assert.deepEqual(await checkLocalWorkflowSource(root), { projects: 2, folders: 1 });
      assert.equal(await fs.readFile(first, 'utf8'), contents);
      assert.equal(await fs.readFile(second, 'utf8'), otherContents);
      assert.deepEqual((await fs.readdir(root)).sort(), ['a.rivet-project', 'b.rivet-project', 'empty-folder']);
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('migration archive parses bounded snapshot and metadata bytes without reopening them', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-archive-checked-'));
  try {
    const published = path.join(root, '.published');
    await fs.mkdir(published);
    const contents = createBlankProjectFile('fixture');
    let workflowId = '';
    await withEnvOverride('RIVET_EXTRA_ROOTS', root, async () => {
      await fs.writeFile(path.join(root, 'fixture.rivet-project'), contents);
      const [source] = await collectSourceWorkflows(root);
      assert.ok(source);
      workflowId = source.workflowId;
    });
    const snapshot = path.join(published, 'snapshot.rivet-project');
    const metadata = path.join(published, 'snapshot.json');
    await fs.writeFile(snapshot, contents);
    await fs.writeFile(
      metadata,
      JSON.stringify({
        version: 1,
        id: 'snapshot',
        projectId: workflowId,
        projectName: 'fixture',
        relativePath: 'fixture.rivet-project',
        endpointName: 'fixture',
        publishedAt: '2026-01-01T00:00:00.000Z',
        stateHash: 'fixture',
      }),
    );
    const readFile = fs.readFile;
    const guard = t.mock.method(fs, 'readFile', (...args: Parameters<typeof fs.readFile>) => {
      assert.ok(args[0] !== snapshot && args[0] !== metadata, 'Checked archive bytes must not be reopened');
      return Reflect.apply(readFile, fs, args);
    });
    await withEnvOverride('RIVET_EXTRA_ROOTS', root, async () => {
      assert.deepEqual(await validateFilesystemPublishedVersionArchiveForMigration(root), new Set([workflowId]));
      const records = await readFilesystemPublishedVersionsForMigration(root, path.join(root, 'fixture.rivet-project'));
      assert.equal(records.length, 1);
      assert.equal(records[0]?.contents, contents);
      guard.mock.restore();
      const lstat = fs.lstat;
      const permission = t.mock.method(fs, 'lstat', (...args: Parameters<typeof fs.lstat>) => {
        if (args[0] === snapshot) throw Object.assign(new Error('private permission detail'), { code: 'EACCES' });
        return Reflect.apply(lstat, fs, args);
      });
      await assert.rejects(
        readFilesystemPublishedVersionsForMigration(root, path.join(root, 'fixture.rivet-project')),
        (error) => {
          const failure = localUpgradeFailure('workflows', error);
          assert.equal(failure.code, 'permission-denied');
          assert.equal(failure.reason, undefined);
          return true;
        },
      );
      permission.mock.restore();
      await withEnvOverride('RIVET_LOCAL_METADATA_MAX_BUNDLE_MIB', '1', async () => {
        await fs.writeFile(snapshot, 'x'.repeat(1048577));
        await assert.rejects(
          readFilesystemPublishedVersionsForMigration(root, path.join(root, 'fixture.rivet-project')),
          (error) => {
            assert.equal(localUpgradeFailure('workflows', error).reason, 'source-bundle-limit');
            return true;
          },
        );
      });
      await fs.rm(snapshot);
      await assert.rejects(
        readFilesystemPublishedVersionsForMigration(root, path.join(root, 'fixture.rivet-project')),
        (error) => {
          assert.equal(localUpgradeFailure('workflows', error).reason, 'publication-snapshot-missing');
          return true;
        },
      );
      await withEnvOverride('RIVET_LOCAL_METADATA_MAX_BUNDLE_MIB', '1', async () => {
        await fs.writeFile(metadata, ' '.repeat(1048577));
        await assert.rejects(validateFilesystemPublishedVersionArchiveForMigration(root), (error) => {
          assert.equal(localUpgradeFailure('workflows', error).reason, 'source-bundle-limit');
          return true;
        });
      });
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('migration legacy publication fallback refuses missing and foreign snapshots without parser warnings', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-legacy-history-'));
  const warnings = t.mock.method(console, 'warn', () => {});
  try {
    const projectPath = path.join(root, 'fixture.rivet-project');
    const snapshot = path.join(root, '.published', 'legacy.rivet-project');
    await fs.mkdir(path.dirname(snapshot));
    await fs.writeFile(projectPath, createBlankProjectFile('fixture'));
    await fs.writeFile(
      getWorkflowProjectSettingsPath(projectPath),
      JSON.stringify({
        endpointName: 'fixture',
        publishedSnapshotId: 'legacy',
      }),
    );
    await withEnvOverride('RIVET_EXTRA_ROOTS', root, async () => {
      const rejectsWith = async (reason: string) => {
        await assert.rejects(collectSourceWorkflows(root), (error) => {
          const failure = localUpgradeFailure('workflows', error);
          assert.equal(failure.reason, reason);
          assert.equal(failure.sourceReference, localUpgradeSourceReference('fixture.rivet-project'));
          return true;
        });
      };
      await rejectsWith('publication-snapshot-missing');
      await assert.rejects(readFilesystemPublishedVersionsForMigration(root, projectPath), (error) => {
        assert.equal(localUpgradeFailure('workflows', error).reason, 'publication-snapshot-missing');
        return true;
      });
      await fs.writeFile(snapshot, createBlankProjectFile('another-project'));
      await rejectsWith('publication-owner-mismatch');
      await assert.rejects(readFilesystemPublishedVersionsForMigration(root, projectPath), (error) => {
        assert.equal(localUpgradeFailure('workflows', error).reason, 'publication-owner-mismatch');
        return true;
      });
      await fs.writeFile(snapshot, 'private malformed project contents');
      await rejectsWith('project-parse-failed');
      await assert.rejects(readFilesystemPublishedVersionsForMigration(root, projectPath));
      assert.equal(warnings.mock.callCount(), 0);
      await fs.writeFile(snapshot, await fs.readFile(projectPath));
      const [source] = await collectSourceWorkflows(root);
      assert.equal(source?.publishedVersions.length, 1);
      assert.equal(source?.publishedVersions[0]?.versionId, 'legacy');
      await fs.writeFile(
        getWorkflowProjectSettingsPath(projectPath),
        JSON.stringify({ publishedSnapshotId: 'legacy' }),
      );
      await rejectsWith('publication-history-invalid');
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('migration publication status and legacy resolution reuse checked project, settings and dataset bytes', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-checked-publication-'));
  try {
    const projectPath = path.join(root, 'fixture.rivet-project');
    const datasetPath = getWorkflowDatasetPath(projectPath);
    const settingsPath = getWorkflowProjectSettingsPath(projectPath);
    const contents = createBlankProjectFile('fixture');
    const datasetsContents = '{"dataset":"preserve checked bytes"}';
    await fs.writeFile(projectPath, contents);
    await fs.writeFile(datasetPath, datasetsContents);
    await fs.writeFile(
      settingsPath,
      JSON.stringify({
        endpointName: 'fixture',
        publishedEndpointName: 'fixture',
        publishedStateHash: createWorkflowPublicationStateHashFromContents(contents, datasetsContents, 'fixture'),
        lastPublishedAt: '2026-01-01T00:00:00.000Z',
      }),
    );
    const readFile = fs.readFile;
    const guard = t.mock.method(fs, 'readFile', (...args: Parameters<typeof fs.readFile>) => {
      assert.ok(
        ![projectPath, datasetPath, settingsPath].includes(args[0] as string),
        'Migration must not reopen checked source through unbounded readers',
      );
      return Reflect.apply(readFile, fs, args);
    });
    await withEnvOverride('RIVET_EXTRA_ROOTS', root, async () => {
      const [source] = await collectSourceWorkflows(root);
      assert.ok(source);
      assert.equal(source.endpointStatus, 'published');
      assert.equal(source.contents, contents);
      assert.equal(source.datasetsContents, datasetsContents);
      assert.equal(source.publishedContents, contents);
      assert.equal(source.publishedDatasetsContents, datasetsContents);
      assert.equal(source.lastPublishedAt, '2026-01-01T00:00:00.000Z');
      await fs.writeFile(datasetPath, '{"dataset":"changed"}');
      await assert.rejects(collectSourceWorkflows(root), (error) => {
        // Changed draft cannot stand in for a missing legacy published snapshot.
        assert.equal(localUpgradeFailure('workflows', error).reason, 'publication-snapshot-missing');
        return true;
      });
      await withEnvOverride('RIVET_LOCAL_METADATA_MAX_BUNDLE_MIB', '1', async () => {
        await fs.writeFile(datasetPath, 'x'.repeat(1048576));
        await assert.rejects(collectSourceWorkflows(root), (error) => {
          const failure = localUpgradeFailure('workflows', error);
          assert.equal(failure.reason, 'source-bundle-limit');
          assert.equal(failure.sourceReference, localUpgradeSourceReference('fixture.rivet-project'));
          return true;
        });
      });
    });
    guard.mock.restore();
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('local workflow candidate rejects invalid UTF-8 dataset bytes rather than changing them', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-local-utf8-'));
  try {
    const projectPath = path.join(root, 'story.rivet-project');
    await fs.writeFile(projectPath, createBlankProjectFile('story'));
    const invalidDataset = Buffer.concat([Buffer.from('{"value":"'), Buffer.from([0xff]), Buffer.from('"}')]);
    await fs.writeFile(getWorkflowDatasetPath(projectPath), invalidDataset);
    const before = await fs.stat(getWorkflowDatasetPath(projectPath));
    await withEnvOverride('RIVET_EXTRA_ROOTS', root, async () => {
      await assert.rejects(collectSourceWorkflows(root), /not valid UTF-8/);
    });
    const after = await fs.stat(getWorkflowDatasetPath(projectPath));
    assert.deepEqual(
      { size: after.size, mtimeMs: after.mtimeMs, ctimeMs: after.ctimeMs },
      { size: before.size, mtimeMs: before.mtimeMs, ctimeMs: before.ctimeMs },
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('local catalog preserves complete project, publication, and web-app state across restart', async () => {
  await fixture(async (catalog, root) => {
    const source = project();
    catalog.importFolder('folder');
    catalog.importFolder('empty');
    await catalog.importProject(source);
    await catalog.verifyExact(['empty', 'folder'], [source]);
    assert.throws(() => catalog.initialize({ verifyOnly: true }), /already open in another mode/);
    catalog.close();
    const beforeVerification = await fs.stat(path.join(root, 'catalog.sqlite'));

    const reopened = new LocalWorkflowCatalog({
      databasePath: path.join(root, 'catalog.sqlite'),
      artifactRoot: path.join(root, 'objects'),
    });
    try {
      reopened.initialize({ verifyOnly: true });
      assert.deepEqual(await reopened.readProject(source.relativePath), source);
      await reopened.verifyExact(['empty', 'folder'], [source]);
      const afterVerification = await fs.stat(path.join(root, 'catalog.sqlite'));
      assert.deepEqual(
        { size: afterVerification.size, mtimeMs: afterVerification.mtimeMs, ctimeMs: afterVerification.ctimeMs },
        { size: beforeVerification.size, mtimeMs: beforeVerification.mtimeMs, ctimeMs: beforeVerification.ctimeMs },
      );
      await assert.rejects(
        reopened.importProject(project({ workflowId: 'another', relativePath: 'another.rivet-project' })),
      );
    } finally {
      reopened.close();
    }
  });
});

test('local catalog verifies mixed-case folder names in the same order it reads them', async () => {
  await fixture(async (catalog) => {
    catalog.importFolder('Zed');
    catalog.importFolder('alpha');
    await catalog.verifyExact(['Zed', 'alpha'], []);
  });
});

test('local catalog retries exactly, rejects drift, extra rows, and route collisions', async () => {
  await fixture(async (catalog) => {
    const source = project();
    catalog.importFolder('folder');
    await catalog.importProject(source);
    await catalog.importProject(source);
    await assert.rejects(catalog.importProject(project({ contents: 'changed' })), /differs on retry/);
    await assert.rejects(catalog.verifyExact([], [source]), /folder set differs/);
    await assert.rejects(catalog.verifyExact(['folder'], []), /project set differs/);
    await assert.rejects(
      catalog.importProject(project({ workflowId: 'second-id', relativePath: 'second.rivet-project' })),
      /UNIQUE constraint failed/,
    );
    assert.deepEqual(catalog.listProjectPaths(), [source.relativePath]);
    await catalog.verifyExact(['folder'], [source]);
  });
});

test('unpublished endpoint preferences preserve history without reserving or stealing live routes', async () => {
  await fixture(async (catalog) => {
    const live = project();
    const archived = project({
      workflowId: 'archived-id',
      relativePath: 'folder/archived.rivet-project',
      endpointStatus: 'unpublished',
      publishedEndpointName: '',
      publishedVersionId: null,
      publishedContents: null,
      publishedDatasetsContents: null,
      publishedVersions: live.publishedVersions.map((v) => ({ ...v, versionId: `archived-${v.versionId}` })),
      publishedWebApps: [],
    });
    const copy = project({
      ...archived,
      workflowId: 'copy-id',
      relativePath: 'folder/copy.rivet-project',
      name: 'copy',
      fileName: 'copy.rivet-project',
      endpointName: 'STORY',
      publishedVersions: [],
    });
    // Import archived preferences first, as in a failed legacy migration.
    catalog.importFolder('folder');
    for (const p of [archived, copy, live]) await catalog.importProject(p);
    for (const p of [archived, copy, live]) await catalog.importProject(p);
    await catalog.verifyExact(['folder'], [archived, copy, live]);
    assert.equal(
      (await catalog.readExecutionSource({ endpointName: 'STORY-LATEST', version: 'latest' }))?.workflowId,
      live.workflowId,
    );
    assert.equal(
      (await catalog.readExecutionSource({ endpointName: 'STORY', version: 'published' }))?.workflowId,
      live.workflowId,
    );
    assert.equal(await catalog.readExecutionSource({ endpointName: 'STORY', version: 'latest' }), null);
    assert.equal(
      (await catalog.readExecutionSource({ workflowId: archived.workflowId, version: 'latest' }))?.workflowId,
      archived.workflowId,
    );
    catalog.close();
    catalog.initialize({ verifyOnly: true });
    await catalog.verifyExact(['folder'], [archived, copy, live]);
    assert.equal(
      (await catalog.readExecutionSource({ endpointName: 'story-latest', version: 'latest' }))?.workflowId,
      live.workflowId,
    );
  });
});

test('legacy schemas, including a premature v4 marker, upgrade only with a successful project write', async () => {
  for (const version of [2, 3, 4]) {
    await fixture(async (catalog, root) => {
      const source = project();
      await catalog.importProject(source);
      catalog.close();
      const file = path.join(root, 'catalog.sqlite');
      const legacyIndex =
        "CREATE UNIQUE INDEX projects_endpoint_name_unique ON projects(endpoint_name) WHERE endpoint_name <> ''";
      useLegacyCatalogSchema(file, version);
      const withoutIndex = new DatabaseSync(file);
      withoutIndex.exec("UPDATE projects SET metadata_json = json_remove(metadata_json, '$.treeIndex')");
      withoutIndex.close();
      const original = new DatabaseSync(file, { readOnly: true });
      const legacyTable = original.prepare("SELECT sql FROM sqlite_master WHERE name='web_apps'").get()!.sql;
      original.close();
      const bytes = await fs.readFile(file);
      catalog.initialize({ verifyOnly: true });
      catalog.checkHealth();
      assert.deepEqual(await catalog.readProject(source.relativePath), source);
      const tree = await catalog.readTreeProjection();
      assert.equal(tree.projects[0]!.workflowId, source.workflowId);
      assert.equal(tree.projects[0]!.publishedWebApps.length, source.publishedWebApps.length);
      catalog.close();
      assert.deepEqual(await fs.readFile(file), bytes, 'Read-only verification preserves certified bytes.');
      catalog.initialize({ requireExisting: true });
      await catalog.importProject(source);
      await assert.rejects(catalog.replaceProject({ ...source, contents: 'stale' }, source), /changed concurrently/);
      const unchanged = new DatabaseSync(file, { readOnly: true });
      assert.equal(unchanged.prepare('PRAGMA user_version').get()!.user_version, version);
      assert.equal(
        unchanged.prepare("SELECT sql FROM sqlite_master WHERE name='projects_endpoint_name_unique'").get()!.sql,
        legacyIndex,
      );
      assert.equal(unchanged.prepare("SELECT sql FROM sqlite_master WHERE name='web_apps'").get()!.sql, legacyTable);
      unchanged.close();
      const copy = project({
        workflowId: 'copy-id',
        relativePath: 'copy.rivet-project',
        endpointStatus: 'unpublished',
        publishedEndpointName: '',
        publishedVersionId: null,
        publishedContents: null,
        publishedDatasetsContents: null,
        publishedVersions: [],
        publishedWebApps: [{ ...source.publishedWebApps[0]!, slug: 'copied-app' }],
      });
      await catalog.importProject(copy);
      await catalog.importProject(copy);
      const upgraded = new DatabaseSync(file, { readOnly: true });
      assert.equal(upgraded.prepare('PRAGMA user_version').get()!.user_version, 4);
      upgraded.close();
      catalog.close();
      catalog.initialize({ verifyOnly: true });
      await catalog.verifyExact([], [source, copy]);
      assert.equal(
        (await catalog.readExecutionSource({ endpointName: source.endpointName, version: 'latest' }))?.workflowId,
        source.workflowId,
      );
    });
  }
});

test('a failed recording insert rolls back recovery of legacy DDL marked v4', async (t) => {
  await fixture(async (catalog, root) => {
    const source = project();
    await catalog.importProject(source);
    catalog.close();
    const file = path.join(root, 'catalog.sqlite');
    useLegacyCatalogSchema(file, 4);
    const original = await fs.readFile(file);
    catalog.initialize({ requireExisting: true });
    const prepare = DatabaseSync.prototype.prepare;
    const failure = t.mock.method(DatabaseSync.prototype, 'prepare', function (this: DatabaseSync, sql: string) {
      if (sql.startsWith('INSERT INTO recordings')) throw new Error('Injected recording insert failure');
      return prepare.call(this, sql);
    });
    await assert.rejects(catalog.importRecording(recording()), /Injected recording insert failure/);
    failure.mock.restore();
    catalog.close();
    assert.deepEqual(await fs.readFile(file), original, 'DDL recovery rolls back with the failed recording write.');
    catalog.initialize({ requireExisting: true });
    assert.deepEqual(await catalog.readProject(source.relativePath), source);
    await catalog.importRecording(recording());
    catalog.close();
    catalog.initialize({ verifyOnly: true });
    await catalog.verifyRecordingsExact([recording()]);
  });
});

test('two catalog connections tolerate recovery committed by the other writer', async () => {
  await fixture(async (catalog, root) => {
    const source = project();
    await catalog.importProject(source);
    catalog.close();
    const file = path.join(root, 'catalog.sqlite');
    useLegacyCatalogSchema(file, 4);
    catalog.initialize({ requireExisting: true });
    const other = new LocalWorkflowCatalog({ databasePath: file, artifactRoot: path.join(root, 'objects') });
    other.initialize({ requireExisting: true });
    try {
      await catalog.importRecording(recording());
      const edited = { ...source, contents: 'edited after recovery' };
      await other.replaceProject(source, edited);
      assert.deepEqual(await catalog.readProject(source.relativePath), edited);
      assert.deepEqual(await other.readRecording('run-1'), recording());
      other.checkHealth();
    } finally {
      other.close();
    }
  });
});

test('catalog compatibility refuses mixed, modified and future schemas without repairing them', async () => {
  const mutations = [
    `DROP INDEX projects_endpoint_name_unique;
      CREATE UNIQUE INDEX projects_endpoint_name_unique ON projects(endpoint_name)
      WHERE endpoint_name <> '' AND json_extract(metadata_json, '$.publishedContents') IS NOT NULL`,
    `ALTER TABLE web_apps RENAME TO old_web_apps;
      CREATE TABLE web_apps (
        app_id TEXT NOT NULL,
        workflow_id TEXT NOT NULL REFERENCES projects(workflow_id) ON DELETE CASCADE,
        slug TEXT NOT NULL UNIQUE,
        metadata_json TEXT NOT NULL,
        PRIMARY KEY(workflow_id, app_id)
      ); DROP TABLE old_web_apps`,
    'ALTER TABLE projects ADD COLUMN unexpected TEXT',
    'CREATE TRIGGER unexpected AFTER INSERT ON projects BEGIN SELECT 1; END',
    'CREATE VIEW sqliteXunexpected AS SELECT workflow_id FROM projects',
    'PRAGMA journal_mode=WAL; CREATE VIEW unexpected AS SELECT workflow_id FROM projects',
    'PRAGMA user_version=5',
  ];
  for (const mutation of mutations) {
    await fixture(async (catalog, root) => {
      catalog.close();
      const file = path.join(root, 'catalog.sqlite');
      useLegacyCatalogSchema(file, 4);
      const raw = new DatabaseSync(file);
      raw.exec(mutation);
      raw.close();
      const original = await fs.readFile(file);
      for (const verifyOnly of [true, false]) {
        assert.throws(() => catalog.initialize({ verifyOnly, requireExisting: true }), /schema/);
        assert.deepEqual(await fs.readFile(file), original);
      }
    });
  }
});

test('an open catalog detects schema or identity changes before health checks and new writes', async () => {
  for (const mutation of [
    'CREATE VIEW sqliteXunexpected AS SELECT workflow_id FROM projects',
    'ALTER TABLE projects ADD COLUMN unexpected TEXT',
    'PRAGMA application_id=1',
    'PRAGMA user_version=5',
  ]) {
    await fixture(async (catalog, root) => {
      await catalog.importProject(project());
      const file = path.join(root, 'catalog.sqlite');
      const raw = new DatabaseSync(file);
      raw.exec(mutation);
      raw.close();
      const original = await fs.readFile(file);
      assert.throws(() => catalog.checkHealth(), /schema|identity|health check/);
      await assert.rejects(catalog.importRecording(recording()), /schema|identity/);
      catalog.close();
      assert.deepEqual(await fs.readFile(file), original, 'Rejected writes must not alter the catalog.');
    });
  }
});

test('local catalog replaces a project atomically and rejects stale writes', async () => {
  await fixture(async (catalog) => {
    const before = project();
    const after = project({
      contents: '{"project":"edited"}',
      endpointName: 'story-new-latest',
      publishedVersions: before.publishedVersions.slice(0, 1),
      publishedVersionId: 'publish-1',
      publishedEndpointName: before.publishedVersions[0]!.endpointName,
      publishedContents: before.publishedVersions[0]!.contents,
      publishedDatasetsContents: before.publishedVersions[0]!.datasetsContents,
      lastPublishedAt: before.publishedVersions[0]!.publishedAt,
      publishedWebApps: [{ ...before.publishedWebApps[0]!, slug: 'story-new-ui' }],
    });
    await catalog.importProject(before);
    await catalog.replaceProject(before, after);
    assert.deepEqual(await catalog.readProject(before.relativePath), after);
    await assert.rejects(catalog.replaceProject(before, project({ contents: 'stale write' })), /changed concurrently/);
    assert.deepEqual(await catalog.readProject(before.relativePath), after);
  });
});

test('local catalog rejects invalid policies, publication pointers and duplicate bindings before committing', async () => {
  await fixture(async (catalog) => {
    const before = project();
    await catalog.importProject(before);
    for (const next of [
      project({ endpointAccess: 'unknown' as 'public' }),
      project({ publicationVersion: '-1' }),
      project({ publishedContents: 'not the current version' }),
      project({ publishedWebApps: [{ ...before.publishedWebApps[0]!, allowedEmails: null as unknown as string[] }] }),
      project({
        publishedWebApps: [
          before.publishedWebApps[0]!,
          { ...before.publishedWebApps[0]!, appId: 'second-app', slug: 'second-ui' },
        ],
      }),
      project({
        publishedWebApps: [
          before.publishedWebApps[0]!,
          { ...before.publishedWebApps[0]!, uiGraphId: 'second-graph', slug: 'second-ui' },
        ],
      }),
    ]) {
      await assert.rejects(
        catalog.replaceProject(before, next),
        /Invalid local|pointer is inconsistent|duplicate web-app|UNIQUE constraint failed: web_apps/,
      );
      assert.deepEqual(await catalog.readProject(before.relativePath), before);
    }
  });
});

test('local catalog materializes retained history without unbounded parallel artifact reads', async (t) => {
  await fixture(async (catalog) => {
    const before = project();
    await catalog.importProject(before);
    const original = ImmutableLocalArtifactStore.prototype.read;
    let active = 0,
      peak = 0;
    const mocked = t.mock.method(
      ImmutableLocalArtifactStore.prototype,
      'read',
      async function (this: ImmutableLocalArtifactStore, hash: string) {
        active += 1;
        peak = Math.max(peak, active);
        try {
          return await original.call(this, hash);
        } finally {
          active -= 1;
        }
      },
    );
    try {
      assert.deepEqual(await catalog.readProject(before.relativePath), before);
      assert.equal(peak, 1);
      assert.equal(active, 0);
    } finally {
      mocked.mock.restore();
    }
  });
});

test('local catalog rolls back a failed project update without changing the route or child rows', async () => {
  await fixture(async (catalog) => {
    const before = project();
    const other = project({
      workflowId: 'other-id',
      relativePath: 'other.rivet-project',
      endpointName: 'other-latest',
      publishedEndpointName: 'other',
      publishedVersionId: null,
      publishedVersions: [],
      publishedWebApps: [],
    });
    await catalog.importProject(before);
    await catalog.importProject(other);
    await assert.rejects(
      catalog.replaceProject(
        before,
        project({
          endpointName: 'other-latest',
          publishedVersions: [],
          publishedVersionId: null,
          publishedWebApps: [],
        }),
      ),
      /UNIQUE constraint failed/,
    );
    assert.deepEqual(await catalog.readProject(before.relativePath), before);
    assert.deepEqual(await catalog.readProject(other.relativePath), other);
  });
});

test('local project replacement rechecks indexed row integrity inside the commit transaction', async (t) => {
  await fixture(async (catalog, root) => {
    const before = project();
    await catalog.importProject(before);
    const originalPut = ImmutableLocalArtifactStore.prototype.putBytes;
    let corrupted = false;
    const intercepted = t.mock.method(
      ImmutableLocalArtifactStore.prototype,
      'putBytes',
      async function (this: ImmutableLocalArtifactStore, bytes: Uint8Array) {
        const ref = await originalPut.call(this, bytes);
        if (!corrupted) {
          corrupted = true;
          const db = new DatabaseSync(path.join(root, 'catalog.sqlite'));
          try {
            db.prepare('UPDATE projects SET endpoint_name = ? WHERE workflow_id = ?').run(
              'unexpected-route',
              before.workflowId,
            );
          } finally {
            db.close();
          }
        }
        return ref;
      },
    );
    try {
      await assert.rejects(catalog.replaceProject(before, project({ contents: 'new bytes' })), /row is inconsistent/);
      assert.equal(corrupted, true);
      const db = new DatabaseSync(path.join(root, 'catalog.sqlite'), { readOnly: true });
      try {
        const row = db.prepare('SELECT metadata_json FROM projects').get() as { metadata_json: string };
        assert.equal((JSON.parse(row.metadata_json) as { name: string }).name, before.name);
        assert.deepEqual(
          (JSON.parse(row.metadata_json) as { publishedVersionId: string }).publishedVersionId,
          before.publishedVersionId,
        );
      } finally {
        db.close();
      }
    } finally {
      intercepted.mock.restore();
    }
  });
});

test('local catalog detects missing or corrupt referenced artifact bytes', async () => {
  await fixture(async (catalog, root) => {
    const source = project();
    await catalog.importProject(source);
    const db = new DatabaseSync(path.join(root, 'catalog.sqlite'), { readOnly: true });
    const row = db.prepare('SELECT metadata_json FROM projects').get() as { metadata_json: string };
    db.close();
    const ref = (JSON.parse(row.metadata_json) as { contents: { hash: string } }).contents;
    const file = path.join(root, 'objects', ref.hash.slice(0, 2), ref.hash);
    await fs.writeFile(file, 'corruption');
    await assert.rejects(catalog.verifyExact([], [source]), /unexpected size|checksum/);
  });
});

test('local catalog rejects invalid UTF-8 artifacts even when their hash and decoded text appear to match', async () => {
  await fixture(async (catalog, root) => {
    const source = project({ contents: '\ufffd' });
    await catalog.importProject(source);
    const invalidBytes = Buffer.from([0xff]);
    const ref = await new ImmutableLocalArtifactStore(path.join(root, 'objects')).putBytes(invalidBytes);
    assert.equal(ref.hash, createHash('sha256').update(invalidBytes).digest('hex'));
    const db = new DatabaseSync(path.join(root, 'catalog.sqlite'));
    try {
      const row = db.prepare('SELECT metadata_json FROM projects').get() as { metadata_json: string };
      const stored = JSON.parse(row.metadata_json) as { contents: typeof ref };
      stored.contents = ref;
      db.prepare('UPDATE projects SET metadata_json = ?').run(JSON.stringify(stored));
    } finally {
      db.close();
    }
    await assert.rejects(catalog.readProject(source.relativePath), /not valid UTF-8/);
    await assert.rejects(catalog.verifyExact([], [source]), /not valid UTF-8/);
  });
});

test('local catalog snapshots caller-owned data before asynchronous imports and replacement', async () => {
  await fixture(async (catalog) => {
    const input = project();
    const expected = structuredClone(input);
    const importing = catalog.importProject(input);
    input.name = 'changed after invocation';
    input.contents = 'changed bytes';
    input.publishedWebApps[0]!.allowedEmails.push('unexpected@example.com');
    await importing;
    assert.deepEqual(await catalog.readProject(expected.relativePath), expected);

    const next = project({ contents: 'intended replacement' });
    const expectedNext = structuredClone(next);
    const replacing = catalog.replaceProject(expected, next);
    next.contents = 'changed replacement';
    next.publishedVersions[0]!.comment = 'changed after invocation';
    await replacing;
    assert.deepEqual(await catalog.readProject(expectedNext.relativePath), expectedNext);

    const run = recording();
    const expectedRun = structuredClone(run);
    const importingRun = catalog.importRecording(run);
    run.recordingContents = 'changed recording';
    run.executionIdentity = { surface: 'editor_local' };
    await importingRun;
    assert.deepEqual(await catalog.readRecording(run.recordingId), expectedRun);

    const runtime = {
      manifest: { packages: { example: { name: 'example', version: '1.0.0' } }, updatedAt: 'original' },
      archive: Buffer.from('original archive'),
    };
    const expectedRuntime = { manifest: structuredClone(runtime.manifest), archive: Buffer.from(runtime.archive) };
    const importingRuntime = catalog.importRuntimeLibraryState(runtime);
    runtime.manifest.packages.example.version = '2.0.0';
    runtime.archive.fill(0);
    await importingRuntime;
    assert.deepEqual(await catalog.readRuntimeLibraryState(), expectedRuntime);
  });
});

test('local recording metadata and replay bytes are exact, keyed by run ID, and tied to a project', async () => {
  await fixture(async (catalog, root) => {
    const sourceProject = project();
    const sourceRun = recording();
    await assert.rejects(catalog.importRecording(sourceRun), /FOREIGN KEY constraint failed/);
    await catalog.importProject(sourceProject);
    await catalog.importRecording(sourceRun);
    await catalog.importRecording(sourceRun);
    await catalog.verifyRecordingsExact([sourceRun]);
    await assert.rejects(catalog.importRecording(recording({ status: 'failed' })), /differs on retry/);
    await assert.rejects(catalog.verifyRecordingsExact([]), /recording set differs/);
    catalog.close();
    const reopened = new LocalWorkflowCatalog({
      databasePath: path.join(root, 'catalog.sqlite'),
      artifactRoot: path.join(root, 'objects'),
    });
    try {
      reopened.initialize({ verifyOnly: true });
      assert.deepEqual(await reopened.readRecording('run-1'), sourceRun);
      await reopened.verifyRecordingsExact([sourceRun]);
    } finally {
      reopened.close();
    }
  });
});

test('catalog verification compares payload bytes without reserializing them and ignores absent optional metadata', async () => {
  await fixture(async (catalog) => {
    await catalog.importProject(project());
    const source = recording({
      recordingContents: 'x'.repeat(1048576),
      executionIdentity: { surface: 'workflow_endpoint', graphId: 'graph', graphName: undefined },
    });
    await catalog.importRecording(source);
    const stringify = JSON.stringify;
    JSON.stringify = ((value: unknown, ...args: unknown[]) => {
      if (
        value &&
        typeof value === 'object' &&
        typeof (value as { recordingContents?: unknown }).recordingContents === 'string'
      ) {
        throw new Error('Verification must not serialize the full recording payload.');
      }
      return Reflect.apply(stringify, JSON, [value, ...args]);
    }) as typeof JSON.stringify;
    try {
      const reordered = { ...source, executionIdentity: { graphId: 'graph', surface: 'workflow_endpoint' as const } };
      await catalog.importRecording(reordered);
      await catalog.verifyRecordingsExact([reordered]);
      await assert.rejects(
        catalog.verifyRecordingsExact([{ ...reordered, recordingContents: `${source.recordingContents} ` }]),
        /differs from source/,
      );
    } finally {
      JSON.stringify = stringify;
    }
  });
});

test('local runtime-library activation and archive are exact across restart', async () => {
  await fixture(async (catalog, root) => {
    const state = {
      manifest: {
        packages: { example: { name: 'example', version: '1.0.0' } },
        updatedAt: '2026-01-01T00:00:00.000Z',
        activeReleaseId: 'local-release',
      },
      archive: Buffer.from('installed package bytes'),
    };
    await catalog.importRuntimeLibraryState(state);
    await catalog.importRuntimeLibraryState(state);
    await assert.rejects(
      catalog.importRuntimeLibraryState({ ...state, archive: null }),
      /archive does not match package state/,
    );
    await assert.rejects(
      catalog.importRuntimeLibraryState({ ...state, archive: Buffer.from('other bytes') }),
      /differs on retry/,
    );
    catalog.close();
    const reopened = new LocalWorkflowCatalog({
      databasePath: path.join(root, 'catalog.sqlite'),
      artifactRoot: path.join(root, 'objects'),
    });
    try {
      reopened.initialize({ verifyOnly: true });
      assert.deepEqual(await reopened.readRuntimeLibraryState(), state);
    } finally {
      reopened.close();
    }
    const db = new DatabaseSync(path.join(root, 'catalog.sqlite'), { readOnly: true });
    const row = db.prepare("SELECT metadata_json FROM runtime_library_state WHERE slot = 'default'").get() as {
      metadata_json: string;
    };
    db.close();
    const ref = (JSON.parse(row.metadata_json) as { archive: { hash: string } }).archive;
    await fs.writeFile(path.join(root, 'objects', ref.hash.slice(0, 2), ref.hash), 'corrupt archive');
    const verifier = new LocalWorkflowCatalog({
      databasePath: path.join(root, 'catalog.sqlite'),
      artifactRoot: path.join(root, 'objects'),
    });
    try {
      verifier.initialize({ verifyOnly: true });
      await assert.rejects(verifier.readRuntimeLibraryState(), /unexpected size|checksum/);
    } finally {
      verifier.close();
    }
  });
});

test('local catalog refuses unidentified or invalid candidate databases', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-local-catalog-'));
  try {
    const databasePath = path.join(root, 'catalog.sqlite');
    const catalog = new LocalWorkflowCatalog({ databasePath, artifactRoot: path.join(root, 'objects') });
    assert.throws(() => catalog.initialize({ verifyOnly: true }), /does not exist/);
    const unrelated = new DatabaseSync(databasePath);
    unrelated.exec('CREATE TABLE sqliteXunrelated (id INTEGER)');
    unrelated.close();
    assert.throws(() => catalog.initialize(), /unidentified database/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('local catalog rejects unexpected schema objects before serving candidate data', async () => {
  await fixture(async (catalog, root) => {
    catalog.close();
    const raw = new DatabaseSync(path.join(root, 'catalog.sqlite'));
    raw.exec('CREATE VIEW unexpected AS SELECT workflow_id FROM projects');
    raw.close();
    const reopened = new LocalWorkflowCatalog({
      databasePath: path.join(root, 'catalog.sqlite'),
      artifactRoot: path.join(root, 'objects'),
    });
    assert.throws(() => reopened.initialize({ verifyOnly: true }), /unexpected objects/);
  });
});

test('frozen filesystem tree stages into the catalog and can be verified without mutation', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-local-catalog-source-'));
  const sourceRoot = path.join(root, 'workflows');
  const databasePath = path.join(root, 'catalog.sqlite');
  const artifactRoot = path.join(root, 'objects');
  try {
    await fs.mkdir(path.join(sourceRoot, 'folder'), { recursive: true });
    await fs.mkdir(path.join(sourceRoot, 'empty'));
    await fs.writeFile(path.join(sourceRoot, 'folder', 'story.rivet-project'), createBlankProjectFile('story'));
    await withEnvOverride('RIVET_EXTRA_ROOTS', root, async () => {
      const catalog = new LocalWorkflowCatalog({ databasePath, artifactRoot });
      try {
        const report = await stageFrozenWorkflowCatalog({ sourceRoot, catalog, assertFrozen: async () => {} });
        assert.deepEqual(report, { folders: 2, projects: 1, publishedVersions: 0, publishedWebApps: 0 });
        assert.deepEqual(catalog.listFolders(), ['empty', 'folder']);
        assert.deepEqual(catalog.listProjectPaths(), ['folder/story.rivet-project']);
      } finally {
        catalog.close();
      }
      const verifier = new LocalWorkflowCatalog({ databasePath, artifactRoot });
      try {
        const report = await stageFrozenWorkflowCatalog({
          sourceRoot,
          catalog: verifier,
          verifyOnly: true,
          assertFrozen: async () => {},
        });
        assert.equal(report.projects, 1);
      } finally {
        verifier.close();
      }
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('frozen conversion preserves shared preferences and project-scoped legacy web-app bindings', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-shared-endpoint-source-'));
  const sourceRoot = path.join(root, 'workflows');
  const databasePath = path.join(root, 'catalog.sqlite');
  const artifactRoot = path.join(root, 'objects');
  const catalog = new LocalWorkflowCatalog({ databasePath, artifactRoot });
  try {
    await fs.mkdir(path.join(sourceRoot, '.published'), { recursive: true });
    await withEnvOverride('RIVET_EXTRA_ROOTS', root, async () => {
      const originals = new Map<string, string>();
      const write = async (file: string, contents: string) => {
        originals.set(file, contents);
        await fs.writeFile(file, contents);
      };
      for (const name of ['archived', 'copy', 'live']) {
        await write(path.join(sourceRoot, `${name}.rivet-project`), createBlankProjectFile(name));
      }
      const initial = await collectSourceWorkflows(sourceRoot);
      const publishedAt = '2026-01-01T00:00:00.000Z';
      for (const source of initial) {
        const file = path.join(sourceRoot, source.relativePath);
        const versionId = `${source.name}-version`;
        const stateHash = createWorkflowPublicationStateHashFromContents(source.contents, null, 'shared');
        await write(
          getWorkflowProjectSettingsPath(file),
          JSON.stringify({
            endpointName: 'shared',
            publicationVersion: '2',
            publishedWebApps:
              source.name === 'copy'
                ? []
                : [
                    {
                      uiGraphId: 'shared-ui',
                      slug: `${source.name}-app`,
                      publishedSnapshotId: versionId,
                      publishedAt,
                    },
                  ],
            ...(source.name === 'copy' ? {} : { lastPublishedAt: publishedAt }),
            ...(source.name === 'live'
              ? { publishedEndpointName: 'shared', publishedSnapshotId: versionId, publishedStateHash: stateHash }
              : {}),
          }),
        );
        if (source.name === 'copy') continue;
        await write(path.join(sourceRoot, '.published', `${versionId}.rivet-project`), source.contents);
        await write(
          path.join(sourceRoot, '.published', `${versionId}.json`),
          JSON.stringify({
            version: 1,
            id: versionId,
            projectId: source.workflowId,
            projectName: source.name,
            relativePath: source.relativePath,
            endpointName: 'shared',
            publishedAt,
            stateHash,
          }),
        );
      }
      const sources = await collectSourceWorkflows(sourceRoot);
      assert.equal(sources.filter((source) => source.publishedContents !== null).length, 1);
      assert.deepEqual(
        sources.flatMap((source) => source.publishedWebApps.map((app) => app.appId)),
        ['legacy:shared-ui', 'legacy:shared-ui'],
      );
      assert.deepEqual(await checkLocalWorkflowSource(sourceRoot), { projects: 3, folders: 0 });
      const assertFrozen = async () => {};
      for (let attempt = 0; attempt < 2; attempt++) {
        const report = await stageFrozenWorkflowCatalog({ sourceRoot, catalog, assertFrozen });
        assert.deepEqual(report, { folders: 0, projects: 3, publishedVersions: 2, publishedWebApps: 2 });
      }
      catalog.close();
      const report = await verifySqliteWorkflowServing({
        databasePath,
        artifactRoot,
        virtualRoot: sourceRoot,
        folders: [],
        projects: sources,
        recordings: [],
        assertFrozen,
      });
      assert.deepEqual(report, { projects: 3, endpoints: 2, publishedVersions: 2, webApps: 2, recordings: 0 });
      // A real slug conflict must fail inspection, not first surface after backup/copy.
      const archivedPath = path.join(sourceRoot, 'archived.rivet-project');
      const settingsFile = getWorkflowProjectSettingsPath(archivedPath);
      const settings = JSON.parse(originals.get(settingsFile)!);
      settings.publishedWebApps[0].slug = 'LIVE-APP';
      await fs.writeFile(settingsFile, JSON.stringify(settings));
      await assert.rejects(checkLocalWorkflowSource(sourceRoot), (error) => {
        const failure = localUpgradeFailure('workflows', error);
        assert.equal(failure.reason, 'publication-route-conflict');
        assert.ok(failure.sourceReference);
        return true;
      });
      await fs.writeFile(settingsFile, originals.get(settingsFile)!);
      const activeSettings = JSON.parse(originals.get(settingsFile)!);
      Object.assign(activeSettings, {
        endpointName: 'SHARED',
        publishedEndpointName: 'shared',
        publishedSnapshotId: 'archived-version',
        publishedStateHash: createWorkflowPublicationStateHashFromContents(
          originals.get(archivedPath)!,
          null,
          'shared',
        ),
      });
      await fs.writeFile(settingsFile, JSON.stringify(activeSettings));
      await assert.rejects(checkLocalWorkflowSource(sourceRoot), (error) => {
        const failure = localUpgradeFailure('workflows', error);
        assert.equal(failure.reason, 'publication-route-conflict');
        assert.equal(failure.sourceReference, localUpgradeSourceReference('live.rivet-project'));
        return true;
      });
      await fs.writeFile(settingsFile, originals.get(settingsFile)!);
      for (const [file, contents] of originals) assert.equal(await fs.readFile(file, 'utf8'), contents);
    });
  } finally {
    catalog.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('frozen tree staging rejects a source change after candidate rows commit', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-local-catalog-drift-'));
  const sourceRoot = path.join(root, 'workflows');
  const projectPath = path.join(sourceRoot, 'story.rivet-project');
  const catalog = new LocalWorkflowCatalog({
    databasePath: path.join(root, 'catalog.sqlite'),
    artifactRoot: path.join(root, 'objects'),
  });
  try {
    await fs.mkdir(sourceRoot);
    await fs.writeFile(projectPath, createBlankProjectFile('story'));
    await withEnvOverride('RIVET_EXTRA_ROOTS', root, async () => {
      let checks = 0;
      await assert.rejects(
        stageFrozenWorkflowCatalog({
          sourceRoot,
          catalog,
          assertFrozen: async () => {
            checks += 1;
            if (checks === 3) await fs.writeFile(projectPath, createBlankProjectFile('changed'));
          },
        }),
        /differs from source/,
      );
    });
  } finally {
    catalog.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('frozen recording bundles stage by run ID and missing replay bytes block verification', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-local-recording-source-'));
  const sourceRoot = path.join(root, 'workflows');
  const recordingsRoot = path.join(root, 'recordings');
  const projectPath = path.join(sourceRoot, 'story.rivet-project');
  const catalog = new LocalWorkflowCatalog({
    databasePath: path.join(root, 'catalog.sqlite'),
    artifactRoot: path.join(root, 'objects'),
  });
  try {
    await fs.mkdir(sourceRoot);
    await fs.writeFile(projectPath, createBlankProjectFile('story'));
    await withEnvOverride('RIVET_EXTRA_ROOTS', root, async () => {
      const [sourceProject] = await collectSourceWorkflows(sourceRoot);
      assert.ok(sourceProject);
      const bundlePath = path.join(recordingsRoot, sourceProject.workflowId, 'run-1');
      await fs.mkdir(bundlePath, { recursive: true });
      const recordingText = '{"input":1}';
      const replayText = sourceProject.contents;
      await fs.writeFile(getRecordingArtifactPath(bundlePath, 'recording', 'identity'), recordingText);
      const replayPath = getRecordingArtifactPath(bundlePath, 'replay-project', 'identity');
      await fs.writeFile(replayPath, replayText);
      await fs.writeFile(
        path.join(bundlePath, 'metadata.json'),
        JSON.stringify({
          version: 3,
          id: 'run-1',
          workflowId: sourceProject.workflowId,
          sourceProjectMetadataId: sourceProject.workflowId,
          sourceProjectName: 'story',
          sourceProjectPath: projectPath,
          sourceProjectRelativePath: 'story.rivet-project',
          endpointNameAtExecution: 'story',
          createdAt: '2026-01-03T00:00:00.000Z',
          runKind: 'published',
          status: 'succeeded',
          durationMs: 120,
          encoding: 'identity',
          hasReplayDataset: false,
          recordingCompressedBytes: Buffer.byteLength(recordingText),
          recordingUncompressedBytes: Buffer.byteLength(recordingText),
          projectCompressedBytes: Buffer.byteLength(replayText),
          projectUncompressedBytes: Buffer.byteLength(replayText),
          datasetCompressedBytes: 0,
          datasetUncompressedBytes: 0,
        }),
      );
      const assertFrozen = async () => {};
      await stageFrozenWorkflowCatalog({ sourceRoot, catalog, assertFrozen });
      assert.equal(await stageFrozenRecordingCatalog({ sourceRoot, recordingsRoot, catalog, assertFrozen }), 1);
      assert.deepEqual(catalog.listRecordingIds(), ['run-1']);
      catalog.close();
      const verifier = new LocalWorkflowCatalog({
        databasePath: path.join(root, 'catalog.sqlite'),
        artifactRoot: path.join(root, 'objects'),
      });
      try {
        assert.equal(
          await stageFrozenRecordingCatalog({
            sourceRoot,
            recordingsRoot,
            catalog: verifier,
            assertFrozen,
            verifyOnly: true,
          }),
          1,
        );
        await fs.rm(replayPath);
        await assert.rejects(
          stageFrozenRecordingCatalog({
            sourceRoot,
            recordingsRoot,
            catalog: verifier,
            assertFrozen,
            verifyOnly: true,
          }),
          /ENOENT/,
        );
      } finally {
        verifier.close();
      }
    });
  } finally {
    catalog.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('legacy recording bundles may have gzip recording bytes and an identity replay project', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-local-recording-legacy-'));
  try {
    await withEnvOverride('RIVET_EXTRA_ROOTS', root, async () => {
      const bundle = path.join(root, 'recordings', 'project-id', 'run-1');
      await fs.mkdir(bundle, { recursive: true });
      await fs.writeFile(getRecordingArtifactPath(bundle, 'recording', 'gzip'), gzipSync('{"input":1}'));
      await fs.writeFile(getRecordingArtifactPath(bundle, 'replay-project', 'identity'), 'legacy replay');
      await fs.writeFile(
        path.join(bundle, 'metadata.json'),
        JSON.stringify({
          version: 1,
          id: 'run-1',
          sourceProjectMetadataId: 'project-id',
          sourceProjectName: 'story',
          sourceProjectPath: path.join(root, 'story.rivet-project'),
          sourceProjectRelativePath: 'folder/story.rivet-project',
          endpointNameAtExecution: 'story',
          createdAt: '2026-01-03T00:00:00.000Z',
          runKind: 'published',
          status: 'succeeded',
          durationMs: 120,
          recordingPath: 'recording.rivet-recording.gz',
          replayProjectPath: 'replay.rivet-project',
        }),
      );
      const source = await collectSourceRecordings(path.join(root, 'recordings'), [project()]);
      assert.equal(source.length, 1);
      assert.equal(source[0]?.recordingContents, '{"input":1}');
      assert.equal(source[0]?.replayProjectContents, 'legacy replay');
      await fixture(async (catalog, catalogRoot) => {
        await catalog.importProject(project());
        for await (const entry of iterateSourceRecordingImports(path.join(root, 'recordings'), [project()])) {
          await catalog.importRecording(entry.recording, { sources: entry.artifacts, compression: 'identity' });
          await catalog.verifyRecordingsExact([entry.recording]);
        }
        const bytes = gzipSync('{"input":1}');
        const hash = createHash('sha256').update(bytes).digest('hex');
        assert.deepEqual(await fs.readFile(path.join(catalogRoot, 'objects', hash.slice(0, 2), hash)), bytes);
        const [metadata] = catalog.listRecordingMetadata();
        assert.equal(metadata?.recordingBytes, bytes.length);
        assert.equal(metadata?.projectBytes, Buffer.byteLength('legacy replay'));
      });
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('recording source bytes must still match the scanned contents before publication', async () => {
  await fixture(async (catalog, root) => {
    await catalog.importProject(project());
    const snapshot = recording();
    const recordingPath = path.join(root, 'source-recording.gz');
    const projectPath = path.join(root, 'source-project');
    await fs.writeFile(recordingPath, gzipSync(snapshot.recordingContents.replace('1', '2')));
    await fs.writeFile(projectPath, snapshot.replayProjectContents);
    await assert.rejects(
      catalog.importRecording(snapshot, {
        sources: {
          recordingContents: {
            path: recordingPath,
            encoding: 'gzip',
            decodedSize: Buffer.byteLength(snapshot.recordingContents),
          },
          replayProjectContents: {
            path: projectPath,
            encoding: 'identity',
            decodedSize: Buffer.byteLength(snapshot.replayProjectContents),
          },
          replayDatasetContents: null,
        },
      }),
      /changed before publication/,
    );
    assert.deepEqual(catalog.listRecordingIds(), []);
  });
});

test('local recording conversion rejects metadata that would silently reinterpret or omit payloads', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-local-recording-strict-'));
  try {
    await withEnvOverride('RIVET_EXTRA_ROOTS', root, async () => {
      const bundle = path.join(root, 'recordings', 'project-id', 'run-1');
      await fs.mkdir(bundle, { recursive: true });
      const payload = '{"input":1}';
      const replay = 'replay bytes';
      await fs.writeFile(getRecordingArtifactPath(bundle, 'recording', 'identity'), payload);
      await fs.writeFile(getRecordingArtifactPath(bundle, 'replay-project', 'identity'), replay);
      const metadata = {
        version: 3,
        id: 'run-1',
        workflowId: 'project-id',
        sourceProjectMetadataId: 'project-id',
        sourceProjectName: 'original name',
        sourceProjectPath: path.join(root, 'original.rivet-project'),
        sourceProjectRelativePath: 'old-folder/original.rivet-project',
        endpointNameAtExecution: 'old-route',
        createdAt: '2026-01-03T00:00:00.000Z',
        runKind: 'published',
        status: 'succeeded',
        durationMs: 120,
        encoding: 'identity',
        hasReplayDataset: false,
        recordingCompressedBytes: Buffer.byteLength(payload),
        recordingUncompressedBytes: Buffer.byteLength(payload),
        projectCompressedBytes: Buffer.byteLength(replay),
        projectUncompressedBytes: Buffer.byteLength(replay),
        datasetCompressedBytes: 0,
        datasetUncompressedBytes: 0,
      };
      const metadataPath = path.join(bundle, 'metadata.json');
      await fs.writeFile(metadataPath, JSON.stringify(metadata));
      const source = await collectSourceRecordings(path.join(root, 'recordings'), [project()]);
      assert.equal(source[0]?.sourceProjectName, 'original name');
      assert.equal(source[0]?.sourceProjectRelativePath, 'old-folder/original.rivet-project');
      const corruptions: Array<Record<string, unknown>> = [
        { encoding: 'unknown' },
        { hasReplayDataset: 'false' },
        { durationMs: -1 },
        { recordingCompressedBytes: -1 },
        { recordingUncompressedBytes: 999 },
      ];
      for (const corruption of corruptions) {
        await fs.writeFile(metadataPath, JSON.stringify({ ...metadata, ...corruption }));
        await assert.rejects(
          collectSourceRecordings(path.join(root, 'recordings'), [project()]),
          /metadata is invalid|size differs from metadata/,
        );
      }
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
