import {
  type ChartNode,
  type NodeConnection,
  type NodeId,
  type NodeInputDefinition,
  type NodeOutputDefinition,
  type PortId,
} from '../NodeBase.js';
import { NodeImpl, type NodeBody, type NodeDefinitionContext, type NodeUIData } from '../NodeImpl.js';
import { nodeDefinition } from '../NodeDefinition.js';
import { type Inputs, type Outputs } from '../GraphProcessor.js';
import { type GraphId } from '../NodeGraph.js';
import { nanoid } from 'nanoid/non-secure';
import { type Project, type ProjectId } from '../Project.js';
import { type DataValue } from '../DataValue.js';
import { type InternalProcessContext } from '../ProcessContext.js';
import { dedent } from 'ts-dedent';
import { getError } from '../../utils/errors.js';
import type { RivetUIContext } from '../RivetUIContext.js';
import type { EditorDefinition } from '../EditorDefinition.js';
import {
  buildExcludedGraphBoundaryOutputs,
  buildGraphBoundaryInputData,
  getGraphBoundary,
  getGraphBoundaryInputDefinitions,
  getGraphBoundaryOutputDefinitions,
} from '../GraphBoundaryCache.js';

export type ReferencedGraphAliasNode = ChartNode & {
  type: 'referencedGraphAlias';
  data: {
    projectId: ProjectId;
    graphId: GraphId;
    useErrorOutput?: boolean;
    outputCostDuration?: boolean;

    /** Data for each of the inputs of the referenced graph */
    inputData?: Record<string, DataValue>;
  };
};

export class ReferencedGraphAliasNodeImpl extends NodeImpl<ReferencedGraphAliasNode> {
  static create(): ReferencedGraphAliasNode {
    const chartNode: ReferencedGraphAliasNode = {
      type: 'referencedGraphAlias',
      title: '', // Always set initially by the editor
      id: nanoid() as NodeId,
      visualData: {
        x: 0,
        y: 0,
        width: 300,
      },
      data: {
        projectId: undefined!, // Always set initially by the editor
        graphId: undefined!, // Always set initially by the editor
        useErrorOutput: false,
      },
    };

    return chartNode;
  }

  getInputDefinitions(
    _connections: NodeConnection[],
    _nodes: Record<NodeId, ChartNode>,
    _project: Project,
    referencedProjects: Record<ProjectId, Project>,
    definitionContext?: NodeDefinitionContext,
  ): NodeInputDefinition[] {
    const referencedProject = referencedProjects[this.data.projectId];
    if (!referencedProject) {
      return [];
    }

    const boundary = this.getBoundary(referencedProject, definitionContext);
    return boundary ? getGraphBoundaryInputDefinitions(boundary) : [];
  }

  getGraphOutputs(referencedProject: Project, definitionContext?: NodeDefinitionContext): NodeOutputDefinition[] {
    const boundary = this.getBoundary(referencedProject, definitionContext);
    return boundary ? getGraphBoundaryOutputDefinitions(boundary) : [];
  }

  getOutputDefinitions(
    _connections: NodeConnection[],
    _nodes: Record<NodeId, ChartNode>,
    _project: Project,
    referencedProjects: Record<ProjectId, Project>,
    definitionContext?: NodeDefinitionContext,
  ): NodeOutputDefinition[] {
    const outputs: NodeOutputDefinition[] = [];

    const referencedProject = referencedProjects[this.data.projectId];
    if (!referencedProject) {
      return outputs;
    }

    outputs.push(...this.getGraphOutputs(referencedProject, definitionContext));

    if (this.data.useErrorOutput) {
      outputs.push({
        id: 'error' as PortId,
        title: 'Error',
        dataType: 'string',
      });
    }

    return outputs;
  }

  private getBoundary(referencedProject: Project, definitionContext?: NodeDefinitionContext) {
    return (
      definitionContext?.getGraphBoundary(referencedProject, this.data.graphId) ??
      getGraphBoundary(referencedProject, this.data.graphId)
    );
  }

  getEditors(context: RivetUIContext): EditorDefinition<ReferencedGraphAliasNode>[] {
    const definitions: EditorDefinition<ReferencedGraphAliasNode>[] = [
      {
        type: 'toggle',
        label: 'Use Error Output',
        dataKey: 'useErrorOutput',
      },
      {
        type: 'toggle',
        label: 'Output Cost & Duration',
        dataKey: 'outputCostDuration',
      },
    ];

    const referencedProject = context.referencedProjects[this.data.projectId];
    if (referencedProject) {
      const boundary = getGraphBoundary(referencedProject, this.data.graphId);
      if (boundary) {
        for (const input of boundary.inputs) {
          definitions.push({
            type: 'dynamic',
            dataKey: 'inputData',
            dynamicDataKey: input.id,
            dataType: input.dataType,
            label: input.id,
            editor: input.editor ?? 'auto',
          });
        }
      }
    }

    return definitions;
  }

  getBody(context: RivetUIContext): NodeBody | Promise<NodeBody> {
    return context.referencedProjects[this.data.projectId]?.graphs[this.data.graphId]?.metadata?.description ?? '';
  }

  static getUIData(): NodeUIData {
    return {
      infoBoxBody: dedent`
        References a graph from another project. Inputs and outputs are defined by Graph Input and Graph Output nodes within the referenced graph.
      `,
      infoBoxTitle: 'Referenced Graph Alias Node',
      contextMenuTitle: 'Referenced Graph Alias',
      group: ['Advanced'],
    };
  }

  async process(inputs: Inputs, context: InternalProcessContext): Promise<Outputs> {
    const referencedProject = context.referencedProjects[this.data.projectId];
    if (!referencedProject) {
      throw new Error(
        `ReferencedGraphAliasNode requires a project with id ${this.data.projectId} to be available in the context.referencedProjects.`,
      );
    }

    const graph = referencedProject.graphs[this.data.graphId];
    if (!graph) {
      throw new Error(
        `ReferencedGraphAliasNode requires a graph with id ${this.data.graphId} to be present in the referenced project.`,
      );
    }

    const boundary =
      context.getGraphBoundary?.(referencedProject, this.data.graphId) ??
      getGraphBoundary(referencedProject, this.data.graphId)!;
    const inputData = buildGraphBoundaryInputData(boundary, inputs, this.data.inputData);

    // Create a subprocessor using the referenced project's graph
    const subGraphProcessor = context.createSubProcessor(this.data.graphId, {
      signal: context.signal,
      project: referencedProject!,
    });

    try {
      const startTime = Date.now();

      const outputs = await subGraphProcessor.processGraph(
        context,
        inputData as Record<string, DataValue>,
        context.contextValues,
      );

      const duration = Date.now() - startTime;

      if (this.data.useErrorOutput) {
        outputs['error' as PortId] = {
          type: 'control-flow-excluded',
          value: undefined,
        };
      }

      if (outputs['duration' as PortId] == null) {
        outputs['duration' as PortId] = {
          type: 'number',
          value: duration,
        };
      }

      return applyMetricOutputSetting(outputs, this.data.outputCostDuration);
    } catch (err) {
      if (!this.data.useErrorOutput) {
        throw err;
      }

      const outputs: Outputs = buildExcludedGraphBoundaryOutputs(boundary);

      outputs['error' as PortId] = {
        type: 'string',
        value: getError(err).message,
      };

      return outputs;
    }
  }
}

export const referencedGraphAliasNode = nodeDefinition(ReferencedGraphAliasNodeImpl, 'Referenced Graph Alias');

function applyMetricOutputSetting(outputs: Outputs, outputCostDuration: boolean | undefined): Outputs {
  if (outputCostDuration) {
    return outputs;
  }

  delete outputs['cost' as PortId];
  delete outputs['duration' as PortId];

  return outputs;
}
