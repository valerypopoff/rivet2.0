import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { ExtractYamlNodeImpl, type ExtractYamlNode, type PortId } from '../../../src/index.js';

function createNode(data: Partial<ExtractYamlNode['data']>) {
  return new ExtractYamlNodeImpl({
    ...ExtractYamlNodeImpl.create(),
    data: {
      ...ExtractYamlNodeImpl.create().data,
      ...data,
    },
  });
}

describe('ExtractYamlNode', () => {
  it('uses the shared JSONPath evaluator for selected YAML values', async () => {
    const node = createNode({
      objectPath: '$.yamlDocument.records[0].name',
    });

    const result = await node.process({
      input: {
        type: 'string',
        value: ['yamlDocument:', '  records:', '    - name: Ada'].join('\n'),
      },
    } as Record<PortId, any>);

    assert.deepStrictEqual(result.output, {
      type: 'any',
      value: 'Ada',
    });
    assert.deepStrictEqual(result.matches, {
      type: 'any[]',
      value: ['Ada'],
    });
  });

  it('accepts the same structural whitespace as interpolation paths', async () => {
    const node = createNode({
      objectPath: '$ . yamlDocument . records [ 0 ] . name',
    });

    const result = await node.process({
      input: {
        type: 'string',
        value: ['yamlDocument:', '  records:', '    - name: Ada'].join('\n'),
      },
    } as Record<PortId, any>);

    assert.equal(result.output?.value, 'Ada');
    assert.deepStrictEqual(result.matches?.value, ['Ada']);
  });

  it('uses the effective input path when typing a dynamically selected scalar', async () => {
    const node = createNode({ objectPath: undefined, useObjectPathInput: true });
    const result = await node.process({
      input: {
        type: 'string',
        value: ['yamlDocument:', '  records:', '    - name: Ada'].join('\n'),
      },
      objectPath: { type: 'string', value: '$ . yamlDocument . records [ 0 ] . name' },
    } as Record<PortId, any>);

    assert.deepStrictEqual(result.output, { type: 'any', value: 'Ada' });
    assert.deepStrictEqual(result.matches, { type: 'any[]', value: ['Ada'] });
  });
});
