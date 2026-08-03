import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { materializeLLMResponse } from '../../../src/model/chat-v2/llmResponseMaterializer.js';

describe('materializeLLMResponse', () => {
  it('uses the SDK structured value before JSON text fallback', () => {
    const result = materializeLLMResponse({
      rawText: 'not used',
      structuredOutput: { value: true },
      responseFormat: 'json_schema',
    });
    assert.deepEqual(result.value, { type: 'object', value: { value: true } });
    assert.equal(result.source, 'sdk-structured');
    assert.equal(result.validation, 'valid');
  });

  it('validates the exact DataValue exposed through Response', () => {
    const result = materializeLLMResponse({
      rawText: '"a JSON string"',
      structuredOutput: undefined,
      responseFormat: 'json_schema',
    });
    assert.deepEqual(result.value, { type: 'string', value: 'a JSON string' });
    assert.equal(result.source, 'text-json');
    assert.equal(result.validation, 'invalid');
  });
});
