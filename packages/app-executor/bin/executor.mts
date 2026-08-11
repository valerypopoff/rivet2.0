import {
  startDebuggerServer,
  createProcessor,
  assembleRegistry,
  resolveBuiltInPlugin,
  DebuggerDatasetProvider,
  NodeProjectReferenceLoader,
} from '@valerypopoff/rivet2-node';
import * as Rivet from '@valerypopoff/rivet2-core';
import {
  getError,
  logRuntimeDebug,
  logRuntimeError,
  logRuntimeInfo,
  logRuntimeWarn,
  summarizePortMapForLog,
  type RivetPluginInitializer,
  type PluginLoadSpec,
} from '@valerypopoff/rivet2-core';
import { match } from 'ts-pattern';
import { join } from 'node:path';
import { access, readFile } from 'node:fs/promises';
import { platform, homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { AppExecutorWorkerCodeRunner } from './AppExecutorWorkerCodeRunner.mjs';
import {
  prewarmSharedAppExecutorCodeWorkerPool,
  shutdownSharedAppExecutorCodeWorkerPool,
} from './codeRunnerWorkerPool.mjs';
import { parseExecutorHostFromArgs, parseExecutorPortFromArgs } from './executorConfig.mjs';
import { getAppExecutorHostOptions, markAppExecutorModuleLoaded } from './executorHostState.mjs';

markAppExecutorModuleLoaded();

type AppExecutorDebugger = ReturnType<typeof startDebuggerServer>;
type AppExecutorDebuggerOptions = NonNullable<Parameters<typeof startDebuggerServer>[0]>;
type AppExecutorClient = Parameters<NonNullable<AppExecutorDebuggerOptions['dynamicGraphRun']>>[0]['client'];
type AppExecutorProcessor = ReturnType<typeof createProcessor>['processor'];
const processorsByClient = new WeakMap<AppExecutorClient, Set<AppExecutorProcessor>>();
const clientByProcessor = new WeakMap<AppExecutorProcessor, AppExecutorClient>();
const datasetProvidersByClient = new WeakMap<AppExecutorClient, DebuggerDatasetProvider>();
const debuggerStatesByClient = new WeakMap<
  AppExecutorClient,
  { uploadedProject: Rivet.Project | undefined; settings: Rivet.Settings | undefined }
>();
const editorExecutionCachesByClient = new WeakMap<AppExecutorClient, Map<string, Map<string, unknown>>>();
const sharedCodeWorkerPoolReady = prewarmSharedAppExecutorCodeWorkerPool().catch((error) => {
  logRuntimeError('Failed to prewarm app-executor code workers.', error);
});

function getEditorExecutionCache(client: AppExecutorClient, project: Rivet.Project) {
  let cachesByProjectId = editorExecutionCachesByClient.get(client);
  if (!cachesByProjectId) {
    cachesByProjectId = new Map<string, Map<string, unknown>>();
    editorExecutionCachesByClient.set(client, cachesByProjectId);
  }

  let cache = cachesByProjectId.get(project.metadata.id);

  if (!cache) {
    cache = new Map<string, unknown>();
    cachesByProjectId.set(project.metadata.id, cache);
  }

  return cache;
}

/**
 * Dynamically import a module and resolve its default export. Handles the
 * CJS/ESM interop case where `import()` may wrap the real default in an
 * extra `{ default: ... }` layer depending on the module format of the target.
 */
async function importPluginInitializer(specifier: string, pluginId: string): Promise<RivetPluginInitializer> {
  const imported = (await import(specifier)) as {
    default: RivetPluginInitializer | { default: RivetPluginInitializer };
  };
  const mod =
    typeof imported.default === 'function'
      ? imported.default
      : (imported.default as { default: RivetPluginInitializer }).default;
  if (typeof mod !== 'function') {
    throw new Error(`Plugin ${pluginId} does not export a valid initializer function`);
  }
  return mod;
}

// Roughly https://github.com/demurgos/appdata-path/blob/master/lib/index.js but appdata local and .local/share, try to match `dirs` from rust
function getAppDataLocalPath() {
  const identifier = 'com.valerypopoff.rivet2';
  return match(platform())
    .with('win32', () => join(homedir(), 'AppData', 'Local', identifier))
    .with('darwin', () => join(homedir(), 'Library', 'Application Support', identifier))
    .with('linux', () => join(homedir(), '.local', 'share', identifier))
    .otherwise(() => {
      if (platform().startsWith('win')) {
        return join(homedir(), 'AppData', 'Local', identifier);
      } else {
        return join(homedir(), '.local', 'share', identifier);
      }
    });
}

const executorArgs = process.argv.slice(2);
const port = parseExecutorPortFromArgs(executorArgs);
const host = parseExecutorHostFromArgs(executorArgs);
const executorReadyMessage = `Rivet app executor websocket listening on ${host}:${port}`;
let executorWebSocketReady = false;
let exitingAfterStartupError = false;

process.on('unhandledRejection', (reason) => {
  handleTopLevelSidecarError('Unhandled promise rejection in app executor sidecar.', reason);
});

process.on('uncaughtException', (error) => {
  handleTopLevelSidecarError('Uncaught exception in app executor sidecar.', error);
});

function handleTopLevelSidecarError(message: string, error: unknown) {
  logRuntimeError(message, error);

  if (!executorWebSocketReady && !exitingAfterStartupError) {
    exitingAfterStartupError = true;
    process.exitCode = 1;
    setImmediate(() => process.exit(1));
  }
}

function sendGraphRunError(client: { send(data: string): void }, requestId: Rivet.RemoteRunRequestId, error: unknown) {
  try {
    client.send(
      JSON.stringify({
        message: 'error',
        data: {
          error: getError(error).toString(),
        },
        requestId,
      }),
    );
  } catch (sendError) {
    logRuntimeError('Failed to report graph run error to executor client.', sendError, { requestId });
  }
}

function trackClientProcessor(client: AppExecutorClient, processor: AppExecutorProcessor) {
  let processors = processorsByClient.get(client);
  if (!processors) {
    processors = new Set();
    processorsByClient.set(client, processors);
  }

  processors.add(processor);
  clientByProcessor.set(processor, client);
}

function untrackClientProcessor(processor: AppExecutorProcessor) {
  const client = clientByProcessor.get(processor);
  clientByProcessor.delete(processor);

  if (!client) {
    return;
  }

  const processors = processorsByClient.get(client);
  processors?.delete(processor);
  if (processors?.size === 0) {
    processorsByClient.delete(client);
  }
}

function getDatasetProviderForClient(client: AppExecutorClient) {
  let provider = datasetProvidersByClient.get(client);
  if (!provider) {
    provider = new DebuggerDatasetProvider();
    datasetProvidersByClient.set(client, provider);
  }

  return provider;
}

function getDebuggerStateForClient(client: AppExecutorClient) {
  let state = debuggerStatesByClient.get(client);
  if (!state) {
    state = { uploadedProject: undefined, settings: undefined };
    debuggerStatesByClient.set(client, state);
  }

  return state;
}

function createClientScopedDebugger(client: AppExecutorClient): AppExecutorDebugger {
  return {
    ...rivetDebugger,
    attach(processor, requestId) {
      trackClientProcessor(client, processor);
      try {
        rivetDebugger.attach(processor, requestId);
      } catch (error) {
        untrackClientProcessor(processor);
        throw error;
      }
    },
    detach(processor) {
      rivetDebugger.detach(processor);
      untrackClientProcessor(processor);
    },
  };
}

const rivetDebugger = startDebuggerServer({
  port,
  host,
  allowGraphUpload: true,
  getClientDebuggerState: getDebuggerStateForClient,
  getDatasetProviderForClient,
  getClientsForProcessor: (processor, fallbackClients) => {
    const client = clientByProcessor.get(processor);
    return client ? [client] : fallbackClients;
  },
  getProcessorsForClient: (client, fallbackProcessors) => {
    const processors = processorsByClient.get(client);
    if (!processors) {
      return [];
    }

    return fallbackProcessors.filter((processor) => processors.has(processor));
  },
  dynamicGraphRun: async ({
    client,
    requestId,
    graphId,
    inputs,
    runToNodeIds,
    preloadData,
    frozenNodeOutputs,
    contextValues,
    projectPath,
    useEditorCache,
    captureNodeTimings,
    returnWhenGraphOutputsReady,
    webAppStorage: initialWebAppStorage,
  }) => {
    logRuntimeInfo(`Running graph ${graphId}`, {
      requestId,
      inputCount: Object.keys(inputs ?? {}).length,
      runToNodeCount: runToNodeIds?.length ?? 0,
      preloadNodeCount: Object.keys(preloadData ?? {}).length,
      contextValueCount: Object.keys(contextValues ?? {}).length,
      hasProjectPath: projectPath != null,
    });
    logRuntimeDebug('Graph input summary', {
      requestId,
      inputs: summarizePortMapForLog(inputs),
    });

    const debuggerState = getDebuggerStateForClient(client);
    const project = debuggerState.uploadedProject;

    if (project === undefined) {
      logRuntimeWarn(`Cannot run graph ${graphId} because no project is uploaded.`);
      sendGraphRunError(client, requestId, new Error(`Cannot run graph ${graphId} because no project is uploaded.`));
      return;
    }

    let processorForConsole: ReturnType<typeof createProcessor>['processor'] | undefined;

    try {
      const { registry, results } = await assembleRegistry(project.plugins ?? [], async (spec: PluginLoadSpec) => {
        return match(spec)
          .with({ type: 'built-in' }, async (s) => resolveBuiltInPlugin(s.id))
          .with({ type: 'uri' }, async (s) => {
            const mod = await importPluginInitializer(s.uri, s.id);
            const initialized = mod(Rivet);
            if (!initialized?.id) {
              throw new Error(`Plugin ${s.id} does not have an id`);
            }
            return initialized;
          })
          .with({ type: 'package' }, async (s) => {
            const localDataDir = getAppDataLocalPath();
            const pluginDir = join(localDataDir, `plugins/${s.package}-${s.tag}/package`);
            const packageJsonPath = join(pluginDir, 'package.json');

            try {
              await access(packageJsonPath);
            } catch (err) {
              throw new Error(`Plugin ${s.id} is not installed, could not access ${packageJsonPath}`);
            }

            const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf-8'));
            if (packageJson.name !== s.package) {
              throw new Error(`Plugin ${s.id} is not installed, found ${packageJson.name} instead of ${s.package}`);
            }

            const mainPath = join(pluginDir, packageJson.main);
            const mod = await importPluginInitializer(pathToFileURL(mainPath).href, s.id);
            const initialized = mod(Rivet);
            if (!initialized?.id) {
              throw new Error(`Plugin ${s.id} does not have an id`);
            }
            return initialized;
          })
          .exhaustive();
      });

      for (const plugin of results.loaded) {
        logRuntimeInfo(`Enabled plugin ${plugin.id}.`);
      }
      for (const fail of results.failed) {
        logRuntimeError(`Failed to enable plugin ${fail.id}.`, fail.error);
      }

      const codeRunner = new AppExecutorWorkerCodeRunner((message) => {
        if (processorForConsole) {
          rivetDebugger.broadcast(processorForConsole, 'codeConsole', message, requestId);
        }
      });
      const clientScopedDebugger = createClientScopedDebugger(client);

      const injectedProcessorOptions =
        (await getAppExecutorHostOptions().createProcessorOptions?.({
          graphId,
          isWebAppAction: initialWebAppStorage !== undefined,
          project,
          projectPath,
          requestId,
        })) ?? {};

      const webAppStorage =
        initialWebAppStorage === undefined
          ? undefined
          : Rivet.createRivetStoredValueSnapshotStore(initialWebAppStorage);
      let webAppStorageBoundaryPublished = false;
      const publishWebAppStoragePatch = webAppStorage
        ? (event: Rivet.ProcessEvents['graphFinish'] | Rivet.ProcessEvents['graphOutputsReady']) => {
            if (event.execution.parentGraphRunId != null || webAppStorageBoundaryPublished) {
              return;
            }
            webAppStorageBoundaryPublished = true;
            const storagePatch = webAppStorage.getPatch();
            if (Object.keys(storagePatch).length === 0 || !processorForConsole) {
              return;
            }
            clientScopedDebugger.broadcast(processorForConsole, 'webAppStoragePatch', { storagePatch }, requestId);
          }
        : undefined;
      const processor = createProcessor(project, {
        ...injectedProcessorOptions,
        graph: graphId,
        inputs,
        ...debuggerState.settings!,
        remoteDebugger: clientScopedDebugger,
        remoteDebuggerRequestId: requestId,
        captureNodeTimings: captureNodeTimings ?? false,
        returnWhenGraphOutputsReady,
        registry,
        datasetProvider: getDatasetProviderForClient(client),
        codeRunner,
        editorExecutionCache: useEditorCache ? getEditorExecutionCache(client, project) : undefined,
        onGraphFinish: publishWebAppStoragePatch,
        onGraphOutputsReady: publishWebAppStoragePatch,
        onTrace: (trace) => {
          logRuntimeDebug('Graph trace', { trace });
        },
        context: contextValues,
        storedValueStore: webAppStorage?.store,
        projectPath,
        projectReferenceLoader: new NodeProjectReferenceLoader(),
      });
      processorForConsole = processor.processor;

      if (runToNodeIds) {
        processor.processor.runToNodeIds = runToNodeIds;
      }

      processor.processor.setFrozenNodeOutputResolver(Rivet.createFrozenNodeOutputResolver(frozenNodeOutputs));

      for (const [nodeId, outputs] of Object.entries(preloadData ?? {})) {
        processor.processor.preloadNodeData(nodeId as Rivet.NodeId, outputs);
      }

      try {
        await processor.run();
      } finally {
        if (processor.processor.isRunning) {
          await processor.processor.waitForRunCompletion().catch(() => undefined);
        }
      }
    } catch (err) {
      logRuntimeError(`Graph ${graphId} failed.`, err, { requestId });
      sendGraphRunError(client, requestId, err);
    } finally {
      if (processorForConsole) {
        rivetDebugger.detach(processorForConsole);
        untrackClientProcessor(processorForConsole);
      }
    }
  },
});

process.on('SIGTERM', () => {
  rivetDebugger.webSocketServer.close();
  void shutdownSharedAppExecutorCodeWorkerPool();
});

async function announceExecutorReady() {
  await sharedCodeWorkerPoolReady;
  executorWebSocketReady = true;
  logRuntimeInfo(executorReadyMessage);
}

if (rivetDebugger.webSocketServer.address()) {
  void announceExecutorReady();
} else {
  rivetDebugger.webSocketServer.once('listening', () => {
    void announceExecutorReady();
  });
}
