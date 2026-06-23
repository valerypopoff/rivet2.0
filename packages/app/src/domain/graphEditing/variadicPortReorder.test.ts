import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  ChartNode,
  NodeConnection,
  NodeId,
  NodeInputDefinition,
  NodeOutputDefinition,
  PortId,
} from '@valerypopoff/rivet2-core';
import {
  buildVariadicPortIdMapping,
  buildVariadicPortReorderMappings,
  canRearrangeVariadicNodePorts,
  getReorderableVariadicInputDefinitions,
  getReorderableVariadicOutputDefinitions,
  getVariadicPortReorderSpec,
  hasVariadicNodeConnectionAffectedByMapping,
  mapVariadicPairPortIdMapping,
  reorderVariadicNodeConnections,
} from './variadicPortReorder.js';

const nodeId = 'node-1' as NodeId;

function makeNode(type: ChartNode['type']): ChartNode {
  return {
    data: {},
    id: nodeId,
    title: type,
    type,
    visualData: { x: 0, y: 0 },
  };
}

function input(id: string): NodeInputDefinition {
  return {
    dataType: 'any',
    id: id as PortId,
    title: id,
  };
}

function output(id: string): NodeOutputDefinition {
  return {
    dataType: 'any',
    id: id as PortId,
    title: id,
  };
}

function connectionTo(inputId: string): NodeConnection {
  return {
    inputId: inputId as PortId,
    inputNodeId: nodeId,
    outputId: 'output' as PortId,
    outputNodeId: `source-${inputId}` as NodeId,
  };
}

test('variadic reorder specs are explicit and exclude Loop Controller', () => {
  assert.equal(getVariadicPortReorderSpec(makeNode('didRun'))?.kind, 'input-only');
  assert.equal(getVariadicPortReorderSpec(makeNode('passthrough'))?.kind, 'input-output-pair');
  assert.equal(getVariadicPortReorderSpec(makeNode('loopController')), undefined);
});

test('reorderable variadic inputs include occupied slot range but exclude trailing blank slot', () => {
  const definitions = [input('conditional'), input('input1'), input('input2'), input('input3'), input('input4')];
  const result = getReorderableVariadicInputDefinitions({
    connections: [connectionTo('input3')],
    definitions,
    node: makeNode('coalesce'),
  });

  assert.deepEqual(
    result.map((definition) => definition.id),
    ['input1', 'input2', 'input3'],
  );
});

test('context menu availability requires at least two connected-range slots', () => {
  assert.equal(
    canRearrangeVariadicNodePorts({
      connections: [connectionTo('input1')],
      node: makeNode('didRun'),
    }),
    undefined,
  );
  assert.equal(
    canRearrangeVariadicNodePorts({
      connections: [connectionTo('input2')],
      node: makeNode('didRun'),
    }),
    'input-only',
  );
});

test('port mapping rewrites preview order back into normal slot ids', () => {
  assert.deepEqual(
    buildVariadicPortIdMapping({
      currentPortOrder: ['input1', 'input2', 'input3'],
      nextPortOrder: ['input3', 'input1', 'input2'],
    }),
    {
      input1: 'input2',
      input2: 'input3',
      input3: 'input1',
    },
  );
});

test('port mapping rejects duplicate or partial preview orders', () => {
  assert.deepEqual(
    buildVariadicPortIdMapping({
      currentPortOrder: ['input1', 'input2', 'input3'],
      nextPortOrder: ['input1', 'input1', 'input3'],
    }),
    {},
  );
  assert.deepEqual(
    buildVariadicPortIdMapping({
      currentPortOrder: ['input1', 'input2', 'input3'],
      nextPortOrder: ['input1', 'input2', 'missing'],
    }),
    {},
  );
});

test('mirror output definitions follow the reorderable input range', () => {
  const inputDefinitions = [input('input1'), input('input2'), input('input3')];
  const outputDefinitions = [output('output1'), output('output2'), output('output3')];
  const result = getReorderableVariadicOutputDefinitions({
    definitions: outputDefinitions,
    inputDefinitions,
    spec: getVariadicPortReorderSpec(makeNode('passthrough')),
  });

  assert.deepEqual(
    result.map((definition) => definition.id),
    ['output1', 'output2', 'output3'],
  );
});

test('mirror port mapping keeps input and output pairs together', () => {
  assert.deepEqual(
    mapVariadicPairPortIdMapping(
      {
        input1: 'input2',
        input2: 'input1',
      },
      'input',
      'output',
    ),
    {
      output1: 'output2',
      output2: 'output1',
    },
  );
});

test('buildVariadicPortReorderMappings builds one-side input mappings only', () => {
  assert.deepEqual(
    buildVariadicPortReorderMappings({
      currentPortOrder: ['input1', 'input2'],
      nextPortOrder: ['input2', 'input1'],
      side: 'input',
      spec: getVariadicPortReorderSpec(makeNode('didRun'))!,
    }),
    {
      inputPortMapping: {
        input1: 'input2',
        input2: 'input1',
      },
      outputPortMapping: undefined,
    },
  );
});

test('buildVariadicPortReorderMappings mirrors input and output mappings for paired variadic nodes', () => {
  const spec = getVariadicPortReorderSpec(makeNode('passthrough'))!;

  assert.deepEqual(
    buildVariadicPortReorderMappings({
      currentPortOrder: ['input1', 'input2'],
      nextPortOrder: ['input2', 'input1'],
      side: 'input',
      spec,
    }),
    {
      inputPortMapping: {
        input1: 'input2',
        input2: 'input1',
      },
      outputPortMapping: {
        output1: 'output2',
        output2: 'output1',
      },
    },
  );

  assert.deepEqual(
    buildVariadicPortReorderMappings({
      currentPortOrder: ['output1', 'output2'],
      nextPortOrder: ['output2', 'output1'],
      side: 'output',
      spec,
    }),
    {
      inputPortMapping: {
        input1: 'input2',
        input2: 'input1',
      },
      outputPortMapping: {
        output1: 'output2',
        output2: 'output1',
      },
    },
  );
});

test('reorderVariadicNodeConnections rewrites only endpoints on the target node and preserves bend points', () => {
  const connections: NodeConnection[] = [
    {
      ...connectionTo('input1'),
      bendPoint: { x: 10, y: 20 },
    },
    {
      inputId: 'target' as PortId,
      inputNodeId: 'consumer' as NodeId,
      outputId: 'output1' as PortId,
      outputNodeId: nodeId,
    },
    {
      inputId: 'input1' as PortId,
      inputNodeId: 'other-node' as NodeId,
      outputId: 'output' as PortId,
      outputNodeId: 'unrelated' as NodeId,
    },
  ];

  const result = reorderVariadicNodeConnections({
    connections,
    inputPortMapping: { input1: 'input2' },
    nodeId,
    outputPortMapping: { output1: 'output2' },
  });

  assert.deepEqual(result[0], {
    ...connections[0],
    inputId: 'input2',
  });
  assert.deepEqual(result[1], {
    ...connections[1],
    outputId: 'output2',
  });
  assert.equal(result[2], connections[2]);
});

test('hasVariadicNodeConnectionAffectedByMapping ignores mappings that only touch empty slots', () => {
  const connections: NodeConnection[] = [connectionTo('input3')];

  assert.equal(
    hasVariadicNodeConnectionAffectedByMapping({
      connections,
      inputPortMapping: {
        input1: 'input2',
        input2: 'input1',
      },
      nodeId,
    }),
    false,
  );

  assert.equal(
    hasVariadicNodeConnectionAffectedByMapping({
      connections,
      inputPortMapping: {
        input3: 'input1',
      },
      nodeId,
    }),
    true,
  );
});
