# Local metadata backup and restored-copy rehearsal

These tools prepare the **legacy files-to-SQLite upgrade**, not a live cutover or the later S3/PostgreSQL migration. They never stop production automatically. A backup on the same VM is not sufficient protection against VM/disk loss. Keep an independently verified off-VM copy and separately preserved deployment secrets.

## Browser backup before activation

Updated standard single-host Compose deployments offer a UI-owned first-time preparation and the combined **Pause writes and create verified backup** action. The independent source inspection/pause controls below remain available under advanced details. Preparation generates one private key and provisions control storage while both serving children are stopped; activation and final write resumption also coordinate both children through the supervisor. Custom launchers without these capabilities retain the manual prerequisites and restart procedure.

For a UI-prepared installation, retain `ui-managed/ui-configuration.json` in the reserved local-metadata volume and `local-metadata-ui-control.json` in App Data. The latter binds the installation to its original root/key hash and prevents a missing volume from silently selecting stale legacy data. Post-upgrade stopped-host backups must preserve the entire reserved volume, including the UI configuration and its `ui-managed` control/artifact tree, not only the nested SQLite files. Keep the downloaded key separately protected; never generate a replacement key or delete the binding during recovery.

For the supervised, authenticated single-host local upgrade, **App Settings → Local storage upgrade → Create verified backup** performs backup creation and scratch restoration without console commands, after **Pause writes and drain** reports a quiet source. The API owns a background job and polls progress through the existing operator status. Closing/reloading the browser does not cancel it; a backend restart reports an interrupted job and requires a fresh backup. No partial archive is certified.

The gzip tar archive contains `workflows/`, `recordings/`, `appData/`, `runtimeLibraries/` and `backup.json` (`kind: rivet-browser-legacy-backup`, version 1, frozen-source/content fingerprints, encryption-key-excluded marker). Paths are logical domain names, not the original host paths. It includes all files in those four roots, SQLite side files, empty directories, ordinary modes and confined relative runtime-library links. This is a distinct portable archive format, not the stopped-host CLI directory format or its receipt. The CLI `--verify`/`--restore` receipt parser does not consume this tar file. An administrator can extract the tar into a new isolated directory and map its four domain directories to the corresponding restored roots for offline fingerprinting and rehearsal. Never extract it over the serving installation.

The API copies into private control-volume scratch, restores the actual archive, checks all content/modes/links and migration fingerprint, and rereads the source before marking it ready. It requires real non-overlapping roots/control storage, excludes unsafe links/special entries/set-ID modes, and streams hashes/archive data. Allow at least three times all four roots' uncompressed file bytes plus 64 MiB free in control storage for staging, archive and restore; successful scratch directories are removed after verification. The archive is mode 0600 in a fresh mode-0700 `browser-backups/<uuid>/` directory; the archive and its directory entries are synced before durable ready status is published. Archives and failed private job directories are retained; repeated attempts consume disk space and eventually refuse capacity. Operator cleanup must target only reviewed backup-owned directories, never source roots or active generations. This is not a scheduled backup/retention service.

**Download verified backup** streams the archive as an authenticated attachment (no multi-gigabyte browser Blob). The API rehashes it before download/copy certification. **Download encryption key separately** is a distinct authenticated, non-cached attachment; keys never appear in operator JSON, archive manifests or logs. Both download routes reject cross-origin browser requests, including same-site sibling hosts, and validate any supplied Origin against the server authority. Same-origin UI navigation and signed direct requests without browser-origin headers remain supported. UI confirmation is explicit because the server cannot observe whether a browser download completed or was safely stored outside the VM. Save the archive and key in separately protected locations; the legacy settings inside the archive may themselves contain credentials. TLS, `.env`, arbitrary external file/plugin dependencies and browser storage are not included and need their own protected backup.

An unreadable or corrupt optional `browser-backup.json` is reported separately from authoritative transition status. It cannot certify a browser-backed copy, but it does not disable legacy recovery, status polling or creation of a fresh verified backup. Strict archive evidence validation still applies to copy and download routes; the UI never treats unreadable evidence as a ready backup.

After exact verification, cleanup adds owner write/traversal permissions only to the fresh job's disposable staging/restored directories, without following symlinks. This permits the production UID 10001 to remove read-only package directories; the frozen source and archived permissions remain unchanged. Run the browser-backup tests as a non-root user as well as root: root alone masks this permission boundary.

This browser archive covers **pre-activation legacy data only**, not a resumed SQLite generation's control/artifact stores. Continue using the coordinated stopped-host format-2 procedure below after SQLite resumption. The same-server scratch restore does not replace the independent actual-data rehearsal, off-host verification, resource qualification or disaster-recovery checks.

## Prerequisites and safety

Format-2 discovery and verification support both manually configured control roots and UI-owned nested journals. UI-owned backups copy the **whole** reserved volume, verify the independent App Data binding and certificate key identity, and retain the bootstrap configuration. Unlike the pre-activation browser archive, this complete-volume backup contains the private bootstrap key: protect/encrypt its transfer and storage, and still retain the separate key download. Missing bindings, incomplete setup or mismatched keys fail closed; do not strip those files to force a restore.

- Use the reviewed candidate commit and API image that passed the packaged fixture gate. Record its immutable image ID/digest; do not qualify a mutable `latest` tag and later deploy different bytes.
- Use Linux, Node 24, and Docker for the real-data rehearsal. The backup/restore library has portable tests, but production backup runs on the source Linux host.
- Obtain an approved maintenance window. Drain work and stop **both** API and executor on the older split VM. Check other containers and host processes that can write any source root. The helper resolves writable mount paths and checks directory/ancestor device+inode identities, rejecting symlink and directory-bind aliases as well as textual parent/child overlaps. Unresolvable writable mounts fail closed. This cannot discover every host editor, cron job, hard-linked file alias or external NFS client; the operator must still exclude those writers.
- The helper requires four real, non-overlapping directories. No root/path symlinks, devices or pipes. Only confined relative runtime-package symlinks are preserved. Escaping/absolute links and set-ID permissions require reviewed disposition before backup. Ordinary modes and sticky directory bits are preserved, not silently stripped. Proof metadata is limited to 64 MiB; oversized proofs are refused before certification.
- Back up `.env`, TLS material, plugin/file dependencies and authentication/encryption keys separately in protected storage. Do not paste their values into logs or chat. Legacy App Settings files themselves can contain secrets: protect/encrypt backup transport and storage.
- Without `--sqlite`, these commands cover the four **legacy** roots (backup format 1). With `--sqlite`, the stopped combined backend's fifth persistent control root is required; it contains the selected databases, immutable artifacts, operational stores, certificates and generation-selection journal (backup format 2). Encryption keys remain a separately protected prerequisite for recovery.

## 1. Discover without changing anything

From the checked-out candidate repository on the VM:

```bash
node deploy/studio-server/scripts/local-upgrade-backup.mjs \
  --api ops-api-1 --executor ops-executor-1
```

Without `--create` this only reports the resolved mounts, known writers and image IDs. Omit `--executor` only after the deployment actually uses the combined API/executor container.

For the reported 2026-09-28 VM, the four roots are about 5.2 GiB on disk, including 4.6 GiB of recordings. Expanded gzip data and candidate copies may need considerably more space. Prefer a separate rehearsal host; do not infer safe RAM/disk limits from idle VM usage.

## 2. Make the coordinated backup in the agreed window

After work is drained and the operator stops all writers, run this with an **unused** destination whose parent already exists. Use elevated permissions only to read the named Docker-volume data and preserve the backup. The script itself does not stop, restart or remove containers.

```bash
sudo "$(command -v node)" deploy/studio-server/scripts/local-upgrade-backup.mjs \
  --api ops-api-1 --executor ops-executor-1 \
  --destination /protected-backups/rivet-legacy-2026-09-28 \
  --host-writers-stopped --create
```

The acknowledgement is an operator claim, not a way to bypass running-container checks. The helper checks writers before/between/after domain copies; streams file contents; preserves empty folders, modes and supported links; includes SQLite side files; checks source stability; and rereads every destination byte. It issues a SHA-256 `receipt` only after success and filesystem synchronization. Save that receipt separately from the backup. A failure leaves any partial destination for private diagnosis, with no valid receipt and no source-authority change. Never treat a partial directory as a backup or retry by overwriting it.

Resume the original legacy stack through its existing maintenance procedure only after the copy is verified. Do not upgrade its image, clear a maintenance marker by hand, delete volumes, or activate SQLite as part of taking this backup.

## 3. Copy off the VM and verify there

Transfer the entire backup directory to protected storage using the company's approved encrypted transport. For example, `rsync -a --protect-args` preserves the modes, symlinks and empty directories expected by the proof. Do not transfer only the SQLite main files or only project files.

On the independent destination, using the separately saved receipt:

```bash
node deploy/studio-server/scripts/local-upgrade-backup.mjs \
  --verify /protected-backups/rivet-legacy-2026-09-28 \
  --receipt REPLACE_WITH_SAVED_64_CHARACTER_RECEIPT
```

Exact item sets, modes, link targets and file hashes must match. The tool does not certify that a path is off-host; the operator must confirm its independent physical storage. Keep this verified backup untouched throughout rehearsal and production preparation.

## 4. Restore an independent disposable copy

On the rehearsal host, create only the parent directory, then restore to a fresh destination:

```bash
sudo "$(command -v node)" deploy/studio-server/scripts/local-upgrade-backup.mjs \
  --restore /protected-backups/rivet-legacy-2026-09-28 \
  --receipt REPLACE_WITH_SAVED_64_CHARACTER_RECEIPT \
  --destination /rehearsals/rivet-copy-1 --create
```

The restore checks the original backup, copies and rereads all four domains, rechecks the backup and writes `restored-copy.json` version 2. This proof includes the original backup manifest, whose hash must equal the independently saved receipt: editing both restored bytes and their proof cannot retain the original receipt. The runner refuses older unbound version-1 restore proofs; restore a fresh copy from the unchanged backup with the current helper instead of editing the proof. No existing destination is replaced or deleted. Change ownership to UID/GID `10001:10001` on **only this disposable restored copy's four roots**, never the original VM or backup. Keep executable/file modes intact. The runner does not silently change ownership or support unknown rootless/user-remapped Docker mappings.

## 5. Validate a plan, then run the isolated rehearsal

Choose explicit CPU/RAM limits suitable for the rehearsal host. This example is a test limit, not a production sizing recommendation:

```bash
sudo "$(command -v node)" deploy/studio-server/scripts/local-upgrade-restored-rehearsal.mjs \
  --restored /rehearsals/rivet-copy-1 \
  --receipt REPLACE_WITH_SAVED_64_CHARACTER_RECEIPT \
  --image REPLACE_WITH_TESTED_API_DIGEST \
  --memory-mib 1024 --cpus 1
```

The default is plan-only. It verifies the restored copy, pins the installed API image ID, and reports isolation/resource settings. It does not create containers. Run explicitly with a new output directory:

Restored authority roots use the same physical device/inode overlap checks as backup creation, before content scanning. The output directory must also pass the backup helper's fresh-directory checks: its parent cannot alias a restored source subtree, and an existing destination is never reused. This checks directory identities and ancestors visible to the host; it does not discover every nested bind mount, hard-linked file or host writer. Keep the operator writer-exclusion requirements above.

```bash
sudo "$(command -v node)" deploy/studio-server/scripts/local-upgrade-restored-rehearsal.mjs \
  --restored /rehearsals/rivet-copy-1 \
  --receipt REPLACE_WITH_SAVED_64_CHARACTER_RECEIPT \
  --image REPLACE_WITH_TESTED_API_DIGEST \
  --memory-mib 1024 --cpus 1 \
  --output /rehearsals/rivet-run-1 --run
```

The runner creates a uniquely named combined API/executor container with `--network none`, **no ports**, read-only root filesystem, bounded scratch, no swap allowance beyond its memory limit and no Docker socket. Only the disposable four roots and fresh control root are writable. Operator API calls run through container-local loopback; production integrations cannot be reached. Restored production graphs are never executed.

Before starting the backend, it creates the clone's persistent maintenance fence and captures its authoritative source fingerprint. It refuses qualification if startup changes that fingerprint, including unexpected retention or startup normalization. Inspect the retained clone instead of certifying changed data as the original backup. Cleanup failures also produce a failed report with the owned container name for private inspection.

It exercises the real operator API: pause/drain → copy/exact verification → activate while paused → whole-backend restart → selected-runtime validation → online return to legacy → restart/validation → legacy resumption commit followed immediately by re-fencing → restart → another conversion → deliberate selected-settings corruption → fail-closed startup → key-free packaged offline recovery → legacy validation/resumption commit/re-fencing/restart. Every conversion and successful restart must match the original frozen source fingerprint, not a newly accepted changed clone. This prevents retention cleanup from trimming old recordings between trials. The final state is **legacy with source writes still paused**, not a writable SQLite cutover. The separate packaged fixture gate covers real post-conversion writes with controlled data.

The private `result.json` records exact image ID, backup receipt, original frozen fingerprint, explicit limits, sampled memory high-water and completed phases. Sampling is not a perfect peak/OOM prediction. `clone.env` contains independent clone authentication/encryption material and is mode 0600; preserve it privately with control data if diagnosing the clone. The runner registers backend and transient tool names before launch, so a failed/timed-out Docker CLI call cannot hide a container already created. Cleanup verifies ownership before stopping anything and reports retained/uncertain names if it fails. The runner stops but retains failed containers, never removes data/volumes, and does not emit raw source/package errors or secrets. Successful runs remove only their own container. A used copy must not be reused as an untouched restore: restore another fresh copy for a new run.

## Memory and acceptance

The restored-data runner handles SIGINT/SIGTERM (including a parent-command timeout) as a failed rehearsal: foreground Docker commands are cancelled, ownership-checked stop/cleanup remains available, and the clone/control/report is retained. Repeated signals do not remove the cleanup handlers. Do not force-kill it while it is stopping a clone. SIGKILL, host loss and a Docker daemon that cannot respond remain outside graceful cleanup: inspect the exact privately recorded owned names and stop only matching containers before reusing any restored data. Interruption never certifies a PASS or grants permission to activate production.

The Linux regression suite sends real SIGINT and SIGTERM to child Node processes and verifies nonzero exit only after ownership-checked cleanup calls complete, with no container deletion. Docker operations in this focused signal test use a deterministic test seam; it proves process-signal handling, not native Docker-host orchestration. Windows skips this POSIX-only check. The complete native-host release gate below remains required.

Loopback login requests have a 15-second HTTP deadline; readiness probes have a five-second deadline. Operator conversion requests retain their separate 15-minute deadline. A backend that accepts a connection but never sends headers cannot silently hold these probes open. The packaged fixture command reader waits for stdout/stderr to close before accepting successful output, keeps only a bounded diagnostic tail, and imposes a 20-minute foreground-command deadline. After timeout it sends SIGTERM, then SIGKILL after five seconds if needed; it never accepts a timeout as success even if termination exits zero. These signals target the direct foreground child, not an entire descendant process tree. Docker resource cleanup remains ownership-checked separately, and host/daemon failure still needs operator inspection.

Focused regressions exercise real stalled loopback HTTP servers, final subprocess output, timeout exits and Linux escalation. Directory-alias regressions use generated backup/restore fixtures and a filesystem identity seam; they are not a privileged bind-mount integration run. Run the backup, snapshot-plan and rehearsal-safety test suites together on Linux; Windows skips only the POSIX-specific cases.

The backup library is tested on Windows and Linux. The expanded packaged synthetic browser/API/restart/recovery gate must pass all required phase receipts, not just its older baseline. The restored-copy runner still requires a complete native Linux-host integration run. Run it where the Docker daemon's writable mount sources are physically resolvable by the host process: remote Docker or Docker Desktop through WSL does not establish that contract. A WSL attempt on 2026-09-28 correctly refused preflight because daemon-owned paths were not available for writer detection. An attempted test using a Docker socket inside an orchestration container was rejected by safety review; no socket workaround is required or recommended. Run the documented commands directly on the rehearsal host. Neither synthetic tests nor tooling inspection qualify actual production data.

The production-image Playwright gate follows the guided UI, not hidden manual controls: **Pause writes and create verified backup**, both authenticated attachment downloads, explicit backup/key attestations, **Copy and verify**, automatic activation restart/validation, and explicit write resumption. It hashes the downloaded archive and compares its size and hash with the durable backup receipt, compares the separate key download's hash and byte count with the fixture's configured encryption key, and checks the independently restored fixture fingerprint. Resumption must reach the intended legacy/SQLite phase with that backend running and the combined runtime ready, not merely any resumed phase. The gate waits for completed restart/write admission rather than issuing an extra console restart. Downloaded key/archive bytes stay in temporary Playwright storage and are not attached to reports. Offline recovery still exercises the packaged CLI against the isolated corrupted candidate; online recovery uses the UI.

The image gate builds host-side Core output for its Playwright fixtures. Run it in a dedicated checkout or after other checks that rebuild Core have finished; concurrent clean/rebuild operations can remove `dist/esm` while the browser test worker imports it. Container isolation does not isolate these host build artifacts.

The post-resumption backup/restore phase stages the backup tool, snapshot planner and UI-managed layout helper together, preserving their deployment-relative module paths under `/fixture-tools`. Only these exact, read-only fixture bindings are allowed on the API service. Staging checks each directory parent before creating its child, refuses symlink/junction ancestors, and never overwrites an existing tool. Behavioral packaging regressions import the staged backup entrypoints in a fresh Node process and verify that refused directory aliases leave their foreign targets untouched, so omitted dependencies and unsafe staging fail locally rather than after the earlier browser phases have passed.

Conversion retains one decoded project/history or recording bundle at a time, rather than all artifact payloads. Gzip input is streamed and output is limited before concatenation; legacy size declarations are checked but not trusted for capacity. `RIVET_LOCAL_METADATA_MAX_BUNDLE_MIB` defaults to 32, accepts 1–128, and replaces the old aggregate `RIVET_LOCAL_METADATA_MAX_SOURCE_MIB` option. A project **including its retained history**, registered settings import, or runtime archive must fit the bundle budget. Large installations are supported when their individual bundles fit; an oversized bundle is refused, not skipped. Metadata/identity sets still scale with item count. The limits are conservative estimates, not reservations or a guarantee against OOM.

A constrained-heap regression converts and exactly verifies 192 distinct legacy gzip recordings (over 192 MiB decoded in aggregate) with a 192 MiB V8 heap and a 2 MiB per-bundle budget. This is synthetic evidence, not qualification of the reported 4.6 GiB recording folder.

Production activation remains blocked until an actual restored data copy passes these checks, a separate controlled functional rehearsal covers required external dependencies, an independent backup/key recovery is demonstrated, the intended image set passes CI, and the operator approves the live maintenance window. Do not claim that repository tooling alone completed an off-VM backup or production-data rehearsal.

## Post-resumption coordinated backup and restore

Once SQLite writes have resumed, returning to stale legacy files is refused. Take a **new** backup of the current selected state, not another copy of only the four retained legacy roots. Drain and stop the whole combined backend, exclude host/other-container writers, then use a fresh destination:

```bash
sudo "$(command -v node)" deploy/studio-server/scripts/local-upgrade-backup.mjs \
  --api ops-api-1 --sqlite --host-writers-stopped \
  --destination /protected-backups/rivet-sqlite-after-upgrade --create
```

The fixed container root contract is `/workflows`, `/workflow-recordings`, `/data/rivet-app`, `/data/runtime-libraries` and `/data/local-metadata`. Discovery refuses remapped roots or a split executor; recovery certificates bind those exact container paths. Host mount sources can change on the isolated restoration host. The helper requires `sqlite-live`, checks the selection/certificate, database integrity and supported catalog/settings identities, and streams/checksums every catalog-referenced artifact before issuing a receipt. Both selected operational databases are mandatory even when their original legacy domains were absent: conversion creates certified empty databases, and missing one later is data loss. Artifact fields are checked explicitly against the supported catalog schema; missing/malformed pointers cannot be silently skipped, and unrelated hash/size-shaped metadata is not treated as a blob pointer. Shared artifacts are hashed once per inspection with consistent size checks. It copies the complete control root, including caches and other retained generations; this intentionally favors conservative recovery over minimal backup size. Include SQLite side files, preserve the separately saved receipt, and copy/verify this backup off-VM as in section 3.

Restore with the same `--restore`, `--receipt`, `--destination ... --create` command into a **fresh** directory. Format 2 restores `control` alongside the four original domains and verifies selected databases/references again. Never restore over live roots, mix one backup's control with another backup's artifacts, overwrite the old VM or edit a selection journal to recover. These helpers do not activate or deploy the restored stack. They cannot decrypt or certify the settings key: only startup with the original separately restored key can prove that step.

Mount each restored domain at its original container path on an isolated deployment of the exact tested image. If retaining the compatibility mount `/home/rivet/.local/share/com.valerypopoff.rivet2`, point it at that same restored `appData` directory. Give UID/GID 10001 ownership on only the disposable restored roots. Preserve the local metadata encryption key and deployment authentication separately; do not rotate the key while testing recovery. Disable public routing and outbound production integrations **before** startup. A `sqlite-live` snapshot resumes its live selection, so the isolated restoration must not be exposed publicly while validating it. Verify startup, tree/dataset/history/binding identities, settings redaction, new recordings, operational rows and package execution; restart/recreate and repeat. Only independently qualified restoration may replace a failed production deployment in an explicitly approved maintenance window. No automatic traffic switch is provided.

The packaged fixture gate exercises this format after real SQLite writes, restores into five newly created volumes (never over the original instance), starts the combined API/executor against the restored state and checks those writes again. It also confirms pre-write legacy rollback remains closed. This synthetic proof does not establish the recovery-point age or external side effects of a future production incident: a restored backup contains changes only up to its consistent snapshot.

Operational backup validation also requires the supported Evaluation and profile-health table sets and columns. An empty, unrelated or partially dropped database can pass `PRAGMA integrity_check`; it is still refused before a destination or receipt is created. The standalone helper deliberately does not depend on compiled API output, and generated fixture tests check its accepted schema against the serving API guard. Decryption and full serving validation still require isolated startup with the separately restored settings key.

## Linux-host orchestration release gate

The restored runner's container has no nginx. Its operator requests log in through the API's direct `/ui-auth` route, attach the derived proxy service token on login and subsequent requests, and retain the signed operator cookie plus migration-intent header. `/__rivet_auth` is the external nginx route and cannot be used inside this container. Missing keys or missing login cookies stop the runner before a mutation; credentials and tokens are never printed. Loopback HTTP regression tests cover this direct-backend boundary.

The host gate validates the entire restored runner receipt before publishing PASS: all five recovery phases must be present exactly once in the required order, with valid timestamps, the supplied backup receipt and exact image/limits must match, a positive memory sample must exist, the final clone must remain fenced, and no owned container may remain after successful cleanup. Unexpected phase fields are refused instead of being forwarded into public diagnostics. The public summary records the image's commit label; cleanup failures have a separate redacted failure summary and can never issue a PASS receipt. This evidence is still a synthetic-host gate, not production-data certification.

`local-upgrade-restored-host.integration.mjs` runs the complete restored-copy orchestration directly on a Linux Docker host, using generated data, an immutable API image and 1 GiB/1 CPU test limits. It creates its own stopped seed container and owned volume, copies a checksummed backup out, restores an independent host copy, and invokes the real runner for conversion/restart/online and key-free offline recovery. No Docker socket is mounted. It requires elevated permissions only for ownership-preserving **fresh disposable** host roots. It never consumes a dev/production source path or executes a production graph.

Its seed container uses the same explicit backup-tool dependency list as the browser image rehearsal. Each module is mounted read-only under `/tools` with its deployment-relative path (`scripts/…` or `images/api/…`); flattening the scripts or omitting the UI-managed layout helper breaks imports before fixture generation. The exported fixture-argument factory is used by both the host gate and its regression, not duplicated in the test. The ordinary production-cutover suite checks the exact mount plan and imports that plan's copied modules in a fresh Node process without unrelated files available. It also confirms that removing the layout helper fails import.

For a Docker-capable checkout with a built API image, run the actual seed-container regression too:

```powershell
$env:RIVET_REHEARSAL_API_IMAGE = 'your-tested-api-image'
node --test deploy/studio-server/scripts/local-upgrade-restored-host.test.mjs
Remove-Item Env:RIVET_REHEARSAL_API_IMAGE
```

Without that explicit image, only the Docker case is skipped; the mount/import regressions still run. With it, the test pins the inspected image ID, executes the exact host fixture command with no network and a fresh labeled volume, requires a real checksum receipt, and removes only its ownership-checked container/volume. This seed test works with Docker Desktop but does **not** qualify the later native Linux-host writer discovery, restore or orchestration phases. The full Linux-host gate remains required in image CI.

The isolated clone sets `RIVET_SHUTDOWN_GRACE_SECONDS=10` because the rehearsal admits no active workflow executions and deliberately restarts the backend several times. Production keeps its normal shutdown grace. Docker still has its separate 150-second stop allowance if cleanup does not finish promptly. Without the shorter clone-only grace, repeated idle shutdowns can consume the host runner's 15-minute deadline before the final legacy-resumption assertion.

The generated settings must satisfy the current serving validators before the clone starts. In particular, its synthetic environment-variable ID uses the supported 8–128 character format; otherwise startup reconciliation fails and the gate times out before exercising conversion. The fixture must also include the empty workflow transaction/publication roots and runtime-library staging root created by a normally initialized legacy server. They are included in the frozen source fingerprint; omitting them makes first boot look like source drift even when no user data changed.

Build Images now runs this as a required gate after the packaged browser gate, using candidate image provenance. An unrun or failed host gate must not be counted as PASS; Windows component tests do not substitute for it. The private backup/clone/report remains in mode-0700 `artifacts/local-upgrade/linux-host-*`; do not upload `clone.env`, raw backup data or key material. Only redacted, readable CI summaries are written separately under `host-summary-*`. Artifact upload uses explicit fixture/summary paths and does not traverse private backup directories. Early failures record a fixed operation category, never raw source or credential-bearing command output. Actual production snapshot qualification is still a separate operator action.

If the restored-copy orchestration fails after its private result is written, the public `host-summary-*/failure.json` also includes a receipt-bound, fixed `rehearsalStep` name. It never contains raw container logs or exception text. A missing `rehearsalStep` means the child failed before producing its private result; inspect the protected runner environment rather than assuming a particular conversion stage.

Failed one-shot helper containers use Docker `--rm` and may already be gone when cleanup begins. The runner accepts their absence only after the daemon confirms the exact helper name is no longer listed. For a present container, cleanup verifies its ownership label and then stops/removes the inspected immutable container ID, not its reusable name. A missing persistent backend, mismatched ownership label, or unavailable daemon remains a cleanup failure; the runner never assumes those cases are safe.
