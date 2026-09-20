const { cp } = require('node:fs/promises');
const esbuild = require('esbuild');
const { createRivetWorkspaceSourceResolver } = require('./rivet-workspace-source-resolver.cjs');

const MACOS_EXECUTOR_TARGETS = {
  'aarch64-apple-darwin': 'node18-macos-arm64',
  'x86_64-apple-darwin': 'node18-macos-x64',
};

const LINUX_EXECUTOR_TARGETS = {
  'aarch64-unknown-linux-gnu': 'node18-linux-arm64',
  'x86_64-unknown-linux-gnu': 'node18-linux-x64',
};

function resolveExecutorBuildPlan({ platform, desktopTarget, rustHostTarget }) {
  const targetTriple = desktopTarget || rustHostTarget;

  if (!targetTriple) {
    throw new Error('Could not determine the desktop target for the executor build.');
  }

  if (platform === 'darwin') {
    const pkgTarget = MACOS_EXECUTOR_TARGETS[targetTriple];
    if (!pkgTarget) {
      throw new Error(
        `Unsupported macOS desktop target ${targetTriple}. Build separate aarch64-apple-darwin or x86_64-apple-darwin packages.`,
      );
    }

    return {
      pkgTarget,
      source: 'dist/rivet-app-executor',
      destination: `dist/app-executor-${targetTriple}`,
      targetTriple,
    };
  }

  if (platform === 'linux') {
    const pkgTarget = LINUX_EXECUTOR_TARGETS[targetTriple];
    if (!pkgTarget) {
      throw new Error(`Unsupported Linux desktop target ${targetTriple}.`);
    }

    return {
      pkgTarget,
      source: 'dist/rivet-app-executor',
      destination: `dist/app-executor-${targetTriple}`,
      targetTriple,
    };
  }

  if (platform === 'win32') {
    if (targetTriple !== 'x86_64-pc-windows-msvc') {
      throw new Error(`Unsupported Windows desktop target ${targetTriple}.`);
    }

    return {
      pkgTarget: 'node18-win-x64',
      source: 'dist/rivet-app-executor.exe',
      destination: `dist/app-executor-${targetTriple}.exe`,
      targetTriple,
    };
  }

  throw new Error(`Unsupported platform ${platform}.`);
}

function resolveDesktopTarget({ rivetDesktopTarget, tauriTargetTriple }) {
  return rivetDesktopTarget?.trim() || tauriTargetTriple?.trim() || undefined;
}

async function resolveRustHostTarget(execaCommand) {
  const { stdout } = await execaCommand('rustc -Vv');
  const hostLine = stdout.split('\n').find((line) => line.startsWith('host:'));
  if (!hostLine) {
    throw new Error('Could not determine the Rust host target.');
  }

  return hostLine.slice('host:'.length).trim();
}

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

  const desktopTarget = resolveDesktopTarget({
    rivetDesktopTarget: process.env.RIVET_DESKTOP_TARGET,
    tauriTargetTriple: process.env.TAURI_ENV_TARGET_TRIPLE,
  });
  const rustHostTarget = desktopTarget ? undefined : await resolveRustHostTarget(execaCommand);
  const buildPlan = resolveExecutorBuildPlan({
    platform: process.platform,
    desktopTarget,
    rustHostTarget,
  });

  console.log(`Compiling to native binary for ${chalk.cyan(buildPlan.targetTriple)}...`);

  await execaCommand(
    `yarn pkg . --out-path dist --no-bytecode --options experimental-network-imports --targets ${buildPlan.pkgTarget}`,
    { stdio: 'inherit' },
  );

  await cp(buildPlan.source, buildPlan.destination);
  console.log(`Copied ${chalk.cyan(buildPlan.source)} to ${chalk.cyan(buildPlan.destination)} for Tauri sidecar`);
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

module.exports = { LINUX_EXECUTOR_TARGETS, MACOS_EXECUTOR_TARGETS, resolveDesktopTarget, resolveExecutorBuildPlan };

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
