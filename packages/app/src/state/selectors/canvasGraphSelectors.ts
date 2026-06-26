import { atom } from 'jotai';
import { atomFamily } from 'jotai/utils';
import {
  type ChartNode,
  type NodeConnection,
  type NodeId,
  type NodeImpl,
  type NodeInputDefinition,
  type NodeOutputDefinition,
} from '@valerypopoff/rivet2-core';
import { connectionsState } from '../atoms/graph.js';
import { draggingWireState } from '../graphBuilder.js';
import { getCanvasPreviewConnections } from '../../domain/graphEditing/wireDragActions.js';
import { handleError } from '../../utils/errorHandling.js';
import { nodesByIdState } from './graphSelectors.js';
import { projectState, referencedProjectsState } from '../savedGraphs.js';
import { nodeInstanceByIdState } from './nodeSelectors.js';
import { projectNodeRegistryState } from '../plugins.js';
import { nodePrefabSourceNodesByIdState } from './nodePrefabSelectors.js';

export const canvasPreviewConnectionsState = atom((get) => {
  const connections = get(connectionsState);
  const draggingWire = get(draggingWireState);

  return getCanvasPreviewConnections(connections, draggingWire);
});

export function getCanvasIoConnectionsForNode(options: {
  nodeId: NodeId;
  connections: NodeConnection[];
  previewConnections: NodeConnection[];
  draggingWire:
    | {
        originalConnection?: NodeConnection;
        rewireSourceInput?: {
          nodeId: NodeId;
        };
      }
    | undefined;
}): NodeConnection[] {
  const activeConnections =
    options.draggingWire?.originalConnection && options.draggingWire.rewireSourceInput?.nodeId === options.nodeId
      ? options.connections
      : options.previewConnections;

  return activeConnections.filter(
    (connection) => connection.inputNodeId === options.nodeId || connection.outputNodeId === options.nodeId,
  );
}

export const canvasConnectionsForNodeState = atom((get) =>
  get(canvasPreviewConnectionsState).reduce(
    (accumulator, connection) => {
      accumulator[connection.inputNodeId] ??= [];
      accumulator[connection.inputNodeId]!.push(connection);
      accumulator[connection.outputNodeId] ??= [];
      accumulator[connection.outputNodeId]!.push(connection);
      return accumulator;
    },
    {} as Record<NodeId, NodeConnection[]>,
  ),
);

export const canvasConnectionsForSingleNodeState = atomFamily((nodeId: NodeId) =>
  atom((get) =>
    getCanvasIoConnectionsForNode({
      nodeId,
      connections: get(connectionsState),
      previewConnections: get(canvasPreviewConnectionsState),
      draggingWire: get(draggingWireState),
    }),
  ),
);

export const canvasIoDefinitionsForNodeState = atomFamily((nodeId: NodeId | undefined) =>
  atom((get) => {
    if (!nodeId) {
      return { inputDefinitions: [], outputDefinitions: [] };
    }

    const project = get(projectState);
    const sourceNode = get(nodePrefabSourceNodesByIdState)[nodeId];
    const connections = sourceNode ? [] : (get(canvasConnectionsForSingleNodeState(nodeId)) ?? []);
    const nodesById = sourceNode ? { ...get(nodesByIdState), [nodeId]: sourceNode } : get(nodesByIdState);
    let instance: NodeImpl<ChartNode> | undefined;
    if (sourceNode) {
      try {
        instance = get(projectNodeRegistryState).createDynamicImpl(sourceNode);
      } catch (error) {
        handleError(error, 'Error creating library node implementation for canvas', {
          metadata: {
            nodeId,
            nodeType: sourceNode.type,
          },
          toastError: false,
        });
      }
    } else {
      instance = get(nodeInstanceByIdState(nodeId));
    }
    const referencedProjects = get(referencedProjectsState);

    let inputDefinitions: NodeInputDefinition[] | undefined;
    let outputDefinitions: NodeOutputDefinition[] | undefined;

    try {
      inputDefinitions = instance?.getInputDefinitionsIncludingBuiltIn(connections, nodesById, project, referencedProjects);
    } catch (error) {
      handleError(error, 'Error getting canvas node input definitions', {
        metadata: {
          connectionCount: connections.length,
          nodeId,
        },
        toastError: false,
      });
      inputDefinitions = [];
    }

    try {
      outputDefinitions = instance?.getOutputDefinitions(connections, nodesById, project, referencedProjects);
    } catch (error) {
      handleError(error, 'Error getting canvas node output definitions', {
        metadata: {
          connectionCount: connections.length,
          nodeId,
        },
        toastError: false,
      });
      outputDefinitions = [];
    }

    return inputDefinitions && outputDefinitions
      ? { inputDefinitions, outputDefinitions }
      : { inputDefinitions: [], outputDefinitions: [] };
  }),
);
