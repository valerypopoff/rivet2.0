# Execution Data Flow and Graph View Identity

> Internal reference for how graph execution, subgraph runs, navigation context,
> and node data storage interact in the desktop app.
>
> This document exists because the interaction between these systems has been
> a recurring source of bugs. Understanding the key mismatch between "how you
> navigated to a graph" and "how execution data was stored for that graph" is
> essential for working in this area.

## Overview

When a graph executes, the app must:

1. Record which graphs ran, how many times, and in what context (root vs subgraph).
2. Store per-node execution data (inputs, outputs, status) tagged with enough identity to filter it later.
3. Let the user navigate to any graph and see the correct execution data for the context they're viewing.
4. Let the user switch between multiple runs of the same graph (the "run switcher").

These four concerns are handled by separate but tightly coupled systems. The coupling
is where bugs tend to hide.

## Per-Node Run Duration Metadata

Node run duration display is an app preference layered over execution events. The persisted setting lives in [`showNodeRunDurationsState`](../packages/app/src/state/settings.ts) with storage key `showNodeRunDurations` and default `false`. It is not part of core `Settings`, project YAML, node data, output definitions, or DataValue output maps.

When the setting is on, Browser/editor runs pass `captureNodeTimings: true` to [`GraphProcessor`](../packages/core/src/model/GraphProcessor.ts), and Node executor runs send `captureNodeTimings` through the app-executor debugger run message. The app-executor explicitly defaults missing run messages to `captureNodeTimings: false` because its internal WebSocket transport uses the debugger server even for ordinary Node executor runs.

External Remote Debugger runs are different: a backend that calls `createProcessor(..., { remoteDebugger })` captures durations by default unless it explicitly passes `captureNodeTimings: false`, because the external backend cannot know the local viewer's display setting. The app still shows or hides incoming `durationMs` solely according to `showNodeRunDurationsState`.

`durationMs` is stored in transient `NodeRunDataBase` and preserved by [`storeNodeDataForHistory(...)`](../packages/app/src/utils/executionDataStorage.ts) so graph-run history, remote-debugger data, and recording replay use the same output surfaces. Terminal updates intentionally preserve an explicit `durationMs: undefined` when timings are disabled so merged process data clears stale timing metadata instead of carrying it into a later no-timing run. Split-run item timings are stored beside it as transient `splitRunDurationMs`, keyed by split item index, because many parallel/sequential runs are one node process with aggregate output arrays rather than several `ProcessDataForNode` entries.

[`NodeRunDurationMeta`](../packages/app/src/components/nodeOutput/NodeRunDurationMeta.tsx) renders `Duration: {n}ms` for single-process inline and fullscreen node outputs. When the same node has multiple visible process runs or split-run item timings, `NodeRunDurationSummaryMeta` renders `Total duration: {n}ms` followed by one `Run {n}: {n}ms` line per finished run, and the selected process suppresses its duplicate single-duration line. The pure visibility/view-model layer receives an explicit `showNodeRunDuration` option so duration-only terminal runs can become visible only when the setting is enabled. Nodes with their own runtime-like output ports (`subGraph`, `callGraph`, `referencedGraphAlias`, and legacy `chat`) suppress this extra metadata line to avoid duplicate duration display. Custom renderers for those nodes must render their own split-run metric arrays when they hide the raw metric ports; for example, the Subgraph renderer formats `duration: number[]` and `cost: number[]` outputs as total values plus one run line per split item.

Copy actions intentionally ignore run-duration metadata. The ordinary copy button and JSON-copy button continue to serialize displayed output values / internal output maps only.

## Parked Subgraph Output-Demand Execution Data

Subgraph and Referenced Graph Alias output-demand pruning is currently disabled
by `GRAPH_BOUNDARY_OUTPUT_DEMAND_OPTIMIZATION_ENABLED`. With the flag off, child
graphs execute fully and unconnected child `Graph Output` branches still emit
their normal lifecycle/data events. Recording, Remote Debugger, graph-run
history, cost, and duration therefore reflect the full child execution.

The parked implementation still computes the metadata it needs for later
re-enablement. When the flag is turned back on, Subgraph and Referenced Graph
Alias runs execute only the child `Graph Output` branches whose caller output
ports are connected to at least one active immediate downstream node. A
downstream node counts as active when it exists, is not disabled, and is part of
the current run-to slice if the run is targeted. Unrequested child boundary
outputs are written on the caller node as `control-flow-excluded` values so the
output panel can show that those outputs did not run. Skipped child branches do
not emit child `nodeStart`, `nodeFinish`, `nodeError`, or `nodeExcluded` events
because the child nodes were never scheduled. The child graph is still executed
fully when the Subgraph node itself is the direct run-to target, when Subgraph
partial-output forwarding is enabled, or when an enabled `Error` output is
actively connected and must represent errors from the whole child graph.

## Frozen Node Outputs

Freeze node output is editor-only execution state. It is not graph data, is not written to `.rivet-project` YAML, and is not included in persisted opened-project editor state. The active project stores frozen outputs in `frozenNodeOutputsState`; `useProjectExecutionSnapshots` captures and restores that atom together with the other in-memory execution view state when switching open projects. Closing/replacing a project, deleting a graph, deleting a folder of graphs, deleting a node, choosing `Unfreeze node output`, or accepting the first execution event from an external Remote Debugger run must remove the matching frozen entries.

Frozen entries are scoped by graph id and node id inside each project execution snapshot. Freezing a node restores all currently retained successful output instances for the selected graph-run context through the execution-data ref reader, then stores cloned runtime `Outputs[]` maps. This is deliberately separate from `ProcessDataForNode` / output refs so normal execution-history retention can prune old pages without invalidating the frozen value while the project remains open. If execution memory already pruned a referenced output, capture fails and the app should leave the node unfrozen.

The concrete `FrozenNodeOutputsByGraph` shape is graph id -> node id -> `Outputs[]`, and each `Outputs` map is keyed by a real port id (`PortId`). Tests and helpers should build frozen fixtures with branded port ids such as `['output' as PortId]`; using an unbranded object key like `output` can pass loose runtime checks but fails the TypeScript project build because it is not a typed `Outputs` map.

The app only offers new freezes for replayable data-producing nodes. It blocks Comment, Abort Graph, Graph Output, Create Dataset, Append to Dataset, Replace Dataset, Raise Event, and Play Audio because those nodes either have no meaningful replayable output, define graph boundaries, or depend on graph aborts, dataset mutations, or host side effects that frozen replay intentionally does not perform. Unfreeze should remain available for any stale frozen entry so the user can clear in-memory state.

Browser execution can replay any frozen value that `structuredClone(...)` can clone. Internal Node executor runs must additionally send the frozen snapshot through the app-to-executor JSON run message, so Node-mode freezes and internal executor run payloads validate that frozen outputs are transport-safe. Explicit JavaScript `undefined` values are encoded with debugger transport sentinels and decoded by the internal Node executor before replay, including optional `undefined` fields inside LLM message objects. Values such as `BigInt`, circular references, `NaN`, infinities, functions, symbols, typed arrays, and class instances should fail before the run message is sent instead of breaking or lossy-serializing through the executor websocket path.

Replay is not `preloadNodeData(...)`. A frozen node still receives its real current inputs in `nodeStart`, emits a normal `nodeFinish`, uses a normal process id, writes `nodeResults`, and schedules downstream nodes exactly like a computed node. The core frozen-output resolver resets its replay counter per graph run and keys lookup by the processor's current graph id plus node id. If a node is invoked more times within the same graph run than there are captured output instances, the resolver reuses the last captured output. A node inside a reusable subgraph is therefore frozen for every invocation of that graph node while the project remains open.

The Browser and internal Node live run-from paths treat frozen boundary outputs as available preload data. If a boundary dependency has both previous execution history and frozen output data, the frozen output wins. Preload event suppression remains unchanged; frozen boundary data is only used to seed the run boundary and must not create duplicate output pages. Live `Run to here` also preserves visible execution data for frozen nodes that are outside the selected target's dependency slice, so a frozen node does not visually lose its output when the user runs to an unrelated node. Frozen nodes inside the run-to slice are allowed to replay normally and update through the ordinary node lifecycle. External Remote Debugger runs, recording playback, and Trivet/test execution do not consult frozen outputs, even for run-from preload planning or run-to visual preservation. While an external Remote Debugger target is selected, `VisualNode` hides frozen presentation state without clearing it; if the user disconnects before any accepted remote execution event arrives, the same frozen outputs become visible again. Once an accepted external Remote Debugger run event arrives, the active `useRemoteExecutor` subscriber clears visible `frozenNodeOutputsState`, and `ExecutorSessionProvider` applies the same flush to inactive project execution snapshots so stale local frozen data cannot reappear after remote execution has replaced that project's run history.

## Key Concept: Graph View Identity

The same graph definition can execute in multiple distinct contexts:

- As a **root graph** (the user clicked "Run" on it directly).
- As a **subgraph** called from node X in parent graph A.
- As a **subgraph** called from node Y in parent graph B.
- As a **subgraph** called from the same node but during different split-run iterations.

Each of these is a different **graph view**. The app tracks views through `GraphViewContext`:

```typescript
// packages/app/src/domain/graphEditing/navigationActions.ts

type GraphViewContext = {
  key: GraphViewKey; // Unique string identifier
  graphId: GraphId; // Which graph definition
  parent?: {
    parentGraphId: GraphId;
    parentNodeId: NodeId;
  };
};
```

### Key formats

| Context    | Key format                                             | `parent`                          |
| ---------- | ------------------------------------------------------ | --------------------------------- |
| Root graph | `root:${graphId}`                                      | `undefined`                       |
| Subgraph   | `subgraph:${parentGraphId}:${parentNodeId}:${graphId}` | `{ parentGraphId, parentNodeId }` |

This distinction matters because execution data is **stored by the key that the
execution engine computes** (always a subgraph key when the graph runs as a subgraph),
but the user may **navigate to that graph using a different key** (a root key, if
they click it in the sidebar).

## The Key Mismatch Problem

This is the single most important thing to understand in this area.

### How execution stores data

When a subgraph executes, the engine emits events with `GraphExecutionMetadata`
that includes an `executor` field:

```typescript
// packages/core/src/model/ProcessContext.ts

type SubgraphExecutorMetadata = {
  nodeId: NodeId; // The subgraph node that invoked this
  parentGraphId: GraphId; // The parent graph
  processId: ProcessId;
  splitIndex?: number; // For split-run: which iteration
};

type GraphExecutionMetadata = {
  rootRunId: RootRunId;
  graphRunId: GraphRunId;
  graphId: GraphId;
  parentGraphRunId?: GraphRunId;
  executor?: SubgraphExecutorMetadata;
};
```

The app converts this metadata into a `GraphViewKey` via `buildGraphViewKeyFromExecution()`:

```typescript
// packages/app/src/utils/executionIdentity.ts

// When executor is present (subgraph execution):
//   key = "subgraph:${parentGraphId}:${nodeId}:${graphId}"
// When executor is absent (root execution):
//   key = "root:${graphId}"
```

This key is used to store **graph run records** in `graphRunHistoryByViewState[key]`.

Per-node data (`ProcessDataForNode`) is tagged with `graphRunId` only, not with
`graphViewKey`. The filtering pipeline uses the resolved `graphRunId` from the run
switcher to select the correct node data for display.

### How navigation creates view context

The user can navigate to a graph in two broad ways:

1. **Sidebar click / Go to Node / most navigation paths**: Creates `createRootGraphViewContext(graphId)`; key is `root:${graphId}`.

2. **Direct Subgraph node navigation**: The Subgraph node header link and
   `"Go to subgraph"` context-menu action both flow through
   `useGoToSubgraphNode(...)`. They create
   `createSubgraphGraphViewContext(...)`; key is
   `subgraph:${parentGraphId}:${nodeId}:${graphId}`.

Only path (2) produces a key that matches the execution-stored key. Path (1) produces
a root key that does **not** match.

### The result

If the user navigates to a subgraph via the sidebar after execution:

- `currentGraphView.key` = `root:${subgraphId}`
- Execution data is stored under `subgraph:${parentId}:${nodeId}:${subgraphId}`
- A direct key lookup would find nothing

If nested graph execution history is stored with only the child `graphId`, the
inverse can also happen in normal editor runs or Remote Debugger runs:

- `currentGraphView.key` = `subgraph:${parentId}:${nodeId}:${subgraphId}` because the user clicked "Go to subgraph" from the caller node
- Execution history may be stored under `root:${subgraphId}` because the app only has the child `graphId` for that record
- Strict parent/executor matching finds nothing even though the child graph did run

### How this is solved

The mismatch is handled in one place: **`getGraphRunsForView()`** in
`executionSelectors.ts`. It collects direct graph-view key matches,
executor-matched runs for explicit "Go to subgraph" contexts, and broader
same-`graphId` matches. Direct or executor matches are preferred when they
provide multiple runs, because they preserve the most precise caller context
while still giving the user an execution switcher. A single direct or executor
match does not hide a broader same-graph history; otherwise "Go to subgraph"
can open without the execution switcher even though the sidebar view of the same
graph can see repeated invocations. If a graph was also run directly as a root
graph, or the same child graph was called from another Subgraph node, the app
cannot distinguish those records during the broad fallback, so they can appear
together until reliable direct/executor metadata is available.

Once the correct `graphRunId` is resolved via the run switcher, all downstream
filtering uses `graphRunId` only:

- **`filterProcessDataForSelection()`** filters node data by `graphRunId`.
- **`setSelectedNodePageLatest()`** matches by `graphId` to decide whether to
  auto-follow the latest execution.

**When modifying `getGraphRunsForView`, preserve its fallback logic.** It is how
the app works for the most common navigation path (sidebar click to view a subgraph
after execution).

## Execution Identity Chain

### How IDs are created

```
User clicks "Run" on main graph
`- GraphProcessor created
   |- rootRunId = nanoid()        // Shared across entire execution tree
   |- graphRunId = nanoid()       // This processor's unique run ID
   |- graphId = main graph ID
   `- executor = undefined        // This is the root
      |
      |- Subgraph node executes
      |  `- #createSubProcessor()
      |     |- rootRunId = inherited from parent
      |     |- graphRunId = nanoid()       // Fresh ID for this subgraph run
      |     |- graphId = subgraph ID
      |     |- parentGraphRunId = parent's graphRunId
      |     `- executor = {
      |          nodeId: subgraph node ID,
      |          parentGraphId: parent graph ID,
      |          processId: ...,
      |          splitIndex: 0              // If split-run
      |        }
      |
      `- Same subgraph node, split iteration 2
         `- #createSubProcessor()
            |- rootRunId = same as above
            |- graphRunId = nanoid()       // Different from iteration 1
            |- parentGraphRunId = same parent
            `- executor.splitIndex = 1
```

### How events flow

Events from subprocessors bubble up through `wireSubprocessorEvents()` in
`SubprocessorBridge.ts`. The key behavior:

- Child processor emits events with **its own** `GraphExecutionMetadata`.
- `wireSubprocessorEvents` forwards those events to the parent's emitter **without rewriting metadata**.
- Passive child process-event forwarding stays subscribed for the subprocessor object lifetime. This keeps late terminal events from successful graph-abort paths flowing even when they arrive after the child graph's own `graphFinish`.
- Control lifecycle wiring, such as parent/child pause, resume, and abort listeners, uses a run-scoped lifecycle subscription and tears down when the forwarded processor's own `graphRunId` finishes, aborts, or errors. A nested child graph finishing must not clean up the parent subgraph bridge, because the parent still needs to forward the subgraph node's later `nodeFinish` and the parent graph's own finish event.
- The app's event handlers see the original metadata and can determine the execution context.

This means the root processor's event emitter receives events from the entire
execution tree, all with correct lineage metadata.

```
SubProcessor emits nodeStart({ execution: { graphRunId: "child-run", ... } })
  `- wireSubprocessorEvents forwards to parentEmitter
     `- parentEmitter.emit('nodeStart', same event)
        `- App handler: onNodeStart(event)
           `- setDataForNode(nodeId, processId, event.execution, data)
              `- Stores with graphRunId from event.execution
```

For **local execution** (`useLocalExecutor`), events are received directly on the
root processor via `attachGraphEvents()`. Browser processors are owned in a
project-keyed map, so one open project tab can keep running in Browser mode
while another tab starts its own Browser run. The event handlers compare the
run's project id to the currently visible project: visible events go through the
normal dispatcher, inactive open-project events are reduced into that project's
execution snapshot, and events for a project that has since been closed are
ignored after that processor is aborted and removed. The local executor also
removes the closed project's editor-execution cache with the processor map entry,
because Browser-mode execution caches are project-tab runtime state, not durable
project data.

For **remote execution** (`useRemoteExecutor`), events arrive as WebSocket messages
from `app-executor`. The sidecar serializes processor events including full
execution metadata; app-only observability messages such as `codeConsole` are
handled separately and are not treated as replayable execution events.
`createProcessEventDispatcher()` deserializes and dispatches processor events to
the same handler functions.

Remote execution is routed through project-keyed executor-session runtimes rather
than through Remote Debugger globals. `ExecutorSessionProvider` owns an
in-memory runtime registry keyed by `project.metadata.id`; the default hooks
resolve the active project's runtime, while cleanup paths can address a specific
project id. This lets several open project tabs keep external Remote Debugger or
internal Node executor websockets connected at the same time, including tabs
that use the same `ws://`/`wss://` URL and port. Target replacement is still
local to one project's runtime: reconnecting the same project to a new target
replaces only that project's socket, and closing/replacing a project removes
only that project's runtime. Browser execution has no session target, but it
follows the same project ownership rule through `useLocalExecutor`'s
project-keyed processor map.

Each runtime exposes an explicit target:

- `internal-desktop`: the desktop/Tauri Node executor sidecar.
- `internal-hosted`: a wrapper-provided internal executor URL from
  `RivetAppHost`'s `executor.internalExecutorUrl`.
- `external-debugger`: a user-connected Remote Debugger endpoint.

Browser execution has no executor-session target. UI code maps the selected
executor, loaded recording state, session target/status, and `canSendRun`
capability into a product state such as `browser-ready`,
`internal-node-ready`, or `external-debugger-ready`. A websocket status of
`ready` is not enough by itself for UI run readiness; the ready product states
also require the active session to be able to send a run command. This prevents
a hosted internal executor reconnect from being displayed as a Remote Debugger
reconnect. ActionBar visibility then applies product policy on top of transport
capability: external Remote Debugger sessions show the stop/debugger affordance
but disable editor-side run entrypoints, while Browser and internal Node
executor sessions keep Run visibility aligned with readiness.

Executor-session target identity inside a single project runtime is `type + url`,
not URL alone. Reconnecting the same project to the same target reuses the
existing websocket when possible, while connecting that project to the same URL
as a different target emits a replacement lifecycle event and resets
capabilities before the new socket opens. The same URL in a different open
project is not a replacement; it is a separate project runtime and a separate
websocket. If the same target has a stale or closing websocket that cannot be
reused, that handoff also uses the explicit `replaced` lifecycle path so old
pending graph executions are rejected before the new socket is created.
Replacement disconnect events report the old target and the post-transition
`idle` status visible to subscribers. Target factories, internal/external
classification, labels, and equality live in `executorSessionTarget.ts`; session
code should not compare URLs directly.

Transport features are exposed as session capabilities. For example,
`canSendRun` controls whether remote run commands can be sent, `canUploadProject`
replaces older direct `remoteUploadAllowed` checks for project uploads, and
`canRecordSocket` gates Gentrace socket recording. Remote graph execution,
Trivet remote runs, remote user-input replies, editor startup preload data
bundled into run messages, live preload messages for already-attached processors,
and remote abort/pause/resume commands check those capabilities at action time
before sending protocol messages and then verify that the websocket accepted the send.
Gentrace records through `recordSocketEvents(...)`, so feature code no longer
reads the session socket from UI state. Raw socket/status fields are still
available to low-level runtime code and tests, but product UI should use the
selector and capability layer.

`useRemoteExecutor` caches the last successfully uploaded
project/settings/static-data payload per executor session. Upload cache decisions
are planned in `remoteExecutorUploadCache.ts`: `planRemoteExecutorProjectUpload`
compares the session key, derived project graph/plugin state, resolved runtime
settings, and sorted static project data before the hook sends anything.
Identical consecutive runs can therefore send only the lightweight `run`
message, while graph edits, settings/env changes, static data changes, or a new
session force a fresh upload. The imperative upload path sends dynamic project
data first, then each static-data payload, and marks the cache fresh only after
every send succeeds. The cache is cleared on executor connect/disconnect, and
failed project or static-data sends do not update it.

Remote run request ids are managed by `remoteExecutorRunRequest.ts`.
Editor graph runs register one active request id before sending the `run`
message; request-scoped process events are dispatched only when their request id
matches that active request. The active request id is stored on the
project-scoped executor runtime as well as the mounted `useRemoteExecutor`
hook, so a project tab that becomes visible again while its Node/Remote run is
still in flight can resume routing terminal events and abort responses for that
same run. Remote control messages (`abort`, `pause`, `resume`, and
`user-input`) include that active request id when available, and the Node
debugger server filters attached processors by request id before invoking the
control method. This is required when two open tabs share the same internal
Node executor or external Remote Debugger URL: a control action from one tab
must not pause, resume, abort, or answer a processor owned by another tab.
Legacy/unscoped controls remain accepted for older clients or manually attached
processors without request ids.

Legacy/unscoped external-debugger events are scoped by the `start` event's
project id when that id is available: runs for a different open project are
ignored, and the root-run decision is remembered for the follow-up node/graph
events. Root graph completion also carries that decision forward to the
following unscoped terminal frame (`done`, `abort`, or top-level `error`),
because those legacy terminal frames do not include execution metadata
themselves. The remembered root-run route stays active until that terminal
frame is consumed, so late node terminal messages for the accepted root are not
rerouted just because another external-debugger project started between root
`graphFinish` and `done`. A bounded recently-completed route cache keeps the
same decision briefly after terminal completion too, so a late node terminal
frame can still repair display state without being routed through a newer
project run. Duplicate root graph terminal frames are deduped for both route
decisions and successful-`done` reconciliation, because only one legacy
terminal frame can correspond to a root run. Events from older transports that
do not carry a project id keep the compatibility fallback and still pass
through. `done`, `abort`, `error`, disconnect, and send-failure paths clear the
active request explicitly.
Trivet/test runs use the executor-session pending-promise API and reject that
pending request if the `run` send fails before reaching the socket, so the
failure is observed through the same async result path as normal remote test-run
completion.

Inside the shared session runtime, request ownership is split by transport
policy. `executorSession.ts` coordinates socket generations, state transitions,
and reconnect scheduling. `executorSessionTransport.ts` owns protocol JSON
classification and safe websocket sends, `executorSessionDatasetBridge.ts` owns
dataset request/response dispatch, `executorSessionPendingExecutions.ts` owns
pending graph-run promise maps, and `executorSessionCallbackIsolation.ts` owns
failure-isolated callback fan-out. These helpers are app-private seams; they
preserve the existing websocket message shapes rather than introducing a new
protocol layer.

Executor-session callbacks are failure-isolated. Lifecycle subscribers,
process-message subscribers, and the renderer state-change callback are invoked
from snapshots, and both synchronous throws and asynchronous promise rejections
are logged without toast notifications. Dataset provider requests also run
behind the same non-toast error boundary and use safe websocket sends, so a
provider failure or closed socket cannot become an unhandled renderer rejection
after the graph execution has already moved on. If websocket construction itself
fails, for example because a typed external debugger URL is malformed, the
runtime clears the attempted target back to idle and the Remote Debugger command
surface reports the connection failure instead of leaving stale session state
behind.

`useExecutorSessionCoordinator` owns active-project connection policy. It starts/restores the
internal Node executor when Node mode is selected, falls back to Browser mode in
plain web contexts without a hosted internal executor URL, and restores only the
internal Node executor after an external Remote Debugger disconnects while Node
mode is selected. `useRemoteDebugger` is limited to the explicit external
debugger command surface. Startup decisions go through
`getExecutorSessionStartupAction(...)`, and side effects go through
`runExecutorSessionStartupAction(...)` so hosted executor connects, Browser
fallback, desktop sidecar readiness, and cleanup-before-ready cancellation all
share one tested path.
Coordinator startup and cleanup must not replace or disconnect an existing
external Remote Debugger or internal Node runtime during tab switches. It may
start missing internal executor sessions for the newly active project, but
destructive cleanup happens only when the user explicitly switches that project
to Browser mode, the project closes/replaces, or the provider shuts down.
Desktop sidecar startup is asynchronous, so the coordinator also rechecks the
runtime target after the sidecar is ready; a Remote Debugger connection that
arrives while the sidecar is starting must win over the late internal-executor
continuation.
The external-debugger disconnect restore path uses the same desktop sidecar
startup/ownership helper as normal Node-mode startup. Do not restore desktop
Node mode by calling `connectInternalDesktopExecutor()` directly unless sidecar
ownership has already been established for that project runtime.
The desktop Node sidecar is process-wide but its ownership is tracked per
project runtime through `executorSessionRuntimeResources.ts`. Starting the same
project runtime twice does not double-count the sidecar consumer; removing a
project runtime releases only that runtime's sidecar ownership, so another
Node-mode project tab can keep using the same sidecar.
Inside that shared sidecar, uploaded project/settings/static-data state and
dataset proxy providers are also scoped by websocket client. `app-executor`
uses `startDebuggerServer`'s `getClientDebuggerState` and
`getDatasetProviderForClient` hooks, then passes the same client-local
`DebuggerDatasetProvider` into the processor for that run. This prevents one
Node-mode project tab from overwriting another tab's uploaded project or
satisfying another tab's pending dataset request.
The sidecar wraps the debugger object passed into `createProcessor(...)` so the
processor is associated with its websocket client during the debugger `attach`
call itself. Do not move this ownership registration after processor
construction: `createProcessor(...)` attaches immediately, and a startup-time
control message must already route to the new processor.
Switching a project runtime from desktop Node to a hosted internal executor URL
must invalidate pending desktop startup and release that runtime's sidecar
ownership before the hosted socket connects, otherwise a late desktop startup
can replace the hosted target.
Execution-event rendering has two paths. The active project still uses
`useRemoteExecutor` or `useLocalExecutor` and the normal
`createProcessEventDispatcher(...)` path so UI-only behaviors such as
diagnostics, frozen-output flushing, user-input modals, local toast display,
Browser recording UI, and code-console logging stay tied to the visible editor. Inactive project tabs
are handled by project snapshot reducers: `ExecutorSessionProvider` subscribes
to every Node/Remote project runtime, while `useLocalExecutor` routes inactive
Browser processor events directly. Both paths reduce accepted process events
through `projectExecutionSnapshotRouting.ts`, which delegates the per-event
state transition to `projectExecutionSnapshotEvents.ts`, into that project's
stored execution snapshot. This keeps hidden Browser/Node/Remote Debugger runs from getting stuck
on spinners when the user switches tabs before `nodeFinish`, `graphFinish`, or
`done` arrives. Browser runs that fail before a normal processor terminal event
must still reduce an `error` terminal into the owning inactive snapshot, otherwise
a background tab can remain visually running forever. The hidden reducer mirrors
the same execution-data ref storage,
pending user-input question storage, hidden Browser-run recording storage, and
successful-`done` stale-running reconciliation as the visible path, but it does
not show active-project-only UI surfaces. Request-scoped terminal messages still settle their pending promise
even when they are not the active graph-run request, so hidden remote test or
auxiliary runs can complete without being rendered into the tab snapshot.
Unscoped terminal messages settle pending promises only when the routing
decision accepted the run for that project. Restoring a hidden project's
execution snapshot also restores any pending user-input questions for that
project. `useGraphExecutor` owns the global user-input submit handler and
installs the currently selected executor's submit path, so answering a restored
prompt sends the answer to the active project's Browser/Node/Remote processor
instead of whichever project last started a run. A `useRemoteExecutor`
subscription and the local Browser event router must also check that their
project is still the active project before writing visible execution atoms or
calling `currentExecution.onStop()` from cleanup; inactive events belong to the
project snapshot reducer, and closed-project events should be ignored instead of
creating fresh hidden snapshots.
The disconnect restore path is tested through
`handleExecutorSessionCoordinatorDisconnect(...)`, which reads the latest
selected executor and hosted executor URL at lifecycle-event time instead of
using the render snapshot that created the subscription.

The runtime owns the current session snapshot. [`executorSessionRevisionState`](../packages/app/src/state/execution.ts)
is only a transient render tick, not a storage-backed source of active URL,
upload permission, connection status, or target classification. The durable
Remote Debugger field is [`debuggerDefaultUrlState`](../packages/app/src/state/settings.ts),
which remembers the default URL shown in the connect panel. `buildSessionState()`
keeps optional legacy parameters for source-level compatibility, but ignores
them; the returned state is always derived from the runtime.

## State Storage

### Graph run history

```typescript
// packages/app/src/state/dataFlow.ts

graphRunHistoryByViewState = atom<Record<GraphViewKey, GraphRunRecord[]>>({});
```

Each `GraphRunRecord` contains:

```typescript
{
  graphRunId: GraphRunId;
  rootRunId: RootRunId;
  graphId: GraphId;
  parentGraphRunId?: GraphRunId;
  executor?: SubgraphExecutorMetadata;
  startedAt?: number;
  finishedAt?: number;
  status?: 'running' | 'ok' | 'error' | 'aborted';
}
```

Records are created in `onGraphStart` and updated in `onGraphFinish`/`onGraphError`/`onGraphAbort`.

On new execution start (`onStart`), all history is cleared (unless running Trivet tests).

### Graph run selection

```typescript
selectedGraphRunByViewState = atom<Record<GraphViewKey, GraphRunSelection>>({});
// where GraphRunSelection = GraphRunId | 'latest'
```

- Defaults to `'latest'` (follow the most recent run).
- Set to a specific `GraphRunId` when the user clicks a historical run in the run switcher.
- When a new run starts for a view, the selection is preserved if it was an explicit
  historical selection. If it was `'latest'` or unset, it stays `'latest'`.

### Per-node execution data

```typescript
lastRunDataByNodeState = atom<Record<NodeId, ProcessDataForNode[]>>({});
```

Each `ProcessDataForNode` contains:

```typescript
{
  processId: ProcessId;
  rootRunId?: RootRunId;
  graphRunId?: GraphRunId;
  graphId?: GraphId;
  data: {
    debugData?: {
      codeSource?: string;
      expressionSource?: string;
      extractObjectPathSource?: string;
      extractObjectPathUsePathInput?: boolean;
      jsListCallbackBodySource?: string;
    };
    inputData?: Record<PortId, StoredDataValue>;
    outputData?: Record<PortId, StoredDataValue>;
    splitOutputData?: Record<number, Record<PortId, StoredDataValue>>;
    status?: { type: 'ok' | 'error' | 'running' | 'interrupted' | 'notRan', ... };
    startedAt?: number;
    finishedAt?: number;
  };
}
```

Data is keyed by `processId` within the node's array. A node can have multiple
entries from different graph runs or split-run iterations.
For one `processId`, terminal node updates (`nodeFinish`, `nodeError`,
`nodeExcluded`, or interruption) are one-way. `setDataForNode` may still merge
late input/debug data from a `nodeStart` frame, but it must not let that stale
start frame put the process back into `running`, replace terminal outputs, or
move terminal timing fields forward. This protects Remote Debugger and
recording playback display from transport or replay ordering quirks without
changing runtime graph execution.
Running updates are normalized before storage so a malformed running frame cannot
write output refs before the terminal merge guard discards those output fields.
External Remote Debugger sessions also keep a bounded diagnostic trace of
incoming process-event routing decisions plus a per-process lifecycle ledger.
The trace records metadata only, not full input/output values, and is dumped to
the browser console only when successful-`done` reconciliation has to synthesize
the missing-terminal-event warning. The top-level warning is a copy-friendly
multiline report with diagnosis hints, exact and related process lifecycles,
exact and related process traces, root-run trace tail, and recent trace tail.
The same structured data is attached to the warning, and the collapsed details
group includes console tables plus raw trace entries. This gives hosted-wrapper
investigations enough signal to tell whether the terminal event never arrived,
arrived but was routed away, arrived under mismatched nested graph metadata, or
arrived and was dispatched while state/display still stayed running.
If an accepted Remote Debugger `nodeError` carries an abort-like error such as
`Error: Aborted` or `AbortError: The operation was aborted`, the app prints a
separate unexpected-abort diagnostic immediately. That report uses the same
bounded trace and lifecycle ledger, but it points debugging at runtime
cancellation propagation rather than websocket event loss.
Accepted `nodeExcluded` frames can also be diagnostic. When the exclusion reason
is `Graph aborted successfully`, `Race branch lost`, `input is excluded value`,
or the excluded node is a Code/Expression/Subgraph node, the app prints a
`Node excluded` report with the exclusion reason and the same trace context. That
keeps control-flow/exclusion failures visible even when the terminal event was
received cleanly and there is no missing-terminal warning.

Subgraph event forwarding is deliberately longer-lived than subgraph graph
completion. [`SubprocessorBridge.ts`](../packages/core/src/model/SubprocessorBridge.ts)
keeps process-event forwarding subscribed for the lifetime of the subprocessor
object because successful graph-abort paths can emit node terminal events for
aborted branches just after their own `graphFinish`. Without that, an ordinary
node such as Expression, or a nested Subgraph node, can start, the child graph
can complete through a successful early-exit path, and the parent Remote Debugger
stream can miss the aborted branch's terminal event.
If an already-started node produces outputs after a successful non-race abort,
the core emits its normal `nodeFinish` so the editor can show the value, but that
late finish does not queue dependents because the graph is already terminal.
If an already-started node is actually interrupted by that successful abort, its
`nodeExcluded` terminal also does not queue dependents because there is no
longer a live graph path to continue.
Parallel and sequential split-run nodes also check the shared abort state before
processing each item, so a successful graph abort cannot launch additional split
work after the terminal path has already been chosen.
Work that is actually interrupted is reported as `nodeExcluded`, not as
`nodeError`, because the graph already has a valid successful terminal path.
`Abort Graph` successful early exits use reason `Graph aborted successfully`;
`Race Inputs` losing branches use reason `Race branch lost`. Nested
subprocessors receive the same internal successful-abort reason so an aborted
Expression inside a leaf Subgraph clears as excluded instead of rendering as a
false workflow error.
Control listeners, including parent/child pause, resume, and abort wiring, still
clean up at the subprocessor's own graph terminal event; only passive event
forwarding stays alive.

Most nodes leave `debugData` empty. The current notable exceptions are app-side
presentation/debug affordances: `Code (legacy)` and `Code` snapshot `codeSource` so
the selected failed run can highlight the matching editor line, `Expression`
snapshots `expressionSource` for historical `Parsed expression` rendering,
`Extract Object Path` snapshots `extractObjectPathSource` and
`extractObjectPathUsePathInput` for stored-path parsed-source rendering, and `JS
Filter` / `JS Map` snapshot `jsListCallbackBodySource` for their callback
parsed-source preview. These snapshots are stored only in app execution history;
they are not part of the core graph-output contract used by programmatic
workflow execution.

`StoredDataValue` is an app-only wrapper around execution payloads:

- small values stay inline as `{ type, storage: 'inline', value }`
- oversized text-like values and media values become `{ type, storage: 'ref', refId, preview }`
- the full payload for ref-backed values lives in the in-memory `globalDataRefs` cache

Execution-scoped ref ids are stable per project, process, and port when project
identity is available:

- `execution:${projectId}:${nodeId}:${processId}:input:${portId}`
- `execution:${projectId}:${nodeId}:${processId}:output:${portId}`
- `execution:${projectId}:${nodeId}:${processId}:output:${splitIndex}:${portId}`

This matters because streaming `partialOutput` updates overwrite the same ref entry instead of
allocating a new blob key on every event, project tabs can keep independent
in-memory output snapshots, and run resets can clear all execution-scoped refs
deterministically. Low-level storage helpers still tolerate a missing project id
for isolated tests or legacy app-private callers.

## Data Filtering for Display

When rendering node output or execution status, the app filters the node's
`ProcessDataForNode[]` array through a two-stage pipeline:

```
All ProcessDataForNode[] for this node
  |
  |- Stage 1: Filter by selected graphRunId
  |  First use exact process.graphRunId === resolvedSelectedGraphRunId matches.
  |  If exact matches are present, ignore untagged records so stale or
  |  metadata-poor entries cannot mix into the selected graph run.
  |  If no process entries have graphRunId at all, keep legacy/untagged data.
  |  If other graphRunId-tagged entries exist but the selected run has none,
  |  show no node data for that selected graph run.
  |
  `- Stage 2: Page selection
     Pick entry by page index or 'latest'. Numeric page selections are clamped
     to the filtered process list so a page chosen in another graph run cannot
     make the current run appear empty.
```

The `resolvedSelectedGraphRunId` comes from the run switcher, which uses
`getGraphRunsForView()` to resolve the correct runs for the current view
(handling the key mismatch described above).

Inline node outputs keep a short replacement grace window to avoid flicker when
stored refs are being swapped during execution. That grace is scoped to the
resolved selected graph run, so changing the subgraph execution selector does not
temporarily reuse visible output from the previously selected invocation.

This pipeline is implemented across:

- `filterProcessDataForSelection()` in `executionSelectors.ts` (stage 1)
- `getSelectedProcessData()` in `executionSelectors.ts` (stage 2)

The graph selection inputs (`graphRuns` and `selectedGraphRun`) are computed
once via the `resolvedGraphSelectionState` derived atom in `dataFlow.ts` and
shared across all consuming components.

- Consumers: `NodeOutput`, `VisualNode`, `PortInfo`, `WireLayer`, and zoomed-out
  node content.
- `VisualNode` resolves `selectedProcessRun` once from that shared selection state and passes
  it down into `NormalVisualNodeContent` and `ZoomedOutVisualNodeContent` rather than having
  those children resubscribe and recompute the same selection locally.

## The Run Switcher

`GraphExecutionSelectorBar` renders when a graph view has more than one run:

```typescript
const graphRuns = getGraphRunsForView({ currentGraphView, graphRunHistoryByView });

if (!currentGraphView || graphRuns.length <= 1) {
  return null; // No switcher needed
}

// Render prev/next buttons and "Execution: N/M" indicator
```

The control is fixed in the same top canvas row as the main run controls, uses
the same scaled action height, and follows the graph-search panel's dark
bordered surface style. Its stacking order stays below graph search so an open
search panel always wins when the two overlays occupy the same row.

The run switcher updates `selectedGraphRunByViewState[currentGraphView.key]`:

- Moving to the last run sets selection to `'latest'`.
- Moving to any other run sets it to a specific `GraphRunId`.

## Split-Run vs Subgraph Runs

These are related but different concepts:

### Split-run (pager within a single node)

- A node marked `isSplitRun: true` processes array inputs item-by-item.
- All iterations share the same `processId` and `graphRunId`.
- Each iteration's output is stored in `splitOutputData[index]`.
- The UI shows a pager ("page 1 of N") within the node's output panel.
- Split-output renderers sort those indexes numerically through `packages/app/src/components/nodeOutput/splitOutputEntries.ts`; do not rely on object-key order or string sorting for display order.
- This is **not** multiple graph runs; it is one node execution with indexed outputs.

### Subgraph runs (multiple entries in run history)

- A subgraph node creates a child `GraphProcessor` for each invocation.
- Each invocation gets a unique `graphRunId`.
- When combined with split-run (subgraph node is split), you get N subgraph runs.
- The UI shows a run switcher ("1 / N") at the top of the canvas when viewing that subgraph.
- Each run has its own complete set of node execution data.

### Combined scenario

When a split-run subgraph node processes an array of 3 items:

```
Main graph run (graphRunId: "gr-1")
  `- Subgraph node (split-run, 3 iterations)
     |- Iteration 0: subgraph run (graphRunId: "gr-2", splitIndex: 0)
     |- Iteration 1: subgraph run (graphRunId: "gr-3", splitIndex: 1)
     `- Iteration 2: subgraph run (graphRunId: "gr-4", splitIndex: 2)
```

In the main graph view: the subgraph node shows a pager with 3 split outputs.
In the subgraph view: the run switcher shows "1 / 3" and the user can inspect
each iteration's complete internal execution.

## Navigation and View Context

### Navigation stack

```typescript
// packages/app/src/state/graphBuilder.ts

graphNavigationStackState = atom<GraphNavigationStack>({
  stack: GraphViewContext[],
  index?: number
});

// packages/app/src/state/dataFlow.ts

currentGraphViewState = atom((get) => {
  const nav = get(graphNavigationStackState);
  return nav.index != null ? nav.stack[nav.index] : undefined;
});
```

### Navigation paths and their view contexts

| Action                                               | View context created             | Key format                              |
| ---------------------------------------------------- | -------------------------------- | --------------------------------------- |
| Click graph in sidebar                               | `createRootGraphViewContext`     | `root:${graphId}`                       |
| "Go to node" (search)                                | `createRootGraphViewContext`     | `root:${graphId}`                       |
| Back/forward browser buttons                         | Restored from stack              | Whatever was stored                     |
| Subgraph header link / "Go to subgraph" context menu | `createSubgraphGraphViewContext` | `subgraph:${parent}:${node}:${graphId}` |
| Load project                                         | `createRootGraphViewContext`     | `root:${graphId}`                       |

The Subgraph header link and the Subgraph node context-menu action are the
intentional direct Subgraph navigation paths that create a subgraph view
context. Sidebar graph clicks, search "Go to node", project load, and most
other navigation paths create root contexts.

### Viewport per view

The active canvas still renders from `canvasPositionState`, but remembered graph view is
now persisted separately in `projectEditorStateByProjectIdState`.

Important nuance:

- remembered editor view is keyed by `project.metadata.id`, then by `graphId`
- each persisted entry stores both the `GraphNavigationStack` and per-graph canvas positions
- `useSyncCurrentProjectEditorState` mirrors `graphNavigationStackState` and `canvasPositionState`
  into that project-scoped store, so programmatic viewport moves are captured too
- `useRestorePersistedWorkspace` restores the remembered graph/subgraph context and viewport once on
  boot without re-running the full project-load side effects
- `lastCanvasPositionByGraphState` remains as a same-session runtime cache and compatibility
  fallback for graph switching, but it is no longer the authoritative reopen source

Switching between views therefore prefers the current project's persisted canvas positions, then
falls back to the legacy cache, and centers/resets only when neither has a saved viewport.

## Event Handler Registration

### Local execution (`useLocalExecutor`)

```typescript
attachGraphEvents(processor, currentExecution);
// currentExecution comes from useGraphExecutionEvents + useNodeExecutionEvents
```

All events from the entire execution tree arrive on the root processor's emitter
(via SubprocessorBridge forwarding).

### Remote execution (`useRemoteExecutor`)

```typescript
const eventDispatcher = createProcessEventDispatcher(currentExecution);
// WebSocket messages dispatched through eventDispatcher
```

The sidecar serializes events with full metadata. The dispatcher reconstructs
and routes them to the same handler functions.

The remote execution client pipeline is layered intentionally:

- `useRemoteExecutor` remains the React adapter. It reads atoms/providers, gets
  the current executor-session runtime, resolves environment-backed settings,
  subscribes to process messages, and updates `useCurrentExecution()`.
- `remoteExecutorUploadCache.ts` owns pure upload decisions plus the imperative
  send-and-mark-fresh path for project/settings/static data.
- `remoteExecutorRunRequest.ts` owns request-id creation/registration helpers,
  active-request event filtering, completion cleanup, and pending test-run
  send-failure cleanup.
- `remoteExecutorHelpers.ts` owns pure run-from planning, preload extraction,
  Trivet selection, and process-event dispatcher construction.

Gentrace remote runs are intentionally outside this editor/test-run pipeline.
They use `recordSocketEvents(...)` to capture the raw executor socket stream for
Gentrace recording, so they should keep their separate capability and recording
contract unless that feature is refactored directly.

Local and remote editor run-from execution share the same explicit run plan:

- `getEditorRunFromPlan(...)` in `remoteExecutorHelpers.ts` finds the selected node plus downstream nodes to run, the downstream terminal nodes to pass as `runToNodeIds`, and the already-computed boundary inputs to preload
- `getDependentDataForNodeForPreload(...)` restores the latest available boundary outputs from stored history. A stored output map only counts as available when it contains at least one real port wrapper; legacy/malformed maps whose ports are all absent/nullish are skipped instead of preloading an empty output object.
- `useLocalExecutor` applies the restored boundary data with `processor.preloadNodeData(...)` before starting the targeted processor run
- `useRemoteExecutor` sends `runToNodeIds` and restored `preloadData` together in the debugger `run` message so the app executor can create the processor, preload it, and then run it
- before that run emits `start`, the executor hook tells the execution-data layer which prior node snapshots are outside the rerun slice. `onStart` preserves those snapshots and clears only nodes that will be recalculated, so untouched upstream outputs stay visible and can still seed later editor run-from actions.
- `GraphProcessor.preloadNodeData(...)` still emits `nodeStart`/`nodeFinish` with `processId: 'preload'` for its generic event contract. During editor run-from, `useNodeExecutionEvents` suppresses those preload node events for the boundary nodes that were already preserved, so reused boundary outputs do not appear as duplicate previous/next history pages.
- editor `Run to here` keeps its existing execution semantics: it passes only `runToNodeIds` to the processor and does not preload ordinary previous outputs. The app still computes the target dependency slice through `getEditorRunToPlan(...)` so `onStart` can preserve existing visible output pages for frozen nodes that are outside that slice; this is display preservation only, not a preload input to the processor.

### Lifecycle

- `onStart`: Clears run history and selection state. It clears prior run data for full runs, but editor run-from starts preserve prior node snapshots that are outside the rerun slice, and editor run-to starts preserve frozen node snapshots outside the run-to dependency slice.
- `onGraphStart`: Creates a `GraphRunRecord` in history.
- `onGraphFinish`/`onGraphError`/`onGraphAbort`: Updates the record's status through a shared `finishGraphRun(...)` helper in `useGraphExecutionEvents`.
- `onNodeStart`/`onNodeFinish`/`onNodeExcluded`/`onPartialOutput`/`onNodeError`: Store per-node data.
- `onDone`: Marks graph as no longer running.

Persisted app-side execution payloads now share one storage/preview utility layer before being cloned into history:

- `sanitizeInputsOrOutputs(...)` in `executionDataSanitization.ts` fixes Uint8Array-shaped values without destructively truncating them
- `storeNodeDataForHistory(...)` / `storeInputsOrOutputsForHistory(...)` in `executionDataStorage.ts` decide whether each payload stays inline or moves into `globalDataRefs`
- `storeInputsOrOutputsForHistory(...)` stores only actual per-port `DataValue` payloads. A missing/nullish port entry is treated as absent and skipped, while explicit runtime values such as `{ type: 'any', value: undefined }` remain real payloads because the wrapper object exists. Generic renderers, node-specific output renderers, port inspectors, Chat Viewer, display-copy, node-specific copy projectors, and JSON-copy readers preserve that same distinction so malformed absent wrappers do not appear as user-authored `undefined` values.
- `getStorageDecision(...)` in `executionDataPreview.ts` owns preview thresholds, text/json excerpts, encoded hints, media/chat summaries, and defensive inline fallback for malformed typed payloads, so an invalid node output can stay inline for debugging instead of throwing an unhandled UI error while the graph itself has already finished
- ref cleanup in `executionDataStorage.ts` must distinguish node-run records from stored port maps by checking that `inputData`, `outputData`, or `splitOutputData` are actual stored port maps. Port ids such as `status`, `inputData`, `outputData`, and `splitOutputData` are valid output names and must still have their refs collected and deleted like ordinary ports. Legacy/malformed split-output maps may contain nullish split entries; ref cleanup should skip those entries without misclassifying the whole node-run record and losing refs from sibling split entries.
- downstream UI consumers must preserve that boundary: output visibility checks, `RenderDataValue`, custom node output bodies, port inspectors, Chat Viewer prompt/response lookup, Prompt Designer attached-node hydration, run-cost totals, `Copy value`, and `globalDataRefs` sizing all use the shared runtime guards in `dataValuePayloads.ts` or explicit nullish-wrapper guards to tolerate malformed inline/ref payloads and render or fall back instead of assuming the static `DataValue` type was honored at runtime
- explicit `{ type: 'any', value: undefined }` output is real display data, not a missing payload. Shared rendering and display-oriented copy should show the literal text `undefined`; explicit `any[]` arrays should apply the same projection to each item. Large ref-backed `any[]` previews and fullscreen-search text should use the same display projection so undefined items stay findable instead of becoming JSON `null`. That projection must stay cycle-safe and fall back through the existing defensive JSON/string path for circular arrays. Absent `DataValue` wrappers, malformed typed payloads, and `control-flow-excluded` remain separate fallback/exclusion cases.
- `globalDataRefs` still uses compact JSON for cache-size fallback accounting; pretty-printing helpers are display-only and should not affect LRU sizing
- `storeNodeDataForHistory(...)` only writes fields that are explicitly present, so start-time payloads such as `inputData` and small debug snapshots survive later finish/error updates instead of being overwritten with `undefined`
- `useNodeExecutionEvents` uses that shared path for started, finished, excluded, and partial-output persistence
- split-run partial outputs still keep their separate `splitOutputData[index]` storage model, but they now reuse the same storage transform and stable ref-id scheme before persistence. Render/copy helpers should only prefer split output data when at least one split entry contains a real visible stored port wrapper; an empty split map, warnings-only split map, or internal-port-only split map from partial outputs must not hide a later valid `outputData` payload.
- `onStart`, `onTrivetStart`, and node-output clearing paths clear the corresponding execution-scoped refs when they wipe prior run data
- error-only and timing-only node-run records can legitimately have no stored input/output payloads. Ref collection and cleanup must treat those records as node-run metadata with zero refs, not as malformed port maps, so one failed node cannot break the next run-start cleanup.
- `executionDataStorage.ts` is the low-level storage/restore boundary. App-side read/restore behavior goes through `executionDataReaders.ts` so UI and executor-preload code share the same displayed-output restore, port-level restore/coercion, and warning extraction logic.
- Preview-only or editor-assist consumers that interpolate stored inputs for display, such as Code, Expression, JS list, Extract Object Path parsed-source sections, and Prompt Designer attached-node hydration, should use `tryRestoreStoredPortMap(...)`. Missing ref-backed inputs are skipped port-by-port so available inputs still render in the parsed preview or editor assist surface, while an entirely unavailable input map simply removes the optional detail instead of breaking the visible output value. Strict `restoreStoredPortMap(...)` remains appropriate for executor preload paths that must fail loudly when required boundary data has been evicted.
- display-oriented `Copy value` serialization is exported from `executionDataCopyValue.ts`, with implementation split under `executionDataCopy/`: visible `DataValue` projection in `projectDataValue.ts`, port/split serialization in `serializeDisplayedOutputs.ts`, and labelled copy metadata in `displayCopySections.ts`. It projects restored outputs into user-facing copy text instead of serializing raw `DataValue` wrappers. A single visible output copies the displayed value text; multiple visible outputs copy labelled sections using output-definition titles, matching the node/fullscreen output layout closely enough for pasted text to read like the UI. Node-specific copy projectors should use `displayCopySections(...)` for multi-section text so ordinary object values are never confused with copy metadata. Generic display-copy restores each visible port independently so a missing ref-backed value copies the same "Value no longer available in memory." fallback the renderer shows instead of failing the whole copy action. Warning and `__internalPort_*` outputs are not body output ports; `outputPortVisibility.ts` keeps generic render, split-output selection, and display-copy aligned on that rule. Custom copy projectors are only called for output maps and split-output entries that pass that visible-wrapper check; otherwise projectors with default text, such as loop-controller continue status, can create copy text for output that the UI did not render. Warning messages render through the dedicated output-warning UI in both inline and fullscreen output surfaces instead of being treated as ordinary body ports. The fullscreen `JSON` action remains the internal-representation path and copies the restored output map with `DataValue` wrappers. Its restore order deliberately prefers split output data only when at least one visible split body port exists, falls back to valid final `outputData`, and only then restores hidden-only split data when that is the only stored representation; this keeps warnings/internal split maps from blanking valid final output while still letting JSON copy/export inspect warning-only split runs.
- inline and fullscreen output surfaces use `nodeOutputViewModel.ts` as the app-level view-model boundary for selected process data, output/error/custom-error state, warning sections, generic output-section metadata, body-source selection, display-copy text, and JSON-copy payloads. The view model treats absent wrappers and hidden-only output maps as empty body content while keeping warnings as dedicated warning sections. It also owns generic output-section policy: visible-port filtering, compact first-port selection, definition-title/fallback labels, and header visibility/sizing. Its generic section helper returns an ordered section list; renderer-only details such as React keys and counter calculation stay in [`RenderDataOutputs`](../packages/app/src/components/nodeOutput/RenderDataOutputs.tsx). `NodeInlineOutput.tsx` and `NodeFullscreenOutput.tsx` should stay focused on React layout and controls, while `renderNodeOutputBody.tsx` and `RenderDataOutputs` should render the body and sections chosen by the view model instead of recomputing split-output or section-label policy. Keep generic [`RenderDataValue`](../packages/app/src/components/RenderDataValue.tsx) focused on data-type rendering; it should not import node-output policy.
- nodes whose visible output shape differs from the raw output port map use `getCopyValueData` projectors from `nodeOutputCopyValueProjectors.ts` so copy behavior stays aligned with the custom output UI
- fullscreen node-output search also depends on the same restore/payload model: generic rendered text is searched from the current fullscreen page DOM through `fullscreenOutputSearch.ts`, while large ref-backed text/JSON-like previews participate through `LargeStoredValuePreview` search providers so search can target the full restored text instead of only the currently visible excerpt
- preload/run-from paths therefore restore ref-backed values back into full `DataValue` payloads through the shared reader layer before passing them to the executor, instead of each consumer hand-rolling `restoreStoredInputsOrOutputs(...)` calls. The selected run-from node is intentionally not preloaded, because the editor contract is to rerun the selected node and downstream nodes while reusing only boundary inputs from prior results.

## Browser vs Remote: Event Delivery and React Rendering

This section documents a critical difference between browser and remote execution
modes that is invisible from the handler code but determines whether the UI
updates during execution. **Getting this wrong causes the app to appear frozen
during browser-mode execution: no running indicators, no dataflow, no progress,
even though all state updates happen correctly (visible only after execution ends).**

### The core problem

React 18 batches all `setState` calls and only commits + paints at **macrotask
boundaries**. The browser's rendering pipeline (style -> layout -> paint ->
composite) runs between macrotasks, never in the middle of a microtask chain.

This distinction is irrelevant for remote execution but critical for browser
execution, because the two modes deliver events on fundamentally different
scheduling boundaries.

### Remote execution: natural macrotask boundaries

In remote/Node execution mode, each event arrives as a separate **WebSocket
message**. The browser delivers each message as its own macrotask:

```
[macrotask] WebSocket message: nodeStart  -> setState -> React commit -> browser paint
[macrotask] WebSocket message: nodeFinish -> setState -> React commit -> browser paint
[macrotask] WebSocket message: nodeStart  -> setState -> React commit -> browser paint
```

Each event gets its own render cycle automatically. No special handling is needed.

Node executor mode is available only in the desktop/Tauri app because it relies
on Tauri's sidecar launcher. When Node mode is selected, the renderer starts the
app-executor sidecar and waits until the sidecar reports that its websocket
server is listening before opening the internal websocket at
`ws://127.0.0.1:21889/internal`. The sidecar binds that internal debugger server
to `127.0.0.1` by default, matching the renderer URL and avoiding localhost
IPv4/IPv6 resolution mismatches. Hosted wrappers that run the executor in a
container can override the bind address with `--host` or `RIVET_EXECUTOR_HOST`,
and can override the default port with `--port` / `-p` or `RIVET_EXECUTOR_PORT`;
custom ports must be valid TCP ports from `1` to `65535`. The desktop app keeps
the loopback default. If the plain web app loads a stale
persisted Node executor preference, it resets to Browser mode instead of
attempting an internal sidecar connection that cannot be created in a normal
browser.

The app-executor prewarms its shared CodeRunner worker pool before announcing
that the executor websocket is ready. Ordinary Code (legacy), Code, and Expression
node runs use single-use workers from that pool, then terminate them and
replenish the pool in the background. This keeps fresh-worker isolation while
avoiding the common cold-start cost on minimal Node-executor workflows.
`RIVET_CODE_RUNNER_WORKER_POOL_SIZE` controls the number of prewarmed workers,
and `0` disables prewarming.
The shared pool is lazy outside the sidecar entrypoint, and idle workers are
unrefed plus guarded with error/exit cleanup so failed idle workers are dropped
and replenished without surfacing as executor process errors.

The app-executor worker code is intentionally split by ownership. [`AppExecutorWorkerCodeRunner.mts`](../packages/app-executor/bin/AppExecutorWorkerCodeRunner.mts)
is the orchestration adapter that implements the core `CodeRunner` interface,
prepares hosted runtime libraries, chooses worker execution versus the
`includeRivet` current-thread fallback, and passes the active run's console
bridge. [`codeRunnerWorkerPool.mts`](../packages/app-executor/bin/codeRunnerWorkerPool.mts)
owns pool configuration, shared prewarm/shutdown lifecycle, idle-worker checkout,
replenishment, stats, and cleanup. [`codeRunnerWorkerHost.mts`](../packages/app-executor/bin/codeRunnerWorkerHost.mts)
owns the string-evaluated worker source, worker creation, ready/result handling,
exit-before-result errors, worker console forwarding, and worker-error
deserialization. This keeps performance-sensitive pool policy separate from the
package-sensitive worker source while preserving fresh-worker isolation: after a
run starts, that worker is never returned to the idle pool.

If the user connects an external remote debugger while Node executor mode is
selected, that external websocket temporarily replaces the internal sidecar
session. Manual remote-debugger disconnect must restore the internal Node
executor session immediately when Node mode is still selected, using
`executor.internalExecutorUrl` in hosted shells or
`ws://127.0.0.1:21889/internal` in Tauri, so the Run button becomes usable again
without requiring a Browser -> Node mode toggle.

Hosted executor URLs are still internal executor sessions: callers must connect
them through `executorSession.connectInternalHostedExecutor(...)` or the
compatibility `connectInternal(...)` wrapper, not through the external
remote-debugger `connectExternalDebugger(...)` path, so ActionBar/debugger UI
does not mistake the hosted executor for a user-attached remote debugger.

Hosted wrappers that mount the editor through
[`RivetAppHost`](../packages/app/src/host.tsx) can opt back into Node executor
mode in a browser shell by passing `executor.internalExecutorUrl`. In that mode
the shared executor-session coordinator connects to the provided websocket URL
directly and skips Tauri sidecar start/stop ownership; all
run/upload/message handling continues through the same `useRemoteExecutor` and
executor-session runtime as the desktop app.

`executor.internalExecutorUrl` is also a UI/session classification contract. A
hosted executor URL connected as `internal-hosted` is treated as the active
internal Node executor, so manual remote-debugger disconnect restores that
session and the ActionBar keeps Node-mode run controls in an explicit disabled
loading state only while the internal executor is genuinely connecting. Hosted
internal executor reconnects must preserve that internal classification after
proxy, server, or idle websocket closes; otherwise `/ws/executor/internal` can
be misrepresented as a user-attached remote debugger. External remote debuggers
should continue to use the public `connectExternalDebugger(...)` path, and
remote-debugger UI should only show stop/debugger affordances for
external-debugger sessions. While an external Remote Debugger is connected or
connecting, the ActionBar hides editor-side run buttons, menu and
hotkey run commands no-op, and node `Run to here` / `Run from here` context-menu
items stay hidden; live execution data is expected to arrive from the remote
process instead.

The app-executor sidecar treats graph failures as request-scoped execution
events rather than process/session failures. If a dynamic run throws because a
node fails, provider setup fails, or plugin assembly fails, the sidecar sends an
`error` protocol message with the active request id, detaches that processor
from the debugger server, and keeps the websocket connection alive. The app can
then clear `graphRunningState` through the normal remote event dispatcher
without forcing the user to reconnect the Node executor.
The ActionBar intentionally keeps Node-mode Run controls rendered while the
internal sidecar is starting, connecting, or reconnecting; readiness only moves
the button into a disabled loading state that keeps its normal text and appends
the same ring indicator used by running node headers. It must not collapse the
control or make a handled node failure look like the executor UI disappeared.
This internal-executor rule must not be applied to
external Remote Debugger sessions, which replace editor-run controls with a
`Stop Remote Debugger` banner.
The app logs the internal Node executor lifecycle at the sidecar/session seam.
Sidecar spawn, readiness marker vs timeout fallback, socket close/reconnect
scheduling, disconnect requests, and skipped run attempts are runtime debug logs
gated by `rivet.debugRuntimeLogs`. These logs intentionally describe the phase
and internal/external target, not full graph input values or secrets.
Automatic reconnect is restricted to internal executor sessions. A user-attached
external Remote Debugger websocket that closes unexpectedly is not reopened by
Rivet itself. If Node executor mode is selected, the app shell may restore only
the internal Node executor session; Browser mode waits for an explicit Remote
Debugger Connect action. This keeps an open project from suddenly reopening a
remote debugger socket by itself.

Server-side Remote Debugger keepalive lives in the Node debugger server, not in
the app executor session. `startDebuggerServer` in
[`packages/node/src/debugger.ts`](../packages/node/src/debugger.ts) keeps
websocket server creation, message parsing, graph upload/run commands, dataset
forwarding, and public API assembly. Transport policy is split into focused
helpers:

- [`debuggerHeartbeat.ts`](../packages/node/src/debuggerHeartbeat.ts) sends
  WebSocket ping frames every `DEBUGGER_HEARTBEAT_INTERVAL_MS` and terminates
  sockets that do not pong within `DEBUGGER_HEARTBEAT_TIMEOUT_MS`. Inbound
  debugger messages and successful server-to-client debugger frames also reset
  an outstanding heartbeat wait, so a busy post-idle workflow broadcast is
  treated as transport activity instead of being killed by an older ping
  timeout.
- [`debuggerTransport.ts`](../packages/node/src/debuggerTransport.ts) owns
  best-effort server-to-client serialization, send, error emission, and failed
  socket termination. Connection-time frames and processor event broadcasts must
  never fail graph execution; serialization or websocket send failures are
  reported through the debugger `error` event, and only the failed websocket is
  terminated.
- [`debuggerPayloadSanitizer.ts`](../packages/node/src/debuggerPayloadSanitizer.ts)
  turns outgoing Remote Debugger payloads into display-safe JSON copies before
  serialization. Runtime event objects and graph outputs are not mutated.
  JSON-compatible branches are preserved, explicit `undefined` is encoded with
  a versioned debugger-transport sentinel and decoded by
  [`executorSessionTransport.ts`](../packages/app/src/hooks/executorSessionTransport.ts).
  User values that exactly match that sentinel envelope are escaped before send
  and restored after receipt so normal output data is not reinterpreted as
  transport metadata. Non-JSON-safe branches such as circular references,
  `BigInt`, functions, symbols, `NaN`, and infinities become clear placeholder
  strings. If this safety clone ever fails, `debuggerTransport.ts` tries to
  send a minimal lifecycle payload with a warning output instead of dropping the
  event.
- [`debuggerProcessorAttachments.ts`](../packages/node/src/debuggerProcessorAttachments.ts)
  owns `attach`/`detach` listener registration, request-id association,
  partial-output throttling, and root-`finish` auto-detach cleanup. Routing
  callbacks receive snapshots of the currently attached processors so external
  routing code cannot mutate the server's attachment list by accident.

The Node `createProcessor(..., { remoteDebugger })` helper re-attaches the same
processor at the start of each `run()` and calls `detach` in `finally`, so
reusing a processor object for multiple runs does not lose debugger events and
manual app-executor `detach` calls remain harmless no-ops after auto-detach.
This keeps hosted routes such as `/ws/latest-debugger` from looking idle to
proxy/CDN layers while preserving the app policy above: an external debugger
socket that truly closes is still treated as an external disconnect, not as
something Rivet should reopen automatically.

The app has a final reconciliation guard for successful debugger-style event
streams. When `done` is accepted but a displayed process from the just-finished
root run is still marked `running`,
[`graphExecutionEventHelpers.ts`](../packages/app/src/hooks/graphExecutionEventHelpers.ts)
marks that process terminal and adds a warning output explaining that the
terminal debugger event was not received. Metadata-rich runs scope this cleanup
by `rootRunId`; only legacy streams without execution metadata fall back to
broad cleanup. This keeps the editor from showing a completed remote workflow
as permanently running, but it is only a safety net; the server-side sanitizer
above should keep normal lifecycle events intact.

The renderer does not treat app-executor stderr as an execution-state signal.
The sidecar can write expected Node warnings or logged provider failures to
stderr while still delivering the request-scoped websocket `error` event. The
renderer records stdout/stderr byte counts as debug telemetry only; run state is
driven by `start`, `done`, `abort`, and `error` protocol messages.
The app-executor also logs top-level unhandled promise rejections and uncaught
exceptions. Startup-phase top-level failures still terminate the sidecar, while
late provider/stream failures after websocket startup are recorded without
terminating the sidecar after a graph failure has already been reported through
the normal request-scoped protocol.

The desktop app's internal Node sidecar also uses an app-executor-only
worker-backed `CodeRunner` for most Code-family JavaScript. That
keeps the sidecar event loop free to process independent nodes and emit their
`nodeFinish` events while an unrelated synchronous Code-family node is still
running. This does not change the public `@valerypopoff/rivet2-node` default
runner, and Code-family nodes that request the `Rivet` capability may still run
on the sidecar's current thread for compatibility.

Code-family `console` output in Node executor mode is an executor-session
message, not sidecar stdout. When the node's console permission is enabled, the
app-executor runner sends `codeConsole` messages for `debug`, `info`, `log`,
`warn`, and `error`; [`useRemoteExecutor`](../packages/app/src/hooks/useRemoteExecutor.ts)
only replays messages for the active editor run into the renderer console.

Code-family `require()` resolution has a stable hosted-runtime seam. Public
`NodeCodeRunner` and the app-executor worker runner default to resolving from the
process working directory, but `RIVET_CODE_RUNNER_REQUIRE_ROOT` can point them at
a runtime-library directory and `RIVET_CODE_RUNNER_REQUIRE_ANCHOR` can provide a
fully custom `.cjs` anchor path. This keeps hosted wrappers from patching runner
source while preserving the programmatic default for normal `@valerypopoff/rivet2-node`
callers.
For app-executor hosted runtimes, a bootstrap layer may also install
`globalThis.__RIVET_PREPARE_RUNTIME_LIBRARIES__`. The worker runner invokes that
hook before require-enabled or Rivet-capable Code-family nodes run, so hosted
wrappers can synchronize managed runtime-library artifacts just before module
resolution without rewriting Rivet's runner source.

### Browser execution: microtask avalanche

In browser execution mode, `GraphProcessor` runs in the same thread as React.
The processor uses **Emittery** for event emission and **PQueue** for node
processing concurrency. Both of these schedule work as **microtasks**:

- **Emittery's `emit()`** has `await resolvedPromise` before calling listeners,
  which defers all listener invocations to microtasks.
- **PQueue** chains node processing as further microtask continuations.

The result is that dozens or hundreds of events fire within the same macrotask,
with React batching all their `setState` calls. The browser never gets a chance
to repaint until the entire graph execution completes:

```
[macrotask] processGraph() starts
  [microtask] emit nodeStart  -> setState (batched, not committed)
  [microtask] emit nodeFinish -> setState (batched, not committed)
  [microtask] emit nodeStart  -> setState (batched, not committed)
  ... hundreds more microtasks ...
  [microtask] emit done       -> setState (batched, not committed)
[macrotask boundary] -> React commits ALL state -> browser paints ONCE
```

The user sees nothing change until execution is complete, then everything appears
at once.

### The solution: macrotask yielding

The fix has two parts that must work together:

**1. GraphProcessor must `await` its emits** (`GraphProcessor.ts`)

For `nodeStart`, `nodeFinish`, and terminal `nodeError`, the processor uses
`await this.#emitter.emit()` instead of `emitDetached()`. This makes the
processor pause until all listeners have completed. For `nodeStart` and
`nodeFinish`, that is what allows app listeners to yield for a browser paint.
For `nodeError`, the important contract is ordering: nested subgraph error
events must reach Remote Debugger clients before graph-level cleanup.

```typescript
// In #processNormalNode:
await this.#emitter.emit('nodeStart', ...);   // processor waits for listeners
// ... node processes ...
await this.#emitter.emit('nodeFinish', ...);  // processor waits again
await this.#emitter.emit('nodeError', ...);   // processor waits before graphError/done
```

Note: `emitDetached()` (which calls `void emitter.emit()`) is fire-and-forget:
the processor continues immediately regardless of what listeners do. With
`emitDetached`, a listener's `await yieldToMacrotask()` would pause only that
listener, not the processor. The processor would race ahead, emitting more events
before any yield completes.

**2. Local executor handlers must yield to the macrotask queue** (`useLocalExecutor.ts`)

Key event handlers (`nodeStart`, `nodeFinish`, `start`, `graphStart`) are async
and yield to the macrotask queue after updating state:

```typescript
function yieldToMacrotask(): Promise<void> {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => resolve();
    channel.port2.postMessage(undefined);
  });
}

processor.on('nodeStart', async (data) => {
  currentExecution.onNodeStart(data); // setState calls (batched by React)
  await yieldToMacrotask(); // pause -> React commits -> browser paints
});
```

`MessageChannel` posts a macrotask with near-zero latency (unlike `setTimeout(0)`
which has a >=4 ms minimum in browsers). The returned Promise resolves on the next
macrotask, which means:

1. The handler calls `setState` (React batches it).
2. `await yieldToMacrotask()` suspends the handler.
3. Since Emittery `await`s listener Promises, and the processor `await`s
   `emit()`, the entire processing chain is paused.
4. The microtask queue drains. The macrotask ends.
5. **React commits the batched state.** The browser paints.
6. The `MessageChannel` macrotask fires, resolving the Promise.
7. The handler resumes, Emittery resumes, and the processor continues.

### Why `flushSync` doesn't work

`flushSync` (from `react-dom`) forces React to synchronously commit state, but
it does **not** trigger a browser repaint. The browser repaint only happens at
macrotask boundaries. Since Emittery defers listeners to microtasks, even with
`flushSync` the DOM updates happen but the browser never paints them; the next
microtask (next event) starts before the browser can composite a frame.

### Subgraph event propagation

`wireSubprocessorEvents` in `SubprocessorBridge.ts` forwards child processor
events to the parent emitter by returning the Promise from
`parentEmitter.emit()`:

```typescript
processor.on('nodeStart', (event) => parentEmitter.emit('nodeStart', event));
//                                  ^ returns Promise
```

Because the child processor `await`s its own `emit()` calls, and those listeners
return the Promise from `parentEmitter.emit()`, and the parent's listeners yield
to macrotask, the pause propagates through the entire subprocessor tree. A
macrotask yield in a top-level handler pauses child processors too.

### Why only some events yield

Not all events need macrotask yields:

- **`nodeStart`, `nodeFinish`, `nodeError`**: Events that drive node lifecycle
  state and dataflow display. `nodeStart` and `nodeFinish` yield in the local
  executor for paint responsiveness. `nodeError` is still awaited by the
  processor, but the local app handler stays synchronous; the awaited boundary is
  there so graph-level terminal events cannot clean up subgraph bridges before
  the inner node error reaches the editor and Remote Debugger.
- **`start`, `graphStart`**: Set up initial execution context. Yielding here
  ensures the UI shows "running" state before node processing begins.
- **`done`, `abort`, etc.**: Terminal or infrequent graph-level events. By the
  time they fire, either the graph is finishing (one final paint is sufficient)
  or there is an error state. No extra UI yield is needed.

## Stale Closures in Browser Execution Handlers

### The problem

In browser execution mode, `attachGraphEvents()` in `useLocalExecutor` registers
event handlers **once** when the processor is created. These handlers close over
values from the render cycle in which `attachGraphEvents` was called.

In contrast, remote execution mode uses `useEffect` with a dependency array that
causes re-subscription on every relevant render, so handlers always have fresh
closure values.

This means any value captured by closure in a browser-mode handler will be stale
if it changes during execution. The most important case is
`setSelectedNodePageLatest` in `useExecutionDataFlow.ts`, which reads
`currentGraphView` and `selectedGraphRunByView` to decide whether to auto-follow
the latest execution page.

### The solution: `useLatest` refs

Values that must be current when read inside event handlers are wrapped with
`useLatest` (from `ahooks`), which stores the value in a ref that is updated on
every render:

```typescript
const currentGraphViewLatest = useLatest(currentGraphView);
const selectedGraphRunByViewLatest = useLatest(selectedGraphRunByView);

const setSelectedNodePageLatest = (nodeId, execution) => {
  const view = currentGraphViewLatest.current; // always fresh
  const selectionByView = selectedGraphRunByViewLatest.current; // always fresh
  // ...
};
```

This is safe because `setSelectedNodePageLatest` is only called from event
handlers (microtasks), and React updates refs synchronously during the commit
phase of the previous render, so by the time a handler reads the ref, it
reflects the latest committed state.

### When to use `useLatest` vs direct closure

- **Jotai `useSetAtom` setters** (e.g., `setLastRunData`): Safe to capture in
  closure. The setter identity is stable and functional updates (`prev => ...`)
  always receive the latest state.
- **Jotai `useAtomValue` values** (e.g., `currentGraphView`): Stale in
  long-lived handlers. Use `useLatest` if the handler needs the current value.
- **Callback refs from `useStableCallback`**: Already use refs internally, so
  they always call the latest version of the callback. Safe to capture.

## Recording and Replay

Execution recordings capture the full event stream so it can be replayed later
with the same data flow behavior as a live run.

### Recording (`ExecutionRecorder`)

`ExecutionRecorder` subscribes to every event on a `GraphProcessor` (or WebSocket
channel) and serializes each event into a `RecordedEvents` array. The key detail
is that **execution metadata is preserved in each recorded event** via the
`withExecution()` helper; every graph-level and node-level event records its
`GraphExecutionMetadata` alongside the event data.

```typescript
// packages/core/src/recording/ExecutionRecorder.ts

// Each event is serialized with its execution metadata intact:
nodeStart: ({ node, inputs, processId, execution }) => withExecution({
  nodeId: node.id,
  inputs,
  processId,
}, execution),
```

Recorded event types mirror `ProcessEvents` but replace runtime objects with
serializable identifiers (e.g. `node: ChartNode` -> `nodeId: NodeId`,
`graph: NodeGraph` -> `graphId: GraphId`). The full type mapping is in
`RecordedEventsMap` (`RecordedEvents.ts`).

Recorder finish semantics follow root-run semantics, not every control event.
`done`, `error`, and unsuccessful root `abort` events close the recording. A
successful root `abort` from `Abort Graph` is recorded as an intermediate event
because the processor can still emit late node terminals and then a successful
`done`. Keeping the recorder open through that `done` preserves the same late
successful-abort node terminals that Remote Debugger and replay need to clear
running state correctly.

Recordings are serialized to `.rivet-recording` files with asset deduplication
(Uint8Arrays -> base64) and string deduplication (long strings -> FNV-1a hash
references).

### Replay (`replayExecutionRecording`)

`RecordingPlayer.ts` replays a recording by iterating the `RecordedEvents` array
and re-emitting each event on a provided `Emittery<ProcessEvents>` emitter. This
means the app's standard event handlers (`onNodeStart`, `onGraphStart`, etc.)
receive the same events during replay as during live execution.

In the desktop app, replay is intentionally routed through the local executor
path even when the selected live executor is Node. The ActionBar's `Play
Recording` button still delegates to `useGraphExecutor`, but
`shouldUseRemoteExecutor(...)` treats `loadedRecordingState` as a local replay
override, and the ActionBar keeps playback enabled without waiting for the Node
sidecar. Remote/app-executor sessions only run live graphs; they do not receive
a `run` protocol message for recording playback. This override is scoped to
graph playback and playback controls, so live features such as Trivet tests keep
using the selected executor while a recording is loaded. The app blocks
recording load/unload while an execution is active, which keeps the playback
override stable for the lifetime of the run and prevents Abort/Pause/Resume from
switching executor targets mid-run.

The critical design point is **execution metadata parity**: replay emits events
with the same `GraphExecutionMetadata` that was recorded, so:

- `graphRunHistoryByView` gets populated with the same view keys.
- `lastRunDataByNodeState` entries get the same `graphRunId` tags.
- The run switcher and data filtering work identically to live execution.

### Legacy recording fallback

Recordings made before execution metadata was added do not have `execution` fields
on their events. `RecordingPlayer` handles this with `getExecution()`:

```typescript
// packages/core/src/model/RecordingPlayer.ts

const legacyRootRunId = nanoid() as RootRunId;
const legacyGraphRunsByGraphId = new Map<GraphId, GraphRunId>();

const getExecution = (graphId: GraphId, recordedExecution?: GraphExecutionMetadata): GraphExecutionMetadata => {
  if (recordedExecution) {
    return recordedExecution; // New recording; use as-is
  }

  // Legacy recording; synthesize consistent IDs per graphId
  let graphRunId = legacyGraphRunsByGraphId.get(graphId);
  if (!graphRunId) {
    graphRunId = nanoid() as GraphRunId;
    legacyGraphRunsByGraphId.set(graphId, graphRunId);
  }

  return { graphId, graphRunId, rootRunId: legacyRootRunId };
};
```

This ensures legacy recordings produce stable synthetic `graphRunId` values per
graph (the same `graphId` always maps to the same `graphRunId` within a replay),
while new recordings use the original metadata verbatim.

### Event coverage

All event types relevant to data flow are replayed:

| Event                                       | Effect on app state                                 |
| ------------------------------------------- | --------------------------------------------------- |
| `start`                                     | Clears history, sets context values and inputs      |
| `graphStart`                                | Creates `GraphRunRecord` in history                 |
| `graphFinish` / `graphError` / `graphAbort` | Updates run record status                           |
| `nodeStart` / `nodeFinish` / `nodeError`    | Stores per-node execution data                      |
| `nodeExcluded`                              | Stores excluded status                              |
| `partialOutput`                             | Stores streaming/split-run output                   |
| `nodeOutputsCleared`                        | Removes node data entries                           |
| `done`                                      | Sets final outputs, marks not running               |
| `userInput`                                 | Replays user input prompt (callback is `undefined`) |
| `globalSet`                                 | Replays global variable changes                     |

Chat nodes get an artificial delay (`recordingPlaybackChatLatency`) during replay
to simulate streaming behavior.

### Recording options

`ExecutionRecorderOptions` controls what is captured:

- `includePartialOutputs` (default `false`): Whether to record `partialOutput` events. Excluded by default to reduce recording size.
- `includeTrace` (default `false`): Whether to record `trace` events.

These same events are simply skipped during recording; replay handles their
absence gracefully since the final `nodeFinish` event contains the complete outputs.

## File Reference

| File                                                                                                     | Role                                                                                                                                                                 |
| -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`navigationActions.ts`](../packages/app/src/domain/graphEditing/navigationActions.ts)                   | `GraphViewContext` types, `createRootGraphViewContext`, `createSubgraphGraphViewContext`                                                                             |
| [`executionIdentity.ts`](../packages/app/src/utils/executionIdentity.ts)                                 | `buildGraphViewKeyFromExecution` - converts execution metadata to view key (used only for graph-level events)                                                        |
| [`dataFlow.ts`](../packages/app/src/state/dataFlow.ts)                                                   | Core atoms: `currentGraphViewState`, `graphRunHistoryByViewState`, `selectedGraphRunByViewState`, `lastRunDataByNodeState`, `resolvedGraphSelectionState`            |
| [`executionSelectors.ts`](../packages/app/src/state/selectors/executionSelectors.ts)                     | `getGraphRunsForView`, `filterProcessDataForSelection`, `getSelectedProcessData`, `getGraphSelectionOptions`, executor product-state and ActionBar routing selectors |
| [`useExecutionDataFlow.ts`](../packages/app/src/hooks/useExecutionDataFlow.ts)                           | `setDataForNode`, `setSelectedNodePageLatest` - writes execution data to state                                                                                       |
| [`useGraphExecutionEvents.ts`](../packages/app/src/hooks/useGraphExecutionEvents.ts)                     | Graph-level event handlers: `onStart`, `onGraphStart`, `onGraphFinish`, `onDone`                                                                                     |
| [`useNodeExecutionEvents.ts`](../packages/app/src/hooks/useNodeExecutionEvents.ts)                       | Node-level event handlers: `onNodeStart`, `onNodeFinish`, `onPartialOutput`, `onNodeError`                                                                           |
| [`useLocalExecutor.ts`](../packages/app/src/hooks/useLocalExecutor.ts)                                   | Browser-mode execution orchestration                                                                                                                                 |
| [`executorSession.ts`](../packages/app/src/hooks/executorSession.ts)                                     | Shared websocket runtime coordinator: socket generations, reconnect policy, session status, capabilities, and lifecycle events                                       |
| [`executorSessionTarget.ts`](../packages/app/src/hooks/executorSessionTarget.ts)                         | Executor-session target factories, type+URL equality, internal/external classification, and debug labels                                                             |
| [`executorSessionTransport.ts`](../packages/app/src/hooks/executorSessionTransport.ts)                   | Executor websocket protocol frame serialization/classification and safe-send policy                                                                                  |
| [`executorSessionDatasetBridge.ts`](../packages/app/src/hooks/executorSessionDatasetBridge.ts)           | Dataset request/response bridge over the executor websocket protocol, using an exact request switch                                                                  |
| [`executorSessionPendingExecutions.ts`](../packages/app/src/hooks/executorSessionPendingExecutions.ts)   | Pending remote graph-run promises, request-id allocation, completion, and rejection cleanup                                                                          |
| [`executorSessionCallbackIsolation.ts`](../packages/app/src/hooks/executorSessionCallbackIsolation.ts)   | Failure-isolated executor-session lifecycle, process-message, and state-change callback fan-out                                                                      |
| [`useExecutorSessionCoordinator.ts`](../packages/app/src/hooks/useExecutorSessionCoordinator.ts)         | Product policy for Browser/hosted Node/desktop Node startup, cleanup, sidecar readiness, and external-debugger handoff restoration                                   |
| [`useExecutorSession.ts`](../packages/app/src/hooks/useExecutorSession.ts)                               | Read-only executor-session snapshot hook plus compatibility exports for coordinator helpers                                                                          |
| [`useRemoteDebugger.ts`](../packages/app/src/hooks/useRemoteDebugger.ts)                                 | External Remote Debugger command/subscription surface; does not own Node executor restoration policy                                                                 |
| [`useRemoteExecutor.ts`](../packages/app/src/hooks/useRemoteExecutor.ts)                                 | Remote graph/test execution over the shared session; sends protocol messages only after action-time capability checks                                                |
| [`remoteExecutorUploadCache.ts`](../packages/app/src/hooks/remoteExecutorUploadCache.ts)                 | Remote project/settings/static-data upload decisions, cache invalidation, and send-success marking                                                                   |
| [`remoteExecutorRunRequest.ts`](../packages/app/src/hooks/remoteExecutorRunRequest.ts)                   | Remote run request-id registration, active request filtering, send-failure cleanup, and pending test-run send helpers                                                |
| [`remoteExecutorHelpers.ts`](../packages/app/src/hooks/remoteExecutorHelpers.ts)                         | Run-from planning, preload extraction, Trivet selection, and `createProcessEventDispatcher` routing from WebSocket messages to handlers                              |
| [`GraphProcessor.ts`](../packages/core/src/model/GraphProcessor.ts)                                      | Core execution engine, `#createSubProcessor`, `#buildExecutionMetadata`                                                                                              |
| [`SubprocessorBridge.ts`](../packages/core/src/model/SubprocessorBridge.ts)                              | `wireSubprocessorEvents` - forwards child events to parent emitter                                                                                                   |
| [`SplitRunProcessor.ts`](../packages/core/src/model/SplitRunProcessor.ts)                                | `processSplitRunNode` - iterates split inputs, creates subprocessors per iteration                                                                                   |
| [`ProcessContext.ts`](../packages/core/src/model/ProcessContext.ts)                                      | `GraphExecutionMetadata`, `SubgraphExecutorMetadata` type definitions                                                                                                |
| [`GraphExecutionSelectorBar.tsx`](../packages/app/src/components/GraphExecutionSelectorBar.tsx)          | Run switcher UI component                                                                                                                                            |
| [`useGoToNode.ts`](../packages/app/src/hooks/useGoToNode.ts)                                             | Navigation to node - creates root view context                                                                                                                       |
| [`useGoToSubgraphNode.ts`](../packages/app/src/hooks/useGoToSubgraphNode.ts)                             | Shared direct Subgraph navigation used by the header link and context menu                                                                                           |
| [`useGraphBuilderContextMenuHandler.ts`](../packages/app/src/hooks/useGraphBuilderContextMenuHandler.ts) | Context-menu dispatch for "Go to subgraph"                                                                                                                           |
| [`ExecutionRecorder.ts`](../packages/core/src/recording/ExecutionRecorder.ts)                            | Records execution events with metadata, serializes to `.rivet-recording`                                                                                             |
| [`RecordedEvents.ts`](../packages/core/src/recording/RecordedEvents.ts)                                  | `RecordedEventsMap` type definitions - serializable mirror of `ProcessEvents`                                                                                        |
| [`RecordingPlayer.ts`](../packages/core/src/model/RecordingPlayer.ts)                                    | `replayExecutionRecording` - replays recorded events through the same emitter/handler pipeline                                                                       |

## Debugging Checklist

When execution data is not showing up for a graph:

1. **Check `currentGraphView.key`** - is it `root:` or `subgraph:`?
2. **Check `graphRunHistoryByView` keys** - what keys have run records?
3. **Do the keys match?** If not, `getGraphRunsForView()` should fall back to
   a broader search by `graphId`. Check that this fallback is finding runs.
4. **Check `ProcessDataForNode.graphRunId`** for the node - does it match a
   run in the resolved graph runs list?
5. **Check that events are being forwarded** - is `wireSubprocessorEvents` wiring the event type you expect?
6. **Check `filterProcessDataForSelection`** - is it filtering to the correct `graphRunId`?
7. **For remote execution** - check that the sidecar serializes the event type and that `createProcessEventDispatcher` maps it.

When execution data appears only _after_ execution completes (no live updates):

8. **Browser mode only?** If the problem is exclusive to browser mode but works
   in Node mode, see "Browser vs Remote: Event Delivery and React Rendering"
   above. The most likely cause is that event handlers are not yielding to the
   macrotask queue, preventing React from committing intermediate state.
9. **Check `emitDetached` vs `await emit()`** - if a new event type is added
   to `GraphProcessor` and uses `emitDetached`, its listeners cannot pause the
   processor. If that event needs live UI updates, change it to `await emit()`.
10. **Check for stale closure values** - if a handler reads a value that was
    correct at registration time but wrong at call time, see "Stale Closures in
    Browser Execution Handlers" above. Use `useLatest` for values captured by
    long-lived handlers in `attachGraphEvents`.
