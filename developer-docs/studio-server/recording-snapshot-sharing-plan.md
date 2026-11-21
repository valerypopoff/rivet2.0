# Share project snapshots in Run recordings

## Scope

For new managed durable recordings, use one S3 replay project object per
exact executed project state. Each recording keeps its own trace, replay tab
ID, optional datasets and run metadata. A thousand recordings of the same
state should reference one replay project object. Retrospective conversion is
an optional operator tool, outside the serving application and its images.
Normal maintenance does not search for retrospective conversions. This scope
covers the supported PostgreSQL/S3 deployments, including local storage with
MinIO. Durable opt-out, legacy imports and filesystem and SQLite
compatibility continue to produce per-recording artifacts.

The separate [Brotli recording plan](recording-brotli-plan.md) covers the new
trace codec and bounded historical recompression command. Those changes are
implemented locally and do not change shared project snapshot ownership or retention.

Fingerprint the same executed project and attached data that capture already
hands to persistence. Serialize with the original project ID and hash the
exact UTF-8 bytes before compression. The existing serializer stabilizes
map ordering. Keep all replay-visible changes, including layout and attached
data, in the fingerprint. A managed revision ID only identifies saved
content. Hosted editor capture also accepts unsaved snapshots, and the
execution service materializes mutable per-run project data from immutable
source bytes. Root and called-project recordings retain their own captured
versions and lineage.

[Durable writer](../../packages/studio-server-api/src/routes/workflows/managed/recording-evidence.ts) ·
[Editor capture](../../packages/studio-server-api/src/routes/workflows/local-editor-recordings.ts) ·
[Execution materialization](../../packages/studio-server-api/src/routes/workflows/managed/execution-service.ts) ·
[Project serializer](../../packages/core/src/utils/serialization/serialization_v4.ts) ·
[Called-project capture](../../packages/studio-server-api/src/routes/workflows/subgraph-recordings.ts)

## Storage and playback

- Add one small managed catalog keyed by project ID and content digest.
  Store the current immutable S3 key and whether that object is pending,
  verified or unusable. The catalog supplies an indexed lookup and a lock
  for coordinating reuse and reclamation even before a run row exists.
  Use the existing artifact descriptor for encoding, integrity and size.
  Allocate a fresh physical generation in a dedicated workflow-owned replay
  snapshot prefix for each new object. Recordings and pending manifests
  already have a place for the full key. The catalog can outlive its source
  project.
- Keep the authenticated replay API and project file format. Return unconverted
  legacy project objects byte-for-byte. For a shared project key, validate its
  workflow ownership and artifact integrity, then set the project ID in
  the serialized envelope to the durable recording ID. Preserve graph
  and node IDs and every other replay field. The shared object is standard
  project v4 JSON, with the source ID first in the metadata. The reader checks
  that prefix and replaces the ID without parsing or reserializing the graph.
  Older browsers already accept this v4 representation. The live project and
  recordings still open in separate tabs.

[Artifact descriptor](../../packages/studio-server-api/src/routes/workflows/managed/artifact-descriptor.ts) ·
[Replay API](../../packages/studio-server-api/src/routes/workflows/recording-http.ts) ·
[Recording artifact lookup](../../packages/studio-server-api/src/routes/workflows/managed/recordings.ts) ·
[Editor playback](../../packages/studio-server-web/dashboard/editorDetachedProjectCommands.ts)

## Persistence

1. Work at the existing persistence boundary. The endpoint and web-app
   recording queue starts with `setImmediate`. Keep serialization, hashing,
   snapshot lookup, manifest changes and uploads inside that work. The
   editor uploads after execution. Scheduled completion is different. The
   scheduler holds a published execution permit through recording persistence
   and occurrence finalization, so benchmark that whole interval as well
   as the graph. Keep its current completion behavior and the existing
   queue and upload budgets.
2. On a verified hit, take a short shared lock on the catalog row while
   binding its key to the existing durable manifest. Reuse the stored
   descriptor. A hit needs zero gzip, PUT, HEAD or GET work for the replay
   project. On a miss, prepare bytes outside the transaction and reserve
   the winning key together with the pending manifest before uploading.
   Concurrent cold writers bind under the same lock and may finish that
   reservation if their bytes match its descriptor. If the encoding differs,
   a new capture can use the existing per-recording format before it commits
   a manifest. The shared descriptor defines its codec. Per-run artifacts
   continue to use the run's frozen compression settings.
   Use the existing conditional upload and verified readback. Pass the same
   deadline through the duplicate-upload verification path. This keeps
   compression and encoding negotiation out of the catalog and avoids a
   queue of waiters for another run.
3. Record verification for the exact catalog key once its upload or readback
   is confirmed. A failed trace upload should still leave the verified
   project available for reuse. Keep locks and transactions free of S3
   calls. A fresh capture can fall back before binding a manifest if the
   sharing lookup exceeds its bounded budget. Retain the same durable
   recording ID and ownership on fallback. Resolve an ambiguous manifest
   commit by readback first. For an existing manifest, validate the retried
   payload against the bound snapshot digest and artifact descriptors and
   keep its keys. Existing recovery verifies and publishes the original
   manifest. Recheck that the shared key is still verified when finalizing
   so a known unusable object cannot get another available recording row.
   The pending pin and retained row exchange in that transaction. Recovery
   uses stored artifacts and recording metadata.
4. Trust verified catalog rows on the warm path. Use confirmed absence from
   reconciliation or an integrity failure on replay or recovery to mark
   the exact key unusable. Future captures can save their own playable
   snapshot. Keep existing references for diagnosis and restore, and keep
   authorized deletion governed by the reference checks below. Timeouts and
   authorization failures remain storage errors. Continue using existence
   scans for reconciliation and checksum checks for payload reads.

[Deferred queue](../../packages/studio-server-api/src/routes/workflows/recordings-store.ts) ·
[Endpoint recording handoff](../../packages/studio-server-api/src/routes/workflows/web-app-execution.ts) ·
[Scheduled recording completion](../../packages/studio-server-api/src/scheduled-runs/runner.ts) ·
[Schedule permit lifetime](../../packages/studio-server-api/src/scheduled-runs/service.ts) ·
[Conditional object writes](../../packages/studio-server-api/src/routes/workflows/managed/blob-store.ts) ·
[Existing durability contract](recording-durability-plan.md)

## Deletion and retention

Recording deletion, retention and failed-upload cleanup release their
references through the existing tables and enqueue only their own objects.
Project deletion still preserves retained recordings and their snapshot
references. Route shared project objects through a single bounded pass in
the existing maintenance owner. Take an exclusive lock on each catalog
candidate before doing a fresh read of its recording rows and recoverable
manifests. Remove the unreferenced catalog row and enqueue its exact key
in the same transaction. The outbox retains its final reference check.
A later recording with the same digest gets a fresh physical key, so a
delayed delete can only affect the retired generation. Reconciliation
protects live catalog entries, including pending reservations. Pending
artifacts may still be uploading. Handle unrelated late orphans through
the existing reconciliation policy.

Use the recording key and pending manifest as the references. Start with
the existing workflow-scoped indexes and bounded candidate batches.
Measure reference lookups with a large history concentrated in one project.
Add an index to a populated table only if that measurement calls for one
and the rollout supports building it safely.

Keep the current age, count, byte-limit and hold rules. The byte limit
continues to charge the full replay size to each recording as a conservative
retention budget. Use object inventory for physical storage savings.

[Object references](../../packages/studio-server-api/src/routes/workflows/managed/workflow-object-references.ts) ·
[Outbox and maintenance](../../packages/studio-server-api/src/routes/workflows/managed/maintenance.ts) ·
[Retention and deletion](../../packages/studio-server-api/src/routes/workflows/managed/recordings.ts) ·
[Project deletion](../../packages/studio-server-api/src/routes/workflows/managed/project-deletion.ts) ·
[Reconciliation](../../packages/studio-server-api/src/routes/workflows/managed/reconciliation.ts)

## Rollout and restore

1. Use the existing maintenance cutover from schema 22. Close editor and
   endpoint admission, fence older readers and writers, and verify a restored
   copy of the frozen database and object checkpoint. The migration creates
   the empty snapshot catalog and compaction checkpoint tables. It leaves
   original recording rows and objects intact. The rolling migration path
   refuses this transition because older readers and backup tooling cannot
   handle shared replay ownership.
2. Serve with schema 23-aware images and backup tooling. Managed durable
   writers share snapshots by default, without an activation switch.
   Older releases also started retrospective conversion automatically; the
   current server does not. An upgrade can leave legacy recordings readable
   in their original format or convert them with the separate operator tool.
3. Capture metadata and object storage from the same checkpoint. Backup
   inventory captures each shared object once, includes existing artifacts
   of recoverable manifests and retains the inert compaction checkpoint for
   schema/restore compatibility. Only a replay project can refer to a shared
   key owned by its workflow. Recovery
   after the cutover uses schema 23-compatible images or the reviewed
   pre-cutover backup procedure. Legacy imports still accept dedicated replay
   project files.

[Managed migration policy](../../packages/studio-server-api/src/routes/workflows/managed/schema-migrations.ts) ·
[Maintenance cutover](deployment-operations.md#schema-23-shared-recording-snapshots) ·
[Managed restore drill](../../deploy/studio-server/scripts/kubernetes-managed-restore-drill.mjs) ·
[Legacy restore scope](../../packages/studio-server-api/src/legacy-restore/scope.ts)

## Compact existing recordings

The one-off converter lives under `packages/studio-server-api/maintenance/`.
It is excluded from production TypeScript compilation and runtime packaging,
including when packaging a full development build. There is no automatic
registration, timer or checkpoint scan in the serving application. The small
`workflow_recording_project_compaction` table stays in schema 23 and backups;
removing it would need a separate migration and compatibility review.
Normal maintenance uses the same task list for requested and scheduled passes;
the converter's former periodic-only scheduling mode has been removed.

Use a source checkout matching the installation, with the normal workspace
dependencies installed and built. Supply the installation's storage/settings
environment and its mounted maintenance-pause inputs through the usual
protected operator mechanism; a database URL alone is not that environment.
The command verifies the managed schema, respects release/VM migration pauses,
and takes the restore serving lease. It neither starts a server nor registers
a worker.

```sh
yarn studio-server:recording-projects:compact --limit 100 --max-seconds 30
```

Use `--workflow-id ID` to limit the batch to one project. The command reads the
installed storage settings, verifies schema 23, and holds the existing
restore lease. Pass the returned `nextAfter` as `--after` with the same
workflow scope. An uninterrupted batch with a null cursor reached the end.
Rerunning a batch skips committed replacements. If storage fails temporarily,
the command stops and the last reported cursor remains safe to reuse.

Compaction uses the saved replay file and its attached data. It requires
equivalent deserialized content and an independently readable shared blob.
The API uses the recording ID as the replay project ID after conversion.
Open tabs continue through the recording's existing virtual path. The run
row keeps its trace, datasets, retention accounting, and outcome. Files with
active upload windows or unsettled evidence keep their current pointer.
Unreadable or incompatible files also keep their current pointer. When
creating a new shared blob for a historical recording, the command compares
its size with the original to avoid increasing storage for a unique snapshot.

Before uploading a new shared blob, the command records a deletion intent
with a five-minute grace period. Publication locks that intent and cancels
it in the same transaction that swaps the pointer and queues the original
blob for deletion. If the process dies before commit, the original remains
readable and maintenance can reclaim the abandoned upload. Compaction
skips any candidate whose cleanup has become eligible or been claimed.

The outbox applies the usual reference check before deletion. Batch output
counts queued original bytes and bytes added for published shared snapshots.
Storage use falls as the outbox drains, subject to the bucket's object-version
retention policy. Use object inventory to measure reclaimed bytes. The
command runs outside the serving process and uses its own bounded database
connections. Normal maintenance still reclaims unreferenced snapshots and
drains the deletion outbox; it does not perform retrospective conversion.

[Compaction](../../packages/studio-server-api/maintenance/recording-project-compaction.ts) ·
[Operator command](../../packages/studio-server-api/maintenance/compact-recording-projects.ts)

## Local release checks

- **Store once.** Use real PostgreSQL and MinIO. Create 1,000 healthy
  captures of the same project in the local measurement run. Count one
  replay project object and 1,000 independent traces. Keep the deterministic
  CI fixture small. Check zero replay-object requests on warm reuse. Run
  concurrent cold writers in separate processes, vary encoders, change layout
  and attached data, and serve both draft and published captures.
- **Play both formats.** Verify the real API's legacy replay bytes and the
  shared response's recording-specific ID and preserved fields, including
  a called-project recording. Open the live project, a legacy recording,
  and two shared recordings with different outputs through the existing
  Playwright flow using real API responses. Verify independent playback
  after switching tabs with a node output modal open. Exercise an existing
  browser bundle.
- **Recover and reclaim.** Interrupt at manifest, upload and finalization
  boundaries. Exercise lost acknowledgements, a stuck reservation, a
  missing or corrupt shared object and a fallback with the same recording
  ID. Prove each execution still runs once. Test concurrent last-reference
  removal and new attachment, protected holds, source deletion and a late
  delete after a new physical generation exists. Restore a mixed-format
  backup. Check that the ordinary rollout refuses schema 22, the maintenance
  migration preserves its records and the manifest rejects schema 22 rollback.
- **Qualify historical compaction.** Kill the operator command after a real
  shared upload and before publication. Verify the old replay still opens
  and maintenance can reclaim the abandoned upload. Overlap two commands
  and live replay, expire a candidate before publication, and resume without
  moving a committed pointer again. Start the real periodic maintenance owner
  and verify it leaves dedicated recordings and the legacy checkpoint untouched.
  Restore compacted history and verify the project, trace and attached dataset
  from the restored storage.
- **Keep runs fast.** Compare shared writes with a dedicated-write baseline
  in the local measurement fixture. Use warmed small
  endpoints and large projects, concurrent cold writes and sustained
  traffic while the background queue drains. Block only the recording
  registry or its S3 writes and prove public requests complete and release
  their permits. Measure editor completion and scheduled permit occupancy,
  including mixed endpoint and scheduled load. Run interleaved comparisons
  with enough samples for p50/p95/p99 and record throughput, event-loop
  delays, CPU, pool waits and queue depth. Include large replay opens
  during active runs. Require zero new foreground snapshot work and no
  reproducible latency or throughput regression before enabling shared
  writes.

Extend the existing managed durability integration test and
`recording-durability:measure` command. Use the deterministic stalled-storage
assertions in CI and report measured latency separately. Run the replay
browser suite with `PLAYWRIGHT_HEADLESS=1`, `PLAYWRIGHT_SLOW_MO=0` and
`yarn studio-server:ui:observe recording-playback-history.spec.ts`.
Run migration-ledger and rollout-source checks on the candidate. These
checks turn the storage and latency goals into rollout gates.

[Durability and latency fixture](../../packages/studio-server-api/src/tests/recording-durability-managed.integration.ts) ·
[Playback browser fixture](../../packages/studio-server-web/playwright-observe/recording-playback-history.spec.ts)

## Local verification

Run `yarn workspace @valerypopoff/rivet-studio-server-api run recording-durability:measure`
for storage counts and timings in disposable PostgreSQL and MinIO. The
benchmark interleaves sharing on and off against the same build. It records
endpoint responses during concurrent recording writes and replay reads,
scheduled permit occupancy during endpoint traffic, and the editor's
post-execution recording upload time. Append `--sharing-latency-only` to
repeat the timings separately. Build the API workspace and append
`--compiled-compaction` to exercise the operator entry point from the full
development build during the historical compaction fixture. That build output
is not included in serving images. Ordinary shared-recording and operator
checks use separate restore fixtures. A real periodic maintenance pass verifies
that dedicated recordings and the old checkpoint remain untouched.

The retirement recheck on 21 November 2026 passed the managed integration,
69 focused recording/maintenance tests and six browser playback cases. Full
development-build packaging retained normal recording maintenance and excluded
the operator and its tests; the runtime compiler also excluded those files.
Shared writing, replay and recovery code did not change during retirement.
These are compatibility and cleanup checks, not new latency measurements.

In the counterbalanced local run each mode had 256 endpoint samples, 24
scheduled permits, 24 editor uploads and 16 replay opens per project size.
The table shows p95 values in milliseconds.

| Measurement             | Small project, off → on | 512 KiB static data, off → on |
| ----------------------- | ----------------------: | ----------------------------: |
| Endpoint response       |            10.05 → 8.87 |                  11.74 → 9.61 |
| Scheduled permit        |           62.82 → 55.77 |                 79.23 → 63.62 |
| Editor recording upload |           40.19 → 39.39 |                 59.29 → 47.60 |
| Replay project response |           12.09 → 10.63 |                 17.40 → 17.65 |

A second run measured endpoint p95 at 8.47 → 8.43 ms and
13.82 → 11.36 ms. The small editor upload p95 varied across runs.

The results describe the local fixtures. During the blocked catalog test,
endpoint responses completed and released their execution permits while
recording persistence waited. The real replay API returned original files
byte-for-byte. The Playwright replay suite exercised both formats with an
existing editor bundle, including separate tabs and node-output inspection.

The object inventory showed 1,000 separate traces and one shared replay
project for 1,000 captures. The mixed-format restore read old and new replays
from a restored database and a different object prefix. Retention reclaimed
an unreferenced generation in about 121 ms with 100,000 additional recording
rows in one workflow and kept that workflow's referenced snapshot. The
existing indexes were sufficient for that local check.

In the compiled-command qualification, 128 existing recordings with gzip
and plain-text replay projects moved to one shared project object. The
MinIO inventory fell from 100,303 to 7,478 bytes across the fixture's
recording and replay objects after the outbox drained. The fixture killed a
command before commit, reclaimed its abandoned upload, and ran two
overlapping commands with a replay reading the original pointer. It then
restored the compacted project, trace and dataset from a PostgreSQL dump
and copied objects under a different prefix. Endpoint p95 measured 10.50 ms
before this compaction batch and 9.30 ms while the command was active, using
128 samples in each group.

The isolated sharing repeat measured endpoint p95 at 7.77 → 6.06 ms for
the small fixture and 11.28 → 7.52 ms for the 512 KiB fixture. The 512 KiB
editor upload p95 measured 63.69 → 58.79 ms in the repeat. Scheduled permit
and editor upload tail timings varied across runs. The compaction integration
also exercised file-backed and encrypted PostgreSQL storage settings and kept
the original replay when the replacement failed verification.

Before automatic backfill was retired, the real managed maintenance timer converted
128 seeded recordings and revisited a recording when its upload hold expired.
The endpoint fixture measured p95 at 11.18 ms before compaction and 11.12 ms
during it, with 128 requests in each group. The PostgreSQL schema fixture
refused a rolling 22 → 23 migration, then applied the maintenance migration
and verified the original recording rows and pointers were intact.

The flag-free writer comparison measured endpoint p95 at 8.73 → 6.74 ms
for the small fixture and 14.38 → 9.67 ms for the 512 KiB fixture, with 256
requests per mode. For the larger fixture, replay-open medians were 12.71
and 12.82 ms, and the upper tail varied across the 16-sample runs.
