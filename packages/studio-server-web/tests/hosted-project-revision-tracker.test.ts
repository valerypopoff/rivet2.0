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

test('remote project revisions require an explicit reload or keep-mine choice before saving', () => {
  revisions.pruneHostedProjectRevisions([]);
  revisions.bindHostedProjectRevision('project-1', '/workflows/Project.rivet-project', 'revision-1');

  assert.equal(
    revisions.observeHostedProjectRevision({
      projectId: 'project-1',
      path: '/workflows/Project.rivet-project',
      revisionId: 'revision-1',
      structuralChange: false,
    }),
    null,
  );
  const remoteChange = revisions.observeHostedProjectRevision({
    projectId: 'project-1',
    path: '/workflows/Project.rivet-project',
    revisionId: 'revision-2',
    structuralChange: false,
  });
  assert.deepEqual(remoteChange, {
    projectId: 'project-1',
    path: '/workflows/Project.rivet-project',
    revisionId: 'revision-2',
  });
  assert.equal(revisions.getHostedProjectExpectedRevision('project-1', '/workflows/Project.rivet-project'), 'revision-1');
  assert.equal(revisions.getHostedProjectPendingRevision('project-1'), 'revision-2');
  assert.throws(
    () => revisions.assertHostedProjectRevisionCanSave('project-1'),
    revisions.HostedProjectRemoteChangePendingError,
  );

  assert.equal(
    revisions.acceptHostedProjectRemoteRevision('project-1', '/workflows/Project.rivet-project', 'revision-2'),
    true,
  );
  assert.equal(revisions.getHostedProjectExpectedRevision('project-1', '/workflows/Project.rivet-project'), 'revision-2');
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
      revisionId: 'revision-2',
      structuralChange: true,
    }),
    null,
  );
  assert.equal(
    revisions.getHostedProjectExpectedRevision('project-1', '/workflows/Moved/Original.rivet-project'),
    'revision-2',
  );
  assert.equal(revisions.getHostedProjectPendingRevision('project-1'), null);
});

test('a failed candidate reload restores the prior pending remote-version decision', () => {
  revisions.pruneHostedProjectRevisions([]);
  revisions.bindHostedProjectRevision('project-1', '/workflows/Project.rivet-project', 'revision-1');
  revisions.observeHostedProjectRevision({
    projectId: 'project-1',
    path: '/workflows/Project.rivet-project',
    revisionId: 'revision-2',
    structuralChange: false,
  });
  const beforeCandidateReload = revisions.getHostedProjectRevisionState('project-1');

  revisions.bindHostedProjectRevision('project-1', '/workflows/Project.rivet-project', 'revision-2');
  revisions.restoreHostedProjectRevisionState('project-1', beforeCandidateReload);

  assert.equal(revisions.getHostedProjectExpectedRevision('project-1', '/workflows/Project.rivet-project'), 'revision-1');
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
    structuralChange: false,
  });

  assert.deepEqual(
    revisions.observeHostedProjectRevision({
      projectId: 'project-1',
      path: '/workflows/Moved/Project.rivet-project',
      revisionId: 'revision-3',
      structuralChange: true,
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
