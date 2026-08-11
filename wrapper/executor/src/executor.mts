import { createHash } from 'node:crypto';

import { startAppExecutor } from '../../../rivet/packages/app-executor/bin/executorHost.mjs';
import { createHttpRivetLLMProfileHealthStore } from '../../shared/llmProfileHealthHttpStore.js';

function createProxyAuthenticationHeaders(): HeadersInit {
  const sharedKey = process.env.RIVET_KEY?.trim();
  if (!sharedKey) return {};
  return {
    'x-rivet-proxy-auth': createHash('sha256').update(`${sharedKey}:proxy-auth`).digest('hex'),
  };
}

const healthServiceUrl = process.env.RIVET_LLM_PROFILE_HEALTH_API_URL?.trim()
  || 'http://127.0.0.1:3100/api/workflows/llm-profile-health';
const healthStore = createHttpRivetLLMProfileHealthStore({
  baseUrl: healthServiceUrl,
  headers: createProxyAuthenticationHeaders,
});

void startAppExecutor({
  createProcessorOptions: () => ({ llmProfileHealthStore: healthStore }),
}).catch((error) => {
  console.error('[rivet-executor] Failed to start:', error);
  process.exitCode = 1;
});
