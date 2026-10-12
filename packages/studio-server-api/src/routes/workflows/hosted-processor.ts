import {
  createProcessor,
  type Project,
  type DatasetProvider,
  type LooseDataValue,
  type NodeCreateProcessorOptions,
} from '@valerypopoff/rivet2-node';
import type { ManagedCodeRunnerTelemetry } from '../../runtime-libraries/managed-code-runner.js';
import {
  createHostedRuntimeOptions,
  type HostedRuntimeInput,
  type HostedRuntimeDependencies,
} from './hosted-runtime-policy.js';
import {
  createExecutionProjectReferenceLoader,
  createExecutionSubgraphProjectLoader,
  getLLMProfileHealthStore,
} from './storage-backend.js';
import { getWorkflowExecutionRecorderOptions } from './recordings-config.js';
import { enqueueSubgraphProjectRecording } from './subgraph-recordings.js';

/** Common server runtime policy. Request transport and durable scheduling are
 * callers; neither may invent alternate credentials, datasets or child loaders. */
export type HostedProcessorInput = {
  project: Project;
  datasetProvider: DatasetProvider;
  projectPath: string;
  inputs: Record<string, LooseDataValue>;
  context: Record<string, LooseDataValue>;
  abortSignal?: AbortSignal;
  recording: boolean;
  correlationId: string;
  remoteDebugger?: NodeCreateProcessorOptions['remoteDebugger'];
  telemetry?: ManagedCodeRunnerTelemetry | null;
  earlyOutputs?: boolean;
};
const servingRuntimeDependencies: HostedRuntimeDependencies = {
  createProjectReferenceLoader: createExecutionProjectReferenceLoader,
  createSubgraphProjectLoader: createExecutionSubgraphProjectLoader,
  getProfileHealth: getLLMProfileHealthStore,
};
export function createServingRuntimeOptions(input: HostedRuntimeInput & { recording: boolean }) {
  return createHostedRuntimeOptions(
    {
      ...input,
      childRecording: input.recording
        ? {
            onSubgraphProjectRun: enqueueSubgraphProjectRecording,
            subgraphRecordingOptions: getWorkflowExecutionRecorderOptions(),
          }
        : undefined,
    },
    servingRuntimeDependencies,
  );
}
export async function createHostedProcessor(input: HostedProcessorInput) {
  const runtime = await createServingRuntimeOptions(input);
  return createProcessor(input.project, {
    ...runtime,
    returnWhenGraphOutputsReady: input.earlyOutputs ?? false,
    context: input.context,
    inputs: input.inputs,
  });
}
