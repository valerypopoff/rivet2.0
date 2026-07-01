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
  writeNodeExecutorProxySettings,
} from '../routes/app-settings.js';

const relevantEnvKeys = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'RIVET_APP_DATA_ROOT',
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
