import assert from 'node:assert/strict';
import test from 'node:test';
import type { ExecutionRecorder, ProjectId } from '@valerypopoff/rivet2-core';
import { createStore } from 'jotai/vanilla';
import {
  activateLoadedRecordingState,
  canChangeLoadedRecordingForTab,
  canUnloadCurrentProjectRecordingState,
  clearLoadedRecordingForPathState,
  clearLoadedRecordingForTabState,
  currentProjectLoadedRecordingState,
  getLoadedRecordingForTab,
  isCurrentLoadedRecordingForTab,
  isLoadedRecordingOwnedByTab,
  isRecordingProjectState,
  loadedRecordingState,
  recordingPlaybackStartingState,
  recordingTabIndicatorsState,
  rebindLoadedRecordingPathState,
  type LoadedRecording,
} from './execution.js';
import { loadedProjectState, projectState } from './savedGraphs.js';

const projectA = 'project-a' as ProjectId;
const projectB = 'project-b' as ProjectId;
const recording: LoadedRecording = {
  path: 'C:/recordings/project-a.rivet-recording',
  projectId: projectA,
  projectPath: 'recording://project-a/replay.rivet-project',
  recorder: { events: [] } as unknown as ExecutionRecorder,
};

test('only recordings layered onto an ordinary owning project can be unloaded', () => {
  const store = createStore();
  const project = store.get(projectState);
  store.set(projectState, { ...project, metadata: { ...project.metadata, id: projectA } });
  for (const path of ['recording://run/replay.rivet-project', '/projects/a.rivet-project', null]) {
    store.set(loadedProjectState, { loaded: path != null, path });
    store.set(activateLoadedRecordingState, { ...recording, projectPath: path });
    assert.equal(store.get(canUnloadCurrentProjectRecordingState), !path?.startsWith('recording://'));
    store.set(loadedRecordingState, { ...recording, projectId: projectB, projectPath: path });
    assert.equal(store.get(canUnloadCurrentProjectRecordingState), false);
    store.set(loadedRecordingState, null);
    assert.equal(store.get(canUnloadCurrentProjectRecordingState), false);
  }
});

test('loaded recordings are visible only to their owning editor tab', () => {
  assert.equal(getLoadedRecordingForTab(recording, projectA, recording.projectPath), recording);
  assert.equal(getLoadedRecordingForTab(recording, projectA, 'C:/projects/project-a.rivet-project'), undefined);
  assert.equal(getLoadedRecordingForTab(recording, projectB, recording.projectPath), undefined);
  assert.equal(getLoadedRecordingForTab(recording, undefined, recording.projectPath), undefined);
  assert.equal(isLoadedRecordingOwnedByTab(recording, projectA, recording.projectPath), true);
  assert.equal(isLoadedRecordingOwnedByTab(recording, projectA, 'C:/projects/project-a.rivet-project'), false);
  assert.equal(isLoadedRecordingOwnedByTab(recording, projectB, recording.projectPath), false);
});

test('recording tab indicators retain original outcomes across selection, rebinding and exact-owner cleanup', () => {
  const store = createStore();
  const a = { ...recording, summary: { status: 'failed' as const, createdAt: '', durationMs: 0 } };
  const b = {
    ...recording,
    projectId: projectB,
    projectPath: '/b',
    summary: { status: 'succeeded' as const, createdAt: '', durationMs: 0 },
  };
  store.set(activateLoadedRecordingState, a);
  store.set(activateLoadedRecordingState, b);
  assert.equal(store.get(recordingTabIndicatorsState)[projectA]?.color, 'var(--error)');
  assert.equal(store.get(recordingTabIndicatorsState)[projectB]?.color, 'var(--success)');
  store.set(clearLoadedRecordingForTabState, { projectId: projectA, projectPath: '/wrong' });
  assert.ok(store.get(recordingTabIndicatorsState)[projectA]);
  store.set(clearLoadedRecordingForTabState, { projectId: projectA, projectPath: a.projectPath });
  assert.equal(store.get(recordingTabIndicatorsState)[projectA], undefined);
  assert.equal(store.get(loadedRecordingState), b);
  store.set(rebindLoadedRecordingPathState, { fromPath: '/b', toPath: '/moved-b' });
  assert.equal(store.get(recordingTabIndicatorsState)[projectB]?.projectPath, '/moved-b');
  store.set(clearLoadedRecordingForPathState, '/b');
  assert.ok(store.get(recordingTabIndicatorsState)[projectB]);
  store.set(clearLoadedRecordingForPathState, '/moved-b');
  assert.deepEqual(store.get(recordingTabIndicatorsState), {});
  assert.equal(store.get(loadedRecordingState), null);
  store.set(activateLoadedRecordingState, { ...a, summary: { ...a.summary, status: 'suspicious' } });
  assert.equal(store.get(recordingTabIndicatorsState)[projectA]?.color, 'var(--warning)');
  store.set(clearLoadedRecordingForPathState, a.projectPath);
  assert.deepEqual(store.get(recordingTabIndicatorsState), {});
});

test('missing recordings remain absent for every project', () => {
  assert.equal(getLoadedRecordingForTab(null, projectA, recording.projectPath), undefined);
});

test('saving a pathless recording tab rebinds only that project, not another pathless tab', () => {
  const store = createStore();
  store.set(activateLoadedRecordingState, { ...recording, projectPath: null });
  const selected = { ...recording, projectId: projectB, projectPath: null };
  store.set(activateLoadedRecordingState, selected);
  store.set(rebindLoadedRecordingPathState, { projectId: projectA, fromPath: null, toPath: '/a' });
  assert.equal(store.get(recordingTabIndicatorsState)[projectA]?.projectPath, '/a');
  assert.equal(store.get(recordingTabIndicatorsState)[projectB]?.projectPath, null);
  assert.equal(store.get(loadedRecordingState), selected);
  store.set(rebindLoadedRecordingPathState, { projectId: projectB, fromPath: null, toPath: '/b' });
  assert.equal(store.get(loadedRecordingState)?.projectPath, '/b');
});

test('only the owner can replace or unload a loaded recording', () => {
  assert.equal(canChangeLoadedRecordingForTab(recording, projectA, recording.projectPath), true);
  assert.equal(canChangeLoadedRecordingForTab(recording, projectA, 'C:/projects/project-a.rivet-project'), false);
  assert.equal(canChangeLoadedRecordingForTab(recording, projectB, recording.projectPath), false);
  assert.equal(canChangeLoadedRecordingForTab(null, projectB, recording.projectPath), true);
});

test('a stale playback cannot clear the starting state for a newer recording selection', () => {
  const replacement: LoadedRecording = {
    ...recording,
    path: 'C:/recordings/project-b.rivet-recording',
    projectId: projectB,
  };

  assert.equal(isCurrentLoadedRecordingForTab(recording, recording, projectA), true);
  assert.equal(isCurrentLoadedRecordingForTab(null, recording, projectA), false);
  assert.equal(isCurrentLoadedRecordingForTab(replacement, recording, projectA), false);
  assert.equal(isCurrentLoadedRecordingForTab(replacement, replacement, projectB), true);
});

test('activating a replacement recording resets a stale pre-start playback state', () => {
  const store = createStore();
  const replacement: LoadedRecording = {
    ...recording,
    path: 'C:/recordings/project-b.rivet-recording',
    projectId: projectB,
  };
  store.set(loadedRecordingState, recording);
  store.set(recordingPlaybackStartingState, true);

  store.set(activateLoadedRecordingState, replacement);

  assert.equal(store.get(loadedRecordingState), replacement);
  assert.equal(store.get(recordingPlaybackStartingState), false);
});

test('moving an owner tab rebinds its recording path and clears a stale pre-start playback state', () => {
  const store = createStore();
  const originalPath = 'C:/projects/project-a.rivet-project';
  const movedPath = 'C:/projects/Moved/project-a.rivet-project';
  const localRecording: LoadedRecording = {
    ...recording,
    projectPath: originalPath,
  };
  store.set(loadedRecordingState, localRecording);
  store.set(recordingPlaybackStartingState, true);

  assert.equal(
    store.set(rebindLoadedRecordingPathState, {
      fromPath: 'C:/projects/another-project.rivet-project',
      toPath: movedPath,
    }),
    false,
  );
  assert.equal(store.get(loadedRecordingState), localRecording);

  assert.equal(
    store.set(rebindLoadedRecordingPathState, {
      fromPath: originalPath,
      toPath: movedPath,
    }),
    true,
  );
  assert.deepEqual(store.get(loadedRecordingState), { ...localRecording, projectPath: movedPath });
  assert.equal(store.get(recordingPlaybackStartingState), false);
});

test('closing a recording owner clears the selection and pre-start playback state only for that owner', () => {
  const store = createStore();
  store.set(loadedRecordingState, recording);
  store.set(recordingPlaybackStartingState, true);

  assert.equal(
    store.set(clearLoadedRecordingForTabState, {
      projectId: projectB,
      projectPath: recording.projectPath,
    }),
    false,
  );
  assert.equal(store.get(loadedRecordingState), recording);
  assert.equal(store.get(recordingPlaybackStartingState), true);

  assert.equal(
    store.set(clearLoadedRecordingForTabState, {
      projectId: projectA,
      projectPath: recording.projectPath,
    }),
    true,
  );
  assert.equal(store.get(loadedRecordingState), null);
  assert.equal(store.get(recordingPlaybackStartingState), false);
});

test('replacing a replay tab clears only that path and its pre-start playback state', () => {
  const store = createStore();
  store.set(loadedRecordingState, recording);
  store.set(recordingPlaybackStartingState, true);

  assert.equal(store.set(clearLoadedRecordingForPathState, 'recording://another/replay.rivet-project'), false);
  assert.equal(store.get(loadedRecordingState), recording);
  assert.equal(store.get(recordingPlaybackStartingState), true);

  assert.equal(store.set(clearLoadedRecordingForPathState, recording.projectPath), true);
  assert.equal(store.get(loadedRecordingState), null);
  assert.equal(store.get(recordingPlaybackStartingState), false);
});

test('the current-tab selector does not enter playback mode for another path with the same project ID', () => {
  const store = createStore();
  store.set(loadedRecordingState, recording);
  store.set(projectState, (current) => ({
    ...current,
    metadata: {
      ...current.metadata,
      id: projectA,
    },
  }));
  store.set(loadedProjectState, { loaded: true, path: 'C:/projects/project-a.rivet-project' });

  assert.equal(store.get(currentProjectLoadedRecordingState), undefined);

  store.set(loadedProjectState, { loaded: true, path: recording.projectPath });
  assert.equal(store.get(currentProjectLoadedRecordingState), recording);
});

test('recording target display covers detached replay startup and unload without leaking into live tabs', () => {
  const store = createStore();
  store.set(projectState, (current) => ({ ...current, metadata: { ...current.metadata, id: projectA } }));
  const localPath = 'C:/projects/project-a.rivet-project';
  store.set(loadedProjectState, { loaded: true, path: localPath });
  assert.equal(store.get(isRecordingProjectState), false);
  store.set(loadedRecordingState, { ...recording, projectPath: localPath });
  assert.equal(store.get(isRecordingProjectState), true);
  store.set(loadedProjectState, { loaded: true, path: 'C:/projects/another.rivet-project' });
  assert.equal(store.get(isRecordingProjectState), false);
  store.set(loadedRecordingState, null);
  store.set(loadedProjectState, { loaded: true, path: recording.projectPath });
  assert.equal(store.get(isRecordingProjectState), true); // Before activation, and after unload.
  store.set(loadedProjectState, { loaded: true, path: localPath });
  assert.equal(store.get(isRecordingProjectState), false);
});
