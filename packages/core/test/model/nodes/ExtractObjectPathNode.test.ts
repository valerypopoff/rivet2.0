import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  type DataValue,
  type ExtractObjectPathNode,
  ExtractObjectPathNodeImpl,
  getExtractObjectPathInterpolationInputNames,
  interpolateExtractObjectPathSource,
  type InternalProcessContext,
} from '../../../src/index.js';

const createNode = (data: Partial<ExtractObjectPathNode['data']>) => {
  return new ExtractObjectPathNodeImpl({
    ...ExtractObjectPathNodeImpl.create(),
    data: {
      ...ExtractObjectPathNodeImpl.create().data,
      ...data,
    },
  });
};

const createContext = (overrides: Partial<InternalProcessContext> = {}) => {
  return {
    ...overrides,
  } as InternalProcessContext;
};

describe('ExtractObjectPathNodeImpl', () => {
  it('creates the same node type as before', () => {
    const node = ExtractObjectPathNodeImpl.create();

    assert.equal(node.type, 'extractObjectPath');
  });

  it('keeps static paths working without interpolation', async () => {
    const node = createNode({
      path: '$.aaa["ccc"]',
    });

    const result = await node.process(
      {
        object: {
          type: 'object',
          value: {
            aaa: {
              ccc: 42,
            },
          },
        } as DataValue,
      } as Record<any, DataValue>,
      createContext(),
    );

    assert.equal(result['match'].value, 42);
    assert.deepEqual(result['all_matches'].value, [42]);
  });

  it('accepts the same structural whitespace as interpolation paths', async () => {
    const node = createNode({
      path: '$ . aaa [ "ccc" ]',
    });

    const result = await node.process(
      {
        object: {
          type: 'object',
          value: { aaa: { ccc: 'picked' } },
        } as DataValue,
      } as Record<any, DataValue>,
      createContext(),
    );

    assert.equal(result.match.value, 'picked');
    assert.deepEqual(result.all_matches.value, ['picked']);
  });

  it('creates dynamic inputs from valid interpolation tokens in the stored path', () => {
    const node = createNode({
      path: '$.aaa["{{bbb}}"]',
    });

    assert.deepEqual(
      node.getInputDefinitions().map((definition) => definition.id),
      ['object', 'bbb'],
    );
  });

  it('resolves quoted property interpolation in the stored path', async () => {
    const node = createNode({
      path: '$.aaa["{{bbb}}"]',
    });

    const result = await node.process(
      {
        object: {
          type: 'object',
          value: {
            aaa: {
              ccc: 'picked',
            },
          },
        } as DataValue,
        bbb: {
          type: 'string',
          value: 'ccc',
        } as DataValue,
      } as Record<any, DataValue>,
      createContext(),
    );

    assert.equal(result['match'].value, 'picked');
    assert.deepEqual(result['all_matches'].value, ['picked']);
  });

  it('supports numeric interpolation for array indices', async () => {
    const node = createNode({
      path: '$.items[{{index}}]',
    });

    const result = await node.process(
      {
        object: {
          type: 'object',
          value: {
            items: ['zero', 'one', 'two'],
          },
        } as DataValue,
        index: {
          type: 'number',
          value: 1,
        } as DataValue,
      } as Record<any, DataValue>,
      createContext(),
    );

    assert.equal(result['match'].value, 'one');
    assert.deepEqual(result['all_matches'].value, ['one']);
  });

  it('uses the same JSONPath resolver for an interpolation expression inside the stored path', async () => {
    const node = createNode({
      path: '$.aaa["{{selector.keys[0]}}"]',
    });

    assert.deepEqual(
      node.getInputDefinitions().map(({ id, dataType }) => ({ id, dataType })),
      [
        { id: 'object', dataType: 'object' },
        { id: 'selector', dataType: 'any' },
      ],
    );

    const result = await node.process(
      {
        object: {
          type: 'object',
          value: { aaa: { selected: 'picked' } },
        } as DataValue,
        selector: {
          type: 'object',
          value: { keys: ['selected'] },
        } as DataValue,
      } as Record<any, DataValue>,
      createContext(),
    );

    assert.equal(result.match.value, 'picked');
    assert.deepEqual(result.all_matches.value, ['picked']);
  });

  it('allows a stored path to interpolate a variable named path when usePathInput is off', async () => {
    const node = createNode({
      path: '$.aaa["{{path}}"]',
    });

    assert.deepEqual(
      node.getInputDefinitions().map((definition) => definition.id),
      ['object', 'path'],
    );

    const result = await node.process(
      {
        object: {
          type: 'object',
          value: {
            aaa: {
              ccc: 'picked-via-path-variable',
            },
          },
        } as DataValue,
        path: {
          type: 'string',
          value: 'ccc',
        } as DataValue,
      } as Record<any, DataValue>,
      createContext(),
    );

    assert.equal(result['match'].value, 'picked-via-path-variable');
    assert.deepEqual(result['all_matches'].value, ['picked-via-path-variable']);
  });

  it('discovers later valid interpolation tokens even when an earlier opener is broken', () => {
    const node = createNode({
      path: '$.aaa["{{bar"].bbb["{{somevar}}"]',
    });

    assert.deepEqual(
      node.getInputDefinitions().map((definition) => definition.id),
      ['object', 'somevar'],
    );
  });

  it('keeps escaped interpolation tokens literal and does not create dynamic inputs for them', async () => {
    const node = createNode({
      path: '$.aaa["{{{bbb}}}"]',
    });

    assert.deepEqual(
      node.getInputDefinitions().map((definition) => definition.id),
      ['object'],
    );

    const result = await node.process(
      {
        object: {
          type: 'object',
          value: {
            aaa: {
              '{{bbb}}': 'literal',
            },
          },
        } as DataValue,
      } as Record<any, DataValue>,
      createContext(),
    );

    assert.equal(result['match'].value, 'literal');
    assert.deepEqual(result['all_matches'].value, ['literal']);
  });

  it('does not let interpolation silently read built-in input ports with reserved names', async () => {
    const node = createNode({
      path: '$.aaa["{{object}}"]',
    });

    assert.deepEqual(
      node.getInputDefinitions().map((definition) => definition.id),
      ['object'],
    );

    const result = await node.process(
      {
        object: {
          type: 'object',
          value: {
            aaa: {
              '[object Object]': 'wrong-hidden-match',
            },
          },
        } as DataValue,
      } as Record<any, DataValue>,
      createContext(),
    );

    assert.deepEqual(result, {
      match: {
        type: 'control-flow-excluded',
        value: undefined,
      },
      all_matches: {
        type: 'any[]',
        value: [],
      },
    });
  });

  it('supports @graphInputs and @context interpolation without creating dynamic inputs', async () => {
    const node = createNode({
      path: '$.aaa["{{@graphInputs.pick}}"]["{{@context.leaf}}"]',
    });

    assert.deepEqual(
      node.getInputDefinitions().map((definition) => definition.id),
      ['object'],
    );

    const result = await node.process(
      {
        object: {
          type: 'object',
          value: {
            aaa: {
              ccc: {
                ddd: 99,
              },
            },
          },
        } as DataValue,
      } as Record<any, DataValue>,
      createContext({
        graphInputNodeValues: {
          pick: {
            type: 'string',
            value: 'ccc',
          },
        },
        contextValues: {
          leaf: {
            type: 'string',
            value: 'ddd',
          },
        },
      }),
    );

    assert.equal(result['match'].value, 99);
    assert.deepEqual(result['all_matches'].value, [99]);
  });

  it('exposes shared helpers for stored-path interpolation', () => {
    assert.deepEqual(getExtractObjectPathInterpolationInputNames('$.aaa["{{bbb}}"]["{{@context.leaf}}"]'), ['bbb']);
  });

  it('trims the parsed stored path used at runtime', () => {
    assert.equal(
      interpolateExtractObjectPathSource('\n  $.aaa["{{bbb}}"]  \n', {
        bbb: {
          type: 'string',
          value: 'ccc',
        } as DataValue,
      } as Record<any, DataValue>),
      '$.aaa["ccc"]',
    );
  });

  it('keeps usePathInput mode unchanged and does not expose interpolation-derived ports', async () => {
    const node = createNode({
      path: '$.aaa["{{bbb}}"]',
      usePathInput: true,
    });

    assert.deepEqual(
      node.getInputDefinitions().map((definition) => definition.id),
      ['object', 'path'],
    );

    const result = await node.process(
      {
        object: {
          type: 'object',
          value: {
            aaa: {
              ccc: 'from-input-path',
            },
          },
        } as DataValue,
        path: {
          type: 'string',
          value: '$.aaa["ccc"]',
        } as DataValue,
      } as Record<any, DataValue>,
      createContext(),
    );

    assert.equal(result['match'].value, 'from-input-path');
    assert.deepEqual(result['all_matches'].value, ['from-input-path']);
  });

  it('keeps no-match behavior unchanged', async () => {
    const node = createNode({
      path: '$.aaa["missing"]',
    });

    const result = await node.process(
      {
        object: {
          type: 'object',
          value: {
            aaa: {
              ccc: 1,
            },
          },
        } as DataValue,
      } as Record<any, DataValue>,
      createContext(),
    );

    assert.deepEqual(result, {
      match: {
        type: 'control-flow-excluded',
        value: undefined,
      },
      all_matches: {
        type: 'any[]',
        value: [],
      },
    });
  });

  it('treats invalid paths as no matches', async () => {
    const node = createNode({
      path: '$.aaa[?(@.]',
    });

    const result = await node.process(
      {
        object: {
          type: 'object',
          value: {
            aaa: {
              ccc: 1,
            },
          },
        } as DataValue,
      } as Record<any, DataValue>,
      createContext(),
    );

    assert.deepEqual(result, {
      match: {
        type: 'control-flow-excluded',
        value: undefined,
      },
      all_matches: {
        type: 'any[]',
        value: [],
      },
    });
  });
});
