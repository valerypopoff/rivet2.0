import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('./PromptDesignerTestRunner.ts', import.meta.url), 'utf8');

test('Prompt Designer evaluator graphs share the configured Browser LLM profile health store', () => {
  assert.match(source, /const llmProfileHealthStore = useLLMProfileHealthStore\(\)/);
  assert.match(source, /tokenizer: new GptTokenizerTokenizer\(\),\s*llmProfileHealthStore,/);
});
