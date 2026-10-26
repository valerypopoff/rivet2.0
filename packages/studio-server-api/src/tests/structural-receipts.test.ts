import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import type { Pool, PoolClient } from 'pg';
import {
  captureOperation,
  recoverCapturedReceipt,
  withMutationReceipt,
} from '../routes/workflows/managed/namespace-receipts.js';
import { withCatalogTransaction } from '../routes/workflows/managed/structural-admission.js';
import { createManagedWorkflowTransactionRunner } from '../routes/workflows/managed/transactions.js';
import { createPreparedRevisions } from '../routes/workflows/managed/prepared-revisions.js';
import type { RevisionRow } from '../routes/workflows/managed/types.js';
import { mutationRequestText } from '../../../studio-server-shared/workflow-mutation-contract.js';
import { createManagedProject } from '../routes/workflows/managed/project-creation.js';
import { createBlankProjectFile } from '../routes/workflows/fs-helpers.js';
import type { ManagedWorkflowContext } from '../routes/workflows/managed/context.js';
import {
  serializeProject,
  serializeDatasets,
  type Project,
  type ProjectId,
  type DatasetId,
} from '@valerypopoff/rivet2-node';
import { createManagedWorkflowRevisionService } from '../routes/workflows/managed/revisions.js';
import { datasetOwnershipHash, repairManagedDatasetOwnership } from '../routes/workflows/managed/dataset-ownership.js';
import { createManagedBundleService } from '../routes/workflows/managed/bundles.js';
import { importManagedProjectBundle } from '../routes/workflows/managed/bundle-import.js';
import { mutateManagedNamespace } from '../routes/workflows/managed/namespace-mutations.js';

test('Save As and reviewed repair recheck admission after slow source preparation', async (t) => {
  const start = Date.now();
  let now = start;
  t.mock.method(Date, 'now', () => now);
  const contents = (id: string) =>
    serializeProject({ metadata: { id, title: id, description: '' }, graphs: {} } as Project) as string;
  const datasetsContents = serializeDatasets([
    {
      meta: { id: 'data' as DatasetId, projectId: 'source' as ProjectId, name: 'Data', description: '' },
      data: { id: 'data' as DatasetId, rows: [] },
    },
  ]);
  for (const mode of ['save-as', 'repair']) {
    now = start;
    let uploads = 0;
    const context = {
      initialize: async () => {},
      pool: { query: async () => ({ rows: [] }) },
      endpointSync: { syncWorkflowEndpointRows: async () => {} },
      mappers: {},
      executionInvalidationController: {
        queueWorkflowInvalidation: async () => {},
        queueCatalogInvalidation: async () => {},
      },
      queries: {
        getWorkflowByRelativePath: async () => {
          now = start + 2000;
          return null;
        },
        getWorkflowById: async () =>
          mode === 'save-as' ? null : { workflow_id: 'target', current_draft_revision_id: 'target-revision' },
        getRevision: async (_client: unknown, id: string) => ({
          revision_id: id,
          workflow_id: id === 'target-revision' ? 'target' : 'source',
          dataset_blob_key: 'inherited',
        }),
      },
      revisions: {
        readRevisionContents: async (revision: { workflow_id: string }) => {
          now = start + 2000;
          return { contents: contents(revision.workflow_id), datasetsContents };
        },
        createRevision: async () => {
          uploads++;
          throw new Error('Expired preparation started an upload');
        },
      },
    } as unknown as ManagedWorkflowContext;
    const mutation = { operationId: 'expired-preparation', expiresAt: new Date(start + 1000).toISOString() };
    await assert.rejects(
      mode === 'save-as'
        ? createManagedWorkflowRevisionService({ context }).saveHostedProject({
            projectPath: '/managed/workflows/New.rivet-project',
            contents: contents('source'),
            datasetsContents: null,
            saveIntent: 'save-as',
            structuralMutation: { ...mutation, expectedDestinationPath: '', expectedDestinationId: null },
          })
        : repairManagedDatasetOwnership(context, {
            projectId: 'target',
            expectedRevisionId: 'target-revision',
            expectedProjectHash: datasetOwnershipHash(contents('target')),
            expectedDatasetKey: 'inherited',
            expectedDatasetHash: datasetOwnershipHash(datasetsContents),
            sourceProjectId: 'source',
            sourceRevisionId: 'source-revision',
            sourceDatasetKey: 'inherited',
            approvalReason: 'Reviewed fixture provenance',
            mutation: { ...mutation, expectedSource: { id: 'target', revisionId: 'target-revision' } },
          }),
      { status: 410 },
      mode,
    );
    assert.equal(uploads, 0, `${mode}: no upload begins after admission expiry`);
  }
});

test('generated names stop on admission expiry before another lookup or artifact upload', async (t) => {
  const start = Date.now();
  let now = start;
  t.mock.method(Date, 'now', () => now);
  for (const occupied of [true, false]) {
    now = start;
    let lookups = 0,
      uploads = 0;
    const context = {
      initialize: async () => {},
      pool: { query: async () => ({ rows: [] }) },
      queries: {
        getWorkflowByRelativePath: async () => {
          lookups++;
          now = start + 2000; // The name lookup consumed the original admission window.
          return occupied && lookups === 1 ? { workflow_id: 'existing' } : null;
        },
      },
      revisions: {
        createRevision: async () => {
          uploads++;
          throw new Error('Expired work uploaded an artifact');
        },
      },
    } as unknown as ManagedWorkflowContext;
    await assert.rejects(
      createManagedProject(
        context,
        {
          operation: 'upload-project',
          input: { parentRelativePath: '', fileName: 'New project', contents: createBlankProjectFile('New project') },
        },
        {
          operationId: 'expiry-during-name-allocation',
          expiresAt: new Date(start + 1000).toISOString(),
          expectedDestinationId: null,
        },
      ),
      { status: 410 },
    );
    assert.equal(lookups, 1, 'Expired admission must stop searching for another generated name');
    assert.equal(uploads, 0, 'Expired name preparation must not upload immutable objects');
  }
});

test('receipts bind the admitted request before working copies change and reject expired new work', async () => {
  const mutation = { operationId: 'original-operation', expiresAt: new Date(Date.now() + 60000).toISOString() };
  const payload = { operation: 'save-as', input: { path: 'Original', contents: 'unchanged bytes\n'.repeat(100_000) } };
  const expected = createHash('sha256').update(mutationRequestText(mutation, payload)).digest('hex');
  let captures = 0;
  const admitted = captureOperation(
    { mutation, payload },
    (input) => input.mutation,
    (input) => {
      captures++;
      return input.payload;
    },
  );
  let inserted: unknown[] | undefined;
  const client = {
    query: async (sql: string, values?: unknown[]) => {
      if (sql.startsWith('SELECT request_hash') && values?.[0] === inserted?.[0])
        return { rows: [{ request_hash: inserted![1], result: JSON.parse(inserted![3] as string) }] };
      if (sql.startsWith('INSERT INTO workflow_namespace_receipts')) inserted = values;
      return { rows: [] };
    },
  } as unknown as PoolClient;
  const tx = { client, hooks: { onCommit() {}, onRollback() {} }, topologyOwned: true as const };
  await withMutationReceipt(tx, admitted.admission, async () => {
    mutation.operationId = 'mutated-working-operation';
    payload.input.path = 'Rebased path';
    return { project: 'created' };
  });
  assert.equal(inserted?.[0], 'original-operation');
  assert.equal(inserted?.[1], expected);
  assert.deepEqual(JSON.parse(inserted?.[3] as string), { project: 'created' });
  assert.deepEqual(
    await withMutationReceipt(tx, admitted.admission, async () => assert.fail('Cannot replay a committed write')),
    { project: 'created' },
  );
  assert.equal(captures, 1);
  assert.equal(admitted.input.payload.input.path, 'Original');
  assert.throws(() => {
    admitted.input.payload.input.path = 'Not mutable';
  }, TypeError);
  assert.throws(() => recoverCapturedReceipt(client, { ...admitted.admission! }), /server-captured/);
  await assert.rejects(
    withMutationReceipt(
      tx,
      captureOperation(
        {
          operationId: 'expired',
          expiresAt: new Date(Date.now() - 1000).toISOString(),
        },
        (input) => input,
        () => ({}),
      ).admission,
      async () => assert.fail('Expired admission cannot execute work'),
    ),
    { status: 410 },
  );
});

test('operation owners recover fixed compatibility receipt hashes before admitting expired work', async () => {
  // Fixed vectors, not hashes generated by the production encoder. The legacy
  // duplicate envelope deliberately includes its nested receipt; content bytes
  // include CRLF and Unicode to guard against normalization.
  const receipt = { operationId: 'op', expiresAt: '2020-01-01T00:00:00.000Z' };
  const namespace = {
    ...receipt,
    command: { kind: 'rename' as const, itemType: 'project' as const, relativePath: 'F/P.rivet-project', name: 'New' },
    expectedSource: { id: 'p', revisionId: null },
  };
  const repair = {
    projectId: 'p',
    expectedRevisionId: 'rev',
    expectedProjectHash: 'ph',
    expectedDatasetKey: 'dk',
    expectedDatasetHash: 'dh',
    sourceProjectId: 's',
    sourceRevisionId: 'sr',
    sourceDatasetKey: 'sk',
    approvalReason: 'reviewed',
    mutation: receipt,
  };
  const save = {
    projectPath: '/managed/workflows/A.rivet-project',
    contents: 'raw\r\n',
    datasetsContents: null,
    structuralMutation: receipt,
  };
  const imported = { folderName: 'unused', rootProjectId: 'p', projects: [] };
  const command = {
    operation: 'import-bundle',
    input: { parentRelativePath: 'F', files: [{ path: 'project.rivet-project', contents: 'raw\r\n' }] },
  };
  const cases: Array<{ name: string; hash: string; invoke: (context: ManagedWorkflowContext) => Promise<unknown> }> = [
    {
      name: 'namespace',
      hash: '00060cc65ed8298a41aa7affeed89fa30638905b1ccbb8a779ffe20645ba15f1',
      invoke: (context) => mutateManagedNamespace(context, namespace),
    },
    {
      name: 'create',
      hash: '81ba1e722b57cb16d7fd590140552b34dcc6b2c17b96aa246b0db5b96c8fb2a5',
      invoke: (context) =>
        createManagedProject(
          context,
          { operation: 'create-project', input: { name: 'A', parentRelativePath: 'F' } },
          receipt,
        ),
    },
    {
      name: 'copy',
      hash: '698c2830a6216636ebda885482895de85ce19f48f7634266cd96394a7b39eef4',
      invoke: (context) =>
        createManagedProject(
          context,
          { operation: 'copy-project', input: { relativePath: 'F/A.rivet-project', version: 'published' } },
          receipt,
        ),
    },
    {
      name: 'upload',
      hash: 'ac94feb48f059574c8f0deea9536a34592ba02a624b1c80ca9932a29d615c975',
      invoke: (context) =>
        createManagedProject(
          context,
          {
            operation: 'upload-project',
            input: { parentRelativePath: 'F', fileName: 'A.rivet-project', contents: 'text\r\n🚀' },
          },
          receipt,
        ),
    },
    {
      name: 'current bundle',
      hash: '852f7820b611eafa76d5e71582590c9f57aa438abc923342c4790b277e7fbe7d',
      invoke: (context) =>
        createManagedBundleService(context).duplicate('bundle', {
          automatic: true,
          relativePath: 'F/B',
          mutation: receipt,
        }),
    },
    {
      name: 'legacy bundle',
      hash: 'ad1729a460410e9f10d4a8156067de90af442bcc050d8d732ad51b8bb9b12e6c',
      invoke: (context) => createManagedBundleService(context).duplicate('bundle', { automatic: true, receipt }),
    },
    {
      name: 'legacy bundle recovery',
      hash: 'ad1729a460410e9f10d4a8156067de90af442bcc050d8d732ad51b8bb9b12e6c',
      invoke: (context) => createManagedBundleService(context).recoverDuplicate('bundle', { automatic: true, receipt }),
    },
    {
      name: 'bundle import',
      hash: '62f8c21a97dd60d9a639e8f2699835589640abe84d1edd6f6839871b6bfb8de3',
      invoke: (context) => importManagedProjectBundle(context, 'F', imported, receipt, command),
    },
    {
      name: 'Save As omitted defaults',
      hash: '0ab9707054bf9212d86249e440ffbc1c8d9a2dfe8a357d333ad8b718fae36cb1',
      invoke: (context) => createManagedWorkflowRevisionService({ context }).saveHostedProject(save),
    },
    {
      name: 'Save As explicit null',
      hash: '0ab9707054bf9212d86249e440ffbc1c8d9a2dfe8a357d333ad8b718fae36cb1',
      invoke: (context) =>
        createManagedWorkflowRevisionService({ context }).saveHostedProject({
          ...save,
          expectedRevisionId: null,
          saveIntent: 'save-as',
        }),
    },
    {
      name: 'Save As empty dataset',
      hash: '83bf0a7dab4afa2c1488c33a61910ff35a7fc7907e0ac6678c8e0f692a8c8cc6',
      invoke: (context) =>
        createManagedWorkflowRevisionService({ context }).saveHostedProject({ ...save, datasetsContents: '' }),
    },
    {
      name: 'reviewed repair',
      hash: '62aeb8b54539775be40b37290721acc89c4a0c038f8ebdadb16ae2320298bfe9',
      invoke: (context) => repairManagedDatasetOwnership(context, repair),
    },
  ];
  for (const scenario of cases) {
    let reads = 0;
    const previous = { project: { name: 'previous' }, folder: {}, bundleId: 'previous' };
    const client = {
      query: async (sql: string) => {
        if (sql.includes('pg_advisory_xact_lock') || sql.startsWith('DELETE FROM workflow_namespace_receipts'))
          return { rows: [] };
        assert.match(sql, /SELECT request_hash,result FROM workflow_namespace_receipts/, scenario.name);
        reads++;
        return {
          rows: [
            {
              request_hash: scenario.hash,
              result: previous,
            },
          ],
        };
      },
    };
    const context = {
      pool: client,
      initialize: async () => {},
      withTransaction: async (run: (client: unknown, hooks: unknown) => Promise<unknown>) =>
        run(client, { onCommit() {}, onRollback() {} }),
      db: {},
      queries: {},
      revisions: {},
      mappers: {},
      endpointSync: {},
      executionInvalidationController: { queueWorkflowInvalidation() {}, queueCatalogInvalidation() {} },
    } as unknown as ManagedWorkflowContext;
    const result = await scenario.invoke(context);
    const expected = ['create', 'copy', 'upload'].includes(scenario.name)
      ? previous.project
      : scenario.name === 'legacy bundle recovery'
        ? { state: 'committed', result: previous }
        : previous;
    assert.deepEqual(result, expected, `${scenario.name}: preserve the exact recovered result`);
    assert.equal(reads, 1, scenario.name);
  }
});

test('prepared revisions follow exact attachment and acknowledged transaction outcomes after releasing SQL', async (t) => {
  t.mock.method(console, 'error', () => {
    throw new Error('Logger unavailable');
  });
  for (const mode of ['commit', 'rollback', 'lost-commit', 'lost-rollback', 'receipt-recovered'] as const) {
    const events: string[] = [];
    const originalFailure = new Error(mode);
    const client = {
      query: async (sql: string) => {
        events.push(sql);
        if (sql === 'COMMIT' && mode === 'lost-commit') throw originalFailure;
        if (sql === 'ROLLBACK' && mode === 'lost-rollback') throw new Error('Rollback acknowledgement lost');
        return { rows: [] };
      },
      release: () => {
        events.push('released');
      },
    } as unknown as PoolClient;
    const runner = createManagedWorkflowTransactionRunner({
      pool: { connect: async () => client } as unknown as Pool,
      initialize: async () => {},
    });
    let discarded = 0;
    let rollbackHooks = 0;
    const revision = { revision_id: 'prepared', workflow_id: 'same-project' } as RevisionRow;
    const scope = createPreparedRevisions({
      createRevision: async () => revision,
      discardPreparedRevision: async () => {
        assert.ok(events.includes('released'), 'Cleanup must not retain the SQL lease');
        discarded++;
      },
    });
    const prepared = await scope.prepare('same-project', 'Project', null);
    const operation = withCatalogTransaction(runner, async (tx) => {
      scope.observe(tx.hooks);
      tx.hooks.onSettled!(() => {
        throw new Error('Observer failed');
      });
      tx.hooks.onCommit(async () => {
        throw new Error('Commit observer failed');
      });
      tx.hooks.onRollback(async () => {
        rollbackHooks++;
        throw new Error('Rollback observer failed');
      });
      if (mode === 'rollback' || mode === 'lost-rollback') throw originalFailure;
      if (mode !== 'receipt-recovered') scope.stage(prepared, tx.hooks);
      return 'confirmed';
    });
    if (mode === 'commit' || mode === 'receipt-recovered') assert.equal(await operation, 'confirmed');
    else await assert.rejects(operation, (error) => error === originalFailure);
    await scope.close();
    await scope.close();
    assert.equal(discarded, mode === 'rollback' || mode === 'receipt-recovered' ? 1 : 0, mode);
    assert.equal(rollbackHooks, mode === 'rollback' ? 1 : 0, `${mode}: only confirmed rollback runs rollback hooks`);
    assert.equal(events.filter((event) => event.includes('pg_advisory_xact_lock')).length, 1, mode);
  }
});

test('preparation scope settles an accepted upload, rejects concurrent or foreign work, and tolerates cleanup/logger failure', async (t) => {
  t.mock.method(console, 'error', () => {
    throw new Error('Logger unavailable');
  });
  let finish!: (row: RevisionRow) => void;
  const revision = { revision_id: 'accepted' } as RevisionRow;
  let discarded = 0;
  const scope = createPreparedRevisions({
    createRevision: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
    discardPreparedRevision: async () => {
      discarded++;
      throw new Error('Cleanup queue unavailable');
    },
  });
  const accepted = scope.prepare('project', 'Project', null);
  await assert.rejects(scope.prepare('project', 'Project', null), /already active/);
  assert.throws(() => scope.stage({ ...revision }, { onCommit() {}, onRollback() {} }), /not owned/);
  const close = scope.close();
  finish(revision);
  assert.equal(await accepted, revision);
  await close;
  assert.equal(discarded, 1);
  await assert.rejects(scope.prepare('project', 'Project', null), /closed/);
});
