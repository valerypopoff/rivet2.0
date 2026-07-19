import { atom } from 'jotai';
import { atomFamily } from 'jotai/utils';
import {
  type ChartNode,
  type NodeId,
  type NodeImpl,
  type NodeInputDefinition,
  type NodeOutputDefinition,
} from '@valerypopoff/rivet2-core';
import { projectState, referencedProjectsState } from '../savedGraphs';
import { connectionsForSingleNodeState } from './graphSelectors';
import { effectiveNodesByIdState, nodeInstanceByIdState } from './nodeSelectors';
import { handleError } from '../../utils/errorHandling.js';
import { projectNodeRegistryState } from '../plugins.js';
import { nodePrefabSourceNodesByIdState } from './nodePrefabSelectors.js';
import { connectionsState } from '../atoms/graph.js';

export const ioDefinitionsForNodeState = atomFamily((nodeId: NodeId | undefined) =>
  atom((get) => {
    if (!nodeId) {
      return { inputDefinitions: [], outputDefinitions: [] };
    }

    const project = get(projectState);
    const sourceNode = get(nodePrefabSourceNodesByIdState)[nodeId];
    const connections = sourceNode ? [] : get(connectionsForSingleNodeState(nodeId)) ?? [];
    const nodesById = sourceNode
      ? { ...get(effectiveNodesByIdState), [nodeId]: sourceNode }
      : get(effectiveNodesByIdState);
    let instance: NodeImpl<ChartNode> | undefined;
    if (sourceNode) {
      try {
        instance = get(projectNodeRegistryState).createDynamicImpl(sourceNode);
      } catch (error) {
        handleError(error, 'Error creating library node implementation', {
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
      inputDefinitions = instance?.getInputDefinitionsIncludingBuiltIn(
        connections,
        nodesById,
        project,
        referencedProjects,
      );
    } catch (error) {
      handleError(error, 'Error getting node input definitions', {
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
      handleError(error, 'Error getting node output definitions', {
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

/**
 * The persisted graph can contain stale edges whose ports no longer exist.
 * Core preprocessing removes those edges before scheduling; graph-aware editor
 * features must use the same definition-valid view when connection order has
 * runtime meaning.
 */
export const definitionValidConnectionsState = atom((get) => {
  const connections = get(connectionsState);
  const nodesById = get(effectiveNodesByIdState);
  const portIdsByNodeId = new Map<
    NodeId,
    {
      inputIds: Set<NodeInputDefinition['id']>;
      outputIds: Set<NodeOutputDefinition['id']>;
    }
  >();

  const getPortIds = (nodeId: NodeId) => {
    const cached = portIdsByNodeId.get(nodeId);
    if (cached) {
      return cached;
    }

    const { inputDefinitions, outputDefinitions } = get(ioDefinitionsForNodeState(nodeId));
    const portIds = {
      inputIds: new Set(inputDefinitions.map((definition) => definition.id)),
      outputIds: new Set(outputDefinitions.map((definition) => definition.id)),
    };
    portIdsByNodeId.set(nodeId, portIds);
    return portIds;
  };

  const filteredConnections = connections.filter((connection) => {
    if (!nodesById[connection.outputNodeId] || !nodesById[connection.inputNodeId]) {
      return false;
    }

    const outputPortIds = getPortIds(connection.outputNodeId).outputIds;
    const inputPortIds = getPortIds(connection.inputNodeId).inputIds;

    return outputPortIds.has(connection.outputId) && inputPortIds.has(connection.inputId);
  });

  return filteredConnections.length === connections.length ? connections : filteredConnections;
});
