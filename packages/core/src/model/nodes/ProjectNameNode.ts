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
import { newId } from '../../utils/index.js';
import { nodeDefinition } from '../NodeDefinition.js';
import { NodeImpl } from '../NodeImpl.js';

export type ProjectNameNode = ChartNode<'projectName', Record<string, never>>;

export class ProjectNameNodeImpl extends NodeImpl<ProjectNameNode> {
  static create(): ProjectNameNode {
    return {
      id: newId<NodeId>(),
      type: 'projectName',
      title: 'Project Name',
      visualData: { x: 0, y: 0, width: 250 },
      data: {},
    };
  }

  getInputDefinitions(): NodeInputDefinition[] {
    return [];
  }

  getOutputDefinitions(): NodeOutputDefinition[] {
    return [{ id: 'projectName' as PortId, title: 'Project Name', dataType: 'string' }];
  }

  getEditors(): EditorDefinition<ProjectNameNode>[] {
    return [];
  }

  static getUIData(): NodeUIData {
    return {
      contextMenuTitle: 'Project Name',
      infoBoxTitle: 'Project Name',
      infoBoxBody:
        "Returns the name of the project that owns the graph currently being executed. A graph called from a referenced project returns that referenced project's name.",
      group: ['Debug'],
    };
  }

  async process(_inputs: Inputs, context: InternalProcessContext): Promise<Outputs> {
    return {
      ['projectName' as PortId]: { type: 'string', value: context.project.metadata.title },
    };
  }
}

export const projectNameNode = nodeDefinition(ProjectNameNodeImpl, 'Project Name');
