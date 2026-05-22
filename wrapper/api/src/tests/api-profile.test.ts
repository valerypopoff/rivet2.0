import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { getExpectedProxyAuthToken } from '../auth.js';
import {
  assertApiRuntimeProfileStartupPreconditions,
  createApiApp,
  getApiErrorResponse,
  getApiRouteExposureMatrix,
} from '../app.js';
import { disposeRuntimeLibrariesBackend } from '../runtime-libraries/backend.js';
import { createHttpError } from '../utils/httpError.js';

const relevantEnvKeys = [
  'RIVET_KEY',
  'RIVET_REQUIRE_WORKFLOW_KEY',
  'RIVET_STORAGE_MODE',
  'RIVET_WORKFLOWS_ROOT',
  'RIVET_APP_DATA_ROOT',
  'RIVET_RUNTIME_LIBRARIES_ROOT',
  'RIVET_WORKSPACE_ROOT',
] as const;

async function withApiEnv(
  overrides: Partial<Record<(typeof relevantEnvKeys)[number], string | undefined>>,
  run: () => Promise<void> | void,
) {
  const previous = new Map<string, string | undefined>();

  for (const key of relevantEnvKeys) {
    previous.set(key, process.env[key]);
    delete process.env[key];
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rivet-api-profile-'));
  process.env.RIVET_KEY = 'phase4-shared-key';
  process.env.RIVET_REQUIRE_WORKFLOW_KEY = 'false';
  process.env.RIVET_STORAGE_MODE = 'filesystem';
  process.env.RIVET_WORKSPACE_ROOT = tempRoot;
  process.env.RIVET_WORKFLOWS_ROOT = path.join(tempRoot, 'workflows');
  process.env.RIVET_APP_DATA_ROOT = path.join(tempRoot, 'app-data');
  process.env.RIVET_RUNTIME_LIBRARIES_ROOT = path.join(tempRoot, 'runtime-libraries');

  for (const [key, value] of Object.entries(overrides)) {
    if (value != null) {
      process.env[key] = value;
    }
  }

  try {
    await run();
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

async function startServer(profile: 'combined' | 'control' | 'execution') {
  const app = createApiApp(profile);
  const server = http.createServer(app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to bind test server');
  }

  return {
    server,
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

test('Phase 4 route exposure matrix stays stable across API runtime profiles', () => {
  assert.deepEqual(getApiRouteExposureMatrix('control'), [
    '/ui-auth',
    '/workflows-latest/:endpointName',
    '/api/native/*',
    '/api/shell/*',
    '/api/plugins/*',
    '/api/projects/*',
    '/api/workflows/*',
    '/api/runtime-libraries/*',
    '/api/config*',
  ]);

  assert.deepEqual(getApiRouteExposureMatrix('execution'), [
    '/workflows/:endpointName',
    '/internal/workflows/:endpointName',
  ]);

  assert.deepEqual(getApiRouteExposureMatrix('combined'), [
    '/ui-auth',
    '/workflows-latest/:endpointName',
    '/api/native/*',
    '/api/shell/*',
    '/api/plugins/*',
    '/api/projects/*',
    '/api/workflows/*',
    '/api/runtime-libraries/*',
    '/api/config*',
    '/workflows/:endpointName',
    '/internal/workflows/:endpointName',
  ]);
});

test('execution profile startup preconditions require managed storage mode', async () => {
  await withApiEnv({
    RIVET_STORAGE_MODE: 'filesystem',
  }, () => {
    assert.throws(
      () => assertApiRuntimeProfileStartupPreconditions('execution'),
      /RIVET_API_PROFILE=execution requires RIVET_STORAGE_MODE=managed/,
    );
  });

  await withApiEnv({
    RIVET_STORAGE_MODE: 'managed',
  }, () => {
    assert.doesNotThrow(() => assertApiRuntimeProfileStartupPreconditions('execution'));
  });
});

test('combined and control profiles keep filesystem mode as a supported startup contract', async () => {
  await withApiEnv({
    RIVET_STORAGE_MODE: 'filesystem',
  }, () => {
    assert.doesNotThrow(() => assertApiRuntimeProfileStartupPreconditions('combined'));
    assert.doesNotThrow(() => assertApiRuntimeProfileStartupPreconditions('control'));
  });
});

test('API error responses expose only explicitly marked 500 messages', () => {
  assert.deepEqual(
    getApiErrorResponse(new Error('boom')),
    {
      status: 500,
      body: { error: 'Internal server error' },
    },
  );

  assert.deepEqual(
    getApiErrorResponse(createHttpError(500, 'Workflow storage is not writable.', { expose: true })),
    {
      status: 500,
      body: { error: 'Workflow storage is not writable.' },
    },
  );

  assert.deepEqual(
    getApiErrorResponse(createHttpError(403, 'Forbidden')),
    {
      status: 403,
      body: { error: 'Forbidden' },
    },
  );
});

test('control profile exposes control-plane routes and does not expose published execution routes', async () => {
  await withApiEnv({}, async () => {
    const server = await startServer('control');
    try {
      const uiAuthResponse = await fetch(`${server.baseUrl}/ui-auth`, {
        method: 'POST',
        headers: {
          ...trustedProxyHeaders(),
          'content-type': 'application/json',
        },
        body: JSON.stringify({ key: 'phase4-shared-key' }),
      });
      assert.equal(uiAuthResponse.status, 204);

      const configResponse = await fetch(`${server.baseUrl}/api/config`, {
        headers: trustedProxyHeaders(),
      });
      assert.equal(configResponse.status, 200);

      const publishedResponse = await fetch(`${server.baseUrl}/workflows/phase4-missing`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      assert.equal(publishedResponse.status, 404);
      assert.equal(publishedResponse.headers.get('x-duration-ms'), null);
      assert.deepEqual(await publishedResponse.json(), { error: 'Not found' });

      const internalResponse = await fetch(`${server.baseUrl}/internal/workflows/phase4-missing`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      assert.equal(internalResponse.status, 404);
      assert.equal(internalResponse.headers.get('x-duration-ms'), null);
      assert.deepEqual(await internalResponse.json(), { error: 'Not found' });
    } finally {
      await server.close();
    }
  });
});

test('execution profile exposes published execution routes and hides control-plane routes', async () => {
  await withApiEnv({}, async () => {
    const server = await startServer('execution');
    try {
      const configResponse = await fetch(`${server.baseUrl}/api/config`, {
        headers: trustedProxyHeaders(),
      });
      assert.equal(configResponse.status, 404);
      assert.deepEqual(await configResponse.json(), { error: 'Not found' });

      const uiAuthResponse = await fetch(`${server.baseUrl}/ui-auth`, {
        method: 'POST',
        headers: {
          ...trustedProxyHeaders(),
          'content-type': 'application/json',
        },
        body: JSON.stringify({ key: 'phase4-shared-key' }),
      });
      assert.equal(uiAuthResponse.status, 404);

      const pluginsResponse = await fetch(`${server.baseUrl}/api/plugins/install-package`, {
        method: 'POST',
        headers: {
          ...trustedProxyHeaders(),
          'content-type': 'application/json',
        },
        body: JSON.stringify({ package: '@scope/example', tag: 'latest' }),
      });
      assert.equal(pluginsResponse.status, 404);

      const publishedResponse = await fetch(`${server.baseUrl}/workflows/phase4-missing`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      assert.equal(publishedResponse.status, 404);
      assert.match(publishedResponse.headers.get('x-duration-ms') ?? '', /^\d+$/);
      const publishedPayload = await publishedResponse.json() as { error: string; durationMs: number };
      assert.equal(publishedPayload.error, 'Published workflow not found');
      assert.equal(typeof publishedPayload.durationMs, 'number');

      const internalResponse = await fetch(`${server.baseUrl}/internal/workflows/phase4-missing`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      assert.equal(internalResponse.status, 404);
      assert.match(internalResponse.headers.get('x-duration-ms') ?? '', /^\d+$/);
      const internalPayload = await internalResponse.json() as { error: string; durationMs: number };
      assert.equal(internalPayload.error, 'Published workflow not found');
      assert.equal(typeof internalPayload.durationMs, 'number');
    } finally {
      await server.close();
    }
  });
});

test('combined profile preserves both control-plane and published/latest execution routes', async () => {
  await withApiEnv({}, async () => {
    const server = await startServer('combined');
    try {
      const configResponse = await fetch(`${server.baseUrl}/api/config`, {
        headers: trustedProxyHeaders(),
      });
      assert.equal(configResponse.status, 200);

      const publishedResponse = await fetch(`${server.baseUrl}/workflows/phase4-missing`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      assert.equal(publishedResponse.status, 404);
      assert.match(publishedResponse.headers.get('x-duration-ms') ?? '', /^\d+$/);
      assert.equal((await publishedResponse.json()).error, 'Published workflow not found');

      const latestResponse = await fetch(`${server.baseUrl}/workflows-latest/phase4-missing`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      assert.equal(latestResponse.status, 404);
      assert.match(latestResponse.headers.get('x-duration-ms') ?? '', /^\d+$/);
      assert.equal((await latestResponse.json()).error, 'Latest workflow not found');
    } finally {
      await server.close();
    }
  });
});

test('runtime-libraries route exposes permission errors for an unwritable runtime-library root', async (t) => {
  await withApiEnv({}, async () => {
    await disposeRuntimeLibrariesBackend();
    const server = await startServer('control');
    const runtimeLibrariesRoot = process.env.RIVET_RUNTIME_LIBRARIES_ROOT!;
    const normalizedRoot = runtimeLibrariesRoot.replace(/\\/g, '/');
    const loggedErrors: unknown[][] = [];

    try {
      t.mock.method(console, 'error', (...args: unknown[]) => {
        loggedErrors.push(args);
      });
      t.mock.method(fs, 'mkdirSync', (targetPath: fs.PathLike) => {
        const normalizedTargetPath = String(targetPath).replace(/\\/g, '/');
        if (normalizedTargetPath.startsWith(normalizedRoot)) {
          const error = new Error(`EACCES: permission denied, mkdir '${targetPath}'`) as Error & { code?: string };
          error.code = 'EACCES';
          throw error;
        }

        return undefined;
      });

      const response = await fetch(`${server.baseUrl}/api/runtime-libraries`, {
        headers: trustedProxyHeaders(),
      });

      assert.equal(response.status, 500);
      assert.deepEqual(await response.json(), {
        error: `Runtime-library storage is not writable. Check server permissions for ${normalizedRoot}.`,
      });
      assert.equal(loggedErrors.length, 1);
      assert.equal(loggedErrors[0]?.[0], 'Unhandled API error:');
      assert.match((loggedErrors[0]?.[1] as Error).message, /Runtime-library storage is not writable/);
    } finally {
      await disposeRuntimeLibrariesBackend();
      await server.close();
    }
  });
});
