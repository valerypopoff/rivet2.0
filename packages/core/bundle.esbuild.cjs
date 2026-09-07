const esbuild = require('esbuild');
const { existsSync } = require('node:fs');

const aliasModule = (moduleFrom, moduleTo) => ({
  name: 'alias-module',
  setup(build) {
    build.onResolve({ filter: new RegExp(`^${moduleFrom}$`) }, async (args) => {
      const resolved = await build.resolve(moduleTo, {
        importer: args.importer,
        kind: 'import-statement',
        resolveDir: args.resolveDir,
      });

      if (resolved.errors.length > 0) {
        return { errors: resolved.errors };
      }

      return { path: resolved.path, namespace: 'alias-module', external: true };
    });
  },
});

// Several dependencies ship as ESM-only in their latest versions. The CJS
// bundle aliases them to installed CJS-compatible versions so require() works.
const hasWebAppRuntimeEntry = existsSync('src/webAppRuntime.ts');
const hasInterpolationRuntimeEntry = existsSync('src/interpolationRuntime.ts');
const hasInterpolationSyntaxEntry = existsSync('src/utils/interpolationSyntax.ts');
const entryPoints = { bundle: 'src/index.ts' };

if (hasWebAppRuntimeEntry) {
  entryPoints.webAppRuntime = 'src/webAppRuntime.ts';
}

if (hasInterpolationRuntimeEntry) {
  entryPoints.interpolationRuntime = 'src/interpolationRuntime.ts';
}

if (hasInterpolationSyntaxEntry) {
  entryPoints.interpolationSyntax = 'src/utils/interpolationSyntax.ts';
}

const options = {
  entryPoints,
  bundle: true,
  platform: 'node',
  ...(hasWebAppRuntimeEntry || hasInterpolationRuntimeEntry || hasInterpolationSyntaxEntry
    ? { outdir: 'dist/cjs', outExtension: { '.js': '.cjs' } }
    : { outfile: 'dist/cjs/bundle.cjs' }),
  format: 'cjs',
  target: 'node16',
  packages: 'external',
  define: {
    'import.meta.url': '__filename',
  },
  sourcemap: true,
  plugins: [
    aliasModule('lodash-es', 'lodash'),
    aliasModule('p-queue', 'p-queue-6'),
    aliasModule('emittery', 'emittery-0-13'),
    aliasModule('p-retry', 'p-retry-4'),
  ],
};

async function main() {
  if (process.argv.includes('--watch')) {
    const context = await esbuild.context(options);
    await context.watch();
  } else {
    await esbuild.build(options);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
