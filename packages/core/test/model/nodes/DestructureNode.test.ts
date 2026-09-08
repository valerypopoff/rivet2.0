import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { DestructureNodeImpl, type DestructureNode, type PortId } from '../../../src/index.js';

const createNode = (data: Partial<DestructureNode['data']>) => {
  return new DestructureNodeImpl({
    ...DestructureNodeImpl.create(),
    data: {
      ...DestructureNodeImpl.create().data,
      ...data,
    },
  });
};

describe('DestructureNode', () => {
  it('seeds newly added path rows with JSONPath root syntax', () => {
    const node = createNode({});
    const pathsEditor = node.getEditors().find((editor) => editor.type === 'stringList');

    assert.equal(pathsEditor?.newItemDefault, '$.');
  });

  it('uses legacy output ids when stored path port ids are absent', async () => {
    const node = createNode({
      paths: ['$.value.name', '$.value.age'],
      pathPortIds: undefined,
    });

    assert.deepEqual(
      node.getOutputDefinitions().map(({ id, title }) => ({ id, title })),
      [
        { id: 'match_0', title: '$.value.name' },
        { id: 'match_1', title: '$.value.age' },
      ],
    );

    const output = await node.process({
      object: {
        type: 'object',
        value: {
          value: {
            name: 'Ada',
            age: 42,
          },
        },
      },
    } as Record<PortId, any>);

    assert.equal(output['match_0' as PortId]?.value, 'Ada');
    assert.equal(output['match_1' as PortId]?.value, 42);
  });

  it('uses stored path port ids and keeps process outputs aligned with output definitions', async () => {
    const node = createNode({
      paths: ['$.value.name', '$.value.age'],
      pathPortIds: ['path-name', 'path-age'],
    });

    assert.deepEqual(
      node.getOutputDefinitions().map(({ id, title }) => ({ id, title })),
      [
        { id: 'path-name', title: '$.value.name' },
        { id: 'path-age', title: '$.value.age' },
      ],
    );

    const output = await node.process({
      object: {
        type: 'object',
        value: {
          value: {
            name: 'Ada',
            age: 42,
          },
        },
      },
    } as Record<PortId, any>);

    assert.equal(output['path-name' as PortId]?.value, 'Ada');
    assert.equal(output['path-age' as PortId]?.value, 42);
  });

  it('accepts the same structural whitespace as interpolation paths', async () => {
    const node = createNode({
      paths: ['$ . value . name'],
      pathPortIds: ['path-name'],
    });

    const output = await node.process({
      object: {
        type: 'object',
        value: { value: { name: 'Ada' } },
      },
    } as Record<PortId, any>);

    assert.equal(output['path-name' as PortId]?.value, 'Ada');
  });
});
