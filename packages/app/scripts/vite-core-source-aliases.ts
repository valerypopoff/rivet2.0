import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';

const corePackage = JSON.parse(readFileSync(new URL('../../core/package.json', import.meta.url), 'utf8')) as {
  name: string;
  exports: Record<string, unknown>;
  rivetSourceEntrypoints: Record<string, string>;
};
if (Object.keys(corePackage.exports).sort().join() !== Object.keys(corePackage.rivetSourceEntrypoints).sort().join()) {
  throw new Error('Core public exports and source entrypoints must have identical subpaths.');
}
export const rivetCoreSourceEntrypoints: Record<string, string> = Object.fromEntries(
  Object.entries(corePackage.rivetSourceEntrypoints).map(([subpath, source]) => {
    if (!source.startsWith('src/') || !source.endsWith('.ts')) {
      throw new Error(`Core export ${subpath} must declare a TypeScript source entrypoint.`);
    }
    return [subpath === '.' ? corePackage.name : `${corePackage.name}/${subpath.slice(2)}`, source.slice(4)];
  }),
);

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Browser builds consume current workspace source instead of requiring Core's
 * generated package exports to exist. The package export declarations own the
 * source map, so adding a public subpath cannot leave browser builds behind.
 */
export function createRivetCoreSourceAliases(coreDirectory: string) {
  return Object.entries(rivetCoreSourceEntrypoints).map(([specifier, sourcePath]) => ({
    find: new RegExp(`^${escapeRegExp(specifier)}$`),
    replacement: resolve(coreDirectory, 'src', sourcePath),
  }));
}
