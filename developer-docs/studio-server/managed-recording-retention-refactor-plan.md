# Managed recording retention extraction

Status: implemented and locally validated. Reviewed and implemented on
22 November 2026 against baseline
`b1662c284e5aaaec6ee552544748f896633e40c3` on `develop`.

## Purpose and expected result

Give managed recording retention one focused implementation module while
preserving its behavior. Before extraction, `managed/recordings.ts` contained the
retention policy and SQL callback alongside catalog reads, filtering, statistics,
replay loading, imports, explicit deletion and persistence.

After this change, a maintainer can inspect which recordings retention removes,
how protected evidence is excluded, and how deletion is queued without navigating
those unrelated operations. The existing recording service still composes and
registers the callback. Its callers and public methods remain unchanged.

This is one extraction, not a redesign of the recording subsystem. Total code
size should remain roughly similar; the benefit is clearer ownership and better
verification of the production SQL. A smaller parent file alone is not an
acceptance criterion.

## Verified baseline behavior

Paths in this section are relative to
`packages/studio-server-api/src/routes/workflows/`.

- Before extraction, `managed/recordings.ts` defined `selectManagedRecordingRowsForCleanup`, its
  policy helpers, suspension-evidence parsing, and the SQL cleanup callback.
- Production candidate selection is SQL. The exported JavaScript selector is
  used by tests as an independent policy reference; production does not load the
  recording history into JavaScript to select deletions.
- Each callback reads `options.getRecordingConfig?.() ??
getWorkflowRecordingConfig()` when that pass starts. All three nonpositive
  retention limits make the callback return before opening its transaction.
- Inside the transaction, the callback validates and locks its maintenance lease,
  reads protected LLM-profile suspension evidence, selects a bounded oldest-first
  batch, deletes those recording rows, queues their artifact keys and invalidates
  their input-cache entries.
  The batch limit bounds selected/deleted rows, not the window-function scans or
  health-evidence reads needed to select them.
- The selection applies age expiry first, per-project/normalized-endpoint counts
  second, and the stored-byte limit to the remaining recordings third. Protected
  recording IDs are excluded before ranking and byte accounting.
  Bytes mean the existing per-recording compressed trace/project/dataset columns;
  this is not a measurement of physical bucket size or unique shared snapshots.
- Cache invalidation currently occurs inside the transaction callback, before
  its commit acknowledgement. Preserve that placement. Database rollback does
  not promise to restore an evicted in-memory cache entry.
- `maintenanceTaskRegistered` and `recoveryReady` belong to the recording-service
  closure. Registration happens once. `initialize()` initializes the context,
  registers tasks, awaits `maintenance.runNow()`, then enables evidence recovery.
  This gate waits for the pass to settle, not for successful reconciliation:
  maintenance can log/swallow a task failure and still resolve `runNow()`.
  A subsequent direct service initialization still runs maintenance; it does not
  register a second task. Backend initialization has its own cached promise.
- `managed/backend.ts` avoids service startup maintenance in copy/verify/restore
  modes and during a paused legacy restore. Keep that decision there.
  A verify-mode context alone does not disable an explicit maintenance pass;
  `runNow()` can schedule later passes even without `maintenance.initialize()`.
- The maintenance owner handles leases, scheduling, failure logging and the
  deletion outbox. It sorts tasks by their existing names, independently of
  registration order, and disposal does not release its database lease row.
  Shared snapshot keys are filtered/protected by existing maintenance and
  snapshot-retention code; recording retention does not directly delete S3 data.

## Scope and ownership

| Area                                    | Change                                                                                                 |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `managed/recording-retention.ts`        | New module owning the existing retention callback, policy reference and retention-only helpers.        |
| `managed/recordings.ts`                 | Construct the callback, keep registration/startup/recovery state, and retain the compatibility export. |
| Existing recording tests                | Add missing behavior checks and retain meaningful existing assertions.                                 |
| Existing managed statistics integration | Invoke a focused retention contract using its disposable PostgreSQL database.                          |
| Import-boundary ledger                  | Relocate the existing retention-only health-state edge to its new owner.                               |
| Developer documentation                 | Document the implemented owner and verification results after completion.                              |

Persistence, browsing, search algorithms, statistics, evidence recovery, explicit
user deletion, artifact codecs, shared snapshots and physical deletion policies
retain their implementations. Do not change database schemas, routes, settings,
environment defaults, task names, release manifests or deployment behavior.
Production recompression and its temporary helper are outside this work.

## Intended module boundary

Create one runtime module:
`packages/studio-server-api/src/routes/workflows/managed/recording-retention.ts`.

Its entry point is:

```ts
export function createManagedRecordingRetentionTask(options: {
  context: ManagedWorkflowContext;
  getRecordingConfig?: () => WorkflowRecordingConfig;
}): ManagedWorkflowMaintenanceTask;
```

Reuse the existing context and maintenance-task types. Import types as types so
the extraction does not introduce a runtime dependency cycle. The factory only
creates the callback: it must not read settings, initialize storage, register a
task, create a pool/client, start a timer or perform I/O.
Do not eagerly dereference task-only state such as `maintenance.config`; those
accesses remain inside the pass. Existing browsing-only fixtures must not need
new maintenance setup merely to construct an unused retention callback.

Move together:

- The callback's existing SQL construction and transaction body, unchanged.
- `ManagedHealthEntryRow` and `getManagedLLMProfileHealthHeldRecordingIds`.
- `ManagedRecordingRetentionConfig`, `DAY_MS`, endpoint grouping, byte summing
  and timestamp helpers used exclusively by the policy reference.
- `selectManagedRecordingRowsForCleanup`, retaining its current implementation.

In `managed/recordings.ts`, create the callback once per service instance using
the existing service options object. Capture the same context dependencies once,
as the current `deps` object does; retain the original blob-store identity used
for input-cache keys. Read the optional configuration callback, or the current
default settings, inside each pass. Register the task under the existing
`workflow-recording-retention` name in the existing guarded function.
Keep `workflow-recording-recovery`, both closure flags, the startup sequence and
`cleanupWorkflowRecordingStorage()` exactly where they are.

Re-export `selectManagedRecordingRowsForCleanup` from `managed/recordings.ts` so
existing imports continue to work. Remove only imports and aliases made unused
by the extraction. Keep imports for persistence, explicit deletion or search even
when they are also needed by the new module.

`scripts/checks/import-boundary-debt.json` currently names the exact runtime edge
from `managed/recordings.ts` to `../../../llm-profile-health/state.js`. Relocate
that entry to `managed/recording-retention.ts` when its import moves. Keep the
other recording-service entries where their implementations remain. Do not add
a broader allowance or increase the exception count for this move.

Do not introduce a generic repository, SQL-builder framework, additional service
class, dependency registry or a second maintenance owner. Do not replace the
existing transaction helper, rewrite SQL or normalize policy edge cases as part
of this refactor.

## Ordered implementation

### 1. Record a baseline and close the SQL coverage gap

Start with tests against the current implementation, before moving production
code. Preserve the paused CI optimizations already present in the working tree.
Use the supported Node 24 runtime and existing compiled dependencies.

Extend `src/tests/managed-recordings.test.ts` for lifecycle assertions where
needed. Add one integration helper,
`src/tests/helpers/managed-recording-retention-contract.ts`, invoked by
`src/tests/recording-statistics-managed.integration.ts` as its final serial test,
after the existing sub-run-presence/indexed-statistics case. That case already
migrates the complete managed schema in the runner's disposable PostgreSQL.

Reset the earlier synthetic recording rows before seeding retention cases: a
workflow-ID filter cannot isolate a global byte limit. Use only the pool created
by this runner, which starts its own generated local container; add no database
URL input, second database, container or MinIO setup. No maintenance owner has
been started by the preceding presence tests. Use one owner across retention
policy cases and dispose it in `finally` before the runner closes its pool/container.
The adjacent ownership regression described below uses one controlled successor
for expiry/handoff checks and disposes it separately. No fixture waits for a
lease to expire in wall-clock time.
Reset inherited session settings such as the presence fixture's `work_mem` before
running this contract; do not inherit unrelated query-tuning state accidentally.

Exercise the current service's registered retention callback through the existing
maintenance pass and real PostgreSQL transaction/outbox implementation. Reuse
`createManagedWorkflowTransactionRunner`, the real database helpers and
`createManagedWorkflowMaintenance`. Supply only synthetic artifact keys and a
blob-store deletion stub that records calls; physical storage is already covered
elsewhere. Inject a mutable configuration reader, not a second retention
algorithm. Keep one small service fixture, with case-specific recording,
health-evidence and outbox rows reset serially while preserving its lease.
Existing migration/restore suppression remains a backend contract; intentionally
invoking the service in a controlled fixture is not permission to start serving
maintenance from migration code.

Use a compact fixture matrix:

| Behavior                 | Required observation                                                                                                                   |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| Age/count/byte rules     | Check each rule alone, then combined; exact removed/retained IDs match explicit expectations and earlier exclusions free later quotas. |
| Endpoint identity        | ASCII case and surrounding spaces group as today; different projects reusing a slug remain separate.                                   |
| Protected evidence       | Active suspension contributors survive all limits and are excluded from quota calculations.                                            |
| Batch bound and ordering | Assert the selected ID set for each bounded oldest-first batch, including a timestamp tie; later passes make progress.                 |
| Live configuration       | Changing the injected limits affects the next pass without reconstructing the service.                                                 |
| Disabled limits          | No retention selection/deletion transaction; ordinary maintenance can still perform its own lease/outbox work.                         |
| Atomic rollback          | After real deletion and real outbox insertion, an injected failure leaves both recording rows and deletion intent rolled back.         |
| Lease/health failure     | No recording deletion when the fence cannot be confirmed or protected evidence cannot be read/parsed.                                  |

Reuse existing fixture builders and valid suspension-evidence shapes. Use
database-relative timestamps with clear age margins; avoid sleeps around an
expiry boundary. Keep the policy cases table-driven; age-only, count-only,
byte-only, combined and all-disabled settings exercise the conditional SQL paths
without testing every combination. Include a no-deletion pass, a byte-limit
equality, and contributions from all three stored-byte columns in these cases.
Keep the independent pure-policy tests, but do not treat them
as proof that PostgreSQL executes the same policy or derive SQL expectations
from that selector. Use simple ASCII IDs for ties; preserve current database
collation and JavaScript sorting/trim rules rather than claiming they agree for
every possible string. `DELETE ... RETURNING` and outbox draining have no promised
row order, so do not assert their iteration order.

Inject rollback failure around the existing enqueue operation after it writes,
within the real transaction. Observe state and reported task failure: do not
incorrectly expect `maintenance.runNow()` itself to reject. Its subsequent
outbox drain may complete eligible fixture deletions, so assertions must not
assume every committed outbox row stays pending. Rolled-back keys must produce
neither a committed deletion intent nor a blob-deletion call.

Keep lease-failure, failed/undecodable-evidence and startup-order checks
deterministic in the existing unit fixture. Confirm that constructing the service
does not read settings and that both the injected reader and the production
fallback observe changed limits on a later pass. Reuse scoped settings helpers
and restore their state; do not add a runtime hook or run global-setting cases
concurrently. Preserve current evidence-normalization behavior.
Existing maintenance and shared snapshot integrations remain the authority for physical deletion and live
reference protection; do not build a duplicate S3 collector or concurrency suite.

If these tests expose a pre-existing policy discrepancy, document and assess it
separately before extraction. Do not silently alter retention behavior to make
the reference function and SQL agree.

### 2. Extract the callback and its exclusive helpers

Apply the module boundary above as a mechanical move. Keep SQL predicates,
parameter order, selected columns, batch limit, ordering, deletion reason,
transaction boundaries, lease checks and cache invalidation placement unchanged.
Keep dynamic settings access inside the returned callback.

Review the moved code against the baseline body, including failure paths. Avoid
formatting unrelated portions of the large service or modifying its other methods.

### 3. Verify service composition and compatibility

Run the same characterization tests after extraction. Check task registration
once, context initialization before the pass, recovery suppressed during the
first startup pass and enabled after it settles, and existing repeated-initialize
behavior. Include the logged-failure startup path so the extraction does not
silently strengthen or weaken that gate. Reuse backend lifecycle tests for
offline-mode suppression and disposal. Verify cache invalidation for an actually
deleted recording uses the same storage-owner namespace; do not change its
pre-commit timing or require rollback to refill the cache.

Verify existing imports still obtain the policy reference from `recordings.ts`.
Build the API and exercise compiled startup through the existing managed tests;
source-only TypeScript resolution is insufficient proof that the new `.js`
runtime import is packaged correctly.

### 4. Validate storage behavior and performance locally

From the repository root, run the focused checks, then the two existing managed
integration entry points:

```powershell
yarn workspace @valerypopoff/rivet-studio-server-api build
yarn workspace @valerypopoff/rivet-studio-server-api test:files src/tests/managed-recordings.test.ts src/tests/managed-maintenance.test.ts src/tests/managed-transactions.test.ts src/tests/managed-operations.test.ts src/tests/recording-durability.test.ts
yarn workspace @valerypopoff/rivet-studio-server-api run test:statistics-managed
yarn workspace @valerypopoff/rivet-studio-server-api run test:recording-durability-managed
yarn check:file-tree
yarn studio-server:verify:test-style
yarn node scripts/checks/check-doc-links.mjs
```

Build workspace dependencies first if stale, then build the API before tests
that spawn compiled modules. Keep builds and tests using their outputs sequential.
The new helper is reached from an already selected integration runner; no new CI
job or top-level test entry is needed. Apply formatting
and lint checks to the final changed source and docs.

Compare baseline and candidate using the existing
`scripts/benchmark-recording-memory.mjs` managed harness, with identical cached
image dependencies, codec, settings backend, warmups and synthetic workload.
Use `production` (2 CPU / 4 GiB, 32 runs) and `smallest` (500m / 1 GiB, 4 runs)
profiles for small and mixed traffic. These are local profile measurements, not
cloud qualification. Preserve build snapshots before moving production code so
the baseline is the actual pre-refactor implementation. Compare complete
responses and expected recording counts as well as latency, throughput and
drain/resource observations.

The extraction must add no storage calls, request-path initialization, queue or
memory-accounting work. Keep retained-memory protections and asynchronous
recording persistence untouched. SQL/query-order equivalence and paired results
provide different evidence: passing correctness checks alone does not prove
performance neutrality. Compare multiple paired rounds, accounting for run-to-run
noise. Investigate a repeatable regression rather than treating one timing spike
as proof or averaging it away. Do not add a flaky timing assertion to the ordinary
unit suite or grow a new performance harness for this extraction.

The existing serving benchmark disables background maintenance. It checks the
execution/persistence path, not retention contention or throughput under backlog.
Use the new SQL fixture to check that the selected/deleted rows remain bounded
and review that the query itself is unchanged. Neither claims bounded total SQL
work. Broader retention performance work requires separate evidence and is
outside this extraction.

Reuse one focused existing Run recordings Playwright journey to verify browsing
and replay after the final API/web build, following the repository's required
headless runner. Do not add a layout test or rebuild the web repeatedly for
unchanged inputs. Mocked browser checks do not replace the storage integrations.

### 5. Document the completed boundary and review the final diff

After implementation and successful validation:

- Update this plan with completed steps and exact verification boundaries.
- Update the recording ownership section of `development.md` and the relevant
  recording/maintenance description in `architecture.md`.
- Add a focused entry to `refactor-history.md` explaining why the callback moved
  and which invariants/tests maintainers must preserve.
- Review public exports, emitted imports, changed test selection and the staged
  diff. Read applicable CI notes before any separately requested commit/push.

Version bumps, commits, pushes, cloud tests and deployment remain separate tasks.

## Completion and stop conditions

- One runtime retention module owns the moved implementation; one existing
  maintenance owner still schedules and executes it.
- The recording service's interface, startup order and offline-mode behavior
  remain compatible, with no new resource lifetime.
- The real SQL contract passes before and after extraction. Unit, managed
  storage, compiled-startup and focused browser checks pass against final code.
- Existing recordings, codecs, shared snapshots, capture memory limits and
  asynchronous persistence retain their behavior.
- Paired local measurements show no repeatable execution regression; any open
  performance uncertainty is reported rather than marked passed.
- The diff contains only the extraction, necessary coverage and owning docs.

Stop and revise if the work needs SQL/policy changes, additional production
pools/timers, altered recovery/lease semantics or a broad service split. Do not
continue into persistence or browsing extraction automatically after this slice.

## Implementation and verification record

The extraction is complete. `managed/recording-retention.ts` owns the callback,
policy reference and retention-only helpers. The recording service retains its
public methods, compatibility export, task registration and recovery gate. No
schema, configuration, deployment, capture-memory or persistence-format changes
were made. The paused CI optimizations were preserved separately.

The SQL/transaction body and JavaScript policy reference match the saved baseline
exactly. The extraction relocates one existing import-boundary allowance; it
does not increase the count. No new production pool, timer, queue or per-request
storage operation was introduced.

Local checks passed:

- API build/typecheck and typed lint for the runtime modules, integration helper
  and integration runner. The existing `node:test` registration file was linted
  with only the top-level-test `no-floating-promises` rule excluded; no committed
  lint policy or production rule was weakened.
- The 16 focused recording tests and the real PostgreSQL contract passed before
  extraction. The post-extraction focused suite passed 57 tests; the final
  changed recording fixture was also rerun separately. The existing pure-policy
  tests remain in place.
- `test:statistics-managed` passed all six tests, including real retention
  selection, held evidence, tied multi-pass batches, dynamic/disabled limits and
  rollback/retry after actual delete/outbox insertion. The expanded contract takes
  about one second locally in the existing database; it adds no container startup
  or CI timing threshold.
- `test:recording-durability-managed` passed real PostgreSQL/MinIO recovery,
  uncertain acknowledgements, concurrent deletion/finalization, shared snapshots,
  legacy/Brotli playback, restored copies and the actual recording APIs.
- The headless Run recordings deletion/replay journey passed through the standard
  observation runner against the local app. Its mocked API/browser checks remain
  distinct from the real storage integrations.
- Import boundaries, test-style guardrails, documentation links and final diff
  checks passed.

The existing managed benchmark compared saved original/candidate builds with the
same cached image, PostgreSQL-backed settings and recording codec. Each workload
used six alternating measured pairs of 128 requests after two 64-request warmup
batches. All 896 recordings per side/case were audited, 7,168 total.

| Local profile / workload       | Original p95 | Candidate p95 | Original mean completion/drain | Candidate mean completion/drain |
| ------------------------------ | ------------ | ------------- | ------------------------------ | ------------------------------- |
| 2 CPU / 4 GiB / 32 runs, small | 4.77 ms      | 4.54 ms       | 2,486.85 ms                    | 2,383.72 ms                     |
| 2 CPU / 4 GiB / 32 runs, mixed | 15.70 ms     | 15.77 ms      | 2,570.89 ms                    | 2,594.11 ms                     |
| 500m / 1 GiB / 4 runs, small   | 4.73 ms      | 4.89 ms       | 5,365.79 ms                    | 5,379.68 ms                     |
| 500m / 1 GiB / 4 runs, mixed   | 30.11 ms     | 27.44 ms      | 5,342.68 ms                    | 5,344.05 ms                     |

The paired confidence intervals include zero for p95 and total completion/drain
differences in all four cases: no repeatable serving regression was observed.
The half-CPU profile showed quota/GC variation in both builds. RSS ranges overlap;
retained-memory checks drained successfully. These finite synthetic measurements
do not establish identical latency for every workload or a production speedup.
Background maintenance is disabled by this harness; retention SQL work and
backlog throughput retain the limitations described above.

Local evidence is under `artifacts/managed-recording-retention-20261122/`, including
baseline/candidate snapshots, equivalence checks, integration/browser logs and
the four benchmark manifests/results. No cloud test, deployment, commit or push
was performed.

### Post-implementation review

The review found coverage gaps, not a production behavior regression. The common
fixture now has a count-excluded row newer than a retained project from another
workflow. This makes the combined-limit case fail if excluded rows incorrectly
consume byte quota. Separate equality and just-below-equality cases also detect
omitting either replay-project or dataset bytes from the sum.

Those checks were confirmed with three deliberately faulty SQL variants loaded
only inside isolated test processes. Each failed at its intended assertion;
runtime files and live application processes were not modified. These one-off
checks are local evidence, not another CI job or application configuration.

One shared assertion checks remaining recordings, deletion intents and object
deletions after batches, rollback and retry. Retry must produce no additional
logged error. Service construction and the lazy-settings assertion now sit inside
the fixture's disposal scope so an early failure still cleans up its owner.
The adjacent developer-documentation claim that durability defaults off was
corrected to match `recordingDurabilityEnabled()` and its existing tests.

The API build, 16 focused recording tests, all six PostgreSQL/statistics tests,
typed lint, test-style/import guards and documentation checks passed again.
At that test-only review, the compiled serving fingerprint still matched the
measured candidate, so those browser, storage and performance checks were not
repeated. The following adjacent repair changes background claim fencing and has
its own validation record.

### Adjacent maintenance ownership repair

A real PostgreSQL reproduction confirmed that an expired maintenance pass could
claim and delete a newly queued object after a successor acquired the global
lease. A task can consume the pass's lease lifetime; the outbox claim previously
checked only the object's claim expiry, not the pass holder/token/expiry.

`managed/maintenance.ts` now validates and briefly share-locks the pass lease as
part of each existing claim statement. No extra database round trip, schema,
timer or foreground execution operation was added. The lock ends with the claim
statement, before object-reference checks and storage calls. Already issued
calls may finish under their existing per-object claim fencing; no graph is
resubmitted and no uncertain business side effect is replayed.

The PostgreSQL contract failed before the fix with a deletion by the old owner.
It now checks expiry both with and without a takeover, verifies a real successor
obtains a higher fencing token, and confirms the current owner can finish the
queued deletion. All owners are disposed before the existing fixture pool closes.
No additional service/container or waiting for lease deadlines was introduced.

Local validation passed: the API build, all 57 focused tests, all six real
PostgreSQL/statistics tests, the full PostgreSQL/MinIO durability suite and the
headless recording deletion/replay journey. The latter storage checks include
shared-snapshot pins, uncertain acknowledgements and pending deletion, so the
repair does not substitute an ownership check for live-object protection.

A fresh six-pair 32-run small-request comparison of the final build against the
pre-refactor baseline measured p95 4.8235 ms versus 4.8289 ms, with the paired
interval including zero. Mean completion/drain was 2,432.12 ms versus 2,395.29 ms;
all 896 recordings per side were audited. No repeatable normal-run slowdown was
observed. This harness disables background maintenance; correctness of the new
claim gate is established by the actual PostgreSQL handoff test, not this timing
sample. No retention-throughput improvement is claimed.

Evidence is stored with the earlier local receipts as `adjacent-*` logs, build
snapshot and benchmark results. The paused CI changes remain unchanged. No cloud
test, deployment, commit or push was performed.

### Relevant test cleanup

The maintenance unit fixture now centralizes only fake query responses and
per-test disposal. A five-case table retains completed deletion, live-reference
blocking, disabled-policy blocking and storage retry, and explicitly checks a
failed reference lookup cannot cause deletion. Durable updates also assert the
claim owner and fencing token. Duplicate pool/store/logger setup and a stale
reference-query matcher were removed.

All three metrics contracts remain: correct observations, failure isolation and
nonblocking completion. Deferred gates replace the manual one-second timeout
race; cleanup releases a held snapshot before disposing maintenance. Isolated
fault probes verified that ignoring a reference-read failure fails an assertion
and awaiting metrics fails the test timeout and still exits cleanly.

The enqueue unit retains its single-query batching/normalization check. Its SQL
shape assertions were replaced by an actual PostgreSQL blocked-intent reopening
case, verifying the new reason, retry/claim reset, readiness and subsequent
deletion. Retention selection, protected evidence, rollback and real lease-handoff
checks remain unchanged. The compiled native-compression test keeps process
isolation while dropping inherited test/transpiler flags; both source and compiled
parent modes passed.

Across the four reviewed files the cleanup removes 137 test lines overall:
maintenance tests shrink from 404 to 235 lines, with the additional real SQL
assertions included in the total. All 57 focused tests and the six actual
PostgreSQL/statistics tests pass. The production serving build is unchanged, so
the previously recorded storage/browser/performance checks are retained rather
than rerun for this test-only cleanup. No CI job, container or runtime dependency
was added.

### Final reliability assessment

The final review compared the uncommitted retention work with `b1662c284`.
Canonical TypeScript comparison confirms that the extracted callback's SQL and
transaction body, and the independent policy helpers, remain unchanged. The
rebuilt serving fingerprint matches the candidate used for the final normal-run
benchmark. Fresh validation passed the API build, 57 focused tests, six real
PostgreSQL/statistics tests, workflow policy checks and 11 CI/fixture tests.
The retention review left the nine paused CI optimization files unchanged;
its local results do not establish hosted workflow success or a hosted speed
improvement.

No further correctness regression was found. The ownership repair improves
deletion safety but can defer physical cleanup when preceding maintenance tasks
consume the lease. Retention still performs history-wide SQL work to select a
bounded deletion batch, and its stored-byte quota is not a physical bucket cap.
The normal-run benchmark disables maintenance, so it does not establish latency
or cleanup throughput during a production-sized retention backlog. These limits
remain explicit; this extraction is a maintainability and correctness improvement,
not a claim of faster retention or complete production qualification.

Commit preparation also includes the previously paused CI optimizations,
documented in [CI performance](ci-performance.md#rollout-and-chart-contracts).
Deployment-command journeys remain mandatory in their separate source-only job;
the post-build verification skips only that duplicated suite. Local validation
and the existing release gates remain separate from hosted workflow results.
Pre-commit checks passed repository-wide `test:style`, typed lint, the API build,
all 57 focused tests and all 31 deployment-command journeys. Formatting and
documentation links also passed. Private evidence and the local CI checklist
remain excluded from Git.
