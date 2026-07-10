import type { PascalCase } from 'type-fest';
import type { AttachedData } from '../utils/serialization/serializationUtils.js';
import type { AudioProvider } from '../integrations/AudioProvider.js';
import type { DataValue } from '../model/DataValue.js';
import type { DatasetProvider } from '../integrations/DatasetProvider.js';
import type {
  ExternalFunction,
  GraphProcessorConcurrency,
  GraphProcessorExecutionPlanCacheMode,
  GraphProcessorRuntimeCache,
  GraphProcessorRuntimeProfiler,
  GraphProcessorScheduler,
  ProcessEvents,
} from '../model/GraphProcessor.js';
import type { GraphId } from '../model/NodeGraph.js';
import type { Project } from '../model/Project.js';
import type { MCPProvider } from '../integrations/mcp/MCPProvider.js';
import type { NativeApi } from '../native/NativeApi.js';
import type { NodeRegistration } from '../model/NodeRegistration.js';
import type { ProcessContext } from '../model/ProcessContext.js';
import type { RivetEventStreamFilterSpec } from './streaming.js';
import type { Settings } from '../model/Settings.js';
import { globalRivetNodeRegistry } from '../model/Nodes.js';
import { getProcessorEvents, getProcessorSSEStream, getSingleNodeStream } from './streaming.js';
// eslint-disable-next-line import/no-cycle -- GraphProcessor depends on CodeRunner, which exposes the package export surface.
import { GraphProcessor } from '../model/GraphProcessor.js';
import { deserializeProject } from '../utils/serialization/serialization.js';
import { GptTokenizerTokenizer } from '../integrations/GptTokenizerTokenizer.js';
import type { Tokenizer } from '../integrations/Tokenizer.js';
import { looseDataValuesToDataValues, type LooseDataValue } from './looseDataValue.js';
import type { ProjectReferenceLoader } from '../model/ProjectReferenceLoader.js';
import { resolveProcessSettings } from './processSettings.js';

export type RunGraphOptions = {
  graph?: string;
  inputs?: Record<string, LooseDataValue>;
  context?: Record<string, LooseDataValue>;
  nativeApi?: NativeApi;
  datasetProvider?: DatasetProvider;
  audioProvider?: AudioProvider;
  mcpProvider?: MCPProvider;
  externalFunctions?: {
    [key: string]: ExternalFunction;
  };
  onUserEvent?: {
    [key: string]: (data: DataValue | undefined) => void;
  };
  abortSignal?: AbortSignal;
  captureNodeTimings?: boolean;
  registry?: NodeRegistration<any, any>;
  includeTrace?: boolean;
  concurrency?: GraphProcessorConcurrency;
  getChatNodeEndpoint?: ProcessContext['getChatNodeEndpoint'];
  tokenizer?: Tokenizer;
  codeRunner?: ProcessContext['codeRunner'];
  projectPath?: string;
  projectReferenceLoader?: ProjectReferenceLoader;
  editorExecutionCache?: ProcessContext['editorExecutionCache'];
} & {
  [P in keyof ProcessEvents as `on${PascalCase<P>}`]?: (params: ProcessEvents[P]) => void;
} & Settings &
  Record<string, unknown>;

export type CoreCreateProcessorInternalOptions = {
  cacheLoadedProjects?: boolean;
  executionPlanCacheMode?: GraphProcessorExecutionPlanCacheMode;
  runtimeCache?: GraphProcessorRuntimeCache;
  runtimeProfiler?: GraphProcessorRuntimeProfiler;
  scheduler?: GraphProcessorScheduler;
};

export function coreCreateProcessor(
  project: Project,
  options: RunGraphOptions,
  internalOptions: CoreCreateProcessorInternalOptions = {},
) {
  const { graph, inputs = {}, context = {} } = options;

  const graphId = graph
    ? graph in project.graphs
      ? graph
      : Object.values(project.graphs).find((g) => g.metadata?.name === graph)?.metadata?.id
    : project.metadata.mainGraphId;

  if (!graphId) {
    throw new Error(`Graph not found, and no main graph specified.`);
  }

  // TODO: Consolidate options into one object
  const processor = new GraphProcessor(
    project,
    graphId as GraphId,
    options.registry ?? globalRivetNodeRegistry,
    options.includeTrace,
    {
      cacheLoadedProjects: internalOptions.cacheLoadedProjects,
      captureNodeTimings: options.captureNodeTimings,
      concurrency: options.concurrency,
      executionPlanCacheMode: internalOptions.executionPlanCacheMode,
      runtimeCache: internalOptions.runtimeCache,
      runtimeProfiler: internalOptions.runtimeProfiler,
      scheduler: internalOptions.scheduler,
    },
  );

  if (options.onStart) {
    processor.on('start', options.onStart);
  }

  if (options.onNodeStart) {
    processor.on('nodeStart', options.onNodeStart);
  }

  if (options.onNodeFinish) {
    processor.on('nodeFinish', options.onNodeFinish);
  }

  if (options.onNodeError) {
    processor.on('nodeError', options.onNodeError);
  }

  if (options.onNodeExcluded) {
    processor.on('nodeExcluded', options.onNodeExcluded);
  }

  if (options.onGraphStart) {
    processor.on('graphStart', options.onGraphStart);
  }

  if (options.onGraphError) {
    processor.on('graphError', options.onGraphError);
  }

  if (options.onGraphFinish) {
    processor.on('graphFinish', options.onGraphFinish);
  }

  if (options.onPartialOutput) {
    processor.on('partialOutput', options.onPartialOutput);
  }

  if (options.onUserInput) {
    processor.on('userInput', options.onUserInput);
  }

  if (options.onDone) {
    processor.on('done', options.onDone);
  }

  if (options.onAbort) {
    processor.on('abort', options.onAbort);
  }

  if (options.onGraphAbort) {
    processor.on('graphAbort', options.onGraphAbort);
  }

  if (options.onTrace) {
    processor.on('trace', options.onTrace);
  }

  if (options.onNodeOutputsCleared) {
    processor.on('nodeOutputsCleared', options.onNodeOutputsCleared);
  }

  if (options.externalFunctions) {
    for (const [name, fn] of Object.entries(options.externalFunctions)) {
      processor.setExternalFunction(name, fn);
    }
  }

  if (options.onUserEvent) {
    for (const [name, fn] of Object.entries(options.onUserEvent)) {
      processor.onUserEvent(name, fn);
    }
  }

  options.abortSignal?.addEventListener('abort', () => {
    void processor.abort();
  });

  const resolvedInputs = looseDataValuesToDataValues(inputs);
  const resolvedContextValues = looseDataValuesToDataValues(context);

  return {
    processor,
    inputs: resolvedInputs,
    contextValues: resolvedContextValues,
    getEvents: (spec: RivetEventStreamFilterSpec) => getProcessorEvents(processor, spec),
    getSSEStream: (spec: RivetEventStreamFilterSpec) => getProcessorSSEStream(processor, spec),
    streamNode: (nodeIdOrTitle: string) => getSingleNodeStream(processor, nodeIdOrTitle),
    async run() {
      const outputs = await processor.processGraph(
        {
          nativeApi: options.nativeApi,
          datasetProvider: options.datasetProvider,
          audioProvider: options.audioProvider,
          mcpProvider: options.mcpProvider,
          codeRunner: options.codeRunner,
          tokenizer: options.tokenizer ?? new GptTokenizerTokenizer(),
          projectPath: options.projectPath,
          projectReferenceLoader: options.projectReferenceLoader,
          editorExecutionCache: options.editorExecutionCache,
          settings: resolveProcessSettings(options),
          getChatNodeEndpoint: options.getChatNodeEndpoint,
        },
        resolvedInputs,
        resolvedContextValues,
      );

      return outputs;
    },
  };
}

export async function coreRunGraph(project: Project, options: RunGraphOptions): Promise<Record<string, DataValue>> {
  const processorInfo = coreCreateProcessor(project, options);
  return processorInfo.run();
}

export function loadProjectFromString(content: string): Project {
  const [project] = deserializeProject(content);
  return project;
}

export function loadProjectAndAttachedDataFromString(content: string): [Project, AttachedData] {
  return deserializeProject(content);
}
