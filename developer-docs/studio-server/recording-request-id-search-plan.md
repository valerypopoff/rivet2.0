# Faster recording input searches without database changes

Status: implemented and locally validated, November 11, 2026.
The read-only production observation below is unchanged. No deployment, new
production search/benchmark, database change or backfill has been performed.

The reported slow journey is **Run recordings -> Project: Any ->
`$.request_id == somevalue`**. Other input paths/operators and the outcome-only
filter remain compatibility cases, not reasons to build a generic search system.

## Combined delivery plan

This is one implementation, combining less repeated work, compact caching and
faster loading/reading. The phases below are local checkpoints, not six separate
deployments or cloud-test campaigns.

| Order | Change | Main benefit |
| --- | --- | --- |
| 1 | Reuse the production observation; add missing local phase measurements | Establish which work actually costs time |
| 2 | Read minimal candidates; count once and enrich only matches | Less repeated work in cold and repeat searches |
| 3 | Cache request IDs with bounded capacity and useful expiry | Reuse more than 20,725 inputs without retaining full payloads |
| 4 | Process more work per continuation and keep the existing download/parse pipeline busy | Fewer tiny browser round trips, especially on cold searches |
| 5 | Increase only the measured download or parsing bottleneck | Additional parallelism where it improves throughput |
| 6 | Verify the combined result and compare cold/repeat performance | Same complete results, responsive Stop and bounded memory |

The first optimization targets parsed root `request_id` equality. Other filters
keep their current behavior. Optimize production's managed metadata queries;
change local-storage readers only where required by the shared cache interface.
Do not turn this into a rewrite of every recording backend.

Measure cold cases with the cache reset and repeat cases with the same cache
retained. Otherwise the cache improvement can hide an ineffective loading change.
Land the measured settings and fixes together after local validation. Publishing
and deployment remain later, separately authorized steps.

## Constraints

- No database changes: no new tables, columns, indexes, migrations, stored input
  projections, database backfills or persistent database-setting changes.
- Existing read queries may be improved. Recording persistence, artifact format,
  replay, retention and SQL ownership remain authoritative and unchanged.
- Reuse the existing scanner, bounded input cache, extraction workers and API.
  Do not add another search service or an object-store index disguised as a cache.
- Preserve the existing filter semantics, global newest-first order, root scope,
  cancellation behavior and complete results. Do not replace Any with a recent-only or
  selected-project search, hide read errors, or stop after an arbitrary limit.

## Read-only production findings

Cloud Logging was queried with explicit November 11 UTC bounds 12:00-13:40,
retrieving all five result pages: 4,419 Any recording-run access entries. Raw
query values remain only in ignored private audit artifacts; they are not copied
into this document. A broader ascending CLI sample was excluded from this
analysis because its freshness flag did not enforce the intended time boundary.

The latest distinct `$.request_id == ...` request chain:

| Observation | Result |
| --- | --- |
| First to last logged response | 12:55:12-13:26:34 UTC; 16:55-17:26 Asia/Tbilisi |
| Observed span | 31 minutes 21.889 seconds |
| Requests / HTTP status | 3,528; all HTTP 200 |
| Incoming scan cursor | 0 to 20,725 |
| Mean cursor advance per continuation | 5.88 recordings |
| Continuations advancing only one recording | 1,029 of 3,527; about 29% |
| Median / p95 completion-to-completion gap | 474 / 993 ms |

These are logged response gaps, not measured individual request latencies. The
last incoming cursor is not the last response body; neither final match count
nor complete search exhaustion can be proved from these access logs.

During that chain, approximately one-minute Monitoring samples showed backend
CPU averaging 0.63 cores, peaking at 0.92 cores, and non-evictable memory peaking
near 868 MiB. Cloud SQL CPU averaged 38.7%, peaking at 60.3%; its memory utilization
remained near 50%. Cloud SQL serves other clients, so those figures do not
attribute its work specifically to the recording queries. The later live snapshot
had six ready Pods and no container restarts on those Pods; it is not a historical
availability proof for replaced Pods.

The access logs contain no per-request latency or SQL/object/parse breakdown.
Cloud Monitoring exposed no Rivet-prefixed Prometheus metric descriptors, and
the returned Cloud SQL configuration did not enable Query Insights. Exact phase
timing and cache hit/eviction counts remain unmeasured; resource utilization alone
does not establish the dominant function or justify resizing services.

There is now a concrete working-set constraint: the production singleton uses
the fixed 16,384-entry, five-minute cache defaults. A scan already past 20,725
recordings cannot fit in that entry limit even if every input is tiny. Entries
loaded early in a 31-minute scan also expire before it finishes. This makes an
assumed fully warm repeat scan invalid. It is evidence for reviewing projection
entry/TTL limits, not a measurement of actual evictions or an excuse to retain
unbounded full inputs.

## Pre-change implementation used for the baseline

1. `useRunRecordingsController.ts` sends an initial input request for 20 matches
   by default, then sequential continuations requesting at most 100 matches. It
   continues until exhaustion or an explicit stop. These are not 100-record scan
   limits; sparse searches can examine many more candidates.
2. `workflowApi.ts` sends Any to `/api/workflows/recordings/runs`, omitting a
   project restriction. This is already one globally ordered query, not a loop
   over projects. Input searches use non-Subgraph roots.
3. Managed `listWorkflowRecordingRunsPage()` calculates root/outcome counts on
   every request, including continuations. Its metadata windows select the full
   recording projection and compute `has_sub_runs` for candidates before knowing
   which candidates match the input predicate.
4. `filterRecordingInputWindows()` starts at 24 candidates or the requested page
   size, grows windows to 256, and has a 150 ms scheduling budget. It already
   batches windows and uses keyset continuations. Candidate queries consume that
   budget; the earlier scope-count query adds latency outside it. The budget does
   not terminate an already-started slow read. If a candidate query uses up the
   budget, it still reads one candidate to ensure cursor progress.
5. On a cache miss, managed search fetches the recording object, decompresses it,
   parses its complete JSON and string table, extracts the captured start input,
   and applies the JavaScript matcher. At most eight artifact loads are admitted
   per process, with a weighted memory cap; extraction uses one or two workers.
6. The existing cache retains the full extracted input, not just `request_id`:
   default 32 MiB, 16,384 entries, five-minute TTL, maximum 1 MiB per entry. Large
   inputs, expiry and working sets larger than retention can make repeat scans
   download and parse the same recordings again.

The managed `queryRows()` helper has no request signal or statement timeout.
Scanner/artifact cancellation does not prove an active SQL query was canceled.
The graph-reference helper has different admission, timeout and error semantics;
it is not a drop-in recording-search helper.

Consequently, a cold Any input search can require an artifact read for every
retained root until its cursor exhausts. There is also avoidable repeated SQL and
candidate-decoration work. The relative production costs have not been measured;
the available telemetry does not prove whether object I/O, SQL or parsing
dominates this installation. Earlier SQLite/VM catalog diagnoses are not a
production-GCP timing baseline for this code.

## Assumptions checked and resulting decisions

| Assumption | Finding and decision |
| --- | --- |
| Any loops over projects | False: it already queries globally. Keep that path. |
| Larger SQL windows alone mean faster downloads | False: scheduling, load admission and parsing impose separate limits. Measure useful throughput. |
| Every request ID is small | Not guaranteed: values may be large strings, objects or arrays. Use bounded scalar projections with exact fallback. |
| Projecting after `getOrLoad()` removes full-input cost | False: it already stores/clones full inputs. Select the retained view before those steps. |
| A five-minute cache can keep this history warm | False for a 31-minute scan; its 16,384-entry cap is also below the observed working set. Size and expiry both matter. |
| Every source key is immutable | Content-addressed managed/local artifacts are; legacy raw keys and filesystem stat keys do not give the same guarantee. Extend expiry only for trusted immutable identities. |
| Search results form a fixed database snapshot | False: continuations are live keyset reads. Preserve their current insert/delete behavior and label counts as estimates. |
| Browser Stop cancels active SQL | Not established by the current helper. Stop further work, retain ownership of pending reads, and test the actual cancellation limits. |
| Spare average CPU justifies more parsers | False: averages do not establish quota, queue or peak-memory headroom. Make parallelism conditional on measurement. |
| Removing extraction work proves an end-to-end multiplier | False: SQL, network, HTTP and cold decoding remain. Compare the complete path. |

## Implementation sequence

### 1. Establish the relevant baseline before changing runtime behavior

The read-only observation above provides the initial production progress/resource
baseline. The remaining baseline work is phase attribution, cache diagnostics
and controlled comparisons, not another long production search.

Use the actual `request_id` equality predicate and the verified deployed source
as the baseline. Reuse its image or compile the pinned source locally; a new
published image build is not a prerequisite for comparing the code paths.
Measure cold and repeat searches separately, with one project and Any. Distinguish
time to the first result, first 20 matches and search completion; a selective
request ID and an absent ID must both be covered. Dense repeated IDs are a
separate result-volume case. Report first-20 latency as unavailable when fewer
than 20 matches exist; do not mistake that for an unfinished scan.

Capture request count, scanned candidates, metadata/count/decorating query time,
artifact reads/bytes, extraction time, cache hits/evictions/oversized entries,
API CPU/event-loop delay and retained memory. Existing metrics cover HTTP,
object I/O, cache events and extraction. Add only the missing fixed-cardinality
timing/counter hooks; never log real inputs, request IDs, paths or filter values.

Missing production phase timings are an uncertainty, not a prerequisite for
local implementation. Use existing observations and controlled local timings;
do not wait for a new instrumentation deployment or run another exhaustive
production scan. Any live query-plan inspection needs separate read-only scope;
use local/disposable fixtures for expensive comparisons.

The existing benchmark is useful for scanner/extractor checks but hardcodes a
single SQLite workflow. Extend its fixture/adapter to exercise Any and managed
PostgreSQL reads using the existing disposable integration setup and current
schema. Fixture data is local, never a production backfill or schema proposal.
Do not present old one-workflow or simulated object-delay results as GCP evidence.

### 2. Remove repeated metadata work from the input-search hot path

Owners: managed `recordings.ts`, shared scope/matching contracts and their query
tests. Keep ordinary browsing and other backends unchanged unless a shared
interface requires a compatibility adaptation.

- Add a minimal candidate projection containing only recording/source identity,
  exact cursor timestamp, owner/scope/status data and read-size estimates. Do not
  calculate child presence or hydrate display/replay metadata for non-matches.
- Once the matcher selects IDs, fetch/enrich only those matched rows in one
  bounded metadata query and restore their exact scanner order. Recheck scope,
  outcome and source identity before presenting a row. If a selected recording
  was deleted or its source changed, omit the stale match; the page may underfill.
  Keep the scanner's last consumed boundary, analyzed count and exhaustion flag.
  Do not rewind, skip an unconsumed candidate or claim an exact match total after
  dropping rows. Retain ordinary browsing and expanded-family semantics.
- Compute search-scope counts for the initial request, not again for every
  continuation solely to animate progress. Preserve the initial scope estimate
  in the controller's active search generation, including when React batches the
  initial response and a count-free continuation. Clear it when scope/filter
  changes and preserve deletion adjustments. Never confuse matches, analyzed
  candidates and available roots. Validate existing callers because `scopeCounts`
  is already optional; use that contract without adding a search session or a
  mandatory new parameter. Leave exact ordinary page counts unchanged. Identify
  the initial request using both keyset and legacy cursor fields, not page number.
  Validate the filter-bound cursor before issuing the count or candidate query.
- Reuse existing indexes and keyset boundaries. Compare actual query plans and
  rows read; do not add indexes or assume workflow-leading indexes are ideal for
  Any. Do not move an equally expensive whole-history grouping into another
  per-candidate expression.
- Check cancellation before and after each count/candidate/enrichment query;
  never begin another read or retry after cancellation. With the current managed
  helper, an active read can settle after Stop. Keep its lease/admission owned
  until settlement; do not race a timeout and release/reuse a busy connection.
  Do not promise immediate SQL cancellation or copy the graph-reference query
  framework into this feature. If measurements require active-query cancellation,
  resolve it explicitly before claiming a bounded server-side Stop time. No
  persistent database settings change is included. Thread the request signal
  through the existing retry boundary so an outer cancellation check cannot be
  bypassed by its internal connection-error retries.

This can improve cold as well as repeat searches: less count/decoration work per
response. Removing candidate decoration also frees scanner budget; removing the
earlier counts reduces latency outside that budget. Measure these separately
before changing scan budgets or increasing parallelism.

### 3. Retain a tiny request-ID projection in the existing process-local cache

Owners: `recording-input-cache.ts`, `recording-input-filter.ts`, managed/SQLite/
filesystem recording readers and cache invalidation tests.

- Select this fast path only for equality on the parsed single property
  `request_id`, including equivalent bracket notation. Retain captured-root and
  property-presence flags plus the exact supported scalar value/type. Oversized
  strings and non-scalar values use the existing full-input matcher; never
  truncate, stringify them into keys or silently return a non-match. Other
  paths/operators retain full-input behavior.
- Keep a private, explicitly typed projection separate from full input. Its
  process-local cache instance is replaced with the code; no persistent version
  or artifact-format change is needed.
  Project before cache storage and per-consumer cloning. Calling today's full
  `getOrLoad()` and projecting afterward still stores/clones the large payload
  and does not satisfy this change. Preserve values with the existing lossless
  in-process serialization rather than JSON round-tripping undefined/non-finite
  numbers. The first cold read still extracts full input through the current
  worker; changing its wire format is not required for this optimization.
- Reuse the existing source key (managed storage owner plus recording blob key,
  or filesystem stat/content identity). Share in-flight artifact reads and the
  current admission/worker limits with full-input consumers. A shared cold load
  returns full extraction internally; each consumer chooses its view before
  retention/cloning. A projection-only search must not automatically retain the
  full input, and a full-input consumer must never receive a partial projection.
  On a projection miss, reuse a valid cached full input before downloading its
  artifact again. Materialize only the requested view for the caller.
- Cache the extracted property independently of the searched value, so changing
  request IDs reuses it. A large unrelated input must not prevent retaining a
  small request ID. Keep one explicit aggregate retained-byte budget across both
  views; do not silently double the existing 32 MiB allowance by adding a second
  independent cache. Honor the configured byte limit, including zero disabling
  both views. Bound projection entry count, value size and TTL; account
  for keys/wrappers in measured RSS. Choose limits from the measured history
  size rather than simply raising the full-input cache budget. Cover at least
  the observed 20,725-root working set with headroom and a repeat after a search
  longer than five minutes. Fixed expiry must cover the longest measured cold
  scan plus the repeat window, not merely the planned faster scan. Check that a
  full-input search cannot evict the entire projection working set despite that
  budget; choose a bounded reservation if the mixed workload demonstrates it.
- Longer expiry is permitted for verified content-addressed managed artifacts
  and SQLite hashes. Legacy managed raw keys and filesystem path/size/mtime
  identities retain their current freshness policy unless equivalent immutability
  is proved. Existing stat keys alone do not prove immutable content. Deletion,
  retention and source/namespace invalidation must affect both views. Test reset
  and reopen at the same storage path: SQLite's current namespace is path-based,
  while managed namespaces use the storage owner object. Keep reset fencing
  explicit; do not rely on a longer TTL to hide stale data. Errors are not
  cacheable non-matches.
- Use the existing matcher with an explicitly reconstructed input/projection
  adapter, retaining captured-input semantics. Numeric-looking strings, missing
  keys, undefined, null and booleans must remain distinct where the matcher makes
  them distinct. Do not replace matching with a string cast or SQL equality.
- Do not start loading all historical recordings when opening the modal or
  recording a new run. Execution-worker-local warming does not automatically
  warm the separate control API that serves this modal.

This makes repeat request-ID searches cheaper and covers histories whose full
inputs cannot fit in the current cache. It does not remove artifact reads from a
completely cold search and does not survive process restarts.

### 4. Use larger useful batches and preserve pipeline overlap

Keep sequential keyset continuations: parallel HTTP pages cannot independently
know the next safe cursor. The backend already performs bounded concurrent reads;
blindly adding more HTTP requests or workers can duplicate work and increase RSS.

The pre-change eight-slot cap covered the entire download/extraction lifetime, and a
256 MiB estimated-load budget can admit fewer slots for larger artifacts. Parsing
has one or two workers depending on available CPUs. The 150 ms scheduling budget
can also end admission before those slots perform much useful work. Increasing
the nominal metadata-window size alone does not remove any of these constraints.
The byte budget is an estimate, not an RSS ceiling: the current admission rule
allows one oversized load to run alone. Include that case in peak-memory tests;
do not claim a hard memory bound from the configured weight alone.

Use a small sequenced local experiment, not a large configuration matrix:

1. Keep the current policy as baseline. First apply the minimal metadata path
   above; attribute the removed count latency and scanner-window work separately.
2. Compare the baseline budget with 500-1000 ms continuation scheduling budgets,
   retaining fast initial discovery, the same concurrency and the current byte
   admission bound. These are experimental values, not selected defaults or
   forced minimum response durations. Return a completed page earlier and honor
   explicit cancellation throughout. Keep per-request candidate, match and
   metadata-window caps, and yield to other requests during warm-cache scanning.
3. Measure whether those longer batches keep the current download/parser slots
   useful and reduce requests per consumed candidate before increasing load
   slots or parser count. Preserve initial-result latency as a separate outcome.

Measure useful candidates per response, artifact GETs per consumed candidate,
bytes in flight, parsing queue time, worker starts/terminations, first-result
latency, completion, Stop latency, CPU and RSS. Fetching, decoding and matching
can overlap, but ordered consumption must still determine the cursor.

Also check the existing 250 ms page-completion handoff grace. Speculative admitted
work is canceled when no continuation adopts it in that interval; active worker
cancellation can terminate a worker. Establish whether repeated page boundaries
actually discard useful work or churn workers before changing this policy. Reuse
bounded in-flight work only; explicit Stop/close and abandoned searches must not
become a permanent background scan. This is a hypothesis to measure, not a
confirmed explanation of the production latency. Adjust the handoff only if
discarded work is demonstrated; do not build a new background-search subsystem.

### 5. Add parallelism at the measured bottleneck

Use the lean metadata path and selected continuation policy from phase 4.

- If storage wait dominates while parser capacity remains available, compare
  one bounded increase in load slots, for example eight to sixteen. Retain byte
  admission and measure actual peak RSS, including the single-oversized-load
  exception; a file-count increase must not be treated as permission to double
  decoded memory.
- If extraction queues dominate instead, test one additional parser only with
  measured CPU/memory headroom. Keep downloads and parsing overlapped, without
  creating an unbounded queue of downloaded recordings awaiting extraction.
- Change one limit at a time. Retain an increase only when it improves useful
  throughput without worsening first-result/Stop latency or resource bounds.
  If extra concurrency provides no benefit, keep the existing limit; the other
  phases still form the delivery.

If cold object download/decompression still dominates, report that limit
explicitly. Larger batches reduce round trips and repeated setup; more download
slots cannot exceed parser or memory capacity. A persistent lookup or changed
recording format would be a separate proposal, not silently added to this
no-database-change implementation.

### 6. Validate the combined behavior and performance locally

- Differentially compare exact ordered IDs from the old and optimized paths for
  recent, sparse, dense and absent request IDs, Any and one-project scopes, All
  and failed/warning outcomes, and roots versus child-family expansion.
  Compare ID/order equality on an unchanged fixture. For concurrent writes, test
  explicit live-keyset invariants rather than demand a snapshot this API does
  not provide: no duplicates or skipped still-eligible older rows, and no stale
  source result after enrichment. Newer insertions appear on a fresh search.
- Verify match semantics including numeric `42` versus searched `'042'` (matches),
  stored string `"042"` versus searched numeric `42` (does not), strings versus
  booleans, null, missing properties, undefined and named-input fallback. Include
  serialized string references and equivalent bracket/dot paths.
- Test full/partial cache sharing, entries above the full-input limit, eviction,
  TTL, mixed-view eviction pressure, configured cache disable, concurrent
  searches, cancellation, process reset and reader errors. Include object/array
  and oversized request IDs falling back without changing results. Use
  at least 25,000 compact source identities for count-capacity cases and an
  injected clock for long-search expiry; keep large-artifact real-worker cases
  separately bounded instead of allocating huge recordings for every identity.
- Test keyset ties including PostgreSQL microseconds, mixed old/new cursor fields,
  concurrent insert/delete/retention, stale counters and query progress. Preserve
  real failures and source identity checks; no false empty-success response.
  Exercise deletion/source change between matching and enrichment, canceled
  metadata reads and canceled retry delays. Report UI Stop latency separately
  from settlement of already-started SQL or an uncancellable compatibility read.
- Assert that non-matching candidates do not trigger child-presence decoration,
  and continuations do not perform repeated counts. Cover real managed SQL with
  realistic correlations, not only string-matching SQL mocks.
- Run affected API tests, test-manifest/shard checks and headless
  `run-recordings-modal.spec.ts` through the repo Playwright runner after behavior
  changes. Extend the existing browser fixture for preserved progress across a
  count-free continuation, Apply/Stop, replacing a search and reopening a replay.
- Benchmark the production compiled worker path on Linux with the CI Node
  version and representative CPU/memory, as well as source-mode correctness.
  No Kubernetes rehearsal is required for these UI/API changes.

Before tuning, record repeatable baseline and optimized measurements on the same
fixtures, runtime, CPU/memory limits and simulated storage conditions. Use real
PostgreSQL for metadata cost and the compiled worker for extraction cost. Report
the components and complete HTTP/controller journey, not a sum of overlapping
phase timings. The observed 31-minute production chain is context, not a matched
before/after benchmark or an absolute performance acceptance threshold.

Target a substantial cold improvement and several-fold repeat-search improvement
above the old cache capacity. Exact speedup remains a measurement outcome. The
deterministic acceptance checks are: identical results, no counts on managed
continuations, no decoration of non-matches, retained small projections across
the measured working set/expiry window, and no artifact reads in an unchanged
fully covered repeat equality scan. Include exceptions/fallbacks explicitly.
Compare first-result latency, request count, completed candidates/second and
CPU/RSS; reject tuning that gains throughput by starving Stop or other API work.
Wall-clock benchmark outcomes are reports, not flaky CI timing asserts. If cold
gains are small, report the measured bottleneck before adding complexity or
claiming the goal is met. A cold unindexed absent-ID search still has linear
artifact work; this plan cannot guarantee seconds for every historical search.

## Local assumption check already completed

An ignored diagnostic under `artifacts/recording-search-analysis-20261111/` uses
the current source extractor/matcher. On Windows Node 22.22.3, 256 synthetic gzip
recordings with 128 KiB of unrelated repeated content took a median 74.18 ms to
extract and match, versus 1.28 ms to parse/match already prepared small inputs.
All ordered IDs and seven comparison-semantics cases agreed.

This demonstrates avoidable extraction work only: it excludes SQL, object-store
latency, HTTP, worker transfer and production CPU limits. It is not an implemented
cache optimization or a production speedup measurement.

## Completion and rollout

### Implementation reconciliation

| Phase | Delivered locally |
| --- | --- |
| Baseline and timings | Added a disposable PostgreSQL benchmark with real HTTP continuations, compiled extraction, five project owners, child correlations, cold/repeat/changed-ID cases and bounded fixture sizes. Added fixed-label count/candidate/match query timing. |
| Metadata | Input search selects minimal candidates, counts on the initial request only, then decorates only matches. Final hydration rechecks source/timestamp and preserves consumed cursors if a row disappears. Ordinary browsing is unchanged. |
| Cache | Request-ID equality uses a scalar projection before full-input retention/cloning. Full/projection consumers share reads. Both views share the configured byte budget; projections are limited to 32,768 entries and 75% of that budget. Verified immutable sources use one-hour expiry; raw/filesystem-stat identities keep five-minute expiry. |
| Batching | Initial discovery remains 150 ms; continuations can schedule for 500 ms and still return early. Window, match and candidate caps and event-loop yields remain. |
| Parallelism | Local comparison retained 16 reads instead of 8 under the same 256 MiB estimated-load budget. Parser count remains one or two. The 250 ms speculative handoff was left unchanged: no duplicate reads were observed in the benchmark. |
| Compatibility | Added 25,000-entry/long-scan tests, mixed-view memory and invalidation cases, type-sensitive matching/fallback cases, metadata cancellation and retry checks. Browser fixtures now omit counts on continuations to exercise the new contract. Final check results are recorded in the owning performance document. |

The benchmark compared the same 800-root fixture with 64 KiB captured inputs,
3,200 child rows and 10 ms simulated artifact-read latency. PostgreSQL and
compressed artifact extraction were real; remote GCS latency and production
load were not reproduced. These are local measurements, not a GCP speedup claim.

| Any search | Before | After | Artifact reads before / after |
| --- | ---: | ---: | ---: |
| Cold | 2,129 ms | 1,227 ms | 800 / 800 |
| Repeat | 1,762 ms | 22 ms | 800 / 0 |
| Different ID after the scan | 1,701 ms | 21 ms | 800 / 0 |

Cold HTTP requests fell from 13 to 3. First-match latency was approximately
221 ms before and 214 ms after, including initial worker startup. Counts fell
from 13 to 1 and child-presence queries from 13 to 1 for the cold case. The
intermediate eight-reader/500 ms experiment reduced requests to five but did
not materially reduce completion time, which justified the bounded read increase.

### Remaining release work

1. Commit the reviewed code, tests and documentation to `develop`. Preserve raw
   reports under ignored `artifacts/recording-search-implementation-20261111/`
   and `artifacts/recording-search-completion-20261111/`; keep the local CI
   recurrence checklist out of Git.
2. Require the normal GitHub workflows to pass for that exact revision. Local
   validation does not substitute for hosted CI or final-image checks.
3. Use the established release process when separately authorized. Observe the
   real query latency and API memory after rollout.

There is no schema release, database/index backfill or historical artifact rewrite.
Existing history works immediately; its first targeted search remains cold.
Rollback requires only the prior application version; no data rollback is needed.

Local acceptance: 138 affected API tests, 70 compiled Node 24/Linux tests,
14 headless browser checks, 20 browser-side unit tests and the real
PostgreSQL/SQLite integration passed. API compilation, the web build, root style
and import-boundary checks passed. A separate optional full-API sweep was stopped
during unrelated legacy-storage migration rehearsals; it is not reported as a
passing full-suite run. Its earlier build-order/Windows permission failures
passed a 105-test targeted recheck after prerequisites were ready.

Follow-up review: fresh reads now retire stale views, source-verification trust
cannot be upgraded by cache hits or later in-flight consumers, and projection
replacement does not unnecessarily evict full inputs. Regression cases failed
before these fixes and passed afterward. The current review passed 148 affected
API tests, 80 compiled Linux tests and five targeted headless browser checks;
type, test-style, documentation and import-boundary checks passed as well.

### Final completeness audit

The implementation was already present, but the original benchmark covered only
a recent match and a warm absent value. The following remaining local validation
work is now complete; this does not claim live production qualification.

| Plan requirement | Final evidence |
| --- | --- |
| Recent, sparse, dense and absent IDs; Any/one project; All/failed-warning outcomes | The managed benchmark now supports the four patterns and both outcome filters. Eight configurations passed, each with two scopes and cold/repeat/changed-value searches: 48 complete, exact ordered-result checks against both the fixture and an uncached full-metadata/full-input reference. Every covered repeat used zero artifact reads. |
| First result, first 20 matches and completion | Reports include all three; first-20 is explicitly null when fewer than 20 results exist. Dense cases exercise populated first-page timings. |
| Stage timing and cancellation | Reports split count/candidate/match query time, artifact reads and decode/parse/worker queue time. Eight held-read Stop checks passed, reporting client cancellation and server settlement separately. All eight local fixtures settled within 20 ms; active production SQL can still take longer. |
| Compiled Linux performance | The existing benchmark accepts `--input-property request_id --scope any`. Node 24.22.1 with Docker limits of two CPUs/1.5 GiB passed a 600-record, five-project, 64 KiB-input run. Cold completion was about 1,000 ms and repeat completion 22 ms; concurrent cold searches shared 600 reads rather than doubling them. This run uses SQLite metadata; real PostgreSQL is checked separately. |
| Actual input-query plan | The disposable PostgreSQL integration checked 50,000 history rows. Candidate queries returned a bounded 25-row window without child aggregation, and continuations did not repeat counts. No indexes or application database settings were changed. |
| Fast browser continuations and lifecycle reset | A zero-delay, count-free continuation browser case preserves root-only totals. The real SQLite adapter test proves close/reopen rereads the recording instead of retaining its previous cache entry. |

The Linux report's `availableCpus` is OS affinity, not a cgroup CPU allowance;
the two-CPU limit comes from the recorded Docker invocation. These additional
reports are under ignored `artifacts/recording-search-completion-20261111/`.
The final pre-push pass also completed the full root style lane after the last
test additions, CI formatting, API/web typechecks, compiled workspace exports,
dependency-loader consistency and API test registration. Only publication,
authorized deployment and observation of real GCP latencies remain.

## Research checks

The PostgreSQL references reinforce why neither a workflow-leading metadata
index nor generic JSON indexing should be assumed to solve this predicate:
[multicolumn indexes](https://www.postgresql.org/docs/current/indexes-multicolumn.html),
[JSON types and indexing](https://www.postgresql.org/docs/current/datatype-json.html).
They are background reasoning only; this plan creates no database index or JSON
storage. Existing code remains authoritative for Rivet's matching semantics.
