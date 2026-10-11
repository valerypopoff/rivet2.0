# Serving refactor completion and verification

This is the implementation checklist for the refined SQLite isolation, immutable
execution-definition reuse and short-transaction/Evaluation projection plan.
Correctness tests are not evidence of a production VM speedup.

## Maintainability follow-up (2026-10-11)

CI follow-up caught two integration gaps missed by the selected local test run:
the transformed HTTP folder schema rejected omitted root destinations, and two
catalog rollback tests still asserted raw SQLite uniqueness messages. Folder
destinations now explicitly default before normalization; omitted, null and empty
values retain their existing root meaning. HTTP regressions cover create, move
and upload, including rejection of malformed/traversing folder inputs. Catalog
collision tests assert the stable `workflow_destination_conflict` code and 409
status while retaining exact post-failure state/rollback checks. Run the full
affected filesystem and catalog suites, not only the pure normalizer contract:

```sh
yarn workspace @valerypopoff/rivet-studio-server-api test:files src/tests/workflow-filesystem-tree.test.ts src/tests/workflow-publication-filesystem.test.ts src/tests/workflow-execution-filesystem.test.ts src/tests/llm-profile-health.test.ts src/tests/local-workflow-catalog.test.ts
```

The repaired complete affected run passed all 163 tests on local Node 22.22.3,
with no skips; API compilation and repository/style checks also passed. GitHub
remains the supported Node 24/Linux qualification gate, not an inferred result
from the local run.

The compatibility baseline is commit
`5fdd02cef9dc021355d0a362de7beefd7693b622`. The measurements below use the
maintainability implementation against that starting point; they
compare execution models, not a measured pre-refactor production deployment.

Completed the dashboard request owner, typed workflow inputs/failures, legacy
command adapter, explicit server resource lifecycle, shared web-app preparation
and backend-neutral runtime-library observation. Schemas, artifact formats,
public revision IDs, scheduler semantics and transport authorization contracts
are unchanged. Tests cover bridge expiry/replacement/overload, cleanup retries,
SQLite error identity, legacy publication, HTTP/Socket authentication, early
outputs, recording pagination and real PostgreSQL/S3 execution.

Settings readiness now uses a cheap connectivity probe plus validation of the
bounded settings rows. Full database integrity remains a startup/migration or
explicit `verifyIntegrity()` operation, not a periodic readiness scan. Do not
remove the settings-data validation: corrupt settings must still fail closed.

The reproducible disposable operational workload is:

```sh
yarn workspace @valerypopoff/rivet-studio-server-api build
yarn workspace @valerypopoff/rivet-studio-server-api serving-refactors:operational-workload 100
```

It creates 24 settings rows, 100 health records, 100 Evaluation bodies of about
100 KiB and 100 schedules outside serving storage. The local Windows/Node 22.22.3
sample measured p95 readiness at 0.63 ms, health begin/finish at 12.08 ms,
Evaluation summary pages at 12.51 ms, detail at 0.88 ms and schedule list/tick
below 0.70 ms. These are development observations, not production capacity
claims; Node 24 is the supported deployment runtime. Windows timer granularity
also limits interpretation of the event-loop sample.

Decision: retain the existing workflow-catalog worker, but do not mechanically
move every operational store into another worker. This fixture does not prove
that added IPC, startup and retained memory would improve them. PostgreSQL stays
on its async driver. A contention/tail-latency measurement on the protected VM
workload is still required before further isolation; Evaluation JSON projection
and durable health writes are the measured candidates, not all settings reads.
SQLite lock waits and large Evaluation histories remain limitations worth
measuring. No worker pool, new trial ledger or compiled-plan cache was added.

The follow-up qualification passed API and web compilation, web unit checks,
the real disposable PostgreSQL/MinIO integration and 41 headless browser cases.
After the last pending-open identity guard change, four affected browser cases
were rerun against a fresh production build and passed. The final selected local
API run passed 124 tests, with two existing POSIX permission checks skipped on
Windows. It includes settings readiness/integrity separation, broken observer
isolation, resource fencing/disposal retries, SQLite serving, trusted clients
and legacy publication history. The focused recording/scheduling/contract run
also passed 35 tests. These suites overlap; do not add them into a unique total.

The protected 100-round local workload was run before and after this change.
Both direct and worker modes preserved its correctness assertions. One noisy
post-change sample had worker operation p95 values about 10-17% above the earlier
sample and approximately 22 MiB more sampled process RSS, while direct-mode
values were lower. Those single development samples do not establish a speedup
or certify performance neutrality. Repeat isolated paired measurements on the
supported Node 24 deployment runtime before claiming either. The new boundaries
preserve the existing worker, cache and transaction designs; this follow-up is
primarily an ownership/maintainability improvement.

An isolated repeat after the final code review observed worker execution
definition/readiness p95 of 24.31/24.36 ms, tree 51.97 ms and save/publication
161.27 ms, with 840 MiB sampled RSS and 48.50 ms maximum event-loop delay.
The earlier baseline was 22.06/22.12 ms, 49.51 ms, 149.98 ms, 834 MiB and
50.66 ms respectively. Direct-mode save/publication p95 was 147.63 ms versus
179.69 ms earlier. Results are mixed and remain synthetic development evidence,
not a statistically established regression or improvement. All workload
correctness assertions passed, and worker pending/active/reserved-byte metrics
returned to zero after the operations.

Final review additionally verified that native runtime-library log observations
read only appended entries rather than rescanning the complete history, and that
SQLite mutation message translation preserves structured conflict identity.
The affected final suites passed 38 and 59 tests respectively, without skips.
Two runtime-library modal browser cases also passed after the log-tail change.
The separate live install/cancel browser scenario was subsequently qualified
against the real API and built dashboard with disposable storage and a blocked
loopback npm registry. It exposed a Windows cancellation defect: killing only
the command shim left npm holding its output pipes. Owned process-tree termination
fixes that path in both runtime-library backends. The browser check then passed
with actual registry requests, no duplicate logs, no activated candidate and API
exit code zero. Windows process-tree checks require normal process permissions;
the restricted development sandbox blocks them. No normal deployment data or
external package registry was used.

Final lifecycle review additionally found that managed runtime-library disposal
could release its database while an accepted worker job or heartbeat still ran.
Disposal now awaits both, fences late process registration and prevents new
claims after shutdown. Focused tests exercise the blocked heartbeat and late-child
races, alongside the existing activation-outcome and observation checks. The
final focused run passed 25 tests without skips; API compilation, full root
`test:style`, repository structure/test-style guards and the disposable
PostgreSQL/MinIO integration passed again after these corrections.

### Final checklist audit

The final audit repaired remaining correctness gaps: blanket SQLite uniqueness
translation, repeated pool releases inventing a successful close, and no-op
local runtime-library disposal. Constraint translation is statement-scoped;
internal identity collisions remain failures. Both library backends fence new
jobs and await owned cleanup. Managed object-client cleanup remains retryable
without reopening admission. Worker loss distinguishes dispatched unknown
outcomes from never-dispatched work without changing its unavailable code or
automatically replaying either.

The operational harness now supports the missing combined workload:

```sh
yarn workspace @valerypopoff/rivet-studio-server-api serving-refactors:operational-workload 100 direct
yarn workspace @valerypopoff/rivet-studio-server-api serving-refactors:operational-workload 100 worker
```

Run separately after compilation, without competing builds/tests. Each owns
disposable storage and rejects deployment paths. The same six serving operations
run alongside settings refresh, profile-health begin/finish, Evaluation trial
checkpoints and actual schedule queue/claim/finish operations. Every round checks
returned identities and revisions. Reports include p50/p95/p99/max latency,
event-loop delay, sampled Node RSS including workers, startup/shutdown, sampled
queue/bytes high-water and queue-wait histograms. Native database lock wait is
not isolated from complete operation duration; the existing contention test
proves responsiveness, not production latency.

The paired local Node 22.22.3, 100-round sample observed:

| Metric                    |    Direct |     Worker |
| ------------------------- | --------: | ---------: |
| Event-loop maximum        | 149.95 ms |   58.52 ms |
| Sampled Node RSS          | 581.0 MiB |  792.5 MiB |
| Save/publication p95      | 186.78 ms |  171.86 ms |
| Tree p95                  |  28.45 ms |   75.33 ms |
| Profile-health p95        |  23.56 ms |   21.05 ms |
| Evaluation checkpoint p95 |  23.50 ms |   21.03 ms |
| Catalog startup           |   1.28 ms | 1072.71 ms |
| All-store shutdown        |   5.83 ms |   20.52 ms |

The worker sample reached six pending operations, one active operation and
238,610 reserved message bytes; pending/active/byte counters returned to zero.
Raw checkout-local reports are `artifacts/refactor-operational-serving-*.json`.
This extends qualification coverage; it is not a before/after performance claim
for this maintainability patch. Production Node 24 repeatability, contention and
regression budgets remain an operator qualification gate. No additional
operational worker is justified solely by this synthetic sample.

Final qualification passed 121 selected API tests without skips, followed by a
42-test overlapping worker/runtime-library/pool rerun after the last worker
failure-outcome change. These are separate runs, not a unique-test total. API
compilation, root `test:style`, repository structure and test-style guards passed.
The real disposable PostgreSQL/MinIO integration passed publication conflicts,
bundle execution, Evaluation ownership and asynchronous endpoint persistence.
The required headless repository browser check passed cancellation of an actual
npm job. A separate active-install shutdown check confirmed API exit and candidate
cleanup before completion; it did not kill the API to manufacture success.
These checks do not replace deployment-specific performance budgets or a live
Kubernetes rehearsal when promoting the earlier managed representation cutover.

### Plan acceptance map

Post-audit regressions cover real HTTP delivery of 2,000 retained log lines and
one terminal event across backpressure, blocked disconnect/stall cleanup, and
cursor/status/terminal resumption without duplicates. Bridge tests use a
controlled monotonic clock independent of timer callbacks, and cover durable
count/byte overload and unknown/replaced delivery outcomes. The browser
tree-sync regression rejects an oversized committed rename notification and
checks that authoritative reconciliation preserves the open tab and retargets
its next save without needing an event-stream notification.

This follow-up passed 40 selected API tests, the full web unit suites, all 21
headless tree-sync browser cases, API/web builds, root style and repository
structure checks. Commit preparation also passed the normal migration-ledger
check against the staged successor files, the full web unit suites, the real
disposable PostgreSQL/MinIO integration and all 21 headless tree-sync browser
cases. The selected API rerun passed 171 tests; two existing POSIX permission
checks were skipped on Windows. The native Windows process-tree regression
passed with normal process permissions. Do not overlap dependency-rebuilding
checks with suites consuming those build outputs. Unused facade imports and an
unused lifecycle property were removed without changing resource ownership.
No production services or storage were changed.

| Planned boundary                  | Completion                                                                                                                                                                                       |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Baseline and compatibility        | Protected direct/worker workloads, ownership docs and behavioral suites; mixed local measurements are recorded above without production claims.                                                  |
| Dashboard/editor bridge           | One bounded request owner; expiry, cancellation, instance replacement and durable queued-command behavior tested.                                                                                |
| Workflow contracts                | Normalized typed inputs, named recording queries, structured failures and a focused legacy command adapter; SQL/native error identity preserved.                                                 |
| Server lifecycle                  | Explicit startup/fence/disposal owner with retryable resource boundaries, typed maintenance probes and preserved storage generation/drain ownership.                                             |
| Execution and runtime observation | Shared web-app preparation/persistence, transport-specific delivery/auth presentation and backend-neutral job observation; real cancellation qualified.                                          |
| Operational SQLite                | Cheap settings readiness plus explicit integrity checks and a disposable measurement command. Additional workers remain measurement-gated, as planned—not an omitted mandatory rewrite.          |
| Qualification and docs            | API/web compilation, focused and managed behavioral tests, browser checks, repository manifests/ledger and owning developer docs. Production capacity qualification remains deployment-specific. |

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
