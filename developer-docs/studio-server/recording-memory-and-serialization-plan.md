# Recording memory accounting and serialization plan

Status: accounting implemented locally, 2026-11-21, on baseline `95155d385`.

The [recording latency repair plan](recording-latency-repair-plan.md) owns the
remaining work. This document preserves the implementation and earlier evidence.

One focused performance pass is recorded below; the strict no-slowdown release
gate remains open for small and many-node workloads.
An earlier full-build matrix confirmed a many-node saturation regression in the
larger profile; the focused corrections did not qualify and were reverted.
See the completion plan for the current release blocker and comparison receipts.
Off-thread serialization was assessed and deferred because raw transfer changes
supported values and adds copying overhead. The requirements below record the
design; the implementation and evidence are summarized here. No deployment or
schema change is included.

The [combined recording preparation assessment](recording-combined-preparation-plan.md)
records the next implemented candidate. Reusing inspected property views made
encoding cheaper in isolated tests, but the 16-pair request test did not clear
the original-build latency gate. The candidate was removed and serving source
restored; the current recording-memory protections remain. The performance
issue is still open.

The subsequent implementation and its early rejection are recorded in the
[recording encoder worker assessment](recording-encoder-worker-plan.md). The earlier
requirement to pass the accounting-only latency gate before assessing a worker
is superseded: the combined candidate must demonstrate the improvement.
The candidate tested descriptor-only transport checks, bounded expansion and
post-await memory accounting. It failed feasibility in both container resource
profiles and was removed before producer integration. Scheduled and Evaluation
recording encoders remain synchronous, and the original performance issue is
still open. The restored runtime retains all implemented memory protections.
The [recording performance completion record](recording-performance-completion-plan.md)
retains the earlier plan, findings and validation evidence.
Its revised repair first strengthens the benchmark oracle and drain barrier,
then attributes the confirmed many-node burst regression. The private cache
template cannot replace accounting of mutable run clones. The plan keeps those
fresh checks, removes speculative shared-snapshot machinery and adds connected
graph and continuous-load coverage before local qualification.
That foundation is now implemented and locally checked. The stronger final
comparison audited every node in 2,176 recordings but did not clear the strict
latency gate. No runtime optimization from the follow-up probes was retained;
the completion plan records the remaining blocker and exact evidence.
The design and measurements below describe the existing change and its history;
they do not supersede that follow-up plan.

## Implementation

- `ExecutionRecorder` accepts an optional host capture policy. Default Core and
  Desktop behavior and the v1 codec remain unchanged. Refused captures stop
  retaining events while the graph and its outcome/terminal handling continue.
- `recording-memory.ts` owns a per-process ledger, per-capture estimates and
  preparation reservations. Root/child captures, scheduled runs, Evaluations
  and prepared editor uploads all participate through their existing owners.
- Healthy payloads use the existing synchronous codec in the background
  persistence phase. The worker prototype is not included in serving code.
- Common node-event metadata uses a conservative fixed allowance; only payloads
  are traversed and rechecked from the current event list. No duplicate payload
  list is retained. This avoids stale accounting if event data is replaced and
  repeated inspection of engine-owned envelopes. The codec hashes repeated strings once per serialization while
  preserving its original traversal, string keys and binary representation.
- The shared estimate limit is 256 MiB, with 256 reservations, 64 MiB per raw
  capture, 100,000 events and 250,000 inspected values per estimate step.
  Opaque values are estimated without executing accessors or Proxy traps.
  These are recording-admission limits, not a hard process memory ceiling.
- Queue finalizers dispose accepted captures after completion or cancellation
  before start. Settled data is rechecked for mutation and writer preparation
  retains separate working headroom. Diagnostics expose estimates and rejections
  without payload labels. Persistence closures do not retain the whole session
  result.
- Known outcomes, costs, child coverage, Evaluation policy and existing
  recording enablement stay independent of capture success. No new database
  schema, storage format, deployment switch or service was added.

The follow-up review added regression coverage for native Map/Set contents,
error causes, sparse-array slots and event payload replacement. Collection
inspection uses captured native methods, skipping user-defined iterators and
lazy error-stack formatting. Array length is checked before allocating a list
of keys. A failed WebSocket recorder attachment releases its reservation and
does not prevent the next action from recording. Synchronous writer failures
do not increment the memory-capacity rejection count. Direct prepared uploads
also account for a separate current source project alongside the replay snapshot.

The ownership reassessment reproduced and fixed failures in processor/socket
listener attachment and serving-queue admission. Partial listeners and capture
reservations are released, the original attachment error is preserved, and a
recording-admission error cannot replace a known graph result. A scheduled-run
test double now also releases the capture it withholds, matching the real session.

Settled queue admission now refreshes the current event data as well as snapshot
data. Otherwise a later node could enlarge an earlier output and leave a blocked
queue retaining more data than its old estimate. The fresh pre-encoding check
remains. Both checks share one measurement method; each consumer reserves only
its required working headroom. Re-encoding resets the writer-headroom marker.
Capacity-error classification also contains hostile thrown values so cleanup
still runs and the original failure is preserved.

### Validation and performance disposition

The full regression suite passed 174 tests covering the Core recorder, memory
owner, queue, metrics, published HTTP and WebSocket actions, scheduled runs,
Evaluations and editor uploads. Disposable PostgreSQL/MinIO checks passed for
blocked writes, exact retry bytes, crash recovery, shared snapshots, historical
compaction and deletion races. Six headless browser checks passed for root,
child, nested, legacy and prompt replay plus output-modal ownership. Core, Node,
API and Web builds and generated-client freshness passed separately.
The final error-classification change also passed 27 focused memory/durability
checks, including a hostile thrown value in serialization and synchronous write
setup. Each new cleanup/admission regression failed before its fix.

Profiling separated event/queue accounting, the fresh pre-encoding inspection,
the codec, garbage collection and storage. In the small filesystem fixture,
accounting was about 0.06 ms per request; synchronous SQLite index work dominated
the profile. GC time was similar. The changes target measured avoidable work:

- Equivalent 32-bit FNV arithmetic replaces per-byte BigInt operations.
- Object traversal reuses copied entries, preserving getter order and ordinary
  `__proto__` keys. Closed reservations release their estimator without creating
  an unused replacement.
- The initial FIFO-writer optimization overlapped a fairness turn with storage
  I/O. The later small-request repair restored a fresh turn after each settled
  job: a turn scheduled before storage may already have elapsed. The smaller
  deterministic matrix covers synchronous/asynchronous jobs, FIFO and cleanup.
  See the completion plan for the current endpoint measurements.

A 101-case check retained exact recording bytes, including Unicode, surrogates,
sparse arrays and custom JSON values. A seven-sample 5 MiB codec check reduced
median encoding from 88.23 to 10.95 ms. Bulk property-descriptor enumeration was
slower in a separate estimator probe and was not adopted. The initial stack-reuse
probe did not materially improve small captures; the later completion pass
measured an improvement for many-node captures and retained that optimization.
See the completion plan for the current implementation and measurements.

The filesystem comparisons below predate the ownership/admission reassessment;
they are historical measurements, not performance qualification of the latest
code. The added settled-data check must be included in the next performance gate.
Those comparisons use two separate warm Docker processes,
alternating matched batches so unrelated disk changes do not favor one complete
test run. Production-sized containers have 2 CPU/4 GiB at concurrency 32;
the smaller profile has 0.5 CPU/1 GiB at concurrency 4. Each side has eight
measured batches, excludes warmup, drains recording persistence, verifies every
expected recording and ends with zero reservations. The control disables the
new accounting and uses the `95155d385` codec and queue. Results below are means
of batch p95 latency and complete batch time, in milliseconds; complete time
includes recording drain.

| Profile / workload | p95 control | p95 candidate | Complete control | Complete candidate |
| ------------------ | ----------: | ------------: | ---------------: | -----------------: |
| 32 / small         |       92.37 |         85.79 |          2171.10 |            2201.73 |
| 32 / 1 MiB         |      351.30 |        175.69 |          4009.65 |            1144.77 |
| 32 / mixed         |      143.42 |        114.39 |          3380.42 |            2384.39 |
| 32 / 100 nodes     |      159.99 |        164.87 |          1263.60 |            1318.84 |
| 4 / small          |       63.18 |         62.47 |          2512.77 |            2573.90 |
| 4 / 1 MiB          |      368.94 |        239.27 |          8195.22 |            1768.79 |
| 4 / mixed          |      196.51 |        106.58 |          6079.14 |            3247.03 |

A separate managed test uses the real published handler, local PostgreSQL and
MinIO, 32 concurrent requests, and six alternating pairs per workload. Both
modes share the new queue; the comparison isolates accounting and the codec.
The API runs on the host, so these are not CPU-limited container measurements.
All 4096 expected recordings persisted and the final reservations were zero.

| Managed workload | p95 control | p95 candidate | Complete control | Complete candidate |
| ---------------- | ----------: | ------------: | ---------------: | -----------------: |
| Small            |       33.45 |         35.76 |          3050.11 |            3044.14 |
| 1 MiB            |      301.47 |        187.88 |          4964.97 |            1128.23 |
| Mixed            |      167.64 |         71.20 |          5162.46 |            3294.10 |

Large and mixed workloads improved substantially. Small/many-node comparisons
remain noisy and include worse observations: managed small p95 was 2.31 ms
higher; filesystem small complete time was 1.41% higher at 32 and 2.43% higher
at 4; 100-node complete time was 4.37% higher. An earlier paired small-profile
repeat had nearly unchanged complete time. Do not discard those observations
or claim that passing correctness tests closes the strict no-slowdown gate.
No execution-side storage wait was introduced, but accounting still consumes CPU.

Before release, the next design review should separate the cost of immutable
executed snapshots from mutable event payloads. Meter a snapshot only once if
its immutability and lifetime can actually be proved; object identity alone is
insufficient. Keep fresh mutation checks for event data, every expected replay,
and the existing limits. Do not replace the gate with silent sampling, weaker
memory accounting or a raw worker transfer. The latter changes custom `toJSON`
values, invokes accessors, rejects callbacks and copies backing buffers.

Earlier serial-process experiments (including 60.97 / 66.44 ms small p95)
motivated this pass; they are historical, not the final comparison above. Raw
receipts and probes remain in the ignored `.data/recording-memory-plan-20261121/`
directory, including pre-coalescing results and the first paired repeat. No
deployment or production performance qualification was performed.

## Outcome and constraints

Bound the memory retained specifically for server recording capture and
persistence, and assess whether moving serialization off the serving thread
improves responsiveness. Keep the existing replay format and storage protocol.

- Recording never acquires an execution slot, waits for storage/worker capacity,
  or introduces an awaited bookkeeping step before a business result is sent.
- A recording failure does not change a known graph outcome or rerun a graph.
- Below the capture limits, recorded values, event order, timing, identifiers,
  costs, child coverage and replay behavior remain compatible.
- At recording capacity, stop retaining that capture, release its data, and use
  the existing unavailable-replay/child-coverage states. Do not save a truncated
  recording as a complete replay. Existing recordings remain playable.
- Existing publication, deletion, snapshot sharing, manifest recovery and
  retention rules remain authoritative. No new database schema, file format,
  broker, environment feature flag, operator screen or workflow scheduler.
- No measurable regression to business-run latency or sustainable throughput
  in the local acceptance workloads. Bookkeeping and thread messaging consume
  CPU; their cost must be measured, not described as zero.

This is a recording-admission budget, not a hard limit on process RSS or the
memory arbitrary Code nodes may allocate. Bounded estimates and memory held
only by recording must be distinguished from total application memory.

## Baseline ownership and gaps addressed

| Boundary                                    | Current owner                                                                                                                                                                                           | Required treatment                                                                                                                  |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Event capture and v1 codec                  | [ExecutionRecorder](../../packages/core/src/recording/ExecutionRecorder.ts)                                                                                                                             | Optional server capture accounting; retain default Core/browser behavior and existing codec                                         |
| Published/latest HTTP and HTTP web-app runs | [ExecutionSession](../../packages/studio-server-api/src/routes/workflows/execution-session.ts), [enqueueExecutionRecording](../../packages/studio-server-api/src/routes/workflows/web-app-execution.ts) | Account active capture, retained project data and queued/active preparation through one ownership handoff                           |
| WebSocket web-app actions                   | [WebSocket action owner](../../packages/studio-server-api/src/web-app-action-websocket.ts)                                                                                                              | Same capture budget; preserve settlement timeout and physical-run ownership                                                         |
| Called projects                             | [Subgraph recorder](../../packages/core/src/model/nodes/SubGraphNode.ts), [child persistence](../../packages/studio-server-api/src/routes/workflows/subgraph-recordings.ts)                             | Include active children, queued recorders, immutable project/dataset strings and root coverage                                      |
| Queue and live count policy                 | [Recording store](../../packages/studio-server-api/src/routes/workflows/recordings-store.ts), [configuration](../../packages/studio-server-api/src/routes/workflows/recordings-config.ts)               | Retain FIFO/count policy and add byte ownership for deferred captures                                                               |
| Scheduled runs                              | [Scheduled runner](../../packages/studio-server-api/src/scheduled-runs/runner.ts)                                                                                                                       | Include direct serialization; preserve its existing awaited occurrence-completion contract                                          |
| Evaluations                                 | [Hosted Evaluation runner](../../packages/studio-server-api/src/evaluation-runs/hosted-execution.ts)                                                                                                    | Include direct capture/serialization, but preserve its separate trial store and retry identity                                      |
| Editor recording uploads                    | [Upload routes](../../packages/studio-server-api/src/routes/workflows/local-editor-recordings.ts)                                                                                                       | Preserve negotiated registration and upload semantics; account server-held decoded/prepared data without recapturing browser events |
| Managed persistence                         | [Evidence writer](../../packages/studio-server-api/src/routes/workflows/managed/recording-evidence.ts)                                                                                                  | Preserve existing artifact/upload limits; avoid an unaccounted overlap with raw/encoded captures                                    |

Keep recording enablement separate from accounting. In particular, hosted
Evaluations create a recording session directly and do not use the global
workflow-recording switch. Schedules require both their recording setting and
that switch. Adding one budget must not change either policy, turn on child
recordings in Evaluations, or route Evaluation artifacts into workflow history.
Do not assume updating the common options factory covers these direct callers.

The root and child deferred queues currently pass `0` as retained bytes.
The queue has a 256 MiB prepared-payload limit and a count limit, but neither
measures those raw captures. Active recorders retain event values before any
queue admission. Scheduled and Evaluation serialization bypasses this queue.

The recorder retains references to event data. Its `getRecording()` copies the
event array, not nested values. An estimate cached once per object can become
stale when a later node mutates that object. Typed-array views can also retain
a much larger backing buffer than their own `byteLength`.

Serialization is more than `JSON.stringify`: the v1 codec walks values,
deduplicates strings and binary assets, then emits JSON. Worker transfer must
preserve that codec's behavior. Interactive events contain callbacks which JSON
omits but a raw structured clone rejects. Moving just `JSON.stringify` would
leave the other expensive preparation on the serving thread.

## 1. Freeze the behavioral and performance baseline

Before runtime edits, extend a small recording-specific local harness. Reuse
existing Core/API fixtures and storage-test helpers instead of building another
serving framework or copying all recording tests.

Measure three configurations separately: current code, accounting only, and
accounting plus the serialization candidate. Keep recording enabled in the
primary comparison; recording disabled is an additional overhead/control check.

Use the actual published HTTP handler with a deterministic local graph and no
paid provider, plus focused lifecycle checks for the other surfaces. Include:

- Tiny results, many small events, repeated long strings, distinct large values,
  binary outputs/views, root plus repeated called projects, and post-response
  background work. Include 1 MiB, 5 MiB and near-limit captures.
- Steady traffic and bursts at 1, 4 and 32 accepted roots, with explicit offered
  load. Hold a fake writer behind a controlled gate to exercise a storage stall.
  Repeat representative persistence with disposable local PostgreSQL/MinIO.
- Foreground p50/p95/p99, physical completion/slot release, throughput, event-loop
  delay, recording-ready delay, recording rejection counts, parent/worker CPU,
  process-wide RSS, heap and external/array-buffer memory, and queue bytes/count.
- Independent baseline/candidate processes, warmup excluded and alternating
  measurement order. At least five paired measured runs per acceptance workload;
  record enough completions for useful tail estimates and report uncertainty.
  Do not treat eight diagnostic samples as a tail-latency qualification.

Complete each measured cycle by draining admitted recording work and checking
all expected replays and reservation balances. Do not end measurement at the
last HTTP response while an accumulating recording backlog remains. Include a
small independent endpoint beside a large-recording workload to measure effects
on other requests. A candidate cannot obtain a faster result by dropping more
recordings, disabling capture or silently using a different capture policy.

Measure at the smallest supported execution profile as well as the larger
production profile using local resource limits. Record the exact limits rather
than assuming all available host cores describe production. Count a process's
RSS once: worker-thread RSS is not additional independent process RSS.

## 2. Add one recording-memory owner

Use one per-process recording-memory ledger with per-capture reservations.
Keep ownership with the existing recording service/queue; do not introduce a
second scheduler or merge the existing persistence controllers. Pass the same
accounting capability to all server-created recorders, including direct
Evaluation sessions. Each recorder obtains its own reservation; passing the
same already-acquired handle to multiple child recorders is incorrect. Optional
Core hooks must be platform-neutral and absent from ordinary Desktop/CLI use by
default. The no-budget/default Core path keeps its existing behavior.

The reservation tracks only the capture and its retained preparation data:

1. During capture, charge event envelopes and a bounded conservative estimate
   of retained values. Set both a per-capture bound and a shared process bound,
   and bound event count/active-capture count as well as estimated bytes.
2. On completion, transfer the same reservation to its queued job or direct
   persistence owner. Include project/dataset snapshots and other payloads that
   the owner keeps alive. Use
   already-known serialized sizes/cache metadata where available. Do not walk
   database clients, providers or arbitrary runtime service objects.
3. Before preparation, recheck the settled capture and reserve conservative
   raw/encoded working headroom. Account for the project/dataset codecs,
   UTF-8 buffers, binary/base64 expansion and compression buffers, not only the
   final recording JSON. Adjust to observed sizes while preparing. Native
   serialization can allocate before its exact output size is known; this is
   not a promise of a hard allocation cap. Reject work before preparation when
   estimated headroom is unavailable, and validate peak overlap locally.
4. Charge encoded strings/buffers until their final consumer releases them.
   A queue shift, client disconnect, cancellation request, response completion
   or rejected worker promise is not proof that the payload has been released.
   Release exactly once after the real owner stops retaining it, including on
   errors and shutdown. Worker termination must settle before freeing its
   reservation or starting a replacement against the same allowance.

The lifecycle is capture -> queued/direct preparation -> persisted or discarded
-> released. Existing prepared-upload callers join at preparation. Tests cover
failed handoffs, disposal and a fresh storage-owner generation; an old finalizer
must not release a newer owner's reservation. Do not mask accounting bugs by
clamping an unexplained negative balance to zero.

Keep the existing count policy, including its finite deferred-capture fallback
when `maxPendingWrites` is zero. Lowering a live limit prevents new admission;
it does not silently evict previously accepted jobs or abort business runs.

Use the existing 256 MiB prepared-payload policy as the starting admission
envelope, not as permission to allocate an additional unrestricted raw queue.
Choose the final raw/preparation split and per-capture ceiling from the local
amplification measurements. Include the evidence writer's existing active-byte
budget and worker heap in the calculation. Record concrete constants and their
measurements before enabling them; do not infer a safe value from idle RSS.

### Estimation requirements

No whole-recording stringify, recursive unbounded walk, awaited allocation, or
storage access in a node event callback. The estimator must have bounded work
and an explicit conservative result when its inspection limit is reached.

- Strings: estimate retained characters and overhead without hashing/encoding
  the entire string just to count it.
- Binary views: include the retained backing allocation, not only view length.
  Avoid counting a shared backing allocation repeatedly within an inspection.
- Arrays/plain data: account container/entry overhead with bounded inspection.
  Handle cycles without recursion overflow. Do not invoke getters or `toJSON`
  to estimate size, or retain strong-reference caches of discarded values.
  Proxy reflection can run user code even when inspecting descriptors. Handle
  this at the server boundary without pretending a generic JavaScript walk has
  a guaranteed time bound. Do not run a second full payload walk on every event.
- Repeated references may be conservatively overcounted; indefinite bookkeeping
  to obtain exact deduplication is not justified. Document the approximation.
- Do not use a lifetime `WeakMap` estimate as proof that mutable data has not
  grown. Recheck after settlement, and test mutation between events and after
  the last event. Do not change captured values by deep-cloning every event.
- Ordinary currently supported values must remain supported. If an accounting
  shortcut drops their replay or a bounded implementation cannot meet the
  latency gate, stop and revise it rather than quietly narrowing compatibility.

Finish this estimator feasibility check before wiring it into all capture
events. Measure its own work on large/aliased payloads. Choosing an inspection
limit or repeatedly charging an aliased buffer must not silently cause healthy
representative recordings to disappear. The implementation must document what
an exhausted inspection budget means and how that conservative estimate affects
admission; it cannot call uninspected data zero bytes.

The ledger cannot bound an object that unrelated running code grows without
emitting another event. Nor can it reclaim a value still owned by the processor.
Report those limits explicitly. Tests must distinguish bounded recording
retention from total workflow/Code memory and verify bounded post-settlement
admission; do not advertise byte-perfect live heap accounting.

## 3. Preserve outcomes and release dropped capture data

On capture overflow, stop retaining additional replay events and release the
recorder's retained payload. Keep the minimal completion/evidence lifecycle
needed to observe the real graph outcome. An empty recorder is not a successful
empty recording; carry an explicit internal capture disposition to the owner.
Accounting, release callbacks and diagnostics must not throw into node execution
or reject an accepted business run during recorder construction. Admission
failure produces a non-capturing recording disposition through the existing
reporting boundary; it does not prevent the graph from starting.
Keep creation time, recording identity, cost collection and terminal observation
independent of the event array; clearing a capture must not erase that metadata.

Use existing persisted reasons and UI states where sufficient:

- Root: known success/failure and costs remain truthful; replay is unavailable
  because recording capacity was exhausted.
- Child: mark the existing root coverage incomplete and preserve the root's
  real outcome. Repeated child notifications use the existing bounded/coalesced
  evidence mechanism.
- Evaluation: preserve the trial outcome and its unavailable recording reference,
  without adding the trial to ordinary workflow history.
- Recording disabled: do not attach a budgeted recorder or add per-event work.
  Existing accepted evidence still follows its current completion rules.

Audit recorder listeners, snapshots, queue closures and owner fields so dropping
the internal array actually releases the recording's references. Never dispose
the live processor or break user-input callbacks to reclaim recording data.
Terminal handling remains active after replay capture has stopped.

Construct a narrow persistence payload before enqueueing it. TypeScript's
structural type does not remove extra runtime fields: the HTTP caller currently
passes an entire session result, so closing over it can also retain outputs and
failure objects. Keep only fields needed by persistence. A previous
`getRecording()` or finish-event snapshot still owns its own event array after
the recorder array is cleared; its owner must also drop that reference. Do not
change public Core finish events to solve a server-only ownership problem.

Extend existing low-cardinality recording metrics with estimated active/queued
bytes and capacity rejection reason. Avoid per-event logs, payload labels and
run/project IDs in metric labels. Preserve the current sanitized diagnostics.

## 4. Assess off-thread serialization, then make a gated decision

Only after accounting passes its own gate, prototype one warm serialization
worker behind a narrow internal helper. This is a local assessment first, not
an automatic production integration or a new public execution mode.

The raw-clone prototype is already **ineligible**: local checks found different
serialized values for a class with `toJSON`, even without a clone exception.
Callbacks are therefore not the only compatibility concern. Do not promote
that prototype or build a per-type fallback framework around it. Assess a
minimal compatible handoff; if it needs an expensive second codec or cannot
preserve existing semantics, defer off-thread serialization.

Use the same v1 codec. If necessary, extract a pure `serializeRecording` helper
from `ExecutionRecorder.serialize()` and have both paths call it; do not create
a second codec or change string/asset identifiers. Keep the existing class API.

Measure the entire handoff: main-thread preparation and copying, worker encoding,
result copying, peak overlap and ready-to-persist latency. Specifically:

- Raw `Recording` is not always cloneable. Handle only the transient fields
  already excluded by current serialization, and prove equivalent treatment of
  callbacks, binary values, dates, `toJSON`, accessors, non-plain values, sparse
  arrays and serialization errors. Cloning can invoke getters before the
  existing codec does; do not add observable reads or change their order.
  A costly main-thread normalization pass counts against the candidate.
- Do not transfer/detach a buffer still used by a graph, another event, an editor
  consumer or a cached project. Never mutate the live capture for transport.
- Use a bounded queue and memory reservation before posting. One worker is the
  first candidate; reuse the existing background queue rather than adding
  another unbounded set of promises. Direct persistence callers retain their
  current post-execution await contract. Do not create a worker during a live
  run or couple recording-worker readiness to endpoint availability. Worker
  startup, retirement, packaged file resolution and shutdown are part of
  acceptance; recovery remains bounded and never reruns a graph.
- Preserve one serialization result per accepted persistence attempt. Once its
  bytes enter a manifest or Evaluation artifact, retries use those exact bytes.
  Do not reserialize and obtain different random binary-asset identifiers after
  an uncertain write. Never retry a workflow to replace missing evidence.
- A worker failure rejects only the affected recording, releases ownership and
  leaves future work usable. Do not fall back to a large synchronous encoding
  on the serving thread during saturation. Keep replacement attempts bounded.

Integrate the worker only if it reduces serving-thread stalls while passing the
business-latency, throughput, compatibility and resource gates below. If it does
not, ship the verified accounting independently and record serialization as
deferred. Do not expand this change into whole-workflow isolation; that remains
the separate [hosted execution isolation plan](hosted-execution-isolation-plan.md).

## Local acceptance and lean regression coverage

Extend the existing suites at their owning boundaries. Use controlled gates and
small injected budgets in correctness tests; avoid large allocations, sleeps,
GC-dependent assertions and performance thresholds in ordinary CI.

| Check                        | Evidence required                                                                                                                                                                                                                   |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ownership/admission          | Active roots and children share the limit; queued/active jobs remain charged; overflow/release/reset/disposal paths cannot leak or double-release; prepared editor payloads cannot bypass it                                        |
| Runtime behavior             | A blocked writer or full capture budget does not delay the HTTP business response or release its execution slot early; outcomes/costs remain correct and no workflow is replayed; Evaluation/schedule recording policy is unchanged |
| Retention hazards            | Large strings, many events, nested/cyclic values, repeated references, mutated values, full backing buffers behind tiny views, and retained project/dataset snapshots                                                               |
| Replay compatibility         | Existing v1 fixtures and new healthy captures replay through the existing decoder/player, including binary, timing, nested scope, Watch/partial output, error/abort, user-input and custom value serialization                      |
| Durable lifecycle            | Capacity rejection, worker loss and storage failure keep known outcomes; child coverage remains honest; manifest publication/deletion/recovery and Evaluation exact-byte retry still work                                           |
| Backend boundaries           | Managed PostgreSQL/MinIO, SQLite/filesystem, hosted editor upload and direct scheduled/Evaluation paths; no extra startup storage dependency                                                                                        |
| Packaged worker, if selected | Built Node entry point starts locally, ignores caller-controlled module paths, stays within bounded lifecycle, drains and does not pin process shutdown                                                                             |

Performance acceptance is separate from unit CI. Compare foreground and physical
completion latencies and throughput against the unchanged baseline under the
same offered load; no added failures or recording losses below the declared
capacity. A repeatable latency/throughput regression fails the candidate, even
if serialization itself is faster. Report distributions, paired differences and
uncertainty instead of hiding a regression in a generous percentage allowance.
An inconclusive noisy result is not a pass. Under overload, explicitly expect
recording-capacity rejections and verify memory returns to a stable plateau
without starving accepted workflow responses. No forced GC in acceptance.

Required commands include the existing Core recorder and API queue suites,
API lifecycle/backends tests, Core/Node/API build and type checks, relevant style
checks, and the local managed durability integration. Use the pinned Node/Yarn
and disposable stores. If UI-visible availability behavior changes, also run
the required headless Playwright recording flow before completion. Do not use a
Kubernetes/cloud rehearsal for this local plan validation.

## Local planning evidence, 2026-11-21

The current Core recorder and API recording-store suites passed **51 tests**.
An ignored local probe at
`.data/recording-memory-plan-20261121/assumptions.mts` additionally confirmed:

- With no new event, mutation grew a retained capture from 448 to 1,049,068
  serialized bytes. A one-time object-size cache would miss this growth.
- A recorded user-input callback serializes today, but raw structured cloning
  throws `DataCloneError`.
- A 16-byte typed-array view retained a 1 MiB backing allocation.
- In an eight-sample warmed diagnostic, direct/worker-round-trip medians were
  0.047/0.214 ms for a 256-byte value and 87.519/93.723 ms for a 5 MiB value.
  Decoded recordings matched for those plain-data fixtures. These are local
  diagnostic samples, not serving-latency, memory-cap or production evidence.

The measurements justify assessing handoff cost and compatibility rather than
assuming a worker is automatically faster. They do not approve any budget,
worker count, rollout, or claim that implementation is complete.

The follow-up local reassessment added six passing assumption checks in
`.data/recording-memory-plan-20261121/reassessment.mts`:

- A custom `toJSON` value decoded to `{ label: 'public' }` through the current
  codec but `{ label: 'internal' }` after raw cloning. Neither path threw.
- Raw cloning invoked an accessor once before serialization invoked it again.
- Cloning a 16-byte view also copied its 1 MiB backing buffer.
- Clearing a recorder did not release the payload held by an earlier snapshot.
- Repeated binary serialization produced different bytes with the same decoded
  recording, reinforcing the requirement to freeze bytes once before retries.
- Reflecting property descriptors on a Proxy invoked its `ownKeys` trap; a
  generic descriptor walk is not intrinsically side-effect-free.

These checks validate design constraints, not the performance of a future
accounting implementation. The unchanged 51-test baseline remains applicable;
implementation acceptance still requires the broader gates above.

## Completion and release boundary

The accounting fix is complete only after all capture paths are covered,
reservations balance, old/new replay fixtures pass, and representative local
business-run latency/throughput does not regress. The serialization assessment
is complete with either a qualified candidate or an explicit measured decision
to defer it. Update [recording durability](recording-durability.md) with actual
limits and evidence; retain honest limits on mutable values and process RSS.

Keep the schema, shared-snapshot format, compaction policy and recovery protocol
unchanged. Before a later authorized rollout, verify normal mixed-version reader
compatibility and, if shipped, packaged worker startup on the release images.
No backfill or production maintenance task is part of this change. Deployment
remains a separate authorization.
