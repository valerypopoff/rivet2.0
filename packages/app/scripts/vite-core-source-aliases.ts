import { resolve } from 'node:path';

export const rivetCoreSourceEntrypoints = {
  '@valerypopoff/rivet2-core': 'index.ts',
  '@valerypopoff/rivet2-core/web-app-runtime': 'webAppRuntime.ts',
  '@valerypopoff/rivet2-core/interpolation-runtime': 'interpolationRuntime.ts',
  '@valerypopoff/rivet2-core/interpolation-syntax': 'utils/interpolationSyntax.ts',
} as const;

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Browser builds consume current workspace source instead of requiring Core's
 * generated package exports to exist. Keep this map aligned with Core's public
 * exports so clean CI builds cannot depend on a developer's warm `dist/` tree.
 */
export function createRivetCoreSourceAliases(coreDirectory: string) {
  return Object.entries(rivetCoreSourceEntrypoints).map(([specifier, sourcePath]) => ({
    find: new RegExp(`^${escapeRegExp(specifier)}$`),
    replacement: resolve(coreDirectory, 'src', sourcePath),
  }));
}
