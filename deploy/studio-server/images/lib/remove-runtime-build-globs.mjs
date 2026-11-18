import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const reviewed = { picomatch: new Set(['2.3.2', '4.0.5']), micromatch: new Set(['4.0.8']) };

// Only call on an owned runtime copy. The builder and managed runtime-library
// releases retain their dependencies. check-runtime-glob-scope guards execution.
export async function removeRuntimeBuildGlobs(directory) {
  assert.ok((await fs.lstat(directory)).isDirectory(), 'Runtime dependency copy must be a real directory');
  const root = await fs.realpath(directory);
  const targets = [];
  async function visit(modules) {
    for (const entry of await fs.readdir(modules, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue; // Never follow workspace/dependency links.
      const location = path.join(modules, entry.name);
      if (Object.hasOwn(reviewed, entry.name)) {
        const manifest = JSON.parse(await fs.readFile(path.join(location, 'package.json'), 'utf8'));
        assert.ok(
          manifest.name === entry.name && reviewed[entry.name].has(manifest.version),
          'Review changed build-glob packaging before removing it from runtime copies',
        );
        targets.push(location);
        continue;
      }
      if (entry.name.startsWith('@')) await visit(location);
      const nested = path.join(location, 'node_modules');
      const stat = await fs.lstat(nested).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
      });
      if (stat?.isDirectory()) await visit(nested);
    }
  }
  await visit(root); // Validate all reviewed packages before removing any of them.
  for (const target of targets) {
    const relative = path.relative(root, await fs.realpath(target));
    assert.ok(
      relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative),
      'Target escaped runtime copy',
    );
    await fs.rm(target, { recursive: true });
  }
  // Keep the normalized dependency-copy metadata stable after unlinking children.
  for (const parent of new Set(targets.map((target) => path.dirname(target)))) await fs.utimes(parent, 0, 0);
  return targets.map((target) => path.relative(root, target));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  assert.ok(process.argv.length > 2, 'Specify an owned runtime dependency copy');
  for (const root of process.argv.slice(2)) console.log(JSON.stringify(await removeRuntimeBuildGlobs(root)));
}
