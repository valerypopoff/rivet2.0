# Execution Identity And Snapshots

Canonical guide for execution lineage, event snapshots, and app-side run history.

## Core Identity

Every graph event carries `GraphExecutionMetadata`: `rootRunId` identifies one root
invocation, `graphRunId` identifies one graph/subgraph invocation,
`parentGraphRunId` links child runs, and executor metadata identifies the parent
node/process/split index. Subprocessor events retain child metadata when forwarded.

## Core Lifecycle

`GraphRunLifecycle` owns run/paused/abort/finish-once state decisions.
`GraphProcessor` owns scheduling, controllers, event emission, and exact event order.
The root emits `finish` once; subprocessors do not. Successful abort and race-loser
cancellation remain exclusion semantics where characterized, not generic node errors.

## App Run Records

Execution event hooks store graph runs and node process pages keyed by execution
identity. Missing selected process page means `latest` for canvas execution chrome,
because off-screen graph events may arrive before a node has a page-selection entry.
An explicit numeric page remains stable for output inspection.

Stored execution values may be inline, preview-only, or ref-backed. Copy/render code
must use the shared restore/read APIs and tolerate malformed historical payloads.
Error status is additive when outputs exist: an errored run can still expose and copy
its stored outputs.

## Executor Sessions

Browser, Node sidecar, and Remote Debugger sessions are project-scoped. Routing keys
include project/run ownership so runs in different tabs cannot replace each other.
Terminal events and abort controls must resolve against the same owning session.

## Recording ownership and omitted work

Loaded recording ownership is the exact editor tab's project ID **and path**,
as resolved by [execution state](../packages/app/src/state/execution.ts).
Project ID alone is insufficient because a virtual recording tab can coexist
with the source project. Only the owning tab receives playback UI and controls;
loading/unloading a recording does not rewrite the live Browser/Node choice.
The app requires the recording's declared root start graph through
[`requireRecordingRootGraphId`](../packages/app/src/utils/recordingPlayback.ts).
Do not substitute the currently visible graph during replay.

For output-pruned child invocations, unscheduled nodes have no lifecycle events,
and a caller with no demanded outputs has no child invocation. Selecting that
caller must not show data from a previous child run. Historical navigation remains
available by explicit run selection; never erase history to conceal stale current
selection. See [Execution Data Flow](./EXECUTION-DATA-FLOW.md#subgraph-output-demand-execution-data)
for projection, parent-process selection and replay-ID remapping.

## Verification

`GraphProcessor.characterization.test.ts` pins event order, nested metadata,
pause/resume, abort/race behavior, split runs, frozen outputs, and reference graphs.
`GraphRunLifecycle.test.ts` pins the extracted state owner. Runtime changes also run
the speed/equivalence matrix; output equality alone is insufficient if event order or
hot-path allocations change.

Use the [refactor verification matrix](./REFACTOR-BASELINE.md#execution-regression-matrix)
for the Node/CLI/sidecar, repeated split, selected-output, and serialized replay
checks that must accompany changes to these identities.
