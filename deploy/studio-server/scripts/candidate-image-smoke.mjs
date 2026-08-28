import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const fixturePath = path.join(
  rootDir,
  'deploy',
  'studio-server',
  'scripts',
  'fixtures',
  'managed-release-gate.rivet-project',
);
const imageNamespace = process.env.IMAGE_NAMESPACE?.trim();
const sourceTag = process.env.SOURCE_TAG?.trim();

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: rootDir,
      env: options.env ?? process.env,
      shell: false,
      stdio: options.stdio ?? 'inherit',
      windowsHide: true,
    });
    let output = '';
    child.stdout?.on('data', (chunk) => {
      output += String(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      output += String(chunk);
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0 || options.allowFailure) {
        resolve({ code: code ?? 1, output });
      } else {
        reject(new Error(`${command} ${args.join(' ')} failed with code ${code ?? 'unknown'}.\n${output}`.trim()));
      }
    });
  });
}

async function getAvailablePort() {
  return await new Promise((resolve, reject) => {
    const server = http.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function request(baseUrl, route, options = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    ...options,
    signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
  });
  if (!response.ok) {
    throw new Error(`${options.method ?? 'GET'} ${route} returned ${response.status}: ${await response.text()}`);
  }
  return response;
}

async function openExecutorSocket(baseUrl, cookie) {
  const url = new URL('/ws/executor/internal', baseUrl);
  await new Promise((resolve, reject) => {
    const request = http.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Key': Buffer.alloc(16, 1).toString('base64'),
        'Sec-WebSocket-Version': '13',
        Cookie: cookie,
      },
    });
    const timeout = setTimeout(
      () => request.destroy(new Error('Executor WebSocket did not open within 15 seconds.')),
      15_000,
    );
    request.once('upgrade', (response, socket) => {
      clearTimeout(timeout);
      socket.destroy();
      if (response.statusCode !== 101) {
        reject(new Error(`Executor WebSocket upgrade returned ${response.statusCode}.`));
        return;
      }
      resolve();
    });
    request.once('response', (response) => {
      clearTimeout(timeout);
      response.resume();
      reject(new Error(`Executor WebSocket upgrade returned HTTP ${response.statusCode}.`));
    });
    request.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    request.end();
  });
}

export function createCandidateWorkflowRequestBody() {
  return JSON.stringify('candidate-ok');
}

export function extractCandidateWorkflowValue(result) {
  return result?.value?.type === 'any' ? result.value.value : result;
}

async function main() {
  if (!imageNamespace || !sourceTag) {
    throw new Error('IMAGE_NAMESPACE and SOURCE_TAG are required.');
  }

  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-candidate-smoke-'));
  const projectName = `rivet-image-smoke-${process.env.GITHUB_RUN_ID ?? process.pid}`
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-');
  const port = await getAvailablePort();
  const key = `candidate-smoke-${process.env.GITHUB_RUN_ID ?? process.pid}`;
  const composeArgs = ['compose', '-p', projectName, '-f', 'deploy/studio-server/compose/docker-compose.yml'];
  const directories = {
    workflows: path.join(tempRoot, 'workflows'),
    recordings: path.join(tempRoot, 'recordings'),
    runtimeLibraries: path.join(tempRoot, 'runtime-libraries'),
  };
  await Promise.all(Object.values(directories).map((directory) => fs.mkdir(directory, { recursive: true })));

  const env = {
    ...process.env,
    RIVET_API_IMAGE: `${imageNamespace}/api:${sourceTag}`,
    RIVET_EXECUTOR_IMAGE: `${imageNamespace}/executor:${sourceTag}`,
    RIVET_PROXY_IMAGE: `${imageNamespace}/proxy:${sourceTag}`,
    RIVET_WEB_IMAGE: `${imageNamespace}/web:${sourceTag}`,
    RIVET_PORT: String(port),
    RIVET_KEY: key,
    RIVET_SERVER_UI_AUTH_MODE: 'key',
    RIVET_REQUIRE_UI_GATE_KEY: 'true',
    RIVET_WORKFLOWS_HOST_PATH: directories.workflows,
    RIVET_WORKFLOW_RECORDINGS_HOST_PATH: directories.recordings,
    RIVET_RUNTIME_LIBS_HOST_PATH: directories.runtimeLibraries,
    RIVET_DOCKER_WAIT_TIMEOUT: '420',
  };
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    await run(
      'docker',
      [
        ...composeArgs,
        'up',
        '-d',
        '--no-build',
        '--force-recreate',
        '--remove-orphans',
        '--wait',
        '--wait-timeout',
        '420',
      ],
      { env },
    );

    const unauthenticated = await fetch(`${baseUrl}/api/config`, {
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
    });
    const unauthenticatedBody = await unauthenticated.text();
    if (!unauthenticatedBody.includes('Enter Access Key')) {
      throw new Error(`Unauthenticated API request did not return the access gate (status ${unauthenticated.status}).`);
    }

    const login = await fetch(`${baseUrl}/__rivet_auth`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ key, return_to: '/' }),
      signal: AbortSignal.timeout(10_000),
    });
    if (login.status !== 303) {
      throw new Error(`UI key login returned ${login.status} instead of 303.`);
    }
    const cookie = login.headers.get('set-cookie')?.split(';', 1)[0];
    if (!cookie?.startsWith('rivet_ui_token=')) {
      throw new Error('UI key login did not issue the Rivet session cookie.');
    }

    await request(baseUrl, '/', { headers: { Cookie: cookie } });
    await request(baseUrl, '/api/config', { headers: { Cookie: cookie } });
    await openExecutorSocket(baseUrl, cookie);

    const fixtureContents = await fs.readFile(fixturePath, 'utf8');
    const upload = await request(baseUrl, '/api/workflows/projects/upload', {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        folderRelativePath: '',
        fileName: 'candidate-smoke.rivet-project',
        contents: fixtureContents,
      }),
    });
    const uploaded = await upload.json();
    const relativePath = uploaded.project?.relativePath;
    if (typeof relativePath !== 'string') {
      throw new Error('Candidate smoke project upload did not return a relativePath.');
    }

    await request(baseUrl, '/api/workflows/projects/publish', {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ relativePath, settings: { endpointName: 'candidate-smoke' } }),
    });
    const execution = await request(baseUrl, '/workflows/candidate-smoke', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: createCandidateWorkflowRequestBody(),
      timeoutMs: 60_000,
    });
    const executionBody = await execution.json();
    const executionValue = extractCandidateWorkflowValue(executionBody);
    if (executionValue?.environmentValue !== 'candidate-ok') {
      throw new Error(`Candidate workflow returned an unexpected result: ${JSON.stringify(executionBody)}`);
    }
    console.log(
      '[candidate-image-smoke] Candidate images passed authentication, routing, executor, and workflow execution checks.',
    );
  } catch (error) {
    console.error(
      `[candidate-image-smoke] Failure before cleanup: ${error instanceof Error ? error.stack ?? error.message : String(error)}`,
    );
    await run('docker', [...composeArgs, 'ps', '-a'], { env, allowFailure: true });
    await run('docker', [...composeArgs, 'logs', '--no-color', '--tail', '300'], { env, allowFailure: true });
    throw error;
  } finally {
    await run('docker', [...composeArgs, 'down', '--timeout', '5', '--volumes', '--remove-orphans'], {
      env,
      allowFailure: true,
    });
    await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(1);
  });
}
