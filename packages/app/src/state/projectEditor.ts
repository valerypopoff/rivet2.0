import { atom } from 'jotai';
import { atomWithStorage } from 'jotai/utils';
import { type GraphId, type ProjectId } from '@valerypopoff/rivet2-core';
import type { GraphNavigationStack } from '../domain/graphEditing/navigationActions.js';
import { createHybridStorage } from './storage.js';

const { storage } = createHybridStorage('project');

export type PersistedCanvasPosition = {
  x: number;
  y: number;
  zoom: number;
};

export type ProjectEditorState = {
  navigationStack: GraphNavigationStack;
  canvasPositionsByGraph: Record<GraphId, PersistedCanvasPosition | undefined>;
};

export type ProjectEditorStateByProjectId = Record<ProjectId, ProjectEditorState | undefined>;

export const projectEditorStateByProjectIdState = atomWithStorage<ProjectEditorStateByProjectId>(
  'projectEditorStateByProjectId',
  {},
  storage,
);

export const projectEditorHydratedState = atom(false);
