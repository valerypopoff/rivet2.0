import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  canRenderDataBusNode,
  compileDataBusTopology,
  createBuiltInRegistry,
  getDataBusInputPortId,
  getDataBusOutputPortId,
  GraphProcessor,
  NodeImpl,
  nodeDefinition,
  parseDataBusChannelIndex,
  type ChartNode,
  type GraphId,
  type Inputs,
  type NodeConnection,
  type NodeId,
  type NodeInputDefinition,
  type NodeOutputDefinition,
  type NodePrefabId,
  type Outputs,
  type PortId,
  type Project,
  type ProjectId,
} from '../../src/index.js';
import { testProcessContext } from '../testUtils.js';

type RelayNode = ChartNode<'dataBusTestRelay', Record<string, never>>;

class RelayNodeImpl extends NodeImpl<RelayNode> {
  static create(): RelayNode {
    return relay('relay');
  }

  static getUIData() {
    return {};
  }

  getInputDefinitions(): NodeInputDefinition[] {
    return [{ id: 'input' as PortId, title: 'Input', dataType: 'any', required: true }];
  }

  getOutputDefinitions(): NodeOutputDefinition[] {
    return [{ id: 'output' as PortId, title: 'Output', dataType: 'any' }];
  }

  async process(inputs: Inputs): Promise<Outputs> {
    return { output: inputs['input' as PortId]! };
  }
}

const relayNodeDefinition = nodeDefinition(RelayNodeImpl, 'Data Bus Test Relay');

function id(value: string): NodeId {
  return value as NodeId;
}

function port(value: string): PortId {
  return value as PortId;
}

function dataBus(nodeId = 'bus'): ChartNode {
  return {
    id: id(nodeId),
    type: 'dataBus',
    title: 'Shared values',
    data: {},
    visualData: { x: 0, y: 0 },
  };
}

function legacyDataBus(nodeId = 'bus'): ChartNode {
  return {
    id: id(nodeId),
    type: 'passthrough',
    title: 'Legacy shared values',
    data: { renderAsDataBus: true },
    visualData: { x: 0, y: 0 },
  };
}

function relay(nodeId: string): RelayNode {
  return {
    id: id(nodeId),
    type: 'dataBusTestRelay',
    title: nodeId,
    data: {},
    visualData: { x: 0, y: 0 },
  };
}

function connection(
  outputNodeId: string,
  outputId: string,
  inputNodeId: string,
  inputId: string,
): NodeConnection {
  return {
    outputNodeId: id(outputNodeId),
    outputId: port(outputId),
    inputNodeId: id(inputNodeId),
    inputId: port(inputId),
  };
}

function graphInput(nodeId = 'input'): ChartNode {
  return {
    id: id(nodeId),
    type: 'graphInput',
    title: 'Input',
    data: { id: 'value', dataType: 'string' },
    visualData: { x: 0, y: 0 },
  };
}

function graphOutput(nodeId = 'output'): ChartNode {
  return {
    id: id(nodeId),
    type: 'graphOutput',
    title: 'Output',
    data: { id: 'result', dataType: 'string' },
    visualData: { x: 0, y: 0 },
  };
}

function project(nodes: ChartNode[], connections: NodeConnection[]): Project {
  const graphId = 'data-bus-test-graph' as GraphId;
  return {
    metadata: {
      id: 'data-bus-test-project' as ProjectId,
      title: 'Data Bus test',
      description: '',
      mainGraphId: graphId,
    },
    graphs: {
      [graphId]: {
        metadata: { id: graphId, name: 'Data Bus test', description: '' },
        nodes,
        connections,
      },
    },
    plugins: [],
  };
}

void describe('Data Bus topology', () => {
  void it('compiles independent channels without turning a downstream reuse into a cycle', () => {
    const bus = dataBus();
    const nodes = [graphInput(), bus, relay('stage'), graphOutput()];
    const connections = [
      connection('input', 'data', 'bus', 'input1'),
      connection('bus', 'output1', 'stage', 'input'),
      connection('stage', 'output', 'bus', 'input2'),
      connection('bus', 'output2', 'output', 'value'),
    ];

    const compiled = compileDataBusTopology({ connections, graphNodes: nodes });

    assert.deepEqual(compiled.executionNodes.map((node) => node.id), ['input', 'stage', 'output']);
    assert.deepEqual(compiled.connections, [
      connection('input', 'data', 'stage', 'input'),
      connection('stage', 'output', 'output', 'value'),
    ]);
  });

  void it('compiles long valid relay chains without recursive stack growth', () => {
    const relayCount = 12_000;
    const buses = Array.from({ length: relayCount }, (_, index) => dataBus(`bus-${index}`));
    const nodes = [graphInput('source'), ...buses, relay('receiver')];
    const connections = [connection('source', 'data', buses[0]!.id, 'input1')];
    for (let index = 0; index < buses.length - 1; index++) {
      connections.push(connection(buses[index]!.id, 'output1', buses[index + 1]!.id, 'input1'));
    }
    connections.push(connection(buses[buses.length - 1]!.id, 'output1', 'receiver', 'input'));

    const compiled = compileDataBusTopology({ connections, graphNodes: nodes });

    assert.deepEqual(compiled.connections, [connection('source', 'data', 'receiver', 'input')]);
    assert.deepEqual(compiled.executionNodes.map((node) => node.id), ['source', 'receiver']);
  });

  void it('runs reused later-stage values without waiting for every bus channel', async () => {
    const bus = dataBus();
    const projectValue = project(
      [graphInput(), bus, relay('stage'), graphOutput()],
      [
        connection('input', 'data', 'bus', 'input1'),
        connection('bus', 'output1', 'stage', 'input'),
        connection('stage', 'output', 'bus', 'input2'),
        connection('bus', 'output2', 'output', 'value'),
      ],
    );
    const graphId = Object.keys(projectValue.graphs)[0] as GraphId;
    const processor = new GraphProcessor(
      projectValue,
      graphId,
      createBuiltInRegistry().register(relayNodeDefinition),
    );

    const outputs = await processor.processGraph(testProcessContext(), {
      value: { type: 'string', value: 'available immediately' },
    });

    assert.deepEqual(outputs.result, { type: 'string', value: 'available immediately' });
  });

  void it('keeps compatible legacy rail nodes as a compiled topology during programmatic execution', () => {
    const bus = legacyDataBus();
    const compiled = compileDataBusTopology({
      graphNodes: [graphInput(), bus, relay('receiver')],
      connections: [
        connection('input', 'data', 'bus', 'input1'),
        connection('bus', 'output1', 'receiver', 'input'),
      ],
    });

    assert.deepEqual(compiled.executionNodes.map((node) => node.id), ['input', 'receiver']);
    assert.deepEqual(compiled.connections, [connection('input', 'data', 'receiver', 'input')]);
  });

  void it('keeps legacy Passthroughs with execution modifiers out of Data Bus compilation', () => {
    const bus = { ...legacyDataBus(), variants: [{ id: 'legacy-variant', name: 'Legacy variant' }] };
    const connections = [
      connection('input', 'data', 'bus', 'input1'),
      connection('bus', 'output1', 'receiver', 'input'),
    ];

    const compiled = compileDataBusTopology({
      graphNodes: [graphInput(), bus, relay('receiver')],
      connections,
    });

    assert.deepEqual(compiled.executionNodes.map((node) => node.id), ['input', 'bus', 'receiver']);
    assert.deepEqual(compiled.connections, connections);
  });

  void it('rejects dedicated Data Buses with execution-only settings', () => {
    assert.throws(
      () =>
        compileDataBusTopology({
          graphNodes: [{ ...dataBus(), disabled: true }],
          connections: [],
        }),
      /cannot be conditional, run per item, disabled, or variant-driven/,
    );
  });

  void it('does not render dedicated Data Buses with invalid execution-only settings as rails', () => {
    assert.equal(canRenderDataBusNode({ ...dataBus(), variants: [{ id: 'variant', name: 'Variant' }] }), false);
  });

  void it('uses canonical, bounded Data Bus channel port IDs', () => {
    assert.equal(parseDataBusChannelIndex('input01', true), undefined);
    assert.equal(parseDataBusChannelIndex('output01', false), undefined);
    assert.equal(parseDataBusChannelIndex('input0', true), undefined);
    assert.equal(parseDataBusChannelIndex('output10001', false), undefined);
    assert.equal(getDataBusInputPortId(1), 'input1');
    assert.equal(getDataBusOutputPortId(10_000), 'output10000');
    assert.throws(() => getDataBusInputPortId(0), RangeError);
    assert.throws(() => getDataBusOutputPortId(1.5), RangeError);
    assert.throws(() => getDataBusInputPortId(10_001), RangeError);
  });

  void it('rejects frozen/preloaded output injection for topology-only buses', () => {
    const bus = dataBus();
    const projectValue = project([graphInput(), bus, relay('receiver')], [
      connection('input', 'data', 'bus', 'input1'),
      connection('bus', 'output1', 'receiver', 'input'),
    ]);
    const graphId = Object.keys(projectValue.graphs)[0] as GraphId;
    const processor = new GraphProcessor(
      projectValue,
      graphId,
      createBuiltInRegistry().register(relayNodeDefinition),
    );

    assert.throws(
      () => processor.preloadNodeData(bus.id, { output1: { type: 'string', value: 'not an invocation' } }),
      /compiled topology/,
    );
  });

  void it('rejects dependency inspection for topology-only buses', () => {
    const bus = dataBus();
    const projectValue = project([graphInput(), bus, relay('receiver')], [
      connection('input', 'data', 'bus', 'input1'),
      connection('bus', 'output1', 'receiver', 'input'),
    ]);
    const graphId = Object.keys(projectValue.graphs)[0] as GraphId;
    const processor = new GraphProcessor(
      projectValue,
      graphId,
      createBuiltInRegistry().register(relayNodeDefinition),
    );

    assert.throws(() => processor.getDependencyNodesDeep(bus.id), /Cannot get dependencies for Data Bus/);
  });

  void it('rejects frozen/preloaded output injection for Data Bus library instances', () => {
    const prefabId = 'data-bus-prefab' as NodePrefabId;
    const busInstance: ChartNode<'nodePrefabInstance'> = {
      id: id('bus-instance'),
      type: 'nodePrefabInstance',
      title: 'Shared values',
      data: { prefabId },
      visualData: { x: 0, y: 0 },
    };
    const projectValue = project([graphInput(), busInstance, relay('receiver')], [
      connection('input', 'data', 'bus-instance', 'input1'),
      connection('bus-instance', 'output1', 'receiver', 'input'),
    ]);
    projectValue.nodePrefabs = {
      [prefabId]: {
        id: prefabId,
        sourceNode: dataBus('prefab-source'),
      },
    };
    const graphId = Object.keys(projectValue.graphs)[0] as GraphId;
    const processor = new GraphProcessor(
      projectValue,
      graphId,
      createBuiltInRegistry().register(relayNodeDefinition),
    );

    assert.throws(
      () => processor.preloadNodeData(busInstance.id, { output1: { type: 'string', value: 'not an invocation' } }),
      /compiled topology/,
    );
    assert.throws(() => processor.getDependencyNodesDeep(busInstance.id), /Cannot get dependencies for Data Bus/);
  });

  void it('emits an actionable root error for Data Bus compilation failures', async () => {
    const bus = dataBus();
    const projectValue = project([bus, relay('first'), relay('second')], [
      connection('first', 'output', 'bus', 'input1'),
      connection('second', 'output', 'bus', 'input1'),
    ]);
    const graphId = Object.keys(projectValue.graphs)[0] as GraphId;
    const processor = new GraphProcessor(
      projectValue,
      graphId,
      createBuiltInRegistry().register(relayNodeDefinition),
    );
    const errors: Array<Error | string> = [];
    processor.on('error', ({ error }) => errors.push(error));

    await assert.rejects(processor.processGraph(testProcessContext()), /exactly one provider/);
    assert.equal(errors.length, 1);
    assert.match(String(errors[0]), /exactly one provider/);
  });

  void it('rejects run-to targets that are Data Bus topology rather than executable nodes', async () => {
    const bus = dataBus();
    const projectValue = project([graphInput(), bus, relay('receiver')], [
      connection('input', 'data', 'bus', 'input1'),
      connection('bus', 'output1', 'receiver', 'input'),
    ]);
    const graphId = Object.keys(projectValue.graphs)[0] as GraphId;
    const processor = new GraphProcessor(
      projectValue,
      graphId,
      createBuiltInRegistry().register(relayNodeDefinition),
    );
    processor.runToNodeIds = [bus.id];

    await assert.rejects(processor.processGraph(testProcessContext()), /Cannot run to Data Bus/);
  });

  void it('rejects ambiguous providers and real bus relay loops', () => {
    const bus = dataBus();
    assert.throws(
      () =>
        compileDataBusTopology({
          graphNodes: [bus, relay('first'), relay('second')],
          connections: [
            connection('first', 'output', 'bus', 'input1'),
            connection('second', 'output', 'bus', 'input1'),
          ],
        }),
      /exactly one provider/,
    );

    assert.throws(
      () =>
        compileDataBusTopology({
          graphNodes: [bus],
          connections: [connection('bus', 'output1', 'bus', 'input1'), connection('bus', 'output1', 'receiver', 'input')],
        }),
      /relay cycle/,
    );

    assert.throws(
      () =>
        compileDataBusTopology({
          graphNodes: [bus],
          connections: [
            connection('bus', 'output1', 'bus', 'input2'),
            connection('bus', 'output2', 'bus', 'input1'),
          ],
        }),
      /relay cycle/,
    );
  });
});
