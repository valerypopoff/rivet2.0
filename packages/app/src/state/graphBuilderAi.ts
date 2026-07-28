import { atom } from 'jotai';
import { atomWithStorage } from 'jotai/utils';
import { createHybridStorage } from './storage.js';

const { storage } = createHybridStorage('graphBuilderAi');

export type GraphBuilderImplementationMode = 'legacy' | 'plan-b';

export function normalizeGraphBuilderImplementationMode(value: unknown): GraphBuilderImplementationMode {
  return value === 'plan-b' ? 'plan-b' : 'legacy';
}

const storedGraphBuilderImplementationModeState = atomWithStorage<unknown>('implementationMode', 'legacy', storage);

/**
 * Developer rollback seam. The value is captured at session creation and never
 * switches an in-flight session between implementations.
 */
export const graphBuilderImplementationModeState = atom(
  (get) => normalizeGraphBuilderImplementationMode(get(storedGraphBuilderImplementationModeState)),
  (_get, set, value: GraphBuilderImplementationMode) => {
    set(storedGraphBuilderImplementationModeState, value);
  },
);

/** Advisory only; canonical authoring fingerprints remain the CAS authority. */
export const graphBuilderEditorRevisionState = atom(0);

/** One Graph Builder session may own a project draft in a window at a time. */
type ActiveGraphBuilderSessionOwner = {
  projectId: string;
  sessionId: string;
};

export const activeGraphBuilderSessionOwnerState = atom<ActiveGraphBuilderSessionOwner | undefined>(undefined);
