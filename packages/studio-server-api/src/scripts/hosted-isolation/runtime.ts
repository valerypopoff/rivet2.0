import {
  createProcessor,
  ExecutionRecorder,
  NodeDatasetProvider,
  NodeProjectReferenceLoader,
  prepareRivetWebAppAction,
  type NodeCreatedProcessor,
  type Outputs,
  type PortId,
} from '@valerypopoff/rivet2-node';
import { ManagedCodeRunner } from '../../runtime-libraries/managed-code-runner.js';
import { createHostedRuntimeOptions } from '../../routes/workflows/hosted-runtime-policy.js';
import {
  ExecutionSession,
  getExecutionOutputStatus,
  getExecutionRunCostSnapshot,
} from '../../routes/workflows/execution-session.js';
import {
  prototypeFailure,
  type PrototypeDefinition,
  type PrototypeEvent,
  type PrototypeRequest,
  type PrototypeResult,
} from './protocol.js';

function responseJson(outputs: Outputs): string | undefined {
  const output = outputs['output' as PortId];
  return JSON.stringify(output?.type === 'any' ? output.value ?? null : outputs);
}

/** Actual hosted policy/Code runner/session, with local immutable fixture services.
 * These injected services do not initialize storage, SQL or settings repositories.
 * This is not acceptance of the production service adapters, which do not exist yet. */
export async function runPrototypeRoot(
  definition: PrototypeDefinition,
  request: PrototypeRequest,
  signal: AbortSignal,
  emit: (event: PrototypeEvent) => void,
): Promise<PrototypeResult> {
  signal.throwIfAborted();
  const executionEnvironment = request.executionEnvironment ?? definition.executionEnvironment;
  const inputs = request.inputJson
    ? { input: { type: 'any' as const, value: JSON.parse(Buffer.from(request.inputJson).toString()) as unknown } }
    : request.inputs;
  const runtime = await createHostedRuntimeOptions(
    { projectPath: definition.projectPath, datasetProvider: new NodeDatasetProvider([]), abortSignal: signal },
    {
      readEnvironment: async () => executionEnvironment,
      createProjectReferenceLoader: async () => new NodeProjectReferenceLoader(),
      getProfileHealth: async () => undefined,
    },
  );
  // The benchmark has no managed libraries or live storage. Both modes use the
  // same lazy fixture preparation instead of accidentally contacting production.
  runtime.codeRunner = new ManagedCodeRunner(definition.runtimeLibrariesRoot, {
    executionEnvironment,
    prepareRuntimeLibraries: async () => {},
  });
  const started = performance.now();
  let unsubscribe: (() => void) | undefined;
  const observe = (processor: NodeCreatedProcessor['processor']) => {
    if (request.observeNodes)
      unsubscribe = processor.on('nodeStart', ({ node }) => emit({ kind: 'node', nodeId: node.id }));
  };
  if (request.action) {
    const action = request.action;
    const prepared = await prepareRivetWebAppAction(definition.project, {
      uiGraph: action.uiGraph,
      componentId: action.componentId,
      state: action.state,
      storage: action.storage,
      createProcessorOptions: { ...runtime, context: request.context },
    });
    let recorder: ExecutionRecorder | undefined;
    const result: PrototypeResult = { status: 'failed', durationMs: 0 };
    try {
      recorder = request.recording ? new ExecutionRecorder() : undefined;
      recorder?.record(prepared.processor);
      observe(prepared.processor);
      emit({ kind: 'prepared' });
      signal.throwIfAborted();
      emit({ kind: 'started' });
      try {
        const foreground = await prepared.run();
        // Delivery/encoding failure must not release a thread with an active tail.
        // Encode beside the graph, never by cloning arbitrary intermediate values.
        emit({ kind: 'foreground', json: JSON.stringify(foreground) });
      } catch (error) {
        result.failure = prototypeFailure(error);
      }
      const output = await prepared.processor.waitForRunCompletion();
      result.status = getExecutionOutputStatus(output);
    } catch (error) {
      result.failure = prototypeFailure(error);
    } finally {
      result.durationMs = performance.now() - started;
      result.cost = getExecutionRunCostSnapshot(prepared.processor);
      try {
        if (recorder && !prepared.processor.isRunning) result.recording = recorder.serialize();
      } catch (error) {
        result.captureError = prototypeFailure(error);
      }
      unsubscribe?.();
      prepared.dispose();
      // A settled result authorizes reuse. Fail fatally (retire the thread) if
      // its terminal Promise unexpectedly rejects before physical settlement.
      if (prepared.processor.isRunning) throw new Error('Prototype action did not physically settle.');
    }
    return result;
  }
  const processor = createProcessor(definition.project, {
    ...runtime,
    graph: request.graph,
    inputs,
    context: request.context,
    returnWhenGraphOutputsReady: true,
  });
  observe(processor.processor);
  const session = new ExecutionSession(processor, { recording: request.recording ?? false });
  try {
    signal.throwIfAborted();
    emit({ kind: 'started' });
    const snapshot = await session.run((outputs) => emit({ kind: 'foreground', json: responseJson(outputs) }));
    if (processor.processor.isRunning) throw new Error('Prototype endpoint did not physically settle.');
    const result: PrototypeResult = {
      status: snapshot.status,
      durationMs: snapshot.durationMs,
      cost: snapshot.cost,
      ...(snapshot.failure ? { failure: prototypeFailure(snapshot.failure.error) } : {}),
    };
    try {
      if (snapshot.recorder) result.recording = snapshot.recorder.serialize();
    } catch (error) {
      result.captureError = prototypeFailure(error);
    }
    return result;
  } finally {
    unsubscribe?.();
    processor.dispose();
  }
}
