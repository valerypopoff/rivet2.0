import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  GraphProcessor,
  IsomorphicCodeRunner,
  JSFilterNodeImpl,
  NotAllowedCodeRunner,
  globalRivetNodeRegistry,
  type InternalProcessContext,
  type JSFilterNode,
  type NodeBodySpec,
  type PortId,
} from '../../../src/index.js';
import { testProcessContext } from '../../testUtils';

const createNode = (data: Partial<JSFilterNode['data']>) => {
  return new JSFilterNodeImpl({
    ...JSFilterNodeImpl.create(),
    data: {
      ...JSFilterNodeImpl.create().data,
      ...data,
    },
  });
};

const createContext = (codeRunner = new IsomorphicCodeRunner(), overrides: Partial<InternalProcessContext> = {}) =>
  ({
    codeRunner,
    graphInputNodeValues: {},
    contextValues: {},
    ...overrides,
  }) as InternalProcessContext;

const makeProject = (graph: any) =>
  ({
    metadata: {
      id: 'project-1',
      title: 'Project',
      description: '',
      mainGraphId: graph.metadata.id,
    },
    graphs: {
      [graph.metadata.id]: graph,
    },
    plugins: [],
  }) as any;

describe('JSFilterNode', () => {
  it('can create node', () => {
    const node = JSFilterNodeImpl.create();
    assert.strictEqual(node.type, 'jsFilter');
    assert.strictEqual(node.title, 'JS Filter');
  });

  it('seeds the default callback body in the editor config', () => {
    const node = JSFilterNodeImpl.create();
    const editors = new JSFilterNodeImpl(node).getEditors();

    assert.deepStrictEqual(editors, [
      {
        type: 'code',
        label: 'Callback Body',
        helperMessage: '(item, index, array) => {',
        postEditorHelperMessage:
          '};\n\n//Use {{var}} to create input ports. {{config.limit.max}} creates only config; {{item.name}} and {{array[0]}} use callback locals.',
        dataKey: 'callbackBody',
        language: 'javascript',
        interpolationSyntax: 'js-value',
        enableFolding: true,
      },
    ]);
  });

  it('renders a wrapped callback preview body', () => {
    const node = createNode({
      callbackBody: ['const allowed = index > 0;', 'return allowed && item != null;'].join('\n'),
    });

    assert.deepStrictEqual(node.getBody(), {
      type: 'colorized',
      text: [
        '(item, index, array) => {',
        '  const allowed = index > 0;',
        '  return allowed && item != null;',
        '}',
      ].join('\n'),
      language: 'javascript',
      fontSize: 12,
      fontFamily: 'monospace',
    } satisfies NodeBodySpec);
  });

  it('creates value interpolation input ports after the fixed array port', () => {
    const node = createNode({
      callbackBody: 'return item > {{min}} && item !== {{excluded}};',
    });

    assert.deepStrictEqual(
      node.getInputDefinitions().map((definition) => ({
        id: definition.id,
        dataType: definition.dataType,
        required: definition.required,
      })),
      [
        {
          id: 'array',
          dataType: 'any[]',
          required: true,
        },
        {
          id: 'min',
          dataType: 'any',
          required: false,
        },
        {
          id: 'excluded',
          dataType: 'any',
          required: false,
        },
      ],
    );
  });

  it('filters numbers with plain JS values', async () => {
    const node = createNode({ callbackBody: 'return item > 2;' });
    const result = await node.process(
      {
        ['array' as PortId]: { type: 'number[]', value: [1, 2, 3, 4] },
      },
      createContext(),
    );

    assert.deepStrictEqual(result, {
      filtered: {
        type: 'any[]',
        value: [3, 4],
      },
    });
  });

  it('evaluates interpolation inputs as connected values before filtering', async () => {
    const node = createNode({
      callbackBody: 'return item > {{min}} && item !== {{excluded}};',
    });

    const result = await node.process(
      {
        ['array' as PortId]: { type: 'number[]', value: [1, 2, 3, 4] },
        ['min' as PortId]: { type: 'number', value: 2 },
        ['excluded' as PortId]: { type: 'number', value: 4 },
      },
      createContext(),
    );

    assert.deepStrictEqual(result.filtered?.value, [3]);
  });

  it('resolves JSONPath expressions from callback locals without creating local ports', async () => {
    const node = createNode({
      callbackBody: 'return {{item.details.score}} >= {{config.minimum}} && {{array[0].enabled}};',
    });

    assert.deepStrictEqual(
      node.getInputDefinitions().map((definition) => definition.id),
      ['array', 'config'],
    );

    const result = await node.process(
      {
        ['array' as PortId]: {
          type: 'object[]',
          value: [
            { enabled: true, details: { score: 2 } },
            { enabled: true, details: { score: 5 } },
          ],
        },
        ['config' as PortId]: { type: 'object', value: { minimum: 3 } },
      },
      createContext(),
    );

    assert.deepStrictEqual(result.filtered?.value, [{ enabled: true, details: { score: 5 } }]);
  });

  it('resolves a global JSONPath expression without creating an input port', async () => {
    const node = createNode({ callbackBody: 'return item > {{@globals.config.minimum}};' });

    assert.deepStrictEqual(
      node.getInputDefinitions().map((definition) => definition.id),
      ['array'],
    );

    const result = await node.process(
      {
        ['array' as PortId]: { type: 'number[]', value: [1, 2, 3, 4] },
      },
      createContext(undefined, {
        getGlobal: (id) => (id === 'config' ? { type: 'object', value: { minimum: 2 } } : undefined),
      }),
    );

    assert.deepStrictEqual(result.filtered?.value, [3, 4]);
  });

  it('keeps interpolation values available when callback code uses generated helper names', async () => {
    const node = createNode({
      callbackBody: 'const __jsListInputs = {};\nreturn item > {{min}};',
    });

    const result = await node.process(
      {
        ['array' as PortId]: { type: 'number[]', value: [1, 2, 3] },
        ['min' as PortId]: { type: 'number', value: 1 },
      },
      createContext(),
    );

    assert.deepStrictEqual(result.filtered?.value, [2, 3]);
  });

  it('receives interpolation inputs when run through the graph processor', async () => {
    const graph = {
      metadata: {
        id: 'graph-1',
        name: 'Graph',
        description: '',
      },
      nodes: [
        {
          id: 'array-input',
          type: 'graphInput',
          title: 'Array',
          data: {
            id: 'array',
            dataType: 'number[]',
          },
          visualData: { x: 0, y: 0, width: 300 },
        },
        {
          id: 'min-input',
          type: 'graphInput',
          title: 'Minimum',
          data: {
            id: 'min',
            dataType: 'number',
          },
          visualData: { x: 0, y: 100, width: 300 },
        },
        {
          id: 'filter-node',
          type: 'jsFilter',
          title: 'JS Filter',
          data: {
            callbackBody: 'return item > {{min}};',
          },
          visualData: { x: 350, y: 0, width: 220 },
        },
        {
          id: 'output-node',
          type: 'graphOutput',
          title: 'Graph Output',
          data: {
            id: 'filtered',
            dataType: 'any[]',
          },
          visualData: { x: 650, y: 0, width: 300 },
        },
      ],
      connections: [
        {
          outputNodeId: 'array-input',
          outputId: 'data',
          inputNodeId: 'filter-node',
          inputId: 'array',
        },
        {
          outputNodeId: 'min-input',
          outputId: 'data',
          inputNodeId: 'filter-node',
          inputId: 'min',
        },
        {
          outputNodeId: 'filter-node',
          outputId: 'filtered',
          inputNodeId: 'output-node',
          inputId: 'value',
        },
      ],
    };

    const processor = new GraphProcessor(makeProject(graph), graph.metadata.id as any, globalRivetNodeRegistry);
    const result = await processor.processGraph(testProcessContext(), {
      array: { type: 'number[]', value: [1, 2, 3] },
      min: { type: 'number', value: 1 },
    });

    assert.deepStrictEqual(result.filtered, { type: 'any[]', value: [2, 3] });
  });

  it('does not create interpolation ports for callback locals', () => {
    const node = createNode({
      callbackBody: 'return {{item}} !== {{array}} && {{index}} > -1;',
    });

    assert.deepStrictEqual(
      node.getInputDefinitions().map((definition) => definition.id),
      ['array'],
    );
  });

  it('allows callback locals to be written with interpolation braces', async () => {
    const node = createNode({
      callbackBody: 'return {{item}} > {{min}} && {{index}} > -1 && {{array}}.length === 3;',
    });

    assert.deepStrictEqual(
      node.getInputDefinitions().map((definition) => definition.id),
      ['array', 'min'],
    );

    const result = await node.process(
      {
        ['array' as PortId]: { type: 'number[]', value: [1, 2, 3] },
        ['min' as PortId]: { type: 'number', value: 1 },
      },
      createContext(),
    );

    assert.deepStrictEqual(result.filtered?.value, [2, 3]);
  });

  it('does not mutate upstream callback array values', async () => {
    const node = createNode({
      callbackBody: 'item.seen = true; array.push({ value: 99 }); return item.value > 1;',
    });
    const array = [{ value: 1 }, { value: 2 }];

    const result = await node.process(
      {
        ['array' as PortId]: { type: 'any[]', value: array },
      },
      createContext(),
    );

    assert.deepStrictEqual(result.filtered?.value, [{ value: 2, seen: true }]);
    assert.deepStrictEqual(array, [{ value: 1 }, { value: 2 }]);
  });

  it('does not mutate upstream interpolation input values', async () => {
    const node = createNode({
      callbackBody: '{{allowed}}.push(4); return {{allowed}}.includes(item);',
    });
    const allowed = [2, 3];

    const result = await node.process(
      {
        ['array' as PortId]: { type: 'number[]', value: [1, 2, 3, 4] },
        ['allowed' as PortId]: { type: 'any[]', value: allowed },
      },
      createContext(),
    );

    assert.deepStrictEqual(result.filtered?.value, [2, 3, 4]);
    assert.deepStrictEqual(allowed, [2, 3]);
  });

  it('receives index and array callback parameters', async () => {
    const node = createNode({
      callbackBody: 'return index === 0 || item === array[array.length - 1];',
    });

    const result = await node.process(
      {
        ['array' as PortId]: { type: 'string[]', value: ['a', 'b', 'c'] },
      },
      createContext(),
    );

    assert.deepStrictEqual(result.filtered?.value, ['a', 'c']);
  });

  it('uses JS truthiness rather than strict booleans', async () => {
    const node = createNode({ callbackBody: 'return item;' });

    const result = await node.process(
      {
        ['array' as PortId]: { type: 'any[]', value: [0, 1, '', 'hello', null] },
      },
      createContext(),
    );

    assert.deepStrictEqual(result.filtered?.value, [1, 'hello']);
  });

  it('throws on missing or non-array input', async () => {
    const node = createNode({ callbackBody: 'return true;' });

    await assert.rejects(
      () =>
        node.process(
          {
            ['array' as PortId]: { type: 'string', value: 'not-an-array' },
          },
          createContext(),
        ),
      /JS Filter input "array" must be an array\./,
    );
  });

  it('rejects promise-returning callbacks', async () => {
    const node = createNode({ callbackBody: 'return Promise.resolve(true);' });

    await assert.rejects(
      () =>
        node.process(
          {
            ['array' as PortId]: { type: 'number[]', value: [1, 2, 3] },
          },
          createContext(),
        ),
      /JS Filter callbacks must be synchronous\./,
    );
  });

  it('respects disabled dynamic code execution', async () => {
    const node = createNode({ callbackBody: 'return true;' });

    await assert.rejects(
      () =>
        node.process(
          {
            ['array' as PortId]: { type: 'number[]', value: [1] },
          },
          createContext(new NotAllowedCodeRunner()),
        ),
      /Dynamic code execution is disabled\./,
    );
  });
});
