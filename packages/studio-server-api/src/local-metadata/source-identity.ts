import { createHash } from 'node:crypto';
import path from 'node:path';

export type LocalMetadataSourceRoots = {
  workflows: string;
  recordings: string;
  appData: string;
  runtimeLibraries: string;
};

/** Fixed field order and a protocol tag bind recovery to the same owned roots.
 * Keep the original mount paths: an alias is not automatically the same source. */
export function localMetadataSourceIdentity(roots: LocalMetadataSourceRoots): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        protocol: 'local-metadata-source-v1',
        workflows: path.resolve(roots.workflows),
        recordings: path.resolve(roots.recordings),
        appData: path.resolve(roots.appData),
        runtimeLibraries: path.resolve(roots.runtimeLibraries),
      }),
    )
    .digest('hex');
}
