import { atom } from 'jotai';
import { atomWithStorage } from 'jotai/utils';
import { type NodeId, type ProcessId, type LatestDebuggerPrompt } from '@valerypopoff/rivet2-core';
import { createHybridStorage } from '../storage.js';
import { executionSnapshotField } from '../projectExecutionStore.js';

const { storage } = createHybridStorage('userInput');

export const userInputModalOpenState = atom<boolean>(false);

export type ProcessQuestions = {
  latestPrompt?: LatestDebuggerPrompt;
  nodeId: NodeId;
  processId: ProcessId;
  questions: string[];
};

export const userInputModalQuestionsState = executionSnapshotField('userInputQuestions');
export const lastAnswersState = atomWithStorage<Record<string, string>>('lastAnswers', {}, storage);
