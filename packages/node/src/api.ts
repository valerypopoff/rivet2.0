import {
  type DataValue,
  type NodeRegistration,
  type Project,
  type StringPluginConfigurationSpec,
  globalRivetNodeRegistry,
  type AttachedData,
  coreCreateProcessor,
  loadProjectFromString,
  loadProjectAndAttachedDataFromString,
  looseDataValuesToDataValues,
  type RunGraphOptions,
  resolveProcessSettings,
  type Tokenizer,
  type TokenizerCallInfo,
  type ChatMessage,
  type GptFunction,
  type GraphProcessorRuntimeCache,
  type GraphId,
  type RemoteRunRequestId,
  type LooseDataValue,
  type NodeGraph,
  type ProcessContext,
  type GraphProcessorRuntimeProfiler,
} from '@valerypopoff/rivet2-core';

import { readFile } from 'node:fs/promises';

import { NodeNativeApi } from './native/NodeNativeApi.js';
import * as events from 'node:events';
import { NodeCodeRunner } from './native/NodeCodeRunner.js';
import { CachedNodeCodeRunner } from './native/CachedNodeCodeRunner.js';
import type { RivetDebuggerServer } from './debugger.js';
import { NodeProjectReferenceLoader } from './native/NodeProjectReferenceLoader.js';
import { NodeMCPProvider } from './native/NodeMCPProvider.js';
import { resolveCreateProcessorRuntimePolicy, type NodeRuntimeProfile } from './createProcessorRuntimePolicy.js';

export type { NodeRuntimeProfile };

class FallbackTokenizer implements Tokenizer {
  on(_event: 'error', _listener: (err: Error) => void): () => void {
    return () => {};
  }

  async getTokenCountForString(input: string, _info: TokenizerCallInfo): Promise<number> {
    return input.length;
  }

  async getTokenCountForMessages(
    messages: ChatMessage[],
    _gptFunctions: GptFunction[] | undefined,
    _info: TokenizerCallInfo,
  ): Promise<number> {
    return messages.reduce((total, message) => {
      if (typeof message.message === 'string') {
        return total + message.message.length;
      }

      if (Array.isArray(message.message)) {
        return (
          total +
          message.message.reduce((messageTotal, part) => {
            if (typeof part === 'string') {
              return messageTotal + part.length;
            }

            if (part.type === 'url') {
              return messageTotal + part.url.length;
            }

            if (part.type === 'document') {
              return messageTotal + (part.title?.length ?? 0) + (part.context?.length ?? 0);
            }

            return messageTotal;
          }, 0)
        );
      }

      return total;
    }, 0);
  }
}

export async function loadProjectFromFile(path: string): Promise<Project> {
  const content = await readFile(path, { encoding: 'utf8' });
  return loadProjectFromString(content);
}

export async function loadProjectAndAttachedDataFromFile(path: string): Promise<[Project, AttachedData]> {
  const content = await readFile(path, { encoding: 'utf8' });
  return loadProjectAndAttachedDataFromString(content);
}

export async function runGraphInFile(path: string, options: NodeRunGraphOptions): Promise<Record<string, DataValue>> {
  options.abortSignal?.throwIfAborted();
  const project = await loadProjectFromFile(path);
  return runGraph(project, options);
}

export type NodeRunGraphOptions = RunGraphOptions & {
  remoteDebugger?: RivetDebuggerServer;
  remoteDebuggerRequestId?: RemoteRunRequestId;
};

type NodeGraphProcessor = ReturnType<typeof coreCreateProcessor>['processor'];

export type NodeCreatedProcessor = ReturnType<typeof coreCreateProcessor> & {
  dispose(): void;
};

export type NodeCreateProcessorOptions = NodeRunGraphOptions & {
  runtimeProfiler?: GraphProcessorRuntimeProfiler;
  runtimeProfile?: NodeRuntimeProfile;
};

export type NodeGraphRunnerOptions = Omit<
  NodeRunGraphOptions,
  'abortSignal' | 'context' | 'inputs' | 'remoteDebugger' | 'remoteDebuggerRequestId'
>;

export type NodeGraphRunnerRunOptions = {
  abortSignal?: AbortSignal;
  context?: Record<string, LooseDataValue>;
  inputs?: Record<string, LooseDataValue>;
};

export type NodeGraphRunner = {
  dispose: () => void;
  run: (options?: NodeGraphRunnerRunOptions) => Promise<Record<string, DataValue>>;
};

type DefaultRunGraphRuntimePlan = 'compatible' | 'default-safe';

export function createProcessor(project: Project, options: NodeCreateProcessorOptions): NodeCreatedProcessor {
  const { runtimeProfile, runtimeProfiler, ...processorOptions } = options;
  const effectiveProcessorOptions = {
    ...processorOptions,
    captureNodeTimings:
      processorOptions.captureNodeTimings ?? (processorOptions.remoteDebugger !== undefined ? true : undefined),
  };
  const runtimePolicy = resolveCreateProcessorRuntimePolicy({ ...processorOptions, runtimeProfile });
  const processor = coreCreateProcessor(
    project,
    {
      ...effectiveProcessorOptions,
      // Node owns the run-scoped binding below so repeated runs can clean it
      // up without retaining completed processors on a long-lived signal.
      abortSignal: undefined,
    },
    {
      cacheLoadedProjects: runtimePolicy.cacheLoadedProjects,
      executionPlanCacheMode: runtimePolicy.executionPlanCacheMode,
      runtimeCache: runtimePolicy.runtimeCache,
      runtimeProfiler,
      scheduler: runtimePolicy.scheduler,
    },
  );

  configureNodeProcessor(processor.processor);

  let remoteDebuggerAttached = false;
  const attachRemoteDebugger = () => {
    if (!effectiveProcessorOptions.remoteDebugger || remoteDebuggerAttached) {
      return;
    }

    effectiveProcessorOptions.remoteDebugger.attach(
      processor.processor,
      effectiveProcessorOptions.remoteDebuggerRequestId,
    );
    remoteDebuggerAttached = true;
  };
  const detachRemoteDebugger = () => {
    if (!effectiveProcessorOptions.remoteDebugger || !remoteDebuggerAttached) {
      return;
    }

    effectiveProcessorOptions.remoteDebugger.detach(processor.processor);
    remoteDebuggerAttached = false;
  };

  const abortSignal = effectiveProcessorOptions.abortSignal;
  let disposed = false;
  let abortCleanupAttached = false;
  const detachRemoteDebuggerOnAbort = () => {
    abortCleanupAttached = false;
    detachRemoteDebugger();
  };
  const attachAbortCleanup = () => {
    if (!effectiveProcessorOptions.remoteDebugger || !abortSignal || abortCleanupAttached) return;
    if (abortSignal.aborted) {
      detachRemoteDebugger();
      return;
    }

    abortSignal.addEventListener('abort', detachRemoteDebuggerOnAbort, { once: true });
    abortCleanupAttached = true;
  };
  const detachAbortCleanup = () => {
    if (!abortSignal || !abortCleanupAttached) return;
    abortSignal.removeEventListener('abort', detachRemoteDebuggerOnAbort);
    abortCleanupAttached = false;
  };

  attachRemoteDebugger();
  attachAbortCleanup();

  const pluginEnv = resolveNodePluginEnv(effectiveProcessorOptions);

  return {
    ...processor,
    dispose() {
      if (disposed) return;
      disposed = true;
      detachAbortCleanup();
      detachRemoteDebugger();
      processor.dispose();
    },
    async run() {
      if (disposed) {
        throw new Error('This Node processor has been disposed.');
      }
      abortSignal?.throwIfAborted();
      const shouldManageRemoteDebugger =
        effectiveProcessorOptions.remoteDebugger != null && !processor.processor.isRunning;
      const shouldManageRunScopedRuntimeCache = runtimePolicy.runtimeCache != null && !processor.processor.isRunning;
      if (shouldManageRunScopedRuntimeCache) {
        clearGraphProcessorRuntimeCache(runtimePolicy.runtimeCache!);
      }

      if (shouldManageRemoteDebugger) {
        attachRemoteDebugger();
        attachAbortCleanup();
      }

      const runScopedCodeRunner = runtimePolicy.useCachedDefaultCodeRunner ? new CachedNodeCodeRunner() : undefined;
      const detachProcessorAbort = bindAbortSignal(processor.processor, abortSignal);

      const cleanupRunResources = () => {
        detachProcessorAbort();
        runScopedCodeRunner?.clearCache();
        if (shouldManageRunScopedRuntimeCache) {
          clearGraphProcessorRuntimeCache(runtimePolicy.runtimeCache!);
        }

        if (shouldManageRemoteDebugger) {
          detachAbortCleanup();
          detachRemoteDebugger();
        }
      };

      try {
        const outputsPromise = processor.processor.processGraph(
          createNodeProcessContext(effectiveProcessorOptions, pluginEnv, { codeRunner: runScopedCodeRunner }),
          processor.inputs,
          processor.contextValues,
          { returnWhenGraphOutputsReady: effectiveProcessorOptions.returnWhenGraphOutputsReady },
        );

        if (abortSignal?.aborted) {
          void processor.processor.abort();
        }

        return await outputsPromise;
      } finally {
        if (processor.processor.isRunning) {
          void processor.processor
            .waitForRunCompletion()
            .catch(() => undefined)
            .finally(cleanupRunResources);
        } else {
          cleanupRunResources();
        }
      }
    },
  };
}

function clearGraphProcessorRuntimeCache(runtimeCache: GraphProcessorRuntimeCache): void {
  runtimeCache.executionPlans = undefined;
  runtimeCache.graphBoundaries = undefined;
  runtimeCache.loadedProjects = undefined;
}

export function createGraphRunner(project: Project, options: NodeGraphRunnerOptions): NodeGraphRunner {
  const { runtimeProfile: ignoredRuntimeProfile, ...processorOptions } = options as NodeGraphRunnerOptions & {
    runtimeProfile?: unknown;
  };
  void ignoredRuntimeProfile;

  const processContext = createNodeProcessContext(processorOptions, resolveNodePluginEnv(processorOptions), {
    codeRunner: undefined,
  });
  const activeProcessors = new Set<NodeGraphProcessor>();
  let disposed = false;

  const runWithProcessor = async (
    processor: NodeGraphProcessor,
    runOptions: NodeGraphRunnerRunOptions = {},
  ): Promise<Record<string, DataValue>> => {
    runOptions.abortSignal?.throwIfAborted();
    activeProcessors.add(processor);
    const cleanupAbortSignal = bindAbortSignal(processor, runOptions.abortSignal);

    const cleanup = () => {
      cleanupAbortSignal();
      activeProcessors.delete(processor);
    };
    try {
      const outputsPromise = processor.processGraph(
        processContext,
        looseDataValuesToDataValues(runOptions.inputs ?? {}),
        looseDataValuesToDataValues(runOptions.context ?? {}),
        { returnWhenGraphOutputsReady: processorOptions.returnWhenGraphOutputsReady === true },
      );

      if (runOptions.abortSignal?.aborted) {
        void processor.abort();
      }

      const outputs = await outputsPromise;
      return outputs;
    } finally {
      if (processor.isRunning) {
        void processor
          .waitForRunCompletion()
          .catch(() => undefined)
          .finally(cleanup);
      } else {
        cleanup();
      }
    }
  };

  return {
    dispose() {
      disposed = true;
      for (const processor of activeProcessors) {
        void processor.abort(false, 'Graph runner disposed.');
      }
      activeProcessors.clear();
    },
    async run(runOptions = {}) {
      if (disposed) {
        throw new Error('Cannot run a disposed graph runner.');
      }
      runOptions.abortSignal?.throwIfAborted();

      return await runWithProcessor(createRunnerProcessor(project, processorOptions), runOptions);
    },
  };
}

export async function runGraph(project: Project, options: NodeRunGraphOptions): Promise<Record<string, DataValue>> {
  options.abortSignal?.throwIfAborted();
  const processorOptions = stripRunGraphRuntimeProfile(options);
  const runtimePlan = resolveDefaultRunGraphRuntimePlan(project, processorOptions);
  const processorInfo = createProcessor(project, createRunGraphProcessorOptions(processorOptions, runtimePlan));
  return processorInfo.run();
}

function createRunGraphProcessorOptions(
  options: NodeRunGraphOptions,
  runtimePlan: DefaultRunGraphRuntimePlan,
): NodeCreateProcessorOptions {
  if (runtimePlan === 'default-safe') {
    return options;
  }

  return { ...options, runtimeProfile: 'compatible' };
}

function stripRunGraphRuntimeProfile(options: NodeRunGraphOptions): NodeRunGraphOptions {
  if (!('runtimeProfile' in options)) {
    return options;
  }

  const processorOptions: NodeRunGraphOptions & { runtimeProfile?: unknown } = { ...options };
  delete processorOptions.runtimeProfile;
  return processorOptions;
}

function resolveDefaultRunGraphRuntimePlan(project: Project, options: NodeRunGraphOptions): DefaultRunGraphRuntimePlan {
  const graph = getRunGraphTarget(project, options.graph);
  if (!graph) {
    return 'compatible';
  }

  return shouldUseDefaultSafeRunGraphPolicy(graph, options) ? 'default-safe' : 'compatible';
}

function shouldUseDefaultSafeRunGraphPolicy(graph: NodeGraph, options: NodeRunGraphOptions): boolean {
  if (options.remoteDebugger !== undefined || options.includeTrace) {
    return false;
  }

  const subgraphTargetCounts = new Map<string, number>();
  const referencedAliasTargetCounts = new Map<string, number>();
  let dynamicCallGraphCalls = 0;
  let hasCodeFamilyNode = false;

  for (const node of graph.nodes) {
    if (node.type === 'subGraph') {
      if (hasRepeatedTarget(subgraphTargetCounts, getNodeGraphId(node))) {
        return true;
      }
    } else if (node.type === 'referencedGraphAlias') {
      if (hasRepeatedTarget(referencedAliasTargetCounts, getReferencedGraphAliasTarget(node))) {
        return true;
      }
    } else if (node.type === 'callGraph') {
      dynamicCallGraphCalls += 1;
    }

    if (
      options.codeRunner == null &&
      (node.type === 'code' ||
        node.type === 'codeNew' ||
        node.type === 'expression' ||
        node.type === 'jsFilter' ||
        node.type === 'jsMap')
    ) {
      hasCodeFamilyNode = true;
    }

    if (hasCodeFamilyNode || dynamicCallGraphCalls > 1) {
      return true;
    }
  }

  return false;
}

function hasRepeatedTarget(targetCounts: Map<string, number>, target: string | undefined): boolean {
  if (!target) {
    return false;
  }

  const count = (targetCounts.get(target) ?? 0) + 1;
  targetCounts.set(target, count);
  return count > 1;
}

function getNodeGraphId(node: { data?: unknown }): string | undefined {
  const data = node.data as { graphId?: unknown } | undefined;
  return typeof data?.graphId === 'string' ? data.graphId : undefined;
}

function getReferencedGraphAliasTarget(node: { data?: unknown }): string | undefined {
  const data = node.data as { graphId?: unknown; projectId?: unknown } | undefined;
  if (typeof data?.graphId !== 'string') {
    return undefined;
  }

  return `${typeof data.projectId === 'string' ? data.projectId : ''}:${data.graphId}`;
}

function getRunGraphTarget(project: Project, graph: string | undefined): NodeGraph | undefined {
  if (graph) {
    return (
      project.graphs[graph as GraphId] ??
      Object.values(project.graphs).find((candidate) => candidate.metadata?.name === graph)
    );
  }

  return project.metadata.mainGraphId ? project.graphs[project.metadata.mainGraphId] : undefined;
}

function configureNodeProcessor(processor: NodeGraphProcessor): void {
  processor.executor = 'nodejs';

  processor.on('newAbortController', (controller) => {
    events.setMaxListeners(0, controller.signal);
  });
}

function createRunnerProcessor(project: Project, options: RunGraphOptions): NodeGraphProcessor {
  const processorInfo = coreCreateProcessor(
    project,
    {
      ...options,
      abortSignal: undefined,
      context: {},
      inputs: {},
    },
    {
      cacheLoadedProjects: false,
      executionPlanCacheMode: 'all',
      scheduler: 'compatible',
    },
  );

  configureNodeProcessor(processorInfo.processor);
  return processorInfo.processor;
}

function createNodeProcessContext(
  options: RunGraphOptions,
  pluginEnv: Record<string, string | undefined>,
  overrides: { codeRunner?: ProcessContext['codeRunner'] } = {},
): ProcessContext {
  return {
    nativeApi: options.nativeApi ?? new NodeNativeApi(),
    datasetProvider: options.datasetProvider,
    mcpProvider: options.mcpProvider ?? new NodeMCPProvider(),
    audioProvider: options.audioProvider,
    tokenizer: options.tokenizer ?? new FallbackTokenizer(),
    codeRunner: options.codeRunner ?? overrides.codeRunner ?? new NodeCodeRunner(),
    projectPath: options.projectPath,
    projectReferenceLoader: options.projectReferenceLoader ?? new NodeProjectReferenceLoader(),
    editorExecutionCache: options.editorExecutionCache,
    settings: resolveProcessSettings(
      { ...options, pluginEnv },
      {
        openAiApiKey: process.env.OPENAI_API_KEY ?? '',
        anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? '',
        googleApiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY ?? '',
        customAiApiKey: process.env.CUSTOM_PROVIDER_API_KEY ?? process.env.CUSTOM_AI_API_KEY ?? '',
        openAiOrganization: process.env.OPENAI_ORG_ID ?? '',
      },
    ),
    getChatNodeEndpoint: options.getChatNodeEndpoint,
    onChatV2CallFinished: options.onChatV2CallFinished,
  };
}

function resolveNodePluginEnv(options: RunGraphOptions): Record<string, string | undefined> {
  // If unset, use process.env
  return options.pluginEnv ?? getPluginEnvFromProcessEnv(options.registry);
}

function bindAbortSignal(processor: NodeGraphProcessor, abortSignal?: AbortSignal): () => void {
  if (!abortSignal) {
    return () => {};
  }

  const abort = () => {
    void processor.abort();
  };

  abortSignal.addEventListener('abort', abort, { once: true });
  return () => {
    abortSignal.removeEventListener('abort', abort);
  };
}

function getPluginEnvFromProcessEnv(registry?: NodeRegistration<any, any>) {
  const pluginEnv: Record<string, string> = {};
  for (const plugin of (registry ?? globalRivetNodeRegistry).getPlugins() ?? []) {
    const configs = Object.entries(plugin.configSpec ?? {}).filter(([, c]) => c.type === 'string') as [
      string,
      StringPluginConfigurationSpec,
    ][];
    for (const [configName, config] of configs) {
      if (config.pullEnvironmentVariable) {
        const envVarName =
          typeof config.pullEnvironmentVariable === 'string'
            ? config.pullEnvironmentVariable
            : config.pullEnvironmentVariable === true
              ? configName
              : undefined;
        if (envVarName) {
          pluginEnv[envVarName] = process.env[envVarName] ?? '';
        }
      }
    }
  }
  return pluginEnv;
}
