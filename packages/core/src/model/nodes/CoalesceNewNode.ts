import { dedent } from 'ts-dedent';
import { nodeDefinition } from '../NodeDefinition.js';
import { type NodeUIData } from '../NodeImpl.js';
import { type ChartNode } from '../NodeBase.js';
import { CoalesceNodeBase, createCoalesceNode, type CoalesceNodeData } from './CoalesceNodeBase.js';

export type CoalesceNewNode = ChartNode<'coalesceNew', CoalesceNodeData>;

export class CoalesceNewNodeImpl extends CoalesceNodeBase<CoalesceNewNode> {
  protected readonly includesLegacyConditionalInput = false;

  static create = (): CoalesceNewNode => createCoalesceNode('coalesceNew', 'Coalesce');

  static getUIData(): NodeUIData {
    return {
      infoBoxBody: dedent`
        Takes in any number of inputs and outputs the first value that is not "Not Ran". Useful for consolidating branches after a Match node.

        Null and undefined input values are emitted by default, but the node can be configured to skip either value and continue checking later inputs.
      `,
      infoBoxTitle: 'Coalesce Node',
      contextMenuTitle: 'Coalesce',
      group: ['Logic'],
    };
  }
}

export const coalesceNewNode = nodeDefinition(CoalesceNewNodeImpl, 'Coalesce');
