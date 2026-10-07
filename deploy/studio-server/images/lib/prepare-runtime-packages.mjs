import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Preserve workspace link targets and public dist exports, not the entire
// monorepo's source/tests/desktop assets. Third-party node_modules stays intact
// because plugins and Code nodes can resolve packages dynamically.
export async function prepareRuntimePackages(sourceRoot, destination, profile) {
  if (!['api', 'executor'].includes(profile)) throw new Error('Unknown container runtime profile.');
  await fs.mkdir(destination); // Fresh owned staging only; never delete an existing tree.
  const compiled = ['core', 'node', 'evaluations'];
  if (profile === 'api') compiled.push('studio-server-api');
  for (const workspace of [...compiled, 'studio-server-bootstrap']) {
    const source = path.join(sourceRoot, 'packages', workspace);
    const target = path.join(destination, workspace);
    await fs.mkdir(target);
    for (const file of ['package.json', 'LICENSE', 'README.md']) {
      try {
        await fs.copyFile(path.join(source, file), path.join(target, file));
      } catch (error) {
        if (file !== 'package.json' && error.code === 'ENOENT') continue;
        throw error;
      }
    }
    if (workspace === 'studio-server-bootstrap') {
      for (const file of await fs.readdir(source)) {
        if (file.endsWith('.mjs') && !file.endsWith('.test.mjs'))
          await fs.copyFile(path.join(source, file), path.join(target, file));
      }
    } else {
      await fs.cp(path.join(source, 'dist'), path.join(target, 'dist'), {
        recursive: true,
        // API tsc emits tests alongside runtime code; they are only CI inputs.
        filter: (entry) =>
          workspace !== 'studio-server-api' ||
          !path.relative(path.join(source, 'dist'), entry).split(path.sep).includes('tests'),
      });
    }
    // Yarn's node-modules linker may keep non-hoisted versions here. Preserve
    // that resolution hierarchy, including relative dependency/bin links.
    const localModules = path.join(source, 'node_modules');
    try {
      await fs.lstat(localModules);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    await fs.cp(localModules, path.join(target, 'node_modules'), {
      recursive: true,
      verbatimSymlinks: true,
    });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await prepareRuntimePackages(process.cwd(), process.argv[2], process.argv[3]);
}
