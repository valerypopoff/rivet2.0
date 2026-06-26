import { atom } from 'jotai';
import { atomFamily } from 'jotai/utils';
import { type NodeId, resolveNodePrefabInstance } from '@valerypopoff/rivet2-core';
import { mapValues } from 'lodash-es';
import { projectNodeRegistryState } from '../plugins';
import { nodesByIdState } from './graphSelectors';
import { handleError } from '../../utils/errorHandling.js';
import { projectState } from '../savedGraphs.js';

export const nodeByIdState = atomFamily((nodeId: NodeId) => atom((get) => get(nodesByIdState)[nodeId]));

export const effectiveNodesByIdState = atom((get) => {
  const nodesById = get(nodesByIdState);
  const project = get(projectState);

  return mapValues(nodesById, (node) => resolveNodePrefabInstance(project, node));
});

export const effectiveNodeByIdState = atomFamily((nodeId: NodeId) =>
  atom((get) => get(effectiveNodesByIdState)[nodeId]),
);

export const nodeInstancesState = atom((get) => {
  const nodesById = get(effectiveNodesByIdState);
  const projectNodeRegistry = get(projectNodeRegistryState);

  return mapValues(nodesById, (node) => {
    try {
      return projectNodeRegistry.createDynamicImpl(node);
    } catch (error) {
      handleError(error, 'Error creating node implementation', {
        metadata: {
          nodeId: node.id,
          nodeType: node.type,
        },
        toastError: false,
      });
      return undefined;
    }
  });
});

export const nodeInstanceByIdState = atomFamily((nodeId: NodeId) =>
  atom((get) => get(nodeInstancesState)?.[nodeId]),
);

export const nodeConstructorsState = atom((get) => {
  return get(projectNodeRegistryState).getNodeConstructors();
});
