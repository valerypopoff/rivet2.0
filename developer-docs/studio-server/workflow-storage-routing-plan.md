# Workflow storage routing refactor

Status: implemented and locally verified. The completion summary below records
the final behavior, regression coverage and validation limits.
Reviewed against `8b9f572aa282da5e063da856f614c44282b4105c` on 2026-11-14.

## Goal and corrected scope

Make workflow storage easier to navigate and extend without changing behavior,
adding execution latency, or replacing working persistence machinery. Keep the
exports of `routes/workflows/storage-backend.ts` compatible so callers do not
need a coordinated migration.

The original recommendation needs narrowing. The roughly 1,400-line facade is
not just routing, but PostgreSQL and SQLite already use the four narrow contracts
in `data-backend.ts`. `WorkflowStorageServices.getRepository()` returns the same
installation-owned backend through those contracts; it does not create four
repositories or enforce authorization. Replacing this mechanism gains little.

Legacy filesystem storage does not implement `WorkflowDataBackend`, and making
it do so is not a prerequisite. Its hosted save returns `project: null`; the SQL
contract returns a project. The compatibility facade also permits nullable
revision IDs, even though current filesystem reads/saves compute a revision.
Legacy relative-reference loaders need a source path, web-app policy checks need
an expected project path, and evidence support differs. These are real contract
differences, not missing implementations to fill with invented values.

The useful work is to extract the filesystem implementation, reuse contracts
where they already fit, and simplify repeated publication dispatch. A few explicit
mode branches and policy functions should remain. Do not introduce a universal
repository registry, a method-name dispatcher, or another lifecycle owner merely
to make the facade shorter.

## Owning files and intended boundaries

Paths below are relative to `packages/studio-server-api/src/routes/workflows/`.
The legacy modules and identity helper were introduced by this refactor.

| Owner                                              | Responsibility after the refactor                                                                                                                                                                                                                                                           |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `storage-backend.ts`                               | Existing compatibility exports, narrow SQL repository selection, capability guards, and the small cross-backend policies listed below. No filesystem project transaction or project-materialization bodies.                                                                                 |
| `legacy-project-storage.ts` (new)                  | Filesystem tree/path queries and hosted project load/save, permission-error mapping, save-target reconciliation, and post-commit statistics handling. Obtain the root at the same point as today.                                                                                           |
| `legacy-execution-storage.ts` (new)                | Filesystem endpoint/web-app/Subgraph loading, targeted web-app policy lookup, revision-key construction, missing-root recovery, reference-loader locking, and the existing cache/policy invalidation helpers.                                                                               |
| `filesystem-project-identity.ts` (new leaf helper) | The existing physical project-ID scan shared by save reconciliation and Subgraph loading. Preserve its malformed-neighbor behavior; no new index or cache.                                                                                                                                  |
| `legacy-workflow-commands.ts`                      | Keep the existing project/publication commands, lock boundaries and mutation hooks. Reuse this adapter rather than extracting another copy.                                                                                                                                                 |
| `data-backend.ts`                                  | Keep existing narrow SQL contracts. Move the facade's hosted-IO option/result types here under distinct compatibility names where necessary; do not widen SQL results or discard `structuralMutation` from the facade's save options. Re-export existing public type names from the facade. |
| `storage-services.ts`, `storage-composition.ts`    | Preserve resource selection, construction, initialization, maintenance and shutdown ownership. No new pools, stores, workers, timers or admission rules.                                                                                                                                    |

Dependencies must point away from the compatibility facade. The new legacy modules
must not import it at runtime or construct serving services. Compose existing
command hooks in the facade using imports from the legacy execution module and
the existing storage-owner getters. Supply hosted-save invalidation as a narrow
callback so project IO does not import the execution adapter. Both legacy modules
can import the identity leaf without creating a cycle.

Move hosted-IO compatibility types only as needed to share them with the new
module. Preserve the current branded `ProjectId`, `saveIntent`, optional
`structuralMutation` and result nullability. Do not replace the facade's options
with the SQL save-options type: the latter does not describe the complete facade
contract. Keep the SQL declarations themselves unchanged.

Keep short forwarding functions together. Do not split each domain into another
facade file solely to reduce the line count of `storage-backend.ts`.

## Behavior that must remain unchanged

| Boundary           | Required behavior                                                                                                                                                                                                                                                                                          |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Public API         | Same exports, overloads, argument defaults, response fields, nullability, error codes/status/messages and exposed-error flags. Preserve managed-only rejection and tree capability flags.                                                                                                                  |
| Mode selection     | Preserve internal `legacy`/`sqlite`/`managed` selection and the separate public `filesystem`/`managed` storage-mode result. A SQL failure must never fall back to filesystem storage.                                                                                                                      |
| Lazy construction  | Importing helpers and reading pending/active counts must not open resources. Keep `peek` observation and retirement paths non-constructing. Do not cache a root or storage owner in a new module at import time.                                                                                           |
| Filesystem writes  | Preserve existing read/write locks, physical identity reconciliation under the save transaction, revision conflicts, title normalization, dataset validation, rollback and derived-statistics timing. Even if statistics writing fails after commit, execution materializations must still be invalidated. |
| Publications       | Clone the whole command before the first adapter-acquisition or writer wait. Keep precondition checks and writes inside their current transaction/lock. Preserve command overload results and one exhaustive switch.                                                                                       |
| Execution          | Preserve published/latest selection, `requireFreshPointer` handling in each mode, cache hits/invalidation, returned paths, revision keys, dataset providers and Subgraph identity checks. No added graph serialization, artifact read or storage round trip.                                               |
| Web-app access     | Preserve mode-specific paths and `filesystem:`/`managed:` binding identities. Legacy policy rechecks must read the expected project's settings without scanning/deserializing the workspace.                                                                                                               |
| Missing root       | Keep the existing single recovery only for `ENOENT` when the workflows root itself is missing. Do not add ordinary warm-path directory creation or general IO retries.                                                                                                                                     |
| Recordings         | Preserve query snapshotting/defaults, `includeEvidence` differences, dataset-retention policy for every producer, and asynchronous persistence ownership. A successful recording deletion stays successful if its subsequent health-evidence update fails. No graph re-execution.                          |
| Indexed references | Keep managed-only lookup, the two-operation limit, existing request deadline including initialization, caller cancellation, and slot release when underlying work actually settles. Do not cancel shared initialization when a caller times out.                                                           |
| Shutdown           | Keep retirement, accepted-work drain, producer stop, evidence/recording/outcome flush and close ordering. Existing stores remain available to accepted work; failed or uncertain cleanup retains its owner. Queue policy is disposed only after successful service disposal.                               |
| Offline tools      | Direct adapters used by import/migration/restore tools remain independent of serving factories, maintenance timers and operational producers. Legacy compatibility is still used by these paths.                                                                                                           |

These are preservation requirements, not proposals to strengthen or relax the
current product policy. Any independently discovered behavior bug should be
recorded and handled separately rather than hidden in this refactor.

## Implementation order

### 1. Capture the contract and baseline

- Reconfirm the starting commit and known working-tree changes. Review callers
  of touched exports, including hosted editor IO, execution and recording paths.
  Leave unchanged lifecycle, capability and offline-adapter entrypoints in place.
  Compiler/import checks provide the complete caller compatibility check; no new
  manually maintained export catalog or generated source snapshots are needed.
- Use the preservation table to review each moved body's root acquisition,
  transaction, cache notification and error behavior. Keep a short moved-symbol
  list in the implementation handoff rather than another permanent ledger.
- Run the small baseline command below before edits. Capture same-fixture cold
  initialization and warm endpoint results through the actual facade/HTTP path.
  Record pre-existing failures and environmental skips separately; do not use a
  passing unrelated test to claim a missing baseline.
- Inspect existing tests before adding any. Publication command snapshotting,
  moved-project saves, cache invalidation, and storage-owner failure fencing
  already have regressions; retain and use them. Add only missing observable
  cases, such as an unasserted compatibility result or routing side effect.

Completion: an explicit baseline and identified test gaps, with no production
behavior changes or new all-method mock repository.

### 2. Extract filesystem project IO

- Move the project-ID scan unchanged into the identity leaf and keep both callers
  using it. Do not substitute the UI tree or a cached projection for physical
  identity during save reconciliation.
- Move filesystem tree/path queries, hosted load/save and their private helpers
  into `legacy-project-storage.ts`. Pass the existing invalidation callback to
  save; keep root acquisition and callbacks in their original lock/commit phase.
- Move compatibility types without changing signatures. The facade delegates to
  the selected SQL repository or the legacy functions and retains tree capability
  decoration and unsupported managed-hosted-IO behavior.
- Preserve the legacy tree's maintenance branch: during VM migration maintenance,
  it uses `getWorkflowsRoot()` without `ensureWorkflowsRoot()`. Extracting tree and
  path queries must not merge their different root-acquisition rules.
- Run hosted-title/identity, filesystem transaction, tree and execution
  invalidation tests. Check successful save output as well as conflicts and
  post-commit derived-cache failure behavior.

Completion: filesystem project persistence has one owner; the facade no longer
contains its transaction body. Existing command implementations are untouched.

### 3. Extract filesystem execution support

- Move the existing legacy endpoint/web-app/reference/Subgraph branches and their
  helpers into `legacy-execution-storage.ts`; preserve each call's lock scope.
  Keep the current `filesystem-execution-cache.ts` and
  `filesystem-execution-source.ts` implementations unchanged.
- Move invalidation helpers with their current distinctions: materialization-only
  invalidation, structural invalidation plus policy notification, and invalidation
  of both old/new paths after a move. Reconnect existing command/save hooks once.
- Preserve root recovery, web-app revision hashing, targeted policy lookup, lazy
  creation of reference loaders and optional Subgraph validation exactly.
- Leave mode-specific web-app policy mapping explicit. The SQL policy shape and
  the facade's absolute/virtual paths and binding IDs are not interchangeable.
- Run real published/latest executions, cross-project loads, web-app access and
  cache regressions before proceeding.

Completion: no project loading/materialization implementation remains in the
facade and no extra work has been added to warm execution paths.

### 4. Simplify routing where it removes actual duplication

- In `executeWorkflowPublicationCommandWithBackend`, snapshot first and keep the
  exhaustive switch **before** repository acquisition. Each valid case calls one
  small publication-selector callback with the narrowed command. An unsupported
  kind must still return the current 400 without initializing storage, including
  when storage is unavailable. Moving the switch after acquisition changes that
  error precedence and must be avoided.
- Implement a small callback selector using the existing typed `delegate` helper
  for `publications`. The legacy branch calls it with `legacyCommands` immediately;
  the SQL branch awaits the same installation-owned repository as today. Avoid an
  async `getPublicationRepository()` followed by an unconditional await, which
  would introduce a new yield before legacy writer admission. Keep method calls
  on the repository object so `this` binding is preserved.
- Legacy commands already satisfy `WorkflowPublicationRepository`. Delete the
  seven private per-command dispatch helpers and reuse the selector for existing
  publication queries. No second list of supported kinds or generic dispatcher
  is needed. Keep command cloning before the selector and all writer waits.
- Keep existing typed project/recording delegations where they are short and
  honest. Do not force hosted IO, policy lookup or reference loaders into a common
  contract with optional fake methods, blanket casts or nullable SQL fields.
- Replace the duplicate inline recording-persistence options declaration with
  `PersistWorkflowExecutionRecordingOptions`, preserving the dataset-policy check
  before dispatch. Keep pagination snapshots/defaults and deletion's best-effort
  health update at this shared boundary.
- Keep indexed-reference admission/deadlines and lifecycle entrypoints explicit.
  Remove only helpers/imports made unused by these changes. Preserve the
  synchronous/async call boundary of legacy work and avoid adding hot-path awaits.

Completion: less repeated dispatch and duplicated type plumbing, without a new
repository framework or broad consumer migration.

Retain the existing reviewed-command snapshot regression. Add or extend focused
behavioral coverage for unsupported-command rejection before storage acquisition
and publication's synchronous legacy admission if those cases are not covered.
Use a fresh owner/process where necessary; do not retarget a live singleton by
changing environment variables halfway through a test.

### 5. Validate the integrated result and update ownership docs

Run relevant checks once against the final unchanged code, reusing intermediate
results where no affected code changed. No GKE rehearsal, cloud resources,
backfill, application deployment or production data is needed for this refactor.

The table below maps risk to existing coverage, not separate mandatory reruns.
All 20 named `.test.ts` files currently belong to the normal API test manifest.
Use targeted suites while editing, then one normal API run on the final diff;
do not run the entire table again alongside that same unchanged full suite.

| Area                               | Existing verification to reuse                                                                                                                                                                                                   |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Resource owner                     | `workflow-storage-services.test.ts`, `workflow-storage-config.test.ts`                                                                                                                                                           |
| Hosted IO and transactions         | `hosted-project-title.test.ts`, `filesystem-project-transactions.test.ts`, `filesystem-project-move-transactions.test.ts`                                                                                                        |
| Filesystem integration             | `workflow-filesystem-tree.test.ts`, `workflow-publication-filesystem.test.ts`, `workflow-published-history-filesystem.test.ts`, `workflow-execution-filesystem.test.ts`, `workflow-web-apps-filesystem.test.ts`                  |
| Cache/source contracts             | `filesystem-execution-cache.test.ts`, `filesystem-execution-source.test.ts`, `filesystem-publication-transactions.test.ts`                                                                                                       |
| SQLite and shared policy           | `sqlite-workflow-backend.test.ts`, `local-workflow-catalog.test.ts`, `workflow-publication-policy.test.ts`                                                                                                                       |
| Recordings and operational effects | `workflow-recordings-http.test.ts`, `filesystem-recordings-root.test.ts`, `recording-durability.test.ts`, `llm-profile-health.test.ts`                                                                                           |
| Real managed serving               | Maintained `test:async-managed` command against disposable local PostgreSQL/MinIO. Its isolated API process seeds, saves, publishes, resolves and records through the real facade and serves actual recording artifact requests. |

Use the pinned Yarn release from the repository root on Windows, for example:

```powershell
node .yarn/releases/yarn-4.17.1.cjs workspace @valerypopoff/rivet-studio-server-api test:files src/tests/workflow-storage-services.test.ts src/tests/workflow-storage-config.test.ts src/tests/hosted-project-title.test.ts src/tests/workflow-publication-filesystem.test.ts
# At final integration, after building the affected workspaces:
$env:RIVET_API_TEST_RUNTIME = 'prebuilt'
node .yarn/releases/yarn-4.17.1.cjs workspace @valerypopoff/rivet-studio-server-api test
node .yarn/releases/yarn-4.17.1.cjs workspace @valerypopoff/rivet-studio-server-api test:async-managed
```

Across the existing filesystem, SQLite and managed fixtures, verify the touched
facade paths: load/save, publication dispatch and execution resolution. Reuse
existing recording read/write/delete regressions and add only missing assertions
for the changed shared options/policy boundary. A direct-adapter contract alone
does not prove routing. Extend the existing isolated fixtures for genuine gaps
rather than adding another service harness or duplicating a full journey in every
test file. Verify SQL requests do not initialize legacy storage and legacy
requests do not acquire SQL resources.

The full API command uses the verified compiled runtime for rehearsal children,
matching `studio-server-verify.yml`. Build the current API first; source-mode
rehearsals repeatedly transform the whole API during restart scenarios and do not
represent CI's execution mode. Do not mistake source compilation time for a
storage-routing regression. Root build/style tooling uses its own CI Node 22
version; deployment-facing API validation and measurements use Node 24.

`test:migration-managed` mainly exercises migration/restore through direct
adapters; it is not the primary serving-facade test. Leave offline adapter
construction unchanged and check imports/types. Run its larger restore drill
only if implementation actually affects an offline import, construction or
recovery boundary. Such a change requires a separate scope review first.

At final integration, compile the affected workspaces and run relevant
structure/import-boundary checks, test manifest/style checks and documentation
links once. If adding a test file, register it in the explicit API manifest;
prefer extending an owning existing suite. Before a requested commit
or push, apply relevant entries from `ci-pre-push.local.md` if it exists. Refresh
the migration source-file ledger only for moves it actually tracks; do not change
historical provenance just to satisfy a path check.

Hosted save/publication/recording behavior is browser-visible even though no UI
redesign is planned. The observer runner accepts Playwright file filters and
`--grep`; use a small relevant selection rather than its full browser inventory.
Point `PLAYWRIGHT_BASE_URL` at a disposable local dashboard. For example:

```powershell
$env:PLAYWRIGHT_HEADLESS = '1'
$env:PLAYWRIGHT_SLOW_MO = '0'
node .yarn/releases/yarn-4.17.1.cjs studio-server:ui:observe workflow-project-version-modal.spec.ts cross-project-subgraph-loading.spec.ts run-recordings-modal.spec.ts --grep 'unpublished_changes uses|Go to subgraph selects|Any is first and filters'
```

These three existing cases check saved-version UI selection, external Subgraph
navigation, and recording filtering/deletion. They intercept API requests and
prove browser compatibility with the response contract, not persistence or
storage routing. Attribute that evidence honestly; the real facade/API journeys
above prove server behavior. Do not require an extra new browser harness to
duplicate the API tests. Inspect `artifacts/playwright/` on failure and record
environmental skips separately from successful coverage.

Update `architecture.md`, the storage section of `development.md`, and relevant
ownership statements in `refactor-history.md` only after implementation. Mark
this plan's phases complete with actual evidence, not because files were moved.
No user documentation change is expected for behavior-preserving internals.

## Performance and completion criteria

Measure through the facade and an actual local published/latest endpoint, using
the same small deterministic graph, recordings settings and storage mode
before/after. Use freshly built baseline/candidate output on the same supported
Node runtime (Node 24 for deployment-representative evidence), including cold
startup and warm repeated requests. Run measurements separately from builds,
tests and other measurements; use independent processes for each storage mode.
Use the existing HTTP fixture to assert successful status, expected complete body
and cache behavior before interpreting timings. The `workflow-execution:measure`
command can capture complete-response timings, but only prints statuses and
rounded milliseconds; it does not assert the response or calculate percentiles.
Summarize captured samples separately or use high-resolution timing around the
existing fixture when rounded measurements cannot resolve the result. No new
benchmark framework is needed. Keep warmups separate, use equal sample counts
before/after (for example 20 warmups and 200 measured requests), and record
p50/p95, sample count and errors. A p99 from such a small sample is diagnostic,
not a reliable acceptance gate. Measure startup separately; the HTTP command
does not time process initialization.

Repeat paired measurements only when noise or an apparent regression needs
resolving. Existing serving-workload benchmarks instantiate
adapters directly, so they alone cannot establish that facade routing is neutral.
Do not use public/production endpoints or paid provider calls for the fixture.

The refactor must add no storage round trip, root scan, serialization, per-run
owner construction, or awaited recording bookkeeping. A repeatable slowdown
beyond measured baseline variation blocks completion; investigate it rather than
introducing a new performance allowance. A noisy sample is inconclusive, not a
speedup or a regression claim.

Done means:

- All existing exports and caller-visible contracts are preserved across the
  three internal storage modes, including intentional unsupported capabilities.
- Filesystem project/execution implementation has focused owners without cycles,
  duplicate mutation logic, or a second resource lifecycle.
- Publication dispatch and recording option types have demonstrably less
  duplication. Report net production-code change across **all** affected files,
  not just the shortened facade; no arbitrary facade line-count target applies.
- Existing behavioral tests and the locally affected integration/browser paths
  pass, with skipped/unavailable checks explicitly recorded.
- No repeatable execution regression or new per-request IO is introduced, and
  lifecycle tests still prove accepted work can settle before resources close.
- Documentation states what owns each behavior and which mode differences remain
  intentional. No schema, persisted format, HTTP/WebSocket protocol, deployment
  configuration, feature or authorization policy changed.

Stop and reduce scope if extraction requires changing identity, lock or drain
semantics, causes a module cycle/eager initialization, or grows a generic routing
framework. Keep behavior fixes separate. The objective is clearer ownership and
less duplication, not maximum backend uniformity.

## Implemented result (2026-11-14)

All five phases are complete. `legacy-project-storage.ts` owns filesystem
tree/hosted IO, identity-safe saves and post-commit statistics;
`legacy-execution-storage.ts` owns endpoint, web-app, reference and Subgraph
loading plus cache/policy invalidation. `filesystem-project-identity.ts` shares
the physical ID scan. The facade retains compatibility exports, repository
selection and cross-backend policies. Seven private publication dispatch helpers
and the duplicate recording-persistence options declaration were removed.

The facade decreased from 1,412 to 806 lines. Across all nine changed production
files, nonblank lines decreased from 2,298 to 2,292. Clearer ownership is the main
benefit. All 61 runtime exports remain; the final source comparison found 45
retained and 11 moved function bodies unchanged. Routing changes were reviewed
separately. No new resource owner, cache, transaction framework, schema, persisted
format, authorization policy or HTTP/WebSocket protocol was introduced.
Container packaging copies the compiled API tree, including the new modules.

### Correctness repairs found during verification

- Hosted saves capture their DTO before lazy repository acquisition or writer
  waits. Filesystem saves normalize the title once and reuse the written bytes
  for statistics and response revisions, removing two redundant parses. Two
  regressions failed before repair: caller changes could alter submitted bytes
  or make the returned/tree revision describe unsaved edits. This is a confirmed
  programmatic-caller race, not a demonstrated production HTTP incident. Direct
  SQL adapter captures remain for offline callers.
- Open Windows readers could make atomic control-record replacement fail with
  `EPERM`. Preparation, backup-status and repair-journal writers now share
  `replaceControlFile`: at most five attempts, with four delays totaling 150 ms
  plus filesystem time, promoting the same staged bytes. Other errors propagate
  immediately. Accepted inspection, backup, repair or execution work is never
  replayed. Callers retain validation, fsync and temporary-file cleanup. Failed
  backup-status publication preserves earlier evidence. Real-reader regressions
  failed before repair and passed afterward; persistent-error cases prove that
  work does not start. Moving obsolete backup status to a new name was probed
  separately and remains unchanged.
- Hosted Save As browser cleanup now drains forwarded requests and closes its
  browser context before the owned API fixture. Previously teardown could hide
  an initialization error with connection resets and interrupt fixture cleanup.
  Its startup wait now passes the two-minute timeout in `waitForFunction`'s third
  argument; the trace confirmed that it was previously page data. Source-host
  cases require Vite and stable dependency optimization, as documented in
  `development.md`; a local cold-cache optimization change loaded duplicate
  React instances. No production UI behavior changed.
- Stale runtime-library migration fixtures now describe valid installed source
  selections; archive-only cases call the directory-archive primitive and retain
  confinement checks. The bounded-copy fixture aliases its injected
  `createRequire` import to avoid a bundler collision reproduced with the
  original facade. Its data, heap and RSS limits were preserved.

### Final regression coverage

- Hosted-save tests retain identity, revision and caller-mutation checks.
  Project-only and dataset-only remote edits are independent cases; changing
  both at once could hide an omitted dataset conflict check. The suite owns
  cleanup rather than individual cases silently deleting sidecars.
- The cache-refresh case covers ordinary and failed-statistics saves using
  equal-size graph edits with the original timestamp. It asserts the returned
  graph and warm routing index, so metadata revalidation cannot conceal missing
  invalidation. A one-off local probe disabled only the failing-save invalidator;
  the graph assertion failed as intended, then passed after restoration. The
  probe is ignored, not a permanent implementation-mirroring test.
- Four backup-status cases use only private control storage and valid metadata.
  Archive cases retain real source trees, fingerprints and payloads. Distinct
  Windows sharing, durability, writer-order and restart cases remain intact.
- The existing isolated SQLite serving scenario exercises facade save,
  publication, divergent published/latest execution and unpublish. Its parent
  checks that retained legacy files stay unchanged. Direct-adapter tests alone
  do not substitute for this routing coverage.

### Validation and limits

| Check                                                                         | Result                                                                                                                                                                                                    |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Full maintained API command on Node 24.22.1, with prebuilt rehearsal children | 1,902 tests: 1,896 passed, zero failed, six platform-specific skips on Windows; about 21m 35s. Includes the repaired background preparation, SQLite serving and three Windows overlapping-reader cases.   |
| Final test-only maintenance on unchanged production code                      | Three affected suites: 41 passed on Windows. The strengthened cache case was rechecked after its final change and after the mutation probe. Linux: 40 passed, only the Windows reader case skipped.       |
| Real managed serving                                                          | `test:async-managed` passed against disposable PostgreSQL/MinIO: publication policy, bundles, actual endpoints, async completion and durable recordings.                                                  |
| Browser compatibility                                                         | Selected existing headless observers passed. Hosted Save As passed against disposable PostgreSQL/MinIO, proving separate copy identity, a subsequent in-place save and unchanged source contents.         |
| Source/build checks                                                           | API compilation on Node 24.22.1; root style tooling on Node 22; import/repository boundaries, test manifests/style, migration ledger and documentation checks passed. No import-debt allowance was added. |

The full API result supersedes earlier unsuccessful runs. Subsequent changes
were test-only cleanup and documentation; their affected suites were rerun
instead of repeating unchanged recovery scenarios. The local Linux container
ran as a non-root user with networking disabled and the checkout mounted
read-only. Its removal, browser-fixture container/volume cleanup and listener
shutdown were verified. Detailed local logs and diagnostic scripts remain
ignored under `artifacts/workflow-storage-routing-20261114/`; repeatable CI
prevention notes stay in the ignored `ci-pre-push.local.md`.

Paired local HTTP measurements used Node 24.22.1, one deterministic Text graph,
recordings disabled, complete-response assertions, 20 warmups and 200 measured
requests per route, without competing validation jobs. Both runs had 200/200 warm
cache hits and no request failures.

| Local filesystem route | Baseline p50 / p95 | Refactor p50 / p95 |
| ---------------------- | ------------------ | ------------------ |
| Published              | 1.898 / 2.380 ms   | 1.857 / 2.375 ms   |
| Saved latest           | 1.819 / 2.621 ms   | 1.682 / 2.393 ms   |

Cold storage initialization was about 102/108 ms, excluding module loading;
first published requests were about 35/32 ms. These single local samples showed
no warm-path slowdown for this fixture. They do not establish production latency,
capacity, total process startup or a production speedup. No endpoint storage IO,
graph serialization, awaited recording work or per-run resource construction was
added. This work has not run a cloud qualification or production deployment;
normal image/CI and release validation remain separate.
