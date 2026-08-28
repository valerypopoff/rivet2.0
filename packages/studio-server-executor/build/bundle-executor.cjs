// Docker-specific executor bundler: runs the esbuild step from Rivet's
// app-executor package and skips the native pkg binary build.
//
// Rivet 2.0 exposes host/port and CodeRunner require-root seams directly, so
// this wrapper must not patch upstream executor or code-runner source strings.

const esbuild = require('esbuild');
const path = require('path');

const repoRootDir = path.resolve(__dirname, '..', '..', '..');
const appExecutorDir = path.resolve(repoRootDir, 'packages', 'app-executor');
const studioServerExecutorDir = path.resolve(repoRootDir, 'packages', 'studio-server-executor');

const resolveRivet = {
  name: 'resolve-rivet',
  setup(build) {
    build.onResolve({ filter: /^@valerypopoff\/rivet2-(core|node)$/ }, (args) => {
      const rivetPackage = args.path.replace(/^@valerypopoff\/rivet2-/, '');
      return {
        path: path.resolve(appExecutorDir, '..', rivetPackage, 'src', 'index.ts'),
      };
    });
  },
};

esbuild
  .build({
    entryPoints: [path.join(studioServerExecutorDir, 'src', 'executor.mts')],
    bundle: true,
    platform: 'node',
    outfile: path.join(studioServerExecutorDir, 'dist', 'executor-bundle.cjs'),
    format: 'cjs',
    target: 'node20',
    define: {
      'import.meta.url': '__filename',
    },
    external: [],
    plugins: [resolveRivet],
  })
  .then(() => {
    console.log('Studio Server executor bundled to dist/executor-bundle.cjs');
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
