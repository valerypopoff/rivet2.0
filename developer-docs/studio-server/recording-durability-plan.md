# Durable run evidence and recording recovery

Status: implemented locally on 2026-11-13 and reviewed through 2026-11-14; cloud qualification, activation and
deployment remain separate. New admission is disabled by default. The exact
implementation and activation procedure are in
[Recording durability](recording-durability.md).

## Implementation reconciliation

- [x] Shared evidence contract and additive schema 20, with immutable artifact
      manifests, atomic publication, uncertain-write readback and deletion protection.
- [x] Asynchronous registration/outcome writes for production endpoints,
      HTTP/WebSocket web-app actions and scheduled graph execution; separate
      pre-invocation registration for negotiated Browser/Node editor runs.
- [x] Post-capture child handoffs and explicit incomplete root coverage, without
      adding a child-start database dependency to accepted graph execution.
- [x] Actual executor ownership, leases, background recovery, pending object
      references, bounded retries/retention, statistics and safe history DTOs.
- [x] Adapter failure review: child-coverage errors cannot suppress root outcomes;
      WebSocket and scheduled captures withhold incomplete replays; HTTP response
      mapping preserves the graph's outcome. Metadata drain covers follow-up jobs
      and continues after an individual rejection.
- [x] Adjacent capture/upload review: recording without metadata and Evaluation
      runners honor withheld captures; rejected editor snapshots leave outcomes
      untouched; invalid/conflicting retries cannot acknowledge an older handoff.
- [x] Evaluation capture keeps its existing trial/recording ownership; immutable
      retry/readback cannot turn successful execution into a recording failure.
- [x] Local PostgreSQL/MinIO process-crash, concurrent deletion, partial upload,
      uncertain-commit, real API, browser and compatibility checks; CI wiring.
- [x] Shared catalog aggregation includes unpublished projects with only pending
      evidence and counts each run once through publication/deletion. Browser
      catalog mocks accept the evidence query parameter so delayed/error scenarios
      still exercise their intended behavior.
- [x] Test cleanup moves duration permutations into unit coverage, keeps one
      browser display check, combines pending/completed session reuse and replaces
      hidden continuation delays with explicit gates. Repeated timing samples are
      opt-in; crash recovery and blocked-storage execution remain in normal CI.
- [x] Local before/after writer measurements and documented numeric budgets;
      blocked-storage and request-latency checks exercise the production boundary.
      These are local diagnostics, not production throughput guarantees.
- [x] Disabling recording stops new admission while preserving already accepted
      root/child captures under the same queue limits; unit and real API checks.
- [ ] Approved exact-image staging qualification and operational activation after
      all maintenance/GC owners understand schema-20 references.

## Requested behavior and completion evidence

The original pre-invocation registration requirement was subsequently changed by
the user: production runs prioritize execution speed and register asynchronously,
accepting the crash window before their first metadata commit. Negotiated editor
runs retain their separate pre-invocation protocol. Do not restore a blocking
production write while implementing or releasing this feature.

| Requested behavior                    | Implementation                                                                                            | Local verification                                                                                                 |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Identify recorded attempts            | `run-evidence.ts`, `execution-session.ts`, editor registration and executor ownership adapters            | Registration outage/blocked-write tests; real endpoint and editor API fixture                                      |
| Reuse existing execution histories    | Scheduled occurrence, web-app `sourceRunId`, Evaluation trial/recording adapters                          | Scheduled, web-app, Evaluation and ownership regressions; no new execution controller                              |
| Repeat writes without duplicate runs  | Stable handle/capture IDs, immutable artifact descriptors and fingerprint checks                          | Lost acknowledgements, conflicting payloads, concurrent finalizers and rejected retries                            |
| Recover uploads after process loss    | Managed manifest, recovery task and shared live object-reference query                                    | Actual child-process exit after uploads, fresh-owner finalization, deletion races and partial uploads              |
| Truthful history, filtering and costs | Evidence-aware history/catalog/statistics and the existing Run recordings UI                              | SQL/HTTP regressions and headless browser cases for pending, unavailable, unknown and unsearchable entries         |
| Bound overhead and preserve speed     | Deferred single metadata writer, bounded capture queue, off-path serialization, existing parallel uploads | Concurrent real requests while storage is blocked, local latency samples, queue bounds and disable-during-run test |

The implementation and local verification are complete; release readiness is a
separate step. The feature remains off by default. It still requires the normal
reviewed publication, exact-image staging qualification, schema-20/maintenance
owner verification and approved production activation. None of those cloud
operations is implied by completing this implementation checklist.

## Goal and exact guarantee

For a new, recording-enabled top-level hosted execution accepted under this protocol:

1. Allocate a stable identity and asynchronously save a small durable entry.
   Production graph execution, response delivery and execution-slot release must
   not wait for recording storage. As explicitly chosen by the user, a crash
   before this first commit or metadata-capacity rejection can leave no entry.
   After registration commits, a missing replay remains visible in history.
   Negotiated editor runs retain their separate pre-invocation registration.
2. Keep execution outcome and recording availability separate. A recording
   failure must not turn a successful graph into a failed graph; a vanished
   execution owner must not be described as a confirmed graph failure.
3. Once the complete replay payload has been acknowledged as durably staged,
   finish publication after an API restart without executing the graph again.
4. Expose a pending or unavailable replay honestly, including a safe reason.

This does **not** guarantee a complete replay after a crash while its events or
unfinished upload exist only in memory. It preserves evidence of the attempt
after registration commits and reports the gap. Guaranteeing every event through an arbitrary crash would
require a separate event-journaling design; metadata alone cannot provide it.
It also cannot prove whether an external business side effect completed.
Called-project captures share the durable upload/finalization protocol, but this
plan does not promise a pre-execution history entry for every nested invocation.
Requiring another successful registration in the middle of an accepted graph
would add a new business-execution failure mode. Missing child capture is instead
reported as incomplete coverage on the root evidence when observable; an owner
crash leaves coverage unknown. Do not claim complete child enumeration after a crash.

Use the existing PostgreSQL database, S3-compatible blob store and managed
maintenance owner. An additive database migration is required. No new broker,
service, cluster, database product or execution-retry mechanism is proposed.

## Rechecked assumptions

| Assumption                                            | Source-checked conclusion                                                                                                                                                                | Consequence                                                                                                                         |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Every recording uses the in-memory queue              | False. API workflow/web-app and API-hosted called-project captures enqueue callbacks; editor uploads and scheduled recordings write directly. Evaluations use their own recording store. | Fix the shared persistence contract and each admission boundary, not just the queue.                                                |
| No executions have durable state                      | False. Managed web-app actions, scheduled occurrences and hosted Evaluation trials already have durable owners and state.                                                                | Reuse those identities and outcomes; do not create another execution controller.                                                    |
| Graceful drain covers crashes                         | False. The queue is an array of callbacks and the Core recorder stores events in memory.                                                                                                 | An acknowledged handoff cannot be an in-memory callback. The chosen fast production path accepts the pre-registration crash window. |
| Failed persistence always means no recording exists   | False. Blob uploads or the SQL insert may have succeeded before acknowledgement was lost. The writer deliberately retains uncertain artifacts.                                           | Stable IDs, fingerprints and readback are prerequisites to retrying persistence.                                                    |
| Correlation ID is a unique recording ID               | False. A root and its called-project recordings share correlation; a graph can call a project repeatedly.                                                                                | Assign one stable ID per run/capture and an explicit root link. Keep correlation for investigation; do not invent direct parentage. |
| Existing writers can be retried unchanged             | False. The managed writer currently creates a fresh recording ID and a fresh replay-project ID for every call.                                                                           | Freeze IDs and serialized content before the first write; reject conflicting duplicates.                                            |
| No recording means a failed execution                 | False. Recording may be disabled, capture incomplete, persistence pending, evidence expired/deleted, or outcome unknown.                                                                 | Model and present those states separately.                                                                                          |
| A project deletion deletes its retained recordings    | False. Managed recordings intentionally outlive their source project.                                                                                                                    | Preserve historical ownership snapshots; do not cascade evidence away with the current project row.                                 |
| “Local storage” needs a second durable implementation | False for supported serving. Local-storage commands run PostgreSQL/MinIO; filesystem/SQLite are migration/compatibility internals.                                                       | Implement managed durability once and preserve old adapters without expanding their guarantees.                                     |

Owning sources:

- [Queue and overflow](../../packages/studio-server-api/src/routes/workflows/recordings-store.ts)
- [API recording capture](../../packages/studio-server-api/src/routes/workflows/web-app-execution.ts)
- [Direct editor uploads](../../packages/studio-server-api/src/routes/workflows/local-editor-recordings.ts)
- [Scheduled capture](../../packages/studio-server-api/src/scheduled-runs/runner.ts)
- [Evaluation capture](../../packages/studio-server-api/src/evaluation-runs/hosted-execution.ts)
- [Managed recording writer](../../packages/studio-server-api/src/routes/workflows/managed/recordings.ts)
- [Blob uploads and uncertain inserts](../../packages/studio-server-api/src/routes/workflows/managed/revision-factory.ts)
- [Core recorder](../../packages/core/src/recording/ExecutionRecorder.ts)
- [Called-project execution](../../packages/core/src/model/nodes/SubGraphNode.ts)
- [Project deletion](../../packages/studio-server-api/src/routes/workflows/managed/project-deletion.ts)
- [Supported server stack](server-stack.md)

## Data model and ownership

Add a managed run-evidence table and a small typed repository. It is an
observation/persistence record, never authority to start, retry or cancel a graph.

Required fields, split into typed columns and a bounded manifest as appropriate:

- Stable run/capture ID, root ID, recording ID allocated once, source
  domain and source-run identity when another durable owner already exists.
- Project/graph/revision identity, surface, run kind, name/path snapshots,
  correlation ID and start time. Record actual unsaved editor execution as such;
  do not substitute the current saved project for its executed snapshot.
- Execution state: accepted, running, succeeded, failed, suspicious, or outcome
  unknown. Existing surfaces retain their cancellation outcome conventions;
  do not invent a distinct confirmed-cancelled state from a lost connection.
  Only the execution owner supplies a known
  terminal result; loss of contact alone yields outcome unknown.
- Recording availability: pending, available, unavailable, or deleted. A fixed
  reason code explains unavailable evidence, such as queue capacity, capture
  incomplete, serialization failure, upload incomplete or retry deadline reached.
- Root/child capture coverage, distinguishing complete, known incomplete and
  unknown. A child row observed only after completion must not claim durable
  acceptance before execution.
- The owner identity/lease for surfaces without an existing durable owner;
  version/fencing data for updates, attempts and retry time for persistence.
- A prepared-artifact manifest: immutable blob keys, encoding, byte sizes,
  content digests, replay-project identity and metadata fingerprint.
- Final duration and cost only when observed. Preserve partial/unknown cost;
  never invent zero cost or complete totals for an interrupted observation.

Do not put request bodies, credentials, arbitrary provider exceptions or complete
recording payloads into this metadata table. Replays retain their current private
blob storage, access controls and capture policy.

For schedules, managed web-app actions and Evaluations, reference the existing
run/trial identity and lifecycle. Where needed, store an immutable terminal
projection for history before the source owner's own retention removes it.
That projection cannot renew ownership or contradict the live owner.
Evaluation payloads keep their existing Evaluation recording store and expiry;
do not copy them into workflow recording history or counts.

### Acceptance and failure policy

- Resolve authorization, project identity and existing execution admission limits
  first. Allocate a recording identity without storage I/O and defer registration
  through one yielding background writer. Metadata never invokes a graph.
- Production recording registration must not delay or reject a graph. Use bounded
  metadata admission and retain the stable ID for uncertain-write readback. A
  failure before registration commits may leave no history entry; do not claim
  unconditional durable acceptance or resubmit execution to manufacture one.
- Once a graph has started, a recording/storage failure does not abort it or
  change its business result. Keep a bounded attempt to save evidence; if that
  cannot succeed, leave a visible pending/unknown entry for recovery.
- Recording-disabled execution keeps its current execution behavior and does
  not allocate replay payloads or a new general-purpose run journal. Existing
  scheduler/web-app/Evaluation histories still follow their own contracts.
- Hosted editor recording is negotiated through a versioned capability. For
  the new protocol, registration failure is shown before a recorded run starts;
  the existing recording-off choice remains available. Old servers/clients keep
  their explicitly weaker compatibility path. Desktop/CLI are unaffected.

## Persistence protocol

Keep an ordinary fast path and one recovery path, both using the same idempotent
finalizer. In-memory work may schedule serialization/upload but is never called
durable acceptance of a replay.

1. On physical graph settlement, enqueue the observed execution outcome separately
   from replay serialization, then release the execution slot. The persistence
   worker awaits registration and outcome handling. A serializer or dataset-export failure must not
   erase a result already known to the execution owner. Freeze the executed
   project/attached data, applicable dataset snapshot, recorder content and the
   environment-derived capture policy; do not reread unrelated live retention
   settings or substitute later saved content. Preserve early-response semantics:
   sending a foreground response
   does not finalize still-running branches. Apply the existing conservative
   settlement policy when cancellation cannot fully settle.
2. Serialize and prepare immutable artifacts. Allocate the recording and replay
   project IDs once, not again on retry. Persist the artifact manifest before
   uploading so recovery knows the exact keys it may inspect. A manifest that
   names objects does not claim that those objects have been stored.
3. Upload the required recording, replay-project and optional dataset artifacts.
   Preserve the current parallel upload behavior. A timeout or lost reply is
   uncertain: inspect the deterministic keys and verify content descriptors;
   do not create fresh identities or overwrite mismatching content. Use the
   artifact descriptor's real content digest; an S3 ETag or mere object existence
   is not sufficient integrity verification.
4. Acknowledge the replay handoff only after all required objects are durable
   and its ready-to-finalize state is confirmed committed. An upload client may
   then discard its payload. Before that boundary it must retain it or explicitly
   report that it could not retain it.
5. Insert/link the normal recording row and mark evidence available in one SQL
   transaction. A repeated finalize of the same ID/fingerprint returns the same
   result. A different payload for that ID is a conflict, not success.
6. On uncertain commit, read the recording and evidence rows back. Retry only
   this idempotent publication, with bounded attempts, backoff/jitter and a
   finite deadline. A callback/notification failure never repeats the insert.
   Reads/writes also have operation deadlines, including a stalled queue task;
   retries cannot wait forever behind one hung storage operation.
7. The existing managed maintenance owner recovers stranded handoffs in bounded,
   indexed batches. If every manifested artifact is verified, finalize it even
   after its execution owner disappears. If required bytes never reached storage
   and no live uploader retains them, mark the replay unavailable after its
   handoff deadline. Do not claim reconstruction or restart the graph.

For a lost execution owner, use the database clock and a lease/heartbeat (batched
per process) only where an existing durable owner does not already provide one.
Expiry changes the observation to outcome unknown; it does not prove the process
stopped or that side effects failed. Accept an authorized late completion from
that same immutable invocation, after validation, unless deletion/retention has
closed it. A late payload additionally needs an open upload window, or an
already-durable handoff eligible for finalization; an expired handle cannot create
new indefinite storage. Recovery cannot replace the execution owner or authorize
a second invocation. Concurrent finalizers are fenced independently of execution
ownership.

## Execution-surface integration

| Surface                        | Required integration                                                                                                                                                                                                                                                                                                                                |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Published/latest HTTP workflow | Queue registration after normal auth/admission without waiting for database I/O. Retain accepted-work/body/permit ownership through physical graph settlement, then release it independently of recording completion.                                                                                                                               |
| HTTP/WebSocket web-app actions | Reuse the managed action run identity when present; queue recording registration/outcome independently of execution and response delivery. Keep existing action acceptance, reconnect state and request deduplication authoritative.                                                                                                                |
| Hosted browser execution       | Register via the host persistence provider before invocation; finish/upload using the returned stable handle. If a browser disappears, mark observation unknown, not confirmed cancelled. Do not require browser storage for server-hosted durability.                                                                                              |
| Hosted Node editor/preview     | Bind evidence to the executor's accepted request and actual processor lifetime, not just browser connectivity. Propagate the handle through the reliable session protocol; loss of its observer must not falsely end a running executor.                                                                                                            |
| Called-project Subgraphs       | Reuse the existing completion callback and recorder's stable capture identity. The host adapter binds captured child artifacts to the root handle and shares durable staging/finalization. Report observed child capture failures on the root; do not block child execution on another database registration or claim pre-execution child coverage. |
| Scheduled runs                 | Use the occurrence's existing acceptance/lease/outcome; graph execution does not wait for recording metadata. The existing occurrence-completion step awaits replay persistence. Never requeue a started occurrence to recover its replay.                                                                                                          |
| Hosted Evaluations             | Retain trial ownership and the existing stable Evaluation recording reference. Verify uncertain writes/readback in that store; expose unavailable artifacts through existing trial state. Do not add duplicate workflow recordings.                                                                                                                 |

Keep this in existing host adapters; Core remains storage-agnostic and needs no
new persistence lifecycle for the initial implementation. Run evidence identifies
an attempt, not an application `request_id` input, and does not introduce
deduplication of separate HTTP requests.

## Resource bounds, retention and access

- Preserve the 24 MiB decoded editor-upload bound and its separate JSON transport
  bound. Measure representative server recordings before introducing any new
  server payload ceiling; never silently truncate accepted replay content.
- Keep configured pending-write limits; deferred raw captures use a 64-item
  fallback when that count is zero so they cannot accumulate without bound.
  Do not serialize on the execution path merely to measure retained bytes.
  Bound active serialization/upload by count **and** bytes; account separately
  for durable pending bytes and retry backlog. Do not replace a bounded queue
  with unlimited retained callbacks, database payloads or stored blobs.
- Metadata describing a known accepted run must survive local payload-capacity
  rejection. Mark the artifact unavailable with a capacity reason; do not drop
  its evidence or block a graph that already started.
- Choose and document finite handoff/retry/retention limits from the local
  workload measurements before enabling the feature. Pending work cannot retain
  storage indefinitely; limits must cover shutdown grace and ordinary outages.
  Do not silently change existing installation limits to enable it.
- Extend the shared managed object-reference query and every relevant destructive
  policy to protect manifested pending artifacts. Reconciliation, stale-upload
  pruning, retention and deletion must agree on the same live reference set.
- Explicit deletion/retention atomically closes the evidence and cancels its
  pending publication before queuing object deletion. Keep a bounded tombstone
  sufficient to reject late uploads/retries. Recovery must not resurrect a
  deliberately deleted recording. Project deletion alone retains historical
  evidence according to the existing recording policy.
- Continue LLM profile suspension holds, post-save evidence links and cache
  invalidation. Derive/reconcile links from committed availability so a lost
  notification does not require repeating persistence.
- Use the existing recording authorization boundary for registration, readback,
  upload and history. Validate stable handles against their bound project,
  invocation and immutable fingerprint. Executor access additions remain exact
  service routes; never grant general operator API access.

## History, search and compatibility

Preserve `workflow_recordings` as the table of committed playable artifacts.
Do not insert placeholder artifact keys or label a pending upload as a recording.

Add an additive, capability-versioned evidence/list DTO. New clients combine
playable legacy recordings with unrepresented evidence entries using bounded
SQL pages and explicit identity links, producing one row per invocation.
Old recording endpoints and clients retain their current playable-only contract.
No historical backfill is needed: existing recordings remain readable, and
previously lost runs cannot be invented or recovered by migration.

The normal Run recordings view shows Pending, Recording unavailable (with a safe
reason), or Outcome unknown where appropriate. Opening a replay is enabled only
when its artifact is available. Known execution status is displayed independently.
Use the existing table, modal and status patterns; no new separate operations UI.

Keep filters and statistics honest:

- A failed-execution predicate does not match a successful execution merely
  because its recording failed. Unknown outcomes are not fabricated failures.
- Input predicates cannot test an unavailable payload. Omit those entries from
  input matches and expose the number of unsearchable attempts in scope; even
  `not_exists` cannot infer an absent field from absent data.
- Distinguish execution counts from playable-recording counts. Include metadata
  only once in cost/run statistics, preserve current surface exclusions and
  root/child counting, and retain partial/unknown cost semantics.
- Stable pagination/grouping uses run/capture identity and logical start time.
  Availability transitions must not duplicate a run or fabricate direct parentage
  from correlation or a root link. Display known-incomplete/unknown child coverage.
- Bound evidence queries independently of project-tree loading and replay blob
  reads so this work does not regress the recent recordings performance fixes.

## Ordered implementation

| Phase                                          | Owning code                                                                                                                                                                        | Deliverable and stop condition                                                                                                                                                                                                                   |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1. Contracts and regression fixtures           | `studio-server-shared/workflow-recording-types.ts`, API recording tests; new managed evidence repository                                                                           | Agree exact state/acceptance semantics and write the fault matrix first. Stop if a proposed state implies replaying a graph or inventing a known outcome.                                                                                        |
| 2. Additive schema and idempotent writer       | `managed/schema-migrations.ts`, `managed/recordings.ts`, `managed/revision-factory.ts`, `data-backend.ts`, `storage-backend.ts`                                                    | Add next migration, indexes and stable-ID/fingerprint prepare/finalize operations. Keep legacy callers supported. Prove uncertain-commit readback and concurrent finalize before enabling retries.                                               |
| 3. Admission and capture adapters              | `execution.ts`, `execution-session.ts`, `web-app-execution.ts`, `subgraph-recordings.ts`, `scheduled-runs/runner.ts`, web-app run store, Evaluation capture/store                  | Establish the top-level durable acceptance boundaries and shared immutable handoff. Reuse existing owners/callbacks and report child coverage honestly. Never claim durable top-level acceptance on a path that only registers after completion. |
| 4. Editor protocol and recovery                | App `ProvidersContext.tsx`, `editorRunRecording.ts`, local/remote executor hooks; host persistence provider/API; executor request handling; managed maintenance/reference policies | Negotiate the protocol, bind actual executor ownership, recover uploads/finalization, preserve deletion/retention. Stop if browser disconnect is treated as executor death or pending blobs are considered unreferenced.                         |
| 5. History and diagnostics                     | shared DTOs, managed recording/evidence queries, `RunRecordingsModal.tsx`, `RecordingRunsTable.tsx`, statistics, recording diagnostics and metrics                                 | Show missing/pending evidence without fake replays, duplicate costs or broken input searches. Preserve old clients and existing LLM profile health links.                                                                                        |
| 6. Local qualification and release preparation | owning unit/integration/Playwright suites, schema/release compatibility docs, workflow publication docs                                                                            | Run the matrix below and benchmark overhead. Publish implemented guarantees/limits in developer and user docs. No deployment is part of this plan's approval.                                                                                    |

Keep one evidence repository and one reusable finalizer, with small surface
adapters. Do not introduce a generic job framework or rewrite the execution engine.

## Required local acceptance matrix

Use deterministic unit faults first, then actual local PostgreSQL/MinIO with
child-process termination and a fresh API owner. Fake-pool tests alone cannot
prove committed metadata, restart recovery, transaction ordering or SQL races.

| Injected condition                                                                              | Required result                                                                                                                                            |
| ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Registration unavailable/acknowledgement lost                                                   | Production graphs and responses proceed without waiting; queued writes retain the stable ID. Negotiated editor registration still fails before invocation. |
| Crash after registration, before processor starts                                               | Entry remains; state says execution was not confirmed/outcome unknown, never success or automatic retry.                                                   |
| Crash during graph execution or after early HTTP response                                       | Entry remains visible; no guessed terminal result, fabricated replay, resumed graph or repeated business side effect.                                      |
| Known successful/failed/exhausted-profile outcome, then queue full or serializer failure        | Known outcome is preserved when its update committed; availability shows the precise missing-capture reason. Existing failed-chain recordings still work.  |
| One of the parallel blob uploads fails or loses its reply                                       | Verify exact keys/digests; complete from still-retained bytes or recover already-present bytes. Missing bytes are honestly unavailable.                    |
| Crash with all artifacts stored but final ready/update/insert not acknowledged                  | A fresh process discovers the registered manifest and publishes exactly one recording with the same identities and bytes.                                  |
| SQL commit reply lost or two finalizers race                                                    | Readback/fingerprint validation returns one committed recording; conflicting content is rejected.                                                          |
| Notification/logger/profile-health callback fails after commit                                  | Recording remains available; linking/diagnostics failure never repeats insertion or graph execution.                                                       |
| Owner lease expires while partitioned, then valid completion arrives                            | Initially outcome unknown; validated late evidence can resolve it without replacing ownership or undoing deletion.                                         |
| Delete/retention races with finalize, late upload or reconciliation                             | No resurrection, unsafe object deletion or unbounded tombstone/backlog. Project deletion preserves historical records as before.                           |
| Browser closes, executor reconnects, overlapping preview requests or repeated child calls occur | Stable separate run/capture IDs, correct actual owner, no duplicate record, no false cancellation or root/child collision.                                 |
| Recording storage fails during a nested Subgraph                                                | Do not introduce a graph failure to register the child. Retain root evidence and report child coverage incomplete/unknown honestly.                        |
| Recording disabled, dataset capture disabled, old client/server, legacy recordings              | Preserve existing opt-outs, authorization, payload policy, supported compatibility and no unnecessary payload allocation.                                  |
| Input filtering/statistics across pending/unavailable/legacy/child entries                      | No false `not_exists` matches, hidden unknown cost, duplicate totals or unbounded blob scans.                                                              |
| Recovery under restart/load and a large valid recording                                         | Bounded work/memory/storage and no long new request/shutdown waits.                                                                                        |
| Recording registration/outcome blocked while concurrent requests execute                        | Requests finish and release execution slots before storage unblocks; retained work completes afterward without repeating graphs.                           |

Extend the existing recording queue/HTTP/managed, async-response, scheduled,
web-app-coordination, editor recovery and hosted Subgraph suites rather than
duplicating them. Add one focused managed durability integration fixture for
process-crash/uncertain-write cases. Use local fake providers; no AI API spend.

Run API/App/Core type checks and scoped lint, then the relevant real-storage
integration fixtures. For UI changes, run the required headless runner:

```powershell
$env:PLAYWRIGHT_HEADLESS = '1'
$env:PLAYWRIGHT_SLOW_MO = '0'
yarn studio-server:ui:observe local-editor-recordings.spec.ts
```

Extend the appropriate recordings UI spec for unavailable rows/search/statistics,
and run it as well. Inspect `artifacts/playwright/` on a browser failure. Finish
with the documentation-link and repository policy checks relevant to the diff.

Measure before/after metadata-registration latency, end-to-end request latency,
serialization/upload throughput, database work per invocation, pending bytes,
peak RSS, and shutdown/recovery time at equal concurrency and payload sizes.
Batch heartbeats, perform no per-token/node or child-start database writes, retain parallel
artifact uploads, and keep backlog draining off startup readiness/the rollout
critical path. Record actual measurements and chosen numeric bounds before release;
do not promise a latency figure before measuring it.

## Rollout and completion criteria

Use the normal migration task and immutable-image release path. Test old/new API
and editor combinations and the supported rollback manifest against the additive
schema before release. Existing replicas may finish with the legacy writer during
the first update; advertise the stronger guarantee only for invocations negotiated
and accepted under the new protocol. Protect new pending references during mixed
versions: old maintenance binaries do not know the new reference table. Update
and verify the maintenance/GC owner before enabling new handoffs, and quiesce or
finish/cancel protected pending work before rolling that owner back. If this cannot
be proven, gate activation/rollback rather than trusting an additive schema alone.

Completion requires all surfaces above covered, all local fault cases passing,
visible and truthful unavailable evidence, verified resource bounds and measured
overhead, plus a documented mixed-version/rollback procedure. Historical missing
recordings and events lost before durable staging remain unrecoverable. A later
approved staging rollout and production release verify deployment behavior; this
planning task starts neither.
