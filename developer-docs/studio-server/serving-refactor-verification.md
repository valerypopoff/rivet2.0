# Serving refactor completion and verification

This is the implementation checklist for the refined SQLite isolation, immutable
execution-definition reuse and short-transaction/Evaluation projection plan.
Correctness tests are not evidence of a production VM speedup.

## Implemented boundaries

| Area                                | Implementation and proof                                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SQLite operation ownership          | Complete typed catalog commands run in one worker; SQL transactions and protected artifact checks remain inside the catalog. `catalog-worker.test.ts` exercises the real connection owner. PostgreSQL stays on its asynchronous driver.                                                                                                                                                                   |
| Drain and generation                | Queue and active RPCs are counted, including reads; parent leases cover whole writes and host callbacks. Selected generation paths are captured before lazy startup. Worker loss holds pending counts/leases until termination. `sqlite-workflow-backend.test.ts` and worker lifecycle tests cover these boundaries.                                                                                      |
| Cancellation and overload           | Signal views remove only undispatched jobs; dispatched transactions finish or fail with unknown outcome, never auto-replay. Canceling a drain wait does not cancel a write. Count admission is checked before serialization; byte admission is bounded. Expired readiness probes leave the queue.                                                                                                         |
| Execution reuse                     | Parsed source data is bounded by total/per-entry budgets, checked against its source revision and cloned per consumer. Concurrent managed loads share IO, not mutable projects, attached data, allowlists, diagnostics or dataset providers. Root and cross-project artifact identity checks remain authoritative.                                                                                        |
| Execution compatibility             | External revision IDs remain unchanged. SQL routes/access policies and invalidation checks are retained; processors, globals, outputs and compiled plans stay run-scoped. `parsed-execution-cache.test.ts`, managed execution tests and SQLite serving tests cover mutation isolation and races.                                                                                                          |
| Publication preparation             | Both project and dataset artifacts retain their integrity reads outside the writer transaction. The command owns a snapshot of reviewed preconditions. Under lock it rechecks identity, draft, publication version and route ownership; invalidation is commit-owned. Publication history tests exercise preparation/commit races and corrupt identities.                                                 |
| Hosted Evaluation progress          | Existing fenced trial-job rows are the only trial ledger. Running projections contain compact headers, not a growing duplicate trial list. Index-backed pending checks replace whole-run reconstruction; no duplicated counters require retry repair. Local/incremental runner behavior is unchanged.                                                                                                     |
| Evaluation consistency and recovery | Header and trials assemble in one SQL snapshot. Successful fenced transitions alone update projections. Manual retry clears stale terminal aggregates and advances revision under the same run lock. Terminal aggregation, recording retention and run status commit atomically; a failed transaction leaves no partial finalization. Leases distinguish interrupted work from durable user cancellation. |
| Compatibility writes                | Generic full snapshots remain supported but cannot overwrite active scheduler-owned projections or set the internal marker. Public read/rename/retry responses remove that marker. Real PostgreSQL integration covers queued ownership, retry, cancellation, expired leases and exact terminal results.                                                                                                   |

Replay artifact deduplication, a separate parsing worker pool and cross-run
compiled-plan reuse are intentionally excluded. They require additional
benchmarks and durable identity/reference protection, not an opportunistic change
inside this implementation.

## Measurement

Adjacent lifecycle/deletion regressions also cover normal-close drain through
termination acknowledgement, lazy unused shutdown, failed mode changes in both
adapters, startup write admission, and shutdown racing initialization. Managed
store and coordinator deletion use the same job/scheduler lock boundary; queued
or active jobs protect evidence even if the coordinator is disabled or the parent
status is inconsistent. Unit and real PostgreSQL checks cover these paths.
Termination-request failures are covered separately from failed catalog-close
RPCs. When the request fails, actual worker exit is required before clearing
pending counts or releasing parent leases; canceling a drain wait does not
override that proof. These are fail-closed lifecycle checks, not query-speed
optimizations.

Execution regressions additionally cover different routes sharing one failed
immutable revision read: all callers see the failure, no automatic replay occurs,
and a later request can recover without a poisoned in-flight/cache entry. Total
parsed-cache eviction is tested separately from per-entry admission, including
detached mutable state and unchanged public content revisions. Execution uses
the revision service's integrity-aware reads exclusively; there is no parallel
raw blob-reading implementation in the execution loader.

After building the API:

```text
yarn workspace @valerypopoff/rivet-studio-server-api serving-refactors:benchmark 40
```

The command creates only its own temporary catalog and generated project. It
accepts no deployment paths, endpoints or credentials. Its fixed workload has
400 text nodes and a 500-folder compact catalog. Baseline and optimized results
must match exactly before timing. It compares fresh parsing with warm, detached
parsed-definition reuse, and direct catalog reads with worker reads including RPC.
Worker startup is separate from warm operation timings.
Cold admission and oversized fresh materialization are measured separately;
oversized/default-parser results are not cloned into an unused retained copy.

Catalog indexing and parsed-definition reuse use Core's lightweight serialization
entry point. Pure indexing is separate from filesystem cache/settings owners, so
the SQL worker does not initialize execution providers or Settings repositories
just to inspect project metadata. `project-stats.ts` re-exports the same public
helpers and revision format; compatibility tests compare the lightweight parser
with the Node API, including attached data and datasets.

Report p50/p95/max, CPU, sampled process RSS and event-loop delay. RSS is not a
heap-allocation counter: phases share one process, and worker memory plus prior
phases are included. Source/TypeScript worker startup differs from compiled
deployment startup; the command uses the compiled API. Do not run it concurrently
with repository builds/tests when collecting comparison evidence.

Worker isolation is for responsiveness under blocking SQL, not a claim that every
query becomes faster. Small metadata requests can be slower because of RPC and
copying. The lock-contention heartbeat regression separately proves the API
thread remains responsive while a catalog write waits on SQLite.

Example component measurement on Windows, Node 22.22.3, compiled API, 40 samples
(2026-10-10): fresh materialization p95 29.8 ms; warm detached reuse 1.1 ms;
direct compact catalog p95 0.27 ms; worker including RPC 0.45 ms. Worker startup
was 1.2 s versus 5.7 s before removing broad runtime/settings imports. These are
one-checkout synthetic observations, not deployment SLOs or a guaranteed ratio.

Publication tests verify zero artifact IO under the writer lock. The real managed
Evaluation integration counts immutable scheduler-snapshot reads while a trial
is blocked: claim reads are allowed, progress/settlement reads are not. These are
work-reduction measurements, not estimates of PostgreSQL/S3 request latency.

The concurrent `serving-refactors:workload compare 100` and
`serving-refactors:managed-workload 100` commands share one logical correctness
workload: 12 projects, 300 nodes/project, three publications/project, 96 recordings
and 100 rounds with six simultaneous service operations. Local direct/worker
comparisons use separate processes; managed tests own fresh PostgreSQL/MinIO.
They measure adapter operations, not browser/network latency. Node-process RSS
excludes database/object-store container memory. Setup is excluded from operation
timings, startup and cold definition materialization are reported separately.

One Windows/Node 22.22.3 run (2026-10-10) observed direct/worker event-loop maximum
164/54 ms and Node RSS 609/820 MiB. Worker execution-definition p95 was 29 ms
versus 101 ms direct, but compact tree p95 was 29 ms versus 9 ms direct; save plus
publication was approximately 164/162 ms. This shows responsiveness improvements
and real RPC/memory costs, not uniform speedups. The managed workload completed
with equivalent correctness, tree p95 5 ms and save/publication p95 197 ms on
local disposable services. Raw reports are under `artifacts/refactor-hardening-*`;
rerun the same workload on release hardware before making capacity decisions.

Production p95/p99 latency, request throughput and resource high-water remain a
deployment measurement task on the identical protected workload. The component
benchmark does not replace it or justify changing VM resources.

## Managed rollout

Compact running Evaluation headers require schema-15 readers. Stop older managed
API readers and Evaluation workers before the representation cutover; do not use
an ordinary mixed-version rolling upgrade or widen rollback compatibility to
schema 14. The explicit `--maintenance-cutover` performs owned stopping, paused
startup validation and resume. It does not infer authority over external database
consumers or force-delete stalled pods. Failed/unknown outcomes retain paused
recovery ownership with an exact `--resume-cutover` token and manifest.
Lost completion acknowledgements restore a pending journal before closing
admission, so a paused release cannot masquerade as a completed cutover.
Ordinary rollout and recovery share journal validation. A completed phase with
a live runner lease still blocks another rollout. Renewal is settled before
failure cleanup reads ownership, and lease loss between controller mutations
stops further changes rather than reporting a falsely confirmed pause. The
behavior suite covers these races without wall-clock sleeps.
An operation that outlives the lease cannot silently renew it at the next phase;
explicit recovery is required before any later traffic-resume step.
Losing the initial ownership-write acknowledgement changes no workloads and
reports the attempted token for journal inspection; it never retries the write
automatically. Release command acknowledgements wait for output pipes to close,
and broken input pipes are failures rather than unhandled process exceptions.
Direct Helm migration cannot bypass its reader guard. Local
storage and historical terminal Evaluation formats are unchanged. See
[architecture](./architecture.md#serving-path-refactors).

## Commit qualification (2026-10-10)

The final storage/lifecycle regression run passed 133 tests with no skips. It
covers the worker owner, SQLite backend, parsed cache, managed execution/cache,
publication preparation and metrics. This includes synchronous and asynchronous
termination-request failure, independently confirmed exit and already-exited
owners; none may release a write lease before SQL ownership ends.

The Kubernetes contract checks passed 73 API tests, 14 cutover behavior tests and
local/production Helm lint/render verification. The cutover suite includes a
validation operation that outlives the runner lease: traffic cannot resume until
an explicit exact-token recovery succeeds. API compilation and full root
`test:style` also passed. The separate real PostgreSQL/MinIO integration passed
Evaluation ownership, detail reconstruction, retry/cancellation, retention,
bundle execution and asynchronous endpoint persistence checks.

These suites overlap; their counts are separate runs, not a unique-test total.
The commit pass also passed 32 release-manifest/cutover tests and 23 selected
browser cases: 22 hosted cases on a fixed production preview, plus the desktop
bundle case on its required Vite source-serving harness. The latter was rerun
after initial dependency optimization settled. All use isolated fixtures, not
production workflows. The browser, storage and rollout reports are checkout-local
artifacts, not shipped application files.

Before promoting an incompatible managed release, still run the disposable live
Kubernetes cutover rehearsal. The local cluster was unavailable during this pass;
unit/render results do not qualify real RBAC, pod termination or controller
interference. Production latency and resource budgets likewise require the same
protected workload on release hardware. Do not infer those from a passing commit
gate or the synthetic adapter measurements above.
