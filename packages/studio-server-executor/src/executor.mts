import { createHash } from 'node:crypto';

import { startAppExecutor } from '../../app-executor/bin/executorHost.mjs';
import { createHttpRivetLLMProfileHealthStore } from '../../studio-server-shared/llmProfileHealthHttpStore.js';

function createProxyAuthenticationHeaders(): HeadersInit {
  const sharedKey = process.env.RIVET_KEY?.trim();
  if (!sharedKey) return {};
  return {
    'x-rivet-proxy-auth': createHash('sha256').update(`${sharedKey}:proxy-auth`).digest('hex'),
    'x-rivet-executor-auth': createHash('sha256').update(`${sharedKey}:executor-internal`).digest('hex'),
  };
}

const healthServiceUrl = process.env.RIVET_LLM_PROFILE_HEALTH_API_URL?.trim()
  || 'http://127.0.0.1:3100/api/workflows/llm-profile-health';
const healthStore = createHttpRivetLLMProfileHealthStore({
  baseUrl: healthServiceUrl,
  headers: createProxyAuthenticationHeaders,
});

const executionEnvironmentServiceUrl = process.env.RIVET_EXECUTION_ENVIRONMENT_API_URL?.trim()
  || 'http://api:80/api/workflows/execution-environment';

async function readExecutionEnvironment(): Promise<Readonly<Record<string, string>>> {
  const response = await fetch(executionEnvironmentServiceUrl, {
    headers: createProxyAuthenticationHeaders(),
    cache: 'no-store',
  });
  if (!response.ok) {
    throw new Error(`Execution environment service failed (${response.status} ${response.statusText})`);
  }

  const body = await response.json() as { environment?: unknown };
  if (!body.environment || typeof body.environment !== 'object' || Array.isArray(body.environment)) {
    throw new Error('Execution environment service returned an invalid response');
  }

  return Object.freeze(Object.fromEntries(
    Object.entries(body.environment).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  ));
}

void startAppExecutor({
  createProcessorOptions: async () => ({
    executionEnvironment: await readExecutionEnvironment(),
    llmProfileHealthStore: healthStore,
  }),
}).catch((error) => {
  console.error('[rivet-executor] Failed to start:', error);
  process.exitCode = 1;
});
