import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../../../', import.meta.url));
export function nodeTestPrerequisites(mode = 'build') {
  if (mode === 'prebuilt') return [['check:compiled-workspace-exports']];
  if (mode !== 'build') throw new Error('RIVET_NODE_TEST_DEPENDENCIES must be build or prebuilt.');
  return [
    ['workspace', '@valerypopoff/rivet2-core', 'run', 'build:esm'],
    ['workspace', '@valerypopoff/rivet2-core', 'run', 'build:cjs'],
    ['workspace', '@valerypopoff/rivet2-node', 'run', 'build:esm'],
    ['workspace', '@valerypopoff/rivet2-node', 'run', 'build:cjs'],
  ];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const args of nodeTestPrerequisites(process.env.RIVET_NODE_TEST_DEPENDENCIES ?? 'build')) {
    const result = spawnSync(process.execPath, [path.join(root, '.yarn/releases/yarn-4.17.1.cjs'), ...args], {
      cwd: root,
      env: process.env,
      stdio: 'inherit',
    });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}
