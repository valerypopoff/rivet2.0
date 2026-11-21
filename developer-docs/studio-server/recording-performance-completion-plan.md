# Recording performance investigation history

Status: historical implementation and experiment evidence, 2026-11-21. Current
release readiness is recorded in the
[recording latency assessment](recording-latency-repair-plan.md). No cloud
qualification or deployment is implied by the measurements here.

The [accounting implementation and earlier measurements](recording-memory-and-serialization-plan.md)
remain the record of completed work. The [recording latency repair plan](recording-latency-repair-plan.md)
now owns the remaining work. This document preserves historical implementation,
diagnostic and qualification results; its old next-step instructions are superseded.

The current assessment includes the bounded settings-check repair and the final
comparison with the pre-change commit. It supersedes the intermediate results
below when judging the current build. Keep failed and inconclusive experiments
as evidence, not as instructions to repeat them until they pass.

## Implementation and measurement notes

`yarn studio-server:recordings:benchmark` now compares complete built source
trees in separate CPU/RAM-limited containers, using one shared test fixture and
an external load driver. It fingerprints every tested workspace build and the
fixture, fixes request arrivals (or runs a separate saturation test), alternates
paired batches, drains recording work, and opens every saved recording and
replay project. PostgreSQL/MinIO are disposable and separate for each side.
The helper makes no runtime substitutions. Fixture queue settings are explicit
and identical; the actual capture byte budget is unchanged.

Example from the repository root, after building both isolated source trees.
Set `$benchmarkImage` to an already-built local API image with the matching
dependencies. The command refuses to pull images and pins its inspected image
ID for both sides, even if the tag is subsequently changed.

```powershell
yarn studio-server:recordings:benchmark --image $benchmarkImage --original .data/recording-performance-20261121/original --candidate .data/recording-performance-20261121/final --output .data/recording-performance-20261121/final-small --backend managed --profile production --workload small --batches 8 --samples 256 --rate 64
```

`--profile smallest` uses 0.5 CPU/1 GiB and four execution slots; `production`
uses 2 CPU/4 GiB and 32 slots. `--rate 0` is the saturation measurement. Other
workloads are `nodes`, `large`, `mixed`, `stall`, `retained` and `aliases`.
`retained` generates an intermediate 5 MiB value while returning a small HTTP
response, separating encoding from HTTP JSON parsing/response work. `aliases`
generates repeated references that are cheap to retain but expand in the codec.
Artifacts include complete samples, bootstrap intervals and recording audits.
An audit accepts both legacy dedicated snapshots and shared snapshots: their
synthetic project IDs differ; their captured graphs must remain playable.
It also compares the decoded input/output and generated intermediate values,
so counts alone cannot qualify an empty or incomplete recording.

The driver warms the same number of HTTP connections before each paired batch.
Results retain both the mean of paired batch-p95 differences and the pooled-p95
difference; each confidence interval resamples complete matched batches.
They are different statistics and must not be substituted for each other.
The small deterministic CLI/summary tests run with
`node --test scripts/benchmark-recording-memory.test.mjs` and are included in
the existing `test:benchmark-support` CI check. They never start Docker or run
timing thresholds in CI.

Early full-source comparisons verified 4,160 small-run recordings with p95
4.11 ms before versus 4.09 ms with accounting. That interval still included a
small regression, so it is not the final no-slowdown qualification. A separate
5 MiB interference test verified 576 recordings and reduced maximum observed
event-loop delay from 1,675.6 ms to 31.9 ms. These measurements predate the final
candidate and remain diagnostic.

The first measured bookkeeping optimization reuses the per-inspection traversal
workspace, clearing it in `finally` even when inspection fails. It preserves
fresh admission/encoding checks and avoids retaining payloads in the workspace.
The isolated comparison reduced 100-node metering work by about 10%; endpoint
qualification remains required. Bulk property-descriptor copying and a codec
primitive fast path did not help in local probes and were not adopted.
The follow-up CPU profile identified own-key enumeration as the largest metering
cost. Separate native string/symbol enumeration reduced focused inspection time
by roughly one-third while retaining non-enumerable and symbol-keyed values.
The final endpoint measurements must include this change.

A first post-response I/O-turn prototype passed its lifecycle test but did not
show a performance benefit in its many-node comparison. It was removed at that
stage; the small-request repair below revisits that handoff for the slow case.
The full-source, warmed-connection
100-node saturation repeat (16 paired batches; 4,352 recordings per side)
measured pooled p95 135.37 versus 137.29 ms, with a paired-bootstrap difference
interval of -27.10 to +32.40 ms. Complete/drained batch time was 5,553.33 versus
5,608.90 ms. This is inconclusive, not a cleared no-slowdown gate.

At a fixed 64 arrivals/second, eight 128-request pairs measured 100-node p95
6.88 versus 7.22 ms and complete/drained batch time 2,945.96 versus 3,025.88 ms.
All 2,304 recordings, including warmup, passed content/snapshot checks.
The pooled-p95 difference interval was -0.25 to +0.59 ms. This smaller diagnostic
sample does not replace the larger saturation comparison or qualify the gate.

The tiny-graph fixed-arrival check (128 requests/second; eight 128-request pairs)
found a measurable tail regression: pooled p95 4.44 versus 4.65 ms, difference
+0.215 ms with a +0.063 to +0.476 ms paired-bootstrap interval. Complete/drained
batch time improved from 2,503.00 to 2,437.92 ms. All 2,304 recordings passed
the decoded-content and replay-project checks. Better drain time does not cancel
the latency regression. Do not repeat this check until it passes or describe
the no-slowdown requirement as satisfied. The fresh capture/snapshot scans remain
the measured extra work; removing them would reopen the memory-accounting gap.

Additional bounded checks on the same built candidate:

| Profile and workload                                                       | Requests per side, including warmup | Pooled p95 before / after (ms) | Mean complete/drain before / after (ms) |
| -------------------------------------------------------------------------- | ----------------------------------: | -----------------------------: | --------------------------------------: |
| 0.5 CPU / 1 GiB, one 5 MiB intermediate among small requests, 8 arrivals/s |                                 160 |                  243.72 / 6.16 |                     3,914.15 / 3,909.76 |
| 2 CPU / 4 GiB, repeated object aliases, 32 arrivals/s                      |                                 160 |                    5.23 / 5.49 |                     1,005.29 / 1,004.91 |
| 0.5 CPU / 1 GiB, mixed 1 MiB and small requests, saturation                |                                 160 |                 97.70 / 163.63 |                     3,882.85 / 1,030.21 |

These four-pair checks are functional/interference diagnostics, not final tail
qualification. In the mixed check, maximum event-loop delay fell from 707.26 to
206.44 ms, but the pooled p95 point estimate was worse and its interval was wide.
Keep both findings. The preceding fixed 8-arrivals/s mixed attempt exceeded the
four-outstanding-request cap during original-build warmup; its `failure.json`
is preserved. The separate saturation check changes the offered workload and
does not turn that failed fixed-rate attempt into a pass.

Across the five latest comparisons, all 5,568 original/candidate recordings
passed content and replay-project audits; settled reservations and permits
returned to zero. Artifacts are under `.data/recording-performance-20261121/`.
The candidate build fingerprint is
`890ea3bd1217a65a27b273d6f8172a20e7754517aa8348ba062344717ce121bd`;
the original is
`6d0674ba3e5278e664a9b76d76c78cfa75f59544ad98b969d1c125a3931b40ac`.
Both use image
`sha256:6c0455eb69881d50639cf4fb2851e7d36e74b5a42e503a4b837611ff4a740800`,
Node 24.22.1, and the same fixture. The Windows build/driver uses Node 24.22.3
and Yarn 4.17.1. The driver refuses to overwrite an existing result directory.

The local correctness run passed 170 recording-related tests, two release-auth
tests, the managed PostgreSQL/MinIO recovery check, and six headless playback/UI
checks. Later inspector changes passed the 35-test memory/queue subset again.
Core, Node, API and Web builds passed. These checks establish compatibility and
cleanup, not the missing performance acceptance. The worker remains rejected;
the full plan and release qualification remain incomplete while Gate B is held.

The optional worker remains outside the runtime. A compatible plain-data probe
under 2 CPU/4 GiB improved dispatch time but increased 5 MiB encoding p95 from
14.1 to 19.5 ms and CPU from 251.6 to 365.1 ms across 20 samples. At 0.5 CPU/1 GiB,
p95 rose from 63.6 to 80.0 ms and CPU from 295.4 to 483.4 ms. These isolated
probes do not qualify a worker and do not justify expanding the serialization
or storage protocols. No raw-clone worker, new queue or feature flag was added.

### Small-request latency repair

The follow-up profile used complete old/new builds with the real managed writer.
Across 768 captures, the sampler attributed about 10 ms to active inspection,
26 ms to settled admission inspection, and 30 ms to the pre-encoding inspection.
These are diagnostic sample totals, not precise per-request latency estimates.
All inspections remain required while their values can mutate.

The candidate restores the simpler writer scheduling: after a job settles, allow
a fresh I/O turn before the next job. An I/O turn scheduled at job start could
already have elapsed while storage was pending. The smaller FIFO test matrix
now verifies fresh I/O after both synchronous and asynchronous work; its
asynchronous case failed before this correction.

Completed HTTP responses also get an I/O turn before settled recording admission.
The execution permit and active-HTTP owner remain held across that turn, bounding
the number of not-yet-admitted snapshots and keeping them inside the existing
shutdown drain. Discarded captures, unsent responses and destroyed responses
skip this handoff. Inspection still occurs before queue admission, followed by
the existing fresh pre-encoding check. This changes neither recording bytes nor
which saved project is selected and adds no storage wait or second queue.

The first small-request comparison (eight pairs of 256, 128 arrivals/s) measured
pooled p95 4.30 versus 4.13 ms. Its interval still included regression (-0.40 to
+0.20 ms), so the predeclared larger 16-pair confirmation followed. All 4,608
recordings were audited. The earlier post-response prototype was only assessed
on the many-node workload; it did not settle the small-request question.

The larger Windows-driver confirmation (16 pairs of 256) measured p95 4.00
versus 3.95 ms; its difference interval was -0.26 to +0.10 ms. A separate yield
immediately before encoding did not help its end-to-end comparison and was
removed, together with its prototype-only test. The final runtime changes are
the completed-response handoff and the simpler FIFO scheduling only.

The final confirmation uses Linux Node 24.22.1 for both driver and APIs,
16 pairs of 128 requests at the original 128-arrivals/s rate, and the unchanged
2 CPU/4 GiB/32-slot profile. It measured pooled p95 **3.59 versus 3.10 ms** and
mean complete/drain time **2,412.49 versus 2,309.29 ms**. The pooled-p95
difference interval is **-0.92 to +0.09 ms**; the complete/drain difference
interval is **-171.02 to -40.21 ms**. All **4,352 recordings** passed the content
and snapshot audit, with zero rejections and zero settled reservations or
execution permits. The original positive small-request point estimate did not
recur, but the latency interval still crosses zero. Do not call that a proven
speedup or proof of literally zero added latency. The strict zero-regression
gate remains statistically inconclusive.

Evidence: `.data/recording-performance-20261121/latency-final-confirmation/`.
Final build fingerprint:
`9125889d25bf4ca46d4aceab4f9759ff84c2c9d22ba708b52b0e2cd9054c5889`.
The original and image fingerprints are unchanged from above. The same command
ran under Ubuntu/WSL with Node and its required shared libraries extracted from
the pinned API image. No staging/production environment, system package or
Docker setting changed. The driver now records platform and architecture.
A local health probe did not establish that Windows forwarding caused the
earlier difference; earlier observations remain part of the evidence.

Primitive stack bypass and per-capture estimator-object reuse did not improve
their focused probes and were not added to runtime code. No memory limit,
mutation check, capture setting or recording format was relaxed.

Final local correctness checks passed: 68 focused server tests, the real
PostgreSQL/MinIO recording-recovery integration, 10 benchmark-support tests,
the API build, changed-line lint, formatting, documentation links, test-style
and file-tree checks. All six recording-playback browser scenarios passed.
The first browser run completed five scenarios; Chromium failed to fetch a
stylesheet with `net::ERR_NO_BUFFER_SPACE` before the remaining scenario reached
playback. That scenario passed on its isolated rerun. The original failure
trace is retained under `artifacts/playwright/ci-test-results/`; the rerun log
is `.data/recording-performance-20261121/latency-final-playwright-confirmation.log`.
The six existing local development containers stayed running, and all owned
benchmark containers were removed. Nothing was deployed.

The follow-up ownership review found no further runtime defect in the response
handoff, FIFO drain, capture remeasurement or borrowed writer reservations.
It extended the existing queue-failure test to verify that a failed write and
failed logger still finalize the capture, a throwing finalizer cannot block the
next write's cleanup, and repeated drain does not finalize either job twice.
This review adds no production code or measurement passes. The measured runtime
and the statistically inconclusive zero-regression gate above remain unchanged.
Fresh validation passed 68 server tests, 37 recorder/hash tests, 10 benchmark
support tests and API type checking, plus formatting, test-style, changed-line
lint and documentation-link checks. The unchanged runtime does not require
repeating the prior Docker recovery, playback or latency qualification runs.

### Final-build mixed and many-node matrix

The remaining local comparison is predeclared against original build
`6d0674ba3e5278e664a9b76d76c78cfa75f59544ad98b969d1c125a3931b40ac`
and final build
`9125889d25bf4ca46d4aceab4f9759ff84c2c9d22ba708b52b0e2cd9054c5889`,
with the same pinned image and Linux Node 24.22.1 driver. No runtime changes
precede this matrix. The driver additionally retains raw `smallLatencies` so
mixed small-request tails can be pooled and resampled without conflating them
with the larger responses. Its manifest records the resulting harness hash.

| Profile                   | Workload  | Pairs | Requests per measured batch | Arrivals/s |
| ------------------------- | --------- | ----: | --------------------------: | ---------: |
| 2 CPU / 4 GiB / 32 slots  | 100 nodes |    16 |                         128 |         64 |
| 2 CPU / 4 GiB / 32 slots  | Mixed     |    16 |                         160 |         32 |
| 0.5 CPU / 1 GiB / 4 slots | 100 nodes |    16 |                         128 |          8 |
| 0.5 CPU / 1 GiB / 4 slots | Mixed     |    16 |                         160 |          4 |

Each cell also has a separate eight-pair, 64-request saturation comparison
(`--rate 0`) for complete/drained throughput. Saturation does not qualify
fixed-arrival latency. Requests, recording loss, resource peaks and every
replay remain part of acceptance. Preserve all failures and inconclusive
results. Do not extend sampling until green; investigate a measured regression
before changing production code, then record a new candidate fingerprint.
No build, browser check or other benchmark runs concurrently with this matrix.

The first three fixed-arrival cells completed with all replays audited. The
half-CPU mixed cell stopped on `ECONNRESET` during warmup, before measured
batches. Its original logs and `failure.json` remain under
`.data/recording-performance-20261121/remaining-final-20261121/fixed-mixed-smallest/`.
Both API containers exited normally during cleanup; the evidence does not
establish the connection-reset cause or attribute it to the candidate. One
short diagnostic passed for both builds and all 128 recordings. It does not
qualify performance. The driver now preserves build side, round, socket reuse
and bounded API logs for failures, with a loopback regression check that resets
are reported without automatically retrying a request. The full mixed cell
resumes once in `fixed-mixed-smallest-resume/` with the original declared
settings. Serving builds, traffic, memory bounds and successful cells are
unchanged; manifests record the diagnostic-only harness revision separately.

The complete matrix audited 23,552 recordings. It found a production-profile
many-node saturation regression: p95 110.84 versus 155.00 ms, with pooled
difference interval +25.56 to +65.80 ms. A larger unprofiled confirmation of
the same 64-request burst (16 pairs) reproduced p95 121.43 versus 138.19 ms,
with difference interval +3.81 to +31.22 ms. The serving build therefore remains
unqualified even though its fixed-arrival and mixed-payload results improved.
The local CPU profile retained all memory checks and attributed about 42 ms
to active inspection, 124 ms to settled admission, and 214 ms to fresh
measurement across 384 captures; these sampled inclusive totals overlap and
are diagnostic, not additive per-request timings.

The first corrective experiment removes only the post-response I/O yield,
preserving the synchronous response-before-admission order, execution ownership,
both fresh mutation checks and all memory limits. It compares against the
accounting build before comparing with the original commit. This is a
provisional experiment, not an accepted repair: saturation, tiny-request latency
and correctness must validate the combined result before it can be retained.

### Final matrix disposition and rejected corrections

The fixed-arrival mixed cases improved substantially. Small-request p95 was
206.59 to 3.76 ms at 2 CPU/4 GiB, and 166.90 to 3.94 ms at 0.5 CPU/1 GiB.
Fixed-arrival many-node p95 was 6.37 to 5.95 ms in the larger profile (pooled
difference interval -0.83 to -0.11 ms), and 6.38 to 6.30 ms in the smaller
profile (-0.23 to +0.11 ms; inconclusive).

| Saturation workload        | Original p95 (ms) | Accounting p95 (ms) | Pooled difference 95% interval (ms) | Original / accounting drain (ms) |
| -------------------------- | ----------------: | ------------------: | ----------------------------------: | -------------------------------: |
| 100 nodes, 2 CPU / 4 GiB   |            110.84 |              155.00 |                    +25.56 to +65.80 |              1,512.34 / 1,470.58 |
| Mixed, 2 CPU / 4 GiB       |             83.57 |               86.62 |                     -3.46 to +11.66 |              3,611.09 / 1,296.77 |
| 100 nodes, 0.5 CPU / 1 GiB |            168.14 |              189.77 |                    -83.73 to +91.01 |              2,238.98 / 2,244.02 |
| Mixed, 0.5 CPU / 1 GiB     |            104.34 |              101.88 |                     -80.75 to +7.00 |              6,944.74 / 1,688.12 |

All eight completed cells audited their expected recordings and ended with zero
capture reservations, retained bytes and execution permits, with no recording
rejections. The larger confirmation of the production many-node saturation
regression audited another 2,176 recordings. Faster mixed-workload drain does
not cancel that confirmed latency regression.

Removing the handoff did not qualify as a repair. Against the accounting build,
its eight-pair p95 difference interval was -32.43 to +0.34 ms. Against the
original build, 16 pairs measured 123.91 versus 135.52 ms; the pooled interval
was -7.64 to +36.04 ms and the mean paired-batch-p95 interval remained positive
(+3.46 to +22.91 ms). Tiny-request p95 was 3.21 versus 3.60 ms with a wide
interval (-0.44 to +0.96 ms). Both 16-pair comparisons audited every recording.
The original handoff was restored; no counter, inspection or bound was relaxed.

An array-classification/canonical-empty-array probe preserved the exact
346,270-byte estimate for a real 100-node, 305-event capture, including both
fresh checks. It improved focused inspection by only about 1.3% and was removed.
The existing native-value protection matrix now also covers arrays with hidden
properties/symbols and altered array/native-map prototypes. A descriptor lookup
probe showed no useful gain from `Reflect.getOwnPropertyDescriptor` or bounded
bulk descriptors; those variants stayed in ignored diagnostic artifacts only.

Evidence is under `.data/recording-performance-20261121/remaining-final-20261121/`:
`assessment.json` records the eight-cell matrix; `confirm-saturation-nodes-production/`
records the larger confirmation; `profile-saturation-nodes-production/` contains
CPU profiles; `ablation-response-handoff/`, `repair-nodes-production/` and
`repair-small-production/` retain rejected scheduling comparisons. The probe
receipts retain estimates and raw timings. No experiment is a cleared release
gate. The confirmed production-profile many-node burst regression is unresolved;
the protected serving implementation remains at the earlier measured state.
Do not deploy or mark the strict performance requirement complete on these results.
Restoration compared 426 compiled serving files with the measured accounting
build and found no differences. Final validation passed 105 recorder/server
tests plus 11 benchmark-support tests, API compilation, focused lint, formatting,
test-style and documentation-link checks. All owned performance containers were
removed; the six existing development containers remained running. The retained
changes from this pass are diagnostic evidence, benchmark failure reporting,
raw small-request samples, edge-case coverage and documentation, not a claimed
production performance repair.

## Revised repair plan

This section replaces the earlier unimplemented completion steps. The notes
above preserve historical measurements and rejected experiments. The benchmark
foundation and attribution work below have been implemented locally. A
qualifying runtime repair has not been found; the release remains held.

### Revised-plan implementation status

- The maintained benchmark now audits the complete graph, every node's paired
  start/finish/output, expected request identities and terminal results. It
  fails on missing traces, duplicate requests and mismatched replay snapshots.
- A bounded test-only drain barrier waits for active HTTP owners and execution
  permits before flushing evidence/recordings, then rechecks for late work.
- A separate 100-node connected Passthrough chain supplements the existing
  102-node independent fixture. Both storage builds passed its local smoke
  checks in the 2 CPU/4 GiB and 0.5 CPU/1 GiB profiles. Smoke timings are not
  performance qualification.
- The driver retains planned/send/finish times, service and scheduled latency,
  small-request samples, response/drain intervals and bounded resource history.
  A declared scheduling-delay bound is enforceable. A separate calibration
  observed at most 1.125 ms delay; this is a local observation, not an automatic
  acceptance bound for future machines or runs.
- Full-package and serving-code fingerprints are separate from the common
  fixture fingerprint. Warmup traces count in the final completeness audit.
- A disposable instrumented build attributed approximately 0.14 ms/capture to
  live event inspection, 0.28 ms to admission rechecks and 0.31 ms to pre-encoding
  rechecks in the independent-node fixture. Its codec took about 1.39 ms/capture.
  These non-overlapping phase timings cover 256 measured captures and exclude
  warmup; instrumentation timings are diagnostic, not acceptance results.
- Local probes for primitive-leaf aggregation, local counters/native-function
  bindings and alternative codec object construction did not provide a useful
  gain. They remain ignored artifacts, not serving changes. Mutable projects
  still use full fresh inspection; no snapshot cache or lease layer was added.

Receipts are under
`.data/recording-performance-20261121/revised-repair/`. The original protected
runtime remains intact. The final uninstrumented comparison used 16 paired
64-request batches and audited all 2,176 recordings, including warmup. Pooled
p95 was 132.97 versus 132.05 ms, difference -0.93 ms with a 95% interval of
-26.77 to +24.50 ms: inconclusive, not a no-slowdown pass. Mean complete/drained
time was 1,908.53 versus 1,935.63 ms, also inconclusive. Last-response completion
was slower in that comparison (paired difference interval +0.12 to +35.99 ms).
The earlier confirmed regression remains open. Do not pool the instrumented
diagnostic or short fixture smoke checks into this acceptance result.

The serving-code fingerprint remained
`0dbffe01427de166d3909c8c5ef37c5b0fc40c918cbc2f19182cd84dbf09a32f`
before and after this pass; full-build fingerprints differ because test helpers
changed. Temporary probes did not change production code. Seven benchmark
support tests and 105 recorder/execution tests passed. The existing managed
PostgreSQL/MinIO integration also passed real crash recovery, lost acknowledgements,
shared and legacy playback, blocked writes, deletion races and historical
compaction. No cloud test or deployment ran.
API compilation, focused fixture lint, formatting, test-style, file-tree and
documentation-link checks passed. All disposable test containers were cleaned
up; the six existing development containers remained running.

The runtime-repair step is unfinished. In accordance with the failure gate, the
remaining full performance matrix and continuous-load qualification have not
been run: they would not turn a missing repair into an accepted implementation.
The benchmark foundation is ready for the next measured candidate, including
the connected graph, trace-completeness checks and bounded resource history.

### Follow-up code review

The review reproduced and fixed several validation gaps in the maintained
benchmark, without changing serving code or relaxing recording protection:

- Drain deadlines now also bound a stalled flush or yield, and reject late
  completion instead of reporting successful drain after the budget expires.
- Recording audits check lifecycle ordering within each node and graph as well
  as complete values. Independent nodes may still execute in either order.
- Expected request identities are compared as complete sets; duplicated batch
  declarations cannot conceal an unexpected recording.
- HTTP checks verify the complete echoed request, allowing only Rivet's existing
  numeric durationMs response metadata. The stronger assertion runs after the
  response timing sample, and its driver overhead remains part of workload
  validation, not a claimed server improvement.
- Summaries reject incomplete or unequal paired samples and invalid timings.
  They derive percentiles from raw values instead of trusting a stale saved
  percentile. One-pair stability checks report point estimates and pair count;
  they do not manufacture confidence intervals from one observation.

Regression cases were added to the existing small benchmark-support suite.
The first HTTP smoke check exposed the duration metadata assumption in the new
validator; its failed receipt is retained rather than treated as a server
failure. Historical multi-pair results still stand: these fixes do not clear
the unresolved performance gate.
All seven benchmark-support tests passed, followed by local connected-chain and
mixed-payload smoke checks auditing 96 recordings across the original and
protected builds. Their receipts are in
`.data/recording-performance-20261121/benchmark-review/`. Recomputing the prior
16-pair comparison from its raw samples reproduced its confidence intervals
exactly. These are validation fixes, not a claimed runtime speed improvement.

## Encoder worker feasibility outcome

The [recording encoder worker assessment](recording-encoder-worker-plan.md)
records the next implemented candidate and its failed early gate. A guarded
worker preserving the v1 bytes and memory reservations took about 2.7 times as
much CPU per batch as synchronous encoding in the 2-CPU container, and about
2.5 times as much in the half-CPU container. It did not reduce initial
serving-thread p95 in the 2-CPU check. These are local encoding measurements,
not business-request latency measurements.

The candidate was removed before producer/lifecycle integration. Its source
and receipts remain ignored under
`.data/recording-worker-implementation-20261121/`. Runtime source was restored
byte-for-byte, including all existing recording-memory protections. The strict
performance gate remains open. Repeating the full load matrix against this
rejected candidate is not the next step; a different measured cost-reduction
approach is required.

## Property-view candidate outcome

The [combined recording preparation assessment](recording-combined-preparation-plan.md)
records the implemented property-view candidate. Its simplified encoding path
reduced preparation time in both isolated container profiles. The integrated
production-profile comparison still measured original/candidate request p95 of
127.81/142.09 ms. Its pooled interval was inconclusive, and paired batch-p95 and
last-response intervals remained positive. All 2,176 recordings were audited;
all 1,088 candidate recordings used the checked path and drained without loss.

The candidate therefore failed the original-build performance requirement and
was removed before the remaining qualification matrix. Runtime source was
restored byte-for-byte. A small v1 collision-order regression and benchmark
memory receipts remain useful independently. Evidence lives under
`.data/recording-property-views-20261121/`; the issue is not resolved or ready
for release. Optimizing preparation alone has not cleared the existing request
latency regression; these results do not isolate which remaining phase dominates it.
