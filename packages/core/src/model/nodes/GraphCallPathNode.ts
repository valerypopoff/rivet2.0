import type {
  ChartNode,
  EditorDefinition,
  Inputs,
  InternalProcessContext,
  NodeId,
  NodeInputDefinition,
  NodeOutputDefinition,
  NodeUIData,
  Outputs,
  PortId,
} from '../../index.js';
import { NodeImpl } from '../NodeImpl.js';
import { nodeDefinition } from '../NodeDefinition.js';
import { newId } from '../../utils/index.js';

export type GraphCallPathNode = ChartNode<'graphCallPath', Record<string, never>>;

export class GraphCallPathNodeImpl extends NodeImpl<GraphCallPathNode> {
  static create(): GraphCallPathNode {
    return {
      id: newId<NodeId>(),
      type: 'graphCallPath',
      title: 'Graph Call Path',
      visualData: { x: 0, y: 0, width: 250 },
      data: {},
    };
  }

  getInputDefinitions(): NodeInputDefinition[] {
    return [];
  }

  getOutputDefinitions(): NodeOutputDefinition[] {
    return [
      { id: 'currentGraphName' as PortId, title: 'Current Graph Name', dataType: 'string' },
      { id: 'graphPath' as PortId, title: 'Graph Path', dataType: 'string[]' },
    ];
  }

  getEditors(): EditorDefinition<GraphCallPathNode>[] {
    return [];
  }

  static getUIData(): NodeUIData {
    return {
      contextMenuTitle: 'Graph Call Path',
      infoBoxTitle: 'Graph Call Path',
      infoBoxBody:
        'Returns the current graph name and the names of graph calls from the entry graph to this graph. Internal async and streaming branches do not add a graph hop.',
      group: ['Debug'],
    };
  }

  async process(_inputs: Inputs, context: InternalProcessContext): Promise<Outputs> {
    const graphPath = [...context.graphCallPath];
    return {
      ['currentGraphName' as PortId]: { type: 'string', value: graphPath.at(-1) ?? '(Unnamed Graph)' },
      ['graphPath' as PortId]: { type: 'string[]', value: graphPath },
    };
  }
}

export const graphCallPathNode = nodeDefinition(GraphCallPathNodeImpl, 'Graph Call Path');
