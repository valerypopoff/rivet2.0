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
});
