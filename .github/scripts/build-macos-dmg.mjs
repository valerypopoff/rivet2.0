import { spawn } from 'node:child_process';
import { readdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const appRoot = join(repositoryRoot, 'packages', 'app');
const yarnPath = join(repositoryRoot, '.yarn', 'releases', 'yarn-4.17.1.cjs');
const supportedTargets = new Set(['aarch64-apple-darwin', 'x86_64-apple-darwin']);
const retainedOutputLength = 64 * 1024;

export const macDmgBuildRetryDelaysMs = [5_000, 15_000];

export const isTransientMacDmgBuildFailure = (result) =>
  result.status !== 0 && result.output.includes('hdiutil: create failed - Resource busy');

const waitForRetry = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs));

export const runMacDmgBuildWithRetries = async ({
  run,
  cleanup,
  wait = waitForRetry,
  warn = console.warn,
  retryDelays = macDmgBuildRetryDelaysMs,
}) => {
  for (let attempt = 1; attempt <= retryDelays.length + 1; attempt += 1) {
    const result = await run();
    const retryDelayMs = retryDelays[attempt - 1];

    if (!isTransientMacDmgBuildFailure(result) || retryDelayMs === undefined) return result;

    warn(
      `macOS DMG build attempt ${attempt} hit a transient hdiutil resource-busy failure; cleaning its partial image and retrying attempt ${attempt + 1} in ${retryDelayMs / 1000}s.`,
    );
    await cleanup();
    await wait(retryDelayMs);
  }

  throw new Error('macOS DMG build retry loop ended without a result.');
};

export const cleanupPartialMacDmg = async (target) => {
  if (!supportedTargets.has(target)) throw new Error(`Unsupported macOS target: ${target}`);

  const bundleDirectory = join(appRoot, 'src-tauri', 'target', target, 'release', 'bundle', 'macos');
  let entries;
  try {
    entries = await readdir(bundleDirectory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }

  const partialImages = entries.filter(
    (entry) => entry.isFile() && entry.name.startsWith('rw.') && entry.name.endsWith('.dmg'),
  );
  await Promise.all(partialImages.map((entry) => rm(join(bundleDirectory, entry.name), { force: true })));
};

const runTauriMacDmgBuild = (target) =>
  new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [yarnPath, 'tauri', 'build', '--verbose', '--ci', '--target', target, '--bundles', 'dmg'],
      {
        cwd: appRoot,
        env: process.env,
        stdio: ['inherit', 'pipe', 'pipe'],
      },
    );
    let output = '';
    let settled = false;

    const capture = (stream, chunk) => {
      stream.write(chunk);
      output = `${output}${chunk.toString()}`.slice(-retainedOutputLength);
    };
    child.stdout.on('data', (chunk) => capture(process.stdout, chunk));
    child.stderr.on('data', (chunk) => capture(process.stderr, chunk));
    child.once('error', (error) => {
      settled = true;
      resolve({ status: null, output, error });
    });
    child.once('close', (status) => {
      if (!settled) resolve({ status, output });
    });
  });

async function main(args = process.argv.slice(2)) {
  const [target, ...extraArgs] = args;
  if (!target || extraArgs.length > 0 || !supportedTargets.has(target)) {
    throw new Error('Usage: build-macos-dmg.mjs <aarch64-apple-darwin|x86_64-apple-darwin>');
  }

  const result = await runMacDmgBuildWithRetries({
    run: () => runTauriMacDmgBuild(target),
    cleanup: () => cleanupPartialMacDmg(target),
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exitCode = result.status ?? 1;
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
