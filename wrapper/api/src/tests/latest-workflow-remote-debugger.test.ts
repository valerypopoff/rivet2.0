import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import test from 'node:test';
import WebSocket from 'ws';
import { listenTestServer } from './helpers/http-server-harness.js';
import { createWorkflowTestRoots, resetWorkflowTestRoots } from './helpers/workflow-fixtures.js';
import {
  createWebAppProject,
  extractWebAppRevisionKey,
  serializeWebAppProject,
  WEB_APP_TEST_ACTION_COMPONENT_ID,
  WEB_APP_TEST_UI_GRAPH_ID,
} from './helpers/workflow-web-app-fixtures.js';
import {
  closeWebSocket,
  connectWebSocket,
  expectWebSocketConnectionFailure,
  parseJsonWebSocketMessage,
  waitForWebSocketMessages,
} from './helpers/websocket-harness.js';

const envKeys = [
  'RIVET_WORKSPACE_ROOT',
  'RIVET_WORKFLOWS_ROOT',
  'RIVET_APP_DATA_ROOT',
  'RIVET_RUNTIME_LIBRARIES_ROOT',
  'RIVET_STORAGE_MODE',
  'RIVET_KEY',
  'RIVET_REQUIRE_WORKFLOW_KEY',
  'RIVET_REQUIRE_UI_GATE_KEY',
  'RIVET_ENABLE_LATEST_REMOTE_DEBUGGER',
  'RIVET_RECORDINGS_ENABLED',
  'RIVET_PUBLISHED_WORKFLOWS_BASE_PATH',
  'RIVET_LATEST_WORKFLOWS_BASE_PATH',
  'RIVET_PUBLISHED_APPS_BASE_PATH',
  'RIVET_LATEST_APPS_BASE_PATH',
  'RIVET_WEB_APPS_BASE_PATH',
  'RIVET_LATEST_WEB_APPS_BASE_PATH',
] as const;

const previousEnv = new Map<string, string | undefined>();
for (const key of envKeys) {
  previousEnv.set(key, process.env[key]);
}

const { tempRoot, workflowsRoot, appDataRoot, runtimeLibrariesRoot } = await createWorkflowTestRoots('rivet-latest-debugger-');

process.env.RIVET_WORKSPACE_ROOT = tempRoot;
process.env.RIVET_WORKFLOWS_ROOT = workflowsRoot;
process.env.RIVET_APP_DATA_ROOT = appDataRoot;
process.env.RIVET_RUNTIME_LIBRARIES_ROOT = runtimeLibrariesRoot;
process.env.RIVET_STORAGE_MODE = 'filesystem';
process.env.RIVET_KEY = 'latest-debugger-test-key';
process.env.RIVET_REQUIRE_WORKFLOW_KEY = 'false';
process.env.RIVET_REQUIRE_UI_GATE_KEY = 'false';
delete process.env.RIVET_ENABLE_LATEST_REMOTE_DEBUGGER;
process.env.RIVET_RECORDINGS_ENABLED = 'false';
process.env.RIVET_PUBLISHED_WORKFLOWS_BASE_PATH = '/workflows';
process.env.RIVET_LATEST_WORKFLOWS_BASE_PATH = '/workflows-latest';
process.env.RIVET_PUBLISHED_APPS_BASE_PATH = '/apps';
process.env.RIVET_LATEST_APPS_BASE_PATH = '/apps-latest';
process.env.RIVET_WEB_APPS_BASE_PATH = '/apps';
process.env.RIVET_LATEST_WEB_APPS_BASE_PATH = '/apps-latest';

const { getExpectedProxyAuthToken } = await import('../auth.js');
const { createApiApp } = await import('../app.js');
const {
  initializeLatestWorkflowRemoteDebugger,
  isLatestWorkflowRemoteDebuggerEnabled,
  resetLatestWorkflowRemoteDebuggerForTests,
} = await import('../latestWorkflowRemoteDebugger.js');
const workflowFs = await import('../routes/workflows/fs-helpers.js');
const workflowMutations = await import('../routes/workflows/workflow-mutations.js');
const workflowStorageBackend = await import('../routes/workflows/storage-backend.js');
const filesystemExecutionCache = await import('../routes/workflows/filesystem-execution-cache.js');
const rivetNode = await import('@valerypopoff/rivet2-node');

type ApiProfile = 'combined' | 'control' | 'execution';

function trustedProxyHeaders(): Record<string, string> {
  return {
    'x-rivet-proxy-auth': getExpectedProxyAuthToken(),
  };
}

function toWebSocketUrl(baseUrl: string): string {
  return baseUrl.replace(/^http/, 'ws') + '/ws/latest-debugger';
}

async function resetFilesystemState(): Promise<void> {
  filesystemExecutionCache.resetFilesystemExecutionCacheForTests();
  await resetLatestWorkflowRemoteDebuggerForTests();
  delete process.env.RIVET_ENABLE_LATEST_REMOTE_DEBUGGER;
  await resetWorkflowTestRoots({ workflowsRoot, appDataRoot, runtimeLibrariesRoot });
  await workflowFs.ensureWorkflowsRoot();
}

async function createPublishedWorkflow(projectName: string, endpointName: string) {
  const created = await workflowMutations.createWorkflowProjectItem('', projectName);
  await workflowMutations.publishWorkflowProjectItem(created.relativePath, { endpointName });
  return created;
}

async function createPublishedWebApp(projectName: string, slug: string, appName: string) {
  const created = await workflowMutations.createWorkflowProjectItem('', projectName);
  const blankProjectContents = workflowFs.createBlankProjectFile(projectName);
  const project = createWebAppProject(rivetNode, blankProjectContents, appName);
  const serializedProject = serializeWebAppProject(rivetNode, project);

  await fs.writeFile(created.absolutePath, serializedProject, 'utf8');
  await workflowStorageBackend.publishWorkflowProjectWebAppsWithBackend(created.relativePath, [{
    uiGraphId: WEB_APP_TEST_UI_GRAPH_ID,
    slug,
  }]);

  return created;
}

async function startApiServer(
  profile: ApiProfile,
  options: { debuggerEnabled?: boolean; debuggerEnvValue?: string } = {},
): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
}> {
  if (typeof options.debuggerEnvValue === 'string') {
    process.env.RIVET_ENABLE_LATEST_REMOTE_DEBUGGER = options.debuggerEnvValue;
  } else if (typeof options.debuggerEnabled === 'boolean') {
    process.env.RIVET_ENABLE_LATEST_REMOTE_DEBUGGER = options.debuggerEnabled ? 'true' : 'false';
  } else {
    delete process.env.RIVET_ENABLE_LATEST_REMOTE_DEBUGGER;
  }

  const app = createApiApp(profile);
  const server = http.createServer(app);

  if (profile === 'combined' || profile === 'control') {
    initializeLatestWorkflowRemoteDebugger(server);
  }

  const listener = await listenTestServer(server);

  return {
    baseUrl: listener.baseUrl,
    async close() {
      await resetLatestWorkflowRemoteDebuggerForTests();
      await listener.close();
    },
  };
}

async function connectDebuggerSocket(baseUrl: string, trusted = true): Promise<WebSocket> {
  return connectWebSocket(toWebSocketUrl(baseUrl), {
    headers: trusted ? trustedProxyHeaders() : {},
  });
}

async function expectDebuggerConnectionFailure(baseUrl: string, trusted = true) {
  return expectWebSocketConnectionFailure(toWebSocketUrl(baseUrl), {
    headers: trusted ? trustedProxyHeaders() : {},
  });
}

async function waitForDebuggerMessages(socket: WebSocket, expectedMessages: string[], timeoutMs = 5000) {
  return waitForWebSocketMessages(socket, expectedMessages, {
    timeoutMs,
    parser: parseJsonWebSocketMessage,
  });
}

async function assertNoDebuggerMessages(socket: WebSocket, timeoutMs = 500): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, timeoutMs);
    timeout.unref?.();

    const cleanup = () => {
      clearTimeout(timeout);
      socket.off('message', handleMessage);
      socket.off('error', handleError);
    };

    const handleMessage = (raw: WebSocket.RawData) => {
      cleanup();
      reject(new Error(`Expected no debugger messages, got ${raw.toString()}`));
    };

    const handleError = (error: Error) => {
      cleanup();
      reject(error);
    };

    socket.on('message', handleMessage);
    socket.once('error', handleError);
  });
}

async function assertNoDebuggerMessagesDuring<T>(
  socket: WebSocket,
  action: () => Promise<T>,
  timeoutMs = 500,
): Promise<T> {
  let unexpectedMessage: string | null = null;

  const handleMessage = (raw: WebSocket.RawData) => {
    unexpectedMessage = raw.toString();
  };

  socket.on('message', handleMessage);
  try {
    const result = await action();
    if (unexpectedMessage != null) {
      throw new Error(`Expected no debugger messages, got ${unexpectedMessage}`);
    }

    await assertNoDebuggerMessages(socket, timeoutMs);
    return result;
  } finally {
    socket.off('message', handleMessage);
  }
}

function closeDebuggerSocket(socket: WebSocket | null | undefined): void {
  if (!socket) {
    return;
  }

  socket.removeAllListeners();
  closeWebSocket(socket);
}

async function assertSuccessfulBlankWorkflowResponse(response: Response): Promise<void> {
  assert.equal(response.status, 200);
  const payload = await response.json() as { durationMs: number };
  assert.equal(typeof payload.durationMs, 'number');
}

test.beforeEach(async () => {
  await resetFilesystemState();
});

test.afterEach(async () => {
  await resetLatestWorkflowRemoteDebuggerForTests();
});

test.after(async () => {
  await resetLatestWorkflowRemoteDebuggerForTests();
  await fs.rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });

  for (const key of envKeys) {
    const previousValue = previousEnv.get(key);
    if (previousValue == null) {
      delete process.env[key];
    } else {
      process.env[key] = previousValue;
    }
  }
});

test('latest debugger defaults on unless explicitly disabled', () => {
  delete process.env.RIVET_ENABLE_LATEST_REMOTE_DEBUGGER;
  assert.equal(isLatestWorkflowRemoteDebuggerEnabled(), true);

  for (const value of ['false', 'FALSE', '0', 'no', 'off']) {
    process.env.RIVET_ENABLE_LATEST_REMOTE_DEBUGGER = value;
    assert.equal(isLatestWorkflowRemoteDebuggerEnabled(), false);
  }

  for (const value of ['', 'true', '1', 'yes', 'surprise']) {
    process.env.RIVET_ENABLE_LATEST_REMOTE_DEBUGGER = value;
    assert.equal(isLatestWorkflowRemoteDebuggerEnabled(), true);
  }
});

test('latest debugger receives events for latest endpoint execution', async () => {
  await createPublishedWorkflow('Latest Debugger Fixture', 'latest-debugger-endpoint');
  const server = await startApiServer('control');
  let socket: WebSocket | null = null;

  try {
    socket = await connectDebuggerSocket(server.baseUrl);
    const messagesPromise = waitForDebuggerMessages(socket, ['start', 'done']);

    const response = await fetch(`${server.baseUrl}/workflows-latest/latest-debugger-endpoint`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: 'latest' }),
      signal: AbortSignal.timeout(5000),
    });

    await assertSuccessfulBlankWorkflowResponse(response);

    const messages = await messagesPromise;
    assert.ok(messages.some((message) => message.message === 'start'));
    assert.ok(messages.some((message) => message.message === 'done'));
  } finally {
    closeDebuggerSocket(socket);
    await server.close();
  }
});

test('latest debugger receives events for latest web app action execution', async () => {
  await createPublishedWebApp(
    'Latest Debugger Web App Fixture',
    'latest-debugger-web-app',
    'Latest Debugger Web App',
  );
  const server = await startApiServer('control', { debuggerEnabled: true });
  let socket: WebSocket | null = null;

  try {
    socket = await connectDebuggerSocket(server.baseUrl);

    const htmlResponse = await fetch(`${server.baseUrl}/apps-latest/latest-debugger-web-app`, {
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(htmlResponse.status, 200);
    const revisionKey = extractWebAppRevisionKey(await htmlResponse.text());

    const messagesPromise = waitForDebuggerMessages(socket, ['start', 'done']);
    const response = await fetch(`${server.baseUrl}/apps-latest/latest-debugger-web-app/actions/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        componentId: WEB_APP_TEST_ACTION_COMPONENT_ID,
        revisionKey,
        state: {
          prompt: 'latest web app action',
        },
      }),
      signal: AbortSignal.timeout(5000),
    });

    assert.equal(response.status, 200);
    const payload = await response.json() as { statePatch?: Record<string, unknown> };
    assert.deepEqual(payload.statePatch, { result: 'latest web app action' });

    const messages = await messagesPromise;
    assert.ok(messages.some((message) => message.message === 'start'));
    assert.ok(messages.some((message) => message.message === 'done'));
  } finally {
    closeDebuggerSocket(socket);
    await server.close();
  }
});

test('published endpoint execution does not emit latest debugger events', async () => {
  await createPublishedWorkflow('Published Debugger Fixture', 'published-no-debugger-endpoint');
  const server = await startApiServer('combined', { debuggerEnabled: true });
  let socket: WebSocket | null = null;

  try {
    socket = await connectDebuggerSocket(server.baseUrl);

    const response = await assertNoDebuggerMessagesDuring(socket, () =>
      fetch(`${server.baseUrl}/workflows/published-no-debugger-endpoint`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ value: 'published' }),
        signal: AbortSignal.timeout(5000),
      }));

    await assertSuccessfulBlankWorkflowResponse(response);
  } finally {
    closeDebuggerSocket(socket);
    await server.close();
  }
});

test('published web app action execution does not emit latest debugger events', async () => {
  await createPublishedWebApp(
    'Published Debugger Web App Fixture',
    'published-no-debugger-web-app',
    'Published Debugger Web App',
  );
  const server = await startApiServer('combined', { debuggerEnabled: true });
  let socket: WebSocket | null = null;

  try {
    socket = await connectDebuggerSocket(server.baseUrl);

    const htmlResponse = await fetch(`${server.baseUrl}/apps/published-no-debugger-web-app`, {
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(htmlResponse.status, 200);
    const revisionKey = extractWebAppRevisionKey(await htmlResponse.text());

    const response = await assertNoDebuggerMessagesDuring(socket, () =>
      fetch(`${server.baseUrl}/apps/published-no-debugger-web-app/actions/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          componentId: WEB_APP_TEST_ACTION_COMPONENT_ID,
          revisionKey,
          state: {
            prompt: 'published web app action',
          },
        }),
        signal: AbortSignal.timeout(5000),
      }));

    assert.equal(response.status, 200);
  } finally {
    closeDebuggerSocket(socket);
    await server.close();
  }
});

test('latest debugger websocket rejects untrusted upgrades', async () => {
  const server = await startApiServer('control', { debuggerEnabled: true });

  try {
    const failure = await expectDebuggerConnectionFailure(server.baseUrl, false);
    assert.equal(failure.statusCode, 401);
  } finally {
    await server.close();
  }
});

test('latest debugger websocket is unavailable when disabled', async () => {
  const server = await startApiServer('control', { debuggerEnabled: false });

  try {
    const failure = await expectDebuggerConnectionFailure(server.baseUrl);
    assert.equal(failure.statusCode, 404);
  } finally {
    await server.close();
  }
});

for (const disabledValue of ['false', '0', 'no', 'off']) {
  test(`latest debugger websocket is unavailable when env is ${disabledValue}`, async () => {
    const server = await startApiServer('control', { debuggerEnvValue: disabledValue });

    try {
      const failure = await expectDebuggerConnectionFailure(server.baseUrl);
      assert.equal(failure.statusCode, 404);
    } finally {
      await server.close();
    }
  });
}

test('execution-only profile does not provide latest debugger', async () => {
  const server = await startApiServer('execution');

  try {
    const failure = await expectDebuggerConnectionFailure(server.baseUrl);
    assert.ok(failure.statusCode != null || failure.error != null);
  } finally {
    await server.close();
  }
});

test('api config advertises latest debugger websocket only when supported', async () => {
  const controlEnabled = await startApiServer('control');
  try {
    const response = await fetch(`${controlEnabled.baseUrl}/api/config`, {
      headers: trustedProxyHeaders(),
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(response.status, 200);
    const payload = await response.json() as {
      latestAppsBasePath: string;
      publishedAppsBasePath: string;
      remoteDebuggerDefaultWs: string;
    };
    assert.match(payload.remoteDebuggerDefaultWs, /^ws:\/\/127\.0\.0\.1:\d+\/ws\/latest-debugger$/);
    assert.equal(payload.publishedAppsBasePath, '/apps');
    assert.equal(payload.latestAppsBasePath, '/apps-latest');
  } finally {
    await controlEnabled.close();
  }

  const combinedDisabled = await startApiServer('combined', { debuggerEnabled: false });
  try {
    const response = await fetch(`${combinedDisabled.baseUrl}/api/config`, {
      headers: trustedProxyHeaders(),
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(response.status, 200);
    const payload = await response.json() as { remoteDebuggerDefaultWs: string };
    assert.equal(payload.remoteDebuggerDefaultWs, '');
  } finally {
    await combinedDisabled.close();
  }

  const execution = await startApiServer('execution');
  try {
    const response = await fetch(`${execution.baseUrl}/api/config`, {
      headers: trustedProxyHeaders(),
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: 'Not found' });
  } finally {
    await execution.close();
  }
});

test('multiple debugger clients on the single backend all observe latest runs', async () => {
  await createPublishedWorkflow('Multi Client Fixture', 'multi-client-latest-endpoint');
  const server = await startApiServer('control', { debuggerEnabled: true });
  let firstSocket: WebSocket | null = null;
  let secondSocket: WebSocket | null = null;

  try {
    firstSocket = await connectDebuggerSocket(server.baseUrl);
    secondSocket = await connectDebuggerSocket(server.baseUrl);

    const firstMessagesPromise = waitForDebuggerMessages(firstSocket, ['start', 'done']);
    const secondMessagesPromise = waitForDebuggerMessages(secondSocket, ['start', 'done']);

    const response = await fetch(`${server.baseUrl}/workflows-latest/multi-client-latest-endpoint`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: 'latest' }),
      signal: AbortSignal.timeout(5000),
    });

    await assertSuccessfulBlankWorkflowResponse(response);

    const [firstMessages, secondMessages] = await Promise.all([
      firstMessagesPromise,
      secondMessagesPromise,
    ]);

    assert.ok(firstMessages.some((message) => message.message === 'start'));
    assert.ok(firstMessages.some((message) => message.message === 'done'));
    assert.ok(secondMessages.some((message) => message.message === 'start'));
    assert.ok(secondMessages.some((message) => message.message === 'done'));
  } finally {
    closeDebuggerSocket(firstSocket);
    closeDebuggerSocket(secondSocket);
    await server.close();
  }
});
