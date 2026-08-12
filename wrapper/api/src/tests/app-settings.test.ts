import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { getExpectedExecutorAuthToken, getExpectedProxyAuthToken } from '../auth.js';
import { createApiApp } from '../app.js';
import { getCommandTimeout, getMaxOutputBytes } from '../security.js';
import {
  readNodeExecutorProxySettings,
  readRunRecordingsSettings,
  writeRunRecordingsSettings,
  writeNodeExecutorProxySettings,
} from '../routes/app-settings.js';
import {
  getRunRecordingsSettingsPath,
  getWorkflowRecordingConfig,
} from '../routes/workflows/recordings-config.js';
import { getWebAppAuthMode } from '../web-app-oauth.js';
import {
  getWebAppAuthSettingsPath,
  readWebAppAuthSettings,
  readWebAppAuthSettingsSync,
  writeWebAppAuthSettings,
} from '../web-app-auth-settings.js';
import {
  getPublicRouteSettingsPath,
  readPublicRouteSettings,
  readWebAppRouteSettings,
  writePublicRouteSettings,
  writeWebAppRouteSettings,
} from '../public-route-settings.js';
import {
  getDeploymentStorageSettingsPath,
  readDeploymentStorageSettings,
  writeDeploymentStorageSettings,
} from '../deployment-storage-settings.js';
import {
  getExecutorUrlOverrideSettingsPath,
  readExecutorUrlOverrideSettings,
  writeExecutorUrlOverrideSettings,
} from '../executor-url-override-settings.js';
import {
  getRuntimeLimitSettingsPath,
  readRuntimeLimitSettings,
  writeRuntimeLimitSettings,
} from '../runtime-limit-settings.js';
import {
  getTrustedHostSettingsPath,
  readTrustedHostSettings,
  writeTrustedHostSettings,
} from '../trusted-host-settings.js';
import {
  getWorkflowEndpointAuthSettingsPath,
  readWorkflowEndpointAuthSettings,
  writeWorkflowEndpointAuthSettings,
} from '../workflow-endpoint-auth-settings.js';
import {
  getManagedWorkflowStorageConfig,
  getWorkflowStorageBackendMode,
} from '../routes/workflows/storage-config.js';
import { writePrivateJsonSettingsFile } from '../settings-file-writer.js';
import {
  getEnvironmentVariableSettingsPath,
  readEnvironmentVariableSettings,
  readExecutionEnvironmentVariables,
} from '../environment-variable-settings.js';

const relevantEnvKeys = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'RIVET_APP_DATA_ROOT',
  'RIVET_RECORDINGS_MAX_PENDING_WRITES',
  'RIVET_RECORDINGS_MAX_RUNS_PER_ENDPOINT',
  'RIVET_RECORDINGS_RETENTION_DAYS',
  'RIVET_STORAGE_MODE',
  'RIVET_ARTIFACTS_HOST_PATH',
  'RIVET_DATABASE_MODE',
  'RIVET_DATABASE_CONNECTION_STRING',
  'RIVET_DATABASE_SSL_MODE',
  'RIVET_STORAGE_URL',
  'RIVET_STORAGE_ACCESS_KEY_ID',
  'RIVET_STORAGE_ACCESS_KEY',
  'RIVET_STORAGE_BACKEND',
  'RIVET_WORKFLOWS_STORAGE_BACKEND',
  'RIVET_DATABASE_URL',
  'RIVET_PUBLISHED_WORKFLOWS_BASE_PATH',
  'RIVET_LATEST_WORKFLOWS_BASE_PATH',
  'RIVET_PUBLISHED_APPS_BASE_PATH',
  'RIVET_LATEST_APPS_BASE_PATH',
  'RIVET_WEB_APPS_BASE_PATH',
  'RIVET_LATEST_WEB_APPS_BASE_PATH',
  'RIVET_WEB_APPS_AUTH_MODE',
  'OAUTH_AUTHORIZE_URL',
  'OAUTH_TOKEN_URL',
  'OAUTH_USER_URL',
  'OAUTH_CLIENT_ID',
  'OAUTH_CLIENT_SECRET',
  'OAUTH_CALLBACK_URL',
  'OAUTH_SCOPES',
  'OAUTH_EMAIL_CLAIM',
  'OAUTH_SESSION_SECRET',
  'OAUTH_SESSION_TTL_SECONDS',
  'OAUTH_CLIENT_AUTH_METHOD',
  'OAUTH_DEBUG_LOG_PROFILE',
  'RIVET_PROXY_READ_TIMEOUT',
  'RIVET_COMMAND_TIMEOUT',
  'RIVET_MAX_OUTPUT',
  'RIVET_DOCKER_WAIT_TIMEOUT',
  'RIVET_EXECUTOR_WS_URL',
  'RIVET_REMOTE_DEBUGGER_DEFAULT_WS',
  'RIVET_REQUIRE_WORKFLOW_KEY',
  'RIVET_UI_TOKEN_FREE_HOSTS',
  'RIVET_KEY',
  'OPENAI_API_KEY',
  'UI_MANAGED_ENVIRONMENT_VARIABLE_TEST',
] as const;

async function withAppSettingsEnv(run: (tempRoot: string) => Promise<void> | void) {
  const previous = new Map<string, string | undefined>();
  for (const key of relevantEnvKeys) {
    previous.set(key, process.env[key]);
    delete process.env[key];
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rivet-app-settings-'));
  process.env.RIVET_APP_DATA_ROOT = path.join(tempRoot, 'app-data');
  process.env.RIVET_KEY = 'app-settings-test-key';

  try {
    await run(tempRoot);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    for (const key of relevantEnvKeys) {
      const value = previous.get(key);
      if (value == null) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

async function startServer(profile: Parameters<typeof createApiApp>[0] = 'control') {
  const app = createApiApp(profile);
  const server = http.createServer(app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to bind test server');
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    async close() {
      server.close();
      await once(server, 'close');
    },
  };
}

function trustedProxyHeaders(): Record<string, string> {
  return {
    'x-rivet-proxy-auth': getExpectedProxyAuthToken(),
  };
}

function trustedExecutorHeaders(): Record<string, string> {
  return {
    ...trustedProxyHeaders(),
    'x-rivet-executor-auth': getExpectedExecutorAuthToken(),
  };
}

function setNodeExecutorProxySettingsReloaderForTest(reloader: (() => Promise<unknown> | unknown) | undefined) {
  (globalThis as typeof globalThis & {
    __rivetReloadNodeExecutorProxySettings?: () => Promise<unknown> | unknown;
  }).__rivetReloadNodeExecutorProxySettings = reloader;
}

function assertPrivateSettingsFile(filePath: string): void {
  if (process.platform === 'win32') {
    return;
  }

  assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
}

test('Node executor proxy settings ignore environment values until saved', async () => {
  await withAppSettingsEnv(async () => {
    process.env.HTTP_PROXY = 'http://env-proxy.local:3128';
    process.env.HTTPS_PROXY = 'http://env-secure-proxy.local:3128';
    process.env.NO_PROXY = 'localhost,executor';

    const defaultSettings = await readNodeExecutorProxySettings();
    assert.equal(defaultSettings.source, 'default');
    assert.equal(defaultSettings.httpProxy, '');
    assert.equal(defaultSettings.httpsProxy, '');
    assert.equal(defaultSettings.noProxy, '');

    const savedSettings = await writeNodeExecutorProxySettings({
      httpProxy: 'http://saved-proxy.local:3128',
      httpsProxy: '',
      noProxy: 'localhost,api,executor',
    });
    assert.equal(savedSettings.source, 'app-settings');

    const nextSettings = await readNodeExecutorProxySettings();
    assert.equal(nextSettings.source, 'app-settings');
    assert.equal(nextSettings.httpProxy, 'http://saved-proxy.local:3128');
    assert.equal(nextSettings.httpsProxy, '');
    assert.equal(nextSettings.noProxy, 'localhost,api,executor');
  });
});

test('Node executor proxy settings API saves and returns persisted values', async () => {
  await withAppSettingsEnv(async () => {
    let reloadCalls = 0;
    setNodeExecutorProxySettingsReloaderForTest(() => {
      reloadCalls += 1;
    });

    let server: Awaited<ReturnType<typeof startServer>> | undefined;
    try {
      server = await startServer();
      const saveResponse = await fetch(`${server.baseUrl}/api/app-settings/node-executor-proxy`, {
        method: 'PUT',
        headers: {
          ...trustedProxyHeaders(),
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          httpProxy: ' http://172.17.0.1:3128 ',
          httpsProxy: 'http://172.17.0.1:3128',
          noProxy: 'localhost,127.0.0.1,::1,api,web,executor,proxy,172.17.0.1',
        }),
      });

      assert.equal(saveResponse.status, 200);
      const saved = await saveResponse.json() as Record<string, unknown>;
      assert.equal(saved.source, 'app-settings');
      assert.equal(saved.httpProxy, 'http://172.17.0.1:3128');

      const readResponse = await fetch(`${server.baseUrl}/api/app-settings/node-executor-proxy`, {
        headers: trustedProxyHeaders(),
      });
      assert.equal(readResponse.status, 200);
      const settings = await readResponse.json() as Record<string, unknown>;
      assert.equal(settings.httpProxy, 'http://172.17.0.1:3128');
      assert.equal(settings.httpsProxy, 'http://172.17.0.1:3128');
      assert.equal(settings.noProxy, 'localhost,127.0.0.1,::1,api,web,executor,proxy,172.17.0.1');
      assert.equal(reloadCalls, 1);
    } finally {
      setNodeExecutorProxySettingsReloaderForTest(undefined);
      await server?.close();
    }
  });
});

test('App settings API supports revisioned partial updates without lost writes', async () => {
  await withAppSettingsEnv(async () => {
    const server = await startServer();
    try {
      const readResponse = await fetch(`${server.baseUrl}/api/app-settings/node-executor-proxy`, {
        headers: trustedProxyHeaders(),
      });
      assert.equal(readResponse.status, 200);
      const originalRevision = readResponse.headers.get('etag');
      assert.ok(originalRevision);

      const firstUpdate = await fetch(`${server.baseUrl}/api/app-settings/node-executor-proxy`, {
        method: 'PATCH',
        headers: {
          ...trustedProxyHeaders(),
          'content-type': 'application/json',
          'if-match': originalRevision,
        },
        body: JSON.stringify({ httpProxy: 'http://first-proxy.local:3128' }),
      });
      assert.equal(firstUpdate.status, 200);
      assert.notEqual(firstUpdate.headers.get('etag'), originalRevision);

      const staleUpdate = await fetch(`${server.baseUrl}/api/app-settings/node-executor-proxy`, {
        method: 'PATCH',
        headers: {
          ...trustedProxyHeaders(),
          'content-type': 'application/json',
          'if-match': originalRevision,
        },
        body: JSON.stringify({ httpsProxy: 'http://stale-proxy.local:3128' }),
      });
      assert.equal(staleUpdate.status, 409);

      const saved = await readNodeExecutorProxySettings();
      assert.equal(saved.httpProxy, 'http://first-proxy.local:3128');
      assert.equal(saved.httpsProxy, '');
    } finally {
      await server.close();
    }
  });
});

test('Executor URL override settings ignore environment values until saved', async () => {
  await withAppSettingsEnv(async () => {
    process.env.RIVET_EXECUTOR_WS_URL = 'wss://env.example.test/ws/executor';
    process.env.RIVET_REMOTE_DEBUGGER_DEFAULT_WS = 'wss://env.example.test/ws/debugger';

    const defaultSettings = await readExecutorUrlOverrideSettings();
    assert.equal(defaultSettings.source, 'default');
    assert.equal(defaultSettings.executorWsUrl, '');
    assert.equal(defaultSettings.remoteDebuggerDefaultWs, '');

    let server: Awaited<ReturnType<typeof startServer>> | undefined;
    try {
      server = await startServer();
      const configResponse = await fetch(`${server.baseUrl}/api/config`, {
        headers: {
          ...trustedProxyHeaders(),
          'x-forwarded-host': 'derived.example.test',
          'x-forwarded-proto': 'https',
        },
      });
      assert.equal(configResponse.status, 200);
      const config = await configResponse.json() as Record<string, unknown>;
      assert.equal(config.executorWsUrl, 'wss://derived.example.test/ws/executor/internal');
      assert.equal(config.remoteDebuggerDefaultWs, 'wss://derived.example.test/ws/latest-debugger');
    } finally {
      await server?.close();
    }

    const savedSettings = await writeExecutorUrlOverrideSettings({
      executorWsUrl: ' wss://saved.example.test/ws/executor ',
      remoteDebuggerDefaultWs: 'wss://saved.example.test/ws/latest-debugger',
    });
    assert.equal(savedSettings.source, 'app-settings');
    assert.equal(savedSettings.executorWsUrl, 'wss://saved.example.test/ws/executor');
    assert.equal(savedSettings.remoteDebuggerDefaultWs, 'wss://saved.example.test/ws/latest-debugger');

    const nextSettings = await readExecutorUrlOverrideSettings();
    assert.equal(nextSettings.executorWsUrl, 'wss://saved.example.test/ws/executor');
    assert.equal(nextSettings.remoteDebuggerDefaultWs, 'wss://saved.example.test/ws/latest-debugger');
  });
});

test('Executor URL override settings API saves and config returns persisted overrides', async () => {
  await withAppSettingsEnv(async () => {
    let server: Awaited<ReturnType<typeof startServer>> | undefined;
    try {
      server = await startServer();
      const saveResponse = await fetch(`${server.baseUrl}/api/app-settings/executor-url-overrides`, {
        method: 'PUT',
        headers: {
          ...trustedProxyHeaders(),
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          executorWsUrl: 'wss://override.example.test/ws/executor/internal',
          remoteDebuggerDefaultWs: 'wss://override.example.test/ws/latest-debugger',
        }),
      });

      assert.equal(saveResponse.status, 200);
      const saved = await saveResponse.json() as Record<string, unknown>;
      assert.equal(saved.source, 'app-settings');
      assert.equal(saved.executorWsUrl, 'wss://override.example.test/ws/executor/internal');

      const readResponse = await fetch(`${server.baseUrl}/api/app-settings/executor-url-overrides`, {
        headers: trustedProxyHeaders(),
      });
      assert.equal(readResponse.status, 200);
      const settings = await readResponse.json() as Record<string, unknown>;
      assert.equal(settings.executorWsUrl, 'wss://override.example.test/ws/executor/internal');
      assert.equal(settings.remoteDebuggerDefaultWs, 'wss://override.example.test/ws/latest-debugger');

      const configResponse = await fetch(`${server.baseUrl}/api/config`, {
        headers: {
          ...trustedProxyHeaders(),
          'x-forwarded-host': 'derived.example.test',
          'x-forwarded-proto': 'https',
        },
      });
      assert.equal(configResponse.status, 200);
      const config = await configResponse.json() as Record<string, unknown>;
      assert.equal(config.executorWsUrl, 'wss://override.example.test/ws/executor/internal');
      assert.equal(config.remoteDebuggerDefaultWs, 'wss://override.example.test/ws/latest-debugger');
    } finally {
      await server?.close();
    }
  });
});

test('Executor URL override settings reject non-websocket URLs', async () => {
  await withAppSettingsEnv(async () => {
    let server: Awaited<ReturnType<typeof startServer>> | undefined;
    try {
      server = await startServer();
      const saveResponse = await fetch(`${server.baseUrl}/api/app-settings/executor-url-overrides`, {
        method: 'PUT',
        headers: {
          ...trustedProxyHeaders(),
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          executorWsUrl: 'https://not-websocket.example.test/ws/executor',
          remoteDebuggerDefaultWs: '',
        }),
      });

      assert.equal(saveResponse.status, 400);
      assert.match((await saveResponse.json() as { error: string }).error, /must use ws or wss/);
    } finally {
      await server?.close();
    }
  });
});

test('Workflow endpoint auth settings default to requiring bearer auth and ignore environment values', async () => {
  await withAppSettingsEnv(async () => {
    process.env.RIVET_REQUIRE_WORKFLOW_KEY = 'false';

    const defaultSettings = await readWorkflowEndpointAuthSettings();
    assert.equal(defaultSettings.source, 'default');
    assert.equal(defaultSettings.requireBearerAuth, true);

    const savedSettings = await writeWorkflowEndpointAuthSettings({
      requireBearerAuth: false,
    });
    assert.equal(savedSettings.source, 'app-settings');
    assert.equal(savedSettings.requireBearerAuth, false);

    process.env.RIVET_REQUIRE_WORKFLOW_KEY = 'true';
    const nextSettings = await readWorkflowEndpointAuthSettings();
    assert.equal(nextSettings.requireBearerAuth, false);
  });
});

test('Workflow endpoint auth settings API saves and returns persisted values', async () => {
  await withAppSettingsEnv(async () => {
    let server: Awaited<ReturnType<typeof startServer>> | undefined;
    try {
      server = await startServer();
      const defaultResponse = await fetch(`${server.baseUrl}/api/app-settings/workflow-endpoint-auth`, {
        headers: trustedProxyHeaders(),
      });
      assert.equal(defaultResponse.status, 200);
      const defaultSettings = await defaultResponse.json() as Record<string, unknown>;
      assert.equal(defaultSettings.source, 'default');
      assert.equal(defaultSettings.requireBearerAuth, true);

      const saveResponse = await fetch(`${server.baseUrl}/api/app-settings/workflow-endpoint-auth`, {
        method: 'PUT',
        headers: {
          ...trustedProxyHeaders(),
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          requireBearerAuth: false,
        }),
      });
      assert.equal(saveResponse.status, 200);
      const savedSettings = await saveResponse.json() as Record<string, unknown>;
      assert.equal(savedSettings.source, 'app-settings');
      assert.equal(savedSettings.requireBearerAuth, false);

      const readResponse = await fetch(`${server.baseUrl}/api/app-settings/workflow-endpoint-auth`, {
        headers: trustedProxyHeaders(),
      });
      assert.equal(readResponse.status, 200);
      const readSettings = await readResponse.json() as Record<string, unknown>;
      assert.equal(readSettings.requireBearerAuth, false);
    } finally {
      await server?.close();
    }
  });
});

test('Workflow endpoint auth settings reject non-boolean values', async () => {
  await withAppSettingsEnv(async () => {
    let server: Awaited<ReturnType<typeof startServer>> | undefined;
    try {
      server = await startServer();
      const saveResponse = await fetch(`${server.baseUrl}/api/app-settings/workflow-endpoint-auth`, {
        method: 'PUT',
        headers: {
          ...trustedProxyHeaders(),
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          requireBearerAuth: 'false',
        }),
      });

      assert.equal(saveResponse.status, 400);
      assert.match((await saveResponse.json() as { error: string }).error, /must be true or false/);
    } finally {
      await server?.close();
    }
  });
});

test('Trusted host settings default empty and ignore environment values', async () => {
  await withAppSettingsEnv(async () => {
    process.env.RIVET_UI_TOKEN_FREE_HOSTS = 'env-trusted.example.test';

    const defaultSettings = await readTrustedHostSettings();
    assert.equal(defaultSettings.source, 'default');
    assert.deepEqual(defaultSettings.trustedHosts, []);

    const savedSettings = await writeTrustedHostSettings({
      trustedHosts: [
        ' Storyteller-Rivet-1.Internal.Yc.Prod.Litnet.Com ',
        'storyteller-rivet-1.internal.yc.prod.litnet.com',
        'localhost',
      ],
    });
    assert.equal(savedSettings.source, 'app-settings');
    assert.deepEqual(savedSettings.trustedHosts, [
      'storyteller-rivet-1.internal.yc.prod.litnet.com',
      'localhost',
    ]);

    process.env.RIVET_UI_TOKEN_FREE_HOSTS = 'ignored.example.test';
    const nextSettings = await readTrustedHostSettings();
    assert.deepEqual(nextSettings.trustedHosts, [
      'storyteller-rivet-1.internal.yc.prod.litnet.com',
      'localhost',
    ]);
  });
});

test('Trusted host settings API saves and returns persisted hosts', async () => {
  await withAppSettingsEnv(async () => {
    let server: Awaited<ReturnType<typeof startServer>> | undefined;
    try {
      server = await startServer();
      const saveResponse = await fetch(`${server.baseUrl}/api/app-settings/trusted-hosts`, {
        method: 'PUT',
        headers: {
          ...trustedProxyHeaders(),
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          trustedHosts: ['storyteller-rivet-1.internal.yc.prod.litnet.com', '127.0.0.1', '::1'],
        }),
      });
      assert.equal(saveResponse.status, 200);
      const savedSettings = await saveResponse.json() as Record<string, unknown>;
      assert.equal(savedSettings.source, 'app-settings');
      assert.deepEqual(savedSettings.trustedHosts, [
        'storyteller-rivet-1.internal.yc.prod.litnet.com',
        '127.0.0.1',
        '::1',
      ]);

      const readResponse = await fetch(`${server.baseUrl}/api/app-settings/trusted-hosts`, {
        headers: trustedProxyHeaders(),
      });
      assert.equal(readResponse.status, 200);
      const readSettings = await readResponse.json() as Record<string, unknown>;
      assert.deepEqual(readSettings.trustedHosts, savedSettings.trustedHosts);

      const settingsPath = getTrustedHostSettingsPath();
      const raw = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as Record<string, unknown>;
      assert.equal(raw.trustedHostsCsv, 'storyteller-rivet-1.internal.yc.prod.litnet.com,127.0.0.1,::1');
      if (process.platform !== 'win32') {
        assert.equal(fs.statSync(settingsPath).mode & 0o777, 0o644);
      }
    } finally {
      await server?.close();
    }
  });
});

test('Trusted host settings reject unsafe host values', async () => {
  await withAppSettingsEnv(async () => {
    await assert.rejects(
      writeTrustedHostSettings({ trustedHosts: ['https://trusted.example.test'] }),
      /without protocol/,
    );
    await assert.rejects(
      writeTrustedHostSettings({ trustedHosts: ['trusted.example.test:8080'] }),
      /must not include ports/,
    );
    await assert.rejects(
      writeTrustedHostSettings({ trustedHosts: ['*.example.test'] }),
      /without protocol, path, or wildcard/,
    );
    await assert.rejects(
      writeTrustedHostSettings({ trustedHosts: 'trusted.example.test' }),
      /must be a list/,
    );
    await assert.rejects(
      writeTrustedHostSettings({
        trustedHosts: Array.from({ length: 101 }, (_, index) => `trusted-${index}.example.test`),
      }),
      /cannot contain more than 100 entries/,
    );
  });
});

test('App settings files are written with owner-only permissions', async () => {
  await withAppSettingsEnv(async () => {
    await writeNodeExecutorProxySettings({
      httpProxy: 'http://proxy-user:proxy-pass@proxy.local:3128',
      httpsProxy: '',
      noProxy: 'localhost,api',
    });
    await writeRunRecordingsSettings({
      maxPendingWrites: 100,
      maxRunsPerEndpoint: 2000,
      retentionDays: 0,
    });
    await writeExecutorUrlOverrideSettings({
      executorWsUrl: 'wss://executor.example.test/ws/executor/internal',
      remoteDebuggerDefaultWs: 'wss://debugger.example.test/ws/latest-debugger',
    });
    await writeWorkflowEndpointAuthSettings({
      requireBearerAuth: true,
    });
    await writeDeploymentStorageSettings({
      storageMode: 'managed',
      databaseMode: 'managed',
      databaseConnectionString: 'postgresql://db-user:db-pass@example-db:5432/rivet',
      storageUrl: 'https://bucket.sfo3.digitaloceanspaces.com',
      storageAccessKeyId: 'storage-key-id',
      storageAccessKey: 'storage-secret',
    });
    await writeWebAppAuthSettings({
      mode: 'oauth',
      provider: 'external',
      authorizeUrl: 'https://oauth.example.test/authorize',
      tokenUrl: 'https://oauth.example.test/token',
      userUrl: 'https://oauth.example.test/profile',
      clientId: 'client-id',
      clientSecret: 'client-secret',
      sessionSecret: 'session-secret',
    });

    const appDataRoot = process.env.RIVET_APP_DATA_ROOT;
    assert.ok(appDataRoot);
    assertPrivateSettingsFile(path.join(appDataRoot, 'settings', 'node-executor-proxy.json'));
    assertPrivateSettingsFile(getRunRecordingsSettingsPath());
    assertPrivateSettingsFile(getExecutorUrlOverrideSettingsPath());
    assertPrivateSettingsFile(getWorkflowEndpointAuthSettingsPath());
    assertPrivateSettingsFile(getDeploymentStorageSettingsPath());
    assertPrivateSettingsFile(getWebAppAuthSettingsPath());
  });
});

test('App settings concurrent saves use unique temporary files', async () => {
  await withAppSettingsEnv(async () => {
    const originalDateNow = Date.now;
    Date.now = () => 1234567890;

    try {
      await Promise.all([
        writeNodeExecutorProxySettings({
          httpProxy: 'http://proxy-one.local:3128',
          httpsProxy: '',
          noProxy: 'localhost,api',
        }),
        writeNodeExecutorProxySettings({
          httpProxy: 'http://proxy-two.local:3128',
          httpsProxy: '',
          noProxy: 'localhost,executor',
        }),
        writeRunRecordingsSettings({
          maxPendingWrites: 100,
          maxRunsPerEndpoint: 100,
          retentionDays: 14,
        }),
        writeRunRecordingsSettings({
          maxPendingWrites: 200,
          maxRunsPerEndpoint: 200,
          retentionDays: 0,
        }),
        writeDeploymentStorageSettings({
          storageMode: 'filesystem',
          artifactsHostPath: '../one',
        }),
        writeDeploymentStorageSettings({
          storageMode: 'filesystem',
          artifactsHostPath: '../two',
        }),
        writeWebAppAuthSettings({ mode: 'ui-gate' }),
        writeWebAppAuthSettings({ mode: 'none' }),
      ]);
    } finally {
      Date.now = originalDateNow;
    }

    const appDataRoot = process.env.RIVET_APP_DATA_ROOT;
    assert.ok(appDataRoot);
    const leftoverTempFiles = fs.readdirSync(path.join(appDataRoot, 'settings')).filter((fileName) => fileName.endsWith('.tmp'));
    assert.deepEqual(leftoverTempFiles, []);

    const proxySettings = await readNodeExecutorProxySettings();
    assert.match(proxySettings.httpProxy, /^http:\/\/proxy-(one|two)\.local:3128$/);
    const recordingsSettings = await readRunRecordingsSettings();
    assert.ok(recordingsSettings.maxPendingWrites === 100 || recordingsSettings.maxPendingWrites === 200);
    const deploymentStorageSettings = await readDeploymentStorageSettings();
    assert.match(deploymentStorageSettings.artifactsHostPath, /^\.\.\/(one|two)$/);
    const webAppAuthSettings = await readWebAppAuthSettings();
    assert.ok(webAppAuthSettings.mode === 'ui-gate' || webAppAuthSettings.mode === 'none');
  });
});

test('App settings failed writes clean up temporary files', async () => {
  await withAppSettingsEnv(async (tempRoot) => {
    const directoryTarget = path.join(tempRoot, 'settings-target-directory');
    fs.mkdirSync(directoryTarget);

    await assert.rejects(
      writePrivateJsonSettingsFile(directoryTarget, { secret: 'temporary-secret' }),
      /EEXIST|EPERM|EISDIR|ENOTEMPTY/,
    );

    const leftoverTempFiles = fs.readdirSync(tempRoot).filter((fileName) => fileName.includes('.tmp'));
    assert.deepEqual(leftoverTempFiles, []);
  });
});

test('Node executor proxy settings API stays behind trusted proxy auth', async () => {
  await withAppSettingsEnv(async () => {
    const server = await startServer();
    const originalConsoleError = console.error;
    console.error = (...args: unknown[]) => {
      if (String(args[1]).includes('Forbidden')) {
        return;
      }
      originalConsoleError(...args);
    };

    try {
      const response = await fetch(`${server.baseUrl}/api/app-settings/node-executor-proxy`);
      assert.equal(response.status, 403);
    } finally {
      console.error = originalConsoleError;
      await server.close();
    }
  });
});

test('Node executor proxy settings reject unsafe proxy values', async () => {
  await withAppSettingsEnv(async () => {
    await assert.rejects(
      writeNodeExecutorProxySettings({
        httpProxy: 'ftp://proxy.example.com',
        httpsProxy: '',
        noProxy: '',
      }),
      /HTTP_PROXY must use http or https/,
    );
  });
});

test('Node executor proxy settings fail loudly when saved fields have invalid types', async () => {
  await withAppSettingsEnv(async () => {
    const settingsPath = path.join(process.env.RIVET_APP_DATA_ROOT!, 'settings', 'node-executor-proxy.json');
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify({ version: 1, httpProxy: 123 }), 'utf8');

    await assert.rejects(readNodeExecutorProxySettings(), /HTTP_PROXY must be a string/);
  });
});

test('Run recordings settings ignore environment values until saved', async () => {
  await withAppSettingsEnv(async () => {
    process.env.RIVET_RECORDINGS_MAX_PENDING_WRITES = '1';
    process.env.RIVET_RECORDINGS_MAX_RUNS_PER_ENDPOINT = '2000';
    process.env.RIVET_RECORDINGS_RETENTION_DAYS = '0';

    const defaultSettings = await readRunRecordingsSettings();
    assert.equal(defaultSettings.source, 'default');
    assert.equal(defaultSettings.maxPendingWrites, 100);
    assert.equal(defaultSettings.maxRunsPerEndpoint, 100);
    assert.equal(defaultSettings.retentionDays, 14);
    assert.equal(getWorkflowRecordingConfig().maxPendingWrites, 100);
    assert.equal(getWorkflowRecordingConfig().maxRunsPerEndpoint, 100);
    assert.equal(getWorkflowRecordingConfig().retentionDays, 14);

    await writeRunRecordingsSettings({
      maxPendingWrites: 42,
      maxRunsPerEndpoint: 2000,
      retentionDays: 0,
    });

    const nextSettings = await readRunRecordingsSettings();
    assert.equal(nextSettings.source, 'app-settings');
    assert.equal(nextSettings.maxPendingWrites, 42);
    assert.equal(nextSettings.maxRunsPerEndpoint, 2000);
    assert.equal(nextSettings.retentionDays, 0);
    assert.equal(getWorkflowRecordingConfig().maxPendingWrites, 42);
    assert.equal(getWorkflowRecordingConfig().maxRunsPerEndpoint, 2000);
    assert.equal(getWorkflowRecordingConfig().retentionDays, 0);
  });
});

test('Run recordings settings API saves and returns persisted values', async () => {
  await withAppSettingsEnv(async () => {
    let server: Awaited<ReturnType<typeof startServer>> | undefined;
    try {
      server = await startServer();
      const saveResponse = await fetch(`${server.baseUrl}/api/app-settings/run-recordings`, {
        method: 'PUT',
        headers: {
          ...trustedProxyHeaders(),
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          maxPendingWrites: '80',
          maxRunsPerEndpoint: '2000',
          retentionDays: '0',
        }),
      });

      assert.equal(saveResponse.status, 200);
      const saved = await saveResponse.json() as Record<string, unknown>;
      assert.equal(saved.source, 'app-settings');
      assert.equal(saved.maxPendingWrites, 80);
      assert.equal(saved.maxRunsPerEndpoint, 2000);
      assert.equal(saved.retentionDays, 0);

      const readResponse = await fetch(`${server.baseUrl}/api/app-settings/run-recordings`, {
        headers: trustedProxyHeaders(),
      });
      assert.equal(readResponse.status, 200);
      const settings = await readResponse.json() as Record<string, unknown>;
      assert.equal(settings.maxPendingWrites, 80);
      assert.equal(settings.maxRunsPerEndpoint, 2000);
      assert.equal(settings.retentionDays, 0);
    } finally {
      await server?.close();
    }
  });
});

test('Run recordings settings reject invalid numbers', async () => {
  await withAppSettingsEnv(async () => {
    await assert.rejects(
      writeRunRecordingsSettings({
        maxPendingWrites: -1,
        maxRunsPerEndpoint: 100,
        retentionDays: 0,
      }),
      /Queued recording writes must be a non-negative whole number/,
    );
  });
});

test('Run recordings runtime settings fail loudly when the saved settings file is invalid', async () => {
  await withAppSettingsEnv(async () => {
    const settingsPath = getRunRecordingsSettingsPath();
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, '{bad json', 'utf8');

    await assert.rejects(readRunRecordingsSettings(), /JSON|Unexpected|Expected|position/);
    assert.throws(() => getWorkflowRecordingConfig(), /JSON|Unexpected|Expected|position/);

    fs.writeFileSync(settingsPath, JSON.stringify({ version: 1, maxPendingWrites: 'not-a-number' }), 'utf8');
    await assert.rejects(readRunRecordingsSettings(), /Queued recording writes/);
    assert.throws(() => getWorkflowRecordingConfig(), /Queued recording writes/);
  });
});

test('Runtime limit settings ignore environment values until saved', async () => {
  await withAppSettingsEnv(async () => {
    process.env.RIVET_PROXY_READ_TIMEOUT = '1s';
    process.env.RIVET_COMMAND_TIMEOUT = '1000';
    process.env.RIVET_MAX_OUTPUT = '1024';
    process.env.RIVET_DOCKER_WAIT_TIMEOUT = '3';

    const defaultSettings = await readRuntimeLimitSettings();
    assert.equal(defaultSettings.source, 'default');
    assert.equal(defaultSettings.commandTimeoutSeconds, 30);
    assert.equal(defaultSettings.maxOutputBytes, 10 * 1024 * 1024);
    assert.equal(defaultSettings.proxyReadTimeoutSeconds, 180);
    assert.equal(defaultSettings.webAppActionRequestLimitBytes, 100 * 1024 * 1024);
    assert.equal(defaultSettings.dockerWaitTimeoutSeconds, 1200);
    assert.equal(getCommandTimeout(), 30_000);
    assert.equal(getMaxOutputBytes(), 10 * 1024 * 1024);

    await writeRuntimeLimitSettings({
      commandTimeoutSeconds: 45,
      maxOutputBytes: 12 * 1024 * 1024,
      proxyReadTimeoutSeconds: 240,
      webAppActionRequestLimitBytes: 200 * 1024 * 1024,
      dockerWaitTimeoutSeconds: 1500,
    });

    const nextSettings = await readRuntimeLimitSettings();
    assert.equal(nextSettings.source, 'app-settings');
    assert.equal(nextSettings.commandTimeoutSeconds, 45);
    assert.equal(nextSettings.maxOutputBytes, 12 * 1024 * 1024);
    assert.equal(nextSettings.proxyReadTimeoutSeconds, 240);
    assert.equal(nextSettings.webAppActionRequestLimitBytes, 200 * 1024 * 1024);
    assert.equal(nextSettings.dockerWaitTimeoutSeconds, 1500);
    assert.equal(getCommandTimeout(), 45_000);
    assert.equal(getMaxOutputBytes(), 12 * 1024 * 1024);
  });
});

test('Runtime limit settings API saves and returns persisted values', async () => {
  await withAppSettingsEnv(async () => {
    let server: Awaited<ReturnType<typeof startServer>> | undefined;
    try {
      server = await startServer();
      const saveResponse = await fetch(`${server.baseUrl}/api/app-settings/runtime-limits`, {
        method: 'PUT',
        headers: {
          ...trustedProxyHeaders(),
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          commandTimeoutSeconds: '60',
          maxOutputBytes: String(20 * 1024 * 1024),
          proxyReadTimeoutSeconds: '300',
          webAppActionRequestLimitBytes: String(150 * 1024 * 1024),
          dockerWaitTimeoutSeconds: '1800',
        }),
      });

      assert.equal(saveResponse.status, 200);
      const saved = await saveResponse.json() as Record<string, unknown>;
      assert.equal(saved.source, 'app-settings');
      assert.equal(saved.commandTimeoutSeconds, 60);
      assert.equal(saved.maxOutputBytes, 20 * 1024 * 1024);
      assert.equal(saved.proxyReadTimeoutSeconds, 300);
      assert.equal(saved.webAppActionRequestLimitBytes, 150 * 1024 * 1024);
      assert.equal(saved.dockerWaitTimeoutSeconds, 1800);

      const readResponse = await fetch(`${server.baseUrl}/api/app-settings/runtime-limits`, {
        headers: trustedProxyHeaders(),
      });
      assert.equal(readResponse.status, 200);
      const settings = await readResponse.json() as Record<string, unknown>;
      assert.equal(settings.commandTimeoutSeconds, 60);
      assert.equal(settings.maxOutputBytes, 20 * 1024 * 1024);
      assert.equal(settings.proxyReadTimeoutSeconds, 300);
      assert.equal(settings.webAppActionRequestLimitBytes, 150 * 1024 * 1024);
      assert.equal(settings.dockerWaitTimeoutSeconds, 1800);

      const partialSaveResponse = await fetch(`${server.baseUrl}/api/app-settings/runtime-limits`, {
        method: 'PUT',
        headers: {
          ...trustedProxyHeaders(),
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          proxyReadTimeoutSeconds: '360',
        }),
      });
      assert.equal(partialSaveResponse.status, 200);
      const partiallySaved = await partialSaveResponse.json() as Record<string, unknown>;
      assert.equal(partiallySaved.commandTimeoutSeconds, 60);
      assert.equal(partiallySaved.maxOutputBytes, 20 * 1024 * 1024);
      assert.equal(partiallySaved.proxyReadTimeoutSeconds, 360);
      assert.equal(partiallySaved.webAppActionRequestLimitBytes, 150 * 1024 * 1024);
      assert.equal(partiallySaved.dockerWaitTimeoutSeconds, 1800);
    } finally {
      await server?.close();
    }
  });
});

test('Web app action JSON requests use the saved button-data limit on active app routes', async () => {
  await withAppSettingsEnv(async () => {
    await writeRuntimeLimitSettings({
      webAppActionRequestLimitBytes: 1024 * 1024,
    });

    const server = await startServer('combined');
    try {
      await writePublicRouteSettings({
        publishedWorkflowsBasePath: '/workflows',
        latestWorkflowsBasePath: '/workflows-latest',
        publishedAppsBasePath: '/published-apps',
        latestAppsBasePath: '/latest-apps',
      });

      for (const route of [
        '/published-apps/example/actions/run',
        '/published-apps/example/actions/run/',
        '/latest-apps/example/actions/run',
        '/latest-apps/example/actions/run/',
      ]) {
        const response = await fetch(`${server.baseUrl}${route}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ data: 'x'.repeat(1024 * 1024) }),
        });

        assert.equal(response.status, 413, route);
      }
    } finally {
      await server.close();
    }
  });
});

test('Runtime limit settings reject invalid values and fail loudly when saved file is invalid', async () => {
  await withAppSettingsEnv(async () => {
    await assert.rejects(
      writeRuntimeLimitSettings({
        commandTimeoutSeconds: 0,
      }),
      /Command timeout must be a positive whole number/,
    );

    await assert.rejects(
      writeRuntimeLimitSettings({
        commandTimeoutSeconds: true,
      }),
      /Command timeout must be a positive whole number/,
    );

    await assert.rejects(
      writeRuntimeLimitSettings({
        webAppActionRequestLimitBytes: 1,
      }),
      /Web app button data limit must be at least 1 MiB/,
    );

    const settingsPath = getRuntimeLimitSettingsPath();
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, '{bad json', 'utf8');

    await assert.rejects(readRuntimeLimitSettings(), /JSON|Unexpected|Expected|position/);
    assert.throws(() => getCommandTimeout(), /JSON|Unexpected|Expected|position/);

    fs.writeFileSync(settingsPath, JSON.stringify({ version: 1, proxyReadTimeoutSeconds: 'not-a-number' }), 'utf8');
    await assert.rejects(readRuntimeLimitSettings(), /Proxy read timeout/);

    fs.writeFileSync(settingsPath, JSON.stringify({ version: 1, proxyReadTimeoutSeconds: null }), 'utf8');
    await assert.rejects(readRuntimeLimitSettings(), /Proxy read timeout/);

    fs.writeFileSync(settingsPath, JSON.stringify([]), 'utf8');
    await assert.rejects(readRuntimeLimitSettings(), /Runtime limit settings must be an object/);
  });
});

test('Deployment storage settings ignore storage and database environment variables', async () => {
  await withAppSettingsEnv(async () => {
    process.env.RIVET_STORAGE_MODE = 'managed';
    process.env.RIVET_ARTIFACTS_HOST_PATH = '../env-artifacts';
    process.env.RIVET_DATABASE_MODE = 'managed';
    process.env.RIVET_DATABASE_CONNECTION_STRING = 'postgresql://env-user:env-pass@example-db:5432/rivet?sslmode=disable';
    process.env.RIVET_DATABASE_SSL_MODE = 'require';
    process.env.RIVET_STORAGE_URL = 'https://env-bucket.sfo3.digitaloceanspaces.com';
    process.env.RIVET_STORAGE_ACCESS_KEY_ID = 'env-key-id';
    process.env.RIVET_STORAGE_ACCESS_KEY = 'env-secret';

    const defaultSettings = await readDeploymentStorageSettings();
    assert.equal(defaultSettings.source, 'default');
    assert.equal(defaultSettings.storageMode, 'filesystem');
    assert.equal(defaultSettings.artifactsHostPath, '../');
    assert.equal(defaultSettings.databaseMode, 'local-docker');
    assert.equal(defaultSettings.databaseConnectionStringConfigured, false);
    assert.equal(defaultSettings.storageAccessKeyConfigured, false);
    assert.equal(defaultSettings.storageUrl, '');
    assert.equal(getWorkflowStorageBackendMode(), 'filesystem');

    const savedSettings = await writeDeploymentStorageSettings({
      storageMode: 'managed',
      artifactsHostPath: '../saved-artifacts',
      databaseMode: 'managed',
      databaseSslMode: 'verify-full',
      databaseConnectionString: 'postgresql://saved-user:saved-pass@example-db:5432/rivet',
      storageUrl: 'https://saved-bucket.sfo3.digitaloceanspaces.com',
      storageAccessKeyId: 'saved-key-id',
      storageAccessKey: 'saved-secret',
    });
    assert.equal(savedSettings.source, 'app-settings');

    process.env.RIVET_STORAGE_MODE = 'filesystem';
    process.env.RIVET_ARTIFACTS_HOST_PATH = '../ignored-artifacts';
    process.env.RIVET_STORAGE_URL = 'https://ignored-bucket.sfo3.digitaloceanspaces.com';

    const nextSettings = await readDeploymentStorageSettings();
    assert.equal(nextSettings.source, 'app-settings');
    assert.equal(nextSettings.storageMode, 'managed');
    assert.equal(nextSettings.artifactsHostPath, '../saved-artifacts');
    assert.equal(nextSettings.storageUrl, 'https://saved-bucket.sfo3.digitaloceanspaces.com');
    assert.equal(getWorkflowStorageBackendMode(), 'managed');
  });
});

test('Deployment storage settings ignore retired storage aliases after they are saved', async () => {
  await withAppSettingsEnv(async () => {
    await writeDeploymentStorageSettings({
      storageMode: 'managed',
      databaseMode: 'managed',
      databaseSslMode: 'verify-full',
      databaseConnectionString: 'postgresql://saved-user:saved-pass@example-db:5432/rivet',
      storageUrl: 'https://saved-bucket.sfo3.digitaloceanspaces.com',
      storageAccessKeyId: 'saved-key-id',
      storageAccessKey: 'saved-secret',
    });

    process.env.RIVET_STORAGE_BACKEND = 'filesystem';
    process.env.RIVET_DATABASE_URL = 'postgresql://legacy-user:legacy-pass@example-db:5432/legacy';
    process.env.RIVET_WORKFLOWS_STORAGE_BACKEND = 'filesystem';

    assert.equal(getWorkflowStorageBackendMode(), 'managed');
    const config = getManagedWorkflowStorageConfig();
    assert.equal(config.databaseUrl, 'postgresql://saved-user:saved-pass@example-db:5432/rivet');
    assert.equal(config.databaseSslMode, 'verify-full');
    assert.equal(config.objectStorageBucket, 'saved-bucket');
    assert.equal(config.objectStorageAccessKeyId, 'saved-key-id');
  });
});

test('Deployment storage settings API saves managed config and hides secrets', async () => {
  await withAppSettingsEnv(async () => {
    let server: Awaited<ReturnType<typeof startServer>> | undefined;
    try {
      server = await startServer();
      const saveResponse = await fetch(`${server.baseUrl}/api/app-settings/deployment-storage`, {
        method: 'PUT',
        headers: {
          ...trustedProxyHeaders(),
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          storageMode: 'managed',
          artifactsHostPath: '../artifacts',
          databaseMode: 'managed',
          databaseSslMode: 'verify-full',
          databaseConnectionString: 'postgresql://db-user:db-pass@example-db:5432/rivet',
          storageUrl: 'https://saved-bucket.sfo3.digitaloceanspaces.com',
          storageAccessKeyId: 'saved-key-id',
          storageAccessKey: 'saved-secret',
        }),
      });

      assert.equal(saveResponse.status, 200);
      const saved = await saveResponse.json() as Record<string, unknown>;
      assert.equal(saved.source, 'app-settings');
      assert.equal(saved.storageMode, 'managed');
      assert.equal(saved.databaseConnectionStringConfigured, true);
      assert.equal(saved.storageAccessKeyConfigured, true);
      assert.equal(saved.databaseConnectionString, undefined);
      assert.equal(saved.storageAccessKey, undefined);

      const config = getManagedWorkflowStorageConfig();
      assert.equal(config.databaseMode, 'managed');
      assert.equal(config.databaseSslMode, 'verify-full');
      assert.equal(config.objectStorageBucket, 'saved-bucket');
      assert.equal(config.objectStorageRegion, 'sfo3');
      assert.equal(config.objectStorageAccessKeyId, 'saved-key-id');
      assert.equal(config.objectStorageSecretAccessKey, 'saved-secret');

      const rotateResponse = await fetch(`${server.baseUrl}/api/app-settings/deployment-storage`, {
        method: 'PUT',
        headers: {
          ...trustedProxyHeaders(),
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          storageMode: 'managed',
          artifactsHostPath: '../artifacts',
          databaseMode: 'managed',
          databaseSslMode: 'require',
          databaseConnectionString: '',
          storageUrl: 'https://saved-bucket.sfo3.digitaloceanspaces.com',
          storageAccessKeyId: 'saved-key-id-2',
          storageAccessKey: '',
        }),
      });

      assert.equal(rotateResponse.status, 200);
      const rotated = await rotateResponse.json() as Record<string, unknown>;
      assert.equal(rotated.databaseConnectionStringConfigured, true);
      assert.equal(rotated.storageAccessKeyConfigured, true);
      assert.equal(getManagedWorkflowStorageConfig().objectStorageAccessKeyId, 'saved-key-id-2');
      assert.equal(getManagedWorkflowStorageConfig().objectStorageSecretAccessKey, 'saved-secret');
    } finally {
      await server?.close();
    }
  });
});

test('Deployment storage settings preserve managed SSL mode on partial saves', async () => {
  await withAppSettingsEnv(async () => {
    await writeDeploymentStorageSettings({
      storageMode: 'managed',
      artifactsHostPath: '../artifacts',
      databaseMode: 'managed',
      databaseSslMode: 'verify-full',
      databaseConnectionString: 'postgresql://db-user:db-pass@example-db:5432/rivet',
      storageUrl: 'https://saved-bucket.sfo3.digitaloceanspaces.com',
      storageAccessKeyId: 'saved-key-id',
      storageAccessKey: 'saved-secret',
    });

    await writeDeploymentStorageSettings({
      storageMode: 'managed',
      storageUrl: 'https://saved-bucket.sfo3.digitaloceanspaces.com',
      storageAccessKeyId: 'saved-key-id-2',
      storageAccessKey: '',
    });

    const settings = await readDeploymentStorageSettings();
    assert.equal(settings.databaseMode, 'managed');
    assert.equal(settings.databaseSslMode, 'verify-full');
    assert.equal(getManagedWorkflowStorageConfig().databaseSslMode, 'verify-full');
  });
});

test('Deployment storage settings preserve prepared managed secrets across storage mode switches', async () => {
  await withAppSettingsEnv(async () => {
    await writeDeploymentStorageSettings({
      storageMode: 'managed',
      artifactsHostPath: '../artifacts',
      databaseMode: 'managed',
      databaseSslMode: 'verify-full',
      databaseConnectionString: 'postgresql://saved-user:saved-pass@example-db:5432/rivet',
      storageUrl: 'https://saved-bucket.sfo3.digitaloceanspaces.com',
      storageAccessKeyId: 'saved-key-id',
      storageAccessKey: 'saved-secret',
    });

    await writeDeploymentStorageSettings({
      storageMode: 'filesystem',
      artifactsHostPath: '../artifacts',
      databaseMode: 'managed',
      databaseConnectionString: '',
      storageUrl: 'https://saved-bucket.sfo3.digitaloceanspaces.com',
      storageAccessKeyId: 'saved-key-id',
      storageAccessKey: '',
    });

    await writeDeploymentStorageSettings({
      storageMode: 'managed',
      artifactsHostPath: '../artifacts',
      databaseMode: 'managed',
      databaseConnectionString: '',
      storageUrl: 'https://saved-bucket.sfo3.digitaloceanspaces.com',
      storageAccessKeyId: 'saved-key-id',
      storageAccessKey: '',
    });

    const config = getManagedWorkflowStorageConfig();
    assert.equal(config.databaseUrl, 'postgresql://saved-user:saved-pass@example-db:5432/rivet');
    assert.equal(config.objectStorageSecretAccessKey, 'saved-secret');
  });
});

test('Deployment storage settings keep database and object storage sections independent', async () => {
  await withAppSettingsEnv(async () => {
    const preparedDatabase = await writeDeploymentStorageSettings({
      storageMode: 'filesystem',
      databaseMode: 'local-docker',
    });

    assert.equal(preparedDatabase.databaseMode, 'local-docker');
    assert.equal(preparedDatabase.databaseConnectionStringConfigured, true);
    assert.equal(preparedDatabase.storageUrl, '');
    assert.equal(preparedDatabase.storageAccessKeyId, '');
    assert.equal(preparedDatabase.storageAccessKeyConfigured, false);

    await assert.rejects(
      writeDeploymentStorageSettings({
        storageMode: 'managed',
        databaseMode: 'local-docker',
      }),
      /object storage URL/,
    );
  });
});

test('Deployment storage settings fail loudly when the saved settings file is invalid', async () => {
  await withAppSettingsEnv(async () => {
    const settingsPath = getDeploymentStorageSettingsPath();
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, '{bad json', 'utf8');

    await assert.rejects(readDeploymentStorageSettings(), /JSON|Unexpected|Expected|position/);
    assert.throws(() => getWorkflowStorageBackendMode(), /JSON|Unexpected|Expected|position/);
  });
});

test('Deployment storage settings reject incomplete managed config', async () => {
  await withAppSettingsEnv(async () => {
    await assert.rejects(
      writeDeploymentStorageSettings({
        storageMode: 'managed',
        databaseMode: 'managed',
        storageUrl: 'https://bucket.example.test',
        storageAccessKeyId: 'storage-key-id',
        storageAccessKey: 'storage-secret',
      }),
      /PostgreSQL connection string/,
    );
  });
});

test('Public route settings use deployment defaults until saved', async () => {
  await withAppSettingsEnv(async () => {
    process.env.RIVET_PUBLISHED_WORKFLOWS_BASE_PATH = '/env-workflows';
    process.env.RIVET_LATEST_WORKFLOWS_BASE_PATH = '/env-workflows-latest';
    process.env.RIVET_PUBLISHED_APPS_BASE_PATH = '/env-apps';
    process.env.RIVET_LATEST_APPS_BASE_PATH = '/env-apps-latest';

    const defaultSettings = await readPublicRouteSettings();
    assert.equal(defaultSettings.source, 'default');
    assert.equal(defaultSettings.publishedWorkflowsBasePath, '/env-workflows');
    assert.equal(defaultSettings.latestWorkflowsBasePath, '/env-workflows-latest');
    assert.equal(defaultSettings.publishedAppsBasePath, '/env-apps');
    assert.equal(defaultSettings.latestAppsBasePath, '/env-apps-latest');

    const savedSettings = await writePublicRouteSettings({
      publishedWorkflowsBasePath: 'public-workflows',
      latestWorkflowsBasePath: '/draft-workflows/',
      publishedAppsBasePath: 'public-tools',
      latestAppsBasePath: '/draft-tools/',
    });
    assert.equal(savedSettings.source, 'app-settings');
    assert.equal(savedSettings.publishedWorkflowsBasePath, '/public-workflows');
    assert.equal(savedSettings.latestWorkflowsBasePath, '/draft-workflows');
    assert.equal(savedSettings.publishedAppsBasePath, '/public-tools');
    assert.equal(savedSettings.latestAppsBasePath, '/draft-tools');

    process.env.RIVET_PUBLISHED_WORKFLOWS_BASE_PATH = '/ignored-workflows';
    process.env.RIVET_LATEST_WORKFLOWS_BASE_PATH = '/ignored-latest-workflows';
    process.env.RIVET_PUBLISHED_APPS_BASE_PATH = '/ignored-apps';
    process.env.RIVET_LATEST_APPS_BASE_PATH = '/ignored-latest-apps';

    const nextSettings = await readPublicRouteSettings();
    assert.equal(nextSettings.source, 'app-settings');
    assert.equal(nextSettings.publishedWorkflowsBasePath, '/public-workflows');
    assert.equal(nextSettings.latestWorkflowsBasePath, '/draft-workflows');
    assert.equal(nextSettings.publishedAppsBasePath, '/public-tools');
    assert.equal(nextSettings.latestAppsBasePath, '/draft-tools');
  });
});

test('Public route settings API saves and returns persisted values', async () => {
  await withAppSettingsEnv(async () => {
    let server: Awaited<ReturnType<typeof startServer>> | undefined;
    try {
      server = await startServer();
      const saveResponse = await fetch(`${server.baseUrl}/api/app-settings/public-routes`, {
        method: 'PUT',
        headers: {
          ...trustedProxyHeaders(),
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          publishedWorkflowsBasePath: 'published-workflows',
          latestWorkflowsBasePath: 'latest-workflows',
          publishedAppsBasePath: 'published-apps',
          latestAppsBasePath: 'latest-apps',
        }),
      });

      assert.equal(saveResponse.status, 200);
      const saved = await saveResponse.json() as Record<string, unknown>;
      assert.equal(saved.source, 'app-settings');
      assert.equal(saved.publishedWorkflowsBasePath, '/published-workflows');
      assert.equal(saved.latestWorkflowsBasePath, '/latest-workflows');
      assert.equal(saved.publishedAppsBasePath, '/published-apps');
      assert.equal(saved.latestAppsBasePath, '/latest-apps');

      const configResponse = await fetch(`${server.baseUrl}/api/config`, {
        headers: trustedProxyHeaders(),
      });
      assert.equal(configResponse.status, 200);
      const config = await configResponse.json() as Record<string, unknown>;
      assert.equal(config.publishedWorkflowsBasePath, '/published-workflows');
      assert.equal(config.latestWorkflowsBasePath, '/latest-workflows');
      assert.equal(config.publishedAppsBasePath, '/published-apps');
      assert.equal(config.latestAppsBasePath, '/latest-apps');

      const settingsPath = getPublicRouteSettingsPath();
      const raw = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as Record<string, unknown>;
      assert.equal(raw.publishedWorkflowsBasePath, '/published-workflows');
      assert.equal(raw.latestWorkflowsBasePath, '/latest-workflows');
      assert.equal(raw.publishedAppsBasePath, '/published-apps');
      assert.equal(raw.latestAppsBasePath, '/latest-apps');
    } finally {
      await server?.close();
    }
  });
});

test('Public route settings move workflow and web-app dispatch without recreating the API app', async () => {
  await withAppSettingsEnv(async () => {
    await writeWorkflowEndpointAuthSettings({ requireBearerAuth: false });
    await writeWebAppAuthSettings({ mode: 'none' });

    const readError = async (response: Response): Promise<string> => {
      const body = await response.json() as { error?: unknown };
      return String(body.error ?? '');
    };

    let server: Awaited<ReturnType<typeof startServer>> | undefined;
    try {
      server = await startServer('combined');

      const defaultWorkflowResponse = await fetch(`${server.baseUrl}/workflows/missing-endpoint`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      assert.equal(defaultWorkflowResponse.status, 404);
      assert.notEqual(await readError(defaultWorkflowResponse), 'Not found');

      const saveResponse = await fetch(`${server.baseUrl}/api/app-settings/public-routes`, {
        method: 'PUT',
        headers: {
          ...trustedProxyHeaders(),
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          publishedWorkflowsBasePath: 'published-workflows',
          latestWorkflowsBasePath: 'draft-workflows',
          publishedAppsBasePath: 'published-apps',
          latestAppsBasePath: 'draft-apps',
        }),
      });
      assert.equal(saveResponse.status, 200);

      const staleWorkflowResponse = await fetch(`${server.baseUrl}/workflows/missing-endpoint`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      assert.equal(staleWorkflowResponse.status, 404);
      assert.equal(await readError(staleWorkflowResponse), 'Not found');

      const movedWorkflowResponse = await fetch(`${server.baseUrl}/published-workflows/missing-endpoint`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      assert.equal(movedWorkflowResponse.status, 404);
      assert.notEqual(await readError(movedWorkflowResponse), 'Not found');

      const movedLatestWorkflowResponse = await fetch(`${server.baseUrl}/draft-workflows/missing-endpoint`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      assert.equal(movedLatestWorkflowResponse.status, 404);
      assert.notEqual(await readError(movedLatestWorkflowResponse), 'Not found');

      const staleWebAppResponse = await fetch(`${server.baseUrl}/apps/missing-app`);
      assert.equal(staleWebAppResponse.status, 404);
      assert.equal(await readError(staleWebAppResponse), 'Not found');

      const movedWebAppResponse = await fetch(`${server.baseUrl}/published-apps/missing-app`);
      assert.equal(movedWebAppResponse.status, 404);
      assert.notEqual(await readError(movedWebAppResponse), 'Not found');

      const movedLatestWebAppResponse = await fetch(`${server.baseUrl}/draft-apps/missing-app`);
      assert.equal(movedLatestWebAppResponse.status, 404);
      assert.notEqual(await readError(movedLatestWebAppResponse), 'Not found');
    } finally {
      await server?.close();
    }
  });
});

test('Public route settings keep the legacy web-app route endpoint compatible', async () => {
  await withAppSettingsEnv(async () => {
    await writePublicRouteSettings({
      publishedWorkflowsBasePath: 'workflows',
      latestWorkflowsBasePath: 'workflows-latest',
      publishedAppsBasePath: 'apps',
      latestAppsBasePath: 'apps-latest',
    });

    const settings = await writeWebAppRouteSettings({
      publishedAppsBasePath: 'tools',
      latestAppsBasePath: 'tools-latest',
    });
    assert.equal(settings.publishedAppsBasePath, '/tools');
    assert.equal(settings.latestAppsBasePath, '/tools-latest');

    const publicSettings = await readPublicRouteSettings();
    assert.equal(publicSettings.publishedWorkflowsBasePath, '/workflows');
    assert.equal(publicSettings.latestWorkflowsBasePath, '/workflows-latest');
    assert.equal(publicSettings.publishedAppsBasePath, '/tools');
    assert.equal(publicSettings.latestAppsBasePath, '/tools-latest');

    const legacyRead = await readWebAppRouteSettings();
    assert.equal(legacyRead.publishedAppsBasePath, '/tools');
    assert.equal(legacyRead.latestAppsBasePath, '/tools-latest');
  });
});

test('Public route settings reject invalid or conflicting slugs', async () => {
  await withAppSettingsEnv(async () => {
    await assert.rejects(
      () => writePublicRouteSettings({
        publishedWorkflowsBasePath: 'api',
        latestWorkflowsBasePath: 'latest-workflows',
        publishedAppsBasePath: 'apps',
        latestAppsBasePath: 'latest-apps',
      }),
      /reserved "api" route/,
    );

    await assert.rejects(
      () => writePublicRouteSettings({
        publishedWorkflowsBasePath: 'workflows',
        latestWorkflowsBasePath: 'workflows-latest',
        publishedAppsBasePath: 'workflows',
        latestAppsBasePath: 'latest-apps',
      }),
      /must be different/,
    );

    await assert.rejects(
      () => writePublicRouteSettings({
        publishedWorkflowsBasePath: 'workflows',
        latestWorkflowsBasePath: 'ui-auth',
        publishedAppsBasePath: 'apps',
        latestAppsBasePath: 'latest-apps',
      }),
      /reserved "ui-auth" route/,
    );

    await assert.rejects(
      () => writePublicRouteSettings({
        publishedWorkflowsBasePath: 'workflows',
        latestWorkflowsBasePath: 'workflows-latest',
        publishedAppsBasePath: 'assets',
        latestAppsBasePath: 'latest-apps',
      }),
      /reserved "assets" route/,
    );

    await assert.rejects(
      () => writePublicRouteSettings({
        publishedWorkflowsBasePath: 'workflows',
        latestWorkflowsBasePath: 'workflows-latest',
        publishedAppsBasePath: 'nested/apps',
        latestAppsBasePath: 'latest-apps',
      }),
      /single URL path segment/,
    );

    await assert.rejects(
      () => writePublicRouteSettings({
        publishedWorkflowsBasePath: 'workflows',
        latestWorkflowsBasePath: 'workflows-latest',
        publishedAppsBasePath: 'apps',
        latestAppsBasePath: 'apps',
      }),
      /must be different/,
    );
  });
});

test('Public route settings fail loudly when the saved settings file is invalid', async () => {
  await withAppSettingsEnv(async () => {
    const settingsPath = getPublicRouteSettingsPath();
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, '{bad json', 'utf8');

    await assert.rejects(readPublicRouteSettings(), /JSON|Unexpected|Expected|position/);
  });
});

test('Web app auth settings ignore environment values until saved', async () => {
  await withAppSettingsEnv(async () => {
    process.env.RIVET_WEB_APPS_AUTH_MODE = 'oauth';
    process.env.OAUTH_AUTHORIZE_URL = 'https://env.example.test/authorize';
    process.env.OAUTH_TOKEN_URL = 'https://env.example.test/token';
    process.env.OAUTH_USER_URL = 'https://env.example.test/profile';
    process.env.OAUTH_CLIENT_ID = 'env-client';
    process.env.OAUTH_CLIENT_SECRET = 'env-secret';

    const defaultSettings = await readWebAppAuthSettings();
    assert.equal(defaultSettings.source, 'default');
    assert.equal(defaultSettings.mode, 'ui-gate');
    assert.equal(defaultSettings.authorizeUrl, '');
    assert.equal(defaultSettings.clientSecretConfigured, false);
    assert.equal(getWebAppAuthMode(), 'ui-gate');

    await writeWebAppAuthSettings({
      mode: 'none',
    });

    const nextSettings = await readWebAppAuthSettings();
    assert.equal(nextSettings.source, 'app-settings');
    assert.equal(nextSettings.mode, 'none');
    assert.equal(getWebAppAuthMode(), 'none');
  });
});

test('Web app auth settings fail closed when the saved file is invalid', async () => {
  await withAppSettingsEnv(async () => {
    const settingsPath = getWebAppAuthSettingsPath();
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    const originalConsoleError = console.error;
    console.error = (...args: unknown[]) => {
      if (String(args[0]).includes('[web-app-auth] Failed to read web-app auth app settings')) {
        return;
      }
      originalConsoleError(...args);
    };

    try {
      fs.writeFileSync(settingsPath, '{not json', 'utf8');

      const settings = await readWebAppAuthSettings();
      assert.equal(settings.source, 'default');
      assert.equal(settings.mode, 'oauth');
      assert.equal(getWebAppAuthMode(), 'oauth');

      fs.writeFileSync(settingsPath, JSON.stringify({ version: 1, mode: 'surprise' }), 'utf8');
      assert.equal(getWebAppAuthMode(), 'oauth');
    } finally {
      console.error = originalConsoleError;
    }
  });
});

test('Web app auth settings API saves and hides secrets', async () => {
  await withAppSettingsEnv(async () => {
    let server: Awaited<ReturnType<typeof startServer>> | undefined;
    try {
      server = await startServer();
      const saveResponse = await fetch(`${server.baseUrl}/api/app-settings/web-app-auth`, {
        method: 'PUT',
        headers: {
          ...trustedProxyHeaders(),
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          mode: 'oauth',
          provider: 'external',
          authorizeUrl: 'https://oauth.example.test/authorize',
          tokenUrl: 'https://oauth.example.test/token',
          userUrl: 'https://oauth.example.test/profile',
          clientId: 'client-id',
          clientSecret: 'client-secret',
          callbackUrl: 'https://rivet.example.test/apps/auth/callback',
          scopes: 'email',
          emailClaim: 'data.email',
          sessionSecret: 'session-secret',
          sessionTtlSeconds: '7200',
          clientAuthMethod: 'basic',
          debugLogProfile: true,
          serverUiAdminEmails: ['Admin@Example.test', 'editor@example.test', 'admin@example.test'],
        }),
      });

      assert.equal(saveResponse.status, 200);
      const saved = await saveResponse.json() as Record<string, unknown>;
      assert.equal(saved.source, 'app-settings');
      assert.equal(saved.mode, 'oauth');
      assert.equal(saved.clientSecretConfigured, true);
      assert.equal(saved.sessionSecretConfigured, true);
      assert.equal(saved.clientSecret, undefined);
      assert.equal(saved.sessionSecret, undefined);
      assert.equal(saved.emailClaim, 'data.email');
      assert.equal(saved.clientAuthMethod, 'basic');
      assert.deepEqual(saved.serverUiAdminEmails, ['admin@example.test', 'editor@example.test']);
      const savedRevision = saveResponse.headers.get('etag');
      assert.ok(savedRevision);

      const rotateResponse = await fetch(`${server.baseUrl}/api/app-settings/web-app-auth`, {
        method: 'PATCH',
        headers: {
          ...trustedProxyHeaders(),
          'content-type': 'application/json',
          'if-match': savedRevision,
        },
        body: JSON.stringify({
          clientSecret: '',
          scopes: 'profile email',
          sessionSecret: '',
          clientAuthMethod: 'body',
          debugLogProfile: false,
          serverUiAdminEmails: ['editor@example.test'],
        }),
      });

      assert.equal(rotateResponse.status, 200);
      const rotated = await rotateResponse.json() as Record<string, unknown>;
      assert.equal(rotated.clientSecretConfigured, true);
      assert.equal(rotated.sessionSecretConfigured, true);
      assert.equal(rotated.scopes, 'profile email');
      assert.equal(rotated.clientAuthMethod, 'body');
      assert.deepEqual(rotated.serverUiAdminEmails, ['editor@example.test']);

      const runtime = readWebAppAuthSettingsSync();
      assert.equal(runtime.mode, 'oauth');
      assert.equal(runtime.authorizeUrl, 'https://oauth.example.test/authorize');
      assert.equal(runtime.clientSecret, 'client-secret');
      assert.equal(runtime.sessionSecret, 'session-secret');
      assert.equal(runtime.sessionTtlSeconds, 7200);
    } finally {
      await server?.close();
    }
  });
});

test('Web app auth settings keep the default session TTL for nonnumeric values', async () => {
  await withAppSettingsEnv(async () => {
    const settings = await writeWebAppAuthSettings({
      sessionTtlSeconds: true,
    });

    assert.equal(settings.sessionTtlSeconds, 24 * 60 * 60);
  });
});

test('Web app auth settings reject incomplete OAuth config', async () => {
  await withAppSettingsEnv(async () => {
    await assert.rejects(
      writeWebAppAuthSettings({
        mode: 'oauth',
        provider: 'external',
        authorizeUrl: 'https://oauth.example.test/authorize',
        tokenUrl: 'https://oauth.example.test/token',
      }),
      /Profile URL is required when OAuth web-app auth is enabled/,
    );
  });
});

test('Web app auth settings reject incomplete server UI OAuth preparation', async () => {
  await withAppSettingsEnv(async () => {
    await assert.rejects(
      writeWebAppAuthSettings({
        mode: 'ui-gate',
        provider: 'external',
        authorizeUrl: 'https://oauth.example.test/authorize',
        serverUiAdminEmails: ['admin@example.test'],
      }),
      /Token URL is required when server UI admin emails are configured/,
    );

    await assert.rejects(
      writeWebAppAuthSettings({
        mode: 'ui-gate',
        provider: 'dummy',
        serverUiAdminEmails: ['not-an-email'],
      }),
      /Server UI admin emails must contain valid email addresses/,
    );
  });
});
