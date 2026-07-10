import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChartNode, CustomEditorDefinition } from '@valerypopoff/rivet2-core';
import { getModelOptions, includeCurrentModelOption } from './llmChatV2ModelCatalogOptions.js';

test('getModelOptions reads the editor-owned fallback catalog', () => {
  const editor = {
    data: { modelOptions: [{ value: 'gpt-fallback', label: 'GPT fallback' }] },
  } as CustomEditorDefinition<ChartNode>;

  assert.deepEqual(getModelOptions(editor), [{ value: 'gpt-fallback', label: 'GPT fallback' }]);
});

test('includeCurrentModelOption keeps a model that is absent from the catalog', () => {
  assert.deepEqual(includeCurrentModelOption([{ value: 'gpt-live', label: 'GPT live' }], 'gpt-current'), [
    { value: 'gpt-current', label: 'gpt-current (Current)' },
    { value: 'gpt-live', label: 'GPT live' },
  ]);
});

test('includeCurrentModelOption does not duplicate an existing or blank model', () => {
  const options = [{ value: 'gpt-live', label: 'GPT live' }];
  assert.equal(includeCurrentModelOption(options, 'gpt-live'), options);
  assert.equal(includeCurrentModelOption(options, ''), options);
});
