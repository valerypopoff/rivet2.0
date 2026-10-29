import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import { PassThrough } from 'node:stream';
import { once } from 'node:events';
import { createHmac, randomUUID } from 'node:crypto';
import type { GraphProcessor, Project, ProjectId, GraphId } from '@valerypopoff/rivet2-core';
import test from 'node:test';
import {
  createReviewedBackendPublicationFixtures,
  createReviewedFilesystemMutationFixtures,
} from './helpers/reviewed-publication.js';
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
  'RIVET_WORKFLOW_RECORDINGS_ROOT',
  'RIVET_APP_DATA_ROOT',
  'RIVET_RUNTIME_LIBRARIES_ROOT',
  'RIVET_STORAGE_MODE',
  'RIVET_KEY',
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

const { tempRoot, workflowsRoot, recordingsRoot, appDataRoot, runtimeLibrariesRoot } =
  await createWorkflowTestRoots('rivet-latest-debugger-');

process.env.RIVET_WORKSPACE_ROOT = tempRoot;
process.env.RIVET_WORKFLOWS_ROOT = workflowsRoot;
process.env.RIVET_WORKFLOW_RECORDINGS_ROOT = recordingsRoot;
process.env.RIVET_APP_DATA_ROOT = appDataRoot;
process.env.RIVET_RUNTIME_LIBRARIES_ROOT = runtimeLibrariesRoot;
process.env.RIVET_STORAGE_MODE = 'filesystem';
process.env.RIVET_KEY = 'latest-debugger-test-key';
process.env.RIVET_REQUIRE_UI_GATE_KEY = 'false';
delete process.env.RIVET_ENABLE_LATEST_REMOTE_DEBUGGER;
process.env.RIVET_RECORDINGS_ENABLED = 'false';
process.env.RIVET_PUBLISHED_WORKFLOWS_BASE_PATH = '/workflows';
process.env.RIVET_LATEST_WORKFLOWS_BASE_PATH = '/workflows-latest';
process.env.RIVET_PUBLISHED_APPS_BASE_PATH = '/apps';
process.env.RIVET_LATEST_APPS_BASE_PATH = '/apps-latest';
process.env.RIVET_WEB_APPS_BASE_PATH = '/apps';
process.env.RIVET_LATEST_WEB_APPS_BASE_PATH = '/apps-latest';

const { getExpectedProxyAuthToken, getExpectedUiSessionToken } = await import('../auth.js');
const { writeTrustedClientSettings } = await import('../trusted-client-settings.js');
const { createApiApp } = await import('../app.js');
const {
  initializeLatestWorkflowRemoteDebugger,
  isLatestWorkflowRemoteDebuggerEnabled,
  resetLatestWorkflowRemoteDebuggerForTests,
} = await import('../latestWorkflowRemoteDebugger.js');
const workflowFs = await import('../routes/workflows/fs-helpers.js');
const workflowMutations = createReviewedFilesystemMutationFixtures(
  await import('../routes/workflows/workflow-mutations.js'),
);
const workflowStorageBackend = createReviewedBackendPublicationFixtures(
  await import('../routes/workflows/storage-backend.js'),
);
const filesystemExecutionCache = await import('../routes/workflows/filesystem-execution-cache.js');
const workflowEndpointAuthSettings = await import('../workflow-endpoint-auth-settings.js');
const rivetNode = await import('@valerypopoff/rivet2-node');
const workflowRecordings = await import('../routes/workflows/recordings.js');

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
  process.env.RIVET_RECORDINGS_ENABLED = 'false';
  await workflowRecordings.resetWorkflowRecordingStorageForTests();
  filesystemExecutionCache.resetFilesystemExecutionCacheForTests();
  await resetLatestWorkflowRemoteDebuggerForTests();
  await workflowStorageBackend.disposeWorkflowStorage();
  delete process.env.RIVET_ENABLE_LATEST_REMOTE_DEBUGGER;
  await resetWorkflowTestRoots({ workflowsRoot, recordingsRoot, appDataRoot, runtimeLibrariesRoot });
  await workflowEndpointAuthSettings.writeWorkflowEndpointAuthSettings({
    requireBearerAuth: false,
  });
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
  await workflowStorageBackend.publishWorkflowProjectWebAppsWithBackend(created.relativePath, [
    {
      uiGraphId: WEB_APP_TEST_UI_GRAPH_ID,
      slug,
    },
  ]);

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

async function connectDebuggerSocket(baseUrl: string, trusted = true, suffix = ''): Promise<WebSocket> {
  return connectWebSocket(toWebSocketUrl(baseUrl) + suffix, {
    headers: trusted ? trustedProxyHeaders() : {},
  });
}

void test('latest debugger revokes an established trusted-client socket after policy removal', async () => {
  const previousMode = process.env.RIVET_SERVER_UI_AUTH_MODE;
  process.env.RIVET_SERVER_UI_AUTH_MODE = 'key';
  await resetFilesystemState();
  await writeTrustedClientSettings({ trustedClients: ['10.20.0.0/16'] });
  const listener = await startApiServer('combined', { debuggerEnabled: true });
  let socket: WebSocket | undefined;
  try {
    socket = await connectWebSocket(toWebSocketUrl(listener.baseUrl), {
      headers: { ...trustedProxyHeaders(), 'x-rivet-client-ip': '10.20.1.2' },
    });
    const closed = once(socket, 'close', { signal: AbortSignal.timeout(5_000) });
    await writeTrustedClientSettings({ trustedClients: [] });
    await closed;
    assert.equal(socket.readyState, WebSocket.CLOSED);
    await expectWebSocketConnectionFailure(toWebSocketUrl(listener.baseUrl), {
      headers: { ...trustedProxyHeaders(), 'x-rivet-client-ip': '10.20.1.2', 'x-rivet-token-free-host': '1' },
    });
  } finally {
    socket?.terminate();
    await listener.close();
    if (previousMode === undefined) delete process.env.RIVET_SERVER_UI_AUTH_MODE;
    else process.env.RIVET_SERVER_UI_AUTH_MODE = previousMode;
  }
});

async function expectDebuggerConnectionFailure(baseUrl: string, trusted = true) {
  return expectWebSocketConnectionFailure(toWebSocketUrl(baseUrl), {
    headers: trusted ? trustedProxyHeaders() : {},
  });
}

void test('latest debugger rejects unreadable OAuth policy without escaping the upgrade callback', async (t) => {
  await resetFilesystemState();
  const previousMode = process.env.RIVET_SERVER_UI_AUTH_MODE;
  process.env.RIVET_SERVER_UI_AUTH_MODE = 'oauth';
  const { webAppAuthSettingsRepository } = await import('../web-app-auth-settings.js');
  t.mock.method(webAppAuthSettingsRepository, 'readSync', () => {
    throw new Error('policy storage unavailable');
  });
  const server = http.createServer();
  initializeLatestWorkflowRemoteDebugger(server);
  const socket = new PassThrough();
  let response = '';
  socket.on('data', (data) => {
    response += data.toString();
  });
  try {
    const req = { url: '/ws/latest-debugger', headers: trustedProxyHeaders() } as http.IncomingMessage;
    assert.doesNotThrow(() => server.emit('upgrade', req, socket, Buffer.alloc(0)));
    assert.match(response, /^HTTP\/1.1 503 /);
    assert.equal(socket.destroyed, true);
    const malformedSocket = new PassThrough();
    let malformedResponse = '';
    malformedSocket.on('data', (data) => {
      malformedResponse += data.toString();
    });
    assert.doesNotThrow(() => server.emit('upgrade', { ...req, url: 'http://[' }, malformedSocket, Buffer.alloc(0)));
    assert.match(malformedResponse, /^HTTP\/1.1 400 /);
    assert.equal(malformedSocket.destroyed, true);
  } finally {
    socket.destroy();
    await resetLatestWorkflowRemoteDebuggerForTests();
    if (previousMode === undefined) delete process.env.RIVET_SERVER_UI_AUTH_MODE;
    else process.env.RIVET_SERVER_UI_AUTH_MODE = previousMode;
  }
});

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
  const payload = (await response.json()) as { durationMs: number };
  assert.equal(typeof payload.durationMs, 'number');
}

test.beforeEach(async () => {
  await resetFilesystemState();
});

test.afterEach(async () => {
  await resetLatestWorkflowRemoteDebuggerForTests();
});

test.after(async () => {
  await workflowRecordings.resetWorkflowRecordingStorageForTests();
  await resetLatestWorkflowRemoteDebuggerForTests();
  await workflowStorageBackend.disposeWorkflowStorage();
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

void test('latest debugger defaults on unless explicitly disabled', () => {
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

void test('disposing latest debugger removes its HTTP upgrade listener', async () => {
  const server = http.createServer();
  const initialUpgradeListeners = server.listenerCount('upgrade');

  initializeLatestWorkflowRemoteDebugger(server);
  assert.equal(server.listenerCount('upgrade'), initialUpgradeListeners + 1);

  await resetLatestWorkflowRemoteDebuggerForTests();
  assert.equal(server.listenerCount('upgrade'), initialUpgradeListeners);

  initializeLatestWorkflowRemoteDebugger(server);
  assert.equal(server.listenerCount('upgrade'), initialUpgradeListeners + 1);

  await resetLatestWorkflowRemoteDebuggerForTests();
  assert.equal(server.listenerCount('upgrade'), initialUpgradeListeners);
});

void test('latest debugger receives events for latest endpoint execution', async () => {
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

void test('latest debugger receives events for latest web app action execution', async () => {
  await createPublishedWebApp('Latest Debugger Web App Fixture', 'latest-debugger-web-app', 'Latest Debugger Web App');
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
    const payload = (await response.json()) as { statePatch?: Record<string, unknown> };
    assert.deepEqual(payload.statePatch, { result: 'latest web app action' });

    const messages = await messagesPromise;
    assert.ok(messages.some((message) => message.message === 'start'));
    assert.ok(messages.some((message) => message.message === 'done'));
  } finally {
    closeDebuggerSocket(socket);
    await server.close();
  }
});

void test('published endpoint execution does not emit latest debugger events', async () => {
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
      }),
    );

    await assertSuccessfulBlankWorkflowResponse(response);
  } finally {
    closeDebuggerSocket(socket);
    await server.close();
  }
});

void test('published web app action execution does not emit latest debugger events', async () => {
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
      }),
    );

    assert.equal(response.status, 200);
  } finally {
    closeDebuggerSocket(socket);
    await server.close();
  }
});

void test('latest debugger websocket rejects untrusted upgrades', async () => {
  const server = await startApiServer('control', { debuggerEnabled: true });

  try {
    const failure = await expectDebuggerConnectionFailure(server.baseUrl, false);
    assert.equal(failure.statusCode, 401);
  } finally {
    await server.close();
  }
});

void test('latest debugger websocket is unavailable when disabled', async () => {
  const server = await startApiServer('control', { debuggerEnabled: false });

  try {
    const failure = await expectDebuggerConnectionFailure(server.baseUrl);
    assert.equal(failure.statusCode, 404);
  } finally {
    await server.close();
  }
});

for (const disabledValue of ['false', '0', 'no', 'off']) {
  void test(`latest debugger websocket is unavailable when env is ${disabledValue}`, async () => {
    const server = await startApiServer('control', { debuggerEnvValue: disabledValue });

    try {
      const failure = await expectDebuggerConnectionFailure(server.baseUrl);
      assert.equal(failure.statusCode, 404);
    } finally {
      await server.close();
    }
  });
}

void test('execution-only profile does not provide latest debugger', async () => {
  const server = await startApiServer('execution');

  try {
    const failure = await expectDebuggerConnectionFailure(server.baseUrl);
    assert.ok(failure.statusCode != null || failure.error != null);
  } finally {
    await server.close();
  }
});

void test('api config advertises latest debugger websocket only when supported', async () => {
  const controlEnabled = await startApiServer('control');
  try {
    const response = await fetch(`${controlEnabled.baseUrl}/api/config`, {
      headers: trustedProxyHeaders(),
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(response.status, 200);
    const payload = (await response.json()) as {
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
    const payload = (await response.json()) as { remoteDebuggerDefaultWs: string };
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

void test('multiple debugger clients on the single backend all observe latest runs', async () => {
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

    const [firstMessages, secondMessages] = await Promise.all([firstMessagesPromise, secondMessagesPromise]);

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

void test('same endpoint executions are isolated by URL channel, including late replay and the default channel', async () => {
  const created = await createPublishedWorkflow('Channel Fixture', 'channel-fixture');
  const [project] = await rivetNode.loadProjectAndAttachedDataFromFile(created.absolutePath);
  process.env.RIVET_RECORDINGS_ENABLED = 'true';
  const server = await startApiServer('control', { debuggerEnabled: true });
  const clients: WebSocket[] = [];
  try {
    const a = await connectDebuggerSocket(server.baseUrl, true, '@00123');
    clients.push(a);
    const b = await connectDebuggerSocket(server.baseUrl, true, '@B');
    clients.push(b);
    const ordinary = await connectDebuggerSocket(server.baseUrl);
    clients.push(ordinary);
    const received = clients.map(() => [] as Array<{ message: string; rivetScope?: { channel: string | null } }>);
    clients.forEach((client, i) => client.on('message', (raw) => received[i]!.push(JSON.parse(raw.toString()))));
    clients.push(await connectDebuggerSocket(server.baseUrl, true, '@00123'));
    for (const [client, suffix] of [
      [a, '@00123'],
      [b, '@B'],
      [ordinary, ''],
    ] as const) {
      const terminal = waitForDebuggerMessages(client, ['start', 'done']);
      const response = await fetch(`${server.baseUrl}/workflows-latest/channel-fixture${suffix}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      await assertSuccessfulBlankWorkflowResponse(response);
      await terminal;
    }
    for (const [i, channel] of ['00123', 'B', null].entries()) {
      const starts = received[i]!.filter((message) => message.message === 'start');
      assert.equal(starts.length, 1);
      assert.equal(starts[0]!.rivetScope?.channel, channel);
      assert.ok(received[i]!.every((message) => !message.rivetScope || message.rivetScope.channel === channel));
    }
    const replay: Array<{ message: string; rivetScope?: { channel: string | null } }> = [];
    const late = new WebSocket(toWebSocketUrl(server.baseUrl) + '@00123', { headers: trustedProxyHeaders() });
    clients.push(late);
    late.on('message', (raw) => replay.push(JSON.parse(raw.toString())));
    await waitForDebuggerMessages(late, ['start', 'done']);
    assert.equal(replay.filter((message) => message.message === 'start').length, 1);
    assert.ok(replay.every((message) => !message.rivetScope || message.rivetScope.channel === '00123'));
    await workflowRecordings.flushWorkflowExecutionRecordingPersistence();
    const recordings = await workflowRecordings.listWorkflowRecordingRunsPage(
      workflowsRoot,
      project.metadata.id!,
      1,
      20,
      'all',
    );
    assert.equal(recordings.runs.length, 3, 'two viewers and replay cannot create extra recordings');
    assert.equal(new Set(recordings.runs.map((run) => run.id)).size, 3);
    assert.ok(
      recordings.runs.every((run) => run.endpointNameAtExecution === 'channel-fixture'),
      'channel suffixes never become recording endpoint identity',
    );
    assert.ok(
      recordings.runs.every((run) => run.cost?.status === 'complete' && run.cost.knownCostUsd === 0),
      'the real no-AI execution accounting is persisted independently of observers',
    );
  } finally {
    await workflowRecordings.flushWorkflowExecutionRecordingPersistence();
    clients.forEach(closeDebuggerSocket);
    await server.close();
  }
});

void test('production HA initializer preserves authenticated large-history replay and real workflow observations', async () => {
  const identity = randomUUID();
  const configuration = {
    RIVET_HA_PROTOCOL: '1',
    RIVET_HA_PEER_LIMIT: '2',
    RIVET_POD_NAME: 'backend-0',
    RIVET_PROCESS_INCARNATION: identity,
    RIVET_HA_HEADLESS_SERVICE: 'fixture.invalid',
    RIVET_HA_BACKEND_NAME: 'backend',
    RIVET_BACKEND_API_PORT: '8080',
    RIVET_BACKEND_EXECUTOR_PORT: '21889',
    RIVET_LEGACY_RESTORE_INSTALLATION: 'ha-initializer-fixture',
    RIVET_SERVER_UI_AUTH_MODE: 'key',
  };
  const previous = new Map(Object.keys(configuration).map((key) => [key, process.env[key]]));
  Object.assign(process.env, configuration);
  const server = http.createServer();
  const clients: WebSocket[] = [];
  let listener: Awaited<ReturnType<typeof listenTestServer>> | undefined;
  let runner: ReturnType<typeof rivetNode.createProcessor> | undefined;
  const wait = async (condition: () => boolean) => {
    const deadline = Date.now() + 10_000;
    while (!condition()) {
      assert.ok(Date.now() < deadline, 'Production HA debugger fixture did not settle');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  try {
    const debuggerServer = initializeLatestWorkflowRemoteDebugger(server)!;
    listener = await listenTestServer(server);
    const base = listener.baseUrl.replace(/^http/, 'ws');
    assert.equal((await expectWebSocketConnectionFailure(`${base}/ws/latest-debugger`)).statusCode, 401);
    assert.equal(
      (await expectWebSocketConnectionFailure(`${base}/ws/latest-debugger`, { headers: trustedProxyHeaders() }))
        .statusCode,
      401,
    );
    const incarnation = randomUUID();
    const peerHeaders = {
      'x-rivet-latest-protocol': '2',
      'x-rivet-ha-pod': 'backend-1',
      'x-rivet-ha-incarnation': incarnation,
      'x-rivet-ha-peer': createHmac('sha256', process.env.RIVET_KEY!)
        .update(
          JSON.stringify([
            'rivet-latest-peer-v1',
            configuration.RIVET_LEGACY_RESTORE_INSTALLATION,
            'backend-1',
            incarnation,
          ]),
        )
        .digest('hex'),
    };
    for (const headers of [
      { ...peerHeaders, 'x-rivet-latest-protocol': '1' },
      { ...peerHeaders, 'x-rivet-ha-peer': '0'.repeat(64) },
      { ...peerHeaders, origin: 'https://public.invalid' },
    ])
      assert.equal((await expectWebSocketConnectionFailure(`${base}/internal/ha/latest`, { headers })).statusCode, 401);
    const historyProcessor = { id: 'history-fixture', on: () => () => {} } as unknown as GraphProcessor;
    debuggerServer.attach(historyProcessor);
    debuggerServer.broadcast(historyProcessor, 'start', {
      execution: { projectId: 'history-project', rootRunId: 'history-root', graphRunId: 'history-graph' },
    });
    for (let i = 0; i < 40; i++)
      debuggerServer.broadcast(historyProcessor, 'trace', {
        marker: `history-${i}`,
        padding: 'x'.repeat(1024 * 1024),
      });
    const observe = async (peer = false) => {
      const client = new WebSocket(`${base}${peer ? '/internal/ha/latest' : '/ws/latest-debugger'}`, {
        headers: peer
          ? peerHeaders
          : { ...trustedProxyHeaders(), cookie: `rivet_ui_token=${getExpectedUiSessionToken()}` },
      });
      clients.push(client);
      const frames: Array<{
        message: string;
        rivetEventId?: string;
        data?: { marker?: string; code?: string; execution?: { projectId?: string } };
      }> = [];
      client.on('message', (raw) => {
        const frame = JSON.parse(raw.toString());
        if (frame.message === 'trace') delete frame.data.padding;
        frames.push(frame);
      });
      await once(client, 'open');
      await wait(() => frames.some((frame) => frame.data?.marker === 'history-39'));
      assert.equal(client.readyState, WebSocket.OPEN);
      if (peer) assert.ok(frames.every((frame) => frame.rivetEventId || frame.message === 'latest-peer'));
      else {
        assert.equal(frames[0]!.message, 'latest-session');
        assert.equal(frames.filter((frame) => frame.data?.code === 'history-truncated').length, 1);
      }
      return { client, frames };
    };
    const browser = await observe(),
      peer = await observe(true);
    const graphId = 'main' as GraphId;
    const project: Project = {
      metadata: { id: 'ha-live-project' as ProjectId, title: 'HA live project', description: '', mainGraphId: graphId },
      graphs: { [graphId]: { metadata: { id: graphId, name: 'Main Graph' }, nodes: [], connections: [] } },
      plugins: [],
    };
    runner = rivetNode.createProcessor(project, { remoteDebugger: debuggerServer });
    await runner.run();
    await wait(() =>
      [browser, peer].every((observer) =>
        observer.frames.some(
          (frame) => frame.message === 'done' && frame.data?.execution?.projectId === project.metadata.id,
        ),
      ),
    );
    browser.client.terminate();
    const resumed = await observe();
    await runner.run();
    const fence = `live-fence-${randomUUID()}`;
    debuggerServer.broadcast(historyProcessor, 'trace', { marker: fence });
    await wait(() =>
      [resumed, peer].every((observer) => observer.frames.some((frame) => frame.data?.marker === fence)),
    );
    for (const observer of [resumed, peer]) {
      const ids = observer.frames.flatMap((frame) => (frame.rivetEventId ? [frame.rivetEventId] : []));
      assert.equal(new Set(ids).size, ids.length);
      const sequences = ids.map((id) => Number(id.split(':').at(-1)));
      assert.ok(sequences.every((sequence, i) => i === 0 || sequence > sequences[i - 1]!));
      assert.ok(!observer.frames.some((frame) => frame.message === 'error'));
      assert.equal(observer.client.readyState, WebSocket.OPEN);
    }
  } finally {
    runner?.dispose();
    clients.forEach((client) => closeWebSocket(client));
    await resetLatestWorkflowRemoteDebuggerForTests();
    await listener?.close();
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
