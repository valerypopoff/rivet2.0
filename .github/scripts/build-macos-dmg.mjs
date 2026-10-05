import { execFile, execFileSync, spawn } from 'node:child_process';
import { readdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const appRoot = join(repositoryRoot, 'packages', 'app');
const yarnPath = join(repositoryRoot, '.yarn', 'releases', 'yarn-4.17.1.cjs');
const supportedTargets = new Set(['aarch64-apple-darwin', 'x86_64-apple-darwin']);
const retainedOutputLength = 64 * 1024;
const execute = promisify(execFile);
const runDiskCommand = (args) => execute('/usr/bin/hdiutil', args, { timeout: 30_000 });
const listAttachedImages = async () => {
  const { stdout } = await runDiskCommand(['info', '-plist']);
  return JSON.parse(
    execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '-'], {
      input: stdout,
      encoding: 'utf8',
      timeout: 30_000,
    }),
  ).images;
};

export const macDmgBuildRetryDelaysMs = [5_000, 15_000];

const transientMacDmgBuildFailures = [
  {
    kind: 'hdiutil-resource-busy',
    message: 'hdiutil: create failed - Resource busy',
    description: 'hdiutil resource-busy failure',
  },
  {
    kind: 'apple-secure-timestamp',
    message: 'A timestamp was expected but was not found.',
    description: 'Apple secure-timestamp failure',
  },
];

export const getTransientMacDmgBuildFailure = (result) => {
  if (result.status === 0) return undefined;
  if (/hdiutil: couldn't eject "disk\d+" - Resource busy/.test(result.output)) {
    return { kind: 'hdiutil-detach-busy', description: 'hdiutil scratch-image unmount failure' };
  }
  return transientMacDmgBuildFailures.find(({ message }) => result.output.includes(message));
};

export const isTransientMacDmgBuildFailure = (result) => getTransientMacDmgBuildFailure(result) !== undefined;

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
    const transientFailure = getTransientMacDmgBuildFailure(result);

    if (!transientFailure || retryDelayMs === undefined) return result;

    warn(
      `macOS DMG build attempt ${attempt} hit a transient ${transientFailure.description}; cleaning its partial image and retrying attempt ${attempt + 1} in ${retryDelayMs / 1000}s.`,
    );
    await cleanup();
    await wait(retryDelayMs);
  }

  throw new Error('macOS DMG build retry loop ended without a result.');
};

export const cleanupPartialMacDmg = async (
  target,
  { root = appRoot, listImages = listAttachedImages, diskCommand = runDiskCommand } = {},
) => {
  if (!supportedTargets.has(target)) throw new Error(`Unsupported macOS target: ${target}`);

  const bundleDirectory = join(root, 'src-tauri', 'target', target, 'release', 'bundle', 'macos');
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
  if (partialImages.length === 0) return;
  const attachedImages = await listImages();
  if (!Array.isArray(attachedImages)) throw new Error('Unable to inspect attached DMG images safely.');
  for (const entry of partialImages) {
    const imagePath = join(bundleDirectory, entry.name);
    for (const image of attachedImages) {
      if (typeof image['image-path'] !== 'string' || resolve(image['image-path']) !== resolve(imagePath)) continue;
      const device = image['system-entities']?.find((entity) => /^\/dev\/disk\d+$/.test(entity['dev-entry']))?.['dev-entry'];
      if (!device) throw new Error('Owned scratch DMG has no identifiable whole-disk device; refusing cleanup.');
      try {
        await diskCommand(['detach', device]);
      } catch (error) {
        // Tauri has already exhausted its normal unmount retries. Force only our disposable scratch image.
        if (error.code !== 16) throw error;
        await diskCommand(['detach', device, '-force']);
      }
    }
    await rm(imagePath, { force: true });
  }
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
