# Editor performance implementation plan

## Goal and scope

Make Rivet start with less unnecessary JavaScript and keep execution presentation
responsive as projects, node events and debugger traffic grow. Preserve the
execution engine, public project and recording formats, saved data, authorization
and the existing Browser, desktop Node and hosted Node behavior.

This is a bounded optimization plan based on the
[measured local baseline](editor-performance-baseline.md), not another general
refactor. Implementation, tests and measurements stay local. Committing, pushing,
release publication, GCP changes and production deployment are separate actions.

Implementation status is recorded in
[the implementation and verification report](editor-performance-results.md).
P0 (portable harness), P1 (direct lookup/hidden drawer), P2 (feature-local loading)
and P3 (definition/row projection plus stable ancestry references) are implemented. P4 is deliberately closed with
required live access checks retained and a revocation regression: snapshot reuse
cannot safely stand in for authorization. P5's final paired measurements and
integrated checks have passed; exact results and limitations are in the report.
Preserve the existing baseline
artifacts rather than overwriting them with candidate results. Record the actual
source revision and dirty-diff digest for each build.

### Completion audit (2026-10-25)

| Phase | Final disposition |
| --- | --- |
| P0 | Complete: portable isolated runner, source identity, actual execution counts, cold/cached resources, profiles and owned cleanup. |
| P1 | Complete: direct registration lookup and open-only detailed Run Activity, with retained events/preferences and fenced output navigation. |
| P2 | Complete: feature-local editor loading, explicit safe retry, pinned build and manifest-derived startup guard. The guard uses exact emitted asset paths and rejects missing module attribution. |
| P3 | Complete: presentation-local indexes/row reuse and stable ancestry metadata. Cached-versus-reference parity now also runs after every event in a streaming/split/late-child/failure/abort/retention/repeated-replay sequence. |
| P4 | Closed with the permitted safe no-optimization decision: live permission checks remain mandatory. Snapshot reuse cannot authorize an invocation; the revocation regression protects this boundary. |
| P5 | Complete for the local scope: preserved seven-sample paired evidence, regression/build/browser results and documented limitations. The final verification-only additions have their own receipts in the implementation report. |

There is no mandatory implementation left in this bounded plan. Additional
accounting caches, event/frame batching, broader provider/runtime chunk splitting
and permission-protocol changes are not unfinished phases: they were conditional
on measured need or explicitly excluded. Committing/pushing, release publication,
native desktop/provider qualification and production deployment remain separate
actions, not implied by this completion status.

## What must remain unchanged

- One authoritative execution snapshot and journal per binding/run. Do not add
  a second event store, execution coordinator or transport-specific policy fork.
- Closing Run Activity stops expensive presentation work, not event collection.
  Reopening it must show everything retained by the current retention rules.
- Preserve event order, node and graph ancestry, costs, errors, progress, waits,
  streaming terminal signals and the difference between outputs ready and fully
  stopped. Never drop events or shorten history to improve timings.
- Browser, Node, Remote Debugger and recording adapters keep their intentional
  differences. Observers cannot issue execution commands; reconnects cannot
  automatically repeat saves, executions, uploads or other writes.
- Open bundle members show their own execution data. Closing/reopening or
  rebinding the same project ID cannot admit an old event or cached view.
- Playback remains read-only, preserves original timing and replaces rather
  than accumulates display history. The saved source and its recording can be
  open together through their distinct project identities.
- Same-bundle rules remain enforced on the server. Cached project bytes are
  never proof of authorization. Caller, target, version and live hierarchy matter.
- Lazy loading preserves model contents, input focus, diagnostics, settings,
  worker initialization and useful load-failure recovery. The dashboard and
  iframe remain on one pinned immutable frontend build.
- No database migration, new public API or new permanent service is needed.

## Implementation order

| Phase | Deliverable                                            | Depends on                                       |
| ----- | ------------------------------------------------------ | ------------------------------------------------ |
| P0    | Repeatable benchmark and behavioral controls           | Existing baseline                                |
| P1    | Remove measured low-risk lookup and hidden-drawer work | P0                                               |
| P2    | Defer editor-only startup dependencies                 | P0; compare after P1                             |
| P3    | Reduce remaining execution projection costs            | P1 and a new CPU profile                         |
| P4    | Remove redundant Subgraph traversal safely             | P0 characterization and explicit access contract |
| P5    | Integrated verification and implementation report      | Implemented phases                               |

Keep the phases independently reviewable. Measure after each one; do not combine
several speculative caches and then guess which change helped. P3's deeper
journal changes are conditional on the new profile. If P4 cannot preserve live
authorization without a broader protocol change, retain the safe behavior and
record that decision instead of expanding this work into a security redesign.

## P0 Make the baseline reusable

### Work

1. Promote the useful parts of the ignored diagnostic harness under
   `artifacts/benchmarks/editor-20261025/` into a small repository-owned local
   benchmark runner. Proposed location: `scripts/benchmarks/editor-performance/`.
   Keep test fixtures, asset serving and metric collection separate, without
   introducing a general benchmark framework.
2. Replace hardcoded drive paths, source SHA, port and Chromium executable with
   repository-relative paths, detected revision and configurable inputs. Refuse
   to bind a port already in use; never stop the user's existing application.
3. Reuse the production Vite configuration and
   `packages/studio-server-web/production/server.mjs`. Generate manifest/module
   attribution in an isolated output directory. Do not rebuild or replace the
   user's active `dist` during browser measurements.
4. Keep ten projects, 999 nodes, the nine-edge chain and deterministic outputs.
   Count actual completed node/graph invocations across the projects, not just
   nodes in the fixture. Explain the root recorder's project-scoped event count;
   do not equate it with the total number of executed nodes.
5. Preserve real Browser execution, local Node/WebSocket execution and real
   generated recordings. Wait for physical Node completion before disposal.
   Retain the separate replay-project ID used by the server.
6. Measure these checkpoints independently:
   - Navigation to usable dashboard.
   - Navigation to first usable editor/project, initial-readiness admission and
     restored tabs after reload. The UI intentionally disables project rows until
     iframe readiness; do not force a disabled interaction to manufacture a queue.
     Internal pre-ready command queuing remains covered by bridge contract tests.
   - First Code Editor open, including usable input and initialized language.
   - Opening all ten projects and switching tabs at fixed zoom levels.
   - Browser run to actual terminal presentation. The fixed 999-node workload
     does not isolate a controlled outputs-ready/background-work interval; keep
     that semantic distinction under existing lifecycle tests rather than claim
     a separately measured Browser first-output latency.
   - Debugger run to changed output and to all observed members' terminal state.
   - Recording open, repeated play and populated Run Activity.
7. Separate steady-state debugger runs from bursts. Steady-state runs must wait
   for the previous terminal projection before admitting the next run. Preserve
   a bounded burst scenario to expose backlogs without mislabeling them leaks.
8. Collect both per-frame and whole-navigation resource costs, including the
   iframe and workers. Removing an import from the main frame while eagerly
   loading it in the iframe does not count as reducing total startup work.
9. Keep HTTP caching enabled. Collect cold contexts and cached reloads separately;
   avoid Playwright routing in the timing workload. Keep external fonts excluded
   consistently. Distinguish decoded bytes, actual transfer and offline gzip.
10. Capture CPU profiles in separate repetitions, not timed samples. Preserve
    raw samples, request counts, environment, source identity, output assertions
    and failures. Clean up only processes, contexts and ports the harness owns.

### Verification and exit

- Compare baseline and candidate with the same machine, browser, fixtures,
  production-build settings and zoom. Use at least seven timed repetitions per
  principal condition, alternate comparison order where practical and report
  medians/ranges. Repeat a noisy result; do not derive p95 from a few samples.
- Assert output values in the source and executed bundle member tabs. For Run
  Activity check expected row identities/statuses and one inspectable output,
  not merely a nonempty drawer or a button that returned to idle.
- Add lean tests for metric aggregation, cache-state separation, source metadata,
  port ownership and cleanup after failure. Keep timing thresholds out of the
  ordinary shared-runner CI lane; structural/count regressions can run there.
- P0 is done when another local checkout can reproduce a passing baseline without
  production access, paid services, secret files or manual harness edits.

## P1 Remove unnecessary work first

### Direct node label lookup

Owner: `packages/core/src/model/NodeRegistration.ts`.

`getDynamicDisplayName` currently constructs a map of every registered display
name to retrieve one item. Replace this with a direct lookup through the existing
registered-info owner. Keep unknown-type and empty-label behavior unchanged.
Remove the obsolete private map getter/import if it has no remaining consumers.

Do not replace the map rebuild with a new cache: direct lookup already observes
later built-in/plugin registrations correctly and needs no invalidation protocol.

Add a focused `packages/core/test/model/NodeRegistration.test.ts` covering built-in
and plugin registration, late registration, missing types, empty labels and
duplicate registration. Assert behavior and lookup work without a wall-clock
microbenchmark or source-string assertion.

### Closed Run Activity

Owners:

- `packages/app/src/components/runActivity/RunActivityRenderer.tsx`
- `packages/app/src/components/runActivity/buildRunActivityViewModel.ts`
- `packages/app/src/components/StatusBar.tsx`

The renderer is mounted in `RivetApp` and computes detailed rows even when the
drawer is closed. Separate its lightweight open/close and inspector lifetime
logic from the detailed presentation component, or otherwise prevent expensive
projection when it is not needed. Keep React hook order valid. Compact status
must continue reading the authoritative journal's root metadata, not retained
drawer rows.

On opening, project the current journal immediately. On closing, preserve event
collection, column preferences and existing inspector-close semantics. Verify
that every action needing the detailed model has a live owner; do not break
diagnostic copying, output inspection or navigation through an early return.

### Verification and exit

- Extend the existing Run Activity renderer/drawer tests to feed events while
  closed, assert zero detailed row-resolution calls, then open and inspect exact
  rows. Also cover closing while an inspector or live-duration timer is active.
- Run the same execution with the drawer closed and open. Verify identical
  retained journal semantics and outputs, then compare CPU work and duration.
- Recheck tabs, recording playback and plugin display labels. Keep only measured
  savings; this phase must not introduce delayed authoritative state.

## P2 Reduce startup loading

### Find the actual dependency edges

Start with:

- `packages/studio-server-web/entry.tsx` and `bootstrapApp.tsx`
- `packages/studio-server-web/dashboard/DashboardPage.tsx`
- `packages/studio-server-web/dashboard/WorkflowLibraryModals.tsx`
- `packages/studio-server-web/dashboard/WorkflowLibraryPanel.tsx`
- `packages/studio-server-web/dashboard/HostedEditorApp.tsx`
- `packages/studio-server-web/vite.config.ts`
- `packages/app/src/components/CodeEditor.tsx`
- `packages/app/src/components/ProjectComparisonDiffEditor.tsx`
- `packages/app/src/utils/monaco.ts` and `utils/monaco/codeEditorMonaco.ts`

Use the emitted import graph and browser requests to trace why Monaco and
provider/runtime modules reach startup. The `useHostedSurfaceDismiss` chunk name
is not a module ownership boundary. Also distinguish static dependencies from
Vite preloads and the dashboard's automatically mounted editor iframe.

### Changes

1. Convert type-only imports to type-only edges where appropriate. Reuse existing
   narrow Core entrypoints, such as serialization, when they own the needed
   behavior. Do not make hosted code depend on more editor/engine internals.
2. Load code editors, comparison editors and settings-only heavy surfaces at the
   actual feature boundary. Preserve existing shared components rather than
   creating hosted-only alternatives.
3. Provide a compact loading state and explicit failure/retry at that boundary.
   Preserve pending text, selected project/node, focus intent and cancellation
   when the user closes a modal or switches projects during the import.
4. Keep the existing Monaco worker setup, model cache, language initialization,
   themes, completion and diagnostics owners. Load them before creating a usable
   editor; do not register them twice after a retry or Strict Mode remount.
5. Retain bootstrap error handling and the `editorSource` pinned-build contract.
   A delayed import must still work after a newer frontend build is published.
6. Inspect emitted requests after every boundary change. Adjust manual chunking
   only when the build graph proves it is necessary. Do not disable module
   preload globally, force every dependency into a chunk or merely rename chunks.
7. Do not defer iframe mounting or change workspace restoration simply to improve
   dashboard timing. Consider such a behavior change separately only if the
   dependency fixes cannot meet the goal.

### Verification and exit

- No Monaco request before a Monaco-backed feature is needed, including in the
  embedded editor, rather than only its removal from the main-frame manifest.
- Production-build checks cover dashboard, direct `/?editor`, restored workspace
  and first project open. Exercise first Code Editor open/edit, JSON diagnostics,
  prompt language, diff editor, close-during-load and a failed lazy import/retry.
- Reuse `node-editor-lifecycle.spec.ts`, `node-editor-ownership.spec.ts`, existing
  bootstrap/recovery tests and production asset tests; do not duplicate them in
  an enormous new test file.
- Add a small emitted-graph/request guard for forbidden eager dependencies.
  Match module identity or a manifest-derived relationship, not hashed filenames.
- Compare combined dashboard-plus-first-project cost and first code-edit
  readiness. A faster empty dashboard with a proportionally slower first project
  is not sufficient. Do not eagerly prefetch the removed bytes before the
  checkpoint to conceal the shift.

## P3 Optimize the remaining execution presentation

Reprofile after P1. If detailed activity projection or immutable updates are no
longer significant, stop this phase and record the measured residual cost.

Owners:

- `packages/app/src/components/runActivity/RunActivityRenderer.tsx`
- `packages/app/src/components/runActivity/buildRunActivityViewModel.ts`
- `packages/app/src/features/runActivity/runActivityJournal.ts`
- `packages/app/src/features/runActivity/runActivityProcessEvents.ts`
- `packages/app/src/hooks/projectExecutionSnapshotEvents.ts`
- `packages/app/src/hooks/projectExecutionSnapshotRouting.ts`
- `packages/app/src/hooks/useExecutionSnapshotWriter.ts`

### Resolve and project only what changed

1. Build graph/node lookup indexes once for the current definition identities.
   Preserve the unsaved current graph's precedence over its saved definition,
   prefab resolution, deleted-node fallbacks and foreign-project isolation.
2. Separate stable definition lookup from exact process-output lookup. Resolve
   history by binding, root run, graph run, graph, node and process identity;
   never substitute another execution with the same node ID.
3. Cache derived rows only inside their presentation lifetime, using the actual
   invocation, graph/ancestry, definition, registry and stored-output dependencies.
   Project ID alone is not a sufficient key. Start with simple reference-based
   indexes/memoization; add revision counters only if references cannot express
   the required invalidation cleanly.
4. Avoid rebuilding expensive response-inspector traces for every ordinary row
   if a cheap capability predicate is sufficient. Build the full trace on actual
   inspection while preserving button availability and failure handling.
5. Reuse unchanged row objects. Keep elapsed-time updates separate from completed
   rows and retain stable ordering, filtering, accounting and graph options.
   Remove a full sort only if journal sequence ordering is proved by tests.
6. Recompute accounting incrementally only if it remains a measured cost and
   parity tests cover partial/unknown costs, dropped-history counters and retries.
   Do not create a second accounting authority for the sake of caching.

### Handle immutable update costs conservatively

First remove redundant copies or repeated work shown by the new profile. Preserve
the shared snapshot writer, source admission, effect ordering and ref cleanup.
If a producer already supplies a bounded ordered batch, a single journal reduction
may apply that batch in one immutable transaction, with the same result as its
individual events.

Do **not** add a new global event buffer, delay control state until the next
animation frame or change journal publication semantics as a default solution.
Frame batching of derived presentation is an optional later step only if it
still has a material benefit. It must have bounded storage and a maximum delay,
work in background tabs without relying solely on `requestAnimationFrame`, and
flush/dispose on terminal events, tab changes, unload and binding replacement.
Old deferred work must never repopulate a closed or rebound tab.

### Verification and exit

- Extend existing journal/view-model tests with one shared lifecycle sequence:
  streaming, split runs, outputs ready, late child completion, failure/abort,
  replay replacement and retained-history trimming. Assert optimized versus
  reference results, object reuse for unchanged rows and bounded cache lifetime.
- Exercise Browser/Node and active/inactive snapshot parity using
  `executionSnapshotParity.test.tsx`, `projectExecutionSnapshotEvents.test.ts`
  and `projectExecutionSnapshotRouting.test.ts`.
- In the browser, run with the drawer open and closed, switch bundle tabs, reopen
  a tab with the same ID, inspect an output and repeat playback. Assert actual
  values and row identities, not just control visibility.
- Keep the simplest change that shows a material paired improvement. Do not add
  more caches after the hot path has ceased to dominate.

## P4 Reduce redundant dependency traversal without weakening access

Owners:

- `packages/core/src/model/GraphProcessor.ts`, especially
  `#loadProjectReferences` and `#loadSubgraphProjectTargets`
- `packages/core/src/model/SubgraphProjectTarget.ts`
- `packages/core/src/model/nodes/SubGraphNode.ts`
- `packages/studio-server-web/dashboard/hostedSubgraphProjects.ts`
- `packages/studio-server-api/src/routes/workflows/managed/subgraph-access.ts`

The measured chain produced nine snapshot loads and 36 access requests per
Browser run. The `visited` set is local to each topology traversal, while nested
processors share target snapshots. Repeated descendant discovery therefore
rechecks cached edges. Snapshot reuse and permission reuse are different things.

### Characterize the safety boundary first

1. Instrument tests with exact caller/target/version tuples and distinguish
   topology discovery from an actual cross-project invocation.
2. Cover chain, diamond, repeated invocation, cycle, depth limit, disabled node,
   prefab, latest/published variants and two callers with different access to the
   same cached target.
3. Establish where live validation occurs today. Include a project moving between
   bundles after discovery, deletion/recreation, a load failure and a second run
   on a reusable processor. Permission denial must reach the caller without
   executing the denied target or accepting stale bytes as authorization.

### Preferred implementation boundary

Reuse successful **structural discovery of exact graph/snapshot definitions**
within one root execution, rather than walking the same descendant structure for
every child. Keep cycle detection and graph/depth checks correct on each relevant
path; a visited marker cannot be reused as an active recursion marker.

Keep live caller-dependent validation at the actual target-admission boundary and
preserve required preflight checks. Moving a check must never move it after node
side effects or remove a meaningful revocation boundary. An authorized parent's
result cannot authorize a different caller. Only concurrent duplicate checks of
the same actual admission may share a pending result; no TTL-based permission
cache or cross-run approval cache is part of this plan.

Implement only when those boundaries can be expressed through the existing
loader/processor ownership. If required rechecks cannot be removed safely, retain
them and optimize only structural traversal. Do not introduce signed access
tokens, a new batch API, schema changes or broad server caches in this phase.

### Verification and exit

- Use existing Core graph/child-processor tests and
  `managed-subgraph-access.test.ts`, plus a counted HTTP fixture for the hosted
  loader. Add deterministic gates for hierarchy changes during a run.
- For a simple one-invocation-per-edge chain, repeated _discovery_ must be linear
  in unique edges/graphs rather than triangular in depth. Set exact request-count
  assertions from the preserved access contract; zero access checks is not a goal.
- A genuine repeated invocation still receives its required live validation.
  Reused structural state expires with its root execution and cannot leak into a
  new caller, selected version, changed graph or later run.
- Reject on access failure and propagate the original error. Never retry graph
  execution or a modifying request to hide a failed or uncertain response.

## P5 Integrated verification and completion

### Lean test strategy

Use existing suites as the owners of regression scenarios rather than repeating
the same matrix at every layer:

| Layer                  | Responsibility                                                                         |
| ---------------------- | -------------------------------------------------------------------------------------- |
| Core unit/lifecycle    | Registry semantics, target discovery, exact access context and terminal ownership      |
| App reducer/view model | Journal equivalence, cache invalidation, accounting, row identity and ref cleanup      |
| Hosted/asset contracts | Lazy import reachability, build pinning, worker/language loading and forwarding        |
| Headless browser       | Real first use, bundle-tab outputs, debugger reconnect and repeated recording activity |
| Local benchmark        | Timing, bytes, CPU samples and request amplification on identical workloads            |

Run focused tests after each phase. At the final gate run the complete relevant
Core, App, Node and hosted-web suites, architecture/import checks and production
builds. Run API access regressions if P4 changes the loader/authorization seam.
Finish build-mutating checks before Node/browser fixtures import compiled Core.

Browser verification uses the repository runner with `PLAYWRIGHT_HEADLESS=1`,
`PLAYWRIGHT_SLOW_MO=0` and the isolated local URL. Reuse the existing
`remote-bundle-observation.spec.ts` and `recording-playback-history.spec.ts`, plus
the relevant code-editor/recovery scenarios. Inspect failure artifacts instead
of relaxing an assertion. Performance sampling remains a separate local command;
do not add many minutes to every develop push.

### Proposed performance acceptance criteria

Freeze paired P0 measurements before editing runtime code. These are local work
targets, not production guarantees or universal millisecond thresholds:

- At least 25% less decoded JavaScript requested during an empty dashboard
  startup across the whole page/iframe, and no eager Monaco request before it is
  needed. Record transfer and gzip estimates separately.
- No material regression in navigation to first usable project or first usable
  code editor. Investigate a repeatable increase greater than the larger of 10%
  or 50 ms; do not trade all startup savings for a new first-use stall.
- Aim for at least 25% lower median Browser execution-to-terminal presentation
  time on the 999-node workload, compared with its new P0 baseline. Report drawer
  open and closed separately, with supporting CPU samples and output parity.
- Tab switching and repeated playback should not regress by more than the larger
  of 10% or 20 ms in paired repetitions. Investigate noise before declaring a
  regression. Do not reduce fixture complexity or history to meet the target.
- Debugger steady-state and burst runs must settle completely with correct member
  outputs, no repeated execution commands and no persistent queue after the
  producer stops. Compare both first-output latency and terminal drain time.
- The access/traversal optimization passes only with all authorization regressions
  intact and a documented work/count reduction. A safe decision not to remove a
  required check is acceptable; silently weakening it is not.

If a target is missed, report the measured result and remaining hot path. Do not
declare success by moving the checkpoint, changing the browser or changing the
fixture between baseline and candidate. Stop adding complexity when the next
change has no material paired benefit.

### Documentation and handoff

Update this plan's phase status and the owning developer docs as each phase lands.
Keep the original baseline and add a separate before/after report with exact
revision/diff identity, raw artifact location, test results, bytes, timing,
profiles and any deliberately retained cost. Document lazy-loading ownership and
cache invalidation rules next to their extension points.

Completion requires correct saved data and outputs, passing relevant regression
and headless checks, reproducible paired evidence, no new unbounded cache/queue
and a truthful disposition for every phase. Do not infer native desktop startup,
production network performance or GKE qualification from the hosted local run.

Before any later requested commit, review the complete diff and owning docs;
do not stage generated builds, CPU profiles, secrets or local artifacts. Preserve
the user's `develop` branch preference. Publication and deployment remain outside
this implementation plan's authority.
