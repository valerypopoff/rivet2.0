# Published endpoint admission before project preparation

Implemented and verified locally through November 22, 2026. This document covers
published run admission, managed endpoint lookup limits and their local qualification.

## Problem and boundary

Published HTTP requests previously loaded the executable project before checking
the shared execution gate. Even at full capacity, public requests performed their
required fresh metadata lookup, loaded missing revision/release artifacts, and
constructed mutable project state before returning `429`.

The fix moves only expensive preparation behind admission. Authentication, body
limits, endpoint existence and public/internal access retain their current order.
The required fresh public metadata lookup remains before admission: this change
does not eliminate overload pressure on the database or guarantee a particular
production throughput.

Cold preparation now occupies an execution slot instead of running outside the
limit. A cold burst can therefore have fewer graphs actively executing while
projects load, but it cannot create an additional unbounded preparation workload
behind a full execution gate. Database capacity, external API capacity and the
memory used by running graphs still need their own workload validation.

## Request flow and ownership

1. Validate/authenticate the endpoint before receiving its JSON body, as before.
2. Parse with the existing body-reader queue, size and byte-reservation limits.
   Waiting/receiving an upload owns no execution permit.
3. Resolve a request-local `WorkflowPublishedExecutionTarget`: current access
   metadata and a deferred `load()` operation. Missing/private public targets
   return the same `404`, even when execution capacity is full.
4. Acquire the existing shared published permit. Saturation still returns `429`,
   `error.code: execution_capacity_exceeded`, and `Retry-After: 1`; draining still
   returns `503`. Rejection never calls `load()`.
5. Track accepted HTTP work before loading project/release artifacts, constructing
   mutable per-run state, and creating the processor. Recheck the loaded result's
   existence/access because storage invalidation can cause a reload.
6. Retain the permit and shutdown registration through preparation, the complete
   run and its background tail, preserving early-response/recording semantics.
   Release both on every exit, including failed preparation and construction.

The existing UI-adjustable limit now includes accepted project preparation. The
gate, live-setting subscription, other published surfaces, body admission, latest
editor runs and recording persistence are unchanged. There is no new execution
queue, database schema, environment flag, service or automatic graph retry.

## Storage seams

`WorkflowExecutionSources.resolvePublishedExecutionTarget` is separate from the
existing full-project loader; other callers keep that API. Targets own no lock,
worker lease or background operation when discarded and are not durable handles.
The compatibility facade selects the same installation-owned repository.

- **Managed PostgreSQL:** split the existing endpoint resolver before revision or
  frozen-release artifact loading. Public lookups still bypass the pointer cache
  and pre-change in-flight loads. Normal accepted requests reuse the resolved
  revision/pointer, adding no database lookup or object read. Existing bounded
  invalidation retries, immutable artifact caches and per-run cloning remain.
  Cacheable internal lookups share one in-flight metadata read per endpoint and
  invalidation generation. Sharing ends when that lookup settles, including
  failure, without starting artifacts. Existing full-source sharing retains its
  longer lifetime for callers requesting complete definitions. Fresh public
  lookups bypass both forms of sharing to preserve committed access checks.
  Admitted cacheable targets join the existing full-source owner for their
  endpoint/generation, including requests arriving after an earlier metadata
  lookup finished. They share source loading and bounded invalidation retries.
  Existing full-source owners/retry continuations use the private `load(false)`
  path to avoid joining their own promise. Fresh public loads never join older
  source work, even before invalidation notification. Settled source entries are
  removed, including failures; each caller receives its own mutable project and
  dataset state. Observed invalidation is checked
  before artifact loading, after successful loading and on loading failure,
  including frozen-release manifest reads. A known unpublish can therefore return
  not-found without first depending on retired artifacts. Only read-only
  preparation is retried; the graph is never resubmitted by this mechanism.
- **SQLite:** resolve only metadata and immutable artifact references in the
  catalog, then load/verify them after admission. Direct and worker-backed modes
  use the same catalog operations, cache and post-I/O state-change check. The
  worker exchanges a serializable target, not callbacks or cache instances.
- **Legacy filesystem:** separate cached routing lookup from materialization.
  Each phase holds its own existing storage-read lease; discarded targets retain
  none. Loading revalidates routing and preserves missing-root recovery, stale
  pointer fallback and not-found behavior. A concurrently changed bypass target
  fails closed instead of executing under stale access metadata.
  Immediate full loads retain their caller's read lease and skip redundant
  routing revalidation; deferred targets always revalidate under their new lease.

## Local verification

Use the pinned Node/Yarn runtime. Focused tests:

```powershell
yarn test:style
yarn workspace @valerypopoff/rivet-studio-server-api build
yarn workspace @valerypopoff/rivet-studio-server-api test:files src/tests/workflow-published-admission.test.ts src/tests/managed-execution-service.test.ts src/tests/managed-execution-invalidation.test.ts src/tests/filesystem-execution-cache.test.ts src/tests/sqlite-workflow-backend.test.ts src/tests/workflow-execution-filesystem.test.ts src/tests/workflow-async-response.test.ts src/tests/published-execution-admission.test.ts src/tests/active-http-executions.test.ts src/tests/web-app-policy-lookup.test.ts src/tests/workflow-storage-services.test.ts
yarn workspace @valerypopoff/rivet-studio-server-api test:files src/tests/body-admission.test.ts src/tests/shutdown-http.test.ts src/tests/server-resource-lifecycle.test.ts
```

Run dependency-rebuilding checks such as `test:style` separately from API tests:
they regenerate Core's ESM output, which running test processes also import.

The final local review passed the API build, root style checks and all 244 tests
in these two selections (197 execution/storage tests and 47 body/shutdown/resource
lifecycle tests). The new HTTP regression is included in the default API test
manifest and therefore runs in CI. These results do not replace CI or
representative staging qualification of the built images.

The HTTP regression holds 32 permits and sends 64 excess requests, asserting
`429`, retry guidance and zero deferred loads. It also checks pre-admission
authentication/private/not-found responses; live-limit changes during held
preparation; shutdown counts; preparation failure/disappearance/access changes;
processor-construction failure; shutdown abort during preparation; draining;
and continued internal access. Existing async
HTTP tests verify that foreground output does not release background ownership.

Managed-service tests assert zero cold reads or warm clones during lookup, one
fresh metadata lookup per ordinary public request, no second query on load,
deferred frozen-release access, and invalidation races in both phases. Metadata
lookup-sharing tests additionally prove 32 cold internal requests make one query,
that public freshness and new invalidation generations cannot join stale work,
and that a failed shared lookup permits recovery on the next request. Further
source-sharing tests additionally compare 32 full/deferred/staggered loads through
an access-change race: all need two metadata lookups, one artifact read and 32
independent projects. They cover unavailable artifacts before/during unpublish,
retired frozen-release manifest reads, failed/settled load cleanup, and fresh
public source isolation while an older revision is still loading. Filesystem
immediate-load tests retain the original two-settings-stat budget (index plus
pointer), while deferred-load tests still catch access/unpublish changes. SQLite
tests resolve targets with the artifact directory temporarily unavailable in
both direct and serving-worker modes, then verify execution preparation and
concurrent access/unpublish checks. Filesystem tests cover deferred reads and
access/unpublish changes, with existing cache/root-recovery coverage retained.

Performance validation compares the committed and changed real HTTP route and
processor locally, with the same fake managed database/blob I/O, warmed projects,
and recording disabled. Check accepted latency for both tiny and 1 MiB projects;
also count rejected materializations and ordinary metadata/artifact operations.
These fixtures isolate request-ordering overhead; they are not a cloud load test
or a measurement of production database latency.

Measured against `c1600cd76` on the same local Node 24.22.3 runtime, alternating
old/new samples to reduce process and warmup bias:

| Warm accepted path | Samples per variant | Previous p95 | Changed p95 |
| --- | ---: | ---: | ---: |
| Managed HTTP, tiny project | 3,000 | 0.996 ms | 0.974 ms |
| Managed HTTP, 1 MiB project | 3,000 | 1.396 ms | 1.400 ms |
| SQLite direct preparation, tiny project | 1,000 | 0.256 ms | 0.241 ms |
| SQLite direct preparation, 1 MiB project | 1,000 | 0.650 ms | 0.658 ms |
| SQLite worker preparation, tiny project | 1,000 | 0.535 ms | 0.699 ms |
| SQLite worker preparation, 1 MiB project | 1,000 | 1.620 ms | 1.870 ms |

Managed HTTP figures were refreshed after the adjacent invalidation review; SQLite
figures are from the original validation. Small differences in these local
latencies do not establish a production speedup.

Managed accepted requests retained exactly one fresh metadata lookup and one
project materialization per request, with zero warm blob reads. For 64 rejected
requests at a full 32-slot gate, materializations fell from 64 to zero; metadata
lookups stayed at 64. SQLite worker mode pays for one additional metadata-only
worker exchange; its local p95 increase was 0.16–0.25 ms. These measurements bound
the observed local overhead, not all workload sizes or production tail latency.
Scratch benchmark fixtures/results are under the ignored
`.data/overload-admission-review/` directory, outside the ordinary test suite.

## Bounded public endpoint metadata lookups

### Runtime contract

The public managed workflow POST authenticates the caller, admits and parses
the body, and validates the endpoint name before looking up the publication.
The server takes a run permit only after confirming current public access.
Internal routes, SQLite and filesystem storage bypass the managed lookup queue.

A process admits up to `max(1, floor(pool maximum × 0.8))` metadata operations.
The ten-connection pool admits eight. Up to 96 callers can wait in arrival order
for 200 ms. The monotonic deadline is checked again on dispatch. Once dispatched,
a lookup holds its slot through initialization, SQL and metadata retries until
settlement, even if the client disconnects. The route skips run admission for
a closed public response. Retirement, shutdown and restore fence new lookups.

An uncontended lookup reads PostgreSQL immediately. While a read is outstanding,
admitted callers can share the next statement across endpoint names. Enrollment
closes before SQL starts. Each caller checks its own row and gets a snapshot
taken after it arrived. An admitted run that observes a publication change
rechecks the pointer independently before loading the replacement. See the
[execution and frozen-release lifecycle](./architecture.md) for cold-read limits.

| Public request outcome | HTTP response |
| --- | --- |
| Authentication fails | 401 |
| Lookup completes and the endpoint is private or missing | 404 |
| A verified public endpoint has no run slot available | 429 `execution_capacity_exceeded` in enforcement mode |
| Lookup queue is full or its deadline expires | 503 `endpoint_lookup_busy` with `Retry-After: 1` |
| Lookup admission is draining | 503 `execution_draining` with `Retry-After: 1` |

Use `rivet_endpoint_lookups_active` and `rivet_endpoint_lookups_queued` to
inspect metadata pressure. The wait histogram is `rivet_endpoint_lookup_wait_seconds`.
The `reason` label on `rivet_endpoint_lookup_rejections_total` distinguishes
`full`, `expired`, `draining` and `disconnected`.

### Local verification

Run the focused admission and storage checks listed above. The additional lookup
tests and managed integration suites run from the pinned API workspace.

```powershell
yarn workspace @valerypopoff/rivet-studio-server-api test:files src/tests/public-endpoint-lookups.test.ts src/tests/managed-workflow-schema.test.ts
yarn workspace @valerypopoff/rivet-studio-server-api test:endpoint-releases-managed
yarn workspace @valerypopoff/rivet-studio-server-api test:published-execution-managed
```

For load comparisons, alternate baseline and candidate builds on the same local
CPU and RAM quotas with an independent HTTP client. Validate the graph output
and count rejections for every workload. Exercise normal arrivals, synchronized
bursts, distinct cold releases, a full execution replica and blocked metadata
SQL. During a database stall, time an independent read on the same pool.
For healthy traffic, each workload must clear the one-sided 95% bounds of
0.5 ms added p95 and 2% lost successful throughput. The local measurements
below record how the final queue limits and batching behavior were selected.

### Initial local qualification

The November 22 comparison used the compiled develop baseline at `5d93500b1`
and the candidate with the same core, Node runtime, local PostgreSQL and MinIO.
The HTTP client ran separately. The timing fixture disabled recording to
isolate the lookup change. A separate recording-enabled HTTP fixture checked
that pre-admission rejections created no recordings and admitted graphs
completed and persisted normally.

- Queued requests observed committed access changes and unpublishing as 404,
  and a republished workflow returned the new frozen graph's output. The test
  withheld cache notifications. An already-admitted graph completed unrelated
  SQL on the application pool before the blocked endpoint reads were released.
- Selecting only the fields consumed by the execution resolver reduced the
  database response while preserving the history-row check and the distinct
  endpoint and revision owner IDs. Across seven longer paired production-profile
  trials, synchronized groups of 32 completed **6.87% fewer runs per second**
  on average (one-sided 95% upper loss 11.97%). Burst p95 improved 0.98 ms on
  average, but its upper bound was +0.69 ms. Continuous concurrency of 32 had
  a 0.95% mean throughput loss with a 6.90% upper bound. All responses in
  these trials returned the expected graph output.
- Removing queue instrumentation in a diagnostic build did not recover burst
  capacity. A prepared-statement experiment still missed the throughput gate
  against the baseline over nine paired blocks. The application uses the
  ordinary parameterized query.

The final five-block comparison completed 47,206 baseline and 45,743 candidate
requests with correct outputs and zero errors. Counts differ because the
capacity cases run for fixed durations. The table shows the candidate's change
in p95 latency and the one-sided 95% upper bound for that change.

| Run slots | Scheduled workload | Requests/s | Mean p95 change | Upper bound |
| ---: | --- | ---: | ---: | ---: |
| 4 | Tiny graphs | 40 | −0.29 ms | −0.08 ms |
| 4 | Tiny and I/O-waiting graphs | 40 | −0.01 ms | +0.28 ms |
| 32 | Tiny graphs | 125 | +0.02 ms | +0.23 ms |
| 32 | Tiny and I/O-waiting graphs | 125 | +0.10 ms | +0.53 ms |

Short synchronized groups of 32 in the final comparison lost 21.54% throughput.
The longer burst trial above provides the less noisy estimate. Both missed the
2% target. Sustained near-capacity trials on the four-slot profile also missed
it (6.17% mean loss with a wide upper bound of 15.39%).

These results held the initial implementation for a burst-throughput repair.

### Burst-throughput repair

Keep the eight admitted metadata operations and the 96-waiter limit for a
ten-connection pool. Each admitted request owns its invalidation snapshot,
access check and run permit. Only the parameterized metadata statement can
serve more than one caller. It returns rows by normalized endpoint name.
No caller can enroll in a statement that has already started. An incomplete
history row fails the affected name, while missing names produce their
ordinary not-found response. A storage failure reaches the callers that
shared that statement. The next lookup can start immediately after settlement.

Faster lookup dispatch also exposed the four-distinct-release cold I/O limit.
With 32 separate cold publications, the metadata-only repair completed five
runs in one trial and the baseline completed nineteen. The other requests
received the cold-artifact busy response. The final implementation keeps
four reads active. An admitted public run may wait up to one second alongside
at most 27 other distinct release keys. Equal immutable keys share a promise.
Queue overflow and expiry keep the existing busy response. Internal callers
cannot enqueue new keys. Invalidation still gets checked after loading.

The SQL regression test holds a dispatched multi-name read open, changes
access and checks that a later caller starts a new read. The PostgreSQL
integration suite exercises two real publications, a missing name, a repeated
name and broken history in two SQL statements. The cold-load test holds all
four readers and verifies FIFO handoff, deduplication, expiry, capacity,
reader failure and recovery.

The final compiled API and the original `5d93500b1` baseline ran on identical
local CPU and memory quotas. Both API builds used the same two CPU cores.
PostgreSQL and the independent HTTP client ran on separate cores. The
eight-block qualification alternated build order, validated every HTTP
output and completed 511,571 baseline and 572,154 candidate requests.
Counts differ in the fixed-duration capacity tests. Recording was disabled
for timing. A separate recording-enabled test verified that admitted graphs
persisted and pre-admission rejections created no recordings.

| 32 simultaneous requests | Mean throughput gain | Mean p95 change | One-sided 95% upper p95 change |
| --- | ---: | ---: | ---: |
| Two warm endpoint names | 14.29% | −1.11 ms | −0.58 ms |
| 32 distinct warm endpoint names | 15.78% | −1.63 ms | −1.23 ms |

All 32 distinct cold publications completed in the final candidate check.
The baseline completed 25 and returned the existing cold-release busy response
to seven. Fresh-access checks also passed after committed private, unpublished
and republished changes with cache notifications withheld.

**Local performance qualification passed.** The initial eight pairs left two
latency bounds inconclusive. Twelve longer pairs for those cases independently
passed, and all observations were retained. Across 1,304,909 successful
responses, all eleven profile/workload combinations cleared both one-sided
95% limits of 0.5 ms added p95 and 2% lost successful throughput. The largest
upper latency bound was +0.42 ms (four-slot bursts). The largest upper
throughput-loss bound was 1.08% (single requests on the 32-slot profile).
Production-profile scheduled traffic at 125 requests/s measured −0.18 ms
added p95 for tiny graphs and +0.19 ms for mixed graphs, with upper bounds of
−0.03 and +0.33 ms respectively. These figures describe the synthetic local
workloads.

Under a one-second database lock and 256 simultaneous calls, the candidate
peaked at eight admitted lookups and 96 waiters. An unrelated query on the
same pool finished in approximately 1 ms before unlock. The baseline query
took 1,028 ms. With a healthy database and all run slots occupied, 32-, 64-
and 96-request bursts preserved the baseline's 404 and 429 distributions.

### Recheck after the invalidation and disconnect fixes

Eight alternating local comparisons against `5d93500b1` completed 614,400
timed HTTP requests with correct graph output and zero errors. Both profiles
ran synchronized bursts and scheduled tiny and mixed traffic. The 32-slot
profile also ran bursts across 32 distinct names. All seven cases passed
the same one-sided 95% limits. At 125 requests/s, the upper bounds for added
p95 were 0.461 ms for tiny graphs and 0.252 ms for mixed graphs. Bursts of 32
improved mean throughput by 23.9% across two names and by 17.0% across 32.
With a one-second database lock, the revised API capped active lookups at
eight and queued lookups at 96. An independent same-pool query completed
in 0.92 ms before the lock was released.

The route tests hold a single execution permit to check saturation, auth and
hidden endpoints. Request-volume comparisons use the separate burst benchmark.
The race tests hold database or artifact reads at the handoff, observe the
server-side socket close before releasing a disconnected lookup, and advance
the invalidation clock explicitly. After pruning, a lookup that might have
missed a discarded change must retry. A later lookup can proceed. Shared SQL failures reach every enrolled caller, and the next caller
can issue a fresh read.
