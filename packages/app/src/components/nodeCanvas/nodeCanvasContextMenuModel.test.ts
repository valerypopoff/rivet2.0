import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createBuiltInRegistry,
  type ChartNode,
  type FrozenNodeOutputsByGraph,
  type GraphId,
  type NodeId,
  type NodePrefabId,
  type PortId,
  type Project,
  type ProjectId,
} from '@valerypopoff/rivet2-core';
import type { ContextMenuData } from '../../hooks/useContextMenu.js';
import {
  canRunNodeCanvasContextMenuFromHere,
  getNodeCanvasContextMenuContext,
  getNodeCanvasContextMenuTarget,
} from './nodeCanvasContextMenuModel.js';
import { canNodeTypeBeFrozen } from '../../utils/frozenNodeOutputs.js';

const registry = createBuiltInRegistry();
const graphId = 'graph-1' as GraphId;
const nodeId = 'node-1' as NodeId;
const project = makeProject();
const baseNode = project.graphs[graphId]!.nodes[0]!;
const contextModelOptions = {
  canStartEditorGraphRun: true,
  canUseFrozenNodes: true,
  frozenNodeOutputs: {},
  graphSelection: {},
  lastRunPerNode: {},
  nodesById: {
    [nodeId]: baseNode,
  },
  project,
  projectNodeRegistry: registry,
  selectedGraphId: graphId,
  selectedNodeIds: [],
};

function makeNode(type: ChartNode['type'], id: NodeId, title = type): ChartNode {
  const node = registry.createDynamic(type);
  node.id = id;
  node.title = title;
  return node;
}

function makeProject(): Project {
  const node = makeNode('text', nodeId, 'Text');

  return {
    metadata: {
      description: '',
      id: 'project-1' as ProjectId,
      mainGraphId: graphId,
      title: 'Project',
    },
    graphs: {
      [graphId]: {
        metadata: { id: graphId, name: 'Graph' },
        nodes: [node],
        connections: [],
      },
    },
  };
}

function makeProjectWithFrozenBoundaryDependency(): Project {
  const sourceNode = registry.createDynamic('text');
  sourceNode.id = 'source-node' as NodeId;
  sourceNode.title = 'Source';

  const selectedNode = registry.createDynamic('text');
  selectedNode.id = nodeId;
  selectedNode.title = 'Selected';
  selectedNode.data = {
    ...(selectedNode.data as Record<string, unknown>),
    text: '{{input}}',
  };

  return {
    metadata: {
      description: '',
      id: 'project-1' as ProjectId,
      mainGraphId: graphId,
      title: 'Project',
    },
    graphs: {
      [graphId]: {
        metadata: { id: graphId, name: 'Graph' },
        nodes: [sourceNode, selectedNode],
        connections: [
          {
            outputNodeId: sourceNode.id,
            outputId: 'output' as PortId,
            inputNodeId: selectedNode.id,
            inputId: 'input' as PortId,
          },
        ],
      },
    },
  };
}

function makeContextMenuData(type: string, nodeIdValue = nodeId): ContextMenuData {
  return {
    x: 0,
    y: 0,
    data: {
      type,
      element: {
        dataset: { nodeid: nodeIdValue },
      } as unknown as HTMLElement,
    },
  };
}

test('getNodeCanvasContextMenuContext creates blank-area context for non-node targets', () => {
  assert.deepEqual(
    getNodeCanvasContextMenuContext({
      ...contextModelOptions,
      contextMenuData: { x: 0, y: 0, data: null },
    }),
    {
      type: 'blankArea',
      data: {
        graphCommandsEnabled: true,
        pasteCommandsEnabled: true,
      },
    },
  );
});

test('getNodeCanvasContextMenuContext can enable paste without enabling graph commands', () => {
  assert.deepEqual(
    getNodeCanvasContextMenuContext({
      ...contextModelOptions,
      contextMenuData: { x: 0, y: 0, data: null },
      graphCommandsEnabled: false,
      pasteCommandsEnabled: true,
    }),
    {
      type: 'blankArea',
      data: {
        graphCommandsEnabled: false,
        pasteCommandsEnabled: true,
      },
    },
  );
});

test('getNodeCanvasContextMenuTarget rejects malformed node targets without a node id', () => {
  assert.equal(
    getNodeCanvasContextMenuTarget({
      type: 'node-text',
      element: {
        dataset: {},
      } as unknown as HTMLElement,
    }),
    undefined,
  );
});

test('getNodeCanvasContextMenuTarget rejects malformed node targets without a node type', () => {
  assert.equal(getNodeCanvasContextMenuTarget(makeContextMenuData('node-').data), undefined);
});

test('getNodeCanvasContextMenuContext hydrates node context data from the DOM target', () => {
  assert.deepEqual(
    getNodeCanvasContextMenuContext({
      ...contextModelOptions,
      contextMenuData: makeContextMenuData('node-text'),
    }),
    {
      type: 'node',
      data: {
        nodeType: 'text',
        nodeId,
        graphCommandsEnabled: true,
        isLinkedNode: false,
        canRunFromEditor: true,
        canRunFromHere: true,
        canRearrangeSubgraphPorts: false,
        canRearrangeVariadicPorts: false,
        variadicPortRearrangeKind: undefined,
        canFreeze: false,
        canUnfreeze: false,
        freezeNodeTargets: [],
        freezeMenuTargetCount: 1,
        freezeDisabledReason: undefined,
        unfreezeNodeIds: [],
        isFrozen: false,
        canOpenNodePrefabSource: false,
      },
    },
  );
});

test('getNodeCanvasContextMenuContext marks linked nodes while resolving their source type', () => {
  const prefabId = 'prefab-text' as NodePrefabId;
  const linkedNode = makeNode('nodePrefabInstance', nodeId, 'Linked node');
  linkedNode.data = { prefabId };
  const sourceNode = makeNode('text', 'source-node' as NodeId, 'Library text');
  const projectWithPrefab: Project = {
    ...project,
    graphs: {
      [graphId]: {
        metadata: { id: graphId, name: 'Graph' },
        nodes: [linkedNode],
        connections: [],
      },
    },
    nodePrefabs: {
      [prefabId]: {
        id: prefabId,
        sourceNode,
      },
    },
  };

  const context = getNodeCanvasContextMenuContext({
    ...contextModelOptions,
    contextMenuData: makeContextMenuData('node-nodePrefabInstance'),
    nodesById: {
      [nodeId]: linkedNode,
    },
    project: projectWithPrefab,
  });

  assert.equal(context.type, 'node');
  assert.equal(context.data.nodeType, 'text');
  assert.equal(context.data.isLinkedNode, true);
  assert.equal(context.data.canOpenNodePrefabSource, true);
});

test('getNodeCanvasContextMenuContext enables Subgraph port rearrange when the target graph has boundary nodes', () => {
  const childGraphId = 'child-graph' as GraphId;
  const subGraphNode = makeNode('subGraph', nodeId, 'Subgraph');
  subGraphNode.data = {
    ...(subGraphNode.data as Record<string, unknown>),
    graphId: childGraphId,
  };
  const inputNode = makeNode('graphInput', 'input-node' as NodeId, 'Graph Input');
  inputNode.data = {
    ...(inputNode.data as Record<string, unknown>),
    id: 'input',
  };

  const projectWithBoundarySubgraph: Project = {
    ...project,
    graphs: {
      [graphId]: {
        metadata: { id: graphId, name: 'Graph' },
        nodes: [subGraphNode],
        connections: [],
      },
      [childGraphId]: {
        metadata: { id: childGraphId, name: 'Child' },
        nodes: [inputNode],
        connections: [],
      },
    },
  };

  const context = getNodeCanvasContextMenuContext({
    ...contextModelOptions,
    contextMenuData: makeContextMenuData('node-subGraph'),
    nodesById: {
      [nodeId]: subGraphNode,
    },
    project: projectWithBoundarySubgraph,
  });

  assert.equal(context.type, 'node');
  assert.equal(context.data.canRearrangeSubgraphPorts, true);
});

test('getNodeCanvasContextMenuContext hides Subgraph port rearrange when the target graph has no boundary nodes', () => {
  const childGraphId = 'empty-child-graph' as GraphId;
  const subGraphNode = makeNode('subGraph', nodeId, 'Subgraph');
  subGraphNode.data = {
    ...(subGraphNode.data as Record<string, unknown>),
    graphId: childGraphId,
  };

  const projectWithEmptySubgraph: Project = {
    ...project,
    graphs: {
      [graphId]: {
        metadata: { id: graphId, name: 'Graph' },
        nodes: [subGraphNode],
        connections: [],
      },
      [childGraphId]: {
        metadata: { id: childGraphId, name: 'Child' },
        nodes: [],
        connections: [],
      },
    },
  };

  const context = getNodeCanvasContextMenuContext({
    ...contextModelOptions,
    contextMenuData: makeContextMenuData('node-subGraph'),
    nodesById: {
      [nodeId]: subGraphNode,
    },
    project: projectWithEmptySubgraph,
  });

  assert.equal(context.type, 'node');
  assert.equal(context.data.canRearrangeSubgraphPorts, false);
});

test('getNodeCanvasContextMenuContext enables one-side variadic input rearrange for connected Did Run slots', () => {
  const didRunNode = makeNode('didRun', nodeId, 'Did Run');
  const sourceNode = makeNode('text', 'source-node' as NodeId, 'Source');
  const projectWithDidRun: Project = {
    ...project,
    graphs: {
      [graphId]: {
        metadata: { id: graphId, name: 'Graph' },
        nodes: [didRunNode, sourceNode],
        connections: [
          {
            inputId: 'input2' as PortId,
            inputNodeId: didRunNode.id,
            outputId: 'output' as PortId,
            outputNodeId: sourceNode.id,
          },
        ],
      },
    },
  };

  const context = getNodeCanvasContextMenuContext({
    ...contextModelOptions,
    contextMenuData: makeContextMenuData('node-didRun'),
    nodesById: {
      [nodeId]: didRunNode,
    },
    project: projectWithDidRun,
  });

  assert.equal(context.type, 'node');
  assert.equal(context.data.canRearrangeVariadicPorts, true);
  assert.equal(context.data.variadicPortRearrangeKind, 'input-only');
});

test('getNodeCanvasContextMenuContext enables variadic rearrange for linked nodes based on their source type', () => {
  const prefabId = 'prefab-did-run' as NodePrefabId;
  const linkedNode = makeNode('nodePrefabInstance', nodeId, 'Linked Did Run');
  linkedNode.data = { prefabId };
  const didRunSource = makeNode('didRun', 'library-did-run' as NodeId, 'Library Did Run');
  const sourceNode = makeNode('text', 'source-node' as NodeId, 'Source');
  const projectWithLinkedDidRun: Project = {
    ...project,
    graphs: {
      [graphId]: {
        metadata: { id: graphId, name: 'Graph' },
        nodes: [linkedNode, sourceNode],
        connections: [
          {
            inputId: 'input2' as PortId,
            inputNodeId: linkedNode.id,
            outputId: 'output' as PortId,
            outputNodeId: sourceNode.id,
          },
        ],
      },
    },
    nodePrefabs: {
      [prefabId]: {
        id: prefabId,
        sourceNode: didRunSource,
      },
    },
  };

  const context = getNodeCanvasContextMenuContext({
    ...contextModelOptions,
    contextMenuData: makeContextMenuData('node-nodePrefabInstance'),
    nodesById: {
      [nodeId]: linkedNode,
    },
    project: projectWithLinkedDidRun,
  });

  assert.equal(context.type, 'node');
  assert.equal(context.data.nodeType, 'didRun');
  assert.equal(context.data.canRearrangeVariadicPorts, true);
  assert.equal(context.data.variadicPortRearrangeKind, 'input-only');
});

test('getNodeCanvasContextMenuContext enables mirror variadic rearrange for connected Passthrough slots', () => {
  const passthroughNode = makeNode('passthrough', nodeId, 'Passthrough');
  const sourceNode = makeNode('text', 'source-node' as NodeId, 'Source');
  const projectWithPassthrough: Project = {
    ...project,
    graphs: {
      [graphId]: {
        metadata: { id: graphId, name: 'Graph' },
        nodes: [passthroughNode, sourceNode],
        connections: [
          {
            inputId: 'input2' as PortId,
            inputNodeId: passthroughNode.id,
            outputId: 'output' as PortId,
            outputNodeId: sourceNode.id,
          },
        ],
      },
    },
  };

  const context = getNodeCanvasContextMenuContext({
    ...contextModelOptions,
    contextMenuData: makeContextMenuData('node-passthrough'),
    nodesById: {
      [nodeId]: passthroughNode,
    },
    project: projectWithPassthrough,
  });

  assert.equal(context.type, 'node');
  assert.equal(context.data.canRearrangeVariadicPorts, true);
  assert.equal(context.data.variadicPortRearrangeKind, 'input-output-pair');
});

test('getNodeCanvasContextMenuContext enables Freeze for nodes with retained successful outputs', () => {
  const context = getNodeCanvasContextMenuContext({
    ...contextModelOptions,
    contextMenuData: makeContextMenuData('node-text'),
    lastRunPerNode: {
      [nodeId]: [
        {
          graphId,
          processId: 'process-1' as any,
          data: {
            status: { type: 'ok' },
            outputData: {
              output: { type: 'string', storage: 'inline', value: 'saved output' },
            },
          },
        },
      ],
    } as any,
  });

  assert.equal(context.type, 'node');
  assert.equal(context.data.canFreeze, true);
  assert.equal(context.data.canUnfreeze, false);
  assert.deepEqual(context.data.freezeNodeTargets, [{ nodeId, nodeType: 'text' }]);
  assert.equal(context.data.freezeMenuTargetCount, 1);
  assert.equal(context.data.freezeDisabledReason, undefined);
  assert.deepEqual(context.data.unfreezeNodeIds, []);
  assert.equal(context.data.isFrozen, false);
});

test('getNodeCanvasContextMenuContext bulk-freezes only selected nodes with retained successful outputs', () => {
  const secondNodeId = 'node-2' as NodeId;
  const noOutputNodeId = 'node-without-output' as NodeId;
  const graphOutputNodeId = 'graph-output-node' as NodeId;
  const secondNode = makeNode('text', secondNodeId, 'Second');
  const noOutputNode = makeNode('text', noOutputNodeId, 'No output');
  const graphOutputNode = makeNode('graphOutput', graphOutputNodeId, 'Graph Output');

  const context = getNodeCanvasContextMenuContext({
    ...contextModelOptions,
    contextMenuData: makeContextMenuData('node-text'),
    selectedNodeIds: [nodeId, secondNodeId, noOutputNodeId, graphOutputNodeId],
    nodesById: {
      [nodeId]: baseNode,
      [secondNodeId]: secondNode,
      [noOutputNodeId]: noOutputNode,
      [graphOutputNodeId]: graphOutputNode,
    },
    lastRunPerNode: {
      [nodeId]: [
        {
          graphId,
          processId: 'process-1' as any,
          data: {
            status: { type: 'ok' },
            outputData: {
              output: { type: 'string', storage: 'inline', value: 'first output' },
            },
          },
        },
      ],
      [secondNodeId]: [
        {
          graphId,
          processId: 'process-2' as any,
          data: {
            status: { type: 'ok' },
            outputData: {
              output: { type: 'string', storage: 'inline', value: 'second output' },
            },
          },
        },
      ],
      [graphOutputNodeId]: [
        {
          graphId,
          processId: 'process-3' as any,
          data: {
            status: { type: 'ok' },
            outputData: {
              valueOutput: { type: 'string', storage: 'inline', value: 'blocked output' },
            },
          },
        },
      ],
    } as any,
  });

  assert.equal(context.type, 'node');
  assert.equal(context.data.canFreeze, true);
  assert.equal(context.data.freezeMenuTargetCount, 4);
  assert.equal(context.data.freezeDisabledReason, undefined);
  assert.deepEqual(context.data.freezeNodeTargets, [
    { nodeId, nodeType: 'text' },
    { nodeId: secondNodeId, nodeType: 'text' },
  ]);
});

test('getNodeCanvasContextMenuContext ignores the selection when right-clicking an unselected node', () => {
  const selectedNodeId = 'selected-node' as NodeId;
  const selectedNode = makeNode('text', selectedNodeId, 'Selected');

  const context = getNodeCanvasContextMenuContext({
    ...contextModelOptions,
    contextMenuData: makeContextMenuData('node-text'),
    selectedNodeIds: [selectedNodeId],
    nodesById: {
      [nodeId]: baseNode,
      [selectedNodeId]: selectedNode,
    },
    lastRunPerNode: {
      [nodeId]: [
        {
          graphId,
          processId: 'process-1' as any,
          data: {
            status: { type: 'ok' },
            outputData: {
              output: { type: 'string', storage: 'inline', value: 'target output' },
            },
          },
        },
      ],
      [selectedNodeId]: [
        {
          graphId,
          processId: 'process-2' as any,
          data: {
            status: { type: 'ok' },
            outputData: {
              output: { type: 'string', storage: 'inline', value: 'selected output' },
            },
          },
        },
      ],
    } as any,
  });

  assert.equal(context.type, 'node');
  assert.deepEqual(context.data.freezeNodeTargets, [{ nodeId, nodeType: 'text' }]);
  assert.equal(context.data.freezeMenuTargetCount, 1);
  assert.equal(context.data.freezeDisabledReason, undefined);
});

test('canNodeTypeBeFrozen blocks non-replayable node categories', () => {
  assert.equal(canNodeTypeBeFrozen('text'), true);

  for (const nodeType of [
    'comment',
    'abortGraph',
    'graphOutput',
    'appendToDataset',
    'createDataset',
    'replaceDataset',
    'raiseEvent',
    'playAudio',
  ] as const) {
    assert.equal(canNodeTypeBeFrozen(nodeType), false, `${nodeType} should not be freezable`);
  }
});

test('getNodeCanvasContextMenuContext disables Freeze for Graph Output nodes with retained outputs', () => {
  const context = getNodeCanvasContextMenuContext({
    ...contextModelOptions,
    contextMenuData: makeContextMenuData('node-graphOutput'),
    lastRunPerNode: {
      [nodeId]: [
        {
          graphId,
          processId: 'process-1' as any,
          data: {
            status: { type: 'ok' },
            outputData: {
              valueOutput: { type: 'string', storage: 'inline', value: 'graph output value' },
            },
          },
        },
      ],
    } as any,
  });

  assert.equal(context.type, 'node');
  assert.equal(context.data.canFreeze, false);
  assert.equal(context.data.canUnfreeze, false);
  assert.deepEqual(context.data.freezeNodeTargets, []);
  assert.equal(context.data.freezeMenuTargetCount, 1);
  assert.equal(context.data.freezeDisabledReason, 'This node type cannot be frozen');
  assert.deepEqual(context.data.unfreezeNodeIds, []);
});

test('getNodeCanvasContextMenuContext enables Unfreeze for frozen nodes', () => {
  const context = getNodeCanvasContextMenuContext({
    ...contextModelOptions,
    contextMenuData: makeContextMenuData('node-text'),
    frozenNodeOutputs: {
      [graphId]: {
        [nodeId]: [
          {
            output: { type: 'string', value: 'frozen output' },
          },
        ],
      },
    } as any,
  });

  assert.equal(context.type, 'node');
  assert.equal(context.data.canFreeze, false);
  assert.equal(context.data.canUnfreeze, true);
  assert.deepEqual(context.data.freezeNodeTargets, []);
  assert.equal(context.data.freezeMenuTargetCount, 1);
  assert.equal(context.data.freezeDisabledReason, undefined);
  assert.deepEqual(context.data.unfreezeNodeIds, [nodeId]);
  assert.equal(context.data.isFrozen, true);
});

test('getNodeCanvasContextMenuContext bulk-unfreezes frozen selected nodes only', () => {
  const secondNodeId = 'node-2' as NodeId;
  const unfrozenNodeId = 'unfrozen-node' as NodeId;
  const staleGraphOutputNodeId = 'stale-graph-output-node' as NodeId;
  const secondNode = makeNode('text', secondNodeId, 'Second');
  const unfrozenNode = makeNode('text', unfrozenNodeId, 'Unfrozen');
  const staleGraphOutputNode = makeNode('graphOutput', staleGraphOutputNodeId, 'Stale Graph Output');

  const context = getNodeCanvasContextMenuContext({
    ...contextModelOptions,
    contextMenuData: makeContextMenuData('node-text'),
    selectedNodeIds: [nodeId, secondNodeId, unfrozenNodeId, staleGraphOutputNodeId],
    nodesById: {
      [nodeId]: baseNode,
      [secondNodeId]: secondNode,
      [unfrozenNodeId]: unfrozenNode,
      [staleGraphOutputNodeId]: staleGraphOutputNode,
    },
    frozenNodeOutputs: {
      [graphId]: {
        [nodeId]: [{ output: { type: 'string', value: 'first frozen output' } }],
        [secondNodeId]: [{ output: { type: 'string', value: 'second frozen output' } }],
        [staleGraphOutputNodeId]: [{ valueOutput: { type: 'string', value: 'stale frozen output' } }],
      },
    } as any,
  });

  assert.equal(context.type, 'node');
  assert.equal(context.data.canUnfreeze, true);
  assert.equal(context.data.freezeMenuTargetCount, 4);
  assert.equal(context.data.freezeDisabledReason, undefined);
  assert.deepEqual(context.data.unfreezeNodeIds, [nodeId, secondNodeId, staleGraphOutputNodeId]);
});

test('getNodeCanvasContextMenuContext keeps Unfreeze available for stale frozen blocked nodes', () => {
  const context = getNodeCanvasContextMenuContext({
    ...contextModelOptions,
    contextMenuData: makeContextMenuData('node-raiseEvent'),
    frozenNodeOutputs: {
      [graphId]: {
        [nodeId]: [
          {
            result: { type: 'string', value: 'event data' },
          },
        ],
      },
    } as any,
  });

  assert.equal(context.type, 'node');
  assert.equal(context.data.canFreeze, false);
  assert.equal(context.data.canUnfreeze, true);
  assert.deepEqual(context.data.freezeNodeTargets, []);
  assert.equal(context.data.freezeMenuTargetCount, 1);
  assert.equal(context.data.freezeDisabledReason, undefined);
  assert.deepEqual(context.data.unfreezeNodeIds, [nodeId]);
  assert.equal(context.data.isFrozen, true);
});

test('getNodeCanvasContextMenuContext disables Freeze and Unfreeze outside normal editor runs', () => {
  const context = getNodeCanvasContextMenuContext({
    ...contextModelOptions,
    canUseFrozenNodes: false,
    contextMenuData: makeContextMenuData('node-text'),
    freezeUnavailableReason: 'Freeze node output is unavailable while the Remote Debugger is active.',
    frozenNodeOutputs: {
      [graphId]: {
        [nodeId]: [
          {
            output: { type: 'string', value: 'frozen output' },
          },
        ],
      },
    } as any,
    lastRunPerNode: {
      [nodeId]: [
        {
          graphId,
          processId: 'process-1' as any,
          data: {
            status: { type: 'ok' },
            outputData: {
              output: { type: 'string', storage: 'inline', value: 'saved output' },
            },
          },
        },
      ],
    } as any,
  });

  assert.equal(context.type, 'node');
  assert.equal(context.data.canFreeze, false);
  assert.equal(context.data.canUnfreeze, false);
  assert.deepEqual(context.data.freezeNodeTargets, []);
  assert.equal(context.data.freezeMenuTargetCount, 1);
  assert.equal(context.data.freezeDisabledReason, undefined);
  assert.deepEqual(context.data.unfreezeNodeIds, []);
  assert.equal(context.data.isFrozen, true);
});

test('getNodeCanvasContextMenuContext keeps disabled Freeze visible for mode blockers when output can be frozen', () => {
  const context = getNodeCanvasContextMenuContext({
    ...contextModelOptions,
    canUseFrozenNodes: false,
    contextMenuData: makeContextMenuData('node-text'),
    freezeUnavailableReason: 'Freeze node output is unavailable while the Remote Debugger is active.',
    lastRunPerNode: {
      [nodeId]: [
        {
          graphId,
          processId: 'process-1' as any,
          data: {
            status: { type: 'ok' },
            outputData: {
              output: { type: 'string', storage: 'inline', value: 'saved output' },
            },
          },
        },
      ],
    } as any,
  });

  assert.equal(context.type, 'node');
  assert.equal(context.data.canFreeze, false);
  assert.deepEqual(context.data.freezeNodeTargets, []);
  assert.equal(context.data.freezeMenuTargetCount, 1);
  assert.equal(context.data.freezeDisabledReason, 'Freeze node output is unavailable while the Remote Debugger is active.');
});

test('getNodeCanvasContextMenuContext ignores frozen preload boundaries when frozen nodes are disabled', () => {
  const projectWithFrozenBoundaryDependency = makeProjectWithFrozenBoundaryDependency();
  const frozenNodeOutputs = {
    [graphId]: {
      ['source-node' as NodeId]: [
        {
          ['output' as PortId]: { type: 'string', value: 'frozen source' },
        },
      ],
    },
  } satisfies FrozenNodeOutputsByGraph;

  const enabledContext = getNodeCanvasContextMenuContext({
    ...contextModelOptions,
    contextMenuData: makeContextMenuData('node-text'),
    frozenNodeOutputs,
    lastRunPerNode: {},
    project: projectWithFrozenBoundaryDependency,
  });
  const disabledContext = getNodeCanvasContextMenuContext({
    ...contextModelOptions,
    canUseFrozenNodes: false,
    contextMenuData: makeContextMenuData('node-text'),
    frozenNodeOutputs,
    lastRunPerNode: {},
    project: projectWithFrozenBoundaryDependency,
  });

  assert.equal(enabledContext.type, 'node');
  assert.equal(enabledContext.data.canRunFromHere, true);
  assert.equal(disabledContext.type, 'node');
  assert.equal(disabledContext.data.canRunFromHere, false);
});

test('canRunNodeCanvasContextMenuFromHere is false when editor runs are unavailable or planning fails', () => {
  assert.equal(
    canRunNodeCanvasContextMenuFromHere({
      ...contextModelOptions,
      canStartEditorGraphRun: false,
      nodeId,
    }),
    false,
  );

  assert.equal(
    canRunNodeCanvasContextMenuFromHere({
      ...contextModelOptions,
      nodeId: 'missing-node' as NodeId,
    }),
    false,
  );
});
