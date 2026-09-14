import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildLegacyChatEditorCacheKey,
  resolveLegacyChatEditorCache,
  writeLegacyChatEditorCache,
} from '../../src/model/LegacyChatEditorCache.js';
import type { Outputs } from '../../src/model/GraphProcessor.js';
import type { InternalProcessContext } from '../../src/model/ProcessContext.js';

function createContext(overrides: Partial<InternalProcessContext> = {}): InternalProcessContext {
  return {
    editorExecutionCache: new Map<string, unknown>(),
    executionCache: new Map<string, unknown>(),
    execution: { graphId: 'graph-a' },
    node: { id: 'node-a', type: 'chatGoogle' },
    ...overrides,
  } as InternalProcessContext;
}

test('legacy chat cache keys are stable, scoped, and never expose request credentials', () => {
  const common = {
    graphId: 'graph-a',
    nodeId: 'node-a',
    nodeType: 'chatGoogle',
    providerIdentity: {
      apiKey: 'google-secret-a',
      headers: { Authorization: 'Bearer example-token' },
    },
    request: { prompt: 'private prompt', model: 'gemini-2.5-flash' },
  };
  const key = buildLegacyChatEditorCacheKey(common);

  assert.equal(
    key,
    buildLegacyChatEditorCacheKey({ ...common, request: { model: 'gemini-2.5-flash', prompt: 'private prompt' } }),
  );
  assert.notEqual(
    key,
    buildLegacyChatEditorCacheKey({
      ...common,
      providerIdentity: { ...common.providerIdentity, apiKey: 'google-secret-b' },
    }),
  );
  assert.notEqual(key, buildLegacyChatEditorCacheKey({ ...common, nodeId: 'node-b' }));
  assert.notEqual(key, buildLegacyChatEditorCacheKey({ ...common, graphId: 'graph-b' }));
  assert.doesNotMatch(key, /google-secret-a|example-token|private prompt/);
});

test('legacy chat cache uses editor ownership and clones values at both boundaries', () => {
  const context = createContext();
  const params = {
    context,
    enabled: true,
    providerIdentity: { apiKey: 'secret-a', headers: { 'X-Account': 'account-a' } },
    request: { model: 'gemini-2.5-flash', prompt: [{ role: 'user', text: 'Hello' }] },
  };
  const initial = resolveLegacyChatEditorCache(params);
  assert.ok(initial.cache);
  assert.equal(initial.cachedOutputs, undefined);

  const outputs = {
    response: { type: 'object', value: { text: 'original' } },
  } as Outputs;
  writeLegacyChatEditorCache(initial.cache, outputs);
  (outputs.response!.value as { text: string }).text = 'mutated after write';

  const hit = resolveLegacyChatEditorCache(params);
  assert.equal((hit.cachedOutputs!.response!.value as { text: string }).text, 'original');
  (hit.cachedOutputs!.response!.value as { text: string }).text = 'mutated after read';

  const secondHit = resolveLegacyChatEditorCache(params);
  assert.equal((secondHit.cachedOutputs!.response!.value as { text: string }).text, 'original');
  assert.equal(context.editorExecutionCache!.size, 1);
  assert.equal(context.executionCache.size, 0);
});

test('legacy chat cache falls back to the graph execution cache and remains optional', () => {
  const executionCache = new Map<string, unknown>();
  const context = createContext({ editorExecutionCache: undefined, executionCache });
  const enabled = resolveLegacyChatEditorCache({
    context,
    enabled: true,
    providerIdentity: { apiKey: 'secret-a' },
    request: { model: 'gpt-5', prompt: 'Hello' },
  });
  assert.ok(enabled.cache);
  writeLegacyChatEditorCache(enabled.cache, { response: { type: 'string', value: 'cached' } } as Outputs);
  assert.equal(executionCache.size, 1);

  const disabled = resolveLegacyChatEditorCache({
    context,
    enabled: false,
    providerIdentity: { apiKey: 'secret-a' },
    request: { model: 'gpt-5', prompt: 'Hello' },
  });
  assert.equal(disabled.cache, undefined);
  assert.equal(disabled.cachedOutputs, undefined);
});
