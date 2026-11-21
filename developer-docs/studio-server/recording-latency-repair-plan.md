# Recording latency repair plan

Status: whole-change review completed locally, 2026-11-21.
The strict performance gate remains inconclusive; release readiness is held.
No cloud test or deployment ran. Results below supersede prospective instructions
when deciding what work is already done.

The [performance history](recording-performance-completion-plan.md),
[worker assessment](recording-encoder-worker-plan.md) and
[property-view assessment](recording-combined-preparation-plan.md) preserve
previous results. Their old experiment instructions are historical, not
additional implementation queues.

## Whole-change comparison with the last commit

The whole-change review compares the current uncommitted implementation with
`95155d385`, not with an intermediate recording candidate. The frozen original
matches that commit's sixteen changed runtime source files and four package
manifests; its compiled fingerprint is unchanged. The current frozen serving
fingerprint is `7ea1946fa4e9136d22cd0e238970ef44f59323b02ad297c34a7dff4e5b5d9c3d`.

The reliability improvements are real: active captures, queued payloads and
writer preparation share a memory budget; failed setup and queue admission
release ownership; capture failures preserve known execution outcomes and costs;
and explicit settings refreshes install the correct revision in every request
context. The existing persistence queue is reused. No encoder worker, second
queue, new storage format or schema migration was added by this change set.

Two fresh comparisons used the same cached image, PostgreSQL settings, isolated
PostgreSQL/MinIO data, 2 CPU/4 GiB and the execution API profile:

| Workload                                           | Before p95 | Current p95 | Paired pooled-p95 difference interval |
| -------------------------------------------------- | ---------: | ----------: | ------------------------------------: |
| 100-node bursts, 32 outstanding requests, 16 pairs |  111.01 ms |   107.80 ms |                    -16.04 to +6.06 ms |
| Mixed 1 MiB/small requests, 16 arrivals/s, 8 pairs |  305.45 ms |    11.65 ms |                 -308.36 to -255.33 ms |

Small requests within the mixed workload improved from 311.69 to 4.86 ms p95.
All 3,712 recordings, including warmups and both builds, passed the complete
content/snapshot audit. Every final capture reservation and execution permit
settled, with no recording rejection in these healthy workloads.

The whole change is **not better in every measured dimension**. In the 100-node
case, mean maximum event-loop delay while serving requests rose from 13.84 to
26.21 ms, even though whole-batch CPU fell from 726.53 to 698.14 ms. Full
completion/drained time was 1,492.45/1,519.15 ms, with an inconclusive difference
interval. The primary p95 interval also crosses zero, so the strict no-slowdown
gate remains open. The mixed-workload improvement cannot override this result.

The admission limits deliberately refuse oversized/over-budget recordings to
protect execution and subsequent captures. Retained-memory values are estimates,
not a cap on the whole process, opaque closures or arbitrary workflow allocations.
Encoding and fresh memory inspections still perform synchronous work. Those
limits and trade-offs must remain visible when describing release readiness.

The review reran 249 relevant API, Core and benchmark-support tests successfully.
The real PostgreSQL/MinIO integration also passed abrupt process exit, lost
acknowledgements, immutable-write recovery, deletion races, legacy/shared replay,
compaction, blocked recording writes and normal API/editor capture. There was no
cloud test, deployment or database change outside the disposable local fixtures.
Changed-line lint found one updated WebSocket test registration missing `void`;
that CI lint defect was corrected without changing its assertions or behavior.
No additional runtime correctness defect was found. Evidence is under
`.data/recording-whole-review-20261121/`, including the checked source manifest,
both comparison receipts, test logs and `assessment.json`.
Commit preparation also passed the full root `test:style` suite, scoped
changed-line lint and API, desktop frontend and CLI builds. Generated browser-log
additions were excluded; cleanup did not change the measured runtime behavior.

## Settings-sharing isolation

The previous comparison's longer event-loop delay was consistent, not just one
outlier: mean per-batch maximum delay was 69.91 ms with unbounded sharing versus
15.30 ms on the original build. An isolated comparison changed only queued
settings-check sharing; both sides retained the request-snapshot correctness
repair and identical recording-memory/codec code. Disabling sharing reduced
maximum delay from 76.74 to 16.40 ms, but increased request p95 from 100.72 to
121.01 ms (difference interval +18.16 to +28.71 ms). Sharing was the cause of the
additional pauses in this workload, but removing it sacrificed its queueing gain.

Two other local candidates were rejected. Limiting a shared read to four callers
reduced pauses but increased p95 from 105.38 to 118.47 ms, with a positive
last-response-completion interval. Sharing one read and yielding between groups
of four increased p95 from 110.24 to 127.27 ms (difference interval +14.83 to
+41.73 ms). Neither candidate remains in serving code.

The retained fix limits each queued freshness read to **eight callers**. A full
32-request burst therefore cannot resume from one shared read. It uses the
existing operation queue; it adds no scheduler, timed cache, environment flag,
storage format or service. Running reads cannot be joined, queued writes still
break sharing, and every caller installs the exact returned revision in its own
request context. This limits a shared completion's fan-out, not the duration of
arbitrary workflow code or the configured execution concurrency.

The compiled final source was compared with the previous unbounded-sharing build
in 16 alternating pairs, using PostgreSQL settings, the execution API profile,
2 CPU/4 GiB, 32 outstanding requests and 64 100-node runs per batch:

- Mean per-batch maximum event-loop delay: **68.26 to 27.26 ms**; maximum across
  all measured batches: **82.51 to 43.22 ms**. All sixteen paired batches had
  lower maximum delay with the fix.
- Pooled request p95: **99.72 to 100.99 ms**, difference interval **-8.71 to
  +25.73 ms**. This is inconclusive, not proof of zero slowdown.
- Full completion/drained time: **1,523.94 to 1,464.57 ms**, paired difference
  interval **-119.16 to -11.56 ms**.
- All **2,560** expected recordings, including warmups, passed the full
  input/output, node-event and replay-project audit. Recording reservations and
  execution permits settled to zero, with no recording rejections.

The tiny-request check at 128 arrivals/second audited another 2,560 recordings:
p95 was 3.74 to 3.32 ms, with a difference interval of -0.88 to +0.05 ms. It found
no repeatable slowdown, but does not prove a strict zero-regression bound.
The smaller profile (0.5 CPU/1 GiB, four runs) completed a 20-second mixed phase
at four arrivals/second on both sides: all 192 recordings including warmup were
audited, there were no missed arrivals or recording rejections, and reservations
settled to zero. Its single-pair 12.75/11.79 ms p95 is a short regression check,
not sustained capacity qualification.

The bounded read groups have a cost: in the 16-pair final comparison, mean
whole-batch CPU increased from 674.23 to 685.64 ms (about 1.7%); serving-window
CPU was 235.79/256.49 ms. The reduced pauses and faster persistence completion
are not a claim of less CPU work. The wider no-slowdown requirement remains open.

Local validation passed 187 tests (104 settings/runtime, 35 memory/queue,
38 recorder/hash and 10 CI manifest/shard tests), API compilation, changed-line
lint, repository test-style, file-tree and documentation-link checks. One
headless playback scenario passed, covering legacy/shared recording tabs,
compaction and the full-output modal. Windows preview teardown again required
stopping the verified test-only Vite process; the runner then exited successfully.
The test-style check found that the new recording-memory test was missing from
the API manifest. Its sorted entry was added and the real manifest/shard checks
passed. Existing CI notes already require this check; no duplicate note was added.

Across this isolation pass, 11,456 recordings were audited; 5,312 belonged to
the final-source comparisons. The final fingerprint comparison confirmed that
only the settings-repository serving module differs from the preceding build.
Recording-memory, recorder and serialization source hashes are unchanged.

The eight-caller development screen and final-source confirmation are separate
receipts. They are not pooled with the earlier comparisons or the pre-accounting
baseline. Fixing this confirmed pause amplification does not close the wider
strict recording-performance gate. No cloud test or deployment was started.

Evidence: `.data/recording-settings-isolation-20261121/`, including `isolation.json`,
`sharing-ab/`, `sharing-four-ab/`, `sharing-fair-ab/`, `sharing-eight-ab/`,
`final.json`, `assessment.json`, `final-confirmation/`, `final-small/` and
`final-smallest-mixed/`. The rejected probes are confined to that ignored evidence
directory.

### Review of the bound and ordering

A follow-up review removed the redundant `freshnessCheck` flag from the enqueue
helper. Joining a group never queues another operation. Creating an operation
can therefore always close the previous group: a new freshness group is installed
synchronously before its queued job can start. The eight-caller limit, read
ordering, actual I/O and request-snapshot policy are unchanged.

Two existing tests were strengthened instead of adding parallel scenarios. The
managed test now advances the stored revision between its three groups and checks
that all twenty request contexts retain the correct 8/8/4 grouping. The failed-read
test now spans twenty callers, exercising failure and recovery across multiple
groups. All 139 focused settings/runtime and recording-memory/queue tests passed.
API compilation, focused changed-line lint, test-style and documentation checks
also passed, along with the headless legacy/shared playback scenario. As before,
Windows required stopping the verified test-only preview after the scenario
passed so runner teardown could exit successfully. Source and build verification
under `.data/recording-settings-review-20261121/` confirms that only the settings
repository serving module changed and the recording-memory, recorder and
serialization source hashes are unchanged.
There is no new benchmark claim from this semantic cleanup; the performance
receipts and the open strict release gate above remain unchanged.

## Implementation and current evidence

The maintained harness now has unique, audited warmup rounds; explicit API,
queue and settings-backend selection; a bounded sustained phase; separate client
body-receipt/parsing timing; serving/drain resource windows; cgroup v1/v2 quota
and throttle receipts; GC/driver metrics; and configurable bounded audit time.
Its eight deterministic tests cover bounds, identities, no intermediate drain,
transport failure, cleanup and no replay of failed requests.

The initial identical-build control audited 1,024 recordings but measured
125.51/156.94 ms p95 across four pairs. That is a warning about process/run
variation, not a difference between the identical builds. The diagnostic then
showed only two codecs completed during each 64-request serving window. Live
inspection plus admission took about 25–28 ms per batch; pre-graph waiting was
much larger. A refined diagnostic attributed 75–79 ms/request of overlapping
wall time to serialized execution-environment freshness checks. These are
queueing waits, not 4.8–5.1 seconds of CPU per batch.

The retained runtime repair is limited to `app-settings/settings-repository.ts`.
Adjacent freshness checks share a job only before it starts. Running jobs are
never reused, and other operations break the sharing group, preserving write
order and a fresh check begun after each caller arrives. Every caller installs
the exact refreshed revision in its own async context. A regression reproduced
the old file-backend bug: only the first of twenty concurrent requests received
an external update; nineteen retained stale request snapshots. File/managed
sharing, running-check isolation, write barriers, errors and retry are covered.
No recording-memory or Core codec source changed.

The eight-pair file-settings development screen measured p95 133.80/118.65 ms,
difference interval -31.29 to -8.11 ms, auditing all 1,536 recordings. The frozen
final build's 16-pair original comparison measured 112.22/107.82 ms, interval
-17.70 to +4.27 ms: inconclusive. Complete/drained time was 1,466.29/1,517.09 ms,
also inconclusive. This does not clear the strict file-settings performance gate.

The second bounded candidate reused estimator workspace while resetting all
seen-value state before fresh walks. All recording bytes and estimates matched,
but mean preparation was 1.301/1.307 ms and CPU per 128 samples 173.64/174.72 ms.
It provided no useful saving and remains an ignored probe only.

An additional representativeness gap was confirmed: the old managed benchmark
used PostgreSQL for workflows/recordings but file-backed app settings. Kubernetes
selects PostgreSQL app settings in `deploy/studio-server/helm/templates/_env.tpl`.
Managed benchmark defaults now select PostgreSQL app settings and assert the
actual backend in each resource receipt. A corrected original/candidate smoke
audited all sixteen recordings. New results use a new manifest and are never
pooled with old file-settings measurements. The existing local schema initializer
is reused; no deployment migration or new schema was introduced.

The corrected 16-pair PostgreSQL-settings comparison audited all 2,560 recordings.
Original/final pooled p95 was **124.74/111.03 ms**, with difference interval
**-56.69 to +22.55 ms**: still inconclusive under the predeclared primary gate.
Paired batch-p95 and last-response completion intervals favored the candidate,
but cannot replace the primary statistic after seeing results. Complete/drained
time was 1,473.21/1,495.43 ms, also inconclusive. The largest observed event-loop
delay during serving was worse on the candidate (116.65 versus the original's
32.92 ms maximum). Its affected batch also reported GC and throttling; these
correlations do not isolate a cause. This remains a qualification concern.

The repair remains in the uncommitted diff for its demonstrated queueing
improvement and reproduced stale-snapshot fix. The protected baseline remains
archived unchanged. No candidate is release-qualified, and the original
recording-performance issue is not claimed fully resolved. Under the stop rule,
no independent
confirmation or remaining full performance matrix/five-minute load qualification
ran after the primary gate stayed inconclusive. Three-second correctness-only
sustained smokes ran in both resource profiles: all 64 recordings were audited,
with no skipped requests or recording rejections and settled ledgers. They
validate the driver, not sustainable production capacity. The temporary reset
candidate was not adopted, and memory/codec hashes remain unchanged.

Evidence is under `.data/recording-latency-repair-20261121/`: `before.json`,
`final.json`, `control-bb/`, `phase-diagnostic/`, `setup-diagnostic/`,
`settings-screen/`, `final-nodes-production/`, `reset-*.json` and
`postgres-settings-smoke/`, `final-postgres-nodes-production/` and
`sustained-smoke-{production,smallest}/`, `diagnostic-overhead-chain-smoke/` and
`admission-smoke/`. Correctness passed 231 focused settings, transport, runtime,
recorder/hash, memory and queue tests, eight benchmark tests, API
compilation, and the existing real PostgreSQL/MinIO durability integration:
crashes, lost acknowledgements, legacy/shared replay, deletion and compaction.
All six headless playback cases passed; Windows required terminating the exact
owned preview process after the cases finished so runner teardown could complete.
All six original development containers were preserved. The first broad Windows
invocation hit the default `/workflows` path outside its allowed root; the
corrected invocation used a test-owned root.
The earlier stale recorder-options assertion was updated to include its existing
capture policy. Neither was a production failure.

The connected-chain diagnostic-on/off smoke audited all 32 recordings; its
single-pair 43.41/43.79 ms p95 values do not establish precise instrumentation
overhead. The final admission smoke also verified the actual enforced 32-run
limit on both builds, rather than relying on the configured value alone. Its
sixteen recordings were audited. Production/helper lint and changed-line lint
passed with the API's owning TypeScript project; pre-existing top-level test
registration lint debt is unchanged. Type checking, test-style, file-tree,
formatting and documentation-link checks passed.

## Evidence and limits

The protected build improves large/mixed workloads but has a repeatable
response-latency regression for bursts of 100-node graphs at 32 outstanding
requests. This does not establish that all production runs are slower.

The last property-view candidate reduced isolated preparation p95 from 1.28 to
1.13 ms, but its original-build request comparison measured 127.81 versus
142.09 ms p95. The pooled difference interval crossed zero; paired batch-p95
and last-response completion intervals remained positive. All 2,176 recordings
passed their audit. The candidate was correctly withheld from release.

Fresh review of those raw receipts adds important qualifications:

- Mean process CPU for the **whole batch plus drain** was 806.4 ms original and
  783.7 ms candidate. Less total CPU did not mean earlier responses. CPU during
  request serving has not been separated from post-response recording work.
- Original mean batch p95 was 126.44 ms in the first eight pairs and 103.66 ms
  in the last eight; candidate values were 131.47 and 126.26 ms. That is time
  variation, not proof of a particular cause. Warmup and paired alternating
  order do not explain GC, JIT or host effects by themselves.
- The candidate was never compared directly with its protected parent build.
  Its failed comparison with the original proves neither improvement nor
  regression relative to that parent.

Earlier instrumentation measured about 0.14 ms/capture for live inspection,
0.28 ms for settled admission, 0.31 ms for pre-encoding checks and 1.39 ms for
the codec. These are diagnostic averages, not independent additions to one
request's latency. Other recordings can run while that request waits.

Source confirms synchronous live inspection and settled admission. The queue
yields between jobs, but each preparation remains synchronous. Existing CPU
timing ends after drain; its 10-ms event-loop histogram and roughly one-second
history cannot locate the cause inside a short request burst.

Receipts:

- `.data/recording-property-views-20261121/nodes-production-original/`
- `.data/recording-property-views-20261121/assessment.json`
- `.data/recording-performance-20261121/revised-repair/phase-diagnostic/`
- `.data/recording-performance-20261121/revised-repair/final-harness-target/`
- `.data/recording-performance-20261121/remaining-final-20261121/`

## Invariants and acceptance

Preserve live accounting, both fresh mutation checks, writer headroom, every
capture/count/event/inspection/byte limit and exact release ownership. Keep
known outcomes, costs, child coverage and complete replay data. Recording
failure must not change a known run outcome. Mutable project/event identity
is not proof of unchanged contents.

Preserve v1 getter/toJSON order, binary values, aliases, collision order, sparse
arrays and legacy/shared snapshot playback. Diagnostics never inspect payloads.
No raw worker transfer, new service, schema change, production flag, reduced
recording coverage or increased deployment resources. Do not lower concurrency
to pass the test, or repeat removal of the response handoff/queue yield without
new evidence identifying an actual defect.

The active requirement remains **no slowdown**. Finite noisy tests cannot prove
zero overhead for every graph and machine. For declared latency cases, the
strict evidence gate requires the upper bound of the paired-bootstrap 95%
interval for the primary p95 difference to be at or below zero. This is a
conservative release rule, not a claim that equal performance can be proven by
finite samples. An interval crossing zero is inconclusive, not a pass or proof
of regression. Keep estimates and intervals together. A repeatable regression
in response completion or full completion/drained time also blocks release
even if p95 improves. The post-response-only `drainMs` can increase because
responses finish earlier; it is not by itself proof that full persistence
completion got slower. Keep it separate from `totalMs`.

The previously proposed allowances (1 ms for tiny-run p95, 3% for many-node
bursts, 2% for complete/drained time) have not been approved. They are not
defaults, and approval to implement this plan does not silently adopt them.
Diagnosis and small repairs can proceed without choosing an allowance. If the
user later accepts a margin, record its exact workload/metric scope before
running the final test; all other cases retain the strict rule. Never increase
a margin because the benchmark is noisy. If safe accounting retains an
irreducible measured cost, report that trade-off instead of claiming success.

## 1. Freeze builds and check measurement reliability

Reuse `scripts/benchmark-recording-memory.mjs`, its existing test file and
`packages/studio-server-api/src/tests/helpers/workflow-async-server.mts`.

| Build        | Role                                                                                                      |
| ------------ | --------------------------------------------------------------------------------------------------------- |
| A: original  | Pre-accounting reference in `.data/recording-performance-20261121/original`; never deploy it as a repair. |
| B: protected | Immutable copy of the current built source with every protection; parent of the proposed repair.          |
| C: candidate | Exactly one measured change to B, built separately. Diagnostic hooks use another isolated copy.           |

Verify source/build/fixture/image hashes before reuse. The previous B serving
hash was `0dbffe01427de166d3909c8c5ef37c5b0fc40c918cbc2f19182cd84dbf09a32f`;
check instead of assuming it. Keep full-build and serving-code hashes separate,
the common fixture overlay and pinned Node/image. Preserve old receipts and
unrelated working-tree changes.

Make these small harness changes explicit and test them before a load run:

- Configurable warmup, initially four 64-request batches. Assign each warmup
  a unique negative round ID; repeating the current `-1` ID would make the
  expected-recording audit fail. Include every warmup in retention and audits.
  Four batches are a declared starting point, not proof of JIT/heap stability.
- Explicit API profile and pending-write policy in the manifest. The fixture
  currently forces `combined` and 1,000 queued writes; the repository queue
  default is 100. Keep historical comparisons identified as such. New final
  acceptance uses the `execution` profile and a declared representative queue
  limit (100 unless a verified configuration is supplied), identical on A/C.
  Increasing retained history to 10,000 for auditing is separate from increasing
  queue capacity. Do not claim the repository default is the live prod setting.
- Explicit settings backend too: PostgreSQL workflow storage alone does not
  select PostgreSQL app settings. Managed qualification selects both, verifies
  the actual settings backend, and keeps file-backend diagnostics separately.
- A bounded sustained-run path through the same HTTP driver, described below.
  Keep the existing 16-pair maximum: the former 32-pair plan was not supported.

Smoke-test original/protected startup, recording and the audit in the execution
profile before accepting the common fixture change. Runtime sources remain
untouched. Log the new harness hash; do not splice new samples into old results.
Retain the historical combined profile only if needed to diagnose that specific
reproduction, not as a substitute for final execution-profile acceptance.

Run one short **B/B control**, four alternating pairs of 64 requests with 32
outstanding client requests. Record process/order/round drift without excluding
slow rounds. This detects gross harness bias; four pairs cannot prove precise
equivalence. Outstanding HTTP requests are not active graph runs: early
responses and retained permits can make them differ, so record both counts.

Use the existing local Linux/Docker environment, separate disposable
PostgreSQL/MinIO and 2 CPU/4 GiB API limits. Read actual cgroup quota/period and
memory limits. Preserve the six development containers. Run no competing
build, browser check or benchmark. No new benchmark framework.

If the control finds a concrete harness bias, fix it before judging C and allow
one declared remeasurement. Ordinary variance or drift is evidence to retain,
not an invitation to endlessly tune warmup. It need not block diagnosis; it
does block unsupported performance claims. Do not keep sampling until green.

## 2. Attribute the delay before choosing the repair

In a disposable instrumented B, keep every guard and collect bounded counters:

1. Server receipt, graph start/end, response-write completion, admission and
   permit release, alongside existing client timings. An early response may
   precede graph completion. Server `finish` is not client receipt; never
   subtract clocks across processes.
2. Separate CPU/resources for request-serving and post-response drain windows,
   plus whole-batch totals. Runs and recordings overlap, so window CPU is not
   exclusive per-request attribution. The current client timing also includes
   JSON parsing. Retain that metric and separately mark complete-body receipt;
   record driver load so client work is not attributed to Rivet.
3. Non-overlapping phase totals/counts for live inspection, admission,
   pre-encoding checks, codec, snapshot handling and compression/persistence.
   Distinguish async elapsed time from CPU. Use inspection counts and sampled
   allocation/GC evidence; do not pretend to measure every JS allocation.
4. GC, event-loop utilization/delay, queue depth/age, reservations and CPU
   throttling deltas. Use bounded counters/rings, not per-event logging or stack
   capture. Missing platform data stays unavailable.

Node's [performance APIs](https://nodejs.org/docs/latest-v24.x/api/perf_hooks.html)
provide GC entries and event-loop measures; utilization is not process CPU.
Linux's [cgroup CPU interface](https://www.kernel.org/doc/html/latest/admin-guide/cgroup-v2.html#cpu-interface-files)
defines quota/throttle counters. Record their scope; aggregate throttled time
is not an individual request delay. Reuse existing resource helpers where
sufficient; do not expand production monitoring for this investigation.

Use four fixed diagnostic pairs of the known burst and a short connected-chain
case. Exclude warmup from phase totals. Neither independent `nodes` nor connected
`chain` alone represents the production app. End with a table connecting each
observed delay to evidence, competing explanations and the smallest repair.
Keep instrumentation in disposable copies and export counters after measurement.
Compare hooks enabled/disabled on the same short B fixture to identify material
measurement overhead. Diagnostic latency is never final acceptance evidence.

## 3. Implement one measured repair at a time

Choose the repair from the attribution table, not from a predetermined encoder
design. If live/settled inspection is a material cause, one small candidate is
the ordinary-object path in `routes/workflows/recording-memory.ts`: avoid
repeated native-type classification/temporary work where a cheaper checked
path gives the same estimate. Preserve Proxy handling before unsafe access,
descriptors, symbols, prototypes, native containers and fallback behavior.
Require identical estimates/admission decisions on the adversarial matrix and
a phase saving large enough to matter relative to the observed delay. A faster
microbenchmark alone does not establish that the request bottleneck is fixed.

If allocation/GC dominates, remove the specific redundant allocation/lifetime
identified. If response/permit scheduling dominates, repair the exact ordering
defect in `execution.ts` or `recordings-store.ts`; do not build an idle-only
writer. If throttling dominates, identify which work consumed the budget.
Changing the quota is a diagnostic control, not a qualifying fix.

Do not repeat rejected primitive aggregation, bound-method, bulk-descriptor or
property-view work without new evidence. The archived property-view candidate
can be compared with B once if attribution makes its savings relevant; neither
its isolated gain nor its earlier A/C result establishes a B/C improvement.

Screen C once against B: eight paired 64-request bursts, identical warmup and
audits. This is a development screen, not the release gate. Record the phase
saving and request estimate/interval; an inconclusive latency screen does not
erase a useful phase saving, but it does not prove improvement. Preserve that
candidate in isolation for the final comparison if the evidence is promising
and there is no new correctness, backlog or resource problem. Drop changes with
no useful saving or a reproduced regression before spending on the full matrix.

Limit this pass to two evidence-backed small repairs. A second must address a
separately measured remaining cost, not be another blind rewrite. If neither
qualifies, stop with the measured trade-off and remaining constraint. Avoid
promising success through increasingly complicated machinery.

## 4. Validate the final build without hiding work

Remove diagnostics, rebuild and freeze hashes. First run a fixed **16-pair A/C
comparison of the original 64-request burst**, which the current runner supports.
Predeclare pooled request p95 as primary; retain paired batch-p95, last-response
completion, p99, drain, CPU and memory as supporting checks. Never select the
favorable statistic afterward. If it passes, run one independent 16-pair
confirmation with fresh processes, alternating which build starts first. Both
must satisfy the declared rule; preserve all results. A failure or unresolved
interval does not authorize repeated runs until a favorable result appears.

Only after that clears, run this final matrix. Report small-request latency
separately within mixed traffic; an improved large-request percentile cannot
hide a worse small-request tail.

| Case                               | 2 CPU / 4 GiB / 32 slots              | 0.5 CPU / 1 GiB / 4 slots             |
| ---------------------------------- | ------------------------------------- | ------------------------------------- |
| Independent-node burst             | Already gated above                   | Eight paired bursts                   |
| Tiny fixed-arrival traffic         | Eight paired batches                  | Eight paired batches                  |
| Connected chain                    | Eight paired bursts                   | One correctness smoke                 |
| Continuous mixed traffic           | One matched five-minute run per build | One matched five-minute run per build |
| Large/intermediate output, aliases | Focused compatibility/memory pressure | Focused compatibility/memory pressure |

Reuse prior fixed-arrival rates as starting points. Declare each case's rate,
duration, pair count and primary metric before running, with identical A/C
inputs. For timed cases use full identical request counts; samples plus all
warmups must fit fixture retention. No hardware timing thresholds in ordinary CI.

Continuous tests use one duration-driven phase in the existing driver, without
its current before/after-batch drains inside the timed phase. Keep a bounded
sample buffer, one final drain, and one full audit. Its current per-batch limit
is 4,096 requests; explicitly support the sustained phase's computed total
without weakening the ordinary batch bound or the 10,000-record overall cap.
Five minutes at 32 arrivals/s plus 256 warmup requests is 9,856 recordings;
four arrivals/s in the smaller profile is 1,456. Use fresh stores for these runs
so earlier calibration/qualification recordings do not consume that allowance.
These rates are test inputs, not claims about production capacity.

Give every request one planned identity, include warmups in the oracle, and
report offered/sent/completed/error counts plus schedule delay. The current
driver skips an arrival when its outstanding cap is full, then fails; preserve
that as an invalid target-rate comparison, not improved latency. Never silently
skip, delay or retry arrivals. Use scheduled latency as primary for fixed-rate
cases and retain service latency separately. Predeclare a driver-delay bound
with the existing option; a bound violation invalidates the comparison rather
than proving a server regression. Preserve all unsuccessful receipts.

Inspect interval latency, queue/byte backlog and oldest pending age. If A
cannot sustain the declared rate, retain the overload result and declare one
lower common-rate sustainability test before running it. If only C fails, that
is a candidate regression; do not lower its rate to make it pass. Check that
growth is not merely hidden by the fixture's enlarged queue. No errors, drops,
growing backlog or incomplete audit may count as a successful healthy case.

The sustained checks establish bounded behavior at the tested rate, not a
precise confidence interval from one long run. Do not treat its one-second
windows or thousands of correlated requests as independent replications.
Compare early/late intervals and normal heap/RSS; forced GC is diagnostic only.

Drain and audit have separate fixed deadlines. The current full-audit command
has a 180-second timeout; validate/declare an adequate bounded budget for the
larger recording count using the pilot's measured audit cost before launching.
An audit timeout means correctness is unverified, not that the requests passed.
Keep partial counts and failure context, clean up owned resources, and do not
automatically replay the workload. Never truncate the audit to fit the deadline.

Reject gains from moving work past the timer, growing the queue, losing healthy
recordings, delaying writes indefinitely or borrowing more memory. Reject new
HTTP/cancellation failures and outcome changes. Separate deliberate memory-limit
tests from healthy performance cases: an expected capture refusal must leave the
workflow outcome and cleanup intact, but must not be counted as successful
recording throughput. Do not relabel an unexpected drop as a pressure test.

## 5. Keep tests focused and report the exact outcome

Reuse existing suites; add a regression only if it fails without the repair:

- Core recorder/hash and recording-memory: bytes, value semantics, mutation,
  refusal decisions and release ownership.
- Queue/execution: fairness, sync/async failure, response order and known
  outcomes for HTTP, WebSocket, children, schedules, Evaluations and uploads.
- Local PostgreSQL/MinIO recovery: blocked storage, retry bytes, crash recovery,
  shared/legacy replay, deletion and compaction races.
- Six headless playback cases through `studio-server:ui:observe` after recorder
  or lifecycle changes; Core/Node/API builds and relevant style/doc checks.

Extend the existing deterministic benchmark tests, not a second harness or
duplicate fixtures. Cover unique warmup IDs, total retention bounds, sustained
mode with no intermediate drain, offered-load accounting and failure cleanup.
Keep hardware-dependent performance thresholds out of CI.

Completion requires one report linking A/B/C manifests, attribution, failed
and successful comparisons, final-build correctness, final memory/backlog and
the exact acceptance rule. An approved practical budget is different from
proof of zero overhead. Failed or inconclusive gates leave the protected
baseline and release hold intact. No push, cloud test, deployment or production
resource changes belong to this plan.
