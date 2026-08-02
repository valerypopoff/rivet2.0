# Run Activity

Maintainer contract for the editor's run-level activity journal and drawer.

Run Activity is a projection over ordinary execution events. It is not a second
executor, durable run database, response-trace transport, or copy of node
outputs. The same journal reducer must consume Browser, internal Node, Remote
Debugger, inactive-project snapshot, and recording-replay events.

## Ownership

The implementation has three boundaries:

1. The event reducer records bounded run and invocation metadata.
2. The view-model layer joins that metadata with current graph definitions and
   the existing ref-backed execution-data readers.
3. The React drawer renders the view model and delegates exact navigation,
   fullscreen output, and response inspection to their existing owners.

Do not derive a timeline by rescanning the currently open graph and sorting
unrelated node data by timestamps. That loses subgraph invocation identity,
cannot distinguish repeated runs of the same node, and produces unstable order
when parallel work finishes.

## Execution identity

Activity is scoped and correlated through the normal execution hierarchy:

- `rootRunId` identifies one complete top-level execution.
- `graphRunId` identifies one root-graph or subgraph invocation.
- `parentGraphRunId` preserves the graph-invocation hierarchy.
- `graphRunId + nodeId + processId` identifies one exact node invocation.
- `splitIndex`, when present, identifies a child result of that invocation.

`nodeId` alone is never a run-level identity. Timestamp proximity is never a
correlation mechanism. `GraphViewKey` is an editor-navigation identity and must
not replace executor lineage.

A root first observed through a subgraph has no trustworthy root-graph id until
an exact root graph event arrives. Keep `rootGraphId` absent during that partial
state rather than assigning the subgraph id to it.

The event boundary must stamp every `RunActivityEvent.occurredAt`; the reducer
does not call the wall clock and therefore remains deterministic. The journal
assigns a stable ingestion sequence when it first observes an invocation. Rows
use that sequence for presentation order; later completion events update the
row without moving it. Timestamps remain display and duration data, not the
primary ordering key.

## Lifecycle semantics

Keep these states distinct:

1. The root execution started.
2. Graphs and nodes are running.
3. Root graph outputs became available.
4. Async work may still be settling.
5. The root execution reached a terminal completed, failed, or aborted state.

An outputs-ready event must not be labelled as complete while an async branch
continues. A startup or preflight failure must still produce root-level error
activity even when no graph or node lifecycle began.

When a root settles without an expected child terminal event, mark that child
with `terminalEventMissing`. A successful root leaves its child status
`unknown`; failed and aborted roots mark the unsettled child `aborted`. Never
leave a row visibly running after its root is terminal, and never manufacture a
successful child completion.

Some abort paths deliver exact node terminals just after the graph terminal.
Treat the root-settlement marker as provisional: a later exact node or graph
terminal must clear `terminalEventMissing` and replace the provisional child
status with the observed terminal status.

An exact root-graph terminal event is followed by an unscoped processor
`done`, `error`, or `abort` confirmation. The reducer tracks those pending
confirmations separately. It must consume the confirmation without applying it
to whichever other root happens to be the only active run at that moment.

Partial-output events update the existing invocation entry. They must be
coalesced rather than appended as timeline rows. Parallel node and tool work
retains separate entries and stable ordering.

## Retention and value ownership

Run Activity retains metadata for active roots and the latest completed root.
It deliberately does not provide persistent multi-run history; execution
recordings own that use case.

The journal keeps identifiers, hierarchy, statuses, timestamps, port ids,
output revisions/availability, split indices, compact error summaries, and
bounded agent-trace metadata. It does not store `DataValue` objects, node data,
full prompts, outputs, retrieved documents, tool arguments/results, response
texts, provider bodies, headers, or credentials.

Expanded activity reads only bounded previews that already belong to the
ordinary execution-data store. Full values remain behind the existing
fullscreen-output action and renderer; the journal never duplicates them. Ref
eviction is a normal state: show the shared unavailable-value explanation
rather than throwing or substituting `undefined`. Journal eviction does not own
or delete ordinary node-history values; those remain governed by the
execution-data lifecycle.

The default bounds retain every active root plus the newest completed root,
2,000 node invocations per root, 250 model-call rows per invocation, and 500
tool-call rows per invocation. Totals and omitted-row counters remain truthful
after row storage reaches a bound.

The presentation model carries the selected `rootRunId`. Stateful views use
that identity—not item counts or timestamps—to reset expansion and live-follow
bookkeeping when the selected root changes.

## Result provenance

When the runtime supplies result provenance, preserve whether a visible result
was physically executed, preloaded, frozen, restored from editor cache, or has
unknown origin. Frozen/preloaded/cache replay must not be represented as a new
physical model or tool operation.

Old remote hosts and recordings may omit newer provenance. Display `unknown` or
a partial-data explanation rather than inferring provenance from timestamps or
zero usage. Provider prompt-cache usage is still a physical model call and is
not the same as Rivet editor-cache replay.

Normal `executed` provenance is implicit and should not add a repetitive detail
row to every activity. Show the result-origin detail only when it explains a
preloaded, frozen, editor-cache, or unknown/legacy result.

Current runtimes must emit `resultOrigin` explicitly for every physical node
lifecycle event. The reserved legacy preload process id remains recognizable as
preloaded, but all other lifecycle events without provenance stay `unknown`.
For normal and split-run invocations, `nodeStart` is provisional `executed`
because the node implementation has begun. The terminal `nodeFinish` or
`nodeError` event is authoritative and may replace that value with
`editor-cache` after a cache-aware node confirms that it returned cached
outputs. A split-run result is `editor-cache` only when every split replayed
cached output; a mixed cached/physical run remains `executed`. Partial outputs
remain `executed` because editor-cache replay does not stream partial values.
Remote execution serialization, `ExecutionRecorder`, and `RecordingPlayer`
must preserve an explicitly supplied `resultOrigin`. Legacy protocol payloads
and recordings that omit the field remain valid and resolve to `unknown`; the
transport and replay layers must not synthesize a provenance value.
Adapters that normalize errors for transport may stringify the error itself,
but must preserve execution identity, duration fields, and `resultOrigin`
unchanged.

The desktop Node executor is a native sidecar built when `yarn dev` starts. Vite
hot reload updates the editor UI, but it cannot replace a sidecar process that
is already running. After changing core or Node lifecycle-event provenance,
restart `yarn dev` before evaluating Run Activity; otherwise the new drawer is
correctly observing an older executor contract and will label its missing
provenance as unknown.

## Model and tool activity

Physical model-call and tool-call events attach to the exact owning node
invocation through execution identity. Direct-return tools must show the real
provider call and tool execution without inventing a follow-up model request.
Parallel tools remain separate child entries. Retry and LLM-profile fallback
counts come from explicit attempt/profile metadata, not inferred timing.

Run Activity reuses the response-inspector model for metadata when it is
available. It must not introduce another trace format or another cost/usage
aggregation path.

The response projection deduplicates transport redelivery by stable
physical-call identity before calculating rows or totals. Model identity
includes the owning root/graph run, node/process, and model-call id; identified
tool identity includes the owning root/graph run, source node/process, and
tool-call id. Anonymous tool events deliberately remain distinct. Run Activity
replaces redelivered identified rows while they are retained and otherwise relies on the
runtime's exactly-once lifecycle-event contract; nested processors must emit
once and the editor must keep a single executor subscription.

## Provider-neutral presentation descriptors

Specialized previews are opt-in node presentation metadata, not a list of
hard-coded Chat node types or assumptions that ports are named `prompt` and
`response`.

Built-in and plugin node implementations may declare an execution-activity
descriptor with:

- a category such as model, tool, or generic;
- an optional primary output port for the collapsed preview;
- optional context input ports for the expanded view.

The descriptor is runtime/editor metadata and is not serialized into a Rivet
project. Unknown nodes remain visible as generic invocation rows; the absence of
a descriptor only removes the specialized preview.

The current built-in descriptors are deliberately small:

- Chat (Legacy), LLM Chat, and the legacy Anthropic Chat plugin use category
  `model`, primary output `response`, and context input `prompt`.
- Delegate Tool Call uses category `tool`, primary output `output`, and context
  input `function-call`.

When a node changes its port contract, update its descriptor and the focused
descriptor-port regression test together. Never leave a descriptor pointing at
a port that the node no longer exposes.

Descriptors must name only workflow data that already belongs to the selected
invocation. They do not authorize copying values into the journal or exposing
credentials and provider request internals.

## Exact navigation

Navigation starts from the row's full execution target: root run, graph run,
graph view context, graph, node, process, and optional split index. The
navigation helper must select the matching graph invocation and process page
before centering the node.

Do not call the generic node-navigation helper with only `nodeId` and `graphId`
for Run Activity. That is ambiguous when a subgraph or node ran multiple times.
If the graph or node was removed after execution, preserve the captured label
but disable canvas navigation and node-owned actions such as fullscreen output
or response inspection.

## Drawer integration

On desktop, the drawer's clamped height is the single value published through
`--run-activity-drawer-reserved-height`. Every editor surface that occupies the
canvas workspace, including the graph canvas and UI graph builder, must reserve
that height. The graph-tree sidebar is an independent full-height panel and
must not consume the drawer reservation. Narrow layouts treat Run Activity as
a modal sheet and must ignore the desktop reservation. If another modal is
opened from the drawer, Escape closes that topmost modal without also closing
the drawer behind it.

The lower-right **Runtime** status control is the only persistent Run Activity
entry point. It remains available before the first run and toggles the drawer;
Run Activity must not consume a workspace tab in the top strip. The drawer uses
the app's semantic panel, strip, form-control, node-body, border, and foreground
tokens so built-in and custom themes remain the single styling owner.

The Runtime value uses the same selected root as the drawer. While that root is
live it advances from the recorded start time; after completion it freezes at
`finishedAt - startedAt`, including after a project switch or status-bar
remount. The legacy graph-start atom is only a short startup fallback before
the first identified Run Activity event arrives. A newly starting live run must
take precedence over a retained completed root during that gap.

## Executor and recording parity

All delivery paths reduce the same activity event contract:

- active Browser execution;
- inactive-project Browser execution snapshots;
- internal Node and external Remote Debugger sessions;
- recording capture and playback.

Additive fields must degrade safely when an older host, client, or recording
does not provide them. Observer failures are non-fatal and must never change
workflow scheduling, outputs, errors, cancellation, or cost accounting.
Active-run dispatch and inactive-project snapshot projection keep Run Activity
behind a separate error boundary from the primary execution-state update.

## Privacy and performance

The journal is editor-only and does not add web-app protocol payloads.
Bound activity and child-call collections, avoid eagerly restoring large
values, and virtualize or use browser visibility containment for long runs.
Search operates on bounded metadata and safe previews.
Its metadata projection indexes every bounded model-call provider/model pair and
every bounded tool-call name shown in the expanded activity row, including
failed profile attempts and later parallel tools rather than only the row's
effective summary values.

Never place secrets, raw request bodies, full message arrays, chain-of-thought,
tool arguments/results, or retrieved documents into activity metadata.

## Required regression coverage

Tests must cover:

- exact root filtering and repeated subgraph/node invocations;
- stable ordering when parallel operations finish out of order;
- split runs, partial output, failures, cancellation, and preflight errors;
- outputs-ready while async work remains active;
- physical model calls, retries, profile fallbacks, parallel tools, and direct
  return without double counting;
- frozen, preloaded, cached, unknown, and ref-evicted values;
- exact graph-run/process navigation and deleted targets;
- Browser, Node, Remote Debugger, inactive-project, recording, and replay parity;
- bounded retention and cleanup;
- absence of forbidden sensitive payloads from journal state.
