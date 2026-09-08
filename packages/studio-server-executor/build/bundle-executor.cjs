// Docker-specific executor bundler: runs the esbuild step from Rivet's
// app-executor package and skips the native pkg binary build.
//
// Rivet 2.0 exposes host/port and CodeRunner require-root seams directly, so
// this wrapper must not patch upstream executor or code-runner source strings.

const esbuild = require('esbuild');
const path = require('path');
const {
  createRivetWorkspaceSourceResolver,
} = require('../../app-executor/scripts/rivet-workspace-source-resolver.cjs');

const repoRootDir = path.resolve(__dirname, '..', '..', '..');
const studioServerExecutorDir = path.resolve(repoRootDir, 'packages', 'studio-server-executor');

const executorBundlePath = path.join(studioServerExecutorDir, 'dist', 'executor-bundle.cjs');

function createExecutorBuildOptions(additionalPlugins = []) {
  return {
    absWorkingDir: repoRootDir,
    entryPoints: [path.join(studioServerExecutorDir, 'src', 'executor.mts')],
    bundle: true,
    platform: 'node',
    outfile: executorBundlePath,
    format: 'cjs',
    target: 'node20',
    define: {
      'import.meta.url': '__filename',
    },
    external: [],
    plugins: [createRivetWorkspaceSourceResolver(), ...additionalPlugins],
  };
}

function buildExecutorBundle(overrides = {}) {
  return esbuild.build({ ...createExecutorBuildOptions(), ...overrides });
}

async function main() {
  await buildExecutorBundle();
  console.log('Studio Server executor bundled to dist/executor-bundle.cjs');
}

module.exports = { buildExecutorBundle, createExecutorBuildOptions, executorBundlePath, repoRootDir };

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
