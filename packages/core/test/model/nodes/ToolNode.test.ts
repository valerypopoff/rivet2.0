import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { GptFunctionNodeImpl, type GptFunctionNode } from '../../../src/index.js';

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
});
