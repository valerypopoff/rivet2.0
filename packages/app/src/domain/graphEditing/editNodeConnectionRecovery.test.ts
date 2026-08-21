import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createInterpolationInputDefinition,
  createBuiltInRegistry,
  extractInterpolationVariables,
  pluginNodeDefinition,
  type ChartNode,
  type NodeConnection,
  type NodeId,
  type NodeInputDefinition,
  type NodeOutputDefinition,
  type NodeRegistration,
  type PortId,
  type Project,
} from '@valerypopoff/rivet2-core';
import { reconcileNodeEditConnections } from './editNodeConnectionRecovery.js';
import { createTestNodeRegistry, makeConnection, makeObjectNode, makeTextNode } from './testGraphBuilders.js';

const registry = createTestNodeRegistry();
type PluginInterpolationNode = ChartNode<'pluginInterpolation', { template: string }>;

const pluginRegistry = createBuiltInRegistry();
pluginRegistry.registerPlugin({
  id: 'interpolation-test-plugin',
  register(register) {
    register(
      pluginNodeDefinition<PluginInterpolationNode>(
        {
          create() {
            return {
              id: 'plugin-node' as NodeId,
              type: 'pluginInterpolation',
              title: 'Plugin Interpolation',
              data: {
                template: '{{foo}}',
              },
              visualData: {
                x: 0,
                y: 0,
                width: 300,
              },
            };
          },
          getInputDefinitions(data): NodeInputDefinition[] {
            return extractInterpolationVariables(data.template).map((inputName) =>
              createInterpolationInputDefinition({
                interpolationName: inputName,
                dataType: 'string',
                required: false,
              }),
            );
          },
          getOutputDefinitions(): NodeOutputDefinition[] {
            return [
              {
                id: 'output' as PortId,
                title: 'Output',
                dataType: 'string',
              },
            ];
          },
          async process() {
            return {};
          },
          getEditors() {
            return [];
          },
          getBody() {
            return undefined;
          },
          getUIData() {
            return {};
          },
        },
        'Plugin Interpolation',
      ),
    );
  },
});
const project = {
  graphs: {},
} as Project;

function makePromptNode(nodeId: string, promptText: string): ChartNode {
  const node = registry.createDynamic('prompt');

  node.id = nodeId as NodeId;
  node.data = {
    ...(node.data as Record<string, unknown>),
    promptText,
  };

  return node;
}

function makeCodeNode(nodeId: string, outputNames: string[]): ChartNode {
  const node = registry.createDynamic('code');

  node.id = nodeId as NodeId;
  node.data = {
    ...(node.data as Record<string, unknown>),
    outputNames,
  };

  return node;
}

function makeCodeNewNode(nodeId: string, code: string): ChartNode {
  const node = registry.createDynamic('codeNew');

  node.id = nodeId as NodeId;
  node.data = {
    ...(node.data as Record<string, unknown>),
    code,
  };

  return node;
}

function makeExpressionNode(nodeId: string, expression: string): ChartNode {
  const node = registry.createDynamic('expression');

  node.id = nodeId as NodeId;
  node.data = {
    ...(node.data as Record<string, unknown>),
    expression,
  };

  return node;
}

function makeJSFilterNode(nodeId: string, callbackBody: string): ChartNode {
  const node = registry.createDynamic('jsFilter');

  node.id = nodeId as NodeId;
  node.data = {
    ...(node.data as Record<string, unknown>),
    callbackBody,
  };

  return node;
}

function makeJSMapNode(nodeId: string, callbackBody: string): ChartNode {
  const node = registry.createDynamic('jsMap');

  node.id = nodeId as NodeId;
  node.data = {
    ...(node.data as Record<string, unknown>),
    callbackBody,
  };

  return node;
}

function makeExtractObjectPathNode(nodeId: string, path: string): ChartNode {
  const node = registry.createDynamic('extractObjectPath');

  node.id = nodeId as NodeId;
  node.data = {
    ...(node.data as Record<string, unknown>),
    path,
    usePathInput: false,
  };

  return node;
}

function makeToolNode(nodeId: string, schema: string): ChartNode {
  const node = registry.createDynamic('gptFunction');

  node.id = nodeId as NodeId;
  node.data = {
    ...(node.data as Record<string, unknown>),
    schema,
    useSchemaInput: false,
  };

  return node;
}

function makePluginInterpolationNode(nodeId: string, template: string): ChartNode {
  const node = pluginRegistry.createDynamic('pluginInterpolation');

  node.id = nodeId as NodeId;
  node.data = {
    ...(node.data as Record<string, unknown>),
    template,
  };

  return node;
}

function makeArrayNode(nodeId: string): ChartNode {
  const node = registry.createDynamic('array');
  node.id = nodeId as NodeId;
  return node;
}

function assertInterpolationRenamePreservesConnection({
  newData,
  newInputId = 'bar' as PortId,
  oldInputId = 'foo' as PortId,
  projectNodeRegistry = registry,
  targetNode,
}: {
  newData: Record<string, unknown>;
  newInputId?: PortId;
  oldInputId?: PortId;
  projectNodeRegistry?: NodeRegistration<any, any>;
  targetNode: ChartNode;
}) {
  const sourceNode = makeTextNode('source', 'source');
  const connection = makeConnection({
    inputNodeId: targetNode.id,
    inputId: oldInputId,
    outputNodeId: sourceNode.id,
  });

  const result = reconcileNodeEditConnections({
    nodeId: targetNode.id,
    newNode: {
      data: {
        ...(targetNode.data as Record<string, unknown>),
        ...newData,
      },
    },
    nodes: [sourceNode, targetNode],
    liveConnections: [connection],
    recoverableConnections: [],
    project,
    referencedProjects: {},
    projectNodeRegistry,
  });

  assert.deepEqual(result.nextConnections, [
    {
      ...connection,
      inputId: newInputId,
    },
  ]);
  assert.deepEqual(result.nextRecoverableConnections, []);
}

test('renamed interpolation input keeps the live incoming connection', () => {
  const targetNode = makeTextNode('target', '{{foo}}');
  const sourceNode = makeTextNode('source', 'source');
  const connection = makeConnection({
    inputNodeId: targetNode.id,
    inputId: 'foo' as PortId,
    outputNodeId: sourceNode.id,
  });

  const result = reconcileNodeEditConnections({
    nodeId: targetNode.id,
    newNode: {
      data: {
        ...(targetNode.data as Record<string, unknown>),
        text: '{{bar}}',
      },
    },
    nodes: [sourceNode, targetNode],
    liveConnections: [connection],
    recoverableConnections: [],
    project,
    referencedProjects: {},
    projectNodeRegistry: registry,
  });

  assert.deepEqual(result.nextConnections, [
    {
      ...connection,
      inputId: 'bar' as PortId,
    },
  ]);
  assert.deepEqual(result.nextRecoverableConnections, []);
});

test('renamed interpolation input does not rename a recoverable connection after the old port disappeared', () => {
  const targetNode = makeTextNode('target', '');
  const sourceNode = makeTextNode('source', 'source');
  const connection = makeConnection({
    inputNodeId: targetNode.id,
    inputId: 'foo' as PortId,
    outputNodeId: sourceNode.id,
  });

  const result = reconcileNodeEditConnections({
    nodeId: targetNode.id,
    newNode: {
      data: {
        ...(targetNode.data as Record<string, unknown>),
        text: '{{bar}}',
      },
    },
    nodes: [sourceNode, targetNode],
    liveConnections: [],
    recoverableConnections: [connection],
    project,
    referencedProjects: {},
    projectNodeRegistry: registry,
  });

  assert.deepEqual(result.nextConnections, []);
  assert.deepEqual(result.nextRecoverableConnections, [connection]);
});

test('recoverable interpolation input does not restore to a new prefix token', () => {
  const targetNode = makeTextNode('target', '');
  const sourceNode = makeTextNode('source', 'source');
  const connection = makeConnection({
    inputNodeId: targetNode.id,
    inputId: 'name' as PortId,
    outputNodeId: sourceNode.id,
  });

  const result = reconcileNodeEditConnections({
    nodeId: targetNode.id,
    newNode: {
      data: {
        ...(targetNode.data as Record<string, unknown>),
        text: '{{n}}',
      },
    },
    nodes: [sourceNode, targetNode],
    liveConnections: [],
    recoverableConnections: [connection],
    project,
    referencedProjects: {},
    projectNodeRegistry: registry,
  });

  assert.deepEqual(result.nextConnections, []);
  assert.deepEqual(result.nextRecoverableConnections, [connection]);
});

test('renamed interpolation input keeps live connections across consecutive merged edits', () => {
  const targetNode = makeTextNode('target', '{{aa}}');
  const sourceNode = makeTextNode('source', 'source');
  const originalConnection = makeConnection({
    inputNodeId: targetNode.id,
    inputId: 'a' as PortId,
    outputNodeId: sourceNode.id,
  });
  const currentConnection = {
    ...originalConnection,
    inputId: 'aa' as PortId,
  };

  const result = reconcileNodeEditConnections({
    nodeId: targetNode.id,
    newNode: {
      data: {
        ...(targetNode.data as Record<string, unknown>),
        text: '{{aaa}}',
      },
    },
    nodes: [sourceNode, targetNode],
    liveConnections: [currentConnection],
    recoverableConnections: [],
    project,
    referencedProjects: {},
    projectNodeRegistry: registry,
  });

  assert.deepEqual(result.nextConnections, [
    {
      ...currentConnection,
      inputId: 'aaa' as PortId,
    },
  ]);
  assert.deepEqual(result.nextRecoverableConnections, []);
});

test('renamed interpolation input rewrites only the changed port in a multi-token node', () => {
  const targetNode = makeTextNode('target', 'foo {{a}}\nbar {{b}}\nfoobar {{c}}');
  const sourceNodeA = makeTextNode('source-a', 'source a');
  const sourceNodeB = makeTextNode('source-b', 'source b');
  const sourceNodeC = makeTextNode('source-c', 'source c');
  const connectionA = makeConnection({
    outputNodeId: sourceNodeA.id,
    inputNodeId: targetNode.id,
    inputId: 'a' as PortId,
  });
  const connectionB = makeConnection({
    outputNodeId: sourceNodeB.id,
    inputNodeId: targetNode.id,
    inputId: 'b' as PortId,
  });
  const connectionC = makeConnection({
    outputNodeId: sourceNodeC.id,
    inputNodeId: targetNode.id,
    inputId: 'c' as PortId,
  });

  const result = reconcileNodeEditConnections({
    nodeId: targetNode.id,
    newNode: {
      data: {
        ...(targetNode.data as Record<string, unknown>),
        text: 'foo {{a}}\nbar {{boo}}\nfoobar {{c}}',
      },
    },
    nodes: [sourceNodeA, sourceNodeB, sourceNodeC, targetNode],
    liveConnections: [connectionA, connectionB, connectionC],
    recoverableConnections: [],
    project,
    referencedProjects: {},
    projectNodeRegistry: registry,
  });

  assert.deepEqual(result.nextConnections, [
    connectionA,
    {
      ...connectionB,
      inputId: 'boo' as PortId,
    },
    connectionC,
  ]);
  assert.deepEqual(result.nextRecoverableConnections, []);
});

test('renamed interpolation input works for same-id token nodes beyond Text', () => {
  const targetNode = makeObjectNode('target', '{"value":"{{foo}}"}');
  const sourceNode = makeTextNode('source', 'source');
  const connection = makeConnection({
    inputNodeId: targetNode.id,
    inputId: 'foo' as PortId,
    outputNodeId: sourceNode.id,
  });

  const result = reconcileNodeEditConnections({
    nodeId: targetNode.id,
    newNode: {
      data: {
        ...(targetNode.data as Record<string, unknown>),
        jsonTemplate: '{"value":"{{bar}}"}',
      },
    },
    nodes: [sourceNode, targetNode],
    liveConnections: [connection],
    recoverableConnections: [],
    project,
    referencedProjects: {},
    projectNodeRegistry: registry,
  });

  assert.deepEqual(result.nextConnections, [
    {
      ...connection,
      inputId: 'bar' as PortId,
    },
  ]);
  assert.deepEqual(result.nextRecoverableConnections, []);
});

test('renamed interpolation input works for all same-id marked node families', () => {
  const scenarios = [
    {
      name: 'Prompt',
      targetNode: makePromptNode('target', '{{foo}}'),
      newData: { promptText: '{{bar}}' },
    },
    {
      name: 'Code',
      targetNode: makeCodeNewNode('target', 'return {{foo}};'),
      newData: { code: 'return {{bar}};' },
    },
    {
      name: 'Expression',
      targetNode: makeExpressionNode('target', '{{foo}}'),
      newData: { expression: '{{bar}}' },
    },
    {
      name: 'JS Filter',
      targetNode: makeJSFilterNode('target', 'return item > {{foo}};'),
      newData: { callbackBody: 'return item > {{bar}};' },
    },
    {
      name: 'JS Map',
      targetNode: makeJSMapNode('target', 'return item + {{foo}};'),
      newData: { callbackBody: 'return item + {{bar}};' },
    },
    {
      name: 'Extract Object Path',
      targetNode: makeExtractObjectPathNode('target', '$.items["{{foo}}"]'),
      newData: { path: '$.items["{{bar}}"]' },
    },
  ];

  for (const scenario of scenarios) {
    assert.doesNotThrow(
      () =>
        assertInterpolationRenamePreservesConnection({
          targetNode: scenario.targetNode,
          newData: scenario.newData,
        }),
      scenario.name,
    );
  }
});

test('renamed interpolation input works for plugin nodes that use the interpolation helper', () => {
  assertInterpolationRenamePreservesConnection({
    targetNode: makePluginInterpolationNode('target', '{{foo}}'),
    newData: { template: '{{bar}}' },
    projectNodeRegistry: pluginRegistry,
  });
});

test('renamed interpolation input works for prefixed token ports', () => {
  const targetNode = makeToolNode('target', '{"type":"object","properties":{"foo":{"default":"{{foo}}"}}}');
  const sourceNode = makeTextNode('source', 'source');
  const connection = makeConnection({
    inputNodeId: targetNode.id,
    inputId: 'input-foo' as PortId,
    outputNodeId: sourceNode.id,
  });

  const result = reconcileNodeEditConnections({
    nodeId: targetNode.id,
    newNode: {
      data: {
        ...(targetNode.data as Record<string, unknown>),
        schema: '{"type":"object","properties":{"bar":{"default":"{{bar}}"}}}',
      },
    },
    nodes: [sourceNode, targetNode],
    liveConnections: [connection],
    recoverableConnections: [],
    project,
    referencedProjects: {},
    projectNodeRegistry: registry,
  });

  assert.deepEqual(result.nextConnections, [
    {
      ...connection,
      inputId: 'input-bar' as PortId,
    },
  ]);
  assert.deepEqual(result.nextRecoverableConnections, []);
});

test('interpolation input rename does not rewrite when the old port still exists', () => {
  const targetNode = makeTextNode('target', '{{foo}}');
  const sourceNode = makeTextNode('source', 'source');
  const connection = makeConnection({
    inputNodeId: targetNode.id,
    inputId: 'foo' as PortId,
    outputNodeId: sourceNode.id,
  });

  const result = reconcileNodeEditConnections({
    nodeId: targetNode.id,
    newNode: {
      data: {
        ...(targetNode.data as Record<string, unknown>),
        text: '{{foo}} {{bar}}',
      },
    },
    nodes: [sourceNode, targetNode],
    liveConnections: [connection],
    recoverableConnections: [],
    project,
    referencedProjects: {},
    projectNodeRegistry: registry,
  });

  assert.deepEqual(result.nextConnections, [connection]);
  assert.deepEqual(result.nextRecoverableConnections, []);
});

test('interpolation input rename does not rewrite ambiguous multiple-port changes', () => {
  const targetNode = makeTextNode('target', '{{foo}} {{bar}}');
  const sourceNode = makeTextNode('source', 'source');
  const connection = makeConnection({
    inputNodeId: targetNode.id,
    inputId: 'foo' as PortId,
    outputNodeId: sourceNode.id,
  });

  const result = reconcileNodeEditConnections({
    nodeId: targetNode.id,
    newNode: {
      data: {
        ...(targetNode.data as Record<string, unknown>),
        text: '{{baz}}',
      },
    },
    nodes: [sourceNode, targetNode],
    liveConnections: [connection],
    recoverableConnections: [],
    project,
    referencedProjects: {},
    projectNodeRegistry: registry,
  });

  assert.deepEqual(result.nextConnections, []);
  assert.deepEqual(result.nextRecoverableConnections, [connection]);
});

test('interpolation input rename does not steal an occupied new input slot', () => {
  const targetNode = makeTextNode('target', '{{foo}}');
  const oldSourceNode = makeTextNode('old-source', 'old source');
  const newSourceNode = makeTextNode('new-source', 'new source');
  const oldConnection = makeConnection({
    outputNodeId: oldSourceNode.id,
    inputNodeId: targetNode.id,
    inputId: 'foo' as PortId,
  });
  const newConnection = makeConnection({
    outputNodeId: newSourceNode.id,
    inputNodeId: targetNode.id,
    inputId: 'bar' as PortId,
  });

  const result = reconcileNodeEditConnections({
    nodeId: targetNode.id,
    newNode: {
      data: {
        ...(targetNode.data as Record<string, unknown>),
        text: '{{bar}}',
      },
    },
    nodes: [oldSourceNode, newSourceNode, targetNode],
    liveConnections: [oldConnection, newConnection],
    recoverableConnections: [],
    project,
    referencedProjects: {},
    projectNodeRegistry: registry,
  });

  assert.deepEqual(result.nextConnections, [newConnection]);
  assert.deepEqual(result.nextRecoverableConnections, [oldConnection]);
});

test('interpolation input rename moves only the first duplicate old-name connection', () => {
  const targetNode = makeTextNode('target', '{{foo}}');
  const firstSourceNode = makeTextNode('first-source', 'first source');
  const secondSourceNode = makeTextNode('second-source', 'second source');
  const firstConnection = makeConnection({
    outputNodeId: firstSourceNode.id,
    inputNodeId: targetNode.id,
    inputId: 'foo' as PortId,
  });
  const secondConnection = makeConnection({
    outputNodeId: secondSourceNode.id,
    inputNodeId: targetNode.id,
    inputId: 'foo' as PortId,
  });

  const result = reconcileNodeEditConnections({
    nodeId: targetNode.id,
    newNode: {
      data: {
        ...(targetNode.data as Record<string, unknown>),
        text: '{{bar}}',
      },
    },
    nodes: [firstSourceNode, secondSourceNode, targetNode],
    liveConnections: [firstConnection, secondConnection],
    recoverableConnections: [],
    project,
    referencedProjects: {},
    projectNodeRegistry: registry,
  });

  assert.deepEqual(result.nextConnections, [
    {
      ...firstConnection,
      inputId: 'bar' as PortId,
    },
  ]);
  assert.deepEqual(result.nextRecoverableConnections, [secondConnection]);
});

test('removed dynamic inputs become recoverable and exact same ids restore later', () => {
  const targetNode = makeTextNode('target', '{{foo}}');
  const sourceNode = makeTextNode('source', 'source');
  const connection = makeConnection({
    inputNodeId: targetNode.id,
    inputId: 'foo' as PortId,
    outputNodeId: sourceNode.id,
  });

  const removedResult = reconcileNodeEditConnections({
    nodeId: targetNode.id,
    newNode: {
      data: {
        ...(targetNode.data as Record<string, unknown>),
        text: '',
      },
    },
    nodes: [sourceNode, targetNode],
    liveConnections: [connection],
    recoverableConnections: [],
    project,
    referencedProjects: {},
    projectNodeRegistry: registry,
  });

  assert.deepEqual(removedResult.nextConnections, []);
  assert.deepEqual(removedResult.nextRecoverableConnections, [connection]);

  const restoredTargetNode = makeTextNode('target', '');
  const restoredResult = reconcileNodeEditConnections({
    nodeId: restoredTargetNode.id,
    newNode: {
      data: {
        ...(restoredTargetNode.data as Record<string, unknown>),
        text: '{{foo}}',
      },
    },
    nodes: [sourceNode, restoredTargetNode],
    liveConnections: [],
    recoverableConnections: removedResult.nextRecoverableConnections,
    project,
    referencedProjects: {},
    projectNodeRegistry: registry,
  });

  assert.deepEqual(restoredResult.nextConnections, [connection]);
  assert.deepEqual(restoredResult.nextRecoverableConnections, []);
});

test('different dynamic input ids do not restore previous connections', () => {
  const targetNode = makeTextNode('target', '');
  const sourceNode = makeTextNode('source', 'source');
  const connection = makeConnection({
    inputNodeId: targetNode.id,
    inputId: 'foo' as PortId,
    outputNodeId: sourceNode.id,
  });

  const result = reconcileNodeEditConnections({
    nodeId: targetNode.id,
    newNode: {
      data: {
        ...(targetNode.data as Record<string, unknown>),
        text: '{{bar}}',
      },
    },
    nodes: [sourceNode, targetNode],
    liveConnections: [],
    recoverableConnections: [connection],
    project,
    referencedProjects: {},
    projectNodeRegistry: registry,
  });

  assert.deepEqual(result.nextConnections, []);
  assert.deepEqual(result.nextRecoverableConnections, [connection]);
});

test('manual retyping restores only the matching pooled connections', () => {
  const targetNode = makeTextNode('target', '');
  const sourceNode = makeTextNode('source', 'source');
  const fooConnection = makeConnection({
    inputNodeId: targetNode.id,
    inputId: 'foo' as PortId,
    outputNodeId: sourceNode.id,
  });
  const barConnection = makeConnection({
    inputNodeId: targetNode.id,
    inputId: 'bar' as PortId,
    outputNodeId: sourceNode.id,
  });

  const result = reconcileNodeEditConnections({
    nodeId: targetNode.id,
    newNode: {
      data: {
        ...(targetNode.data as Record<string, unknown>),
        text: '{{foo}}',
      },
    },
    nodes: [sourceNode, targetNode],
    liveConnections: [],
    recoverableConnections: [fooConnection, barConnection],
    project,
    referencedProjects: {},
    projectNodeRegistry: registry,
  });

  assert.deepEqual(result.nextConnections, [fooConnection]);
  assert.deepEqual(result.nextRecoverableConnections, [barConnection]);
});

test('a live incoming connection on the same port supersedes an older recoverable one', () => {
  const targetNode = makeTextNode('target', '{{foo}}');
  const sourceNode = makeTextNode('source', 'source');
  const oldConnection = makeConnection({
    outputNodeId: 'old-source' as NodeId,
    inputNodeId: targetNode.id,
    inputId: 'foo' as PortId,
  });
  const liveConnection = makeConnection({
    outputNodeId: sourceNode.id,
    inputNodeId: targetNode.id,
    inputId: 'foo' as PortId,
  });

  const result = reconcileNodeEditConnections({
    nodeId: targetNode.id,
    newNode: {
      data: {
        ...(targetNode.data as Record<string, unknown>),
        text: '{{foo}}',
      },
    },
    nodes: [sourceNode, targetNode],
    liveConnections: [liveConnection],
    recoverableConnections: [oldConnection],
    project,
    referencedProjects: {},
    projectNodeRegistry: registry,
  });

  assert.deepEqual(result.nextConnections, [liveConnection]);
  assert.deepEqual(result.nextRecoverableConnections, []);
});

test('identical live connections clear stale recoverable duplicates', () => {
  const targetNode = makeTextNode('target', '{{foo}}');
  const sourceNode = makeTextNode('source', 'source');
  const connection = makeConnection({
    inputNodeId: targetNode.id,
    inputId: 'foo' as PortId,
    outputNodeId: sourceNode.id,
  });

  const result = reconcileNodeEditConnections({
    nodeId: targetNode.id,
    newNode: {
      data: {
        ...(targetNode.data as Record<string, unknown>),
        text: '{{foo}}',
      },
    },
    nodes: [sourceNode, targetNode],
    liveConnections: [connection],
    recoverableConnections: [connection],
    project,
    referencedProjects: {},
    projectNodeRegistry: registry,
  });

  assert.deepEqual(result.nextConnections, [connection]);
  assert.deepEqual(result.nextRecoverableConnections, []);
});

test('dynamic outputs restore their exact outgoing connections when the same id returns', () => {
  const codeNode = makeCodeNode('code-node', []);
  const downstreamNode = makeTextNode('downstream', '{{input}}');
  const connection = makeConnection({
    outputNodeId: codeNode.id,
    outputId: 'foo' as PortId,
    inputNodeId: downstreamNode.id,
    inputId: 'input' as PortId,
  });

  const result = reconcileNodeEditConnections({
    nodeId: codeNode.id,
    newNode: {
      data: {
        ...(codeNode.data as Record<string, unknown>),
        outputNames: ['foo'],
      },
    },
    nodes: [codeNode, downstreamNode],
    liveConnections: [],
    recoverableConnections: [connection],
    project,
    referencedProjects: {},
    projectNodeRegistry: registry,
  });

  assert.deepEqual(result.nextConnections, [connection]);
  assert.deepEqual(result.nextRecoverableConnections, []);
});

test('restoring an output-side recoverable connection does not steal an already-occupied downstream input', () => {
  const originalSourceNode = makeCodeNode('code-node', ['foo']);
  const replacementSourceNode = makeCodeNode('replacement-node', ['bar']);
  const downstreamNode = makeTextNode('downstream', '{{input}}');
  const recoverableConnection = makeConnection({
    outputNodeId: originalSourceNode.id,
    outputId: 'foo' as PortId,
    inputNodeId: downstreamNode.id,
    inputId: 'input' as PortId,
  });
  const liveConnection = makeConnection({
    outputNodeId: replacementSourceNode.id,
    outputId: 'bar' as PortId,
    inputNodeId: downstreamNode.id,
    inputId: 'input' as PortId,
  });

  const result = reconcileNodeEditConnections({
    nodeId: originalSourceNode.id,
    newNode: {
      data: {
        ...(originalSourceNode.data as Record<string, unknown>),
        outputNames: ['foo'],
      },
    },
    nodes: [originalSourceNode, replacementSourceNode, downstreamNode],
    liveConnections: [liveConnection],
    recoverableConnections: [recoverableConnection],
    project,
    referencedProjects: {},
    projectNodeRegistry: registry,
  });

  assert.deepEqual(result.nextConnections, [liveConnection]);
  assert.deepEqual(result.nextRecoverableConnections, []);
});

test('restoring an output-side recoverable connection does not revive a downstream port that no longer exists', () => {
  const sourceNode = makeCodeNode('code-node', ['foo']);
  const downstreamNode = makeTextNode('downstream', '');
  const recoverableConnection = makeConnection({
    outputNodeId: sourceNode.id,
    outputId: 'foo' as PortId,
    inputNodeId: downstreamNode.id,
    inputId: 'foo' as PortId,
  });

  const result = reconcileNodeEditConnections({
    nodeId: sourceNode.id,
    newNode: {
      data: {
        ...(sourceNode.data as Record<string, unknown>),
        outputNames: ['foo'],
      },
    },
    nodes: [sourceNode, downstreamNode],
    liveConnections: [],
    recoverableConnections: [recoverableConnection],
    project,
    referencedProjects: {},
    projectNodeRegistry: registry,
  });

  assert.deepEqual(result.nextConnections, []);
  assert.deepEqual(result.nextRecoverableConnections, [recoverableConnection]);
});

test('restoring an output-side recoverable connection still works for dynamic downstream inputs', () => {
  const sourceNode = makeCodeNode('code-node', ['foo']);
  const downstreamNode = makeArrayNode('array-node');
  const recoverableConnection = makeConnection({
    outputNodeId: sourceNode.id,
    outputId: 'foo' as PortId,
    inputNodeId: downstreamNode.id,
    inputId: 'input3' as PortId,
  });

  const result = reconcileNodeEditConnections({
    nodeId: sourceNode.id,
    newNode: {
      data: {
        ...(sourceNode.data as Record<string, unknown>),
        outputNames: ['foo'],
      },
    },
    nodes: [sourceNode, downstreamNode],
    liveConnections: [],
    recoverableConnections: [recoverableConnection],
    project,
    referencedProjects: {},
    projectNodeRegistry: registry,
  });

  assert.deepEqual(result.nextConnections, [recoverableConnection]);
  assert.deepEqual(result.nextRecoverableConnections, []);
});

test('Regex Match Per output wires become recoverable in Shared mode and restore when switched back', () => {
  const sourceNode = makeTextNode('source', 'case value');
  const matchNode = registry.createDynamic('match');
  matchNode.id = 'match' as NodeId;
  matchNode.data = {
    ...(matchNode.data as Record<string, unknown>),
    cases: ['YES'],
    casePortIds: ['case-yes'],
    valueInputMode: 'per-output',
  };
  const connection = makeConnection({
    outputNodeId: sourceNode.id,
    inputNodeId: matchNode.id,
    inputId: 'value-case-yes' as PortId,
  });

  const sharedResult = reconcileNodeEditConnections({
    nodeId: matchNode.id,
    newNode: {
      data: {
        ...(matchNode.data as Record<string, unknown>),
        valueInputMode: 'shared',
      },
    },
    nodes: [sourceNode, matchNode],
    liveConnections: [connection],
    recoverableConnections: [],
    project,
    referencedProjects: {},
    projectNodeRegistry: registry,
  });

  assert.deepEqual(sharedResult.nextConnections, []);
  assert.deepEqual(sharedResult.nextRecoverableConnections, [connection]);

  const sharedMatchNode = {
    ...matchNode,
    data: {
      ...(matchNode.data as Record<string, unknown>),
      valueInputMode: 'shared',
    },
  };
  const perOutputResult = reconcileNodeEditConnections({
    nodeId: sharedMatchNode.id,
    newNode: {
      data: {
        ...(sharedMatchNode.data as Record<string, unknown>),
        valueInputMode: 'per-output',
      },
    },
    nodes: [sourceNode, sharedMatchNode],
    liveConnections: [],
    recoverableConnections: sharedResult.nextRecoverableConnections,
    project,
    referencedProjects: {},
    projectNodeRegistry: registry,
  });

  assert.deepEqual(perOutputResult.nextConnections, [connection]);
  assert.deepEqual(perOutputResult.nextRecoverableConnections, []);
});
