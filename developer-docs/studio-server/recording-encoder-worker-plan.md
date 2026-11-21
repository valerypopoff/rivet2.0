# Recording encoder worker plan

Status: feasibility candidate implemented and rejected, 2026-11-21. No worker
implementation remains in the serving source, and nothing was deployed.
This records the assessed follow-up to the
[recording performance measurements](recording-performance-completion-plan.md).
The subsequent [combined preparation assessment](recording-combined-preparation-plan.md)
records a separate non-worker candidate, also rejected at its request-performance gate.
It supersedes the earlier small-repair scope and the prerequisite that the
accounting-only build must clear its latency gate before a worker is assessed.

## Implementation disposition

The codec was extracted into a lightweight helper and passed all 37 existing
recorder/hash tests. A concrete candidate then added one reusable encoder,
descriptor-only eligibility collection during memory inspection, bounded
alias/output expansion, optional copy reservations and a fresh post-await
memory check. All 12 existing memory tests passed. The candidate did not add a
queue, migrate storage, change recording bytes or relax the memory limits.

The early feasibility gate failed. One actual 100-node GraphProcessor capture
produced 305 events. Each side ran two warmup and eight alternating measured
batches of 32 encodings, comparing the protected synchronous path with the
guarded worker path. Every result matched the original encoded string. There
were 320 real worker calls per runtime, including warmup; the result did not
come from accidentally using fallback. The Docker checks used the existing
API image and its Node 24.22.1 with the production and staging CPU/RAM quotas.

| Runtime/profile                  | Direct mean batch p95 | Worker mean batch p95 | Direct / worker CPU per 32 encodings |
| -------------------------------- | --------------------: | --------------------: | -----------------------------------: |
| Container, 2 CPU / 4 GiB         |               1.17 ms |               3.46 ms |                    41.15 / 109.56 ms |
| Container, 0.5 CPU / 1 GiB       |               8.70 ms |              60.51 ms |                    48.64 / 119.79 ms |
| Windows Node 24.22.3, diagnostic |               0.93 ms |               2.28 ms |                     41.00 / 74.25 ms |

These are encoding feasibility measurements, not endpoint latency or a final
load-test qualification. The half-CPU timings include quota throttling in the
shared container, including one slow direct batch. The separate CPU totals also
show substantially greater work in both profiles. In the 2-CPU container, mean
batch p95 before the first await increased from 1.17 to 1.39 ms; this candidate
did not even reduce its initial serving-thread interval. Moving the remaining
work to another thread did not meet the proposed benefit.

Following the stop rule below, the candidate was not integrated into recording
producers, storage lifecycle or CI. Its source and raw receipts are retained
only under `.data/recording-worker-implementation-20261121/`, including
`assessment.json`, `linux-2cpu.json`, `linux-halfcpu.json` and `rejected-source/`.
All three edited runtime source files were restored byte-for-byte from their
pre-attempt copies, and the four added runtime modules were removed. The
existing recording-memory protections remain intact.

After restoration, Core/Evaluations and API builds passed, along with 72
recorder/hash/memory/queue tests and seven benchmark-support tests. The compiled
encoder and codec-extraction files were also confirmed absent. Documentation
formatting, links and diff checks passed. This verifies the restored state; it
does not qualify the rejected worker or close the pre-existing performance gate.

The sections below describe the rejected candidate and its acceptance rules,
not a completed feature or a recommendation to repeat the same experiment.
Further runtime work needs a different measured approach to reducing encoding
or inspection cost. The original high-load performance issue remains open;
the full endpoint/continuous-load matrix cannot qualify a failed feasibility
candidate and was deliberately not run.

## Outcome and scope

Keep the recording memory protections and existing replay behavior while
removing the confirmed high-load latency regression. Start with the measured
many-small-events case. The earlier worker experiment used a few very large
strings and increased total encoding cost; repeating that experiment unchanged
is not this plan.

Use at most one reusable encoder worker per API process for eligible,
sufficiently expensive recordings in the existing deferred persistence queue.
Keep small, incompatible, unavailable-worker and insufficient-headroom cases on
the existing synchronous codec. Scheduled runs and Evaluations retain their
synchronous encoding: their callers already await persistence, and a worker
round trip has no demonstrated latency benefit there. The worker only encodes
recording events. Project serialization, datasets, evidence and storage stay
with their current owners.

There is no database migration, new service, deployment flag or user setting.
Whole-workflow isolation, offloading storage clients, changing the recording
format and introducing a second persistence queue are outside this scope.

This remains a candidate design. It is complete only when compatibility,
ownership and final-build performance gates pass. A worker does not make the
remaining synchronous checks disappear or guarantee faster execution.

## What the evidence changes

- Current diagnostic measurements attribute about 0.14 ms/capture to live
  inspection, 0.28 ms to admission checks, 0.31 ms to pre-encoding checks and
  1.39 ms to event encoding in the independent-node fixture. These are diagnostic
  values, not a production capacity claim.
- Moving event encoding can plausibly recover more serving-thread time than
  inspection costs, but dispatch/copying and scheduling must be included.
- Small-run bookkeeping, large-string copying, worker heap and fallback traffic
  can erase the benefit. Both 2 CPU/4 GiB/32-slot and 0.5 CPU/1 GiB/4-slot profiles
  must qualify; CPU/RAM reservations alone prove nothing.
- Source templates do not certify mutable recorded values. This design copies
  validated event data at the existing encode boundary, never substitutes a
  cached project revision and never skips a required memory recheck.
- Existing benchmarks already verify all node events, graph lifecycle order,
  complete responses, request identities, bounded drain and matched samples.
  Reuse them. Single-pair measurements have no confidence interval.
- The persistence queue processes one task through encoding and storage before
  starting the next. A worker frees the serving thread during that task; it
  does not create parallel uploads or inherently increase recording throughput.
- Raw retained bytes do not bound codec expansion. A local node-output probe of
  a 12-level shared object graph used a 3,050-byte raw estimate but produced
  102,590 characters of v1 text. The codec expands repeated paths even though memory
  accounting counts shared objects once. This is a worker-admission constraint,
  not permission to rewrite the format or weaken existing capture limits.
  Reproduction: `.data/recording-worker-plan-review-20261121/probe.mts`
  (ignored local evidence; not a performance benchmark).

## 1. Preserve the codec and capture contract first

1. Extract the existing v1 event serialization into a small pure Core helper,
   proposed `packages/core/src/recording/recordingSerialization.ts`. Move the
   existing implementation, including string hashes, binary identifiers,
   traversal, JSON behavior and corresponding decode helpers where needed.
   Do not rewrite the algorithm during extraction.
2. Keep `ExecutionRecorder.serialize()` and `serializeStream()` behavior and
   public signatures unchanged. Both continue through the same implementation.
   Export the string-encoding helper through the existing lightweight
   `@valerypopoff/rivet2-core/serialization` entry for the Node worker.
3. The worker calls that helper directly with a recording snapshot. Do not
   rebuild a recorder using `events.push(...events)`: large arrays can exceed
   argument limits and a second recorder is unnecessary.
4. Pin the semantic boundary: the worker snapshot must represent the values
   the synchronous codec would observe at dispatch, with the same recording
   ID, event order, timestamps and data. Obtain the shallow recording snapshot
   once; never reread a live recorder after dispatch.
5. Preserve the same executed project, attached data, dataset selection and
   writer ownership. Map the lifetime of these objects through each queued
   producer before enabling it. Managed execution materializes per-run copies;
   filesystem execution can reuse a cached definition. Neither a stopped
   recorder nor a saved revision proves that arbitrary retained objects cannot
   mutate. Add a controlled mutation-during-wait test for each enabled owner.
   A producer whose replay source cannot remain correct across the new await
   uses the synchronous path. Do not add another project clone, substitute a
   saved revision or change snapshot timing simply to enable the worker.
   If this excludes the measured root-request workload, the candidate has not
   fixed that workload and cannot pass by testing only immutable Subgraphs.

**Codec gate:** all current v1 fixtures and explicit special-value cases pass
before and after extraction. Exact bytes must match where identifiers are
deterministic; random asset IDs require equal decoded data/reference integrity,
plus identical bytes on retries of one prepared recording.

## 2. Prove a narrow, inexpensive transport guard

The first worker path accepts only ordinary data for which structured cloning
preserves the codec's meaning. Everything else keeps the current codec. Do not
normalize arbitrary objects or introduce a replacement JavaScript serializer.

- Accept primitive JSON-like values, ordinary objects and ordinary dense arrays
  only after checking their actual values. Preserve undefined and non-finite
  number behavior through the shared codec.
- Reject accessors, proxies, custom prototypes, custom JSON behavior, functions,
  symbol values/keys and native objects from this initial worker path. Binary
  buffers, typed arrays, Maps/Sets, dates, boxed values, sparse/custom arrays and
  SharedArrayBuffers use the existing path.
- An ineligible value is not a failed recording. Detection must not invoke a
  getter, proxy trap, user iterator or toJSON method.
- Account for relevant inherited behavior, especially prototype toJSON hooks
  and array properties. The worker has a separate realm; do not assume its
  prototypes match a modified parent realm. Check relevant built-in prototype
  hooks once per dispatch, not once per nested value or once at process startup.
- Validate event envelopes and metadata too. Checking only inputs/outputs is
  insufficient to certify a complete recording. Inspect their descriptors
  before worker eligibility relies on the Core-created envelope fast path;
  rejecting eligibility must not add a user-hook invocation to fallback.
- Reuse information from the mandatory fresh pre-encoding inspection. Have it
  report transport eligibility as well as the existing memory estimate.
  Validate only as-yet-unchecked metadata separately, with a bounded scan.
  A separate full normalization, clone probe or second deep eligibility walk
  defeats the proposed saving.
- First apply the cheap event-count and worker-readiness prefilter. Only its
  candidates request eligibility information from the fresh inspection; small
  jobs and known-busy/unavailable workers retain the existing inspection cost.
- Keep size accounting and eligibility distinct. Extra metadata validation must
  not poison the memory walk's visited set, skip mutable allocations or turn
  an eligibility limit into a dropped recording.
- Support repeated references without changing their contents. Pure cycles
  and excessively deep structures use the synchronous path with its existing
  outcome. Admission must also bound expanded traversal and output size, not
  just unique retained objects. Use capped per-object summaries during the
  optional inspection to account for repeated paths; over-budget or unprovable
  expansion falls back before dispatch. Do not recursively expand the graph
  during the guard or build a second serialization tree. Ordinary shared
  DataValues must remain eligible where their expansion fits; excluding every
  alias would bypass much of the workload we need to improve.
- Finish the fresh check, select the path, reserve copy/worker headroom and post
  the snapshot without an intervening await. Shared mutable native memory is
  excluded; no graph-owned buffer may be transferred or detached.

Node documents that cloning changes class/prototype/accessor behavior and that
transferring a backing buffer affects other views. These constraints are
verified against the pinned
[Node 24.22.1 worker documentation](https://nodejs.org/download/release/v24.22.1/docs/api/worker_threads.html#considerations-when-cloning-objects-with-prototypes-classes-and-accessors),
not handled by assuming that every supported recording is cloneable.

**Transport gate:** exact old/new results for eligible data; unchanged results
and user-hook invocation counts for fallback data. Mutation after dispatch must
not affect the worker's event snapshot. If guard cost requires another full
walk or changes captured values, stop and revise the candidate.

## 3. Run a bounded feasibility test before broad integration

Build one minimal worker using the extracted codec and one active job. Use the
actual guard and memory reservations; a raw-clone microbenchmark cannot qualify.

1. Measure direct versus worker encoding for the existing many-event fixture
   and connected chain, plus small, mixed, large-string and fallback examples.
   Include preparation, dispatch, cloning, encoding, result delivery and total
   CPU/elapsed time. Measure in both resource profiles.
2. Compare against both the protected synchronous build and the pre-accounting
   build. Include a guard/extraction-only build to expose overhead before
   claiming worker benefit. Use whole builds, not runtime replacement.
3. Select one simple policy from the measured crossover: an event-count
   minimum and a copied-byte maximum if both are necessary. Keep constants
   internal and record why those values work in both profiles.
   The earlier string-heavy regression must not be selected merely because
   its byte count is large.
4. Small jobs bypass worker eligibility work beyond existing accounting.
   No adaptive tuner, per-node rules, configurable pool or environment flag.
5. Select finite ready/encoding deadlines and worker heap/stack limits from
   worst-case eligible shape measurements under both CPU quotas. The existing
   64 MiB capture limit is not automatically a safe worker-job limit. Freeze the
   narrower worker limits, output/expansion allowance and selection thresholds
   in a short decision table before integration. Test deadline handling with
   injected clocks, separately from real throttled-runtime measurements.
6. Reject this design early if copying/guard work eats the measured benefit,
   or if the smaller profile cannot sustain it. Do not compensate by increasing
   CPU requests, permitting fewer runs, weakening memory limits or losing data.

**Feasibility gate:** the eligible path provides material serving-thread relief
after its entire handoff cost, with no repeatable business-latency or throughput
regression. Include the post-await memory recheck described below. An isolated
worker timing or one favorable batch is insufficient. Predeclare paired sample
counts and a bounded confirmation rule; retain unfavorable results rather than
rerunning until a favorable interval appears.

## 4. Integrate through current owners

Proposed API modules, added only after the feasibility gate:

- `routes/workflows/recording-encoder.ts`: one worker client and synchronous
  fallback selection.
- `routes/workflows/recording-encoder-worker.ts`: pure v1 encoding entry point.
- `recording-memory.ts`: shared preparation/completion accounting for synchronous
  and asynchronous encoding. Preserve its existing synchronous entry.

Factor preparation and final accounting once. Do not call the synchronous
public serializer after separately repeating its fresh measurement.

| Producer                                         | Required integration                                                                                                                                       |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Published/latest HTTP and web-app HTTP/WebSocket | Keep synchronous queue admission and business response timing. Await the encoder only inside the existing accepted recording task in web-app-execution.ts. |
| Subgraph recordings                              | Use the same encoder in subgraph-recordings.ts; keep immutable child source and root coverage reporting.                                                   |
| Scheduled runs                                   | Keep synchronous encoding and existing awaited recording/permit lifetime in scheduled-runs/runner.ts.                                                      |
| Hosted Evaluations                               | Keep synchronous encoding, artifact preparation and exact-byte retries in evaluation-runs/hosted-execution.ts.                                             |
| Editor uploads                                   | Already encoded; keep their current prepared-upload path without decoding or worker submission.                                                            |
| Isolation prototypes                             | Leave separate hosted-isolation scripts unchanged unless the shared codec extraction requires an import adjustment.                                        |

Never turn `enqueueExecutionRecording` into an awaited encoder call on the
request path. Capture refusal or encoder failure must not alter a known graph
result, cost subtotal or normal endpoint response.
Do not share the recording-search worker pool: searches have different queue,
cancellation and latency requirements. A generic worker-pool refactor is not
part of this change.

## 5. Memory and failure ownership

Use the existing 256 MiB/256-reservation process budget, 64 MiB raw-capture limit,
100,000-event bound and inspection bound. Do not replace the central owner.

| Phase                   | Accounted ownership                                                                                                                |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Active/queued capture   | Existing reservation, including mutable payload checks.                                                                            |
| Before postMessage      | Parent snapshot array, retained source values, transport copy and bounded expanded codec/output headroom reserved before dispatch. |
| Worker active           | Parent capture remains owned; worker copy is additional memory, not a shared reference.                                            |
| Encoded result returned | Parent result and any remaining worker representation remain covered until the worker has released the job.                        |
| Parent persistence      | Existing writer preparation, exact prepared bytes and accepted-task finalizer.                                                     |
| Timeout/crash/shutdown  | Do not release worker-owned capacity until completion or termination is confirmed.                                                 |

If additional worker headroom cannot be reserved, take the existing synchronous
path before dispatch; the optimization must not introduce healthy recording
loss under pressure. Preserve each existing per-capture bound.
Borrow the same capture reservation instead of counting the copy as a second
capture. A refused optional worker reservation must leave the original lease
unchanged and must not increment the dropped-recording counter.

The existing synchronous raw-bytes multiplier is not the worker sizing formula.
Include simultaneous transport allocation, receiver data, expanded codec tree,
string/hash tables, the result in transit and the received UTF-16 string. Use
the admitted shape's bounded expansion and verify peaks empirically. Checking
result length only after JSON.stringify has returned cannot protect its earlier
allocations. Over-budget shapes must fall back before any worker copy exists.

After the worker await, fresh-check any mutable parent capture/project data
still retained and reserve writer headroom together with the returned string.
Do not borrow the stale pre-dispatch measurement across that await or reset a
lease to raw bytes while a worker/result is still owned. A failure retains the
usual recording failure semantics. This additional check is part of the
feasibility cost; avoiding it requires an explicit, tested ownership handoff,
not an unverified immutability assumption.

One worker job may be active, with no second encoder queue. The persistence queue
remains the only deferred queue. A busy or retiring worker is never given another
job; its caller uses the synchronous path. In ordinary queued traffic, FIFO
execution already prevents a second simultaneous encode. Direct producers keep
their current synchronous path throughout this implementation.

The worker receives only its job ID/generation and recording snapshot. It has no
SQL/S3 client, settings loader, project resolver or workflow executor.
Replies are validated for identity, type and size. Parent-side storage keeps
IDs, manifests, publication, retries and deletion handling.
Bound the returned text by its reserved UTF-16 memory allowance in the worker
before posting and again in the parent. Keep heap-size units distinct from
encoded artifact bytes; neither may silently replace the other's limit.

A normal result releases job data before the client marks the worker reusable.
A completion reply must mean the raw job is no longer retained by worker state
or an encoding stack frame. If needed, post it from the next worker turn after
clearing input references; do not infer release merely from starting postMessage.
A stale or duplicate reply cannot release another job's reservation. On a worker
error, messageerror, malformed reply or timeout, mark it unavailable and await
confirmed termination before rejecting the job. Otherwise the queue's existing
finally block would discard the capture while the worker still owns a copy.
If termination cannot be confirmed, retain the job's ownership and let bounded
server shutdown report incomplete drain. Late replies cannot resurrect it.
After dispatch, do not automatically re-encode on the main thread or retry the
graph; the retained parent data may have changed since the original copy.

Existing errors mark replay unavailable/child coverage incomplete and preserve
known execution outcome. Retry of a prepared storage write uses the exact same
bytes and IDs, never another invocation of the codec.

Worker heap limits supplement the accounting; they do not bound native buffers
or guarantee process-wide safety. Measure process RSS once and worker heap
separately. Never add process-wide RSS from each thread as though it were
independent memory. Measure the worker's fixed idle footprint as additional
process overhead; the capture ledger is not a bound on the entire process.
Clearing job references is ownership release, not proof that V8 has returned
memory to the OS. Reuse/soak tests must pass without forced garbage collection.

Healthy worker/fallback traffic must not lose recordings that the synchronous
implementation would accept. A worker crash after dispatch adds a possible
recording failure, reported explicitly as unavailable evidence; it must never
change the known run outcome. This distinction is required in tests and docs.

## 6. Lifecycle and packaging

- The storage composition creates and owns the encoder client. Initialize the
  worker outside request handling; unavailable/not-ready workers use the
  synchronous path. Require a ready message after codec initialization, not
  merely Node's online event. Worker startup must not become endpoint readiness.
- Use a fixed packaged entry URL, explicit worker arguments and minimal
  environment. Do not inherit test/debug/preload launchers or use caller paths,
  eval code, SHARE_ENV or storage credentials. Omit inherited NODE_OPTIONS too;
  preload and heap flags must not silently override the measured worker limits.
- Reuse one worker across healthy jobs. A startup or worker failure disables
  this optional optimization until the normal process restart. Keep the
  synchronous path available with an observable failure state; do not add a
  replacement worker or retry timer in this first implementation.
- Unref an idle worker and ref it while an accepted job is active. No idle
  worker may keep an offline tool or completed test process alive. Do not start
  workers at module import or in offline storage/migration helpers.
- Integrate with WorkflowStorageServices: stop producers, drain accepted queue
  and direct encoding jobs, close the encoder, then dispose storage clients.
  Never create or re-enable a worker while retiring.
- If a worker will not exit within the shutdown budget, report an incomplete
  drain and retain ownership. Do not claim memory was freed or close stores
  while parent work can still use them.
- Verify the compiled entry in the real local API image. Worker startup from a
  source checkout alone is insufficient. Production images currently use Node
  24.22.1; the local Windows 24.22.3 tool is not a substitute for that check.
  Verify the runtime tsconfig, lightweight Core ESM/CJS exports and prepared
  package file list. A missing/broken entry must fail this test even though the
  application can serve through its fallback. No cloud build or deployment is
  required for this local implementation phase.

## 7. Lean validation matrix

Extend existing tests at the real boundary; keep timing assertions out of unit
tests. Add one small encoder-client suite and one real-worker integration fixture.
Proposed files are `packages/studio-server-api/src/tests/recording-encoder.test.ts`
and `recording-encoder-worker.integration.ts` in the same directory. Reuse the
existing memory, recording-store and managed-recovery fixtures.

| Area             | Required cases                                                                                                                                                                                 |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Core codec       | Existing recordings, hashes, Unicode/surrogates, undefined/non-finite values, arrays, custom JSON, getters, binary references, deterministic bytes and stream parity.                          |
| Guard            | Eligible values; forbidden values at root/nested/envelope positions; no user-hook reads; dense versus sparse/custom arrays; realm/prototype hooks; cycles, depth and bounded alias expansion.  |
| Memory           | Peak copy/output overlap, busy/low-headroom fallback without mutation of the original lease, refusal, worker error/timeout, exact-once release, mutation before dispatch and during the await. |
| Worker protocol  | Healthy reuse, real packaged startup, stale/duplicate replies, messageerror, malformed output, crash/timeout, confirmed termination and retirement.                                            |
| Integration      | All producers above, aborted HTTP client with accepted evidence, root/child outcomes and costs, complete recording trace and correct replay project.                                           |
| Storage/playback | Existing PostgreSQL/MinIO crash/lost-ack/delete tests, shared and legacy snapshots, exact Evaluation retries, headless recording playback.                                                     |

A mutation-during-worker-wait fixture must check both event data and replay
project/attached data. Keep the existing run-specific source and its defined
writer snapshot point. An asynchronous change that selects another revision or
changes deterministic expected content blocks that producer's worker path.
Exercise managed, SQLite and legacy writer selection rather than assuming one
storage mode's ownership contract covers the others.

Use the maintained benchmark's invalid-data tests and drain timeout cases.
Fault injection is bounded and must not run a real workflow twice.

Start local validation with the pinned toolchain and existing commands:

```powershell
yarn build:hosted-web-deps
yarn workspace @valerypopoff/rivet2-node build
yarn workspace @valerypopoff/rivet-studio-server-api build
yarn exec tsx --test --test-concurrency=1 packages/core/test/recording/ExecutionRecorder.test.ts packages/core/test/utils/fnv1a.test.ts packages/studio-server-api/src/tests/recording-memory.test.ts packages/studio-server-api/src/tests/recordings-store.test.ts packages/studio-server-api/src/tests/recording-encoder.test.ts
yarn exec tsx packages/studio-server-api/src/tests/recording-encoder-worker.integration.ts
yarn workspace @valerypopoff/rivet-studio-server-api test:recording-durability-managed
node --test scripts/benchmark-recording-memory.test.mjs
node scripts/checks/check-test-style.mjs
node scripts/checks/check-doc-links.mjs
git diff --check
```

The proposed integration fixture must select the final compiled entry even
when the fixture itself runs through tsx; assert a real worker handled the job.
Register it in the relevant existing CI/build checks, not only this manual
command. Then use the existing headless Playwright runner for
recording-playback-history.spec.ts. Do not put load measurements into normal CI.

## 8. Final performance and acceptance

Run the existing final-build matrix with its improved audit and clocks:

1. Known independent-node regression: 16 alternating pairs, 64 requests/batch,
   32 outstanding, 2 CPU/4 GiB.
2. Tiny workloads in both profiles, then connected chains and fixed-arrival
   mixed traffic. Analyze small requests separately within the mixed case.
3. Saturation, busy-worker/low-memory fallback, large strings, binary/custom
   fallback and cold-worker startup. Record worker selection and eligibility
   reasons so a nominally passing test cannot bypass the new path. Include
   concurrent recording searches and synchronous scheduled/Evaluation work to
   check contention with existing workers and direct producers.
4. The two-minute continuous mixed-load checks, with queue/memory trends and
   final drain, after the short cases pass.

Preserve matched sample sizes, driver lateness bounds, source/image/harness
fingerprints and all failures. Resample matched batches; a single pair has
point estimates only. Keep the existing strict no-slowdown gate; do not borrow
the separate Code-isolation allowance or treat an inconclusive interval as
equivalence.

Record business p95/p99, completion/drain, recording-ready latency, CPU, RSS,
worker heap, maximum reservations/backlog and rejection counts. A large encoding
slowdown is still a problem even if response dispatch improves. The known root
request regression must improve against the pre-accounting build with an
interval excluding regression; unchanged/fallback cases must also meet the
existing gate. Ambiguous measurements remain unqualified. Fixed worker
overhead, post-await checks and optional-admission refusal belong in these
results; do not subtract them from the reported cost.

Completion requires:

- Compatible recordings and fallback semantics, with no additional healthy loss.
- All current memory protections and truthful failure/outcome reporting.
- Final-build latency and throughput gates pass in both profiles.
- Bounded lifecycle and packaged-image tests pass.
- Core/Node/API/Web builds, relevant unit/integration tests, headless playback,
  formatting, focused lint, file-tree and documentation checks pass.
- Only the qualifying implementation remains; failed probes stay in ignored
  local evidence.
- Developer docs state the measured policy and remaining synchronous behavior.

If any gate fails, the change remains local and unqualified. Record the precise
failure and remove the unsuccessful runtime candidate. Do not replace it with
a broader execution-worker architecture without a separately reviewed plan.
