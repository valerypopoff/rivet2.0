import type { CombinedDataset, ProjectId } from '@valerypopoff/rivet2-core';
import { BrowserDatasetProvider } from '../../app/src/io/BrowserDatasetProvider';

export class HostedDatasetProvider extends BrowserDatasetProvider {
  override async importDatasetsForProject(
    projectId: ProjectId,
    datasets: CombinedDataset[],
    options: { isCurrent?: () => boolean; signal?: AbortSignal; activate?: boolean } = {},
  ): Promise<void> {
    // Replace in one abortable transaction; never clear the source and then
    // leave an empty database when a cancelled import fails halfway through.
    await super.importDatasetsForProject(projectId, datasets, { ...options, replace: true });
  }
}
