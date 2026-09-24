import {
  type ChartNode,
  type NodeConnection,
  type NodeId,
  type NodeInputDefinition,
  type NodeOutputDefinition,
  type PortId,
} from '../NodeBase.js';
import { NodeImpl, type NodeDefinitionContext, type NodeUIData } from '../NodeImpl.js';
import { nodeDefinition } from '../NodeDefinition.js';
import { type Inputs, type Outputs } from '../GraphProcessor.js';
import { type GraphId } from '../NodeGraph.js';
import { nanoid } from 'nanoid/non-secure';
import { type Project, type ProjectId } from '../Project.js';
import { type DataValue } from '../DataValue.js';
import { type InternalProcessContext } from '../ProcessContext.js';
import { type EditorDefinition } from '../../index.js';
import { dedent } from 'ts-dedent';
import { getError } from '../../utils/errors.js';
import { getSubgraphProjectKey, type SubgraphProjectVersion } from '../SubgraphProjectTarget.js';
import { ExecutionRecorder } from '../../recording/ExecutionRecorder.js';

import type { RivetUIContext } from '../RivetUIContext.js';
import {
  applyGraphBoundaryPortOrder,
  buildExcludedGraphBoundaryOutputs,
  buildGraphBoundaryInputData,
  getGraphBoundary,
  getGraphBoundaryInputDefinitions,
  getGraphBoundaryOutputDefinitions,
  type GraphBoundary,
} from '../GraphBoundaryCache.js';

export type SubGraphNode = ChartNode & {
  type: 'subGraph';
  data: {
    graphId: GraphId;
    /** Studio Server-only saved project target. Absent means the current project. */
    targetProjectId?: ProjectId;
    /** Retains the hosted picker mode before an external project is selected. */
    targetScope?: 'other-projects';
    targetVersion?: SubgraphProjectVersion;
    /** Last selected boundary keeps existing wires visible while a hosted preview reloads. */
    targetBoundary?: GraphBoundary;
    useErrorOutput?: boolean;
    useAsGraphPartialOutput?: boolean;
    /** Only execute child branches needed by actively connected output ports. */
    skipUnusedOutputs?: boolean;

    /** Data for each of the inputs of the subgraph */
    inputData?: Record<string, DataValue>;
    inputPortOrder?: string[];
    outputPortOrder?: string[];
  };
};

/** A saved cross-project boundary is the wire contract until the user explicitly selects a new target. */
export function getSubgraphTargetBoundaryChange(
  expected: GraphBoundary | undefined,
  actual: GraphBoundary,
): { side: 'input' | 'output'; id: string } | null {
  if (!expected) return null;
  for (const side of ['inputs', 'outputs'] as const) {
    for (const port of expected[side]) {
      const match = actual[side].find((candidate) =>
        port.nodeId ? candidate.nodeId === port.nodeId : candidate.portId === port.portId,
      );
      if (match?.dataType !== port.dataType) {
        return { side: side === 'inputs' ? 'input' : 'output', id: port.id };
      }
    }
    const callerIds = new Set<string>();
    for (const port of actual[side]) {
      const saved = expected[side].find((candidate) =>
        candidate.nodeId ? candidate.nodeId === port.nodeId : candidate.portId === port.portId,
      );
      const callerId = saved?.portId ?? port.portId;
      if (callerIds.has(callerId)) {
        return { side: side === 'inputs' ? 'input' : 'output', id: port.id };
      }
      callerIds.add(callerId);
    }
  }
  return null;
}

/** Keep the caller's saved wire IDs while adopting current target names and metadata. */
export function reconcileSubgraphTargetBoundary(
  expected: GraphBoundary | undefined,
  actual: GraphBoundary,
): GraphBoundary {
  if (!expected) return actual;
  return {
    inputs: actual.inputs.map((port) => {
      const saved = expected.inputs.find((candidate) =>
        candidate.nodeId ? candidate.nodeId === port.nodeId : candidate.portId === port.portId,
      );
      return saved && saved.dataType === port.dataType ? { ...port, portId: saved.portId } : port;
    }),
    outputs: actual.outputs.map((port) => {
      const saved = expected.outputs.find((candidate) =>
        candidate.nodeId ? candidate.nodeId === port.nodeId : candidate.portId === port.portId,
      );
      return saved && saved.dataType === port.dataType ? { ...port, portId: saved.portId } : port;
    }),
  };
}

export function getSubgraphTargetBoundaryIssue(
  expected: GraphBoundary | undefined,
  actual: GraphBoundary,
): string | null {
  const change = getSubgraphTargetBoundaryChange(expected, actual);
  return change
    ? `The selected project's graph changed its ${change.side} "${change.id}". Re-select the graph and review its connections.`
    : null;
}

export class SubGraphNodeImpl extends NodeImpl<SubGraphNode> {
  static create(): SubGraphNode {
    const chartNode: SubGraphNode = {
      type: 'subGraph',
      title: 'Subgraph',
      id: nanoid() as NodeId,
      visualData: {
        x: 0,
        y: 0,
        width: 300,
      },
      data: {
        graphId: '' as GraphId,
        useErrorOutput: false,
        useAsGraphPartialOutput: false,
        skipUnusedOutputs: false,
      },
    };

    return chartNode;
  }

  getInputDefinitions(
    _connections: NodeConnection[],
    _nodes: Record<NodeId, ChartNode>,
    project: Project,
    referencedProjects: Record<ProjectId, Project>,
    definitionContext?: NodeDefinitionContext,
  ): NodeInputDefinition[] {
    const boundary = this.getTargetBoundary(project, referencedProjects, definitionContext);
    return boundary ? getGraphBoundaryInputDefinitions(boundary, this.data.inputPortOrder) : [];
  }

  getGraphOutputs(project: Project, definitionContext?: NodeDefinitionContext): NodeOutputDefinition[] {
    const boundary = this.getBoundary(project, definitionContext);
    return boundary ? getGraphBoundaryOutputDefinitions(boundary, this.data.outputPortOrder) : [];
  }

  getOutputDefinitions(
    _connections: NodeConnection[],
    _nodes: Record<NodeId, ChartNode>,
    project: Project,
    referencedProjects: Record<ProjectId, Project>,
    definitionContext?: NodeDefinitionContext,
  ): NodeOutputDefinition[] {
    const outputs: NodeOutputDefinition[] = [];

    const boundary = this.getTargetBoundary(project, referencedProjects, definitionContext);
    if (boundary) outputs.push(...getGraphBoundaryOutputDefinitions(boundary, this.data.outputPortOrder));

    if (this.data.useErrorOutput) {
      outputs.push({
        id: 'error' as PortId,
        title: 'Error',
        dataType: 'string',
      });
    }

    return outputs;
  }

  private getBoundary(project: Project, definitionContext?: NodeDefinitionContext) {
    return (
      definitionContext?.getGraphBoundary(project, this.data.graphId) ?? getGraphBoundary(project, this.data.graphId)
    );
  }

  private getTargetProject(project: Project, referencedProjects: Record<ProjectId, Project>): Project | undefined {
    if (!this.data.targetProjectId) return project;
    return referencedProjects[
      getSubgraphProjectKey({
        projectId: this.data.targetProjectId,
        version: this.data.targetVersion ?? 'latest',
      })
    ];
  }

  private getTargetBoundary(
    project: Project,
    referencedProjects: Record<ProjectId, Project>,
    definitionContext?: NodeDefinitionContext,
  ): GraphBoundary | undefined {
    // Keep the authored port contract visible even after a referenced project
    // changes. Execution checks it against the resolved graph and fails with a
    // reviewable error; replacing it here would hide existing wires in the UI.
    if (this.data.targetProjectId && this.data.targetBoundary) {
      const target = this.getTargetProject(project, referencedProjects);
      const actual = target && this.getBoundary(target, definitionContext);
      return actual && !getSubgraphTargetBoundaryChange(this.data.targetBoundary, actual)
        ? reconcileSubgraphTargetBoundary(this.data.targetBoundary, actual)
        : this.data.targetBoundary;
    }
    const target = this.getTargetProject(project, referencedProjects);
    return (
      (target && this.getBoundary(target, definitionContext)) ??
      (this.data.targetProjectId ? this.data.targetBoundary : undefined)
    );
  }

  getEditors(context: RivetUIContext): EditorDefinition<SubGraphNode>[] {
    const definitions: EditorDefinition<SubGraphNode>[] = [
      {
        type: 'custom',
        label: 'Graph',
        customEditorId: 'SubgraphTarget',
      },
      {
        type: 'group',
        label: 'Outputs',
        editors: [
          {
            type: 'toggle',
            label: 'Use Error Output',
            dataKey: 'useErrorOutput',
          },
          {
            type: 'toggle',
            label: 'Skip unused outputs',
            dataKey: 'skipUnusedOutputs',
            helperMessage:
              'Only run branches needed by connected outputs. Skipped branches also skip their side effects and errors. ' +
              'Runs the full subgraph for Run to here, partial-output forwarding, or a connected Error output.',
          },
        ],
      },
    ];

    if (this.data.graphId) {
      const boundary = this.getTargetBoundary(context.project, context.referencedProjects);
      if (boundary) {
        for (const input of applyGraphBoundaryPortOrder(boundary.inputs, this.data.inputPortOrder)) {
          definitions.push({
            type: 'dynamic',
            dataKey: 'inputData',
            dynamicDataKey: input.portId,
            dataType: input.dataType,
            label: input.id,
            editor: input.editor ?? 'auto',
          });
        }
      }
    }

    return definitions;
  }

  static getUIData(): NodeUIData {
    return {
      infoBoxBody: dedent`
        Executes another graph. Inputs and outputs are defined by Graph Input and Graph Output nodes within the subgraph.
      `,
      infoBoxTitle: 'Subgraph Node',
      contextMenuTitle: 'Subgraph',
      group: ['Advanced'],
    };
  }

  async process(inputs: Inputs, context: InternalProcessContext): Promise<Outputs> {
    const { project } = context;

    if (!project) {
      throw new Error('SubGraphNode requires a project to be set in the context.');
    }

    const target = this.data.targetProjectId
      ? context.referencedProjects[
          getSubgraphProjectKey({
            projectId: this.data.targetProjectId,
            version: this.data.targetVersion ?? 'latest',
          })
        ]
      : project;
    if (!target) {
      throw new Error('The selected Studio Server project is unavailable. Refresh the target and try again.');
    }
    const graph = target.graphs[this.data.graphId];
    if (!graph) {
      throw new Error(`SubGraphNode requires a graph with id ${this.data.graphId} to be present in the project.`);
    }

    const boundary =
      context.getGraphBoundary?.(target, this.data.graphId) ?? getGraphBoundary(target, this.data.graphId)!;
    if (this.data.targetProjectId) {
      const boundaryIssue = getSubgraphTargetBoundaryIssue(this.data.targetBoundary, boundary);
      if (boundaryIssue) throw new Error(boundaryIssue);
    }
    const callerBoundary = this.data.targetProjectId
      ? reconcileSubgraphTargetBoundary(this.data.targetBoundary, boundary)
      : boundary;
    const callerInputData = buildGraphBoundaryInputData(callerBoundary, inputs, this.data.inputData);
    const inputData: Inputs = this.data.targetProjectId ? {} : callerInputData;
    if (this.data.targetProjectId) {
      for (const input of callerBoundary.inputs) {
        if (Object.hasOwn(callerInputData, input.portId))
          inputData[input.id as PortId] = callerInputData[input.portId]!;
      }
    }
    const graphInputStreams = this.data.targetProjectId
      ? Object.fromEntries(
          callerBoundary.inputs.flatMap((input) => {
            const stream = context.graphInputStreams?.[input.portId];
            return stream ? [[input.id, stream] as const] : [];
          }),
        )
      : context.graphInputStreams;

    const shouldRunWholeGraph =
      this.data.skipUnusedOutputs !== true ||
      context.isDirectRunTarget ||
      this.data.useAsGraphPartialOutput === true ||
      (this.data.useErrorOutput === true && context.activeOutputPortIds.has('error' as PortId));
    const requestedGraphOutputIds = shouldRunWholeGraph
      ? undefined
      : callerBoundary.outputs
          .filter((output) => context.activeOutputPortIds.has(output.portId))
          .map((output) => output.id);

    if (requestedGraphOutputIds?.length === 0) {
      return buildOptimizedSubgraphOutputs(callerBoundary, [], {}, 0, this.data.useErrorOutput);
    }

    const subGraphProcessor = context.createSubProcessor(this.data.graphId, {
      signal: context.signal,
      project: target,
    });
    const recordingTarget = this.data.targetProjectId && context.subgraphTarget;
    const childRecorder =
      recordingTarget && context.onSubgraphProjectRun
        ? new ExecutionRecorder(context.subgraphRecordingOptions)
        : undefined;
    const finishChildRecording = childRecorder?.record(subGraphProcessor);
    const startedAt = Date.now();
    let runError: string | undefined;

    try {
      const graphOutputs = await subGraphProcessor.processGraph(
        context.subgraphTarget
          ? {
              ...context,
              datasetProvider: context.subgraphTarget.datasetProvider ?? context.datasetProvider,
              projectPath: context.subgraphTarget.sourceProjectPath ?? context.projectPath,
            }
          : context,
        inputData as Record<string, DataValue>,
        context.contextValues,
        {
          ...(requestedGraphOutputIds ? { requestedGraphOutputIds } : {}),
          graphInputStreams,
          // A child Graph Output can relay a direct producer's partial value
          // under the public boundary port ID. An Error-output Subgraph may
          // later replace that same normal output with an exclusion, so it is
          // final-only even if a caller supplies this internal callback.
          // The parent owns all Watch scheduling.
          ...(context.onGraphOutputPartial && this.data.useErrorOutput !== true
            ? {
                onGraphOutputPartial: (partial: Outputs) =>
                  context.onGraphOutputPartial?.(
                    this.data.targetProjectId ? mapSubgraphTargetOutputs(callerBoundary, partial) : partial,
                  ),
              }
            : {}),
        },
      );
      const duration = Date.now() - startedAt;
      finishChildRecording?.({ type: 'done', results: graphOutputs });

      if (requestedGraphOutputIds) {
        return buildOptimizedSubgraphOutputs(
          callerBoundary,
          requestedGraphOutputIds,
          graphOutputs,
          duration,
          this.data.useErrorOutput,
        );
      }

      const outputs = this.data.targetProjectId ? mapSubgraphTargetOutputs(callerBoundary, graphOutputs) : graphOutputs;
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

      return outputs;
    } catch (err) {
      runError = getError(err).message;
      finishChildRecording?.({ type: 'error', error: getError(err) });
      if (!this.data.useErrorOutput) {
        throw err;
      }

      const outputs: Outputs = buildExcludedGraphBoundaryOutputs(callerBoundary);

      outputs['error' as PortId] = {
        type: 'string',
        value: getError(err).message,
      };

      return outputs;
    } finally {
      if (childRecorder && recordingTarget && this.data.targetProjectId) {
        try {
          // Hosted editor persistence uploads the replay over HTTP. Finish that
          // upload before reporting the caller run complete, so closing its tab
          // immediately after completion cannot discard the called-project run.
          await context.onSubgraphProjectRun?.({
            target: { projectId: this.data.targetProjectId, version: this.data.targetVersion ?? 'latest' },
            resolved: recordingTarget,
            graphId: this.data.graphId,
            recorder: childRecorder,
            status: runError ? 'failed' : 'succeeded',
            durationMs: Math.max(0, Date.now() - startedAt),
            ...(runError ? { errorMessage: runError } : {}),
            correlationId: context.llmProfileHealthExecutionCorrelationId,
          });
        } catch (error) {
          console.error('Failed to retain Subgraph project run:', error);
        }
      }
    }
  }
}

export const subGraphNode = nodeDefinition(SubGraphNodeImpl, 'Subgraph');

function mapSubgraphTargetOutputs(boundary: GraphBoundary, graphOutputs: Outputs): Outputs {
  const targetNames = new Set(boundary.outputs.map((output) => output.id));
  const outputs: Outputs = Object.fromEntries(
    Object.entries(graphOutputs).filter(([name]) => !targetNames.has(name)),
  ) as Outputs;
  for (const output of boundary.outputs) {
    if (Object.hasOwn(graphOutputs, output.id)) outputs[output.portId] = graphOutputs[output.id as PortId]!;
  }
  return outputs;
}

function buildOptimizedSubgraphOutputs(
  boundary: GraphBoundary,
  requestedOutputIds: readonly string[],
  graphOutputs: Outputs,
  duration: number,
  useErrorOutput: boolean | undefined,
): Outputs {
  const outputs: Outputs = buildExcludedGraphBoundaryOutputs(boundary);

  for (const outputId of requestedOutputIds) {
    const callerPortId = boundary.outputs.find((output) => output.id === outputId)?.portId ?? (outputId as PortId);
    if (Object.hasOwn(graphOutputs, outputId)) {
      outputs[callerPortId] = graphOutputs[outputId as PortId];
    } else {
      // Missing requested values must remain missing: downstream optional inputs
      // may use defaults, whereas an excluded value would skip their node.
      delete outputs[callerPortId];
    }
  }

  if (useErrorOutput) {
    outputs['error' as PortId] = {
      type: 'control-flow-excluded',
      value: undefined,
    };
  }

  // Authored boundary values retain ownership of metric-named ports, including
  // exclusions. An unrequested Graph Output may still run as another output's
  // dependency, so do not copy arbitrary child results into the caller map.
  if (!boundary.outputs.some((output) => output.id === 'cost')) {
    outputs['cost' as PortId] = graphOutputs['cost' as PortId] ?? { type: 'number', value: 0 };
  }
  if (!boundary.outputs.some((output) => output.id === 'duration')) {
    outputs['duration' as PortId] = { type: 'number', value: duration };
  }

  return outputs;
}
