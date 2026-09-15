import assert from 'node:assert/strict';
import test from 'node:test';

type SessionStorageLike = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

function createSessionStorage(): SessionStorageLike {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
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
  const savedState = revisions.getHostedProjectRevisionState('project-1');
  const beforeReload = revisions.captureHostedProjectReconciliation(['project-1']);
  revisions.bindHostedProjectRevision('project-1', path, 'theirs');
  revisions.restoreHostedProjectRevisionState('project-1', savedState);
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
  const before = revisions.getHostedProjectRevisionState('project-1');
  const observation = revisions.captureHostedProjectReconciliation(['project-1']);
  const finish = revisions.beginHostedProjectReload('project-1');
  revisions.bindHostedProjectRevision('project-1', path, 'theirs');
  assert.deepEqual(snapshot().contentChanges, [conflict]);
  assert.throws(() => revisions.assertHostedProjectRevisionCanSave('project-1'));
  assert.equal(revisions.claimHostedProjectObservation(observation, 'project-1'), 'waiting-for-save');
  revisions.restoreHostedProjectRevisionState('project-1', before);
  finish();
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
  const beforeCandidateReload = revisions.getHostedProjectRevisionState('project-1');

  revisions.bindHostedProjectRevision('project-1', '/workflows/Project.rivet-project', 'revision-2');
  revisions.restoreHostedProjectRevisionState('project-1', beforeCandidateReload);

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
