# Evaluations reliability and maintainability improvement plan

This assessment was revalidated against the implementation at `54e86021a` and
then used as the implementation roadmap on 2026-08-23. The Evaluations engine
has a sound separation between target execution and quality evaluation. The
first hardening increment implemented the shared lifecycle, incremental event,
checkpoint, per-record storage, and compare-and-swap foundations described
below. The remaining repository normalization, lease/resume, retention-budget,
and UI-model work stays in this file as explicit follow-up rather than being
mistaken for a guarantee the product already provides.

## Implementation status (2026-08-23)

| Area              | Delivered in this increment                                                                                                                                                                                                                  | Remaining acceptance boundary                                                                                                                                                                                                                                                       |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Persistence       | V2 per-run records plus a per-project index; per-snapshot and per-recording artifacts; lazy restartable V1 imports; revisioned library writes; compare-and-swap batches in IndexedDB and SQLite; atomic recording manifest/artifact changes. | Runs still contain embedded trials and listing materializes all runs. There is no summary pagination, byte budget, reference-counted GC, or one transaction spanning snapshot, run, trials, and recordings. Custom backends without `applyBatch` have compatibility semantics only. |
| Lifecycle         | Local and remote execution use one framework-independent lifecycle service for snapshots, runner events, checkpoints, name preservation, retention, warnings, and terminal persistence.                                                      | Runtime preparation/graph execution, abort registries, and recording production remain adapter-owned. A declared concurrency-capability registry and the large UI model split remain follow-up work.                                                                                |
| Progress/recovery | The runner emits awaited revisioned `run-started`, one-trial `trial-settled`, and `run-finalized` events; the app structurally applies one trial and durably checkpoints events in order. Legacy full snapshots are opt-in only.             | There is no cross-window lease/heartbeat, abandoned-run classification, explicit resume, incremental aggregate accumulator, or UI-event coalescing yet. Persisted checkpoints are recoverable evidence, not a promise that a run can resume.                                        |

The implementation intentionally does not mark the broader plan complete. It
closes the highest-risk lost-update and duplicated-finalization paths without
introducing unsafe “resume” behavior that could race another live window.

## Post-roadmap maintenance (2026-09-05)

The following completed replay-UI correction is deliberately outside the
persistence roadmap above: it changes no evaluation artifact, retention, or
transaction guarantee.

- A loaded recording is now owned by the exact editor tab: its project ID and
  loaded path must both match before replay-only UI or executor behavior is
  shown. This prevents a replay's yellow canvas frame, controls, and disabled
  executor status from leaking into another open document when a legacy replay
  project ID is reused.
- Recording activation and release update the recorder selection and the
  transient playback-start state together. Replacing a tab or a failed replay
  restore clears by the exact path, so an unrelated tab cannot be cleared.
- When a normal project tab is renamed or moved, a manually loaded recording
  follows that tab's rewritten path. This preserves the owner relationship
  without weakening cross-tab isolation.

Coverage includes state ownership transitions, hosted bridge contracts, replay
tab switching, and workflow-tree synchronization. The remaining persistence
and lifecycle work in this plan is unchanged.

The three original architectural boundaries were:

1. persistence is expressed as independent key/value operations instead of an
   evaluation transaction;
2. the application execution lifecycle is duplicated across local and remote
   executors and partly owned by the UI;
3. live progress is transported as an ever-growing full run snapshot instead of
   incremental events and durable checkpoints.

The scoring, deterministic-check, threshold, aggregation, provenance, and
cancellation rules in the engine do **not** need a rewrite. The work below is
about giving that engine a transactional repository, one application-level
orchestrator, and an incremental progress protocol.

## Assessment corrections and confirmed assumptions

The original assessment was directionally correct, but several claims needed to
be made more precise.

| Assumption                                                                              | Reassessment                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A saved run can routinely reference a recording that was never persisted.               | **Not supported by the built-in implementation.** A recording reference is returned only after the artifact and its manifest entry have been persisted. The real crash window is the inverse: a recording or dataset snapshot can be committed before the terminal run, leaving an orphan if finalization fails. A custom host store could still violate the intended ordering because the interface does not express an atomic evidence commit. |
| Same-process library edits can overtake one another.                                    | **Mitigated in the current increment.** The app still serializes writes within one store instance, while the built-in browser and desktop stores now compare the last observed revision and atomically reject a stale replacement. Hosted/custom implementations receive the same optional batch seam but must provide their own cross-client transaction.                                                                                       |
| The local per-project controller map and remote single controller prove a behavior bug. | **Not proven.** The remote runtime may intentionally allow only one active evaluation session. The confirmed problem is that this policy is embedded independently in two lifecycle implementations instead of being an explicit adapter capability tested by a shared contract.                                                                                                                                                                 |
| Desktop SQLite makes evaluation finalization transactional.                             | **Still false as a whole-lifecycle claim.** SQLite now provides atomic compare-and-swap batches for individual run/index, snapshot, library, and recording-manifest transitions. The lifecycle still crosses several such transactions, so a crash can leave a checkpointed nonterminal run or orphan snapshot rather than one all-or-nothing finalization.                                                                                      |
| Hosted implementations necessarily use the same JSON layout as the built-in stores.     | **False.** A host can normalize its own storage internally. `EvaluationStore.applyRunEvent` and the app key/value `applyBatch` capability now express idempotent checkpoints and atomic mutations additively. The public store still lacks paginated summaries, typed conflict results, interruption leases, and an atomic evidence-finalization operation, so stronger guarantees cannot be relied on portably.                                 |
| Interrupted evaluations are resumable.                                                  | **Still false by design.** Live progress is now durably checkpointed when the active store implements `applyRunEvent`, so settled evidence need not disappear. No safe cross-window lease or provenance-checked resume exists yet; a stored nonterminal run is not automatically relabeled or resumed.                                                                                                                                           |

## Current ownership map

```text
Evaluation library + workspace state (Jotai)
                    │
                    ▼
        Evaluations workspace UI
          │                  │
          │                  └─ resource/history/baseline store operations
          ▼
 Local executor hook / Remote executor hook
          │
          ├─ runtime adapter, cancellation registry and notifications
          ▼
 executeEvaluationRunLifecycle (shared application service)
          │
          ├─ snapshot, checkpoints, retention and terminal persistence
          ▼
 runEvaluationSuite (executor-agnostic engine + delta events)
          │
          ▼
 Target/evaluator graph adapter

Built-in persistence
  Browser: IndexedDB values (with a local-storage compatibility fallback)
  Desktop: SQLite key/value rows
  Hosted: injected EvaluationStore implementation
```

The target ownership should instead be:

```text
UI ──commands/events──> EvaluationExecutionController
                            │
                            ├─ EvaluationRepository (transactional domain API)
                            ├─ EvaluationRuntimeAdapter (local or remote graphs)
                            └─ runEvaluationSuite (evaluation rules)
```

---

## Problem 1: persistence is not atomic or scalable as an evaluation database

### Verified current behavior

The store contract in
[`packages/evaluations/src/types.ts`](packages/evaluations/src/types.ts) exposes
independent methods for runs, dataset snapshots, recordings, retention, and
baselines plus the additive, idempotent `applyRunEvent` checkpoint capability.
The app's key/value backend adds compare-and-swap batches, and built-in library
writes carry revisions. The public domain contract still has no compound
`beginRun`/`finalizeRun`, typed conflict, summary-pagination, or resource-CAS
operation.

The built-in implementation in
[`packages/app/src/providers/EvaluationRunStore.ts`](packages/app/src/providers/EvaluationRunStore.ts)
now stores:

- a small per-project run index plus one complete JSON record per run;
- one immutable record per project-scoped dataset snapshot;
- recordings as separate artifacts plus a manifest;
- the full inputs, expected values, outputs, observations, diagnostics, and
  recording references inside every retained trial.

History listing still reads every indexed complete run and recording metadata to
perform expiry cleanup. The 100-run limit bounds the number of unprotected runs,
not their byte size. IndexedDB and SQLite changes use compare-and-swap batches,
so independent built-in store instances cannot silently lose concurrent run or
library inserts. A compatibility backend without `applyBatch` still has only
instance/process-level serialization.

The desktop commands in
[`packages/app/src-tauri/src/evaluation_store.rs`](packages/app/src-tauri/src/evaluation_store.rs)
store opaque values in a generic SQLite table. Consequently, the desktop has
durable storage but not a domain-level transaction spanning a run, its trials,
its snapshot, and retained recordings.

### Confirmed failure modes and scaling risks

- A crash after recording or snapshot persistence but before terminal run
  persistence can leave orphan evidence and no completed history entry.
- A final run persistence failure leaves the UI with a completed in-memory run
  whose terminal state and any finalization warnings are not durable.
- A custom backend that omits atomic batches can still lose a cross-client
  update; built-in stores reject or retry conflicts.
- Run append/delete/rename no longer rewrites unrelated run bodies, and snapshot
  creation no longer rewrites unrelated snapshots. Listing and each trial
  checkpoint still deserialize/rewrite the selected run's complete trial body.
- History cost grows with retained evidence rather than with the requested page
  of lightweight run summaries.
- Count-only retention cannot stop one unusually large output from exhausting a
  browser quota or making a project history blob impractical to parse.
- Safe garbage collection is difficult because references and retention leases
  are not committed with the records that own them.

The built-in recording ordering prevents the common dangling-reference case,
so that should not be used as the justification for this work. Atomic lifecycle
state, orphan prevention/recovery, cross-instance consistency, and bounded query
cost are the actual reasons.

### Comprehensive remediation plan

#### 1. Define an additive `EvaluationRepositoryV2` contract

Keep the current `EvaluationRun` and transfer formats as public reporting/export
shapes, but stop using that aggregate as the persistence API. The V2 repository
must provide domain operations with explicit guarantees:

- revisioned CRUD for suites, datasets, and baselines;
- `beginRun`, which atomically creates the run header, immutable provenance,
  requested trial plan, and dataset-snapshot reference/lease;
- idempotent `upsertTrial`, keyed by `(runId, caseId, trialIndex)`, which commits
  one settled trial and its recording references;
- `finalizeRun`, which atomically records terminal execution/quality/accounting
  state, aggregates, warnings, and final retention decisions;
- `markRunInterrupted` and `deleteRun`, including reference-safe artifact cleanup;
- atomic baseline promotion and demotion;
- paginated/indexed run-summary queries and separate loading of trial summaries,
  trial details, snapshots, and recordings;
- compare-and-swap revisions for mutable resources, with a typed conflict result;
- an explicit transaction/capability version so the application never assumes
  guarantees that a host adapter does not provide.

Writes must be idempotent. Retrying a trial or finalization operation after an
unknown transport result must produce the same stored state, not a duplicate.

#### 2. Normalize the built-in schemas

Use the same conceptual records in browser and desktop stores:

- `evaluation_resources` for suites, datasets, and baseline definitions;
- `evaluation_runs` for headers, provenance, status, summary aggregates, and
  timestamps;
- `evaluation_trials` for one trial per stable compound key;
- `evaluation_dataset_snapshots`, addressed by immutable fingerprint;
- `evaluation_recordings`, with expiry/retention metadata and reference counts;
- indexes for project, suite, start time, status, expiry, and baseline references.

For the browser, implement these as IndexedDB object stores and perform lifecycle
changes in IndexedDB transactions. Do not silently promise full durability when
only the local-storage fallback is available: either run that fallback through a
clearly documented compatibility adapter or surface that durable evaluation
history is unavailable.

For the desktop, use real SQLite tables, indexes, foreign keys, and transactions
instead of opaque aggregate JSON values. JSON columns may still hold graph values
and diagnostics; normalization is required at lifecycle and query boundaries,
not inside arbitrary user graph data.

#### 3. Add bounded, reference-safe retention

Retention policy must combine:

- age limits for temporary recordings and interrupted runs;
- count limits for ordinary run history;
- byte budgets per project and globally;
- protection for explicitly retained/baseline evidence;
- reference counts or leases for shared snapshots and recordings.

Garbage collection may remove only artifacts that have no live run/baseline
reference and no active lease. Run deletion and baseline changes should update
references in the same transaction. A periodic orphan scan should repair only
records proven unreachable; it must not infer reachability from an incomplete
in-memory run.

#### 4. Migrate without risking existing evaluation history

Implement a one-way, restartable migration:

1. detect the V1 aggregate keys and an absent V2 completion marker;
2. read and normalize V1 data without modifying it;
3. import resources, runs, trials, snapshots, and recording metadata into V2 in
   a transaction (or transactional batches with a migration journal);
4. validate counts, IDs, references, and snapshot fingerprints;
5. commit the V2 completion marker only after validation succeeds;
6. prefer V2 reads after the marker, while retaining V1 data for a documented
   rollback window;
7. delete V1 data only in a later schema cleanup, never as part of first startup.

Migration tests must include old browser data, old desktop data, interrupted
migration, duplicate restart, malformed optional fields, missing optional
recordings, retained baselines, and quota/disk failures.

#### 5. Preserve hosted-wrapper compatibility explicitly

Introduce V2 as an additive capability rather than changing the semantics of the
existing interface invisibly. Hosted wrappers may temporarily use a V1
compatibility adapter, but the app must expose its reduced guarantees and must
not enable checkpoint/resume or claim atomic finalization through it. Publish a
host contract guide and conformance suite before deprecating V1.

### Verification and acceptance criteria

- Browser and desktop repository contract tests pass against the same scenarios.
- Two independent store instances cannot lose concurrent resource or run writes;
  one update succeeds and the other commits independently or receives a typed
  revision conflict.
- Killing the process after every finalization step yields either a resumable/
  interrupted run or a fully finalized run, with no visible half-committed state.
- Retrying `upsertTrial` and `finalizeRun` is idempotent.
- Listing 50 summaries does not deserialize unrelated trial payloads or recording
  bodies and remains bounded as total retained history grows.
- Byte, age, and count retention preserve baselines and remove only unreferenced
  evidence.
- V1-to-V2 migration is restartable and leaves V1 data untouched on failure.
- Existing JSON/CSV transfer and CLI/reporting consumers still receive the same
  `EvaluationRun`/suite/dataset shapes.

---

## Problem 2: one execution lifecycle has multiple competing owners

### Verified current behavior

The shared service in
[`packages/app/src/utils/evaluationExecutionLifecycle.ts`](packages/app/src/utils/evaluationExecutionLifecycle.ts)
now owns dataset snapshots, runner invocation, ordered checkpoints, retention
finalization, name preservation, storage-warning aggregation, and terminal
history persistence for both
[`useLocalExecutor.ts`](packages/app/src/hooks/useLocalExecutor.ts) and
[`useRemoteExecutor.ts`](packages/app/src/hooks/useRemoteExecutor.ts). Focused
tests exercise ordering and non-fatal storage failures through this one path.

Runtime preparation, graph execution and recording production genuinely differ
and remain in their hooks. The local per-project abort-controller registry and
remote single-controller reference may reflect different runtime capabilities,
but those capabilities are not yet declared by an adapter contract or verified
by a shared concurrency contract.

Meanwhile,
[`Evaluations.tsx`](packages/app/src/components/evaluations/Evaluations.tsx) is a
roughly 5,000-line integration component that also owns resource mutations,
import/export, history loading and caching, selection reconciliation, naming,
deletion, recordings, baseline promotion, validation warnings, and presentation.
The source-based parity assertion in
[`useLocalExecutor.test.ts`](packages/app/src/hooks/useLocalExecutor.test.ts)
checks for a shared call name; it does not prove equivalent lifecycle behavior.

### Confirmed risks

- Snapshot, checkpoint, retention, naming and history-finalization fixes now
  have one owner. Cancellation registries, recording production, adapter
  diagnostics, and runtime setup can still drift between executor branches.
- Runtime capability differences are accidental control flow rather than explicit
  policy, so future maintainers cannot tell an intentional difference from drift.
- React hook/effect lifetime can influence domain behavior, especially during
  workspace switches, unmounts, and late progress/finalization callbacks.
- The large UI component couples rendering changes to cache, selection, and
  lifecycle behavior, making regressions difficult to isolate.
- A new runtime or hosted integration is encouraged to copy orchestration instead
  of implementing a narrow adapter.

### Comprehensive remediation plan

#### 1. Introduce one framework-independent execution controller

Create an `EvaluationExecutionController` application service with an explicit
state machine:

```text
idle -> preparing -> running -> finalizing -> persisting -> terminal
                          |          |             |
                          +-------- cancelling ----+
                          +-------- failed/interrupted
```

The controller—not React hooks—must own:

- run ID and immutable run-definition/provenance capture;
- suite/dataset resolution validation;
- abort-controller lifetime and the legal cancellation points;
- dataset snapshot acquisition and lease;
- invocation of `runEvaluationSuite`;
- progress/checkpoint sequencing;
- recording failure aggregation and retention finalization;
- terminal persistence and exactly-once terminal event publication;
- cleanup in success, validation failure, graph failure, cancellation, store
  failure, and controller disposal paths.

The controller should emit typed lifecycle events. Jotai updates, toasts, and UI
navigation should be presenters/subscribers; they must not be required for the
run to finalize correctly.

#### 2. Reduce runtimes to small declared adapters

Define an `EvaluationRuntimeAdapter` responsible only for runtime-specific work:

- prepare/validate a graph execution session;
- execute a target or evaluator graph;
- return recording material/metadata produced by the runtime;
- dispose the session;
- declare an explicit concurrency key and maximum active evaluations.

The controller should persist returned recording artifacts through the
repository, so local and remote paths cannot implement different retention or
failure semantics. If the remote runtime truly permits only one evaluation, its
adapter declares that limit; the shared controller registry enforces it without
hard-coding a separate lifecycle.

#### 3. Make run concurrency policy explicit

Registry entries should be keyed by the adapter's declared concurrency scope
(for example, project, remote session, or global runtime), not by whichever ref
shape a hook happens to use. Starting a conflicting run must return a typed
`already-running` result. Cancellation must target a stable run ID and must not
cancel an unrelated project/session.

#### 4. Split application models from presentation

After controller extraction, divide `Evaluations.tsx` along behavior boundaries:

- resource-library model: suite/dataset CRUD and transfer;
- definition model: editing, binding, and validation;
- run-history model: paginated summaries, selected run, sorting, naming,
  deletion, baseline and recording actions;
- view components that receive data and commands without calling stores or
  executors directly.

Keep workspace/session UI state in Jotai, but keep durable domain state in the
repository and active execution state in the controller registry. Preserve the
existing warm-cache behavior when switching workspaces.

#### 5. Migrate behavior before deleting old paths

1. Extract pure preparation/finalization helpers and characterize current local
   and remote behavior with table-driven tests.
2. Route the local adapter through the controller while keeping the public
   `TryRunEvaluation` hook API stable.
3. Run the same contract suite against the remote adapter, explicitly approving
   only documented capability differences.
4. Route remote execution through the controller.
5. Move lifecycle side effects out of `Evaluations.tsx` into models/subscribers.
6. Delete duplicated orchestration and source-text parity tests only after both
   adapters pass the behavioral contract.

### Verification and acceptance criteria

- The same controller contract suite covers local and remote success, validation
  failure, target failure, evaluator failure, required/optional recording
  failure, cancellation in every state, retention failure, history failure, and
  cleanup.
- Each terminal path persists/emits at most one terminal result and notification.
- Workspace changes and component unmounts do not cancel, duplicate, or prevent
  persistence unless the user explicitly cancels the run.
- Runtime concurrency differences are declared adapter capabilities and have
  dedicated tests.
- Executor hooks contain adapter setup and presentation wiring, not copies of the
  evaluation lifecycle.
- `Evaluations.tsx` no longer owns repository or executor orchestration and is
  split into independently testable feature models/views.
- Browser, desktop-local, remote, and hosted-adapter smoke tests produce the same
  run status, scoring, warnings, retention, and cancellation semantics for the
  same fixture.

---

## Problem 3: progress is an ever-growing full snapshot and is not recoverable

### Verified current behavior

In [`packages/evaluations/src/runner.ts`](packages/evaluations/src/runner.ts),
the primary protocol now publishes an awaited empty `run-started` shell, one
detached `trial-settled` payload per completion, and one complete
`run-finalized` reporting model. The app applies these events with structural
sharing and serializes durable checkpoint writes. The complete-run clone path
remains only behind deprecated `onUpdate`, so new integrations do not pay the
quadratic live-transport cost.

The current checkpoints are useful crash evidence but not a complete recovery
protocol. They rewrite the growing selected run record, do not carry an owner
lease/heartbeat, and do not contain a separately queryable immutable execution
plan. No startup process can safely decide that a running record belongs to a
dead controller rather than another live browser window.

### Confirmed risks

- Legacy `onUpdate` consumers still incur full-snapshot copy cost, by explicit
  compatibility choice.
- Durable checkpoint bytes still grow with all settled trial details because
  trials are embedded in the run record rather than separate records.
- The app rejects stale revisions, but a future transport that delivers events
  out of order still needs repository-level idempotent trial keys.
- A long, expensive evaluation preserves checkpointed evidence but has no safe
  interrupted classification or way to continue only its unfinished trials.

### Comprehensive remediation plan

#### 1. Add an incremental engine event protocol

Add a discriminated event stream alongside the existing callback:

- `runStarted`: run header, provenance, requested trial keys, and total count;
- `trialSettled`: monotonic revision plus one immutable settled trial;
- `runFinalized`: terminal status, aggregate summaries, warnings, and accounting.

The app should consume events. Keep `onUpdate` for one compatibility cycle by
deriving full snapshots in an opt-in compatibility adapter; do not make the
engine build those snapshots when no legacy consumer requested them.

Use a stable trial key `(runId, caseId, trialIndex)` and a monotonic sequence so
out-of-order asynchronous delivery can be rejected deterministically.

#### 2. Make aggregation incremental

Maintain per-case and run-level accumulators as trials settle instead of
filtering/reducing all accumulated trials for every progress update. Terminal
finalization should verify/recompute aggregates once as a correctness guard.

The in-memory UI model should keep trial summaries in a keyed map/order index and
apply structural sharing for one changed trial. Heavy trial details remain lazy,
as they are today in the Runs view, and should be fetched/materialized only when
expanded.

#### 3. Separate durability from render frequency

Persist every settled trial idempotently through `EvaluationRepositoryV2` (or a
small transactional batch when several trials finish together). UI summary
events may be coalesced to one animation frame or a short bounded interval, but
the final event must flush immediately. UI throttling must never be the durability
mechanism.

Backpressure rules should cap queued UI events and preserve the latest summary,
while repository writes remain ordered per run. Store failures should move the
controller into a visible degraded/failed persistence state rather than silently
dropping checkpoints.

#### 4. Persist and expose interrupted runs

At `runStarted`, persist an immutable execution plan containing:

- project, suite, dataset snapshot, target/evaluator graph provenance and engine
  version/fingerprint;
- ordered case/trial keys and derived seeds;
- execution settings that affect results.

On startup, any nonterminal run without a live controller becomes `interrupted`
rather than disappearing. Its settled trials remain inspectable. Offer explicit
resume only when the current project/runtime and all result-affecting fingerprints
are compatible. Otherwise keep the interrupted run as historical evidence and
require a new run.

Resume must skip already settled trial keys and use idempotent writes, providing
at-least-once execution with exactly-once stored trial identity. It should never
silently mix trials produced by incompatible graph, suite, dataset, seed, or
engine definitions.

#### 5. Preserve the aggregate output contract

At finalization, materialize the complete `EvaluationRun` shape for existing
reporters, transfer/export, comparisons, and CLI consumers. The complete shape
remains a read/reporting model; it is no longer the live transport or primary
storage unit.

### Verification and acceptance criteria

- Settling one trial publishes an event whose size is proportional to that trial,
  not to all prior trials.
- A 1,000-trial payload-heavy benchmark shows no full-run clone/reduction per
  trial and no quadratic increase in progress work.
- Concurrent completions retain deterministic ordering/identity and cannot
  regress the displayed revision.
- UI throttling reduces render bursts without delaying checkpoint persistence or
  the terminal flush.
- Process termination after any settled trial produces an inspectable
  `interrupted` run with all committed trials.
- Resume skips settled keys, refuses incompatible provenance, preserves seeds,
  and produces the same final aggregation as an uninterrupted run.
- Cancellation creates a durable terminal/cancelled record according to policy;
  a crash creates an interrupted record, not a misleading cancellation.
- Legacy `onUpdate` consumers and complete-run reporters remain covered during
  the compatibility period.

---

## Delivery sequence

The **risk priority** is persistence first, followed by lifecycle ownership and
progress transport. The safest **implementation sequence** is slightly different
because the persistence migration should have one caller, not two duplicated
executor paths:

### Milestone 0: characterize and freeze behavior

- **In progress:** repository, runner-event, and shared lifecycle fixtures cover
  the implemented V2/CAS/checkpoint increment.
- Capture migration fixtures from current browser and desktop stores.
- Add performance baselines for run append/list and 100/1,000-trial progress.
- Document intentional runtime capability differences before refactoring them.

### Milestone 1: centralize lifecycle without changing persistence

- **Partially delivered:** both local and remote hooks route through the shared
  lifecycle service and preserve current UI commands and terminal reporting.
- Extract the abort/concurrency registry and recording producer behind declared
  runtime-adapter capabilities.
- Remove the remaining duplicated runtime policy only after adapter contract
  tests pass.

### Milestone 2: introduce transactional V2 persistence

- **Foundation delivered:** per-record V2 run/snapshot/recording layout,
  restartable aggregate imports, and atomic compare-and-swap batches in
  IndexedDB and SQLite.
- Add the normalized V2 domain repository with separate run summaries/trials.
- Add hosted capability negotiation and conformance tests.
- Add byte/age/count retention and reference-safe cleanup.

### Milestone 3: switch progress to deltas and checkpoints

- **Delivered:** delta runner events, structural UI trial updates, and ordered
  durable start/trial/final checkpoints through the additive store capability.
- Add incremental aggregate accumulators and bounded UI-event coalescing.
- Add interrupted-run inspection and guarded explicit resume.

### Milestone 4: simplify the UI and retire compatibility paths

- Extract resource, definition, and history models from `Evaluations.tsx`.
- Remove V1 orchestration, full-snapshot app transport, and source-text parity
  assertions after their deprecation period.
- Retain V1 data until the rollback window and migration telemetry/tests show the
  V2 path is stable.

## Completion definition

This plan is complete only when:

- a run and its evidence have a transactional, queryable, bounded lifecycle in
  browser, desktop, and conforming hosted stores;
- local and remote execution use one state machine with explicitly declared
  runtime capabilities;
- progress cost is linear in newly completed work and every settled trial can be
  recovered after interruption;
- existing suite/dataset transfer, run export/reporting, comparison, baseline,
  recording replay, naming, sorting, and warm workspace navigation behavior
  remain compatible;
- developer and host-integration documentation describe the new guarantees,
  migration, retention, and downgrade behavior before the old contracts are
  removed.
