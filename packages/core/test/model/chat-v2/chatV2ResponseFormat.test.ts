import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  createChatV2ResponseOutput,
  mergeCustomProviderResponseFormatOptions,
  resolveChatV2ResponseFormatParameters,
  type ChatV2ResponseFormatData,
} from '../../../src/model/chat-v2/chatV2ResponseFormat.js';
import type { DataValue, GptFunction } from '../../../src/model/DataValue.js';
import type { Inputs } from '../../../src/model/GraphProcessor.js';

function resolve(data: ChatV2ResponseFormatData, inputs: Inputs = {}) {
  return resolveChatV2ResponseFormatParameters(data, inputs);
}

describe('chat v2 response format helpers', () => {
  it('omits response output by default', () => {
    assert.equal(resolve({ responseFormat: '' }), undefined);
    assert.equal(resolve({}), undefined);
  });

  it('resolves JSON response metadata from settings or inputs', () => {
    const inputs = {
      responseSchemaName: { type: 'string', value: 'answer' },
      responseSchemaDescription: { type: 'string', value: 'Short answer object' },
    } satisfies Inputs;

    assert.deepEqual(
      resolve(
        {
          responseFormat: 'json',
          responseSchemaName: 'ignored',
          useResponseSchemaNameInput: true,
          responseSchemaDescription: 'ignored',
          useResponseSchemaDescriptionInput: true,
        },
        inputs,
      ),
      {
        responseFormat: 'json',
        schemaName: 'answer',
        schemaDescription: 'Short answer object',
      },
    );
  });

  it('uses object input values as JSON schema parameters', () => {
    const schema = {
      type: 'object',
      properties: {
        answer: { type: 'string' },
      },
      required: ['answer'],
    };

    assert.deepEqual(
      resolve(
        {
          responseFormat: 'json_schema',
          responseSchemaName: 'answer_schema',
        },
        {
          responseSchema: { type: 'object', value: schema } satisfies DataValue,
        },
      ),
      {
        responseFormat: 'json_schema',
        schema,
        schemaName: 'answer_schema',
        schemaDescription: undefined,
      },
    );
  });

  it('uses gpt-function parameters as JSON schema parameters', () => {
    const gptFunction: GptFunction = {
      name: 'answer_schema',
      description: 'Answer schema',
      parameters: {
        type: 'object',
        properties: {
          answer: { type: 'string' },
        },
      },
    };

    assert.deepEqual(
      resolve(
        {
          responseFormat: 'json_schema',
        },
        {
          responseSchema: { type: 'gpt-function', value: gptFunction } satisfies DataValue,
        },
      ),
      {
        responseFormat: 'json_schema',
        schema: gptFunction.parameters,
        schemaName: 'response_schema',
        schemaDescription: undefined,
      },
    );
  });

  it('creates Vercel output descriptors for supported response formats', () => {
    assert.ok(createChatV2ResponseOutput({ responseFormat: 'text' }));
    assert.ok(createChatV2ResponseOutput({ responseFormat: 'json' }));
    assert.ok(
      createChatV2ResponseOutput({
        responseFormat: 'json_schema',
        schemaName: 'answer_schema',
        schema: { type: 'object', properties: { answer: { type: 'string' } } },
      }),
    );
  });

  it('omits the SDK output descriptor for custom-provider JSON object mode', () => {
    assert.equal(createChatV2ResponseOutput({ responseFormat: 'json' }, 'custom'), undefined);
    assert.ok(createChatV2ResponseOutput({ responseFormat: 'json' }, 'custom', 'responses'));
  });

  it('rejects non-JSON-compatible response schemas before creating Vercel output descriptors', () => {
    assert.throws(
      () =>
        createChatV2ResponseOutput({
          responseFormat: 'json_schema',
          schemaName: 'answer_schema',
          schema: { type: 'object', enum: [Number.NaN] },
        }),
      /Response Schema\.enum\[0\] must be JSON-compatible; non-finite numbers are not supported/,
    );
  });

  it('adds raw OpenAI-compatible response format options for custom provider JSON mode', () => {
    assert.deepEqual(
      mergeCustomProviderResponseFormatOptions(
        'custom',
        {
          custom: {
            response_format: { type: 'text' },
            customFlag: true,
          },
        },
        {
          responseFormat: 'json',
          schemaName: 'answer_json',
        },
      ),
      {
        custom: {
          response_format: { type: 'json_object' },
          customFlag: true,
        },
      },
    );
  });

  it('leaves Custom Responses provider options to the Responses adapter', () => {
    const providerOptions = {
      openai: {
        store: false,
      },
    } as const;

    assert.equal(
      mergeCustomProviderResponseFormatOptions(
        'custom',
        providerOptions,
        { responseFormat: 'json', schemaName: 'answer_json' },
        'responses',
      ),
      providerOptions,
    );
  });

  it('adds raw OpenAI-compatible response format options for custom provider JSON schema', () => {
    const schema = {
      type: 'object',
      properties: {
        answer: { type: 'string' },
      },
      required: ['answer'],
    };

    assert.deepEqual(
      mergeCustomProviderResponseFormatOptions(
        'custom',
        {
          custom: {
            response_format: { type: 'json_object' },
            customFlag: true,
          },
        },
        {
          responseFormat: 'json_schema',
          schema,
          schemaName: 'answer_schema',
          schemaDescription: 'Answer payload',
        },
      ),
      {
        custom: {
          response_format: {
            type: 'json_schema',
            json_schema: {
              name: 'answer_schema',
              description: 'Answer payload',
              strict: true,
              schema,
            },
          },
          customFlag: true,
        },
      },
    );
  });

  it('rejects non-JSON-compatible custom provider JSON schemas before sending provider options', () => {
    assert.throws(
      () =>
        mergeCustomProviderResponseFormatOptions('custom', undefined, {
          responseFormat: 'json_schema',
          schema: { type: 'object', invalid: undefined },
          schemaName: 'answer_schema',
        }),
      /Response Schema\.invalid must be JSON-compatible/,
    );

    const schema: Record<string, unknown> = { type: 'object' };
    schema.self = schema;

    assert.throws(
      () =>
        mergeCustomProviderResponseFormatOptions('custom', undefined, {
          responseFormat: 'json_schema',
          schema,
          schemaName: 'answer_schema',
        }),
      /Response Schema\.self must be JSON-compatible; circular references are not supported/,
    );

    assert.throws(
      () =>
        mergeCustomProviderResponseFormatOptions('custom', undefined, {
          responseFormat: 'json_schema',
          schema: { type: 'object', createdAt: new Date('2026-05-05T00:00:00Z') },
          schemaName: 'answer_schema',
        }),
      /Response Schema\.createdAt must be JSON-compatible; only plain objects are supported/,
    );
  });

  it('leaves non-custom provider options unchanged', () => {
    const providerOptions = {
      openai: {
        reasoningEffort: 'high',
      },
    } as const;

    assert.equal(
      mergeCustomProviderResponseFormatOptions('openai', providerOptions, {
        responseFormat: 'json_schema',
        schema: { type: 'object' },
        schemaName: 'answer_schema',
      }),
      providerOptions,
    );
  });
});
