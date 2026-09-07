import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  TextNodeImpl,
  type DataValue,
  type InternalProcessContext,
  type NodeBodySpec,
  type TextNode,
} from '../../../src/index.js';

const createNode = (data: Partial<TextNode['data']>) => {
  return new TextNodeImpl({
    ...TextNodeImpl.create(),
    data: {
      ...TextNodeImpl.create().data,
      ...data,
    },
  });
};

describe('TextNode', () => {
  const context = {
    graphInputNodeValues: {
      graphValue: { type: 'string', value: 'from graph' },
    },
    contextValues: {
      contextValue: { type: 'string', value: 'from context' },
    },
  } as InternalProcessContext;

  it('interpolates string values with spaces and braces without reparsing them', async () => {
    const node = createNode({
      text: 'Value: {{input}}',
    });

    const result = await node.process(
      {
        input: { type: 'string', value: 'foo {{not-a-port}} bar' },
      } satisfies Record<string, DataValue>,
      context,
    );

    assert.deepStrictEqual(result.output, {
      type: 'string',
      value: 'Value: foo {{not-a-port}} bar',
    });
  });

  it('resolves graph and context interpolation references without exposing input ports', async () => {
    const node = createNode({
      text: '{{@graphInputs.graphValue}} / {{@context.contextValue}}',
    });

    assert.deepStrictEqual(node.getInputDefinitions(), []);

    const result = await node.process({}, context);

    assert.deepStrictEqual(result.output, {
      type: 'string',
      value: 'from graph / from context',
    });
  });

  it('uses one raw base input for nested JSONPath expressions while preserving bare string coercion', async () => {
    const node = createNode({
      text: '{{payload.user.names[0]}} / {{payload}}',
    });

    assert.deepStrictEqual(
      node.getInputDefinitions().map(({ id, dataType }) => ({ id, dataType })),
      [{ id: 'payload', dataType: 'any' }],
    );

    const result = await node.process(
      {
        payload: {
          type: 'object',
          value: { user: { names: ['Ada'] } },
        },
      } satisfies Record<string, DataValue>,
      context,
    );

    assert.deepStrictEqual(result.output, {
      type: 'string',
      value: 'Ada / {"user":{"names":["Ada"]}}',
    });
  });

  it('opts the text editor into word and character stats', () => {
    const node = createNode({});
    const textEditor = node.getEditors().find((editor) => editor.type === 'code' && editor.dataKey === 'text');

    assert.equal(textEditor?.showTextStats, true);
  });

  it('truncates long single-line previews so large blobs do not render in full', () => {
    const node = createNode({
      text: `prefix-${'a'.repeat(5000)}`,
    });

    assert.deepStrictEqual(node.getBody(), {
      type: 'colorized',
      language: 'prompt-interpolation-markdown',
      theme: 'prompt-interpolation',
      text: `prefix-${'a'.repeat(233)}...`,
    } satisfies NodeBodySpec);
  });

  it('still limits the preview to the first 15 lines', () => {
    const node = createNode({
      text: Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join('\n'),
    });

    assert.deepStrictEqual(node.getBody(), {
      type: 'colorized',
      language: 'prompt-interpolation-markdown',
      theme: 'prompt-interpolation',
      text: `${Array.from({ length: 15 }, (_, index) => `line ${index + 1}`).join('\n')}\n...`,
    } satisfies NodeBodySpec);
  });
});
