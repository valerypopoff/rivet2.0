import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import {
  serializeProject,
  SubGraphNodeImpl,
  type Project,
  type ProjectId,
  type GraphId,
  type SubGraphNode,
} from '@valerypopoff/rivet2-node';
import {
  migrateManagedWorkflowSchema,
  verifyManagedWorkflowSchema,
  CURRENT_MANAGED_WORKFLOW_SCHEMA_VERSION,
  MANAGED_WORKFLOW_SCHEMA_MIGRATIONS,
} from '../routes/workflows/managed/schema-migrations.js';
import { createManagedWorkflowRevisionFactory } from '../routes/workflows/managed/revision-factory.js';
import { readIndexedProjectReferences, INCOMING_REFERENCE_SQL } from '../routes/workflows/managed/reference-index.js';
import { queryReferences } from '../routes/workflows/managed/reference-query.js';
import { backfillProjectReferences } from '../routes/workflows/managed/reference-backfill.js';
import { scanIncomingProjectReferences } from '../routes/workflows/project-references.js';
import type { WorkflowProjectReferenceSnapshot } from '../routes/workflows/project-reference-snapshots.js';
import type { ManagedWorkflowBlobStore } from '../routes/workflows/managed/blob-store.js';
import { getWorkflowProjectIndexDataFromContents } from '../routes/workflows/project-index.js';

const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8', timeout: 60_000 }).trim();
const signal = new AbortController().signal;
function project(id: string, targets: string[] = []): Project {
  return {
    metadata: { id: id as ProjectId, title: id, description: '' },
    graphs: {
      ['main' as GraphId]: {
        metadata: { id: 'main' as GraphId, name: 'Folder/Main' },
        connections: [],
        nodes: targets.map((target, i) => {
          const call = SubGraphNodeImpl.create();
          call.id = `call-${i}` as typeof call.id;
          call.data.targetProjectId = target as ProjectId;
          call.data.targetVersion = i % 2 ? 'published' : 'latest';
          call.data.graphId = 'main' as GraphId;
          return call;
        }),
      },
    },
  };
}
const serialized = (value: Project) => serializeProject(value) as string;
let container: string | undefined;
let pool: Pool | undefined;
let observer: Pool | undefined;
let server: ReturnType<typeof createServer> | undefined;
try {
  container = docker(
    'run',
    '--rm',
    '-d',
    '--name',
    `rivet-reference-test-${randomUUID()}`,
    '--memory',
    '512m',
    '--cpus',
    '1',
    '-p',
    '127.0.0.1::5432',
    '-e',
    'POSTGRES_HOST_AUTH_METHOD=trust',
    'postgres:16.8-alpine',
  );
  const port = docker(
    'inspect',
    '--format',
    '{{(index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort}}',
    container,
  );
  const config = {
    connectionString: `postgres://postgres@127.0.0.1:${port}/postgres`,
    max: 2,
    connectionTimeoutMillis: 1000,
  };
  pool = new Pool(config);
  observer = new Pool({ ...config, max: 1 });
  const ready = Date.now() + 30_000;
  for (;;) {
    try {
      await pool.query('SELECT 1');
      break;
    } catch (error) {
      if (Date.now() > ready) throw error;
      await delay(100);
    }
  }
  await pool.query(`CREATE TABLE managed_workflow_schema_migrations (
    version INTEGER PRIMARY KEY CHECK(version > 0), name TEXT NOT NULL, checksum TEXT NOT NULL CHECK(char_length(checksum)=64),
    application_version TEXT, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  for (const migration of MANAGED_WORKFLOW_SCHEMA_MIGRATIONS.filter((entry) => entry.version <= 18)) {
    await pool.query(migration.sql);
    await pool.query('INSERT INTO managed_workflow_schema_migrations(version,name,checksum) VALUES($1,$2,$3)', [
      migration.version,
      migration.name,
      migration.checksum,
    ]);
  }
  const migrated = await migrateManagedWorkflowSchema(pool, {
    migrationPolicy: 'rolling',
    logger: { log() {}, warn() {} },
  });
  assert.deepEqual(migrated.appliedVersions, [19]);
  assert.equal((await verifyManagedWorkflowSchema(pool)).currentVersion, CURRENT_MANAGED_WORKFLOW_SCHEMA_VERSION);
  const probes = await import(
    new URL('../../../../deploy/studio-server/scripts/lib/schema-compatibility-probe.mjs', import.meta.url).href
  );
  const probeSchema = `rivet_schema_probe_${randomUUID().replaceAll('-', '')}`;
  const contentionPool = new Pool({ ...config, max: 3 });
  try {
    await pool.query(`CREATE SCHEMA ${probeSchema}`);
    await probes.probeSchemaLockContention(contentionPool, probeSchema, MANAGED_WORKFLOW_SCHEMA_MIGRATIONS.at(-1));
  } finally {
    await contentionPool.end();
    await pool.query(`DROP SCHEMA ${probeSchema} CASCADE`);
  }
  const blobs = new Map<string, string>();
  const reads: string[] = [];
  const blobStore = {
    putText: async (key: string, value: string) => {
      blobs.set(key, value);
    },
    getText: async (key: string, options?: { signal?: AbortSignal }) => {
      reads.push(key);
      assert.ok(options?.signal, 'Backfill propagates cancellation into artifact reads');
      if (!blobs.has(key)) throw new Error('fixture artifact missing');
      return blobs.get(key)!;
    },
  } as unknown as ManagedWorkflowBlobStore;
  const factory = createManagedWorkflowRevisionFactory({ blobStore, queueObjectDeletions: async () => 0 });
  const snapshots = new Map<string, WorkflowProjectReferenceSnapshot[]>();
  const revisionIds = new Map<string, string>();
  async function add(value: Project) {
    const id = value.metadata.id;
    const contents = serialized(value);
    const revision = await factory.createRevision(id, contents, null);
    const client = await pool!.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO workflows(workflow_id, name, file_name, relative_path, folder_relative_path, current_draft_revision_id)
        VALUES ($1, $1, $1 || '.rivet-project', $1 || '.rivet-project', '', $2)`,
        [id, revision.revision_id],
      );
      await factory.insertRevision(client, revision);
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    snapshots.set(`${id}.rivet-project`, [{ source: { kind: 'saved-latest' }, contents }]);
    revisionIds.set(id, revision.revision_id);
    return revision;
  }
  await add(project('target'));
  const caller = project('caller', ['target', 'target', 'other']);
  caller.references = [{ id: 'target' as ProjectId, title: 'Target', hintPaths: [] }];
  const prefab = caller.graphs['main' as GraphId]!.nodes[0]!;
  caller.nodePrefabs = { prefab: { id: 'prefab', sourceNode: prefab } } as unknown as Project['nodePrefabs'];
  caller.graphs['main' as GraphId]!.nodes.push({
    ...prefab,
    id: 'instance' as typeof prefab.id,
    type: 'nodePrefabInstance',
    data: { prefabId: 'prefab' },
  });
  caller.graphs['main' as GraphId]!.nodes.push({ ...prefab, id: 'disabled' as typeof prefab.id, disabled: true });
  caller.graphs['main' as GraphId]!.nodes.push({
    ...prefab,
    id: 'legacy' as typeof prefab.id,
    type: 'referencedGraphAlias',
    data: { projectId: 'target', graphId: 'main' },
  });
  const draft = await add(caller);
  const published = project('caller', ['target']);
  const publication = await factory.createRevision('caller', serialized(published), null);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await factory.insertRevision(client, publication);
    await client.query(
      "UPDATE workflows SET published_revision_id = $1, published_endpoint_name = 'caller-endpoint' WHERE workflow_id = 'caller'",
      [publication.revision_id],
    );
    await client.query(
      `INSERT INTO workflow_web_apps(app_id,workflow_id,revision_id,ui_graph_id,slug,slug_lookup_name)
      VALUES ('app','caller',$1,'ui','caller-app','caller-app')`,
      [publication.revision_id],
    );
    await client.query('COMMIT');
  } finally {
    client.release();
  }
  snapshots
    .get('caller.rivet-project')!
    .push(
      { source: { kind: 'published-endpoint', label: 'caller-endpoint' }, contents: serialized(published) },
      { source: { kind: 'published-web-app', label: 'caller-app' }, contents: serialized(published) },
    );
  for (let i = 0; i < 320; i++) await add(project(`unrelated-${String(i).padStart(3, '0')}`, Array(200).fill('other')));
  // Historic revisions are intentionally irrelevant to live dependency checks.
  await pool.query(
    `INSERT INTO workflow_revisions(revision_id,workflow_id,project_blob_key,reference_summary)
    SELECT 'archive-' || n, 'caller', 'unused', $1::jsonb FROM generate_series(1, 10000) n`,
    [JSON.stringify(draft.reference_summary)],
  );
  await pool.query('ANALYZE');
  const plan = (
    await pool.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${INCOMING_REFERENCE_SQL}`, [null, 'target', ['main'], 1])
  ).rows[0]['QUERY PLAN'][0];
  const revisionAccess: string[] = [];
  const visit = (node: Record<string, unknown>) => {
    if (node['Relation Name'] === 'workflow_revisions')
      revisionAccess.push(String(node['Node Type']) + ':' + String(node['Index Name'] ?? 'none'));
    for (const child of (node.Plans ?? []) as Record<string, unknown>[]) visit(child);
  };
  visit(plan.Plan);
  console.log(JSON.stringify({ sqlExecutionMs: plan['Execution Time'], revisionAccess }));
  const catalog = [...snapshots].map(([relativePath]) => ({
    relativePath,
    name: relativePath.replace('.rivet-project', ''),
    projectMetadataId: relativePath.replace('.rivet-project', ''),
    identity: 'fixture',
  }));
  const canonical = (result: unknown) =>
    JSON.parse(JSON.stringify(result, (key, value) => (key === 'incompleteReasons' ? undefined : value)));
  for (const graphIds of [undefined, ['main']]) {
    const indexed = await readIndexedProjectReferences(pool, { expectedProjectId: 'target', graphIds, signal });
    const scanned = await scanIncomingProjectReferences({
      expectedProjectId: 'target',
      graphIds,
      signal,
      getCatalog: async () => catalog,
      readSaved: async () => snapshots.get('target.rivet-project')![0]!.contents,
      readSnapshots: async (path) => snapshots.get(path)!,
    });
    // Graph edge order is not part of the API contract.
    const normalize = (result: typeof indexed) => ({
      ...result,
      ...(graphIds
        ? {
            graphReferences: [...result.graphReferences!].sort((a, b) =>
              JSON.stringify(a).localeCompare(JSON.stringify(b)),
            ),
          }
        : {}),
    });
    assert.deepEqual(
      canonical(normalize(indexed)),
      canonical(normalize(scanned)),
      'Indexed lookup preserves scanner semantics',
    );
  }
  assert.equal(reads.length, 0, 'Healthy checks never read blobs');
  await pool.query("UPDATE workflows SET published_endpoint_name = '' WHERE workflow_id = 'caller'");
  const blankLabel = await readIndexedProjectReferences(pool, { expectedProjectId: 'target', signal });
  assert.equal(blankLabel.references[0]!.sources.find((source) => source.kind === 'published-endpoint')!.label, '');
  await pool.query("UPDATE workflows SET published_endpoint_name = 'caller-endpoint' WHERE workflow_id = 'caller'");
  if (draft.reference_summary?.state !== 'complete') throw new Error('Expected fixture summary');
  await pool.query('UPDATE workflow_revisions SET reference_summary = $1::jsonb WHERE revision_id = $2', [
    JSON.stringify({ ...draft.reference_summary, projectTargets: null }),
    draft.revision_id,
  ]);
  assert.equal(
    (await readIndexedProjectReferences(pool, { expectedProjectId: 'target', graphIds: ['main'], signal })).complete,
    true,
  );
  assert.equal((await readIndexedProjectReferences(pool, { expectedProjectId: 'target', signal })).complete, false);
  await pool.query('UPDATE workflow_revisions SET reference_summary = $1::jsonb WHERE revision_id = $2', [
    JSON.stringify(draft.reference_summary),
    draft.revision_id,
  ]);
  // A graph-only extraction failure must not invalidate project-level facts.
  await pool.query('UPDATE workflow_revisions SET reference_summary = $1::jsonb WHERE revision_id = $2', [
    JSON.stringify({ ...draft.reference_summary, graphCalls: null }),
    draft.revision_id,
  ]);
  assert.equal((await readIndexedProjectReferences(pool, { expectedProjectId: 'target', signal })).complete, true);
  assert.equal(
    (await readIndexedProjectReferences(pool, { expectedProjectId: 'target', graphIds: ['main'], signal })).complete,
    false,
  );
  await pool.query('UPDATE workflow_revisions SET reference_summary = $1::jsonb WHERE revision_id = $2', [
    JSON.stringify(draft.reference_summary),
    draft.revision_id,
  ]);
  // Advisory metadata must not make an otherwise permitted artifact save fail.
  await assert.rejects(pool.query('SELECT $1::jsonb', [JSON.stringify({ title: 'bad\0title' })]), { code: '22P05' });
  const unsafeText = project('caller', ['target']);
  unsafeText.graphs['main' as GraphId]!.nodes[0]!.title = 'bad\0title';
  const unsafeRevision = await factory.createRevision('caller', serialized(unsafeText), null);
  assert.equal(unsafeRevision.reference_summary?.state, 'complete');
  if (unsafeRevision.reference_summary?.state !== 'complete') throw new Error('Expected project summary');
  assert.equal(unsafeRevision.reference_summary.graphCalls, null);
  const unsafeClient = await pool.connect();
  try {
    await factory.insertRevision(unsafeClient, unsafeRevision);
  } finally {
    unsafeClient.release();
  }
  await pool.query('UPDATE workflow_revisions SET reference_summary = NULL WHERE revision_id = $1', [
    unsafeRevision.revision_id,
  ]);
  await pool.query("UPDATE workflows SET current_draft_revision_id = $1 WHERE workflow_id = 'caller'", [
    unsafeRevision.revision_id,
  ]);
  const partialRepair = await backfillProjectReferences({ pool, blobStore, signal, maxRevisions: 1 });
  assert.deepEqual(partialRepair.failures, [{ revisionId: unsafeRevision.revision_id, reason: 'invalid-summary' }]);
  assert.equal((await readIndexedProjectReferences(pool, { expectedProjectId: 'target', signal })).complete, true);
  assert.equal(
    (await readIndexedProjectReferences(pool, { expectedProjectId: 'target', graphIds: ['main'], signal })).complete,
    false,
  );
  await pool.query("UPDATE workflows SET current_draft_revision_id = $1 WHERE workflow_id = 'caller'", [
    draft.revision_id,
  ]);
  // The target's outgoing calls are irrelevant to validating its incoming callers.
  const invalidTarget = project('target', ['outside']);
  (invalidTarget.graphs['main' as GraphId]!.nodes[0]! as SubGraphNode).data.targetVersion = 'invalid' as never;
  const targetRevision = await factory.createRevision('target', serialized(invalidTarget), null);
  assert.equal(targetRevision.reference_summary?.state, 'invalid');
  const targetClient = await pool.connect();
  try {
    await factory.insertRevision(targetClient, targetRevision);
  } finally {
    targetClient.release();
  }
  await pool.query("UPDATE workflows SET current_draft_revision_id = $1 WHERE workflow_id = 'target'", [
    targetRevision.revision_id,
  ]);
  for (const graphIds of [undefined, ['main']])
    assert.equal(
      (await readIndexedProjectReferences(pool, { expectedProjectId: 'target', graphIds, signal })).complete,
      true,
    );
  await pool.query("UPDATE workflows SET current_draft_revision_id = 'absent-target' WHERE workflow_id = 'target'");
  assert.deepEqual(
    (await readIndexedProjectReferences(pool, { expectedProjectId: 'target', signal })).incompleteReasons,
    ['invalid-summary'],
  );
  await pool.query("UPDATE workflows SET current_draft_revision_id = $1 WHERE workflow_id = 'target'", [
    revisionIds.get('target'),
  ]);
  const empty = await readIndexedProjectReferences(pool, {
    expectedProjectId: 'unrelated-319',
    graphIds: ['main'],
    signal,
  });
  assert.equal(empty.complete, true);
  assert.deepEqual(empty.references, []);
  const writerPayload = snapshots.get('unrelated-000.rivet-project')![0]!.contents;
  const writerTimes: number[][] = [[], []];
  for (let i = 0; i < 50; i++)
    for (const references of [false, true]) {
      const start = performance.now();
      getWorkflowProjectIndexDataFromContents(writerPayload, null, references);
      writerTimes[Number(references)]!.push(performance.now() - start);
    }
  console.log(
    JSON.stringify({
      writerMetadataSamples: 50,
      statsOnlyP95Ms: Math.round(writerTimes[0]!.sort((a, b) => a - b)[47]!),
      statsAndReferencesP95Ms: Math.round(writerTimes[1]!.sort((a, b) => a - b)[47]!),
    }),
  );
  await assert.rejects(
    readIndexedProjectReferences(pool, { expectedProjectId: 'wrong', relativePath: 'target.rivet-project', signal }),
    /changed/,
  );
  await assert.rejects(readIndexedProjectReferences(pool, { expectedProjectId: 'absent', signal }), /not found/);
  // Old writer inserts / missing, outdated, invalid, and newer summaries.
  await pool.query('UPDATE workflow_revisions SET reference_summary = NULL WHERE revision_id = $1', [
    draft.revision_id,
  ]);
  let partial = await readIndexedProjectReferences(pool, { expectedProjectId: 'target', graphIds: ['main'], signal });
  assert.equal(partial.complete, false);
  assert.equal(partial.checkedProjects, 320);
  assert.ok(
    partial.graphReferences!.some((call) => call.source.kind === 'published-endpoint'),
    'Known publication edges survive missing drafts',
  );
  assert.deepEqual(partial.incompleteReasons, ['missing-summary']);
  await pool.query(
    'UPDATE workflow_revisions SET reference_summary = \'{"version":1,"state":"invalid","reason":"invalid-project"}\' WHERE revision_id = $1',
    [draft.revision_id],
  );
  const invalid = await readIndexedProjectReferences(pool, { expectedProjectId: 'target', graphIds: ['main'], signal });
  assert.deepEqual(invalid.incompleteReasons, ['invalid-summary']);
  assert.equal(invalid.graphReferences!.length, 2);
  await pool.query('UPDATE workflow_revisions SET reference_summary = NULL WHERE revision_id = $1', [
    draft.revision_id,
  ]);
  const repair = await backfillProjectReferences({ pool, blobStore, signal, maxRevisions: 100 });
  assert.equal(repair.updated, 1);
  assert.deepEqual(repair.coverage, { total: 323, complete: 323 });
  assert.equal((await backfillProjectReferences({ pool, blobStore, signal, maxRevisions: 100 })).attempted, 0);
  // Compare the original PostgreSQL JSONB value without lossy JavaScript conversion.
  for (const stale of ['null', '{"version":0,"counter":9007199254740993}']) {
    await pool.query('UPDATE workflow_revisions SET reference_summary = $1::jsonb WHERE revision_id = $2', [
      stale,
      draft.revision_id,
    ]);
    const repaired = await backfillProjectReferences({ pool, blobStore, signal, maxRevisions: 1 });
    assert.equal(repaired.updated, 1, `Repair must retain the exact old value: ${stale}`);
    assert.equal(repaired.coverage.complete, repaired.coverage.total);
  }
  await pool.query(
    'UPDATE workflow_revisions SET reference_summary = reference_summary || \'{"version":0}\'::jsonb WHERE revision_id = $1',
    [draft.revision_id],
  );
  partial = await readIndexedProjectReferences(pool, { expectedProjectId: 'target', signal });
  assert.deepEqual(partial.incompleteReasons, ['outdated-summary']);
  assert.equal((await backfillProjectReferences({ pool, blobStore, signal, maxRevisions: 1 })).updated, 1);
  await pool.query('UPDATE workflow_revisions SET reference_summary = \'{"version":99}\' WHERE revision_id = $1', [
    draft.revision_id,
  ]);
  assert.equal(
    (await backfillProjectReferences({ pool, blobStore, signal, maxRevisions: 100 })).updated,
    0,
    'Never downgrade a future summary',
  );
  await pool.query('UPDATE workflow_revisions SET reference_summary = $1::jsonb WHERE revision_id = $2', [
    JSON.stringify(draft.reference_summary),
    draft.revision_id,
  ]);
  // Concurrent extraction wins over a stale read; a pointer switch is picked up
  // by the next batch, and unreadable blobs are attempted only once per run.
  const concurrentId = revisionIds.get('unrelated-000')!;
  await pool.query('UPDATE workflow_revisions SET reference_summary = NULL WHERE revision_id = $1', [concurrentId]);
  const raced = await backfillProjectReferences({
    pool,
    signal,
    maxRevisions: 2,
    blobStore: {
      ...blobStore,
      getText: async (key, options) => {
        await pool!.query('UPDATE workflow_revisions SET reference_summary = \'{"version":99}\' WHERE revision_id=$1', [
          concurrentId,
        ]);
        return blobStore.getText(key, options);
      },
    },
  });
  assert.equal(raced.updated, 0);
  assert.equal(
    (await pool.query('SELECT reference_summary FROM workflow_revisions WHERE revision_id=$1', [concurrentId])).rows[0]
      .reference_summary.version,
    99,
  );
  await pool.query('UPDATE workflow_revisions SET reference_summary = NULL WHERE revision_id = $1', [concurrentId]);
  let failedReads = 0;
  const failed = await backfillProjectReferences({
    pool,
    signal,
    maxRevisions: 100,
    blobStore: {
      ...blobStore,
      getText: async () => {
        failedReads++;
        throw new Error('fixture failure');
      },
    },
  });
  assert.equal(failedReads, 1);
  assert.deepEqual(failed.failures, [{ revisionId: concurrentId, reason: 'unreadable-artifact' }]);
  assert.equal((await backfillProjectReferences({ pool, blobStore, signal, maxRevisions: 100 })).updated, 1);
  const peerSummary = (
    await pool.query('SELECT reference_summary::text AS value FROM workflow_revisions WHERE revision_id = $1', [
      concurrentId,
    ])
  ).rows[0].value;
  await pool.query('UPDATE workflow_revisions SET reference_summary = NULL WHERE revision_id = $1', [concurrentId]);
  const repairedByPeer = await backfillProjectReferences({
    pool,
    signal,
    maxRevisions: 1,
    blobStore: {
      ...blobStore,
      getText: async () => {
        await pool!.query('UPDATE workflow_revisions SET reference_summary = $1::jsonb WHERE revision_id = $2', [
          peerSummary,
          concurrentId,
        ]);
        throw new Error('This artifact read failed while another operator repaired the index');
      },
    },
  });
  assert.deepEqual(repairedByPeer.failures, [{ revisionId: concurrentId, reason: 'unreadable-artifact' }]);
  assert.equal(repairedByPeer.updated, 0);
  assert.equal(
    repairedByPeer.coverage.complete,
    repairedByPeer.coverage.total,
    'Final coverage supersedes a failed attempt',
  );
  const renamed = 'Renamed caller';
  await pool.query(
    "UPDATE workflows SET name = $1, relative_path = 'Moved/caller.rivet-project' WHERE workflow_id = 'caller'",
    [renamed],
  );
  assert.equal(
    (await readIndexedProjectReferences(pool, { expectedProjectId: 'target', graphIds: ['main'], signal }))
      .references[0]!.name,
    renamed,
  );
  await pool.query(
    "UPDATE workflows SET name = 'caller', relative_path = 'caller.rivet-project' WHERE workflow_id = 'caller'",
  );
  const many = project('caller', Array(1001).fill('target'));
  const manyRevision = await factory.createRevision('caller', serialized(many), null);
  const attach = await pool.connect();
  try {
    await attach.query('BEGIN');
    await factory.insertRevision(attach, manyRevision);
    await attach.query("UPDATE workflows SET current_draft_revision_id = $1 WHERE workflow_id = 'caller'", [
      manyRevision.revision_id,
    ]);
    const before = await readIndexedProjectReferences(pool, {
      expectedProjectId: 'target',
      graphIds: ['main'],
      signal,
    });
    assert.equal(before.graphReferencesTruncated, false, 'Uncommitted revisions and pointers stay invisible');
    await attach.query('COMMIT');
  } finally {
    attach.release();
  }
  const limited = await readIndexedProjectReferences(pool, { expectedProjectId: 'target', graphIds: ['main'], signal });
  assert.equal(limited.graphReferences!.length, 1000);
  assert.equal(limited.graphReferencesTruncated, true);
  assert.deepEqual(limited.incompleteReasons, ['result-limit']);
  const largeLabel = project('caller', ['target']);
  largeLabel.graphs['main' as GraphId]!.nodes[0]!.title = 'x'.repeat(2200000);
  const largeRevision = await factory.createRevision('caller', serialized(largeLabel), null);
  const largeClient = await pool.connect();
  try {
    await factory.insertRevision(largeClient, largeRevision);
  } finally {
    largeClient.release();
  }
  await pool.query("UPDATE workflows SET current_draft_revision_id = $1 WHERE workflow_id = 'caller'", [
    largeRevision.revision_id,
  ]);
  const byteLimited = await readIndexedProjectReferences(pool, {
    expectedProjectId: 'target',
    graphIds: ['main'],
    signal,
  });
  assert.equal(byteLimited.complete, false);
  assert.deepEqual(byteLimited.incompleteReasons, ['result-limit']);
  assert.ok(
    Buffer.byteLength(JSON.stringify(byteLimited)) < 2 * 1024 * 1024,
    'Large caller labels cannot amplify the response without a bound',
  );
  await pool.query("UPDATE workflows SET current_draft_revision_id = $1 WHERE workflow_id = 'caller'", [
    draft.revision_id,
  ]);
  // A revision restored from history needs coverage repair, without scanning the archive.
  await pool.query("UPDATE workflows SET current_draft_revision_id = 'absent-revision' WHERE workflow_id = 'caller'");
  assert.deepEqual(
    (await readIndexedProjectReferences(pool, { expectedProjectId: 'target', graphIds: ['main'], signal }))
      .incompleteReasons,
    ['invalid-summary'],
    'A missing revision is a metadata error, not pending indexing',
  );
  await pool.query("UPDATE workflows SET current_draft_revision_id = 'archive-1' WHERE workflow_id = 'caller'");
  await pool.query(
    "UPDATE workflow_revisions SET reference_summary = NULL, project_blob_key = $1 WHERE revision_id = 'archive-1'",
    [draft.project_blob_key],
  );
  assert.equal((await backfillProjectReferences({ pool, blobStore, signal, maxRevisions: 100 })).updated, 1);
  await pool.query("UPDATE workflows SET current_draft_revision_id = $1 WHERE workflow_id = 'caller'", [
    draft.revision_id,
  ]);
  // SQL statement timeout and cancellation clean up the backend query and its session.
  await assert.rejects(queryReferences(pool, 'SELECT pg_sleep(5)', [], signal, { timeoutMs: 40 }), /timed out/);
  assert.equal((await pool.query('SHOW statement_timeout')).rows[0].statement_timeout, '0');
  const held = await pool.connect();
  try {
    await held.query('BEGIN');
    await held.query('LOCK TABLE workflows IN ACCESS EXCLUSIVE MODE');
    await assert.rejects(
      queryReferences(pool, INCOMING_REFERENCE_SQL, [null, 'target', ['main'], 1], signal, { timeoutMs: 50 }),
      /timed out/,
    );
  } finally {
    await held.query('ROLLBACK');
    held.release();
  }
  await delay(50);
  assert.equal(
    (
      await observer.query(
        "SELECT count(*)::int AS n FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND state = 'active'",
      )
    ).rows[0].n,
    0,
  );
  // Measure the HTTP -> query -> response path with no process-local summary cache.
  server = createServer(async (_req, res) => {
    try {
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify(
          await readIndexedProjectReferences(pool!, { expectedProjectId: 'target', graphIds: ['main'], signal }),
        ),
      );
    } catch {
      res.statusCode = 500;
      res.end('{}');
    }
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  const times: number[] = [];
  for (let i = 0; i < 100; i++) {
    const start = performance.now();
    const response = await fetch(`http://127.0.0.1:${address.port}/references`);
    assert.equal(response.status, 200);
    const result = (await response.json()) as { complete: boolean; checkedProjects: number };
    assert.equal(result.complete, true);
    assert.equal(result.checkedProjects, 321);
    times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  const report = {
    projects: 322,
    archivedRevisions: 10000,
    unrelatedCallsPerProject: 200,
    samples: 100,
    p95Ms: Math.round(times[94]!),
    p99Ms: Math.round(times[98]!),
    maxMs: Math.round(times[99]!),
    blobReadsDuringLookup: 0,
  };
  console.log(JSON.stringify(report));
  assert.ok(report.p95Ms <= 2000 && report.p99Ms <= 5000, 'Local end-to-end latency targets');
  // One first request in a separate Node process, with a fresh pool and no
  // previously loaded application state. Database and OS caches remain warm.
  const worker = spawn(process.execPath, [...process.execArgv, '--input-type=module', '-'], {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let workerErrors = '';
  worker.stderr.on('data', (chunk) => {
    workerErrors = (workerErrors + chunk.toString()).slice(-4000);
  });
  try {
    const endpoint = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Cold worker did not start')), 20000);
      let output = '';
      worker.stdout.on('data', (chunk) => {
        output += chunk.toString();
        const match = /REFERENCE_PORT (\d+)/.exec(output);
        if (match) {
          clearTimeout(timer);
          resolve(`http://127.0.0.1:${match[1]}/`);
        }
      });
      worker.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      worker.once('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`Cold worker exited (${code}): ${workerErrors}`));
      });
    });
    worker.stdin.end(`
      import { createRequire } from 'node:module';
      import { createServer } from 'node:http';
      const { Pool } = createRequire(${JSON.stringify(new URL('../../package.json', import.meta.url).href)})('pg');
      const { readIndexedProjectReferences } = await import(${JSON.stringify(new URL('../routes/workflows/managed/reference-index.ts', import.meta.url).href)});
      const pool = new Pool(${JSON.stringify(config)});
      const server = createServer(async (_, res) => {
        try { res.end(JSON.stringify(await readIndexedProjectReferences(pool, { expectedProjectId: 'target', graphIds: ['main'], signal: new AbortController().signal }))); }
        catch { res.statusCode = 500; res.end('{}'); }
      });
      server.listen(0, '127.0.0.1', () => console.log('REFERENCE_PORT ' + server.address().port));
    `);
    const url = await endpoint;
    const start = performance.now();
    const response = await fetch(url);
    const body = (await response.json()) as { complete: boolean; checkedProjects: number };
    const coldFirstRequestMs = Math.round(performance.now() - start);
    assert.equal(response.status, 200);
    assert.equal(body.complete, true);
    assert.equal(body.checkedProjects, 321);
    assert.ok(coldFirstRequestMs <= 2000);
    console.log(JSON.stringify({ coldProcessFirstRequestMs: coldFirstRequestMs, databaseCache: 'warm' }));
  } finally {
    if (worker.exitCode === null) {
      const exited = new Promise<void>((resolve) => worker.once('exit', () => resolve()));
      worker.kill();
      await exited;
    }
  }
  console.log('Reference summary migration, writer, parity, coverage, backfill, deadlines and HTTP latency passed.');
} finally {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  await pool?.end();
  await observer?.end();
  if (container) docker('stop', container);
}
