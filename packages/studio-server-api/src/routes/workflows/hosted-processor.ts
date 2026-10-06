import { createProcessor, type Project, type DatasetProvider, type LooseDataValue } from '@valerypopoff/rivet2-node';
import { readExecutionEnvironmentVariables } from '../../environment-variable-settings.js';
import { ManagedCodeRunner, type ManagedCodeRunnerTelemetry } from '../../runtime-libraries/managed-code-runner.js';
import { getRootPath } from '../../runtime-libraries/manifest.js';
import { createLocalCatalogNativeApi } from '../../local-metadata/execution-io.js';
import {
  createExecutionProjectReferenceLoader,
  createExecutionSubgraphProjectLoader,
  getLLMProfileHealthStore,
} from './storage-backend.js';
import { getWorkflowExecutionRecorderOptions } from './recordings-config.js';
import { enqueueSubgraphProjectRecording } from './subgraph-recordings.js';

/** Common server runtime policy. Request transport and durable scheduling are
 * callers; neither may invent alternate credentials, datasets or child loaders. */
export async function createHostedProcessor(input: {
  project: Project;
  datasetProvider: DatasetProvider;
  projectPath: string;
  inputs: Record<string, LooseDataValue>;
  context: Record<string, LooseDataValue>;
  abortSignal?: AbortSignal;
  recording: boolean;
  correlationId: string;
  remoteDebugger?: any;
  telemetry?: ManagedCodeRunnerTelemetry | null;
  earlyOutputs?: boolean;
}) {
  input.abortSignal?.throwIfAborted();
  const executionEnvironment = await readExecutionEnvironmentVariables();
  input.abortSignal?.throwIfAborted();
  const projectReferenceLoader = await createExecutionProjectReferenceLoader(input.projectPath);
  input.abortSignal?.throwIfAborted();
  const llmProfileHealthStore = await getLLMProfileHealthStore();
  input.abortSignal?.throwIfAborted();
  return createProcessor(input.project, {
    returnWhenGraphOutputsReady: input.earlyOutputs ?? false,
    abortSignal: input.abortSignal,
    codeRunner: new ManagedCodeRunner(getRootPath(), {
      ...(input.telemetry ? { telemetry: input.telemetry } : {}),
      executionEnvironment,
    }) as any,
    projectPath: input.projectPath,
    nativeApi: createLocalCatalogNativeApi(),
    datasetProvider: input.datasetProvider,
    projectReferenceLoader,
    subgraphProjectLoader: createExecutionSubgraphProjectLoader(),
    ...(input.recording
      ? {
          onSubgraphProjectRun: enqueueSubgraphProjectRecording,
          subgraphRecordingOptions: getWorkflowExecutionRecorderOptions(),
        }
      : {}),
    llmProfileHealthStore,
    llmProfileHealthExecutionCorrelationId: input.correlationId,
    executionEnvironment,
    remoteDebugger: input.remoteDebugger,
    context: input.context,
    inputs: input.inputs,
  });
}
