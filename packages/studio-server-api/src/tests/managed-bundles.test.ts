import assert from 'node:assert/strict';
import test from 'node:test';
import { serializeProject, type Project, type ProjectId } from '@valerypopoff/rivet2-node';
import { createManagedBundleService } from '../routes/workflows/managed/bundles.js';
import type { ManagedWorkflowContext } from '../routes/workflows/managed/context.js';
import type { HttpError } from '../utils/httpError.js';

for (const failure of ['none', 'empty', 'name', 'path', 'missing', 'endpoint', 'web app', 'storage queue'] as const) {
  test(`bundle deletion is atomic and guarded (${failure})`, async () => {
    const root = { name: 'Feature', relative_path: 'Parent/Feature', bundle_id: 'bundle' };
    const members = (failure === 'empty' ? [] : ['one', 'two']).map((workflow_id) => ({
      workflow_id,
      name: workflow_id,
      relative_path: `Parent/Feature/${workflow_id}.rivet-project`,
      published_revision_id: failure === 'endpoint' && workflow_id === 'two' ? 'published' : null,
    }));
    const committed: string[] = [];
    const queued: Array<string | null> = [];
    let locked = false;
    const journal: string[] = [];
    const client = {
      async query(sql: string, params: unknown[] = []) {
        if (sql.includes('pg_advisory_xact_lock')) {
          locked = true;
          return { rows: [] };
        }
        assert.ok(locked);
        if (sql.includes('WHERE bundle_id = $1')) {
          assert.match(sql, /FOR UPDATE/);
          return { rows: failure === 'missing' ? [] : [root] };
        }
        if (sql.startsWith('SELECT relative_path')) {
          assert.match(sql, /FOR UPDATE/);
          return { rows: [root] };
        }
        if (sql.startsWith('SELECT * FROM workflows')) {
          assert.match(sql, /FOR UPDATE/);
          assert.deepEqual(params, ['Parent/Feature']);
          return { rows: members };
        }
        if (sql.includes('FROM workflow_web_apps'))
          return { rows: failure === 'web app' && params[0] === 'two' ? [{}] : [] };
        if (sql.startsWith('DELETE')) {
          journal.push(`${sql.split(' ')[2]}:${params[0]}`);
          return { rows: [] };
        }
        throw new Error(`Unexpected query: ${sql}`);
      },
    };
    const context = {
      withTransaction: async (run: (connection: typeof client, hooks: unknown) => Promise<unknown>) => {
        const result = await run(client, {});
        committed.push(...journal);
        return result;
      },
      db: {
        queryRows: async (_client: unknown, sql: string, params: string[]) =>
          sql.includes('workflow_revisions')
            ? [{ project_blob_key: `${params[0]}-project`, dataset_blob_key: `${params[0]}-data` }]
            : [
                {
                  recording_blob_key: `${params[0]}-recording`,
                  replay_project_blob_key: `${params[0]}-replay`,
                  replay_dataset_blob_key: null,
                },
              ],
      },
      mappers: {
        RECORDING_COLUMNS: '*',
        mapWorkflowRowToProjectItem: (row: { relative_path: string }) => ({
          absolutePath: `/workflows/${row.relative_path}`,
        }),
      },
      maintenance: {
        enqueueObjectDeletions: async (_client: unknown, _domain: string, keys: Array<string | null>) => {
          if (failure === 'storage queue') throw new Error('Queue unavailable');
          queued.push(...keys);
        },
      },
      executionInvalidationController: {
        queueWorkflowInvalidation: async () => {},
        queueCatalogInvalidation: async () => {},
      },
    } as unknown as ManagedWorkflowContext;
    const operation = createManagedBundleService(context).delete('bundle', {
      name: failure === 'name' ? 'feature' : 'Feature',
      relativePath: failure === 'path' ? 'Moved/Feature' : root.relative_path,
    });
    if (failure === 'none' || failure === 'empty') {
      const result = await operation;
      assert.equal(result.deleted, true);
      assert.deepEqual(
        result.deletedProjects.map((p) => p.projectId),
        members.map((member) => member.workflow_id),
      );
      assert.equal(committed.length, members.length * 2 + 1);
      if (members.length) {
        assert.ok(queued.includes('two-recording'));
        assert.ok(queued.includes('one-replay'));
      }
    } else {
      await assert.rejects(
        operation,
        failure === 'missing'
          ? /Bundle not found/
          : failure === 'name' || failure === 'path'
            ? /name or location changed/
            : failure === 'storage queue'
              ? /Queue unavailable/
              : /Unpublish/,
      );
      assert.deepEqual(committed, [], 'no partial transaction is committed');
    }
  });
}

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

for (const sourceName of ['Feature', '🎨'.repeat(127) + 'x']) {
  test(`automatic empty-bundle copy chooses a valid unique sibling name (${sourceName === 'Feature' ? 'plain' : 'Unicode'})`, async () => {
    const source = {
      name: sourceName,
      relative_path: `Parent/${sourceName}`,
      parent_relative_path: 'Parent',
      bundle_id: 'bundle',
    };
    let locked = false;
    let lookups = 0;
    let invalidations = 0;
    const client = {
      async query(sql: string, params: unknown[] = []) {
        if (sql.includes('pg_advisory_xact_lock')) {
          locked = true;
          return { rows: [] };
        }
        if (sql.startsWith('SET TRANSACTION')) return { rows: [] };
        if (sql.startsWith('SELECT * FROM workflow_folders')) return { rows: [{ ...source }] };
        if (sql.startsWith('SELECT * FROM workflows')) return { rows: [] };
        if (sql === 'SELECT 1 FROM workflow_folders WHERE relative_path=$1') {
          assert.ok(locked, 'naming happens under the topology lease');
          assert.ok(String(params[0]).startsWith('Parent/'));
          lookups++;
          return { rowCount: lookups === 1 ? 1 : 0, rows: lookups === 1 ? [{}] : [] };
        }
        if (sql.startsWith('SELECT 1 FROM workflow_folders WHERE bundle_id')) return { rowCount: 0, rows: [] };
        if (sql.startsWith('INSERT INTO workflow_folders')) {
          const [relative_path, name, parent_relative_path, bundle_id] = params;
          return { rows: [{ relative_path, name, parent_relative_path, bundle_id }] };
        }
        throw new Error(`Unexpected query: ${sql}`);
      },
    };
    const service = createManagedBundleService({
      initialize: async () => {},
      withTransaction: async (run: (connection: typeof client) => Promise<unknown>) => run(client),
      queries: {
        assertFolderExists: async (_client: unknown, parent: string) => {
          assert.equal(parent, 'Parent');
        },
      },
      mappers: { mapFolderRowToFolderItem: (row: unknown) => row },
      executionInvalidationController: {
        queueCatalogInvalidation: async () => {
          invalidations++;
        },
      },
    } as unknown as ManagedWorkflowContext);
    const copy = await service.duplicate('bundle', { automatic: true });
    const row = copy.folder as unknown as { name: string; relative_path: string; bundle_id: string };
    assert.equal(row.name.endsWith(' copy 2'), true);
    assert.ok(row.name.length <= 255);
    assert.ok(!/[\uD800-\uDBFF]$/.test(row.name.slice(0, -' copy 2'.length)), 'no split Unicode code point');
    assert.equal(row.relative_path, `Parent/${row.name}`);
    assert.notEqual(row.bundle_id, source.bundle_id);
    assert.equal(lookups, 2);
    assert.equal(invalidations, 1);
  });
}

function conversionFixture(
  options: {
    published?: boolean;
    webApp?: boolean;
    sharedWebAppRevision?: boolean;
    targetBundled?: boolean;
    change?: 'draft' | 'publication' | 'web app' | 'member' | 'target';
    malformed?: boolean;
  } = {},
) {
  const folder = { relative_path: 'Feature', name: 'Feature', bundle_id: null as string | null };
  const rows = [
    {
      workflow_id: 'one',
      relative_path: 'Feature/Nested/One.rivet-project',
      current_draft_revision_id: 'draft',
      published_revision_id: options.published ? 'published' : null,
    },
  ];
  let reads = 0,
    writes = 0,
    invalidations = 0,
    leased = false;
  let bundled = options.targetBundled ?? true;
  const webApps = options.webApp
    ? [{ workflow_id: 'one', revision_id: options.sharedWebAppRevision ? 'draft' : 'web-app' }]
    : [];
  const client = {
    async query(sql: string, params?: unknown[]) {
      if (sql.startsWith('SET TRANSACTION')) return { rows: [] };
      if (sql.includes('pg_advisory_xact_lock')) {
        leased = true;
        return { rows: [] };
      }
      if (sql.startsWith('SELECT * FROM workflow_folders')) return { rows: [{ ...folder }] };
      if (sql.startsWith('SELECT * FROM workflows')) {
        if (leased) assert.match(sql, /FOR SHARE/);
        return { rows: rows.map((row) => ({ ...row })) };
      }
      if (sql.startsWith('SELECT DISTINCT workflow_id, revision_id FROM workflow_web_apps'))
        return { rows: webApps.map((app) => ({ ...app })) };
      if (sql.includes('ANY($1::text[])')) {
        assert.equal(leased, true, 'membership is checked under the topology lease');
        assert.ok(!(params![0] as string[]).includes('one'), 'internal references need no target query');
        return {
          rows: bundled
            ? [{ workflow_id: 'foreign', relative_path: 'Other/Target.rivet-project', bundle_path: 'Other' }]
            : [],
        };
      }
      assert.match(sql, /^UPDATE workflow_folders/);
      writes++;
      folder.bundle_id = params![1] as string | null;
      return { rows: [{ ...folder }] };
    },
  };
  const service = createManagedBundleService({
    initialize: async () => {},
    withTransaction: async <T>(run: (connection: typeof client) => Promise<T>) => {
      leased = false;
      return run(client);
    },
    queries: { getRevision: async (_pool: unknown, id: string) => ({ revision_id: id, workflow_id: 'one' }) },
    revisions: {
      readRevisionProjectContents: async ({ revision_id }: { revision_id: string }) => {
        assert.equal(leased, false, 'blob reads must not hold topology locks');
        reads++;
        if (options.change === 'draft') rows[0]!.current_draft_revision_id = 'edited';
        if (options.change === 'publication') rows[0]!.published_revision_id = 'new-publication';
        if (options.change === 'web app') webApps.push({ workflow_id: 'one', revision_id: 'new-web-app' });
        if (options.change === 'member') rows.push({ ...rows[0]!, workflow_id: 'two' });
        if (options.change === 'target') bundled = true;
        if (options.malformed) return 'not a project';
        const target =
          (options.published || options.webApp) && !['published', 'web-app'].includes(revision_id) ? 'one' : 'foreign';
        return serializeProject({
          metadata: { id: 'one' as ProjectId, title: 'One', description: '' },
          graphs: {
            main: {
              metadata: { id: 'main', name: 'Main' },
              nodes: [
                {
                  id: 'call',
                  title: 'Subgraph',
                  type: 'subGraph',
                  visualData: { x: 0, y: 0, width: 150 },
                  data: { targetProjectId: target },
                },
              ],
              connections: [],
            },
          },
        } as unknown as Project) as string;
      },
    },
    executionInvalidationController: {
      queueCatalogInvalidation: async () => {
        invalidations++;
      },
    },
    mappers: { mapFolderRowToFolderItem: (row: unknown) => row },
  } as unknown as ManagedWorkflowContext);
  return { service, folder, stats: () => ({ reads, writes, invalidations }) };
}

for (const version of ['saved draft', 'published', 'published web app'] as const) {
  test(`conversion rejects another bundle in ${version} without writes`, async () => {
    const fixture = conversionFixture({ published: version === 'published', webApp: version === 'published web app' });
    await assert.rejects(fixture.service.setKind('Feature', true), (error: HttpError) => {
      assert.equal(error.status, 409);
      assert.equal(error.code, 'bundle_cross_bundle_reference');
      assert.match(error.message, /Feature\/Nested\/One.*Other\/Target.*another bundle/);
      assert.ok(error.message.includes(`(${version})`));
      return true;
    });
    assert.deepEqual(fixture.stats(), { reads: version === 'saved draft' ? 1 : 2, writes: 0, invalidations: 0 });
    assert.equal(fixture.folder.bundle_id, null);
  });
}
test('conversion permits ordinary external references and internal references; disabling grouping does no blob reads', async () => {
  const fixture = conversionFixture({ published: true, targetBundled: false });
  await fixture.service.setKind('Feature', true);
  assert.ok(fixture.folder.bundle_id);
  await fixture.service.setKind('Feature', true); // Idempotent, no new reads.
  await fixture.service.setKind('Feature', false);
  assert.equal(fixture.folder.bundle_id, null);
  assert.deepEqual(fixture.stats(), { reads: 2, writes: 3, invalidations: 3 });
});
test('a web app sharing the draft revision does not cause a duplicate blob read', async () => {
  const fixture = conversionFixture({ webApp: true, sharedWebAppRevision: true });
  await fixture.service.setKind('Feature', true);
  assert.deepEqual(fixture.stats(), { reads: 1, writes: 1, invalidations: 1 });
});
for (const change of ['draft', 'publication', 'web app', 'member', 'target'] as const) {
  test(`conversion fences concurrent ${change} changes`, async () => {
    const fixture = conversionFixture({ targetBundled: false, change });
    await assert.rejects(
      fixture.service.setKind('Feature', true),
      change === 'target' ? /another bundle/ : /changed while checking/,
    );
    assert.equal(fixture.stats().writes, 0);
    assert.equal(fixture.stats().invalidations, 0);
  });
}
test('conversion fails closed on unreadable saved project data', async () => {
  const fixture = conversionFixture({ malformed: true });
  await assert.rejects(fixture.service.setKind('Feature', true), (error: HttpError) => {
    assert.equal(error.status, 409);
    assert.match(error.message, /Cannot check saved project Feature\/Nested\/One/);
    assert.ok(!error.message.includes('not a project'));
    return true;
  });
  assert.equal(fixture.stats().writes, 0);
});

for (const automatic of [false, true]) {
  for (const failure of ['source edited during upload', 'later upload failed'] as const) {
    test(`${automatic ? 'automatic' : 'explicit'} bundle preparation exposes nothing and cleans only prepared copies when ${failure}`, async () => {
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
      const preview = automatic ? null : await service.preview('bundle', 'latest');
      await assert.rejects(
        service.duplicate(
          'bundle',
          automatic
            ? { automatic: true }
            : {
                version: 'latest',
                fingerprint: preview!.fingerprint,
                name: 'Copy',
                parentRelativePath: '',
              },
        ),
        failure === 'later upload failed' ? /Fixture upload failure/ : /changed during duplication/,
      );
      assert.equal(writes, 0, 'no copied metadata is exposed before final source validation');
      assert.deepEqual(discarded, prepared);
      assert.equal(prepared.length, failure === 'later upload failed' ? 1 : 2);
    });
  }
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
