import { dedent } from 'ts-dedent';
import { nodeDefinition } from '../NodeDefinition.js';
import { type NodeUIData } from '../NodeImpl.js';
import { type ChartNode } from '../NodeBase.js';
import { CoalesceNodeBase, createCoalesceNode, type CoalesceNodeData } from './CoalesceNodeBase.js';

export type CoalesceNode = ChartNode<'coalesce', CoalesceNodeData>;

/** Display-only label; the persisted node type remains the stable `coalesce`. */
export const coalesceLegacyDisplayName = 'Coalesce (legacy)';

/** The persisted `coalesce` type remains available for existing graphs. */
export class CoalesceNodeImpl extends CoalesceNodeBase<CoalesceNode> {
  protected readonly includesLegacyConditionalInput = true;

  static create = (): CoalesceNode => createCoalesceNode('coalesce', coalesceLegacyDisplayName);

  static getUIData(): NodeUIData {
    return {
      infoBoxBody: dedent`
        Legacy Coalesce node. Takes in any number of inputs and outputs the first value that is not "Not Ran". Useful for consolidating branches after a Match node.

        Its Conditional input can exclude the node itself. New graphs should use Coalesce instead, which has the same fallback behavior without that port.
      `,
      infoBoxTitle: `${coalesceLegacyDisplayName} Node`,
      contextMenuTitle: coalesceLegacyDisplayName,
      group: ['Logic'],
    };
  }
}

export { type CoalesceNodeData } from './CoalesceNodeBase.js';

export const coalesceNode = nodeDefinition(CoalesceNodeImpl, coalesceLegacyDisplayName);
