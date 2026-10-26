import type { ProjectId } from './Project.js';
import type { CombinedDataset } from '../utils/serialization/serialization.js';

/** Change only the owner of already validated sidecars. Reference/version
 * rewiring is an operation-specific policy, not part of dataset ownership. */
export function remapOwnedDatasets(
  datasets: readonly CombinedDataset[],
  sourceId: ProjectId,
  targetId: ProjectId,
): CombinedDataset[] {
  return datasets.map((dataset) => {
    if (dataset.meta.projectId !== sourceId) throw new Error('Dataset ownership does not match the source project.');
    return { ...dataset, meta: { ...dataset.meta, projectId: targetId } };
  });
}
