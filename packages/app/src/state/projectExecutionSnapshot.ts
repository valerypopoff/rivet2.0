import type { ProjectExecutionSnapshot } from './dataFlow.js';
import { atom } from 'jotai';
import type { ProjectId } from '@valerypopoff/rivet2-core';
import { createRunActivityJournal } from '../features/runActivity/runActivityJournal.js';

/** Storage has no dependency on active workspace selection or binding lifecycle. */
export const executionSnapshotsState = atom<Record<ProjectId, ProjectExecutionSnapshot | undefined>>({});

export function createEmptyProjectExecutionSnapshot(): ProjectExecutionSnapshot {
  return {
    completedRootRunIds: [],
    graphPaused: false,
    graphRunHistoryByView: {},
    graphRunning: false,
    graphStartTime: undefined,
    frozenNodeOutputs: {},
    lastRecording: undefined,
    lastRunDataByNode: {},
    rootGraph: undefined,
    runActivityJournal: createRunActivityJournal(),
    runningGraphs: [],
    selectedGraphRunByView: {},
    selectedLLMChatOutputPageByInvocation: {},
    selectedProcessPageNodes: {},
    userInputQuestions: {},
  };
}
