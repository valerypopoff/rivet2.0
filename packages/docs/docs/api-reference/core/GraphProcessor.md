---
title: GraphProcessor
---

# `GraphProcessor`

## Description

`GraphProcessor` is the low-level execution engine for a Rivet graph. It walks the graph, resolves node inputs, executes node implementations, runs subgraphs, tracks events, handles control flow, and returns graph outputs as [DataValue](./DataValue) records.

Most integrations should use the higher-level helpers from `@valerypopoff/rivet2-node`, such as `runGraph`, `runGraphInFile`, or `createProcessor`. Use `GraphProcessor` directly when you are building a runtime, debugger, executor, test harness, or custom embedding that needs direct access to execution events and lifecycle controls.

## Constructor

```typescript
new GraphProcessor(
  project: Project,
  graphId: GraphId | undefined,
  registry: NodeRegistration<any, any>,
  includeTrace?: boolean,
  options?: {
    captureNodeTimings?: boolean;
    concurrency?: GraphProcessorConcurrency;
  },
);
```

### project

Type: `Project`

The Rivet project that contains the graph to run.

### graphId

Type: `GraphId | undefined`

The graph ID to run. If `undefined`, the processor uses `project.metadata.mainGraphId`. The constructor throws if it cannot resolve a graph.

### registry

Type: `NodeRegistration<any, any>`

The node registry used to instantiate built-in and plugin node implementations.

### includeTrace

Type: `boolean | undefined`

Controls whether `trace` events are emitted. The current default is trace-enabled unless explicitly disabled.

### options.captureNodeTimings

Type: `boolean`

When `true`, `nodeFinish` and `nodeError` events include `durationMs` metadata for actual node processing. Split-run nodes also include `splitRunDurationMs`, keyed by split item index. The default is `false`. This does not add node output ports, change graph outputs, or write anything to project files.

### options.concurrency

Type: `GraphProcessorConcurrency`

Controls processor-level concurrency.

```typescript
export type GraphProcessorConcurrency = {
  nodeConcurrency?: number;
  splitRunConcurrency?: number;
};
```

`nodeConcurrency` defaults to `8`. `splitRunConcurrency` defaults to `4`. Invalid, non-finite, or values below `1` fall back to the default. Node-level `Max concurrent runs` can override split-run concurrency for a specific many-runs node.

## Running a Graph

```typescript
const outputs = await processor.processGraph(context, inputs, contextValues);
```

### processGraph(context, inputs?, contextValues?)

```typescript
processGraph(
  context: ProcessContext,
  inputs?: Record<string, DataValue>,
  contextValues?: Record<string, DataValue>,
): Promise<GraphOutputs>
```

Runs the selected graph and resolves with graph outputs.

`inputs` are values for Graph Input nodes in the main graph. `contextValues` are values available to Context nodes throughout the graph and all subgraphs. Context nodes coerce their resolved runtime value or fallback default to the node's configured data type before emitting an output.

`processGraph` throws if the processor is already running. A `GraphProcessor` instance is intended for one active run at a time.

When the run succeeds, GraphProcessor adds a `cost` output if the graph did not already produce one.

`cost` stays a numeric DataValue containing known USD costs from LLMs,
Decision AI nodes, and other cost-producing nodes. When known costs are accounted,
`costBreakdown` is also returned as an object DataValue:

```json
{
  "cost": { "type": "number", "value": 0.23 },
  "costBreakdown": { "type": "object", "value": { "llm": 0.2, "classifier": 0.03, "other": 0 } }
}
```

Usage-output settings do not disable accounting. Nested graph/tool costs retain
their categories. Missing prices mean these are incomplete known subtotals, not
an invoice. Graph Outputs named `cost` or `costBreakdown` override the matching
derived output. Early results are snapshots; terminal results include managed
background work that finishes later.

Live editor cache hits add no new cost; their cached Usage evidence may still
describe the original request. Invalid negative/non-finite node costs are ignored.

## ProcessContext

`ProcessContext` provides host/runtime services to nodes:

```typescript
export type ProcessContext = {
  settings: Settings;
  nativeApi?: NativeApi;
  datasetProvider?: DatasetProvider;
  mcpProvider?: MCPProvider;
  audioProvider?: AudioProvider;
  tokenizer: Tokenizer;
  codeRunner?: CodeRunner;
  projectReferenceLoader?: ProjectReferenceLoader;
  projectPath?: string;
  editorExecutionCache?: Map<string, unknown>;
  getChatNodeEndpoint?: (
    configuredEndpoint: string,
    configuredModel: string,
  ) => ChatNodeEndpointInfo | Promise<ChatNodeEndpointInfo>;
};
```

If the project has `references`, `projectReferenceLoader` is required. `projectPath` is used by loaders that resolve references or file-relative behavior.

## Outputs and Inputs

```typescript
export type GraphOutputs = Record<string, DataValue>;
export type GraphInputs = Record<string, DataValue>;
export type Inputs = Record<PortId, DataValue | undefined>;
export type Outputs = Record<PortId, DataValue | undefined>;
```

`GraphOutputs` is keyed by Graph Output ID. Node-level `Inputs` and `Outputs` are keyed by port ID.

## Events

`GraphProcessor` exposes Emittery methods:

```typescript
processor.on(eventName, listener);
processor.off(eventName, listener);
processor.once(eventName);
processor.onAny(listener);
processor.offAny(listener);
```

The main event map is `ProcessEvents`:

| Event                | When it fires                                                                                                         |
| -------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `start`              | Root graph processing starts.                                                                                         |
| `graphStart`         | A graph or subgraph starts.                                                                                           |
| `graphFinish`        | A graph or subgraph finishes.                                                                                         |
| `graphError`         | A graph or subgraph fails.                                                                                            |
| `graphAbort`         | A graph is aborted.                                                                                                   |
| `nodeStart`          | A node starts with resolved inputs.                                                                                   |
| `nodeFinish`         | A node finishes with outputs.                                                                                         |
| `nodeError`          | A node errors.                                                                                                        |
| `nodeExcluded`       | A node is skipped due to disabled state, conditional state, control-flow exclusion, or an unconnected required input. |
| `partialOutput`      | A node emits partial output while still running.                                                                      |
| `nodeOutputsCleared` | Previously displayed outputs for a node should be cleared.                                                            |
| `userInput`          | A User Input node is waiting for user input.                                                                          |
| `error`              | Root graph execution fails.                                                                                           |
| `done`               | Root graph execution completes successfully.                                                                          |
| `abort`              | Root graph execution is aborted.                                                                                      |
| `finish`             | Root graph processing has finished, successful or not.                                                                |
| `trace`              | A trace message is emitted when trace is enabled.                                                                     |
| `pause`              | The processor is paused.                                                                                              |
| `resume`             | The processor is resumed.                                                                                             |
| `globalSet`          | A graph global value is set.                                                                                          |
| `newAbortController` | A node-level AbortController is created.                                                                              |
| `userEvent:${name}`  | A custom user event is raised.                                                                                        |
| `globalSet:${id}`    | A specific graph global value is set.                                                                                 |

Most event payloads include `execution` metadata:

```typescript
export type GraphExecutionMetadata = {
  rootRunId: RootRunId;
  graphRunId: GraphRunId;
  graphId: GraphId;
  parentGraphRunId?: GraphRunId;
  executor?: {
    nodeId: NodeId;
    parentGraphId: GraphId;
    processId: ProcessId;
    splitIndex?: number;
  };
};
```

This identifies the root run, current graph invocation, parent subgraph invocation, and the Subgraph node that invoked the current graph when relevant.

## Async Event Stream

```typescript
for await (const event of processor.events()) {
  console.log(event.type, event);
}
```

`events()` returns an async generator of `ProcessEvent` objects. Each object has a `type` field plus the event payload. The generator ends after the root `finish` event.

## Lifecycle Controls

### abort(successful?, error?)

```typescript
await processor.abort(successful, error);
```

Aborts the current run. If `successful` is `true`, the graph is treated as intentionally stopped rather than failed. If `error` is provided, it is used as the abort error.

### pause()

Pauses graph processing before the next node execution.

### resume()

Resumes a paused processor.

### isRunning

Read-only getter that reports whether the processor is currently running.

### setSlowMode(slowMode)

Sets the public `slowMode` flag. This is used by UI/debugging flows that need slower execution visualization.

## User Input

When a User Input node requests values, GraphProcessor emits a `userInput` event. Respond either by calling the event payload's `callback`, or by calling:

```typescript
processor.userInput(nodeId, {
  type: 'string[]',
  value: ['answer one', 'answer two'],
});
```

The call is also forwarded to active subprocessors so nested graphs can receive input.

## User Events

```typescript
processor.onUserEvent('approved', (value) => {
  console.log(value);
});

processor.offUserEvent(listener);
```

`onUserEvent` listens for `userEvent:${name}` events. Nodes can raise user events through their process context, and external code can raise them directly:

```typescript
processor.raiseEvent('approved', { type: 'boolean', value: true });
```

`raiseEvent` is propagated through subprocessors.

## External Functions

```typescript
processor.setExternalFunction('lookupCustomer', async (context, customerId) => {
  return {
    type: 'object',
    value: await lookupCustomer(customerId),
  };
});
```

External functions are available to External Call nodes by name. The function receives an `ExternalFunctionProcessContext` and any graph-provided arguments, and must return a `Promise<DataValue & { cost?: number }>` or throw.

GraphProcessor also registers a default `echo` external function.

## Run-To and Preloaded Partial Execution

GraphProcessor exposes `runToNodeIds` for targeted execution:

```typescript
processor.runToNodeIds = [nodeId];
```

`runToNodeIds` restricts execution to the dependencies needed to reach the selected node or nodes.

Editor "Run from here" is built outside the core processor by calculating explicit `runToNodeIds` plus preloaded boundary inputs. Programmatic callers should use that same explicit shape instead of relying on `runFromNodeId`.

## Preloading Node Data

```typescript
processor.preloadNodeData(nodeId, {
  output: { type: 'string', value: 'already computed' },
});
```

`preloadNodeData` marks a node as already visited and stores its outputs. Every preloaded output must be a valid `DataValue`.

This is mainly used by editor partial reruns. Do not preload a node that should execute in the upcoming run; preload only the already-computed boundary inputs that the targeted run should reuse. The Rivet editor also preserves output snapshots for nodes outside the rerun slice so their previous values remain visible, but that preservation is UI state and does not change `GraphProcessor` results.

## Dependencies

```typescript
const dependencies = processor.getDependencyNodesDeep(nodeId);
```

Returns all node IDs that the given node depends on. This method preprocesses the graph if needed.

## Recording Replay

```typescript
const outputs = await processor.replayRecording(recorder);
```

Replays a recorded execution through processor events and returns graph outputs. The `recordingPlaybackChatLatency` property controls the delay between replayed chat/node-finish events. The default is `1000` milliseconds.

## Subprocessors

Subgraph nodes create child `GraphProcessor` instances internally. Subprocessors share execution cache, external functions, globals, context values, pause/resume state, and execution lineage with the root processor.

Call `getRootProcessor()` from processor-aware code when you need the top-level processor for a nested run.

## Advanced Properties

| Property                       | Purpose                                                                                                   |
| ------------------------------ | --------------------------------------------------------------------------------------------------------- |
| `id`                           | Generated processor instance ID.                                                                          |
| `executor`                     | Optional runtime label: `'nodejs'` or `'browser'`.                                                        |
| `runToNodeIds`                 | Optional target nodes for run-to-node execution.                                                          |
| `runFromNodeId`                | Legacy editor field. Current scheduling uses explicit `runToNodeIds` plus `preloadNodeData(...)` instead. |
| `recordingPlaybackChatLatency` | Replay delay in milliseconds. Default `1000`.                                                             |
| `warnOnInvalidGraph`           | Enables graph preprocessing warnings for invalid graph structures.                                        |
| `slowMode`                     | Public flag for slow/debug visualization. Prefer `setSlowMode(...)`.                                      |

## Direct Use Example

```typescript
import { GraphProcessor, globalRivetNodeRegistry, type DataValue } from '@valerypopoff/rivet2-core';
import { loadProjectFromFile } from '@valerypopoff/rivet2-node';

const project = await loadProjectFromFile('./workflow.rivet-project');
const processor = new GraphProcessor(project, project.metadata.mainGraphId, globalRivetNodeRegistry, true, {
  concurrency: {
    nodeConcurrency: 8,
    splitRunConcurrency: 4,
  },
});

processor.on('nodeError', ({ node, error }) => {
  console.error(`Node failed: ${node.title}`, error);
});

const outputs = await processor.processGraph(
  {
    settings: {},
    tokenizer,
  },
  {
    prompt: { type: 'string', value: 'Hello' } satisfies DataValue,
  },
);
```

This example omits most host services. Real runtimes usually provide a full `ProcessContext`, or use `createProcessor` / `runGraph` from `@valerypopoff/rivet2-node` so Node defaults are supplied.

## See Also

- [DataValue](./DataValue)
- [NodeGraph](./NodeGraph)
- [Project](./Project)
- [Settings](./Settings)
- [RunGraphOptions](../node/RunGraphOptions)
