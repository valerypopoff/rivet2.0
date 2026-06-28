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

export const ioDefinitionsForNodeState = atomFamily((nodeId: NodeId | undefined) =>
  atom((get) => {
    if (!nodeId) {
      return { inputDefinitions: [], outputDefinitions: [] };
    }

    const project = get(projectState);
    const sourceNode = get(nodePrefabSourceNodesByIdState)[nodeId];
    const connections = sourceNode ? [] : (get(connectionsForSingleNodeState(nodeId)) ?? []);
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
      inputDefinitions = instance?.getInputDefinitionsIncludingBuiltIn(connections, nodesById, project, referencedProjects);
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
