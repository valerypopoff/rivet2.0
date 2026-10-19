import assert from 'node:assert/strict';
import test from 'node:test';
import { serializeProject, type ProjectId } from '@valerypopoff/rivet2-node';
import { createManagedBundleService } from '../routes/workflows/managed/bundles.js';
import type { ManagedWorkflowContext } from '../routes/workflows/managed/context.js';

for (const operation of ['create', 'duplicate'] as const) {
  test(`bundle ${operation} rejects project-file folder names before storage access`, async () => {
    const service = createManagedBundleService({
      initialize: async () => {
        throw new Error('Unexpected storage access');
      },
    } as unknown as ManagedWorkflowContext);
    await assert.rejects(
      operation === 'create'
        ? service.create('Broken.rivet-project', 'Parent')
        : service.duplicate('bundle', {
            name: 'Broken.rivet-project',
            parentRelativePath: 'Parent',
            version: 'latest',
            fingerprint: 'old',
          }),
      /Expected folder path/,
    );
  });
}

for (const failure of ['source edited during upload', 'later upload failed'] as const) {
  test(`bundle preparation exposes nothing and cleans only prepared copies when ${failure}`, async () => {
    const folder = { relative_path: 'Feature', name: 'Feature', parent_relative_path: '', bundle_id: 'bundle' };
    const members = ['one', 'two'].map((id) => ({
      workflow_id: id,
      name: id,
      file_name: `${id}.rivet-project`,
      relative_path: `Feature/${id}.rivet-project`,
      current_draft_revision_id: `source-${id}`,
      published_revision_id: null,
    }));
    const contents = new Map(
      members.map((member) => [
        member.workflow_id,
        serializeProject({
          metadata: { id: member.workflow_id as ProjectId, title: member.name, description: '' },
          graphs: {},
        }) as string,
      ]),
    );
    const prepared: string[] = [],
      discarded: string[] = [];
    let writes = 0;
    const client = {
      async query(sql: string, params?: unknown[]) {
        if (sql.startsWith('SELECT * FROM workflow_folders WHERE bundle_id')) {
          assert.deepEqual(params, ['bundle']);
          return { rows: [{ ...folder }] };
        }
        if (sql.startsWith('SELECT * FROM workflow_folders')) {
          assert.match(sql, /WHERE relative_path = \$1 OR left\(relative_path/);
          assert.match(sql, /LIMIT 513/);
          assert.deepEqual(params, ['Feature']);
          return { rows: [{ ...folder }] };
        }
        if (sql.startsWith('SELECT * FROM workflows')) {
          assert.match(sql, /LIMIT 257/);
          assert.deepEqual(params, ['Feature']);
          return { rows: members.map((member) => ({ ...member })) };
        }
        if (sql.startsWith('SET TRANSACTION') || sql.includes('pg_advisory_xact_lock')) return { rows: [] };
        writes++;
        throw new Error(`Unexpected write: ${sql}`);
      },
    };
    const context = {
      initialize: async () => {},
      withTransaction: async <T>(run: (connection: typeof client) => Promise<T>) => run(client),
      queries: {
        getRevision: async (_pool: unknown, id: string) => ({ workflow_id: id.slice('source-'.length) }),
      },
      revisions: {
        readRevisionContents: async (revision: { workflow_id: string }) => ({
          contents: contents.get(revision.workflow_id),
          datasetsContents: null,
        }),
        createRevision: async (workflowId: string) => {
          assert.ok(
            !members.some((member) => member.workflow_id === workflowId),
            'uploads belong only to fresh copies',
          );
          if (prepared.length === 1 && failure === 'later upload failed') throw new Error('Fixture upload failure');
          const revision_id = `prepared-${prepared.length}`;
          prepared.push(revision_id);
          if (prepared.length === 2) members[0]!.current_draft_revision_id = 'source-edited';
          return { revision_id, workflow_id: workflowId, project_blob_key: workflowId, dataset_blob_key: null };
        },
        discardPreparedRevision: async (revision: { revision_id: string }) => {
          discarded.push(revision.revision_id);
        },
      },
    } as unknown as ManagedWorkflowContext;
    const service = createManagedBundleService(context);
    const preview = await service.preview('bundle', 'latest');
    await assert.rejects(
      service.duplicate('bundle', {
        version: 'latest',
        fingerprint: preview.fingerprint,
        name: 'Copy',
        parentRelativePath: '',
      }),
      failure === 'later upload failed' ? /Fixture upload failure/ : /changed during duplication/,
    );
    assert.equal(writes, 0, 'no copied metadata is exposed before final source validation');
    assert.deepEqual(discarded, prepared);
    assert.equal(prepared.length, failure === 'later upload failed' ? 1 : 2);
  });
}

for (const oversized of ['projects', 'folders'] as const) {
  test(`oversized bundle ${oversized} are rejected before reading project artifacts`, async () => {
    const root = { relative_path: 'Feature', bundle_id: 'bundle' };
    let artifactReads = 0;
    const client = {
      async query(sql: string) {
        if (sql.startsWith('SET TRANSACTION')) return { rows: [] };
        if (sql.includes('WHERE bundle_id')) return { rows: [{ ...root }] };
        if (sql.startsWith('SELECT * FROM workflows')) {
          assert.match(sql, /LIMIT 257/);
          return {
            rows: Array.from({ length: oversized === 'projects' ? 257 : 0 }, (_, index) => ({
              workflow_id: `${index}`,
            })),
          };
        }
        assert.match(sql, /FROM workflow_folders WHERE relative_path = \$1/);
        assert.match(sql, /LIMIT 513/);
        return { rows: Array.from({ length: 513 }, () => ({ ...root })) };
      },
    };
    const service = createManagedBundleService({
      initialize: async () => {},
      withTransaction: async <T>(run: (connection: typeof client) => Promise<T>) => run(client),
      queries: {
        getRevision: async () => {
          artifactReads++;
          throw new Error('Unexpected artifact read');
        },
      },
    } as unknown as ManagedWorkflowContext);
    await assert.rejects(
      service.preview('bundle', 'latest'),
      oversized === 'projects' ? /at most 256 projects/ : /at most 512 folders/,
    );
    assert.equal(artifactReads, 0);
  });
}
