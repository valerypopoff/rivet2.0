import assert from 'node:assert/strict';
import test from 'node:test';
import type { ExecutionRecorder, ProjectId } from '@valerypopoff/rivet2-core';
import { createStore } from 'jotai/vanilla';
import {
  activateLoadedRecordingState,
  canChangeLoadedRecordingForTab,
  clearLoadedRecordingForPathState,
  clearLoadedRecordingForTabState,
  currentProjectLoadedRecordingState,
  getLoadedRecordingForTab,
  isCurrentLoadedRecordingForTab,
  isLoadedRecordingOwnedByTab,
  loadedRecordingState,
  recordingPlaybackStartingState,
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
  recorder: {} as ExecutionRecorder,
};

test('loaded recordings are visible only to their owning editor tab', () => {
  assert.equal(getLoadedRecordingForTab(recording, projectA, recording.projectPath), recording);
  assert.equal(getLoadedRecordingForTab(recording, projectA, 'C:/projects/project-a.rivet-project'), undefined);
  assert.equal(getLoadedRecordingForTab(recording, projectB, recording.projectPath), undefined);
  assert.equal(getLoadedRecordingForTab(recording, undefined, recording.projectPath), undefined);
  assert.equal(isLoadedRecordingOwnedByTab(recording, projectA, recording.projectPath), true);
  assert.equal(isLoadedRecordingOwnedByTab(recording, projectA, 'C:/projects/project-a.rivet-project'), false);
  assert.equal(isLoadedRecordingOwnedByTab(recording, projectB, recording.projectPath), false);
});

test('missing recordings remain absent for every project', () => {
  assert.equal(getLoadedRecordingForTab(null, projectA, recording.projectPath), undefined);
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

  assert.equal(store.set(rebindLoadedRecordingPathState, {
    fromPath: 'C:/projects/another-project.rivet-project',
    toPath: movedPath,
  }), false);
  assert.equal(store.get(loadedRecordingState), localRecording);

  assert.equal(store.set(rebindLoadedRecordingPathState, {
    fromPath: originalPath,
    toPath: movedPath,
  }), true);
  assert.deepEqual(store.get(loadedRecordingState), { ...localRecording, projectPath: movedPath });
  assert.equal(store.get(recordingPlaybackStartingState), false);
});

test('closing a recording owner clears the selection and pre-start playback state only for that owner', () => {
  const store = createStore();
  store.set(loadedRecordingState, recording);
  store.set(recordingPlaybackStartingState, true);

  assert.equal(store.set(clearLoadedRecordingForTabState, {
    projectId: projectB,
    projectPath: recording.projectPath,
  }), false);
  assert.equal(store.get(loadedRecordingState), recording);
  assert.equal(store.get(recordingPlaybackStartingState), true);

  assert.equal(store.set(clearLoadedRecordingForTabState, {
    projectId: projectA,
    projectPath: recording.projectPath,
  }), true);
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
