import assert from 'node:assert/strict';
import test from 'node:test';
import type { Project } from '@valerypopoff/rivet2-core';
import {
  resolveHostedProjectMetadataUpdatesForPathMoves,
  resolveHostedProjectTitleFromPath,
  resolveHostedProjectTitle,
  withHostedProjectTitle,
} from '../dashboard/openedProjectMetadata';

function makeProject(title: string | undefined): Project {
  return {
    metadata: {
      id: 'project-1' as Project['metadata']['id'],
      title: title as string,
      description: '',
    },
    graphs: {},
  };
}

test('resolveHostedProjectTitle prefers a normal hosted project path title', () => {
  assert.equal(resolveHostedProjectTitle(makeProject('Billing Flow'), '/workflows/Renamed Flow.rivet-project'), 'Renamed Flow');
});

test('resolveHostedProjectTitle falls back to the project filename when metadata title is missing', () => {
  assert.equal(resolveHostedProjectTitle(makeProject(undefined), '/workflows/published-demo.rivet-project'), 'published-demo');
  assert.equal(resolveHostedProjectTitle(makeProject('   '), 'D:\\Programming\\workflows\\Windows Demo.rivet-project'), 'Windows Demo');
  assert.equal(resolveHostedProjectTitle(makeProject('undefined'), '/workflows/bad-title.rivet-project'), 'bad-title');
  assert.equal(resolveHostedProjectTitle(makeProject('null'), '/workflows/null-title.rivet-project'), 'null-title');
});

test('resolveHostedProjectTitle preserves metadata titles for virtual project paths', () => {
  assert.equal(resolveHostedProjectTitle(makeProject('Recorded Run'), 'recording://run-1/replay.rivet-project'), 'Recorded Run');
  assert.equal(
    resolveHostedProjectTitle(makeProject('Published Snapshot'), 'published-version-preview://Project/version/replay.rivet-project'),
    'Published Snapshot',
  );
});

test('resolveHostedProjectTitleFromPath resolves the file-tree project title without consulting metadata', () => {
  assert.equal(resolveHostedProjectTitleFromPath('/workflows/My Flow.rivet-project'), 'My Flow');
  assert.equal(resolveHostedProjectTitleFromPath('D:\\Programming\\workflows\\Windows Demo.rivet-project'), 'Windows Demo');
  assert.equal(resolveHostedProjectTitleFromPath('/workflows/No Extension'), 'No Extension');
  assert.equal(resolveHostedProjectTitleFromPath('/workflows/readme.md'), 'readme.md');
  assert.equal(resolveHostedProjectTitleFromPath('   '), null);
  assert.equal(resolveHostedProjectTitleFromPath(null), null);
});

test('withHostedProjectTitle normalizes project metadata titles from normal hosted paths', () => {
  const titledProject = makeProject('Already Named');
  const fallbackProject = makeProject(undefined);

  assert.equal(withHostedProjectTitle(titledProject, '/workflows/renamed.rivet-project').metadata.title, 'renamed');
  assert.equal(withHostedProjectTitle(fallbackProject, '/workflows/fallback.rivet-project').metadata.title, 'fallback');
});

test('withHostedProjectTitle preserves metadata titles for virtual project paths', () => {
  const titledProject = makeProject('Recorded Run');

  assert.equal(withHostedProjectTitle(titledProject, 'recording://run-1/replay.rivet-project'), titledProject);
});

test('resolveHostedProjectMetadataUpdatesForPathMoves finds open project renames', () => {
  const current = {
    openedProjects: {
      'project-1': {
        title: 'Old Name',
        fsPath: '/managed/workflows/Old Name.rivet-project',
      },
      'project-2': {
        title: 'Other',
        fsPath: '/managed/workflows/Other.rivet-project',
      },
    },
    openedProjectsSortedIds: ['project-1', 'project-2'],
  };

  const result = resolveHostedProjectMetadataUpdatesForPathMoves(current, [
    {
      fromAbsolutePath: '/managed/workflows/Old Name.rivet-project',
      toAbsolutePath: '/managed/workflows/New Name.rivet-project',
    },
  ]);

  assert.deepEqual(result, [
    {
      projectId: 'project-1',
      path: '/managed/workflows/New Name.rivet-project',
      title: 'New Name',
    },
  ]);
});

test('resolveHostedProjectMetadataUpdatesForPathMoves also handles already-retargeted paths', () => {
  const current = {
    openedProjects: {
      'project-1': {
        title: 'Old Name',
        fsPath: '/managed/workflows/New Name.rivet-project',
      },
    },
  };

  const result = resolveHostedProjectMetadataUpdatesForPathMoves(current, [
    {
      fromAbsolutePath: '/managed/workflows/Old Name.rivet-project',
      toAbsolutePath: '/managed/workflows/New Name.rivet-project',
    },
  ]);

  assert.deepEqual(result, [
    {
      projectId: 'project-1',
      path: '/managed/workflows/New Name.rivet-project',
      title: 'New Name',
    },
  ]);
});

test('resolveHostedProjectMetadataUpdatesForPathMoves emits path-only updates for folder moves', () => {
  const current = {
    openedProjects: {
      'project-1': {
        title: 'Current Name',
        fsPath: '/managed/workflows/Folder/Current Name.rivet-project',
      },
    },
  };

  const result = resolveHostedProjectMetadataUpdatesForPathMoves(current, [
    {
      fromAbsolutePath: '/managed/workflows/Folder/Current Name.rivet-project',
      toAbsolutePath: '/managed/workflows/Renamed Folder/Current Name.rivet-project',
    },
  ]);

  assert.deepEqual(result, [
    {
      projectId: 'project-1',
      path: '/managed/workflows/Renamed Folder/Current Name.rivet-project',
      title: undefined,
    },
  ]);
});

test('resolveHostedProjectMetadataUpdatesForPathMoves matches native Windows move paths against normalized editor paths', () => {
  const current = {
    openedProjects: {
      'project-1': {
        title: 'Current Name',
        fsPath: 'F:/Programming/workflows/Folder/Current Name.rivet-project',
      },
    },
  };

  const result = resolveHostedProjectMetadataUpdatesForPathMoves(current, [
    {
      fromAbsolutePath: 'F:\\Programming\\workflows\\Folder\\Current Name.rivet-project',
      toAbsolutePath: 'F:\\Programming\\workflows\\Renamed Folder\\Current Name.rivet-project',
    },
  ]);

  assert.deepEqual(result, [
    {
      projectId: 'project-1',
      path: 'F:\\Programming\\workflows\\Renamed Folder\\Current Name.rivet-project',
      title: undefined,
    },
  ]);
});

test('resolveHostedProjectMetadataUpdatesForPathMoves ignores virtual project paths', () => {
  const current = {
    openedProjects: {
      'project-1': {
        title: 'Recorded Run',
        fsPath: 'recording://run-1/replay.rivet-project',
      },
    },
  };

  const result = resolveHostedProjectMetadataUpdatesForPathMoves(current, [
    {
      fromAbsolutePath: 'recording://run-1/replay.rivet-project',
      toAbsolutePath: 'recording://run-2/replay.rivet-project',
    },
  ]);

  assert.deepEqual(result, []);
});
