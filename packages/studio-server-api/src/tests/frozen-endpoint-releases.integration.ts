import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { Client, Pool } from 'pg';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { S3ManagedWorkflowBlobStore } from '../routes/workflows/managed/blob-store.js';
import {
  createProcessor,
  getGraphBoundary,
  GraphOutputNodeImpl,
  LLMChatV2NodeImpl,
  serializeDatasets,
  serializeProject,
  SubGraphNodeImpl,
  TextNodeImpl,
  type DatasetId,
  type GraphId,
  type PortId,
  type Project,
  type ProjectId,
} from '@valerypopoff/rivet2-node';
import { ManagedWorkflowBackend } from '../routes/workflows/managed/backend.js';
import { createManagedWorkflowQueries } from '../routes/workflows/managed/db.js';
import { prepareEndpointRelease, validatePreparedEndpointReleases } from '../routes/workflows/managed/endpoint-releases.js';
import { getManagedWorkflowProjectVirtualPath } from '../routes/workflows/virtual-paths.js';
import { getWorkflowTreeSyncState } from '../routes/workflows/workflow-tree-events.js';
import { backfillProjectReferences } from '../routes/workflows/managed/reference-backfill.js';
import { findManagedWorkflowObjectReferences } from '../routes/workflows/managed/workflow-object-references.js';
import { MANAGED_WORKFLOW_SCHEMA_MIGRATIONS } from '../routes/workflows/managed/schema-migrations.js';
import type { WorkflowProjectItem } from '../../../studio-server-shared/workflow-types.js';
import { startManagedHistoryStorage } from './helpers/managed-history-storage.js';

const providedDatabase = process.env.RIVET_TEST_HISTORY_DATABASE_URL || undefined;
const providedObjectStorage = process.env.RIVET_TEST_HISTORY_OBJECT_URL || undefined;
assert.equal(Boolean(providedDatabase), Boolean(providedObjectStorage), 'Supply both local storage URLs or neither.');
const fixture = providedDatabase ? null : await startManagedHistoryStorage();
const database = new URL(providedDatabase ?? fixture!.databaseUrl);
const objectStorage = new URL(providedObjectStorage ?? fixture!.objectStorageUrl);
assert.equal(database.hostname, '127.0.0.1');
assert.equal(objectStorage.hostname, '127.0.0.1');
const schema = `rivet_schema_probe_${randomUUID().replaceAll('-', '')}`;
const admin = new Pool({ connectionString: database.toString(), connectionTimeoutMillis: 5000 });
const probe = `rivet_schema_probe_${randomUUID().replaceAll('-', '')}`;
database.searchParams.set('options', `-c search_path=${schema}`);
const config = {
  databaseMode: 'managed',
  databaseUrl: database.toString(),
  databaseSslMode: 'disable',
  objectStorageBucket: 'rivet-history-test',
  objectStorageRegion: 'us-east-1',
  objectStorageEndpoint: objectStorage.origin,
  objectStorageAccessKeyId: 'rivet-history',
  objectStorageSecretAccessKey: 'local-verification-only',
  objectStorageForcePathStyle: true,
  objectStoragePrefix: schema,
} as const;
const ioMetrics = new AsyncLocalStorage<{ queries: number; objects: number }>();
const query = Client.prototype.query;
Client.prototype.query = function (this: Client, ...args: unknown[]) {
  const metrics = ioMetrics.getStore();
  if (metrics) metrics.queries++;
  return Reflect.apply(query, this, args);
} as typeof query;
function countObjectRead() {
  const metrics = ioMetrics.getStore();
  if (metrics) metrics.objects++;
}

class MeasuredBlobStore extends S3ManagedWorkflowBlobStore {
  override getBytes(key: string, options?: { signal?: AbortSignal }) {
    countObjectRead();
    return super.getBytes(key, options);
  }

  override exists(key: string) {
    countObjectRead();
    return super.exists(key);
  }
}

const writer = new ManagedWorkflowBackend(config, new MeasuredBlobStore(config));
const readerStore = new MeasuredBlobStore(config);
const reader = new ManagedWorkflowBackend(config, readerStore);
const fresh = new Pool({ connectionString: database.toString() });
const main = 'main' as GraphId;
const project = (id: string, payload: string | Project, version: 'latest' | 'published' = 'latest'): Project => {
  const source = typeof payload === 'string' ? TextNodeImpl.create() : SubGraphNodeImpl.create();
  if (source.type === 'text') {
    source.data.text = payload as string;
  } else if (typeof payload !== 'string') {
    source.data.targetProjectId = payload.metadata.id;
    source.data.targetVersion = version;
    source.data.graphId = main;
    source.data.targetBoundary = getGraphBoundary(payload, main)!;
  }
  const output = GraphOutputNodeImpl.create();
  output.data.id = 'result';
  return {
    metadata: { id: id as ProjectId, title: id, description: '', mainGraphId: main },
    graphs: {
      [main]: {
        metadata: { id: main, name: 'Main', description: '' },
        nodes: [source, output],
        connections: [
          {
            outputNodeId: source.id,
            outputId: (source.type === 'text' ? 'output' : 'result') as PortId,
            inputNodeId: output.id,
            inputId: 'value' as PortId,
          },
        ],
      },
    },
  };
};
const reviewed = (saved: WorkflowProjectItem) => ({
  expectedProjectId: saved.projectMetadataId!,
  expectedDraftRevisionId: saved.revisionId!,
  expectedPublicationVersion: saved.settings.publicationVersion!,
});
const datasetId = 'shared-dataset' as DatasetId;
const dataset = (owner: Project, value: string) =>
  serializeDatasets([
    {
      meta: { id: datasetId, projectId: owner.metadata.id, name: 'Fixture data', description: '' },
      data: { id: datasetId, rows: [{ id: 'row', data: [value] }] },
    },
  ]);
const put = (
  value: Project,
  relativePath: string,
  datasetsContents: string | null = null,
  legacyEndpointName = '',
) => {
  const contents = serializeProject(value) as string;
  return writer.importWorkflow({
    workflowId: value.metadata.id,
    relativePath,
    name: value.metadata.title!,
    contents,
    datasetsContents,
    endpointName: legacyEndpointName,
    publishedEndpointName: legacyEndpointName,
    ...(legacyEndpointName && { publishedContents: contents, publishedDatasetsContents: datasetsContents }),
  });
};
const save = async (previous: WorkflowProjectItem, value: Project, datasetsContents: string | null = null) =>
  (
    await writer.saveHostedProject({
      projectPath: getManagedWorkflowProjectVirtualPath(previous.relativePath),
      projectId: previous.projectMetadataId,
      expectedRevisionId: previous.revisionId,
      saveIntent: 'in-place',
      contents: serializeProject(value) as string,
      datasetsContents,
    })
  ).project!;
const publish = (saved: WorkflowProjectItem, endpointName: string, releaseReviewToken?: string) =>
  writer.publishWorkflowProjectItem(saved.relativePath, { endpointName, releaseReviewToken }, reviewed(saved));
const execute = async (name: string, instance = reader, { frozen = true, publicLookup = true } = {}) => {
  const loaded = await instance.loadPublishedExecutionProject(name, publicLookup);
  assert.ok(loaded);
  assert.equal(Boolean(loaded.frozenReferences), frozen, `Release mode for ${name}`);
  const processor = createProcessor(loaded.project, {
    ...(loaded.frozenReferences ?? {
      projectReferenceLoader: instance.createProjectReferenceLoader(),
      subgraphProjectLoader: { loadTarget: (target) => instance.loadSubgraphTarget(target) },
    }),
    datasetProvider: loaded.datasetProvider,
  });
  try {
    return (await processor.run()).result?.value;
  } finally {
    processor.dispose();
  }
};

const timings = async (sample: () => Promise<unknown>) => {
  for (let i = 0; i < 8; i++) await sample();
  const observations: number[] = [];
  for (let i = 0; i < 30; i++) {
    const started = performance.now();
    await sample();
    observations.push(performance.now() - started);
  }
  observations.sort((a, b) => a - b);
  return { p50: Number(observations[14]!.toFixed(2)), p95: Number(observations[28]!.toFixed(2)) };
};

const measure = process.argv.includes('--measure');
async function measureIo<T>(run: () => Promise<T>) {
  const counters = { queries: 0, objects: 0 };
  const started = performance.now();
  const result = await ioMetrics.run(counters, run);
  return { result, ...counters, ms: Number((performance.now() - started).toFixed(2)) };
}

async function profileEndpoint(name: string, frozen: boolean) {
  const cold = await measureIo(() => execute(name, reader, { frozen }));
  await execute(name, reader, { frozen, publicLookup: false });
  const publicLookup = await measureIo(() => execute(name, reader, { frozen }));
  const internalLookup = await measureIo(() => execute(name, reader, { frozen, publicLookup: false }));
  const warm = measure ? await timings(() => execute(name, reader, { frozen })) : undefined;
  return { cold, publicLookup, internalLookup, warm };
}

try {
  await admin.query(`CREATE SCHEMA ${schema}; CREATE SCHEMA ${probe}`);
  await writer.initialize();
  await reader.initialize();
  const probes = await import(
    new URL('../../../../deploy/studio-server/scripts/lib/schema-compatibility-probe.mjs', import.meta.url).href
  );
  const publicationMigration = MANAGED_WORKFLOW_SCHEMA_MIGRATIONS.find((migration) => migration.version === 22)!;
  await probes.probeSchemaLockContention(admin, probe, publicationMigration);
  const c1 = project('shared', 'C1');
  const inner = project('helper', c1);
  const a1 = project('a', inner);
  const b1 = project('b', c1);
  let c = await put(c1, 'Library/shared.rivet-project', dataset(c1, 'C1'));
  const helper = await put(inner, 'Experiment/deep/helper.rivet-project');
  await put(project('unrelated', 'unused'), 'Experiment/unused/unrelated.rivet-project');
  // Import the live snapshots a pre-capture server would have left behind.
  let a = await put(a1, 'Experiment/a.rivet-project', null, 'endpoint-a');
  let b = await put(b1, 'b.rivet-project');
  let standalone = await put(project('standalone', 'standalone'), 'standalone.rivet-project', null, 'standalone-endpoint');
  let legacy = await put(project('legacy', c1), 'legacy.rivet-project', null, 'legacy-endpoint');
  const bundleId = randomUUID();
  await fresh.query("UPDATE workflow_folders SET bundle_id = $1 WHERE relative_path = 'Experiment'", [bundleId]);
  const floatingStandalone = await profileEndpoint('standalone-endpoint', false);
  const floatingBundle = await profileEndpoint('endpoint-a', false);
  const readyToCapture = await writer.readWorkflowReferenceOverview();
  const legacyBundle = readyToCapture.endpoints.find((item) => item.projectId === a.projectMetadataId);
  assert.equal(legacyBundle?.coverage, 'project-only');
  assert.equal(legacyBundle?.canCaptureRelease, true);
  assert.ok(
    readyToCapture.endpoints.find((item) => item.projectId === standalone.projectMetadataId)?.canCaptureRelease,
  );
  a = await publish(a, 'endpoint-a');
  b = await publish(b, 'endpoint-b');
  standalone = await publish(standalone, 'standalone-endpoint');
  const frozenStandalone = await profileEndpoint('standalone-endpoint', true);
  const frozenBundle = await profileEndpoint('endpoint-a', true);
  for (const [floating, frozen] of [
    [floatingStandalone, frozenStandalone],
    [floatingBundle, frozenBundle],
  ] as const) {
    assert.equal(floating.publicLookup.result, frozen.publicLookup.result);
    assert.ok(frozen.cold.queries > 0 && frozen.cold.objects > 0, 'A cold release must exercise both storage counters.');
    assert.ok(frozen.publicLookup.queries <= 1, 'Warm public requests need at most the fresh endpoint lookup.');
    assert.equal(frozen.internalLookup.queries, 0, 'Warm internal requests reuse the endpoint and release.');
    assert.equal(frozen.publicLookup.objects + frozen.internalLookup.objects, 0, 'Warm requests reuse captured artifacts.');
  }
  if (measure)
    console.log(
      'Endpoint profiles',
      JSON.stringify({ floatingStandalone, frozenStandalone, floatingBundle, frozenBundle }),
    );
  const { result: currentReferences, objects: overviewReads } = await measureIo(() => writer.readWorkflowReferenceOverview());
  assert.equal(overviewReads, 0, 'The reference overview must use saved metadata without reading project artifacts.');
  assert.ok(
    !currentReferences.endpoints.find((item) => item.projectId === standalone.projectMetadataId)?.canCaptureRelease,
  );
  const standaloneHistory = (await writer.listWorkflowPublishedVersions(standalone.relativePath)).versions[0]!;
  const setStandaloneHistory = (versionId: string) => fresh.query(
    'UPDATE workflows SET published_version_id = $1 WHERE workflow_id = $2',
    [versionId, standalone.projectMetadataId],
  );
  await setStandaloneHistory('missing-active-history');
  try {
    await assert.rejects(writer.loadPublishedExecutionProject('standalone-endpoint', true), {
      status: 503,
      message: /active endpoint revision is missing from history/i,
    });
    const entry = (await writer.readWorkflowReferenceOverview()).endpoints
      .find((item) => item.projectId === standalone.projectMetadataId);
    assert.equal(entry?.coverage, 'project-only', 'A missing active version must not be treated as legacy history.');
    assert.equal(entry?.canCaptureRelease, undefined);
    const history = await writer.listWorkflowPublishedVersions(standalone.relativePath);
    const review = await writer.reviewEndpointRelease(standalone.relativePath, reviewed(standalone));
    assert.equal(review.missingRollback, true);
    await assert.rejects(publish(standalone, 'standalone-endpoint', review.token), {
      status: 409,
      message: /cannot be captured for rollback/i,
    });
    assert.deepEqual(await writer.listWorkflowPublishedVersions(standalone.relativePath), history);
  } finally {
    await setStandaloneHistory(standaloneHistory.id);
  }
  const currentA = currentReferences.endpoints.find((item) => item.projectId === a.projectMetadataId);
  assert.equal(currentA?.coverage, 'complete');
  assert.deepEqual(
    new Map(currentA?.dependencies.map(({ projectId, changed }) => [projectId, changed])),
    new Map([
      [helper.projectMetadataId, false],
      [c.projectMetadataId, false],
    ]),
  );
  const oldA = (await writer.listWorkflowPublishedVersions(a.relativePath)).versions[0]!;
  const preview = await writer.readWorkflowHistoryPreview(a.relativePath, oldA.id, a.projectMetadataId);
  assert.deepEqual(preview.projects.map((item) => item.relativePath).sort(), [
    'Experiment/a.rivet-project',
    'Experiment/deep/helper.rivet-project',
    'Library/shared.rivet-project',
  ]);
  assert.deepEqual(
    new Map(preview.projects.map((item) => [item.name, item.bundleRelativePath ?? null])),
    new Map([
      ['a', 'Experiment'],
      ['helper', 'Experiment'],
      ['shared', null],
    ]),
  );
  // Changing the folder type leaves project paths, revisions and call permissions valid.
  const prepared = await prepareEndpointRelease(
    { pool: fresh, queries: createManagedWorkflowQueries(fresh), blobStore: readerStore },
    a.projectMetadataId!,
    a.revisionId!,
    'latest',
  );
  await fresh.query("UPDATE workflow_folders SET bundle_id = NULL WHERE relative_path = 'Experiment'");
  const publishing = await fresh.connect();
  try {
    await publishing.query('BEGIN');
    await assert.rejects(validatePreparedEndpointReleases(publishing, [prepared]), {
      status: 409,
      message: /bundle membership changed/i,
    });
  } finally {
    await publishing.query('ROLLBACK');
    publishing.release();
    await fresh.query("UPDATE workflow_folders SET bundle_id = $1 WHERE relative_path = 'Experiment'", [bundleId]);
  }
  const frozenChild = preview.projects.find((item) => item.projectId === c1.metadata.id)!;
  const download = await writer.readWorkflowPublishedVersionDownload(a.relativePath, oldA.id);
  assert.ok(download.fileName.endsWith('.zip') && Buffer.isBuffer(download.contents));
  assert.equal(await execute('endpoint-a'), 'C1');
  assert.equal(await execute('endpoint-b'), 'C1');

  // Dynamic tool candidates are separate entry points. A large set of
  // candidates must not form an artificial chain or omit their dependencies.
  const toolOwner = project('tool-owner', 'root');
  for (let index = 0; index < 65; index++) {
    const node = LLMChatV2NodeImpl.create();
    node.data.useToolCalling = true;
    node.data.autoContinueToolCalls = true;
    const id = (index === 0 ? main : `tool-${index}`) as GraphId;
    if (id === main) {
      toolOwner.graphs[main]!.nodes.push(node);
    } else {
      toolOwner.graphs[id] = { metadata: { id, name: id }, nodes: [node], connections: [] };
    }
  }
  const toolGraph = 'read_book' as GraphId;
  toolOwner.graphs[toolGraph] = {
    ...project('unused', c1).graphs[main]!,
    metadata: { id: toolGraph, name: toolGraph },
  };
  const toolEndpoint = await publish(await put(toolOwner, 'tool-owner.rivet-project'), 'tool-endpoint');
  const toolHistory = (await writer.listWorkflowPublishedVersions(toolEndpoint.relativePath)).versions[0]!;
  const toolPreview = await writer.readWorkflowHistoryPreview(toolEndpoint.relativePath, toolHistory.id);
  assert.ok(toolPreview.references.some((edge) => edge.sourceGraphId === toolGraph));
  assert.ok(toolPreview.projects.some((artifact) => artifact.artifactId === c.revisionId));

  const outdatedReview = await writer.reviewEndpointRelease(a.relativePath, reviewed(a));
  c = await save(c, project('shared', 'C2'), dataset(c1, 'C2'));
  await assert.rejects(publish(a, 'endpoint-a', outdatedReview!.token), /reviewed endpoint dependencies changed/i);
  assert.equal(await execute('endpoint-a'), 'C1');
  assert.equal(await execute('endpoint-b'), 'C1');
  const status = await writer.readWorkflowReferenceOverview();
  for (const id of [a1.metadata.id, b1.metadata.id]) {
    const dependency = status.endpoints
      .find((item) => item.projectId === id)
      ?.dependencies.find((item) => item.projectId === c1.metadata.id);
    assert.ok(dependency?.changed);
    assert.deepEqual(dependency.revisions, [
      { selector: 'latest', activeRevisionId: frozenChild.artifactId, savedRevisionId: c.revisionId },
    ]);
  }
  const helperStatus = status.endpoints
    .find((item) => item.projectId === a.projectMetadataId)
    ?.dependencies.find((item) => item.projectId === helper.projectMetadataId);
  assert.equal(helperStatus?.changed, false);
  const external = await writer.readWorkflowBundleReferenceDetails(bundleId);
  assert.equal(external.complete, true);
  assert.deepEqual(
    external.projects.map((item) => item.name),
    ['shared'],
  );
  assert.equal(external.projects[0]?.uses[0]?.sourceName, 'helper');

  await fresh.query('UPDATE workflows SET current_draft_revision_id = $1 WHERE workflow_id = $2', [
    'missing-bundle-draft',
    helper.projectMetadataId,
  ]);
  await fresh.query('UPDATE workflows SET published_revision_id = $1 WHERE workflow_id = $2', [
    'missing-live-revision',
    a.projectMetadataId,
  ]);
  const missingRevisions = await writer.readWorkflowReferenceOverview();
  assert.deepEqual(
    {
      bundle: missingRevisions.bundles.find((entry) => entry.bundleId === bundleId),
      details: await writer.readWorkflowBundleReferenceDetails(bundleId),
      endpointCoverage: missingRevisions.endpoints.find((entry) => entry.projectId === a.projectMetadataId)?.coverage,
    },
    {
      bundle: { bundleId, count: 0, complete: false },
      details: { complete: false, projects: [] },
      endpointCoverage: 'project-only',
    },
  );
  await fresh.query('UPDATE workflows SET current_draft_revision_id = $1 WHERE workflow_id = $2', [
    helper.revisionId,
    helper.projectMetadataId,
  ]);
  await fresh.query('UPDATE workflows SET published_revision_id = $1 WHERE workflow_id = $2', [
    a.revisionId,
    a.projectMetadataId,
  ]);

  // A missing call-site index keeps the known target count but loses coverage.
  await fresh.query(
    "UPDATE workflow_revisions SET reference_summary = reference_summary - 'graphCalls' WHERE workflow_id = $1",
    [inner.metadata.id],
  );
  assert.deepEqual(
    (await writer.readWorkflowReferenceOverview()).bundles.find((bundle) => bundle.bundleId === bundleId),
    { bundleId, count: 1, complete: false },
  );
  assert.equal((await writer.readWorkflowBundleReferenceDetails(bundleId)).complete, false);
  await fresh.query('UPDATE workflow_revisions SET reference_summary = NULL WHERE workflow_id = $1', [
    inner.metadata.id,
  ]);
  const previousTree = getWorkflowTreeSyncState();
  const repaired = await backfillProjectReferences({
    pool: fresh,
    blobStore: readerStore,
    signal: AbortSignal.timeout(5000),
    maxRevisions: 1,
  });
  assert.equal(repaired.updated, 1);
  const notificationDeadline = performance.now() + 3000;
  while (getWorkflowTreeSyncState().revision === previousTree.revision && performance.now() < notificationDeadline) {
    await delay(20);
  }
  assert.ok(getWorkflowTreeSyncState().revision > previousTree.revision);
  assert.equal((await writer.readWorkflowBundleReferenceDetails(bundleId)).complete, true);

  if (measure) {
    for (let i = 0; i < 120; i++) {
      const id = `workspace-fixture-${i}`;
      const withReference = i < 40;
      await put(
        project(id, withReference ? c1 : 'fixture'),
        `${withReference ? 'Experiment' : 'Library'}/${id}.rivet-project`,
      );
    }
    const tree = await measureIo(() => writer.getTree());
    const treeOverview = await measureIo(() => writer.readWorkflowReferenceOverview());
    const summarize = ({ result, ...io }: typeof tree | typeof treeOverview) => ({
      ...io,
      bytes: Buffer.byteLength(JSON.stringify(result)),
    });
    console.log(
      'Workspace profile',
      JSON.stringify({ extraProjects: 120, tree: summarize(tree), references: summarize(treeOverview) }),
    );
  }

  // The first protected publish captures what this currently live legacy
  // endpoint serves, including the current selection of shared C2.
  legacy = await publish(legacy, 'legacy-endpoint');
  const legacyVersions = (await writer.listWorkflowPublishedVersions(legacy.relativePath)).versions;
  const checkpoint = await writer.readWorkflowHistoryPreview(legacy.relativePath, legacyVersions[1]!.id);
  assert.equal(checkpoint.coverage, 'frozen');
  assert.equal(checkpoint.projects.find((item) => item.projectId === c1.metadata.id)?.artifactId, c.revisionId);

  // A known bad legacy artifact must not prevent publishing a repaired draft.
  const repairPath = 'repair-legacy.rivet-project';
  const legacyDataProject = project('repair-legacy', 'old revision');
  const oldLegacyData = await put(legacyDataProject, repairPath, '{invalid dataset', 'repair-legacy');
  const beforeRepair = await writer.listWorkflowPublishedVersions(repairPath);
  await assert.rejects(reader.loadPublishedExecutionProject('repair-legacy', true));
  const safeDraft = await save(oldLegacyData, project('repair-legacy', 'repaired revision'), serializeDatasets([]));
  const repairReview = await writer.reviewEndpointRelease(repairPath, reviewed(safeDraft));
  assert.ok(repairReview.missingRollback);
  await assert.rejects(publish(safeDraft, 'repair-legacy', repairReview.token), {
    status: 409,
    message: /cannot be captured for rollback/i,
  });
  assert.deepEqual(await writer.listWorkflowPublishedVersions(repairPath), beforeRepair);
  await writer.publishWorkflowProjectItem(
    repairPath,
    { endpointName: 'repair-legacy', releaseReviewToken: repairReview.token, acknowledgeMissingRollback: true },
    reviewed(safeDraft),
  );
  assert.equal(await execute('repair-legacy'), 'repaired revision');
  const repairedHistory = (await writer.listWorkflowPublishedVersions(repairPath)).versions;
  assert.equal(repairedHistory[0]?.coverage, 'frozen');
  assert.equal(repairedHistory[1]?.id, beforeRepair.versions[0]?.id);
  assert.equal(repairedHistory[1]?.coverage, 'project-only');

  // Model a damaged history pointer using distinct projects in the isolated database.
  const oldVersionId = repairedHistory[1]!.id;
  await fresh.query('UPDATE workflow_published_versions SET revision_id = $1 WHERE version_id = $2', [
    standalone.revisionId,
    oldVersionId,
  ]);
  await assert.rejects(writer.readWorkflowPublishedVersionPreview(repairPath, oldVersionId), { status: 404 });
  await assert.rejects(writer.readWorkflowPublishedVersionDownload(repairPath, oldVersionId), { status: 404 });
  await fresh.query('UPDATE workflow_published_versions SET revision_id = $1 WHERE version_id = $2', [
    oldLegacyData.revisionId,
    oldVersionId,
  ]);

  a = await save(a, { ...a1, metadata: { ...a1.metadata, description: 'A2' } });
  const beforeFailedPublish = await writer.listWorkflowPublishedVersions(a.relativePath);
  const manifestCount = () =>
    fresh.query('SELECT count(*) FROM workflow_endpoint_releases WHERE workflow_id = $1', [a1.metadata.id]);
  const retainedBeforeFailedPublish = (await manifestCount()).rows;
  await fresh.query(
    "ALTER TABLE workflow_published_versions ADD CONSTRAINT fixture_failed_publish CHECK (endpoint_name <> 'fixture-failed-publish')",
  );
  await assert.rejects(publish(a, 'fixture-failed-publish'), { code: '23514' });
  await fresh.query('ALTER TABLE workflow_published_versions DROP CONSTRAINT fixture_failed_publish');
  assert.deepEqual(await writer.listWorkflowPublishedVersions(a.relativePath), beforeFailedPublish);
  assert.deepEqual((await manifestCount()).rows, retainedBeforeFailedPublish);
  assert.equal(await execute('endpoint-a'), 'C1');
  assert.equal(await reader.loadPublishedExecutionProject('fixture-failed-publish', true), null);
  a = await publish(a, 'endpoint-a');
  c = await save(c, project('shared', 'C3'), dataset(c1, 'C3'));
  b = await save(b, { ...b1, metadata: { ...b1.metadata, description: 'B2' } });
  b = await publish(b, 'endpoint-b');
  assert.equal(await execute('endpoint-a'), 'C2');
  assert.equal(await execute('endpoint-b'), 'C3');

  const openRun = await reader.loadPublishedExecutionProject('endpoint-a', true);
  const aDraft = await writer.loadHostedProject(getManagedWorkflowProjectVirtualPath(a.relativePath));
  const cDraft = await writer.loadHostedProject(getManagedWorkflowProjectVirtualPath(c.relativePath));
  const restored = await writer.restoreWorkflowPublishedVersion(a.relativePath, oldA.id, {
    expectedProjectId: a.projectMetadataId!,
    expectedPublicationVersion: a.settings.publicationVersion!,
  });
  assert.equal(restored.version.restoredFrom, oldA.id);
  assert.equal(restored.project.revisionId, a.revisionId);
  assert.equal(restored.project.settings.status, 'unpublished_changes');
  assert.deepEqual(await writer.loadHostedProject(getManagedWorkflowProjectVirtualPath(a.relativePath)), aDraft);
  assert.deepEqual(await writer.loadHostedProject(getManagedWorkflowProjectVirtualPath(c.relativePath)), cDraft);
  assert.equal(await execute('endpoint-a'), 'C1');
  assert.equal(await execute('endpoint-b'), 'C3');
  const target = { callerProjectId: inner.metadata.id, projectId: c1.metadata.id, version: 'latest' } as const;
  const restoredRun = await reader.loadPublishedExecutionProject('endpoint-a', true);
  const restoredTarget = await restoredRun!.frozenReferences!.subgraphProjectLoader.loadTarget(target);
  assert.deepEqual((await restoredTarget.datasetProvider!.getDatasetData(datasetId)).rows[0]!.data, ['C1']);
  await restoredTarget.datasetProvider!.putDatasetRow(datasetId, { id: 'row', data: ['run-only'] });
  const anotherRun = await reader.loadPublishedExecutionProject('endpoint-a', true);
  const anotherTarget = await anotherRun!.frozenReferences!.subgraphProjectLoader.loadTarget(target);
  assert.deepEqual((await anotherTarget.datasetProvider!.getDatasetData(datasetId)).rows[0]!.data, ['C1']);

  await assert.rejects(
    writer.restoreWorkflowPublishedVersion(a.relativePath, oldA.id, {
      expectedProjectId: a.projectMetadataId!,
      expectedPublicationVersion: a.settings.publicationVersion!,
    }),
    { status: 409 },
  );
  assert.ok(openRun?.frozenReferences);
  const older = createProcessor(openRun.project, openRun.frozenReferences);
  try {
    assert.equal((await older.run()).result?.value, 'C2');
  } finally {
    older.dispose();
  }
  const pins = await fresh.query<{ project_blob_key: string }>(
    'SELECT project_blob_key FROM workflow_endpoint_release_projects WHERE revision_id = $1 LIMIT 1',
    [frozenChild.artifactId],
  );
  await writer.deleteWorkflowProjectItem(c.relativePath);
  assert.ok(
    (await findManagedWorkflowObjectReferences(fresh, [pins.rows[0]!.project_blob_key])).has(
      pins.rows[0]!.project_blob_key,
    ),
  );
  assert.ok(
    (
      await writer.readWorkflowPublishedVersionPreview(a.relativePath, oldA.id, frozenChild.artifactId)
    ).contents.includes('C1'),
  );
  await assert.rejects(
    writer.readWorkflowPublishedVersionPreview(a.relativePath, oldA.id, 'foreign-revision'),
    /not captured/,
  );
  assert.equal(await execute('endpoint-a', writer), 'C1');
  assert.equal(await execute('endpoint-b', writer), 'C3');
  // One release can bind Published and Saved latest to different artifacts.
  const targetPublished = project('dual', 'Published revision');
  let dual = await put(targetPublished, 'Dual.rivet-project');
  dual = await publish(dual, 'dual-target');
  dual = await save(dual, project('dual', 'Saved latest revision'));
  const both = project('both', targetPublished);
  const publishedCall = project('tmp', targetPublished, 'published').graphs[main]!;
  const secondOutput = publishedCall.nodes.find((node) => node.type === 'graphOutput')!;
  (secondOutput.data as { id: string }).id = 'publishedResult';
  both.graphs[main]!.nodes.push(...publishedCall.nodes);
  both.graphs[main]!.connections.push(...publishedCall.connections);
  let mixed = await put(both, 'Both.rivet-project');
  mixed = await publish(mixed, 'both-choices');
  const selection = await reader.loadPublishedExecutionProject('both-choices', true);
  assert.ok(selection?.frozenReferences);
  const paired = createProcessor(selection.project, selection.frozenReferences);
  try {
    const results = await paired.run();
    assert.equal(results.result?.value, 'Saved latest revision');
    assert.equal(results.publishedResult?.value, 'Published revision');
  } finally {
    paired.dispose();
  }
  const mixedHistory = (await writer.listWorkflowPublishedVersions(mixed.relativePath)).versions[0]!;
  const multiple = await writer.readWorkflowHistoryPreview(mixed.relativePath, mixedHistory.id);
  assert.equal(multiple.projects.filter((item) => item.projectId === 'dual').length, 2);

  // Runtime, preview and Restore must agree on whether a release is usable.
  const rootPin = await fresh.query<{ release_id: string; project_blob_key: string }>(
    `
    SELECT p.release_id, p.project_blob_key FROM workflow_endpoint_release_projects p
    JOIN workflow_published_versions v ON v.release_id = p.release_id
    WHERE v.version_id = $1 AND p.revision_id = v.revision_id
  `,
    [mixedHistory.id],
  );
  const rootArtifact = rootPin.rows[0]!;
  const changePin = (key: string, artifactId: string) =>
    fresh.query(
      'UPDATE workflow_endpoint_release_projects SET project_blob_key = $1 WHERE release_id = $2 AND revision_id = $3',
      [key, rootArtifact.release_id, artifactId],
    );
  const restoreMixed = () =>
    writer.restoreWorkflowPublishedVersion(mixed.relativePath, mixedHistory.id, {
      expectedProjectId: mixed.projectMetadataId!,
      expectedPublicationVersion: mixed.settings.publicationVersion!,
    });
  let changedDual = dual;
  for (const malformed of ['', '{"datasets":{}}']) {
    changedDual = await save(changedDual, project('dual', 'New draft with invalid data'), malformed);
    await assert.rejects(writer.reviewEndpointRelease(mixed.relativePath, reviewed(mixed)), {
      status: 503,
      message: /dataset is invalid/i,
    });
  }
  assert.equal(await execute('both-choices'), 'Saved latest revision');
  await changePin('missing-root-artifact', multiple.rootArtifactId);
  await assert.rejects(
    writer.loadPublishedExecutionProject('both-choices', true),
    /captured endpoint revision is unavailable/i,
  );
  await assert.rejects(restoreMixed(), /captured endpoint revision is unavailable/i);
  await changePin(rootArtifact.project_blob_key, multiple.rootArtifactId);

  const originalManifest = await fresh.query<{ manifest: { projects: typeof multiple.projects; references: typeof multiple.references } }>(
    'SELECT manifest FROM workflow_endpoint_releases WHERE release_id = $1',
    [rootArtifact.release_id],
  );
  const manifest = originalManifest.rows[0]!.manifest;
  const changeManifest = (value: typeof manifest) =>
    fresh.query('UPDATE workflow_endpoint_releases SET manifest = $1 WHERE release_id = $2', [
      value,
      rootArtifact.release_id,
    ]);
  const mixedCoverage = async () => (await writer.readWorkflowReferenceOverview())
    .endpoints.find((entry) => entry.projectId === mixed.projectMetadataId)?.coverage;
  await changeManifest({
    ...manifest,
    references: manifest.references.map((edge) => ({ ...edge, selector: 'latest' })),
  });
  await assert.rejects(restoreMixed(), /conflicting revisions/i);
  assert.equal(await mixedCoverage(), 'project-only');
  const historyAfterFailures = await writer.listWorkflowPublishedVersions(mixed.relativePath);
  assert.deepEqual(
    historyAfterFailures.versions.map((version) => version.id),
    [mixedHistory.id],
  );
  await changeManifest({ ...manifest, projects: [], references: [] });
  assert.equal(
    await mixedCoverage(),
    'project-only',
    'A version number alone does not prove that the release references are known.',
  );
  await changeManifest(manifest);

  const dependencyArtifactId = dual.revisionId;
  assert.ok(dependencyArtifactId);
  // A dependency preview must never serve a different project's bytes through a captured pin.
  await changePin(rootArtifact.project_blob_key, dependencyArtifactId);
  await assert.rejects(
    writer.readWorkflowPublishedVersionPreview(mixed.relativePath, mixedHistory.id, dependencyArtifactId),
    { status: 503, message: /captured project has a different saved identity/i },
  );

  // A new reader must also refuse a protected release whose dependency artifact is missing.
  await changePin('missing-test-artifact', dependencyArtifactId);
  await assert.rejects(writer.loadPublishedExecutionProject('both-choices', true), { name: 'NoSuchKey' });
  console.log(
    'Frozen endpoint releases: atomic publication, warm storage budget, shared dependency and dataset restore, legacy capture, reference coverage, preview, archive, and retention passed.',
  );
} finally {
  try {
    await Promise.allSettled([writer.dispose(), reader.dispose(), fresh.end()]);
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE; DROP SCHEMA IF EXISTS ${probe} CASCADE`);
  } finally {
    try {
      await admin.end();
    } finally {
      Client.prototype.query = query;
      await fixture?.close();
    }
  }
}
