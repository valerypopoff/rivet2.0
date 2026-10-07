import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { loadProjectAndAttachedDataFromString, serializeProject } from '@valerypopoff/rivet2-node';
import { SqliteWorkflowBackend } from '../local-metadata/sqlite-workflow-backend.js';
import { LocalWorkflowCatalog } from '../local-metadata/workflow-catalog.js';
import { ImmutableLocalArtifactStore } from '../local-metadata/immutable-artifact-store.js';
import { verifySqliteWorkflowServing } from '../local-metadata/verify-serving-candidate.js';
import type { WorkflowProjectItem } from '../../../studio-server-shared/workflow-types.js';
import { withEnvOverride } from './helpers/workflow-api-harness.js';
import { collectProjectBundle, type BundleSnapshot } from '../routes/workflows/project-bundle.js';

async function fixture(
  run: (
    backend: SqliteWorkflowBackend,
    options: { databasePath: string; artifactRoot: string; virtualRoot: string },
    setPaused: (value: boolean) => void,
  ) => Promise<void>,
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
    withWrite: async (operation) => {
      if (paused) throw new Error('maintenance');
      return operation();
    },
  });
  const candidate = new LocalWorkflowCatalog(options);
  try {
    candidate.initialize();
    candidate.close();
    backend.initialize();
    await run(backend, options, (value) => {
      paused = value;
    });
    // The adapter must never materialize legacy projects or metadata sidecars.
    await assert.rejects(fs.stat(options.virtualRoot), { code: 'ENOENT' });
  } finally {
    candidate.close();
    backend.close();
    await fs.rm(root, { recursive: true, force: true });
  }
}
const conditions = (item: WorkflowProjectItem) => ({
  expectedProjectId: item.projectMetadataId!,
  expectedPublicationVersion: item.settings.publicationVersion!,
  expectedDraftRevisionId: item.revisionId!,
});
function executable(contents: string) {
  const [project, attached] = loadProjectAndAttachedDataFromString(contents);
  const graphId = 'main' as NonNullable<typeof project.metadata.mainGraphId>;
  project.metadata.mainGraphId = graphId;
  project.graphs = { [graphId]: { metadata: { id: graphId, name: 'Main' }, nodes: [], connections: [] } };
  return serializeProject(project, attached) as string;
}
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

test('SQLite endpoint lookup reads only its selected artifact, not unrelated projects or retained history', async () => {
  await fixture(async (backend, options) => {
    let item = await createExecutable(backend);
    item = await backend.updateWorkflowEndpointAccess(item.relativePath, 'internal', conditions(item));
    item = await backend.publishWorkflowProjectItem(
      item.relativePath,
      { endpointName: 'Story', endpointAccess: 'internal' },
      conditions(item),
    );
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
    assert.equal(await backend.loadPublishedExecutionProject('unknown'), null);
    // Conversion verification must still discover the deliberately broken history.
    await assert.rejects(backend.listWorkflowPublishedVersions(item.relativePath), /ENOENT/);
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
      await backend.deleteWorkflowFolderItem('B');
      assert.equal(catalog.findProjectPathById(item.projectMetadataId!), null);
      assert.equal(await catalog.readRecording('run-1'), null);
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

test('SQLite recordings persist before callbacks, support bounded input search, replay, statistics and deletion', async () => {
  await fixture(async (backend) => {
    const item = await createExecutable(backend),
      loaded = await backend.loadHostedProject(item.absolutePath),
      [project, attached] = loadProjectAndAttachedDataFromString(loaded.contents);
    const ids: string[] = [];
    for (const [index, status] of (['succeeded', 'failed', 'suspicious'] as const).entries()) {
      const recordingSerialized = JSON.stringify({
        version: 1,
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
