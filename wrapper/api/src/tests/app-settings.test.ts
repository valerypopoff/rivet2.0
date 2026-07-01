import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { getExpectedProxyAuthToken } from '../auth.js';
import { createApiApp } from '../app.js';
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
  writeWebAppAuthSettings,
} from '../web-app-auth-settings.js';
import { writePrivateJsonSettingsFile } from '../settings-file-writer.js';

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
  'RIVET_KEY',
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

async function startServer() {
  const app = createApiApp('control');
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

      const rotateResponse = await fetch(`${server.baseUrl}/api/app-settings/web-app-auth`, {
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
          clientSecret: '',
          callbackUrl: 'https://rivet.example.test/apps/auth/callback',
          scopes: 'profile email',
          emailClaim: 'data.email',
          sessionSecret: '',
          sessionTtlSeconds: '3600',
          clientAuthMethod: 'body',
          debugLogProfile: false,
        }),
      });

      assert.equal(rotateResponse.status, 200);
      const rotated = await rotateResponse.json() as Record<string, unknown>;
      assert.equal(rotated.clientSecretConfigured, true);
      assert.equal(rotated.sessionSecretConfigured, true);
      assert.equal(rotated.scopes, 'profile email');
      assert.equal(rotated.clientAuthMethod, 'body');
    } finally {
      await server?.close();
    }
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
