# Preserve Subgraph target names in recordings

Status: implemented and locally validated. The adjacent import/replacement fixes
are recorded after the holistic review below. Based on develop `185dfba04`,
2026-11-26. The approved implementation sequence is retained below for reference.
This changes recording presentation and adds optional trace metadata;
it does not change target selection, execution, access policy or replay navigation.

## Problem and verified cause

An external Subgraph can display `project ID / graph ID` in a replay instead of
the original names. The failure is not the recordings-list Project name/Path
display fixed in the preceding commit.

The owners at the baseline commit explained the behavior:

- [SubgraphTargetControl.tsx](../../packages/app/src/components/nodes/SubgraphTargetControl.tsx)
  switches recordings to `SubgraphTargetLabel`, deliberately avoiding live
  preview reads. That label consults `referencedProjectsState` and open-project
  titles before falling back to IDs. Those caches are neither recording-owned
  nor historical, so a warm editor can display different names from a cold one.
- [SubGraphNode.ts](../../packages/core/src/model/nodes/SubGraphNode.ts) stores
  the target project ID, version, graph ID and port boundary. It does not store
  project or graph display names in the authored target.
- [GraphProcessor.ts](../../packages/core/src/model/GraphProcessor.ts) resolves
  the selected targets during reference preparation, before
  `graphStart`. It already has the actual project title and graph name needed
  for capture. Cached targets still receive fresh caller-dependent access checks.
- [ExecutionRecorder.ts](../../packages/core/src/recording/ExecutionRecorder.ts)
  reduces `graphStart` to graph ID, inputs and execution identity. The caller's
  trace therefore lacks a display snapshot for its external target nodes.
- Called projects have separate recordings and can retain their own names.
  Their independent retention, coverage and version identity make them an
  unsuitable mandatory dependency for rendering a caller's saved node label.

Opening live projects during replay would introduce current names, require new
access reads and fail after deletion. Saving names at authoring time alone would
also become stale after a target rename. Capture from the resolved execution
snapshot instead.

## Reassessment decisions

- Collect the current graph's names during its existing target-resolution walk,
  then attach them at `graphStart`. Do not scan the graph again at each event,
  introduce a cache, or add a second target-loading path.
- Keep the shared type with `SubgraphProjectTarget.ts`, which is already exported.
  The proposed separate Core builder module and optional revision field are
  unnecessary: the actual resolved snapshot supplies the names, while the
  existing target tuple and recording ownership identify the label.
- Specify source-owner checks, duplicate/conflict handling and loading fallback
  before implementing the index. Graph/node IDs alone are insufficient, and
  a rebound replay project ID is not the original owner ID.
- Validate the two capture paths (direct processor and socket), then the existing
  storage boundaries. Do not add a separate end-to-end fixture for every caller
  of the same serializer.

Before implementation, read-only probes of the baseline Core established that a synthetic optional
`graphStart.subgraphTargets` field survives string and stream round trips and is
ignored safely by the existing playback adapter. A real external-Subgraph fixture
also confirmed distinct recorded source owners despite colliding graph IDs,
standalone child traces without `start`, root/child event isolation, no loading
of disabled targets, no target reads during replay and fresh target resolution
when a processor is reused. Those initial probes alone did not establish capture,
transport or UI compatibility. The implementation and completion records below
document the finished checks.

## Intended behavior and scope

New recordings show `Original project name / Original graph name` in the
Subgraph body and its **Recorded graph** settings field, before pressing Play
and throughout replay. Preserve the complete graph name, including any authored
graph-folder path. Later saves, renames, moves, publications, deletion or unrelated
open tabs must not change the label.

Same-project targets continue to use the recording's saved project graph names.
The new snapshot covers external targets resolved for a graph that starts,
including an enabled node excluded later by ordinary control flow or output
selection. A disabled target, failed preparation or a graph that never starts may
have no captured name. Missing required targets/graphs still fail preparation as
they do today; only missing display names may be omitted without affecting the
run. Show the available historical parts and retain IDs for missing parts; never
fetch a target merely to fill a label.

Old recordings remain playable. Original external names are not guaranteed to
exist in their artifacts. For those recordings, retain the ID fallback and
explain in the hover text that original names were not captured. Do not label a
current live-cache name as historical. Retrospective recovery from independently
retained children is outside this change; it would need an exact, unambiguous
lineage/version match and cannot repair every old recording.

The visible result changes only the label. Preserve execution, outputs, event
order and timestamp semantics, graph/node IDs, recording ownership, read-only
behavior, navigation actions, cancellation and storage safeguards. Adding display
data must not alter the saved project or its dirty state.

## Data contract

The implementation adds one optional display snapshot to the existing
`graphStart` payload:

```ts
type SubgraphTargetDisplaySnapshot = {
  nodeId: NodeId;
  targetProjectId: ProjectId;
  targetVersion: 'latest' | 'published';
  targetGraphId: GraphId;
  projectName?: string;
  graphName?: string;
};

// Additional optional member of the existing graphStart data:
subgraphTargets?: SubgraphTargetDisplaySnapshot[];
```

The enclosing event already identifies the caller graph and execution owner.
Use its source graph ID plus node ID and the complete target tuple to resolve a
label. Default an absent authored version to `latest`, as execution already does;
new metadata must contain an explicit valid version. Do not key by project ID
alone: latest and published snapshots can have the same project/graph IDs and
different names. Do not persist revision keys, source paths or a separate identity
scheme merely to render these names.

These strings are display evidence only. They must never authorize a read,
select a graph, resolve a file path, establish bundle membership or change
execution identity. Copy strings from the resolved snapshot; retain no Project,
graph, dataset, credential or live cache object in the metadata.
Presence of a name is not evidence that the node ran: preparation can resolve a
target later excluded by control flow. Do not derive child counts or outcomes
from this field.

Use the existing version-1 trace envelope with an additive optional field.
Compatibility must be demonstrated with both existing and updated readers before
keeping that decision. An older producer still yields the legacy fallback, even
when paired with a new UI. No capability negotiation or release-version gate is
needed for this optional display field. No new artifact, API route, database
column or project-file field is planned. Keeping per-run metadata in the trace preserves exact
replay-project snapshot sharing and its retention/recovery rules.

## Ordered implementation

### 1. Establish the behavior and baseline before changing capture

Extend the existing
[child playback fixture](../../packages/app/src/hooks/fixtures/childPlaybackRecording.ts)
and [recording playback browser spec](../../packages/studio-server-web/playwright-observe/recording-playback-history.spec.ts).
Use intentionally different project titles, graph names and opaque IDs. Record
which cases demonstrate the current ID fallback or misleading warm-cache names.
Keep a legacy trace explicitly lacking the new field; do not generate the legacy
case implicitly with the upgraded recorder. The existing root-playback assertion
for `playback-child / main` must move to that legacy case, while the normal real
processor fixture must expect `Child replay / Child main`.

Record request counts, outputs and event identities for the fixture. Establish
baseline runtime measurements for a cheap graph, repeated same-project calls and
repeated external calls with recording on/off. Save the exact source, runtime,
parameters and results under ignored artifacts. This phase must finish before
moving to the capture change.

### 2. Reuse target preparation and the existing graph-start event

Put the shared type in `packages/core/src/model/SubgraphProjectTarget.ts`; its
existing export in `exports.ts` makes another public module unnecessary.

In `GraphProcessor.#loadSubgraphProjectTargets`, collect string-only entries
while the existing walk resolves/checks candidates. Collect only candidates in
this invocation's source graph/project, not every recursively visited dependency.
Use the already-resolved prefab candidate, retaining its instance node ID, and
the actual target selected by the existing versioned cache. Do not clone prefabs
or projects again to obtain display fields.

Publish the array to an invocation-owned field after successful preparation,
then attach it conditionally in `#emitGraphStart`. Reset the field in
`GraphInvocationState.initialize`, including processor reuse and replay startup.
An empty result remains absent. Keep the emitted array immutable after delivery
so later invocations cannot rewrite an earlier recording. Do not store it in the
cross-invocation runtime cache or populate it from stale targets on a failed run.

Preserve every existing access check and error, including validation of a cached
target for a new caller. Missing/non-string/empty display names produce missing
display evidence; they do not substitute a live cache or alter execution. Do not
mutate authored nodes, executed projects, attached data or target caches.

Update these existing contracts together:

- `packages/core/src/model/GraphProcessor.ts`: `ProcessEvents.graphStart` and
  target preparation/graph-start production.
- `packages/core/src/model/GraphExecutionState.ts`: the optional invocation field
  and its reset, without a new cache or lifetime owner.
- `packages/core/src/model/ExecutorProtocol.ts`: the separately declared
  `SerializedProcessEventMap.graphStart` contract.
- `packages/core/src/recording/RecordedEvents.ts`: persisted optional field.
- `packages/core/src/recording/ExecutionRecorder.ts`: preserve the field for
  direct capture and `recordSocket`, copying only validated string fields.

Verify that Node debugger forwarding and sanitization carry the field; change
transport code only where an actual drop is demonstrated. Root and called-project
recorders keep their existing project-scope filtering. A child's descendants must
be described in that child's recording, without leaking its events into the
parent's canvas or recording. Reuse the serializer's existing memory accounting;
do not increase event, byte or debugger-history limits to accommodate the field.
Transport fallback/compaction may omit optional names when its existing limits
require it. The UI must tolerate that without changing those safety policies.

Leave the replay event adapter's execution behavior unchanged. The label reads
the original recorder data, so it does not need playback to re-emit metadata or
load any target. Cover this explicitly in the replay tests.

### 3. Resolve labels from the recording owned by the current tab

Add a small pure recording-label index/lookup helper and focused tests under
`packages/app/src/utils/`. Build the index once per selected recording through a
derived selector next to `currentProjectLoadedRecordingState` in
`packages/app/src/state/execution.ts`. Do not rescan the whole event log for each
rendered node or create another persistent project-name cache.

The lookup must:

1. Depend on the exact `currentProjectLoadedRecordingState` value. Derive the
   recorded source owner from root `start.data.projectId` and its execution
   scope, or the first `graphStart.data.execution` for standalone children
   without `start`. Match both source project ID and `projectScope` (including
   absence), because another version can share the same project ID. Only accept
   metadata from that owner; never use the rebound tab ID as the original ID.
   Missing/contradictory owner evidence means no external names.
2. Match source graph ID, instance node ID, target project ID, effective version
   and target graph ID. Use a collision-safe tuple key, not delimiter joins.
   Resolve the effective prefab target on the UI side too. Reused node/graph IDs
   in another source graph or called project must not borrow names.
3. Ignore absent, malformed and unknown optional fields without blocking valid
   replay. Require string IDs, a valid version and string names when present.
   Identical repeated entries collapse to one; conflicting names for the same
   complete tuple invalidate that tuple for this recording, regardless of order.
   A later duplicate must not resurrect a conflicted entry.
4. Preserve valid historical project/graph names independently, with the matching
   ID as fallback for each missing part. Empty/whitespace-only names are missing.
   Render as text and keep the full readable name available on hover when the
   existing bounded node layout clips it.
5. Discard the derived view when its recording changes, unloads or closes. During
   the existing asynchronous load, keep IDs with a neutral tooltip; do not claim
   the recording is legacy before its trace arrives. Reuse existing load/error
   handling rather than adding a second fetch or loading-state owner. Neither
   live tabs nor another recording's cached names may supply this fallback.

Change recording-mode rendering in `SubgraphTargetLabel` to use this lookup.
The node body and `SubgraphTargetEditor` already share that label; keep one
implementation. Preserve normal live read-only labels and published-history
inspection, which have different data owners. Keep existing controls and focus
handling. Do not modify `useGoToSubgraphNode` or imply that capturing a name adds
historical child navigation.

### 4. Verify storage paths and compatibility without duplicating persistence

Trace endpoint/root, called-project, hosted Browser/Node, scheduled and Evaluation
callers to their shared direct-recorder or socket-recorder path. Verify direct
and socket capture once each with real producer data, and reuse existing writer
tests for unchanged pass-through adapters. Add an adapter-specific assertion only
when it reconstructs/drops fields; do not create six equivalent integration suites.

Test ordinary string and stream serialization/deserialization, legacy traces,
new traces through the baseline reader and optional metadata corruption. The
baseline reader's successful round-trip probes are supporting evidence, not a substitute
for testing the actual updated producer and socket event projection.
Do not alter codec descriptors, artifact integrity, upload limits, registration,
outcome handling, recovery manifests or shared replay-project IDs. Retain the
existing per-capture memory accounting and discard behavior, including the
additional metadata bytes. Run the relevant recording-memory and durability
regressions, including a near-limit capture. Optional display data consumes the
same finite recording budget; do not promise zero byte cost, raise the limits,
or retry a destructive failed admission with a modified event. Preserve the
existing capacity-unavailable result and successful business outcome. No migration
or historical artifact rewrite is required.

### 5. Complete validation, documentation and review

Keep tests with their existing owners:

| Owner                           | Required checks                                                                                                                                                                                           |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Core processor/recorder         | Correct resolved names; latest/published separation; fresh names on processor reuse; skipped nodes; prefab instance identity; source project/scope isolation; event order and outputs unchanged.          |
| Core serialization/socket tests | String and stream round trips; request-ID filtering; old/new reader compatibility; malformed optional fields; snapshots unaffected by later source mutation.                                              |
| App pure lookup/state tests     | Exact graph/node/target and source-scope matching; rebound replay ID; legacy/partial/conflicting metadata; duplicate-order invariance; same-project names; tab replacement, switching and cleanup.        |
| Existing headless replay spec   | Cold editor shows names before Play; body/settings agree; renamed/deleted target and misleading live cache have no effect; child replay; delayed loading/reopen; no live reads; legacy/long-name display. |
| Existing Subgraph browser specs | Live target selection, version changes, authorization and published-history inspection continue to work.                                                                                                  |
| Persistence/memory regressions  | Names survive the real artifact read boundary; memory bounds remain enforced; replay-project sharing and source bytes stay unchanged.                                                                     |

Extend `packages/core/test/recording/ExecutionRecorder.test.ts` and the existing
processor/portable bundle tests instead of creating redundant capture harnesses.
Include a reused processor with a newly resolved target on its second run. Replay
the same captured trace with and without the optional display field and compare
outputs and event order. Across separate baseline/new executions, compare stable
source, graph and node identities; do not compare freshly generated run IDs or
wall-clock timestamps for equality.
At least one test must execute a real external Subgraph; manually emitting a
`graphStart` cannot establish that the production resolver populated its names.
Retain the existing cached-target authorization negatives, and verify that a
later preparation failure on a reused processor cannot publish the previous
run's names. The normal Node/relay transport check must preserve both request
and project scope along with the optional data; no new transport event is needed.

Use the existing managed artifact fixture for one stored round trip with names
and verify an explicitly legacy artifact remains readable. Cover filesystem
pass-through with its existing writer fixture, without another service stack.
Do not introduce a Kubernetes rehearsal. Browser coverage stays in
the already-selected `recording-playback-history.spec.ts` and adjacent Subgraph
specs. Measure added test duration before changing shard estimates/placement.

After implementation, run focused unit suites, affected package builds/type
checks/lint, documentation links and the required headless browser runner:

```powershell
$env:PLAYWRIGHT_HEADLESS = '1'
$env:PLAYWRIGHT_SLOW_MO = '0'
# Set PLAYWRIGHT_BASE_URL to the verified built app/preview if needed.
yarn studio-server:ui:observe recording-playback-history.spec.ts cross-project-subgraph-loading.spec.ts subgraph-bundle-scope.spec.ts
```

Also run the relevant Core/Node recorder suites against the final build and
confirm test discovery in the existing App and editor CI selections. Broaden the
browser run to the affected editor shard for the final integrated change; do not
repeat it for documentation-only edits. Inspect failure artifacts under
`artifacts/playwright/`; retain existing timeouts and safeguards. Do not count a
retry-only pass as an explained fix.

Update [Development](development.md),
[Recording durability](recording-durability.md) and this plan with the final
format, fallback behavior and exact validation results. Clearly distinguish
local checks, hosted CI and production verification. Before any later requested
commit/push, read the ignored recurrence checklist and stage only reviewed files.

## Performance and completion gates

Use the existing Node runtime benchmark infrastructure for before/after repeated
Subgraph runs. Extend it only with the minimal recording-on fixture it lacks.
Measure a cheap graph without external targets, a many-target graph and a repeated
target, with recording on and off, using interleaved samples on the same otherwise
idle machine. Report distributions and serialized trace growth, not a single
best timing. Build and browser runs must not overlap the measurement.

Require zero added target/storage/network requests and no new awaited persistence
on the execution path. Name collection piggybacks on the existing preparation
walk and is bounded by external nodes in the current graph; no added graph walk
or per-node-event metadata generation is allowed. Include recording-off runs:
this event producer also serves live execution/debugging, so optional recording
data is not automatically free when persistence is disabled. Report preparation,
serialization/transport bytes and recording-memory overhead separately. There
is no justified zero-cost claim or need for a new feature flag.

Investigate a reproducible latency/throughput or memory regression before
declaring completion. Keep raw paired samples and the unchanged baseline; if
machine noise prevents a conclusion, report performance as unresolved instead
of repeatedly rerunning until it looks favorable. Local measurements cannot
guarantee production latency; hosted results and queueing remain separate evidence.

Completion requires the displayed names to survive target changes and a cold
reopen, compatibility and storage checks to pass, no unexpected access/request
changes, and no unresolved reproducible performance regression. Record limitations:
older traces without names, targets never resolved before failure, and disabled
or unvisited graphs can retain IDs. No rollout is authorized by this plan.

## Implementation and validation record (2026-11-26)

The approved sequence above is implemented. `SubgraphProjectTarget.ts` owns the
optional type and normalizer; the existing preparation walk collects names for
this invocation's graph. Both direct and socket recording copy the field into
the unchanged version-1 trace. No transport, storage schema or execution adapter
needed a new path. The App derives one index from the selected recording and
uses it for both the node body and settings field. Names never enter the replay
project snapshot, so shared snapshot identity and source files remain unchanged.

Two confirmed gaps found during implementation were fixed and covered:

- Optional display capture initially invoked a target title getter. It now reads
  only own data properties, so an accessor cannot fail the business run. A real
  processor test uses a throwing getter and verifies zero accessor calls.
- During reload, the selected replay project could hydrate before the global
  last-loaded path and briefly request a live target preview. Recording display
  mode now uses the current open tab's path first. A held-trace browser case
  verifies IDs during loading, names after arrival and zero live target reads.
  State tests also verify the reverse transition back to a live tab.

Local evidence is retained under ignored
`artifacts/recorded-subgraph-names-20261126/`; it is not release qualification.

| Validation                                               | Local result                                                                                                                                                                  |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Full Core suite                                          | 2,234 cases covered: 2,232 passed in the first run; the two CJS fixture-builder cases hit sandbox filesystem denials and passed unchanged with normal process permissions.    |
| App lookup and recording ownership                       | 20 passed, including scope/version isolation, conflicting evidence, malformed/legacy input and tab replacement.                                                               |
| Focused API recording/memory/filesystem                  | 54 passed; added metadata consumes the existing finite budget without changing business settlement.                                                                           |
| Node execution/debugger                                  | 38 passed, including event forwarding through the existing sanitizer.                                                                                                         |
| HA replay/WebSocket                                      | 22 passed, including metadata and source-scope preservation across reconnect.                                                                                                 |
| Real PostgreSQL/MinIO durability integration             | Complete suite passed, including authenticated named/legacy artifact reads, identical replay-project blob keys, recovery, retention, recompression and transition safeguards. |
| Actual old/new Core producer compatibility               | Both string and stream round trips passed in both directions against the baseline build. Stable event identities, order and node outputs match; replay makes no target reads. |
| Focused recording browser case                           | Passed after the reload fix; covers body/settings, long names, a misleading live cache, delayed reload, explicit legacy data, artifact export and read-only playback.         |
| Adjacent Subgraph and publication history browser checks | All 32 passed in 2.5 minutes.                                                                                                                                                 |
| Affected editor CI shard                                 | All 123 passed in 4.5 minutes using the normal two-worker CI configuration; no retry was needed.                                                                              |
| Builds and static checks                                 | Core ESM/CJS, Node, API and Web builds; App and browser typechecks; changed-source lint and repository style checks passed.                                                   |

The standard Windows Core test script exceeded the shell command length when
expanding all test files. Passing the glob directly to Node's test runner ran the
same complete selection with four workers. This and the sandbox-only fixture
denials are recorded in the ignored recurrence checklist; no tests or production
safeguards were removed. Browser checks use the installed Chromium with the
repository's original timeout and observation settings.

The expanded root-playback case took 7.5 seconds in the focused observe run
versus 5.1 seconds at baseline, including its added reload/legacy scenarios.
The complete playback file took 46.6 seconds of case work in the final CI shard;
its existing 90-second allocation remains sufficient. No test placement or
workflow change is needed on this local evidence. This is not a hosted timing
or queueing measurement.

### Local execution cost

The ignored benchmark driver retains the baseline build and nine interleaved
samples per variant, with 15 warmups and 70 measured runs per sample on Node
24.22.3. Both recording-on and recording-off variants ran on the same idle
machine, without overlapping builds or browser tests. Values below are medians
of sample medians in milliseconds; raw per-sample medians and p95s are retained.

| Recording-on fixture            | Baseline run | Current run | Baseline serialization | Current serialization | Added raw trace bytes |
| ------------------------------- | -----------: | ----------: | ---------------------: | --------------------: | --------------------: |
| No Subgraphs                    |       0.0731 |      0.0759 |                 0.0328 |                0.0338 |                     0 |
| 12 same-project calls           |       1.7938 |      1.7644 |                 0.4606 |                0.4547 |                     0 |
| One external call               |       0.2384 |      0.2381 |                 0.0333 |                0.0345 |                   179 |
| 12 calls to one external target |       2.0255 |      2.0556 |                 0.1773 |                0.1894 |                 1,930 |
| 12 distinct external targets    |       2.0115 |      1.9910 |                 0.1684 |                0.2097 |                 2,047 |

Recording-off runtime medians ranged from 0.0670 to 1.8574 ms in the current
build versus 0.0793 to 1.8044 ms at baseline, with mixed positive/negative deltas
across fixtures. All variants asserted the same target-load counts; there were
zero added target requests. A separate three-sample profiling run measured
preparation and graph-start work: for 12 distinct targets with recording,
cumulative preparation was 3.5547 to 3.6050 ms and graph-start work 0.3849 to
0.4002 ms. These cumulative nested-invocation durations are not endpoint latency.

These local measurements show small serialization/byte costs and no demonstrated
material execution regression. They do not establish zero overhead, production
latency, hosted CI speed or runner queueing. Trace growth depends on node counts
and actual name lengths; it remains subject to the existing limits. Process
RSS/heap changes were not benchmarked; the near-limit test verifies capture
accounting and safe rejection of added metadata instead. Old traces
without names, disabled targets and targets never resolved before a failure keep
the documented ID fallback. Hosted CI and production have not been rerun for
this change.

## Follow-up code review (2026-11-26)

The review found one additional ownership gap: recording display mode used the
current tab's registered path, while the selected recording still used the
global last-loaded path. During hydration those could disagree. A regression
test reproduced both loss of an available recording during restoration and
retention of an old selection after a same-ID tab acquired a different path.

Both selectors now derive from one shared current-tab path selector. The
registered tab path takes precedence, with the existing global-path fallback
for standalone sessions. Source project/path matching and playback mutation
guards remain intact. The label component also uses explicit same-project,
recorded-external and live-external branches instead of nested conditional
expressions; it retains one common ID fallback and tooltip.

The new regression failed before the fix and passed afterwards. Fresh review
validation passed: 39 lookup/state/playback-display tests, 42 save/remote-executor/
preview/synchronization tests and 12 editor-session tests; the App typecheck and
affected lint checks; the production Web build; and all 37 headless recording,
Subgraph and editor-lifecycle browser cases in 3.0 minutes. No browser retry was
needed, and timeouts and observation settings remain unchanged.

Evidence is under ignored `artifacts/recorded-subgraph-review-20261126/`.
Prior Core, storage, transport and performance receipts above apply to unchanged
code; this follow-up changes App ownership selection and label rendering only.
The full editor shard result above precedes this follow-up; its affected browser
cases were rerun in the focused 37-case selection. No hosted workflow or
production verification is claimed.

## Completion audit (2026-11-26)

All capture surfaces use the updated shared recorder; none needs a separate
display-metadata implementation:

| Surface                                | Capture and persistence owner                                                                                                                             |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Endpoint and scheduled runs            | `ExecutionSession` records the prepared processor; `execution.ts` and `scheduled-runs/runner.ts` retain their existing policy and evidence handling.      |
| Hosted Evaluations                     | `evaluation-runs/hosted-execution.ts` uses `ExecutionSession` and stores the serialized recorder through the existing Evaluation store.                   |
| Browser editor and Browser Evaluations | `useLocalExecutor.ts` attaches `ExecutionRecorder` directly to the processor.                                                                             |
| Remote editor and remote Evaluations   | `useRemoteExecutor.ts` captures the exact request through `ExecutionRecorder.recordSocket`; forwarding preserves the graph-start payload.                 |
| Web-app actions                        | HTTP actions use `ExecutionSession`; WebSocket actions attach the same recorder in `web-app-action-websocket.ts`.                                         |
| External child recordings              | `SubGraphNode.ts` records the child processor; server/browser owners serialize that recorder in `subgraph-recordings.ts` and `hostedSubgraphProjects.ts`. |

The existing `VisualNode` prefab resolver passes the resolved instance to the
Subgraph body, preserving the instance ID captured by Core. Linked-node editing
keeps its existing library behavior. Playback reads serialized events through
`useWorkflowRecordingBridge`; it does not reconstruct names from live targets.

The real-processor regression now also forwards its actual events through the
socket recorder. It verifies identical graph-start inputs, execution identity,
resolved names and root outcome, including exclusion of child-project events.
This complements the malformed-frame/request-filter tests without adding
another service fixture. The 38 focused Core recorder tests, scoped typecheck
and lint check pass.

The final full editor shard passed all 123 tests in 4.3 minutes after the
ownership fix, without retries. This closes the integrated validation gate.
No additional runtime code was needed in this completion audit. The agreed
implementation and local validation are complete; evidence is under ignored
`artifacts/recorded-subgraph-completion-20261126/`.

Legacy traces without the optional field and targets never resolved during
execution retain the documented fallback. Retrospective name recovery and
deployment remain outside this plan.

## Adjacent recording-selection review (2026-11-26)

Following the earlier restoration races, the adjacent review reproduced stale
file-picker results attaching to a replaced or reopened tab, recording actions
using an obsolete global path, and an older menu request overwriting a newer
selection. It also reproduced acceptance while the inactive owner was running
and obsolete I/O errors being reported after that owner's replacement.

`useLoadRecording` now captures the existing project binding and workspace
lifetime before opening the picker, and checks them again at completion. It
uses the same current-tab path as recording display. A verified same-document
move follows the current path; replacement, rebinding and close/reopen reject
the old result. A shared pending-load identity orders requests from separate
menu hook instances. Activating or explicitly unloading a recording supersedes
the pending request; a path-only rebind preserves it. Existing running and
playback-start guards remain, with an additional check for an inactive owner.
Retired I/O failures cannot notify the new owner.

The regression cases reuse the real workspace hooks in
`useLoadProject.test.tsx`, rather than adding another mocked workspace owner.
Positive cases retain ordinary tab switching, verified moves and standalone
sessions.

At the socket capture boundary, valid JSON `null` frames caused a destructuring
exception, and prototype names such as `__proto__` passed the event-name test.
The recorder now requires an object envelope and its own registered event keys
(plus the existing named-event prefixes). A regression sends those non-events
followed by a valid terminal frame and verifies an intact recording. Known event
payload handling, request/scope filtering and terminal settlement are unchanged.

No recording format, storage writer, target resolver or network request was
added or changed. Fresh validation passed:

- 138 focused App tests, including ownership, playback display, saving and
  remote-executor coverage; the App typecheck and affected typed lint checks.
- 38 Core recorder/metadata tests, five Node debugger transport tests, Core
  typed lint, and the complete Core ESM/CommonJS builds and exports check.
- The production Web build and all 123 tests in editor CI shard 3/5 (4.4 minutes,
  no retries) after the selection fixes, plus the required headless observe
  check for manual loading and unloading.
- After the subsequent socket-envelope guard, another production Web build and
  all seven focused replay/history/manual-loading browser cases (48.9 seconds,
  no retries). The full 123-case shard preceded this final Core-only guard.
- Editor boundaries, test-style checks, local documentation links and diff
  checks. Existing allowlisted test-style warnings remain unchanged.

The failing-before and passing-after regressions and validation logs are under
ignored `artifacts/recording-adjacent-review-20261126/`. These checks establish
local behavior; hosted workflows and production were not rerun.

## Recording and playback test review (2026-11-26)

The review retained the independent capture, transport, storage and browser
boundaries. A storage round trip is not redundant with a recorder codec test;
the former also proves that its backend and HTTP reader preserve the artifact.
Legacy traces, nested invocations, failed/aborted runs, prompts, stale owners and
fresh access checks keep their existing coverage.

Confirmed test weaknesses and cleanup:

- Sixteen Core playback cases copied the same runtime context. One local
  fixture now creates fresh mutable state for each call while retaining each
  case's explicit event observers, project topology and identity overrides.
- The Core test file had stale types hidden by transpile-only execution:
  unbranded port IDs, a missing type import, insufficient event narrowing and
  listeners returning array lengths. Its fixtures now pass a scoped strict
  TypeScript check. The codec matrix uses native Web Streams directly, removing
  the old Node/Web-stream cast workaround without dropping any round trip.
- Optional-field validation is concentrated in Core. App tests retain lookup,
  ownership, malformed-entry integration and conflicting metadata checks,
  including conflicts split across different graph-start events. The redundant
  standalone null-selection case is folded into the existing ownership test.
- File-picker error tests assert actual toast calls as well as logging. Current
  errors preserve the prior recording; replaced and superseded requests stay
  silent. Mocks are scoped to their test and the existing workspace fixture is
  reused.
- Socket checks now include invalid JSON and non-string event names, preserve
  both named-event prefixes and validate listener cleanup after a terminal.
  The test closes the socket even on failure.
- Browser replays require a different activity identity and completed status
  for every click, plus no uncaught page errors. They retain the three replays
  and all five trace variants without adding sleeps or changing timeouts.

This review changes tests and documentation only. Validation receipts are under
ignored `artifacts/recording-tests-review-20261126/`:

- 152 focused App tests, 38 Core recorder/metadata tests and 39 hosted recording
  utility/persistence tests passed. The Core recorder file is about 190 lines shorter
  than before this review while keeping all of its test cases.
- The App typecheck, scoped strict Core-test typecheck and affected typed lint
  checks passed. Formatting, test-style and documentation-link checks passed.
- All six playback/history browser cases passed in 58.2 seconds through the
  headless observe runner with the existing CI preview configuration and one
  worker. Runtime code and its built frontend were unchanged by this review.
- A deliberate negative control blocked the second Play click in the root
  scenario. The new activity-identity assertion correctly failed using the
  existing 20-second assertion timeout. The script restored the tested browser
  file byte-for-byte afterwards; this expected failure is not an open regression.

No safety window, request timeout, browser retry or CI selection was changed.
These local checks are not measurements of hosted CI speed or production.

## Holistic comparison with the last commit (2026-11-26)

Compared the working tree with develop
`185dfba04774fc80888c97469c58d906aaad938e`, including the untracked lookup helper
and tests. The change is a net improvement in historical label accuracy,
selection ownership and test maintainability. No newly introduced execution,
storage-format, authorization or playback regression was confirmed by this
audit. This is a qualified assessment, not proof that every regression is absent.

The production changes remain narrow: optional names are captured during the
existing target-resolution walk, per-invocation state is reset, the recorder
copies validated fields, and the UI resolves labels from its selected trace.
The normal target cache/permission checks, replay adapter, storage writers,
version-1 envelope, deployment guards and timeout policies were not replaced.
The test cleanup keeps independent storage/transport boundaries rather than
collapsing them into codec-only checks.

Two additional defects were reproduced by that audit; the follow-up fixes are
recorded below. At audit time their owning code matched the last commit:

1. **Hosted Chromium imports hide real failures.**
   `HostedIOProvider.loadRecordingData` catches every error from the native
   picker path, including file-read failures and invalid recording JSON. It
   returns exactly as it does for cancellation, so the hook cannot show the
   newly tested error notification. A probe of the actual provider reproduced
   zero callbacks and no rejection for a read failure, malformed content and
   user cancellation. Catch cancellation specifically and propagate actual
   failures; retain the current selection when they are reported.
2. **Explicit same-ID/same-path content replacement retains a prior recording.**
   The replacement path renews the project binding but does not release the
   loaded recording, whose ownership still matches by ID/path. A probe using the
   real workspace hooks replaced a project with a different graph under the
   same identity and path: the old graph was absent, but the old trace remained
   selected and the replacement stayed in recording mode. Release the exact
   owner's recording and indicators on committed content replacement, covering
   active and inactive owners. Preserve ordinary tab switching, failed or
   cancelled replacements, and verified same-document moves.

The probes and logs are under ignored
`artifacts/recording-quality-audit-20261126/`. Temporary probe additions were
restored byte-for-byte; this audit changed no runtime code. The previously
passing 152 App, 38 Core, 39 hosted and six browser checks were inspected and
reused for unchanged code. They do not cover the two newly reproduced defects.

Remaining validation limits also matter: legacy traces cannot recover names
that were never saved; optional names consume the existing finite recording
budget and may cause near-limit replay captures to become unavailable earlier,
without failing the business run; large-recording UI memory, hosted queueing
and production performance have not been freshly measured. The retained local
comparison showed small added serialization costs and no material execution
regression, not zero overhead. That audit withheld unconditional reliability
sign-off pending the adjacent fixes below; no production rollout was performed.

## Adjacent import and replacement fixes (2026-11-26)

`HostedIOProvider.loadRecordingData` now limits cancellation handling to the
native picker call. It returns quietly for picker cancellation or no selection;
unexpected picker errors and all subsequent read, parse and callback failures
propagate to the existing recording-load error handler. The fallback file-input
path is unchanged. No failed import replaces the current recording.

The active content-commit path and inactive snapshot replacement both call the
existing exact-owner recording cleanup, using the old path before replacement.
This also releases the old tab indicator and its playback-start flag, while
preserving a different selected recording and that recording's flag. Standalone
same-owner replacement uses the current loaded path when no tab is registered.
The existing binding renewal still rejects stale picker/execution callbacks.
No cleanup was added to ordinary tab activation or verified path moves; rejected
or superseded replacement requests do not reach the cleanup point.

Regression coverage reuses `useLoadProject.test.tsx` for active/inactive owners,
same-path replacement, independent neighboring recordings, standalone sessions,
rejection/cancellation, tab switching and the normal two-part verified move.
`deserialize-worker.test.ts` exercises the real hosted provider for picker
cancellation, valid files, unexpected picker failure, file/text failures, an
aborted read, invalid JSON and callback failure. Four replacement cases and the
provider propagation case failed before the fixes. The existing manual-load
browser journey now verifies visible read/parse errors, cancellation, retained
recording mode and subsequent unload, without another browser fixture.

Both added test groups are already selected by the normal App/Web test runners;
the extended browser case is already in editor CI. No new CI job, timeout or
retry policy was introduced. Validation passed:

- 146 focused App tests, including real workspace replacement, playback,
  recording ownership, saves and remote-execution routing.
- All 12 provider/worker tests in `deserialize-worker.test.ts`, including the
  real recording import failure and cancellation paths.
- All 26 headless browser cases selected from project activation/recovery,
  recording playback/history and the extended manual-import journey, against
  the rebuilt hosted frontend. The run took 2.0 minutes with no retries.
- The production Web build, App typecheck, scoped hosted source/test/browser
  typecheck, affected typed lint, formatting, test-style and documentation-link
  checks.

Both findings in the preceding audit are resolved in the working tree. Evidence
is under ignored `artifacts/recording-open-issues-fix-20261126/`. No recording
format, storage schema, deployment safeguard or production installation changed.

## Commit preparation (2026-11-26)

The implementation and both adjacent fixes are complete. The final source
review includes the new lookup/validation tests, real provider tests, workspace
replacement cases, and the shared replay-fixture cleanup. No diagnostic scripts,
private packets, test receipts or credentials are part of the source change.

The current behavior and ownership rules are summarized in
[`development.md`](development.md) and
[`refactor-history.md`](refactor-history.md#2026-11-26---recording-display-evidence-and-playback-ownership).
The validation records above distinguish broad initial coverage from later
focused checks; passing results are reused only for unchanged inputs. Desktop
and CLI builds, the repository file/import guard, package-version consistency,
formatting and documentation links passed during commit preparation. Receipts
are under ignored `artifacts/recording-commit-20261126/`. Hosted CI, release
qualification and deployment remain
separate from this implementation and commit.
