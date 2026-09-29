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
import { collectSourceWorkflows } from '../local-metadata/filesystem-workflow-source.js';
import { collectSourceRecordings } from '../local-metadata/filesystem-recording-source.js';
import { createBlankProjectFile, getWorkflowDatasetPath } from '../routes/workflows/fs-helpers.js';
import { getRecordingArtifactPath } from '../routes/workflows/recordings-artifacts.js';
import { decodeMigrationSourceUtf8 } from '../scripts/migration-source-utf8.js';
import { ImmutableLocalArtifactStore } from '../local-metadata/immutable-artifact-store.js';
import { withEnvOverride } from './helpers/workflow-api-harness.js';

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
          { before: other, after: { ...other, relativePath: 'new/other.rivet-project', endpointName: 'STORY' } },
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
    ]) {
      await assert.rejects(
        catalog.replaceProject(before, next),
        /Invalid local|pointer is inconsistent|duplicate web-app/,
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
    unrelated.exec('CREATE TABLE unrelated (id INTEGER)');
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
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
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
