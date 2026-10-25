import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const fixtureNames = ['dist-test-v3', 'dist-test-v4'];
const entryPointFields = [
  'main',
  'module',
  'exports',
  'types',
  'typings',
  'browser',
  'bin',
  'imports',
  'typesVersions',
];

// zod-to-json-schema publishes complete test-only dependency installations.
// Remove only these known fixture roots, never arbitrary tests/node_modules:
// converters, schemas, declarations, assets and actual Zod dependencies survive.
export async function removeDependencyTestFixtures(root) {
  if (!(await fs.lstat(root)).isDirectory()) throw new Error('Dependency root must be a real directory.');
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue; // Never follow dependency/workspace symlinks.
    const directory = path.join(root, entry.name);
    const hasFixtures =
      entry.name === 'zod-to-json-schema' && (await fs.readdir(directory)).some((name) => fixtureNames.includes(name));
    if (hasFixtures) {
      const manifest = JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8'));
      if (manifest.name !== 'zod-to-json-schema' || !/^3\.25\./.test(manifest.version))
        throw new Error('Review changed zod-to-json-schema fixture packaging before shipping it.');
      if (/dist-test-v[34]/.test(JSON.stringify(entryPointFields.map((field) => manifest[field]))))
        throw new Error('Refusing to remove exported dependency fixtures.');
      const targets = [];
      for (const name of fixtureNames) {
        const target = path.join(directory, name);
        const stat = await fs.lstat(target).catch((error) => {
          if (error.code !== 'ENOENT') throw error;
        });
        if (stat && !stat.isDirectory()) throw new Error('Refusing non-directory dependency fixtures.');
        if (stat) targets.push(target);
      }
      // Validate every root before modifying either one.
      for (const target of targets) await fs.rm(target, { recursive: true });
    }
    // Scoped packages and nested dependencies need the same narrow treatment.
    if (entry.name.startsWith('@')) await removeDependencyTestFixtures(directory);
    const nested = path.join(directory, 'node_modules');
    const stat = await fs.lstat(nested).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
    if (stat?.isDirectory()) await removeDependencyTestFixtures(nested);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  for (const root of process.argv.slice(2)) await removeDependencyTestFixtures(path.resolve(root));
}
