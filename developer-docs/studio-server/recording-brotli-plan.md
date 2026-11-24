# Brotli recording storage and bounded historical recompression

Status: implemented locally. Production qualification and strict latency acceptance
remain open. No deployment has been performed.

## Implementation decisions and operation

Managed trace writers use fixed-quality Brotli 4 by default. An explicit existing
`RIVET_RECORDINGS_COMPRESS=gzip` or `identity` choice is preserved. Project and
dataset codecs, legacy filesystem/SQLite formats and decoded recording v1 bytes
are unchanged. The reader-only first release sets the source constant
`DEFAULT_MANAGED_RECORDING_ENCODING` to `gzip`; it must retain Brotli readers and
coordination support. The subsequent writer release sets it to `br`. The
normalized release manifest records these capabilities; online upgrade and
forward-rollback checks reject incompatible reader/writer combinations.

Historical recompression is source-only and is excluded from runtime images.
The operator imports of existing release/reader and command owners are reviewed
exact edges in `scripts/checks/import-boundary-debt.json`. They prevent a second
manifest validator or deployment policy from drifting inside the API package;
runtime packaging tests verify that these operator entry points are excluded.
First run `yarn studio-server:recordings:recompress` for a read-only inventory.
An apply invocation needs the installation's actual storage configuration and
encryption key, a promoted installed manifest, and an explicit Kubernetes
context/namespace/release:

```powershell
yarn studio-server:recordings:recompress --apply --receipt .data/recompression.private.json --reader-manifest artifacts/installed-manifest.json --context <context> --namespace <namespace> --release <release> --limit 100 --max-seconds 30
```

Each invocation processes one bounded batch. Reuse the receipt to continue.
Start a new receipt for another pass after held evidence expires or backdated
imports arrive. `exhausted` describes that pass, not a promise that all rows were
converted. Inventory distinguishes held rows and encodings; the batch reports
oversized, corrupt/missing, not-smaller and competing rows separately. Physical
space reclamation follows the normal deletion outbox.
The post-batch `inventory` includes already-Brotli rows; it is not a remaining-work
count. Its eligibility counts describe terminal/evidence state within each codec.

The revised coordination is deliberately serial: a converter takes the exclusive
recording-storage advisory lock. Deployments, backup freezes and destructive
restore/DDL participants take its shared side. Nested transition participants
therefore cannot deadlock their parent. The converter publishes using its own
lease connection; a lost connection cannot leave a second connection committing
across a transition. No execution request or normal already-current startup
takes this lock.

Wrap the journaled release entry point with
`yarn studio-server:recordings:guard-transition --context <context> --namespace <namespace> --release <release> -- node deploy/studio-server/scripts/deploy-kubernetes-release.mjs <args>`.
The command requires access to the same installed database settings. Its
short-lived localhost guard is consumed by deployment tooling and expires with
the owning process. `RIVET_RECORDING_TRANSITION_GUARD` is private coordination
between these processes, not a feature activation setting. Never configure it
persistently in a container or deployment.
The hosted qualified-release and production-only preflight paths now share the
callable transition lifetime with this standalone wrapper. The latter optionally
accepts `--configuration <private file>` before `--`; existing environment-based
local invocation remains supported. Protected bootstrap, pinned proxy transport,
native cancellation, retained observers and activation requirements are documented
in [deployment operations](deployment-operations.md#hosted-recording-storage-coordination).
This shared automation is implemented locally; fresh hosted production preflight
and an authorized automated rollout remain separate verification gates.
The wrapper accepts that entry point only. Its backup stages have durable release
journals; an arbitrary standalone command does not. Interruption is not proof that
detached helpers or remote changes stopped. Recompression refuses an unfinished
journal, even with an expired lease, until the release is recovered and settled.
Apply requires a completed journal for the exact installed reader manifest; no
journal is not proof of a settled installation. Existing non-HA installations use
the explicit `--maintenance-cutover` path so their updates also have a journal.
Native schema migrations acquire coordination transactionally without this wrapper.
Supervised legacy restores take these locks internally; do not nest a destructive
restore command inside the wrapper's restore-serving lease.

Before downtime, the reviewed backup adapter must support the codec preflight
receipt. The existing `verifyLocalDeploymentPrerequisites` helper now reads the
compiled artifact codec and emits that evidence. Checkpoints carry the encodings
that their verified restore copy must support; an old adapter missing the proof
is rejected. Future release preparation must update and review that installation's
private adapter before publishing an activation request.

Reassessment: the design below explicitly separates codec selection, upload
ownership and operator coordination. The operator is not authorized merely by
an environment flag saying that its own process is in serving mode.

## Objective and scope

Use Brotli quality 4 for new managed recording **trace** blobs and provide a
bounded operator command to recompress existing traces safely. This covers
PostgreSQL/S3, including production and the local PostgreSQL/MinIO deployment,
and every managed recording surface: endpoints, web apps, editor and child runs.

Keep the recording's decoded v1 bytes, identity, events, values, timestamps,
outcome, costs and project/dataset links unchanged. Shared project snapshots
and managed dataset blobs retain their current encoding and lifecycle. This
is not another project-snapshot compactor or a recording-format redesign.

Legacy filesystem/SQLite recording writes remain gzip/identity in this change;
their old recordings, imports and exports must keep working. Do not introduce a
second legacy bundle metadata format solely to change compression. If a legacy
writer receives an unsupported explicit Brotli configuration, reject it clearly
instead of labelling gzip bytes as Brotli.

No new service, database schema migration, permanent background converter or
activation environment flag is planned. Production and staging remain untouched
while implementing and validating this plan.

## Evidence and limits

The 21 November 2026 read-only production sample contains 732 traces from 128
projects: a size-stratified sample of 696 and 36 additional failed, warning and
editor examples. All downloads matched their immutable length/hash descriptors.
The original 90,196,363 stored bytes decode to 621,454,407 bytes. Eight codecs
completed 5,856 exact byte round trips.

| Codec                        | Sample stored bytes | Size-weighted estimated saving across existing traces |
| ---------------------------- | ------------------: | ----------------------------------------------------: |
| Existing gzip / gzip level 4 |          90,196,363 |                                                    0% |
| Brotli quality 4             |          41,097,370 |                                  38.4%, about 5.72 GB |
| Brotli quality 5             |          39,214,350 |                                  43.5%, about 6.48 GB |
| Brotli quality 6             |          37,303,831 |                                  44.7%, about 6.67 GB |

The population baseline was 342,437 traces and 14,905,335,959 trace bytes.
Weight the six sampled size bands by their actual population bytes; do not apply
the raw sample's 54% saving to the whole installation. The additional coverage
examples are not part of that estimator. Local codec timing favored quality 4
overall, but does not prove unchanged endpoint or playback latency. One tiny
trace grew; historical conversion must keep an original when Brotli is not smaller.

Receipts and private samples stay Git-ignored under
`.data/recording-compression-prod-20261121/`. Never commit recording payloads,
credentials, object inventories or private identities with fixtures.

The pinned Node 24.22.3 runtime also passed a local asynchronous Brotli-4 byte
round trip, rejection of truncated input and enforcement of `maxOutputLength`.
These primitive checks are not integration or release qualification.

## Baseline implementation boundaries (before this change)

- [Artifact descriptors](../../packages/studio-server-api/src/routes/workflows/managed/artifact-descriptor.ts)
  currently accept only identity/gzip. Encoding, compressed SHA256 and both byte
  lengths are bound into the SQL-owned immutable key.
- [Blob storage](../../packages/studio-server-api/src/routes/workflows/managed/blob-store.ts)
  verifies immutable writes/reads. Its GCS transport explicitly avoids gzip
  transcoding; that protection must stay in place.
- [Durable persistence](../../packages/studio-server-api/src/routes/workflows/managed/recording-evidence.ts)
  prepares trace/project/dataset artifacts and freezes upload manifests for
  recovery. It currently records a compression boolean and gzip level.
- [Recording services](../../packages/studio-server-api/src/routes/workflows/managed/recordings.ts)
  include imports and the non-durable compatibility writer. Their trace reader
  does not yet retry a replaced trace pointer; its existing missing-object
  fallback is limited to replay projects.
- [Input extraction](../../packages/studio-server-api/src/routes/workflows/recording-input-source.ts)
  decompresses bounded encoded bytes in a worker. Search result hydration in the
  recording service rejects a candidate whose blob key changed. Recompression
  would currently turn that safe rejection into a missed match if left unchanged.
- [Memory accounting](../../packages/studio-server-api/src/routes/workflows/recording-memory.ts)
  and [deferred work](../../packages/studio-server-api/src/routes/workflows/recording-evidence-work.ts)
  own existing capture limits and the serial background writer. Do not replace
  either while introducing a codec.
- [Restore inventory](../../packages/studio-server-api/src/legacy-restore/scope.ts),
  object-name grammar, reconciliation and deletion must recognize the new trace
  keys without broadening authority over unrelated objects.
- [Release manifests](../../deploy/studio-server/scripts/lib/studio-server-release-manifest.mjs)
  currently describe schema compatibility, not recording codecs. Equal database
  schema versions do not establish that an older release can read Brotli.

## Non-negotiable invariants

1. Recompression decodes and re-encodes the original bytes. It never parses and
   reserializes the recording, loads the current project or reruns a workflow.
2. Existing gzip and identity artifacts remain readable indefinitely. The public
   replay/download response stays compatible; browsers and older editor clients
   do not need to decode a new on-disk codec themselves.
3. Preserve every memory/admission bound, asynchronous recording ownership and
   separation of known execution outcome from recording availability.
4. A prepared manifest owns its codec and parameters. Resume must reproduce its
   bound bytes, not adopt a new live configuration halfway through an upload.
5. Never overwrite an existing blob. A pointer may move only after an independent
   read verifies the replacement and a transaction confirms the old pointer.
6. Retention/deletion and conversion may race. A deleted recording cannot be
   resurrected; an abandoned or losing upload remains discoverable by cleanup.
7. A changed storage key must not make a matching recording disappear from a
   concurrent search or break an already-open recording.
8. No rollout, rollback, restore or converter activation may expose Brotli data
   to a reader that only understands gzip/identity.

## Implementation order

### 1. Add readers and a narrow codec contract first

Extend the managed artifact encoding with `br`, preserving the descriptor's
existing integrity contract and `.artifact-v1.<hash>.<stored>.<decoded>.<encoding>`
shape. Unknown/malformed encodings fail explicitly, never fall through to
identity or gzip. Use Node's asynchronous Brotli encoder at fixed quality 4.
Keep the other encoder parameters pinned to the same defaults used by the
production-sample experiment; do not introduce a dictionary or change the
window/mode as part of this change.
Decoded output must obey the existing 100 MiB artifact maximum and exact declared
length. Preserve fatal UTF-8 handling where text is required. Test empty values,
incompressible data and both encoded/decoded limit boundaries; never raise a
limit or silently drop a previously supported recording to make the codec fit.

Keep one codec implementation at the managed artifact boundary; worker-side
decoding may use the synchronous equivalent inside its existing isolated worker.
Do not introduce a new serialization engine, worker service or plugin dependency.

Update every managed trace consumer: S3 reads, recovery, input extraction,
download/import handling, mixed-format backup/restore and operational tools.
Keep the underlying v1 recording JSON and browser-facing API unchanged. Keep
filesystem encodings distinct enough that adding `br` cannot activate legacy
`encoding !== identity => gzip` fallbacks accidentally.

Store Brotli as opaque object bytes with the codec defined by the descriptor.
Do not add transport metadata that silently decompresses bytes before integrity
verification. Retain the existing unsigned GCS gzip-negotiation workaround.
Test GET, HEAD, listing, copying and readback behavior separately; do not infer
real GCS behavior from MinIO alone.

At this stage, all writers still emit their old encodings.

### 2. Close pointer-change and search races before enabling conversion

Give managed trace reads the same bounded recovery principle as shared-project
reads: on a missing old object, reload that recording's current pointer once,
check its owner/identity, and read the replacement. Do not turn permission,
integrity or arbitrary network failures into broad retries.

During input-search hydration, if the candidate's pointer changed, evaluate the
current artifact with the same predicate before accepting or rejecting that
candidate. Use its actual key for cache identity. Do not cache replacement bytes
under the old immutable key, silently drop the row, or move the consumed cursor
past an unresolved candidate. Repair at most once within the existing bounded
page/worker path. If another replacement prevents a stable decision, fail that
response without publishing its advanced cursor; the caller can retry from the
original boundary. Preserve pages already delivered. A genuinely deleted row
retains the current deletion semantics.

Cover replacement both before extraction and between matching and hydration.
Re-evaluating only already-matched rows does not repair a missing old object at
the extraction stage. If re-evaluation removes a match, preserve page filling,
continuation and exact/incomplete-count semantics; do not just shrink the page
and claim that the search finished.

Keep the current ordering, status/scope filtering, cancellation, counts and opaque
cursor semantics. A replacement that differs semantically must never inherit an
old match merely because the recording ID is the same.

### 3. Enable new managed trace writes

Use this policy at the storage writer boundary, not by globally changing the
encoding of every artifact created by the shared settings getter:

| Writer / existing setting                              | New trace                      | Project and dataset artifacts  |
| ------------------------------------------------------ | ------------------------------ | ------------------------------ |
| Managed / unset or `br`                                | Brotli quality 4               | Existing gzip policy and level |
| Managed / explicit `gzip`                              | Existing gzip policy and level | Unchanged                      |
| Managed / explicit `identity`                          | Identity                       | Identity                       |
| Legacy filesystem/SQLite / unset, `gzip` or `identity` | Unchanged                      | Unchanged                      |
| Legacy filesystem/SQLite / `br`                        | Reject during setup            | No write attempted             |

Extend the existing configuration contract to permit `br` for managed writers.
Inventory generated deployment environment values: preserve explicit operator
choices and identify any old generated `gzip` override before rollout. Changing
that override is an explicit part of the future writer release, not a silent
side effect of installing readers. There is no additional activation flag,
automatic fallback experiment or adjustable Brotli quality control.

Resolve this policy once in existing background preparation, not through an
additional settings lookup on every request/event. Keep shared-project and
dataset preparation on their existing codec paths. Include imports and the
managed non-durable writer in the inventory; preserve the caller's content and
identity rather than silently rebuilding a project or changing a run outcome.

Reuse descriptor/manifest ownership to freeze the trace encoding and quality for
retries. Old manifests remain gzip/identity even after the default changes. Store
the required codec parameters once in that manifest, with legacy interpretation
for absent fields; do not maintain a second policy registry. Existing bound
objects are verified and reused. Recovery does not re-encode them just because
the process or Node version changed. If lost bytes cannot be reproduced to the
bound descriptor, report unavailable recording evidence and preserve the known
execution outcome instead of silently changing the fingerprint.

Use the existing serial background preparation and asynchronous compression.
Do not run both gzip and Brotli for every new trace to choose a winner. Account
for encoded/decoded buffers and bound native codec workspace in the local memory
tests; faster aggregate compression does not waive the memory protections.
Measure the native workspace explicitly: a multiplier for retained payload bytes
does not by itself bound the compressor's memory. Keep the current one-background-
writer scheduling and avoid adding per-event accounting or another worker pool.

### 4. Add a source-only recompression command

Implement `maintenance/recompress-recordings.ts` and a focused helper/test beside
the existing source-only snapshot operator. Type-check them in the normal API
build, but exclude them from runtime packaging. The maintained root command is:
`yarn studio-server:recordings:recompress`. Do not register a maintenance task,
CronJob, automatic sweep or perpetual cursor table.

The command must:

- Resolve the installation's actual storage settings and encryption keys;
  preserve release/VM-migration pauses and the restore serving lease.
- Require verified installed-reader compatibility before apply; a newer operator
  checkout alone is not proof that every active reader understands Brotli.
- Offer read-only inventory/dry-run first, then bounded apply: default one serial
  batch, 100 candidates/30 seconds, maxima 1,000/120 seconds, optional workflow
  filter and explicit resume cursor. Initially allow 32 MiB decoded per object
  and 128 MiB decoded work per batch, with an explicit tested override up to the
  existing 100 MiB object limit. Oversized candidates stay intact and are
  reported, not treated as finished conversion.
- Treat the time budget as a scheduling deadline, not a promise that native
  compression stops mid-call. Check cancellation before/after each operation,
  use bounded storage/SQL timeouts, and wait for owned work to settle before
  closing the session. Never abandon a mutation through `Promise.race` and then
  report clean cancellation.
- Select completed legacy trace blobs only. Skip active upload windows and
  **any row still present in `workflow_run_evidence`**, including a completed
  row. Leave its manifest and fingerprint untouched. Normal cleanup retains
  completed evidence for at least two days beyond its upload window; passing the
  upload deadline alone is not eligibility. Recheck absence inside the publication
  transaction. Report held records and revisit them in a later explicit pass.
- Read/verify/decode the original; compress those same bytes with Brotli 4;
  retain the original if the result is not smaller.
- Give each conversion attempt a fresh physical trace generation under the
  existing recording owner directory, for example
  `recording.<uuid>.rivet-recording.artifact-v1.<sha256>.<stored>.<decoded>.br`.
  Extend only that exact trace-name grammar. A fresh generation prevents a late
  cleanup from an abandoned attempt deleting a later retry's replacement.
- Register a delayed deletion intent before PUT, using the existing outbox and
  an explicit trace-recompression cleanup reason. Its delay exceeds the maximum
  batch duration. Reuse immutable PUT/readback verification.
- Independently read the candidate and verify hash, both lengths and exact
  decoded byte equality. No pointer change before this succeeds.
- In one short transaction, lock the unclaimed upload intent, recheck eligibility
  and the expected old row pointer, update only the trace pointer/compressed-byte
  accounting, cancel candidate cleanup and queue the original through ordinary
  reference-checked deletion. Preserve original decoded byte accounting. There
  is no second retention timer for replaced originals: reader fallback must be
  correct even if the ordinary outbox drains immediately.
- On a competing winner or deletion, leave the row alone and let the outbox
  reclaim the losing generation. After an uncertain commit, read back the exact
  proposed pointer before advancing progress or retrying persistence.
- Keep a local atomic resume receipt bound to the non-secret storage identity,
  restore epoch, codec policy and selected workflow scope. Use a fixed creation-
  time cutoff and a `(created_at, recording_id)` keyset with full database timestamp
  precision; random UUID ordering alone is not a historical cutoff. Reject a
  receipt after a restore or storage/scope change. Never skip an unresolved write.
  Late backdated imports can require another pass, which the final inventory must
  reveal. Emit payload-free progress, never recording contents or credentials.

Recompression must not overlap a deployment, backup freeze, restore or storage
migration. The current restore-serving lease protects destructive restore, but
the release-maintenance flag is process-local environment state. It cannot
coordinate an external converter with a later rollout or backup.

Use one narrow PostgreSQL advisory coordination key. The implementation serializes
converters with its exclusive side; release/backup/storage transitions use its
shared side across their freeze/change window. Take locks non-blockingly. Ordinary
execution, reads and already-current replica startup do not take this lock.

The converter holds coordination and the existing restore-serving lease on one
connection, using that same connection for pointer-publication transactions and
a second connection for inventory work. Before publishing, its transaction takes
the same exclusive transaction lock reentrantly and verifies the restore epoch.
This prevents a lost outer session from leaving a second connection committing
across a concurrent freeze.
Connection loss aborts new work; already-issued PUTs may settle as unreferenced
uploads, but must not bypass publication checks.

Acquire coordination before existing restore locks. A transition's outer owner
and nested migration/restore subprocesses hold compatible shared locks. Do not
reuse the restore-owner lock: those subprocesses already need it, which would
introduce a lock cycle. Fail or wait visibly on
contention, without stopping application traffic just to obtain coordination.
This needs no table, heartbeat service or execution-request check. Source-only
release use requires the updated journaled transition tooling; an environment-only
preflight is insufficient. Standalone backup commands are not accepted by the
wrapper because they lack a durable operation journal.

A finite operator session may drive successive bounded batches with an explicit
overall time/record limit and a saved receipt after each batch. It must stop on
an unresolved failure or lost coordination. This does not install a recurring
job, revive the automatic compactor or retry a workflow/deployment. Release
coordination only after owned work settles and progress is saved, before any
inter-batch wait. Recheck the installation, reader capability and restore epoch
before the next batch, allowing a backup or deployment to take the lock between
batches without waiting for the entire history to finish.

Report scanned, converted, already-Brotli, not-smaller, held, corrupt/missing and
failed counts, plus bytes uploaded and queued for deletion. Reaching the cursor's
end is not equivalent to completion: finish with a fresh inventory of remaining
eligible/held/failed rows and outbox state. Report physical reclamation separately
from bucket soft-delete/version retention and eventual billing.

### 5. Enforce reader-first rollout and rollback compatibility

Prepare two releasable stages, without deploying either during implementation:

1. **Reader release:** all managed readers and tools understand Brotli/new trace
   generations, while writers remain gzip/identity. Retain this immutable release
   as the rollback target.
2. **Writer release:** after every execution/control/maintenance reader and restore
   tool is confirmed compatible, switch the managed default to Brotli 4. Run the
   bounded converter only after this release is fully installed and qualified.

Add a narrow, tested recording-encoding capability to immutable release and
checkpoint metadata. Treat absent capability as gzip/identity only. Release
checks must cover the union of actual stored codecs and active-writer codecs;
an empty current Brotli count is not safe evidence while a Brotli writer can run.
Any downgrade to a gzip-only reader must fail before deployment/restore. A
Brotli-aware rollback must remain possible after conversion and after deleting
the replaced originals. Do not infer this from the unchanged SQL schema version
or pin a one-off source SHA inside general runtime code.

Use the existing release/backup validation owners rather than a new generic
capability service or database format registry. Include the codec capability in
manifest normalization and the semantic digest: the current normalizer discards
unrecognized fields. Derive declarations from source-owned contracts and verify
them with the packaged reader, not just a hand-edited manifest. Check checkpoint
claims against its object inventory. Exercise normalized/serialized manifests,
old/new metadata and the installed-image planning path. A one-release rollout would require a separately
approved maintenance transition that removes all old readers first; never mix
old readers with new Brotli writes during an ordinary rolling update.

## Local validation and release gates

### Correctness and recovery

- Extend existing descriptor/transport tests for identity/gzip/br, bad descriptors,
  checksum/size mismatch, invalid UTF-8, truncation and decompression limits.
- Run the private 732-recording byte corpus through the new real artifact reader,
  encoder and compiled input worker, comparing exact decoded bytes and extraction
  results. Keep synthetic binary/string/empty-input edge cases in public tests;
  never make CI depend on private production samples.
- Exercise fresh durable, legacy-manifest resume, non-durable managed persistence,
  imports, attached data, nested runs, outcomes/costs and shared snapshot reuse.
  Test the policy table, a settings change during upload and restart with a
  different encoder result: valid bound objects must still be reused, and an
  incompatible reproduction must not rewrite the manifest or workflow outcome.
- Use disposable PostgreSQL/MinIO for failures before PUT, after PUT, after row
  update but before commit, lost commit acknowledgement, concurrent converters,
  deletion, an expired upload intent and restart/resume. Original playback must
  work until publication; committed playback must work after original deletion.
  Include already-completed evidence, corrupted resume receipts, restore-epoch
  changes, microsecond cursor boundaries and backdated imports.
- Race conversion with an input search and with an open replay. Require the same
  ordered matches/cursors as an unchanged corpus, not merely successful requests.
- Restore a mixed gzip/identity/Brotli backup into another database/prefix and
  verify traces plus shared project/dataset links. Verify unsupported rollback
  rejection and a successful rollback to the reader release.
- Hold a conversion inside PUT/publication while each backup/deployment/restore
  transition starts, and reverse the ordering. Prove operation exclusion and
  cancellation drain with a two-connection converter pool. Terminate its lease
  connection mid-PUT and let a freeze acquire the shared lock; the publication
  transaction must not cross that freeze. A backup must never copy an old pointer
  whose object the converter can retire underneath it. Verify nested migration
  does not try to reacquire the parent's coordination lock.
- Keep automatic-compaction absence and ordinary retention/recovery/cleanup
  regressions. Packaging must contain readers but no converter/test payloads.

### Performance

Use final compiled builds on pinned Node 24.22.3. Compare the current commit
(`3495e328e`) with the final candidate, and isolate gzip versus Brotli on the same
candidate. The previous recording-latency gate remains separately open; this
codec work must not relabel that older inconclusive result as a pass.

Use the existing [recording benchmark](../../scripts/benchmark-recording-memory.mjs)
and [latency protocol](recording-latency-repair-plan.md). Include small requests,
many-node graphs, mixed small/large records, nested runs, slow storage, capture
failure, cold/warm replay and cold/repeated input search. Test both local resource
profiles: 4 outstanding runs at 500m/1 GiB and 32 at 2 CPU/4 GiB. Preserve the
workload, recording coverage, capacity and drain accounting between variants.

Measure response completion, full workload plus recording drain, p95/p99,
throughput, event-loop stalls, CPU, RSS/cgroup memory, queue high-water and drops.
Run a bounded converter concurrently in an isolated process against the same
local storage and verify it does not degrade serving. Limit/pause that operator
before changing serving concurrency or adding production resources.

Declare the same no-slowdown gate before running paired comparisons. A confidence
interval spanning a regression is inconclusive; do not widen margins or use
aggregate codec speed to override a small-request regression. Preserve all
recording memory protections and never hide unfinished work after the stopwatch.

### Maintained commands and browser checks

Run affected API tests via the workspace's `test:files`, the full API build, and
`test:recording-durability-managed` with compiled operator/worker coverage. Extend
the existing managed integration rather than creating another generic storage
harness. Run root style/file-tree checks, the separate Studio Server test-style
gate, scoped lint and developer-doc link checks.
Finish builds before tests which import their output. In particular, the root
style gate may rebuild `core/dist`; do not run it concurrently with recording
tests or performance comparisons that load that directory.

Run headless `recording-playback-history.spec.ts` and `run-recordings-modal.spec.ts`
through `yarn studio-server:ui:observe` with the CI built frontend. Cover old/new
replay, child recordings, open outputs, search continuation and conversion races.
Exercise release-manifest/backup/rollback and runtime-package contract tests.
Local MinIO transport proof does not replace future exact-image GCS qualification.

## Completion criteria

The implementation is complete only when new managed defaults, every affected
reader/recovery path, bounded conversion, mixed-format restore, rollback guards,
packaging and documentation pass their local gates. Report any performance gate
still open separately. No deployment, production rewrite, background operator or
cloud qualification starts without a later explicit rollout request.

## Local validation results

The real 732-recording corpus passed exact-byte round trips through the implemented
encoder and reader. Stored trace bytes decreased from 90,196,363 to 41,097,370 in
that sample. All 732 also produced identical extracted inputs before and after
recompression through the compiled search worker. This is not a claim about total
production savings.

PostgreSQL/MinIO checks cover mixed-codec restored-copy playback, metadata
preservation, completed-evidence exclusion, stale-pointer reads, unique retry
generations, deletion races and loss of the operator's database connection.
Four normal endpoint requests also completed and saved their recordings while
the converter held its lease. This proves coexistence, not a throughput bound.
The full-precision cursor and an expired cleanup intent are exercised explicitly.
A separate 100 MiB incompressible case verifies that an encoding which exceeds
the stored-object ceiling keeps its original without PUT or pointer mutation.

Initial implementation validation covered 323 API checks (including legacy SQLite recording
behavior), 89 headless recording/playback checks, the API build/typecheck,
145 release/rollback/transition checks, runtime-package exclusion, scoped lint,
repository style and documentation links.
The PostgreSQL/MinIO integration is additional to those unit/browser checks.

Native-memory measurements used 5/32/99 MiB incompressible inputs. Brotli's
observed peak exceeded gzip by approximately 15–22 MiB, so its encoder reserves
32 MiB of workspace inside the existing shared recording budget. This reservation
does not raise the memory limit or claim to cap whole-process RSS.

Quiet paired comparisons isolated gzip versus Brotli in the same compiled build:

| Profile / workload     | gzip response p95 | Brotli response p95 | 95% interval for the difference |
| ---------------------- | ----------------: | ------------------: | ------------------------------: |
| 2 CPU / small request  |           4.67 ms |             4.43 ms |               −0.44 to −0.08 ms |
| 2 CPU / 100-node graph |           6.84 ms |             6.38 ms |               −0.75 to +0.08 ms |
| 500m / small request   |           5.68 ms |             5.72 ms |               −0.27 to +0.50 ms |
| 500m / 100-node graph  |           8.56 ms |             8.42 ms |               −1.80 to +1.89 ms |

Every expected recording was accounted for after drain. Baseline-versus-candidate
bursts also covered mixed workloads and many-node graphs at 4/32 outstanding
runs. Those measurements were noisy; a quieter repeated 500m many-node burst
did not reproduce the earlier total-time regression. Neither those results nor
faster compression establishes a strict zero-slowdown guarantee. Intervals still
permit small regressions, particularly on the smaller profile. Keep that latency
gate separate from the passed correctness checks and from future exact-image
cloud qualification. The overloaded trial that dropped recordings on both
baseline and candidate is retained as rejected evidence, not an acceptance run.

Detailed command logs, paired results and private corpus checks are kept under
`.data/recording-compression-prod-20261121/`. Do not commit that directory.

## Follow-up review

Failure-path preparation retains its memory reservation until every started
compression settles. Success still prepares artifacts concurrently. A deterministic
held-compressor regression covers the early rejection that previously released
ownership too soon.

The operator handles both its lease connection and idle pooled-connection errors.
If an uncertain publication still reads back the original pointer, it stops with
the original error and leaves the receipt retryable. A different winner or deletion
is reported separately. Corrupt reads and oversized legacy reads consume the batch
budget; legacy keys reserve the maximum possible read before their size is known.
Malformed cursors fail before storage access.

An interrupted transition cannot report success merely because its command exits
zero. Recompression also rejects an unfinished rollout journal, including one whose
lease expired after the coordinating process disappeared. These checks remain
outside ordinary workflow execution.

Follow-up validation passed the focused runtime/operator suites, the full local
PostgreSQL/MinIO durability integration, 34 release-manifest cases, two real
non-HA command scenarios, and the API build/typecheck, lint, formatting, test
manifest and documentation-link checks. The earlier latency qualification remains
unchanged; failure-path fixes do not close that separate performance gate.

The adjacent journal review also covers the actual maintenance writer's unlabeled
ConfigMaps: their deterministic name, namespace, UID/resource version and embedded
operation identity remain authoritative. A present but wrong release label is
rejected. Completed autoscaler journals must have cleared their pending scale,
target, fence, fence-repair and removal work before recompression may begin; the
same validation is shared with deployment readiness.
All 52 readiness, journal and release-manifest tests passed after these changes,
along with typechecking, formatting, test-style and documentation-link checks.

## Release assurance checks

The managed integration now checks actual endpoint/editor writes: their stored
trace descriptor uses the configured default (`br` in this source), and the HTTP
recording route returns playable/exact decoded contents. Mixed identity/gzip/br
fixtures are read through that route before and after conversion.

It also invokes the real source CLI against disposable PostgreSQL/MinIO with
encrypted storage settings. Only Kubernetes inventory reads are replaced by a
fixture. Inventory, incompatible-reader rejection, a one-record batch, receipt
resume/exhaustion, and invalid-receipt rejection pass. This closes the prior gap
between testing the batch function and testing the maintained operator command.

The production pod configuration was read on 22 November 2026: the backend and
two execution API containers had no compression override or inherited env sources.
Check the final release values again when preparing the rollout. The previous
production backup adapter predates codec proof fields; prepare a new reviewed kit
and verify it locally before activation. Codec preflight must actually exercise
identity, gzip and br before claiming support for all three in its receipt.

## Maintained test boundaries

Codec tests own byte integrity, size limits and streaming cleanup; the same S3
fixture covers gzip/Brotli with and without length headers. Worker lifecycle
tests share one restart scenario. The failed-preparation test deliberately holds
a compressor callback and uses the prebuilt API; removing the preparation join
must fail its pending-work assertion. Build before running these tests.

Recompression unit tests own cursor shapes, work budgets and uncertain-commit
outcomes. The managed integration owns SQL/object-store races, mixed-codec HTTP
playback, restored-copy playback and actual CLI configuration/apply/resume.
Malformed cursor shapes need no additional CLI process; malformed receipt JSON
and wrong restore epochs still exercise the command boundary. Keep the separate
snapshot-compaction integration while that source-only command remains supported.
The CLI's Kubernetes stand-in rejects unexpected external commands.

Legacy direct-Helm acceptance fixtures deliberately omit the new coordination
contract. A separate coordinated-release case verifies that an unjournaled update
is rejected before mutation; do not weaken that guard to keep legacy tests passing.

Test consolidation preserves coverage rather than adding elapsed-time assertions.
The isolated compressor test still has noticeable dependency startup cost; no
runtime speed improvement is inferred from its shorter setup.
