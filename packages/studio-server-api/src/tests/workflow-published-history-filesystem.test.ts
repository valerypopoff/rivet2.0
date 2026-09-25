import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import { observeFilesystemExecutionInvalidations } from './helpers/workflow-api-harness.js';
import { createFilesystemWorkflowSuiteHarness } from './helpers/workflow-filesystem-suite-harness.js';

const {
  workflowsRoot,
  workflowMutations,
  workflowFs,
  workflowPublication,
  workflowStorageBackend,
  filesystemExecutionCache,
  resetAndEnsureWorkflowsRoot,
  cleanupWorkflowSuite,
} = await createFilesystemWorkflowSuiteHarness();

test.beforeEach(resetAndEnsureWorkflowsRoot);
test.after(cleanupWorkflowSuite);

test('each filesystem publish creates a downloadable published version history entry', async (t) => {
  const created = await workflowMutations.createWorkflowProjectItem('', 'PublishedHistory');
  const firstContents = await fs.readFile(created.absolutePath, 'utf8');
  const firstDatasetContents = 'first published dataset';
  await fs.writeFile(workflowFs.getWorkflowDatasetPath(created.absolutePath), firstDatasetContents, 'utf8');

  await workflowMutations.publishWorkflowProjectItem(created.relativePath, {
    endpointName: 'published-history-endpoint',
  });

  const secondContents = firstContents.replace('description: ""', 'description: "second published version"');
  await fs.writeFile(created.absolutePath, secondContents, 'utf8');
  await fs.writeFile(workflowFs.getWorkflowDatasetPath(created.absolutePath), 'second published dataset', 'utf8');
  await workflowMutations.publishWorkflowProjectItem(created.relativePath, {
    endpointName: 'published-history-endpoint',
  });

  const history = await workflowStorageBackend.listWorkflowPublishedVersionsWithBackend(created.relativePath);
  assert.equal(history.versions.length, 2);
  assert.equal(history.versions[0]?.isCurrent, true);
  assert.equal(history.versions[1]?.isCurrent, false);
  assert.equal(history.versions[0]?.endpointName, 'published-history-endpoint');
  assert.equal(history.versions[0]?.isStarred, false);
  assert.equal(history.versions[0]?.comment, '');

  const starredVersion = await workflowStorageBackend.setWorkflowPublishedVersionStarWithBackend(
    created.relativePath,
    history.versions[1]!.id,
    true,
  );
  assert.equal(starredVersion.isStarred, true);

  const commentedVersion = await workflowStorageBackend.setWorkflowPublishedVersionCommentWithBackend(
    created.relativePath,
    history.versions[1]!.id,
    '  baseline before model switch  ',
  );
  assert.equal(commentedVersion.comment, 'baseline before model switch');

  const historyAfterStar = await workflowStorageBackend.listWorkflowPublishedVersionsWithBackend(created.relativePath);
  assert.equal(
    historyAfterStar.versions.find((version) => version.id === history.versions[1]!.id)?.isStarred,
    true,
  );
  assert.equal(
    historyAfterStar.versions.find((version) => version.id === history.versions[1]!.id)?.comment,
    'baseline before model switch',
  );

  const currentDownload = await workflowStorageBackend.readWorkflowPublishedVersionDownloadWithBackend(
    created.relativePath,
    history.versions[0]!.id,
  );
  const previousDownload = await workflowStorageBackend.readWorkflowPublishedVersionDownloadWithBackend(
    created.relativePath,
    history.versions[1]!.id,
  );

  assert.equal(currentDownload.contents, secondContents);
  assert.equal(previousDownload.contents, firstContents);
  assert.match(currentDownload.fileName, /^PublishedHistory \[published /);

  const cacheInvalidations = observeFilesystemExecutionInvalidations(
    t,
    filesystemExecutionCache.getFilesystemExecutionCache(),
  );

  const restored = await workflowStorageBackend.restoreWorkflowPublishedVersionWithBackend(
    created.relativePath,
    history.versions[1]!.id,
  );
  assert.equal(restored.version.isCurrent, true);
  assert.notEqual(restored.version.id, history.versions[1]!.id);
  assert.equal(restored.version.endpointName, 'published-history-endpoint');
  assert.equal(restored.project.settings.status, 'published');
  assert.equal(cacheInvalidations.markedIndexDirty, true);
  assert.deepEqual(cacheInvalidations.invalidatedMaterializationPathCalls.at(-1), [created.absolutePath]);

  const restoredHistory = await workflowStorageBackend.listWorkflowPublishedVersionsWithBackend(created.relativePath);
  assert.equal(restoredHistory.versions.length, 3);
  assert.equal(restoredHistory.versions[0]?.id, restored.version.id);
  assert.equal(restoredHistory.versions[0]?.isCurrent, true);
  assert.equal(restoredHistory.versions.filter((version) => version.isCurrent).length, 1);

  const restoredDownload = await workflowStorageBackend.readWorkflowPublishedVersionDownloadWithBackend(
    created.relativePath,
    restored.version.id,
  );
  const restoredPreview = await workflowStorageBackend.readWorkflowPublishedVersionPreviewWithBackend(
    created.relativePath,
    restored.version.id,
  );
  assert.equal(restoredDownload.contents, firstContents);
  assert.equal(restoredPreview.datasetsContents, firstDatasetContents);
  assert.equal(await fs.readFile(created.absolutePath, 'utf8'), firstContents);
  assert.equal(await fs.readFile(workflowFs.getWorkflowDatasetPath(created.absolutePath), 'utf8'), firstDatasetContents);

  await workflowMutations.unpublishWorkflowProjectItem(created.relativePath);
  const historyAfterUnpublish = await workflowStorageBackend.listWorkflowPublishedVersionsWithBackend(created.relativePath);

  assert.equal(historyAfterUnpublish.versions.length, 3);
  assert.equal(historyAfterUnpublish.versions.some((version) => version.isCurrent), false);
  assert.equal(
    historyAfterUnpublish.versions.find((version) => version.id === history.versions[1]!.id)?.isStarred,
    true,
  );
  assert.equal(
    historyAfterUnpublish.versions.find((version) => version.id === history.versions[1]!.id)?.comment,
    'baseline before model switch',
  );
});

test('restoring a published version preserves dataset sidecar bytes', async () => {
  const created = await workflowMutations.createWorkflowProjectItem('', 'PublishedHistoryBytes');
  const datasetPath = workflowFs.getWorkflowDatasetPath(created.absolutePath);
  const originalBytes = Buffer.from([0, 255, 254, 13, 10]);
  await fs.writeFile(datasetPath, originalBytes);
  await workflowMutations.publishWorkflowProjectItem(created.relativePath, {
    endpointName: 'published-history-bytes',
  });
  const history = await workflowStorageBackend.listWorkflowPublishedVersionsWithBackend(created.relativePath);
  const versionId = history.versions[0]?.id;
  assert.ok(versionId);

  await fs.writeFile(datasetPath, 'changed dataset');
  await workflowStorageBackend.restoreWorkflowPublishedVersionWithBackend(created.relativePath, versionId);

  assert.deepEqual(await fs.readFile(datasetPath), originalBytes);
  const restoredHistory = await workflowStorageBackend.listWorkflowPublishedVersionsWithBackend(created.relativePath);
  assert.deepEqual(
    await fs.readFile(workflowFs.getPublishedWorkflowSnapshotDatasetPath(workflowsRoot, restoredHistory.versions[0]!.id)),
    originalBytes,
  );
});

test('a direct request for corrupt noncurrent history reports corruption instead of not found', async () => {
  const created = await workflowMutations.createWorkflowProjectItem('', 'CorruptOldHistory');
  await workflowMutations.publishWorkflowProjectItem(created.relativePath, { endpointName: 'corrupt-old-history' });
  const first = (await workflowStorageBackend.listWorkflowPublishedVersionsWithBackend(created.relativePath)).versions[0]!;
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
  const storedSettings = await workflowPublication.readStoredWorkflowProjectSettings(published.absolutePath, published.name);
  assert.ok(storedSettings.publishedSnapshotId);

  await fs.rm(
    workflowFs.getPublishedWorkflowSnapshotMetadataPath(workflowsRoot, storedSettings.publishedSnapshotId),
    { force: true },
  );

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
  const storedSettings = await workflowPublication.readStoredWorkflowProjectSettings(published.absolutePath, published.name);
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
  await fs.writeFile(
    metadataPath,
    `${JSON.stringify({ ...metadata, id: 'different-version-id' }, null, 2)}\n`,
    'utf8',
  );

  await assert.rejects(
    workflowStorageBackend.listWorkflowPublishedVersionsWithBackend(created.relativePath),
    /Corrupt published-version metadata/,
  );
  await assert.rejects(
    workflowStorageBackend.setWorkflowPublishedVersionStarWithBackend(
      created.relativePath, storedSettings.publishedSnapshotId, true,
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

  await fs.writeFile(metadataPath, `${JSON.stringify({ ...metadata, projectId: 'another-project' }, null, 2)}\n`, 'utf8');
  await assert.rejects(
    workflowStorageBackend.listWorkflowPublishedVersionsWithBackend(created.relativePath),
    /belongs to a different project/,
  );
  await assert.rejects(
    workflowStorageBackend.setWorkflowPublishedVersionStarWithBackend(
      created.relativePath, storedSettings.publishedSnapshotId, true,
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

  const originalContents = await fs.readFile(created.absolutePath, 'utf8');
  const otherProject = await workflowMutations.createWorkflowProjectItem('', 'PublishedHistoryOtherProject');
  await fs.copyFile(
    otherProject.absolutePath,
    workflowFs.getPublishedWorkflowSnapshotPath(workflowsRoot, storedSettings.publishedSnapshotId),
  );
  for (const operation of [
    () => workflowStorageBackend.readWorkflowPublishedVersionDownloadWithBackend(
      created.relativePath, storedSettings.publishedSnapshotId,
    ),
    () => workflowStorageBackend.readWorkflowPublishedVersionPreviewWithBackend(
      created.relativePath, storedSettings.publishedSnapshotId,
    ),
    () => workflowStorageBackend.setWorkflowPublishedVersionStarWithBackend(
      created.relativePath, storedSettings.publishedSnapshotId, true,
    ),
    () => workflowMutations.publishWorkflowProjectItem(created.relativePath, {
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
    () => workflowStorageBackend.restoreWorkflowPublishedVersionWithBackend(
      created.relativePath,
      storedSettings.publishedSnapshotId,
    ),
    /Published version snapshot belongs to a different project/,
  );
  assert.equal(cacheInvalidations.markedIndexDirty, false);
  assert.deepEqual(cacheInvalidations.invalidatedMaterializationPathCalls, []);
  assert.equal(await fs.readFile(created.absolutePath, 'utf8'), originalContents);
});
