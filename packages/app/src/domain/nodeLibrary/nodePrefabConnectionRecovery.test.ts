import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  ChartNode,
  GraphId,
  NodeId,
  NodeConnection,
  NodeInputDefinition,
  NodeOutputDefinition,
  NodePrefabId,
  NodeRegistration,
  PortId,
  Project,
  ProjectId,
} from '@valerypopoff/rivet2-core';
import { reconcileNodePrefabInstanceConnectionsInGraph } from './nodePrefabConnectionRecovery.js';

const projectId = 'project' as ProjectId;
const graphId = 'graph' as GraphId;
const prefabId = 'prefab' as NodePrefabId;
const upstreamNodeId = 'upstream' as NodeId;
const instanceNodeId = 'instance' as NodeId;
const outputPort = 'output' as PortId;
const optionalInputPort = 'apiKey' as PortId;
const responsePort = 'response' as PortId;

function node(id: string, type: string, data: unknown = {}): ChartNode {
  return {
    id: id as NodeId,
    type,
    title: id,
    visualData: { x: 0, y: 0 },
    data,
  };
}

function input(id: PortId, title: string): NodeInputDefinition {
  return {
    id,
    title,
    dataType: 'string',
  };
}

function output(id: PortId, title: string): NodeOutputDefinition {
  return {
    id,
    title,
    dataType: 'string',
  };
}

const fakeRegistry = {
  createDynamicImpl(chartNode: ChartNode) {
    return {
      getInputDefinitionsIncludingBuiltIn(): NodeInputDefinition[] {
        if (chartNode.type === 'prefabSource' && (chartNode.data as { exposeOptionalInput?: boolean }).exposeOptionalInput) {
          return [input(optionalInputPort, 'API key')];
        }

        return [];
      },
      getOutputDefinitions(): NodeOutputDefinition[] {
        if (chartNode.type === 'upstream') {
          return [output(outputPort, 'Output')];
        }

        if (chartNode.type === 'prefabSource') {
          return [output(responsePort, 'Response')];
        }

        return [];
      },
    };
  },
} as unknown as NodeRegistration<any, any>;

function projectWithPrefabSource(exposeOptionalInput: boolean): Project {
  return {
    metadata: {
      id: projectId,
      title: 'Project',
      description: '',
    },
    graphs: {},
    nodePrefabs: {
      [prefabId]: {
        id: prefabId,
        sourceNode: node('source', 'prefabSource', { exposeOptionalInput }),
      },
    },
    plugins: [],
  };
}

const sourceConnection: NodeConnection = {
  outputNodeId: upstreamNodeId,
  outputId: outputPort,
  inputNodeId: instanceNodeId,
  inputId: optionalInputPort,
};

function graphWithInstance(connections: NodeConnection[]) {
  return {
    metadata: { id: graphId, name: 'Graph', description: '' },
    nodes: [
      node(upstreamNodeId, 'upstream'),
      node(instanceNodeId, 'nodePrefabInstance', { prefabId }),
    ],
    connections,
  };
}

test('linked nodes move hidden-port wires into recoverable connections', () => {
  const result = reconcileNodePrefabInstanceConnectionsInGraph({
    graph: graphWithInstance([sourceConnection]),
    project: projectWithPrefabSource(false),
    projectNodeRegistry: fakeRegistry,
    recoverableConnections: {},
    referencedProjects: {},
  });

  assert.deepEqual(result.graph.connections, []);
  assert.deepEqual(result.recoverableConnections, {
    [instanceNodeId]: [sourceConnection],
  });
});

test('linked nodes restore recoverable wires when the source port returns', () => {
  const result = reconcileNodePrefabInstanceConnectionsInGraph({
    graph: graphWithInstance([]),
    project: projectWithPrefabSource(true),
    projectNodeRegistry: fakeRegistry,
    recoverableConnections: {
      [instanceNodeId]: [sourceConnection],
    },
    referencedProjects: {},
  });

  assert.deepEqual(result.graph.connections, [sourceConnection]);
  assert.deepEqual(result.recoverableConnections, {});
});
