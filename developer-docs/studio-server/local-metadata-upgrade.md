# Local metadata storage upgrade

## Ownership and supported deployment

This is an explicit, non-destructive upgrade for the supervised single-host VM/Compose deployment. It does not select S3 or PostgreSQL, and a Storage-tab Save never starts it. Kubernetes uses managed storage instead. The feature is disabled by default.

Remaining delivery and production qualification work is tracked in the [completion plan](./local-metadata-upgrade-completion-plan.md). Its acceptance gates distinguish repository readiness from a completed rehearsal on this VM's actual data.

| Data                                                                                               | Upgraded local authority                 | Managed counterpart           |
| -------------------------------------------------------------------------------------------------- | ---------------------------------------- | ----------------------------- |
| Project/folder catalog, revision pointers, publications/history, routes, web-app identities/access | SQLite catalog                           | PostgreSQL                    |
| Recording identity, searchable input, replay references                                            | SQLite catalog                           | PostgreSQL                    |
| All registered App Settings domains                                                                | Encrypted SQLite settings                | Encrypted PostgreSQL settings |
| Runtime-library manifest/activation and archive reference                                          | SQLite catalog                           | PostgreSQL                    |
| Evaluation library/runs/artifacts and LLM-profile health                                           | Copied operational SQLite databases      | PostgreSQL                    |
| Project/dataset/revision bytes, recording/replay payloads, package archive                         | Immutable checksum-addressed local files | S3 objects                    |

Graph metadata embedded in project bytes remains part of that artifact. Catalog rows, not scans or sidecars, establish existence, tree position and publication state. New writes never update retained `.wrapper-settings.json`, `.published/*.json`, recording `metadata.json`, App Settings JSON or runtime `manifest.json`.

Plugin preparation, stats, temporary files and extracted caches are not metadata authorities. Arbitrary VM file dependencies and browser IndexedDB are not converted. This is not a disk-write-free mode.

## Delivered workflow and rollback boundary

The operator service provides inspection, backup certification, persistent maintenance/drain, a durable copy job, exact verification, paused activation, runtime validation, explicit resumption, a redacted report and return to legacy. Offline recovery works when the selected API cannot start.

Both API and executor start from the same generation and journal revision. Selection is immutable for a process lifetime. Activation, return to legacy and resumption require restarting the entire combined backend. Old processes remain fenced even after the maintenance marker is removed. A missing/corrupt/incompatible journal never means "start a fresh legacy instance."

The generation certificate binds all four configured source mounts during SQLite **and legacy** startup and before operator authority changes. Paused legacy recovery rechecks the frozen content proof before file-backed repositories can initialize defaults or reconcile files. It does not open the candidate or require its settings key. After legacy write resumption, normal content changes are allowed while mount identity remains bound; changing deployment paths is not a recovery shortcut.

The editor loading overlay covers only the editor pane. Sidebar Settings and its upgrade/recovery controls remain reachable if maintenance prevents editor initialization, including after a full reload; no forced browser click or temporary write bypass is needed. Backend authentication and maintenance still reject ordinary writes.

Before upgrade opt-in, the dashboard calls a separate read-only setup endpoint guarded by the same strong key/OAuth operator session as migration actions, but not by the upgrade flag. It returns only booleans for local-VM eligibility, flag/root/key readiness, whether SQLite is selected and whether it is already live; it never returns paths or secret values. On an eligible legacy VM with missing setup, a prerequisite modal names the three deployment environment variables, the persistent control volume and offline one-time provisioning order. It explicitly distinguishes deployment secrets from the Rivet Settings Environment variables tab, warns not to start the normal backend with an unprovisioned control root, and offers only Postpone until setup is complete. Its configuration flags do not prove that a control volume is fresh or that a key matches an earlier generation: the modal explicitly forbids replacing an existing key or re-provisioning an existing upgrade. If SQLite is already selected but still paused and the operator disables upgrade controls, the modal gives recovery instructions instead of fresh-provisioning instructions. Kubernetes/managed deployments, unauthorized users and already-live SQLite (even with upgrade controls disabled later) get no setup modal. The default disabled upgrade remains safe: this modal does not provision, copy or pause anything.

After setup, each fresh dashboard load shows a signed-in operator a local-storage-upgrade reminder when the enabled upgrade status confirms a stable legacy runtime (`legacy` or `legacy-resumed`, no maintenance or pending restart), even if an old copy job remains in the audit ledger. Postpone dismisses it only for that page load; it is not a durable refusal. Review upgrade steps opens Settings directly on the existing Local storage upgrade tab, without pausing writes or starting a copy. Once durable state shows a paused source, copy job, verified candidate or selected runtime awaiting finalization, a continuation modal returns on every page reload and opens that same tab. It explains when return to legacy remains possible and when SQLite write resumption has closed one-click rollback. The prompt is cleared while another Settings/modal dialog is open and status is reread when that dialog closes, so a same-page pause or completion cannot reveal a stale legacy offer or recovery instruction. While visible, it rechecks status every ten seconds so another operator's completion or lost authorization removes stale guidance. Temporary setup/status connection or server failures hide stale guidance and retry after three seconds; authorization failures do not retry. A completed `sqlite-live` runtime (SQLite running, no maintenance or pending restart) does not show the reminder. The recovery buttons are absent after `sqlite-live`; the backend also refuses rollback then. Dismissing either reminder lasts only for the current page load. This UI does not replace control-volume provisioning, a restored backup, encryption-key recovery or the explicit activation/resumption gates below.

The upgrade panel uses the shared Settings button, text-field and checkbox controls. Inspection/maintenance, backup certification/copy, activation/validation, write resumption and recovery/report actions have separate titled sections. Each action occupies its own row; backup fields and attestations are grouped in a dedicated form, and long fingerprints/paths wrap without widening the modal. This is presentation only: the existing operator authorization, maintenance, verification and resumption gates remain unchanged. Mocked Playwright checks cover the action layout, field accessibility and safety states without running a conversion on the developer's real data.

The panel discards its last status and locks actions when status polling loses connectivity or authorization. Only a fresh successful response unlocks it; reconnect clears the connection warning without erasing an action's diagnostic. Older failed requests cannot overwrite newer responses. The write-resumption acknowledgement stays disabled until successful validation and is bound to the displayed generation, validation phase and journal revision, not carried into another candidate or revalidation. Its hint distinguishes SQLite's irreversible resumption boundary from continuing the legacy backend after recovery.

Runtime validation has visible in-progress, failure and success feedback directly below its action button. Success identifies SQLite or legacy and states that writes remain paused; it is derived from the server's durable validation state, not from an empty HTTP 204 response or a transient toast, so it survives reopening the panel. A different generation, validation phase, required restart, lost operator status or failed revalidation cannot leave a stale success message visible. Revalidation clears the browser acknowledgement, and a failed attempt locks acknowledgement/resumption for that generation and revision until validation succeeds. The feedback never checks the resumption acknowledgement or resumes writes automatically.

Every upgrade action uses the same loading-button/progress component. Inspection, pause/drain, fingerprint, copy, activation, validation, return to legacy, both resumption paths, cancellation and report download show a theme-contrasting spinner on the initiating button and an adjacent live progress message. The pending action is the single source of UI busy state, and a synchronous guard rejects repeated clicks while its request and status refresh are outstanding. Server-reported copying and draining keep their indicators after the initial HTTP request returns and when the panel is reopened; a short request deadline is not imposed on these legitimate long-running operations. Pending indicators clear on success or failure, never select a backend or resume writes themselves.

Action settlement suspends background polling and invalidates older status reads. Every completed or failed action attempts a fresh status read before unlocking controls: a lost HTTP response does not prove that the server made no durable change. If reconciliation fails, the connection gate stays locked while the original action diagnostic is retained. Restart completion is derived from current server status, not a sticky browser flag; validation, acknowledgement and resumption all require the running backend to match the selected backend. A fingerprint is shown and accepted only for the maintenance session in which it was read. Failed repeat fingerprint/inspection reads discard their earlier proof/inventory instead of silently enabling the next step from stale results. These are browser safeguards in addition to server-side revision, source and backup checks, not replacements for them.

Authenticated status also reports a fixed, non-secret `operation` name while any local-upgrade operation or copy worker is running. Reopened panels and other operator browsers display its progress and lock competing actions; the server still arbitrates races with a fixed 409 `local-upgrade-busy` response. This volatile activity signal is not authority or a durable job: interrupted copies are recovered through the existing ledger, and a restarted process never invents a successful operation. Local pending actions take display precedence so "Finish durable resumption" does not also spin the ordinary Resume button. Backup attestations are bound to the current pause, transition revision, frozen fingerprint and backup reference; changing either evidence field clears both checkboxes, and a new pause/revision requires review again. A lost operator status clears the write-resumption acknowledgement, so reconnect cannot silently re-enable an already-checked Resume button. The UI blocks new inspection/fingerprint/copy cycles and unchanged-legacy cancellation while a restart is required. Validation failures have one adjacent diagnostic rather than duplicate alerts.

- Before SQLite write resumption, legacy can be selected again, with writes still paused, after rechecking its exact source proof.
- Resumption durably closes one-click rollback **before** removing maintenance. A crash between these steps remains paused; "Finish durable resumption" completes it.
- Completing that crash gap advances the durable revision before clearing maintenance. Even a process that restarted in the already-resumed phase stays fenced until another whole-backend restart; clearing only the marker cannot make it writable.
- After resumption, old files are stale. Recovery requires a coordinated SQLite-plus-artifacts backup restore or a separately verified reverse export. Do not clear environment flags, edit the journal or downgrade to an unaware image as a rollback shortcut.

Closing the browser does not cancel copying. Restart leaves an interrupted job and maintenance intact. Explicit retry accepts only the same generation, frozen source and backup reference; existing candidate metadata/bytes must match. Failure never selects a partial candidate. If certification committed but the final job-status write did not, the durable transition takes precedence in status reporting.

The job persists its current stage and a fixed failure category (`disk-full`, `permission-denied`, `missing-data`, `io-error`, `invalid-data`, or `verification-failed`). Failed jobs have a downloadable, explicitly unverified report. A new failed copy reports its own job ID, never a previously returned generation's certificate; the download filename follows the returned report identity. Raw exception messages, stacks, paths, SQL and error causes are never persisted: they can contain settings secrets. An internal checkpoint seam is used only by tests; no HTTP or production environment variable can inject a fault.

Unhandled storage-operator API failures, including inspection failures before a copy job exists, also use only a fixed failure code and request correlation ID in logs. Their HTTP 5xx response is fixed text, never an exposed parser/driver error or its arbitrary error code. A malformed generated recording metadata fixture verifies that private source text does not enter either output. Authentication and request-validation errors retain their normal HTTP status behavior.

## Deployment preparation

First rehearse on an isolated restored copy of the **actual VM data**, using the same image/filesystem. Keep the clone away from public routing, live queues and unrestricted production integrations. Automated fixtures do not replace this rehearsal.

Deploy the new image/Compose version with the upgrade disabled and confirm legacy serving. Compose mounts persistent `rivet_local_metadata` at `/data/local-metadata`; the existing ownership initializer grants UID/GID 10001 access. It is not scratch or a container layer. Never use `down -v` during upgrade/recovery.

Keep the four original source mounts/container paths: `RIVET_WORKFLOWS_ROOT`, `RIVET_WORKFLOW_RECORDINGS_ROOT`, `RIVET_APP_DATA_ROOT`, `RIVET_RUNTIME_LIBRARIES_ROOT`. Control storage must be outside all four. Roots and selected generation directories must have real, non-symlink ancestors.

Provision a securely generated, dedicated encryption key of at least 32 characters. Store it outside SQLite in deployment secrets and back it up separately. Losing/changing it blocks startup, never resets settings. Never paste it into the wizard or shell command line.

The operator status exposes only a `copyConfigurationReady` boolean, never the
key or its length. An absent/short key disables copying in the UI but does not
hide legacy recovery controls. Both setup and copy guidance distinguish first-time key generation from restoring the original key for an existing candidate; replacing that key is not a retry. The copy API also rejects it with a fixed 409
`local-encryption-key-required` response before creating a job or candidate.
After editing `.env`, recreate the backend with the normal launcher: `docker
start`/`restart` retains the old container environment. Preserve the new key
separately and renew the backup attestation after reopening the panel. This
configuration correction is safe only before a candidate uses the key; it is
not a supported key-rotation procedure after conversion.

Add to the protected deployment environment:

```dotenv
RIVET_LOCAL_METADATA_UPGRADE_ENABLED=1
RIVET_LOCAL_METADATA_CONTROL_ROOT=/data/local-metadata
RIVET_LOCAL_METADATA_ENCRYPTION_KEY=<dedicated secret supplied securely>
```

Keep strong UI authentication enabled: key-session or administrator OAuth. Trusted-client/IP bypass alone cannot invoke upgrade actions. The combined supervisor supplies ownership/editor-drain flags; do not fake them in unsupported processes.

The bundled nginx forwards the complete request `Host`, including a non-default port. Operator mutations compare browser `Origin` with that authority and require the migration-intent header; cross-origin requests remain rejected. An external gateway must preserve the same authority too, rather than stripping the browser port or weakening the API's origin check.

Stop the **whole** combined API container. With the same project name, environment file and Compose overlays as the launcher, run a one-off API image with its normal mounts:

```sh
docker compose <your normal Compose arguments> stop api
docker compose <your normal Compose arguments> run --rm --no-deps \
  --entrypoint node api \
  /app/packages/studio-server-api/dist/studio-server-api/src/scripts/local-metadata-control.js --provision
```

`--provision` is one-time setup on a new control volume, not a reset. It acquires the supervisor's exclusive owner lease and creates `transition.sqlite` and `upgrade.sqlite` with legacy selected. A partial provisioning failure requires inspection, not automatic deletion/recreation. Restart with the normal launcher and open Settings -> Local storage upgrade.

Use `local-metadata-control.js --capacity` before copying to inspect payload, disk and memory headroom without writing or provisioning databases. Supply the four absolute source/restored roots and an existing control root outside them, in the supported image and with the real deployment resource limits. Exit code 2 means capacity refusal, not successful certification. This command measures capacity only; it neither freezes data nor replaces exact verification.

Keep the key/control root across every restart. After upgrading, disabling only the operator UI flag is safe; removing the control root or key is not.

## Operator procedure

1. Inspect source: roots, counts, portability warnings and capacity.
2. Pause writes and drain. Persistent maintenance rejects new saves, settings changes, executions and WebSocket actions. Notification-only workflow-tree and Evaluation-library SSE streams close after the durable marker; they must not keep the operator's own browser in the HTTP drain forever. A stream whose asynchronous setup finishes later refuses to open. Accepted saves/executions are not aborted: wait for HTTP/editor/action runs, recording queues, catalog writes, connection tests and library jobs. Prohibit host-side edits too.
3. Back up all four frozen roots, including SQLite side files, and the separate encryption key. Restore an independent copy. Same-disk copies do not protect against disk failure.
4. Run `local-metadata-control --fingerprint` on the restored copy in the supported image, supplying its four **absolute restored root paths**. The command reads twice and refuses moving data. It hashes owned content, not absolute root names. Compare its output with "Read frozen source fingerprint." Enter a non-secret backup reference/hash and attest restored-backup/key recovery checks.
5. Copy and verify. No source is deleted or rewritten. Download the redacted report. On failure repair/retry the same generation, or resume unchanged legacy and restart. Capacity and drift checks are repeated server-side.
6. Activate SQLite while paused. Restart the combined container and reopen the panel. Both processes must load the certified generation and become ready; no workloads run yet.
7. Validate selected runtime. Repeat exact candidate/source comparison, operational logical hashes, settings/catalog health, tree/library loading and combined readiness. Graph probes with external effects belong in the isolated rehearsal.
8. On startup/validation failure, Return to legacy while paused (or recover offline below). Restart, validate legacy, then explicitly resume/restart.
9. Only after successful validation and review, acknowledge the rollback boundary and Resume writes. Restart before admitting work. Confirm ordinary saving/publication/execution, recording search/replay, library changes and restart persistence. Retain original files through a documented recovery window; this feature never deletes them.

Backup certification is an operator attestation with a restored-source hash, not an automated backup service. Do not enter the live-source hash without actually restoring/checking a backup.

## Offline recovery when startup fails

Stop API **and** executor by stopping the entire combined container, not just its supervisor. Use the same mounts/environment:

```sh
docker compose <your normal Compose arguments> run --rm --no-deps \
  --entrypoint node api \
  /app/packages/studio-server-api/dist/studio-server-api/src/scripts/recover-local-metadata.js --status

docker compose <your normal Compose arguments> run --rm --no-deps \
  --entrypoint node api \
  /app/packages/studio-server-api/dist/studio-server-api/src/scripts/recover-local-metadata.js \
  <reported-revision> <reported-generation-id>
```

Recovery verifies ownership, journal/schema/integrity, expected revision/generation, four source roots and retained fingerprint. It does not open the candidate settings database, need its key, delete files or resume writes. Restart into legacy-validation, validate in the UI and explicitly resume/restart. Recovery refuses after SQLite resumption. A damaged journal or altered source requires coordinated backup recovery, not bypasses.

## Implementation invariants

- `LocalMetadataTransitionJournal` uses CAS revisions and strict SQLite identity/schema checks. `LocalUpgradeOperatorStore` holds jobs/bound certificates separately from candidates, without encryption keys.
- A supervisor-owned SQLite lease excludes competing supported containers/offline recovery. Use a supported persistent local filesystem, not a network share.
- Selected Settings use existing domain/repository migrations with encrypted CAS rows. Missing domains/databases fail closed, without JSON/default fallback.
- SQLite cache-change notifications dispatch after commit without awaiting the writing repository's queued refresh. Awaiting it would deadlock the update against its own operation queue. The writer immediately remembers its committed record; health checks await outstanding notifications and retry failed invalidations without undoing the committed write. A repository-level regression covers serialized updates and concurrent same-domain repository owners.
- Shutdown keeps the selected App Settings backend installed until its pending notification refreshes have drained and the database has closed. Clearing it earlier would direct those refreshes to retained legacy JSON. Disposal also waits for initialization before removing its subscription. A regression deliberately delays a post-commit listener through shutdown and proves the SQLite value remains authoritative and the old JSON is unchanged.
- Immutable artifact durability precedes catalog commit: SHA-256 addressing, fsync, no-replace publication, checksum readback, then SQL references. Crashes can leave orphans, not deliberately committed missing payloads.
- Exact verification covers IDs/paths/empty folders, drafts/datasets, retained versions, routes/access, web-app IDs/policies, recordings/replay, registered settings and active package archives. Corruption, duplicates, unexpected rows and escaping paths block certification.
- Recording execution identities compare every defined field exactly. Legacy readers produce optional `undefined` fields that JSON rows omit; those two representations are equivalent. Defined changes are still mismatches, and all recording payload bytes are still checked.
- Native SQLite snapshots include WAL-visible data and verify logical schema/rows, integrity, foreign keys, blobs and 64-bit integers. Missing operational domains get certified empty candidate schemas; serving cannot silently recreate a deleted selected database or its authoritative tables. Read-triggered Evaluation retention stays disabled during paused validation.
- API/editor NativeApi reads and project references use the selected catalog, including after saves/moves. The executor bridge requires loopback plus both service tokens, confines reads to workflow paths and denies browser proxy authentication alone. Errors never fall back to old files; raw file writes inside catalog paths are rejected.
- Runtime activation commits the archive/manifest in SQL before rebuilding disposable `node_modules`. Startup repairs from SQL. Executor startup gets generation/cache/proxy configuration over the authenticated loopback API. Failed proxy refresh retains its last valid state.
- Selected runtime caches use unique physical release directories behind a confined `current` link. API/editor require anchors resolve that link natively before module resolution, avoiding stale Node package `main`/`exports` caches as well as stale loaded modules. Live promotion retains earlier physical paths for in-flight lazy dependencies; supervised startup prunes inactive owned caches before admitting executions. Allow update/extraction overhead in disk sizing. Retained legacy source libraries are unchanged.
- Once the selected cache has a POSIX activation link, promotion replaces it atomically rather than removing it before installing the new one. Concurrent executor reads cannot observe a missing `current`; injected permission failure leaves the prior link and release intact. Non-directory/non-link activation entries are refused. Directory/junction compatibility swaps remain for startup and Windows tests.
- A missing extracted runtime-cache directory is recreated from the selected SQL archive; it is not part of the authority proof. An existing symlink or non-directory at that cache path still blocks startup. The runtime rehearsal removes the cache before coordinated startup and verifies package loading after reconstruction.
- SQL recording retention respects health holds, stays paused during conversion/validation and runs only for writable live generations. Unreferenced immutable files are retained: audited artifact GC is a separate feature.

## Limits and release evidence

### Current production snapshot preparation

The operator inventory on 2026-09-28 still uses a split `ops-api-1`/`ops-executor-1` deployment. The API owns `/home/vpopov/workflows`, `/home/vpopov/workflow-recordings`, `/home/vpopov/runtime-libraries` and the persistent `ops_rivet_data` volume. The old executor also writes the same runtime-library and App Settings volume. Stopping only the API does **not** make a consistent backup: stop both processes in an approved maintenance window and check for other writers. Never copy a live SQLite database without a coordinated database snapshot or stopped writers; include its side files.

`node deploy/studio-server/scripts/local-upgrade-snapshot-plan.mjs --api ops-api-1 --executor ops-executor-1` is read-only discovery for this older layout. Omit `--executor` only for the supported combined backend. It validates persistent, non-overlapping mounts and shared API/executor authorities, then returns resolved roots, writer image IDs and known writer state. It never prints `Config.Env`, performs backup, stops containers or certifies unobserved writers. `knownWritersStopped` is a necessary check, not independent backup certification. Preserve deployment configuration, TLS and encryption secrets separately in protected backup storage, without posting them to reports/chat.

Reported sizes are workflows 228 MiB, recordings 4.6 GiB, runtime libraries 23 MiB and app data 349 MiB, on a 3.8 GiB/no-swap host with 30 GiB free disk. Conversion now uses bounded bundles instead of an installation-wide payload allocation, but those idle-host figures do not qualify this production dataset. Keep production on legacy mode until an independent restored snapshot passes the documented resource and recovery checks; do not raise limits to force oversized bundles through. Same-host backup storage can be a temporary staging location, but an off-host copy is required for disk-loss recovery and a separate isolated rehearsal host is preferable to competing with production for this RAM.

### Rehearsal provenance and safety

The synthetic runner resolves image references once and supplies immutable image IDs to every Compose operation. It records registry digests and source revisions where available; mismatched or mixed labelled/unlabelled revisions fail before startup. Rendered Compose is validated before creation, controls and cleanup: only generated non-external project-prefixed volumes/networks, the owned read-only registry script bind, and a loopback gateway are allowed. Existing same-name volumes/networks are refused, and rejection must never reach `down -v`. This runner is not a clone tool for production paths.

The ownership guard also rejects Compose configs/secrets, implicit Docker API socket mounts and lifecycle hooks; inspecting only the ordinary volume list would miss these routes around fixture isolation. Post-write restoration checks that all five new destination volume names are unused before changing the fixture model. A successful qualification receipt is published only after owned-container/volume cleanup succeeds; failed cleanup is a failed gate, not a PASS with a warning.

Phase evidence uses one shared schema for both recording and final acceptance: unique known phase names, `passed` status and canonical timestamps are required; complete acceptance requires every phase. A file with all the right names but failed/not-run statuses cannot qualify. Evidence paths and their ancestors must be real files/directories rather than symlinks/junctions, including when a new evidence file is absent. Generated credential manifests are removed even if container cleanup fails its safety recheck. A refusal before fresh-resource checks pass must not run diagnostics against pre-existing containers either. Read-only snapshot discovery normalizes source paths before rejecting the host filesystem root and requires exactly one persistent executor mount per shared authority.

The internal test-only npm registry serves deterministic package tarballs on the isolated network. API/executor public egress is tested as blocked. Browser assertions emit per-phase receipts; the result cannot claim a required phase passed unless its assertions completed. The expanded test covers editor/API saves, dataset persistence, stale writes, project rename/move, draft versus published behavior, publication history, masked settings updates, real library-job failure preservation, recordings and recreation/cache reconstruction. The earlier ten-phase baseline passed on 2026-09-28; the current acceptance contract requires fourteen phases, adding web-app allow/deny and policy changes, operational-domain writes, Node editor package replacement/removal and post-resumption coordinated backup/restore into fresh volumes. Expanded testing exposed stale CommonJS package reuse in Rivet-capable editor execution; the require helper now invalidates the configured release's nested modules on atomic replacement, for both parent and direct `node_modules` anchors. Do not treat the older baseline as evidence that these additional assertions passed. Local image reports have no release revision labels and leave `sourceCommit` null; exact-commit hosted CI, native Linux-host orchestration, constrained-resource qualification and actual production-data clone execution remain separate requirements.

Inspection runs capacity checks before decoding projects or publication history. If capacity is refused, it returns `inventory: null` with the measurements and blocking reasons; no fabricated counts are shown. Copy repeats the capacity check server-side. The runtime regression uses oversized invalid project bytes to prove that inspection refuses them before the aggregate parser can run.

Capacity traversal stops when an individual artifact or decoded recording bundle exceeds its budget, before reading subsequent payloads. Its partial measurement is explicitly incomplete and cannot approve conversion. A regression uses an oversized invalid gzip file to prove a refusal is returned without trying to decode it. Aggregate installation bytes remain relevant to disk sizing, not this per-bundle memory refusal.

The local converter and exact serving verifier consume one project/history or recording bundle at a time. Preflight counts installation bytes for disk sizing but estimates memory from the per-bundle budget, not total installation size. Actual gzip output is measured in bounded chunks; legacy normalization no longer allocates an unbounded expanded payload. `RIVET_LOCAL_METADATA_MAX_BUNDLE_MIB` defaults to 32 MiB and accepts 1–128 MiB; the old aggregate `RIVET_LOCAL_METADATA_MAX_SOURCE_MIB` option is retired. A project including its history, settings import, or runtime archive exceeding the bundle budget is refused. Metadata/identity sets still scale with item count. Preflight stops on an oversized item and reports incomplete measurement as a lower bound, never approving it. Disk estimate remains four times payload plus twice operational bytes plus 32 MiB; extra working memory is eight times the bundle limit plus 64 MiB, checked against 75% of the smaller of available process memory and V8 heap. These are conservative estimates, not resource reservations or measured production limits. See the [executable backup/restore/rehearsal procedure](./local-metadata-backup-rehearsal.md) for supported limits, operator actions and evidence boundaries.

Catalog equality checks compare JSON-domain values directly, ignoring omitted optional `undefined` fields while preserving exact artifact strings and array order. They do not serialize whole project/recording payloads into additional JSON strings merely to compare them. Artifact checksum and size verification still run before returned bytes can be trusted.

The bounded-copy regression first bundles the current converter, serving verifier and JavaScript dependencies outside the measured process, then runs that worker with a 192 MiB old-space limit and an unchanged 512 MiB peak-RSS ceiling. Inherited `NODE_OPTIONS` loader hooks are cleared, and the report verifies the child arguments and absence of those hooks. Yarn PnP/tsx compiler, ZIP caches and loader threads are test infrastructure, not serving-runtime memory: including them previously consumed about 429 MiB before conversion started on Linux Node 24.21.0 and left a flaky margin. The fixture still converts and exactly verifies 192 distinct gzip recordings exceeding 192 MiB when expanded; neither the dataset nor memory ceiling was reduced. The worker records startup and per-stage RSS, heap and external-memory checkpoints for failures and emits its peak in the test diagnostic. This isolated algorithm check is not a whole-server or production-data capacity qualification.

The durable job records phase/recovery evidence, not a per-byte percentage. Transient install logs/caches are not permanent business records. Local artifact GC and post-resumption reverse export are not implemented.

The legacy VM-to-managed wizard is blocked when a local control root is enabled: it must not export stale retained files after this cutover. A later managed migration requires a selected-SQLite source adapter. Do not run both transition workflows concurrently.

Verification includes local backend/settings/artifact/snapshot, transition and offline recovery suites. `local-upgrade-runtime.test.ts` rehearses operator copy, process restarts, selected serving and corrupt-candidate/key-free rollback on disposable fixtures. It injects disk-full and permission errors, kills copying at durable stages and certification boundaries, and kills activation/resumption after commit. Recovery checks exact retry, retained legacy hashes, maintenance, rollback closure and restart fences. On Linux it also starts the real supervised API and executor, checks generation agreement and verifies the paused HTTP barrier. Playwright `local-storage-upgrade.spec.ts` checks backup gates, capacity refusal, safe failure reports, restart, validation/resumption and unauthorized sessions.

`yarn studio-server:verify:local-upgrade-images` is the real packaged UI/API rehearsal. Supply all three exact `RIVET_REHEARSAL_API_IMAGE`, `RIVET_REHEARSAL_WEB_IMAGE`, `RIVET_REHEARSAL_PROXY_IMAGE` references, or `IMAGE_NAMESPACE` plus an immutable `SOURCE_TAG`; there is no `latest` fallback. It creates a uniquely named disposable Compose project and Linux volumes, exposes only its gateway on loopback, blocks API/executor egress, provisions independent control storage, and invokes headless `local-storage-upgrade-live.spec.ts` without API mocks. It exercises copy, paused activation, whole-backend restart, online return to legacy, corrupted selected startup/key-free offline recovery, and final SQLite resumption/serving. Only owned disposable volumes are removed. Non-secret results/container diagnostics and browser artifacts are retained under `artifacts/local-upgrade/` and `artifacts/playwright/`; generated fixture credentials are removed. Image CI runs it against the candidate image tag before promotion.

Image CI installs Chromium and its Linux dependencies explicitly before running the browser gate. The gate also invokes the packaged read-only capacity command before starting conversion. The UI regression suite separately keeps the editor permanently unready and checks that Settings recovery controls remain accessible without forced clicks.

### Latest local verification

The fourteen-phase packaged rehearsal passed at 2026-09-28 15:51 UTC with fixture `e9a753f7-1137-4935-9f3e-a27c75ac4525` and API image `sha256:e7887070343b3e31e62780052f941750369efa947e5241239c33c08f7e2d0a8b`. Its receipt is `artifacts/local-upgrade/rivet-local-upgrade-rehearsal-e9a753f7-1137-4935-9f3e-a27c75ac4525-T9SZJ3/result.json`. It covers online/key-free offline recovery, conversion, saves/conflicts, publication/history, settings, API/editor package replacement/removal, web-app access, operational data, recordings, restart/reference integrity, retained-source proof and post-resumption backup restoration into fresh volumes. Cleanup completed before the PASS receipt. Earlier local receipts are development history, not evidence for this image.

All 57 focused packaged Linux artifact/runtime/settings/operational tests and 54 Linux backup/snapshot/isolation tests passed. Windows backup tests passed 53 with one platform-specific skip. The cache regression checks one-step POSIX link replacement and injected promotion failure; the backup regression rejects integrity-valid databases with missing/extra tables or incomplete columns. API type-check, repository policy, targeted formatting and diff checks passed. Run artifact-rebuilding repository checks separately from local process tests that consume those build outputs; isolated Linux image tests do not share the host build directory.

The receipt has `sourceCommit: null`: this is working-tree evidence, not exact-commit release qualification. Exact-commit CI and the native Linux-host orchestration gate are still required; the latter remains unexecuted locally.

These tests do not certify production data or its filesystem: the isolated real-data conversion, restart, failure/recovery and controlled functional rehearsal remains mandatory.
