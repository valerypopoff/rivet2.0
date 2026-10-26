import assert from 'node:assert/strict';
import test from 'node:test';
import { applyFolderMoveToTree, reconcileExpandedFolders } from '../dashboard/workflowTreeOps.js';
import type { WorkflowFolderItem, WorkflowProjectItem } from '../dashboard/types.js';

function folder(relativePath: string, bundleId: string | null = null): WorkflowFolderItem {
  return {
    id: relativePath,
    name: relativePath.split('/').at(-1)!,
    relativePath,
    absolutePath: `/workflows/${relativePath}`,
    updatedAt: '',
    bundleId,
    folders: [],
    projects: [],
  };
}

function project(relativePath: string, bundleId: string | null): WorkflowProjectItem {
  return {
    id: relativePath,
    name: 'Project',
    relativePath,
    absolutePath: `/workflows/${relativePath}`,
    bundleId,
  } as WorkflowProjectItem;
}

test('managed expansion follows identity through moves, not old paths or replacements', () => {
  const old = { ...folder('Old'), namespaceId: 'kept' };
  old.folders = [{ ...folder('Old/Closed'), namespaceId: 'closed' }];
  const moved = { ...folder('New'), namespaceId: 'kept' };
  moved.folders = [{ ...folder('New/Closed'), namespaceId: 'closed' }];
  const replacement = { ...folder('Old'), namespaceId: 'replacement' };
  const legacy = folder('Legacy');
  const expanded = { Old: true, 'Old/Closed': false, Legacy: true, Removed: true };
  const next = reconcileExpandedFolders(expanded, [old, legacy], [moved, replacement, legacy]);
  assert.deepEqual(next, { New: true, 'New/Closed': false, Old: false, Legacy: true });
  assert.equal(expanded.Old, true);
  assert.equal(reconcileExpandedFolders(next, [moved, replacement, legacy], [moved, replacement, legacy]), next);
});

for (const [from, to] of [
  [null, 'one'],
  ['one', null],
  ['one', 'two'],
] as const) {
  test(`folder move rebinds every descendant from bundle ${from} to ${to} before refresh`, () => {
    const origin = folder('Origin', from),
      destination = folder('Destination', to);
    const source = folder('Origin/Moved'),
      nested = folder('Origin/Moved/Nested');
    source.projects.push(project('Origin/Moved/Root.rivet-project', from));
    nested.projects.push(project('Origin/Moved/Nested/Child.rivet-project', from));
    source.folders.push(nested);
    origin.folders.push(source);
    destination.projects.push(project('Destination/Existing.rivet-project', to));
    const folders = [origin, destination];
    const before = structuredClone(folders);
    const result = applyFolderMoveToTree(folders, [], source, folder('Destination/Moved'));
    const moved = result.folders[1]!.folders[0]!;
    assert.equal(moved.projects[0]!.bundleId, to);
    assert.equal(moved.folders[0]!.projects[0]!.bundleId, to);
    assert.equal(moved.projects[0]!.absolutePath, '/workflows/Destination/Moved/Root.rivet-project');
    assert.equal(result.folders[1]!.projects[0]!.bundleId, to);
    assert.deepEqual(folders, before, 'optimistic updates do not mutate the previous tree');
  });
}

test('moving an ordinary ancestor preserves nested bundle identities and excludes prefix-sharing siblings', () => {
  const source = folder('Parent'),
    nested = folder('Parent/Feature', 'own');
  nested.projects.push(project('Parent/Feature/Member.rivet-project', 'own'));
  source.folders.push(nested);
  source.projects.push(project('Parent/Ordinary.rivet-project', null));
  const unrelated = folder('Target sibling', 'other'),
    target = folder('Target');
  const result = applyFolderMoveToTree([source, unrelated, target], [], source, folder('Target/Parent'));
  const moved = result.folders.find((item) => item.relativePath === 'Target')!.folders[0]!;
  assert.equal(moved.projects[0]!.bundleId, null);
  assert.equal(moved.folders[0]!.bundleId, 'own');
  assert.equal(moved.folders[0]!.projects[0]!.bundleId, 'own');
});

test('moving a bundle to the library root retains its own identity and member bindings', () => {
  const parent = folder('Parent'),
    source = folder('Parent/Feature', 'own');
  source.projects.push(project('Parent/Feature/Member.rivet-project', 'own'));
  parent.folders.push(source);
  const moved = applyFolderMoveToTree([parent], [], source, folder('Feature', 'own')).folders[1]!;
  assert.equal(moved.bundleId, 'own');
  assert.equal(moved.projects[0]!.bundleId, 'own');
});

test('rename uses returned container identity if a concurrent conversion changed it', () => {
  const source = folder('Feature', 'old');
  source.projects.push(project('Feature/Member.rivet-project', 'old'));
  const renamed = applyFolderMoveToTree([source], [], source, folder('Renamed')).folders[0]!;
  assert.equal(renamed.bundleId, null);
  assert.equal(renamed.projects[0]!.bundleId, null);
});
