const { cp } = require('node:fs/promises');
const esbuild = require('esbuild');
const { createRivetWorkspaceSourceResolver } = require('./rivet-workspace-source-resolver.cjs');

async function main() {
  const [{ execaCommand }, { default: chalk }] = await Promise.all([import('execa'), import('chalk')]);
  const interpolationRuntimeSource = await buildInterpolationRuntimeSource();

  console.log(`Bundling to ${chalk.cyan('bin/executor-bundle.cjs')}...`);

  // The executor source is ESM, but pkg needs a CJS bundle it can analyze.
  // Rivet workspace packages are bundled from source to avoid stale dist files.
  await esbuild.build({
    entryPoints: ['bin/executor.mts'],
    bundle: true,
    platform: 'node',
    outfile: './bin/executor-bundle.cjs',
    format: 'cjs',
    target: 'node16',
    define: {
      'import.meta.url': '__filename',
      __RIVET_CODE_INTERPOLATION_RUNTIME_SOURCE__: JSON.stringify(interpolationRuntimeSource),
    },
    external: [],
    plugins: [createRivetWorkspaceSourceResolver()],
  });

  console.log(`Compiling to native binary for ${chalk.cyan(process.platform)}...`);

  const { platform } = process;
  const targets = {
    darwin: 'node18-macos-x64',
    linux: process.arch === 'arm64' ? 'node18-linux-arm64' : 'node18-linux-x64',
    win32: 'node18-win-x64',
  };
  const target = targets[platform];

  if (!target) {
    throw new Error(`Unsupported platform ${platform}.`);
  }

  await execaCommand(
    `yarn pkg . --out-path dist --no-bytecode --options experimental-network-imports --targets ${target}`,
    { stdio: 'inherit' },
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

  const { stdout } = await execaCommand('rustc -Vv');
  const hostLine = stdout.split('\n').find((line) => line.startsWith('host:'));
  if (!hostLine) {
    throw new Error('Could not determine the Rust host target.');
  }

  const destinations = platformParams.to ?? [`dist/app-executor-${hostLine.split(' ')[1]}`];
  for (const destination of destinations) {
    await cp(platformParams.from, destination);
  }

  console.log(`Copied ${chalk.cyan(platformParams.from)} to ${chalk.cyan(destinations.join(', '))} for tauri sidecar`);
}

async function buildInterpolationRuntimeSource() {
  const result = await esbuild.build({
    entryPoints: ['../core/src/interpolationRuntime.ts'],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node16',
    write: false,
  });
  const output = result.outputFiles?.[0]?.text;
  if (!output) {
    throw new Error('Could not bundle the Core interpolation runtime for the executor worker.');
  }

  return output;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
