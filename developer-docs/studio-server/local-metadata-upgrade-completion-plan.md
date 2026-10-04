# Local metadata upgrade: completion and production qualification plan

## Browser backup follow-up

The normal supervised Compose wizard now also owns initial preparation and necessary
backend restarts. The primary flow groups inspection/pause/backup, off-VM downloads
and exact copy, paused activation/automatic validation, and explicit final resumption.
Manual fingerprint entry remains an advanced alternative. Tests must cover private
setup, retained key/binding, lost-volume refusal, graceful restart timer cleanup,
API/executor readiness, stale/unauthorized restart requests and browser reconnect.
This does not turn offline disaster recovery, independent actual-data rehearsal or
post-resumption restore qualification into automatic browser operations.

The paused legacy wizard now creates/downloads an archive and verifies its actual isolated scratch restore in the API. Archive evidence is bound to the current pause/revision/source and rehashed before copy; completed off-VM download and separate key protection still require explicit operator confirmation. Authenticated read-only project/tree/history downloads remain available during maintenance without writing stats caches. Unit, authenticated process/API and Playwright coverage belong to this follow-up; they do not replace native-host, independent actual-data recovery or release qualification below. See [archive ownership and format](./local-metadata-backup-rehearsal.md#browser-backup-before-activation).

Follow-up verified locally on 2026-10-04: Windows/Linux archive and barrier regressions, archive and authenticated backup/copy flow under production UID/GID 10001:10001, interrupted/stale/corrupt evidence refusal, headless operator browser checks, API typecheck, test-style/shard/repository contracts and the live dependency audit. Read-only scratch cleanup and separate per-phase test deadlines are covered. This is local evidence, not a passing GitHub candidate-image run or approval to convert production data.

Status: repository implementation has passed fresh local review and verification on 2026-09-29, and the full fourteen-phase packaged fixture passed on 2026-09-28; exact-commit release gates and production qualification remain pending. The exact-image fixture guard, offline registry, per-phase assertion evidence and read-only snapshot discovery are implemented. Local conversion/verification process bounded bundles incrementally. Backup/restore tooling covers both legacy roots and post-resumption SQLite generation/control state in the [operator procedure](./local-metadata-backup-rehearsal.md). The real browser/API test passed web-app policy, operational writes, Node editor package execution/removal and post-write restore into fresh volumes, with cleanup completed before the PASS receipt. A direct Linux-host orchestration gate is wired into candidate-image CI but has not run successfully on this Windows/Docker Desktop host. The intended commit must pass that native gate and the other release gates. The actual production backup, off-VM verification and real-data/resource rehearsal still require operator execution. Do not use fixture success as production approval.

## Scope and completion levels

### Current completion ledger (2026-09-29)

| Gate                                                                                  | Implementation/evidence                                                                                                                                          | Remaining action                                                                                       |
| ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Post-conversion web-app policy, operational writes and editor/runtime-library removal | Implemented; all fourteen packaged browser/API/recovery phases passed                                                                                            | Re-run for the committed candidate images in CI                                                        |
| Post-resumption coordinated backup and independent restore                            | Implemented; packaged gate restored five fresh volumes and verified new writes                                                                                   | Repeat on the actual VM-data clone with independently preserved keys                                   |
| Direct Linux-host restored-copy orchestration                                         | Implemented and required by candidate-image CI; result validator requires every recovery phase, matching backup/image/limits, final fence and successful cleanup | Run on native Linux; Windows component tests are not a substitute                                      |
| Actual production snapshot, independent backup and capacity qualification             | Safe discovery/backup/restore/isolated-run tooling implemented                                                                                                   | Operator must supply the frozen backup, independently verify it off-VM and run the real-data rehearsal |
| Reviewed commit and release qualification                                             | Working-tree review and local checks are recorded below; hosted release qualification is not yet established                                                     | Pass required CI for the exact committed candidate and deployment digests                              |
| Live production activation                                                            | Not performed or approved                                                                                                                                        | Only after the preceding evidence and a separately approved maintenance window                         |

The first two code/coverage gaps from the earlier checklist are closed. The remaining native-host, actual-data and release gates are execution evidence, not permission to claim production readiness from another synthetic fixture.

### Operator development-data rehearsal (2026-09-29)

The operator converted their Windows/Docker Desktop development dataset, tested paused return to legacy, converted again, resumed SQLite writes and confirmed saves, publishing and a new recording survived a backend restart. After stopping the combined backend, all five persistent roots were archived and restored into a separate Docker volume. A disposable working copy, never the live roots or independent restored copy, started with a read-only container root, no network or published ports, 1 GiB memory and one CPU.

Authenticated API reads verified the `000/000.rivet-project` test project, its published bytes and version, and its retained recording/replay. Catalog and encrypted-settings logical contents matched the restored baseline before execution; settings loaded with the existing key. A controlled `000` endpoint execution created another readable recording, and the selected backend, project/publication bytes, unchanged settings and both recordings survived a whole-backend restart. The archive checksum remained unchanged. The disposable clone was stopped and retained; the operator restarted their original stack into `sqlite-live`.

This is development-data evidence, not production qualification, a native-host runner PASS, or an independently restored encryption-key test: the clone used the existing key privately. Three setgid app-data directory modes were normalized only in the disposable working copy; the archive and independent restored copy retained their original bytes and permissions. The generic backup helper still refuses unreviewed set-ID modes. No production dataset, external integration, exact released image set or off-VM backup was certified.

Commit review also corrected the nginx-free restored runner's login path and service-authentication headers, with real loopback HTTP and fail-closed regressions. Dev Compose now passes the same supported per-bundle memory setting as production; it no longer passes the retired aggregate source-limit variable. These fixes require a fresh native Linux-host gate in candidate-image CI.

### Fresh pre-commit verification (2026-09-29)

- The complete 106-file default API suite passed on Windows: 1,126 passed, three skipped and zero failures. It includes conversion, crash/interruption, selected runtime, recovery, settings encryption and serving-backend regressions. Style and generated dependency preparation finished before the suite ran; Core, Node and Evaluations were not rebuilt while tests consumed their generated files.
- All 46 headless browser checks in `local-storage-upgrade.spec.ts`, `local-storage-upgrade-origin.spec.ts` and `vm-migration.spec.ts` passed against the development stack. These exercise UI progress, layout, session expiry, stale requests, backup acknowledgements, validation/resumption and the real origin boundary; mocked mutation tests do not certify a production conversion. An earlier run encountered a temporary nginx 500 while an API source-comment edit triggered development hot reload; the complete stable rerun supersedes it.
- Web pure tests passed 104 cases, app-executor tests passed 45 and Studio Server executor tests passed three. Production-cutover contracts passed 103 cases with three POSIX-only skips. The new restored-runner login tests include a real authenticated loopback HTTP exchange and fail-closed missing-key/unsigned-login cases.
- Shared, API, web and Studio Server executor production builds passed, along with API type checking. Repository `test:style`, migration ledger, repository structure, CI policy and documentation-link checks passed. The staged set contains source, tests, configuration and documentation only; no data, archives or credentials are included.
- Real Docker nginx routing/DNS tests passed for development, Compose and image configurations, and the VM TLS fixture passed. The disposable PostgreSQL/S3-compatible migration integration passed copy, idempotent retry and exact verification, including rejection of occupied or mismatched targets. This tests the legacy-file managed importer, not the future selected-SQLite importer.

These are local working-tree checks, not qualification of exact released image digests. Native Linux restored-copy orchestration, required hosted CI and rehearsal of an independently backed-up production dataset remain required before a live upgrade.

### Upgrade reminder and recovery review (2026-09-30)

The dashboard now distinguishes first-time VM setup, a postponed legacy upgrade, an in-progress paused transition and a completed SQLite runtime. The setup response is operator-authenticated but works before the upgrade flag is enabled; it returns readiness booleans only. A paused SQLite selection with disabled controls directs the operator to restore the original key and control volume, never to provision a new one. The reminder opens the existing upgrade tab and does not bypass backup, maintenance, verification or write-resumption gates. The panel hides rollback actions after SQLite has accepted writes. See the [upgrade contract](./local-metadata-upgrade.md) for phase-specific behavior.

The setup endpoint, dashboard prompt and panel have focused API and headless browser coverage. This review is repository evidence only: it does not certify the production VM dataset, the exact released images or the future SQLite-to-managed PostgreSQL/S3 adapter.

### Bounded-memory CI hardening (2026-09-29)

CI reported a 570,812 KiB peak in the source/tsx worker, exceeding its 512 MiB total-RSS ceiling despite successful conversion. Exact Node 24.21.0 with Yarn PnP locally measured 439,440 KiB at worker startup, before creating any recordings, and 520,240 KiB peak across the original fixture. Loader/compiler/ZIP-cache overhead left an unstable margin rather than measuring the converter in its serving-runtime environment.

The regression now compiles its unchanged synthetic workload and current runtime dependencies before starting a loader-free measured process. Its 192 MiB old-space budget and 512 MiB total-RSS ceiling remain unchanged. Three independent Linux Node 24.21.0/Yarn PnP runs passed at 250,936, 253,692 and 252,332 KiB peak (about 245–248 MiB); the Windows run passed at 199,152 KiB. Catalog verification also avoids full-payload JSON reserialization, with a regression proving optional metadata equivalence and changed-byte rejection. This is local regression evidence; the corrected exact-commit CI and production qualification gates remain required.

All 73 affected Linux catalog, candidate, serving, source-budget, artifact and capacity checks passed; the overlapping Windows focused runs passed all 74 unique cases, including the memory worker. Four headless upgrade/recovery UI checks passed. API type checking, test-style, PnP install-state and documentation-link checks passed. The memory report counts the actual UTF-8 recording bytes created by the fixture, not an assumed aggregate size.

Additional local verification on 2026-09-28:

- The complete 106-file default API suite ran in an isolated Linux container with immutable dependencies and current source mounted read-only: 1,122 passed, four skipped (two Windows-only cases and two optional benchmark-fixture checks), and one timestamp fixture failed. That fixture assumed an immediate ctime change within one filesystem clock tick. It now uses a bounded observed-change wait and proves size/mtime are unchanged. All three corrected test files then passed 95 Linux cases; the complete filesystem-tree file passed all 49 Windows cases. The timestamp regression also passed twenty independent Linux process runs. This is a full-suite run plus targeted post-fix evidence, not a claimed all-green single full-suite rerun.
- All 65 Linux backup/restore/isolation/receipt/interruption tests passed; Windows passed 62 with three POSIX-only skips. Restored authority/output paths now share the backup helper's physical directory-alias checks. Real stalled loopback servers prove bounded login/readiness requests; subprocess regressions prove drained output and fail-closed command deadlines, including Linux force-stop escalation. Directory alias tests use a filesystem identity seam, and SIGINT/SIGTERM cleanup tests use a deterministic Docker seam; neither replaces the native-host orchestration gate.
- Web pure tests passed 104 cases; app-executor tests passed 45. Production-cutover contracts passed 101 cases with three POSIX-only skips on Windows, followed by three Studio Server executor tests.
- A fresh packaged headless rehearsal passed all fourteen phases after the latest path/probe/command hardening at `2026-09-28T17:51:15.707Z`, including post-write coordinated backup/restore. Its private receipt is `artifacts/local-upgrade/rivet-local-upgrade-rehearsal-70b53b3e-b170-4a89-ac33-f0d3a3ef075f-mESTv8/result.json`. Its uniquely owned containers and volumes were removed, and the generated secret-bearing manifest was deleted. It records immutable local image IDs but has no commit label: this remains working-tree synthetic evidence, not exact-commit release qualification.
- API type checks, executor/web builds, pending-file formatting, test-style, migration ledger, repository/CI policy and documentation-link checks passed. Two broader-suite test gaps were corrected: the Compose initializer contract now covers the fifth persistent control root, and the filesystem coordinator test uses a temporary root and releases pending operations even on failure. Both corrected test files passed all 46 cases on Windows.

An initial host-source API run was invalidated by running the style guard concurrently: it rebuilt Core's generated runtime files while tests consumed them. That run is not passing evidence. Finish builds/style preparation before source tests; use an immutable dependency image for isolated Linux verification. The strengthened restored runner handles graceful interruption with independent ownership-checked cleanup. None of these checks replaces the still-unrun native-host gate, committed-image CI or actual-data qualification.

Finish and qualify the existing supervised single-host files-to-SQLite upgrade. Keep artifact bytes as local files; move only the metadata domains defined in [the ownership contract](./local-metadata-upgrade.md). This does not change the Storage tab to S3/PostgreSQL or redesign Kubernetes.

The conversion service, maintenance fence, encrypted settings backend, selected serving, restart coordination, exact verifier, UI and pre-resumption recovery already exist. Build on those owners rather than creating a second conversion engine.

Use two distinct completion levels:

1. **Repository/rehearsal ready:** extended packaged tests, capacity and restore tooling, documentation and exact candidate-image CI are passing. A production-data clone can be rehearsed safely.
2. **Production qualified:** an isolated restored copy of the actual VM data passes conversion, recovery and post-conversion writes using the intended image set, resource limits and filesystem. An operator approves the live maintenance window and backup/recovery procedure.

An automated fixture result is never production-data certification. No stage below silently commits, pushes, deploys, freezes production or resumes its writes; each external operational action needs explicit authorization.

Post-resumption reverse export, artifact garbage collection and the later selected-SQLite-to-S3/PostgreSQL adapter remain separate features. Their absence must remain visible in the runbook; none is a prerequisite for a supported local upgrade with a verified backup.

## 1. Close the packaged post-conversion write coverage gap

Owners: `local-upgrade-image-rehearsal.mjs`, `local-storage-upgrade-live.spec.ts`, existing SQLite serving/settings/library APIs and their tests.

Extend the existing disposable production-image rehearsal after final SQLite resumption. Use normal authenticated UI/API paths, not direct SQL edits or mocked successful API responses.

### Required sequence

1. Save an existing project through the hosted editor save path, including a dataset change. Confirm the current draft revision changes and a stale save is rejected without changing it again.
2. Rename/move that project and create an empty folder. Check stable project identity, tree paths and published-route behavior. Refresh publication preconditions before every deliberate change.
3. Execute latest and published versions before republishing: latest must use the new draft, while published still uses the prior published snapshot.
4. Publish the changed draft to the existing endpoint, check the new result, retained history and access rules, and restore an older retained version. Prove the intended version is served, rather than checking only HTTP 200.
5. Update an existing web-app binding and its access policy. Confirm stable binding identity, expected allowed/denied behavior and persisted route changes. Use deterministic local authentication fixtures, never a production OAuth account.
6. Change a private App Settings environment variable using the normal masked-secret update contract. Execute a controlled workflow that reads it. Confirm browser-facing settings responses still redact the value and the changed setting survives restart.
7. Install/update/remove a small deterministic runtime package through the real library job path. Serve its metadata/tarballs from a test-only registry on the isolated network; do not require public npm or substitute a direct catalog activation. Execute a controlled graph with the package through API and editor/executor paths. A failed installation must retain the last usable release.
8. Run a controlled workflow with recording enabled. Wait for recording persistence, search its input, replay it and distinguish the new run from the retained pre-conversion recording. Verify stable historical run identities after a project move.
9. Verify Evaluation and profile-health state survived conversion. Exercise a deterministic local write to each operational domain through its owning service/API, without live LLM/provider side effects, and verify it persists in the selected operational databases.
10. Restart the entire combined backend. Repeat the significant reads and controlled executions. Also recreate the API container against the same mounts to distinguish persistent storage from a surviving writable container layer.
11. With the backend stopped, remove only the disposable selected runtime cache in the owned fixture, restart, and prove library reconstruction and execution from the SQL archive.
12. Compare the retained authoritative legacy source fingerprint with the independent frozen backup. Check selected database integrity, foreign keys and referenced artifact hashes after the new writes.

Use condition-based waits and bounded timeouts. Record which assertions ran; an untested domain is `not-run`, not an implied pass.

**Acceptance gate:** all new writes survive restart/recreation, old source authorities remain unchanged, every referenced artifact is readable and correct, and publication/access/library behavior has the expected observable result. Keep the existing online/offline recovery scenarios passing.

## 2. Strengthen rehearsal provenance and fixture safety

Owners: the image rehearsal runner, release manifest integration and `.github/workflows/studio-server-images.yml`.

- Resolve and pin the API/web/proxy image set before starting. Record image IDs and registry digests where available, source commit and candidate release identity. Local image tags alone are not durable release evidence.
- Render Compose before creating the fixture. Verify every volume/network is fixture-owned, project-prefixed and non-external, and no source bind points at the dev stack or a production mount. Refuse unsafe overrides.
- Keep a fresh project ID, loopback-only gateway and blocked API/executor egress. Allow the package registry/provider fixtures only on the internal test network. Test that outside destinations remain inaccessible.
- Add runner tests for an external/fixed-name volume, a foreign bind mount, mismatched image selection and unsafe cleanup. Cleanup may delete only newly created owned synthetic fixtures, never restored user data or backups.
- Preserve a redacted per-phase report: image identity, phase results, counts, source/candidate proof references, elapsed time, capacity measurements and failure category. Do not publish raw production settings, recording inputs, environment values or unrestricted logs.
- Ensure required rehearsal failures prevent image promotion. Test the failure dependency as well as the successful path. Retain diagnostic artifacts on failure without retaining generated credentials.

**Acceptance gate:** a PASS report identifies the exact tested image set and assertions, failed/skipped required phases cannot pass promotion, and a malicious or accidental fixture configuration cannot delete unrelated data.

## 3. Resolve capacity against the actual source size

The operator's 2026-09-28 inventory changes the priority of this work. The VM has 3.8 GiB RAM (2.5 GiB available at measurement), no swap, and 30 GiB free ext4 storage. `du` reported workflows 228 MiB, recordings 4.6 GiB, runtime libraries 23 MiB, and app data 349 MiB. These allocated sizes are not an exact logical payload measurement, but they rule out assuming that the default 128 MiB aggregate importer is suitable. Expanded recordings can require more space than their compressed disk usage. Do not raise the budget, delete recordings, omit history or attempt live activation as a workaround. Bounded-memory source adapters, staging and verification are a prerequisite for qualifying this installation; an isolated restored snapshot is needed to measure the exact envelope.

Owners: `copy-capacity.ts`, source readers, candidate staging, immutable artifact storage, the exact verifier and operator reporting.

1. Run the packaged read-only capacity command on an isolated restored snapshot with the intended VM resource constraints. Include retained publication history, expanded recording data, runtime packages and operational SQLite side files.
2. Measure peak process/container memory, disk growth and elapsed time during the complete conversion and verification. Include runtime package extraction and the largest normal validation/write operation. The current estimates are refusal safeguards, not measured guarantees.
3. Keep incomplete measurements, unsupported data and insufficient disk/RAM as hard refusals. The obsolete aggregate budget is now replaced by the 32 MiB per-bundle limit; do not raise it solely to force an oversized source bundle through.
4. If the actual source fits with measured headroom, record the supported limits and continue. If not, finish bounded-memory conversion before qualifying that installation:
   - enumerate projects/revisions/recordings incrementally;
   - stream gzip payloads and immutable-file hashing/copying;
   - page catalog comparisons rather than materializing complete item sets;
   - retain exact ID/metadata/content comparison and durable retry checks;
   - bound unavoidable single-document decoding separately;
   - repeat maintenance/source-drift checks between units;
   - never treat streaming or memory pressure as permission to skip a record.
5. Test many small objects, large retained histories, expanded gzip payloads, a single oversized document, disk-full, source drift and restart/retry under constrained memory.

**Acceptance gate:** the actual installation is within an explicitly tested capacity envelope, or a completed streaming implementation proves bounded memory without weakening verification. Otherwise live activation remains blocked.

## 4. Make backup, clone preparation and restore procedures executable

Owners: a separate operator preparation/rehearsal helper plus the existing capacity, fingerprint and offline recovery commands. Do not overload the synthetic fixture runner with permission to consume production paths.

### Backup procedure

- Discover the four resolved source mounts, current image set, Compose inputs and persistent control storage. Produce a redacted manifest rather than printing the complete environment or Compose secrets.
- Obtain one consistent snapshot: use the supported maintenance/drain path when available; otherwise schedule stopping the entire combined backend and other writers before copying. A live uncoordinated directory copy is not a certified backup.
- Back up all four source roots and SQLite journal/side files. Once control storage exists, preserve its journal/certificates as part of recovery. After SQLite resumption, coordinated backups must include the selected generation databases/artifacts and control volume, not just the retained legacy roots.
- Preserve permissions, executable modes and supported internal package symlinks. Save deployment configuration, TLS material, relevant plugin/file dependencies and encryption keys separately in protected storage; they are not converted business artifacts.
- Restore into independent storage and fingerprint the restored roots twice using the packaged command. Compare with the frozen source. Backups must be recoverable independently of the VM disk.
- Keep the production source intact and resume legacy service only through the documented maintenance completion path. Never clear a marker manually or use `down -v`.

### Isolated clone helper

- Accept explicit restored roots, exact images, fresh clone control/output roots and resource limits. Default to validation/plan-only; require an explicit run action for container creation or clone mutations.
- Mount only restored copies writable. Keep the original backup untouched. Preserve the four container source paths across clone restarts so certificate identity remains stable.
- Refuse overlapping roots, symlink escapes, unowned control/output paths, existing production/dev projects, external volumes and public port bindings.
- Use loopback UI access and network isolation before starting the API/executor. Do not contact production providers, scheduled jobs, databases or callback destinations merely because their settings were restored.
- Stop and retain restored-clone data on failure. Do not auto-delete operator-supplied volumes, backups or restoration directories.
- Allow a selected list of safe workflow probes with controlled inputs/local provider fixtures. Mark external-dependent workflows as not exercised rather than claiming equivalence for them.

Document that backup creation remains an operator-controlled operation. The UI attestation/fingerprint check is not evidence that the app created an independent backup.

**Acceptance gate:** helper misuse tests reject unsafe mounts/cleanup, a restored independent snapshot matches the frozen source, and an operator can recover without relying on the running API or the candidate encryption key for pre-resumption legacy return.

## 5. Review, document, commit and pass candidate release gates

- Review the complete pending diff, including untracked files and related migration changes. Remove accidental/generated artifacts, test-only credentials and unrelated changes; preserve user-owned work.
- Update developer and user documentation with exact preparation, capacity, isolation, UI operations, restart, offline recovery and both backup formats. Keep failed/untested evidence visibly separate from PASS results.
- Run backend/settings/catalog/artifact/operational tests, deterministic crash/recovery tests, supervisor/ownership tests, type checks, policy/format checks, headless UI tests and the extended packaged-image gate. Do not rebuild shared generated runtime outputs concurrently with tests that consume them.
- Review the staged snapshot before committing. Push/build only when authorized. The candidate image CI must run the packaged tests for that exact commit; earlier local success is not evidence for a different image.
- Use the same CI-tested candidate digests for actual-data qualification and eventual deployment. If code changes after qualification, rerun the relevant suite and qualification checks before proceeding.

**Acceptance gate:** a reviewed commit, passing required CI, exact tested image identities and an up-to-date runbook agree. This permits actual-data qualification, not production activation.

## 6. Qualify the actual production-data clone

This is operational evidence, not something a repository patch can fabricate. Access to a protected restored snapshot and VM/filesystem/resource details is required. Use the exact candidate digests that passed step 5.

1. Start the restored clone in legacy mode with conversion disabled. Compare baseline tree, IDs, empty folders, drafts/datasets, retained publications, endpoint routes/access, web-app bindings, recording search/replay, settings and active libraries.
2. Enable/provision the separate clone control root, inspect capacity, pause/drain, restore an independent clone backup and certify its fingerprint.
3. Copy and verify. Require exact authoritative item sets, metadata, artifact hashes and operational database integrity. Any warning that can change behavior requires explicit disposition before continuing.
4. Activate while paused; restart/recreate; validate the selected runtime without opening writes. Test an unauthorized operator, stale action and rejected ordinary write while paused.
5. Return to legacy through the UI; restart; validate and resume legacy. Prove baseline equivalence and unchanged retained content.
6. Repeat from a fresh restored clone. Damage only its candidate settings database or omit its candidate key. Prove startup fails and the packaged offline recovery command returns to paused legacy; restart/validate/resume successfully.
7. On another fresh attempt, test interrupted copy/retry and unavailable disk space. Partial candidates must never become selected and the source must remain recoverable. Existing synthetic crash tests remain required; do not simulate hazardous host-wide failures.
8. Convert again, validate, then explicitly resume SQLite writes. Run the post-conversion scenarios from section 1 against safe selected projects. Exercise both API endpoint and editor/executor paths and restart/recreate.
9. Take a coordinated backup of this now-upgraded clone after new writes. Restore it into a second isolated instance and prove those new writes survive. Confirm simple return to legacy is refused after resumption.
10. Produce a redacted qualification report with snapshot/image identity, resource high-water, exact comparison results, functional probes, untested dependencies, recovery evidence and duration. Fix discrepancies and repeat affected gates; do not approve an unresolved mismatch.

**Acceptance gate:** both pre-resumption recovery paths and post-resumption backup restore are demonstrated on actual data, all authoritative data matches, controlled writes persist, and every untested external dependency has an explicit operator disposition.

## 7. Production execution and final definition of done

Production changes require a separately approved maintenance window.

1. Deploy the qualified image/Compose version with upgrade disabled and confirm legacy serving. Verify source paths, permissions, owner lease, available resources and the preserved recovery image/configuration.
2. Provision control storage/key securely. Freeze/drain and take a new independently verified production backup. Earlier clone evidence does not certify files changed since that snapshot.
3. Copy/verify, activate while paused, restart and validate. If any requirement fails, stay paused and recover to legacy using the tested UI/CLI procedure. Do not resume SQLite writes to investigate a failed validation.
4. Review comparison results and recovery evidence. Only then acknowledge and resume writes, restart, and run the approved controlled production smoke checks.
5. Take a coordinated SQLite-generation-plus-artifacts/control backup. Monitor saves, publications, recording completion, library jobs, readiness, disk/RAM and integrity during an agreed observation window. Keep retained legacy sources and the pre-upgrade backup through the agreed recovery period; this plan does not add automatic deletion.

Before SQLite resumption, selecting intact retained legacy is the supported rollback. After resumption, do not switch to stale files or downgrade to an unaware image: recovery uses the tested coordinated backup procedure. This plan does not promise lossless reverse migration of post-resumption writes.

The local upgrade is **done for this production VM** only when qualification and live verification have passed, new writes persist across restart, the tested recovery backup exists, and the operator accepts the report. Future S3/PostgreSQL migration and long-term artifact cleanup stay explicitly outside this completion claim.
