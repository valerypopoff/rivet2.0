# Hosted Evaluation persistence refactor plan

Status: implemented and verified locally against `develop` commit
`301a90986652ac9c5c523abbdf10c184a5ab8af8` on 2026-11-24. Before code movement,
all 23 focused tests, 26 real PostgreSQL
scenarios and the mounted HTTP journey passed on the original coordinator.
The four-condition A/A calibration, candidate checks, paired A/B comparison and
bounded diagnostic repeat passed. Results and their limits are recorded below.
This records local implementation and verification; production and hosted-CI
qualification remain separate.

## Objective and limits

Separate durable hosted-job transitions from process-local worker scheduling.
Preserve successful behavior, errors, recording compatibility and execution
placement. Workflow endpoints must acquire no additional work or reproducible
latency regression from this change.

The proposed change is one persistence owner and a thinner coordinator, not a
new scheduler. Do not introduce an ORM, generic repository framework, event bus,
transaction retry wrapper, second pool, new queue, schema migration or background
service. Do not change SQL, lock order, isolation, lease/poll/drain settings,
capacity limits, graph execution, access checks or deployment topology as part
of the extraction. A discovered baseline defect needs its own reproduction and
reviewed fix before proceeding; do not encode a known defect as desirable behavior.

This plan builds on the existing [Evaluation HTTP separation](evaluation-http-separation-plan.md),
[Evaluation contracts](../EVALUATIONS.md), [architecture](architecture.md) and
[Hosted Evaluations deployment contract](kubernetes.md#hosted-evaluations).

## Verified starting point

- [hosted-coordinator.ts](../../packages/studio-server-api/src/evaluation-runs/hosted-coordinator.ts)
  is 1,413 lines. It contains ten explicit transaction scopes, plus direct state,
  heartbeat, cancellation and queue-metrics queries. It also owns validation,
  worker identity, active tasks, timers, graph dispatch and shutdown.
- The focused [coordinator tests](../../packages/studio-server-api/src/tests/hosted-evaluation-coordinator.test.ts)
  use simulated pools. They check admission, query ordering and projection
  behavior; they cannot establish PostgreSQL locking or concurrent visibility.
- Real PostgreSQL coverage already exists in
  [hosted-evaluation-projection-contract.ts](../../packages/studio-server-api/src/tests/helpers/hosted-evaluation-projection-contract.ts),
  invoked by the existing `test:async-managed` integration command. It covers
  completion, retry, cancellation, lease recovery, compact progress, protected
  writes, renaming and deletion. Extend this foundation rather than building a
  second container/migration harness.
- [managed/operations.ts](../../packages/studio-server-api/src/routes/workflows/managed/operations.ts)
  supplies the existing managed pool and run store. Construction does not start
  workers. [server.ts](../../packages/studio-server-api/src/server.ts) starts
  them after runtime-library readiness; backend retirement/drain precedes pool
  disposal. The new owner must borrow that pool and must never close it.
- Hosted trials currently run in `control` and `combined`; the `evaluation`
  profile is retained for predecessor compatibility. `execution` never claims
  these jobs. Combined mode shares an event loop with workflow requests; split
  mode still shares PostgreSQL with the control backend. Both paths matter for
  endpoint latency.
- [hosted-projection.ts](../../packages/studio-server-api/src/evaluation-runs/hosted-projection.ts)
  and [managed-run-deletion.ts](../../packages/studio-server-api/src/evaluation-runs/managed-run-deletion.ts)
  already own shared contracts. Keep them authoritative.

The 21-test planning result is recorded locally in
`artifacts/hosted-evaluation-persistence-plan-20261124/baseline-focused.log`.
It is not a new PostgreSQL or production qualification.

## Intended ownership

Add `packages/studio-server-api/src/evaluation-runs/hosted-job-store.ts` with one
`HostedEvaluationJobStore` constructed once per coordinator from the same pool,
run store, worker ID and resolved configuration. It owns SQL and complete
transactions; it does not own timers, signals, active maps, graph runners or
pool lifecycle. Its constructor performs no I/O.
The pool is already leased by the managed backend: do not acquire another
registry lease, create a pool, or release/end it from the job store. Type the
run-store dependency as the existing transactional retention capability it
actually uses; the coordinator retains its current `get()` fallback. This
requires no new adapter or implementation.
The store has no `start`, `stop`, `dispose`, retry loop or pending-work queue.
Keep the coordinator's existing awaited work unchanged: `stop()` has two bounded
waits using the current drain calculation, while `drainAcceptedWork()` waits for
accepted work and reports unconfirmed outcomes. Do not merge their semantics.
The evaluation engine races its adapter promise against cancellation. A graph
adapter that ignores abort may therefore outlive the coordinator task; retirement
confirms the durable interruption, not physical settlement of that arbitrary
adapter promise. Exercise the bounded-stop/evidence-drain distinction by holding
the actual interruption write, and release the test adapter during cleanup.

| Owner                       | Responsibilities                                                                                                                                                                                                                                                                            |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Coordinator                 | Public facade; enabled/input validation; project/sidecar validation and run planning; immutable snapshot preparation; worker identity; active-task tracking; wakeups; metrics scheduling; heartbeat scheduling; graph execution; interruption classification; retirement and shutdown.      |
| Job store                   | Persist a prepared submission; read hosted state; cancel; retry interrupted jobs; delete; claim; release an unaccepted claim; accept; heartbeat; read durable cancellation; interrupt; settle; recover expired leases; read queue counts. Each mutation owns its existing full transaction. |
| Existing projection helpers | Compact header, assembled read and marker removal. No second projection representation.                                                                                                                                                                                                     |
| Existing deletion helper    | Job-first deletion locks and atomic removal, shared with the generic managed run store.                                                                                                                                                                                                     |

Move database row/snapshot types and transaction-private helpers with their
owner. Share the existing snapshot parser and terminal-trial constructor where
both execution and persistence need them; do not copy them. Keep exports used by
HTTP/execution consumers available through `hosted-coordinator.ts`. Define each
error class once and re-export it so `instanceof` translation remains valid.
Do not add a separate contracts module unless the final dependency graph actually
requires it; the job store must not import the coordinator at runtime.

The store accepts prepared submission data; it must not parse the project,
rebuild the plan, clone snapshots again or change when the dataset fingerprint
and JSON encodings are computed. Pass the resolved configuration, not an env
reader. Direct query delegates should return the existing query promise when
possible instead of adding async wrappers and additional reads.
Do not add a blanket enabled check to the store. New submission and retry are
disabled by their existing coordinator/HTTP checks; state reads, cancellation
and deletion of existing runs remain available through the configured backend.
A disabled worker's zero lease/poll configuration must not make those operations
unusable.

Two boundary details need explicit treatment:

1. Active cancellation and successful retry currently notify inside the
   transaction method after `COMMIT`, before `client.release()`. Cancellation
   also aborts matching local tasks at that point. Preserve that ordering with
   a narrowly scoped synchronous `onCommitted` callback on those two operations.
   No callback fires for a missing/terminal cancellation or failed transaction;
   no event bus or asynchronous notification is needed. Submission still records
   acceptance and notifies after its client is released.
   The callback receives no client and cannot issue SQL or return asynchronous
   work. Keep it inside the existing `try`/`finally` boundary; do not move it to a
   generic transaction helper or silently swallow errors after commit.
2. Failed settlement/interruption ownership currently marks retirement as
   unconfirmed; it is not an innocuous successful no-op. Return an explicit
   acknowledgement from the store and retain the coordinator's failure flag
   before the active task can settle or retirement can finish. Keep the original
   error messages. Durable-transition metric increments remain at their current
   decision points; queue/active metrics and their single-flight timer stay in
   the coordinator.

## Transaction preservation contract

Move complete operation bodies, including all early commits/rollbacks, audit
writes, projection changes and `finally` releases. Keep operation-specific lock
orders; there is no one generic order that can replace all ten operations.

| Operation          | Required preservation                                                                                                                                                                                                                                               |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Submission         | Per-run validation before connecting; capacity advisory lock before the outstanding count; dataset snapshot, projection, scheduler parent and every job commit together. Duplicate run insertion remains atomic.                                                    |
| Cancellation       | Run mutation advisory lock, pending-job locks, scheduler parent then projection. Durable cancel, pending terminal trials, audit events and projection share one transaction. Already-terminal cancellation returns the existing projection using the leased client. |
| Retry              | Run mutation lock, capacity advisory lock, interrupted-job locks, scheduler parent, capacity decision and projection. Selected jobs change together; preserve attempts/fences, retained trials, uncertainty, warnings and revision rules.                           |
| Deletion           | Continue calling `deleteManagedEvaluationRun` inside the transaction. Its job/scheduler/projection ordering and active-work refusal remain authoritative.                                                                                                           |
| Claim              | Keep the existing ordered `FOR UPDATE OF job SKIP LOCKED` selection, attempt/fence increment, audit and progress update in one transaction. Do not promise nonblocking parent projection locks just because candidate selection skips locked jobs.                  |
| Release unaccepted | Only the matching claimed worker/fence can return work to queued. Preserve the requeued audit event; do not add automatic retries after acceptance.                                                                                                                 |
| Accept             | Require claimed state, matching worker/fence, an unexpired lease and no durable cancel request. Record acceptance atomically before graph dispatch.                                                                                                                 |
| Interrupt / settle | Match accepted state, worker and fence; keep terminal evidence, audit and projection/retention atomic. A missing acknowledgement must still prevent a successful retirement proof.                                                                                  |
| Recovery           | In one transaction, requeue expired unaccepted claims, and turn expired accepted jobs into interruption or durable cancellation evidence. Preserve per-run metadata reuse and finalization.                                                                         |

Acceptance and heartbeat test `lease_expires_at > NOW()`. Settlement and
interruption deliberately do not add that predicate: an expired but unrecovered
owner can still settle while its accepted state/fence remains current. Recovery
or a later claim changes the ownership conditions. Characterize this distinction
before extraction; adding an expiry predicate would be a policy change.

Keep job status, audit event and trial execution status distinct. A live accepted
job settled with a canceled trial is stored as `settled` with a `canceled` audit
event; recovery of an expired accepted job after a cancel request stores
`canceled`. Preserve both paths and the existing evaluation/benchmark and
pass-fail/scoring quality rules rather than normalizing these states.

Keep DB time as DB time: `NOW()` uses PostgreSQL's transaction-start timestamp,
including after lock waits, as documented for
[PostgreSQL 16](https://www.postgresql.org/docs/16/functions-datetime.html#FUNCTIONS-DATETIME-CURRENT).
Do not replace it with a JavaScript clock or
`clock_timestamp()`. Lease-expiry fixtures must start their checking transaction
after the intended boundary, rather than assuming a blocked transaction's
`NOW()` advances. Observe expiry through a separate fresh query.

Preserve project/run predicates, parameter order, row-count checks and isolation.
`fencing_token` is PostgreSQL `BIGINT`, represented here as `string | number`;
do not coerce it to a JavaScript number. Include a token above `2^53` in the
existing stale-owner case. Keep current claim ordering; tied timestamps do not
promise a total order across runs, so tests must not invent a tie-breaker.

Keep rollback on exceptions and release exactly once. A connection/commit
acknowledgement failure must not acquire an automatic replay path.

For progress, retain index-backed pending existence checks and compact headers.
Do not reassemble all previous trials or parse immutable project/dataset snapshots
on each claim or settlement. Terminal finalization still assembles ordered trials
and applies recording retention through `updateRecordingRetentionInTransaction`
using the same client. Never call an independently connecting store method while
holding a transaction that already has the needed client.

## Gate 1: establish behavior before moving code

Run characterization against the unmodified coordinator, then keep the same
assertions and public entry points for the candidate. No code movement starts
until the relevant baseline cases pass or a separately handled defect is resolved.

### Fast boundary checks

Extend the existing coordinator tests only for missing cases:

- Public exports, error identity, enabled checks, invalid sidecars/context and
  per-run capacity rejection before a connection is acquired.
  Include disabled submission/retry alongside still-available state/cancel/delete;
  also check that constructing the owner or reading capability starts no work.
- Trace connection acquisition/release and transaction commands, including early
  returns, query errors, rollback errors and lost commit acknowledgement. Retain
  the original error instead of replacing it with rollback failure; never retry
  the transaction automatically.
- Distinguish a query rejected before commit from an acknowledgement lost after
  commit. For acceptance, a lost commit reply can leave an accepted durable job
  without graph dispatch; for settlement it can leave committed terminal
  evidence. Read durable state rather than assuming the attempted rollback undid
  either commit, and preserve the unconfirmed-retirement outcome.
- Assert commit-before-abort/notify and notification-before-release for active
  cancellation/retry, and release-before-notify for submission. Failed/no-op
  paths must not emit successful wakeups.
- Single-flight queue metrics, non-overlapping heartbeat calls, worker/fence
  rejection, and failure flags before active-task completion/retirement.
- Disabled/maintenance profiles, idempotent start/stop, retiring after claim but
  before accept, and a non-cooperative graph runner. Preserve bounded `stop()`
  versus evidentiary `drainAcceptedWork()` semantics.

Capture SQL/bindings from execution, not source-file substring tests. A private
baseline/candidate trace comparison may check exact operation sequences without
committing a second set of giant SQL snapshots. Permanent assertions should
describe behavior and critical predicates, not duplicate the implementation.

### Real PostgreSQL matrix

Reuse the database, migrations and owned cleanup of `test:async-managed`. Keep
the existing projection contract. Put the additional concurrency scenarios in
one focused helper, `helpers/hosted-evaluation-concurrency-contract.ts`, called
from that integration entry point. Give competing actors independent connections
or coordinator instances. Use real SQL/results; a tracing/gating pool wrapper
may pause an actual query but may not fabricate its result.
Run scenarios serially within this owned database; concurrency is deliberate
inside each scenario. Global capacity counts and recovery scans include the
whole database, so leftover workers/jobs would contaminate the next case.
Record the starting rows and restore only the helper's owned fixtures.

| Case                                    | Required observable result                                                                                                                                                                                                                                                      |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Concurrent duplicate submissions        | One complete run wins; the loser reports the current conflict. No orphan snapshot, partial job set or extra acceptance event survives its rollback.                                                                                                                             |
| Submission versus retry at capacity     | Both acquisition orders use the same global advisory lock. The final queued/claimed/accepted count never exceeds the configured cap; rejection preserves the pre-operation evidence.                                                                                            |
| Two workers claiming                    | A job is accepted by only one current owner; attempt/fence/audit records agree. A locked candidate can be skipped for another eligible job. Check selection separately from expected parent-lock waiting.                                                                       |
| Cancel versus claim/accept              | If cancellation commits before acceptance, no graph begins. If acceptance wins, preserve durable cancellation and accepted-worker handling. Do not require cancellation to undo already admitted execution.                                                                     |
| Cancel versus retry                     | Use a running parent with an interrupted job and an accepted sibling; exercise both lock orders. No retried job can escape a committed cancellation. Also retain the different terminal-parent behavior: terminal cancellation is idempotent and does not invent a cancel flag. |
| Competing retries / deletion            | Overlapping retry selections reject stale ownership; disjoint selections retain correct evidence. Retry versus both coordinator and generic-store deletion cannot revive a deleted run or discard live work.                                                                    |
| Before versus after acceptance recovery | An expired claim can requeue; expired accepted work becomes interruption evidence and stays terminal until explicit retry. An explicit durable cancel yields cancellation evidence instead.                                                                                     |
| Late old owner                          | After recovery and explicit retry/reclaim, an old worker's heartbeat, accept, settlement and interruption cannot overwrite new evidence. Failed terminal acknowledgement remains visible to retirement.                                                                         |
| Expired, unrecovered accepted owner     | Freeze recovery/heartbeat at controlled query boundaries and verify the current settlement rule independently of the stale-owner case. No wall-clock race or new lease policy.                                                                                                  |
| Atomic finalization failure             | Inject failure after a real job/audit write and during retention finalization. A separate connection must observe no partial committed terminal state. Gate the coordinator's existing fallback separately so it cannot hide the rollback under test.                           |
| Multi-job terminal projection           | Several settlements/recoveries for one run preserve each trial once, compact in-progress headers, final order, revision/accounting/warnings and retention. Include multiple projects and repeated caller-supplied run IDs.                                                      |
| Leased-connection read                  | Already-terminal cancellation works with a coordinator pool of size one. It must not deadlock by reading the projection through a second pooled connection.                                                                                                                     |

Wait for a known query/lock/graph-entry barrier. Use `pg_stat_activity`/lock state
or explicit fixture acknowledgements to establish the interleaving; fixed sleeps
are not evidence. Do not assume a second command was blocked merely because its
promise has not resolved. Bound every wait and release all gates in `finally`.
Observer reads must use a separate connection without `FOR UPDATE`; they must
not acquire the lock whose absence/presence they are trying to measure. A gate
must identify its actor, operation and occurrence so an unrelated poll or
heartbeat cannot accidentally release the intended race.

Existing expired-row setup is suitable for focused recovery cases. The current
projection contract runs coordinators in-process; the async API process fixture
does not currently configure hosted Evaluations and always uses `tsx`.
Neither establishes a compiled coordinator or worker-loss check automatically.

Add one small owned worker entry, `helpers/hosted-evaluation-worker.mts`, for the
missing boundary. Its parent selects either the source entry with `tsx` or the
build's emitted `.mjs` with plain Node. Reuse the same contract/data in both
modes. The worker connects only to the integration runner's database, reports
accepted/graph-start state, supports a held graph and normal retirement/shutdown,
and never accepts arbitrary SQL or a deployment URL. Keep the source/build
identity in its acknowledgement. Do not expose coordinator private methods just
to drive it.
Keep the normal Yarn/PnP module-resolution setup in compiled mode, but load no
TypeScript transpiler there. Assert that the selected coordinator entry came
from the expected built directory; otherwise a source fallback can hide a broken
emitted import.

Use that same entry for one process-loss journey: observe actual graph
acceptance, terminate the owned worker, observe exit, let its configured lease
expire, and prove another worker records interruption without replaying the
graph. Release/stop every child on test failure and verify exit before disposing
its database. Do not shorten runtime lease/poll/drain or safety observation
windows. Keep this journey separate from quick SQL-state fixtures and from a
live deployment.

Snapshot the affected scheduler, attempt, projection, dataset and recording rows
through another connection. Assert domain invariants and exact synthetic IDs;
normalize only generated UUIDs/timestamps when comparing variants. Preserve
unrelated project rows. Cleanup must await workers/queries and close borrowed
connections before the owning fixture drops resources.

Use valid persisted recording references for retention/finalization cases and
assert their retained/expiring state through the real store. A mocked retention
counter cannot prove that the recording update rolls back with the job and
projection. Reuse engine coverage for unchanged quality calculations; add only
missing coordinator terminal-outcome cases, not a large Cartesian product.

Keep the existing HTTP doubles for the detailed status/body translation matrix.
Add one compact mounted-HTTP journey backed by the real coordinator and owned
PostgreSQL database: submit, read state, cancel, and explicitly retry interrupted
work in a separate run. Check the actual response/projection and graph-entry
evidence. Mocked browser or mocked coordinator responses alone cannot prove the
new persistence owner is wired into the serving path. Do not repeat every SQL
race over HTTP.

## Gate 2: freeze the endpoint performance baseline

Record baseline performance before moving code, with exact source/build IDs,
Node/Yarn versions, PostgreSQL version, pool bounds, metrics setting, worker
count, recording policy, input payloads and host resource limits. Use owned local
fixtures; never benchmark production or an external model provider for this move.

Structural acceptance is mandatory even if a noisy benchmark looks faster:

- No new endpoint middleware, initialization, coordinator lookup or queue wait.
- No added SQL, connection checkout, serialization, snapshot parsing or cloning
  on a workflow request or on each existing hosted-job transition.
- No changed pool size, index, query predicate, retry, polling frequency, metrics
  cadence, graph admission or recording policy to compensate for a regression.
- Execution-only processes still do not start workers; construction is inert.

Prepare and smoke-test the comparison harness before capturing the baseline.
The existing [recording benchmark](../../scripts/benchmark-recording-memory.mjs)
supplies useful request scheduling, recording audit and paired-summary code, but
it does not currently provide the complete comparison required here:

- Its fixture explicitly disables endpoint bearer authentication.
- It starts one API process per variant, without a separate control worker.
- It neither enables nor supplies hosted-evaluation work.
- Its uncertainty summary is for p95; raw p99 is not a p99 confidence interval.

Keep that general benchmark unchanged for this refactor. Use a scoped local
comparison driver and the existing managed workflow fixtures. Add only the
test-fixture inputs needed for a declared API profile, hosted-evaluation enablement
and valid fixture bearer authentication. Do not patch product modules, bypass
authorization, or create a new benchmark framework. Both builds must consume the
same fixture revision/hash, including these additions.

In combined mode, the actual coordinator must run in the same API process as
the workflow endpoint; an unrelated worker process would miss the event-loop
contention being tested. In split mode, start a control API and an execution API
against the same owned database, using distinct processes and the existing roles.
Verify graph-entry/ledger evidence for the control worker and no evaluation
claims by the execution process. A configured flag alone is insufficient proof
that the worker ran.

| Scenario                                   | Purpose                                                                                                                                                                                                                        |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Warm combined API, no evaluation work      | Detect direct endpoint overhead on the smallest deterministic recorded workflow.                                                                                                                                               |
| Same combined API, steady evaluation work  | Detect event-loop/CPU and shared-pool interference with the same evaluation workload on both variants.                                                                                                                         |
| Split control/execution, shared PostgreSQL | Measure endpoint latency while the control worker claims/settles, then verify cancellation/drain outside the response window. Retry/recovery interleavings belong to Gate 1. The execution process must keep its current role. |
| Representative larger input/output         | Cross-check serialization and recording behavior without allowing provider/network latency to hide overhead.                                                                                                                   |

Benchmark the current recorded workflow path, including normal result bodies and
recording drain/audit. Use fixed scheduled arrivals at a rate the baseline can
sustain, plus a small sequential control. Preserve the same offered endpoint and
evaluation work between variants; record evaluation starts/completions so less
background work cannot masquerade as faster endpoints. Do not measure a draining
or already-empty evaluation queue as steady contention. Wait for the worker's
actual load phase before starting the endpoint measurement.

Report 429s/errors and missed driver arrivals separately; any of them invalidate
the healthy-workload comparison. Include client scheduling delay in
user-perceived latency and set an explicit driver scheduling-delay bound before
the candidate run. Do not run both variants' evaluation load simultaneously.
Settle each variant's accepted work and recording writes outside its measured
HTTP-response window before switching sides. Keep these drains in the results;
do not hide a throughput or persistence regression behind fast responses.

Use the mounted HTTP route with valid fixture credentials, normal admission and
fresh access checks, not a direct graph-runner call. Keep public/private access
and revocation smoke checks outside timed samples. Build both variants from the
frozen application inputs, with the same dependencies and fixture data;
unrelated application changes invalidate that comparison. Freeze the comparison
fixtures before baseline measurement; new tests are shared inputs, not candidate
application improvements.

Use six paired blocks of 1,000 measured requests per main condition after warmup,
alternating side order. This keeps the existing 10,000-recording-per-variant bound
and gives more batches than the original three-block proposal.
Use separate fresh fixtures for A/A calibration, each A/B condition and any
repeat; do not accumulate calibration and comparison recordings in one store.
Count successful warmups and control requests in the retention/audit budget too.
Run the same six-block A/A calibration first, with both sides using baseline
application code. If another comparison is needed, allow one pre-declared
six-block reversed-order run on fresh fixtures; keep every result. Do not
selectively rerun unfavorable blocks.

Report per-block and aggregate median/p95/p99, throughput, errors, CPU/event-loop
delay and observed pool waiting. Gate 1 observes actual PostgreSQL blockers using
`pg_blocking_pids`; the existing timing fixture does not measure lock-wait duration.
Collect a separate PostgreSQL wait profile if a timing regression needs diagnosis,
rather than adding per-request diagnostic queries. Measure accepted-to-settled evaluation
time and completed-job counts too, so endpoint protection cannot conceal slower
evaluation work. Trials do not persist a graph-start timestamp: do not claim an
accepted-to-start measurement or add production timing instrumentation for this
extraction. Use existing low-cost counters or aggregate outside the
measurement window; do not add per-request diagnostic SQL. Collect heavier
profiling separately from latency runs.

The policy is **no reproducible slowdown**, not a new latency allowance:

1. Before candidate measurements, record A/A variation, the workload/rate, the
   smallest regression the setup can resolve and the bounded-repeat rule. Do not
   invent a universal 1 ms/2 ms tolerance after seeing results. If A/A is too noisy
   to make a useful comparison for these short workflows, improve isolation first.
2. Compute paired uncertainty by resampling whole matched blocks, not independent
   requests, for both p95 and p99 when claiming a tail comparison. Report the small
   number of independent blocks. Do not infer equivalence from a nonsignificant
   difference or use the existing p95 interval as proof for p99.
3. Any repeatable increase in endpoint latency, evaluation wait/completion time,
   errors or drained work blocks acceptance until explained and corrected. An
   interval allowing a material slowdown remains inconclusive, even if the point
   estimate is favorable. Every required condition must pass independently;
   improvements in one cannot cancel a regression in another.

The pre-recorded measurement resolution bounds what may be claimed; it is not an
approved slowdown budget. If the bounded comparison remains inconclusive, report
the gate open rather than claiming that the endpoints are unaffected. No finite
local experiment guarantees identical production latency under every workload.

## Gate 3: perform one mechanical ownership extraction

1. Add the store with the existing complete transactions and shared helpers.
   Review worker transitions separately from user mutations, but finish the
   whole boundary before accepting the extraction. Do not leave duplicate SQL
   implementations or temporary transaction methods exposed to both owners.
2. Wire one instance into the coordinator. Keep public method names, argument
   and result shapes, exported errors/types and worker identity stable. Keep all
   timers and active-task ownership in the coordinator.
3. Preserve explicit acknowledgement handling and the two synchronous
   post-commit callbacks described above. Keep a single visible execution/error/
   shutdown path; do not bury classification or lifecycle work in the store.
4. Compare baseline/candidate transaction traces and public outcomes. Verify
   zero SQL remains in the coordinator and no connection leaks/cycles or new
   per-operation copying have been introduced. Remove redundant delegates only
   when they add no lifecycle/error boundary.
5. Run Gate 1 unchanged on the candidate, then the paired Gate 2 comparison.
   Investigate differences before any further cleanup. Keep baseline and
   candidate builds in separate ignored output directories; do not switch the
   running checkout or rebuild shared `dist` during tests.

Do not combine this with scheduler fairness, batching inserts, parallel recovery,
stronger lease predicates, new timeouts, a compact-projection redesign or fixes
to unrelated hosted deployment automation. Each would obscure preservation.

## Gate 4: integrated verification and documentation

Use the repository-pinned Node and checked-in Yarn. Build dependencies before
checks that consume them; root style checks can rebuild Core, so finish them
before final API builds/tests. Do not run competing builds against the same
output directory.

Run the final source/static gate once, then build before source and compiled
integration checks. Core commands, from the repository root:

```sh
yarn test:style
yarn workspace @valerypopoff/rivet-studio-server-api run build
yarn workspace @valerypopoff/rivet-studio-server-api test:files src/tests/hosted-evaluation-coordinator.test.ts src/tests/hosted-evaluation-execution.test.ts src/tests/hosted-evaluations-config.test.ts src/tests/evaluation-runs.test.ts src/tests/evaluation-runs-filesystem.test.ts src/tests/evaluation-library-events.test.ts src/tests/evaluation-recording-maintenance.test.ts src/tests/api-profile.test.ts src/tests/release-maintenance.test.ts src/tests/workflow-async-process.test.ts src/tests/oauth-http.test.ts
yarn workspace @valerypopoff/rivet-studio-server-api run test:async-managed
yarn workspace @valerypopoff/rivet-studio-server-api run test:published-execution-managed
yarn studio-server:verify:test-style
```

`test:published-execution-managed` protects shared execution admission; it is not
the endpoint latency benchmark. The API build includes tests and replaces a
second redundant runtime-only typecheck. The new worker fixture must exercise
the emitted coordinator and job-store imports with plain Node as well as source
with `tsx`; the current async-workflow fixture does not automatically do this.
Keep a positive graph/settlement assertion in both modes. Run typed lint and
formatting with the repository configuration on touched files.

Root style already covers the general test-style guard, file-tree/import checks
and documentation links. The Studio Server-specific test-style command has
different coverage. Reuse passes for unchanged inputs rather than repeating all
checks after each small slice; rerun the relevant check when source or evidence
changes. If documentation is edited afterwards, finish with
`yarn node scripts/checks/check-doc-links.mjs` and `git diff --check`.

Keep the new helper called by `workflow-async-managed.integration.ts`; the
existing managed CI lane already runs it. If a new top-level test is actually
needed, check `api-test-files.mjs` and shard discovery instead of assuming it is
included. Do not add a new CI job or duplicate the PostgreSQL setup for this move.

Run the required headless browser compatibility checks against a built owned
frontend. Discover the existing cases, then select the retryable initial-history
read and both trial-orchestration recording outcomes:

```powershell
$env:PLAYWRIGHT_HEADLESS = '1'
$env:PLAYWRIGHT_SLOW_MO = '0'
# Set PLAYWRIGHT_BASE_URL to the owned frontend.
yarn studio-server:ui:observe evaluation-history-paging.spec.ts evaluation-trial-orchestration.spec.ts --grep 'retryable initial read|Browser evaluation uses shared trial orchestration' --workers=1
```

These browser cases use mocked responses; real PostgreSQL/HTTP checks remain
necessary. Review failures under `artifacts/playwright/`. No Kubernetes rehearsal
is required for this internal move. Staging disruption/production rollout remain
separate qualification and authorization steps.

After implementation, update this record, `architecture.md`, `refactor-history.md`
and `../EVALUATIONS.md` with the final ownership and evidence. Read the optional
Git-ignored recurrence checklist before any commit/push. Preserve private data
and local artifacts outside Git; record hosted queueing separately if making a
later CI performance claim.

## Completion decision

The refactor is complete only when baseline and candidate behavior checks pass,
real PostgreSQL interleavings preserve the stated invariants, public HTTP errors
and projection/recording contracts are unchanged, and workflow/evaluation
performance shows no reproducible regression at the pre-recorded resolution. No
required skip, unresolved deadlock, leaked client, unconfirmed retirement or
inconclusive performance result can be reported as a pass.

Source length is not an acceptance metric. The final code should have one owner
for every durable transition and one owner for process-local scheduling, without
new cross-owner state synchronization. Commit, hosted CI and deployment are
separate from this local implementation and verification.

## Implementation evidence (2026-11-24)

The unchanged application passed an A/A calibration using six paired blocks of
1,000 requests for each of the four conditions. All 48,000 measured requests and
512 sequential warmups succeeded, with no capture rejection; every expected
recording passed the storage audit. Both sides used the frozen baseline build.
The initial 128 requests/second probe exceeded the existing capture admission
limit (a repeated probe recorded 177 rejections). That is retained as overload
evidence, not a passing performance comparison. The healthy workload was fixed
at 32 requests/second before any application code moved; no capture budget changed.

The largest absolute differences between paired identical-build blocks were:

| Condition       | p95 difference | p99 difference |
| --------------- | -------------: | -------------: |
| Idle combined   |       0.843 ms |       1.004 ms |
| Loaded combined |       2.194 ms |       2.884 ms |
| Loaded split    |       0.777 ms |       0.758 ms |
| 64 KiB combined |       0.745 ms |       0.756 ms |

These describe observed local variation, not approved slowdown budgets or a
guarantee that smaller changes are impossible. Candidate results must retain
their whole-block uncertainty intervals and be compared with this calibration;
an apparent small improvement alone is not evidence of a speedup. A reproducible
increase or unresolved material interval still requires investigation and, if
needed, the single pre-declared reversed-order repeat.

Functional verification passed before the A/B comparison:

- 23 focused tests and 26 real PostgreSQL scenarios passed on the original
  coordinator before extraction. The final candidate passed all 134 selected API
  tests with no skips, plus the full `test:async-managed` suite, including those
  same 26 scenarios and a mounted HTTP submission/state/cancel/retry journey.
- Source and plain-Node compiled workers both accepted and settled work. A killed
  accepted worker was recovered after its real configured lease elapsed, with
  no graph replay. Held-query cases covered unaccepted retirement, non-overlapping
  heartbeats, expired-owner rejection and bounded stop versus persistence drain.
- `test:published-execution-managed` passed its four-process admission, reconnect,
  restart, outage and draining checks. All three selected headless browser cases
  passed through the required repo runner.
- API build, typed lint, root style, Studio Server test style, repository structure
  and migration-ledger checks passed. The extraction retained all 84 SQL calls
  and parameter bindings; no SQL remains in the coordinator. All 494 shared
  Core/Node/Evaluations runtime file hashes matched the baseline. The two compiled
  benchmark helpers matched after normalizing line endings.

The first A/B comparison passed all request, capture and recording audits.
Endpoint p95/p99 differences had intervals spanning zero in every condition;
evaluation queue/settlement times and completed work showed no reproducible
slowdown. The large-payload case used more CPU in the candidate, while the A/A
calibration itself had substantial CPU/GC variation between identical builds.
That observation triggered the pre-declared six-pair reversed-order repeat for
the large-payload condition, keeping its rate, payloads, policies and builds fixed.
The original result remains part of the evidence.
Each condition keeps one warm process per side across its six blocks. The
block-bootstrap intervals describe that batch variation; they do not establish
equivalence across independent process starts or arbitrary production workloads.

The repeat passed all response and recording checks. The initial large-payload
comparison used 6,156/7,430 CPU ms per block (original/candidate); the repeat used
7,469/6,667 ms. The CPU increase did not reproduce, and no CPU improvement is
claimed. The earlier A/A run also differed between identical builds
(6,860/5,985 ms). Large-payload drain averages changed from 15.2/22.2 ms in the
first comparison to 18.6/13.9 ms in the repeat. Retain both observations rather
than selecting the favorable run.

Pooled response latencies for the main A/B comparison, in milliseconds:

| Condition       | Original p95 | Candidate p95 | Original p99 | Candidate p99 |
| --------------- | -----------: | ------------: | -----------: | ------------: |
| Idle combined   |        3.919 |         3.878 |        4.602 |         4.546 |
| Loaded combined |       17.370 |        17.222 |       20.941 |        20.931 |
| Loaded split    |        3.936 |         3.935 |        4.860 |         4.645 |
| 64 KiB combined |        4.542 |         4.546 |        5.280 |         5.215 |

The 95% block-bootstrap intervals below describe differences between mean block
quantiles, rather than differences between the pooled quantiles above. Each
resample includes whole matched blocks; all `6^6` resamples were enumerated.

| Condition       | p95 difference interval, ms | p99 difference interval, ms |
| --------------- | --------------------------: | --------------------------: |
| Idle combined   |            -0.410 to +0.282 |            -0.502 to +0.255 |
| Loaded combined |            -0.759 to +0.392 |            -0.801 to +0.721 |
| Loaded split    |            -0.356 to +0.384 |            -0.443 to +0.509 |
| 64 KiB combined |            -0.476 to +0.476 |            -0.653 to +0.457 |

The repeat's corresponding intervals were -0.438 to +0.392 ms and -0.421 to
+0.280 ms. Neither comparison established a reproducible latency increase.
Intervals including driver scheduling delay also remained within the observed
A/A variation. All scheduled requests completed at the fixed offered rate of
32/second, with no capture rejection. This is not a maximum-throughput result.

Evaluation work was real: completed outputs were checked independently in both
condition databases after their timed windows. Combined mode completed
2,249/2,277 trials (original/candidate), and split mode completed 2,233/2,221,
with zero execution errors or incorrect outputs and no remaining active jobs.
Accepted-to-settled p95 averages were 73.72/73.93 ms in combined mode and
75.00/74.56 ms in split mode; their paired difference intervals included zero.
Queue timing and total evaluation/drain duration likewise showed no reproducible
increase. No pool wait was observed by the existing 25 ms sampler; that does not
exclude shorter waits. CPU, GC, event-loop, pending-write and drain measurements
remain in the raw results.

Across calibration, main comparison and the single diagnostic repeat, 108,000
measured requests and 1,152 sequential warmups passed, including every expected
workflow recording audit. These local results support the extraction at the
recorded workload and resolution, alongside unchanged SQL and endpoint work.
They do not establish exact timing equivalence, cold-start behavior, arbitrary
production capacity or a hosted workflow speedup. The owned test containers,
anonymous volumes, child processes and temporary baseline overlay were removed
after verification.

Raw inputs, results and audit logs are Git-ignored under
`artifacts/hosted-evaluation-persistence-20261124/`; `cleanup.json` records the
owned-resource cleanup. The frozen original build and source remain there for
review. The initial implementation's local verification completed at this point.

## Subsequent code review

The 2026-11-24 review added failing real-PostgreSQL reproductions before fixing
two pre-existing identity defects:

- Two runs in one project can have the same encoded job ID when their run/case
  IDs contain colons. The earlier active map overwrote one cancellation signal.
  Active metadata and drain promises now share one promise-keyed map, so each
  task removes only its own entry and frees exactly one concurrency slot.
- Two different project/run pairs can produce the same colon-joined recovery
  key. Recovery could update only one parent and reuse the wrong run metadata.
  A JSON tuple key keeps both identities distinct without changing persisted IDs.

A native-worker regression also demonstrated that cleanup accepted a worker
which had already crashed. Cleanup now coalesces concurrent calls, requires a
successful requested shutdown, and accepts a killed worker only after explicit
fault injection. Release callbacks need no identifier lookup and use a set.
The two post-commit callback signatures return `undefined`, preventing an async
function from silently satisfying a `void` return type.

The three added regressions expand the PostgreSQL matrix from 26 to 29 cases.
The review leaves SQL, transaction ordering, data formats and workflow endpoint
code unchanged. All 29 cases passed in the full managed integration suite,
including source/compiled worker execution and the mounted HTTP journey.
The 103 focused API tests passed without skips, as did the API build, typed lint,
repository/test-style checks and all three selected headless browser cases.
The extraction check still finds all 84 SQL calls and bindings unchanged and
no SQL in the coordinator.

The earlier four-condition benchmark numbers describe the initial extraction.
A separate loaded-combined comparison checks the subsequent ownership fixes
against the same frozen original build; its results are recorded below.

That comparison passed all 12,000 measured requests and 128 warmups at the
unchanged 32 requests/second, including every expected workflow recording audit.
Six matched blocks alternated the original/candidate order. Pooled response
p95 was 15.244/15.208 ms and p99 was 20.252/20.023 ms (original/candidate).
Whole-block 95% bootstrap intervals for the mean paired quantile differences
were -0.564 to +0.527 ms at p95 and -2.738 to +1.727 ms at p99. Intervals including
driver scheduling delay also spanned zero. These do not establish exact timing
equivalence or exclude small regressions; no reproducible latency increase was
found in this local workload.

The independent graph audit found 2,488/2,480 completed trials, correct outputs,
zero execution errors and no remaining active jobs. Evaluation queue, settlement
and total-duration intervals all included zero. Mean serving CPU was
15,260/14,698 ms per block and drain time was 3,233/3,329 ms. No CPU or throughput
improvement is claimed. The review used an owned tmpfs-backed PostgreSQL fixture,
so compare its two sides with each other, not their absolute timings against the
earlier volume-backed fixture. This is one warm-process pair, not a production
capacity, independent-start or hosted CI speedup result.

Reproductions, validation logs, the comparison manifest, raw samples and graph
audit are Git-ignored under `artifacts/hosted-evaluation-review-20261124/`.
The owned containers and temporary baseline overlay were removed, and no owned
benchmark or test-worker process remained. `cleanup.json` records that cleanup.

## Completion audit (2026-11-24)

The final plan audit closed two verification gaps without changing production
code. The earlier 84-call comparison checks source expressions; it is now
supplemented by captured SQL and bound arguments from real PostgreSQL execution.
The same 23 in-process concurrency scenarios ran against the frozen original
runtime and the final runtime. Their distinct transaction paths matched,
including statement order and bound arguments, and every traced client was
released exactly once. The two separately reproduced identity defects remain
covered by their candidate regressions rather than being treated as behavior
to preserve.

The trace comparison uses identical synthetic project/run IDs for both builds.
It normalizes generated worker identities and timestamps. In the three abort
cases it also normalizes elapsed duration values while preserving their equality
relationships in trial and aggregate fields. Repeated polling is collapsed;
empty claim paths are compared across the full matrix because a scheduler may
make an additional idle poll before a test observes completion. Raw traces are
retained, and the earlier performance comparisons remain the timing evidence.

The native worker now reports its resolved coordinator module URL, and the
parent asserts the expected source `.ts` or compiled `.js` path in addition to
the worker entry. Both modes passed their positive execution/settlement checks
in the full managed suite. The fast coordinator test also checks that disabled
retry, blank context keys and non-finite context values reject before acquiring
a connection.

| Plan gate                  | Completion evidence                                                                                                                                                                             |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Behavior before extraction | Original focused tests, 26 PostgreSQL scenarios and the mounted HTTP journey; candidate regressions now cover 29 scenarios.                                                                     |
| Endpoint performance       | Four-condition A/A and A/B comparisons, the bounded large-payload repeat, and the subsequent loaded-combined comparison. No reproducible slowdown was found at the recorded local resolution.   |
| Ownership extraction       | One job store, no coordinator SQL, identical 84 SQL call expressions/bindings, matching executed transaction paths across 23 shared scenarios, and preserved lifecycle/notification boundaries. |
| Integrated verification    | Build, focused tests, full managed and published-execution suites, source/compiled workers, required browser checks, static checks and updated developer documentation.                         |

Audit evidence is Git-ignored under
`artifacts/hosted-evaluation-completion-20261124/`. The pre-consolidation 17 focused coordinator
tests and all 29 managed PostgreSQL scenarios passed, as did build, typed lint,
test-style and file-tree checks. Runtime hashes still match the reviewed
performance build. The owned trace database, temporary overlays and test workers
were cleaned up; `completion.json` records these checks.

This closes local implementation and verification. Hosted CI and deployment
remain separate steps; neither is represented by these local results.

## Adjacent identity review

Following the coordinator collision fixes, the adjacent shared Evaluation
adapters were checked for the same assumptions. Failing regressions reproduced
two additional defects:

- `InMemoryEvaluationRunStore` joined project/resource IDs with `/`. Distinct
  valid pairs could overwrite a run, carry its name into another project, or
  mix recording retention and deletion. One private JSON-tuple key function now
  serves all three maps. Persisted IDs and database schemas do not change.
- Library token maps inherited object members. Creating a resource named
  `constructor` or `toString` could report a false conflict, and a missing token
  could be accepted by the client diff. After remote deletion, retry could expose
  an inherited function as the conflict's current version. Server validation,
  shared diff and HTTP retry now require own properties. Real versions remain
  valid for these names, including `__proto__`; stale edits still conflict.

The focused tests exercise run reads/rename/delete, recording expiry/retention
isolation, real versus missing tokens, and a retained HTTP retry after remote
deletion. Negative reproductions and validation logs are Git-ignored under
`artifacts/hosted-evaluation-adjacent-20261124/`. These adapter corrections add no
workflow request work or hosted-job SQL. Earlier benchmark results describe
their recorded builds; they are not a new timing measurement of these fixes.

All 163 shared Evaluation tests and 58 focused API tests passed. The changed API
test file also passed its final 39-test rerun. Shared package/API/frontend builds,
typed lint and repository guards passed. Four headless browser cases passed;
the dataset editing case now uses isolated bootstrap/library responses and
confirms saved values as well as rendered toggles. Its earlier ambient-API wait
is retained as failed fixture evidence, not counted as a passing run.

## Test consolidation audit

The coordinator unit suite now has 11 tests instead of 17. PostgreSQL owns the
duplicate-submission, global-capacity, stale-selection and one-connection
terminal-cancellation checks; duplicate SQL-mock cases and the unused capacity
pool stub were removed. The real capacity scenarios now check the error limit,
both fully stale and partially valid retry selections, and unchanged jobs after
rejection. The duplicate-submission case also checks the winning snapshot value.
One parameterized unit test covers successful and failed rollback while retaining
the original error, no commit, and exactly one release.

The projection contract now uses `createHostedEvaluationFixture` for its project,
suite, dataset, configuration and cleanup. Its compact projection, retry,
scheduler ownership and finalization assertions remain. The coordinator and
projection test files are 261 lines shorter in total. This is less duplicated setup to maintain,
not evidence of a hosted CI speedup.

Promise settlement replaces flag polling in the bounded-stop case and an extra
deferred gate in the worker-crash case. Every wait remains bounded. The real
heartbeat observation, 15-second worker lease, accepted-work recovery and
source/compiled worker checks remain distinct and retain their timing windows.
Browser history and orchestration fixtures now use current string collaboration
tokens rather than accidentally exercising the old-server fallback.

The shared-library tests retain separate checks for storage isolation, missing
versus real version tokens, server mutation validation and client retry behavior;
those cover different boundaries rather than duplicate the same assertion.
Review and validation records are Git-ignored under
`artifacts/hosted-evaluation-test-audit-20261124/`.

Verification passed: 52 focused API tests, the final 11-test coordinator rerun,
the full managed suite with all 29 PostgreSQL scenarios, and four headless
browser cases. The API build, typed lint, test-style, file-tree and documentation
checks also passed. No application code changed during this consolidation.

## Comparative assessment against the committed version

The implementation recorded here is a net maintainability and local-correctness
improvement over `301a90986652ac9c5c523abbdf10c184a5ab8af8`. The final review found
no new blocking regression in the changed application paths. This assessment
covers the refactor and adjacent adapter fixes, not every subsystem or the live
production installation.

The original 1,413-line coordinator is now a 462-line scheduler/facade and a
1,045-line persistence owner. Total code in those two files is slightly larger;
the benefit is clearer ownership, not a claim that all complexity disappeared.
Transactions remain complete and explicit. No new pool, queue, ORM, schema or
background service was introduced. The 84 SQL call expressions/bindings still
match the original, and the separate real-PostgreSQL trace comparison supports
the preserved transaction paths.

Reliability improved beyond the extraction: reproduced cancellation/recovery
identity collisions, in-memory cross-project collisions and inherited-property
version lookups were fixed. The tests now retain independent proofs for database
contention, terminal rollback, stale fences, actual worker loss, native compiled
execution and recording retention. The large concurrency helper remains a real
maintenance cost; its SQL gates must evolve with future transaction changes.

Two limits remain material:

- This source revision has local build, test and browser evidence. It has
  no exact-image hosted CI, staging upgrade or production qualification. The
  timing experiments describe their recorded builds and workloads; the later
  shared-library fixes received functional checks, not a new production load
  test. No universal latency or capacity guarantee follows from them.
- The pre-existing qualified-production integration issue remains outside this
  diff. `deploy-qualified-release.mjs` still invokes the raw deployment CLI,
  while recording coordination requires the real transition wrapper/guard.
  The shared hosted workflow contains no guard-establishment step. Releases
  requiring that guard must continue to stop safely until the hosted path is
  repaired and qualified, including its production-only preflight.
