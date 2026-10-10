// test-style: fixture-read: reads only generated catalog and artifact fixtures to verify read-only tree data and corruption checks.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { gzipSync } from 'node:zlib';
import { loadProjectAndAttachedDataFromString, serializeProject, serializeDatasets } from '@valerypopoff/rivet2-node';
import { SqliteWorkflowBackend } from '../local-metadata/sqlite-workflow-backend.js';
import { LocalWorkflowCatalog } from '../local-metadata/workflow-catalog.js';
import { ImmutableLocalArtifactStore } from '../local-metadata/immutable-artifact-store.js';
import { verifySqliteWorkflowServing } from '../local-metadata/verify-serving-candidate.js';
import type { WorkflowProjectItem } from '../../../studio-server-shared/workflow-types.js';
import { withEnvOverride } from './helpers/workflow-api-harness.js';
import { collectProjectBundle, type BundleSnapshot } from '../routes/workflows/project-bundle.js';
import { getWorkflowProjectIndexDataFromContents } from '../routes/workflows/project-stats.js';
import { withAsyncDeadline } from './helpers/workflow-async-process.js';
import { verifyWorkflowPublicationContract } from './helpers/workflow-publication-contract.js';

async function fixture(
  run: (
    backend: SqliteWorkflowBackend,
    options: { databasePath: string; artifactRoot: string; virtualRoot: string },
    setPaused: (value: boolean) => void,
  ) => Promise<void>,
  hooks: { beforeDeleteProject?: (projectId: string) => Promise<void>; worker?: boolean } = {},
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-sqlite-backend-'));
  const options = {
    databasePath: path.join(root, 'metadata', 'catalog.sqlite'),
    artifactRoot: path.join(root, 'artifacts'),
    virtualRoot: path.join(root, 'old-workflows'),
  };
  let paused = false;
  const backend = new SqliteWorkflowBackend({
    ...options,
    ...hooks,
    withWrite: async (operation) => {
      if (paused) throw new Error('maintenance');
      return operation();
    },
  });
  const candidate = new LocalWorkflowCatalog(options);
  try {
    candidate.initialize();
    candidate.close();
    await backend.initialize();
    await run(backend, options, (value) => {
      paused = value;
    });
    // The adapter must never materialize legacy projects or metadata sidecars.
    await assert.rejects(fs.stat(options.virtualRoot), { code: 'ENOENT' });
  } finally {
    candidate.close();
    await backend.dispose();
    await fs.rm(root, { recursive: true, force: true });
  }
}
const conditions = (item: WorkflowProjectItem) => ({
  expectedProjectId: item.projectMetadataId!,
  expectedPublicationVersion: item.settings.publicationVersion!,
  expectedDraftRevisionId: item.revisionId!,
});

test('SQLite direct and serving-worker adapters satisfy the shared SQL publication contract', async () => {
  for (const worker of [false, true]) {
    await fixture(verifyWorkflowPublicationContract, { worker });
  }
});

test('serving worker preserves save/publication CAS, detached execution and maintenance ownership', async () => {
  await fixture(
    async (backend, _options, setPaused) => {
      let item = await createExecutable(backend);
      item = await backend.publishWorkflowProjectItem(
        item.relativePath,
        { endpointName: 'worker-contract' },
        conditions(item),
      );
      const first = await backend.loadPublishedExecutionProject('worker-contract');
      assert.ok(first);
      first.project.metadata.title = 'mutated runtime';
      const second = await backend.loadPublishedExecutionProject('worker-contract');
      assert.ok(second);
      assert.notEqual(second.project.metadata.title, 'mutated runtime');
      const target = await backend.loadSubgraphTarget({ projectId: second.project.metadata.id, version: 'published' });
      assert.equal(target.project.metadata.title, second.project.metadata.title);
      const unpublished = await backend.unpublishWorkflowProjectItem(item.relativePath, conditions(item));
      await assert.rejects(
        backend.publishWorkflowProjectItem(item.relativePath, { endpointName: 'worker-contract' }, conditions(item)),
        { status: 409 },
      );
      assert.equal(await backend.loadPublishedExecutionProject('worker-contract'), null);
      assert.equal(unpublished.settings.publicationStatus, 'unpublished');
      setPaused(true);
      await assert.rejects(backend.createWorkflowFolderItem('blocked', ''), /maintenance/);
      assert.equal(backend.getActiveWriteCount(), 0);
      await backend.checkHealth();
    },
    { worker: true },
  );
});

test('worker drain includes catalog reads and canceled readiness probes leave the queue', async () => {
  await fixture(
    async (backend, options) => {
      const blocker = new DatabaseSync(options.databasePath);
      blocker.exec('BEGIN EXCLUSIVE');
      const tree = backend.getTree();
      const controller = new AbortController();
      const health = backend.checkHealth({ signal: controller.signal });
      const canceled = assert.rejects(health, /expired readiness probe/);
      let idle = false;
      const draining = backend.waitForIdle().then(() => {
        idle = true;
      });
      try {
        assert.equal(backend.getActiveWriteCount(), 0);
        assert.ok(backend.getPendingCatalogOperationCount() >= 2);
        controller.abort(new Error('expired readiness probe'));
        await canceled;
        assert.equal(backend.getPendingCatalogOperationCount(), 1);
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(idle, false, 'an outstanding catalog read still prevents drain');
      } finally {
        blocker.exec('ROLLBACK');
        blocker.close();
        await Promise.all([tree, draining]);
      }
      assert.equal(idle, true);
      assert.equal(backend.getPendingCatalogOperationCount(), 0);
    },
    { worker: true },
  );
});

test('SQLite draft saves preserve publication artifacts without reading history', async (t) => {
  await fixture(async (backend) => {
    let item = await createExecutable(backend);
    item = await backend.publishWorkflowProjectItem(item.relativePath, { endpointName: 'story' }, conditions(item));
    const loaded = await backend.loadHostedProject(item.absolutePath);
    const [project, attached] = loadProjectAndAttachedDataFromString(loaded.contents);
    project.metadata.description = 'draft edit';
    let reads = 0;
    let writes = 0;
    const originalRead = ImmutableLocalArtifactStore.prototype.read;
    const originalPut = ImmutableLocalArtifactStore.prototype.putBytes;
    t.mock.method(
      ImmutableLocalArtifactStore.prototype,
      'read',
      function (this: ImmutableLocalArtifactStore, ...args: Parameters<typeof originalRead>) {
        reads++;
        return originalRead.apply(this, args);
      },
    );
    t.mock.method(
      ImmutableLocalArtifactStore.prototype,
      'putBytes',
      function (this: ImmutableLocalArtifactStore, ...args: Parameters<typeof originalPut>) {
        writes++;
        return originalPut.apply(this, args);
      },
    );
    const saved = await backend.saveHostedProject({
      projectPath: item.absolutePath,
      contents: serializeProject(project, attached) as string,
      datasetsContents: null,
      expectedRevisionId: loaded.revisionId,
    });
    assert.equal(reads, 0);
    assert.equal(writes, 1);
    assert.equal(saved.project.settings.status, 'unpublished_changes');
    assert.equal((await backend.listWorkflowPublishedVersions(item.relativePath)).versions.length, 1);
  });
});
function executable(contents: string) {
  const [project, attached] = loadProjectAndAttachedDataFromString(contents);
  const graphId = 'main' as NonNullable<typeof project.metadata.mainGraphId>;
  project.metadata.mainGraphId = graphId;
  project.graphs = { [graphId]: { metadata: { id: graphId, name: 'Main' }, nodes: [], connections: [] } };
  return serializeProject(project, attached) as string;
}

test('SQLite endpoint unpublish preserves web apps without reporting a published endpoint', async () => {
  await fixture(async (backend) => {
    let item = await createExecutable(backend);
    const loaded = await backend.loadHostedProject(item.absolutePath);
    const [project, attached] = loadProjectAndAttachedDataFromString(loaded.contents);
    project.uiGraphs = { ui: { id: 'ui', name: 'Summary app', components: [] } } as typeof project.uiGraphs;
    item = (
      await backend.saveHostedProject({
        projectPath: item.absolutePath,
        contents: serializeProject(project, attached) as string,
        datasetsContents: null,
        expectedRevisionId: loaded.revisionId,
      })
    ).project;
    const assertStatuses = async (endpoint: string, aggregate: string) => {
      const tree = (await backend.getTree()).projects[0]!;
      const settings = (await backend.listWorkflowProjectWebApps(item.relativePath)).project;
      for (const view of [item, tree, settings]) {
        assert.equal(view.settings.status, endpoint);
        assert.equal(view.settings.publicationStatus, aggregate);
      }
    };
    item = await backend.publishWorkflowProjectWebApps(
      item.relativePath,
      [{ uiGraphId: 'ui', slug: 'summary-app', allowedEmails: ['operator@example.com'] }],
      conditions(item),
    );
    await assertStatuses('unpublished', 'published');
    item = await backend.publishWorkflowProjectItem(item.relativePath, { endpointName: 'summary' }, conditions(item));
    await assertStatuses('published', 'published');
    const app = item.settings.publishedWebApps[0];
    item = await backend.unpublishWorkflowProjectItem(item.relativePath, conditions(item));
    await assertStatuses('unpublished', 'published');
    assert.equal(item.settings.publishedEndpointName, '');
    assert.equal(item.settings.endpointName, 'summary');
    assert.equal(item.settings.lastPublishedAt, null);
    assert.deepEqual(item.settings.publishedWebApps, [app]);
    assert.equal(await backend.loadPublishedExecutionProject('summary'), null);
    assert.ok(await backend.loadPublishedWebAppExecutionProject('summary-app'));
    assert.equal((await backend.listWorkflowPublishedVersions(item.relativePath)).versions.length, 1);
    const draft = await backend.loadHostedProject(item.absolutePath);
    const [edited, data] = loadProjectAndAttachedDataFromString(draft.contents);
    edited.metadata.description = 'Unpublished draft change';
    item = (
      await backend.saveHostedProject({
        projectPath: item.absolutePath,
        contents: serializeProject(edited, data) as string,
        datasetsContents: null,
        expectedRevisionId: draft.revisionId,
      })
    ).project;
    await assertStatuses('unpublished', 'unpublished_changes');
    item = await backend.unpublishWorkflowProjectWebApp(item.relativePath, 'ui', conditions(item));
    await assertStatuses('unpublished', 'unpublished');
  });
});

test('SQLite recording picker includes published endpoints without runs using only metadata', async (t) => {
  await fixture(async (backend) => {
    let item = await createExecutable(backend);
    assert.equal((await backend.listWorkflowRecordingWorkflows()).workflows.length, 0);
    item = await backend.publishWorkflowProjectItem(item.relativePath, { endpointName: 'story' }, conditions(item));
    const reads = t.mock.method(ImmutableLocalArtifactStore.prototype, 'read');
    const [summary] = (await backend.listWorkflowRecordingWorkflows()).workflows;
    assert.equal(summary?.workflowId, item.projectMetadataId);
    assert.equal(summary?.totalRuns, 0);
    assert.equal(summary?.latestRunAt, undefined);
    assert.equal(reads.mock.callCount(), 0);
  });
});

test('SQLite deletion rejects live endpoint and web-app publications before running cleanup', async () => {
  const deleted: string[] = [];
  await fixture(
    async (backend) => {
      let item = await createExecutable(backend);
      const loaded = await backend.loadHostedProject(item.absolutePath);
      const [project, attached] = loadProjectAndAttachedDataFromString(loaded.contents);
      project.uiGraphs = { ui: { id: 'ui', name: 'Live app', components: [] } } as typeof project.uiGraphs;
      item = (
        await backend.saveHostedProject({
          projectPath: item.absolutePath,
          contents: serializeProject(project, attached) as string,
          datasetsContents: null,
          expectedRevisionId: loaded.revisionId,
        })
      ).project;
      const assertProtected = async () => {
        await assert.rejects(backend.deleteWorkflowProjectItem(item.relativePath), {
          status: 409,
          message: 'Unpublish the workflow endpoint and web apps before deleting the project',
        });
        assert.deepEqual(deleted, []);
        assert.equal((await backend.getTree()).projects[0]?.projectMetadataId, item.projectMetadataId);
      };
      item = await backend.publishWorkflowProjectWebApps(
        item.relativePath,
        [{ uiGraphId: 'ui', slug: 'live-app', allowedEmails: [] }],
        conditions(item),
      );
      await assertProtected();
      assert.ok(await backend.loadPublishedWebAppExecutionProject('live-app'));
      item = await backend.publishWorkflowProjectItem(item.relativePath, { endpointName: 'live' }, conditions(item));
      await assertProtected();
      item = await backend.unpublishWorkflowProjectWebApp(item.relativePath, 'ui', conditions(item));
      await assertProtected();
      assert.ok(await backend.loadPublishedExecutionProject('live'));
      item = await backend.unpublishWorkflowProjectItem(item.relativePath, conditions(item));
      const versions = (await backend.listWorkflowPublishedVersions(item.relativePath)).versions;
      assert.equal(versions.length, 1);
      assert.equal(versions[0]?.isCurrent, false);
      // Historical publications alone do not block deletion once all routes are gone.
      assert.equal(await backend.deleteWorkflowProjectItem(item.relativePath), item.projectMetadataId);
      assert.deepEqual(deleted, [item.projectMetadataId]);
      assert.equal((await backend.getTree()).projects.length, 0);
      assert.equal(await backend.loadPublishedExecutionProject('live'), null);
      assert.equal(await backend.loadPublishedWebAppExecutionProject('live-app'), null);
    },
    {
      beforeDeleteProject: async (id) => {
        deleted.push(id);
      },
    },
  );
});
async function createExecutable(backend: SqliteWorkflowBackend, name = 'Story') {
  const item = await backend.createWorkflowProjectItem('', name),
    loaded = await backend.loadHostedProject(item.absolutePath);
  return (
    await backend.saveHostedProject({
      projectPath: item.absolutePath,
      contents: executable(loaded.contents),
      datasetsContents: null,
      expectedRevisionId: loaded.revisionId,
    })
  ).project;
}

function removeTreeIndexes(databasePath: string): void {
  const db = new DatabaseSync(databasePath);
  try {
    db.exec("UPDATE projects SET metadata_json = json_remove(metadata_json, '$.treeIndex')");
  } finally {
    db.close();
  }
}

test('SQLite tree uses persisted summaries, not current, historical, dataset or web-app bodies', async (t) => {
  await fixture(async (backend) => {
    let item = await createExecutable(backend);
    const loaded = await backend.loadHostedProject(item.absolutePath);
    const [project, attached] = loadProjectAndAttachedDataFromString(loaded.contents);
    project.uiGraphs = { ui: { id: 'ui', name: 'UI', components: [] } } as typeof project.uiGraphs;
    item = (
      await backend.saveHostedProject({
        projectPath: item.absolutePath,
        contents: serializeProject(project, attached) as string,
        datasetsContents: null,
        expectedRevisionId: item.revisionId,
      })
    ).project;
    item = await backend.publishWorkflowProjectItem(item.relativePath, { endpointName: 'story' }, conditions(item));
    item = await backend.publishWorkflowProjectWebApps(
      item.relativePath,
      [{ uiGraphId: 'ui', slug: 'story-ui', allowedEmails: [] }],
      conditions(item),
    );
    project.metadata.description = 'Changed after web-app publication';
    item = (
      await backend.saveHostedProject({
        projectPath: item.absolutePath,
        contents: serializeProject(project, attached) as string,
        datasetsContents: null,
        expectedRevisionId: item.revisionId,
      })
    ).project;
    item = await backend.publishWorkflowProjectItem(item.relativePath, { endpointName: 'story' }, conditions(item));
    assert.equal((await backend.listWorkflowPublishedVersions(item.relativePath)).versions.length, 2);
    await assert.rejects(backend.listWorkflowPublishedVersions('Story.txt'), { status: 400 });
    assert.equal(item.settings.publishedWebApps![0]!.status, 'unpublished_changes');
    const reads = t.mock.method(ImmutableLocalArtifactStore.prototype, 'read', async () => {
      throw new Error('Unexpected tree artifact read');
    });
    const fullSnapshots = t.mock.method(LocalWorkflowCatalog.prototype, 'readProject', async () => {
      throw new Error('Unexpected full tree snapshot');
    });
    for (let attempt = 0; attempt < 2; attempt++) {
      assert.deepEqual((await backend.getTree()).projects, [item]);
    }
    assert.equal(reads.mock.callCount(), 0);
    assert.equal(fullSnapshots.mock.callCount(), 0);
    fullSnapshots.mock.restore();
    await assert.rejects(backend.loadHostedProject(item.absolutePath), /Unexpected tree artifact read/);
    reads.mock.restore();
  });
});

test('SQLite legacy tree summaries read only current drafts once and leave read-only catalog bytes intact', async (t) => {
  await fixture(async (backend, options) => {
    let item = await createExecutable(backend);
    const draft = await backend.loadHostedProject(item.absolutePath);
    item = (
      await backend.saveHostedProject({
        projectPath: item.absolutePath,
        contents: draft.contents,
        datasetsContents: serializeDatasets([]),
        expectedRevisionId: draft.revisionId,
      })
    ).project;
    item = await backend.publishWorkflowProjectItem(item.relativePath, { endpointName: 'story' }, conditions(item));
    const loaded = await backend.loadHostedProject(item.absolutePath);
    removeTreeIndexes(options.databasePath);
    const before = await fs.readFile(options.databasePath);
    const reader = new SqliteWorkflowBackend({
      ...options,
      withWrite: async () => {
        throw new Error('Read only');
      },
    });
    const read = ImmutableLocalArtifactStore.prototype.read;
    const calls = t.mock.method(ImmutableLocalArtifactStore.prototype, 'read', read);
    try {
      reader.initialize({ readOnly: true });
      const trees = await Promise.all([reader.getTree(), reader.getTree()]);
      for (const tree of trees) assert.deepEqual(tree.projects, [item]);
      assert.equal(
        calls.mock.callCount(),
        2,
        'Concurrent trees share one read per current draft/dataset; published bytes are not loaded.',
      );
      assert.deepEqual((await reader.getTree()).projects, [item]);
      assert.equal(calls.mock.callCount(), 2, 'Repeated reloads reuse the immutable revision summary.');
      const expected = getWorkflowProjectIndexDataFromContents(loaded.contents, loaded.datasetsContents);
      assert.equal(trees[0]!.projects[0]!.revisionId, expected.revisionId);
      assert.deepEqual(trees[0]!.projects[0]!.stats, expected.stats);
      assert.deepEqual(await fs.readFile(options.databasePath), before);
    } finally {
      reader.close();
      calls.mock.restore();
    }
  });
});

test('SQLite returned tree statistics cannot mutate the cached legacy summary', async () => {
  await fixture(async (backend, options) => {
    const item = await createExecutable(backend);
    removeTreeIndexes(options.databasePath);
    const [first, second] = await Promise.all([backend.getTree(), backend.getTree()]);
    first.projects[0]!.stats!.graphCount = 999;
    assert.deepEqual(second.projects[0]!.stats, item.stats);
    assert.deepEqual((await backend.getTree()).projects[0]!.stats, item.stats);
  });
});

test('SQLite legacy trees larger than the summary cache do not thrash on repeated reloads', async (t) => {
  await fixture(async (backend, options) => {
    const seed = await createExecutable(backend);
    const loaded = await backend.loadHostedProject(seed.absolutePath);
    const [project, attached] = loadProjectAndAttachedDataFromString(loaded.contents);
    const bodies = new Map<string, Buffer>();
    const db = new DatabaseSync(options.databasePath);
    try {
      const row = db.prepare('SELECT metadata_json FROM projects').get() as { metadata_json: string };
      const { treeIndex: _index, ...metadata } = JSON.parse(row.metadata_json);
      db.exec('BEGIN; DELETE FROM projects');
      const insert = db.prepare('INSERT INTO projects VALUES (?, ?, ?, ?, ?)');
      // One over the bounded cache is enough to expose scan-order eviction.
      for (let index = 0; index < 1025; index++) {
        const name = `Project ${String(index).padStart(4, '0')}`;
        project.metadata.id = `${seed.projectMetadataId}-${index}` as typeof project.metadata.id;
        const bytes = Buffer.from(serializeProject(project, attached) as string);
        const hash = createHash('sha256').update(bytes).digest('hex');
        bodies.set(hash, bytes);
        const snapshot = {
          ...metadata,
          workflowId: project.metadata.id,
          relativePath: `${name}.rivet-project`,
          fileName: `${name}.rivet-project`,
          name,
          contents: { hash, size: bytes.length },
        };
        insert.run(snapshot.workflowId, snapshot.relativePath, '', '', JSON.stringify(snapshot));
      }
      db.exec('COMMIT');
    } finally {
      db.close();
    }
    // Generated immutable bodies isolate cache I/O counts from filesystem speed.
    const reads = t.mock.method(ImmutableLocalArtifactStore.prototype, 'read', async (hash: string, size?: number) => {
      const bytes = bodies.get(hash);
      assert.ok(bytes);
      assert.equal(bytes.length, size);
      return bytes;
    });
    try {
      const first = await backend.getTree();
      assert.equal(first.projects.length, 1025);
      assert.equal(reads.mock.callCount(), 1025);
      for (let attempt = 0; attempt < 2; attempt++) {
        const before = reads.mock.callCount();
        assert.deepEqual(await backend.getTree(), first);
        assert.equal(reads.mock.callCount() - before, 1, 'Only the evicted summary should need another read.');
      }
    } finally {
      reads.mock.restore();
    }
  });
});

test('SQLite warmed legacy tree summaries follow writes from another connection without reading bodies again', async (t) => {
  await fixture(async (backend, options) => {
    const item = await createExecutable(backend);
    removeTreeIndexes(options.databasePath);
    assert.deepEqual((await backend.getTree()).projects, [item]);
    const writer = new SqliteWorkflowBackend({ ...options, withWrite: async (operation) => operation() });
    try {
      writer.initialize();
      const loaded = await writer.loadHostedProject(item.absolutePath);
      const [project, attached] = loadProjectAndAttachedDataFromString(loaded.contents);
      const main = project.graphs[project.metadata.mainGraphId!]!;
      main.nodes.push({
        id: 'text' as (typeof main.nodes)[number]['id'],
        type: 'text',
        title: 'Text',
        visualData: { x: 0, y: 0, width: 200 },
        data: { text: 'Updated through another connection' },
      });
      const saved = await writer.saveHostedProject({
        projectPath: item.absolutePath,
        contents: serializeProject(project, attached) as string,
        datasetsContents: serializeDatasets([]),
        expectedRevisionId: loaded.revisionId,
      });
      const reads = t.mock.method(ImmutableLocalArtifactStore.prototype, 'read', async () => {
        throw new Error('Updated indexed tree must not read artifacts');
      });
      try {
        assert.deepEqual((await backend.getTree()).projects, [saved.project]);
        assert.equal(reads.mock.callCount(), 0);
        assert.notEqual(saved.project.revisionId, item.revisionId);
        assert.equal(saved.project.stats!.totalNodeCount, 1);
      } finally {
        reads.mock.restore();
      }
      backend.close();
      backend.initialize();
      assert.deepEqual((await backend.getTree()).projects, [saved.project], 'Persisted summary survives restart.');
    } finally {
      writer.close();
    }
  });
});

test('SQLite serving verification checks independent web-app freshness and aggregate publication status', async (t) => {
  await fixture(async (backend, options) => {
    let item = await createExecutable(backend);
    const loaded = await backend.loadHostedProject(item.absolutePath);
    const [project, attached] = loadProjectAndAttachedDataFromString(loaded.contents);
    project.uiGraphs = {
      first: { id: 'first', name: 'First', components: [] },
      second: { id: 'second', name: 'Second', components: [] },
    } as typeof project.uiGraphs;
    item = (
      await backend.saveHostedProject({
        projectPath: item.absolutePath,
        contents: serializeProject(project, attached) as string,
        datasetsContents: null,
        expectedRevisionId: loaded.revisionId,
      })
    ).project;
    const apps = [
      { uiGraphId: 'first', slug: 'first', allowedEmails: [] },
      { uiGraphId: 'second', slug: 'second', allowedEmails: [] },
    ];
    item = await backend.publishWorkflowProjectWebApps(item.relativePath, apps, conditions(item));
    project.metadata.description = 'New draft';
    item = (
      await backend.saveHostedProject({
        projectPath: item.absolutePath,
        contents: serializeProject(project, attached) as string,
        datasetsContents: null,
        expectedRevisionId: item.revisionId,
      })
    ).project;
    item = await backend.publishWorkflowProjectWebApps(item.relativePath, [apps[0]!], conditions(item));
    assert.deepEqual(Object.fromEntries(item.settings.publishedWebApps!.map((app) => [app.uiGraphId, app.status])), {
      first: 'published',
      second: 'unpublished_changes',
    });
    const catalog = new LocalWorkflowCatalog(options);
    let source;
    try {
      catalog.initialize({ verifyOnly: true });
      source = (await catalog.readProject(item.relativePath))!;
    } finally {
      catalog.close();
    }
    const verifyOptions = { ...options, folders: [], projects: [source], recordings: [], assertFrozen: async () => {} };
    await verifySqliteWorkflowServing(verifyOptions);
    const original = SqliteWorkflowBackend.prototype.getTree;
    for (const field of ['webApp', 'aggregate', 'endpoint'] as const) {
      const faulty = t.mock.method(
        SqliteWorkflowBackend.prototype,
        'getTree',
        async function (this: SqliteWorkflowBackend) {
          const tree = await original.call(this);
          const settings = tree.projects[0]!.settings;
          if (field === 'webApp')
            settings.publishedWebApps!.find((app) => app.uiGraphId === 'second')!.status = 'published';
          else if (field === 'aggregate') settings.publicationStatus = 'published';
          else settings.status = 'published';
          return tree;
        },
      );
      try {
        await assert.rejects(
          verifySqliteWorkflowServing(verifyOptions),
          /published web-app set|aggregate publication status|publication pointers/,
        );
      } finally {
        faulty.mock.restore();
      }
    }
  });
});

test('SQLite serving verification rejects well-formed but incorrect persisted tree summaries', async () => {
  await fixture(async (backend, options) => {
    const item = await createExecutable(backend);
    const catalog = new LocalWorkflowCatalog(options);
    let source;
    try {
      catalog.initialize({ verifyOnly: true });
      source = (await catalog.readProject(item.relativePath))!;
    } finally {
      catalog.close();
    }
    const verifyOptions = { ...options, folders: [], projects: [source], recordings: [], assertFrozen: async () => {} };
    await verifySqliteWorkflowServing(verifyOptions);
    const db = new DatabaseSync(options.databasePath);
    try {
      const row = db.prepare('SELECT metadata_json FROM projects').get() as { metadata_json: string };
      const metadata = JSON.parse(row.metadata_json);
      const summary = metadata.treeIndex;
      for (const treeIndex of [
        { ...summary, revisionId: `fs-sha256:${'0'.repeat(64)}` },
        ...(['graphCount', 'totalNodeCount', 'webAppCount'] as const).map((field) => ({
          ...summary,
          stats: { ...summary.stats, [field]: summary.stats[field] + 1 },
        })),
      ]) {
        db.prepare('UPDATE projects SET metadata_json = ?').run(JSON.stringify({ ...metadata, treeIndex }));
        const before = await fs.readFile(options.databasePath);
        await assert.rejects(verifySqliteWorkflowServing(verifyOptions), /tree revision|tree statistics/);
        assert.deepEqual(await fs.readFile(options.databasePath), before, 'Verification cannot rewrite the summary.');
      }
      db.prepare('UPDATE projects SET metadata_json = ?').run(row.metadata_json);
      await verifySqliteWorkflowServing(verifyOptions);
    } finally {
      db.close();
    }
  });
});

test('SQLite cold legacy summary failures are retryable and concurrent mutations cannot return a stale tree', async (t) => {
  await fixture(async (backend, options) => {
    const item = await createExecutable(backend);
    removeTreeIndexes(options.databasePath);
    const original = ImmutableLocalArtifactStore.prototype.read;
    let fail = true;
    const reads = t.mock.method(
      ImmutableLocalArtifactStore.prototype,
      'read',
      async function (this: ImmutableLocalArtifactStore, ...args: Parameters<typeof original>) {
        if (fail) {
          fail = false;
          throw new Error('Transient read failure');
        }
        return original.apply(this, args);
      },
    );
    await assert.rejects(backend.getTree(), /Transient read failure/);
    assert.deepEqual((await backend.getTree()).projects, [item]);
    reads.mock.restore();
    // Reopen to exercise the cold path again, with another connection committing a rename mid-read.
    backend.close();
    backend.initialize();
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    let first = true;
    const delayed = t.mock.method(
      ImmutableLocalArtifactStore.prototype,
      'read',
      async function (this: ImmutableLocalArtifactStore, ...args: Parameters<typeof original>) {
        if (first) {
          first = false;
          started();
          await gate;
        }
        return original.apply(this, args);
      },
    );
    const pending = backend.getTree();
    const rejected = assert.rejects(pending, /Workflow tree changed while loading/);
    try {
      await withAsyncDeadline(ready, 'cold tree read');
      const other = new SqliteWorkflowBackend({ ...options, withWrite: async (operation) => operation() });
      try {
        other.initialize();
        await other.renameWorkflowProjectItem(item.relativePath, 'Renamed');
      } finally {
        other.close();
      }
    } finally {
      release();
    }
    await rejected;
    delayed.mock.restore();
    assert.equal((await backend.getTree()).projects[0]!.name, 'Renamed');
  });
});

test('SQLite cold tree bounds artifact reads and drains in-flight workers before rejecting', async (t) => {
  await fixture(async (backend, options) => {
    for (let index = 0; index < 12; index++) await createExecutable(backend, `Project ${index}`);
    removeTreeIndexes(options.databasePath);
    const original = ImmutableLocalArtifactStore.prototype.read;
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    let calls = 0;
    let active = 0;
    let settled = false;
    const delayed = t.mock.method(
      ImmutableLocalArtifactStore.prototype,
      'read',
      async function (this: ImmutableLocalArtifactStore, ...args: Parameters<typeof original>) {
        calls++;
        if (calls === 8) started();
        if (calls === 1) throw new Error('Injected tree read failure');
        active++;
        try {
          await gate;
          return await original.apply(this, args);
        } finally {
          active--;
        }
      },
    );
    const pending = backend.getTree().finally(() => {
      settled = true;
    });
    const rejected = assert.rejects(pending, /Injected tree read failure/);
    try {
      await withAsyncDeadline(ready, 'bounded cold tree workers');
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(calls, 8, 'Only the bounded first batch starts before failure.');
      assert.equal(active, 7);
      assert.equal(settled, false, 'The failed request still owns its in-flight reads.');
    } finally {
      release();
    }
    await rejected;
    assert.equal(active, 0);
    assert.equal(calls, 8, 'Failure stops further work.');
    delayed.mock.restore();
    assert.equal((await backend.getTree()).projects.length, 12, 'A retry completes the tree.');
  });
});

test('SQLite tree indexes follow edits and retain the hosted revision contract', async () => {
  await fixture(async (backend) => {
    const item = await createExecutable(backend);
    const loaded = await backend.loadHostedProject(item.absolutePath);
    const [project, attached] = loadProjectAndAttachedDataFromString(loaded.contents);
    const main = project.graphs[project.metadata.mainGraphId!]!;
    main.nodes.push({
      id: 'text' as (typeof main.nodes)[number]['id'],
      type: 'text',
      title: 'Text',
      visualData: { x: 0, y: 0, width: 200 },
      data: { text: 'Updated' },
    });
    const saved = await backend.saveHostedProject({
      projectPath: item.absolutePath,
      contents: serializeProject(project, attached) as string,
      datasetsContents: null,
      expectedRevisionId: loaded.revisionId,
    });
    const tree = await backend.getTree();
    assert.deepEqual(tree.projects, [saved.project]);
    assert.deepEqual(tree.projects[0]!.stats, { graphCount: 1, totalNodeCount: 1, webAppCount: 0 });
    assert.notEqual(tree.projects[0]!.revisionId, item.revisionId);
    assert.equal(tree.projects[0]!.revisionId, (await backend.loadHostedProject(item.absolutePath)).revisionId);
  });
});

test('SQLite tree includes dataset-only revisions and independent web-app freshness without reading payloads', async (t) => {
  await fixture(async (backend) => {
    let item = await createExecutable(backend);
    const loaded = await backend.loadHostedProject(item.absolutePath);
    const [project, attached] = loadProjectAndAttachedDataFromString(loaded.contents);
    project.uiGraphs = { ui: { id: 'ui', name: 'UI', components: [] } } as typeof project.uiGraphs;
    item = (
      await backend.saveHostedProject({
        projectPath: item.absolutePath,
        contents: serializeProject(project, attached) as string,
        datasetsContents: null,
        expectedRevisionId: item.revisionId,
      })
    ).project;
    item = await backend.publishWorkflowProjectWebApps(
      item.relativePath,
      [{ uiGraphId: 'ui', slug: 'story-ui', allowedEmails: [] }],
      conditions(item),
    );
    assert.equal(item.settings.status, 'unpublished');
    assert.equal(item.settings.publicationStatus, 'published');
    assert.equal(item.settings.publishedWebApps![0]!.status, 'published');
    const published = item;
    const current = await backend.loadHostedProject(item.absolutePath);
    item = (
      await backend.saveHostedProject({
        projectPath: item.absolutePath,
        contents: current.contents,
        datasetsContents: serializeDatasets([]),
        expectedRevisionId: item.revisionId,
      })
    ).project;
    assert.notEqual(item.revisionId, published.revisionId);
    assert.equal(item.settings.publishedWebApps![0]!.status, 'unpublished_changes');
    const reads = t.mock.method(ImmutableLocalArtifactStore.prototype, 'read', async () => {
      throw new Error('Unexpected tree artifact read');
    });
    assert.deepEqual((await backend.getTree()).projects, [item]);
    assert.equal(reads.mock.callCount(), 0);
    reads.mock.restore();
  });
});

test('SQLite tree rejects malformed persisted summaries instead of returning invalid revisions or counts', async () => {
  await fixture(async (backend, options) => {
    const item = await createExecutable(backend);
    const db = new DatabaseSync(options.databasePath);
    try {
      const row = db.prepare('SELECT metadata_json FROM projects').get() as { metadata_json: string };
      const metadata = JSON.parse(row.metadata_json);
      for (const treeIndex of [
        null,
        {},
        { ...metadata.treeIndex, revisionId: 'invalid' },
        { ...metadata.treeIndex, stats: { ...metadata.treeIndex.stats, graphCount: -1 } },
      ]) {
        db.prepare('UPDATE projects SET metadata_json = ?').run(JSON.stringify({ ...metadata, treeIndex }));
        await assert.rejects(backend.getTree(), /Invalid local project tree index/);
      }
      db.prepare('UPDATE projects SET metadata_json = ?').run(row.metadata_json);
      assert.deepEqual((await backend.getTree()).projects, [item]);
    } finally {
      db.close();
    }
  });
});

test('SQLite endpoint lookup reads only its selected artifact, not unrelated projects or retained history', async () => {
  await fixture(async (backend, options) => {
    let item = await createExecutable(backend);
    item = await backend.publishWorkflowProjectItem(
      item.relativePath,
      { endpointName: 'Story', endpointAccess: 'internal' },
      conditions(item),
    );
    item = await backend.updateWorkflowEndpointAccess(item.relativePath, 'internal', conditions(item));
    const oldContents = (await backend.loadHostedProject(item.absolutePath)).contents;
    const [project, attached] = loadProjectAndAttachedDataFromString(oldContents);
    project.metadata.description = 'new published';
    item = (
      await backend.saveHostedProject({
        projectPath: item.absolutePath,
        contents: serializeProject(project, attached) as string,
        datasetsContents: null,
        expectedRevisionId: item.revisionId,
      })
    ).project;
    item = await backend.publishWorkflowProjectItem(
      item.relativePath,
      { endpointName: 'Story', endpointAccess: 'internal' },
      conditions(item),
    );
    const other = await createExecutable(backend, 'Other');
    const otherContents = (await backend.loadHostedProject(other.absolutePath)).contents;
    for (const contents of [oldContents, otherContents]) {
      const hash = createHash('sha256').update(contents).digest('hex');
      await fs.unlink(path.join(options.artifactRoot, hash.slice(0, 2), hash));
    }
    const loaded = await backend.loadPublishedExecutionProject('sToRy');
    assert.equal(loaded?.project.metadata.description, 'new published');
    assert.equal(loaded?.endpointAccess, 'internal');
    await assert.rejects(backend.loadHostedProject(other.absolutePath), /ENOENT/);
    assert.equal(await backend.loadPublishedExecutionProject('unknown'), null);
    assert.equal((await backend.getTree()).projects.length, 2, 'Discovery does not materialize historical bodies.');
    const versions = (await backend.listWorkflowPublishedVersions(item.relativePath)).versions;
    assert.equal(versions.length, 2, 'History discovery is metadata-only.');
    const oldVersion = versions.find((version) => !version.isCurrent)!;
    await assert.rejects(backend.readWorkflowPublishedVersionPreview(item.relativePath, oldVersion.id), /ENOENT/);
    // Full conversion verification must still discover the deliberately broken history.
    const catalog = new LocalWorkflowCatalog(options);
    try {
      catalog.initialize({ verifyOnly: true });
      await assert.rejects(catalog.readProject(item.relativePath), /ENOENT/);
    } finally {
      catalog.close();
    }
  });
});

test('SQLite project browsing reads only the selected pair, and metadata discovery reads no bodies', async (t) => {
  await fixture(async (backend) => {
    let item = await createExecutable(backend);
    let loaded = await backend.loadHostedProject(item.absolutePath);
    const [project, attached] = loadProjectAndAttachedDataFromString(loaded.contents);
    const datasetsContents = serializeDatasets([]);
    item = (
      await backend.saveHostedProject({
        projectPath: item.absolutePath,
        contents: loaded.contents,
        datasetsContents,
        expectedRevisionId: loaded.revisionId,
      })
    ).project;
    item = await backend.publishWorkflowProjectItem(item.relativePath, { endpointName: 'story' }, conditions(item));
    const firstVersion = (await backend.listWorkflowPublishedVersions(item.relativePath)).versions[0]!.id;
    const firstContents = loaded.contents;
    project.metadata.description = 'New draft and publication';
    loaded = await backend.loadHostedProject(item.absolutePath);
    item = (
      await backend.saveHostedProject({
        projectPath: item.absolutePath,
        contents: serializeProject(project, attached) as string,
        datasetsContents,
        expectedRevisionId: loaded.revisionId,
      })
    ).project;
    item = await backend.publishWorkflowProjectItem(item.relativePath, { endpointName: 'story' }, conditions(item));
    const currentContents = (await backend.loadHostedProject(item.absolutePath)).contents;
    let reads = 0;
    const originalRead = ImmutableLocalArtifactStore.prototype.read;
    t.mock.method(
      ImmutableLocalArtifactStore.prototype,
      'read',
      async function (this: ImmutableLocalArtifactStore, ...args: Parameters<typeof originalRead>) {
        reads++;
        return originalRead.apply(this, args);
      },
    );
    t.mock.method(LocalWorkflowCatalog.prototype, 'readProject', () => {
      throw new Error('Full snapshot read');
    });
    const checkPair = async (operation: () => Promise<unknown>) => {
      const before = reads;
      await operation();
      assert.equal(reads - before, 2, 'Only the requested project and datasets are materialized.');
    };
    await checkPair(async () =>
      assert.equal((await backend.loadHostedProject(item.absolutePath)).contents, currentContents),
    );
    await checkPair(async () => assert.equal(await backend.readHostedText(item.absolutePath), currentContents));
    await checkPair(async () =>
      assert.equal(await backend.resolveManagedRelativeProjectText(item.absolutePath, item.fileName), currentContents),
    );
    await checkPair(async () =>
      assert.equal(
        (await backend.readWorkflowProjectDownload(item.relativePath, 'published')).contents,
        currentContents,
      ),
    );
    await checkPair(async () =>
      assert.equal(
        (await backend.loadSubgraphTarget({ projectId: project.metadata.id, version: 'published' })).projectContents,
        currentContents,
      ),
    );
    const beforeReference = reads;
    assert.equal(
      (await backend.createProjectReferenceLoader().loadProject(undefined, { id: item.projectMetadataId! })).metadata
        .description,
      project.metadata.description,
    );
    assert.equal(
      reads,
      beforeReference,
      'The reference loader reuses the verified immutable source loaded by the Subgraph.',
    );
    await checkPair(async () =>
      assert.deepEqual(await backend.readWorkflowPublishedVersionPreview(item.relativePath, firstVersion), {
        contents: firstContents,
        datasetsContents,
      }),
    );
    await checkPair(async () =>
      assert.equal(
        (await backend.readWorkflowPublishedVersionDownload(item.relativePath, firstVersion)).contents,
        firstContents,
      ),
    );
    const before = reads;
    assert.equal((await backend.listWorkflowPublishedVersions(item.relativePath)).versions.length, 2);
    assert.equal(await backend.hostedPathExists(item.absolutePath), true);
    assert.equal(await backend.hostedPathExists(item.absolutePath.replace('.rivet-project', '.rivet-data')), true);
    assert.equal(await backend.hostedPathExists(item.absolutePath.replace('Story', 'Missing')), false);
    assert.equal(reads, before);
    await assert.rejects(backend.readWorkflowPublishedVersionPreview(item.relativePath, 'missing'), /not found/);
    assert.equal(reads, before);
  });
});

test('SQLite recording workflow summaries aggregate in SQL and never load project or run bodies', async (t) => {
  await fixture(async (backend, options) => {
    assert.deepEqual(await backend.listWorkflowRecordingWorkflows(), { workflows: [] });
    const item = await createExecutable(backend);
    const unused = await createExecutable(backend, 'No recordings');
    const [project, attached] = loadProjectAndAttachedDataFromString(
      (await backend.loadHostedProject(item.absolutePath)).contents,
    );
    for (const status of ['succeeded', 'failed', 'suspicious'] as const) {
      await backend.persistWorkflowExecutionRecording({
        sourceProject: project,
        sourceProjectPath: item.absolutePath,
        executedProject: project,
        executedAttachedData: attached,
        executedDatasets: [],
        endpointName: 'story',
        recordingSerialized: '{}',
        runKind: 'editor',
        status,
        durationMs: 1,
      });
    }
    const page = await backend.listWorkflowRecordingRunsPage(item.projectMetadataId!, 1, 100);
    const newest = page.runs[0]!.createdAt;
    removeTreeIndexes(options.databasePath);
    t.mock.method(ImmutableLocalArtifactStore.prototype, 'read', () => {
      throw new Error('Artifact read');
    });
    t.mock.method(LocalWorkflowCatalog.prototype, 'readProject', () => {
      throw new Error('Full snapshot read');
    });
    t.mock.method(LocalWorkflowCatalog.prototype, 'listRecordingMetadata', () => {
      throw new Error('Per-project all-runs read');
    });
    const returnedRows: number[] = [];
    const prepare = DatabaseSync.prototype.prepare;
    t.mock.method(DatabaseSync.prototype, 'prepare', function (this: DatabaseSync, sql: string) {
      const statement = prepare.call(this, sql);
      if (/\bFROM recordings\b/i.test(sql)) {
        const all = statement.all;
        t.mock.method(statement, 'all', (...args: Parameters<typeof all>) => {
          const rows = all.apply(statement, args);
          returnedRows.push(rows.length);
          return rows;
        });
      }
      return statement;
    });
    const { workflows } = await backend.listWorkflowRecordingWorkflows();
    assert.deepEqual(returnedRows, [1], 'SQLite returns one owner summary, not three recording rows');
    assert.equal(workflows.length, 1);
    assert.equal(workflows[0]!.workflowId, item.projectMetadataId);
    assert.notEqual(workflows[0]!.workflowId, unused.projectMetadataId);
    assert.equal(workflows[0]!.latestRunAt, newest);
    assert.equal(workflows[0]!.totalRuns, 3);
    assert.equal(workflows[0]!.failedRuns, 1);
    assert.equal(workflows[0]!.suspiciousRuns, 1);
    const db = new DatabaseSync(options.databasePath);
    try {
      const row = db.prepare('SELECT recording_id, metadata_json FROM recordings LIMIT 1').get() as {
        recording_id: string;
        metadata_json: string;
      };
      const metadata = JSON.parse(row.metadata_json);
      const update = db.prepare('UPDATE recordings SET metadata_json = ? WHERE recording_id = ?');
      for (const corruption of [
        { status: 'invalid' },
        { status: null },
        { createdAt: 2026 },
        { createdAt: 'invalid' },
        { createdAt: null },
        { createdAt: 'now' },
        { createdAt: '2026' },
        { createdAt: '2026-02-30T00:00:00.000Z' },
        { createdAt: '2026-10-08T24:00:00.000Z' },
        { createdAt: '2026-10-08T24:01:00.000Z' },
        { createdAt: '2026-10-08T02:00:00.000+02:00' },
        { createdAt: '2026-10-08T00:00:00Z' },
        { workflowId: 'other-owner' },
        { recordingId: 'other-recording' },
      ]) {
        update.run(JSON.stringify({ ...metadata, ...corruption }), row.recording_id);
        await assert.rejects(backend.listWorkflowRecordingWorkflows(), /metadata is inconsistent/);
        await assert.rejects(
          backend.readWorkflowRecordingArtifact(row.recording_id, 'recording'),
          /metadata is inconsistent/,
        );
        update.run(row.metadata_json, row.recording_id);
        assert.equal((await backend.listWorkflowRecordingWorkflows()).workflows[0]!.totalRuns, 3);
      }
      // The production expression index already refuses malformed JSON writes.
      // Drop it only in this disposable corruption fixture to exercise the read guard.
      const index = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'recordings_workflow_created_at'").get() as {
        sql: string;
      };
      db.exec('DROP INDEX recordings_workflow_created_at');
      try {
        update.run('{invalid-json', row.recording_id);
        await assert.rejects(backend.listWorkflowRecordingWorkflows(), /metadata is inconsistent/);
      } finally {
        update.run(row.metadata_json, row.recording_id);
        db.exec(index.sql);
      }
      const restored = await backend.listWorkflowRecordingWorkflows();
      assert.equal(restored.workflows[0]!.totalRuns, 3);
      assert.equal(restored.workflows[0]!.latestRunAt, newest);
      const dates = ['2026-03-01T00:00:00.999Z', '2026-03-01T00:00:00.001Z', '2024-02-29T00:00:00.000Z'];
      const setDate = db.prepare(
        "UPDATE recordings SET metadata_json = json_set(metadata_json, '$.createdAt', ?) WHERE recording_id = ?",
      );
      page.runs.forEach((run, index) => setDate.run(dates[index]!, run.id));
      assert.equal((await backend.listWorkflowRecordingWorkflows()).workflows[0]!.latestRunAt, dates[0]);
    } finally {
      db.close();
    }
  });
});

test('SQLite selected payload reads reject changes while I/O is pending and capture version selection', async (t) => {
  await fixture(async (backend, options) => {
    let item = await createExecutable(backend);
    item = await backend.publishWorkflowProjectItem(item.relativePath, { endpointName: 'story' }, conditions(item));
    const versionId = (await backend.listWorkflowPublishedVersions(item.relativePath)).versions[0]!.id;
    const catalog = new LocalWorkflowCatalog(options);
    const originalRead = ImmutableLocalArtifactStore.prototype.read;
    let duringRead: (() => void) | undefined;
    t.mock.method(
      ImmutableLocalArtifactStore.prototype,
      'read',
      async function (this: ImmutableLocalArtifactStore, ...args: Parameters<typeof originalRead>) {
        const effect = duringRead;
        duringRead = undefined;
        effect?.();
        return originalRead.apply(this, args);
      },
    );
    try {
      catalog.initialize({ verifyOnly: true });
      const selection = { versionId };
      duringRead = () => {
        selection.versionId = 'missing';
      };
      assert.ok((await catalog.readProjectPayload(item.relativePath, selection))?.contents);
      duringRead = () => {
        const db = new DatabaseSync(options.databasePath);
        try {
          db.prepare(
            "UPDATE published_versions SET metadata_json = json_set(metadata_json, '$.comment', 'changed') WHERE version_id = ?",
          ).run(versionId);
        } finally {
          db.close();
        }
      };
      await assert.rejects(catalog.readProjectPayload(item.relativePath, { versionId }), /changed concurrently/);
    } finally {
      catalog.close();
    }
  });
});

test('SQLite related project metadata comes from one snapshot under a competing connection', async (t) => {
  await fixture(async (backend, options) => {
    let item = await createExecutable(backend);
    const loaded = await backend.loadHostedProject(item.absolutePath);
    const [project, attached] = loadProjectAndAttachedDataFromString(loaded.contents);
    project.uiGraphs = { ui: { id: 'ui', name: 'UI', components: [] } } as typeof project.uiGraphs;
    item = (
      await backend.saveHostedProject({
        projectPath: item.absolutePath,
        contents: serializeProject(project, attached) as string,
        datasetsContents: null,
        expectedRevisionId: item.revisionId,
      })
    ).project;
    item = await backend.publishWorkflowProjectWebApps(
      item.relativePath,
      [{ uiGraphId: 'ui', slug: 'story-ui', allowedEmails: [] }],
      conditions(item),
    );
    const version = item.settings.publicationVersion!;
    const nextVersion = String(BigInt(version) + 1n);
    const db = new DatabaseSync(options.databasePath);
    const catalog = new LocalWorkflowCatalog(options);
    try {
      // WAL permits a writer to commit while the reader's metadata snapshot is open.
      // Production DELETE-journal mode instead delays the commit until this short read ends.
      db.exec('PRAGMA journal_mode = WAL');
      catalog.initialize({ verifyOnly: true });
      const prepare = DatabaseSync.prototype.prepare;
      let competingWrite = true;
      t.mock.method(DatabaseSync.prototype, 'prepare', function (this: DatabaseSync, sql: string) {
        const statement = prepare.call(this, sql);
        if (sql === 'SELECT * FROM projects WHERE relative_path = ?') {
          const get = statement.get;
          t.mock.method(statement, 'get', (...args: Parameters<typeof get>) => {
            const result = get.apply(statement, args);
            if (competingWrite) {
              competingWrite = false;
              db.exec('BEGIN IMMEDIATE');
              db.prepare(
                "UPDATE projects SET metadata_json = json_set(metadata_json, '$.publicationVersion', ?) WHERE workflow_id = ?",
              ).run(nextVersion, item.projectMetadataId!);
              db.prepare(
                "UPDATE web_apps SET metadata_json = json_set(metadata_json, '$.allowedEmails', json(?)) WHERE workflow_id = ?",
              ).run(JSON.stringify(['other@example.com']), item.projectMetadataId!);
              db.exec('COMMIT');
            }
            return result;
          });
        }
        return statement;
      });
      const original = catalog.readProjectMetadataById(item.projectMetadataId!)!;
      assert.equal(competingWrite, false);
      assert.equal(original.publicationVersion, version);
      assert.deepEqual(original.publishedWebApps[0]!.allowedEmails, []);
      const current = catalog.readProjectMetadataById(item.projectMetadataId!)!;
      assert.equal(current.publicationVersion, nextVersion);
      assert.deepEqual(current.publishedWebApps[0]!.allowedEmails, ['other@example.com']);
      db.prepare(
        "UPDATE projects SET metadata_json = json_set(metadata_json, '$.endpointAccess', 'invalid') WHERE workflow_id = ?",
      ).run(item.projectMetadataId!);
      assert.throws(() => catalog.readProjectMetadataById(item.projectMetadataId!), /access policy/);
      db.prepare(
        "UPDATE projects SET metadata_json = json_set(metadata_json, '$.endpointAccess', 'public') WHERE workflow_id = ?",
      ).run(item.projectMetadataId!);
      assert.equal(
        catalog.readProjectMetadataById(item.projectMetadataId!)!.endpointAccess,
        'public',
        'A failed metadata read releases its snapshot; repairs are immediately visible.',
      );
    } finally {
      catalog.close();
      db.close();
    }
  });
});

test('SQLite execution caches immutable bytes but resolves current routes, paths and access on every hit', async () => {
  await fixture(async (backend, options) => {
    let item = await createExecutable(backend);
    item = await backend.publishWorkflowProjectItem(item.relativePath, { endpointName: 'story' }, conditions(item));
    const first = (await backend.loadPublishedExecutionProject('story'))!;
    assert.equal(first.debug.cacheStatus, 'miss');
    first.project.metadata.description = 'caller mutation';
    const hit = (await backend.loadPublishedExecutionProject('story'))!;
    assert.equal(hit.debug.cacheStatus, 'hit');
    assert.notEqual(hit.project.metadata.description, 'caller mutation');

    const writer = new SqliteWorkflowBackend({ ...options, withWrite: async (operation) => operation() });
    try {
      writer.initialize();
      item = await writer.updateWorkflowEndpointAccess(item.relativePath, 'internal', conditions(item));
      const updated = (await backend.loadPublishedExecutionProject('story'))!;
      assert.equal(updated.debug.cacheStatus, 'hit');
      assert.equal(updated.endpointAccess, 'internal');
      item = (await writer.renameWorkflowProjectItem(item.relativePath, 'Renamed')).project;
      assert.equal((await backend.loadPublishedExecutionProject('story'))!.projectVirtualPath, item.absolutePath);
      const loaded = await writer.loadHostedProject(item.absolutePath);
      const [project, attached] = loadProjectAndAttachedDataFromString(loaded.contents);
      project.metadata.description = 'new draft';
      item = (
        await writer.saveHostedProject({
          projectPath: item.absolutePath,
          contents: serializeProject(project, attached) as string,
          datasetsContents: null,
          expectedRevisionId: loaded.revisionId,
        })
      ).project;
      assert.notEqual(
        (await backend.loadPublishedExecutionProject('story'))!.project.metadata.description,
        'new draft',
      );
      assert.equal((await backend.loadLatestExecutionProject('story'))!.project.metadata.description, 'new draft');
      item = await writer.publishWorkflowProjectItem(
        item.relativePath,
        { endpointName: 'new-route' },
        conditions(item),
      );
      assert.equal(await backend.loadPublishedExecutionProject('story'), null);
      assert.equal(
        (await backend.loadPublishedExecutionProject('new-route'))!.project.metadata.description,
        'new draft',
      );
      await writer.unpublishWorkflowProjectItem(item.relativePath, conditions(item));
      assert.equal(await backend.loadPublishedExecutionProject('new-route'), null);
    } finally {
      writer.close();
    }
  });
});

test('SQLite read-only validation bypasses execution caches and checks artifact bytes every time', async () => {
  await fixture(async (backend, options) => {
    let item = await createExecutable(backend);
    item = await backend.publishWorkflowProjectItem(item.relativePath, { endpointName: 'story' }, conditions(item));
    const contents = (await backend.loadHostedProject(item.absolutePath)).contents;
    const reader = new SqliteWorkflowBackend({
      ...options,
      withWrite: async () => {
        throw new Error('read-only');
      },
    });
    try {
      reader.initialize({ readOnly: true });
      assert.equal((await reader.loadPublishedExecutionProject('story'))!.debug.cacheStatus, 'bypass');
      assert.equal((await reader.loadPublishedExecutionProject('story'))!.debug.cacheStatus, 'bypass');
      const hash = createHash('sha256').update(contents).digest('hex');
      await fs.unlink(path.join(options.artifactRoot, hash.slice(0, 2), hash));
      await assert.rejects(reader.loadPublishedExecutionProject('story'));
    } finally {
      reader.close();
    }
  });
});

test('SQLite cached execution and policy reads fail closed on malformed stored access rules', async () => {
  await fixture(async (backend, options) => {
    let item = await createExecutable(backend);
    const loaded = await backend.loadHostedProject(item.absolutePath);
    const [project, attached] = loadProjectAndAttachedDataFromString(loaded.contents);
    project.uiGraphs = { ui: { id: 'ui', name: 'UI', components: [] } } as typeof project.uiGraphs;
    item = (
      await backend.saveHostedProject({
        projectPath: item.absolutePath,
        contents: serializeProject(project, attached) as string,
        datasetsContents: null,
        expectedRevisionId: item.revisionId,
      })
    ).project;
    item = await backend.publishWorkflowProjectItem(item.relativePath, { endpointName: 'story' }, conditions(item));
    item = await backend.publishWorkflowProjectWebApps(
      item.relativePath,
      [{ uiGraphId: 'ui', slug: 'story-ui', allowedEmails: ['operator@example.com'] }],
      conditions(item),
    );
    await backend.loadPublishedExecutionProject('story');
    await backend.loadPublishedWebAppExecutionProject('story-ui');
    const db = new DatabaseSync(options.databasePath);
    const projectRow = db
      .prepare('SELECT metadata_json FROM projects WHERE workflow_id = ?')
      .get(item.projectMetadataId!) as { metadata_json: string };
    const appRow = db.prepare('SELECT app_id, metadata_json FROM web_apps').get() as {
      app_id: string;
      metadata_json: string;
    };
    try {
      for (const endpointAccess of [null, 'unrecognized', undefined]) {
        db.prepare('UPDATE projects SET metadata_json = ? WHERE workflow_id = ?').run(
          JSON.stringify({ ...JSON.parse(projectRow.metadata_json), endpointAccess }),
          item.projectMetadataId!,
        );
        await assert.rejects(
          backend.loadPublishedExecutionProject('story'),
          /Invalid local project metadata or access policy/,
        );
        await assert.rejects(backend.loadPublishedWebAppExecutionProject('story-ui'), /access policy/);
        await assert.rejects(backend.getTree(), /access policy/);
      }
      db.prepare('UPDATE projects SET metadata_json = ? WHERE workflow_id = ?').run(
        projectRow.metadata_json,
        item.projectMetadataId!,
      );
      for (const allowedEmails of [null, 'operator@example.com', [42], ['not-an-email'], undefined]) {
        db.prepare('UPDATE web_apps SET metadata_json = ? WHERE app_id = ?').run(
          JSON.stringify({ ...JSON.parse(appRow.metadata_json), allowedEmails }),
          appRow.app_id,
        );
        await assert.rejects(
          backend.resolveWebAppAccessPolicy('story-ui'),
          /Invalid local web-app metadata or access policy/,
        );
        await assert.rejects(backend.loadPublishedWebAppExecutionProject('story-ui'), /access policy/);
        await assert.rejects(backend.getTree(), /access policy/);
      }
      db.prepare('UPDATE web_apps SET metadata_json = ? WHERE app_id = ?').run(appRow.metadata_json, appRow.app_id);
      assert.deepEqual((await backend.resolveWebAppAccessPolicy('story-ui'))!.allowedEmails, ['operator@example.com']);
    } finally {
      db.prepare('UPDATE projects SET metadata_json = ? WHERE workflow_id = ?').run(
        projectRow.metadata_json,
        item.projectMetadataId!,
      );
      db.prepare('UPDATE web_apps SET metadata_json = ? WHERE app_id = ?').run(appRow.metadata_json, appRow.app_id);
      db.close();
    }
  });
});

test('SQLite constructor retains its original maintenance lease if caller options are later modified', async () => {
  await fixture(async (_backend, options) => {
    const mutable = {
      ...options,
      withWrite: async <T>(_operation: () => Promise<T>): Promise<T> => {
        throw new Error('maintenance');
      },
    };
    const writer = new SqliteWorkflowBackend(mutable);
    try {
      writer.initialize();
      mutable.withWrite = async (operation) => operation();
      await assert.rejects(writer.createWorkflowProjectItem('', 'Blocked'), /maintenance/);
      assert.equal((await writer.getTree()).projects.length, 0);
    } finally {
      await writer.dispose();
    }
  });
});

test('SQLite serving does not create a missing or unidentified catalog', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-sqlite-missing-'));
  const options = {
    databasePath: path.join(root, 'missing.sqlite'),
    artifactRoot: path.join(root, 'objects'),
    virtualRoot: root,
    withWrite: async <T>(operation: () => Promise<T>) => operation(),
  };
  const backend = new SqliteWorkflowBackend(options);
  try {
    assert.throws(() => backend.initialize(), /does not exist/);
    await fs.writeFile(options.databasePath, '');
    assert.throws(() => backend.initialize(), /unsupported database identity/);
  } finally {
    backend.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('SQLite late initialization cannot reopen admission after close begins', async () => {
  await fixture(async (_backend, options) => {
    let leases = 0;
    const backend = new SqliteWorkflowBackend({
      ...options,
      worker: true,
      withWrite: async (operation) => {
        leases++;
        return operation();
      },
    });
    const blocker = new DatabaseSync(options.databasePath);
    blocker.exec('BEGIN EXCLUSIVE');
    let locked = true;
    const opened = backend.initialize();
    const rejected = assert.rejects(async () => opened, /shutting down/);
    try {
      await assert.rejects(backend.createWorkflowProjectItem('', 'Too early'), { status: 503 });
      assert.equal(leases, 0, 'startup cannot enter a writer lease before initialization succeeds');
      const closed = backend.close();
      blocker.exec('ROLLBACK');
      locked = false;
      await rejected;
      await closed;
      await assert.rejects(backend.createWorkflowProjectItem('', 'Too late'), { status: 503 });
      assert.throws(() => backend.initialize(), /shutdown has begun/);
      assert.equal(leases, 0);
    } finally {
      if (locked) blocker.exec('ROLLBACK');
      blocker.close();
      await backend.dispose();
    }
  });
});

for (const worker of [false, true]) {
  test(`SQLite ${worker ? 'worker' : 'direct'} failed mode changes preserve the initialized write policy`, async () => {
    await fixture(async (_backend, options) => {
      let leases = 0;
      const backend = new SqliteWorkflowBackend({
        ...options,
        worker,
        withWrite: async (operation) => {
          leases++;
          return operation();
        },
      });
      try {
        await backend.initialize();
        await assert.rejects(async () => backend.initialize({ readOnly: true }), /another mode/);
        await backend.createWorkflowProjectItem('', 'Still writable');
        assert.equal(leases, 1, 'a rejected mode change must not disable the original writer');
      } finally {
        await backend.dispose();
      }
      const reader = new SqliteWorkflowBackend({
        ...options,
        worker,
        withWrite: async (operation) => {
          leases++;
          return operation();
        },
      });
      try {
        await reader.initialize({ readOnly: true });
        await assert.rejects(async () => reader.initialize(), /another mode/);
        await assert.rejects(reader.createWorkflowProjectItem('', 'Rejected'), /verification only/);
        assert.equal(leases, 1, 'a rejected mode change must not enter a writer lease on a verifier');
      } finally {
        await reader.dispose();
      }
    });
  });
}

test('SQLite shutdown drains queued writes, rejects new work and supports cancelling only the idle wait', async () => {
  await fixture(async (backend, options) => {
    let release!: () => void, announce!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      announce = resolve;
    });
    const writer = new SqliteWorkflowBackend({
      ...options,
      withWrite: async (operation) => {
        announce();
        await gate;
        return operation();
      },
    });
    writer.initialize();
    const pending = writer.createWorkflowProjectItem('', 'Accepted');
    try {
      await entered;
      await writer.checkHealth();
      assert.throws(() => writer.close(), /pending writes/);
      let drained = false;
      const idle = writer.waitForIdle().then(() => {
        drained = true;
      });
      const controller = new AbortController();
      const cancelled = writer.waitForIdle(controller.signal);
      controller.abort(new Error('operator cancelled wait'));
      await assert.rejects(cancelled, /operator cancelled wait/);
      assert.equal(drained, false);
      const stopped = writer.dispose();
      assert.equal(writer.dispose(), stopped);
      assert.throws(() => writer.initialize(), /shutdown is pending/);
      await assert.rejects(writer.createWorkflowProjectItem('', 'Rejected'), { status: 503 });
      await assert.rejects(writer.checkHealth(), /shutting down/);
      release();
      await Promise.all([pending, idle, stopped]);
      assert.equal(drained, true);
      assert.deepEqual(
        (await backend.getTree()).projects.map((item) => item.name),
        ['Accepted'],
      );
    } finally {
      release();
      await pending;
      await writer.dispose();
    }
  });
});

test('SQLite a failed maintenance lease does not strand the idle drain', async () => {
  await fixture(async (_backend, options) => {
    const writer = new SqliteWorkflowBackend({
      ...options,
      withWrite: async () => {
        throw new Error('maintenance');
      },
    });
    try {
      writer.initialize();
      await assert.rejects(writer.createWorkflowProjectItem('', 'Blocked'), /maintenance/);
      await writer.waitForIdle();
      await writer.checkHealth();
      await assert.rejects(
        writer.checkHealth({ signal: AbortSignal.abort(new Error('cancelled health')) }),
        /cancelled health/,
      );
    } finally {
      await writer.dispose();
    }
  });
});

test('SQLite serving verification checks nested tree, publications, web-app policy and replay without writes', async () => {
  await fixture(async (backend, options, setPaused) => {
    await backend.createWorkflowFolderItem('Folder', '');
    await backend.createWorkflowFolderItem('Empty', 'Folder');
    let item = (await backend.moveWorkflowProject((await createExecutable(backend)).relativePath, 'Folder')).project;
    const loaded = await backend.loadHostedProject(item.absolutePath),
      [project, attached] = loadProjectAndAttachedDataFromString(loaded.contents);
    project.uiGraphs = { ui: { id: 'ui', name: 'UI', components: [] } } as typeof project.uiGraphs;
    item = (
      await backend.saveHostedProject({
        projectPath: item.absolutePath,
        contents: serializeProject(project, attached) as string,
        datasetsContents: null,
        expectedRevisionId: item.revisionId,
      })
    ).project;
    item = await backend.publishWorkflowProjectItem(item.relativePath, { endpointName: 'story' }, conditions(item));
    item = await backend.publishWorkflowProjectWebApps(
      item.relativePath,
      [{ uiGraphId: 'ui', slug: 'story-ui', allowedEmails: ['operator@example.com'] }],
      conditions(item),
    );
    const id = await backend.persistWorkflowExecutionRecording({
      sourceProject: project,
      sourceProjectPath: item.absolutePath,
      executedProject: project,
      executedAttachedData: attached,
      executedDatasets: [],
      recordingSerialized: '{"events":[]}',
      runKind: 'published',
      status: 'succeeded',
      durationMs: 1,
      endpointName: 'story',
      executionIdentity: { surface: 'workflow_endpoint' },
    });
    assert.ok(id);
    setPaused(true);
    const catalog = new LocalWorkflowCatalog(options);
    try {
      catalog.initialize({ verifyOnly: true });
      const source = (await catalog.readProject(item.relativePath))!,
        recording = (await catalog.readRecording(id))!;
      recording.executionIdentity = {
        ...recording.executionIdentity!,
        uiGraphId: undefined,
        componentId: undefined,
      };
      const verifyOptions = {
        ...options,
        folders: ['Folder', 'Folder/Empty'],
        projects: [source],
        recordings: [recording],
        assertFrozen: async () => {},
      };
      assert.deepEqual(await verifySqliteWorkflowServing(verifyOptions), {
        projects: 1,
        endpoints: 2,
        webApps: 1,
        publishedVersions: 1,
        recordings: 1,
      });
      await assert.rejects(
        verifySqliteWorkflowServing({
          ...verifyOptions,
          recordings: [
            { ...recording, executionIdentity: { ...recording.executionIdentity!, componentId: 'changed' } },
          ],
        }),
        /recording metadata/,
      );
      await assert.rejects(
        verifySqliteWorkflowServing({ ...verifyOptions, projects: [{ ...source, endpointAccess: 'internal' }] }),
        /endpoint access/,
      );
      await assert.rejects(
        verifySqliteWorkflowServing({ ...verifyOptions, projects: [{ ...source, publishedWebApps: [] }] }),
        /published web-app set/,
      );
      await assert.rejects(
        verifySqliteWorkflowServing({
          ...verifyOptions,
          projects: [{ ...source, updatedAt: '2000-01-01T00:00:00.000Z' }],
        }),
        /project metadata/,
      );
      await assert.rejects(verifySqliteWorkflowServing({ ...verifyOptions, recordings: [] }), /recording count/);
      const db = new DatabaseSync(options.databasePath);
      try {
        const row = db.prepare('SELECT metadata_json FROM recordings WHERE recording_id = ?').get(id) as {
          metadata_json: string;
        };
        const extra = await new ImmutableLocalArtifactStore(options.artifactRoot).putBytes(
          Buffer.from('unexpected replay datasets'),
        );
        db.prepare('UPDATE recordings SET metadata_json = ? WHERE recording_id = ?').run(
          JSON.stringify({ ...JSON.parse(row.metadata_json), replayDatasetContents: extra }),
          id,
        );
        try {
          await assert.rejects(verifySqliteWorkflowServing(verifyOptions), /unexpected replay datasets/);
        } finally {
          db.prepare('UPDATE recordings SET metadata_json = ? WHERE recording_id = ?').run(row.metadata_json, id);
        }
      } finally {
        db.close();
      }
      assert.deepEqual(await catalog.readProject(item.relativePath), source);
    } finally {
      catalog.close();
    }
  });
});

test('SQLite project saves preserve revisions, reject stale writes, and survive restart without legacy files', async () => {
  await fixture(async (backend, options) => {
    const created = await backend.createWorkflowProjectItem('', 'Story');
    assert.equal(created.settings.endpointName, '');
    const loaded = await backend.loadHostedProject(created.absolutePath);
    const next = await backend.saveHostedProject({
      projectPath: created.absolutePath,
      contents: executable(loaded.contents),
      datasetsContents: null,
      expectedRevisionId: loaded.revisionId,
    });
    assert.notEqual(next.revisionId, loaded.revisionId);
    await assert.rejects(
      backend.saveHostedProject({
        projectPath: created.absolutePath,
        contents: loaded.contents,
        datasetsContents: null,
        expectedRevisionId: loaded.revisionId,
      }),
      /changed since/,
    );
    const other = await backend.createWorkflowProjectItem('', 'Other'),
      otherLoaded = await backend.loadHostedProject(other.absolutePath);
    await assert.rejects(
      backend.saveHostedProject({
        projectPath: created.absolutePath,
        contents: otherLoaded.contents,
        datasetsContents: null,
      }),
      /different project/,
    );
    backend.close();
    const reopened = new SqliteWorkflowBackend({ ...options, withWrite: async (operation) => operation() });
    try {
      reopened.initialize();
      assert.equal((await reopened.loadHostedProject(created.absolutePath)).revisionId, next.revisionId);
      assert.equal((await reopened.getTree()).projects.length, 2);
    } finally {
      reopened.close();
    }
  });
});

test('SQLite folder moves are atomic and keep historical recording identities', async () => {
  await fixture(async (backend, options) => {
    await backend.createWorkflowFolderItem('A', '');
    await backend.createWorkflowFolderItem('nested', 'A');
    const item = await backend.createWorkflowProjectItem('A/nested', 'Story');
    const catalog = new LocalWorkflowCatalog(options);
    catalog.initialize({ requireExisting: true });
    try {
      await catalog.importRecording({
        recordingId: 'run-1',
        workflowId: item.projectMetadataId!,
        sourceProjectName: 'Story',
        sourceProjectRelativePath: item.relativePath,
        createdAt: new Date().toISOString(),
        runKind: 'published',
        status: 'succeeded',
        durationMs: 1,
        endpointName: 'story',
        errorMessage: null,
        recordingContents: '{}',
        replayProjectContents: '{}',
        replayDatasetContents: null,
      });
      const moved = await backend.renameWorkflowFolderItem('A', 'B');
      assert.equal(moved.movedProjectPaths.length, 1);
      assert.equal(catalog.findProjectPathById(item.projectMetadataId!), 'B/nested/Story.rivet-project');
      assert.equal((await catalog.readRecording('run-1'))!.sourceProjectRelativePath, item.relativePath);
      await assert.rejects(backend.moveWorkflowFolder('B', 'B/nested'), /into itself/);
      await backend.createWorkflowFolderItem('C', '');
      await assert.rejects(backend.renameWorkflowFolderItem('B', 'C'), /already exists/);
      assert.equal(
        (await backend.getTree()).folders.find((folder) => folder.name === 'B')!.folders[0]!.projects.length,
        1,
      );
      await assert.rejects(backend.deleteWorkflowFolderItem('B'), {
        status: 409,
        message: 'Only empty folders can be deleted',
      });
      await assert.rejects(backend.deleteWorkflowFolderItem('B/nested'), /Only empty folders/);
      assert.equal(catalog.findProjectPathById(item.projectMetadataId!), 'B/nested/Story.rivet-project');
      assert.ok(await catalog.readRecording('run-1'));
      await backend.deleteWorkflowProjectItem('B/nested/Story.rivet-project');
      assert.equal(catalog.findProjectPathById(item.projectMetadataId!), null);
      assert.equal(await catalog.readRecording('run-1'), null);
      await assert.rejects(backend.deleteWorkflowFolderItem('B'), /Only empty folders/);
      await backend.deleteWorkflowFolderItem('B/nested');
      await backend.deleteWorkflowFolderItem('B');
      assert.deepEqual(
        (await backend.getTree()).folders.map((folder) => folder.name),
        ['C'],
      );
    } finally {
      catalog.close();
    }
  });
});

test('SQLite retention refuses an unreadable hold authority and preserves held diagnostic recordings', async () => {
  await fixture(async (backend, options) =>
    withEnvOverride('RIVET_APP_DATA_ROOT', path.join(options.artifactRoot, 'test-settings'), async () => {
      const item = await createExecutable(backend);
      const catalog = new LocalWorkflowCatalog(options);
      let fail = true;
      let holdBarrier: Promise<void> | null = null;
      const cleaner = new SqliteWorkflowBackend({
        ...options,
        withWrite: async (operation) => operation(),
        getRecordingRetentionHolds: async () => {
          if (fail) throw new Error('hold authority unavailable');
          await holdBarrier;
          return new Set(['held']);
        },
      });
      try {
        catalog.initialize({ requireExisting: true });
        cleaner.initialize();
        for (const recordingId of ['held', 'unheld']) {
          await catalog.importRecording({
            recordingId,
            workflowId: item.projectMetadataId!,
            sourceProjectName: item.name,
            sourceProjectRelativePath: item.relativePath,
            createdAt: '2000-01-01T00:00:00.000Z',
            runKind: 'published',
            status: 'succeeded',
            durationMs: 1,
            endpointName: 'story',
            errorMessage: null,
            recordingContents: '{}',
            replayProjectContents: '{}',
            replayDatasetContents: null,
          });
        }
        await assert.rejects(
          cleaner.cleanupRecordings({ now: Date.parse('2100-01-01T00:00:00Z') }),
          /hold authority unavailable/,
        );
        assert.deepEqual(catalog.listRecordingIds(), ['held', 'unheld']);
        fail = false;
        let releaseHold!: () => void;
        holdBarrier = new Promise<void>((resolve) => {
          releaseHold = resolve;
        });
        const policy = { now: Date.parse('2000-01-01T00:00:00Z'), batchSize: 100 };
        const pending = cleaner.cleanupRecordings(policy);
        policy.now = Date.parse('2100-01-01T00:00:00Z');
        policy.batchSize = 0;
        releaseHold();
        assert.equal(await pending, 0, 'Caller mutation must not alter the accepted cleanup policy');
        assert.deepEqual(catalog.listRecordingIds(), ['held', 'unheld']);
        holdBarrier = null;
        assert.equal(await cleaner.cleanupRecordings({ now: Date.parse('2100-01-01T00:00:00Z') }), 1);
        assert.deepEqual(catalog.listRecordingIds(), ['held']);
      } finally {
        cleaner.close();
        catalog.close();
      }
    }),
  );
});

test('SQLite endpoint retention preserves separate endpoint histories and folds endpoint case', async () => {
  await fixture(async (backend, options) => {
    const item = await createExecutable(backend);
    const catalog = new LocalWorkflowCatalog(options);
    catalog.initialize({ requireExisting: true });
    try {
      for (const [recordingId, endpointName, createdAt] of [
        ['a-old', ' First ', '2025-01-01T00:00:00.000Z'],
        ['a-new', 'first', '2025-01-02T00:00:00.000Z'],
        ['b', 'second', '2025-01-01T00:00:00.000Z'],
      ]) {
        await catalog.importRecording({
          recordingId: recordingId!,
          endpointName: endpointName!,
          createdAt: createdAt!,
          workflowId: item.projectMetadataId!,
          sourceProjectName: item.name,
          sourceProjectRelativePath: item.relativePath,
          runKind: 'published',
          status: 'succeeded',
          durationMs: 1,
          errorMessage: null,
          recordingContents: '{}',
          replayProjectContents: '{}',
          replayDatasetContents: null,
        });
      }
      const deleted = catalog.pruneRecordings({
        now: Date.now(),
        retentionDays: 0,
        maxRunsPerEndpoint: 1,
        maxTotalBytes: 0,
        batchSize: 100,
      });
      assert.deepEqual(
        deleted.map((row) => row.recordingId),
        ['a-old'],
      );
      assert.deepEqual(catalog.listRecordingIds(), ['a-new', 'b']);
    } finally {
      catalog.close();
    }
  });
});

test('SQLite in-place save follows stable project identity after moving to a different folder', async () => {
  await fixture(async (backend) => {
    const created = await backend.createWorkflowProjectItem('', 'Story'),
      loaded = await backend.loadHostedProject(created.absolutePath);
    await backend.createWorkflowFolderItem('Moved', '');
    await backend.moveWorkflowProject(created.relativePath, 'Moved');
    const saved = await backend.saveHostedProject({
      projectPath: created.absolutePath,
      projectId: created.projectMetadataId,
      contents: loaded.contents,
      datasetsContents: null,
      expectedRevisionId: loaded.revisionId,
      saveIntent: 'in-place',
    });
    assert.equal(saved.project.relativePath, 'Moved/Story.rivet-project');
    assert.equal(saved.created, false);
    assert.equal((await backend.getTree()).projects.length, 0);
  });
});

test('SQLite same-path moves and renames are no-ops, including modification time and revision', async () => {
  await fixture(async (backend) => {
    const item = await createExecutable(backend);
    for (const result of [
      await backend.moveWorkflowProject(item.relativePath, ''),
      await backend.renameWorkflowProjectItem(item.relativePath, item.name),
    ]) {
      assert.deepEqual(result.project, item);
      assert.deepEqual(result.movedProjectPaths, []);
    }
  });
});

test('SQLite publication history, restoration, access and latest execution use SQL authority', async () => {
  await fixture(async (backend) => {
    const created = await createExecutable(backend);
    const published = await backend.publishWorkflowProjectItem(
      created.relativePath,
      { endpointName: 'story' },
      conditions(created),
    );
    const first = (await backend.listWorkflowPublishedVersions(created.relativePath)).versions[0]!;
    assert.equal(
      (await backend.loadPublishedExecutionProject('STORY'))!.project.metadata.id,
      created.projectMetadataId,
    );
    const loaded = await backend.loadHostedProject(created.absolutePath);
    const [project, attached] = loadProjectAndAttachedDataFromString(loaded.contents);
    project.metadata.description = 'New draft';
    const saved = (
      await backend.saveHostedProject({
        projectPath: created.absolutePath,
        contents: serializeProject(project, attached) as string,
        datasetsContents: null,
        expectedRevisionId: loaded.revisionId,
      })
    ).project;
    assert.equal(saved.settings.status, 'unpublished_changes');
    assert.equal((await backend.loadLatestExecutionProject('story'))!.project.metadata.description, 'New draft');
    assert.notEqual((await backend.loadPublishedExecutionProject('story'))!.project.metadata.description, 'New draft');
    await assert.rejects(
      backend.unpublishWorkflowProjectItem(created.relativePath, conditions(created)),
      /settings changed/,
    );
    const internal = await backend.updateWorkflowEndpointAccess(created.relativePath, 'internal', conditions(saved));
    assert.equal((await backend.loadPublishedExecutionProject('story'))!.endpointAccess, 'internal');
    await backend.setWorkflowPublishedVersionStar(created.relativePath, first.id, true);
    await backend.setWorkflowPublishedVersionComment(created.relativePath, first.id, 'Keep this');
    const restored = await backend.restoreWorkflowPublishedVersion(
      created.relativePath,
      first.id,
      conditions(internal),
    );
    assert.notEqual(restored.version.id, first.id);
    assert.equal(restored.project.settings.status, 'published');
    assert.equal((await backend.listWorkflowPublishedVersions(created.relativePath)).versions.length, 2);
    assert.equal(
      (await backend.listWorkflowPublishedVersions(created.relativePath)).versions.find(
        (version) => version.id === first.id,
      )!.comment,
      'Keep this',
    );
    assert.equal(
      (await backend.loadHostedProject(created.absolutePath)).contents,
      (await backend.readWorkflowPublishedVersionPreview(created.relativePath, first.id)).contents,
    );
    const unpublished = await backend.unpublishWorkflowProjectItem(created.relativePath, conditions(restored.project));
    assert.equal(unpublished.settings.status, 'unpublished');
    assert.equal(await backend.loadPublishedExecutionProject('story'), null);
    assert.equal((await backend.listWorkflowPublishedVersions(created.relativePath)).versions.length, 2);
    assert.equal(published.projectMetadataId, restored.project.projectMetadataId);
  });
});

test('SQLite publication annotations update only metadata and preserve revisions and sibling annotations', async (t) => {
  await fixture(async (backend, _options, setPaused) => {
    const item = await createExecutable(backend);
    const published = await backend.publishWorkflowProjectItem(
      item.relativePath,
      { endpointName: 'story' },
      conditions(item),
    );
    const first = (await backend.listWorkflowPublishedVersions(item.relativePath)).versions[0]!;
    t.mock.method(ImmutableLocalArtifactStore.prototype, 'read', async () => {
      throw new Error('Annotations must not read immutable artifacts');
    });
    await backend.setWorkflowPublishedVersionComment(item.relativePath, first.id, ' Keep this ');
    await backend.setWorkflowPublishedVersionStar(item.relativePath, first.id, true);
    await backend.setWorkflowPublishedVersionStar(item.relativePath, first.id, true);
    const annotated = (await backend.listWorkflowPublishedVersions(item.relativePath)).versions[0]!;
    assert.equal(annotated.comment, 'Keep this');
    assert.equal(annotated.isStarred, true);
    assert.equal((await backend.getTree()).projects[0]?.revisionId, published.revisionId);
    assert.equal(
      (await backend.getTree()).projects[0]?.settings.publicationVersion,
      published.settings.publicationVersion,
    );
    await assert.rejects(backend.setWorkflowPublishedVersionStar(item.relativePath, 'missing', true), /not found/);
    setPaused(true);
    await assert.rejects(
      backend.setWorkflowPublishedVersionComment(item.relativePath, first.id, 'Denied'),
      /maintenance/,
    );
    assert.equal((await backend.listWorkflowPublishedVersions(item.relativePath)).versions[0]?.comment, 'Keep this');
  });
});

test('SQLite duplication reads only the requested project version, not its publication history', async (t) => {
  await fixture(async (backend) => {
    let item = await createExecutable(backend);
    for (let index = 0; index < 3; index++) {
      const loaded = await backend.loadHostedProject(item.absolutePath);
      const [project, attached] = loadProjectAndAttachedDataFromString(loaded.contents);
      project.metadata.description = `Version ${index}`;
      item = (
        await backend.saveHostedProject({
          projectPath: item.absolutePath,
          contents: serializeProject(project, attached) as string,
          datasetsContents: null,
          expectedRevisionId: loaded.revisionId,
        })
      ).project;
      item = await backend.publishWorkflowProjectItem(item.relativePath, { endpointName: 'story' }, conditions(item));
    }
    const read = ImmutableLocalArtifactStore.prototype.read;
    let reads = 0;
    t.mock.method(
      ImmutableLocalArtifactStore.prototype,
      'read',
      function (this: ImmutableLocalArtifactStore, ...args: Parameters<typeof read>) {
        reads++;
        return read.apply(this, args);
      },
    );
    for (const version of ['live', 'published'] as const) {
      const before = reads;
      const duplicate = await backend.duplicateWorkflowProjectItem(item.relativePath, version);
      assert.equal(reads - before, 1, 'Only selected project content is read; this fixture has no dataset');
      const loaded = await backend.loadHostedProject(duplicate.absolutePath);
      const [project] = loadProjectAndAttachedDataFromString(loaded.contents);
      assert.equal(project.metadata.description, 'Version 2');
      assert.notEqual(project.metadata.id, item.projectMetadataId);
    }
  });
});

test('SQLite web-app settings read the draft definition without datasets or history', async (t) => {
  await fixture(async (backend) => {
    let item = await createExecutable(backend);
    const loaded = await backend.loadHostedProject(item.absolutePath);
    item = (
      await backend.saveHostedProject({
        projectPath: item.absolutePath,
        contents: loaded.contents,
        datasetsContents: serializeDatasets([]),
        expectedRevisionId: loaded.revisionId,
      })
    ).project;
    const read = ImmutableLocalArtifactStore.prototype.read;
    let reads = 0;
    t.mock.method(
      ImmutableLocalArtifactStore.prototype,
      'read',
      function (this: ImmutableLocalArtifactStore, ...args: Parameters<typeof read>) {
        if (++reads > 1) throw new Error('Settings must read only the project definition');
        return read.apply(this, args);
      },
    );
    const settings = await backend.listWorkflowProjectWebApps(item.relativePath);
    assert.equal(reads, 1);
    assert.equal(settings.draftRevisionId, item.revisionId, 'Dataset-inclusive saved revision remains authoritative');
    assert.equal(settings.project.revisionId, item.revisionId);
    assert.equal(settings.hasMainGraph, true);
  });
});

test('SQLite case-insensitive route collisions roll back the complete publication', async () => {
  await fixture(async (backend) => {
    const first = await createExecutable(backend, 'First'),
      second = await createExecutable(backend, 'Second');
    await backend.publishWorkflowProjectItem(first.relativePath, { endpointName: 'Story' }, conditions(first));
    await assert.rejects(
      backend.publishWorkflowProjectItem(second.relativePath, { endpointName: 'story' }, conditions(second)),
      /destination already exists/,
    );
    assert.deepEqual((await backend.listWorkflowPublishedVersions(second.relativePath)).versions, []);
    assert.equal(
      (await backend.getTree()).projects.find((item) => item.name === 'Second')!.settings.publicationVersion,
      '0',
    );
  });
});

test('SQLite reuses an unpublished preference without losing history or confusing serving verification', async () => {
  await fixture(async (backend, options, setPaused) => {
    let archived = await createExecutable(backend, 'Archived');
    archived = await backend.publishWorkflowProjectItem(
      archived.relativePath,
      { endpointName: 'game-engine-test' },
      conditions(archived),
    );
    const history = (await backend.listWorkflowPublishedVersions(archived.relativePath)).versions;
    archived = await backend.unpublishWorkflowProjectItem(archived.relativePath, conditions(archived));
    assert.equal(archived.settings.endpointName, 'game-engine-test');
    assert.equal(await backend.loadLatestExecutionProject('game-engine-test'), null);
    assert.equal(await backend.loadPublishedExecutionProject('game-engine-test'), null);
    let live = await createExecutable(backend, 'Live');
    live = await backend.publishWorkflowProjectItem(
      live.relativePath,
      { endpointName: 'game-engine-test' },
      conditions(live),
    );
    for (const read of ['loadLatestExecutionProject', 'loadPublishedExecutionProject'] as const) {
      assert.equal((await backend[read]('GAME-ENGINE-TEST'))?.project.metadata.id, live.projectMetadataId);
    }
    await assert.rejects(
      backend.publishWorkflowProjectItem(
        archived.relativePath,
        { endpointName: 'GAME-ENGINE-TEST' },
        conditions(archived),
      ),
      /destination already exists/,
    );
    assert.deepEqual(
      (await backend.listWorkflowPublishedVersions(archived.relativePath)).versions,
      history.map((v) => ({ ...v, isCurrent: false })),
    );
    setPaused(true);
    const catalog = new LocalWorkflowCatalog(options);
    try {
      catalog.initialize({ verifyOnly: true });
      const snapshots = await Promise.all([archived, live].map((item) => catalog.readProject(item.relativePath)));
      assert.deepEqual(
        await verifySqliteWorkflowServing({
          ...options,
          folders: [],
          projects: snapshots.map((p) => p!),
          recordings: [],
          assertFrozen: async () => {},
        }),
        { projects: 2, endpoints: 2, publishedVersions: 2, webApps: 0, recordings: 0 },
      );
    } finally {
      catalog.close();
    }
  });
});

test('SQLite web-app publication preserves binding identity and enforces access changes', async () => {
  await fixture(async (backend) => {
    const created = await createExecutable(backend),
      loaded = await backend.loadHostedProject(created.absolutePath);
    const [project, attached] = loadProjectAndAttachedDataFromString(loaded.contents);
    project.uiGraphs = { 'ui-1': { id: 'ui-1', name: 'App', components: [] } } as typeof project.uiGraphs;
    const saved = (
      await backend.saveHostedProject({
        projectPath: created.absolutePath,
        contents: serializeProject(project, attached) as string,
        datasetsContents: null,
        expectedRevisionId: loaded.revisionId,
      })
    ).project;
    assert.equal((await backend.listWorkflowProjectWebApps(saved.relativePath)).webApps[0]!.name, 'App');
    const published = await backend.publishWorkflowProjectWebApps(
      saved.relativePath,
      [{ uiGraphId: 'ui-1', slug: 'story-app', allowedEmails: ['a@example.com'] }],
      conditions(saved),
    );
    const initial = await backend.loadPublishedWebAppExecutionProject('story-app');
    assert.ok(initial);
    const changed = await backend.updateWorkflowProjectWebAppAccess(
      saved.relativePath,
      [{ uiGraphId: 'ui-1', allowedEmails: ['b@example.com'] }],
      conditions(published),
    );
    assert.deepEqual((await backend.resolveWebAppAccessPolicy('story-app'))!.allowedEmails, ['b@example.com']);
    const republished = await backend.publishWorkflowProjectWebApps(
      saved.relativePath,
      [{ uiGraphId: 'ui-1', slug: 'story-app' }],
      conditions(changed),
    );
    assert.equal(
      (await backend.loadPublishedWebAppExecutionProject('story-app'))!.webAppBindingId,
      initial.webAppBindingId,
    );
    const unpublished = await backend.unpublishWorkflowProjectWebApp(
      saved.relativePath,
      'ui-1',
      conditions(republished),
    );
    assert.equal(await backend.resolveWebAppAccessPolicy('story-app'), null);
    await backend.publishWorkflowProjectWebApps(
      saved.relativePath,
      [{ uiGraphId: 'ui-1', slug: 'story-app' }],
      conditions(unpublished),
    );
    assert.notEqual(
      (await backend.loadPublishedWebAppExecutionProject('story-app'))!.webAppBindingId,
      initial.webAppBindingId,
    );
  });
});

test('SQLite concurrent saves cannot both publish a replacement of the same revision', async () => {
  await fixture(async (backend) => {
    const created = await createExecutable(backend),
      loaded = await backend.loadHostedProject(created.absolutePath);
    const changed = (description: string) => {
      const [project, attached] = loadProjectAndAttachedDataFromString(loaded.contents);
      project.metadata.description = description;
      return serializeProject(project, attached) as string;
    };
    const results = await Promise.allSettled(
      ['a', 'b'].map((value) =>
        backend.saveHostedProject({
          projectPath: created.absolutePath,
          contents: changed(value),
          datasetsContents: null,
          expectedRevisionId: loaded.revisionId,
        }),
      ),
    );
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
  });
});

test('SQLite writes obey maintenance and read-only validation without touching the source', async () => {
  await fixture(async (backend, options, setPaused) => {
    const item = await createExecutable(backend);
    setPaused(true);
    await assert.rejects(backend.deleteWorkflowProjectItem(item.relativePath), /maintenance/);
    const reader = new SqliteWorkflowBackend({ ...options, withWrite: async (operation) => operation() });
    try {
      reader.initialize({ readOnly: true });
      assert.equal((await reader.getTree()).projects.length, 1);
      await assert.rejects(reader.createWorkflowProjectItem('', 'blocked'), /verification only/);
    } finally {
      reader.close();
    }
    assert.equal((await backend.getTree()).projects.length, 1);
  });
});

test('SQLite rename preserves published bytes and revisions until a real hosted save', async () => {
  await fixture(async (backend) => {
    const item = await createExecutable(backend),
      loaded = await backend.loadHostedProject(item.absolutePath);
    await backend.publishWorkflowProjectItem(item.relativePath, { endpointName: 'story' }, conditions(item));
    const renamed = await backend.renameWorkflowProjectItem(item.relativePath, 'Renamed');
    const reloaded = await backend.loadHostedProject(renamed.project.absolutePath);
    assert.equal(reloaded.contents, loaded.contents);
    assert.equal(reloaded.revisionId, loaded.revisionId);
    assert.equal(renamed.project.settings.publicationStatus, 'published');
    assert.equal(renamed.project.updatedAt, item.updatedAt);
    const saved = await backend.saveHostedProject({
      projectPath: item.absolutePath,
      contents: loaded.contents,
      datasetsContents: null,
      expectedRevisionId: loaded.revisionId,
      saveIntent: 'in-place',
    });
    assert.equal(saved.project.name, 'Renamed');
    assert.equal(
      loadProjectAndAttachedDataFromString((await backend.loadHostedProject(saved.path)).contents)[0].metadata.title,
      'Renamed',
    );
    assert.notEqual(saved.revisionId, loaded.revisionId);
    await assert.rejects(
      backend.saveHostedProject({
        projectPath: item.absolutePath,
        contents: loaded.contents,
        datasetsContents: null,
        expectedRevisionId: loaded.revisionId,
        saveIntent: 'in-place',
      }),
      /changed since/,
    );
  });
});

test('SQLite cross-project loads choose the requested version by stable identity, not a stale hint', async (t) => {
  await fixture(async (backend) => {
    const item = await createExecutable(backend);
    await backend.publishWorkflowProjectItem(item.relativePath, { endpointName: 'story' }, conditions(item));
    const loaded = await backend.loadHostedProject(item.absolutePath),
      [project, attached] = loadProjectAndAttachedDataFromString(loaded.contents);
    project.metadata.description = 'latest';
    await backend.saveHostedProject({
      projectPath: item.absolutePath,
      contents: serializeProject(project, attached) as string,
      datasetsContents: null,
      expectedRevisionId: loaded.revisionId,
    });
    const published = await backend.loadSubgraphTarget({
      projectId: item.projectMetadataId!,
      version: 'published',
    } as Parameters<typeof backend.loadSubgraphTarget>[0]);
    const latest = await backend.loadSubgraphTarget({
      projectId: item.projectMetadataId!,
      version: 'latest',
    } as Parameters<typeof backend.loadSubgraphTarget>[0]);
    assert.notEqual(published.project.metadata.description, 'latest');
    assert.equal(latest.project.metadata.description, 'latest');
    const reference = await backend
      .createProjectReferenceLoader()
      .loadProject(undefined, { id: item.projectMetadataId!, hintPaths: ['../../wrong.rivet-project'] });
    assert.equal(reference.metadata.id, item.projectMetadataId);
    assert.notEqual(reference.metadata.description, 'latest');

    const snapshot = async (): Promise<BundleSnapshot> =>
      ({
        ...(await backend.loadSubgraphTarget({
          projectId: item.projectMetadataId! as typeof project.metadata.id,
          version: 'published',
        })),
        selectedVersion: 'published',
      }) as BundleSnapshot;
    const files = new Map<string, string>();
    const bundle = await collectProjectBundle({
      source: { root: snapshot, target: snapshot, reference: snapshot },
      rootVersion: 'published',
      signal: new AbortController().signal,
      writeFile: async (name, content) => {
        files.set(name, content);
      },
      progress() {},
    });
    assert.equal(files.get(bundle.manifest.artifacts[0]!.project.path), published.projectContents);
    assert.notEqual(files.get(bundle.manifest.artifacts[0]!.project.path), latest.projectContents);
    await bundle.verify();

    const target = { projectId: item.projectMetadataId!, version: 'published' } as Parameters<
      typeof backend.loadSubgraphTarget
    >[0];
    const originalRead = ImmutableLocalArtifactStore.prototype.read;
    const subgraphRead = t.mock.method(
      ImmutableLocalArtifactStore.prototype,
      'read',
      function (this: ImmutableLocalArtifactStore, hash: string) {
        target.version = 'latest';
        return originalRead.call(this, hash);
      },
    );
    try {
      const captured = await backend.loadSubgraphTarget(target);
      assert.notEqual(captured.project.metadata.description, 'latest');
    } finally {
      subgraphRead.mock.restore();
    }

    const requestedReference = { id: item.projectMetadataId! };
    const referenceRead = t.mock.method(
      ImmutableLocalArtifactStore.prototype,
      'read',
      function (this: ImmutableLocalArtifactStore, hash: string) {
        requestedReference.id = 'caller-mutated';
        return originalRead.call(this, hash);
      },
    );
    try {
      const captured = await backend.createProjectReferenceLoader().loadProject(undefined, requestedReference);
      assert.equal(captured.metadata.id, item.projectMetadataId);
    } finally {
      referenceRead.mock.restore();
    }
  });
});

test('SQLite caller browse scope includes cross-project descendants with accurate paging and input search', async () => {
  await fixture(async (backend) => {
    const caller = await createExecutable(backend, 'Caller');
    const child = await createExecutable(backend, 'Child');
    const nested = await createExecutable(backend, 'Nested');
    const persist = async (
      item: WorkflowProjectItem,
      surface: 'workflow_endpoint' | 'subgraph_project',
      correlationId: string,
      status: 'succeeded' | 'failed' | 'suspicious',
    ) => {
      const [project, attached] = loadProjectAndAttachedDataFromString(
        (await backend.loadHostedProject(item.absolutePath)).contents,
      );
      return (await backend.persistWorkflowExecutionRecording({
        sourceProject: project,
        sourceProjectPath: item.absolutePath,
        executedProject: project,
        executedAttachedData: attached,
        executedDatasets: [],
        endpointName: surface === 'subgraph_project' ? 'Subgraph: Main' : 'caller',
        runKind: 'published',
        status,
        durationMs: 1,
        executionIdentity: { surface, correlationId, graphId: 'main' },
        recordingSerialized: JSON.stringify({
          strings: {},
          recording: {
            events: [{ type: 'start', data: { inputs: { input: { type: 'any', value: { matched: true } } } } }],
          },
        }),
      }))!;
    };
    const rootId = await persist(caller, 'workflow_endpoint', 'rvt-caller-scope-12345', 'succeeded');
    const childId = await persist(child, 'subgraph_project', 'rvt-caller-scope-12345', 'failed');
    const nestedId = await persist(nested, 'subgraph_project', 'rvt-caller-scope-12345', 'suspicious');
    await persist(nested, 'subgraph_project', 'rvt-unrelated-scope-12345', 'failed');
    const workflowId = caller.projectMetadataId!;
    const related = await backend.listWorkflowRecordingRunsPage(
      workflowId,
      1,
      1,
      'all',
      null,
      0,
      undefined,
      undefined,
      true,
    );
    assert.equal(related.totalRuns, 3);
    assert.deepEqual({ ...related.scopeCounts }, { totalRuns: 3, failedRuns: 1, suspiciousRuns: 1 });
    const allIds = new Set(related.runs.map((run) => run.id));
    for (const page of [2, 3]) {
      const response = await backend.listWorkflowRecordingRunsPage(
        workflowId,
        page,
        1,
        'all',
        null,
        0,
        undefined,
        undefined,
        true,
      );
      response.runs.forEach((run) => allIds.add(run.id));
    }
    assert.deepEqual(allIds, new Set([rootId, childId, nestedId]));
    const bad = await backend.listWorkflowRecordingRunsPage(
      workflowId,
      1,
      20,
      'failed',
      null,
      0,
      undefined,
      undefined,
      true,
    );
    assert.equal(bad.totalRuns, 2);
    assert.deepEqual(new Set(bad.runs.map((run) => run.id)), new Set([childId, nestedId]));
    assert.equal(bad.runs.find((run) => run.id === childId)?.sourceProjectRelativePath, child.relativePath);
    assert.equal((await backend.listWorkflowRecordingRunsPage(workflowId, 1, 20)).totalRuns, 1);
    const filter = { path: '$.matched', operator: '==' as const, value: 'true' };
    let batch = await backend.listWorkflowRecordingRunsPage(
      workflowId,
      1,
      1,
      'all',
      filter,
      0,
      undefined,
      undefined,
      true,
    );
    const matches = new Set(batch.runs.map((run) => run.id));
    while (batch.hasMore) {
      batch = await backend.listWorkflowRecordingRunsPage(
        workflowId,
        1,
        1,
        'all',
        filter,
        0,
        undefined,
        batch.nextInputAfter,
        true,
      );
      batch.runs.forEach((run) => matches.add(run.id));
    }
    assert.deepEqual(matches, new Set([rootId]));
    assert.equal(batch.scopeCounts?.totalRuns, 1);
    const children = await backend.listWorkflowRecordingRunsPage(
      rootId,
      1,
      1,
      'all',
      null,
      0,
      undefined,
      undefined,
      false,
      'children',
    );
    assert.equal(children.totalRuns, 2);
    const nextChildren = await backend.listWorkflowRecordingRunsPage(
      rootId,
      2,
      1,
      'all',
      null,
      0,
      undefined,
      undefined,
      false,
      'children',
    );
    assert.deepEqual(
      new Set([...children.runs, ...nextChildren.runs].map((run) => run.id)),
      new Set([childId, nestedId]),
    );
    assert.equal((await backend.listWorkflowRecordingRunsPage('', 1, 20, 'all', filter)).scopeCounts?.totalRuns, 1);
    await backend.deleteWorkflowRecording(childId);
    assert.equal(
      (await backend.listWorkflowRecordingRunsPage(workflowId, 1, 20, 'all', null, 0, undefined, undefined, true))
        .totalRuns,
      2,
    );
    assert.equal((await backend.listWorkflowRecordingRunsPage('', 1, 20)).totalRuns, 3);
  });
});

test('SQLite recording writes use configured compression and gzip level', async () => {
  await fixture(async (backend, options) => {
    const item = await createExecutable(backend);
    const [project, attached] = loadProjectAndAttachedDataFromString(
      (await backend.loadHostedProject(item.absolutePath)).contents,
    );
    const recordingSerialized = JSON.stringify({ input: 'text'.repeat(10000) });
    await withEnvOverride('RIVET_RECORDINGS_ENABLED', 'true', async () => {
      for (const [compression, level] of [
        ['identity', 9],
        ['gzip', 0],
        ['gzip', 1],
        ['gzip', 9],
      ] as const) {
        await withEnvOverride('RIVET_RECORDINGS_COMPRESS', compression, () =>
          withEnvOverride('RIVET_RECORDINGS_GZIP_LEVEL', String(level), async () => {
            const id = await backend.persistWorkflowExecutionRecording({
              sourceProject: project,
              sourceProjectPath: item.absolutePath,
              executedProject: project,
              executedAttachedData: attached,
              executedDatasets: [],
              recordingSerialized,
              runKind: 'editor',
              status: 'succeeded',
              durationMs: 1,
              endpointName: 'story',
            });
            assert.ok(id);
            const catalog = new LocalWorkflowCatalog(options);
            try {
              catalog.initialize({ verifyOnly: true });
              const row = catalog.listRecordingMetadata({ recordingId: id })[0]!;
              const bytes = Buffer.from(recordingSerialized);
              const compressed = gzipSync(bytes, { level });
              const expected = compression === 'gzip' && compressed.length < bytes.length ? compressed : bytes;
              const store = new ImmutableLocalArtifactStore(options.artifactRoot);
              assert.deepEqual(await store.read(row.recordingHash, row.recordingBytes), expected);
              assert.equal(await backend.readWorkflowRecordingArtifact(id, 'recording'), recordingSerialized);
            } finally {
              catalog.close();
            }
          }),
        );
      }
    });
  });
});

test('SQLite recordings persist before callbacks, support bounded input search, replay, statistics and deletion', async () => {
  await fixture(async (backend) => {
    const item = await createExecutable(backend),
      loaded = await backend.loadHostedProject(item.absolutePath),
      [project, attached] = loadProjectAndAttachedDataFromString(loaded.contents);
    const ids: string[] = [];
    for (const [index, status] of (['succeeded', 'failed', 'suspicious'] as const).entries()) {
      const recordingSerialized = JSON.stringify({
        version: 1,
        padding: 'x'.repeat(10000),
        strings: {},
        recording: {
          events: [{ type: 'start', data: { inputs: { input: { type: 'any', value: { value: index } } } } }],
        },
      });
      const id = await backend.persistWorkflowExecutionRecording({
        sourceProject: project,
        sourceProjectPath: item.absolutePath,
        executedProject: project,
        executedAttachedData: attached,
        executedDatasets: [],
        endpointName: 'story',
        recordingSerialized,
        runKind: 'published',
        status,
        durationMs: index + 1,
        executionIdentity: { surface: 'workflow_endpoint' },
        onPersisted: async (id) => {
          assert.equal(await backend.readWorkflowRecordingArtifact(id, 'recording'), recordingSerialized);
          const summary = (await backend.listWorkflowRecordingRunsPage(item.projectMetadataId!, 1, 100)).runs.find(
            (run) => run.id === id,
          )!;
          assert.equal(summary.recordingUncompressedBytes, Buffer.byteLength(recordingSerialized));
          assert.ok(summary.recordingCompressedBytes < summary.recordingUncompressedBytes / 2);
        },
      });
      assert.ok(id);
      ids.push(id);
    }
    const page = await backend.listWorkflowRecordingRunsPage(item.projectMetadataId!, 1, 1, 'failed');
    assert.equal(page.totalRuns, 2);
    assert.equal(page.runs.length, 1);
    assert.equal(page.hasMore, true);
    const filtered = await backend.listWorkflowRecordingRunsPage(item.projectMetadataId!, 1, 20, 'all', {
      path: '$.value',
      operator: '==',
      value: '2',
    });
    assert.equal(filtered.runs.length, 1);
    assert.equal(filtered.runs[0]!.id, ids[2]);
    const other = await createExecutable(backend, 'Other recording owner');
    const [otherProject, otherAttached] = loadProjectAndAttachedDataFromString(
      (await backend.loadHostedProject(other.absolutePath)).contents,
    );
    const otherId = await backend.persistWorkflowExecutionRecording({
      sourceProject: otherProject,
      sourceProjectPath: other.absolutePath,
      executedProject: otherProject,
      executedAttachedData: otherAttached,
      executedDatasets: [],
      endpointName: 'other',
      runKind: 'editor',
      status: 'failed',
      durationMs: 1,
      recordingSerialized: JSON.stringify({
        version: 1,
        strings: {},
        recording: {
          events: [{ type: 'start', data: { inputs: { input: { type: 'any', value: { value: 2 } } } } }],
        },
      }),
    });
    assert.ok(otherId);
    const any = await backend.listWorkflowRecordingRunsPage('', 1, 20, 'all');
    assert.equal(any.totalRuns, 4);
    assert.deepEqual(
      new Set(any.runs.map((run) => run.workflowId)),
      new Set([item.projectMetadataId, other.projectMetadataId]),
    );
    const anyBad = await backend.listWorkflowRecordingRunsPage('', 1, 1, 'failed');
    assert.equal(anyBad.totalRuns, 3);
    assert.equal(anyBad.runs.length, 1);
    assert.equal(anyBad.hasMore, true);
    const anyMatches = await backend.listWorkflowRecordingRunsPage('', 1, 20, 'all', {
      path: '$.value',
      operator: '==',
      value: '2',
    });
    const foundIds = new Set(anyMatches.runs.map((run) => run.id));
    let batch = anyMatches;
    while (batch.hasMore) {
      batch = await backend.listWorkflowRecordingRunsPage(
        '',
        1,
        20,
        'all',
        {
          path: '$.value',
          operator: '==',
          value: '2',
        },
        batch.nextInputCursor,
        undefined,
        batch.nextInputAfter,
      );
      batch.runs.forEach((run) => foundIds.add(run.id));
    }
    assert.deepEqual(foundIds, new Set([ids[2], otherId]));
    const replay = loadProjectAndAttachedDataFromString(
      await backend.readWorkflowRecordingArtifact(ids[0]!, 'replay-project'),
    )[0];
    assert.notEqual(replay.metadata.id, item.projectMetadataId);
    const statistics = await backend.getWorkflowRunStatistics({
      target: { surface: 'endpoint', workflowId: item.projectMetadataId! },
      period: { from: '2000-01-01T00:00:00.000Z', to: '2100-01-01T00:00:00.000Z' },
      runKind: 'both',
      includeFailed: true,
      includeWarnings: true,
    });
    assert.equal(statistics.current.runCount, 3);
    assert.equal(
      (await backend.listWorkflowRecordingWorkflows()).workflows.find(
        (workflow) => workflow.workflowId === item.projectMetadataId,
      )!.totalRuns,
      3,
    );
    await backend.deleteWorkflowRecording(ids[0]!);
    assert.equal((await backend.listWorkflowRecordingRunsPage(item.projectMetadataId!, 1, 20)).totalRuns, 2);
    await assert.rejects(backend.readWorkflowRecordingArtifact(ids[0]!, 'recording'), /not found/);
  });
});
