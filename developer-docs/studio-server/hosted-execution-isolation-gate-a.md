# Hosted execution isolation: local gate results

Status: Gate A tooling is implemented and locally exercised, 2026-11-14.
**Production integration has not started and the existing endpoint/preview
execution paths are unchanged.** The historical zero-regression gate below did
not pass. The owner subsequently accepted **1 ms added p95 for small runs**, with
large-request regressions separately bounded and tested. The new local 8 MiB
comparison freezes a **5 ms added-p95 engineering limit** before measurement.

This records the [isolation plan](./hosted-execution-isolation-plan.md) evidence
and remaining gates. An infinite-loop test does not qualify normal-run latency
or production capacity.

## Implemented local tooling

`packages/studio-server-api/src/scripts/hosted-isolation/` contains a bounded
whole-root prototype, shared generated fixtures, a compiled worker entry,
functional verification and a separate-process HTTP benchmark. It is development
tooling, excluded from the production API compiler inputs in `tsconfig.runtime.json`.
Cheap input/limit contracts live in `src/tests/hosted-isolation.test.ts` and run
in the ordinary API CI manifest without building or bootstrapping the graph engine.
No serving mode, controller, default, database owner or public socket protocol
was changed. This prototype is not the planned production supervisor/adapters.

- The root uses the actual hosted runtime policy, ManagedCodeRunner and existing
  graph/session code with explicitly injected local fixture services. No managed
  database/settings backend is initialized for these fixtures.
- Fixed immutable fixture definitions are supplied once per thread. This does
  not implement production's multi-project/revision cache or service adapters.
- Reuse and retirement are benchmark alternatives, not automatic runtime fallbacks.
  Total warming/active/terminating thread count and the queue are bounded. Exit
  confirmation releases capacity; failed roots are never automatically replayed.
- A transferred request uses exclusive external bytes, not a buffer backing
  existing graph values. JSON decoding remains equivalent to the direct harness.
  This is not yet an implementation of production Express body admission.
  HTTP chunks are assembled once into exclusively owned unpooled storage for
  transfer; original chunks and buffer slices remain intact. The parent no longer
  copies each chunk and then copies the concatenated body again.
- Ordinary failed observation/delivery does not kill an accepted graph.
  In particular, action response encoding or delivery cannot release a thread
  before managed background work settles. Graph outcome and delivery failure
  remain separate, and a thread with unconfirmed settlement cannot be reused.
- Queue bounds and deadlines reject invalid or overflowing values before
  admission. Pool settings and the fixture definition are snapshotted at creation;
  caller mutations cannot change replacement behavior. Bootstrap failure closes
  admission and rejects queued work without invoking it or replaying active work.
- A narrow host stored-value adapter uses a separate MessagePort, per-root
  identities and monotonically increasing operation IDs. At most 64 calls are
  pending per root. Retained roots, including IO left after worker exit, are
  bounded by the worker-plus-queue capacity. Accepted calls enter the parent's drain inventory before
  invocation, retain the accepting request's AsyncLocalStorage context, and stay
  tracked after cancellation or lost replies. No store write or graph is replayed.
  This is an in-memory local integration proof; other production adapters remain
  unimplemented. It adds no database/settings owner or serving configuration.

## Functional evidence

The current worker verifier passed on native Windows Node 22 and in a cached
Linux API runtime using Node 24.22.1 with current workspace dist/manifests mounted
read-only. Fast contracts also passed on both runtimes. The verifier covered:

1. Function/class intermediate values, mutations, typed arrays, Rivet namespace,
   a fresh execution environment on reuse and failed response observation.
2. Exclusive raw-request transfer without detaching the caller's original Buffer.
3. The real Node prepared-action handler, browser storage/state patches and
   recording capture. The former homemade WebSocket echo wrapper was removed:
   it duplicated these assertions and never exercised the production gateway.
4. A synchronous infinite loop and an infinite loop after `await`. A shared
   atomic marker confirms the bad code actually entered its loop before the
   independent root and forced-cancellation checks. The first cancellation proves
   replacement waits for exit; the final one joins shutdown without paying for
   another unused replacement.
5. Queue capacity, cancellation before invocation, byte-budget cleanup and no
   managed SQL pool allocation. All fixture threads exit on cleanup.
6. Direct and isolated prepared actions with real managed async branches. Shared
   atomic markers hold those branches open while JSON encoding, foreground
   delivery or the branch itself fails; settlement and recording wait for release.
7. Invalid bounds, deadlines and non-cloneable payloads reject before invocation.
   Caller-edited options and definitions cannot alter pool bounds or replacement
   snapshots, including after forced cancellation.
8. A separate benchmark fixture returns HTTP 200, then fails in a real managed
   background branch. Sampling waits for root settlement and reports that failure.
   Disconnecting the coordinator then closes the fixture server and worker without
   a forced kill. The tail is explicitly held until sampling has begun, rather
   than relying on a 150 ms delay. This regression failed against the previous
   benchmark behavior.
9. One actual mixed graph chains legacy Code, new Code, JS Map/Filter callbacks
   and Expression, with interpolation, the Rivet namespace, builtin `require`
   and recording. Direct and isolated results agree. This does not yet establish
   managed third-party/native package or plugin compatibility.
10. Prepared actions use a parent-owned host store across root reuse, preserving
    fresh parent request context, recordings and state patches while keeping host
    values out of browser storage. Cancellation while a real store write is held
    proves shutdown waits for that write after worker loss and never replays it.
    A replacement accepts a separate held write; retained-root saturation rejects
    further store roots, and queued cancellation never invokes its graph/write.

Prepared-action checks do not exercise the production web-app gateway. They do
not establish production resume/debugger/browser behavior, parent service IO
ownership beyond the narrow local host-store proof, crash evidence recovery or
complete cross-root cleanup. Those planned
integration gates remain unimplemented.

## Performance evidence and decision

The client and HTTP server run in separate processes. Each case warms both paths,
collects three direct baseline blocks, then alternates direct/isolated ordering in
three paired blocks. The Linux matrix uses 60 requests per block, two CPU cores,
1.5 GiB container memory, no external network, and owned-byte input transfer.
The report includes raw samples, process CPU/RSS, worker counts, runtime/platform
and a hash of the compiled prototype files. Its isolated services remain fixtures.

| Generated case                     | Direct median, ms | Isolated median, ms | Added median, ms |
| ---------------------------------- | ----------------: | ------------------: | ---------------: |
| No Code nodes                      |             0.727 |               0.841 |            0.114 |
| One trivial Code node              |             0.817 |               1.035 |            0.218 |
| Sixteen sequential Code nodes      |             1.302 |               1.522 |            0.221 |
| One Code node with capture enabled |             0.854 |               0.973 |            0.119 |
| 8 MiB request, small result        |            29.198 |              32.729 |            3.531 |

These are medians of the three paired block medians. The isolated median was
higher in every paired block in every case. Small-case p95 deltas varied with
noise; the 8 MiB case's p95 was higher by approximately 9-37 ms. A separate
single large-input run on an earlier harness revision initially looked faster;
it is not a same-revision repeat or acceptance evidence for the matrix. Both
receipts retain their compiled-file fingerprints. One favorable aggregate cannot
replace the final paired matrix or establish a speed guarantee.

On this profile one additional warm thread increased total process RSS by about
138-147 MiB. This is a measured process delta, not a sum of per-thread RSS values.
The real production admission policy/concurrency/resource envelope has not been
qualified against that overhead. In the Windows Node-22/PnP experiment, retirement
required about eight seconds to reload each thread; that is not a production
startup prediction, but it rules out treating prewarming as free replenishment.

**Historical decision under the original requirement:** do not enable the isolated execution
path or proceed with a broad production integration. No measurable endpoint
slowdown had been accepted by the owner. A latency-budget decision, a demonstrated
large-input improvement and capacity evidence would all be needed to advance;
relaxing one check would not establish the others.

The figures above belong to the fingerprinted pre-review matrix. Subsequent local
review repaired lifecycle/admission checks and benchmark failure handling; the
short large-input/retirement smoke check validates those paths, not a new latency
acceptance result. These results do not qualify the subsequently accepted budget.

### Follow-up after removing redundant request copies

A fresh five-case matrix used the same Node 24/container bounds, owned-byte
transfer, 60 requests per block and three alternating pairs. Its receipt is
`gate-a-single-copy-node24-matrix.json`, compiled SHA256
`8066587d58490ba4e2d691b54c10940dce3ebef31f7073f44c427ec9557a4144`.
This benchmark revision includes the complete-root/capture settlement barrier.

| Generated case                     | Direct median, ms | Isolated median, ms |
| ---------------------------------- | ----------------: | ------------------: |
| No Code nodes                      |             0.657 |               0.855 |
| One trivial Code node              |             0.802 |               0.875 |
| Sixteen sequential Code nodes      |             1.282 |               1.579 |
| One Code node with capture enabled |             0.847 |               0.999 |
| 8 MiB request, small result        |            24.979 |              24.912 |

As above, these are medians of the three block medians, not the median of paired
differences. Every small-case paired median still increased. The large case had
two higher paired medians and one lower one; its p95 deltas ranged from about
-2.9 to +23.9 ms. Roughly equal aggregate medians do not qualify its tail latency.
These unpaced, 180-observation results do not qualify the subsequently accepted
p95 budgets. Production integration remains gated by the full plan.

This is local design evidence, not GKE qualification or a fresh application-image
test. The cached Linux dependency image plus mounted current workspaces verifies
the prototype on the target Node patch; it does not establish a new release's
dependency provenance or exact production Pod performance.

### Accepted-budget follow-up

The comparison now paces both paths at the same capped arrival rate, excluding
the inter-request wait from latency. Small fixtures use at least 10 ms between
request starts, and the 8 MiB fixture uses 100 ms. There is at most one HTTP
request outstanding, with no catch-up bursts after slow responses. This is an
ordinary-load latency comparison, not concurrent-load or saturation qualification.
`--interval-ms=0` selects a separately labelled saturation diagnostic.

The six-case Node 24.22.1/Linux comparison used 100 requests per block and three
alternating pairs: 300 observations per path, plus separate direct baselines.
It retained the two-CPU/1.5-GiB local envelope and transferred owned request bytes.
The complete receipt is `gate-a-parent-store-paced-node24-matrix.json`, compiled
SHA256 `a9cf878c7b2006d83a28979f96eaab251dba2862e47ed1e5b5a65faeef13b8d6`.

| Generated case                           | Direct p95, ms | Isolated p95, ms | Added p95, ms | Limit, ms |
| ---------------------------------------- | -------------: | ---------------: | ------------: | --------: |
| No Code nodes                            |          1.518 |            1.958 |         0.439 |         1 |
| One trivial Code node                    |          1.790 |            2.320 |         0.530 |         1 |
| Sixteen sequential Code nodes            |          2.003 |            2.991 |         0.988 |         1 |
| One Code node with capture               |          1.848 |            2.306 |         0.458 |         1 |
| Code and actual parent Stored Value node |          1.770 |            2.407 |         0.637 |         1 |
| 8 MiB request, small result              |         33.599 |           36.758 |         3.159 |         5 |

All six workload limits were met in this comparison. The sequential case is close
to its limit, so this is not evidence of substantial latency headroom. The prior
five-case paced comparison also met the limits (small added p95 0.377-0.615 ms;
8 MiB added p95 1.752 ms), receipt `gate-a-paced-budget-node24-matrix.json`,
SHA256 `73cc348068cb206d1da0f156bb74b8067377c7baf3f95034bfcea96324bfd795`.
Keep the source fingerprints and all raw samples; do not select a favorable run
or reinterpret maximum-throughput historical samples as the new comparison.

The retained-root admission bound was added after that full matrix. Its targeted
300-observation host-store follow-up measured 1.535 ms direct p95 and 2.164 ms
isolated p95: **0.629 ms added**, within 1 ms. Receipt:
`gate-a-bounded-parent-store-node24.json`, SHA256
`054ced73c8844a3ca5bc96660e0721bc848e21f54f70ac03c6aa137894c07aa3`.
Other fixture paths were not remeasured for this store-admission change.

The user supplied the 1 ms small-run limit. The 5 ms large-input limit is a
separately frozen engineering bound for this explicit fixture, not blanket
acceptance of arbitrary large-payload regressions. These results clear only local
workload latency. Real-fixture/native-package compatibility, concurrent capacity,
production adapters, actual socket/debugger integration and activation remain
required by the plan. The serving event-loop blocking issue remains unresolved.

Reports declare requested cases and `complete` so a partially written case set
cannot be mistaken for the finished matrix. Per-case `latencyBudget` is separate
from its median trend and load profile; a trend is not an acceptance decision.

The final local checks passed: 29 targeted API tests, all 11 real-worker groups
on Windows Node 22 and Linux Node 24, the production compiler with isolation tools
absent from its output, documentation links and test/import style checks. These
checks used generated fixtures and in-memory host stores, with zero managed SQL
pools. They do not constitute a hosted browser or production-store integration test.

## Reproduction

From the repository root, with development dependencies installed:

```powershell
node .yarn/releases/yarn-4.17.1.cjs workspace @valerypopoff/rivet-studio-server-api run hosted-isolation:test
node .yarn/releases/yarn-4.17.1.cjs workspace @valerypopoff/rivet-studio-server-api run hosted-isolation:verify
node .yarn/releases/yarn-4.17.1.cjs workspace @valerypopoff/rivet-studio-server-api run hosted-isolation:benchmark -- --wire=transfer --input-bytes=8388608 --runs=100 --blocks=3
```

Use `hosted-isolation:test` for input/limit edits: six normal `node:test` cases
cover fragmented Unicode JSON, real ArrayBuffer transfer/slice ownership,
malformed input, invalid pool bounds, the additive latency-budget calculation,
and request-context/write ownership after a lost reply.
The latter uses nearest-rank p95 and requires equal counts of at least 200
observations per path; a small smoke run reports insufficient evidence. It does
not build the API or start a worker. `hosted-isolation:verify` builds current sources before its real-worker
checks; after an unchanged build, the compiled verifier can also be invoked
directly through `yarn exec node` to avoid another build. Keep the existing Node
`webAppHandler.test.ts` / `webAppSocketGateway.test.ts` suites responsible for
actual handler/gateway semantics; a private echo protocol cannot replace them.

Queue and tail tests use explicitly released atomic gates. They assert actual
completion/outcomes and byte/slot accounting, not human-readable Node/graph error
wording or the assumption that work stays busy for a fixed number of milliseconds.
The verifier prints per-stage and total timings for diagnosis; those numbers are
not timing assertions or a performance acceptance threshold.
Local negative controls also verified that the benchmark regression rejects both
deliberately omitted settlement and a dropped late-failure signal. These probes
use Git-ignored generated copies in isolated containers; they are not an added
mutation-testing framework or part of ordinary CI.

One before/after run under the same constrained Node 24 runtime measured 32.5 s
versus 26.7 s for the full verifier (about 18% less wall time). The new fast suite
completed in 0.34 s in the Windows Node 22 test runner, about 1.8 s including Yarn.
These are observations, not speed guarantees; module bootstrap dominates the
remaining worker integration cost.

The benchmark also accepts `--case=no-code|trivial|sequential|large-input|recording|host-storage`,
`--input-bytes=8388608`, `--retire` for the two-request retirement experiment and
`--output=...`. Omitting `--case` runs the six-case matrix. Case/all input sizes
and run counts are validated; no fixture contacts a paid provider.
Reuse and retirement use the same request-byte allowance, including large inputs.
Resource samples identify both pools when retirement is enabled. HTTP response
latency is timed separately from the settlement barrier: a sample waits for all
accepted roots, rejects execution/delivery/capture failures and requires a recording
when capture was requested. An early HTTP 200 cannot qualify a failed root.

A child that fails cleanup or exceeds the exit deadline fails the command before
its case can be published. The fixture server owns cleanup through startup,
explicit stop and coordinator disconnect; IPC-send errors also stop it. Reports
replace the previous completed case set atomically, and the fixture server needs
no temporary installation directory.

The disconnect regression joins physical child exit with inherited stderr. It
does not wait for `close` after explicitly disconnecting the parent: that event
can be suppressed by the reported [Node IPC close-accounting issue](https://github.com/nodejs/node/issues/65646).
The ordinary benchmark keeps parent IPC attached through termination and joins
the real `close` event so its captured stderr is drained. No event is synthesized
and no Node internals are patched.

For a quick check of this benchmark boundary alone, after building the API:

```powershell
node .yarn/releases/yarn-4.17.1.cjs exec node packages/studio-server-api/dist/studio-server-api/src/scripts/hosted-isolation/verify.js benchmark-check
```

The full verifier includes the same regression after reclaiming its first pool;
its independent 150-second ceiling accounts for initial warmup, one replacement,
the benchmark child and cleanup. No timeout was increased to hide a failure.

Full private receipts stay Git-ignored under
`artifacts/server-robustness-review/`, including
`gate-a-packed-node24-matrix.json`, the single-case transfer receipt and the
earlier Windows clone/retirement receipts. No production data or credentials
are part of these generated fixtures.

The first Linux attempt used the host's Windows-mounted PnP tree and exceeded
setup deadlines before obtaining acceptance evidence. It was not retried unchanged:
the maintained-runtime layout with container-local dependencies avoided that
environment issue. The verification harness now shares one fixture pool and has
an independent child deadline accounting for initialization and forced replacements.
No existing Rivet container was stopped or reconfigured.
