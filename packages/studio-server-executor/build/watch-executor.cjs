const { spawn } = require('node:child_process');
const { stat } = require('node:fs/promises');
const path = require('node:path');
const esbuild = require('esbuild');
const { createExecutorBuildOptions, executorBundlePath, repoRootDir } = require('./bundle-executor.cjs');

const configuredPollIntervalMs = Number.parseInt(process.env.CHOKIDAR_INTERVAL ?? '300', 10);
const pollIntervalMs =
  Number.isFinite(configuredPollIntervalMs) && configuredPollIntervalMs >= 100 ? configuredPollIntervalMs : 300;
let activeExecutor;
let restartChain = Promise.resolve();
let stopping = false;
let inputSignatures = new Map();

function waitForExit(child) {
  return new Promise((resolve) => child.once('exit', resolve));
}

async function stopExecutor(child) {
  if (child.exitCode !== null) return;

  const exitPromise = waitForExit(child);
  child.kill('SIGTERM');
  const exitedGracefully = await Promise.race([
    exitPromise.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 2_000)),
  ]);
  if (!exitedGracefully && child.exitCode === null) {
    child.kill('SIGKILL');
    await exitPromise;
  }
}

async function fileSignature(filePath) {
  try {
    const metadata = await stat(filePath, { bigint: true });
    return `${metadata.mtimeNs}:${metadata.size}`;
  } catch (error) {
    if (error?.code === 'ENOENT') return 'missing';
    throw error;
  }
}

async function snapshotWorkspaceInputs(inputNames) {
  const entries = await Promise.all(
    inputNames
      .filter((inputName) => !inputName.includes('node_modules') && !inputName.includes('.yarn/'))
      .map(async (inputName) => {
        const filePath = path.resolve(repoRootDir, inputName);
        return [filePath, await fileSignature(filePath)];
      }),
  );
  return new Map(entries);
}

async function workspaceInputsChanged() {
  for (const [filePath, previousSignature] of inputSignatures) {
    if ((await fileSignature(filePath)) !== previousSignature) return true;
  }
  return false;
}

async function refreshInputSignatures() {
  inputSignatures = new Map(
    await Promise.all([...inputSignatures.keys()].map(async (filePath) => [filePath, await fileSignature(filePath)])),
  );
}

async function replaceExecutor() {
  if (activeExecutor) {
    const previousExecutor = activeExecutor;
    activeExecutor = undefined;
    await stopExecutor(previousExecutor);
  }

  if (stopping) return;

  const child = spawn(process.execPath, [executorBundlePath], {
    env: {
      ...process.env,
      NODE_OPTIONS: process.env.RIVET_EXECUTOR_CHILD_NODE_OPTIONS ?? process.env.NODE_OPTIONS,
    },
    stdio: 'inherit',
  });
  activeExecutor = child;
  child.once('exit', () => {
    if (activeExecutor === child) activeExecutor = undefined;
  });
}

const restartPlugin = {
  name: 'restart-executor-after-build',
  setup(build) {
    build.onEnd(async (result) => {
      if (result.metafile) inputSignatures = await snapshotWorkspaceInputs(Object.keys(result.metafile.inputs));
      if (result.errors.length > 0 || stopping) return;
      restartChain = restartChain.then(replaceExecutor).catch((error) => {
        console.error('[studio-server-executor:dev] Failed to restart executor:', error);
      });
    });
  },
};

async function main() {
  const context = await esbuild.context({
    ...createExecutorBuildOptions([restartPlugin]),
    metafile: true,
  });
  let rebuildInProgress = false;

  const poll = setInterval(async () => {
    if (stopping || rebuildInProgress || inputSignatures.size === 0) return;
    rebuildInProgress = true;
    try {
      if (await workspaceInputsChanged()) {
        console.log('[studio-server-executor:dev] Workspace source changed; rebuilding executor.');
        await context.rebuild();
      }
    } catch (error) {
      console.error('[studio-server-executor:dev] Rebuild failed:', error);
      // A broken edit should produce one failed build, not a polling storm. The
      // next source change will differ from this refreshed failed snapshot and
      // trigger another attempt.
      await refreshInputSignatures();
    } finally {
      rebuildInProgress = false;
    }
  }, pollIntervalMs);

  const stop = async () => {
    if (stopping) return;
    stopping = true;
    clearInterval(poll);
    await context.dispose();
    await restartChain;
    if (activeExecutor) {
      const child = activeExecutor;
      activeExecutor = undefined;
      await stopExecutor(child);
    }
  };

  process.once('SIGINT', () => void stop().then(() => process.exit(0)));
  process.once('SIGTERM', () => void stop().then(() => process.exit(0)));

  await context.rebuild();
  const missingInputCount = [...inputSignatures.values()].filter((signature) => signature === 'missing').length;
  console.log(
    `[studio-server-executor:dev] Watching ${inputSignatures.size} workspace inputs every ${pollIntervalMs}ms (${missingInputCount} missing).`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
