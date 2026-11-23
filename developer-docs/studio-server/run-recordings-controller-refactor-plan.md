# Run recordings controller refactor and verification

Status: implemented and locally verified against `develop` baseline `8ff38fb72`
on 2026-11-24. The design below remains the
preservation contract. No deployment or performance improvement is claimed.
Latest acceptance after the adjacent audit: 94 browser cases passed under the
normal local CI configuration, plus four focused headless repo-runner probes.

## Comparative assessment against the committed version

This change improves the recordings frontend over `8ff38fb72`: the two
confirmed count/continuation defects below are fixed, and query loops and child
loading now have explicit owners. The parent still coordinates their lifetimes
and deletion; the hooks are not independently mounted controllers. This is a
bounded maintainability improvement, not a claim that the whole server or its
production deployment path has been newly qualified.

The extraction increases combined runtime source from 805 to 1,002 lines,
including blanks and comments, while reducing the parent to 401. The query hook
also exposes a broad state/command interface. That is a real maintenance cost:
adding a cross-owner feature still requires reviewing the parent's deletion and
reset sequence. Smaller files alone are not evidence of lower complexity, and
adding more coordination abstractions is not justified by this review.

A source comparison confirms all 44 public return members retain their names
and order. The moved progress and decrement helpers retain their implementation,
parameter types and return types. A fresh in-memory comparison using the same
focused TypeScript project for the committed and current controller reports
exactly the same three table diagnostics; all three current controller modules
are included. Evidence is `audit-controller-equivalence.json` under the ignored
verification directory below. This establishes no new diagnostics, not a clean
typecheck: normal checked-in projects still do not cover this dashboard, and the
focused project/lint setup is local. A maintained dashboard typecheck and the
existing `react-window` typing errors remain follow-up work.

The 94-case suite exercises the built frontend with mocked recording responses;
the 90-case characterization run against the original controller is the behavior
baseline. These checks support the extraction and its two explicit bug fixes.
They do not establish live API, PostgreSQL, hosted CI or production acceptance.
The earlier 301 web-package tests were run at the extraction checkpoint; later
reviews reran the affected browser, lint/type and structural checks. This
assessment found no additional demonstrated runtime regression and required no
further runtime change.

## Objective and scope

Make changes to recording queries and family loading local to their owners,
without changing the Run recordings modal's behavior or public controller
interface. The main concern is coordination between concurrent reads and
confirmed deletions, rather than the controller's approximately 806 lines.

Baseline owners and contracts (before extraction):

- [useRunRecordingsController.ts](../../packages/studio-server-web/dashboard/useRunRecordingsController.ts)
  owned session initialization, catalog reads, root browsing/search, children,
  filters, counts and deletion reconciliation.
- [RunRecordingsModal.tsx](../../packages/studio-server-web/dashboard/RunRecordingsModal.tsx)
  owns rendering, family expansion, input-path history integration and replay
  opening. Its controller session is active while `isOpen || isRetained`.
- [useRunRecordingsModalState.ts](../../packages/studio-server-web/dashboard/useRunRecordingsModalState.ts)
  distinguishes temporary dismissal from explicit close and project inspection.
- [workflowApi.ts](../../packages/studio-server-web/dashboard/workflowApi.ts)
  owns existing catalog, runs, child metadata and deletion HTTP calls.
- [Recording search performance and scope](recording-search-performance.md)
  describes the user-visible search, count, hierarchy and lifecycle contracts.

Extract child loading first and run queries/search second. Keep catalog requests
independent in the existing controller; their cancellation/identity guard is
already small and separate. Keep the cross-owner deletion sequence there too.
A third catalog hook or a separate deletion coordinator is unnecessary for this
refactor.

No modal layout, replay behavior, API signature, request encoding, recording
format, permission check, retention policy, database/schema, storage or deployment
change belongs in this work. Preserve existing fresh server access checks and
`no-store` reads. Add no query library, reducer framework, cache, event bus,
prefetch, retries, parallel search batches or dependency. Do not combine this
extraction with incidental behavior fixes; a reproducible defect needs a separate
decision and regression before changing the preservation contract.

## Lifetimes and behavior that must remain intact

| Operation or boundary       | Required behavior                                                                                                                                                                                                                                                                                              |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fresh session               | Initialize the reset generation and starting project before reads. A closed, unretained modal issues no recordings reads. Use project ID, not project object identity, in the session key. Mask results from an uninitialized replacement session.                                                             |
| Temporary dismissal         | Backdrop dismissal and successful replay opening retain the session, including pending reads, search results, filters and expansion. Reopening does not itself reload.                                                                                                                                         |
| Explicit close              | End the session, stop its search and reject late completions. A later ordinary opening starts on Any; Inspect recordings supplies a new project's initial selection.                                                                                                                                           |
| Refresh                     | Keep the currently selected project and catalog options while new reads start. Reset page to 1, page size to 20, outcome to All, drafts to `$` / `==` / empty, remove the applied input filter and collapse families. Preserve dialog identity/focus and persistent path history.                              |
| Catalog completion/retry    | With the selection unchanged, update catalog/options and its own loading/error state without restarting queries, clearing edits or collapsing families. An ordinary selected project disappearing from the catalog legitimately falls back to Any and replaces the query. Apply does not wait for the catalog. |
| Project availability        | Any works before/without a catalog. Preserve the synthetic entry for an explicitly inspected project missing from the catalog. After its last deletion that project stays selected; an ordinary missing selection falls back to Any.                                                                           |
| Replacement run view        | Project, page, page size, outcome, applied-filter identity, refresh or session changes replace the root query and its child loads. Reject old success, failure and finalization. Appending matches to the same progressive search is not a replacement view.                                                   |
| Apply / hide / clear / stop | Apply preserves its boolean result for path-history integration. Hide removes the applied filter but retains drafts; Clear resets drafts; Stop retains the applied filter, partial matches and last progress. Preserve existing guards, messages and button availability.                                      |
| Child loading/retry         | Load metadata only, independently of root input/outcome filtering. Publish a complete validated family, never a partial successful family. Child errors and retries cannot overwrite root-search errors or restart root matches.                                                                               |
| Deletion                    | Serialize mutations within a view. Keep the existing confirmation and DELETE request. An acknowledged deletion is reconciled before subsequent reads and remains reflected if they fail. Late completion from a replaced view cannot update it or clear a newer deletion's pending state.                      |

Counts are deliberately different quantities:

- Catalog totals count recordings and can be stale or unavailable. Unavailable
  is `null`, not an invented zero. A real zero remains zero.
- Ordinary `totalRuns` is the authoritative family pagination total. A loaded
  child does not consume a page slot. Never clamp a pending page using a stale
  catalog or decrement its family total as though every deletion removed a slot.
- Input matches count root results; displayed children do not increase matches
  or search progress. Prefer matching response scope counts over catalog estimates.
- Preserve cumulative progress and its unknown-denominator behavior. On scanner
  exhaustion, use its analyzed count as today; a legacy response lacking both
  counts and cumulative analysis must not manufacture a known denominator.

## Ownership boundaries

Use existing dashboard naming conventions and keep the dependency graph one way:
the controller imports the owners; neither owner imports the controller/modal.

| Owner                                    | State and work                                                                                                                                                                                                                                       | Explicit exclusions                                                                                       |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Existing `useRunRecordingsController.ts` | Session key/readiness and reset order; selection/initial project; refresh token; catalog response/latest ref/request identity/retry; shared view generation; deletion token and sequence; derived public counts and unchanged return facade.         | No child pagination loop or progressive root-search loop.                                                 |
| New `useRecordingSubRuns.ts`             | Child rows, per-root load states/errors and pending controllers; root selection/context; bounded pagination and response validation; family merge; child-specific deletion reconciliation.                                                           | No catalog, root query, confirmation, replay, expansion state or independently advancing view generation. |
| New `useRecordingRunsQuery.ts`           | Root page, related scope counts, query loading/error, pagination/outcome/filter state and actions, applied matches, search status/progress and search cancellation; root browse/search request mechanics and query-specific deletion reconciliation. | No catalog fetch, selection policy, DELETE transport, child state or modal session policy.                |

Keep the existing small effect subscriptions in the controller in their current
relative order during the extraction: session initialization, independent catalog
loading, selection pruning, latest-catalog synchronization, root-view replacement,
scope-count synchronization and authoritative page clamping. The new hooks hold
state and expose commands; they do not add competing automatic query/reset
effects. This avoids making correctness depend on the order in which new hooks
mount or clean up. Keep both owner hooks mounted unconditionally with the
controller; do not key/remount them by query, project or modal visibility.
Returning no modal markup during retained dismissal does not end either owner.

Expose read-only state and narrowly named lifecycle/reconciliation commands.
Retain ordinary setters where they are existing user controls in the public
facade. Do not pass a bag of raw result setters, catalog state, or AbortControllers
between owners. Commands used by lifecycle effects must be stable; commands
starting a read receive that operation's immutable query snapshot explicitly.
Do not depend on an entire newly allocated hook result object in an effect.

Only commands used by effects/reset callbacks require stable identity. Keep
event handlers dependent on current render inputs where they already are; do
not add latest-value refs, memoized owner objects or a general command dispatcher
to make every handler stable. In particular:

- The parent's reset callback delegates to a stable query reset command. It must
  not acquire dependencies on drafts, results, loading or selection, which would
  rerun session initialization and erase user work.
- A thin parent Apply wrapper retains the active/ready/deletion admission check;
  the query owner retains the searching/path checks and boolean result. The
  query hook does not need to understand modal sessions or own deletion state.
- The child handler uses current primary rows/project when starting a request;
  its reset/abort/reconciliation commands stay stable independently of those rows.
- Keep scope-count synchronization as a narrow metadata operation. A continuation
  omitting `scopeCounts` must retain the preceding related counts, not clear them.

Move `getNextInputSearchProgress` with the query owner. Keep catalog count lookup
in the parent: the query receives an initial number/null, not the catalog object.
Move only the existing shared decrement calculation, `countsAfterDeletingRun`,
to `recording-run-counts.ts` for catalog and query reconciliation. Preserve its
generic return type, extra fields and clamping; add no general utilities layer.

### View ownership and cancellation

Retain the existing shared version ref in the parent. Child requests capture its
value; deletion also captures a unique mutation token. Catalog requests continue
using their separate AbortController identity. Root browse/search retains its
effect-local cancellation flag, signal and search-controller identity checks.
Do not replace these distinct checks with one global request counter.

The parent root-view effect keeps this sequence:

1. Require an active, initialized session and advance the view generation.
2. Abort/clear previous child loads, clear child rows/status/errors and related
   scope metadata, and invalidate the old deletion token/pending indicator.
3. Start the query owner's browse/search with the captured project, page, size,
   outcome, applied filter and initial available-count snapshot.
4. On cleanup, mark the root request cancelled before aborting it, abort pending
   children, invalidate the captured generation only if still current, and clear
   the search ref only if this request still owns it. Cleanup is synchronous and
   repeat-safe. Preserve these guards without adding a staged cancellation API
   or callbacks solely to reproduce the order of independent abort calls.

The query start command returns its own cleanup closure. It must not expose a
controller for the parent to manipulate. Read the initial count from the latest
catalog ref at query start. Catalog responses, workflow options, child rows and
newly appended primary rows stay out of the root effect's replacement inputs.
Preserve the applied filter object's identity as a replacement trigger: deletion
currently clones that object to restart a root search with identical values.
Do not replace this dependency with structural JSON equality. The modal's
existing serialized hierarchy scope is separate: restarting an identical filter
does not itself change that scope or prescribe a new expansion policy.

Distinguish child commands for replacement/reset, aborting pending work, and
confirmed-deletion reconciliation. Replacement clears loaded families; a
deletion aborts pending requests and changes loading entries to retryable failed
entries while retaining/reconciling completed data. Do not implement both using
one unconditional clear operation. Likewise, do not make Stop or catalog Retry
call the broader session reset.

Keep current reset timing: session reset clears the catalog; Refresh retains it.
The existing root-view effect clears children, rather than adding an earlier
clear in every reset handler. No deferred starts, timers or extra cleanup effects
should be needed to make the extracted owners agree.

### Query and child request contracts

The query owner has one root-page request helper for ordinary reads, progressive
reads and post-deletion refreshes. Keep `includeSubgraphRuns: true` and
`groupByRoot: true`, existing statuses, cursors and signal placement. Preserve
sequential search reads and the current batch-size predicate
`nextCursor === 0 && !nextAfter`: normal initial discovery uses the selected page
size and continuations use 100. Do not replace the predicate with a batch counter
or strengthen cursor/token validation during this extraction.
Keep per-search ID deduplication, response `unsearchableRuns` carry-forward,
scope-count handling, opaque-token/numeric-cursor fallback and the current
non-advancing-continuation error. Do not add sorting or global deduplication to
the facade's `[...primaryRuns, ...subRuns]` assembly.

The child owner retains the exact anchor priority: explicit `familyContext`,
otherwise the sole primary, otherwise a project subgraph anchor. Preserve
`project` versus `all` context for subgraph anchors. Requests stay keyed by root
recording ID, with one pending request per root and the same duplicate-complete
guard. Preserve validation of response recording/page, nonnegative safe-integer
total, stable total across pages, child surface/correlation, unique progress and
final completeness. Keep ID-based family merging, current error text and
identity-checked removal from the pending map in `finally`.
Capture the chosen root, context and generation before the first await; later
primary-row appends must neither retarget nor reset that in-flight family load.

### Deletion remains an explicit cross-owner sequence

Keep this orchestration visible in the parent; use domain reconciliation commands
inside the owners rather than reaching into their setters:

1. Confirm and capture the current query/selected project, visible run, view
   generation and unique deletion token. Stop progressive search, preserving
   partial results; set the existing pending/loading/error state.
2. Await the existing DELETE without adding a cancellation signal. A browser
   cancellation or replacement view cannot roll back a server-side deletion.
3. If the mutation still owns the view, abort the older catalog snapshot. Before
   any refresh await, reconcile the confirmed deletion in query, children and
   catalog using the original count and scope conditions.
4. Remove the ID from matched/page/child rows. Root deletion also removes its
   displayed same-correlation descendants; child deletion retains siblings.
   Clear invalid root-anchor scope membership even if the next read fails.
   Leave ordinary family `totalRuns` for the authoritative refresh to calculate.
5. Reload catalog through its existing guarded loader with `reportError=false`.
   Respect both mutation ownership and a `null` result from a superseded load.
   Preserve ordinary-selection fallback and the inspected-project exception.
6. For filtered results, restart the same applied search after root deletion;
   child deletion does not restart it. For ordinary results, fetch the captured
   page. If deletion emptied a now-invalid last page, update the page once and
   let the existing page effect own its one replacement request.
7. Guard success, errors and `finally` with both captured generation and mutation
   identity. Preserve the confirmed-delete refresh-failure message and local
   deletion evidence. Old completion must not unblock a newer mutation.

The implemented post-delete page boundary separates reading and acceptance:
`readPageAfterDeletion` clears the old page and returns the request promise
without publishing its completion. The parent awaits it, checks `isCurrent`,
then calls synchronous `acceptPageAfterDeletion`. This retains the original
await sequence without hiding writes inside an asynchronous helper. Fetch errors
propagate to the parent's guarded mutation error path; no owner `catch/finally`
can clear a newer mutation's state. The manual refresh and DELETE still have
no signal, as distinct from the effect's abortable browse request.

Preparing deletion aborts/clears the progressive search ref before setting its
loading state. Its old search `finally` must not clear deletion's loading state.
Query completion remains separate from the parent's deletion ID/token; only the
current mutation may finish that combined operation. Reconciliation uses the run
captured before DELETE, including its existing optional/absent-metadata handling,
rather than looking it up again after an await.

Preserve count clamping and the existing distinctions between the deleted
recording's own workflow, selected related scope and root-only input scope. Do
not consolidate these into a blanket decrement. The parent owns which steps run;
each owner owns how its own state changes.

## Implementation sequence and review checkpoints

### 1. Establish the behavior baseline

- Run the current complete modal suite against a fresh build and record its
  result and revision before moving code. Discovery on 2026-11-24 found **83
  tests in one file**; discovery alone is not an acceptance pass. Historical
  counts elsewhere in the docs describe earlier revisions.
- Run existing web pure checks and establish the current typecheck/lint baseline.
  The web package has no general `tsconfig.json`, and the hosted App configuration
  includes only selected dashboard modules, not this controller. Use an ignored
  temporary configuration extending App's browser compiler options with explicit
  modal/controller roots, browser declarations and Core/Evaluations references.
  Include new owners transitively and compare the same check before/after; do
  not introduce a permanent broad typecheck configuration as refactor scope.
  Resolve browser type libraries from the App workspace under Yarn PnP; a config
  under `artifacts/` otherwise resolves them as root-package dependencies. Root
  ESLint's configured projects also exclude this dashboard: use the same focused
  project in an ignored ESLint override that imports the existing root rules.
- Add only the targeted characterization below that is missing from the current
  fixtures. Run it on unchanged production code first. Investigate a failure
  rather than silently changing the baseline behavior.

Exit: baseline evidence separates existing failures from extraction regressions,
and the new checks establish observable behavior rather than hook internals.

### 2. Extract child-family loading

- Move child state, pending-map ownership and the complete handler into
  `useRecordingSubRuns.ts`, initially preserving the loop and error boundaries.
- Wire parent view replacement/cleanup and confirmed deletion to the distinct
  child commands. Pass the current primary rows, selected project and access to
  the parent generation without introducing another epoch or query dependency.
- Preserve the controller's existing child handler/state/error exports and the
  modal's expansion ownership. Progressive row append must retain loaded families.
- Run focused child/race/deletion browser cases plus existing hierarchy tests.
  Update ownership notes with the actual completed slice.

Exit: the parent has no direct child state setters or pending-map manipulation;
the child owner does not fetch roots or catalog. Validate this slice before the
next extraction so regressions remain attributable.

### 3. Extract root browsing and input search

- Move root/query/filter state, request helper, progress math, read loops and
  filter actions into `useRecordingRunsQuery.ts` without rewriting their logic.
- Keep the parent's existing effect boundaries and dependency values. Replace
  only the loop body with the stable start/cleanup command; preserve read/reset
  ordering, related-count synchronization and authoritative page clamping.
- Adapt deletion to explicit query commands for stopping/preparing, local
  reconciliation, post-catalog query refresh and guarded completion. Keep DELETE,
  selection fallback and multi-owner orchestration in the parent.
- Check command identity and every guard after an await before running the full
  suite. Do not add a catalog hook, separate mutation hook, new query key scheme
  or additional reset effects to make the extracted state cooperate.
- Preserve every public return member, readiness/loading mask, nullable count,
  handler result and setter meaning. Avoid modal/table changes unless required
  solely to retain the existing facade.
- Run focused query/progress/session/deletion cases and web pure tests. Check
  request counts as well as results so accidental duplicate fetches are caught.

Exit: ordinary and progressive reads have one owner; the parent coordinates
lifetimes without manipulating query result setters. No catalog response or
owner-object identity has become a query replacement dependency.

### 4. Review the integrated result and document it

- Review each `await`, error path and `finally` against the ownership rules;
  check old-view deletion, root/child distinction and failed-refresh behavior.
- Remove obsolete imports, moved helpers and duplicate reset/reconciliation
  branches. Do not retain unused compatibility wrappers or generic abstractions.
- Run final validation below. Update this plan's status/results, the ownership
  paragraph in [architecture](architecture.md), and the relevant lifecycle notes
  in [recording search](recording-search-performance.md). Add a concise entry to
  [refactor history](refactor-history.md) after implementation is verified.
- Keep a reviewable commit per completed extraction when committing is requested.
  Read the optional Git-ignored `ci-pre-push.local.md` before commit/push and
  apply relevant checks. Private release/operator artifacts stay ignored.

## Acceptance coverage and targeted gaps

Use the existing
[run-recordings-modal.spec.ts](../../packages/studio-server-web/playwright-observe/run-recordings-modal.spec.ts)
and its isolated route fixture as the integration oracle. Preserve all current
cases, including replay cases that consume the unchanged facade.

| Contract                  | Existing coverage to retain                                                                                                                                                                                                                                                                                       |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Independent catalog/query | Controls and filtered results while catalog/browse are held; catalog failure/retry; typing while options arrive; late opening catalog after deletion; unknown totals.                                                                                                                                             |
| Session and refresh       | Closed-session idleness; pending/completed retained reopening; fresh Any after explicit close; Inspect initialization/final deletion; Refresh keeps changed project, resets defaults and rejects older reads.                                                                                                     |
| Progressive query         | Immediate count-free continuation; analyzed/available progress; Stop keeps progress; old stopped batch versus new search; scroll retention; first/continuation batch sizes; unsearchable-warning carry-forward and malformed-artifact error.                                                                      |
| Child families            | Empty family; ambiguous/context anchor; all child pages independent of root filters; 151 descendants without page-slot consumption; late child versus replacement filter; retry; stopped root error preservation; append retains expansion; repeated-page/changed-count/incomplete/unrelated-child rejection.     |
| Deletion                  | Failed DELETE interrupts search without discarding matches; confirmed root/child deletion remains after refresh failure; cross-project family membership; Any counts; serialization; old success/failure versus replacement view; inspected project versus ordinary fallback; last-page replacement exactly once. |
| UI consumers              | Path-history behavior, keyboard/focus, desktop/narrow layout, real scrolling, replay loading/failure/serialization and artifact download.                                                                                                                                                                         |

Add narrowly scoped characterization before the relevant extraction:

1. **Child request identity across replacement.** Extend the held-child fixture
   with Refresh followed by a new load of the same root. Observe cancellation
   of the old browser request, hold the new request, then finish the old route
   handler. Verify there are no old rows/errors, the new load remains pending,
   and only its response completes the family. Existing filter replacement
   exercises a different root; this checks reuse of the pending-map key. Audit
   the identity-checked `finally` directly: a late server/mock-handler response
   is not evidence of a late client finalizer after fetch has already aborted.
   Reuse the existing `beforeRuns` gate and distinguish attempts for that root;
   do not gate every child attempt behind the same promise.
2. **Search continuation validation and deduplication.** Use route responses to
   exercise a repeated opaque token and a missing/non-advancing numeric fallback
   while `hasMore=true`. Require the existing stopped/error behavior, retained
   partial rows/progress and no further continuation. Include a valid advancing
   sequence with a repeated recording ID across batches and verify one match.
   Normal continuation and malformed-artifact tests do not assert these branches.
   Add at most one response-transform option beside `transformSubRunPage` in the
   existing fixture, shared by these cases. Keep scripted responses finite and
   observe the visible stopped/complete state before counting requests; cap and
   report unexpected requests so a broken loop cannot flood the test. Avoid a
   network-idle wait while streams exist.
3. **Replacement during an acknowledged deletion's refresh.** Extend the existing
   deletion race fixture to hold the catalog read after DELETE has succeeded,
   rather than only holding DELETE itself. Switch project, start a new deletion,
   and settle the older refresh. Verify the old mutation cannot fetch its captured
   root page, publish a query error or clear the new pending state. A catalog
   response may still update the independent catalog if it owns that request;
   the mutation's permission to continue is a separate check. Cover refresh
   success/failure with the existing race fixture, not another modal bootstrap.
   Install a catalog route override using `recordingCatalogRoute`; the fixture
   has no `beforeCatalog` option. Hold the second DELETE before it starts its
   own catalog refresh so it does not supersede/abort the old catalog load that
   the test intends to settle. The project picker is available during deletion;
   Refresh is disabled, so it is not the view-switch action for this race.

Catalog Retry is rendered only for a catalog error, which a new load clears.
Do not invent a Retry-during-deletion action or expose controller internals to
test an unreachable UI sequence. Retain the superseded loader's `null` handling
and verify it in the source review alongside existing catalog replacement tests.

Use response gates, recorded request counts and observable browser settlement,
with all gates released in `finally`. Waiting for a route handler alone is not
proof that React consumed its response. For ignored old responses, cross an
observable completion/render boundary before negative assertions. Avoid new
fixed sleeps, provider calls, live database dependencies, duplicate happy-path
cases or a hook-testing framework. Keep test contexts/data isolated and reject
unmatched API requests through the existing hosted-editor bootstrap.
Extend/parameterize the existing race cases at these await boundaries instead of
duplicating them for every project/filter/session combination. Add no artificial
client-finalizer seam or Strict Mode harness for this move; inspect cleanup
idempotence and retain the existing session browser regressions.

The existing
[hierarchy](../../packages/studio-server-web/tests/recording-run-hierarchy.test.ts)
and [input-path history](../../packages/studio-server-web/tests/recording-input-path-history.test.ts)
pure tests remain useful. Add a pure test only for a nontrivial extracted
calculation not adequately exercised through the modal; do not test trivial
state forwarding or mirror every helper implementation. The web test script
uses an explicit file list, so register any genuinely needed new test there.

## Validation and completion criteria

For implementation, use the repository-pinned Node/Yarn environment. Build before
browser verification so tests cannot consume an old bundle. Finish root style's
asset/build preparation before final type/build checks that consume those assets.

Suggested final checks from the repository root:

```powershell
yarn test:style
yarn studio-server:verify:web-pure
yarn studio-server:verify:test-style
yarn workspace @valerypopoff/rivet-app exec tsc -p tsconfig.hosted-development.json --noEmit
yarn workspace @valerypopoff/rivet-studio-server-web run build
```

Also run the focused dashboard typecheck established in step 1. Keep its temporary
configuration and before/after diagnostics in ignored validation artifacts; record
the exact invocation in the implementation results. The App command above is a
consumer check and does not substitute for checking the modal/controller roots.

The plan review verified a usable setup under
`artifacts/recordings-controller-plan-review-20261124/`: a config extending App's
compiler options includes the modal/controller, web SVG declarations and App
ambient declarations, and resolves the inherited type libraries from App's
workspace. A small ESLint override changes only project coverage and imports
the repository rules. Both targets are present in the TypeScript program;
typed lint passes for them. The actual `tsc --noEmit` command reports three
baseline diagnostics in `RecordingRunsTable.tsx`: missing `react-window`
declarations and the resulting implicit `any` parameters `index` and `data`.
There are no configuration-resolution errors or diagnostics in the controller
or modal. This is a focused baseline, not a successful full typecheck.

Recreate that setup when implementing; the ignored files are not portable
repository dependencies. Use the same compiler options, declarations and rules
for before/after comparison. Extend lint project coverage for any changed test
file as needed; do not disable typed rules to avoid a parser-project error. A
nonzero baseline must be reported separately from passing required tests/builds,
and missing type libraries are setup failures, not baseline source diagnostics.

Use the required headless repo browser runner for focused checks after each
extraction, against an owned loopback preview of that build. Use a free port and
the existing Chromium installation. For example, this selects catalog, child,
deletion-serialization and refresh regressions:

```powershell
# Start the owned preview in a separate process/terminal, for example:
yarn workspace @valerypopoff/rivet-studio-server-web run preview --host 127.0.0.1 --port 5174 --strictPort

# In the test process:
$env:PLAYWRIGHT_HEADLESS = '1'
$env:PLAYWRIGHT_SLOW_MO = '0'
$env:PLAYWRIGHT_BASE_URL = 'http://127.0.0.1:5174'
yarn studio-server:ui:observe run-recordings-modal.spec.ts --grep "catalog failure|late child response|deletions are serialized|[Rr]efresh"
```

Do not use an unrelated running Docker stack or an older deployed bundle as
evidence for changed frontend code. Stop only the preview process owned by this
verification. On Windows, background launches use a hidden window and retain
process identity for cleanup.

For final acceptance, run the full modal file through its normal built-application
CI configuration with the preview port free and no shard-selection override.
There is no need to repeat the complete file under the observe configuration as
well; focused repo-runner checks plus this full pass cover both requirements:

```powershell
Remove-Item Env:RIVET_EDITOR_TEST_SHARD -ErrorAction SilentlyContinue
yarn workspace @valerypopoff/rivet-studio-server-web exec playwright test --config playwright.ci.config.ts run-recordings-modal.spec.ts
node scripts/checks/check-doc-links.mjs
git diff --check
```

The CI configuration starts its own preview, uses two workers, and includes this
file in the normal weighted editor shards. Preserve that inclusion, parallel
isolation and complete existing coverage. If an added case materially changes
lane balance, measure it before changing shard estimates; do not remove coverage
or shorten safety waits to obtain a timing result. No hosted speedup is expected
from this refactor; any later workflow claim needs matched hosted runs including
queueing and unchanged acceptance coverage.

Root `test:style` already runs file-tree and documentation-link checks. Reuse
those results for unchanged inputs; the separate doc-link command above is needed
only if result/ownership documentation was updated afterwards. Run each complete
final suite once for the final source; repeat only for a change, failure or
unresolved concern. Discovery/count checks do not replace executing that suite.

Run formatting/lint for touched TypeScript with repository settings. A Vite build
alone is not a full typecheck. Compare any baseline diagnostics explicitly; do
not hide regressions with casts, exclusions or skipped tests. Investigate browser
failures using `artifacts/playwright/` and retain the failing step and evidence.
No Kubernetes rehearsal or production mutation is required for this frontend
extraction. Hosted CI remains distinct from local verification.

Completion means all public behavior above is preserved, each read owner manages
its own asynchronous work, the parent has one visible cross-owner deletion
sequence, required tests/builds pass, type/lint comparison has no new diagnostics,
and docs report any unchanged baseline failures separately from passes. A feature
should be able to extend one owner's logic without reproducing
catalog/reset/cancellation rules elsewhere. File length alone is not acceptance.

Each extraction must remain independently revertible. If a preservation check
fails, correct or revert that slice before proceeding; do not weaken the test
or combine more lifetime changes to obscure the regression.

## Implementation and local verification

The implementation follows the two-owner boundary above. Catalog lookup stays
in the parent; only the unchanged count-decrement helper is shared. The modal,
table, replay flow, API, schema and storage code are unchanged.

| Check                                                                            | Result                                                                                |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Fresh baseline web build                                                         | Passed.                                                                               |
| Full modal suite against the original controller, including seven new cases      | 90 passed.                                                                            |
| Child extraction web build                                                       | Passed.                                                                               |
| Child extraction through the required headless repo runner                       | 28 focused browser cases passed.                                                      |
| Existing hierarchy and input-path-history tests                                  | 20 passed.                                                                            |
| Typed lint after both extractions                                                | Passed for the controller, new modules and browser fixture with the repository rules. |
| Root style/repository checks                                                     | Passed, including import boundaries, file-tree and documentation links.               |
| Web package tests                                                                | 301 passed: 262 TypeScript cases and 39 native development/production cases.          |
| Studio Server test-style guard                                                   | Passed.                                                                               |
| Editor shard coverage and two-worker budget contracts                            | Both passed; normal suite inclusion and weight are retained.                          |
| Hosted App consumer typecheck                                                    | Passed.                                                                               |
| Focused dashboard typecheck                                                      | Exactly the three unchanged table diagnostics described above; no new diagnostics.    |
| Final web build                                                                  | Passed.                                                                               |
| Final query checks through the headless repo runner                              | 16 passed.                                                                            |
| Complete final modal suite through the normal built-application CI configuration | 90 passed, with two workers.                                                          |

Evidence is under `artifacts/recordings-controller-refactor-20261124/` and remains
ignored. The Windows baseline completed all assertions but needed its verified
owned preview tree stopped for Playwright teardown to finish; it then exited
successfully. The child slice likewise required owned-preview cleanup. These
local process-settlement details are not application or hosted CI timing claims.
The final CI-configuration run also completed all 90 cases, required the same
verified preview cleanup, then exited zero. The query repo-runner check cleaned
up its owned preview and exited zero. No production rollout, real recording
mutation or hosted workflow run was performed.

### Follow-up code review

The review rechecked the moved read loops, cleanup, callback dependencies,
session reset, count ownership and each deletion await. It reproduced a defect
in the preserved reconciliation logic: after a continuation without scope
metadata, deleting a child invalidated the cached root count. The UI then showed
15 recordings as though they were roots, while completed progress still reported
13 roots. The failing browser artifact is under `review-red-browser/` in the
same ignored evidence directory.

The correction retains matching cached root counts for a filtered child deletion;
ordinary/root deletion still decrements the applicable scope, and the independent
catalog still records the removal. One shared inclusion condition controls cached
and page counts. The regression also checks Bad only, unchanged matches, no search
restart and the separate 15-recording catalog total. This is a confirmed display
correction, not an additional feature or a storage/access-policy change.

The request helper now lives at module scope because it captures no React state.
Its options derive from the existing API signature, and its mandatory grouping
flags remain fixed. This removes a callback hook, duplicated option fields and
two unnecessary dependency entries without changing requests.

Review validation: the rebuilt web application, typed lint, formatting,
test-style, file-tree/import-boundary and documentation-link checks pass. The
focused dashboard typecheck retains the same three table diagnostics with no
new diagnostics. All 91 modal cases passed through the required headless repo
runner against the corrected build, including the regression that failed before
the correction; its owned preview was cleaned up and the command exited zero.
Earlier complete web-pure, root-style and App consumer passes remain recorded
above; this follow-up reran the affected UI, source, lint and type gates.

### Initial plan completion audit

All four implementation stages and their required local acceptance work are
complete:

| Stage                                           | Completion evidence                                                                                                                                                                                                                                                                          |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Baseline and characterization                   | Original controller passed the complete 90-case suite, including the seven planned characterization cases.                                                                                                                                                                                   |
| Child-family extraction                         | Child state, controllers, pagination, validation and reconciliation have one owner; 28 focused browser cases and 20 hierarchy/path-history cases passed at that checkpoint.                                                                                                                  |
| Root query/search extraction                    | Query/filter state, request loops and reconciliation have one owner; the parent retains its public facade, session/catalog lifetimes and guarded deletion sequence.                                                                                                                          |
| Integrated review, documentation and acceptance | The follow-up count correction is covered by a regression. The latest built application passed all 91 cases through both the required repo runner and the normal two-worker CI configuration. The source, lint/type and documentation results above are recorded with their baseline limits. |

The final CI-configuration command exited zero after cleanup of its verified
owned preview. Its evidence is `browser-completion-ci.log` in the same ignored
directory. The earlier 90-case CI result records the initial extraction; this
91-case pass covers the subsequent correction and helper simplification too.
No runtime implementation or local acceptance item remains open. The three
unchanged table typing diagnostics remain the explicitly documented baseline,
not an unimplemented refactor step. No hosted CI run, push or deployment is
claimed.

### Adjacent reliability audit

The next audit traced the confirmed count bug into missing metadata, pending
reads and failed refreshes. The managed backend intentionally omits scope counts
after the first input-search response, so these are production-relevant lifetime
boundaries. The existing count regression now covers completed search, failed
catalog refresh, and a held final continuation aborted by child deletion. All
three passed before any additional runtime change: root/Bad only counts stayed
stable, catalog totals acknowledged the child removal, and root scanning did not
restart. The held response could not replace stopped progress or results.

A separate fault probe exposed an incomplete continuation guard. A response
sequence A → B → A bypassed the immediate-repeat check. The negative fixture
was capped at four batches to prevent a real request loop; the unfixed client
accepted the cycle and reported completion only at that cap, rather than the
expected stopped-search error. This establishes a client recovery gap under
malformed upstream responses, not a claim that the current server emits cycles.

The correction adds per-search opaque-token history and rejects any previously
followed token when `hasMore` is true. The same stopped/error path keeps partial
rows and progress. Tokens are not parsed, the numeric fallback check is unchanged,
and each replacement query gets independent history. There is no new timeout,
retry, scan limit, dependency or backend change.

The rebuilt application passes all four targeted probes through the required
headless repo runner, including the previously failing cycle. Typed lint,
test-style and file-tree/import-boundary checks pass, and the focused typecheck
still has only the three baseline table diagnostics. All 94 cases passed under
the normal two-worker CI configuration against the final bundle. The command
exited zero after its verified owned preview was settled. Evidence is under the existing
ignored directory in `browser-adjacent-before.log`, `browser-adjacent-after.log`
and `browser-adjacent-ci.log`.
