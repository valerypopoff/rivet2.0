# Execution and Evaluation ownership refactor

This refactor changes ownership, not execution semantics or transport policy.
Browser repaint yields, local recording playback, supported frozen outputs,
external debugger observation, hosted recording ownership and Evaluation-owned
persistence remain intentional differences. No second socket owner, Evaluation
engine, generic repository, or cross-run compiled-plan cache is introduced.

## Ownership matrix

| Scope | Owner | Lifetime and obligations |
| --- | --- | --- |
| Authored tab | Existing workspace/project state | Unsaved graph, static data, settings and inputs are captured before asynchronous preparation; later tab selection cannot change the prepared run. |
| Editor invocation | `preparedEditorRun` and `EditorRunSession` | One detached authored snapshot; providers, callbacks, signals and native handles retain identity. Session owns cancellation, accepted processor/request, recording finalization and exactly its own cleanup. |
| Executor connection | Project-scoped `executorSession` runtimes in `ExecutorSessionRegistry` | Socket/sidecar, target generation, capabilities and pending requests. Each run uses its originating runtime; it must not cancel or upload through a replacement connection. |
| Browser runs | Existing project-to-processor registry | Independent open projects may run concurrently; terminal cleanup removes only the matching processor/session. |
| Evaluation library | Library commands and existing `EvaluationStore` | Suites, datasets and compact baselines are shared resources. Accepted mutations can finish after navigation; stale UI selection must not follow them. |
| Evaluation history | Run commands and scoped history hook | Project/suite/generation-bound reads; compact pages and selected details share invalidation. Accepted durable writes are not canceled by panel disposal. |
| Root execution | `GraphSharedExecutionState` | Globals/cache and controllers shared across children. New root target resolution gets a fresh scope; deliberate globals/cache reuse is retained. |
| Invocation bookkeeping | `GraphInvocationState` | Results, queue, cost, abort/user-input state and child tracking. Explicit initialization mutates the existing owner rather than rebinding late child events to a different object. |
| Streaming boundary | `GraphSchedulerBoundaryState` | Topology, stream subscriptions/relays, Catch tasks and failures; separate setup phases and independently tested exhaustive cleanup. |
| Async branch | Existing `ManagedAsyncBranches` | Root task admission, cancellation, cost and drain. Scheduling and event ordering remain in `GraphProcessor`. |

Outputs-ready and abort-requested are milestones, not terminal completion.
Background branches, diagnostics and recorders remain owned until completion or
transport loss. Cancellation during preparation is delivered if execution binds
later. Cleanup is single-flight and attempts every registered action.

Editor runs and remote Evaluation trials use the same ready-connection binding.
The binding captures socket identity, target kind and URL, not just the executor
address. Recheck it after asynchronous preparation, before upload/recorder
registration and before dispatch; cancellation cannot address a replacement
socket. Reconnecting the same URL requires a newly prepared run. Hosted durable
Evaluations keep their existing coordinator-owned lifecycle rather than using
this WebSocket fence.
Each WebSocket Evaluation prepares its upload key once and rechecks the shared
upload slot immediately before every trial dispatch. Restore the captured
definition synchronously if another request replaced it; do not serialize the
whole project again for every trial. Partial upload failure invalidates the old
slot key, since the executor may already have accepted replacement dynamic data.
The upload slot cache is weakly keyed by the actual socket. Project-scoped
executor runtimes can share a URL but must never share upload state. Tab switching
can reuse its original socket's cache; reconnecting gets a cold cache without
requiring a mounted lifecycle subscriber or retaining dead connections.

## Core inheritance and reset rules

| State group | Ordinary / cross-project child | Continuation | Watch / asynchronous child | Next root invocation |
| --- | --- | --- | --- | --- |
| Globals, execution cache, stored-value and knowledge controllers | Share root owner | Share root owner | Share root owner | Retain deliberate globals/cache semantics; recreate controllers |
| Resolved cross-project target cache | Share current root | Share current root | Share current root | Fresh; old children retain old scope |
| Results, queue, abort/user-input state, cost and child tracking | New invocation bookkeeping | New bookkeeping with explicit aliases below | New bookkeeping | Reinitialize in place |
| Graph outputs, attached node data and input-node values | Invocation-local | Same-graph continuation may explicitly share these three aliases | Invocation-local unless the existing continuation contract supplies aliases | Reset to empty unless an explicit override applies |
| Context, identities, inputs and recording scope | Rebound to child/project | Explicit same-graph identity/owner overrides | Explicit boundary identity and parent cancellation | Rebound during graph initialization |
| Definition/plan cache and processor configuration | Existing policy inherited | Existing policy inherited | Existing policy inherited | Existing reuse policy; no new cross-project compiled-plan reuse |
| Boundary plans, stream routes, subscription disposers and pending tasks | Invocation-local | Invocation-local | Invocation-local; existing root async task controller is shared | Reset at their established topology/input-stream phases |

Configuration, authored graph, registry, runtime-cache policy, executor,
external functions, context values and frozen-output resolver remain processor
configuration. Scheduling topology, continuation ownership, event forwarding and
`GraphRunLifecycle` remain with their existing focused owners. Do not replace
all processor state indiscriminately: seeded plans and continuation overrides
exist before run initialization, and late child completion contributes cost.

## Command guarantees

- Library commands evaluate current identities/dependencies and running-suite
  constraints when a confirmation is accepted. They cannot recreate a deleted
  dataset or remove a field from a newly running dependent suite.
- File import uses the public JSON/CSV serializers. Replacing a dataset compares
  the captured destination against current state before applying it.
- Run commands retain the originating project. Failure leaves selection/history
  unchanged; multi-step recording retention reports partial completion rather
  than speculative rollback. Baseline promotion cannot recreate a deleted suite.
- History requests include project/suite scope and a request generation. Initial
  pages, older pages, selected details and errors all reject superseded results.
  Every committed run mutation fences outstanding reads, not only deletion.
  Invalidation releases obsolete page admission and restarts still-needed reads
  without discarding warm history or admitting another project's live snapshot.
  Commands that finish after disposal invalidate only the matching warm cache;
  returning to that scope reloads committed data without stale selection writes.
  Same-run rename requests are ordered and bounded across command instances.
- Delayed recording hydration rechecks scope and artifact identity before loading
  playback into the editor.

## Verification checklist

Run owning TypeScript builds and lint plus the repository test-style/doc gates.
The relevant behavioral coverage is:

- App preparation, cancellation/readiness, session reentrancy/all-cleanups,
  library and durable run command tests under `packages/app/src`.
  Include registration/send exceptions and overlapping/failed rename writes.
  Connection tests also delay Evaluation preparation across a same-URL reconnect
  and verify that neither run nor abort frames reach the replacement connection.
- Core public processor model tests: repeated use, overlap rejection, both
  scheduler modes, partial outputs, cross-project targets, continuations,
  streaming Watch/Catch, async branches, pause/abort, costs and terminal events.
- State-owner tests exercise aliases/reset and stream cleanup failures directly.
- Real Node sidecar bundle/output-selection integration under
  `packages/app-executor/bin`, plus Node debugger, processor attachments, bundle,
  repeated-call and runtime-equivalence tests.
- Headless repository Playwright checks for desktop bundle IO and execution,
  Evaluation history pagination/races and definition/dataset/run presentation.
  Self-contained history tests mock bootstrap; dashboard-only tests require the
  running API. Inspect `artifacts/playwright` on failure.

Real Node child-process integration is not a test of a packaged Windows native
sidecar or installer. That release-level check still requires the built desktop
artifact. These local checks do not measure production VM latency.

For a UI-only preview without an API stack, run the self-contained
`desktop-project-bundle.spec.ts` and `evaluation-history-paging.spec.ts` scenarios
through `studio-server:ui:observe`. Dataset bulk-toggle and provider-metrics
scenarios need the dashboard/API stack (and Node metrics need its executor);
starting only Vite is not sufficient for those checks. Keep generated test logs,
traces and benchmark reports under ignored `artifacts/`, not in the commit.

## Protected execution comparison

Run `yarn exec node scripts/bench/execution-ownership.mjs` before committing.
It bundles the committed `HEAD` processor as a baseline and the working processor
as the candidate, without replacing workspace source. Both run the identical
100-node text chain, eight nested subgraphs and twelve-call fan-in fixtures under
both scheduler modes. It asserts identical outputs and ordered event names/node
and graph identities, and records median/P95 execution time and retained heap
after forced GC for 60 measured runs following ten warmups.

It also compares the previous shallow editor preparation with detached authored
capture for 100/1,000-node fixtures. Capture intentionally adds one project-sized
copy: locally approximately 0.18/1.77 ms median and about 0.5 MB retained for the
1,000-node snapshot, compared with approximately 0.006/0.043 ms for the shallow
baseline. This is a correctness tradeoff, not a preparation-speed improvement;
large static payloads can increase it. Avoid additional project-sized copies.

The generated report is `artifacts/bench/execution-ownership/report.json` and
includes the baseline commit, Node version and raw timing samples. On the local
Windows Node 22 comparison, the first isolated Core pass had medians of roughly
1.7–3.1 ms. Later passes during other test activity varied materially; neither
small differences nor noisy apparent speedups prove a production speedup or a
leak. Repeat on an idle host when investigating a regression. Heap
deltas can be negative due to GC and are not peak-memory measurements. This
benchmark protects Core overhead; it does not replace Browser preparation,
concurrent Evaluation, streaming teardown or packaged desktop checks.
