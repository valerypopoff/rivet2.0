import { loadProjectAndAttachedDataFromFile, type ProjectId } from '@valerypopoff/rivet2-node';
import { listProjectPathsRecursive } from './fs-helpers.js';

export async function findFilesystemProjectPathsByMetadataId(root: string, projectId: ProjectId): Promise<string[]> {
  // Save reconciliation cannot depend on a UI/tree projection: the physical
  // workflow file may have moved between the tree refresh and this write lock.
  const candidates = await listProjectPathsRecursive(root);
  const matches: string[] = [];
  for (const candidate of candidates) {
    try {
      const [candidateProject] = await loadProjectAndAttachedDataFromFile(candidate);
      if (candidateProject.metadata.id === projectId) {
        matches.push(candidate);
      }
    } catch {
      // A malformed neighboring project cannot establish ownership of this id.
    }
  }
  return matches;
}
