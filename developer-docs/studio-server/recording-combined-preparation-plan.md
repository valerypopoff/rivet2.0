# Combined recording preparation plan

Status: implemented as a local candidate and rejected at the request-performance
gate, 2026-11-21. No property-view implementation remains in serving code.
No cloud test or deployment ran.

The [recording latency repair plan](recording-latency-repair-plan.md) is the
active follow-up. The design below records the rejected candidate, not another
request to implement it.

This records the assessed follow-up to the
[recording performance investigation](recording-performance-completion-plan.md).
The [encoder worker candidate](recording-encoder-worker-plan.md) was rejected
and removed. This plan does not reintroduce it.

## Implementation and disposition

The candidate implemented the shared v1 codec boundary, immutable property
views, unchanged memory-walk order, eligibility/fallback checks, optional
reservations, bounded expansion and temporary-state cleanup. The initial
implementation passed 54 focused recorder/hash/memory tests, including new
collision/alias, late-getter, binary-fallback and memory-refusal cases.

The optimistic property-read probe showed a possible saving. The first fully
guarded implementation lost it: mean batch encoding p95 was 1.31 ms versus
1.22 ms, and CPU per batch was 92.04 ms versus 83.33 ms. Removing redundant
bound-summary maps, sets and temporary objects produced a simpler candidate
without reducing its bounds. That candidate used the real serializer entry.

| Isolated encoder profile | Reference mean batch p95 | Candidate mean batch p95 | Reference / candidate CPU per 64 encodings |
| ------------------------ | -----------------------: | -----------------------: | -----------------------------------------: |
| 2 CPU / 4 GiB            |                  1.28 ms |                  1.13 ms |                           83.71 / 79.63 ms |
| 0.5 CPU / 1 GiB          |                  1.41 ms |                  1.24 ms |                           87.62 / 82.08 ms |

Both comparisons used separate local containers and Node 24.22.1. Their v1
bytes matched, all 640 candidate calls per profile used the checked path, and
reservations returned to zero without a rejection. These are preparation
measurements, not a cleared endpoint latency requirement.

The integrated build then failed the existing release gate against the
pre-accounting build. The maintained Linux-driver benchmark ran 16 alternating
pairs of 64 requests at 32 concurrent requests, with real local PostgreSQL and
MinIO. Both APIs used the same pinned application image and common fixture.

- Pooled request p95: **127.81 ms original, 142.09 ms candidate**.
- Pooled p95 difference interval: **-23.41 to +42.62 ms**, inconclusive.
- Mean paired batch-p95 difference interval: **+0.53 to +26.54 ms**.
- Paired last-response completion difference interval: **+10.88 to +45.00 ms**.
- Mean complete/drained time: 1,508.15 versus 1,510.41 ms, inconclusive.
- Every one of the 2,176 expected recordings was audited, including warmup.
  All 1,088 candidate recordings used property views, with zero fallback,
  rejection, remaining capture reservations or execution permits at drain.

The encoder improvement did not remove the existing business-request
regression. This result does not establish whether the candidate is faster
than the protected pre-attempt build: the required original-build comparison
failed first. No favorable encoding number is being substituted for that gate.

Following the stop rule, the candidate was removed. Runtime source was restored
byte-for-byte to the pre-attempt state, including the memory protections. The
codec helper and property-view module were removed; their source and candidate
tests are kept only as ignored evidence. The retained changes are one small v1
collision/alias regression test, final memory snapshots in benchmark receipts,
and documentation. None changes serving behavior.

Restored-state verification passed Core/Evaluations/API builds, 73 focused
recorder/hash/memory/queue tests, seven benchmark-support tests, test-style and
file-tree checks, and all six headless recording-playback browser cases. The
Windows preview process required explicit cleanup after the browser cases
finished; the runner then exited successfully. All six original development
containers stayed running. The removed helper modules are absent from source
and rebuilt runtime output. This verifies the restored state, not the rejected
candidate's release readiness.

Evidence is under `.data/recording-property-views-20261121/`: `source-manifest.json`,
the `full-*-2cpu.json`/`full-*-halfcpu.json` encoder receipts,
`nodes-production-original/result.json`, `samples.jsonl`, `full-v1-source/` and
`rejected-source/`. The full cross-workload matrix, sustained-load phase and
candidate browser qualification were not run after the known request gate
failed. The original performance issue remains open. The assessed design below
is not an instruction to repeat the same unsuccessful candidate.

## Goal and bounded scope

Reduce repeated work in final recording preparation while preserving the
existing v1 format, playback, memory limits, outcomes and request timing.

The proposed change retains **read-only property views from the fresh
pre-encoding memory inspection** and lets the ordinary-data encoder reuse
them. The encoder keeps its own traversal order; native `JSON.stringify`
remains the final encoding step. Active-capture accounting and
queue-admission inspection remain separate: their checks cover different times
when values can change.

Use the current synchronous `recordingMemory.serialize()` entry and current
persistence owners. No worker, extra queue, new await, database change, feature
flag, custom JSON writer, global snapshot cache or per-node encoding policy.
Unsupported or unprofitable cases keep the current serializer.

This is a measured candidate, not an assumed speedup. Sharing a traversal can
still cost more than it saves. Do not integrate broadly before feasibility.
The native final JSON pass and fallback remain synchronous; this plan does not
promise to eliminate every encoding pause for arbitrarily large recordings.

## Facts that shape the design

- `recording-memory.ts` currently inspects retained values at capture time,
  queue admission and just before encoding. It counts unique retained objects
  and long strings, including non-enumerable/symbol properties and native
  backing storage, without invoking user getters.
- `ExecutionRecorder.ts` then builds a transformed object with `mapValuesDeep`
  and finally calls `JSON.stringify`. Removing the transformed object or its
  ordering would be a separate serializer change, outside this plan.
- The codec visits repeated references again; the memory estimator does not.
  These are different responsibilities. A small shared object graph can expand
  into a large encoding, as the worker investigation demonstrated.
- They also visit properties in different orders: the memory stack processes
  pushed children last-first, while the codec processes object entries in
  order. Encoding while following the memory stack is not equivalent. The
  local probe `.data/recording-combined-plan-review-20261121/ordering.mts`
  confirmed different final values for the colliding strings below.
  This plan leaves the memory traversal and its early limit checks unchanged,
  and preserves the encoder's order rather than trying to reconcile the two.
- Getter order is observable. The existing test expects sibling property reads
  before nested reads, followed by custom `toJSON`. A JSON replacer alone does
  not establish equivalence with this two-phase codec.
- String table collisions are also observable. Locally verified long strings
  `costarring-recording-hash-collision-fixture` and
  `liquid-recording-hash-collision-fixture` both hash to `1910960879` with the
  current vendored 32-bit hash. The last encountered value wins. Skipping a
  repeated object can change the decoded result, not just speed.
- The worker candidate increased CPU by roughly 2.5–2.7 times in its container
  encoding tests. Avoid extra copying and another broad eligibility traversal.
  Those results were not endpoint latency measurements.
- The process ledger is a conservative retained-memory estimate, not a hard
  whole-process RSS ceiling. Preserve that distinction in tests and docs.

## Ownership and source boundaries

| Owner                                                                 | Planned responsibility                                                                                            |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `packages/core/src/recording/ExecutionRecorder.ts`                    | Preserve public recorder and stream APIs, fallback traversal and capture timing.                                  |
| Proposed `packages/core/src/recording/recordingSerialization.ts`      | Shared v1 conversion/envelope logic and consumption of read-only property views; no Node or storage dependencies. |
| `packages/core/src/serialization.ts`                                  | Expose only the lightweight helper needed by the server, using the existing package entry.                        |
| `packages/studio-server-api/src/routes/workflows/recording-memory.ts` | Fresh inspection, optional property views and the existing single reservation owner.                              |
| Existing HTTP/WebSocket/Subgraph/scheduled/Evaluation producers       | Keep their calls, captured sources, awaits, queue admission, retries and cleanup.                                 |
| Existing managed/filesystem writers                                   | Keep project/dataset serialization, artifact identity, compression, upload and deletion behavior.                 |

Prefer keeping property-view collection private to `recording-memory.ts`.
Extract one small helper only if it makes that implementation easier to read.
Do not build a generic visitor, serializer framework or new service lifecycle.

## 1. Freeze contracts and reference builds

1. Preserve the current dirty source and compiled-build fingerprints under an
   ignored, task-owned `.data` directory before editing. Do not replace unrelated
   changes or clean the user's development stack.
2. Keep three distinguishable references: the original pre-accounting build,
   the current protected synchronous build, and the candidate. Verify source,
   image and common-fixture hashes; do not patch runtime modules in place.
3. Capture deterministic v1 examples from the current codec before extraction.
   Include normal multi-node recordings and the collision/alias case below.
   Reuse existing binary and replay fixtures instead of committing another
   large recording collection.
4. Record current byte estimates, rejection counts and reservation cleanup for
   representative captures. Match these on the fallback path and maintain all
   current limits on the combined path.

**Gate:** a failing baseline check is understood before attributing it to this
candidate. Historical passing results alone do not validate new code.

## 2. Extract the smallest reusable codec boundary

Move the existing per-recording string-hash cache, string table, asset handling
and v1 envelope construction into a small Core helper. Let the existing
`mapValuesDeep` path call that helper without changing its algorithm or order.

The server needs that same encoding logic to consume inspected properties.
Use a small optional property-reader seam or read-only view map in the shared
codec, whichever benchmarks better. Do not duplicate the codec into an API-side
serializer. Keep the default reader and its getter behavior unchanged. The
server must not duplicate hash logic, thresholds, prefixes, IDs or constants.

Keep these invariants:

- `ExecutionRecorder.serialize()` and `serializeStream()` keep their signatures
  and outputs. Existing deserializers remain compatible.
- All state is per encoding. No cache survives a run or a retry boundary.
- The ordinary path does not allocate or expose the new preparation machinery.
  Keep the small-recording and active-capture paths cheap.
- Preserve own `__proto__` properties through safe data-property construction.
  Do not use ordinary property assignment that changes an object's prototype.
- Do not change the hash algorithm, collision behavior or random asset IDs.
- Views store original keys/values, never mapped values. The codec may revisit
  them for each alias, but cannot overwrite a cached entry while converting it.
  Do not memoize converted subtrees or skip their per-occurrence table updates.
- A view is valid only inside one synchronous preparation call. It is not
  permission to reuse prior recording contents, prior memory measurements or
  an earlier encoding of the same saved project.

**Gate:** existing Core tests, deterministic bytes, decoded binary references
and stream parity pass. Benchmark the extraction alone; it must not account for
a hidden baseline change when evaluating the combined path.

## 3. Reuse final inspection results without changing traversal order

Implement one synchronous, optional preparation inside the current reservation:

1. Apply a cheap size/work prefilter before allocating preparation state. Start
   the experiment with the measured many-event workload. Determine the final
   internal threshold from the crossover measurements; do not expose a setting.
2. Take one shallow `getRecording()` snapshot at the existing encode boundary.
   Keep its ID, timestamps, order and per-run objects. Do not substitute saved
   project contents or change when datasets are selected.
3. During the normal fresh inspection, optionally retain each eligible
   recording object's keys and data-property values already read for memory
   accounting. Do not hash strings or build transformed subtrees in this pass.
   Do not retain an unused descriptor object once its necessary fields are read.
4. Finish the full retained-set inspection, including project, attached data
   and datasets. Cache only objects the event encoder needs, not every project
   or dataset object. Shared objects must still be accounted once across roots.
5. Validate the recording envelope and metadata with the same descriptor-only
   rules. Reuse cached payload views; do not inspect their contents again. This
   small envelope pass is additional work and belongs in the measurements.
6. Once the whole recording is eligible and memory reservations succeed, let
   the existing v1 traversal consume the read-only views in its original order.
   Construct the transformed object, then call native `JSON.stringify` once.
   Resize for the actual result and pass the string to the existing writer.

Keep the views local to the preparation helper. Do not attach them to the
recorder, persistent `Footprint`, capture reservation or saved project. On
success and failure, clear strong view/table references before releasing their
accounting and before invoking the writer. Weak visited sets in the existing
memory owner do not justify adding a strong cache with the same lifetime.

Preserve the memory walk's root boundaries and current event-envelope charges.
In particular, Node-start/finish metadata currently has a fixed charge while
selected payload fields are inspected. Do not quietly replace that with full
metadata accounting or maintain a second independently hard-coded payload map.
Reuse the existing payload selection, leaving its live-event fast path intact.
Its unique-object/long-string accounting, inspection bounds and per-capture
limits must not silently become per-encoded-occurrence charges. Conversely,
the encoded traversal must preserve every occurrence and current string-table
write order. Do not use one visited set for both jobs.

View collection must not short-circuit memory inspection. A cache hit for an
object is not proof that its current memory was counted in this inspection.
Use separate accounting and view state, including for the envelope pass.

The implementation may share low-level inspection helpers, but must not add
callbacks or allocations to every live event merely to support final encoding.
There must not be a new complete eligibility scan followed by the old complete
memory scan and the old complete encoding walk.

## 4. Make optional property caching safe to abandon

The initial cached path supports null, undefined, strings, numbers, booleans
and ordinary dense arrays/plain data objects whose serialization invokes no
user code. Check actual descriptors and relevant prototype behavior once per
preparation. Record that scope explicitly; do not assume every enumerable
property or array behaves like ordinary data.
Include the actual operations used by the fallback codec in this review:
ordinary array mapping/constructor behavior and object/array JSON hooks can
be changed. If that behavior cannot be shown equivalent, select the unchanged
path. Do not add a framework for emulating arbitrary prototypes.

Use the existing codec when encountering accessors, proxies, custom prototypes,
custom `toJSON`, native/binary values, sparse/custom arrays, symbols/functions,
cycles or shapes beyond the bounded speculative work allowance. These remain
supported or rejected exactly as the existing codec handles them; discovering
one is not itself a failed recording.

The fallback must satisfy all of the following:

- Preparation has not invoked getters, proxy traps, custom iterators or JSON
  hooks. Do not discover incompatibility by calling `JSON.stringify` and then
  retrying it. No binary asset IDs are allocated speculatively.
- When caching becomes ineligible, stop collecting and clear the cache while
  the unchanged memory walk continues to completion. There is no suspended
  encoder to resume and no partially populated v1 string/asset table.
- Return from the cache-building helper before releasing its optional memory
  or calling the fallback, so its stack cannot retain discarded views. Invoke
  the original codec once with the completed fresh measurement; do not run
  `measure()` again or discard/restart the recording.
- Keep mandatory capacity rejection separate from an optional preparation
  refusal. A refused speculative allocation must not increment the recording
  rejection counter or hide a subsequent genuine capacity error.
- Use an explicit unsupported/refused result for optional fallback. Do not
  catch every exception and run the codec again: a real encoding failure must
  not cause repeated work or repeated user-hook side effects.
- Avoid rebuilding mapped views of aliases from a cross-run cache. Preserve
  the codec's occurrence order, including repeated string table writes. The
  collision fixture `A, B, A` must have the same final table as the old codec.
  Reusing a read-only property view is allowed; reusing a transformed subtree
  without reproducing its table writes is not.
- Preserve fallback exception type/message and hook invocation order. Failure
  finalizers and known execution outcomes remain unchanged.

Check envelopes as well as payloads, own and inherited `toJSON`, symbols,
non-enumerable fields and array properties. Views are an optimization, not a
new interpretation of properties the current codec would ignore or invoke.
Any missed or inconsistent view after eligibility is an implementation error;
do not hide it by re-encoding after side effects may have started.

Test incompatibility both near the start and near the end of a large recording.
A late fallback is a realistic worst case: its speculative CPU and memory are
part of the performance result, not excluded as exceptional input.
Before full implementation, measure the lower-level cost being removed:
property reflection/read work versus view allocation/lookups. The whole
existing codec time is not the possible saving. If that trade already loses on
the real many-node fixture, stop without adding the rest of the cache machinery.

## 5. Reserve temporary memory before creating it

Use the current 256 MiB/256-capture process ledger, 64 MiB raw-capture limit,
100,000-event limit and current inspection limit. Keep one capture reservation.

| Phase                       | Required reservation behavior                                                                                                         |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Capture and queue admission | Existing behavior and counts; no encoded view is retained here.                                                                       |
| Fresh inspection            | Keep the original lease while discovering current raw ownership, including mutated values.                                            |
| Property-view collection    | Reserve key/value arrays, map entries and traversal state before retaining them. Continue normal inspection if collection is refused. |
| Optional refusal            | Complete the memory walk, leave the helper's stack, drop the cache, return only its optional headroom, then encode normally.          |
| Cached encoding             | Keep raw data and property views covered; reserve transformed containers, tables and hashing buffers before allocation.               |
| Final JSON call             | Reserve the native string allocation and coexistence with raw data and the complete transformed view first.                           |
| Writer and retry            | Keep existing prepared-write headroom, exact bytes/IDs, borrowed lease and finalizer lifetime.                                        |

Do not assume `rawBytes * 3` bounds cached encoding. Track construction work
and encoded expansion as the view is built, including repeated paths, escaped
keys/strings and tables. Establish conservative expansion/headroom bounds
before beginning the cached codec. Reuse retained views, count repeated paths,
and account for both the cache itself and the transformed output. Bound-summary
work is still overhead, not a free operation. Unprovable or excessive expansion
selects the ordinary path before encoding begins. The final string bound must
come from this accounting, not from checking length after allocating the string.

Use coarse, bounded reservation growth if per-property updates are expensive.
Choose its granularity from measurements. Never allocate a block first and
reserve afterward. Account for partially prepared data while it is reachable;
clearing references does not prove the garbage collector has returned RSS.
Keep traversal and bound-summary state bounded as well; use an iterative stack
or stop collection before excessive nesting can overflow its own stack. The fallback
retains the existing codec's treatment of that input.

If fresh raw data needs capacity occupied by optional views, abandon the
optional work before deciding that the original capture no longer fits. Do not
make a valid recording fail merely because this optimization used its budget.
Keep live/accounting state and optional view state separate enough to unwind once
on every exit; do not introduce another independent pool or capture count.

The result is still a conservative estimate. Do not promise a hard heap cap or
protection from arbitrary allocations inside user hooks on the fallback path.

## 6. Prove feasibility before integrating the default path

Build the helper and the combined preparation as an isolated local candidate.
Use the real reservation implementation and real 100-node captures; do not
benchmark just a hand-written JSON loop.

Compare the protected existing path, extraction-only control and candidate in
both 2 CPU/4 GiB/32-slot and 0.5 CPU/1 GiB/4-slot profiles. Include tiny captures,
independent nodes, a connected chain, shared values, large strings, binary/custom
fallback and a late-fallback recording.
Use separate processes/containers with identical limits for the variants.
Do not alternate them inside one CPU-limited process: quota consumed by one
batch can throttle the next variant. Warm each independently and include an
idle baseline for resource observations.

Measure fresh inspection, view collection, envelope validation, expansion
bounds, conversion and final JSON together, including total CPU, elapsed time,
temporary memory and output equality. Count real property inspections in a
diagnostic build to prove the new path avoids reads instead of merely moving
them. Include all eligibility, fallback and reservation costs in the
uninstrumented comparison; do not add permanent per-property metrics.
Prove that eligible fixtures actually use the cached reader and fallback
fixtures do not. Byte equality or faster timing from an accidentally bypassed
candidate is not a valid result. Include all bookkeeping used in the final
build when measuring performance.

Use a fixed, recorded count of alternating paired batches and at most one
predeclared confirmation run. Keep unfavorable results. Freeze the policy and
bound constants before final validation, with evidence for each.

**Gate:** demonstrate a useful reduction in total preparation work without a
repeatable regression in small/fallback cases or changed recording behavior.
An improvement inside one helper does not pass if the full preparation call is
slower. If safety bookkeeping consumes the saving, reject the candidate before
adding more infrastructure or changing memory limits.

## 7. Integrate through the existing synchronous entry only

After feasibility passes, make `recordingMemory.serialize()` use the combined
preparation where eligible, and use the old path otherwise. Callers still
receive a string synchronously; do not add promises or move serialization onto
the HTTP response path.

The current root HTTP/WebSocket, Subgraph, scheduled and Evaluation callers
therefore keep their lifetime and retry rules. Already encoded editor uploads
keep their prepared-upload path. Do not re-encode a prepared storage retry or
automatically retry workflow execution after any preparation/storage failure.

Project snapshots, shared/legacy recording reads, datasets, evidence outcomes,
costs, compression, retention and compaction are unchanged. No changes to
`storage-services.ts`, worker startup or shutdown sequencing should be needed.

## 8. Focused correctness and memory validation

Extend the existing Core and recording-memory suites. Prefer grouped cases and
current fixtures over a new test framework or a duplicate reference codec.

| Boundary            | Required evidence                                                                                                                                                                                |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| v1 bytes            | Deterministic normal and long-string fixtures, metadata/event order, reserved prefixes, Unicode/surrogates, undefined/non-finite values, own `__proto__`.                                        |
| Observable behavior | Sibling/nested getter order; custom/inherited JSON hooks; proxies; sparse/custom arrays; no extra hook call on late fallback; unchanged errors.                                                  |
| Aliases/collisions  | Shared input/output objects, repeated buffers on fallback, pure cycles, the verified colliding strings and `A, B, A` encounter order.                                                            |
| Memory              | Mutation before queueing/encoding; identical raw estimates on representative cases; budget boundaries; partial-view refusal; exact-once cleanup; successful fallback with no spurious rejection. |
| Persistence         | Existing root/child, scheduled/Evaluation and prepared retry tests; blocked storage; failure reporting; shared and legacy playback and deletion/compaction recovery.                             |

Use decoded data/reference checks for nondeterministic binary asset IDs, and
verify retries reuse the same actual prepared bytes. Keep peak-memory/GC checks
in bounded process tests, with no forced-GC requirement in ordinary acceptance.
Also assert that a repeated source object still exposes its original cached
values on its second visit, and that no view survives the helper on success,
late fallback or error. Small-case tests must prove they bypass view creation.

Start with the pinned local toolchain and existing commands:

```powershell
yarn build:hosted-web-deps
yarn workspace @valerypopoff/rivet2-node build
yarn workspace @valerypopoff/rivet-studio-server-api build
yarn exec tsx --test --test-concurrency=1 packages/core/test/recording/ExecutionRecorder.test.ts packages/core/test/utils/fnv1a.test.ts packages/studio-server-api/src/tests/recording-memory.test.ts packages/studio-server-api/src/tests/recordings-store.test.ts
yarn workspace @valerypopoff/rivet-studio-server-api test:recording-durability-managed
node --test scripts/benchmark-recording-memory.test.mjs
node scripts/checks/check-test-style.mjs
node scripts/checks/check-doc-links.mjs
git diff --check
```

Verify final Core ESM/CJS/lightweight exports and the actual packaged Node
24.22.1 runtime. Run the existing headless Playwright recording-playback check
after building the hosted editor. The unchanged API shapes do not replace a
playback check. Register any new focused tests in the existing CI selection;
keep timing assertions and load experiments out of ordinary unit tests.

## 9. Final-build performance and completion gate

Use the maintained recording benchmark, with complete node/lifecycle/value
audits, actual reply timing, bounded drain, matched samples and source/image
fingerprints. Compare the final build against both references from step 1.

1. Recheck the known production-profile regression: 16 alternating pairs of
   64-request, 32-concurrent many-node batches.
2. Run small, connected, large and fixed-arrival mixed workloads in both
   profiles. Evaluate small requests separately within the mixed traffic.
3. Cover late fallback, aliases and stalled persistence. Compare peak retained
   bytes, queue growth, GC/RSS, recording-ready latency and rejection counts.
4. After short comparisons pass, run at least two minutes of sustained mixed
   traffic per build/profile. Keep the driver within the fixture's 4,096 samples
   per batch and 10,000-record retention cap, including warmup. For example,
   3,840 requests at 32/s or 2,880 at 24/s last about two minutes; calibrate the
   chosen rate and also retain the separate saturation tests. Do not discard
   recordings, lower real recording limits or call a low-rate soak a capacity
   qualification to accommodate the harness.

All cases must preserve expected recording contents and return reservations and
execution permits to zero after drain. Designed overload tests may reject only
as their unchanged limits permit; ordinary workloads must not gain recording
loss. Record business p95/p99, full completion/drain, CPU and memory together.

The known regression must clear the existing strict no-slowdown gate against
the pre-accounting build; unchanged/fallback cases must pass as well. Do not
borrow the separate Code-worker latency allowance, count an inconclusive
interval as equality or select only the favorable statistic. Document any
unresolved result explicitly.

Completion means code, compatibility, memory, packaging, playback and final
performance gates all pass. Update Core/recording developer docs with measured
behavior and remaining synchronous work. Leave deployment and release actions
for a separate request. If the candidate fails, preserve its evidence, remove
the unsuccessful runtime change and leave the performance issue open.
