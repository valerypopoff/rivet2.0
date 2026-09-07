import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  GraphProcessor,
  IsomorphicCodeRunner,
  JSMapNodeImpl,
  NotAllowedCodeRunner,
  globalRivetNodeRegistry,
  type InternalProcessContext,
  type JSMapNode,
  type NodeBodySpec,
  type PortId,
} from '../../../src/index.js';
import { testProcessContext } from '../../testUtils';

const createNode = (data: Partial<JSMapNode['data']>) => {
  return new JSMapNodeImpl({
    ...JSMapNodeImpl.create(),
    data: {
      ...JSMapNodeImpl.create().data,
      ...data,
    },
  });
};

const createContext = (codeRunner = new IsomorphicCodeRunner()) =>
  ({
    codeRunner,
    graphInputNodeValues: {},
    contextValues: {},
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

describe('JSMapNode', () => {
  it('can create node', () => {
    const node = JSMapNodeImpl.create();
    assert.strictEqual(node.type, 'jsMap');
    assert.strictEqual(node.title, 'JS Map');
  });

  it('seeds the default callback body in the editor config', () => {
    const node = JSMapNodeImpl.create();
    const editors = new JSMapNodeImpl(node).getEditors();

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
      callbackBody: ['const next = item * 2;', 'return next;'].join('\n'),
    });

    assert.deepStrictEqual(node.getBody(), {
      type: 'colorized',
      text: ['(item, index, array) => {', '  const next = item * 2;', '  return next;', '}'].join('\n'),
      language: 'javascript',
      fontSize: 12,
      fontFamily: 'monospace',
    } satisfies NodeBodySpec);
  });

  it('creates value interpolation input ports after the fixed array port', () => {
    const node = createNode({
      callbackBody: 'return item * {{factor}} + {{offset}};',
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
          id: 'factor',
          dataType: 'any',
          required: false,
        },
        {
          id: 'offset',
          dataType: 'any',
          required: false,
        },
      ],
    );
  });

  it('maps numbers with plain JS values', async () => {
    const node = createNode({ callbackBody: 'return item * 2;' });
    const result = await node.process(
      {
        ['array' as PortId]: { type: 'number[]', value: [1, 2, 3] },
      },
      createContext(),
    );

    assert.deepStrictEqual(result, {
      mapped: {
        type: 'any[]',
        value: [2, 4, 6],
      },
    });
  });

  it('evaluates interpolation inputs as connected values before mapping', async () => {
    const node = createNode({
      callbackBody: 'return { value: item * {{factor}}, label: {{label}} };',
    });

    const result = await node.process(
      {
        ['array' as PortId]: { type: 'number[]', value: [1, 2] },
        ['factor' as PortId]: { type: 'number', value: 3 },
        ['label' as PortId]: { type: 'string', value: 'scaled' },
      },
      createContext(),
    );

    assert.deepStrictEqual(result.mapped?.value, [
      { value: 3, label: 'scaled' },
      { value: 6, label: 'scaled' },
    ]);
  });

  it('resolves JSONPath expressions from callback locals and one base input port', async () => {
    const node = createNode({
      callbackBody: 'return {{item.details.score}} >= {{config.threshold}} && {{array[0].enabled}};',
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
        ['config' as PortId]: { type: 'object', value: { threshold: 3 } },
      },
      createContext(),
    );

    assert.deepStrictEqual(result.mapped?.value, [false, true]);
  });

  it('keeps interpolation values available when callback code uses generated helper names', async () => {
    const node = createNode({
      callbackBody: 'const __jsListInputs = {};\nreturn item + {{offset}};',
    });

    const result = await node.process(
      {
        ['array' as PortId]: { type: 'number[]', value: [1, 2] },
        ['offset' as PortId]: { type: 'number', value: 10 },
      },
      createContext(),
    );

    assert.deepStrictEqual(result.mapped?.value, [11, 12]);
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
          id: 'factor-input',
          type: 'graphInput',
          title: 'Factor',
          data: {
            id: 'factor',
            dataType: 'number',
          },
          visualData: { x: 0, y: 100, width: 300 },
        },
        {
          id: 'map-node',
          type: 'jsMap',
          title: 'JS Map',
          data: {
            callbackBody: 'return item * {{factor}};',
          },
          visualData: { x: 350, y: 0, width: 220 },
        },
        {
          id: 'output-node',
          type: 'graphOutput',
          title: 'Graph Output',
          data: {
            id: 'mapped',
            dataType: 'any[]',
          },
          visualData: { x: 650, y: 0, width: 300 },
        },
      ],
      connections: [
        {
          outputNodeId: 'array-input',
          outputId: 'data',
          inputNodeId: 'map-node',
          inputId: 'array',
        },
        {
          outputNodeId: 'factor-input',
          outputId: 'data',
          inputNodeId: 'map-node',
          inputId: 'factor',
        },
        {
          outputNodeId: 'map-node',
          outputId: 'mapped',
          inputNodeId: 'output-node',
          inputId: 'value',
        },
      ],
    };

    const processor = new GraphProcessor(makeProject(graph), graph.metadata.id as any, globalRivetNodeRegistry);
    const result = await processor.processGraph(testProcessContext(), {
      array: { type: 'number[]', value: [1, 2] },
      factor: { type: 'number', value: 3 },
    });

    assert.deepStrictEqual(result.mapped, { type: 'any[]', value: [3, 6] });
  });

  it('treats missing interpolation inputs as undefined', async () => {
    const node = createNode({
      callbackBody: 'return {{missing}};',
    });

    const result = await node.process(
      {
        ['array' as PortId]: { type: 'number[]', value: [1] },
      },
      createContext(),
    );

    assert.deepStrictEqual(result.mapped?.value, [undefined]);
  });

  it('allows callback locals to be written with interpolation braces', async () => {
    const node = createNode({
      callbackBody: 'return String({{index}}) + ":" + {{array}}.length + ":" + {{item}};',
    });

    assert.deepStrictEqual(
      node.getInputDefinitions().map((definition) => definition.id),
      ['array'],
    );

    const result = await node.process(
      {
        ['array' as PortId]: { type: 'string[]', value: ['a', 'b'] },
      },
      createContext(),
    );

    assert.deepStrictEqual(result.mapped?.value, ['0:2:a', '1:2:b']);
  });

  it('does not mutate upstream callback array values', async () => {
    const node = createNode({
      callbackBody: 'array[0].seen = true; array.push({ value: 99 }); return item;',
    });
    const array = [{ value: 1 }, { value: 2 }];

    const result = await node.process(
      {
        ['array' as PortId]: { type: 'any[]', value: array },
      },
      createContext(),
    );

    assert.deepStrictEqual(result.mapped?.value, [{ value: 1, seen: true }, { value: 2 }]);
    assert.deepStrictEqual(array, [{ value: 1 }, { value: 2 }]);
  });

  it('does not mutate upstream interpolation input values', async () => {
    const node = createNode({
      callbackBody: '{{config}}.seen = true; return { item, config: {{config}} };',
    });
    const config = { label: 'original' };

    const result = await node.process(
      {
        ['array' as PortId]: { type: 'string[]', value: ['a'] },
        ['config' as PortId]: { type: 'object', value: config },
      },
      createContext(),
    );

    assert.deepStrictEqual(result.mapped?.value, [{ item: 'a', config: { label: 'original', seen: true } }]);
    assert.deepStrictEqual(config, { label: 'original' });
  });

  it('does not mutate upstream function object properties', async () => {
    const node = createNode({
      callbackBody: '{{fn}}.seen = true; return {{fn}}(item);',
    });
    const fn = (value: number) => value * 2;

    const result = await node.process(
      {
        ['array' as PortId]: { type: 'number[]', value: [2] },
        ['fn' as PortId]: { type: 'any', value: fn },
      },
      createContext(),
    );

    assert.deepStrictEqual(result.mapped?.value, [4]);
    assert.equal((fn as { seen?: boolean }).seen, undefined);
  });

  it('keeps escaped interpolation tokens literal and does not create ports for them', () => {
    const node = createNode({
      callbackBody: 'return "{{{literal}}}";',
    });

    assert.deepStrictEqual(
      node.getInputDefinitions().map((definition) => definition.id),
      ['array'],
    );
  });

  it('receives index and array callback parameters', async () => {
    const node = createNode({
      callbackBody: 'return `${index}:${array.length}:${item}`;',
    });

    const result = await node.process(
      {
        ['array' as PortId]: { type: 'string[]', value: ['a', 'b'] },
      },
      createContext(),
    );

    assert.deepStrictEqual(result.mapped?.value, ['0:2:a', '1:2:b']);
  });

  it('supports mapping to objects', async () => {
    const node = createNode({
      callbackBody: 'return { item, index };',
    });

    const result = await node.process(
      {
        ['array' as PortId]: { type: 'string[]', value: ['x', 'y'] },
      },
      createContext(),
    );

    assert.deepStrictEqual(result.mapped?.value, [
      { item: 'x', index: 0 },
      { item: 'y', index: 1 },
    ]);
  });

  it('throws on missing or non-array input', async () => {
    const node = createNode({ callbackBody: 'return item;' });

    await assert.rejects(
      () =>
        node.process(
          {
            ['array' as PortId]: { type: 'string', value: 'not-an-array' },
          },
          createContext(),
        ),
      /JS Map input "array" must be an array\./,
    );
  });

  it('rejects promise-returning callbacks', async () => {
    const node = createNode({ callbackBody: 'return Promise.resolve(item);' });

    await assert.rejects(
      () =>
        node.process(
          {
            ['array' as PortId]: { type: 'number[]', value: [1, 2, 3] },
          },
          createContext(),
        ),
      /JS Map callbacks must be synchronous\./,
    );
  });

  it('respects disabled dynamic code execution', async () => {
    const node = createNode({ callbackBody: 'return item;' });

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
