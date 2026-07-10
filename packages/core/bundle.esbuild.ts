import { createRequire } from 'node:module';

import type * as Esbuild from 'esbuild';

const require = createRequire(import.meta.url);
const esbuild = require('esbuild') as typeof Esbuild;

const aliasModule = (moduleFrom: string, moduleTo: string): esbuild.Plugin => ({
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

// CJS bundle configuration.
// Several dependencies ship as ESM-only in their latest versions. The CJS bundle
// aliases them to older CJS-compatible versions (installed via npm: aliases in
// package.json) so that `require()` works at runtime. See pQueueCompat.ts for
// the corresponding runtime normalization of the p-queue default export.
const options: esbuild.BuildOptions = {
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  outfile: 'dist/cjs/bundle.cjs',
  format: 'cjs',
  target: 'node16',
  packages: 'external',
  define: {
    'import.meta.url': '__filename',
  },
  sourcemap: true,
  plugins: [
    aliasModule('lodash-es', 'lodash'), // lodash-es is ESM-only; lodash is CJS
    aliasModule('p-queue', 'p-queue-6'), // p-queue v7+ is ESM-only; v6 is CJS
    aliasModule('emittery', 'emittery-0-13'), // emittery v1+ is ESM-only; v0.13 is CJS
    aliasModule('p-retry', 'p-retry-4'), // p-retry v6+ is ESM-only; v4 is CJS
  ],
};

if (process.argv.includes('--watch')) {
  const context = await esbuild.context(options);
  await context.watch();
} else {
  await esbuild.build(options);
}
