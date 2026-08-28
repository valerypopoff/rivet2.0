import type { ProjectId } from '@valerypopoff/rivet2-core';
import { releaseProjectContextState } from '../../../app/src/state/savedGraphs';
import { createHybridStorage } from '../../../app/src/state/storage';

export * from '../../../app/src/state/savedGraphs';

const { storage: projectStorage } = createHybridStorage('project');

export function clearProjectContextState(projectId: ProjectId): void {
  // Hosted tab close is not project deletion; editor-owned context must survive reopen.
  releaseProjectContextState(projectId);
}

export function deleteHostedProjectContextState(projectId: ProjectId): void {
  clearProjectContextState(projectId);
  projectStorage.removeItem(`projectContext__"${projectId}"`);
}
