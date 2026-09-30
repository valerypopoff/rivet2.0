# VM filesystem to managed PostgreSQL and S3 migration

This is the implementation and safety contract for copying a filesystem-backed
single-host Rivet Server with legacy file metadata into a separate managed destination. The Settings ->
Migration tab can test a destination, pause the source, run the importer,
verify it, and record a separate deployment review. **It does not route traffic to Kubernetes or change the VM's active
Storage setting.** Simply changing the Storage tab switches the active backend
and does not copy data.

The migration routes are disabled by default. On the single-host VM, set
`RIVET_VM_MIGRATION_ENABLED=1` and use `RIVET_SERVER_UI_AUTH_MODE=key` or
`oauth` before restarting the backend. `none` mode and trusted-client bypass
cannot authorize migration, including status and source inventory reads, even
if they allow ordinary Settings access.
State-changing migration requests require the signed-in UI session and the
same-origin migration-intent header. Turn the enablement off again after the
cutover or abandoned attempt. The separate offline CLI remains an operator
tool and needs access-controlled source mounts and credentials.

## Source and destination

This importer does not yet read a selected local SQLite generation. The browser
workflow is deliberately unavailable whenever local-metadata control is configured,
including its paused legacy phases. After the local storage upgrade, retained legacy
files are not the live authority and must never be supplied to this CLI as a substitute
for a SQLite export. A selected-SQLite-to-S3/PostgreSQL adapter is a separate future
feature; do not remove or bypass the control configuration to unlock migration.

The source must still be in legacy filesystem storage mode. It is the VM's workflow
root, recording-bundle root, app-data root, and runtime-library root. Preserve
all four together in a backup before beginning.
In that mode Rivet's workflow, Evaluation, health, recording and App Settings
state is file-backed, even if the Storage UI has a local Docker PostgreSQL
option configured for a future managed-storage switch. Do not assume an
unrelated database in the local PostgreSQL container is migrated by this tool;
inspect and back it up separately.
The target is a separate, initially offline managed PostgreSQL database and S3
bucket/prefix. Never point the copy at an active Rivet installation or at the
same database that serves the source VM. The tool reads destination connection
details from explicit `RIVET_MIGRATION_TARGET_*` variables, not the source
Storage setting. It does not modify the VM's active setting. The first copy
requires empty PostgreSQL application tables and empty workflow and
runtime-library S3 namespaces. A partial retry is accepted only for the same
source roots and destination location; a PostgreSQL advisory lock rejects a
second concurrent importer.

The tool copies folder topology; exact draft project and dataset bytes;
publication settings, visible endpoint status (including legacy
`unpublished_changes`), endpoint access and publication version; active endpoint
and web-app snapshots; published-version history (including stars and
comments); web-app IDs and email allowlists; recording metadata and replay
artifacts; Evaluation library, imports, runs, recordings and dataset snapshots;
LLM Profile health rows; runtime-library active package set and artifact; and
the encrypted App Settings domains. The destination deployment-storage row is
the one deliberate transformation: it names the managed PostgreSQL and S3
destination while retaining the other source storage settings. LLM Profile
health rows from the old schema may lack `project_id`; the importer uses the
embedded identity's project ID without rewriting the source file. SQLite
recording indexes and project stats are derived state, not independently
copied. Deleted Evaluation project tombstones have no managed counterpart: PostgreSQL workflow
foreign keys prevent writes to a deleted project instead. Plugin package trees
are per-pod reconstructible caches, not durable managed state; app logs, VM
Docker metadata, browser-local data, and external secrets are outside this
migration.

## Browser-assisted sequence

Use this path only on the combined-backend, single-host, filesystem-backed source. The
authenticated Settings -> Migration tab is unavailable to replicated Kubernetes
pods or a source already using managed workflow storage. It collects the same
destination connection details listed below, plus the destination App Settings
encryption key. Those secrets remain in the open browser tab and the migration
child process's environment only; status files and HTTP status responses contain
no target credentials. Close the settings tab after the run and use a secured
browser and HTTPS. The destination must be separate and its API/execution pods
must remain stopped; the checkbox is an operator assertion, not a distributed
lock.

First back up the four source roots and record the published routes and access
policies. The UI requires its read-only **Inspect source** action before pre-copy. It reports project, folder,
recording-bundle and saved-settings counts, and highlights Code and Read File
nodes for portability review. It intentionally does not claim to prove that
arbitrary Code nodes, plugins or external integrations work in Kubernetes;
the frozen importer performs the authoritative structural validation. Test
PostgreSQL and S3 independently in the wizard; editing either connection
resets only its own passed test. The API checks PostgreSQL DDL/read/write permission using a
table created inside a rolled-back transaction, then writes,
reads, then deletes disposable objects in the workflow and runtime-library S3
namespaces. The test creates the configured bucket if missing, matching the
managed importer's first-install behavior. A passed test does not prove the destination is empty or that the
Kubernetes deployment has the same encryption key; the importer and deployment
rehearsal verify those separately. Check native runtime-library compatibility
before affirming that checkbox.
The object-storage preflight uses the same client configuration and timeouts as
managed workflow storage; it does not silently test a different transport.
For AWS S3, bucket creation supplies the configured location constraint outside
`us-east-1`; custom S3-compatible endpoints keep their provider-specific bucket
creation request unchanged.

Runtime-library migration archives only the installed `current/` release.
Relative npm symlinks are supported only when their targets are inside that
release; links to siblings elsewhere in the library root, dangling links,
symlinked source/release roots, and non-regular entries block migration.
Filesystem permission errors are not interpreted as an empty installation.
The frozen fingerprint includes runtime-library permissions as well as content,
so an executable-bit change cannot silently pass verification. Re-run frozen
verification for checkpoints created before this stricter fingerprint; do not
carry an old verified report forward. Native-package OS/architecture/Node ABI
compatibility still requires the separate operator review.

Before maintenance, **Pre-copy content** stages the current draft,
published-version and web-app project/dataset bytes, plus completed recording
artifacts, under the separate
`rivet-vm-migration-staging/<source identity>/` S3 namespace. Objects are
content-addressed and read back by hash. This step leaves the VM serving;
concurrent edits can cause a pre-copy attempt to fail or make a staged version
obsolete. Retry safely before entering maintenance. The frozen importer uses a
staged object only when its SHA-256 matches the _current_ source bytes, copies
it server-side into the managed workflow namespace, and otherwise uploads the
current bytes. Active or incomplete recordings, Evaluations, App Settings and runtime-library
artifacts still transfer during the frozen phase. Staging objects are not
execution authority and remain outside managed reconciliation; retain them
through the rollback window, then clean that dedicated namespace after the
operator accepts cutover. The matching CLI command is
`yarn studio-server:workflow-storage:precopy`.
The durable pre-copy job records a credential-free destination identity. If
the target database or object-storage location changes, the UI requires a new
pre-copy and the server refuses to start the frozen copy against the stale
pre-copy identity.

Enter maintenance mode. The API creates a persistent marker in the source
app-data root, rejects new data requests with 503, rejects new WebSocket
upgrades, drains HTTP and web-app action runs, and flushes recording writes.
The co-located editor executor receives `RIVET_VM_MIGRATION_CONTROL_ROOT`
pointing to the API's app-data mount (its ordinary `RIVET_APP_DATA_ROOT` remains
private) and creates a per-run lease **before** checking the marker;
maintenance waits for all editor leases and for any runtime-library
job using its in-memory runner state, without creating runtime-library scratch
directories during the frozen review. It also waits for previously admitted API requests. A crash leaves the
marker in place so restart stays paused; recording retention and derived index
repair remain disabled before storage startup can touch the source, and runtime-library
startup reconciliation is skipped so it cannot rewrite that source tree. A stale editor lease after an executor
crash must be investigated manually; do not delete it until the process is
confirmed dead. Host-level file writers and other Rivet installations sharing
the source mounts are outside this barrier and must be stopped separately.
Maintenance entry, interrupted-job acknowledgement, exit, and copy admission
are serialized, so concurrent operator requests cannot resume writes while a
job marker is changing or a copy is starting.

Once the status says the source is quiet, confirm that the destination pods are
offline and click Copy and verify all data. One background child runs the
existing retryable importer followed by a separate verify child. The status is
durable but secrets are not; after a crash it reports interrupted. Inspect the
VM and confirm the old importer child has stopped, acknowledge that fact in the
UI, then re-enter credentials to retry against the same offline target. The
server deliberately refuses a retry or maintenance exit while a previous job
is still marked copying or verifying.
After exact verification, the durable job status includes a redacted count and
domain checklist for the compared projects, routes, recordings, Evaluations,
runtime libraries, and App Settings. An append-only per-item receipt records
completed folder, project and recording imports with source hashes. A retry
still compares actual destination bytes and rows; receipts never authorize an
import. The report contains no connection strings
or secrets and distinguishes storage/routing comparisons from functional graph
execution, which requires a controlled rehearsal.
The importer creates `rivet_vm_migration_gate` before importing any managed
state. A source with an unfinished gate cannot start a managed API, including
an execution replica, or run the Kubernetes schema-migration Job. Only the
separate exact-verification pass marks the gate verified. Existing managed
installations without this gate retain their normal startup behavior. The
gate is a protection against accidental early startup, not a replacement for
the operator's requirement to keep the destination offline during copy.
Every later verify pass, including deployment review, first closes an already
verified gate under the importer lock. It reopens the gate only after the full
comparison passes. If the source or target has drifted, a failed recheck leaves
the destination unable to start, even if an earlier report said verified. A
verification command pointed at different source roots cannot close the
rightful target because the gate also checks the source identity.
The importer initializes only the managed schema and read/write stores. It
does not start recording retention, managed reconciliation or stale-upload
cleanup, or even construct the hosted Evaluation worker, regardless of ambient
serving-API feature flags. A long copy must not mutate the destination from
its own maintenance timer. The verifier also rejects destination hosted-
Evaluation scheduler rows, web-app action ledger rows, and managed-maintenance
leases. Filesystem mode has no corresponding durable scheduler or action ledger
to import; those rows indicate an occupied or prematurely started target.
The backend uses a single migration mode contract: copy migrates the schema,
verify checks it without DDL, and neither mode starts serving-time background
tasks, regardless of the source VM's normal schema-mode environment setting.
Replicated API pods check the gate with the bootstrap PostgreSQL connection
before App Settings initialization, which could otherwise seed missing rows
in an incomplete destination. They check again after loading authoritative
storage settings before workflow initialization.
The final copier binds a SHA-256 manifest of the owned workflow tree,
recording bundles, saved settings, operational SQLite files and runtime-library
tree to that target gate after filesystem journal recovery. Copy retries must
match the same manifest. The verify pass compares it before reading the target
and again immediately before opening the gate; a direct host edit during the
frozen window therefore leaves the target closed. Derived recording indexes
and the migration job/status files are excluded because the copier itself can
update them. This guard supplements, but does not replace, stopping all
out-of-band source writers. Derived per-project stats sidecars are excluded
because recording/tree queries may rebuild them during the comparison.
The tool never automatically retries a possibly side-effectful operation. A
verified status is **not** deployment approval or a traffic cutover. Rehearse
the exact Kubernetes release through private routing and controlled inputs
against an isolated clone of the verified database and object namespace. Keep
the real cutover target offline: rehearsal writes (recordings, Evaluation runs,
health and runtime status) would otherwise make exact equality fail. The
Deployment review action requires the
operator to affirm backups, matching deployment settings, functional checks,
external dependencies, and the post-write rollback boundary. It reruns exact
comparison and the frozen-source manifest check against the same target before
recording a timestamped review. The durable job returns to verifying while the
recheck runs; a crash is reported as interrupted, and a failed review is
recorded as failed rather than leaving an obsolete verified status in the UI.
The server attempts to close the target gate again if the recheck fails before
the child can do so, and warns explicitly if closure cannot be confirmed.
This is an operator attestation, not an
automatic proof of DNS, secrets or third-party behavior. DevOps redirects
traffic separately. Keep the VM paused and preserve its data and backups until
the target is accepted. To resume the VM after a final copy, first stop the
destination pods and re-enter/test its credentials. The UI closes the
destination PostgreSQL startup gate before removing the source maintenance
marker; if the target is unreachable, the VM stays paused rather than leaving
a stale, serveable copy. This also applies to a failed final copy, even when
pre-copy was skipped, because a verify child might have opened the gate before
crashing. The durable job records whether final copy started so a failed
pre-copy is not confused with this rollback boundary. A later attempt after
VM writes resume needs a fresh target database and object namespace (or a
separately reviewed target reset); the old frozen-source manifest prevents
merging new writes into that partial copy. Restart the backend before normal
VM serving, because process-local run admission has been drained.
If source validation fails before the importer creates the destination gate,
there is no migrated state to close; the resume path checks for the gate under
the importer lock and permits the VM to resume only in that case. A verified
or pre-copied job without its gate is inconsistent and cannot be resumed
automatically.

## Offline CLI sequence

1. Make a recoverable backup of all four source roots, the source PostgreSQL
   volume if it contains other application data, and the destination before
   reuse. Record the exact image version, configuration, route slugs, endpoint
   access, and published URL probes. Keep the VM serving from its original
   filesystem until the destination has passed verification.
   Prefer running the importer against a consistent frozen copy of the four
   roots: it may recover unfinished filesystem journals and rebuild the
   derived recording index. Migration-specific index initialization disables
   retention cleanup, so importing cannot delete old recording bundles from
   that copy.
2. Stop new HTTP/WebSocket graph runs, editor saves, publication changes,
   Evaluation jobs, and recording writes; drain the API and executor, and keep
   them stopped throughout the final copy and verification. Stop destination
   API/execution pods as well. The two acknowledgement variables below are
   operator assertions, **not** a process-enforced distributed lock.
3. Configure the source roots with
   `RIVET_WORKFLOWS_MIGRATION_SOURCE_ROOT`,
   `RIVET_MIGRATION_SOURCE_APP_DATA_ROOT`,
   `RIVET_MIGRATION_SOURCE_RECORDINGS_ROOT`, and
   `RIVET_MIGRATION_SOURCE_RUNTIME_LIBRARIES_ROOT`. Configure the separate
   destination using `RIVET_MIGRATION_TARGET_DATABASE_URL`,
   which must explicitly name the PostgreSQL host and database,
   `RIVET_MIGRATION_TARGET_DATABASE_SSL_MODE` (`disable`, `require`, or
   `verify-full`), `RIVET_MIGRATION_TARGET_S3_BUCKET`,
   `RIVET_MIGRATION_TARGET_S3_ENDPOINT` (empty for AWS),
   `RIVET_MIGRATION_TARGET_S3_REGION`, `RIVET_MIGRATION_TARGET_S3_PREFIX`,
   `RIVET_MIGRATION_TARGET_S3_FORCE_PATH_STYLE` (`true` or `false`),
   `RIVET_MIGRATION_TARGET_S3_ACCESS_KEY_ID`, and
   `RIVET_MIGRATION_TARGET_S3_SECRET_ACCESS_KEY`. Set
   `RIVET_MIGRATION_TARGET_SETTINGS_ENCRYPTION_KEY` to the **same** key that the
   destination Kubernetes deployment will use for encrypted App Settings.
   Supply secrets through a secure process environment, not command-line
   arguments or a committed dotenv file.
   The importer prints the number of projects, recording bundles, and saved
   App Settings domains found before it initializes the target. The count
   includes a legacy `web-app-routes.json` as the public-route domain. Compare these
   with the VM's inventory. An empty workflow root is rejected unless
   `RIVET_MIGRATION_ALLOW_EMPTY_SOURCE=1` is explicitly set. A source with no
   saved App Settings is rejected unless
   `RIVET_MIGRATION_ALLOW_DEFAULT_APP_SETTINGS=1` is explicitly set. Use these
   overrides only after confirming that the installation is genuinely empty
   or uses entirely default settings, respectively.
4. If installed runtime libraries are present, first verify that source and
   target use compatible OS, CPU architecture, Node ABI, and image/package
   runtime. Only then set `RIVET_MIGRATION_RUNTIME_PLATFORM_ACK=1`. Native
   modules copied from an incompatible VM will not become usable merely
   because their artifact checksum matches. Reconcile the old
   `active-release` layout on the VM before freezing the copy; the importer
   refuses a legacy or manifest-inconsistent runtime-library tree.
5. With the destination offline but the source still live, set
   `RIVET_MIGRATION_TARGET_OFFLINE=1` and run
   `yarn studio-server:workflow-storage:precopy` using the same roots and
   credentials. It stages current project content; it does not certify a
   final source snapshot. A retry rechecks staged hashes. The target gate
   prevents API startup from this point until exact verification completes.
6. Set `RIVET_MIGRATION_SOURCE_QUIESCED=1` and
   `RIVET_MIGRATION_TARGET_OFFLINE=1`, then run
   `yarn studio-server:workflow-storage:migrate` on a host that can read the
   source roots and reach both managed services. The importer may be retried
   against an interrupted partial copy: matching existing projects/rows are
   accepted, mismatches and extra target state fail. It does not delete source
   data. Do not start destination serving pods during a retry.
7. Run `yarn workspace @valerypopoff/rivet-studio-server-api run workflow-storage:verify`
   with the same configuration while the source remains frozen. This reads
   target objects and rows and compares actual project, dataset, publication,
   web-app, recording, Evaluation, health, settings and runtime-library state,
   not only counts. It also resolves every imported published and latest
   endpoint, published web-app route, and web-app access policy through the
   managed execution read path without running arbitrary production graphs.
   The verify path uses schema and bucket health checks instead of creating
   them.
8. Perform a separate deployment rehearsal with the exact target image,
   settings encryption key, PostgreSQL, bucket, region and prefix. Check the
   project tree, edited drafts, endpoint and web-app URLs/access policy,
   historical recording replay and input search, Evaluations, runtime-library
   execution and cross-project calls. Verify the Kubernetes migration Job
   accepts the already-populated settings row and reports no Helm/Vault drift.
   Only then route traffic to Kubernetes; keep the VM data and backups intact
   for rollback. Before lifting VM maintenance for a pre-write rollback, stop
   all destination pods and close the destination gate through the migration
   UI; the source remains paused if this safety step fails. Once Kubernetes has
   accepted writes, returning to the old VM requires a coordinated restore or
   reverse migration, not simply lifting its fence. A Storage-tab switch on the VM is **not** the recommended
   production cutover because it cannot atomically coordinate the two running
   topologies.

## Failure and limits

The copier refuses a missing or duplicate project ID, missing published
snapshot, corrupt history metadata, incomplete recording bundle (including
missing, non-regular or unreadable replay artifacts), unknown App Settings JSON domain,
extra target project/folder/settings domain, mismatched existing row, or
mismatched artifact. Recording artifacts are checked before target copy starts.
It fails closed; it never guesses or rewires project identities.
Object uploads may precede a failed metadata transaction, so a failed attempt
can leave unreferenced target objects. Preserve them for diagnosis; use the
managed reconciliation/audit path after a successful cutover, not blind bucket
deletion. Verification proves a frozen source equals the target at the time of
comparison; it cannot prove that the source stayed frozen if another process
ignores the operator stop procedure. It also cannot prove third-party S3 or
PostgreSQL durability after the check, external DNS/TLS, or native-library
runtime compatibility. Real PostgreSQL+S3 and Kubernetes rehearsal remain
release requirements; unit/build checks alone are insufficient. The disposable
local PostgreSQL+MinIO copy/retry/verify fixture is
`yarn workspace @valerypopoff/rivet-studio-server-api run test:migration-managed`;
it is not a substitute for a rehearsal using the production VM snapshot and
the actual managed provider credentials.

The browser flow still depends on the operator to keep the destination pods
offline, use matching deployment secrets, and conduct the Kubernetes release
rehearsal. There is no one-click or atomic cross-cluster traffic cutover.
