import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveHostedExecutorApiUrls } from './internalApiUrls.mjs';

test('managed executor derives authenticated API calls from its verified loopback configuration URL', () => {
  assert.deepEqual(
    resolveHostedExecutorApiUrls({
      RIVET_DEPLOYMENT_TOPOLOGY: 'replicated',
      RIVET_EXECUTOR_RUNTIME_CONFIG_URL: 'http://127.0.0.1:8080/internal/executor-runtime-config',
      RIVET_LLM_PROFILE_HEALTH_API_URL: 'https://wrong.example/health',
      RIVET_EXECUTION_ENVIRONMENT_API_URL: 'https://wrong.example/environment',
    }),
    {
      healthServiceUrl: 'http://127.0.0.1:8080/api/workflows/llm-profile-health',
      executionEnvironmentServiceUrl: 'http://127.0.0.1:8080/api/workflows/execution-environment',
    },
  );
  assert.deepEqual(
    resolveHostedExecutorApiUrls({
      RIVET_DEPLOYMENT_TOPOLOGY: 'replicated',
      RIVET_EXECUTOR_RUNTIME_CONFIG_URL: 'http://127.0.0.1:80/internal/executor-runtime-config',
    }),
    {
      healthServiceUrl: 'http://127.0.0.1/api/workflows/llm-profile-health',
      executionEnvironmentServiceUrl: 'http://127.0.0.1/api/workflows/execution-environment',
    },
  );
});

test('managed executor refuses a non-loopback or altered configuration route', () => {
  for (const url of [
    undefined,
    'https://127.0.0.1:8080/internal/executor-runtime-config',
    'http://api:8080/internal/executor-runtime-config',
    'http://127.0.0.1:8080/other',
    'http://127.0.0.1:8080/internal/executor-runtime-config?redirect=1',
    'http://user:pass@127.0.0.1:8080/internal/executor-runtime-config',
  ]) {
    assert.throws(
      () =>
        resolveHostedExecutorApiUrls({
          RIVET_DEPLOYMENT_TOPOLOGY: 'replicated',
          RIVET_EXECUTOR_RUNTIME_CONFIG_URL: url,
        }),
      /valid loopback runtime configuration URL/,
    );
  }
});

test('separate local executor retains its configurable API routes', () => {
  assert.deepEqual(
    resolveHostedExecutorApiUrls({
      RIVET_DEPLOYMENT_TOPOLOGY: 'single-host',
      RIVET_LLM_PROFILE_HEALTH_API_URL: 'http://api:80/api/workflows/llm-profile-health',
      RIVET_EXECUTION_ENVIRONMENT_API_URL: 'http://api:80/api/workflows/execution-environment',
    }),
    {
      healthServiceUrl: 'http://api:80/api/workflows/llm-profile-health',
      executionEnvironmentServiceUrl: 'http://api:80/api/workflows/execution-environment',
    },
  );
});
