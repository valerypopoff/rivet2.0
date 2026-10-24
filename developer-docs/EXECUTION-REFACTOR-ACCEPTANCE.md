# Execution and Evaluation ownership refactor

This guide describes the existing execution/Evaluation ownership work. For the
2026-10-24 pre-refactor contract covering current bundle editor routing, Remote
Debugger and playback, use the
[functional baseline](./EXECUTION-ROUTING-BEHAVIOR-BASELINE.md). The implemented
coordination refactor is documented in [Execution coordination](./EXECUTION-COORDINATION.md),
including the canonical store, shared lifetime policy and local evidence limits.

This refactor changes ownership, not execution semantics or transport policy.
Browser repaint yields, local recording playback, supported frozen outputs,
external debugger observation, hosted recording ownership and Evaluation-owned
persistence remain intentional differences. No second socket owner, Evaluation
engine, generic repository, or cross-run compiled-plan cache is introduced.

## Ownership matrix

| Scope                  | Owner                                                                  | Lifetime and obligations                                                                                                                                                                                     |
| ---------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Authored tab           | Existing workspace/project state                                       | Unsaved graph, static data, settings and inputs are captured before asynchronous preparation; later tab selection cannot change the prepared run.                                                            |
| Editor invocation      | `preparedEditorRun` and `EditorRunSession`                             | One detached authored snapshot; providers, callbacks, signals and native handles retain identity. Session owns cancellation, accepted processor/request, recording finalization and exactly its own cleanup. |
| Executor connection    | Project-scoped `executorSession` runtimes in `ExecutorSessionRegistry` | Socket/sidecar, target generation, capabilities and pending requests. Each run uses its originating runtime; it must not cancel or upload through a replacement connection.                                  |
| Browser runs           | Existing project-to-processor registry                                 | Independent open projects may run concurrently; terminal cleanup removes only the matching processor/session.                                                                                                |
| Evaluation library     | Library commands and existing `EvaluationStore`                        | Suites, datasets and compact baselines are shared resources. Accepted mutations can finish after navigation; stale UI selection must not follow them.                                                        |
| Evaluation history     | Run commands and scoped history hook                                   | Project/suite/generation-bound reads; compact pages and selected details share invalidation. Accepted durable writes are not canceled by panel disposal.                                                     |
| Root execution         | `GraphSharedExecutionState`                                            | Globals/cache and controllers shared across children. New root target resolution gets a fresh scope; deliberate globals/cache reuse is retained.                                                             |
| Invocation bookkeeping | `GraphInvocationState`                                                 | Results, queue, cost, abort/user-input state and child tracking. Explicit initialization mutates the existing owner rather than rebinding late child events to a different object.                           |
| Streaming boundary     | `GraphSchedulerBoundaryState`                                          | Topology, stream subscriptions/relays, Catch tasks and failures; separate setup phases and independently tested exhaustive cleanup.                                                                          |
| Async branch           | Existing `ManagedAsyncBranches`                                        | Root task admission, cancellation, cost and drain. Scheduling and event ordering remain in `GraphProcessor`.                                                                                                 |

The follow-up maintainability slices use the same owners:

| Concern                     | Shared implementation                                                  | Policy deliberately retained outside it                                                            |
| --------------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Chat provider metadata      | Closed `chatV2ProviderDescriptors`                                     | Credential resolution, SDK/protocol, dynamic catalog and pricing                                   |
| Editor display updates      | `nodeExecutionData`, `executionDataTransitions`, graph-history helpers | Tab selection, replay, Evaluation/partial reruns, allocation/deletion and payload-retention policy |
| Tab display selection | Canonical `projectExecutionStore` and writable field lenses | Authored workspace persistence and activation ownership |
| Core child mechanics        | Typed child construction and existing bridge adapters                  | Each invocation's identity, aliases, output commits, cost and cleanup lifetime                     |
| Watch/async topology        | Lazy definition-only `SchedulerBoundaryPlanner`                        | Runtime installation, subscriptions, scheduling and root drain                                     |

### Display event policy matrix

| Event concern                     | Shared rule                                                                                                               | Intentional adapter policy                                                               |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Node start/finish/error/exclusion | Sanitization, timing, merge, split-page patches and terminal protection                                                   | Active debug-source capture and preloaded-node suppression                               |
| Streaming partial                 | Terminal rejection before allocation; same stored-output merge                                                            | Active graph-view follow-latest; inactive existing selection rules                       |
| LLM round history                 | Invocation creation, page upsert/redelivery and obsolete-ref calculation                                                  | Allocation scope and committing to atoms versus snapshots                                |
| Trace / Run Activity              | Existing invocation trace and activity projections                                                                        | Dispatcher routes and called-project journal-only observation                            |
| Graph start/terminal              | History insertion/completion and matching running-entry removal                                                           | Active root IDs for successful-done reconciliation and current-view selection            |
| Root start                        | Clear old prompts/recording and establish running root                                                                    | Active partial-rerun preservation, Evaluation accumulation and retention; inactive reset |
| Done / abort / disconnect         | Existing terminal reconciliation and interrupt helpers                                                                    | Active diagnostics, notification and connection lifetime; inactive display projection    |
| User input                        | Replay remains observational; terminal clears only its invocation's prompt                                                | Existing modal/presentation and called-project prompt routing                            |
| Clear / eviction                  | Release only obsolete refs after replacement state is computed; same configured payload limit and round-selection cleanup | Allocation scope and atom versus snapshot commit                                         |

The child inheritance/reset matrix below is the child-policy baseline. Provider
metadata versus protocol/credentials/settings/health owners are documented in
`LLM-CHAT-V2-CONTRACT.md`; those owners are not merged by this refactor. Native
provider options and inline/profile compatibility remain covered by their
existing intercepted-provider and node contract tests, not paid requests.

The local baseline uses Windows Node 22.22.3 and pinned Yarn 4.17.1. Use the same
runtime, fixtures and idle-host conditions for repeats. There is no statistically
established performance budget yet: report raw samples rather than inventing a
percentage threshold or interpreting a single noisy timing pass as a regression.

No new public API, serialized project field, storage format, session owner or
compiled-plan cache is introduced. New planner/binding tests are discovered by
the existing Core/App test runners; no source-text coverage substitutes for
behavioral tests. Run the existing protected comparison against the recorded
starting HEAD, plus the self-contained bundle/Evaluation browser checks. A
native packaged Windows check and live paid-provider calls remain separate
release/operational evidence, not claims implied by these tests.

The metadata/display/child-mechanics baseline is commit
`6c21b9539264ea76a9d0d27f117af2648deb9275`. Preserve raw verification and timing
samples in ignored artifacts and repeat the same workload if a future change
moves these ownership boundaries. Current acceptance evidence and limitations
are summarized below rather than maintained as a chronological audit log.

Streaming-marker browser fixtures must explicitly enable
`useAsGraphPartialOutput` on LLM Chat; its current default is off. Named Subgraph
output markers describe a stream-capable producer, not merely a valid output
wire. Keep this assertion rather than weakening it for non-streaming fixtures.

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

| State group                                                             | Ordinary / cross-project child | Continuation                                                     | Watch / asynchronous child                                                  | Next root invocation                                            |
| ----------------------------------------------------------------------- | ------------------------------ | ---------------------------------------------------------------- | --------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Globals, execution cache, stored-value and knowledge controllers        | Share root owner               | Share root owner                                                 | Share root owner                                                            | Retain deliberate globals/cache semantics; recreate controllers |
| Resolved cross-project target cache                                     | Share current root             | Share current root                                               | Share current root                                                          | Fresh; old children retain old scope                            |
| Results, queue, abort/user-input state, cost and child tracking         | New invocation bookkeeping     | New bookkeeping with explicit aliases below                      | New bookkeeping                                                             | Reinitialize in place                                           |
| Graph outputs, attached node data and input-node values                 | Invocation-local               | Same-graph continuation may explicitly share these three aliases | Invocation-local unless the existing continuation contract supplies aliases | Reset to empty unless an explicit override applies              |
| Context, identities, inputs and recording scope                         | Rebound to child/project       | Explicit same-graph identity/owner overrides                     | Explicit boundary identity and parent cancellation                          | Rebound during graph initialization                             |
| Definition/plan cache and processor configuration                       | Existing policy inherited      | Existing policy inherited                                        | Existing policy inherited                                                   | Existing reuse policy; no new cross-project compiled-plan reuse |
| Boundary plans, stream routes, subscription disposers and pending tasks | Invocation-local               | Invocation-local                                                 | Invocation-local; existing root async task controller is shared             | Reset at their established topology/input-stream phases         |

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

The self-contained browser harnesses still require the Studio Server web Vite
configuration (which provides `/shims/install-process-shim.ts`), not the
standalone App preview. Start
`yarn workspace @valerypopoff/rivet-studio-server-web run dev --host 127.0.0.1 --port 5174 --strictPort`
and point `PLAYWRIGHT_BASE_URL` at that address. A missing shim is a preview
configuration error, not evidence of a bundle execution failure.

Development Node child-process integration is not a packaged-sidecar check.
On Windows, rebuild with `yarn workspace @valerypopoff/rivet-app-executor run build`,
set `RIVET_TEST_PACKAGED_EXECUTOR` to the absolute path of
`packages/app-executor/dist/app-executor-x86_64-pc-windows-msvc.exe`, and run
`bin/executor.projectBundle.test.mts` through that workspace's `tsx --test` runner.
This exercises the actual Tauri sidecar binary over WebSocket, including nested
manifest lookup, unsaved entry edits, members and datasets. It does not prove the
installer or native WebView shell; those remain release-artifact checks. These
local checks do not measure production VM latency.

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
Generated root, graph-run and process IDs are normalized by first observation;
their equality relationships, parentage, executor identity and project scope
remain part of the exact ordered-event comparison.

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
deltas can be negative due to GC and are not peak-memory measurements. The report
also records OS process peak resident bytes (`resourceUsage().maxRSS`) separately
for baseline and candidate child processes. This is a whole-workload high-water,
not per-fixture attribution or a leak test. This
benchmark protects Core overhead; it does not replace Browser preparation,
concurrent Evaluation, streaming teardown or packaged desktop checks.

The workload now also compares committed and working inactive display event
processing for 20/100 invocations, five streamed chunks per invocation, retained
LLM history and terminal outputs. It asserts identical stored history and ref
counts, performs an identity-preserving tab capture/restore, and clears every
invocation to verify zero remaining refs. Baseline editor event sources are
loaded from `HEAD`, not silently shared with the candidate. These samples
measure state processing and tab bindings, not React/browser repaint latency.
The protected display sequence now includes model-call, profile-attempt and
tool-call diagnostics for each invocation. The baseline loads the committed
`agentTraceEventStorage.ts` as well as its committed callers; a changed helper
must not be shared silently with historical code. Keep the baseline source list
as the single declaration for that bundle override, rather than duplicating it
in a filename-matching expression. Comparisons from older reports without these
diagnostic events are a different workload and cannot establish a timing trend.

The `text` scenario in `watch-streaming-output.spec.ts` additionally measures
local transport/SDK/React latency for its two existing chunks to preview
DOM update followed by two animation frames. Its JSON attachment records raw
samples. This verifies repaint opportunities during actual streaming, not pixel
presentation/compositor timing or a before/after browser performance claim.
No arbitrary timing threshold is used as a functional assertion.

## Acceptance evidence and intentional fixes (2026-10-11)

The following defects were fixed rather than preserved as adapter policy:

- Called-project terminal events accept older inactive snapshots without
  `userInputQuestions` or round-selection state, without mutating caller nodes.
- Inactive, bundle and active display use the same configured payload-retention
  limit. Late history/terminal events cannot restore evicted payloads; status,
  timing and diagnostics remain observable. History-first and diagnostic-first
  invocations delegate creation/retention to `updateNodeRunData`, then adapters
  release obsolete references and round selections after committing replacement
  state. Updating an evicted invocation prunes only that invocation.
- Explicit Watch/continuation/async cleanup and ordinary Subgraph automatic
  cleanup preserve primary execution failures. Every disposer is attempted,
  tracking is released and cleanup is idempotent/reentrant. Secondary failures
  emit safe metadata only; a throwing host logger cannot mask the primary error.
  Successful terminals still expose cleanup failures. Watch setup failures also
  finalize their history.
- The benchmark loads historical diagnostic helpers with their historical
  callers. Its single source list prevents accidentally testing today's helper
  as part of the committed baseline.

Regression coverage includes lazy boundary validation and connection ordering,
partial child wiring rollback, actual queued emitter delivery, both schedulers'
child/caller error identity, and active/inactive equivalence with separate ref
stores. Diagnostic-first cases cover model, profile and tool evidence,
identified redelivery, anonymous tools, distinct tool source IDs, retention
disabled/zero/one previous invocation, late events and complete clearing. Native
Inline/Profile request equivalence covers all five providers and both Custom
API contracts, including successful usage/results and authentication failures.

Full-suite verification earlier in this change set covered 2,063 unique Core
tests (bounded Windows batches including a final logger regression). Subsequent
focused checks covered 334 Core, 125 App and 68 Node tests; the last diagnostic
hardening additionally reran 257 adjacent Core tests and a final 49-test App
subset. Core build, App type checks, relevant lint, formatting and
architecture/documentation gates passed. Two temporary-workspace CJS tests
needed filesystem access outside the sandbox and passed unchanged on rerun.
Focused counts are not a claim of another full-suite run.

Two development executor checks and the freshly rebuilt packaged Windows
sidecar's real WebSocket bundle test passed. All 12 focused headless bundle and
Watch browser scenarios passed, with the 11 streaming/history/replay scenarios
rerun after diagnostic hardening. Broader earlier browser coverage included
Evaluation history, tab shortcuts and credentials. One initial fullscreen-pager
timeout coincided with preview module invalidation during a concurrent build;
the isolated case and complete rerun passed without changing assertions. Keep
browser checks separate from builds that reload the preview.

The protected comparison matches outputs, ordered events/identity relationships,
stored display history and reference counts. Timing remains mixed by fixture:
exception-safe binding/cleanup adds bookkeeping, and detached authored capture
costs one copy as documented above. This is a maintainability/reliability
refactor, not a universal speed improvement. No new runtime cache, project-sized
copy or resource owner was added by these follow-up fixes. Raw local samples,
GC-sensitive retained heap and whole-process high-water do not establish
production performance, a statistical regression budget or a leak. Installer
and native WebView verification remain separate release obligations.
