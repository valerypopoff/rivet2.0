# Execution coordination

Implemented locally on 2026-10-24. This is an editor-only refactor: no graph
scheduler, project/bundle/recording format, database, deployment or provider changes.
Compare behavior with the frozen [baseline](./EXECUTION-ROUTING-BEHAVIOR-BASELINE.md).

## Ownership and writer inventory

| Ingress / writer | Authority | Display/state boundary |
| --- | --- | --- |
| Browser processor and recording player, `useLocalExecutor` | Captured `EditorRunSession`, processor and recorder; never the selected tab | Captured binding guard; local observation adapter; ordinary active dispatcher or inactive snapshot reducer |
| Desktop/hosted Node, `ExecutorSessionContext` and `useRemoteExecutor` | Existing executor runtime, request admission and pending result registry | Local observation adapter for dependencies; source handlers retain request/recording accounting |
| External Remote Debugger, `executorSession` | Existing socket generation, logical session, cursor/replay deduplication and root admission | Remote observation adapter and shared display admission; reconnect never issues a run command |
| `useGraphExecutionEvents`, `useNodeExecutionEvents`, `useExecutionDataFlow`, `useRunActivityExecutionEvents` | Existing active-source presentation policy (partial/preloaded/evaluation state, prompts and notifications) | `useExecutionSnapshotWriter` and the same snapshot transition functions as inactive/passive events; field lenses are compatibility/read APIs |
| `projectExecutionSnapshotEvents` | Inactive/passive data transitions and once-only reference effects | `updateOpenProjectExecutionSnapshot`; no React updater owns payload allocation |
| `recordingPlaybackDisplay`, menu reset/freeze operations | Explicit playback/reset owner | Same canonical snapshot; recording identity permits an explicit path move, not replacement by a different recorder/history |
| Workspace load/close | Authored document and tab lifecycle | Load selects the view; close clears refs and removes only the closed project's snapshot |

Execution, controls, recording and observation are separate owners. The display
coordinator cannot run, cancel, pause, resume, upload or resend a command. Existing
source handlers keep their intentional notification/preload/evaluation policies;
they are not replaced with a generic passive reducer.

## Shared run preparation and artifact policy

`hooks/preparedEditorRun.ts` synchronously captures the authored project/current
graph, static data, inputs, settings and project-context values before awaited
preparation. Callback and runtime handles remain references, not cloned objects.
Browser and Node consume this same snapshot; environment resolution, bundle
loading and transport admission still run at their existing adapter boundaries.
Context extraction creates own properties even for IDs such as `__proto__`,
`constructor` and `toString`, retaining deep-copy isolation and JSON portability.
The Context Value editor likewise uses immutable own-property map updates rather
than invoking prototype setters through a draft.

`utils/editorRunRecording.ts` owns capability-approved recording destinations,
correlation IDs, artifact serialization and the single persistence attempt. The
adapter supplies its eligibility policy: Browser excludes playback; Node permits
hosted local runs but excludes desktop/external targets and web-app requests.
Capability failure disables hosted artifact storage, not execution. Browser can
still retain its in-memory replay without serializing a project or exporting
datasets when no hosted destination exists.

The adapter, not the artifact helper, owns settlement and exactly-once ingress:
Browser calls through `EditorRunSession` disposal only after processor completion;
Node removes its request-scoped capture once and requires terminal evidence before
calling persistence. Early outputs, abort notifications, tab replacement and
recoverable socket reconnects do not become permission to finalize or rerun work.
Incomplete Node capture keeps its existing unavailable-reporting path. Creation
time and final status are captured by the run owner; duration is measured before
asynchronous artifact IO. Dataset export still happens at finalization for the
captured project ID. Artifact failures mark that correlation unavailable without
retrying an uncertain write or changing graph results. Observation/display guards
remain outside persistence, so stale canvas admission cannot discard an accepted
run's recording. Evaluation verdict/temporary-recording policies remain in their
separate, already-shared helpers.
The in-memory replay notification is a separate failure boundary: a throwing
display observer is logged but cannot skip the hosted write or falsely mark its
otherwise valid artifact unavailable. Serialization, dataset and actual storage
failures retain the existing one-attempt/unavailable policy.

Output normalization, inline/ref history storage, strict and best-effort
restoration, partial-run preloads and reset partitions preserve own-key
semantics. User-defined port/node IDs such as `__proto__` must not become
prototype assignments or vanish from JSON. Missing-ref handling and retained
payload identities remain unchanged. The isolated Browser preload test runs a
Code node with such an output port, then invokes **Run from here** on its
consumer. Recorded `resultOrigin: preloaded` source events and the final output
prove that retained evidence was reused rather than physically executing the
source. The fixture is included in the balanced CI browser shards.

## Runtime binding generations

`state/projectBindings.ts` holds one registry per Jotai store. The pure
`domain/execution/projectBindingRegistry.ts` assigns monotonic, non-recycled tokens.
Reconciliation checks own keys, not inherited Object properties. Closing an
opaque project ID such as `constructor` must retire its binding just like any
other ID; reopening always gets a fresh token.
Execution snapshot and observation readers also require own entries. Inherited
Object members are not a snapshot, observer list or notice. The central snapshot
writer rejects absent own tab metadata before running update/reference effects.
`projectsState` reconciles at every write, including close/reopen in one synchronous
turn; hydration is reconciled on read. Project IDs and paths alone are not lifetimes.
Actual clean file/snapshot replacement renews the token at the synchronous
`useWorkspaceTransitions` commit (or the inactive replacement commit in
`useWorkspaceHostReplaceProjectSnapshot`). Failed asynchronous preparation does not publish
a new binding. Ordinary save/title changes, graph navigation and tab selection do
not renew a token. Rebinding a path or explicit bundle identity does.
The recovery screen can read tab state after checkpoint validation fails. Binding
derivation therefore ignores null, primitive and array-valued entries without
mutating the saved record. These entries cannot retain an execution lifetime;
valid neighbors retain theirs. The authoritative checkpoint validator still
rejects malformed workspace identities, and recovery controls remain usable.

Hosted null is authoritative detachment. Membership comes only from a hosted
bundle identity or desktop manifest, never reference reachability or folder names.
The neutral `bundleMembership.ts` is shared with the existing debugger membership API.
The app's Node and bundle-debugger transports use these same tokens. Internal
requests capture the originating token when the request is admitted, including
before its first frame. Re-observing an existing request does not recapture a new
owner. Replaced-tab frames are display-ineligible, but explicitly identified
pending results and recording accounting still settle; no run is resent or aborted.
`accountRemoteRunSessionEvent` runs at the request subscription boundary before
display admission. For an owned, identified request, early outputs retain the run
session and cancellation tail until `done`/`error`; an abort notice does not dispose
it. Internal request progress, storage callbacks and response traces may complete
after a same-tab replacement, without dispatching canvas events. External debugger
frames and unidentified legacy frames do not gain request ownership through this path.
Node preparation rechecks the captured token immediately before upload/dispatch.
Browser preparation rechecks immediately before `processGraph`; replacement during
an asynchronous environment/bundle read cannot start obsolete authored code. This
is distinct from already-accepted execution: display loss alone does not abort a
live processor, and its failure/recording accounting still completes.
Explicit document replacement retires old display controls/running evidence while
preserving retained outputs and recordings; it does not cancel the executor.
The final local-ingress release renews every open binding and the workspace epoch,
retires displayed controls, and preserves output/reference identities. Browser and
recording callbacks capture that epoch; standalone Node requests include it in their
fallback lifetime. Reusing a Jotai store after provider disposal cannot revive old
callbacks. Releasing just one of several ingress hooks does not dispose the workspace.
The standalone pure
registry tests can use the existing membership serial fallback.

## Shared admission, distinct adapters

`executionObservationCoordinator.ts` is a workspace-scoped, metadata-only owner.
`executionDisplayPolicy.ts` captures eligible receiver generations at root start
and permanently fences a receiver after ownership conflict or replacement.
Opening a tab later, or releasing a conflict before its first child event, does
not admit that tab midway. New roots can capture it normally. Rejection diagnostics
are a 64-entry ring of root/project IDs and typed reasons; no event payloads,
outputs, prompts, credentials or project contents are retained.
Each rejection includes source kind/project and captured/current binding tokens;
the ring still holds at most 64 metadata-only entries.

The local adapter is pure `localExecutionObservation.ts`; its hook is only store,
reference and subscription integration. Browser and internal Node ingress share
one local adapter per workspace, not independent hook-local maps. The final hook
release and explicit source disconnect/settlement retire its metadata.

Remote Debugger retains its intentional differences: external caller roots may
continue feeding open bundle dependencies after their source tab closes; source
display remains fenced by transport admission. It checks runtime graph/node
definitions and known caller ancestry, keeps up to 32 completed observations, and
refuses excess active roots instead of evicting them. Local execution does not
acquire remote view-only controls or require an external-runtime definition match.
Both adapters use the same sticky receiver policy. Canonical state eliminates
the old intermediate tab-restoration flags, so ownership checks are synchronous.
An explicit membership removal can retain a blocked explanation for the still-open
document. Its old receiver token is never transferred to event admission. Actual
file replacement or close/reopen removes old provenance instead.
The blocked explanation may cross only the first membership transition. A further
binding renewal drops it even when the file path is identical; comparing the old
bundle key and path alone cannot distinguish that reload from the original detach.
Ownership reconciliation itself performs this generation sweep, not just the
project-list listener. Same-path replacement can renew a binding through execution
state without changing the project list. All ownership subscriptions therefore
use the same reconciliation entry point; no separate generation-cleanup path is
required from callers.

Observation publication and settlement can synchronously notify ownership
subscribers. The run's member map remains the authority across those callbacks:
cleanup clears membership before removal notifications, and an in-flight event
cannot project or republish a removed member. Each member claims its terminal
status before settlement callbacks, so a concurrent disconnect does not settle
it again. Conflicts raised in another dependency during that callback remain
blocked rather than being overwritten by the terminal event. This changes
display retirement only; no execution command or recording write is replayed.
Blocked and membership-detachment publication also capture the binding token
before notifying subscribers. Their pending settlement rechecks that exact token
after publication; a callback-created replacement cannot inherit the old write.
When a passive project becomes a source, retiring its earlier observations can
also synchronously disconnect the shared debugger. Finish removing that exact
old observation, then compare the source object with the current registry entry
before continuing admission. A disconnected or replaced source cannot capture
an orphan root; reconnecting under the same runtime key is a new lifetime.

`executionEventNormalization.ts` exhaustively classifies every protocol message.
The internal envelope records adapter kind, source, project/request/binding hints,
origin and lifecycle without altering its payload. Live, reconnect, replay and
recording origins remain distinct. Recording events never enroll passive live tabs.
Outputs-ready, abort requested and display terminal are **not** proof of process
settlement. Browser cleanup retires the source only after `waitForRunCompletion`.
Older Node messages have unknown settlement; only completed display tombstones are
bounded, and disconnect retires the source. None of this releases execution controls.
Identity-free Browser terminal notifications are copied into a display-only envelope
using the captured processor root. Recorder payloads are untouched. Identified active
and inactive completion reconcile that exact root instead of consuming another
root's FIFO confirmation. Legacy identity-free completion keeps its existing fallback.

Canvas ancestry is rebased into each project. Run Activity receives original
cross-project ancestry; return calls into the source use `activityData: false`
because the source already journals the raw event. `projectExecutionObservationSettlement`
settles only that root's passive journal, unfinished node evidence and graph slots.
Observer errors are caught and cannot fail the processor or recording writer.

## One execution-state authority

`state/projectExecutionSnapshot.ts` owns the sole primitive snapshot map and empty
snapshot factory. `state/projectExecutionStore.ts` supplies selection and field lenses;
this separation prevents a runtime import cycle through project selection. All fourteen
former active atoms, including last recording and input questions, are writable
lenses into the selected project's entry. Switching `projectState` selects that
entry immediately; it does not transfer payloads through fourteen competing atoms.
Changing an inactive snapshot and changing an active lens update the same map.
Unchanged payload/reference identities remain unchanged. Missing additive fields
in old in-memory snapshots use empty defaults.

`projectExecutionSnapshotBindings` remains a small explicit capture/reset API for
recording/reset callers and tests, not tab-switch machinery. Workspace activation
no longer persists or restores execution copies. The obsolete persistence method
and exhaustive duplicate field-binding table have been removed.

### Completed event-path consolidation

The initial refactor established canonical storage, but that alone did not finish
P4: interactive hooks still duplicated the inactive reducer's mutations. The
completion audit moved graph/node history, streaming updates, prompt state, LLM
round history, agent traces and reference effects onto the shared snapshot
transitions. `useExecutionSnapshotWriter` is the interactive adapter into the same
generation-checked commit boundary used for inactive and passive updates.

`routeProjectExecutionDisplay` owns view-selection policy. Browser/Node ingress no
longer writes snapshot maps or copies execution state based on the selected tab.
The old map-transform/selection/disconnect exports were removed; their tests now
exercise the real writer. A CI guard rejects direct history writes in the seven
ingress/presentation adapters, in addition to the pure-domain import boundary.

Presentation policies remain explicit: preloaded-node suppression and current-view
follow-latest belong to interactive handlers; interactive start can retain partial
run evidence or evaluation accumulation; root error notifications can retain the
node evidence while cleanup continues. Passive adapters do not acquire these
controls. These choices feed the common transitions, not another data reducer.

Legacy graph-finish/done reconciliation uses `completedRootRunIds` in each runtime
snapshot instead of an active hook-local FIFO. It follows the project on tab
selection, resets on start/stop/replacement, and is never serialized into a project,
bundle or recording. Existing snapshots without it use an empty queue.
Passive settlement also removes that exact root's confirmation: rebased dependency
graph finishes can enqueue it, but passive tabs do not receive source `done`.
Other roots' pending confirmations and retained output data remain untouched.

Inactive request accounting/progress callbacks run before entering the snapshot
transform. Their originating binding is captured first and checked again before
display/reference effects. A synchronous callback may close/replace its tab or
update its retained state; the event must neither resurrect the old tab nor commit
a snapshot read before that callback. The same current binding still receives the
event normally. Keep external callbacks outside snapshot transforms.
Successful completion collects missing-terminal diagnostic metadata during the
transition, commits the terminal snapshot, then notifies diagnostic listeners.
The transition policy accepts a metadata array, not an external listener. Listener
replacement of a snapshot is preserved; a listener exception is logged without
turning the successful execution into a failure or preventing terminal cleanup.

Browser evaluation trials capture an activity-only sink before asynchronous
preparation. Accepted trial cleanup journals to that originating open binding even
after another tab is selected; close/reopen, replacement or workspace retirement
rejects the stale sink. Starting another trial also requires that same binding to
remain selected. This does not fan evaluation data onto bundle canvases, allocate
node payload refs or grant the journal execution-control ownership.

`executionSnapshotParity.test.tsx` drives real interactive hooks and inactive
routing through success, failure, abort, pause/resume, prompts, late streaming
callbacks and clear-history transcripts. Every step compares the complete state,
payload references and reference-deletion effects in independent stores. Existing
node-history tests additionally cover logical LLM rounds and retained invocation
metadata; policy-specific tests retain partial/evaluation distinctions.

## Extension checklist and verification

1. Put new wire messages in the exhaustive lifecycle table. Do not infer physical
   settlement from an early result, abort or error notification.
2. Capture the exact originating binding before asynchronous work. Use shared
   admission and the token-checked snapshot boundary for passive writes.
3. Retain original activity ancestry separately from canvas rebasing. Never allocate
   the same payload refs through both active and inactive paths.
4. Keep new source-specific behavior in an adapter/policy; do not add another
   tab-lifetime map, transport owner, persisted field or active-state replica.
5. Exercise close/reopen/rebind, transient conflicts, outputs-before-cleanup,
   reconnect/replay and disposal. The domain import check rejects framework/state
   imports; it extends the existing `scripts/checks/check-editor-boundaries.mjs`
   gate in `test:style`, with policy regressions in the same CI job. App shard
   discovery automatically includes the new nested domain/state test files.
   The framework boundary includes React DOM entry points, not just `react` itself.

Focused tests: the baseline's twelve files plus
`src/domain/execution/executionCoordination.test.ts` and
`src/state/projectExecutionStore.test.ts`. The latter cover store isolation,
canonical view selection, token checks before ref effects and actual workspace
write boundaries. The pure sequence harness runs all adapter lifecycle categories,
Browser/desktop/hosted passive streams, concurrent fences and 5,000-root disposal.
Sixteen deterministic seeds exercise 128 interleaved admission, conflict, renewal,
workspace invalidation and settlement transitions each. Failure messages identify
the seed, step and root, so the exact metadata-only sequence can be replayed.
Existing real browser suites cover desktop bundle IO, hosted Node, Remote Debugger,
recording replay, Run Activity, local recordings and evaluations.

### Local comparison receipts (2026-10-24)

The source baseline is `1ebeef366`; receipts are ignored diagnostic artifacts, not
release or provider certificates. Counts below overlap and must not be summed as
unique scenarios.

| Baseline IDs / boundary | Result and receipt |
| --- | --- |
| MEM-01–03, LOC-01–08, REM-01–10, SES-01–03, REC-01–04, STA-01–05 | 269 focused unit/adapter/workspace tests pass in `artifacts/execution-refactor-final-unit.log`; original policies retained except the dated GAP corrections in the baseline |
| Snapshot data/ref/selection, save and Run Activity seams | 202 adjacent regressions pass in `artifacts/execution-refactor-adjacent-unit.log` |
| Desktop bundle, both hosted topologies, complete remote observation matrix, repeated playback, local recordings, evaluation history | 41 headless UI checks pass in `artifacts/execution-refactor-final-acceptance-ui.log` |
| Final lifetime hardening | 12 headless checks pass in `artifacts/execution-refactor-final-lifetime-ui.log`, including a gated live Browser run: same-path replacement fences display without cancelling accepted work; a following node still executes exactly once |
| Admission before acceptance versus live execution | The strengthened desktop/bundle UI sequence passes twice in `artifacts/execution-refactor-preparation-green-ui.log`: replacement during environment preparation prevents obsolete code from starting, while replacement after start lets accepted work finish without stale display writes. The pre-fix failure is retained separately as `artifacts/execution-refactor-preparation-red-ui.log` |
| Complete Run recordings modal | All 74 checks pass in `artifacts/execution-refactor-final-recordings-ui.log`, including actual activity rows and Decision AI request/response diagnostics |
| Real local Node WebSocket/bundle execution | `executor.projectBundle.test.mts` passes in `artifacts/execution-refactor-native.log`; not a packaged sidecar qualification |
| Domain boundary and static checks | Two boundary-policy regressions, app typecheck/lint, test-style guard, automatic shard discovery and documentation links pass |

The protected execution benchmark preserves outputs and ordered events
(`artifacts/execution-refactor-benchmark.log`). Its timings are mixed, and its
existing shallow-capture comparison is not a full old/new editor architecture
benchmark; no blanket speedup or production latency claim follows. The general
file-tree checker still reports pre-existing long-relative-import debt (396 in
the starting HEAD versus its 154 baseline); this refactor does not rebaseline it.

UI fixture corrections preserve assertions: the request label already says
Decision AI, and a drag test waits for dnd-kit's 50 ms click-capture
quarantine before issuing a single Play/Close command. No modifying command retry
is used to conceal dropped input. The drag/close sequence also passes three
consecutive repeats.

The follow-up review adds `useRemoteExecutor.test.tsx`, a mounted real-hook/FakeWebSocket
integration covering replacement before the first frame, accepted results, progress,
storage callbacks, once-only response traces, early-output cancellation and terminal
cleanup without stale snapshot writes. The request-helper sequence separately covers
unknown/legacy frames, abort-versus-terminal and isolation from another request.
The follow-up's 301 tests pass in `artifacts/execution-coordination-review-unit.log`;
app typecheck/lint, boundary-policy regressions, test-style/shard discovery and local
doc links also pass. These include existing request, evaluation-accounting and trace
tests, not 301 newly added tests. Pre-fix helper and mounted-hook failures are retained
separately in `execution-coordination-review-request-red.log` and
`execution-coordination-review-hook-red.log`.
All 27 local headless browser checks pass in `artifacts/execution-coordination-review-ui.log`
(desktop bundle execution, Browser/Node recording outcomes and the complete shared
Remote Debugger lifecycle/replay matrix). No provider or production qualification
is implied by this local review.

Local receipts live under `artifacts/execution-refactor-*`. UI tests must run
against stable sources: hot reload disposes a real fixture's sockets and invalidates
an in-flight lifecycle experiment. Browser fixture checks do not qualify packaged
desktop binaries, GKE, production upgrades or provider zero downtime.

### Completion audit of the remaining consolidation (2026-10-24)

The P0–P6 delivery map in the saved plan now describes implemented local code,
including P4's shared transitions, not only canonical storage. No parallel legacy
map-writer API remains. Evaluation journal ingress has the same captured binding
and workspace retirement fence as the other asynchronous display adapters.

- `artifacts/execution-p4-final-unit.log`: 504 unit/adapter/workspace tests pass,
  including independent-store full-snapshot/reference parity after every event.
- `artifacts/execution-p4-full-ui.log`: all 115 headless browser checks pass across
  desktop bundle IO, both hosted topologies, remote observation, playback, local
  recordings, evaluation-history paging and the full Run recordings modal.
- `artifacts/execution-p4-evaluation-unit.log` and
  `artifacts/execution-p4-final-ui.log`: all 11 final focused unit checks and all
  27 post-fix headless browser checks pass. Counts overlap the broad matrix.
- App typecheck/lint, three boundary-policy checks, test-style and doc links pass.
  Native Node/WebSocket bundle execution passes in `execution-p4-native.log`.
  The protected benchmark preserves outputs and ordered events in
  `execution-p4-benchmark.log`; concurrent local timings do not establish a speedup.

At this audit, four additional legacy checks (`evaluation-metrics`, prompt cancellation and Node
pruning) require a live local Compose backend. The isolated Vite fixture environment
cannot initialize their persistent evaluation storage (HTTP 500) or enable their
project rows, so they fail before exercising execution. These checks are unverified,
not counted as passes, and no application assertion was weakened to bypass setup.
Receipts and startup traces are in `execution-p4-adjacent-ui.log` and
`artifacts/playwright/p4-adjacent/`. Running those checks with their required backend,
packaged desktop verification and any provider/release qualification remain distinct
from this completed local source refactor. No production or cloud changes occurred.

The later integrated qualification closed all four Compose gaps; see
[the qualification follow-up](studio-server/feature-readiness-refactoring.md#integrated-qualification-follow-up-2026-10-24).
Packaged Windows Browser and Node execution were subsequently exercised through
the native UI; see the
[native qualification closure](studio-server/feature-readiness-refactoring.md#native-qualification-closure-and-delivery-review-2026-10-24).
The initial Node startup failure was an occupied test port, not a passing source-fixture
result or a demonstrated application defect. This does not qualify GKE deployment.

### Post-consolidation review (2026-10-24)

Two reproduced gaps were closed without adding another owner or event path:

- Exact-root passive settlement now consumes its terminal-confirmation ID. The
  real mounted bundle router regression repeats successful, failed and cancelled
  roots, preserving another pending root and all retained outputs. Previously the
  first repetition left the completed root in the FIFO indefinitely.
- Inactive callback accounting now precedes the token-checked display write. The
  store regression closes/replaces the tab inside the callback and asserts zero
  payload allocation and no stale snapshot commit. A positive same-binding case
  verifies both event delivery and preservation of state written by the callback.

The old failure receipts are `artifacts/execution-review-terminal-red.log` and
`artifacts/execution-review-callback-red.log`. The review's 157 focused checks pass
in `artifacts/execution-review-final-unit.log`; the final typed callback fixture's
seven checks also pass in `artifacts/execution-review-callback-green.log` (overlap,
not seven additional scenarios). No test-only snapshot-map type remains exported
by production routing code, and the shared writer reuses its existing option type.
All 32 headless checks pass in `artifacts/execution-review-final-ui.log`: desktop
bundle execution, Browser/Node recording outcomes, repeated child/nested/prompt
playback and the complete remote bundle lifecycle/replay matrix. App typecheck,
changed-file lint/formatting, the three boundary-policy checks, test-style, doc
links and `git diff --check` pass. The previous live-Compose verification limits
remain unchanged; this review did not access production or start cloud resources.

### Adjacent lifetime/observer review (2026-10-24)

The follow-up extends existing fixtures instead of adding another lifecycle harness:

- Membership detach followed by same-path reload previously kept old blocked
  provenance. Both same-path and different-path replacement now remove it, while
  the initial detach still publishes its useful blocked explanation and no old
  event acquires the new receiver token.
- A missing-terminal diagnostic listener previously ran inside the terminal
  snapshot transform. A listener that replaced the snapshot was overwritten;
  a throwing listener could prevent cleanup. The mounted graph-event regression
  covers both, preserves the replacement by identity, and verifies that a listener
  failure is not surfaced as a graph execution error.

Pre-fix failures: `artifacts/execution-adjacent-lifetime-red.log` and
`artifacts/execution-adjacent-diagnostics-red.log`. All 216 focused tests pass in
`artifacts/execution-adjacent-final-unit.log`, including workspace transitions,
snapshot/ref parity, source accounting and the affected real hooks.
`artifacts/execution-adjacent-reconcile-red.log` separately reproduces the missing
sweep on the ownership-reconciliation entry point used by same-path reloads.
All 18 headless checks pass in `artifacts/execution-adjacent-final-ui.log`
(desktop bundle execution, repeated playback and remote lifecycle/replay). After
consolidating reconciliation, the entire 12-check Remote Debugger matrix passes
again in `artifacts/execution-adjacent-reconcile-ui.log`; these counts overlap.
Final app typecheck, changed-file lint/formatting, boundary-policy regressions,
test-style, local doc links and `git diff --check` pass. Earlier live-Compose and
packaged/provider qualification limits still apply. These receipts cover local
verification only; they do not authorize publication or production/cloud changes.

### Commit handoff

This change set contains the source refactor and its follow-up fixes on `develop`.
Saved project, bundle, recording and database formats remain unchanged. The retained
baseline stays frozen, with explicit dated corrections linked to the implementation.
Ignored verification artifacts and unrelated line-ending-only checkout noise are
not release inputs. Publication, packaged desktop/provider qualification and the
four live-Compose checks described above remain separate from this source handoff.
Commit preparation reran all 187 tests in changed/new App test files
(`artifacts/execution-commit-unit.log`), App typecheck, changed-file lint/formatting,
the three boundary regressions, test-style, doc links and diff hygiene. Only docs
and the boundary check's diagnostic wording changed during preparation; the final
18-check browser receipt and post-integration 12-check Remote Debugger receipt
above still cover the unchanged runtime source.
