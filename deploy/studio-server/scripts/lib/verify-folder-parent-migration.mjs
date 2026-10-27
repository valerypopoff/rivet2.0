import assert from 'node:assert/strict';
import { createManagedWorkflowCatalogService } from '../../../../packages/studio-server-api/dist/studio-server-api/src/routes/workflows/managed/catalog.js';
import {
  createManagedWorkflowQueries,
  queryRows,
} from '../../../../packages/studio-server-api/dist/studio-server-api/src/routes/workflows/managed/db.js';
import * as mappers from '../../../../packages/studio-server-api/dist/studio-server-api/src/routes/workflows/managed/mappers.js';
import { createManagedWorkflowTransactionRunner } from '../../../../packages/studio-server-api/dist/studio-server-api/src/routes/workflows/managed/transactions.js';

/** Runs only against the schema gate's newly created disposable database. */
export async function verifyFolderParentMigration(pool, { migrations, migrate, verify, options }) {
  await pool.query(`CREATE TABLE managed_workflow_schema_migrations (
    version INTEGER PRIMARY KEY CHECK (version > 0), name TEXT NOT NULL,
    checksum TEXT NOT NULL CHECK (char_length(checksum) = 64), application_version TEXT NULL,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  for (const migration of migrations.filter((entry) => entry.version <= 16)) {
    await pool.query(migration.sql);
    await pool.query('INSERT INTO managed_workflow_schema_migrations(version,name,checksum) VALUES($1,$2,$3)', [
      migration.version,
      migration.name,
      migration.checksum,
    ]);
  }
  await pool.query(`CREATE TABLE unrelated_application_sentinel(value TEXT);
    INSERT INTO unrelated_application_sentinel VALUES ('keep');
    INSERT INTO workflow_folders(relative_path,name,parent_relative_path,bundle_id) VALUES
    ('Original','Original','',NULL),('Trash','Trash','',NULL),('Trash/Test','Test','Trash',NULL),
    ('Original/Bundle_%','Bundle_%','Original','168073b5-223d-4395-9d06-e57ed93ca2e8'),
    ('Original/Bundle_%/Sub','Sub','Original/Bundle_%',NULL),
    ('Original/Bundle_%-sibling','Bundle_%-sibling','Original',NULL),
    ('Foreign','Foreign','','58019223-bd4e-49c3-a042-321215efaa35'),
    ('Plain_%','Plain_%','Original',NULL),('Trash/Occupied','Occupied','Trash',NULL);
    INSERT INTO workflows(workflow_id,name,file_name,relative_path,folder_relative_path,current_draft_revision_id) VALUES
    ('root','Root','Root.rivet-project','Original/Bundle_%/Root.rivet-project','Original/Bundle_%','root-revision'),
    ('child','Child','Child.rivet-project','Original/Bundle_%/Sub/Child.rivet-project','Original/Bundle_%/Sub','child-revision');
    INSERT INTO workflow_revisions(revision_id,workflow_id,project_blob_key,dataset_blob_key,stats_graph_count,stats_total_node_count,stats_web_app_count) VALUES
    ('root-revision','root','fixture/root','fixture/root-data',1,2,0),
    ('child-revision','child','fixture/child',NULL,1,2,0);
    INSERT INTO workflow_published_versions(version_id,workflow_id,revision_id,endpoint_name) VALUES
    ('published-root','root','root-revision','retained-endpoint');
    UPDATE workflows SET published_revision_id='root-revision',published_version_id='published-root',
      endpoint_name='retained-endpoint',published_endpoint_name='retained-endpoint' WHERE workflow_id='root';
    INSERT INTO workflow_endpoints(lookup_name,workflow_id,endpoint_name,is_draft,is_published)
      VALUES('retained-endpoint','root','retained-endpoint',TRUE,TRUE);`);
  let sequence = 0;
  const move = async (from, to) =>
    (
      await pool.query('SELECT * FROM move_managed_workflow_folder($1,$2,$3,$4)', [
        from,
        `.__folder_fixture_${++sequence}`,
        to,
        to.split('/').at(-1),
      ])
    ).rows[0];
  await move('Original/Bundle_%', 'Trash/Bundle_%');
  const broken = await move('Trash/Bundle_%', 'Trash/Test/Bundle_%');
  assert.equal(broken.parent_relative_path, 'Original', 'The real schema-16 function must reproduce the incident.');
  const dataTables = ['workflows', 'workflow_revisions', 'workflow_endpoints', 'workflow_published_versions'];
  const snapshot = async (tables = dataTables) => {
    const result = {};
    for (const table of tables)
      result[table] = (await pool.query(`SELECT to_jsonb(t) AS value FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows;
    return result;
  };
  const topologyTables = ['workflow_folders', ...dataTables];
  const saved = await snapshot();
  const oldFunction = (
    await pool.query(`SELECT md5(prosrc) AS hash FROM pg_proc
    WHERE proname='move_managed_workflow_folder' AND pronamespace=current_schema()::regnamespace`)
  ).rows[0].hash;
  // Ambiguous input must roll back the entire migration, including the repair
  // and function replacement, rather than create missing parents or lose data.
  for (const invalid of ['Missing/Child', 'Trash//Child', '../Child', 'Bad\\Child']) {
    await pool.query('INSERT INTO workflow_folders(relative_path,name,parent_relative_path) VALUES($1,$2,$3)', [
      invalid,
      'Invalid fixture',
      '',
    ]);
    const beforeFailure = await snapshot(topologyTables);
    await assert.rejects(migrate(pool), /Folder topology requires review/);
    assert.equal(
      (await pool.query('SELECT max(version) AS version FROM managed_workflow_schema_migrations')).rows[0].version,
      16,
    );
    assert.deepEqual(
      await snapshot(topologyTables),
      beforeFailure,
      'Rejected repair must leave the entire catalog unchanged.',
    );
    assert.equal(
      (
        await pool.query(`SELECT md5(prosrc) AS hash FROM pg_proc
      WHERE proname='move_managed_workflow_folder' AND pronamespace=current_schema()::regnamespace`)
      ).rows[0].hash,
      oldFunction,
    );
    await pool.query('DELETE FROM workflow_folders WHERE relative_path=$1', [invalid]);
  }
  const migrated = await migrate(pool);
  const forwardVersions = migrations.filter((migration) => migration.version > 16).map((migration) => migration.version);
  assert.equal(forwardVersions[0], 17, 'The upgrade must still exercise the folder-parent repair.');
  assert.deepEqual(migrated, { currentVersion: forwardVersions.at(-1), appliedVersions: forwardVersions });
  await verify(pool, options);
  assert.deepEqual(
    await snapshot(),
    saved,
    'Repair must preserve saved revisions, datasets, identities and publications.',
  );
  assert.equal((await pool.query('SELECT value FROM unrelated_application_sentinel')).rows[0].value, 'keep');
  const assertParents = async () => {
    const rows = (await pool.query('SELECT relative_path,parent_relative_path FROM workflow_folders')).rows;
    for (const row of rows)
      assert.equal(
        row.parent_relative_path,
        row.relative_path.includes('/') ? row.relative_path.slice(0, row.relative_path.lastIndexOf('/')) : '',
        row.relative_path,
      );
  };
  await assertParents();
  assert.deepEqual((await migrate(pool)).appliedVersions, []);
  const bundleId = '168073b5-223d-4395-9d06-e57ed93ca2e8';
  for (const [from, to, isBundle] of [
    ['Trash/Test/Bundle_%', 'Original/Bundle_%', true],
    ['Original/Bundle_%', 'Original/Renamed_%', true],
    ['Original/Renamed_%', 'Renamed_%', true],
    ['Plain_%', 'Trash/Plain_%', false],
    ['Trash/Plain_%', 'Plain_%', false],
  ]) {
    const moved = await move(from, to);
    assert.equal(moved.relative_path, to);
    await assertParents();
    if (isBundle) {
      assert.equal(
        (await pool.query('SELECT bundle_id FROM workflow_folders WHERE relative_path=$1', [to])).rows[0].bundle_id,
        bundleId,
      );
      const project = (
        await pool.query(
          "SELECT relative_path,folder_relative_path,current_draft_revision_id FROM workflows WHERE workflow_id='child'",
        )
      ).rows[0];
      assert.equal(project.relative_path, `${to}/Sub/Child.rivet-project`);
      assert.equal(project.folder_relative_path, `${to}/Sub`);
      assert.equal(project.current_draft_revision_id, 'child-revision');
    }
  }
  for (const [destination, code] of [
    ['Trash/Occupied', '23505'],
    ['Missing/Bundle', 'P0002'],
    ['Foreign/Renamed_%', '23514'],
  ]) {
    const beforeFailure = await snapshot(topologyTables);
    await assert.rejects(move('Renamed_%', destination), { code });
    assert.deepEqual(
      await snapshot(topologyTables),
      beforeFailure,
      'Rejected moves must preserve all folder, workflow, revision and publication metadata.',
    );
    await assertParents();
  }
  assert.equal(
    (
      await pool.query('SELECT parent_relative_path FROM workflow_folders WHERE relative_path=$1', [
        'Original/Bundle_%-sibling',
      ])
    ).rows[0].parent_relative_path,
    'Original',
  );
  // Moving a containing ordinary folder must preserve an enclosed bundle,
  // while an empty bundle follows the same parent rules as a populated one.
  await pool.query(
    "INSERT INTO workflow_folders(relative_path,name,parent_relative_path) VALUES('Envelope','Envelope','')",
  );
  await move('Renamed_%', 'Envelope/Renamed_%');
  await move('Envelope', 'Trash/Envelope');
  assert.equal(
    (await pool.query('SELECT relative_path FROM workflow_folders WHERE bundle_id=$1', [bundleId])).rows[0]
      .relative_path,
    'Trash/Envelope/Renamed_%',
  );
  await assertParents();
  await move('Trash/Envelope/Renamed_%', 'Renamed_%');
  const emptyBundle = (await pool.query("SELECT bundle_id FROM workflow_folders WHERE relative_path='Foreign'")).rows[0]
    .bundle_id;
  for (const [from, to] of [
    ['Foreign', 'Trash/Foreign'],
    ['Trash/Foreign', 'Foreign'],
  ]) {
    await move(from, to);
    assert.equal(
      (await pool.query('SELECT bundle_id FROM workflow_folders WHERE relative_path=$1', [to])).rows[0].bundle_id,
      emptyBundle,
    );
    await assertParents();
  }
  const competing = await Promise.allSettled([move('Plain_%', 'Original/Plain_%'), move('Plain_%', 'Trash/Plain_%')]);
  assert.equal(competing.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(competing.filter((result) => result.status === 'rejected').length, 1);
  assert.equal(competing.find((result) => result.status === 'rejected').reason.code, 'P0002');
  await assertParents();
  await verifyConcurrentTreeRead(pool, move, bundleId);
  await pool.query('DROP TABLE unrelated_application_sentinel');
  console.log(
    'Folder migration: schema-16 reproduction, validated atomic repair, identity/data preservation, wildcard moves, root moves and rollback passed.',
  );
}

/** Commit a real move after the folder SELECT but before the project SELECT.
 * A tree must describe one snapshot, never a mixture of the two locations. */
async function verifyConcurrentTreeRead(pool, move, bundleId) {
  const queries = createManagedWorkflowQueries(pool);
  const initialize = async () => {};
  let interleave = true;
  let failNextRead = false;
  let releaseReads;
  const moved = new Promise((resolve) => {
    releaseReads = resolve;
  });
  const catalog = createManagedWorkflowCatalogService({
    context: {
      pool,
      initialize,
      ...createManagedWorkflowTransactionRunner({ pool, initialize }),
      db: {
        queryRows: async (client, sql, params) => {
          await moved;
          if (failNextRead) {
            failNextRead = false;
            throw new Error('Injected tree read failure');
          }
          return queryRows(client, sql, params);
        },
      },
      queries: {
        ...queries,
        listFolderRows: async (client) => {
          const rows = await queries.listFolderRows(client);
          if (interleave) {
            interleave = false;
            try {
              await move('Renamed_%', 'Trash/Concurrent_%');
            } finally {
              releaseReads();
            }
          }
          return rows;
        },
      },
      mappers,
      revisions: {},
      blobStore: {
        getText: async () => {
          throw new Error('Cached tree stats must not read blobs');
        },
      },
      executionInvalidationController: {
        queueWorkflowInvalidation() {},
        queueGlobalInvalidation() {},
        queueCatalogInvalidation() {},
      },
    },
  });
  const assertBundle = (tree, path) => {
    assert.deepEqual(tree.projects, [], 'Concurrent move must not detach projects to the catalog root.');
    const allFolders = (folders) => folders.flatMap((folder) => [folder, ...allFolders(folder.folders)]);
    const bundle = allFolders(tree.folders).find((folder) => folder.bundleId === bundleId);
    assert.equal(bundle?.relativePath, path);
    const projects = [bundle, ...allFolders(bundle.folders)].flatMap((folder) => folder.projects);
    assert.deepEqual(projects.map((project) => project.projectMetadataId).sort(), ['child', 'root']);
    for (const project of projects) {
      assert.equal(project.bundleId, bundleId);
      assert.ok(project.relativePath.startsWith(path + '/'));
    }
  };
  assertBundle(await catalog.getTree(), 'Renamed_%');
  assertBundle(await catalog.getTree(), 'Trash/Concurrent_%');
  failNextRead = true;
  await assert.rejects(catalog.getTree(), /Injected tree read failure/);
  assertBundle(await catalog.getTree(), 'Trash/Concurrent_%');
  assert.equal(pool.idleCount, pool.totalCount, 'Tree snapshot must release its connection after success and failure.');
  console.log(
    'Concurrent tree read: coherent before/after snapshots, bundle membership and failed-read recovery passed.',
  );
}
