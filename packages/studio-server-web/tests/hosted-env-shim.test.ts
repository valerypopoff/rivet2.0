import assert from 'node:assert/strict';
import test from 'node:test';

import type { RivetPlugin } from '@valerypopoff/rivet2-core';

import {
  fillMissingSettingsFromEnvironmentVariables,
  getEnvVar,
  invalidateHostedEnvironmentVariableCache,
} from '../overrides/utils/tauri';

type FetchHandler = (url: string) => Promise<Response> | Response;

function withFetch(handler: FetchHandler): () => void {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = ((input: RequestInfo | URL) => handler(String(input))) as typeof fetch;

  return () => {
    globalThis.fetch = originalFetch;
  };
}

function jsonResponse(value: string, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify({ value }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

test('getEnvVar caches empty hosted env responses', async () => {
  const envName = 'CODEX_EMPTY_ENV_CACHE_TEST';
  const requestedUrls: string[] = [];
  const restoreFetch = withFetch((url) => {
    requestedUrls.push(url);
    return jsonResponse('');
  });

  try {
    assert.equal(await getEnvVar(envName), undefined);
    assert.equal(await getEnvVar(envName), undefined);
    assert.equal(requestedUrls.length, 1);
    assert.match(requestedUrls[0], /\/api\/config\/env\/CODEX_EMPTY_ENV_CACHE_TEST$/);
  } finally {
    restoreFetch();
  }
});

test('getEnvVar dedupes concurrent hosted env requests', async () => {
  const envName = 'CODEX_PENDING_ENV_CACHE_TEST';
  let requestCount = 0;
  let resolveResponse: ((response: Response) => void) | undefined;
  const responsePromise = new Promise<Response>((resolve) => {
    resolveResponse = resolve;
  });
  const restoreFetch = withFetch(() => {
    requestCount += 1;
    return responsePromise;
  });

  try {
    const firstValue = getEnvVar(envName);
    const secondValue = getEnvVar(envName);

    assert.equal(requestCount, 1);
    resolveResponse?.(jsonResponse('shared-value'));

    assert.deepEqual(await Promise.all([firstValue, secondValue]), ['shared-value', 'shared-value']);
    assert.equal(await getEnvVar(envName), 'shared-value');
    assert.equal(requestCount, 1);
  } finally {
    restoreFetch();
  }
});

test('getEnvVar retries after failed hosted env requests', async () => {
  const envName = 'CODEX_FAILED_ENV_CACHE_TEST';
  let requestCount = 0;
  const restoreFetch = withFetch(() => {
    requestCount += 1;
    return requestCount === 1
      ? new Response('nope', { status: 503, statusText: 'Service Unavailable' })
      : jsonResponse('recovered-value');
  });

  try {
    assert.equal(await getEnvVar(envName), undefined);
    assert.equal(await getEnvVar(envName), 'recovered-value');
    assert.equal(requestCount, 2);
  } finally {
    restoreFetch();
  }
});

test('getEnvVar retries after rejected hosted env requests', async () => {
  const envName = 'CODEX_REJECTED_ENV_CACHE_TEST';
  let requestCount = 0;
  const restoreFetch = withFetch(() => {
    requestCount += 1;

    if (requestCount === 1) {
      throw new Error('network unavailable');
    }

    return jsonResponse('recovered-value');
  });

  try {
    assert.equal(await getEnvVar(envName), undefined);
    assert.equal(await getEnvVar(envName), 'recovered-value');
    assert.equal(requestCount, 2);
  } finally {
    restoreFetch();
  }
});

test('getEnvVar retries after malformed hosted env responses', async () => {
  const envName = 'CODEX_MALFORMED_ENV_CACHE_TEST';
  let requestCount = 0;
  const restoreFetch = withFetch(() => {
    requestCount += 1;

    return requestCount === 1
      ? new Response(JSON.stringify({ nope: '' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      : jsonResponse('recovered-value');
  });

  try {
    assert.equal(await getEnvVar(envName), undefined);
    assert.equal(await getEnvVar(envName), 'recovered-value');
    assert.equal(requestCount, 2);
  } finally {
    restoreFetch();
  }
});

test('getEnvVar reloads after UI-managed environment variables change', async () => {
  const envName = 'CODEX_UI_MANAGED_ENV_CACHE_TEST';
  let value = 'before-save';
  let requestCount = 0;
  const restoreFetch = withFetch(() => {
    requestCount += 1;
    return jsonResponse(value);
  });

  try {
    assert.equal(await getEnvVar(envName), 'before-save');
    value = 'after-save';
    assert.equal(await getEnvVar(envName), 'before-save');
    invalidateHostedEnvironmentVariableCache();
    assert.equal(await getEnvVar(envName), 'after-save');
    assert.equal(requestCount, 2);
  } finally {
    restoreFetch();
  }
});

test('fillMissingSettingsFromEnvironmentVariables resolves unique env lookups concurrently', async () => {
  const requestedEnvVars: string[] = [];
  const resolveEnvVars = new Map<string, (value: string | undefined) => void>();

  const settingsPromise = fillMissingSettingsFromEnvironmentVariables(
    {},
    [
      {
        configSpec: {
          PLUGIN_KEY: { type: 'string', pullEnvironmentVariable: true },
          CUSTOM_CONFIG: { type: 'string', pullEnvironmentVariable: 'CUSTOM_ENV' },
          DUPLICATE_CUSTOM_CONFIG: { type: 'string', pullEnvironmentVariable: 'CUSTOM_ENV' },
          IGNORED_NUMBER: { type: 'number', pullEnvironmentVariable: 'IGNORED_ENV' },
        },
      } as unknown as RivetPlugin,
    ],
    {
      extraEnvVarNames: [' EXTRA_ENV ', '', 'PLUGIN_KEY', 'CUSTOM_ENV'],
      environmentProvider: {
        getEnvVar(name) {
          requestedEnvVars.push(name);

          return new Promise((resolve) => {
            resolveEnvVars.set(name, resolve);
          });
        },
      },
    },
  );

  assert.deepEqual([...requestedEnvVars].sort(), [
    'CUSTOM_ENV',
    'EXTRA_ENV',
    'OPENAI_API_KEY',
    'OPENAI_ENDPOINT',
    'OPENAI_ORG_ID',
    'PLUGIN_KEY',
  ]);

  for (const envVarName of requestedEnvVars) {
    resolveEnvVars.get(envVarName)?.(
      envVarName === 'OPENAI_API_KEY'
        ? 'openai-key'
        : envVarName === 'CUSTOM_ENV'
          ? 'custom-value'
          : envVarName === 'EXTRA_ENV'
            ? 'extra-value'
            : undefined,
    );
  }

  const settings = await settingsPromise;

  assert.equal(settings.openAiKey, 'openai-key');
  assert.equal(settings.openAiOrganization, '');
  assert.equal(settings.openAiEndpoint, '');
  assert.deepEqual(settings.pluginEnv, {
    CUSTOM_ENV: 'custom-value',
    EXTRA_ENV: 'extra-value',
  });
});
