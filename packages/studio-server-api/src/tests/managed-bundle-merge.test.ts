import assert from 'node:assert/strict';
import test from 'node:test';
import { serializeProject, type ProjectId } from '@valerypopoff/rivet2-node';
import { projectBundleFixture } from './helpers/project-bundle-fixture.js';
import { createManagedBundleMergeService } from '../routes/workflows/managed/bundle-merge.js';
import type { ManagedWorkflowContext } from '../routes/workflows/managed/context.js';
import type { RevisionRow } from '../routes/workflows/managed/types.js';

for (const mode of [
  'complete',
  'cancelled',
  'logical-key collision',
  'cached-owner mismatch',
  'oversized definition',
  'oversized datasets',
  'preparation failure',
  'unavailable active target',
  'unavailable inactive target',
  'unavailable datasets',
  'inactive cached-owner mismatch',
  'database active target',
  'database inactive target',
  'inactive missing graph',
  'inactive unpublished target',
  'kept counterpart',
] as const) {
  const abortDuringRead = mode === 'cancelled';
  test(`preview deduplicates external metadata/artifact reads and never writes (${mode})`, async () => {
    const fixture = projectBundleFixture();
    const source = fixture.root.project,
      external = fixture.child.project;
    const first = source.graphs[source.metadata.mainGraphId!]!.nodes.find((node) => node.type === 'subGraph')!;
    const keptCounterpart = mode === 'kept counterpart';
    if (keptCounterpart) delete (first.data as { targetBoundary?: unknown }).targetBoundary;
    const targetUnavailable = mode === 'unavailable active target' || mode === 'unavailable inactive target';
    const databaseUnavailable = mode === 'database active target' || mode === 'database inactive target';
    const inactiveCall = [
      'unavailable inactive target',
      'inactive cached-owner mismatch',
      'database inactive target',
      'inactive missing graph',
      'inactive unpublished target',
    ].includes(mode);
    const databaseFailure = Object.assign(new Error('private database diagnostics'), { code: 'ECONNRESET' });
    if (inactiveCall) first.disabled = true;
    if (mode === 'inactive missing graph') external.graphs = {};
    if (mode === 'inactive unpublished target') (first.data as { targetVersion: string }).targetVersion = 'published';
    if (mode === 'logical-key collision') {
      external.metadata.id = `merge-add:${source.metadata.id}` as ProjectId;
      (first.data as { targetProjectId: string }).targetProjectId = external.metadata.id;
    }
    source.graphs[source.metadata.mainGraphId!]!.nodes.push({
      ...structuredClone(first),
      id: 'second-call' as typeof first.id,
    });
    if (mode === 'cached-owner mismatch')
      source.graphs[source.metadata.mainGraphId!]!.nodes = source.graphs[source.metadata.mainGraphId!]!.nodes.filter(
        (node) => node.type !== 'subGraph',
      );
    source.references = targetUnavailable || databaseUnavailable || inactiveCall ? [] : [{ id: external.metadata.id }];
    const root = { bundle_id: 'source', namespace_id: 'source-folder', name: 'Source', relative_path: 'Source' };
    const destination = {
      bundle_id: 'destination',
      namespace_id: 'destination-folder',
      name: 'Destination',
      relative_path: 'Destination',
    };
    const sourceRow = {
      workflow_id: source.metadata.id,
      current_draft_revision_id: 'source-revision',
      name: 'Root',
      relative_path: 'Source/Root.rivet-project',
      folder_relative_path: 'Source',
    };
    const externalRow = {
      workflow_id: external.metadata.id,
      current_draft_revision_id:
        mode === 'cached-owner mismatch' || mode === 'inactive cached-owner mismatch'
          ? 'source-revision'
          : 'external-revision',
      published_revision_id: null,
      name: 'External',
      relative_path: 'External.rivet-project',
      folder_relative_path: '',
    };
    const counterpart = structuredClone(external);
    counterpart.metadata.id = 'kept-target' as ProjectId;
    const counterpartRow = {
      ...externalRow,
      workflow_id: counterpart.metadata.id,
      current_draft_revision_id: 'kept-revision',
      name: 'Kept target',
      relative_path: 'Destination/Kept target.rivet-project',
      folder_relative_path: 'Destination',
    };
    let metadataReads = 0,
      leases = 0,
      releases = 0,
      prepared = 0;
    const discarded: string[] = [];
    const reads = new Map<string, number>();
    const stop = new AbortController();
    const client = {
      async query(sql: string, parameters: unknown[] = []) {
        if (sql.startsWith('BEGIN') || sql === 'COMMIT' || sql === 'ROLLBACK' || sql.startsWith('SELECT set_config'))
          return { rows: [] };
        if (sql.startsWith('SELECT request_hash,result FROM workflow_namespace_receipts')) return { rows: [] };
        if (sql.includes('SELECT row_to_json(f) AS root'))
          return {
            rows: [
              {
                root,
                members: [
                  sourceRow,
                  ...(mode === 'preparation failure' || keptCounterpart
                    ? [{ ...externalRow, relative_path: 'Source/Child.rivet-project', folder_relative_path: 'Source' }]
                    : []),
                ],
                folders: [root],
              },
              { root: destination, members: keptCounterpart ? [counterpartRow] : [], folders: [destination] },
            ],
          };
        if (sql.includes('AS merge_bundle_id')) {
          metadataReads++;
          assert.equal(parameters[0], external.metadata.id);
          return { rows: [{ ...externalRow, merge_bundle_id: null }] };
        }
        if (
          databaseUnavailable &&
          sql.startsWith('SELECT * FROM workflow_revisions WHERE') &&
          parameters[0] === 'external-revision'
        )
          throw databaseFailure;
        if (sql.startsWith('SELECT * FROM workflow_revisions WHERE'))
          return {
            rows: [
              {
                revision_id: parameters[0],
                workflow_id:
                  parameters[0] === 'kept-revision'
                    ? counterpart.metadata.id
                    : parameters[0] === 'source-revision'
                      ? source.metadata.id
                      : external.metadata.id,
                project_blob_key: parameters[0],
                dataset_blob_key:
                  mode === 'oversized datasets' || mode === 'unavailable datasets' ? 'source-datasets' : null,
              },
            ],
          };
        throw new Error('Unexpected preview SQL or write: ' + sql);
      },
      release: () => {
        releases++;
      },
    };
    const pool = {
      query: client.query,
      connect: async () => {
        leases++;
        return client;
      },
    };
    const context = {
      initialize: async () => {},
      pool,
      blobStore: {
        getText: async (key: string) => {
          reads.set(key, (reads.get(key) ?? 0) + 1);
          if (keptCounterpart && key === 'external-revision')
            throw new Error('Unused source contents must not be read');
          if (abortDuringRead && key === 'source-revision') stop.abort();
          if (mode === 'oversized definition' && key === 'source-revision') return 'x'.repeat(128 * 1024 * 1024 + 1);
          if (mode === 'oversized datasets' && key === 'source-datasets') return 'x'.repeat(64 * 1024 * 1024 + 1);
          if (
            (targetUnavailable && key === 'external-revision') ||
            (mode === 'unavailable datasets' && key === 'source-datasets')
          )
            throw new Error('private object path and storage diagnostics must not be exposed');
          return serializeProject(
            key === 'source-revision' ? source : key === 'kept-revision' ? counterpart : external,
          ) as string;
        },
      },
      revisions: {
        createRevision: async (id: string) => {
          if (mode !== 'preparation failure') throw new Error('Preview must never prepare a write');
          prepared++;
          if (prepared === 2) throw new Error('test second artifact upload failure');
          return {
            revision_id: 'prepared-first',
            workflow_id: id,
            project_blob_key: 'prepared-object',
            dataset_blob_key: null,
          } as RevisionRow;
        },
        discardPreparedRevision: async (revision: RevisionRow) => {
          discarded.push(revision.revision_id);
        },
      },
    };
    const service = createManagedBundleMergeService(context as unknown as ManagedWorkflowContext);
    const preview = service.preview(
      'source',
      {
        destinationBundleId: 'destination',
        actions: [
          { sourceProjectId: source.metadata.id as ProjectId, kind: 'add', relativePath: 'Root.rivet-project' },
          ...(mode === 'preparation failure'
            ? [{ sourceProjectId: external.metadata.id, kind: 'add' as const, relativePath: 'Child.rivet-project' }]
            : []),
        ],
        dependencies: keptCounterpart
          ? [{ sourceProjectId: external.metadata.id, kind: 'existing', targetProjectId: counterpart.metadata.id }]
          : [],
        graphs: [],
      },
      stop.signal,
    );
    if (databaseUnavailable) {
      await assert.rejects(preview, (error) => error === databaseFailure);
      assert.equal(reads.has('external-revision'), false);
    } else if (mode === 'inactive cached-owner mismatch') {
      const review = await preview;
      assert.equal(review.fingerprint, undefined);
      assert.equal(review.warnings.length, 0);
      assert.ok(review.blockers.some((issue) => issue.message.includes('revision no longer matches its owner')));
      assert.deepEqual(Object.fromEntries(reads), { 'source-revision': 1 });
    } else if (mode === 'inactive missing graph' || mode === 'inactive unpublished target') {
      const review = await preview;
      assert.ok(review.fingerprint, 'Known inactive graph/version issues remain reviewable warnings');
      assert.equal(review.blockers.length, 0);
      assert.ok(review.warnings.length > 0);
      assert.ok(review.warnings.every((issue) => issue.site?.active === false));
    } else if (targetUnavailable || mode === 'unavailable datasets') {
      await assert.rejects(preview, {
        status: 503,
        expose: true,
        message: `Could not read saved project ${targetUnavailable ? 'External' : 'Root'} from storage. Check storage and refresh the review.`,
      });
    } else if (abortDuringRead) {
      await assert.rejects(preview, { status: 504 });
      assert.equal(metadataReads, 0);
      assert.equal(reads.has('external-revision'), false);
    } else if (mode === 'cached-owner mismatch') {
      const review = await preview;
      assert.equal(review.fingerprint, undefined);
      assert.ok(review.blockers.some((issue) => issue.message.includes('revision no longer matches its owner')));
      assert.deepEqual(Object.fromEntries(reads), { 'source-revision': 1 });
    } else if (mode === 'oversized definition' || mode === 'oversized datasets') {
      await assert.rejects(preview, {
        status: 400,
        message:
          mode === 'oversized definition'
            ? 'Merge analysis exceeds 128 MiB. Select fewer changes.'
            : 'Merge writes exceed 64 MiB. Select fewer changes.',
      });
    } else if (mode === 'preparation failure') {
      const review = await preview;
      assert.equal(prepared, 0, 'Preview cannot upload artifacts');
      await assert.rejects(
        service.commit(
          'source',
          {
            choices: { destinationBundleId: 'destination', actions: review.actions, dependencies: [], graphs: [] },
            fingerprint: review.fingerprint!,
            acknowledgedWarnings: [],
          },
          {
            operationId: 'prepare-failure',
            expiresAt: new Date(Date.now() + 600_000).toISOString(),
            expectedSource: { id: 'source-folder' },
            expectedDestinationId: 'destination-folder',
          },
        ),
        /test second artifact upload failure/,
      );
      assert.equal(prepared, 2);
      assert.deepEqual(discarded, ['prepared-first']);
    } else if (keptCounterpart) {
      const review = await preview;
      assert.ok(review.fingerprint);
      assert.deepEqual(review.blockers, []);
      assert.deepEqual(Object.fromEntries(reads), { 'source-revision': 1, 'kept-revision': 1 });
      assert.equal(metadataReads, 0);
    } else {
      assert.ok((await preview).fingerprint);
      assert.equal(metadataReads, 1);
      assert.equal(leases, 4);
      assert.deepEqual(Object.fromEntries(reads), { 'source-revision': 1, 'external-revision': 1 });
    }
    assert.equal(releases, leases, 'Every preview query returns its bounded lease');
  });
}
