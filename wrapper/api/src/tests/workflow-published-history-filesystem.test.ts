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

  const starredVersion = await workflowStorageBackend.setWorkflowPublishedVersionStarWithBackend(
    created.relativePath,
    history.versions[1]!.id,
    true,
  );
  assert.equal(starredVersion.isStarred, true);

  const historyAfterStar = await workflowStorageBackend.listWorkflowPublishedVersionsWithBackend(created.relativePath);
  assert.equal(
    historyAfterStar.versions.find((version) => version.id === history.versions[1]!.id)?.isStarred,
    true,
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
});

test('filesystem published version history rejects mismatched metadata ids', async (t) => {
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
  await fs.writeFile(
    metadataPath,
    `${JSON.stringify({ ...metadata, id: 'different-version-id' }, null, 2)}\n`,
    'utf8',
  );

  const history = await workflowStorageBackend.listWorkflowPublishedVersionsWithBackend(created.relativePath);
  assert.equal(history.versions.length, 1);
  assert.equal(history.versions[0]?.id, storedSettings.publishedSnapshotId);
  assert.equal(history.versions[0]?.isCurrent, true);

  const starredVersion = await workflowStorageBackend.setWorkflowPublishedVersionStarWithBackend(
    created.relativePath,
    storedSettings.publishedSnapshotId,
    true,
  );
  assert.equal(starredVersion.id, storedSettings.publishedSnapshotId);
  assert.equal(starredVersion.isStarred, true);

  const repairedMetadata = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
  assert.equal(repairedMetadata.id, storedSettings.publishedSnapshotId);
  assert.equal(repairedMetadata.isStarred, true);

  const originalContents = await fs.readFile(created.absolutePath, 'utf8');
  const otherProject = await workflowMutations.createWorkflowProjectItem('', 'PublishedHistoryOtherProject');
  await fs.copyFile(
    otherProject.absolutePath,
    workflowFs.getPublishedWorkflowSnapshotPath(workflowsRoot, storedSettings.publishedSnapshotId),
  );

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
  assert.equal(cacheInvalidations.markedIndexDirty, true);
  assert.deepEqual(cacheInvalidations.invalidatedMaterializationPathCalls.at(-1), [created.absolutePath]);
  assert.equal(await fs.readFile(created.absolutePath, 'utf8'), originalContents);
});
