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

## Verification

`GraphProcessor.characterization.test.ts` pins event order, nested metadata,
pause/resume, abort/race behavior, split runs, frozen outputs, and reference graphs.
`GraphRunLifecycle.test.ts` pins the extracted state owner. Runtime changes also run
the speed/equivalence matrix; output equality alone is insufficient if event order or
hot-path allocations change.
