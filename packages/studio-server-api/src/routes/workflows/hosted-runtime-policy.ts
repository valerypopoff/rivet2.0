import type {
  NodeCreateProcessorOptions,
  DatasetProvider,
  ProjectReferenceLoader,
  SubgraphProjectLoader,
} from '@valerypopoff/rivet2-node';
import { ManagedCodeRunner, type ManagedCodeRunnerTelemetry } from '../../runtime-libraries/managed-code-runner.js';
import { getRootPath } from '../../runtime-libraries/manifest.js';
import { createLocalCatalogNativeApi } from '../../local-metadata/execution-io.js';
import { readExecutionEnvironmentVariables } from '../../environment-variable-settings.js';
import type { RivetStudioLLMProfileHealthStore } from '../../llm-profile-health/store.js';

export type HostedRuntimeDependencies = {
  createProjectReferenceLoader(projectPath: string): Promise<ProjectReferenceLoader>;
  createSubgraphProjectLoader?(): SubgraphProjectLoader;
  getProfileHealth(): Promise<RivetStudioLLMProfileHealthStore | undefined>;
  readEnvironment?: typeof readExecutionEnvironmentVariables;
};
export type HostedRuntimeInput = {
  projectPath: string;
  datasetProvider: DatasetProvider;
  abortSignal?: AbortSignal;
  telemetry?: ManagedCodeRunnerTelemetry | null;
  remoteDebugger?: NodeCreateProcessorOptions['remoteDebugger'];
  correlationId?: string;
  childRecording?: Pick<NodeCreateProcessorOptions, 'onSubgraphProjectRun' | 'subgraphRecordingOptions'>;
};

/** One runtime policy for endpoints, web apps, schedules and Evaluations.
 * No mutable processor/options/environment objects are reused between runs. */
export async function createHostedRuntimeOptions(
  input: HostedRuntimeInput,
  dependencies: HostedRuntimeDependencies,
): Promise<NodeCreateProcessorOptions> {
  const signal = input.abortSignal;
  signal?.throwIfAborted();
  const executionEnvironment = { ...(await (dependencies.readEnvironment ?? readExecutionEnvironmentVariables)()) };
  signal?.throwIfAborted();
  const projectReferenceLoader = await dependencies.createProjectReferenceLoader(input.projectPath);
  signal?.throwIfAborted();
  const llmProfileHealthStore = await dependencies.getProfileHealth();
  signal?.throwIfAborted();
  return {
    abortSignal: signal,
    codeRunner: new ManagedCodeRunner(getRootPath(), {
      executionEnvironment,
      ...(input.telemetry ? { telemetry: input.telemetry } : {}),
    }),
    executionEnvironment,
    projectPath: input.projectPath,
    datasetProvider: input.datasetProvider,
    nativeApi: createLocalCatalogNativeApi(),
    projectReferenceLoader,
    subgraphProjectLoader: dependencies.createSubgraphProjectLoader?.(),
    llmProfileHealthStore,
    llmProfileHealthExecutionCorrelationId: input.correlationId,
    remoteDebugger: input.remoteDebugger,
    ...input.childRecording,
  };
}
