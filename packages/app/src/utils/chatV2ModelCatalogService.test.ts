import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import type { Settings } from '@valerypopoff/rivet2-core';
import { chatV2ModelCatalogService } from './chatV2ModelCatalogService.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  chatV2ModelCatalogService.clearForTests();
});

test('model catalog service owns refresh options, status, and subscriptions', async () => {
  const snapshots: string[] = [];
  const unsubscribe = chatV2ModelCatalogService.subscribe('settings:openai', () => {
    snapshots.push(chatV2ModelCatalogService.getSnapshot('settings:openai').status?.message ?? 'none');
  });
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ data: [{ id: 'gpt-service-test' }] }), { status: 200 });

  const result = await chatV2ModelCatalogService.refresh({
    sessionKey: 'settings:openai',
    provider: 'openai',
    context: {
      settings: { openAiApiKey: 'secret-key' } as Settings,
      plugins: [],
    },
  });
  unsubscribe();

  assert.equal(snapshots[0], 'Refreshing model list...');
  assert.match(snapshots.at(-1) ?? '', /Loaded .* models from openai/);
  assert.ok(result.options?.some((option) => option.value === 'gpt-service-test'));
});

test('model catalog service stores a safe error state without view-owned maps', () => {
  chatV2ModelCatalogService.setError('node:openai:input', new Error('No input key'));
  assert.deepEqual(chatV2ModelCatalogService.getSnapshot('node:openai:input'), {
    status: { tone: 'warning', message: 'No input key' },
  });
});
