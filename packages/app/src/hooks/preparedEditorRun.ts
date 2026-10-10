import type { GraphId, GraphInputNode, GraphOutputs, Project } from '@valerypopoff/rivet2-core';
import type { EditorGraphRunOptions } from './editorGraphRunOptions.js';
import type { EvaluationDataset, EvaluationSuite, PortableJson } from '@valerypopoff/rivet2-evaluations';
import { withDerivedProjectPluginSpecs } from '../utils/pluginUsage.js';
import {
  getDependentDataForNodeForPreload,
  getEditorRunFromPlan,
  getEditorRunToPlan,
} from './remoteExecutorHelpers.js';

type PluginContext = Parameters<typeof withDerivedProjectPluginSpecs>[1];

export function evaluationInputsToGraphOutputs(
  project: Project,
  graphId: GraphId,
  inputs: Record<string, PortableJson>,
): GraphOutputs {
  const graph = project.graphs[graphId];
  if (!graph) throw new Error(`Evaluation target graph "${graphId}" does not exist.`);
  const inputsById = new Map(
    graph.nodes
      .filter((node): node is GraphInputNode => node.type === 'graphInput')
      .map((node) => [node.data.id, node]),
  );
  return Object.fromEntries(
    Object.entries(inputs).map(([inputId, value]) => {
      const graphInput = inputsById.get(inputId);
      if (!graphInput) throw new Error(`Evaluation provided unknown graph input "${inputId}".`);
      return [inputId, { type: graphInput.data.dataType, value }];
    }),
  ) as GraphOutputs;
}

/** Evaluation targets the suite graph, never an unrelated active canvas. */
export function prepareEvaluationRun(input: {
  project: Project;
  suiteId: string;
  suites: EvaluationSuite[];
  datasets: EvaluationDataset[];
  plugins: Omit<PluginContext, 'currentGraph'>;
}) {
  const suite = input.suites.find((candidate) => candidate.id === input.suiteId);
  const dataset = input.datasets.find((candidate) => candidate.id === suite?.datasetId);
  if (!suite || !dataset) throw new Error('The selected evaluation suite or its dataset no longer exists.');
  const graph = input.project.graphs[suite.targetGraphId];
  if (!graph) throw new Error(`Evaluation target graph "${suite.targetGraphId}" no longer exists.`);
  if (!input.project.metadata.id) throw new Error('Cannot run an evaluation without a project id.');
  return {
    suite,
    dataset,
    project: withDerivedProjectPluginSpecs(input.project, { ...input.plugins, currentGraph: graph }),
  };
}

/** Capture authored values once. Runtime handles and callbacks are deliberately not cloned. */
export function captureEditorRun(input: {
  project: Project;
  currentGraph: Project['graphs'][GraphId];
  projectData: Project['data'];
  plugins: PluginContext;
  options: EditorGraphRunOptions;
}) {
  const project: Project = structuredClone(
    withDerivedProjectPluginSpecs(
      {
        ...input.project,
        graphs: { ...input.project.graphs, [input.currentGraph.metadata!.id!]: input.currentGraph },
        ...(input.projectData === undefined ? {} : { data: input.projectData }),
      },
      input.plugins,
    ),
  );
  const options: EditorGraphRunOptions = {
    ...input.options,
    inputs: input.options.inputs === undefined ? undefined : structuredClone(input.options.inputs),
    to: input.options.to?.slice(),
  };
  return {
    project,
    projectId: project.metadata.id,
    graphId: options.graphId ?? input.currentGraph.metadata!.id!,
    options,
  };
}

/** Shared editor policy; adapters select whether frozen outputs are supported. */
export function prepareEditorRunSelection(input: {
  project: Project;
  graphId: GraphId;
  options: EditorGraphRunOptions;
  registry: Parameters<typeof getEditorRunFromPlan>[3];
  previousRunData: Parameters<typeof getDependentDataForNodeForPreload>[1];
  frozen: Parameters<typeof getDependentDataForNodeForPreload>[2];
}) {
  const { project, graphId, options, registry, previousRunData, frozen } = input;
  if (options.from) {
    const plan = getEditorRunFromPlan(project, graphId, options.from, registry);
    return {
      runToNodeIds: plan.runToNodeIds,
      preloadData: getDependentDataForNodeForPreload(plan.preloadNodeIds, previousRunData, frozen),
      preserveNodeIds: plan.preserveNodeIds,
      suppressPreloadedNodeIds: plan.preloadNodeIds,
    };
  }
  if (options.to) {
    const plan = getEditorRunToPlan(project, graphId, options.to, registry, frozen);
    return { runToNodeIds: plan.runToNodeIds, preserveNodeIds: plan.preserveNodeIds };
  }
  return { runToNodeIds: undefined };
}
