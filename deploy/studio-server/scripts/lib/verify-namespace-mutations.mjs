import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createManagedWorkflowCatalogService } from '../../../../packages/studio-server-api/dist/studio-server-api/src/routes/workflows/managed/catalog.js';
import {
  createManagedWorkflowQueries,
  queryOne,
  queryRows,
  isUniqueViolation,
} from '../../../../packages/studio-server-api/dist/studio-server-api/src/routes/workflows/managed/db.js';
import * as mappers from '../../../../packages/studio-server-api/dist/studio-server-api/src/routes/workflows/managed/mappers.js';
import { createManagedWorkflowTransactionRunner } from '../../../../packages/studio-server-api/dist/studio-server-api/src/routes/workflows/managed/transactions.js';
import {
  mutateManagedNamespace,
  recoverManagedNamespace,
} from '../../../../packages/studio-server-api/dist/studio-server-api/src/routes/workflows/managed/namespace-mutations.js';
import { createManagedBundleService } from '../../../../packages/studio-server-api/dist/studio-server-api/src/routes/workflows/managed/bundles.js';
import { verifyStructuralMutations } from './verify-structural-mutations.mjs';

/** Uses only the migration gate's own disposable PostgreSQL database. */
export async function verifyNamespaceMutations(pool) {
  const initialize = async () => {};
  const queries = createManagedWorkflowQueries(pool);
  const context = {
    pool,
    initialize,
    ...createManagedWorkflowTransactionRunner({ pool, initialize }),
    db: { queryOne, queryRows, isUniqueViolation },
    queries,
    mappers,
    revisions: {},
    blobStore: {},
    maintenance: { enqueueObjectDeletions: async () => {} },
    executionInvalidationController: {
      queueWorkflowInvalidation: async () => {},
      queueGlobalInvalidation: async () => {},
      queueCatalogInvalidation: async () => {},
    },
  };
  const catalog = createManagedWorkflowCatalogService({ context });
  await catalog.createWorkflowFolderItem('Race parent', '');
  let deletion;
  const racing = createManagedWorkflowCatalogService({
    context: {
      ...context,
      queries: {
        ...queries,
        assertFolderExists: async (client, path) => {
          await queries.assertFolderExists(client, path);
          deletion = catalog.deleteWorkflowFolderItem(path).then(
            () => ({ deleted: true }),
            (error) => ({ error }),
          );
        },
      },
    },
  });
  await racing.createWorkflowFolderItem('Child', 'Race parent');
  assert.equal(
    (await deletion).error?.status,
    409,
    'Parent deletion must wait for creation and reject the now-nonempty parent.',
  );
  assert.equal(
    (
      await pool.query(
        "SELECT 1 FROM workflow_folders child LEFT JOIN workflow_folders parent ON parent.relative_path=child.parent_relative_path WHERE child.parent_relative_path<>'' AND parent.relative_path IS NULL",
      )
    ).rowCount,
    0,
  );
  await catalog.createWorkflowFolderItem('Guard source', '');
  await catalog.createWorkflowFolderItem('Guard target', '');
  const sourcePath = 'Guard source/Project.rivet-project';
  const seed = async (id) => {
    await pool.query(
      'INSERT INTO workflows(workflow_id,name,file_name,relative_path,folder_relative_path,current_draft_revision_id) VALUES($1,$2,$3,$4,$5,$6)',
      [id, 'Project', 'Project.rivet-project', sourcePath, 'Guard source', id + '-revision'],
    );
    await pool.query(
      'INSERT INTO workflow_revisions(revision_id,workflow_id,project_blob_key,stats_graph_count,stats_total_node_count,stats_web_app_count) VALUES($1,$2,$3,0,0,0)',
      [id + '-revision', id, 'synthetic/' + id],
    );
  };
  const destinationId = (
    await pool.query("SELECT namespace_id FROM workflow_folders WHERE relative_path='Guard target'")
  ).rows[0].namespace_id;
  const request = (id = 'replacement-B') => ({
    operationId: randomUUID(),
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    command: { kind: 'move', itemType: 'project', relativePath: sourcePath, destinationRelativePath: 'Guard target' },
    expectedSource: { id },
    expectedDestinationId: destinationId,
  });
  await seed('selected-A');
  const stale = request('selected-A');
  await catalog.deleteWorkflowProjectItem(sourcePath);
  await seed('replacement-B');
  await assert.rejects(mutateManagedNamespace(context, stale), { status: 409 });
  const current = request();
  const accepted = await mutateManagedNamespace(context, current);
  assert.equal(accepted.project.projectMetadataId, 'replacement-B');
  assert.deepEqual(
    await mutateManagedNamespace(context, current),
    accepted,
    'Lost acknowledgements must return the original result, not issue another move.',
  );
  assert.deepEqual(await recoverManagedNamespace(context, current), { state: 'committed', result: accepted });
  await assert.rejects(
    mutateManagedNamespace(context, { ...current, command: { ...current.command, destinationRelativePath: '' } }),
    { status: 409 },
  );
  await assert.rejects(
    mutateManagedNamespace(context, { ...request(), expiresAt: new Date(Date.now() - 1000).toISOString() }),
    { status: 410 },
  );
  const unknown = request();
  assert.deepEqual(await recoverManagedNamespace(context, unknown), { state: 'unknown' });
  assert.equal(
    (await pool.query('SELECT 1 FROM workflow_namespace_receipts WHERE operation_id=$1', [unknown.operationId]))
      .rowCount,
    0,
  );
  const before = (await pool.query("SELECT namespace_id FROM workflow_folders WHERE relative_path='Guard source'"))
    .rows[0].namespace_id;
  await catalog.deleteWorkflowFolderItem('Guard source');
  await catalog.createWorkflowFolderItem('Guard source', '');
  const folderRequest = {
    ...request(),
    command: { kind: 'rename', itemType: 'folder', relativePath: 'Guard source', name: 'Wrong rename' },
    expectedSource: { id: before },
  };
  await assert.rejects(mutateManagedNamespace(context, folderRequest), { status: 409 });
  const target = await catalog.createWorkflowFolderItem('Replaced destination', '');
  await catalog.deleteWorkflowFolderItem(target.relativePath);
  await catalog.createWorkflowFolderItem('Replaced destination', '');
  const currentFolder = (
    await pool.query("SELECT namespace_id FROM workflow_folders WHERE relative_path='Guard source'")
  ).rows[0].namespace_id;
  await assert.rejects(
    mutateManagedNamespace(context, {
      ...request(),
      command: {
        kind: 'move',
        itemType: 'folder',
        relativePath: 'Guard source',
        destinationRelativePath: target.relativePath,
      },
      expectedSource: { id: currentFolder },
      expectedDestinationId: target.namespaceId,
    }),
    { status: 409 },
  );
  const deleteRequest = {
    ...request(),
    command: { kind: 'delete', itemType: 'project', relativePath: 'Guard target/Project.rivet-project' },
    expectedSource: { id: 'replacement-B', revisionId: 'old-revision' },
  };
  await assert.rejects(mutateManagedNamespace(context, deleteRequest), { status: 409 });
  // A one-connection deployment must not escape to pool.query while its
  // transaction holds the only connection, even for an unchanged path.
  const scopedOnly = {
    ...context,
    pool: {
      query: () => {
        throw new Error('Escaped the owned transaction');
      },
    },
  };
  const folderId = (await pool.query("SELECT namespace_id FROM workflow_folders WHERE relative_path='Guard source'"))
    .rows[0].namespace_id;
  for (const [itemType, relativePath, name, id] of [
    ['folder', 'Guard source', 'Guard source', folderId],
    ['project', 'Guard target/Project.rivet-project', 'Project', 'replacement-B'],
  ]) {
    const unchanged = await mutateManagedNamespace(scopedOnly, {
      ...request(),
      command: { kind: 'rename', itemType, relativePath, name },
      expectedSource: { id },
    });
    assert.deepEqual(unchanged.movedProjectPaths, []);
  }
  const bundles = createManagedBundleService(context);
  await assert.rejects(
    bundles.setKind('Guard source', true, before),
    { status: 409 },
    'Conversion must not target a replacement folder at a reused path.',
  );
  const bundle = await bundles.create('Receipt bundle', '');
  await assert.rejects(
    mutateManagedNamespace(context, {
      ...request(),
      command: { kind: 'delete', itemType: 'folder', relativePath: bundle.relativePath },
      expectedSource: { id: bundle.namespaceId },
    }),
    { status: 409 },
    'Ordinary folder deletion cannot bypass bundle-name confirmation, even for an empty bundle.',
  );
  const duplicate = {
    automatic: true,
    receipt: { operationId: randomUUID(), expiresAt: new Date(Date.now() + 600_000).toISOString() },
  };
  const copies = await Promise.all([
    bundles.duplicate(bundle.bundleId, duplicate),
    bundles.duplicate(bundle.bundleId, duplicate),
  ]);
  assert.equal(copies[0].bundleId, copies[1].bundleId, 'Concurrent repeat of one duplication must create one copy.');
  assert.equal((await pool.query("SELECT 1 FROM workflow_folders WHERE name LIKE 'Receipt bundle copy%'")).rowCount, 1);
  await catalog.deleteWorkflowFolderItem(bundle.relativePath);
  assert.deepEqual(
    await bundles.duplicate(bundle.bundleId, duplicate),
    copies[0],
    'Committed recovery must not reread a deleted source or create another copy.',
  );
  assert.deepEqual(await bundles.recoverDuplicate(bundle.bundleId, duplicate), {
    state: 'committed',
    result: copies[0],
  });
  console.log(
    'Namespace mutations: parent/delete race, source replacement, folder identity, guarded deletion, durable receipt replay, read-only recovery and expired admission passed.',
  );
  await verifyStructuralMutations(context);
}
