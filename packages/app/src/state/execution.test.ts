import assert from 'node:assert/strict';
import test from 'node:test';
import type { ExecutionRecorder, ProjectId } from '@valerypopoff/rivet2-core';
import { createStore } from 'jotai/vanilla';
import {
  canChangeLoadedRecordingForProject,
  clearLoadedRecordingForProjectState,
  getLoadedRecordingForProject,
  isCurrentLoadedRecordingForProject,
  isLoadedRecordingOwnedByProject,
  loadedRecordingState,
  recordingPlaybackStartingState,
  type LoadedRecording,
} from './execution.js';

const projectA = 'project-a' as ProjectId;
const projectB = 'project-b' as ProjectId;
const recording: LoadedRecording = {
  path: 'C:/recordings/project-a.rivet-recording',
  projectId: projectA,
  recorder: {} as ExecutionRecorder,
};

test('loaded recordings are visible only to their owning project', () => {
  assert.equal(getLoadedRecordingForProject(recording, projectA), recording);
  assert.equal(getLoadedRecordingForProject(recording, projectB), undefined);
  assert.equal(getLoadedRecordingForProject(recording, undefined), undefined);
  assert.equal(isLoadedRecordingOwnedByProject(recording, projectA), true);
  assert.equal(isLoadedRecordingOwnedByProject(recording, projectB), false);
});

test('missing recordings remain absent for every project', () => {
  assert.equal(getLoadedRecordingForProject(null, projectA), undefined);
});

test('only the owner can replace or unload a loaded recording', () => {
  assert.equal(canChangeLoadedRecordingForProject(recording, projectA), true);
  assert.equal(canChangeLoadedRecordingForProject(recording, projectB), false);
  assert.equal(canChangeLoadedRecordingForProject(null, projectB), true);
});

test('a stale playback cannot clear the starting state for a newer recording selection', () => {
  const replacement: LoadedRecording = {
    ...recording,
    path: 'C:/recordings/project-b.rivet-recording',
    projectId: projectB,
  };

  assert.equal(isCurrentLoadedRecordingForProject(recording, recording, projectA), true);
  assert.equal(isCurrentLoadedRecordingForProject(null, recording, projectA), false);
  assert.equal(isCurrentLoadedRecordingForProject(replacement, recording, projectA), false);
  assert.equal(isCurrentLoadedRecordingForProject(replacement, replacement, projectB), true);
});

test('closing a recording owner clears the selection and pre-start playback state only for that owner', () => {
  const store = createStore();
  store.set(loadedRecordingState, recording);
  store.set(recordingPlaybackStartingState, true);

  assert.equal(store.set(clearLoadedRecordingForProjectState, projectB), false);
  assert.equal(store.get(loadedRecordingState), recording);
  assert.equal(store.get(recordingPlaybackStartingState), true);

  assert.equal(store.set(clearLoadedRecordingForProjectState, projectA), true);
  assert.equal(store.get(loadedRecordingState), null);
  assert.equal(store.get(recordingPlaybackStartingState), false);
});
