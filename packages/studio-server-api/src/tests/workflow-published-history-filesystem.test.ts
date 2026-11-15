import assert from 'node:assert/strict';
// test-style: fixture-read: reads serialized project fixtures and test-owned persisted artifacts, never implementation source.
import fs from 'node:fs/promises';
import test from 'node:test';
import { observeFilesystemExecutionInvalidations, readJson } from './helpers/workflow-api-harness.js';
import { createFilesystemWorkflowSuiteHarness } from './helpers/workflow-filesystem-suite-harness.js';
import type {
  WorkflowProjectWebAppsResponse,
  WorkflowPublishedVersionCommentResponse,
  WorkflowPublishedVersionPreviewResponse,
  WorkflowPublishedVersionRestoreResponse,
  WorkflowPublishedVersionStarResponse,
  WorkflowPublishedVersionsResponse,
  WorkflowTreeResponse,
} from '../../../studio-server-shared/workflow-types.js';

const {
  workflowsRoot,
  workflowMutations,
  workflowFs,
  workflowPublication,
  workflowStorageBackend,
  filesystemExecutionCache,
  rivetNode,
  withWorkflowApiServer,
  resetAndEnsureWorkflowsRoot,
  cleanupWorkflowSuite,
} = await createFilesystemWorkflowSuiteHarness();

test.beforeEach(resetAndEnsureWorkflowsRoot);
test.after(cleanupWorkflowSuite);

test('published history HTTP routes preserve saved bytes, annotations and reviewed restoration', async (t) => {
  const created = await workflowMutations.createWorkflowProjectItem('', "PublishedHistory café's (draft)");
  const firstContents = await fs.readFile(created.absolutePath, 'utf8');
  // Invalid UTF-8 distinguishes preserving the snapshot bytes from decoding and
  // re-encoding them. The JSON preview still exposes the existing text view.
  const firstDatasetBytes = Buffer.from([0, 255, 254, 13, 10]);
  const firstDatasetContents = firstDatasetBytes.toString('utf8');
  const datasetPath = workflowFs.getWorkflowDatasetPath(created.absolutePath);
  await fs.writeFile(datasetPath, firstDatasetBytes);

  await workflowMutations.publishWorkflowProjectItem(created.relativePath, {
    endpointName: 'published-history-endpoint',
  });

  const secondProject = rivetNode.loadProjectFromString(firstContents);
  secondProject.metadata.description = 'second published version';
  const secondContents = rivetNode.serializeProject(secondProject);
  assert.ok(typeof secondContents === 'string');
  assert.notEqual(secondContents, firstContents);
  await fs.writeFile(created.absolutePath, secondContents, 'utf8');
  await fs.writeFile(workflowFs.getWorkflowDatasetPath(created.absolutePath), 'second published dataset', 'utf8');
  await workflowMutations.publishWorkflowProjectItem(created.relativePath, {
    endpointName: 'published-history-endpoint',
  });

  await withWorkflowApiServer(async (baseUrl) => {
    const url = `${baseUrl}/projects/published-versions`;
    const query = new URLSearchParams({ relativePath: created.relativePath });
    const request = (action: string, body: object, method = 'POST') =>
      fetch(`${url}/${action}`, {
        method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ relativePath: created.relativePath, ...body }),
      });
    const readHistory = () => fetch(`${url}?${query}`).then(readJson<WorkflowPublishedVersionsResponse>);
    const treeState = async () => (await readJson<WorkflowTreeResponse>(await fetch(`${baseUrl}/tree`))).sync;
    const reviewedState = async () => {
      const snapshot = await readJson<WorkflowProjectWebAppsResponse>(
        await fetch(`${baseUrl}/projects/web-apps?${query}`),
      );
      return {
        expectedProjectId: snapshot.projectId,
        expectedPublicationVersion: snapshot.publicationVersion,
        expectedDraftRevisionId: snapshot.draftRevisionId,
      };
    };
    const history = await readHistory();
    assert.equal(history.versions.length, 2);
    assert.equal(history.versions[0]?.isCurrent, true);
    assert.equal(history.versions[1]?.isCurrent, false);
    assert.equal(history.versions[0]?.endpointName, 'published-history-endpoint');
    assert.equal(history.versions[0]?.isStarred, false);
    assert.equal(history.versions[0]?.comment, '');

    for (const route of ['/projects/published-versions', '/projects/web-apps']) {
      const normal = await fetch(`${baseUrl}${route}?${query}`);
      assert.equal(normal.status, 200);
      assert.equal(normal.headers.get('cache-control'), 'no-store, no-cache, must-revalidate');
      assert.equal(normal.headers.get('pragma'), 'no-cache');
      const body = await normal.text();
      const trailingSlash = await fetch(`${baseUrl}${route}/?${query}`);
      assert.equal(trailingSlash.status, 200);
      assert.equal(await trailingSlash.text(), body);
      const head = await fetch(`${baseUrl}${route}?${query}`, { method: 'HEAD' });
      assert.equal(head.status, 200);
      assert.equal(await head.text(), '');
      for (const name of ['content-type', 'content-length', 'etag']) {
        assert.equal(head.headers.get(name), normal.headers.get(name), name);
      }
      // The existing middleware applies its cache policy to GET only.
      assert.equal(head.headers.get('cache-control'), null);
    }

    const beforeAnnotations = await treeState();
    const starred = await readJson<WorkflowPublishedVersionStarResponse>(
      await request('star', { versionId: history.versions[1]!.id, isStarred: true }, 'PATCH'),
    );
    assert.deepEqual(Object.keys(starred), ['version']);
    assert.deepEqual(starred.version, { ...history.versions[1], isStarred: true });

    const commented = await readJson<WorkflowPublishedVersionCommentResponse>(
      await request(
        'comment',
        { versionId: history.versions[1]!.id, comment: '  baseline before model switch  ' },
        'PATCH',
      ),
    );
    assert.deepEqual(Object.keys(commented), ['version']);
    assert.deepEqual(commented.version, { ...starred.version, comment: 'baseline before model switch' });

    const historyAfterStar = await readHistory();
    assert.deepEqual(historyAfterStar, { versions: [history.versions[0], commented.version] });

    for (const [version, contents] of [
      [history.versions[0]!, secondContents],
      [history.versions[1]!, firstContents],
    ] as const) {
      const download = await request('download', { versionId: version.id });
      assert.equal(download.status, 200);
      assert.equal(download.headers.get('content-type'), 'application/x-yaml; charset=utf-8');
      const fileName = `${created.name} [published ${version.publishedAt
        .replace('T', ' ')
        .replace(/\.\d{3}Z$/, 'Z')
        .replace(/:/g, '-')}].rivet-project`;
      assert.equal(
        download.headers.get('content-disposition'),
        `attachment; filename="${fileName.replace('é', '_')}"; filename*=UTF-8''PublishedHistory%20caf%C3%A9%27s%20%28draft%29${encodeURIComponent(fileName.slice(created.name.length))}`,
      );
      assert.equal(await download.text(), contents);
    }
    const preview = await readJson<WorkflowPublishedVersionPreviewResponse>(
      await request('preview', { versionId: history.versions[1]!.id }),
    );
    assert.deepEqual(preview, { contents: firstContents, datasetsContents: firstDatasetContents });
    assert.deepEqual(await treeState(), beforeAnnotations, 'Reading and annotating history do not notify the tree.');

    const stale = await reviewedState();
    secondProject.metadata.description = 'unpublished changes made after review';
    const editedContents = rivetNode.serializeProject(secondProject);
    assert.ok(typeof editedContents === 'string');
    assert.notEqual(editedContents, secondContents);
    await fs.writeFile(created.absolutePath, editedContents);
    for (const [action, body, method, status] of [
      ['preview', { versionId: 'missing-version' }, 'POST', 404],
      ['star', { versionId: history.versions[1]!.id, isStarred: 'true' }, 'PATCH', 400],
      ['comment', { versionId: history.versions[1]!.id, comment: 'x'.repeat(241) }, 'PATCH', 400],
      ['restore', { versionId: history.versions[1]!.id, preconditions: stale }, 'POST', 409],
    ] as const) {
      const response = await request(action, body, method);
      assert.equal(response.status, status, action);
      const error = await response.json();
      assert.equal(typeof error.error, 'string');
      if (action === 'restore') assert.equal(error.code, 'publication_draft_changed');
    }
    assert.deepEqual(await readHistory(), historyAfterStar, 'Rejected requests do not change saved history.');
    assert.equal(await fs.readFile(created.absolutePath, 'utf8'), editedContents);
    assert.deepEqual(await treeState(), beforeAnnotations, 'Rejected requests do not notify the tree.');

    const cacheInvalidations = observeFilesystemExecutionInvalidations(
      t,
      filesystemExecutionCache.getFilesystemExecutionCache(),
    );

    const restored = await readJson<WorkflowPublishedVersionRestoreResponse>(
      await request('restore', { versionId: history.versions[1]!.id, preconditions: await reviewedState() }),
    );
    assert.deepEqual(Object.keys(restored).sort(), ['project', 'version']);
    assert.equal(restored.version.isCurrent, true);
    assert.notEqual(restored.version.id, history.versions[1]!.id);
    assert.equal(restored.version.endpointName, 'published-history-endpoint');
    assert.equal(restored.project.settings.status, 'published');
    assert.equal(cacheInvalidations.markedIndexDirty, true);
    assert.deepEqual(cacheInvalidations.invalidatedMaterializationPathCalls.at(-1), [created.absolutePath]);
    assert.deepEqual(await treeState(), { ...beforeAnnotations, revision: beforeAnnotations.revision + 1 });

    const restoredHistory = await readHistory();
    assert.equal(restoredHistory.versions.length, 3);
    assert.equal(restoredHistory.versions[0]?.id, restored.version.id);
    assert.equal(restoredHistory.versions[0]?.isCurrent, true);
    assert.equal(restoredHistory.versions.filter((version) => version.isCurrent).length, 1);

    const restoredDownload = await request('download', { versionId: restored.version.id });
    assert.equal(restoredDownload.status, 200);
    const restoredPreview = await readJson<WorkflowPublishedVersionPreviewResponse>(
      await request('preview', { versionId: restored.version.id }),
    );
    assert.equal(await restoredDownload.text(), firstContents);
    assert.equal(restoredPreview.datasetsContents, firstDatasetContents);
    assert.equal(await fs.readFile(created.absolutePath, 'utf8'), firstContents);
    assert.deepEqual(await fs.readFile(datasetPath), firstDatasetBytes);
    assert.deepEqual(
      await fs.readFile(workflowFs.getPublishedWorkflowSnapshotDatasetPath(workflowsRoot, restored.version.id)),
      firstDatasetBytes,
    );

    await workflowMutations.unpublishWorkflowProjectItem(created.relativePath);
    const historyAfterUnpublish = await readHistory();
    assert.deepEqual(historyAfterUnpublish, {
      versions: restoredHistory.versions.map((version) => ({ ...version, isCurrent: false })),
    });
  });
});

test('a direct request for corrupt noncurrent history reports corruption instead of not found', async () => {
  const created = await workflowMutations.createWorkflowProjectItem('', 'CorruptOldHistory');
  await workflowMutations.publishWorkflowProjectItem(created.relativePath, { endpointName: 'corrupt-old-history' });
  const first = (await workflowStorageBackend.listWorkflowPublishedVersionsWithBackend(created.relativePath))
    .versions[0]!;
  await workflowMutations.publishWorkflowProjectItem(created.relativePath, { endpointName: 'corrupt-old-history' });
  const metadataPath = workflowFs.getPublishedWorkflowSnapshotMetadataPath(workflowsRoot, first.id);
  await fs.writeFile(metadataPath, '{broken', 'utf8');

  const visible = await workflowStorageBackend.listWorkflowPublishedVersionsWithBackend(created.relativePath);
  assert.equal(visible.versions.length, 1);
  await assert.rejects(
    workflowStorageBackend.setWorkflowPublishedVersionStarWithBackend(created.relativePath, first.id, true),
    /Corrupt published-version metadata/,
  );
  assert.equal(await fs.readFile(metadataPath, 'utf8'), '{broken');
});

test('filesystem published version history exposes legacy current snapshots without metadata', async () => {
  const created = await workflowMutations.createWorkflowProjectItem('', 'PublishedHistoryLegacy');
  const publishedContents = await fs.readFile(created.absolutePath, 'utf8');

  const published = await workflowMutations.publishWorkflowProjectItem(created.relativePath, {
    endpointName: 'published-history-legacy-endpoint',
  });
  const storedSettings = await workflowPublication.readStoredWorkflowProjectSettings(
    published.absolutePath,
    published.name,
  );
  assert.ok(storedSettings.publishedSnapshotId);

  await fs.rm(workflowFs.getPublishedWorkflowSnapshotMetadataPath(workflowsRoot, storedSettings.publishedSnapshotId), {
    force: true,
  });

  const history = await workflowStorageBackend.listWorkflowPublishedVersionsWithBackend(created.relativePath);
  assert.equal(history.versions.length, 1);
  assert.equal(history.versions[0]?.id, storedSettings.publishedSnapshotId);
  assert.equal(history.versions[0]?.isCurrent, true);
  assert.equal(history.versions[0]?.isStarred, false);
  assert.equal(history.versions[0]?.comment, '');

  await workflowMutations.unpublishWorkflowProjectItem(created.relativePath);
  const historyAfterLegacyUnpublish = await workflowStorageBackend.listWorkflowPublishedVersionsWithBackend(
    created.relativePath,
  );

  assert.equal(historyAfterLegacyUnpublish.versions.length, 1);
  assert.equal(historyAfterLegacyUnpublish.versions[0]?.id, storedSettings.publishedSnapshotId);
  assert.equal(historyAfterLegacyUnpublish.versions[0]?.isCurrent, false);
  assert.equal(historyAfterLegacyUnpublish.versions[0]?.isStarred, false);

  const starredLegacyVersion = await workflowStorageBackend.setWorkflowPublishedVersionStarWithBackend(
    created.relativePath,
    historyAfterLegacyUnpublish.versions[0]!.id,
    true,
  );
  assert.equal(starredLegacyVersion.isStarred, true);

  const commentedLegacyVersion = await workflowStorageBackend.setWorkflowPublishedVersionCommentWithBackend(
    created.relativePath,
    historyAfterLegacyUnpublish.versions[0]!.id,
    'legacy keeper',
  );
  assert.equal(commentedLegacyVersion.comment, 'legacy keeper');

  const download = await workflowStorageBackend.readWorkflowPublishedVersionDownloadWithBackend(
    created.relativePath,
    historyAfterLegacyUnpublish.versions[0]!.id,
  );

  assert.equal(download.contents, publishedContents);

  await fs.writeFile(
    created.absolutePath,
    publishedContents.replace('description: ""', 'description: "second version"'),
    'utf8',
  );
  await workflowMutations.publishWorkflowProjectItem(created.relativePath, {
    endpointName: 'published-history-legacy-endpoint',
  });

  const historyAfterSecondPublish = await workflowStorageBackend.listWorkflowPublishedVersionsWithBackend(
    created.relativePath,
  );

  assert.equal(historyAfterSecondPublish.versions.length, 2);
  assert.equal(historyAfterSecondPublish.versions[0]?.isCurrent, true);
  assert.equal(historyAfterSecondPublish.versions[1]?.id, storedSettings.publishedSnapshotId);
  assert.equal(historyAfterSecondPublish.versions[1]?.isStarred, true);
  assert.equal(historyAfterSecondPublish.versions[1]?.comment, 'legacy keeper');
});

test('filesystem published version history preserves corrupt metadata and rejects foreign snapshots', async (t) => {
  const created = await workflowMutations.createWorkflowProjectItem('', 'PublishedHistoryMetadataMismatch');
  const published = await workflowMutations.publishWorkflowProjectItem(created.relativePath, {
    endpointName: 'published-history-metadata-mismatch-endpoint',
  });
  const storedSettings = await workflowPublication.readStoredWorkflowProjectSettings(
    published.absolutePath,
    published.name,
  );
  assert.ok(storedSettings.publishedSnapshotId);

  const metadataPath = workflowFs.getPublishedWorkflowSnapshotMetadataPath(
    workflowsRoot,
    storedSettings.publishedSnapshotId,
  );
  const metadata = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
  await fs.writeFile(metadataPath, '{broken', 'utf8');
  await assert.rejects(
    workflowStorageBackend.listWorkflowPublishedVersionsWithBackend(created.relativePath),
    /Corrupt published-version metadata/,
  );
  await fs.writeFile(metadataPath, `${JSON.stringify({ ...metadata, isStarred: 'true' })}\n`, 'utf8');
  await assert.rejects(
    workflowStorageBackend.listWorkflowPublishedVersionsWithBackend(created.relativePath),
    /Corrupt published-version metadata/,
  );
  await fs.writeFile(metadataPath, `${JSON.stringify({ ...metadata, id: 'different-version-id' }, null, 2)}\n`, 'utf8');

  await assert.rejects(
    workflowStorageBackend.listWorkflowPublishedVersionsWithBackend(created.relativePath),
    /Corrupt published-version metadata/,
  );
  await assert.rejects(
    workflowStorageBackend.setWorkflowPublishedVersionStarWithBackend(
      created.relativePath,
      storedSettings.publishedSnapshotId,
      true,
    ),
    /Corrupt published-version metadata/,
  );
  await assert.rejects(
    workflowMutations.publishWorkflowProjectItem(created.relativePath, {
      endpointName: 'published-history-metadata-mismatch-endpoint',
    }),
    /Corrupt published-version metadata/,
  );
  assert.equal(JSON.parse(await fs.readFile(metadataPath, 'utf8')).id, 'different-version-id');

  await fs.writeFile(
    metadataPath,
    `${JSON.stringify({ ...metadata, projectId: 'another-project' }, null, 2)}\n`,
    'utf8',
  );
  await assert.rejects(
    workflowStorageBackend.listWorkflowPublishedVersionsWithBackend(created.relativePath),
    /belongs to a different project/,
  );
  await assert.rejects(
    workflowStorageBackend.setWorkflowPublishedVersionStarWithBackend(
      created.relativePath,
      storedSettings.publishedSnapshotId,
      true,
    ),
    /belongs to a different project/,
  );
  await assert.rejects(
    workflowMutations.publishWorkflowProjectItem(created.relativePath, {
      endpointName: 'published-history-metadata-mismatch-endpoint',
    }),
    /belongs to a different project/,
  );
  assert.equal(JSON.parse(await fs.readFile(metadataPath, 'utf8')).projectId, 'another-project');

  await fs.writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');

  const publishedSnapshotId = storedSettings.publishedSnapshotId;
  assert.ok(publishedSnapshotId);
  const originalContents = await fs.readFile(created.absolutePath, 'utf8');
  const otherProject = await workflowMutations.createWorkflowProjectItem('', 'PublishedHistoryOtherProject');
  await fs.copyFile(
    otherProject.absolutePath,
    workflowFs.getPublishedWorkflowSnapshotPath(workflowsRoot, publishedSnapshotId),
  );
  for (const operation of [
    () =>
      workflowStorageBackend.readWorkflowPublishedVersionDownloadWithBackend(created.relativePath, publishedSnapshotId),
    () =>
      workflowStorageBackend.readWorkflowPublishedVersionPreviewWithBackend(created.relativePath, publishedSnapshotId),
    () =>
      workflowStorageBackend.setWorkflowPublishedVersionStarWithBackend(
        created.relativePath,
        publishedSnapshotId,
        true,
      ),
    () =>
      workflowMutations.publishWorkflowProjectItem(created.relativePath, {
        endpointName: 'published-history-metadata-mismatch-endpoint',
      }),
  ]) {
    await assert.rejects(operation, /Published version snapshot belongs to a different project/);
  }

  await fs.rm(metadataPath);
  await assert.rejects(
    workflowMutations.publishWorkflowProjectItem(created.relativePath, {
      endpointName: 'published-history-metadata-mismatch-endpoint',
    }),
    /Published version snapshot belongs to a different project/,
  );
  await assert.rejects(fs.stat(metadataPath), { code: 'ENOENT' });
  await fs.writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');

  const cacheInvalidations = observeFilesystemExecutionInvalidations(
    t,
    filesystemExecutionCache.getFilesystemExecutionCache(),
  );
  await assert.rejects(
    () => workflowStorageBackend.restoreWorkflowPublishedVersionWithBackend(created.relativePath, publishedSnapshotId),
    /Published version snapshot belongs to a different project/,
  );
  assert.equal(cacheInvalidations.markedIndexDirty, false);
  assert.deepEqual(cacheInvalidations.invalidatedMaterializationPathCalls, []);
  assert.equal(await fs.readFile(created.absolutePath, 'utf8'), originalContents);
});

test('migration history reads refuse corrupt noncurrent evidence without logging or omitting it', async (t) => {
  const created = await workflowMutations.createWorkflowProjectItem('', 'StrictMigrationHistory');
  await workflowMutations.publishWorkflowProjectItem(created.relativePath, {
    endpointName: 'strict-migration-history',
  });
  const first = (await workflowStorageBackend.listWorkflowPublishedVersionsWithBackend(created.relativePath))
    .versions[0]!;
  await workflowMutations.publishWorkflowProjectItem(created.relativePath, {
    endpointName: 'strict-migration-history',
  });
  const metadataPath = workflowFs.getPublishedWorkflowSnapshotMetadataPath(workflowsRoot, first.id);
  const broken = '{private-invalid-metadata';
  await fs.writeFile(metadataPath, broken);
  const warning = t.mock.method(console, 'warn', () => undefined);
  const { readFilesystemPublishedVersionsForMigration } = await import('../routes/workflows/published-versions.js');
  await assert.rejects(
    readFilesystemPublishedVersionsForMigration(workflowsRoot, created.absolutePath),
    /Corrupt published-version metadata/,
  );
  assert.equal(warning.mock.callCount(), 0);
  assert.equal(await fs.readFile(metadataPath, 'utf8'), broken);
});
