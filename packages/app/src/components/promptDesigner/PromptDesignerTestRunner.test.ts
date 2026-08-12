import assert from 'node:assert/strict';
import test from 'node:test';
import type { DatasetProvider, RivetLLMProfileHealthStore, RuntimeSettings } from '@valerypopoff/rivet2-core';
import { createPromptDesignerEvaluatorProcessorOptions } from './promptDesignerTestProcessorOptions.js';

test('Prompt Designer evaluator graphs receive the configured LLM profile health store', () => {
  const llmProfileHealthStore = {} as RivetLLMProfileHealthStore;
  const settings = {} as RuntimeSettings;
  const options = createPromptDesignerEvaluatorProcessorOptions({
    datasetProvider: {} as DatasetProvider,
    settings,
    llmProfileHealthStore,
  });

  assert.equal(options.llmProfileHealthStore, llmProfileHealthStore);
  assert.equal(options.settings, settings);
  assert.ok(options.tokenizer);
});

test('Prompt Designer evaluator graphs do not create an LLM profile health store', () => {
  const options = createPromptDesignerEvaluatorProcessorOptions({
    datasetProvider: {} as DatasetProvider,
    settings: {} as RuntimeSettings,
  });

  assert.equal(options.llmProfileHealthStore, undefined);
});
