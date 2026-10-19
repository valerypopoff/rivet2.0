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

### Remote dependency observations across open tabs

Connecting Remote Debugger from any open member creates one shared bundle debugger
session. All its open members immediately show the same **Stop Remote Debugger**
button, even before a run executes them. Stopping from any member disconnects that
session everywhere; it does not abort the runtime. There is no per-tab opt-out.
Local Browser/Node preferences and runtimes remain separate and are restored when
the shared debugger stops. Closing its initiating tab does not stop the session
while another member remains open; closing the last member disposes it.
Both desktop and hosted workspace persistence use `useOwnExecutorSessionState`,
not the effective shared session. Otherwise activating a member can persist the
shared URL as its personal executor and open duplicate sockets on the next switch.
The coordinator must not restore an internal executor on a disconnected shared
observer object; the next render returns to each tab's own runtime instead.
`useExecutorSessionRuntime` owns the effective session's revision subscription;
consumers do not need another subscription just to read its current state.

`remoteDebuggerBundle.ts` finds the undirected component of open projects using
explicit cross-project Subgraph references (including resolved library nodes),
legacy `project.references`, or an explicit desktop bundle manifest. Thus attaching from C can admit roots in A,
B or C. It never groups projects by directory, title, graph/node IDs or debugger
URL. New linked tabs can join shared controls, but passive data still requires
their lifetime to have been captured at root admission. Separate bundles remain
independent even when their debugger URLs match. Active local execution blocks a
conflicting attachment rather than being stopped implicitly. Browser preparation
reserves its running flag before awaiting discovery. Node graph/Evaluation
preparation binds both the physical ready connection and the effective project
runtime through `bindExecutorSessionRun`: attaching a shared debugger invalidates
the old preparation even if its personal internal socket remains ready. It cannot
upload/send a run or send stale cancellation after that handoff.

Shared sessions retain a membership generation for each source at its first
identified root start. Closing/reopening the source fences raw canvas/activity
writes from that old root, including duplicate starts. A start first seen while
the source was closed also cannot bind that root to a later-opened source tab.
This does not reject the socket stream needed by already-observing B/C.
A new root captures the new lifetime normally. Shared disconnect cleanup uses the
same captured lifetime through the registry, not the initiating tab or a raw
socket callback. Even when no current source remains, the registry still notifies
the passive observation owner so it can settle its existing receivers. A normal
file rename/move does not end the source tab's lifetime or strand its active run.
Membership discovery is reused once per connected component during each workspace
refresh rather than rescanning every graph separately for each member.

If that admitted live root executes A → B → C, the editor projects events into
eligible open B/C tabs using actual `execution.projectId`, `rootRunId` and
`graphRunId`. It does not infer bundle membership from a folder, desktop manifest,
matching graph/node IDs, or a shared debugger URL. Unexecuted projects are untouched.

Ownership is split deliberately:

- `executorSession.ts` computes admission once per incoming frame, before any
  subscriber can mutate request state. Active display, inactive display, diagnostics
  and passive projections consume that same decision. Admission also carries the
  actual root project, not the tab that opened the socket, so A data cannot be
  dispatched into the B tab which initiated the connection. Logical HA resume and
  transport dedup remain in the session; physical reconnect does not reset admission.
- `remoteExecutionObservation.ts` owns bounded source/root membership, receiver
  tab lifetimes, conflicts and terminal cleanup. It opens no sockets and has no
  command transport. Each root captures the then-open tabs; late opens and
  close/reopens wait for the next root. A missing intermediate tab does not hide
  an open descendant. Each run retains its own actual root project, including
  successive A-rooted and B-rooted runs over the same shared connection.
  When a former dependency becomes an actual root, its own source display wins:
  old passive provenance is retired and late events from the earlier root cannot
  overwrite the new source view. Other dependencies keep observing the earlier run.
  This priority is symmetric: a later root on the shared socket cannot enroll an
  already-active source as a passive receiver. Capture that exclusion at admission,
  not at every chunk; completing the source does not join the older passive run
  midway. Its descendants remain observable, and future roots can observe the now
  idle project. The exclusion applies only to the captured tab lifetime, so an
  old root cannot reserve a closed/reopened source tab indefinitely. Same-root
  A → B → A return calls keep their existing canvas projection.
- `useRemoteExecutionObservations.ts` binds the router to project snapshots and
  provenance atoms. `updateOpenProjectExecutionSnapshot` applies storage/reference
  effects once synchronously, ignores closed tabs, and restores only changed active
  fields. Authored graphs, dirty state and executor preferences are not rewritten.

Canvas projection clears foreign `projectScope` and cross-project parent/executor
links, but **Run Activity retains original ancestry** via `activityData`. Otherwise
each B graph finish would incorrectly close the A root and suppress later B calls.
Passive user input is journal-only: it never creates a second prompt. Progress,
node/model/profile/tool diagnostics and output history use existing reducers.
For A → B → A return calls, `activityData: false` paints only the source canvas;
the source dispatcher already journals the original event. Its own root lifecycle
is never settled by the passive router, avoiding duplicate diagnostics and
premature completion of concurrent source runs.
Run Activity graph records retain an optional actual `projectId`. Its renderer
does not resolve foreign graph/node IDs or foreign caller IDs against the current
authored project, and cannot navigate a foreign row into an unrelated cloned node.
Runtime titles remain visible in the source journal; full output navigation is
available in the owning observed project. Older journals preserve legacy behavior.
`settleObservedRunActivityRoot` closes only that observed root on completion or
disconnect, including missing terminal evidence, without synthesizing a graph start.

An existing local run/preparation, recording playback or independent debugger wins
over passive data. A blocked receiver does not join midway through that root; open
descendants can still observe. A preparation which loses the race to an observation
must recheck before uploading/dispatching. Passive tabs hide run/pause/abort/freeze
controls and guard shortcut/Evaluation entry points. The actual root project keeps
its existing runtime controls and prompts, using the same shared transport. Every
member can stop the shared debugger. Completed values remain visible.
Ownership changes also block retained completed observations, so an old view-only
lock cannot override a newly selected debugger or playback owner. The adapter
coalesces ownership checks after synchronous tab restoration; it does not scan large
execution snapshots on every streaming chunk. Every terminal and provenance fan-out
also checks ownership and the receiver lifetime before publishing.

Input-wait accounting belongs to the admitted root, including prompts in the source
or a child that has since closed/stopped observing. Child terminal events still
clear those waits; receiving tabs never own a duplicate prompt.
Pause state is also root-owned, so a dependency first observed after the pause
notification inherits the correct paused banner. If the same root calls both
`latest` and `published` definitions of a project, its banner reports both rather
than retaining only the version of the first call. These are display labels, not
claims that the editor's authored graph matches either runtime version.

Active and snapshot graph-history transitions share `finishGraphRunState`.
Each identified graph invocation acquires one running slot at its first start and
releases it at its first terminal. Duplicate starts/terminals, a missing start, or
abort followed by cleanup error cannot consume a sibling invocation's slot.
Cleanup may refine aborted status to error/ok, but repeated same-status terminals
do not move the finish clock. Metadata-free legacy events retain their one-slot
fallback; no new scheduler or execution owner is introduced.

Exact root graph completion/failure supports older runtimes without identified done/error
frames. New Node adapters add optional execution metadata to processor lifecycle
messages; absence of project ownership or a missed root admission never authorizes
child projection. Replay is excluded. Up to 32 active and 32 completed roots per
source and 4096 graph owners per root are tracked; capacity limits warn rather than
silently evicting active observations. Normal history/ref retention still applies.
Debugger partial-output throttling is keyed by root/graph/project/node/process,
not node ID alone, so cloned bundle nodes cannot throttle each other's streams.
`graphAbort` and processor `abort` are cancellation requests, not completion:
Core emits them before node/branch cleanup drains. Keep observation live for late
diagnostics until graphFinish/graphError or done/error, retaining aborted status
when cancellation ends with an error. Successful control-flow aborts can still
finish successfully. Do not use the cancellation notification as a disposal boundary.
Source Run Activity also honors identified done/error/abort/pause/resume events.
Its bounded pending-confirmation identities prevent a duplicate identified terminal
from consuming another root's legacy confirmation. Abort cleanup may emit a second
graph terminal and confirmation; it is tracked separately from the cancellation
notification. Unknown identities never fall through to an unrelated active root,
and exact graph terminals retain their original finish clock.
Source admission also rejects a positively identified foreign root that fails
preparation before `start`; its legacy terminal confirmation cannot inherit the
last accepted run. Cross-project events under an already admitted root remain
valid, and metadata-free legacy routing retains its existing fallback.

Regression coverage: `remoteExecutionObservation.test.ts`, executor-session
subscription/resume/routing tests, `remoteExecutionObservationSession.test.ts`, snapshot binding/reducer tests and Node debugger
attachment tests. `remote-bundle-observation.spec.ts` exercises a real A → B → C
processor and one WebSocket through hosted tabs with cloned IDs, partial/final
outputs, child failure, late abort diagnostics, attachment from B/C, identical
bundle controls before the run, shared stop during execution, source close/reopen, mixed-version
provenance, read-only controls, Run Activity and stop/disconnect cleanup.
The browser spec is enrolled in the existing CI lane. No Kubernetes rehearsal is
needed for this editor/debugger feature.
The neighboring nested Watch browser test opens its fixture through the normal
dashboard with mocked bootstrap/load APIs, rather than relying on legacy browser
storage hydration or a running local API.
App test sharding discovers the new test files automatically; the browser spec is
explicitly listed in `playwright.ci.config.ts`. For a local regression pass, run
the focused app session/observation/snapshot/Run Activity tests and Node debugger
attachment tests, type-check the app, and build Studio Server web. Then use the
repository runner with `PLAYWRIGHT_HEADLESS=1`, `PLAYWRIGHT_SLOW_MO=0` and the local
`PLAYWRIGHT_BASE_URL`:

```sh
yarn studio-server:ui:observe remote-bundle-observation.spec.ts watch-conditional-remote.spec.ts
```

These are local editor/debugger checks, not a Kubernetes qualification or deployment.

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
