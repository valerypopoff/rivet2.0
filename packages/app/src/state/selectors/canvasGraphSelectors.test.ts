import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createBuiltInRegistry,
  DelegateFunctionCallNodeImpl,
  LLMChatV2NodeImpl,
  getSubgraphProjectKey,
  GraphInputNodeImpl,
  GraphOutputNodeImpl,
  SubGraphNodeImpl,
  NodePrefabInstanceNodeImpl,
  GetStoredValueNodeImpl,
  type NodeConnection,
  type NodePrefabId,
  type ProjectId,
} from '@valerypopoff/rivet2-core';
import { createStore } from 'jotai/vanilla';
import { graphState } from '../atoms/graph';
import { draggingWireState } from '../graphBuilder';
import {
  canvasIoDefinitionsForNodeState,
  canvasPreviewConnectionsState,
  getCanvasLabelConnectionsForNode,
  createInputConnectionWarningsAtom,
  createInputConnectionWarningDetailsAtom,
} from './canvasGraphSelectors';
import { projectState, referencedProjectsState } from '../savedGraphs';
import { definitionValidConnectionsState, ioDefinitionsForNodeState } from './ioDefinitions.js';

describe('canvasGraphSelectors', () => {
  it('recomputes input warnings for live endpoint types without changing connections', () => {
    const store = createStore();
    const source = GraphInputNodeImpl.create();
    const destination = GraphOutputNodeImpl.create();
    source.data.dataType = 'number';
    destination.data.dataType = 'number';
    const connection = {
      outputNodeId: source.id,
      outputId: 'data',
      inputNodeId: destination.id,
      inputId: 'value',
    } as NodeConnection;
    const graph = {
      metadata: { id: 'type-warning-graph', name: 'Types' },
      nodes: [source, destination],
      connections: [connection],
    };
    store.set(graphState, graph as any);
    const warnings = createInputConnectionWarningsAtom(destination.id, graph.connections);
    const details = createInputConnectionWarningDetailsAtom(destination.id, connection.inputId, true);
    assert.equal(store.get(warnings).size, 0);
    assert.deepEqual(store.get(details), []);
    store.set(graphState, {
      ...graph,
      nodes: [source, { ...destination, data: { ...destination.data, dataType: 'string' } }],
    } as any);
    assert.deepEqual([...store.get(warnings)], ['value']);
    assert.deepEqual(store.get(details), [{ status: 'coerced', sourceType: 'number', targetType: 'string' }]);
    assert.deepEqual(store.get(createInputConnectionWarningDetailsAtom(source.id, connection.outputId, false)), []);
    store.set(graphState, {
      ...graph,
      nodes: [
        { ...source, data: { ...source.data, dataType: 'string' } },
        { ...destination, data: { ...destination.data, dataType: 'string' } },
      ],
    } as any);
    assert.equal(store.get(warnings).size, 0);
    assert.deepEqual(store.get(details), []);
    assert.equal(
      store.get(createInputConnectionWarningsAtom(destination.id, [])).size,
      0,
      'Decorative surfaces must not inherit live graph edges',
    );
    assert.deepEqual(store.get(graphState).connections, [connection]);
    store.set(graphState, { ...graph, connections: [] } as any);
    assert.deepEqual(store.get(details), []);
  });

  it('updates warnings when a target Subgraph boundary changes', () => {
    const store = createStore();
    const registry = createBuiltInRegistry();
    const source = registry.createDynamic('number');
    const caller = SubGraphNodeImpl.create();
    const childInput = GraphInputNodeImpl.create();
    caller.data.graphId = 'child' as any;
    childInput.data.id = 'argument';
    childInput.data.dataType = 'number';
    const child = { metadata: { id: 'child', name: 'Child' }, nodes: [childInput], connections: [] };
    const project = { metadata: { id: 'warning-project', title: 'Warnings', description: '' }, graphs: { child } };
    const connection = {
      outputNodeId: source.id,
      outputId: 'value',
      inputNodeId: caller.id,
      inputId: 'argument',
    } as NodeConnection;
    store.set(projectState, project as any);
    store.set(graphState, {
      metadata: { id: 'main', name: 'Main' },
      nodes: [source, caller],
      connections: [connection],
    } as any);
    const warnings = createInputConnectionWarningsAtom(caller.id, [connection]);
    assert.equal(store.get(warnings).size, 0);
    store.set(projectState, {
      ...project,
      graphs: { child: { ...child, nodes: [{ ...childInput, data: { ...childInput.data, dataType: 'string' } }] } },
    } as any);
    assert.deepEqual([...store.get(warnings)], ['argument']);
  });

  it('updates warnings as referenced-project definitions arrive or change, without removing wires', () => {
    const store = createStore();
    const registry = createBuiltInRegistry();
    const source = registry.createDynamic('number');
    const caller = SubGraphNodeImpl.create();
    const childInput = GraphInputNodeImpl.create();
    caller.data.graphId = 'child' as any;
    caller.data.targetProjectId = 'referenced' as ProjectId;
    childInput.data.id = 'argument';
    childInput.data.dataType = 'number';
    const child = { metadata: { id: 'child', name: 'Child' }, nodes: [childInput], connections: [] };
    const referenced = {
      metadata: { id: 'referenced', title: 'Referenced', description: '' },
      graphs: { child },
    };
    const connection = {
      outputNodeId: source.id,
      outputId: 'value',
      inputNodeId: caller.id,
      inputId: 'argument',
    } as NodeConnection;
    store.set(graphState, {
      metadata: { id: 'main', name: 'Main' },
      nodes: [source, caller],
      connections: [connection],
    } as any);
    const warnings = createInputConnectionWarningsAtom(caller.id, [connection]);
    assert.equal(store.get(warnings).size, 0, 'Unknown boundaries are not type mismatches');
    const key = getSubgraphProjectKey({ projectId: 'referenced' as ProjectId, version: 'latest' });
    store.set(referencedProjectsState, { [key]: referenced } as any);
    assert.equal(store.get(warnings).size, 0);
    store.set(referencedProjectsState, {
      [key]: {
        ...referenced,
        graphs: { child: { ...child, nodes: [{ ...childInput, data: { ...childInput.data, dataType: 'string' } }] } },
      },
    } as any);
    assert.deepEqual([...store.get(warnings)], ['argument']);
    store.set(referencedProjectsState, {});
    assert.equal(store.get(warnings).size, 0);
    assert.deepEqual(store.get(graphState).connections, [connection]);
  });

  it('handles self-connections and missing sources without recursive warning dependencies', () => {
    const store = createStore();
    const node = GraphOutputNodeImpl.create();
    node.isConditional = true;
    node.data.dataType = 'string';
    const connection = {
      outputNodeId: node.id,
      outputId: 'valueOutput',
      inputNodeId: node.id,
      inputId: '$if',
    } as NodeConnection;
    const graph = {
      metadata: { id: 'self-warning-graph', name: 'Self warning' },
      nodes: [node],
      connections: [connection],
    };
    store.set(graphState, graph as any);
    const warnings = createInputConnectionWarningsAtom(node.id, graph.connections);
    assert.deepEqual([...store.get(warnings)], ['$if']);
    store.set(graphState, { ...graph, nodes: [] } as any);
    assert.equal(store.get(warnings).size, 0);
    store.set(graphState, graph as any);
    assert.deepEqual([...store.get(warnings)], ['$if']);
    assert.deepEqual(store.get(graphState).connections, [connection]);
  });

  it('recomputes warnings when a linked source changes in the Node library', () => {
    const store = createStore();
    const source = GetStoredValueNodeImpl.create();
    source.data.dataType = 'number';
    const linked = NodePrefabInstanceNodeImpl.create();
    const prefabId = 'typed-source' as NodePrefabId;
    linked.data.prefabId = prefabId;
    const destination = GraphOutputNodeImpl.create();
    destination.data.dataType = 'string';
    const project = {
      metadata: { id: 'warning-project', title: 'Warnings', description: '' },
      graphs: {},
      nodePrefabs: { [prefabId]: { id: prefabId, sourceNode: source } },
    };
    const connection = {
      outputNodeId: linked.id,
      outputId: 'value',
      inputNodeId: destination.id,
      inputId: 'value',
    } as NodeConnection;
    store.set(projectState, project as any);
    store.set(graphState, {
      metadata: { id: 'linked-warning-graph', name: 'Linked warning' },
      nodes: [linked, destination],
      connections: [connection],
    } as any);
    const warnings = createInputConnectionWarningsAtom(destination.id, [connection]);
    assert.deepEqual([...store.get(warnings)], ['value']);
    store.set(projectState, {
      ...project,
      nodePrefabs: {
        [prefabId]: { id: prefabId, sourceNode: { ...source, data: { ...source.data, dataType: 'string' } } },
      },
    } as any);
    assert.equal(store.get(warnings).size, 0);
    assert.deepEqual(store.get(graphState).connections, [connection]);
  });

  it('keeps the source node dynamic ports stable during an input-origin rewire preview', () => {
    const store = createStore();
    const registry = createBuiltInRegistry();

    const sourceNode = registry.createDynamic('text');
    const targetNode = registry.createDynamic('array');

    const originalConnection: NodeConnection = {
      inputNodeId: targetNode.id,
      inputId: 'input3' as any,
      outputNodeId: sourceNode.id,
      outputId: 'output' as any,
    };

    store.set(graphState, {
      metadata: { id: 'graph-1', name: 'Test Graph' },
      nodes: [sourceNode, targetNode],
      connections: [originalConnection],
    } as any);

    store.set(draggingWireState, {
      startNodeId: sourceNode.id,
      startPortId: originalConnection.outputId,
      startPortIsInput: false,
      dataType: 'string',
      originalConnection,
      rewireSourceInput: {
        nodeId: targetNode.id,
        portId: originalConnection.inputId,
      },
    });

    assert.deepEqual(store.get(canvasPreviewConnectionsState), []);

    const io = store.get(canvasIoDefinitionsForNodeState(targetNode.id));

    assert.ok(io.inputDefinitions.some((definition) => definition.id === 'input3'));
    assert.ok(io.inputDefinitions.some((definition) => definition.id === 'input4'));
  });

  it('returns decorative I/O definitions for library nodes outside the live graph', () => {
    const store = createStore();
    const registry = createBuiltInRegistry();
    const sourceNode = registry.createDynamic('text');

    store.set(projectState, {
      metadata: {
        description: '',
        id: 'project-1' as ProjectId,
        title: 'Project',
      },
      graphs: {},
      nodePrefabs: {
        ['prefab-1' as NodePrefabId]: {
          id: 'prefab-1' as NodePrefabId,
          sourceNode,
        },
      },
    });

    const io = store.get(canvasIoDefinitionsForNodeState(sourceNode.id));

    assert.ok(io.outputDefinitions.some((definition) => definition.id === 'output'));
  });

  it('projects a connected output title onto both sides of a Passthrough slot', () => {
    const store = createStore();
    const registry = createBuiltInRegistry();
    const sourceNode = registry.createDynamic('number');
    const passthroughNode = registry.createDynamic('passthrough');
    const sourceConnection: NodeConnection = {
      inputNodeId: passthroughNode.id,
      inputId: 'input1' as any,
      outputNodeId: sourceNode.id,
      outputId: 'value' as any,
    };

    store.set(graphState, {
      metadata: { id: 'graph-1', name: 'Test Graph' },
      nodes: [sourceNode, passthroughNode],
      connections: [sourceConnection],
    } as any);

    const io = store.get(canvasIoDefinitionsForNodeState(passthroughNode.id));

    assert.equal(io.inputDefinitions.find(({ id }) => id === 'input1')?.title, 'Value');
    assert.equal(io.outputDefinitions.find(({ id }) => id === 'output1')?.title, 'Value');
    assert.equal(io.inputDefinitions.find(({ id }) => id === 'input2')?.title, 'Input 2');
  });

  it('projects Passthrough labels through the non-canvas I/O selector too', () => {
    const store = createStore();
    const registry = createBuiltInRegistry();
    const sourceNode = registry.createDynamic('number');
    const passthroughNode = registry.createDynamic('passthrough');
    const sourceConnection: NodeConnection = {
      inputNodeId: passthroughNode.id,
      inputId: 'input1' as any,
      outputNodeId: sourceNode.id,
      outputId: 'value' as any,
    };

    store.set(graphState, {
      metadata: { id: 'graph-1', name: 'Test Graph' },
      nodes: [sourceNode, passthroughNode],
      connections: [sourceConnection],
    } as any);

    const io = store.get(ioDefinitionsForNodeState(passthroughNode.id));
    assert.equal(io.inputDefinitions.find(({ id }) => id === 'input1')?.title, 'Value');
    assert.equal(io.outputDefinitions.find(({ id }) => id === 'output1')?.title, 'Value');
  });

  it('carries labels through a linked Passthrough instance on the canvas', () => {
    const store = createStore();
    const registry = createBuiltInRegistry();
    const sourceNode = registry.createDynamic('number');
    const libraryPassthrough = registry.createDynamic('passthrough');
    const finalPassthrough = registry.createDynamic('passthrough');
    const prefabId = 'passthrough-library' as NodePrefabId;
    const linkedPassthrough = {
      data: { prefabId },
      id: 'linked-passthrough',
      title: 'Linked Passthrough',
      type: 'nodePrefabInstance',
      visualData: { x: 350, y: 0, width: 220 },
    } as any;

    store.set(projectState, {
      metadata: { description: '', id: 'project-1' as ProjectId, title: 'Project' },
      graphs: {},
      nodePrefabs: {
        [prefabId]: { id: prefabId, sourceNode: libraryPassthrough },
      },
    } as any);
    store.set(graphState, {
      metadata: { id: 'graph-1', name: 'Test Graph' },
      nodes: [sourceNode, linkedPassthrough, finalPassthrough],
      connections: [
        {
          inputNodeId: linkedPassthrough.id,
          inputId: 'input1',
          outputNodeId: sourceNode.id,
          outputId: 'value',
        },
        {
          inputNodeId: finalPassthrough.id,
          inputId: 'input1',
          outputNodeId: linkedPassthrough.id,
          outputId: 'output1',
        },
      ],
    } as any);

    const io = store.get(canvasIoDefinitionsForNodeState(finalPassthrough.id));
    assert.equal(io.inputDefinitions.find(({ id }) => id === 'input1')?.title, 'Value');
    assert.equal(io.outputDefinitions.find(({ id }) => id === 'output1')?.title, 'Value');
  });

  it('keeps a Passthrough label while its input-origin connection is being rewired', () => {
    const store = createStore();
    const registry = createBuiltInRegistry();
    const sourceNode = registry.createDynamic('number');
    const passthroughNode = registry.createDynamic('passthrough');
    const originalConnection: NodeConnection = {
      inputNodeId: passthroughNode.id,
      inputId: 'input1' as any,
      outputNodeId: sourceNode.id,
      outputId: 'value' as any,
    };

    store.set(graphState, {
      metadata: { id: 'graph-1', name: 'Test Graph' },
      nodes: [sourceNode, passthroughNode],
      connections: [originalConnection],
    } as any);
    store.set(draggingWireState, {
      startNodeId: sourceNode.id,
      startPortId: originalConnection.outputId,
      startPortIsInput: false,
      dataType: 'number',
      originalConnection,
      rewireSourceInput: {
        nodeId: passthroughNode.id,
        portId: originalConnection.inputId,
      },
    });

    assert.deepEqual(store.get(canvasPreviewConnectionsState), []);
    assert.deepEqual(
      getCanvasLabelConnectionsForNode({
        draggingWire: store.get(draggingWireState),
        nodeId: passthroughNode.id,
        previewConnections: store.get(canvasPreviewConnectionsState),
      }),
      [originalConnection],
    );

    const io = store.get(canvasIoDefinitionsForNodeState(passthroughNode.id));
    assert.equal(io.inputDefinitions.find(({ id }) => id === 'input1')?.title, 'Value');
    assert.equal(io.outputDefinitions.find(({ id }) => id === 'output1')?.title, 'Value');
  });

  it('removes stale port edges before connection-order-sensitive editor analysis', () => {
    const store = createStore();
    const registry = createBuiltInRegistry();
    const staleSource = registry.createDynamic('text');
    const llmNode = LLMChatV2NodeImpl.create();
    const delegateNode = DelegateFunctionCallNodeImpl.create();
    llmNode.data.useToolCalling = true;
    llmNode.data.autoContinueToolCalls = true;

    const staleConnection: NodeConnection = {
      inputNodeId: delegateNode.id,
      inputId: 'function-call' as any,
      outputNodeId: staleSource.id,
      outputId: 'function-calls' as any,
    };
    const validConnection: NodeConnection = {
      inputNodeId: delegateNode.id,
      inputId: 'function-call' as any,
      outputNodeId: llmNode.id,
      outputId: 'function-calls' as any,
    };

    store.set(graphState, {
      metadata: { id: 'graph-1', name: 'Test Graph' },
      nodes: [staleSource, llmNode, delegateNode],
      connections: [staleConnection, validConnection],
    } as any);

    assert.deepEqual(store.get(definitionValidConnectionsState), [validConnection]);
  });
});
