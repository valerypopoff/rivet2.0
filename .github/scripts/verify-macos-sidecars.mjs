import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const TARGETS = {
  'aarch64-apple-darwin': { architecture: 'arm64', pnpmVersion: '8.8.0' },
  'x86_64-apple-darwin': { architecture: 'x86_64', pnpmVersion: '8.8.0' },
};

function resolveBundledSidecarPaths(macosDirectory) {
  // Tauri uses target-suffixed files to locate sidecars at build time, then
  // installs them under the externalBin basename inside the app bundle.
  return {
    executorPath: join(macosDirectory, 'app-executor'),
    pnpmPath: join(macosDirectory, 'pnpm'),
  };
}

function verifyArchitecture(binaryPath, target) {
  const architectures = execFileSync('lipo', ['-archs', binaryPath], { encoding: 'utf8' }).trim();
  assert.equal(
    architectures,
    target.architecture,
    `Expected ${binaryPath} to be a thin ${target.architecture} executable, found ${architectures || 'no architecture'}.`,
  );
  execFileSync('codesign', ['--verify', '--strict', '--verbose=2', binaryPath], { stdio: 'inherit' });
}

async function reserveLocalPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return address.port;
}

async function verifyExecutorStartup(executorPath) {
  const port = await reserveLocalPort();
  const isolatedHome = await mkdtemp(join(tmpdir(), 'rivet-macos-sidecar-'));
  const child = spawn(executorPath, [], {
    env: {
      ...process.env,
      HOME: isolatedHome,
      RIVET_EXECUTOR_HOST: '127.0.0.1',
      RIVET_EXECUTOR_PORT: String(port),
      RIVET_CODE_RUNNER_WORKER_POOL_SIZE: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const childClosed = new Promise((resolve) => child.once('close', resolve));
  let output = '';
  const appendOutput = (chunk) => {
    output += String(chunk);
  };
  child.stdout.on('data', appendOutput);
  child.stderr.on('data', appendOutput);

  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Executor did not become ready:\n${output}`)), 30_000);
      const cleanup = () => {
        clearTimeout(timeout);
        child.stdout.off('data', onData);
        child.stderr.off('data', onData);
        child.off('error', onError);
        child.off('close', onClose);
      };
      const onData = () => {
        if (output.includes(`Rivet app executor websocket listening on 127.0.0.1:${port}`)) {
          cleanup();
          resolve();
        }
      };
      const onError = (error) => {
        cleanup();
        reject(error);
      };
      const onClose = () => {
        cleanup();
        reject(new Error(`Executor exited before readiness:\n${output}`));
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      child.once('error', onError);
      child.once('close', onClose);
    });

    const socket = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Executor WebSocket did not connect:\n${output}`)), 10_000);
      socket.addEventListener('open', () => {
        clearTimeout(timeout);
        resolve();
      }, { once: true });
      socket.addEventListener('error', () => {
        clearTimeout(timeout);
        reject(new Error(`Executor WebSocket failed to connect:\n${output}`));
      }, { once: true });
    });
    await runExecutorSmokeTest(socket, output);
    socket.close();
  } finally {
    if (child.exitCode == null) {
      child.kill('SIGTERM');
      await Promise.race([childClosed, new Promise((resolve) => setTimeout(resolve, 5_000))]);
    }
    if (child.exitCode == null) {
      child.kill('SIGKILL');
      await Promise.race([childClosed, new Promise((resolve) => setTimeout(resolve, 5_000))]);
    }
    await rm(isolatedHome, { recursive: true, force: true });
  }
}

function createSmokeProject() {
  return {
    metadata: {
      id: 'macos-sidecar-smoke',
      title: 'macOS sidecar smoke test',
      description: '',
      mainGraphId: 'main',
    },
    plugins: [],
    graphs: {
      main: {
        metadata: { id: 'main', name: 'Main' },
        nodes: [
          {
            type: 'codeNew',
            id: 'source',
            title: 'Code',
            data: { code: "return 'native sidecar';" },
            visualData: { x: 0, y: 0 },
          },
          {
            type: 'graphOutput',
            id: 'result-output',
            title: 'result',
            data: { id: 'result', dataType: 'any' },
            visualData: { x: 100, y: 0 },
          },
        ],
        connections: [
          {
            outputNodeId: 'source',
            outputId: 'output',
            inputNodeId: 'result-output',
            inputId: 'value',
          },
        ],
      },
    },
  };
}

function assertSmokeResult(completed) {
  assert.deepEqual(completed.data.results.result, { type: 'any', value: 'native sidecar' });
}

async function runExecutorSmokeTest(socket, output) {
  const requestId = 'macos-sidecar-smoke';
  const done = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Executor did not complete its smoke test:\n${output}`));
    }, 15_000);
    const cleanup = () => {
      clearTimeout(timeout);
      socket.removeEventListener('message', onMessage);
      socket.removeEventListener('close', onClose);
    };
    const onClose = () => {
      cleanup();
      reject(new Error(`Executor socket closed during its smoke test:\n${output}`));
    };
    const onMessage = (event) => {
      const message = JSON.parse(String(event.data));
      if (message.requestId !== requestId) return;
      if (['error', 'nodeError', 'graphError'].includes(message.message)) {
        cleanup();
        reject(new Error(`Executor smoke test failed: ${JSON.stringify(message)}`));
      } else if (message.message === 'done') {
        cleanup();
        resolve(message);
      }
    };
    socket.addEventListener('message', onMessage);
    socket.addEventListener('close', onClose, { once: true });
  });

  socket.send(JSON.stringify({ type: 'set-dynamic-data', data: { project: createSmokeProject(), settings: {} } }));
  socket.send(JSON.stringify({ type: 'run', data: { requestId, graphId: 'main', useEditorCache: true } }));
  const completed = await done;
  assertSmokeResult(completed);
}

async function main(args = process.argv.slice(2)) {
  const [appPath, targetTriple] = args;
  const target = TARGETS[targetTriple];

  if (!appPath || !target) {
    throw new Error('Usage: verify-macos-sidecars.mjs <app-path> <aarch64-apple-darwin|x86_64-apple-darwin>');
  }

  const macosDirectory = join(appPath, 'Contents', 'MacOS');
  const appExecutableName = execFileSync(
    'plutil',
    ['-extract', 'CFBundleExecutable', 'raw', '-o', '-', join(appPath, 'Contents', 'Info.plist')],
    { encoding: 'utf8' },
  ).trim();
  assert.ok(appExecutableName && !appExecutableName.includes('/'), `Could not read a safe CFBundleExecutable from ${appPath}.`);
  const appExecutablePath = join(macosDirectory, appExecutableName);
  const { executorPath, pnpmPath } = resolveBundledSidecarPaths(macosDirectory);

  for (const binaryPath of [appExecutablePath, executorPath, pnpmPath]) {
    verifyArchitecture(binaryPath, target);
  }
  const pnpmVersion = execFileSync(pnpmPath, ['--version'], { encoding: 'utf8' }).trim();
  assert.equal(pnpmVersion, target.pnpmVersion, `Unexpected pnpm version in ${pnpmPath}`);
  await verifyExecutorStartup(executorPath);
  console.log(`Verified native ${target.architecture} executor and pnpm sidecars in ${appPath}.`);
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}

export { assertSmokeResult, createSmokeProject, resolveBundledSidecarPaths };
