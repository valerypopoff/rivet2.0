import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool } from 'pg';
import type { WorkflowExecutionDefinition } from '../routes/workflows/data-backend.js';
import {
  loadProjectAndAttachedDataFromString,
  serializeProject,
  type DatasetId,
  type ProjectId,
} from '@valerypopoff/rivet2-node';

import { createBlankProjectFile } from '../routes/workflows/fs-helpers.js';
import { collectProjectBundle, type BundleSnapshot } from '../routes/workflows/project-bundle.js';
import {
  ManagedWorkflowExecutionCache,
  type ManagedWorkflowRunKind,
} from '../routes/workflows/managed/execution-cache.js';
import { ManagedWorkflowExecutionInvalidationController } from '../routes/workflows/managed/execution-invalidation.js';
import { ManagedWorkflowExecutionService } from '../routes/workflows/managed/execution-service.js';
import { getManagedWorkflowProjectVirtualPath } from '../routes/workflows/virtual-paths.js';
import { createDeferred, FakeListener } from './helpers/managed-backend-harness.js';
import { withAsyncDeadline } from './helpers/workflow-async-process.js';
import { ColdEndpointReleases } from '../routes/workflows/managed/endpoint-release-runtime.js';
import { InMemoryManagedWorkflowBlobStore } from '../routes/workflows/managed/blob-store.js';
import type {
  ManagedExecutionPointerLookupResult,
  ManagedExecutionRevisionRecord,
  ManagedExecutionWorkflowRecord,
  ManagedWebAppAccessPolicy,
} from '../routes/workflows/managed/execution-types.js';

test('cold public releases share reads, bound distinct work and release slots after errors or expiry', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const loads = new ColdEndpointReleases<void>();
  const held = Array.from({ length: 4 }, () => createDeferred<void>());
  const active = held.map((slot, i) => loads.load(String(i), true, () => slot.promise));
  const never = async () => assert.fail('This release must not perform I/O');
  assert.equal(loads.load('0', false, never), active[0]);
  const busy = { status: 503 };
  await assert.rejects(loads.load('internal', false, never), busy);

  const started: string[] = [];
  const next = createDeferred<void>();
  const first = loads.load('first', true, async () => {
    started.push('first');
    throw Error('storage failed');
  });
  const failed = assert.rejects(first, /storage failed/);
  const second = loads.load('second', true, async () => {
    started.push('second');
    await next.promise;
  });
  assert.equal(loads.load('second', true, never), second);
  const expire = Array.from({ length: 26 }, (_, i) => assert.rejects(loads.load('waiting-' + i, true, never), busy));
  await assert.rejects(loads.load('overflow', true, never), busy);
  held[0]!.resolve();
  await failed;
  assert.deepEqual(started, ['first', 'second']);
  t.mock.timers.tick(1_000);
  await Promise.all(expire);
  next.resolve();
  for (const slot of held) slot.resolve();
  await Promise.all([...active, second]);
  await loads.load('first', true, async () => {});
});

function createControllerFixture() {
  const listener = new FakeListener();
  const controller = new ManagedWorkflowExecutionInvalidationController({
    databaseConnectionConfig: {},
    withManagedDbRetry: async (_scope, run) => run(),
    invalidateWorkflowEndpointPointers: () => {},
    clearEndpointPointers: () => {},
    createListener: () => listener,
    scheduleReconnect: () => ({}),
  });

  return {
    controller,
    listener,
  };
}

function createExecutionServiceFixture(options: {
  webAppAllowedEmails?: string[];
  resolveExecutionPointerFromDatabase?: (
    runKind: ManagedWorkflowRunKind,
    lookupName: string,
    batchPublicLookup?: boolean,
  ) => Promise<ManagedExecutionPointerLookupResult | null>;
  resolveWebAppAccessPolicy?: (lookupName: string) => Promise<ManagedWebAppAccessPolicy | null>;
  getWorkflowByRelativePath?: (relativePath: string) => Promise<ManagedExecutionWorkflowRecord | null>;
  getWorkflowById?: (workflowId: string) => Promise<ManagedExecutionWorkflowRecord | null>;
  getRevision?: (revisionId: string | null | undefined) => Promise<ManagedExecutionRevisionRecord | null>;
  readRevisionContents?: (
    revision: ManagedExecutionRevisionRecord,
  ) => Promise<{ contents: string; datasetsContents: string | null }>;
}) {
  const cache = new ManagedWorkflowExecutionCache();
  const { controller, listener } = createControllerFixture();
  const [project] = loadProjectAndAttachedDataFromString(createBlankProjectFile('Managed Cache'));
  project.metadata.id = 'workflow-a' as ProjectId;
  const projectContents = serializeProject(project) as string;
  const workflow: ManagedExecutionWorkflowRecord = {
    workflow_id: 'workflow-a',
    relative_path: 'Managed Cache.rivet-project',
    current_draft_revision_id: 'revision-a',
    published_revision_id: 'revision-a',
  };
  const revision: ManagedExecutionRevisionRecord = {
    revision_id: 'revision-a',
    workflow_id: 'workflow-a',
    project_blob_key: 'project-blob',
    dataset_blob_key: null,
    created_at: new Date(),
  };
  let resolveCount = 0;
  let resolveWebAppAccessPolicyCount = 0;
  let readRevisionContentsCount = 0;
  let getWorkflowByRelativePathCount = 0;
  let getWorkflowByIdCount = 0;
  const context: ManagedWorkflowExecutionContextFixture = {
    pool: {} as Pool,
    executionCache: cache,
    executionInvalidationController: controller,
    queries: {
      getWorkflowByRelativePath: async (_client, relativePath) => {
        getWorkflowByRelativePathCount += 1;
        return options.getWorkflowByRelativePath
          ? options.getWorkflowByRelativePath(relativePath)
          : relativePath === workflow.relative_path
            ? workflow
            : null;
      },
      getWorkflowById: async (_client, workflowId) => {
        getWorkflowByIdCount += 1;
        return options.getWorkflowById
          ? options.getWorkflowById(workflowId)
          : workflowId === workflow.workflow_id
            ? workflow
            : null;
      },
      getRevision: async (_client, revisionId) =>
        options.getRevision ? options.getRevision(revisionId) : revisionId === revision.revision_id ? revision : null,
      resolveExecutionPointerFromDatabase: async (_client, runKind, lookupName, batchPublicLookup) => {
        resolveCount += 1;
        return options.resolveExecutionPointerFromDatabase
          ? options.resolveExecutionPointerFromDatabase(runKind, lookupName, batchPublicLookup)
          : {
              pointer: {
                workflowId: workflow.workflow_id,
                relativePath: workflow.relative_path,
                revisionId: revision.revision_id,
                webAppAllowedEmails: options.webAppAllowedEmails,
              },
              revision,
            };
      },
      resolveWebAppAccessPolicyFromDatabase: async (_client, lookupName) => {
        resolveWebAppAccessPolicyCount += 1;
        return options.resolveWebAppAccessPolicy
          ? options.resolveWebAppAccessPolicy(lookupName)
          : {
              relativePath: workflow.relative_path,
              uiGraphId: 'ui-graph-a',
              allowedEmails: ['user@example.com'],
              appId: 'web-app-a',
            };
      },
    },
    revisions: {
      readRevisionContents: async (loadedRevision) => {
        readRevisionContentsCount += 1;
        return options.readRevisionContents
          ? options.readRevisionContents(loadedRevision)
          : {
              contents: projectContents,
              datasetsContents: null,
            };
      },
    },
  };

  const service = new ManagedWorkflowExecutionService({
    context,
  });

  return {
    context,
    cache,
    controller,
    listener,
    service,
    workflow,
    revision,
    projectContents,
    get resolveCount() {
      return resolveCount;
    },
    get resolveWebAppAccessPolicyCount() {
      return resolveWebAppAccessPolicyCount;
    },
    get readRevisionContentsCount() {
      return readRevisionContentsCount;
    },
    get getWorkflowByRelativePathCount() {
      return getWorkflowByRelativePathCount;
    },
    get getWorkflowByIdCount() {
      return getWorkflowByIdCount;
    },
  };
}

type ManagedWorkflowExecutionContextFixture = ConstructorParameters<typeof ManagedWorkflowExecutionService>[0]['context'];

test('published admission lookup defers cold reads and warm clones without a second DB lookup on load', async (t) => {
  const fixture = createExecutionServiceFixture({});
  await fixture.controller.initialize();
  t.after(() => fixture.controller.dispose());
  const materialize = t.mock.method(fixture.cache.parsedDefinitions, 'materialize');
  const cold = await fixture.service.resolvePublishedExecutionTarget('hello-world', true);
  assert.ok(cold);
  assert.equal(fixture.resolveCount, 1);
  assert.equal(fixture.readRevisionContentsCount, 0);
  assert.equal(materialize.mock.callCount(), 0);
  assert.ok(await cold.load());
  assert.equal(fixture.resolveCount, 1);
  assert.equal(fixture.readRevisionContentsCount, 1);
  assert.equal(materialize.mock.callCount(), 1);

  const warm = await Promise.all(Array.from({ length: 64 }, () =>
    fixture.service.resolvePublishedExecutionTarget('hello-world', true)));
  assert.ok(warm.every(Boolean));
  assert.equal(fixture.resolveCount, 65, 'Each public lookup checks current committed access.');
  assert.equal(fixture.readRevisionContentsCount, 1);
  assert.equal(materialize.mock.callCount(), 1, 'Discarding warm targets must not clone projects.');
  assert.ok(await warm[0]!.load());
  assert.equal(fixture.resolveCount, 65);
  assert.equal(materialize.mock.callCount(), 2);
});

test('published admission lookup checks private and missing endpoints without loading artifacts', async (t) => {
  let exists = true;
  const fixture = createExecutionServiceFixture({
    resolveExecutionPointerFromDatabase: async () => exists ? {
      pointer: {
        workflowId: 'workflow-a', relativePath: 'Managed Cache.rivet-project',
        revisionId: 'revision-a', endpointAccess: 'internal', releaseId: 'captured-release',
      },
      revision: fixture.revision,
    } : null,
  });
  await fixture.controller.initialize();
  t.after(() => fixture.controller.dispose());
  const target = await fixture.service.resolvePublishedExecutionTarget('private', true);
  assert.equal(target?.endpointAccess, 'internal');
  assert.equal(fixture.readRevisionContentsCount, 0);
  // No blob store exists in this fixture. Even a captured release is not read
  // until an admitted caller asks to load it.
  await assert.rejects(target!.load(), /cannot read the captured endpoint revision/);
  exists = false;
  assert.equal(await fixture.service.resolvePublishedExecutionTarget('missing', true), null);
  assert.equal(fixture.resolveCount, 2);
  assert.equal(fixture.readRevisionContentsCount, 0);
});

test('publication/access invalidation between admission lookup and load is rechecked', async (t) => {
  for (const changed of ['private', 'unpublished'] as const) {
    let invalidated = false;
    const fixture = createExecutionServiceFixture({
      resolveExecutionPointerFromDatabase: async () => invalidated && changed === 'unpublished' ? null : {
        pointer: {
          workflowId: 'workflow-a', relativePath: 'Managed Cache.rivet-project', revisionId: 'revision-a',
          endpointAccess: invalidated ? 'internal' : 'public',
        },
        revision: fixture.revision,
      },
    });
    await fixture.controller.initialize();
    t.after(() => fixture.controller.dispose());
    const target = await fixture.service.resolvePublishedExecutionTarget('hello-world', true);
    assert.equal(target?.endpointAccess, 'public');
    invalidated = true;
    fixture.controller.markWorkflowChanged('workflow-a');
    const loaded = await target!.load();
    assert.equal(loaded, null);
    assert.equal(fixture.readRevisionContentsCount, 0);
    assert.equal(fixture.resolveCount, 2);
  }
});

test('a republished public target waits for a cold reader and independently rechecks access', async (t) => {
  const held = createDeferred<void>();
  const saturated = createDeferred<void>();
  let republished = false;
  const batching: boolean[] = [];
  const fixture = createExecutionServiceFixture({
    resolveExecutionPointerFromDatabase: async (_kind, name, batch) => {
      if (name === 'updated') batching.push(batch === true);
      return {
        pointer: {
          workflowId: name, relativePath: name, revisionId: 'revision-a',
          releaseId: name === 'updated' && republished ? 'replacement' : name,
        },
        revision: fixture.revision,
      };
    },
  });
  const reads: string[] = [];
  const unavailable = Error('Manifest read failed');
  const pool = Object.assign(fixture.context.pool, {
    query: async (_sql: string, [id]: string[]) => {
      reads.push(id!);
      if (reads.length === 4) saturated.resolve();
      await held.promise;
      throw unavailable;
    },
  });
  const service = new ManagedWorkflowExecutionService({ context: {
    ...fixture.context, pool, blobStore: new InMemoryManagedWorkflowBlobStore(),
  } });
  await fixture.controller.initialize();
  t.after(() => fixture.controller.dispose());
  const targets = await Promise.all(['a', 'b', 'c', 'd', 'updated'].map(name =>
    service.resolvePublishedExecutionTarget(name, true)));
  const active = targets.slice(0, 4).map(target => assert.rejects(target!.load(), unavailable));
  try {
    await withAsyncDeadline(saturated.promise, 'four frozen release readers');
    republished = true;
    fixture.controller.markWorkflowChanged('updated');
    const result = Promise.allSettled([targets[4]!.load()]);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(reads.length, 4);
    held.resolve();
    assert.deepEqual(await result, [{ status: 'rejected', reason: unavailable }]);
    assert.deepEqual(batching, [true, false]);
    assert.equal(reads[4], 'replacement');
  } finally {
    held.resolve();
    await Promise.all(active);
  }
});

test('invalidation during admission lookup retries metadata only', async (t) => {
  let first = true;
  const fixture = createExecutionServiceFixture({
    resolveExecutionPointerFromDatabase: async () => {
      const stale = first;
      first = false;
      if (stale) fixture.controller.markWorkflowChanged('workflow-a');
      return {
        pointer: {
          workflowId: 'workflow-a', relativePath: 'Managed Cache.rivet-project', revisionId: 'revision-a',
          endpointAccess: stale ? 'public' : 'internal',
        },
        revision: fixture.revision,
      };
    },
  });
  await fixture.controller.initialize();
  t.after(() => fixture.controller.dispose());
  assert.equal((await fixture.service.resolvePublishedExecutionTarget('hello-world', true))?.endpointAccess, 'internal');
  assert.equal(fixture.resolveCount, 2);
  assert.equal(fixture.readRevisionContentsCount, 0);
});

test('cacheable admission lookups share a cold metadata read without starting artifact loads', async (t) => {
  const resolved = createDeferred<ManagedExecutionPointerLookupResult>();
  const fixture = createExecutionServiceFixture({ resolveExecutionPointerFromDatabase: () => resolved.promise });
  await fixture.controller.initialize();
  t.after(() => fixture.controller.dispose());
  const pending = Array.from({ length: 32 }, () => fixture.service.resolvePublishedExecutionTarget('cold-endpoint'));
  try {
    assert.equal(fixture.resolveCount, 1);
    assert.equal(fixture.readRevisionContentsCount, 0);
  } finally {
    resolved.resolve({
      pointer: {
        workflowId: fixture.workflow.workflow_id, relativePath: fixture.workflow.relative_path,
        revisionId: fixture.revision.revision_id,
      },
      revision: fixture.revision,
    });
    const targets = await Promise.all(pending);
    assert.ok(targets.every(Boolean));
    assert.equal(fixture.readRevisionContentsCount, 0);
    const loaded = await Promise.all(targets.map((target) => target!.load()));
    assert.equal(fixture.readRevisionContentsCount, 1);
    assert.equal(new Set(loaded.map((result) => result!.project)).size, 32);
  }
});

test('deferred lookup sharing respects fresh access and invalidation generations', async (t) => {
  for (const fresh of [false, true]) {
    const firstLookup = createDeferred<ManagedExecutionPointerLookupResult>();
    let invocation = 0;
    const fixture = createExecutionServiceFixture({
      resolveExecutionPointerFromDatabase: () => ++invocation === 1 ? firstLookup.promise : Promise.resolve({
        pointer: {
          workflowId: 'workflow-a', relativePath: 'Managed Cache.rivet-project',
          revisionId: 'revision-a', endpointAccess: 'internal',
        },
        revision: fixture.revision,
      }),
    });
    await fixture.controller.initialize();
    t.after(() => fixture.controller.dispose());
    const earlier = fixture.service.resolvePublishedExecutionTarget('hello-world');
    try {
      if (!fresh) fixture.controller.markWorkflowChanged('workflow-a');
      const current = fixture.service.resolvePublishedExecutionTarget('hello-world', fresh);
      assert.equal(fixture.resolveCount, 2);
      assert.equal((await current)?.endpointAccess, 'internal');
    } finally {
      firstLookup.resolve({
        pointer: {
          workflowId: 'workflow-a', relativePath: 'Managed Cache.rivet-project',
          revisionId: 'revision-a', endpointAccess: 'public',
        },
        revision: fixture.revision,
      });
      assert.equal((await earlier)?.endpointAccess, fresh ? 'public' : 'internal');
    }
    assert.equal(fixture.readRevisionContentsCount, 0);
  }
});

test('a failed shared metadata lookup is released without replaying it', async (t) => {
  const failure = new Error('Metadata temporarily unavailable');
  let invocation = 0;
  const fixture = createExecutionServiceFixture({
    resolveExecutionPointerFromDatabase: async () => {
      if (++invocation === 1) throw failure;
      return {
        pointer: {
          workflowId: 'workflow-a', relativePath: 'Managed Cache.rivet-project', revisionId: 'revision-a',
        },
        revision: fixture.revision,
      };
    },
  });
  await fixture.controller.initialize();
  t.after(() => fixture.controller.dispose());
  const pending = Promise.allSettled(Array.from({ length: 2 }, () =>
    fixture.service.resolvePublishedExecutionTarget('hello-world')));
  for (const result of await pending) {
    assert.equal(result.status, 'rejected');
    if (result.status === 'rejected') assert.equal(result.reason, failure);
  }
  assert.equal(fixture.resolveCount, 1, 'Failure must not automatically retry the lookup.');
  assert.ok(await fixture.service.resolvePublishedExecutionTarget('hello-world'));
  assert.equal(fixture.resolveCount, 2, 'The next request must be able to recover.');
  assert.equal(fixture.readRevisionContentsCount, 0);
});

test('shared admission targets retain source-load sharing across an access-change retry', async (t) => {
  for (const mode of ['full', 'deferred', 'staggered'] as const) {
    const readStarted = createDeferred<void>();
    const allLoadsStarted = createDeferred<void>();
    const finishRead = createDeferred<void>();
    let changed = false;
    const fixture = createExecutionServiceFixture({
      resolveExecutionPointerFromDatabase: async () => ({
        pointer: {
          workflowId: 'workflow-a', relativePath: 'Managed Cache.rivet-project', revisionId: 'revision-a',
          endpointAccess: changed ? 'internal' : 'public',
        },
        revision: fixture.revision,
      }),
      readRevisionContents: async () => {
        readStarted.resolve();
        await finishRead.promise;
        return { contents: fixture.projectContents, datasetsContents: null };
      },
    });
    await fixture.controller.initialize();
    t.after(() => fixture.controller.dispose());
    const pending = (async () => {
      const loads: Array<Promise<WorkflowExecutionDefinition | null>> = [];
      if (mode === 'full') {
        loads.push(...Array.from({ length: 32 }, () => fixture.service.loadPublishedExecutionProject('hello-world')));
      } else if (mode === 'deferred') {
        const targets = await Promise.all(Array.from({ length: 32 }, () =>
          fixture.service.resolvePublishedExecutionTarget('hello-world')));
        loads.push(...targets.map((target) => target!.load()));
      } else {
        // Later requests reach separate metadata targets while the first read
        // is still pending; sharing must span their complete source loads.
        for (let index = 0; index < 32; index++) {
          const target = await fixture.service.resolvePublishedExecutionTarget('hello-world');
          loads.push(target!.load());
        }
      }
      allLoadsStarted.resolve();
      return Promise.all(loads);
    })();
    try {
      await readStarted.promise;
      await allLoadsStarted.promise;
      changed = true;
      fixture.controller.markWorkflowChanged('workflow-a');
    } finally {
      finishRead.resolve();
    }
    const loaded = await pending;
    assert.ok(loaded.every((result) => result?.endpointAccess === 'internal'));
    assert.equal(fixture.resolveCount, 2, 'One initial lookup and one access-change retry per shared load.');
    assert.equal(fixture.readRevisionContentsCount, 1);
    assert.equal(new Set(loaded.map((result) => result!.project)).size, 32);
  }
});

test('unpublishing during a revision or frozen manifest read supersedes its storage error', async (t) => {
  for (const releaseId of [undefined, 'retired-release']) {
    let unpublished = false;
    const retire = async () => {
      unpublished = true;
      fixture.controller.markWorkflowChanged('workflow-a');
      throw Error('Retired artifact');
    };
    const fixture = createExecutionServiceFixture({
      resolveExecutionPointerFromDatabase: async () => unpublished ? null : {
        pointer: {
          workflowId: 'workflow-a', relativePath: 'Managed Cache.rivet-project', revisionId: 'revision-a', releaseId,
        },
        revision: fixture.revision,
      },
      readRevisionContents: retire,
    });
    const manifestRead = t.mock.fn(retire);
    const service = new ManagedWorkflowExecutionService({ context: {
      ...fixture.context, pool: Object.assign(fixture.context.pool, { query: manifestRead }),
      blobStore: new InMemoryManagedWorkflowBlobStore(),
    } });
    await fixture.controller.initialize();
    t.after(() => fixture.controller.dispose());
    const target = await service.resolvePublishedExecutionTarget('hello-world', true);
    assert.ok(target);
    assert.equal(await target.load(), null);
    assert.equal(fixture.resolveCount, 2);
    assert.equal(fixture.readRevisionContentsCount, releaseId ? 0 : 1);
    assert.equal(manifestRead.mock.callCount(), releaseId ? 1 : 0);
  }
});

test('shared target loading releases failures and rechecks later changes', async (t) => {
  const failure = new Error('Artifact read failed');
  let failing = true;
  let changed = false;
  const fixture = createExecutionServiceFixture({
    resolveExecutionPointerFromDatabase: async () => ({
      pointer: {
        workflowId: 'workflow-a', relativePath: 'Managed Cache.rivet-project', revisionId: 'revision-a',
        endpointAccess: changed ? 'internal' : 'public',
      },
      revision: fixture.revision,
    }),
    readRevisionContents: async () => {
      if (failing) throw failure;
      return { contents: fixture.projectContents, datasetsContents: null };
    },
  });
  await fixture.controller.initialize();
  t.after(() => fixture.controller.dispose());
  const target = await fixture.service.resolvePublishedExecutionTarget('hello-world', true);
  assert.ok(target);
  for (const result of await Promise.allSettled([target.load(), target.load()])) {
    assert.equal(result.status, 'rejected');
    if (result.status === 'rejected') assert.equal(result.reason, failure);
  }
  assert.equal(fixture.readRevisionContentsCount, 1);
  failing = false;
  const recovered = await target.load();
  assert.ok(recovered);
  recovered.project.metadata.title = 'Caller mutation';
  assert.equal(fixture.readRevisionContentsCount, 2);
  changed = true;
  fixture.controller.markWorkflowChanged('workflow-a');
  assert.equal(await target.load(), null);
  assert.equal(fixture.resolveCount, 2);
  assert.equal(fixture.readRevisionContentsCount, 2);
});

test('a fresh admission target cannot join an older source load before notification arrives', async (t) => {
  const oldReadStarted = createDeferred<void>();
  const finishOldRead = createDeferred<void>();
  let currentRevision = 'revision-a';
  const fixture = createExecutionServiceFixture({
    resolveExecutionPointerFromDatabase: async () => ({
      pointer: {
        workflowId: 'workflow-a', relativePath: 'Managed Cache.rivet-project', revisionId: currentRevision,
      },
      revision: { ...fixture.revision, revision_id: currentRevision },
    }),
    readRevisionContents: async (revision) => {
      if (revision.revision_id === 'revision-a') {
        oldReadStarted.resolve();
        await finishOldRead.promise;
        return { contents: fixture.projectContents, datasetsContents: null };
      }
      const [project] = loadProjectAndAttachedDataFromString(fixture.projectContents);
      project.metadata.title = 'New publication';
      return { contents: serializeProject(project) as string, datasetsContents: null };
    },
  });
  await fixture.controller.initialize();
  t.after(() => fixture.controller.dispose());
  const older = fixture.service.loadPublishedExecutionProject('hello-world');
  try {
    await oldReadStarted.promise;
    currentRevision = 'revision-b'; // Committed elsewhere; no local invalidation yet.
    const target = await fixture.service.resolvePublishedExecutionTarget('hello-world', true);
    assert.ok(target);
    const fresh = target.load();
    assert.equal(fixture.readRevisionContentsCount, 2, 'Fresh loading must not wait on the older source.');
    const loaded = await fresh;
    assert.equal(loaded?.revisionKey, 'managed:revision-b');
    assert.equal(loaded?.project.metadata.title, 'New publication');
    assert.equal(fixture.resolveCount, 2);
  } finally {
    finishOldRead.resolve();
    assert.equal((await older)?.project.metadata.title, 'Managed Cache');
  }
});

test('warm pointer hit does not re-run joined DB resolution', async () => {
  const fixture = createExecutionServiceFixture({});
  await fixture.controller.initialize();

  const first = await fixture.service.loadPublishedExecutionProject('hello-world');
  const second = await fixture.service.loadPublishedExecutionProject('hello-world');

  assert.ok(first);
  assert.ok(second);
  assert.equal(fixture.resolveCount, 1);
  assert.equal(fixture.readRevisionContentsCount, 1);
});

test('different routes share a revision read failure without caching it or automatically replaying it', async () => {
  const entered = createDeferred<void>();
  const release = createDeferred<void>();
  const unavailable = new Error('Object storage temporarily unavailable');
  let failRead = true;
  const fixture = createExecutionServiceFixture({
    readRevisionContents: async () => {
      entered.resolve();
      await release.promise;
      if (failRead) throw unavailable;
      return { contents: fixture.projectContents, datasetsContents: null };
    },
  });
  await fixture.controller.initialize();
  const outcomes = Promise.allSettled([
    fixture.service.loadPublishedExecutionProject('first-route'),
    fixture.service.loadPublishedExecutionProject('second-route'),
  ]);
  await entered.promise;
  release.resolve();
  for (const outcome of await outcomes) {
    assert.equal(outcome.status, 'rejected');
    if (outcome.status === 'rejected') assert.strictEqual(outcome.reason, unavailable);
  }
  assert.equal(fixture.resolveCount, 2, 'independent routes are resolved independently');
  assert.equal(fixture.readRevisionContentsCount, 1, 'only immutable revision IO is coalesced');
  assert.equal(fixture.cache.getRevisionMaterialization('revision-a'), null);
  failRead = false;
  const recovered = await fixture.service.loadPublishedExecutionProject('first-route');
  assert.equal(recovered?.project.metadata.title, 'Managed Cache');
  assert.equal(fixture.readRevisionContentsCount, 2, 'a later request can retry the failed load');
  const next = await fixture.service.loadPublishedExecutionProject('second-route');
  assert.notStrictEqual(next?.project, recovered?.project);
  assert.equal(fixture.readRevisionContentsCount, 2, 'successful immutable contents remain reusable');
});

for (const method of [
  'loadPublishedExecutionProject',
  'loadLatestExecutionProject',
  'loadPublishedWebAppExecutionProject',
  'loadLatestWebAppExecutionProject',
] as const) {
  test(`${method} coalesces immutable IO, not per-execution mutable state`, async () => {
    const fixture = createExecutionServiceFixture({ webAppAllowedEmails: ['reader@example.test'] });
    await fixture.controller.initialize();
    const [first, second] = await Promise.all([
      fixture.service[method]('same-route'),
      fixture.service[method]('same-route'),
    ]);
    assert.ok(first);
    assert.ok(second);
    assert.notStrictEqual(first.project, second.project);
    assert.notStrictEqual(first.attachedData, second.attachedData);
    assert.notStrictEqual(first.datasetProvider, second.datasetProvider);
    assert.notStrictEqual(first.debug, second.debug);
    first.project.metadata.title = 'Mutated by the first execution';
    first.attachedData.test = { changed: true };
    first.debug.materializeMs = -1;
    first.webAppAllowedEmails!.push('other@example.test');
    const datasetId = 'run-local-dataset' as DatasetId;
    await first.datasetProvider.putDatasetMetadata({
      id: datasetId,
      projectId: first.project.metadata.id,
      name: 'Run-local dataset',
      description: '',
    });
    assert.equal(second.project.metadata.title, 'Managed Cache');
    assert.equal(second.attachedData.test, undefined);
    assert.equal(await second.datasetProvider.getDatasetMetadata(datasetId), undefined);
    assert.ok(second.debug.materializeMs >= 0);
    assert.deepEqual(second.webAppAllowedEmails, ['reader@example.test']);
    assert.equal(fixture.resolveCount, 1, 'concurrent route resolution remains coalesced');
    assert.equal(fixture.readRevisionContentsCount, 1, 'concurrent object reads remain coalesced');
    const third = await fixture.service[method]('same-route');
    assert.equal(third?.project.metadata.title, 'Managed Cache');
    assert.deepEqual(third?.webAppAllowedEmails, ['reader@example.test']);
    assert.equal(await third?.datasetProvider.getDatasetMetadata(datasetId), undefined);
  });

  test(`${method} rejects a saved artifact belonging to another project`, async () => {
    const [foreign] = loadProjectAndAttachedDataFromString(createBlankProjectFile('Foreign'));
    const fixture = createExecutionServiceFixture({
      readRevisionContents: async () => ({ contents: serializeProject(foreign) as string, datasetsContents: null }),
    });
    await fixture.controller.initialize();
    await assert.rejects(fixture.service[method]('same-route'), { status: 500 });
  });
}

test('public workflow lookup sees committed access changes before cache invalidation arrives', async () => {
  let access: 'public' | 'internal' = 'public';
  const fixture = createExecutionServiceFixture({
    resolveExecutionPointerFromDatabase: async () => ({
      pointer: {
        workflowId: 'workflow-a',
        relativePath: 'Managed Cache.rivet-project',
        revisionId: 'revision-a',
        endpointAccess: access,
      },
      revision: {
        revision_id: 'revision-a',
        workflow_id: 'workflow-a',
        project_blob_key: 'project-blob',
        dataset_blob_key: null,
        created_at: new Date(),
      },
    }),
  });
  await fixture.controller.initialize();

  assert.equal((await fixture.service.loadPublishedExecutionProject('hello-world'))?.endpointAccess, 'public');
  assert.equal((await fixture.service.loadLatestExecutionProject('hello-world'))?.endpointAccess, 'public');
  access = 'internal';
  assert.equal((await fixture.service.loadPublishedExecutionProject('hello-world'))?.endpointAccess, 'public');
  assert.equal((await fixture.service.loadLatestExecutionProject('hello-world'))?.endpointAccess, 'public');
  assert.equal((await fixture.service.loadPublishedExecutionProject('hello-world', true))?.endpointAccess, 'internal');
  assert.equal((await fixture.service.loadLatestExecutionProject('hello-world', true))?.endpointAccess, 'internal');
  assert.equal(fixture.resolveCount, 4);
  assert.equal(fixture.readRevisionContentsCount, 1);
});

test('fresh public lookups do not join a pre-change lookup still in flight', async () => {
  const oldLookup = createDeferred<ManagedExecutionPointerLookupResult>();
  let lookupCount = 0;
  const fixture = createExecutionServiceFixture({
    resolveExecutionPointerFromDatabase: async () => {
      lookupCount += 1;
      if (lookupCount === 1) return oldLookup.promise;
      return {
        pointer: {
          workflowId: 'workflow-a',
          relativePath: 'Managed Cache.rivet-project',
          revisionId: 'revision-a',
          endpointAccess: 'internal',
        },
        revision: fixture.revision,
      };
    },
  });
  await fixture.controller.initialize();

  const beforeChange = fixture.service.loadPublishedExecutionProject('hello-world', true);
  const afterChange = fixture.service.loadPublishedExecutionProject('hello-world', true);
  assert.equal((await afterChange)?.endpointAccess, 'internal');
  oldLookup.resolve({
    pointer: {
      workflowId: 'workflow-a',
      relativePath: 'Managed Cache.rivet-project',
      revisionId: 'revision-a',
      endpointAccess: 'public',
    },
    revision: fixture.revision,
  });
  assert.equal((await beforeChange)?.endpointAccess, 'public');
  assert.equal(lookupCount, 2);
});

test('reads current web app access policy without loading an executable revision', async () => {
  const fixture = createExecutionServiceFixture({});
  await fixture.controller.initialize();

  const policy = await fixture.service.resolveWebAppAccessPolicy('app-slug');

  assert.deepEqual(policy, {
    relativePath: 'Managed Cache.rivet-project',
    uiGraphId: 'ui-graph-a',
    allowedEmails: ['user@example.com'],
    appId: 'web-app-a',
  });
  assert.equal(fixture.resolveWebAppAccessPolicyCount, 1);
  assert.equal(fixture.resolveCount, 0);
  assert.equal(fixture.readRevisionContentsCount, 0);
});

test('service forwards the correct run kind for workflow and web app endpoint resolution', async () => {
  const observedCalls: Array<{ runKind: ManagedWorkflowRunKind; lookupName: string }> = [];
  const fixture = createExecutionServiceFixture({
    resolveExecutionPointerFromDatabase: async (runKind, lookupName) => {
      observedCalls.push({ runKind, lookupName });
      return {
        pointer: {
          workflowId: 'workflow-a',
          relativePath: 'Managed Cache.rivet-project',
          revisionId: 'revision-a',
          webAppUiGraphId: runKind === 'web-app' || runKind === 'latest-web-app' ? 'ui-graph-a' : undefined,
          webAppId: runKind === 'web-app' || runKind === 'latest-web-app' ? 'published-app-a' : undefined,
        },
        revision: {
          revision_id: 'revision-a',
          workflow_id: 'workflow-a',
          project_blob_key: 'project-blob',
          dataset_blob_key: null,
          created_at: new Date(),
        },
      };
    },
  });
  await fixture.controller.initialize();

  const published = await fixture.service.loadPublishedExecutionProject('public-live');
  const latest = await fixture.service.loadLatestExecutionProject('latest-only');
  const webApp = await fixture.service.loadPublishedWebAppExecutionProject('app-slug');
  const latestWebApp = await fixture.service.loadLatestWebAppExecutionProject('app-slug-latest');

  assert.ok(published);
  assert.ok(latest);
  assert.ok(webApp);
  assert.ok(latestWebApp);
  assert.equal(webApp.webAppUiGraphId, 'ui-graph-a');
  assert.equal(webApp.webAppBindingId, 'managed:published-app-a');
  assert.equal(latestWebApp.webAppUiGraphId, 'ui-graph-a');
  assert.equal(latestWebApp.webAppBindingId, 'managed:published-app-a');
  assert.deepEqual(observedCalls, [
    { runKind: 'published', lookupName: 'public-live' },
    { runKind: 'latest', lookupName: 'latest-only' },
    { runKind: 'web-app', lookupName: 'app-slug' },
    { runKind: 'latest-web-app', lookupName: 'app-slug-latest' },
  ]);
});

test('pointer misses are not cached as null', async () => {
  let callCount = 0;
  const fixture = createExecutionServiceFixture({
    resolveExecutionPointerFromDatabase: async () => {
      callCount += 1;
      if (callCount === 1) {
        return null;
      }

      return {
        pointer: {
          workflowId: 'workflow-a',
          relativePath: 'Managed Cache.rivet-project',
          revisionId: 'revision-a',
        },
        revision: {
          revision_id: 'revision-a',
          workflow_id: 'workflow-a',
          project_blob_key: 'project-blob',
          dataset_blob_key: null,
          created_at: new Date(),
        },
      };
    },
  });
  await fixture.controller.initialize();

  assert.equal(await fixture.service.loadPublishedExecutionProject('hello-world'), null);
  assert.ok(await fixture.service.loadPublishedExecutionProject('hello-world'));
  assert.equal(callCount, 2);
});

test('post-invalidation requests do not join a pre-invalidation endpoint miss', async () => {
  const firstResolve = createDeferred<ManagedExecutionPointerLookupResult>();
  let resolveInvocation = 0;
  const fixture = createExecutionServiceFixture({
    resolveExecutionPointerFromDatabase: async () => {
      resolveInvocation += 1;
      if (resolveInvocation === 1) {
        return firstResolve.promise;
      }

      return {
        pointer: {
          workflowId: 'workflow-a',
          relativePath: 'Managed Cache.rivet-project',
          revisionId: 'revision-a',
        },
        revision: fixture.revision,
      };
    },
  });
  await fixture.controller.initialize();

  const firstLoad = fixture.service.loadPublishedExecutionProject('hello-world');
  fixture.controller.markWorkflowChanged('workflow-a');
  const secondLoad = fixture.service.loadPublishedExecutionProject('hello-world');

  firstResolve.resolve({
    pointer: {
      workflowId: 'workflow-a',
      relativePath: 'Managed Cache.rivet-project',
      revisionId: 'revision-a',
    },
    revision: fixture.revision,
  });

  await Promise.allSettled([firstLoad, secondLoad]);
  assert.equal(resolveInvocation >= 2, true);
});

test('unrelated workflow churn does not force retry after the workflow id is already known', async () => {
  const fixture = createExecutionServiceFixture({
    readRevisionContents: async (revision) => {
      fixture.controller.markWorkflowChanged('workflow-b');
      return {
        contents: fixture.projectContents,
        datasetsContents: null,
      };
    },
  });
  await fixture.controller.initialize();

  const result = await fixture.service.loadPublishedExecutionProject('hello-world');
  assert.ok(result);
  assert.equal(fixture.resolveCount, 1);
});

test('same-workflow change during resolve retries correctly', async () => {
  let resolveInvocation = 0;
  const fixture = createExecutionServiceFixture({
    resolveExecutionPointerFromDatabase: async () => {
      resolveInvocation += 1;
      if (resolveInvocation === 1) {
        fixture.controller.markWorkflowChanged('workflow-a');
      }

      return {
        pointer: {
          workflowId: 'workflow-a',
          relativePath: 'Managed Cache.rivet-project',
          revisionId: 'revision-a',
        },
        revision: fixture.revision,
      };
    },
  });
  await fixture.controller.initialize();

  const result = await fixture.service.loadPublishedExecutionProject('hello-world');
  assert.ok(result);
  assert.equal(resolveInvocation, 2);
});

test('same-workflow change during materialization retries correctly', async () => {
  let readInvocation = 0;
  const fixture = createExecutionServiceFixture({
    readRevisionContents: async () => {
      readInvocation += 1;
      if (readInvocation === 1) {
        fixture.controller.markWorkflowChanged('workflow-a');
      }

      return {
        contents: fixture.projectContents,
        datasetsContents: null,
      };
    },
  });
  await fixture.controller.initialize();

  const result = await fixture.service.loadPublishedExecutionProject('hello-world');
  assert.ok(result);
  assert.equal(fixture.resolveCount, 2);
});

test('repeated same-workflow races eventually fail instead of returning stale data', async () => {
  const fixture = createExecutionServiceFixture({
    resolveExecutionPointerFromDatabase: async () => {
      fixture.controller.markWorkflowChanged('workflow-a');
      return {
        pointer: {
          workflowId: 'workflow-a',
          relativePath: 'Managed Cache.rivet-project',
          revisionId: 'revision-a',
        },
        revision: fixture.revision,
      };
    },
  });
  await fixture.controller.initialize();

  await assert.rejects(
    fixture.service.loadPublishedExecutionProject('hello-world'),
    /Workflow endpoint changed while loading\. Retry the request\./,
  );
});

test('listener-unhealthy mode bypasses pointer cache but still reuses revision materialization cache', async () => {
  const fixture = createExecutionServiceFixture({});
  await fixture.controller.initialize();

  await fixture.service.loadPublishedExecutionProject('hello-world');
  fixture.listener.emitError(new Error('boom'));
  await Promise.resolve();

  await fixture.service.loadPublishedExecutionProject('hello-world');
  assert.equal(fixture.resolveCount, 2);
  assert.equal(fixture.readRevisionContentsCount, 1);
});

test('reference loading reuses revision materialization cache once the revision id is known', async () => {
  const fixture = createExecutionServiceFixture({});
  await fixture.controller.initialize();
  const loader = fixture.service.createProjectReferenceLoader();

  const currentProjectPath = getManagedWorkflowProjectVirtualPath('Main.rivet-project');
  const first = await loader.loadProject(currentProjectPath, {
    id: fixture.workflow.workflow_id,
    hintPaths: ['./Managed Cache.rivet-project'],
    title: 'Managed Cache',
  });
  const second = await loader.loadProject(currentProjectPath, {
    id: fixture.workflow.workflow_id,
    hintPaths: ['./Managed Cache.rivet-project'],
    title: 'Managed Cache',
  });

  assert.equal(first.metadata.title, second.metadata.title);
  assert.equal(fixture.readRevisionContentsCount, 1);
  assert.equal(fixture.getWorkflowByRelativePathCount, 2);
});

test('reference loading skips a stale path hint for another workflow without reading its artifact', async () => {
  const fixture = createExecutionServiceFixture({
    getWorkflowByRelativePath: async (relativePath) => ({
      workflow_id: 'unrelated-workflow',
      relative_path: relativePath,
      current_draft_revision_id: 'unrelated-revision',
      published_revision_id: 'unrelated-revision',
    }),
  });
  await fixture.controller.initialize();
  try {
    const result = await fixture.service
      .createProjectReferenceLoader()
      .loadProject(getManagedWorkflowProjectVirtualPath('Main.rivet-project'), {
        id: fixture.workflow.workflow_id,
        hintPaths: ['./Old Location.rivet-project'],
      });
    assert.equal(result.metadata.id, fixture.workflow.workflow_id);
    assert.equal(fixture.getWorkflowByIdCount, 1);
    assert.equal(fixture.readRevisionContentsCount, 1);
  } finally {
    await fixture.controller.dispose();
  }
});

test('reference loading rejects a materialized project with a foreign identity', async () => {
  const fixture = createExecutionServiceFixture({
    readRevisionContents: async () => ({
      contents: createBlankProjectFile('Foreign Project'),
      datasetsContents: null,
    }),
  });
  await fixture.controller.initialize();
  try {
    await assert.rejects(
      fixture.service
        .createProjectReferenceLoader()
        .loadProject(getManagedWorkflowProjectVirtualPath('Main.rivet-project'), { id: fixture.workflow.workflow_id }),
      /mismatched saved identity/,
    );
  } finally {
    await fixture.controller.dispose();
  }
});

for (const stage of ['resolve', 'materialize'] as const) {
  test(`reference retries preserve identity when a hinted path is reused during ${stage}`, async () => {
    let pathLookups = 0;
    let invalidated = false;
    const fixture = createExecutionServiceFixture({
      getWorkflowByRelativePath: async (relativePath) => {
        pathLookups++;
        if (pathLookups > 1) {
          return {
            workflow_id: 'unrelated-workflow',
            relative_path: relativePath,
            current_draft_revision_id: 'unrelated-revision',
            published_revision_id: 'unrelated-revision',
          };
        }
        if (stage === 'resolve') {
          fixture.controller.markWorkflowChanged('workflow-a');
        }
        return fixture.workflow;
      },
      readRevisionContents: async () => {
        if (stage === 'materialize' && !invalidated) {
          invalidated = true;
          fixture.controller.markWorkflowChanged('workflow-a');
        }
        return { contents: fixture.projectContents, datasetsContents: null };
      },
    });
    await fixture.controller.initialize();
    try {
      const result = await fixture.service
        .createProjectReferenceLoader()
        .loadProject(getManagedWorkflowProjectVirtualPath('Main.rivet-project'), {
          id: fixture.workflow.workflow_id,
          hintPaths: ['./Old Location.rivet-project'],
        });
      assert.equal(result.metadata.id, fixture.workflow.workflow_id);
      assert.equal(pathLookups, 2);
      assert.equal(fixture.getWorkflowByIdCount, 1);
      assert.equal(fixture.readRevisionContentsCount, 1);
    } finally {
      await fixture.controller.dispose();
    }
  });
}

test('reference loading propagates real operational failures after a hint resolves to a real workflow', async () => {
  const fixture = createExecutionServiceFixture({
    readRevisionContents: async () => {
      throw new Error('blob read failed');
    },
  });
  await fixture.controller.initialize();
  const loader = fixture.service.createProjectReferenceLoader();

  await assert.rejects(
    loader.loadProject(getManagedWorkflowProjectVirtualPath('Main.rivet-project'), {
      id: fixture.workflow.workflow_id,
      hintPaths: ['./Managed Cache.rivet-project'],
      title: 'Managed Cache',
    }),
    /blob read failed/,
  );
});

test('Subgraph target resolution distinguishes managed saved and published revisions', async () => {
  const [project] = loadProjectAndAttachedDataFromString(createBlankProjectFile('Saved target'));
  project.metadata.id = 'managed-subgraph-target' as ProjectId;
  const savedContents = serializeProject(project) as string;
  project.metadata.title = 'Published target';
  const publishedContents = serializeProject(project) as string;
  const workflow: ManagedExecutionWorkflowRecord = {
    workflow_id: project.metadata.id,
    relative_path: 'Components/Target.rivet-project',
    current_draft_revision_id: 'saved-revision',
    published_revision_id: 'published-revision',
  };
  const fixture = createExecutionServiceFixture({
    getWorkflowById: async (id) => (id === workflow.workflow_id ? workflow : null),
    getRevision: async (id) =>
      id
        ? {
            revision_id: id,
            workflow_id: workflow.workflow_id,
            project_blob_key: `blob-${id}`,
            dataset_blob_key: null,
            created_at: new Date(),
          }
        : null,
    readRevisionContents: async (revision) => ({
      contents: revision.revision_id === 'saved-revision' ? savedContents : publishedContents,
      datasetsContents: null,
    }),
  });
  await fixture.controller.initialize();
  const latest = await fixture.service.loadSubgraphTarget({ projectId: project.metadata.id, version: 'latest' });
  const published = await fixture.service.loadSubgraphTarget({ projectId: project.metadata.id, version: 'published' });
  assert.equal(latest.project.metadata.title, 'Saved target');
  assert.equal(published.project.metadata.title, 'Published target');
  assert.equal(latest.sourceProjectPath, getManagedWorkflowProjectVirtualPath(workflow.relative_path));
  assert.equal(fixture.getWorkflowByIdCount, 2);

  const snapshot = async (): Promise<BundleSnapshot> =>
    ({
      ...(await fixture.service.loadSubgraphTarget({
        projectId: project.metadata.id,
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
  assert.equal(files.get(bundle.manifest.artifacts[0]!.project.path), publishedContents);
  assert.notEqual(files.get(bundle.manifest.artifacts[0]!.project.path), savedContents);
  await bundle.verify();

  workflow.current_draft_revision_id = 'replacement-revision';
  const nextRun = await fixture.service.loadSubgraphTarget({ projectId: project.metadata.id, version: 'latest' });
  assert.equal(latest.project.metadata.title, 'Saved target');
  assert.equal(nextRun.project.metadata.title, 'Published target');
  assert.equal(nextRun.revisionKey, 'managed:replacement-revision');

  workflow.published_revision_id = null;
  await assert.rejects(
    fixture.service.loadSubgraphTarget({ projectId: project.metadata.id, version: 'published' }),
    /no published version/,
  );
});
