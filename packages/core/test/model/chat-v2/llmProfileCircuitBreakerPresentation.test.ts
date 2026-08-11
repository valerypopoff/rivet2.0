import assert from 'node:assert/strict';
import test from 'node:test';
import type { RivetUIContext } from '../../../src/model/RivetUIContext.js';
import { getLLMProfileEditors } from '../../../src/model/chat-v2/llmChatV2NodeEditors.js';
import { getLLMProfileBodySections } from '../../../src/model/chat-v2/llmProfileBody.js';
import { createLLMProfileNodeData } from '../../../src/model/chat-v2/llmProfileTypes.js';

test('LLM Profile exposes circuit-breaker controls only in its dedicated group', async () => {
  const data = {
    ...createLLMProfileNodeData(),
    provider: 'custom' as const,
    model: 'fast-model',
  };
  const editors = await getLLMProfileEditors(data, {} as RivetUIContext);
  const reliability = editors.find((editor) => editor.type === 'group' && editor.label === 'Reliability');

  assert.ok(reliability?.type === 'group');
  assert.deepEqual(
    reliability.editors.map((editor) => ('dataKey' in editor ? editor.dataKey : undefined)),
    [
      'enableCircuitBreaker',
      'firstOutputTimeoutMs',
      'streamInactivityTimeoutMs',
      'circuitBreakerFailureThreshold',
      'circuitBreakerFailureWindowMs',
      'circuitBreakerOpenDurationMs',
    ],
  );
});

test('LLM Profile body omits default-off health settings and keeps its enabled summary concise', () => {
  const disabled = getLLMProfileBodySections(createLLMProfileNodeData());
  assert.equal(disabled.some((section) => section.id === 'reliability'), false);

  const enabled = getLLMProfileBodySections({
    ...createLLMProfileNodeData(),
    enableCircuitBreaker: true,
    firstOutputTimeoutMs: 10,
    streamInactivityTimeoutMs: 20,
    circuitBreakerFailureThreshold: 4,
    circuitBreakerFailureWindowMs: 50,
    circuitBreakerOpenDurationMs: 60,
  });
  const reliability = enabled.find((section) => section.id === 'reliability');

  assert.deepEqual(reliability?.fields, [{ label: 'Circuit breaker', value: 'Enabled' }]);
});
