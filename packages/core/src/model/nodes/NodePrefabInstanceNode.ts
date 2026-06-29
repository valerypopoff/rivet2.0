import { nanoid } from 'nanoid/non-secure';
import { type Inputs, type Outputs } from '../GraphProcessor.js';
import { type NodeId, type NodeInputDefinition, type NodeOutputDefinition } from '../NodeBase.js';
import { nodeDefinition } from '../NodeDefinition.js';
import { NodeImpl, type NodeUIData } from '../NodeImpl.js';
import {
  NODE_PREFAB_INSTANCE_TYPE,
  type NodePrefabInstanceNode,
  type NodePrefabInstanceNodeData,
} from '../NodePrefabResolver.js';

export type { NodePrefabInstanceNode, NodePrefabInstanceNodeData };

export class NodePrefabInstanceNodeImpl extends NodeImpl<NodePrefabInstanceNode> {
  static create(): NodePrefabInstanceNode {
    return {
      type: NODE_PREFAB_INSTANCE_TYPE,
      title: 'Linked node',
      id: nanoid() as NodeId,
      visualData: {
        x: 0,
        y: 0,
        width: 240,
      },
      data: {},
    };
  }

  getInputDefinitions(): NodeInputDefinition[] {
    return [];
  }

  getOutputDefinitions(): NodeOutputDefinition[] {
    return [];
  }

  async process(_inputData: Inputs): Promise<Outputs> {
    throw new Error('Library node is missing. Open the Node library and reconnect this linked node.');
  }

  static getUIData(): NodeUIData {
    return {
      contextMenuTitle: 'Linked node',
      infoBoxTitle: 'Linked node',
      infoBoxBody: 'Runs a node from the project Node library.',
      group: 'Advanced',
    };
  }
}

export const nodePrefabInstanceNode = nodeDefinition(NodePrefabInstanceNodeImpl, 'Linked node');
