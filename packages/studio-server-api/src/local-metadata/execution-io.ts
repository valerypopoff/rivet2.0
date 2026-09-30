import { NodeNativeApi } from '@valerypopoff/rivet2-node';
import { CatalogNativeApi } from '../../../studio-server-shared/catalogNativeApi.js';
import { getLocalMetadataServingSelection } from './serving-selection.js';
import { readManagedHostedText } from '../routes/workflows/storage-backend.js';
import { listManagedVirtualDirectory } from '../routes/workflows/managed-virtual-io.js';

export function createLocalCatalogNativeApi(): NodeNativeApi {
  const selected = getLocalMetadataServingSelection();
  return selected
    ? new CatalogNativeApi({
        root: selected.source.workflows,
        readText: readManagedHostedText,
        readDirectory: (directory, options) =>
          listManagedVirtualDirectory(directory, {
            recursive: options.recursive ?? false,
            includeDirectories: options.includeDirectories ?? false,
            filterGlobs: options.filterGlobs ?? [],
            relative: options.relative ?? false,
            ignores: options.ignores ?? [],
          }),
      })
    : new NodeNativeApi();
}
