# Execution routing and display hardening plan

Status: proposed; implementation has not started. Prepared 2026-10-24.

This plan follows the local bundle-execution display reviews recorded in
[Project bundles](./project-bundles.md#desktop-opening-and-execution).
It is an editor architecture refactor, not an infrastructure or deployment plan.

Before implementation, use the dated
[functional baseline](../EXECUTION-ROUTING-BEHAVIOR-BASELINE.md) for the actual
current behavior and post-refactor comparison IDs. Its GAP-01–05 section separates
source-checked adapter differences/characterization debt from verified guarantees.
Documentation and the original 256-test baseline have been prepared. A test-only
audit has since extracted local hook tests, retained real workspace integration,
removed masked assertions and preserved the scenario matrix in 240 focused checks.
P0's full writer inventory and cross-adapter comparison harness are still pending;
this cleanup does not implement the production coordinator or store refactor.

## Goal and scope

Make execution-related features easier to add without independently rediscovering
tab lifetime, bundle membership, display ownership, event ordering and cleanup rules.
Preserve the current user-visible behavior across Browser execution, desktop Node,
hosted Node, Remote Debugger and recording playback.

Refactor the editor's execution coordination layer in small, independently verified
steps. Do not rewrite the graph scheduler, replace Jotai, introduce a general event
bus, add a service or change database/project/bundle/recording schemas. Do not
combine this work with the unrelated uncommitted HA/deployment changes.
No publication, production access, GCP changes or paid rehearsal is included.

The recent defects are already fixed. Their regressions are the preservation
contract, not a claim that those defects remain open. The saved baseline receipts
are `artifacts/bundle-routing-admission-unit.log` (149 focused tests) and
`artifacts/bundle-routing-admission-ui-final.log` (five headless UI checks).
These are prior local evidence, not verification of this proposed refactor.

## What the failures tell us

| Findings from the reviews | Structural cause | Refactoring boundary |
| --- | --- | --- |
| Desktop/Server membership and executor-target omissions | Mode-specific integration knows too much about routing | Neutral membership contract and explicit source adapters |
| Independent runs, playback and debugger data overwritten; conflicts missed before/between child events | Display ownership is inferred repeatedly from scattered mutable atoms | One display-admission policy using authoritative ownership transitions |
| Reopened, rebound, moved or newly opened tabs receiving partial/stale data | Project ID and path are being used as substitutes for a tab lifetime | Explicit in-memory binding generation |
| Browser terminal cleanup, late-child resurrection and active-state eviction | Transport messages, display outcome and actual execution settlement are conflated | Normalized lifecycle and lifecycle-owned retention |
| Redundant restoration and active/inactive special cases | More than one route can update equivalent execution state | One write boundary, then one canonical per-binding execution state |

There are already useful foundations. Reuse `ExecutorSessionRegistry` and its
message admission, `createRemoteExecutionObservationRouter`,
`updateOpenProjectExecutionSnapshot`, the snapshot event reducer and Run Activity
journal. Do not add competing versions of those responsibilities.

## Invariants that govern every phase

These are target guardrails, not a claim that all current adapters are already
identical. Use the functional baseline to preserve established behavior and expose
differences; resolving a baseline gap requires a regression and an explicit
intentional-change record rather than silently describing it as a code move.

1. A project ID identifies a project, not an open-tab incarnation. Closing and
   reopening, replacing its file binding or changing bundle binding invalidates
   the old display recipient, even if it later returns to the identical path.
   Switching tabs, saving or renaming a title does not create a new incarnation.
2. Explicit bundle membership is authoritative. References do not create bundles;
   hosted `null` detachment must not fall back to a desktop hint. No entry-project
   concept is introduced. Any member can initiate execution/debugging.
3. Root-run admission captures eligible receiver incarnations. A child event cannot
   create or resurrect admission. Conflicts exclude the affected receiver for that
   root, including conflicts that end before its first child event.
4. Only existing execution owners issue run/cancel/pause/resume/input commands.
   Passive display never acquires those capabilities or reruns an operation.
5. Display rejection does not reject execution. Display errors cannot fail the
   graph, lose its recording or retry a save/upload/execution command.
6. Live, reconnect/replay and recording events remain distinguishable. Preserve
   Remote Debugger's existing recovery and shared bundle-session behavior rather
   than imposing local-run policy on it.
7. One admitted display event updates one target snapshot and its data references
   once. Canvas ancestry may be rebased, but Run Activity keeps original ancestry.
8. Root display outcome, abort request, outputs-ready and processor settlement are
   different facts. None may be used interchangeably to grant new run ownership
   or release execution resources.
9. Retention must not silently evict active admission/protections. Memory cleanup
   must also cover source disposal, disconnect/replacement and workspace shutdown.
10. Unsaved graphs, datasets, save/conflict handling, playback selection, frozen
    outputs, existing evaluation behavior and old recording compatibility survive.

## Target responsibilities

Proposed modules under `packages/app/src/domain/execution/`:

- `bundleMembership.ts`: neutral membership resolution, reusing the current
  `remoteDebuggerBundle.ts` rules instead of redefining portable formats.
- `projectBindingRegistry.ts`: current recipient generations and atomic workspace
  binding changes; no sockets, graph execution or file IO.
- `executionEventNormalization.ts`: typed source/lifecycle envelope adapters;
  preserve original Core payload and ancestry.
- `executionDisplayPolicy.ts`: admission/conflict decisions and reason codes;
  no React, Jotai writes or transport controls.
- `executionObservationCoordinator.ts`: source/run/receiver lifetimes, sticky
  exclusions, graph ownership and cleanup; returns explicit projection commands.

Use one coordinator instance per app store/workspace, owned at provider scope.
Hooks subscribe or forward facts; they do not each create another admission map.
Keep the existing snapshot reducer and reference-storage helpers behind one store
adapter while moving policy. They currently have effects; do not pretend that
shadow-running them is a pure or safe comparison.

Keep transport request admission in `executorSession.ts`/the session registry.
The coordinator consumes that accepted identity; it does not perform a second,
inconsistent security/request-ownership decision. Likewise, display ownership
policy observes existing local-run controllers, playback state and debugger
membership; it does not become another execution lock manager.

## Implementation sequence

### P0 — Freeze the contract and build the replayable test harness

- Inventory all event ingress and execution-state writers in `useLocalExecutor.ts`,
  `useRemoteExecutor.ts`, `ExecutorSessionContext.tsx`,
  `useRemoteExecutionObservations.ts`, `useLoadRecording.ts`,
  `useGraphExecutionEvents.ts`, `useNodeExecutionEvents.ts` and
  `useExecutionDataFlow.ts`.
- Record which handler owns controls, prompts, recording, reference effects, source
  display and passive display. Include Browser and Node evaluation trials: preserve
  their existing isolation, not accidental canvas fan-out.
- Local routing fixture extraction is complete in `useBundleExecutionRouting.test.tsx`;
  two real tab-activation integrations and project-opening tests remain in
  `useLoadProject.test.tsx`. Reuse these focused fixtures when building the
  cross-adapter comparison harness; do not reintroduce a full workspace mount for
  each metadata-policy combination.
- Add a failure-to-invariant matrix covering every finding above. Separate product
  failures from the fixed Vite `/api/` interception bug and sandbox launch failures.
- Use synthetic project data and deterministic gates. A captured trace contains
  metadata/event kinds only, not real project contents, credentials or outputs.

Exit: existing regressions and UI scenarios pass unchanged; every event ingress
and state writer has a documented owner. This phase does not change runtime behavior.

### P1 — Give workspace bindings an explicit lifetime

- Introduce a runtime-only, monotonic binding token, allocated on committed open,
  close/reopen, file replacement/rebind and explicit bundle-binding change.
- Integrate at the existing open/close/rebind/membership transition owners, including
  `useLoadProject.ts`, `useWorkspaceTransitions.ts` and the actual close entry point
  identified in P0. Failed/superseded asynchronous opens cannot publish a binding.
- Reuse the existing Remote Debugger receiver-token concept, replacing its separate
  inferred path-lifetime map with this shared identity.
- Keep path normalization with the existing IO owner; do not invent cross-platform
  casing or symlink rules in the routing layer. Saving normally, updating a title,
  changing graph selection and activating an existing tab preserve its token.
- Publish a coherent binding/ownership transition. Do not make subscribers observe
  a new active project paired with the previous project's running flags.
- Tokens are not serialized into saved projects or persisted workspace metadata;
  a recovered workspace starts new runtime lifetimes. App/provider disposal retires
  the registry and all observers.

Exit: source and receiver reopen/rebind/membership round-trip tests pass, including
changes entirely between events and switching tabs while the source runs. A save
does not detach observation or cause a false conflict dialog.

### P2 — Normalize event identity and lifecycle at ingress

- Add an internal typed envelope carrying source kind, source incarnation, existing
  request/run identity, live/replay origin, original payload and lifecycle fact.
- Use an exhaustive adapter for Browser, internal desktop Node, internal hosted Node,
  external debugger and recording playback. Adding a new target must fail a
  compile-time exhaustive check until its adapter behavior is explicit.
- For Browser's identity-free terminal notifications, bind only to the captured
  processor invocation. Never borrow identity from the active tab or most recent
  unrelated event. Preserve existing metadata/project-scope admission for Node.
- Model outputs-ready, abort-requested, display-terminal, settled and interrupted
  separately. Core can emit an error before its final cleanup drains; its `finish`
  event and `waitForRunCompletion()` are not the same as a root `error` notification.
- Use actual settlement only where the adapter can prove it. For older remote
  runtimes, represent settlement as unknown/interrupted; do not infer success or
  readiness to run again. Do not add a wire-protocol change to make this phase work.
- Preserve accepted session/replay sequence information where it exists. An app
  ingress counter is not evidence of transport exactly-once delivery. Deduplicate
  only using an actual protocol/event identity or an existing domain transition;
  repeated partial outputs must remain real updates.

Exit: equivalent Browser/Node event transcripts produce equivalent admitted display
commands. Startup failure, early outputs, async unwinding, abort, reconnect, missing
identity and old-runtime behavior have explicit tests.

### P3 — Consolidate observation policy and lifetime coordination

- Extract the metadata-only rules from `useBundleExecutionRouting.ts` and
  `remoteExecutionObservation.ts` into the shared coordinator. Move local routing
  first, then Remote Debugger, with a working intermediate state at each step.
- Evaluate conflicts at root admission and on authoritative ownership changes,
  not only when a child emits. Preserve sticky exclusion and exact binding tokens.
- Represent decisions as typed reasons such as `different-bundle`, `stale-binding`,
  `independent-run`, `recording-owned`, `independent-debugger`, `root-not-admitted`
  or `source-retired`. Keep user-facing text in presentation adapters.
- Preserve intentional mode differences explicitly: local editor roots may close
  passive projection at their identified terminal; Remote Debugger keeps its
  notices, version/input/pause diagnostics, replay recovery and shared Stop control.
  A root outside the bundle may provide ancestry context without acquiring a tab
  outside the explicitly eligible bundle.
- Preserve existing multi-root history/selection behavior. Do not replace it with
  an undocumented last-writer-wins rule or give passive observers command authority.
- Keep metadata and retained display history separate. Prune completed metadata and
  retire disconnected/disposed sources without deleting still-displayed data refs.
  Late events from retired incarnations cannot establish a new source/run.
- Establish retention limits from measured use. If admission must be limited,
  refuse new passive admission with a bounded notice; never evict an admitted live
  root or admit a previously refused root from a later child event.

Exit: both local and remote adapters use the same identity, admission and lifetime
implementation. Remove superseded maps/subscriptions rather than leave two owners.
The existing mode-specific behavior matrix must remain green.

### P4 — Unify execution-state writes, then active/inactive storage

- First route every source/passive/playback update through one generation-checked
  store boundary, retaining existing reducers/helpers during migration. Remove the
  direct active-vs-inactive decision from transport callbacks and UI components.
- Audit node/graph state, graph-run selection, Run Activity, frozen outputs,
  last-recording state, process/LLM page selection, pause/running flags and prompts.
  Preserve the existing distinction between interactive owners and passive waits.
- Reuse `projectExecutionSnapshotEvents.ts`, `executionDataTransitions.ts`,
  `graphExecutionEventHelpers.ts` and `projectExecutionSnapshotBindings.ts` instead
  of writing another complete event interpreter. Consolidate the active handlers
  event family by event family against differential transcript tests.
- Execute each payload/reference effect once. Shadow comparisons operate on
  independent test stores/ref stores, never both paths against live state. Isolate
  optional Run Activity/display failures without discarding the primary snapshot.
- Make per-binding execution state canonical. Existing active-tab atoms become
  compatibility selectors/write adapters, not another authoritative copy. Switching
  tabs selects a view rather than saving/restoring execution history to transfer
  ownership. Keep project/graph document persistence outside this migration.
- On close/prune, release only refs owned by that binding and no longer retained
  elsewhere; preserve shared references, recording replay resets and reopened-tab
  isolation. Delete obsolete capture/restore machinery only after all consumers
  are migrated and the data-reference tests prove safe cleanup.

Exit: active and inactive tabs use the same event update path, all snapshot fields
are covered, and no tab switch can redirect an event. No duplicate history rows,
execution counters, prompts or reference effects appear.

### P5 — Put the invariants into routine regression and diagnostics

- Use one scenario matrix across the real mode adapters: A → B → C, A → B → A,
  shared node IDs, failed children, parallel roots, unrelated bundles, membership
  changes, reopening, rebinding and tabs opened after root start.
- Test initial, between-event and pre-first-child conflicts for independent runs,
  recording playback and debugger ownership, with receivers active and inactive.
- Add seeded lifecycle-sequence tests and replayable failure transcripts. Preserve
  causal order for valid streams; inject duplicates, delayed stale callbacks,
  missing terminals and disconnects as explicit separate fault cases.
- Assert properties: no stale-generation writes, no child-created root admission,
  no late resurrection, no passive control capability and no active-root eviction.
  Run thousands of completed roots plus held live roots; verify retained metadata
  returns to its defined baseline after disposal without deleting visible results.
- Benchmark event bursts and large histories against P0 baselines. Use acceptance
  budgets recorded with the fixture/hardware; do not optimize by dropping active
  metadata or copying large payloads. Test notification counts and ref allocations.
- Expose bounded development diagnostics: source/run/binding IDs, transition kind,
  rejection reason and live/retained counts. No payloads/secrets, unbounded log per
  partial event or production telemetry service is needed.
- Add an import-boundary check using the repo's existing check infrastructure:
  transport adapters cannot mutate canvas atoms, and domain policy cannot import
  React/Jotai/transport commands. Do not add another build tool just for this rule.

Exit: the normal CI path runs the new domain/adapter regressions and the relevant
existing UI matrix. Failure output identifies a rule/sequence, not just a timeout.

### P6 — Finish consolidation and document how to add the next feature

- Remove migration shims, obsolete hooks/maps and duplicate state writers.
  Temporary comparison paths must have an owning phase and removal condition.
- Document module ownership, lifecycle facts, source/receiver identity, intentional
  policy differences, supported old-runtime behavior, memory/ref ownership and
  diagnostics. Keep architecture and behavior docs linked rather than duplicating
  a long historical test log as the only specification.
- Add a contributor checklist: identify the source adapter and control owner,
  declare recipient/lifetime policy, use the shared write boundary, add at least
  one conflict/late-event regression, and run the mode matrix affected by the change.
- Report what was validated locally. Provider qualification, packaged desktop
  binary coverage, publication and production deployment remain separate decisions.

Exit: a new display consumer can be added using an adapter/policy and tests without
inventing another receiver cache, tab-lifetime subscription or active/inactive reducer.

## Verification and delivery rules

P0 precedes all structural work. P1 and P2 are prerequisites for P3; P4 follows P3.
Build the P5 harness/checks alongside each phase, not after the whole migration.
P6 completes the work. Each phase must be reviewable and leave the app working.
Keep behavior changes separate from code moves and do not merge a failing phase.

Use the existing app `test:files` runner for domain, adapter, snapshot, session,
workspace and playback regressions. At minimum preserve these owning suites:

```powershell
yarn workspace @valerypopoff/rivet-app test:files src/hooks/useBundleExecutionRouting.test.tsx src/hooks/useLoadProject.test.tsx src/hooks/remoteDebuggerBundle.test.ts src/providers/ExecutorSessionContext.test.ts src/hooks/remoteExecutionObservation.test.ts src/hooks/projectExecutionSnapshotEvents.test.ts src/hooks/recordingPlaybackDisplay.test.ts
yarn workspace @valerypopoff/rivet-app exec tsc --noEmit
node scripts/checks/check-test-style.mjs
node scripts/checks/check-doc-links.mjs
yarn studio-server:verify:repo-structure
git diff --check
```

Add new tests to the applicable runner/CI ownership rather than depending on a
developer remembering the list. Lint all changed implementation/test files from
the app workspace. Run existing reference-storage, event-transition, workspace,
evaluation and session suites affected by each phase, not just the focused baseline.

Any behavior-affecting phase requires headless Playwright using the repo runner:

```powershell
$env:PLAYWRIGHT_HEADLESS='1'
$env:PLAYWRIGHT_SLOW_MO='0'
# Set PLAYWRIGHT_BASE_URL to the local source UI server.
yarn studio-server:ui:observe desktop-project-bundle.spec.ts hosted-subgraph-auth.spec.ts remote-bundle-observation.spec.ts
yarn studio-server:ui:observe recording-playback-history.spec.ts local-editor-recordings.spec.ts run-recordings-modal.spec.ts
```

Use disposable loopback PostgreSQL/object-storage/executor fixtures and real
Browser/HTTP/WebSocket paths. Verify fixture cleanup. Do not substitute fake event
callbacks for all mode-adapter acceptance. Desktop Node adapter changes also run
`packages/app-executor/bin/executor.projectBundle.test.mts`; native sidecar coverage
is required before claiming packaged desktop qualification. Inspect Playwright
artifacts on failure and distinguish environment startup failure from product failure.

Stop and revise the affected phase if it requires a wire/schema change, changes
which project owns controls, rewrites saved data, weakens replay/recording behavior,
cannot explain a parity mismatch or needs production access to continue. None is
silently authorized by this plan. Use an ordinary revert of a known refactor change
if necessary; do not recover by resetting the workspace or restoring user data.

## Completion criteria

- All recent bug regressions remain covered and pass across their actual adapters.
- One shared binding identity, display-admission policy and observation lifetime
  owner replace the duplicated local/remote implementations.
- One canonical execution state/write path serves active and inactive views.
- Controls, prompts and recording remain with their existing authorized owners.
- Missing/out-of-order lifecycle facts fail safely with useful diagnostics; live
  admission is never silently evicted and disposed sources do not leak metadata.
- Large-history/event-burst and reference-cleanup checks meet the measured baseline.
- The full relevant local UI matrix passes; saved data and old recordings work.
- Developer docs describe both the contract and the next-feature integration path.
- No unrelated HA code, cloud resources or production deployment was changed.
