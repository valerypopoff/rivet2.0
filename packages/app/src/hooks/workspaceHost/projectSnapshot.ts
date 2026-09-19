import { normalizeProjectUiGraphs, type NodeGraph, type Project } from '@valerypopoff/rivet2-core';
import type { RivetProjectSnapshotInput } from './types.js';
import {
  normalizeClassifierGraphForAppState,
  normalizeClassifierProjectForAppState,
} from '../../utils/classifierProjectMigration.js';

export type NormalizedProjectSnapshot = {
  project: Omit<Project, 'data'>;
  data?: Project['data'];
  graphToLoad?: NodeGraph;
};

export function normalizeProjectSnapshot(snapshot: RivetProjectSnapshotInput): NormalizedProjectSnapshot {
  const { data: attachedData, ...project } = snapshot.project as Project;
  const uiGraphNormalizedProject = normalizeProjectUiGraphs(project);

  return {
    project: normalizeClassifierProjectForAppState(uiGraphNormalizedProject),
    data: snapshot.data ?? attachedData,
    graphToLoad: snapshot.graphToLoad && normalizeClassifierGraphForAppState(snapshot.graphToLoad),
  };
}
