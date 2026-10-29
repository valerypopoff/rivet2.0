import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createStructuralSqlLeaseGuard } from './structural-sql-lease-guard.mjs';
import { createManagedProject } from '../../../../packages/studio-server-api/dist/studio-server-api/src/routes/workflows/managed/project-creation.js';
import { createManagedWorkflowCatalogService } from '../../../../packages/studio-server-api/dist/studio-server-api/src/routes/workflows/managed/catalog.js';
import { createManagedWorkflowRevisionFactory } from '../../../../packages/studio-server-api/dist/studio-server-api/src/routes/workflows/managed/revision-factory.js';
import { createManagedWorkflowRevisionService } from '../../../../packages/studio-server-api/dist/studio-server-api/src/routes/workflows/managed/revisions.js';
import { createManagedBundleService } from '../../../../packages/studio-server-api/dist/studio-server-api/src/routes/workflows/managed/bundles.js';
import { importManagedProjectBundle } from '../../../../packages/studio-server-api/dist/studio-server-api/src/routes/workflows/managed/bundle-import.js';
import { createBlankProjectFile } from '../../../../packages/studio-server-api/dist/studio-server-api/src/routes/workflows/fs-helpers.js';
import { recoverMutationReceipt } from '../../../../packages/studio-server-api/dist/studio-server-api/src/routes/workflows/managed/namespace-receipts.js';
import { createManagedWorkflowTransactionRunner } from '../../../../packages/studio-server-api/dist/studio-server-api/src/routes/workflows/managed/transactions.js';
import { collectProjectBundle } from '../../../../packages/studio-server-api/dist/studio-server-api/src/routes/workflows/project-bundle.js';
import { prepareProjectBundleImport } from '../../../../packages/studio-server-api/dist/studio-server-api/src/routes/workflows/project-bundle-import.js';
import {
  auditManagedDatasetOwnership,
  repairManagedDatasetOwnership,
  datasetOwnershipHash,
} from '../../../../packages/studio-server-api/dist/studio-server-api/src/routes/workflows/managed/dataset-ownership.js';

/** Real SQL/factories; in-memory immutable artifacts. HTTP/browser verification
 * separately exercises actual MinIO. Uses only the migration gate's owned DB. */
export async function verifyStructuralMutations(base) {
  const require = createRequire(new URL('../../../../packages/studio-server-api/package.json', import.meta.url));
  const { Pool } = require('pg');
  const {
    loadProjectAndAttachedDataFromString,
    serializeProject,
    serializeDatasets,
    deserializeDatasets,
    TextNodeImpl,
    GraphOutputNodeImpl,
    createProcessor,
  } = await import(pathToFileURL(require.resolve('@valerypopoff/rivet2-node')).href);
  const objects = new Map(),
    cleanup = [];
  let onUpload;
  const leaseGuard = createStructuralSqlLeaseGuard(base.withTransaction);
  const context = {
    ...base,
    withTransaction: leaseGuard.withTransaction,
  };
  context.blobStore = {
    putText: async (key, value) => {
      leaseGuard.assertOutsideTransaction();
      objects.set(key, value);
      const callback = onUpload;
      onUpload = undefined;
      await callback?.(key, value);
    },
    getText: async (key) => {
      assert.ok(objects.has(key));
      return objects.get(key);
    },
  };
  context.revisions = createManagedWorkflowRevisionFactory({
    blobStore: context.blobStore,
    queueObjectDeletions: async (_reason, keys) => cleanup.push(...keys.filter(Boolean)),
  });
  context.endpointSync = { syncWorkflowEndpointRows: async () => {} };
  const catalog = createManagedWorkflowCatalogService({ context });
  const service = createManagedWorkflowRevisionService({ context });
  const bundles = createManagedBundleService(context);
  const admission = (guards) => ({
    operationId: randomUUID(),
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    ...guards,
  });
  const parent = await catalog.createWorkflowFolderItem(
    'Structural fixtures',
    '',
    admission({ expectedDestinationId: null }),
  );
  const guards = { expectedDestinationId: parent.namespaceId };
  let releaseCapture;
  const captureReady = new Promise((resolve) => {
    releaseCapture = resolve;
  });
  const changingCommand = {
    operation: 'create-project',
    input: { name: 'Captured input', parentRelativePath: '' },
  };
  const changingReceipt = admission({ expectedDestinationId: null });
  const originalCommand = structuredClone(changingCommand);
  const originalReceipt = structuredClone(changingReceipt);
  const pendingCapture = createManagedProject(
    {
      ...context,
      initialize: async () => {
        await captureReady;
        await context.initialize();
      },
    },
    changingCommand,
    changingReceipt,
  );
  changingCommand.input.name = 'Mutated after admission';
  changingReceipt.expectedDestinationId = randomUUID();
  releaseCapture();
  const capturedProject = await pendingCapture;
  assert.equal(capturedProject.name, originalCommand.input.name);
  assert.equal((await recoverMutationReceipt(base.pool, originalReceipt, originalCommand)).state, 'committed');
  const command = { operation: 'create-project', input: { name: 'Original', parentRelativePath: parent.relativePath } };
  const receipt = admission(guards);
  const created = await Promise.all([
    createManagedProject(context, command, receipt),
    createManagedProject(context, command, receipt),
  ]);
  assert.deepEqual(created[0], created[1]);
  assert.equal(
    (await base.pool.query('SELECT 1 FROM workflows WHERE relative_path=$1', [created[0].relativePath])).rowCount,
    1,
  );
  assert.deepEqual(await recoverMutationReceipt(base.pool, receipt, command), {
    state: 'committed',
    result: { project: created[0] },
  });
  let original = created[0];
  const initialRevision = await context.queries.getRevision(base.pool, original.revisionId);
  const [definition, initialAttached] = loadProjectAndAttachedDataFromString(
    await context.blobStore.getText(initialRevision.project_blob_key),
  );
  const graph = Object.values(definition.graphs)[0];
  const text = TextNodeImpl.create();
  text.data.text = 'preserved workflow';
  const output = GraphOutputNodeImpl.create();
  output.data.id = 'result';
  graph.nodes = [text, output];
  graph.connections = [{ outputNodeId: text.id, outputId: 'output', inputNodeId: output.id, inputId: 'value' }];
  const datasetBytes = serializeDatasets([
    {
      meta: { id: 'preserved-data', projectId: original.projectMetadataId, name: 'Dataset', description: '' },
      data: { id: 'preserved-data', rows: [{ id: 'row', data: ['preserved value'] }] },
    },
  ]);
  const seeded = await service.saveHostedProject({
    projectPath: original.absolutePath,
    projectId: original.projectMetadataId,
    contents: serializeProject(definition, initialAttached),
    datasetsContents: datasetBytes,
    expectedRevisionId: original.revisionId,
    saveIntent: 'in-place',
  });
  original = { ...original, revisionId: seeded.revisionId };
  const sourceRevision = await context.queries.getRevision(base.pool, original.revisionId);
  const originalContents = await context.blobStore.getText(sourceRevision.project_blob_key);
  const copyCommand = { operation: 'copy-project', input: { relativePath: original.relativePath, version: 'live' } };
  const copyReceipt = admission({
    expectedSource: { id: original.projectMetadataId, revisionId: original.revisionId },
  });
  const copy = await createManagedProject(context, copyCommand, copyReceipt);
  const copiedRevision = await context.queries.getRevision(base.pool, copy.revisionId);
  const copiedDatasets = deserializeDatasets(await context.blobStore.getText(copiedRevision.dataset_blob_key));
  assert.equal(copiedDatasets[0].meta.projectId, copy.projectMetadataId);
  assert.deepEqual(copiedDatasets[0].data, deserializeDatasets(datasetBytes)[0].data);
  assert.notEqual(copy.projectMetadataId, original.projectMetadataId);
  assert.equal(await context.blobStore.getText(sourceRevision.project_blob_key), originalContents);
  assert.deepEqual(await createManagedProject(context, copyCommand, copyReceipt), copy);
  await assert.rejects(
    createManagedProject(
      context,
      { ...copyCommand, input: { ...copyCommand.input, version: 'published' } },
      copyReceipt,
    ),
    { status: 409 },
  );
  const preparedCount = objects.size;
  await assert.rejects(
    createManagedProject(context, command, {
      ...admission(guards),
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    }),
    { status: 410 },
  );
  assert.equal(objects.size, preparedCount, 'Expired admissions must not even prepare artifacts.');
  onUpload = () =>
    base.pool.query('UPDATE workflows SET updated_at=NOW() WHERE workflow_id=$1', [original.projectMetadataId]);
  await assert.rejects(
    createManagedProject(
      context,
      copyCommand,
      admission({ expectedSource: { id: original.projectMetadataId, revisionId: original.revisionId } }),
    ),
    { status: 409 },
  );
  const destination = await catalog.createWorkflowFolderItem('Upload destination', '');
  const uploadCommand = {
    operation: 'upload-project',
    input: {
      parentRelativePath: destination.relativePath,
      fileName: 'Imported.rivet-project',
      contents: originalContents,
    },
  };
  onUpload = async () => {
    await catalog.deleteWorkflowFolderItem(destination.relativePath);
    await catalog.createWorkflowFolderItem(destination.name, '');
  };
  await assert.rejects(
    createManagedProject(context, uploadCommand, admission({ expectedDestinationId: destination.namespaceId })),
    { status: 409 },
  );
  assert.equal(
    (await base.pool.query('SELECT 1 FROM workflows WHERE folder_relative_path=$1', [destination.relativePath]))
      .rowCount,
    0,
  );
  const currentDestination = (
    await base.pool.query('SELECT namespace_id FROM workflow_folders WHERE relative_path=$1', [
      destination.relativePath,
    ])
  ).rows[0].namespace_id;
  const uploadReceipt = admission({ expectedDestinationId: currentDestination });
  const uploaded = await createManagedProject(context, uploadCommand, uploadReceipt);
  assert.deepEqual(await createManagedProject(context, uploadCommand, uploadReceipt), uploaded);
  assert.ok(cleanup.length, 'Unused prepared objects are queued for reference-aware cleanup.');

  const kindReceipt = admission({ expectedSource: { id: parent.namespaceId } });
  const converted = await bundles.setKind(parent.relativePath, true, parent.namespaceId, kindReceipt);
  assert.deepEqual(await bundles.setKind(parent.relativePath, true, parent.namespaceId, kindReceipt), converted);
  const newBundleReceipt = admission({ expectedDestinationId: null });
  const emptyBundle = await bundles.create('Created structural bundle', '', newBundleReceipt);
  assert.deepEqual(await bundles.create('Created structural bundle', '', newBundleReceipt), emptyBundle);
  const copyBundleReceipt = admission({ expectedSource: { id: parent.namespaceId } });
  const bundleCopy = await bundles.duplicate(converted.bundleId, {
    automatic: true,
    relativePath: parent.relativePath,
    mutation: copyBundleReceipt,
  });
  assert.deepEqual(
    await bundles.duplicate(converted.bundleId, {
      automatic: true,
      relativePath: parent.relativePath,
      mutation: copyBundleReceipt,
    }),
    bundleCopy,
  );
  // The original diagnostic's full chain: ordinary non-empty dataset copy,
  // conversion, bundle copy, portable export/import, then actual execution.
  const snapshot = await bundles.exportSnapshot(bundleCopy.bundleId, 'latest');
  const members = await Promise.all(
    snapshot.members.map(async (member) => {
      const workflow = await context.queries.getWorkflowById(base.pool, member.projectId);
      const revision = await context.queries.getRevision(base.pool, workflow.current_draft_revision_id);
      const data = await context.revisions.readRevisionContents(revision);
      return {
        project: loadProjectAndAttachedDataFromString(data.contents)[0],
        projectContents: data.contents,
        datasetsContents: data.datasetsContents,
        selectedVersion: 'latest',
      };
    }),
  );
  const files = [];
  const portable = await collectProjectBundle({
    source: {
      versionPolicy: 'latest',
      workspace: { name: 'Roundtrip composition', folders: snapshot.folders, members: snapshot.members },
      root: async () => members[0],
      async *additionalRoots() {
        yield* members.slice(1);
      },
      target: async () => assert.fail('This fixture has no external targets'),
      reference: async (id) => {
        const member = members.find((item) => item.project.metadata.id === id);
        assert.ok(member, 'Only exported member snapshots may be read');
        return member;
      },
    },
    rootVersion: 'latest',
    signal: AbortSignal.timeout(10_000),
    progress: () => {},
    writeFile: async (path, contents) => files.push({ path, contents }),
  });
  await portable.verify();
  const roundtrip = await importManagedProjectBundle(context, '', prepareProjectBundleImport(files));
  assert.equal(roundtrip.projects.length, 2);
  for (const member of roundtrip.projects) {
    const workflow = await context.queries.getWorkflowById(base.pool, member.projectMetadataId);
    const data = await context.revisions.readRevisionContents(
      await context.queries.getRevision(base.pool, workflow.current_draft_revision_id),
    );
    const datasets = deserializeDatasets(data.datasetsContents);
    assert.equal(datasets[0].meta.projectId, member.projectMetadataId);
    assert.deepEqual(datasets[0].data, deserializeDatasets(datasetBytes)[0].data);
    const processor = createProcessor(loadProjectAndAttachedDataFromString(data.contents)[0], {});
    try {
      assert.equal((await processor.run()).result.value, 'preserved workflow');
    } finally {
      processor.dispose();
    }
  }
  const confirmation = { name: bundleCopy.folder.name, relativePath: bundleCopy.folder.relativePath };
  const deletionReceipt = admission({ expectedSource: { id: bundleCopy.folder.namespaceId } });
  const deleted = await bundles.delete(bundleCopy.bundleId, confirmation, deletionReceipt);
  assert.equal(deleted.deletedProjects.length, 2);
  assert.deepEqual(await bundles.delete(bundleCopy.bundleId, confirmation, deletionReceipt), deleted);

  // Independent commands may initially prepare the same automatic name. Both
  // must commit distinct copies; an identical UUID remains exactly-once above.
  const originalPut = context.blobStore.putText;
  for (const mode of ['copy', 'upload']) {
    let arrivals = 0,
      release;
    const ready = new Promise((resolve) => {
      release = resolve;
    });
    context.blobStore.putText = async (key, value) => {
      await originalPut(key, value);
      if (key.endsWith('project.rivet-project') && ++arrivals <= 2) {
        if (arrivals === 2) release();
        await ready;
      }
    };
    try {
      const selected =
        mode === 'copy'
          ? copyCommand
          : {
              operation: 'upload-project',
              input: { parentRelativePath: '', fileName: 'Concurrent upload', contents: originalContents },
            };
      const guards = mode === 'copy' ? { expectedSource: copyReceipt.expectedSource } : { expectedDestinationId: null };
      const concurrent = await Promise.all([
        createManagedProject(context, selected, admission(guards)),
        createManagedProject(context, selected, admission(guards)),
      ]);
      assert.notEqual(concurrent[0].relativePath, concurrent[1].relativePath);
      assert.notEqual(concurrent[0].projectMetadataId, concurrent[1].projectMetadataId);
    } finally {
      context.blobStore.putText = originalPut;
    }
  }

  // Re-preparation is not permission to select fresh authority or outlive the
  // original admission. Force a real first collision, then change one fence.
  for (const failure of ['source', 'destination', 'expiry']) {
    const folder = await catalog.createWorkflowFolderItem(`Collision ${failure}`, '');
    const source = await catalog.createWorkflowProjectItem(folder.relativePath, 'Source');
    const command =
      failure === 'source'
        ? { operation: 'copy-project', input: { relativePath: source.relativePath, version: 'live' } }
        : {
            operation: 'upload-project',
            input: { parentRelativePath: folder.relativePath, fileName: 'Candidate', contents: originalContents },
          };
    const receipt = admission(
      failure === 'source'
        ? { expectedSource: { id: source.projectMetadataId, revisionId: source.revisionId } }
        : { expectedDestinationId: folder.namespaceId },
    );
    if (failure === 'expiry') receipt.expiresAt = new Date(Date.now() + 1500).toISOString();
    let attempts = 0;
    onUpload = async (_key, contents) => {
      attempts++;
      const [project] = loadProjectAndAttachedDataFromString(contents);
      await catalog.createWorkflowProjectItem(folder.relativePath, project.metadata.title);
      onUpload = async () => {
        attempts++;
        if (failure === 'source') await catalog.renameWorkflowProjectItem(source.relativePath, 'Changed source');
        else if (failure === 'destination') {
          await catalog.renameWorkflowFolderItem(folder.relativePath, `${folder.name} moved`);
          await catalog.createWorkflowFolderItem(folder.name, '');
        } else await new Promise((resolve) => setTimeout(resolve, 1600));
      };
    };
    await assert.rejects(createManagedProject(context, command, receipt), { status: failure === 'expiry' ? 410 : 409 });
    onUpload = undefined;
    assert.equal(attempts, 2, 'One acknowledged collision must precede the stale/expired rejection');
    assert.equal((await recoverMutationReceipt(base.pool, receipt, command)).state, 'unknown');
  }

  // A committed write with a lost database acknowledgement is never a naming
  // retry. Its final receipt can still be observed and its objects retained.
  const lostReceipt = admission({ expectedSource: copyReceipt.expectedSource });
  let commitAttempts = 0;
  const beforeLostCleanup = cleanup.length;
  const lostRunner = createManagedWorkflowTransactionRunner({
    initialize: context.initialize,
    pool: {
      connect: async () => {
        const client = await base.pool.connect();
        return {
          query: async (sql, ...args) => {
            const result = await client.query(sql, ...args);
            if (sql === 'COMMIT') {
              commitAttempts++;
              throw new Error('fixture lost commit acknowledgement');
            }
            return result;
          },
          release: (error) => client.release(error),
        };
      },
    },
  });
  await assert.rejects(
    createManagedProject(
      {
        ...context,
        withTransaction: lostRunner.withTransaction,
      },
      copyCommand,
      lostReceipt,
    ),
    /lost commit acknowledgement/,
  );
  assert.equal(commitAttempts, 1);
  assert.equal(cleanup.length, beforeLostCleanup, 'Uncertain prepared objects must not be queued for deletion');
  const recovered = await recoverMutationReceipt(base.pool, lostReceipt, copyCommand);
  assert.equal(recovered.state, 'committed');
  assert.equal(
    (
      await base.pool.query('SELECT 1 FROM workflows WHERE workflow_id=$1', [
        recovered.result.project.projectMetadataId,
      ])
    ).rowCount,
    1,
  );

  // Ordinary saves must also retain their exact uploaded objects when COMMIT
  // succeeded but the acknowledgement was lost. They still avoid the global
  // topology lease and do not automatically replay the save.
  const [editedProject, editedAttached] = loadProjectAndAttachedDataFromString(originalContents);
  editedProject.metadata.description = 'A committed save with a lost acknowledgement';
  const editedContents = serializeProject(editedProject, editedAttached);
  const beforeSaveCleanup = cleanup.length;
  const saveService = createManagedWorkflowRevisionService({
    context: { ...context, withTransaction: lostRunner.withTransaction },
  });
  await assert.rejects(
    saveService.saveHostedProject({
      projectPath: original.absolutePath,
      projectId: original.projectMetadataId,
      contents: editedContents,
      datasetsContents: datasetBytes,
      expectedRevisionId: original.revisionId,
      saveIntent: 'in-place',
    }),
    /lost commit acknowledgement/,
  );
  assert.equal(commitAttempts, 2, 'The uncertain save is attempted only once');
  assert.equal(cleanup.length, beforeSaveCleanup, 'Uncertain save objects must not be queued for deletion');
  const savedAfterLostAck = await context.queries.getWorkflowById(base.pool, original.projectMetadataId);
  assert.notEqual(savedAfterLostAck.current_draft_revision_id, original.revisionId);
  const savedAfterLostAckRevision = await context.queries.getRevision(
    base.pool,
    savedAfterLostAck.current_draft_revision_id,
  );
  const savedAfterLostAckContents = await context.revisions.readRevisionContents(savedAfterLostAckRevision);
  assert.equal(
    loadProjectAndAttachedDataFromString(savedAfterLostAckContents.contents)[0].metadata.description,
    editedProject.metadata.description,
  );
  assert.equal(savedAfterLostAckContents.datasetsContents, datasetBytes);

  // Autocommit INSERT can likewise succeed before a lost acknowledgement.
  // Use a real Pool so the production Pool branch is exercised; the INSERT
  // must not be replayed and its shared recording keys must not be queued.
  const recordingId = randomUUID();
  const recording = await context.revisions.uploadRecordingBlobs(
    original.projectMetadataId,
    recordingId,
    {
      recording: 'recorded events',
      replayProject: originalContents,
      replayDataset: datasetBytes,
    },
    'fixture recording upload',
  );
  const recordingPool = new Pool(base.pool.options);
  const realQuery = recordingPool.query.bind(recordingPool);
  let recordingAttempts = 0;
  recordingPool.query = async (sql, ...args) => {
    const result = await realQuery(sql, ...args);
    if (String(sql).includes('INSERT INTO workflow_recordings')) {
      recordingAttempts++;
      throw Object.assign(new Error('fixture lost recording acknowledgement'), { code: 'ECONNRESET' });
    }
    return result;
  };
  const beforeRecordingCleanup = cleanup.length;
  try {
    await assert.rejects(
      context.revisions.insertRecordingRow(
        recordingPool,
        {
          recordingId,
          workflowId: original.projectMetadataId,
          sourceProjectName: 'Original',
          sourceProjectRelativePath: original.relativePath,
          runKind: 'latest',
          status: 'succeeded',
          durationMs: 1,
          endpointNameAtExecution: '',
          errorMessage: null,
          ...recording,
          hasReplayDataset: true,
          recordingCompressedBytes: 1,
          recordingUncompressedBytes: 1,
          projectCompressedBytes: 1,
          projectUncompressedBytes: 1,
          datasetCompressedBytes: 1,
          datasetUncompressedBytes: 1,
        },
        { timestampMode: 'now', onConflict: 'fail', cleanupContext: 'fixture recording insert' },
      ),
      /lost recording acknowledgement/,
    );
  } finally {
    await recordingPool.end();
  }
  assert.equal(recordingAttempts, 1, 'An uncertain recording INSERT is never replayed');
  assert.equal(
    cleanup.length,
    beforeRecordingCleanup,
    'Recording artifacts remain untouched after an uncertain INSERT',
  );
  const recorded = await base.pool.query(
    'SELECT recording_blob_key, replay_project_blob_key, replay_dataset_blob_key FROM workflow_recordings WHERE recording_id=$1',
    [recordingId],
  );
  assert.deepEqual(recorded.rows[0], {
    recording_blob_key: recording.recordingBlobKey,
    replay_project_blob_key: recording.replayProjectBlobKey,
    replay_dataset_blob_key: recording.replayDatasetBlobKey,
  });
  assert.ok(
    objects.has(recording.recordingBlobKey) &&
      objects.has(recording.replayProjectBlobKey) &&
      objects.has(recording.replayDatasetBlobKey),
  );

  const expiry = admission({ expectedDestinationId: null });
  expiry.expiresAt = new Date(Date.now() + 250).toISOString();
  onUpload = () => new Promise((resolve) => setTimeout(resolve, 400));
  await assert.rejects(
    createManagedProject(
      context,
      {
        operation: 'upload-project',
        input: { parentRelativePath: '', fileName: 'Expired during upload', contents: originalContents },
      },
      expiry,
    ),
    { status: 410 },
  );
  onUpload = undefined;

  const blockedFolder = await catalog.createWorkflowFolderItem('Name contention', '');
  const exhaust = async (_key, value) => {
    const [prepared] = loadProjectAndAttachedDataFromString(value);
    await catalog.createWorkflowProjectItem(blockedFolder.relativePath, prepared.metadata.title);
    onUpload = exhaust;
  };
  onUpload = exhaust;
  const exhaustedReceipt = admission({ expectedDestinationId: blockedFolder.namespaceId });
  await assert.rejects(
    createManagedProject(
      context,
      {
        operation: 'upload-project',
        input: {
          parentRelativePath: blockedFolder.relativePath,
          fileName: 'Contended',
          contents: originalContents,
        },
      },
      exhaustedReceipt,
    ),
    /generated destination kept changing/,
  );
  onUpload = undefined;
  assert.equal(
    (
      await base.pool.query('SELECT 1 FROM workflow_namespace_receipts WHERE operation_id=$1', [
        exhaustedReceipt.operationId,
      ])
    ).rowCount,
    0,
  );
  assert.equal(
    (await base.pool.query('SELECT 1 FROM workflows WHERE folder_relative_path=$1', [blockedFolder.relativePath]))
      .rowCount,
    8,
  );

  // Existing malformed copies require explicit provenance and a new forward
  // draft. Neither audit nor repair may rewrite published/history artifacts.
  const malformed = await catalog.createWorkflowProjectItem('', 'Reviewed old copy');
  await base.pool.query('UPDATE workflow_revisions SET dataset_blob_key=$2 WHERE revision_id=$1', [
    malformed.revisionId,
    sourceRevision.dataset_blob_key,
  ]);
  await base.pool.query('UPDATE workflows SET published_revision_id=current_draft_revision_id WHERE workflow_id=$1', [
    malformed.projectMetadataId,
  ]);
  const report = await auditManagedDatasetOwnership(
    { pool: base.pool, readRevisionContents: context.revisions.readRevisionContents },
    { limit: 100 },
  );
  assert.ok(
    report.findings.some((item) => item.revisionId === malformed.revisionId && item.problem === 'owner-mismatch'),
  );
  assert.ok(!JSON.stringify(report).includes('preserved value'));
  const repair = {
    projectId: malformed.projectMetadataId,
    expectedRevisionId: malformed.revisionId,
    expectedProjectHash: datasetOwnershipHash(
      (await context.revisions.readRevisionContents(await context.queries.getRevision(base.pool, malformed.revisionId)))
        .contents,
    ),
    expectedDatasetKey: sourceRevision.dataset_blob_key,
    expectedDatasetHash: datasetOwnershipHash(datasetBytes),
    sourceProjectId: original.projectMetadataId,
    sourceRevisionId: original.revisionId,
    sourceDatasetKey: sourceRevision.dataset_blob_key,
    approvalReason: 'Reviewed synthetic copy provenance',
    mutation: admission({ expectedSource: { id: malformed.projectMetadataId, revisionId: malformed.revisionId } }),
  };
  await assert.rejects(
    repairManagedDatasetOwnership(context, { ...repair, expectedDatasetHash: '0'.repeat(64) }),
    /reviewed source artifact/,
  );
  await assert.rejects(
    repairManagedDatasetOwnership(context, { ...repair, expectedProjectHash: '0'.repeat(64) }),
    /reviewed source artifact/,
  );
  await assert.rejects(
    repairManagedDatasetOwnership(context, { ...repair, sourceProjectId: malformed.projectMetadataId }),
    /reviewed provenance/,
  );
  const repaired = await repairManagedDatasetOwnership(context, repair);
  assert.deepEqual(await repairManagedDatasetOwnership(context, repair), repaired);
  await assert.rejects(
    repairManagedDatasetOwnership(context, {
      ...repair,
      mutation: admission({ expectedSource: repair.mutation.expectedSource }),
    }),
    /draft revision or provenance changed/,
  );
  assert.notEqual(repaired.revisionId, malformed.revisionId);
  const repairedRow = await context.queries.getRevision(base.pool, repaired.revisionId);
  assert.equal(
    deserializeDatasets((await context.revisions.readRevisionContents(repairedRow)).datasetsContents)[0].meta.projectId,
    malformed.projectMetadataId,
  );
  assert.equal(
    (await context.queries.getRevision(base.pool, malformed.revisionId)).dataset_blob_key,
    sourceRevision.dataset_blob_key,
  );
  assert.equal(
    (await context.queries.getWorkflowById(base.pool, malformed.projectMetadataId)).published_revision_id,
    malformed.revisionId,
  );

  const importId = randomUUID();
  const [importProject, attached] = loadProjectAndAttachedDataFromString(originalContents);
  importProject.metadata.id = importId;
  const importedContents = serializeProject(importProject, attached);
  const prepared = {
    folderName: 'Imported structural bundle',
    rootProjectId: importId,
    folders: ['Nested'],
    projects: [{ id: importId, name: 'Member', folder: 'Nested', contents: importedContents, datasetsContents: null }],
  };
  const importReceipt = admission({ expectedDestinationId: null });
  const payload = {
    operation: 'import-bundle',
    input: { parentRelativePath: '', files: [{ path: 'fixture', contents: importedContents }] },
  };
  const imported = await importManagedProjectBundle(context, '', prepared, importReceipt, payload);
  assert.ok(imported.folder.namespaceId);
  assert.ok(imported.folder.folders[0].namespaceId);
  assert.deepEqual(await importManagedProjectBundle(context, '', prepared, importReceipt, payload), imported);

  const blank = createBlankProjectFile('Save As');
  const [blankProject] = loadProjectAndAttachedDataFromString(blank);
  const saveOptions = {
    projectPath: '/managed/workflows/Fresh chain/Nested/Saved.rivet-project',
    contents: blank,
    datasetsContents: null,
    projectId: blankProject.metadata.id,
    expectedRevisionId: null,
    saveIntent: 'save-as',
    structuralMutation: admission({ expectedDestinationPath: '', expectedDestinationId: null }),
  };
  const saved = await service.saveHostedProject(saveOptions);
  assert.deepEqual(await service.saveHostedProject(saveOptions), saved);
  assert.equal(
    (await base.pool.query("SELECT 1 FROM workflow_folders WHERE relative_path='Fresh chain/Nested'")).rowCount,
    1,
  );
  const saveDestination = await catalog.createWorkflowFolderItem('Save As replacement', '');
  onUpload = async () => {
    await catalog.deleteWorkflowFolderItem(saveDestination.relativePath);
    await catalog.createWorkflowFolderItem(saveDestination.name, '');
  };
  await assert.rejects(
    service.saveHostedProject({
      ...saveOptions,
      projectPath: `/managed/workflows/${saveDestination.relativePath}/Missing/Rejected.rivet-project`,
      structuralMutation: admission({
        expectedDestinationPath: saveDestination.relativePath,
        expectedDestinationId: saveDestination.namespaceId,
      }),
    }),
    { status: 409 },
  );
  assert.equal(
    (
      await base.pool.query('SELECT 1 FROM workflow_folders WHERE relative_path=$1', [
        `${saveDestination.relativePath}/Missing`,
      ])
    ).rowCount,
    0,
    'A failed Save As must not create its folder chain beneath a replacement.',
  );
  console.log(
    'Structural consolidation: create/copy/upload/import, bundle lifecycle, immutable artifact preparation, dataset preservation, stale source/destination fences, Save As chains and exact receipt recovery passed.',
  );
}
