# Execution routing: pre-refactor functional baseline

Recorded: 2026-10-24. Status: current working-tree behavior, before the proposed
[execution-routing refactor](./studio-server/execution-routing-refactoring-plan.md).

This is the comparison contract for editor execution/display changes, not a claim
that a shared coordinator or canonical per-binding store already exists. The
reviewed checkout is on `develop`, with HEAD
`784b1e572fecb80456f07474a4fe5aa61545ca87` **plus uncommitted routing fixes**.
HEAD alone is therefore not an exact source snapshot of this baseline.

Scope: ordinary editor runs across open bundle projects, Remote Debugger,
recording playback, execution snapshots and their integration boundaries.
Graph scheduling, evaluation semantics, project/bundle file formats, persistence
and deployment are preserved adjacent contracts, not being redesigned here.
This does not certify the current production installation or a packaged desktop
binary. No production access is needed to use this document.

## How to use the baseline

- The numbered behavior IDs below are stable review references. Preserve their
  observable results, not the current module arrangement or duplicate state copies.
- Source-checked mechanics and characterization gaps are explicitly separated
  below. Do not turn an untested assumption into a preservation guarantee.
- For each refactor phase, report affected IDs, the pre/post scenario and evidence,
  and classify the result as unchanged, intentionally changed or unresolved.
- Do not revise this baseline silently to fit a new implementation. Record a dated
  amendment and rationale for an intentional behavior change; add a regression
  first when resolving a characterization gap.
- Existing saved projects, portable bundles and old recordings remain readable.
  Changes to their formats, execution control ownership or replay semantics are
  not incidental implementation details of a display refactor.

## Vocabulary and identities

The **source/entry project** here means the project initiating this particular
run, not a special entry-project role in a bundle. Any bundle member can be a
source. A **receiver** is an already-open project tab receiving display evidence;
this does not start another execution. A **binding** is the project plus its
current file/bundle association and open-tab lifetime, not just a project ID.

`execution.projectId` identifies the actual project owning an event.
`rootRunId` identifies the root invocation; `graphRunId` identifies one graph
invocation; `parentGraphRunId` and optional `executor` identify its caller.
`processId` and optional split index distinguish node invocations. Same node/graph
IDs in different projects are not proof of ownership. `projectScope` distinguishes
live called-project snapshots; `replayRecordedAt` is historical delivery provenance,
not a new execution timestamp or the HA transport-resume cursor.

## Supported modes and responsibility boundaries

| Mode | How evidence arrives | Display/control ownership |
| --- | --- | --- |
| Browser ordinary Run | In-process Core `GraphProcessor` events through `useLocalExecutor` | Source owns processor, cancellation, prompts and recorder; eligible bundle receivers get passive projection |
| Desktop Node ordinary Run | Internal desktop executor WebSocket and session admission | Source owns request/session; internal-target bundle routing also paints eligible receivers |
| Studio Server Node ordinary Run | Internal hosted executor WebSocket and session admission | Same passive bundle behavior as desktop Node, using explicit Server membership rather than a local manifest path |
| External Remote Debugger | One shared explicit-bundle session; actual root may differ from the member that connected | Actual root retains runtime controls/prompts; passive members are view-only but all share Stop Remote Debugger |
| Loaded recording | Browser replay of the selected recorder's evidence | Exact recording-owning tab only; no live bundle fan-out or new live recording |
| Evaluations | Browser trial collectors, WebSocket trial requests or durable hosted evaluation jobs | Existing evaluation/trial ownership remains separate; ordinary-run fan-out must not accidentally make one trial stop or overwrite another |

Ordinary editor execution and passive Remote Debugger observation are different
features. Receiving local editor-run results does not connect Remote Debugger or
publish Remote Debugger provenance/read-only state.

## Membership and eligible tabs

**MEM-01 — Explicit bundles only.** Server-qualified `hostedBundleKey` is used
when defined. `null`/empty hosted membership is authoritative detachment, not
permission to fall back to desktop hints. Otherwise desktop membership uses
`bundleManifestPath`, unless `bundleMember === false`. These fields are workspace
metadata, not serialized fields added to the project. Ordinary folder proximity,
references, titles, node IDs and equal debugger URLs never confer membership.

**MEM-02 — All explicit members can participate.** Members do not have to reference
each other to share debugger controls. Ordinary execution paints only members
that actually execute; unexecuted projects receive no invented node results.
Standalone projects retain independent runtimes and behavior.

**MEM-03 — Capture receivers at root admission.** Both local live projection and
remote dependency observation capture the then-open eligible recipients. A closed
project is not opened automatically. A tab opened later waits for a later root's
data, even if it can already join a shared debugger's controls.

## Ordinary editor runs across bundle tabs

**LOC-01 — Nested live data.** With A, B and C open in one explicit bundle, running
A → B → C displays each executed project's nodes/graphs in its own tab. Both active
and inactive receivers update, and switching tabs does not redirect source results.
Run-to/Run-from selection remains source-owned and uses existing output/preload
rules; there is no automatic independent root execution in B or C.

**LOC-02 — Source controls remain source-owned.** Cancellation, prompts, root error
notifications and recording stay with the initiating invocation. Passive projection
does not set the dependency's `graphRunning` flag as an independent root. Local
receivers do not acquire Remote Debugger's view-only lock; a later independent run
or recording is allowed to take priority and blocks further old-root projection.

**LOC-03 — Conflict priority is sticky per root.** An independent run, a loaded
recording belonging to the receiver, or a non-blocked passive Remote Debugger
observation excludes that receiver for the rest of the local root. This applies to
active and inactive tabs, a conflict present at root start, one arising between
child events, and one starting/ending before the first child event. Ending/unloading
the conflicting activity does not splice partial child history into its display.
A fresh root may observe the now-idle receiver normally.

**LOC-04 — Binding changes fence old results.** The router captures eligible project
IDs, paths and the explicit bundle key at root start. Closing/reopening a receiver,
rebinding its path, or leaving/rejoining its bundle excludes it from the old root.
The exclusion survives a return to the identical ID/path/key and changes entirely
between events. A source close/reopen or bundle-binding change closes that old
source's entire passive projection too; it does not itself cancel execution.
Ordinary tab activation or a save with unchanged binding is not such a change.

**LOC-05 — Only a root can establish projection.** An identified source `start` or
source-root `graphStart` establishes routing. A child start or late node completion
cannot invent a partial observation. Finite `replayRecordedAt` events and events
without `execution.projectId` do not establish live bundle routing.

**LOC-06 — Display terminal closes admission.** An identified source-root
`graphFinish`, `graphError`, `done` or `error` removes its local routing record.
Browser processor `done`/`error` lack execution metadata, so exact root graph
terminals provide that cleanup. Subsequent child events cannot recreate routing.
Abort alone is not this terminal boundary. There is no 32-active-root eviction cap
in the local router: unrelated concurrent/completed roots must neither erase a
held root's exclusions nor stop its still-eligible receivers from updating.
See the cleanup limitation in GAP-03; this is not an unbounded-memory guarantee.

**LOC-07 — Canvas identity is local to the owning project.** Cross-project projection
clears foreign `projectScope`, and clears parent/executor linkage when crossing
project ownership, so the receiving graph can display as a local graph view.
Nested calls within that project retain their parent identity. Original run,
graph and process identities still separate repeated invocations. Source canvas
dispatch separately filters foreign live called-project evidence rather than
matching a foreign event to a cloned node ID. See GAP-01 for journal ancestry.

**LOC-08 — Observing is not execution or mutation.** Projection writes execution
display state, not authored graph definitions, dirty flags, save baselines or
executor preferences. It must not issue run/upload/save/cancel commands, open
dependency tabs or reread all bundle projects for every event. Observer errors
are caught as non-terminal diagnostics and cannot fail the source processor.

## Remote Debugger bundle behavior

**REM-01 — One shared connection, from any member.** Connecting from A, B or C gives
all opened eligible members the same Stop Remote Debugger action, including members
not yet executed. Members do not get separate sockets because they share a bundle.
Different bundles remain independent even at the same URL. Existing incompatible
connections or active local work block attachment instead of being silently stopped.
Failed attachment removes temporary shared membership without replacing own runtimes.

**REM-02 — Shared Stop is disconnect, not graph abort.** Any member can stop the
shared debugger everywhere. Closing the initiating tab does not stop it while
another member remains; closing the last member disposes the shared connection.
Own Browser/Node preferences and runtimes are preserved and become effective again
after disconnect. Shared session URLs are not persisted as personal executors.

**REM-03 — Actual root identity wins.** The member opening the connection is not
necessarily the runtime root. Incoming frame admission is computed once before
subscriber callbacks and carries the actual root project. A → B → C evidence routes
to its actual owners, not whichever tab is selected or opened the socket. A runtime
root outside the bundle may supply ancestry/terminal context without gaining an
outsider canvas; eligible descendants can still be observed.

**REM-04 — Source and receiver lifetimes differ.** Closing/reopening the source
fences its old direct source display and disconnect cleanup, but already-admitted
open dependencies can continue observing that old root. A duplicate old start must
not attach to the reopened source. Receiver close/reopen/path lifetime changes
prevent old-root writes there. A missing/closed intermediate project does not hide
an eligible open descendant. Membership reconciliation removes departed members
without merging independently connected bundles. A normal Server file move within
the same retained membership is not automatically a new debugger-source lifetime.

**REM-05 — Conflict handling and competing roots.** Once a receiving observation is
blocked by playback, an independent execution/debugger or lost membership, it stays
blocked for that root. Other descendants remain observable. If a dependency becomes
a new actual root, its old passive provenance is retired and the earlier root cannot
overwrite that new source view. A later root likewise cannot acquire an already-active
source as a passive member. A same-root A → B → A return call can paint A's called
graph without journaling it twice or prematurely settling A's own root. GAP-02
records the narrower current timing coverage than LOC-03.

**REM-06 — View-only provenance and controls.** Passive remote recipients keep
execution data and Run Activity but no duplicate interactive input prompt or
independent run/pause/abort/freeze control path. Relevant shortcuts/Evaluation
entry points are guarded. Every bundle member still has shared Stop Remote Debugger.
The `?` button opens the standard Remote Debugger details modal, rather than inline
status blocks. It reports actual source(s), completion/interruption, reconnecting,
pause/input waits, latest/published/mixed runtime versions and notices. Source
navigation is offered only when that source tab is open. Completed values remain
visible; retained provenance is released/blocked when another owner takes priority.

**REM-07 — Original ancestry, no duplicate prompts.** Remote canvas projection
rebases cross-project identity, while separate `activityData` retains original
caller ancestry in Run Activity. On A → B → A, `activityData: false` leaves source
journaling to its original dispatcher. Passive input is journal-only; root input
accounting clears even if the waiting child tab closes. A dependency first seen
after pause inherits the paused indicator. Diagnostics/version labels do not imply
that an unsaved editor graph matches the runtime graph.

**REM-08 — Definition mismatch is visible.** The remote adapter checks the receiving
graph/node exists before painting. Missing definitions are skipped with a notice.
An unsaved or structurally different graph produces a warning, never replacement
of the authored definition. This is remote-adapter behavior; see GAP-04 for local
projection rather than assuming both adapters have the same definition check.

**REM-09 — Terminal and cancellation handling.** `graphOutputsReady` and root
`graphAbort`/`abort` do not dispose observation; late cleanup diagnostics can arrive.
Admitted root done/error or exact root graph finish/error settles that root's passive
members once. Failure/interruption retains received values and marks unfinished
matching processes, not another root. Child graph completion does not complete the
whole root. Terminal/provenance fan-out checks recipient lifetime and ownership.
Display settlement is not proof that all processor resources have finished cleanup.

**REM-10 — Capacity and old runtimes.** The remote router tracks at most 32 active
roots and retains at most 32 completed roots per source, with at most 4096 graph
owners per root. Capacity warns/refuses new observation rather than silently
evicting active roots. Missing ownership/start/ancestry cannot create dependency
observation; a source-only fallback or notice remains available. Exact root graph
terminals support older producers whose done/error omit execution metadata.
Matching node IDs alone cannot establish ownership.

## Reconnect, historical replay and failure

**SES-01 — Resume a logical session; never rerun commands.** Negotiated hosted
sessions retain capability/owner identity and ordered `rivetSequence` across physical
socket replacement. They are usable only after the ready acknowledgement. Old
sockets and duplicate frames cannot dispatch into the replacement. A gap, changed
owner or expired recovery reports an unknown/interrupted outcome, not success or
permission to repeat an execution, upload or accepted dataset write.

**SES-02 — Latest-debugger recovery is not recording playback.** The latest-session
handshake enables reconnect observation. `rivetEventId` origin/sequence cursors
deduplicate replayed delivery, so reconnect does not duplicate data, create another
logical connection or send a child execution command. Replay-limit/gap diagnostics
warn without themselves inventing an execution failure or restarting work.
This is bounded recovery, not a promise of unlimited history. Generic external
debuggers without that handshake retain their ordinary no-auto-reconnect behavior.

**SES-03 — Preserve existing request ownership.** Pending request progress/results
resolve against the admitted request/runtime, not the selected tab. Early outputs
may resolve a result while an owned execution/recording tail remains. An idle
hosted owner may hand off only after positive idle evidence and guarded discovery;
an accepted/uncertain run remains pinned. Display routing does not discover owners,
open sockets or decide whether to replay a request.

## Recording playback and retained evidence

**REC-01 — Exact playback owner.** Recording selection is tied to the project ID and
file path, including virtual child-recording tabs. Async file-picker acceptance
rechecks its owner. Tab switching is allowed; closing/replacing the owner must not
clear or take over a neighboring tab. Loading/unloading playback does not overwrite
its live executor preference. Existing recording-load restrictions while busy remain.

**REC-02 — Each Play replaces canvas replay history.** Before the first replay event,
reset only the accepted owner's display, including child recordings with `graphStart`
but no root `start`. Preserve configured frozen outputs and the separate retained
Run Activity journal. Repeated Play does not append another copy to the canvas's
Execution n/n history. Genuine repeated invocations within one recording remain
distinct, and replay invocation identities are fresh. Saving a recording exports
the original artifact, not a newly recorded accelerated replay.

**REC-03 — Replay is evidence, not a live bundle run.** Historical replay-marked
events do not enroll live bundle receivers or create another recorder/upload. User
input/pause history is observational, not a reopened live question or a command to
pause another run. Historical timing is retained separately from fresh receipt/run
ordering. Old child recordings without execution metadata remain supported by
existing fallbacks; do not substitute the currently visible graph as the entry.

**REC-04 — Cancellation and late completion stay scoped.** Playback reservation,
selected recorder/history identity and run-session cleanup prevent duplicate Play
starts or stale async reset/stop operations affecting a new owner. Standalone
desktop playback without an opened-project registry remains supported. An already
reserved playback's handling of path changes is not identical to fresh playback
admission; preserve existing ownership tests rather than imposing a generic rule.

## Snapshot, history and data-reference behavior

**STA-01 — Active and inactive results are equivalent views, not execution owners.**
Today active atoms and `projectExecutionSnapshotsState` are separate stores with
capture/restore during activation. The shared passive update boundary ignores
closed tabs, captures the active target or reads the inactive target, runs one
synchronous update, and restores only changed active fields. Large payload
identity is preserved. This is not yet the proposed canonical per-binding store.

**STA-02 — Preserve the complete snapshot.** Covered fields are `graphPaused`,
`graphRunHistoryByView`, `graphRunning`, `graphStartTime`, `frozenNodeOutputs`,
`lastRecording`, `lastRunDataByNode`, `rootGraph`, `runActivityJournal`,
`runningGraphs`, `selectedGraphRunByView`, `selectedProcessPageNodes`,
`selectedLLMChatOutputPageByInvocation` and `userInputQuestions`. Adding/removing
a field requires updating exhaustive capture/restore and its tests. Node, graph,
caller-process and split identities must survive historical view selection.

**STA-03 — Terminal evidence wins over stale partials.** Late partial output cannot
reopen a terminal process or erase retained terminal error outputs. Repeated graph
starts/terminals cannot consume a sibling's running slot. Existing selected-page
rules remain mode-aware: an explicit numeric inspection page is not indiscriminately
reset to latest, and split partials retain their established follow behavior.
Hidden source prompts clear only on matching terminal evidence; passive prompts
remain observational. Existing frozen/preload and partial rerun rules are preserved.

**STA-04 — Reference effects happen once.** Shared snapshot updates execute storage
effects synchronously, not inside a potentially reevaluated React state updater.
Retention uses configured history limits and releases evicted/obsolete refs without
dropping still-retained evidence. Replay reset installs new state before releasing
old refs. Source and passive journaling must not allocate duplicate evidence.
Optional activity-projection failure does not discard the primary snapshot.

**STA-05 — Data safety and execution preparation.** Source execution captures authored
project/context/settings and entry datasets before asynchronous preparation can
switch providers. Desktop bundle runs include unsaved source edits but read saved
dependencies; save dependency edits before calling them. Run-local dataset writes
do not mutate extracted project files/editor datasets. Preparation reserves the
run and supports cancellation; late reads/environment preparation cannot start
cancelled work. WebSocket preparation binds the actual ready connection and
effective runtime before uploads/dispatch. No display refactor may weaken these
existing guards, alter save/conflict behavior or rewrite authored data.

## Current differences and characterization gaps

These are source-checked facts, not additional claims that the listed scenarios
have full UI coverage. They must be characterized before consolidation. Fixing a
discrepancy should be an explicit, tested behavior decision, not an accidental drift
or a reason to preserve a known bad outcome.

- **GAP-01 — Local versus remote journal input.** The local bundle router currently
  sends the rebased canvas payload to the snapshot reducer without separate
  `activityData`; the remote router passes original activity payload (or `false`
  for source return calls). Therefore REM-07's original-ancestry guarantee is not
  established for local receiver journals. Add a local repeated-child/return-call
  journal characterization before claiming shared behavior there.
- **GAP-02 — Conflict observation timing.** LOC-03 is explicitly tested before the
  first child and synchronously across between-event changes. Remote members are
  created on their first eligible event; reconciliation operates on members and is
  microtask-coalesced during tab restoration. Do not claim identical capture of
  transient pre-first-member or same-turn conflicts without an adapter-level test.
- **GAP-03 — Metadata cleanup is not one shared contract yet.** Local maps are
  hook-owned and deleted at identified root terminals; they have no shared explicit
  disconnect-retirement API. Remote maps have disconnect/dispose/sweep behavior
  and completed-history caps. The 40-root local stress tests prove continued/fenced
  routing, not bounded memory after every missing-terminal/disconnect permutation.
  Thousands-of-roots disposal/performance checks remain refactor work.
- **GAP-04 — Definition/ancestry checks differ.** Remote projection checks current
  graph/node definitions, warns on unsaved mismatch and requires known caller
  ancestry. Local projection checks bundle/path/conflict identity but has no
  equivalent adapter definition warning. Do not copy either policy to every mode
  without characterizing unsaved/missing graph and A → B → A behavior.
- **GAP-05 — No common binding generation/envelope/store exists.** Local routing
  uses captured paths/keys plus subscriptions; Remote Debugger uses receiver tokens,
  session membership generations and session admission. Source-change semantics
  intentionally differ between LOC-04 and REM-04. A unified runtime registry,
  normalized envelope and canonical state are proposed, not current capabilities.

## Behavior-to-code/test map

Paths in the following table are relative to `packages/app/src/` unless qualified.
Tests are behavioral owners, not source-text assertions. Existing test names remain
the lookup key when a refactor moves a file; update this map with the move.

| IDs | Current owning code | Automated comparison anchors |
| --- | --- | --- |
| MEM-01–03 | `hooks/remoteDebuggerBundle.ts`, `state/savedGraphs.ts` | `hooks/remoteDebuggerBundle.test.ts`; `hooks/useLoadProject.test.tsx` workspace membership; `hooks/useBundleExecutionRouting.test.tsx` new-open and independent rejection guards |
| LOC-01–08 | `hooks/useBundleExecutionRouting.ts`, `hooks/useLocalExecutor.ts`, `providers/ExecutorSessionContext.tsx` | `hooks/useBundleExecutionRouting.test.tsx`: conflict timing, binding fences, pressure, terminals, nested/cloned-ID outputs; two `hooks/useLoadProject.test.tsx` cases retain real desktop/hosted tab-activation integration |
| REM-01–05 | `providers/ExecutorSessionContext.tsx`, `hooks/useRemoteDebugger.ts`, `hooks/remoteExecutionObservation.ts` | `providers/ExecutorSessionContext.test.ts`: shared attachment from dependency/shared Stop/source reopen; `hooks/remoteExecutionObservation.test.ts`: actual-root priority, outside root, closed intermediate, lifecycle |
| REM-06–10 | `hooks/useRemoteExecutionObservations.ts`, `state/remoteObservation.ts`, `components/RemoteDebuggerInfo.tsx` | `hooks/remoteExecutionObservation.test.ts`: waits, pause, mixed versions, capacity, abort; snapshot event tests; full remote bundle UI matrix; definition checks are also source-inspected |
| SES-01–03 | `hooks/executorSession.ts`, `hooks/remoteExecutorHelpers.ts`, `hooks/useRemoteExecutor.ts` | `hooks/executorSessionResume.test.ts`, `hooks/remoteExecutionObservationSession.test.ts`, `hooks/remoteExecutorHelpers.test.ts`, session/runtime suites |
| REC-01–04 | `hooks/useLoadRecording.ts`, `hooks/recordingPlaybackDisplay.ts`, `hooks/useLocalExecutor.ts`, `state/execution.ts` | `hooks/recordingPlaybackDisplay.test.ts`: repeated child/root/legacy replay; stale owners and preparation; recording-playback UI |
| STA-01–04 | `hooks/projectExecutionSnapshotRouting.ts`, `hooks/projectExecutionSnapshotBindings.ts`, `hooks/projectExecutionSnapshotEvents.ts`, event/ref helpers | corresponding routing/bindings/events tests; terminal/ref/selection assertions; existing execution-data transition/storage suites |
| STA-05 | `hooks/preparedEditorRun.ts`, `hooks/editorRunSession.ts`, bundle IO/runtime, `hooks/useLocalExecutor.ts`, `hooks/useRemoteExecutor.ts` | prepared-run/session/connection/dataset suites; desktop bundle UI; `packages/app-executor/bin/executor.projectBundle.test.mts` |
| GAP-01–05 | implementation differences described above | source inspection only unless a narrower existing test is named; not a green acceptance certificate |

## Evidence captured before refactoring

- **Original local unit baseline, 2026-10-24:** 256 tests passed, zero failures/skips,
  in `artifacts/execution-routing-functional-baseline-unit.log`. This ran 11 files
  before the test-only consolidation described below; it is not the entire repo test suite and does not
  cover every source-checked adjacent guarantee by itself.
- **Earlier local headless evidence, re-read for this baseline:**
  `artifacts/bundle-routing-admission-ui-final.log` has five passing checks: desktop
  Browser bundle IO/execution, real hosted Node in single-host and replicated
  fixtures, and Remote Debugger source-reopen/member-deleted scenarios. No compiled
  Tauri app or GKE environment is implied.
- **Earlier broader browser receipt:** `artifacts/bundle-routing-review-ui.log`
  records 15 passing checks: the three desktop/hosted cases plus the 12-outcome
  Remote Debugger matrix. Later routing fixes have the narrower five-check receipt;
  do not label the earlier full matrix as re-run against the latest changes.
- Relevant additional UI specifications exist for repeated recording playback,
  local editor recording capture, recording selection and evaluation history.
  Their source specifies regression scenarios; they were not re-run during this
  documentation-only update. Do not infer a new pass from this list.
- The refactor's new binding registry, lifecycle envelopes, generated-sequence
  harness, memory budgets and performance measurements have not been implemented
  or qualified. They are not covered by the 256-pass count.

### Test-only consolidation (2026-10-24)

Runtime behavior and the numbered baseline above are unchanged. Local routing
tests now live in `hooks/useBundleExecutionRouting.test.tsx` with a minimal real
hook/Jotai/React fixture. The two desktop/hosted tests in `useLoadProject.test.tsx`
retain actual workspace activation. The routing portion uses 19 focused cases
instead of 35 full-workspace cases: only two still need full-workspace setup.
All 18 owner × timing × active/inactive conflict combinations remain covered;
three owners share each timing fixture using distinct roots and labeled assertions.
Pressure checks exercise a blocked and an eligible sibling together, and all four
terminal forms share one fixture with fresh positive controls.

The prior long smoke test's replay/membership assertions ran after a sticky
conflict had already blocked the receiver. They are replaced with independent
rejection scenarios and a positive control after each. Guards cover replay,
foreign desktop/hosted membership, authoritative detachment, excluded portable
dependencies, missing metadata/start, a foreign project shaped like a root and a
source-project child. Positive controls prevent an always-rejecting router from
passing the suite. Pressure asserts actual output values, not just snapshot identity.
The snapshot-binding test now counts a real large-payload ref allocation as well
as reducer invocation and unchanged-atom notifications.

Four temporary mutations were detected independently: omitted replay rejection,
omitted root-project check, omitted parent check and omitted initial-conflict
capture. Expected failures are retained in
`artifacts/execution-routing-test-audit-{replay,root,parent,conflict}-mutant.log`.
Runtime source was restored and compared with its pre-audit contents before UI
verification; no production implementation change is part of this test cleanup.
These four probes are evidence for those guards, not a whole-suite mutation score.

`artifacts/execution-routing-test-audit-unit.log` records 240 passing focused tests
after consolidation, with zero failures/skips. CI's normal recursive discovery
includes the new TSX file; shard/discovery regressions pass too. Distinct transport,
legacy playback, failure and actual UI integration tests are intentionally retained.
`artifacts/execution-routing-test-audit-ui.log` records five passing headless
desktop/hosted/Remote Debugger checks after the audit. Type-check and focused lint
pass in the corresponding `execution-routing-test-audit-types.log` and `-lint.log`;
disposable hosted fixture containers were verified absent after completion.
Fewer counted cases are not the acceptance goal: unchanged scenario coverage and
stronger assertions are. Raw full-run timings are similar and noisy; this is not
claimed as a measured wall-clock speedup.

### Test-fixture review (2026-10-24)

The follow-up keeps the same case matrix and application behavior, but tightens
the test contract in `useBundleExecutionRouting.test.tsx`:

- Child graph-run IDs include their owning project, so sibling calls cannot
  accidentally reuse one global invocation ID. Fixture graphs actually declare
  the cloned node IDs that their event streams emit.
- Rejection/fence checks compare cloned **complete execution snapshots**, not only
  node-output history references. The guard matrix starts with retained evidence,
  matching a tab that has already displayed a run. Graph history, running slots,
  selections and Run Activity must remain unchanged as well as output values.
- A selective mutation allowing only replayed `graphStart` through the guard passed
  the old node-history-only assertion once existing history was seeded. The complete
  snapshot assertion catches it. Receipts are
  `execution-routing-test-review-graph-only-seeded-before.log` (false green with the
  mutation) and `execution-routing-test-review-graph-only-after.log` (one expected
  failing case, with the other 16 passing). Runtime code was restored afterward.
- One early-registered `t.after` owns unmount and global/storage restoration,
  including setup/assertion failures, rather than seven copied caller teardown
  wrappers. Restoration runs in `finally` even when unmount fails.
- Workspace smoke and payload-allocation fixtures use complete typed Core events
  and built-in nodes instead of hiding missing event fields behind broad casts.
  In the new routing fixture, broad event-shape casts remain only for deliberate
  malformed producer input; ordinary branded test-ID casts are still appropriate.

This is test hardening, not implementation of the proposed routing refactor or
resolution of GAP-01–05. The prior full browser receipts remain separate; fresh
review verification is recorded under `artifacts/execution-routing-test-review-*`:
240 focused tests pass with no failures/skips, plus type-checking, focused lint and
one headless desktop-bundle UI smoke check. The hosted/Remote Debugger browser
matrix was not re-run during this test-only review. The case count is unchanged.

### Adjacent test coverage (2026-10-24)

The neighboring remote-observation and snapshot-map tests now verify three
previously unobserved distinctions without adding cases:

- Map updates and disconnect cleanup retain another project's live snapshot and
  do not mutate the prior map. The disconnect case also checks the target's actual
  node interruption, not just its root-running Boolean.
- Remote canvas metadata is compared with a complete rebased expectation while
  Run Activity is checked against the original project scope/caller/executor
  ancestry. Nested-call input is built from original, not rebased, evidence.
- Settlement spies retain one typed `completed | error | aborted` record instead
  of a lossy success Boolean plus a parallel outcome list. Disconnect/dispose
  assertions distinguish an interrupted observation from a runtime error.

The retention check also restores and compares the exact surviving large input
payload instead of accepting any truthy port map. Normal storage-event fixtures
use complete typed events; deliberate legacy missing-field coverage remains.

Two temporary faults—dropping neighbor snapshots and stripping activity ancestry—
passed all 33 old adjacent tests, then produced three expected failures after the
assertions were strengthened (`execution-routing-adjacent-tests-mutants-before.log`
and `-mutants-after.log`). A separate disconnect-as-error mutation passed 28 old
observation tests and now fails two exact-status checks (`-status-before.log` and
`-status-after.log`). Both runtime files were restored and compared with their
pre-audit contents. These are demonstrated test blind spots, not newly observed
production defects or a whole-suite mutation score. Review receipts live under
`artifacts/execution-routing-adjacent-tests-*`; the functional baseline is unchanged.
Fresh checks pass: 240 focused tests with zero failures/skips, two headless Remote
Debugger scenarios (completion and HA-style replay), type-checking, focused lint,
test-style, documentation and repository checks. Case count remains unchanged.

Current repeat command (including the extracted suite):

```powershell
yarn workspace @valerypopoff/rivet-app test:files src/hooks/useBundleExecutionRouting.test.tsx src/hooks/useLoadProject.test.tsx src/hooks/remoteDebuggerBundle.test.ts src/providers/ExecutorSessionContext.test.ts src/hooks/remoteExecutionObservation.test.ts src/hooks/remoteExecutionObservationSession.test.ts src/hooks/projectExecutionSnapshotEvents.test.ts src/hooks/projectExecutionSnapshotRouting.test.ts src/hooks/projectExecutionSnapshotBindings.test.ts src/hooks/recordingPlaybackDisplay.test.ts src/hooks/remoteExecutorHelpers.test.ts src/hooks/executorSessionResume.test.ts
```

Ignored artifacts may not exist in a fresh clone. Preserve their sanitized receipts
with the reviewed baseline when starting implementation, or re-run the commands;
the committed behavior IDs and test source remain the durable comparison guide.

### Commit-preparation verification (2026-10-24)

The current focused command above passes all 240 tests, with no failures or
skips; the app TypeScript check also passes. The 73 focused API ownership,
maintenance, restore and runtime-profile checks pass separately. The web suites
pass 212 behavior tests and 39 development/production build-process tests.
Six headless browser checks pass: dashboard saving, desktop bundle IO/execution,
single-host and replicated hosted execution, and Remote Debugger source-reopen
and member-deletion behavior. Disposable hosted fixture containers are absent
afterward; the separately running local development stack is preserved.
These are local checks, not a new provider qualification or implementation of
the proposed execution-routing refactor. Receipts are kept separately under
`artifacts/commit-prep-*.log`; ignored receipts are not part of the release.

## Post-refactor UI comparison checklist

Use synthetic A/B/C projects, including deliberately cloned graph/node IDs, an
unrelated D, an explicit desktop bundle and a separate Server bundle. Use gates
to hold execution rather than relying on arbitrary sleeps. These steps specify
comparison work, not a claim that every variation was just manually executed.

1. Run A → B → C through Browser and both internal Node modes. Switch to B/C while
   A is still running and again after it completes; inspect actual outputs and
   invocation selection. D and unexecuted members must remain unchanged.
2. Repeat with multiple B calls, a B-local nested graph, failure in C, cloned IDs
   and an A → B → A return graph. Verify source/passive journals separately;
   record GAP-01/GAP-04 outcomes before changing them.
3. For local projection, introduce each ownership conflict before root start,
   between child events and before the first child. End the conflict and confirm
   old-root data stays excluded; a new root displays normally. Check active and
   inactive receivers. Characterize remote pre-member timing separately (GAP-02).
4. Close/reopen or rebind B, leave/rejoin its bundle, and open C after admission.
   No old partial history may attach to a replacement. Change the source binding
   and compare the intentionally different local/remote rules.
5. Connect Remote Debugger from B, not A. A/B/C share controls before any graph runs.
   Open details, inspect source/version/wait/pause/interruption labels, navigate to
   the actual source, and Stop from C. Stopping observation must not abort runtime
   work; inspect retained values and restored own executor preferences afterward.
6. Interrupt and resume negotiated hosted/latest-debugger transport. Verify one
   logical run, no repeated run/upload/write commands, deduplicated evidence and
   explicit unknown/gap behavior. Test a non-resumable debugger separately.
7. Play root, child, nested child, legacy child and prompt-child recordings three
   times each. Canvas Execution n/n must not grow per click; genuine invocations
   remain. Switch tabs during preparation/playback, close/rebind the owner, unload
   and load another recording, and save the original artifact for equality checking.
8. Preserve frozen outputs, explicit process/LLM page selection, error outputs,
   historical durations, hidden prompts and Run Activity through tab changes.
   Save edited projects during ordinary observation and verify no false conflict
   dialog or loss of unsaved graph/data changes.
9. Run concurrent and completed-root pressure with a held root. Assert continued
   eligible updates and retained exclusions; then retire sources and measure
   metadata/ref cleanup separately from retained visible history (GAP-03).
10. Verify Browser/Evaluation trial isolation and existing hosted evaluation job
    ownership. No trial terminal should stop another trial or acquire ordinary
    bundle canvas/control ownership accidentally.

Use the repo headless runner with `PLAYWRIGHT_HEADLESS=1`, `PLAYWRIGHT_SLOW_MO=0`
and a local `PLAYWRIGHT_BASE_URL`. The owning specs are
`desktop-project-bundle.spec.ts`, `hosted-subgraph-auth.spec.ts`,
`remote-bundle-observation.spec.ts`, `recording-playback-history.spec.ts`,
`local-editor-recordings.spec.ts`, `run-recordings-modal.spec.ts` and the affected
evaluation/session specs. Run the full affected matrices at the final gate, not
just a convenient subset. Inspect `artifacts/playwright/` failures and verify
disposable local fixture cleanup. No paid cloud rehearsal is needed for these checks.

Before claiming parity, attach an ID-by-ID report with source version, actual test
commands/results, separate UI evidence and explicit unresolved characterization
items. Passing a refactor's new unit tests alone is not the comparison.
