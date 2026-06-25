import type { Project } from '@valerypopoff/rivet2-core';
import type { RivetProjectSnapshotInput } from './types.js';

export type NormalizedProjectSnapshot = {
  project: Omit<Project, 'data'>;
  data?: Project['data'];
};

export function normalizeProjectSnapshot(snapshot: RivetProjectSnapshotInput): NormalizedProjectSnapshot {
  const { data: attachedData, ...project } = snapshot.project as Project;

  return {
    project,
    data: snapshot.data ?? attachedData,
  };
}
