import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  getToolNodeBodyPreview,
  GptFunctionNodeImpl,
  type GptFunctionNode,
  type NodeBodySpec,
} from '../../../src/index.js';
import type { InternalProcessContext } from '../../../src/model/ProcessContext.js';

const createNode = (data: Partial<GptFunctionNode['data']>) => {
  return new GptFunctionNodeImpl({
    ...GptFunctionNodeImpl.create(),
    data: {
      ...GptFunctionNodeImpl.create().data,
      ...data,
    },
  });
};

describe('GptFunctionNodeImpl', () => {
  it('marks the schema editor as JSON with template interpolation syntax', () => {
    const node = createNode({});
    const editors = node.getEditors();

    assert.deepStrictEqual(editors[4], {
      type: 'code',
      label: 'Schema',
      dataKey: 'schema',
      language: 'json',
      interpolationSyntax: 'json-template',
      useInputToggleDataKey: 'useSchemaInput',
      enableFolding: true,
    });
  });

  it('defaults to continuing with the LLM and persists direct result handling in Rivet metadata', async () => {
    const defaultNode = createNode({});
    const legacyNode = createNode({ resultHandling: undefined });
    const directNode = createNode({ resultHandling: 'return-direct' });
    const malformedNode = createNode({ resultHandling: 'invalid' as any });

    assert.equal(defaultNode.data.resultHandling, 'continue');
    assert.equal((await legacyNode.process({})).function?.value.resultHandling, 'continue');
    assert.equal((await directNode.process({})).function?.value.resultHandling, 'return-direct');
    assert.equal((await malformedNode.process({})).function?.value.resultHandling, 'continue');
    assert.deepEqual(defaultNode.getEditors()[3], {
      type: 'dropdown',
      label: 'Result handling',
      dataKey: 'resultHandling',
      defaultValue: 'continue',
      options: [
        { label: 'Continue with LLM', value: 'continue' },
        { label: 'Return directly', value: 'return-direct' },
      ],
      helperMessage:
        'Return directly uses the handler output as the final LLM Chat response when it is the only tool call in an auto-continued round.',
    });
  });

  it('discovers later valid schema inputs even when an earlier interpolation opener is broken', () => {
    const node = createNode({
      schema: [
        '{"type":"object","properties":{"foo":{"default":"{{foo}}"},',
        '"bar":{"default":"{{bar"},',
        '"baz":{"default":"{{somevar}}"}}}',
      ].join('\n'),
    });

    assert.deepStrictEqual(
      node.getInputDefinitions([], {}, {} as any, {}).map((definition) => definition.id),
      ['input-foo', 'input-somevar'],
    );
  });

  it('uses one any schema input for nested JSONPath values while retaining bare schema interpolation', async () => {
    const node = createNode({
      schema:
        '{"type":"object","properties":{"name":{"default":"{{payload.user.name}}"},"raw":{"default":{{payload}}}}}',
      useSchemaInput: false,
    });

    assert.deepStrictEqual(
      node.getInputDefinitions([], {}, {} as any, {}).map(({ id, dataType }) => ({ id, dataType })),
      [{ id: 'input-payload', dataType: 'any' }],
    );

    const result = await node.process({
      'input-payload': {
        type: 'object',
        value: { user: { name: 'Ada' } },
      },
    });

    assert.deepStrictEqual(result.function?.value.parameters, {
      type: 'object',
      properties: {
        name: { default: 'Ada' },
        raw: { default: { user: { name: 'Ada' } } },
      },
    });
  });

  it('resolves graph and context JSONPath values in schema templates', async () => {
    const node = createNode({
      schema: '{"graphName":"{{@graphInputs.payload.user.name}}","contextLabel":"{{@context.settings.labels[0]}}"}',
      useSchemaInput: false,
    });

    const result = await node.process({}, {
      graphInputNodeValues: {
        payload: { type: 'object', value: { user: { name: 'Ada' } } },
      },
      contextValues: {
        settings: { type: 'object', value: { labels: ['Primary'] } },
      },
    } as InternalProcessContext);

    assert.deepStrictEqual(result.function?.value.parameters, {
      graphName: 'Ada',
      contextLabel: 'Primary',
    });
  });

  it('bounds long descriptions with the same preview budget as Text nodes', () => {
    const node = createNode({
      name: 'lookup',
      description: Array.from({ length: 20 }, (_, index) => `description line ${index + 1}`).join('\n'),
    });

    assert.deepStrictEqual(node.getBody(), {
      type: 'colorized',
      language: 'prompt-interpolation-markdown',
      theme: 'prompt-interpolation',
      text: `lookup\n${Array.from({ length: 13 }, (_, index) => `description line ${index + 1}`).join('\n')}\n...`,
    } satisfies NodeBodySpec);

    assert.deepStrictEqual(getToolNodeBodyPreview(node.data), {
      name: 'lookup',
      description: `${Array.from({ length: 13 }, (_, index) => `description line ${index + 1}`).join('\n')}\n...`,
    });
  });

  it('clips an oversized description line before it can expand the Tool node', () => {
    const node = createNode({
      name: 'lookup',
      description: `prefix-${'a'.repeat(5000)}`,
    });

    assert.deepStrictEqual(node.getBody(), {
      type: 'colorized',
      language: 'prompt-interpolation-markdown',
      theme: 'prompt-interpolation',
      text: `lookup\nprefix-${'a'.repeat(233)}...`,
    } satisfies NodeBodySpec);
  });
});
