import path from 'node:path';
import type { LocalMetadataSourceRoots } from './source-identity.js';

export type LocalMetadataServingSelection = {
  generationId: string;
  source: LocalMetadataSourceRoots;
  catalogDatabasePath: string;
  settingsDatabasePath: string;
  artifactRoot: string;
  operationalRoot: string;
  runtimeCacheRoot: string;
};

let selection: Readonly<LocalMetadataServingSelection> | null = null;

/** Set once, before any storage backend is initialized. Changing the durable
 * selection requires restarting BOTH supervised processes, never a hot swap. */
export function installLocalMetadataServingSelection(value: LocalMetadataServingSelection): void {
  if (selection) throw new Error('Local metadata serving selection is already installed.');
  selection = Object.freeze({ ...value, source: Object.freeze({ ...value.source }) });
}

export function getLocalMetadataServingSelection(): Readonly<LocalMetadataServingSelection> | null {
  return selection;
}

export function localMetadataGenerationPaths(controlRoot: string, generationId: string) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(generationId)) throw new Error('Invalid local generation ID.');
  const root = path.join(controlRoot, 'generations', generationId);
  return {
    root,
    catalogDatabasePath: path.join(root, 'catalog.sqlite'),
    settingsDatabasePath: path.join(root, 'settings.sqlite'),
    artifactRoot: path.join(root, 'objects'),
    operationalRoot: path.join(root, 'operational'),
    runtimeCacheRoot: path.join(root, 'runtime-cache'),
  };
}
