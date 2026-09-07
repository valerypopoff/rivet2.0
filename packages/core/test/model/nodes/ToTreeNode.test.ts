import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { ToTreeNodeImpl, type DataValue, type ToTreeNode } from '../../../src/index.js';
import type { InternalProcessContext } from '../../../src/model/ProcessContext.js';

const createNode = (data: Partial<ToTreeNode['data']>) => {
  return new ToTreeNodeImpl({
    ...ToTreeNodeImpl.create(),
    data: {
      ...ToTreeNodeImpl.create().data,
      ...data,
    },
  });
};

describe('ToTreeNode', () => {
  it('uses interpolation against each row object without creating graph input ports', async () => {
    const node = createNode({
      format: '{{path}}: {{label}}',
      childrenProperty: 'children',
      useSortAlphabetically: false,
    });

    assert.deepStrictEqual(
      node.getInputDefinitions().map((definition) => definition.id),
      ['objects'],
    );

    const result = await node.process({
      objects: {
        type: 'object[]',
        value: [
          {
            path: 'root',
            label: 'Root',
            children: [
              {
                path: 'child',
                label: 'Child',
              },
            ],
          },
        ],
      } as DataValue,
    });

    assert.equal(typeof result.tree?.value, 'string');
    assert.match(result.tree.value as string, /^root: Root\n/);
    assert.match(result.tree.value as string, /child: Child\n$/);
  });

  it('resolves JSONPath from each raw row without mistaking ordinary type/value fields for DataValues', async () => {
    const node = createNode({
      format: '{{metadata}} / {{metadata.type}}: {{metadata.values[0]}}',
      childrenProperty: 'children',
      useSortAlphabetically: false,
    });

    const result = await node.process({
      objects: {
        type: 'object[]',
        value: [
          {
            metadata: {
              type: 'ordinary-json',
              value: 'not-a-data-value',
              values: ['Ada'],
            },
          },
        ],
      } as DataValue,
    });

    assert.equal(result.tree?.value, '[object Object] / ordinary-json: Ada\n');
  });

  it('resolves graph and context JSONPath expressions while formatting each row', async () => {
    const node = createNode({
      format: '{{label}} / {{@graphInputs.project.title}} / {{@context.settings.labels[0]}}',
      childrenProperty: 'children',
      useSortAlphabetically: false,
    });

    const result = await node.process(
      {
        objects: {
          type: 'object[]',
          value: [
            {
              label: 'Row',
              children: [{ label: 'Child' }],
            },
          ],
        } as DataValue,
      },
      {
        graphInputNodeValues: {
          project: { type: 'object', value: { title: 'Graph' } },
        },
        contextValues: {
          settings: { type: 'object', value: { labels: ['Context'] } },
        },
      } as InternalProcessContext,
    );

    assert.equal(result.tree?.value, 'Row / Graph / Context\n    └── Child / Graph / Context\n');
  });
});
