import assert from 'node:assert/strict';
import test from 'node:test';
import { memoryStorage, initializeHybridStorage } from '../../app/src/state/storage/migrations.js';
import { WorkspaceRecoveryStorage } from '../../app/src/state/storage/workspaceRecovery.js';
import { MemoryAsyncStorage } from '../../app/src/state/storage/indexedDB.js';

// A shared test host persists between recreated recovery writers. The actual
// memory-only browser fallback must not advertise that guarantee.
class PersistentTestStorage extends MemoryAsyncStorage {
  override readonly persistsAcrossReload: boolean = true;
}

type SessionStorageLike = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

function createSessionStorage(): SessionStorageLike {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => {
      values.delete(key);
    },
  };
}

Object.defineProperty(globalThis, 'window', {
  configurable: true,
  value: { localStorage: createSessionStorage(), sessionStorage: createSessionStorage() },
});

const revisions = await import('../io/hostedProjectRevisionTracker.js');

const path = '/workflows/Project.rivet-project';
const observe = (revisionId: string, projectId = 'project-1') =>
  revisions.observeHostedProjectRevision({
    projectId,
    path,
    revisionId,
  });
const snapshot = () => revisions.getHostedProjectConflictSnapshot([{ projectId: 'project-1', title: 'Project' }]);

test('a delayed pre-save tree cannot create a remote conflict after our save', () => {
  revisions.bindHostedProjectRevision('project-1', path, 'before');
  const context = revisions.captureHostedProjectReconciliation(['project-1']);
  const finish = revisions.beginHostedProjectSave('project-1');
  revisions.bindHostedProjectRevision('project-1', path, 'ours');
  finish();
  assert.equal(revisions.claimHostedProjectObservation(context, 'project-1'), 'retry');
  assert.equal(revisions.getHostedProjectPendingRevision('project-1'), null);
  const fresh = revisions.captureHostedProjectReconciliation(['project-1']);
  assert.equal(revisions.claimHostedProjectObservation(fresh, 'project-1'), 'applied');
  assert.equal(observe('ours'), null);
  assert.doesNotThrow(() => revisions.assertHostedProjectRevisionCanSave('project-1'));
});

test('save-in-flight excludes only its project and settlement requests a fresh observation', () => {
  revisions.bindHostedProjectRevision('project-1', path, 'before');
  revisions.bindHostedProjectRevision('project-2', '/workflows/Other.rivet-project', 'other');
  const old = revisions.captureHostedProjectReconciliation(['project-1', 'project-2']);
  const finish = revisions.beginHostedProjectSave('project-1');
  assert.equal(revisions.claimHostedProjectObservation(old, 'project-1'), 'waiting-for-save');
  assert.equal(revisions.claimHostedProjectObservation(old, 'project-2'), 'applied');
  const during = revisions.captureHostedProjectReconciliation(['project-1', 'project-2']);
  assert.deepEqual(
    during.projects.map((project) => project.projectId),
    ['project-2'],
  );
  const beforeFinish = snapshot().recheckSequence;
  // Failed saves release the fence without rebinding the accepted revision.
  finish();
  assert.ok(snapshot().recheckSequence > beforeFinish);
  assert.equal(revisions.getHostedProjectExpectedRevision('project-1', path), 'before');
  const afterFinish = snapshot();
  finish();
  const repeated = snapshot();
  assert.equal(repeated.recheckSequence, afterFinish.recheckSequence);
  assert.deepEqual(repeated.contentChanges, afterFinish.contentChanges);
  assert.equal(revisions.claimHostedProjectObservation(during, 'project-1'), 'retry');
});

test('accepted revisions belong to the atomic workspace recovery, never independent browser caches', () => {
  revisions.bindHostedProjectRevision('document-project', path, 'document-revision');
  assert.equal(window.localStorage.getItem('rivet.hosted-project-revisions.v1'), null);
  assert.equal(window.sessionStorage.getItem('rivet.hosted-project-revisions.v1'), null);
  assert.ok(
    memoryStorage
      .get('project')
      .hostedProjectRevisions.some(
        (entry: { acceptedRevisionId: string }) => entry.acceptedRevisionId === 'document-revision',
      ),
  );
});

test('an unchanged tree observation does not dirty browser recovery', () => {
  revisions.bindHostedProjectRevision('project-1', path, 'unchanged');
  const before = memoryStorage.get('project').hostedProjectRevisions;
  assert.equal(observe('unchanged'), null);
  assert.equal(memoryStorage.get('project').hostedProjectRevisions, before);
  observe('changed');
  assert.notEqual(memoryStorage.get('project').hostedProjectRevisions, before);
  assert.equal(before.find((entry: { projectId: string }) => entry.projectId === 'project-1')?.pendingRevisionId, null);
});

test('a new load retains provisional authority until its actual tab is registered', () => {
  const id = 'loading-project';
  revisions.bindHostedProjectRevision(id, path, 'loaded', { awaitingActivation: true });
  revisions.pruneHostedProjectRevisions(['loading-placeholder']);
  assert.equal(revisions.getHostedProjectExpectedRevision(id, path), 'loaded');
  assert.equal(
    memoryStorage.get('project').hostedProjectRevisions.some((entry: { projectId: string }) => entry.projectId === id),
    false,
  );
  revisions.pruneHostedProjectRevisions([id]);
  assert.equal(
    memoryStorage.get('project').hostedProjectRevisions.find((entry: { projectId: string }) => entry.projectId === id)
      ?.acceptedRevisionId,
    'loaded',
  );
  revisions.pruneHostedProjectRevisions([]);
  assert.equal(revisions.getHostedProjectRevisionState(id), null);
});

test('recovery restores its own authority and never adopts separately saved newer revisions', async () => {
  const revisionKey = 'rivet.hosted-project-revisions.v1';
  const previousGroup = memoryStorage.get('project');
  const backend = new PersistentTestStorage();
  const source = new WorkspaceRecoveryStorage(
    backend,
    () => ({
      project: {
        hostedProjectRevisions: [
          { projectId: 'recovered', path, acceptedRevisionId: 'checkpoint', pendingRevisionId: null },
        ],
      },
    }),
    { session: window.sessionStorage, id: 'selected' },
  );
  await source.setItem('project', '{}');
  try {
    const wrongAuthority = JSON.stringify([
      { projectId: 'recovered', path, acceptedRevisionId: 'wrong-workspace', pendingRevisionId: null },
    ]);
    window.sessionStorage.setItem(revisionKey, wrongAuthority);
    window.localStorage.setItem(revisionKey, wrongAuthority);
    memoryStorage.set('project', { hostedProjectRevisions: JSON.parse(wrongAuthority) });
    const restored = new WorkspaceRecoveryStorage(backend, () => ({}), {
      session: window.sessionStorage,
      id: 'restored',
    });
    await initializeHybridStorage('project', restored);
    const modulePath = '../io/hostedProjectRevisionTracker.js?selected-recovery-test';
    const isolated: typeof revisions = await import(modulePath);
    assert.equal(isolated.getHostedProjectExpectedRevision('recovered', path), 'checkpoint');
    isolated.observeHostedProjectRevision({ projectId: 'recovered', path, revisionId: 'latest' });
    assert.throws(
      () => isolated.assertHostedProjectRevisionCanSave('recovered'),
      isolated.HostedProjectRemoteChangePendingError,
    );
  } finally {
    window.sessionStorage.removeItem(revisionKey);
    window.sessionStorage.removeItem('rivet-workspace-recovery-v1');
    window.localStorage.removeItem(revisionKey);
    memoryStorage.set('project', previousGroup);
  }
});

test('missing recovered revision authority requires review instead of adopting the latest tree revision', () => {
  revisions.pruneHostedProjectRevisions([]);
  assert.throws(() => revisions.assertHostedProjectRevisionCanSave('unknown'), /unknown/);
  assert.deepEqual(observe('newest', 'unknown'), { projectId: 'unknown', path, revisionId: 'newest' });
  assert.equal(revisions.getHostedProjectExpectedRevision('unknown', path), null);
  assert.throws(
    () => revisions.assertHostedProjectRevisionCanSave('unknown'),
    revisions.HostedProjectRemoteChangePendingError,
  );
  assert.equal(revisions.acceptHostedProjectRemoteRevision('unknown', path, 'newest'), true);
  assert.equal(revisions.getHostedProjectExpectedRevision('unknown', path), 'newest');
  assert.doesNotThrow(() => revisions.assertHostedProjectRevisionCanSave('unknown'));
});

test('a genuine edit following our save is detected by the retry', () => {
  revisions.bindHostedProjectRevision('project-1', path, 'ours');
  const context = revisions.captureHostedProjectReconciliation(['project-1']);
  assert.equal(revisions.claimHostedProjectObservation(context, 'project-1'), 'applied');
  observe('theirs');
  assert.throws(() => revisions.assertHostedProjectRevisionCanSave('project-1'));
  assert.equal(snapshot().contentChanges[0]?.revisionId, 'theirs');
});

test('matching accepted content clears a pending conflict; older observations cannot clear newer conflicts', () => {
  revisions.bindHostedProjectRevision('project-1', path, 'ours');
  const old = revisions.captureHostedProjectReconciliation(['project-1']);
  const newer = revisions.captureHostedProjectReconciliation(['project-1']);
  assert.equal(revisions.claimHostedProjectObservation(newer, 'project-1'), 'applied');
  observe('theirs');
  assert.equal(revisions.claimHostedProjectObservation(old, 'project-1'), 'retry');
  assert.equal(revisions.claimHostedProjectObservation(newer, 'project-1'), 'retry');
  const fresh = revisions.captureHostedProjectReconciliation(['project-1']);
  assert.equal(revisions.claimHostedProjectObservation(fresh, 'project-1'), 'applied');
  observe('ours');
  assert.deepEqual(snapshot().contentChanges, []);
  assert.doesNotThrow(() => revisions.assertHostedProjectRevisionCanSave('project-1'));
});

test('conflict identity survives repeats but changes when a revision returns after another conflict', () => {
  revisions.bindHostedProjectRevision('project-1', path, 'ours');
  observe('old-version');
  const first = snapshot().contentChanges[0]!;
  observe('old-version');
  assert.equal(snapshot().contentChanges[0]?.changeId, first.changeId);
  observe('new-version');
  observe('old-version');
  assert.notEqual(snapshot().contentChanges[0]?.changeId, first.changeId);
  assert.equal(revisions.matchesHostedProjectConflict('project-1', path, 'old-version', first.changeId), false);
  assert.equal(revisions.getHostedProjectPendingRevision('project-1'), 'old-version');
});

test('presentation-only title changes publish a newer snapshot without replacing the conflict identity', () => {
  revisions.bindHostedProjectRevision('project-1', path, 'ours');
  observe('theirs');
  const before = revisions.getHostedProjectConflictSnapshot([{ projectId: 'project-1', title: 'Old title' }]);
  const after = revisions.getHostedProjectConflictSnapshot([{ projectId: 'project-1', title: 'New title' }]);
  assert.ok(after.sequence > before.sequence);
  assert.equal(after.contentChanges[0]?.title, 'New title');
  assert.equal(after.contentChanges[0]?.changeId, before.contentChanges[0]?.changeId);
  assert.equal(after.recheckSequence, before.recheckSequence);
});

test('close/reopen and failed reload restoration never resurrect observation generations', () => {
  revisions.bindHostedProjectRevision('project-1', path, 'ours');
  observe('theirs');
  const beforeReload = revisions.captureHostedProjectReconciliation(['project-1']);
  const finish = revisions.beginHostedProjectReload('project-1');
  revisions.bindHostedProjectRevision('project-1', path, 'theirs');
  assert.equal(
    memoryStorage
      .get('project')
      .hostedProjectRevisions.find((entry: { projectId: string }) => entry.projectId === 'project-1')
      ?.acceptedRevisionId,
    'ours',
  );
  finish(false);
  assert.equal(revisions.claimHostedProjectObservation(beforeReload, 'project-1'), 'retry');
  const beforeClose = revisions.captureHostedProjectReconciliation(['project-1']);
  revisions.pruneHostedProjectRevisions([]);
  assert.deepEqual(snapshot().contentChanges, []);
  revisions.bindHostedProjectRevision('project-1', path, 'ours');
  assert.equal(revisions.claimHostedProjectObservation(beforeClose, 'project-1'), 'retry');
  const context = revisions.captureHostedProjectReconciliation(['project-1']);
  assert.equal(
    revisions.claimHostedProjectObservation({ ...context, editorInstanceId: 'previous-editor' }, 'project-1'),
    'retry',
  );
});

test('reload keeps the displayed conflict until replacement settles and rollback remains protected', () => {
  revisions.bindHostedProjectRevision('project-1', path, 'ours');
  observe('theirs');
  const conflict = snapshot().contentChanges[0]!;
  const observation = revisions.captureHostedProjectReconciliation(['project-1']);
  const finish = revisions.beginHostedProjectReload('project-1');
  revisions.bindHostedProjectRevision('project-1', path, 'theirs');
  assert.deepEqual(snapshot().contentChanges, [conflict]);
  assert.throws(() => revisions.assertHostedProjectRevisionCanSave('project-1'));
  assert.equal(revisions.claimHostedProjectObservation(observation, 'project-1'), 'waiting-for-save');
  finish(false);
  const settled = snapshot();
  finish();
  const repeated = snapshot();
  assert.equal(repeated.recheckSequence, settled.recheckSequence);
  assert.deepEqual(repeated.contentChanges, settled.contentChanges);
  assert.equal(settled.contentChanges[0]?.revisionId, 'theirs');
  assert.notEqual(settled.contentChanges[0]?.changeId, conflict.changeId);
  assert.throws(() => revisions.assertHostedProjectRevisionCanSave('project-1'));
  assert.equal(revisions.claimHostedProjectObservation(observation, 'project-1'), 'retry');
});

test('remote project revisions require an explicit reload or keep-mine choice before saving', () => {
  revisions.pruneHostedProjectRevisions([]);
  revisions.bindHostedProjectRevision('project-1', '/workflows/Project.rivet-project', 'revision-1');

  assert.equal(
    revisions.observeHostedProjectRevision({
      projectId: 'project-1',
      path: '/workflows/Project.rivet-project',
      revisionId: 'revision-1',
    }),
    null,
  );
  const remoteChange = revisions.observeHostedProjectRevision({
    projectId: 'project-1',
    path: '/workflows/Project.rivet-project',
    revisionId: 'revision-2',
  });
  assert.deepEqual(remoteChange, {
    projectId: 'project-1',
    path: '/workflows/Project.rivet-project',
    revisionId: 'revision-2',
  });
  assert.equal(
    revisions.getHostedProjectExpectedRevision('project-1', '/workflows/Project.rivet-project'),
    'revision-1',
  );
  assert.equal(revisions.getHostedProjectPendingRevision('project-1'), 'revision-2');
  assert.throws(
    () => revisions.assertHostedProjectRevisionCanSave('project-1'),
    revisions.HostedProjectRemoteChangePendingError,
  );

  assert.equal(
    revisions.acceptHostedProjectRemoteRevision('project-1', '/workflows/Project.rivet-project', 'revision-2'),
    true,
  );
  assert.equal(
    revisions.getHostedProjectExpectedRevision('project-1', '/workflows/Project.rivet-project'),
    'revision-2',
  );
  assert.equal(revisions.getHostedProjectPendingRevision('project-1'), null);
  assert.doesNotThrow(() => revisions.assertHostedProjectRevisionCanSave('project-1'));
});

test('rejected reload restores authority while retaining a concurrent path move', () => {
  revisions.pruneHostedProjectRevisions([]);
  revisions.bindHostedProjectRevision('project-1', path, 'ours');
  observe('theirs');
  const finish = revisions.beginHostedProjectReload('project-1');
  assert.throws(() => revisions.beginHostedProjectSave('project-1'), /finish reloading/);
  revisions.bindHostedProjectRevision('project-1', path, 'theirs');
  const moved = '/workflows/Moved/Project.rivet-project';
  revisions.remapHostedProjectRevisionPaths([{ fromAbsolutePath: path, toAbsolutePath: moved }]);
  finish(false);
  assert.deepEqual(revisions.getHostedProjectRevisionState('project-1'), {
    projectId: 'project-1',
    path: moved,
    acceptedRevisionId: 'ours',
    pendingRevisionId: 'theirs',
  });
  assert.throws(() => revisions.assertHostedProjectRevisionCanSave('project-1'));
});

test('rejected reload does not resurrect a tab whose revision was pruned during IO', () => {
  revisions.pruneHostedProjectRevisions([]);
  revisions.bindHostedProjectRevision('project-1', path, 'ours');
  const finish = revisions.beginHostedProjectReload('project-1');
  revisions.bindHostedProjectRevision('project-1', path, 'candidate');
  revisions.pruneHostedProjectRevisions([]);
  finish(false);
  assert.equal(revisions.getHostedProjectRevisionState('project-1'), null);
});

test('a move keeps the accepted revision bound to the same immutable project', () => {
  revisions.pruneHostedProjectRevisions([]);
  revisions.bindHostedProjectRevision('project-1', '/workflows/Original.rivet-project', 'revision-1');

  assert.equal(
    revisions.observeHostedProjectRevision({
      projectId: 'project-1',
      path: '/workflows/Moved/Original.rivet-project',
      revisionId: 'revision-1',
    }),
    null,
  );
  assert.equal(
    revisions.getHostedProjectExpectedRevision('project-1', '/workflows/Moved/Original.rivet-project'),
    'revision-1',
  );
  assert.equal(revisions.getHostedProjectPendingRevision('project-1'), null);
});

test('a move accompanied by a new saved revision cannot authorize overwriting remote content', () => {
  revisions.pruneHostedProjectRevisions([]);
  const movedPath = '/workflows/Moved/Project.rivet-project';
  revisions.bindHostedProjectRevision('project-1', path, 'revision-1');
  const change = revisions.observeHostedProjectRevision({
    projectId: 'project-1',
    path: movedPath,
    revisionId: 'revision-2',
  });
  assert.equal(change?.revisionId, 'revision-2');
  assert.equal(revisions.getHostedProjectExpectedRevision('project-1', movedPath), 'revision-1');
  assert.equal(revisions.getHostedProjectPendingRevision('project-1'), 'revision-2');
  assert.throws(() => revisions.assertHostedProjectRevisionCanSave('project-1'));
});

test('a failed candidate reload restores the prior pending remote-version decision', () => {
  revisions.pruneHostedProjectRevisions([]);
  revisions.bindHostedProjectRevision('project-1', '/workflows/Project.rivet-project', 'revision-1');
  revisions.observeHostedProjectRevision({
    projectId: 'project-1',
    path: '/workflows/Project.rivet-project',
    revisionId: 'revision-2',
  });
  const finish = revisions.beginHostedProjectReload('project-1');

  revisions.bindHostedProjectRevision('project-1', '/workflows/Project.rivet-project', 'revision-2');
  finish(false);

  assert.equal(
    revisions.getHostedProjectExpectedRevision('project-1', '/workflows/Project.rivet-project'),
    'revision-1',
  );
  assert.equal(revisions.getHostedProjectPendingRevision('project-1'), 'revision-2');
  assert.throws(
    () => revisions.assertHostedProjectRevisionCanSave('project-1'),
    revisions.HostedProjectRemoteChangePendingError,
  );
});

test('a later remote move refreshes an already-pending change notification', () => {
  revisions.pruneHostedProjectRevisions([]);
  revisions.bindHostedProjectRevision('project-1', '/workflows/Project.rivet-project', 'revision-1');
  revisions.observeHostedProjectRevision({
    projectId: 'project-1',
    path: '/workflows/Project.rivet-project',
    revisionId: 'revision-2',
  });

  assert.deepEqual(
    revisions.observeHostedProjectRevision({
      projectId: 'project-1',
      path: '/workflows/Moved/Project.rivet-project',
      revisionId: 'revision-3',
    }),
    {
      projectId: 'project-1',
      path: '/workflows/Moved/Project.rivet-project',
      revisionId: 'revision-3',
    },
  );
  assert.equal(
    revisions.getHostedProjectExpectedRevision('project-1', '/workflows/Moved/Project.rivet-project'),
    'revision-1',
  );
  assert.equal(revisions.getHostedProjectPendingRevision('project-1'), 'revision-3');
});
