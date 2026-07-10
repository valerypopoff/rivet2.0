import { cp } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { execaCommand } from 'execa';
import chalk from 'chalk';
import { resolve } from 'node:path';

import type * as Esbuild from 'esbuild';

const require = createRequire(import.meta.url);
const esbuild = require('esbuild') as typeof Esbuild;

const rivetWorkspaceSourceEntries = new Map<string, string>([
  ['@valerypopoff/rivet2-core', '../core/src/index.ts'],
  ['@valerypopoff/rivet2-node', '../node/src/index.ts'],
]);

const resolveRivet: esbuild.Plugin = {
  name: 'resolve-rivet',
  setup(build) {
    build.onResolve({ filter: /^@valerypopoff\/rivet2-(core|node)$/ }, (args) => {
      const sourceEntry = rivetWorkspaceSourceEntries.get(args.path);
      if (!sourceEntry) {
        return;
      }

      return { path: resolve(sourceEntry) };
    });
  },
};

console.log(`Bundling to ${chalk.cyan('bin/executor-bundle.cjs')}...`);

// The executor source is ESM (.mts) but the bundle must be CJS so that `pkg`
// can statically analyze and package it into a self-contained native binary.
// The resolveRivet plugin inlines Rivet 2 workspace packages from source so
// app-executor stays in lockstep with current core/node changes even when the
// built package dist folders have not been refreshed yet.
await esbuild.build({
  entryPoints: ['bin/executor.mts'],
  bundle: true,
  platform: 'node',
  outfile: './bin/executor-bundle.cjs',
  format: 'cjs',
  target: 'node16',
  define: {
    'import.meta.url': '__filename',
  },
  external: [],
  plugins: [resolveRivet],
});

console.log(`Compiling to native binary for ${chalk.cyan(process.platform)}...`);

const { platform } = process;

if (platform !== 'darwin' && platform !== 'linux' && platform !== 'win32') {
  console.error(`Unsupported platform ${platform}.`);
  process.exit(1);
}

let target = {
  darwin: 'node18-macos-x64',
  linux: 'node18-linux-x64',
  win32: 'node18-win-x64',
}[platform];

if (platform === 'linux' && process.arch === 'arm64') {
  target = 'node18-linux-arm64';
}

await execaCommand(
  `yarn pkg . --out-path dist --no-bytecode --options experimental-network-imports --targets ${target}`,
  {
    stdio: 'inherit',
  },
);

const platformParams = {
  darwin: {
    from: 'dist/rivet-app-executor',
    to: [
      'dist/app-executor-x86_64-apple-darwin',
      'dist/app-executor-aarch64-apple-darwin',
      'dist/app-executor-universal-apple-darwin',
    ],
  },
  linux: {
    from: 'dist/rivet-app-executor',
    to: undefined,
  },
  win32: {
    from: 'dist/rivet-app-executor.exe',
    to: ['dist/app-executor-x86_64-pc-windows-msvc.exe'],
  },
}[platform];

const sourceFrom = platformParams.from;
let to = platformParams.to;

const { stdout } = await execaCommand('rustc -Vv');
const host = stdout
  .split('\n')
  .find((line) => line.startsWith('host:'))!
  .split(' ')[1];

// Copy the file

if (to === undefined) {
  to = [`dist/app-executor-${host}`];
}

for (const toPath of to) {
  await cp(sourceFrom, toPath);
}

console.log(`Copied ${chalk.cyan(sourceFrom)} to ${chalk.cyan(to.join(', '))} for tauri sidecar`);
