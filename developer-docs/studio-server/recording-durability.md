# Recording durability

Managed-storage installations enable new durable recording admission by default.
`RIVET_RECORDING_DURABILITY_ENABLED=false` (or `0`) explicitly disables new
admission; an unset/empty value uses the enabled default. Helm, Docker Compose
and the Kubernetes `.env` launcher use the same default and preserve explicit
opt-out. Deployment still requires the normal release qualification. Filesystem
and SQLite modes retain their existing recording behavior.
The [implementation plan](recording-durability-plan.md) records the original
acceptance matrix and the completed scope.

## Guarantees and limits

With managed storage, recording enabled and
`RIVET_RECORDING_DURABILITY_ENABLED=true`, production endpoints, HTTP/WebSocket
web-app actions and API execution sessions allocate a stable recording identity
immediately and register it in PostgreSQL asynchronously. Registration, outcome
writes do not add an awaited step to graph execution, response delivery or
release of its execution slot. Replay serialization runs in the background
persistence phase on the serving thread; it still consumes CPU. Storage failure
does not reject a business run.
The user explicitly chose this latency policy: a process crash before registration
commits, or a full metadata queue, can still leave no run-evidence entry. Durable
guarantees start after that asynchronous registration commits.

Negotiated hosted Browser/Node editor runs keep their separate pre-invocation
registration protocol; a failed registration there prevents that recorded editor
run. Scheduled graph execution uses asynchronous metadata too, while its existing
occurrence-completion path still awaits replay persistence. Evaluation capture
retains its separate trial protocol. Recording-off and legacy clients retain
their existing behavior.

Execution outcome and replay availability are independent. The actual execution
owner queues its known result before replay persistence. The background writer
waits for registration and outcome handling, never the graph. A lost lease becomes
**outcome unknown**, never a guessed failure. The Node executor owns its lease
even when its browser observer disconnects; the browser cannot override a
Node-owned outcome. Existing web-app/schedule/trial controllers remain the
execution authorities.

Complete replay artifacts use immutable keys and content digests. A bounded
manifest is committed before uploads; an acknowledged handoff means all required
objects are stored and the ready state is committed. Normal recording publication
and available evidence commit atomically. A fresh maintenance owner can verify
and finalize a stranded handoff without invoking a graph. Publication also waits
for a confirmed, matching execution outcome.

Events still only in recorder memory, a dropped queue item, or bytes lost before
upload cannot be reconstructed. When registration committed, their evidence
remains visible as pending or unavailable. No recording system can infer the result of an external business
side effect from a lost owner. This implementation never automatically reruns a
workflow to produce a replacement recording.

Child captures register after completion, sharing the immutable handoff writer
and an explicit root link. Repeated calls have different capture IDs. Missing
snapshots, serialization, admission or upload confirmation mark root coverage
incomplete when observable. An owner crash leaves coverage unknown; this is not
a durable enumeration of every nested invocation. Child-start recording storage
is not a new failure dependency inside accepted business execution.
Known incomplete child coverage is committed together with the root's outcome,
so failure of an earlier coverage update cannot hide either. Lease expiry also
preserves an already observed incomplete child capture. When a WebSocket action is still running at the settlement
deadline or shutdown flush, its replay is marked incomplete; the changing recorder
is never serialized as a completed run. The same rule applies to API sessions
and scheduled captures. HTTP web-app response-mapping errors still return an
action error, but do not rewrite a successful graph's stored outcome and make
its replay conflict with its run evidence.
Unfinished capture is withheld even when durable metadata is disabled. Evaluation
runners also honor the session's withheld recorder, retaining their trial error
without publishing a partial replay as complete.

Evaluations keep their existing durable trial state and Evaluation recording
store, retention and expiry. Their serialized artifact is frozen before writing;
uncertain writes are read back and at most one identical retry is allowed.
Recording failure does not change a successful graph result. Evaluation artifacts
are not duplicated into workflow history or statistics.

## Why these additions exist

The extra state answers two different questions: whether a graph's outcome was
observed, and whether its replay is available. A single success/failure flag
cannot describe a successful graph whose recording was lost. The manifest makes
an interrupted upload recoverable; stable IDs and content checks prevent that
recovery from creating a duplicate or publishing different bytes.

This adds no execution scheduler, workflow retries, separate service or new
operator screen. Production requests enqueue bounded background work; the
existing maintenance worker repairs saved handoffs. The Run recordings UI keeps
its normal controls and only adds the status needed to explain an unavailable
replay. Additional mechanisms should demonstrate a failure this design cannot
handle before expanding these responsibilities.

## Storage, history and recovery

Schema **20** adds `workflow_run_evidence`, indexes and the recording-deletion
trigger. Its bounded JSON contains identity snapshots, outcome and artifact
descriptors, not request bodies or full replay contents. Exception details remain
in the private replay; the journal stores a fixed summary. Tokens and manifests
are excluded from history DTOs.

The existing maintenance owner recovers persisted handoffs; it is not an execution
queue. Healthy writes finish their availability notification directly, so normal
traffic does not consume the recovery backlog. Recovery prioritizes pending
handoffs and uses the existing maintenance cadence (five minutes by default).
It stays off startup readiness. No new service, broker or external scheduler is
required.

Shutdown fences new work, drains accepted recording jobs, stops their evidence
heartbeats, then closes the storage clients. Closing the evidence owner before
draining would let a queued registration restart a heartbeat against closed
storage; `managed-operations.test.ts` covers this ordering.

The shared object-reference query protects manifested pending artifacts from
reconciliation and deletion. Explicit deletion locks and closes pending evidence
before queuing blob deletion; deletion of an ordinary recording also updates its
evidence through the trigger. Late writers cannot resurrect a deleted replay.
Source-project deletion retains historical recordings/evidence as before.

Versioned history requests (`includeEvidence=true`) combine playable recordings
with unrepresented attempts using SQL pagination, without downloading replay
blobs. Old clients keep the playable-only contract. Input predicates cannot match
missing payloads, including `not_exists`; the response reports unsearchable
attempts. Known execution telemetry contributes once to statistics; incomplete
telemetry is excluded with an explicit count. Unavailable replay does not imply
unknown execution cost. No historical backfill is needed.

The managed project picker uses the same combined attempt set for project counts
and global totals in one query. An unpublished project with only pending or
unavailable evidence still appears. Publishing a replay replaces its evidence
contribution rather than adding another run; deleting it removes that contribution.
Global totals retain historical runs whose source project has been deleted, even
though those projects no longer appear in the picker. The UI labels these counts
as runs, not playable recordings.

The existing Run recordings UI shows pending/unavailable/unknown states and
prevents opening a nonexistent replay. New protocol registration/readback routes
use existing UI authorization. Executor access remains an exact service-route
allowlist; no general operator or project API access is added.

Editor uploads validate the project and dataset snapshots before changing a
run's outcome. A pending response is reserved for a verified replay awaiting its
executor-owned outcome; an invalid or conflicting retry cannot use an older
ready handoff as proof of success. The browser likewise rejects definitive
validation/authorization/content errors without replaying the upload, while
retaining bounded readback/retry for uncertain writes and transient failures.

## Numeric bounds

Metadata uses one background writer, yielding to foreground I/O between jobs.
Admission stops at 256 pending metadata jobs rather than consuming the execution
slots or filling the database connection pool. Completed captures serialize in
the existing background persistence queue, not in the request or Subgraph callback.
Server recorders share one in-process memory-accounting owner. Active captures,
queued root/child recordings and direct scheduled/Evaluation captures retain
their reservations until disposal or persistence completion. Incoming prepared
editor uploads join the same accounting at the writer. Recording switches and
the Evaluation artifact store remain independent.

The owner admits at most 256 captures/reservations and 256 MiB of estimated data;
each raw capture has a 64 MiB estimate and 100,000-event limit. Each payload
inspection has a 250,000-value limit. Strings and backing buffers are included, aliases are reused
during capture, and settled payloads are rechecked for mutation at queue admission
and again before encoding. A mutated intermediate value cannot enter a blocked
writer queue using its earlier, smaller estimate.
The recheck reads the recorder's current events rather than retaining a second
payload list. Native Map/Set entries, error causes and sparse-array slots are
included; collection inspection does not call user iterators or format error
stacks. Failed processor/socket attachment removes partial listeners and releases
its capture reservation. Unexpected serving-queue admission errors are reported
as rejected recording work; callers release their captures and retain the graph's
known outcome. The low-level queue still rejects uninitialized policy explicitly.
Error classification cannot let a hostile thrown value bypass capture/write
cleanup or replace the original serialization error.
Completed reservations release their estimator rather than allocating a new
empty one. An estimator reuses its traversal stack and clears its payload
references even on failed inspection; it still remeasures mutable data at both
handoff boundaries. The single persistence worker gives requests a fresh I/O
turn after each job settles, before starting the next job's CPU work. A turn
scheduled before a storage wait may already have elapsed when storage completes.
FIFO order, accepted-job cleanup and the persistence drain contract stay intact.
Completed endpoint responses also get an I/O turn before settled capture
inspection. The execution permit and active HTTP owner stay held across that
handoff, bounding not-yet-admitted snapshots within the existing drain. Discarded
captures and unsent/destroyed responses skip the turn. Both fresh mutation checks
and all memory limits remain unchanged.
Measurement is shared across admission and preparation. Encoding and direct
uploads reserve their working headroom once, for strings, UTF-8 and compression;
re-encoding resets the borrowed writer reservation before a later write.
These are conservative admission estimates, not exact heap/RSS or allocation
limits. Opaque closures/proxies and changes made by unrelated code cannot be
fully measured; garbage collection can retain released allocations temporarily.

Capacity exhaustion discards replay data without cancelling the graph. Known
outcomes and costs remain separate; managed evidence uses its existing capacity
unavailability state and child captures mark coverage incomplete. The v1 replay
codec, immutable artifacts and retry protocol are unchanged. The
[implementation and serialization assessment](recording-memory-and-serialization-plan.md)
records validation and why raw worker transfer was not enabled.
The current local measurements have not cleared the strict no-slowdown release
gate. The latest whole-change comparison improved mixed-workload latency, while
the many-node p95 comparison remained inconclusive and event-loop delay was
higher than the pre-change build. Passing replay/recovery tests alone is not
release qualification. The [current assessment](recording-latency-repair-plan.md)
records those results; the performance history retains the earlier failed and
rejected candidates separately.
Start timestamps are captured before queuing, so a storage backlog does not
shift a run to a later time. Repeated missing-child notifications coalesce per
root, and a dropped root capture marks availability only after registration.

| Boundary                                   | Current bound                                                                                                       |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| Owner lease / renewal                      | 180 seconds / 30 seconds; server owners batch renewals                                                              |
| Upload handle                              | One hour after registration or a valid active-owner renewal/outcome; deletion always fences it                      |
| Metadata / outcome / manifest              | 32 KiB / 4 KiB / 64 KiB database limits; registration input limited to 24 KiB                                       |
| Pending metadata admission                 | Stop new asynchronous registration at 256 pending jobs; admitted runs can still enqueue their completion            |
| Deferred raw captures                      | Existing queue count/fallback plus the shared capture memory reservation; admission does not serialize payloads     |
| Capture/prepared memory admission          | 256 MiB estimated per process; 64 MiB per raw capture; preparation retains its working reservation until settlement |
| Active preparation/verification accounting | 256 MiB per process; existing per-artifact 100 MiB bound remains                                                    |
| Durable pending compressed bytes           | 1 GiB per installation, admitted under a transaction advisory lock                                                  |
| Immutable upload                           | At most three attempts under one 300-second upload deadline; exact keys and bytes only                              |
| Editor upload                              | Existing 24 MiB decoded limit; at most two identical uploads with readback                                          |
| Recovery batch                             | At most ten handoffs; 20-second work-start budget, with separately bounded SQL/blob operations                      |
| Recovery retries                           | At most twelve failures or 24 hours from the prepared/outcome update; exponential backoff up to one hour            |
| Metadata expiry/retention writes           | At most 1,000 rows per policy/pass                                                                                  |
| Deleted/available evidence                 | Trimmed after the upload window and update are at least two days old; normal recording rows remain authoritative    |

Integrity failures and permanent storage permission/client errors close the
handoff rather than repeatedly retrying it. Missing objects may still be an
incomplete upload and get bounded recovery. Unavailable metadata follows existing
recording age/count settings after the late-upload safety window. Pending bytes
cannot be retained indefinitely. These are accounting/admission limits, not hard
whole-process RSS or provider billing caps.

The existing metrics registry exports pending/unavailable attempts, unknown
outcomes, pending bytes and oldest pending age. Labels do not contain run IDs,
project names or payload values. Logs use the existing sanitized recording
diagnostics.
The scrape also exposes estimated recording memory, its limit, retained capture
count and cumulative memory rejections. They are process-local observations,
not measurements of distinct heap objects or whole-process memory.

## Activation and rollback

Once schema 20 and compatible binaries are already installed, enabling the flag
is a configuration-only rolling change. Reuse the exact successful image
qualification and focused flag-validation evidence while their bindings remain
valid; enabling the flag alone does not require rebuilding images, rerunning the
migration or repeating full staging qualification. Keep the Helm setting and
protected CI installation configuration consistent. Verify available durable
evidence as well as protocol capability and healthy Pods after activation.

1. Keep the flag false while applying schema 20 through the maintained migration
   task and rolling all relevant binaries. Chart defaults are 20/20; the existing
   rollback-compatible reader floor remains 17, subject to exact-image evidence.
   When upgrading older binaries, set the opt-out explicitly in Helm values or
   the shared `.env` before the mixed-version rollout; the new default is true.
2. Verify that **all** maintenance, reconciliation and deletion owners understand
   the new reference set. An old GC binary does not know pending manifest keys.
3. Qualify the exact candidate images through the normal staging process, then
   enable the flag on the serving profiles that accept recorded executions.
   Recheck capability negotiation, owner renewal and background recovery.
4. Disabling the flag stops new protocol admission. Existing accepted uploads,
   history reads, finalization and recovery still work. Disabling new recording
   capture likewise does not discard an already accepted durable handoff. Root
   and called-project captures attached to that accepted run can still enter
   the bounded persistence queue; ordinary new captures stay disabled. Existing
   queue count and byte limits continue to apply.
5. Before downgrading the maintenance/GC owner, stop new admission and finish or
   explicitly delete pending handoffs using the maintained recording deletion
   path. Confirm there are no manifested pending/unavailable references:

   ```sql
   SELECT count(*) AS protected_handoffs
   FROM workflow_run_evidence
   WHERE manifest_json IS NOT NULL AND availability IN ('pending', 'unavailable');
   ```

   A nonzero result blocks the GC-owner downgrade. Do not truncate the journal or
   remove blob references to make this check pass. Leave additive schema objects
   installed; normal compatibility/rollback checks still apply.

Historical lost recordings remain lost. Full event journaling is a separate
design, not an implied guarantee of this metadata protocol.

## Local verification

The managed CI lane runs `test:recording-durability-managed`: disposable local
PostgreSQL/MinIO, abrupt child-process exit after upload, fresh-owner recovery,
uncertain transaction acknowledgements, concurrent publication/deletion,
conflicting content, partial upload and the real API execution route.
`verify-managed-workflow-schema.mjs` checks the real migration and bounded
trigger-install lock contention, including preserved legacy rows.

Focused API, App, executor and hosted-provider tests cover asynchronous registration,
registration failure without blocking production graphs, unknown outcomes, capacity,
immutable retries, legacy compatibility and owner separation. Headless
Playwright covers the actual browser recording protocol, ordinary capture
regressions and unavailable history rows.
The metadata drain also covers follow-up work queued by an earlier job and keeps
processing after a rejected job. Child-coverage fault injection verifies that a
known root failure can still publish its replay.

The normal fixture runs correctness and fault-injection checks, including the
blocked-storage execution test. Extra timing samples are opt-in:

```sh
yarn workspace @valerypopoff/rivet-studio-server-api recording-durability:measure
```

This uses the same disposable fixture with `--measure`. It prints
`LOCAL_DURABILITY_MEASUREMENTS` for equal 512 KiB payloads,
five sequential samples per writer, registration time, recovery time and fixture
peak RSS. These measure storage work, not added run latency. A representative local sample measured median registration around
2.3 ms, ordinary writes around 12 ms and durable writes around 24 ms; a short
recovery pass took 4.4 ms. Fixture peak RSS was about 465 MiB, including the
TypeScript/test runtime. This is a loopback diagnostic with compressible data,
not production load or a strict memory-ceiling proof. Production latency and
backlog behavior must be observed during approved activation.

Measurement mode also prints `LOCAL_EXECUTION_LATENCY`: warmed requests through
the real published route, four at a time, with alternating durability-off/on
blocks in the same process and persistence drains outside the timed windows.
On 2026-11-13, the final 16 samples per mode measured median/p95 **8.3/14.5 ms off** and
**8.2/11.7 ms on**. Four additional requests finished in **8.6–16.5 ms** while
registration was deliberately blocked; all execution slots were released before
unblocking, and all four recordings then became available. Unit faults also
hold outcome writes and reject registration while preserving the graph result.
These checks prove storage is not an execution dependency and showed no slowdown
in this local sample. They do not establish zero CPU cost or production tail
latency under sustained load; background storage still consumes finite resources.
