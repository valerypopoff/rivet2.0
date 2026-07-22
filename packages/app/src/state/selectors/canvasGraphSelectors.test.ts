import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createBuiltInRegistry,
  DelegateFunctionCallNodeImpl,
  LLMChatV2NodeImpl,
  type NodeConnection,
  type NodePrefabId,
  type ProjectId,
} from '@valerypopoff/rivet2-core';
import { createStore } from 'jotai/vanilla';
import { graphState } from '../atoms/graph';
import { draggingWireState } from '../graphBuilder';
import { canvasIoDefinitionsForNodeState, canvasPreviewConnectionsState } from './canvasGraphSelectors';
import { projectState } from '../savedGraphs';
import { definitionValidConnectionsState } from './ioDefinitions.js';

describe('canvasGraphSelectors', () => {
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
