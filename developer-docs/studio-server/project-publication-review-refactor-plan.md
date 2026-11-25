# Project publication review ownership refactor

Status: initial extraction, follow-up reviews and test cleanup implemented and locally validated
on 2026-11-25 against runtime baseline
`develop` commit `1b96fb815ac758bb53d31948fb8f7db653ecdcf2`.
The original design and gates are retained below. The execution record at the end
distinguishes baseline evidence, completed local checks and future hosted evidence.

## Objective and boundaries

Remove duplicated browser publication checks and give reviewed publication state
one clear owner. Preserve supported behavior, error messages, request ordering,
fresh access checks, draft retention, revision requirements and modal lifetimes.
This is a frontend refactor. It changes no endpoint, server authorization rule,
publication transaction, stored format, recording behavior or execution path.

The governing references are [Refactor baseline and verification](../REFACTOR-BASELINE.md),
[Workflow publication](workflow-publication.md) and
[Published revision history](published-revision-history-plan.md).
The earlier [HTTP separation](publication-http-separation-plan.md) is complete;
its backend ownership is not reopened here.

Do not introduce a generic mutation framework, reducer, global publication store,
new cache, polling loop or a universal validator with command-mode flags. Retain
the public `useProjectSettingsActions` return shape and existing component props.
Keep the history panel's review lifetime separate from the settings review hook.
Keep the settings snapshot, user drafts and their dirty-value baselines together:
they form one reconciliation lifetime. Separate that owner from mutation execution
instead of adding cross-hook callbacks to synchronize the same data.

## What was verified while preparing this plan

- `useProjectSettingsActions.ts` has 731 lines, 13 state hooks, three refs and two
  effects. It mixes reviewed snapshots, draft reconciliation and mutation handlers.
- `ProjectSettingsModal.tsx` and that hook have identical email-draft parser
  bodies. The hook also repeats the returned-project/path/version checks in
  `reloadWebApps` and `acceptReturnedPublication`.
- History repeats snapshot consistency checks, but its acceptance rules are not
  identical. Restore validates the returned history entry and reviewed live
  address, and can adopt a returned draft revision without approving that draft
  for publication. Settings access/unpublish handling cannot do that.
- `publicationVersion.ts` already owns canonical decimal version validation,
  exact `+1` advancement with `BigInt`, and uncertain-response classification.
  It remains authoritative.
- Actual Playwright collection found **28 Project Settings cases and 10 history
  cases**. Collection passed; those 38 cases were not executed for this plan.
  The settings spec is absent from the current 45-spec editor CI selection;
  history is already selected.
- A read-only compiler probe of the action hook, form helpers, version helpers
  and history panel visited 300 source/declaration files and found one diagnostic:
  TS2322 at `useProjectSettingsActions.ts:112`, where unchecked indexed access
  gives the draft-carry result a `string | undefined` value type.
- Including the entire settings view in a probe based on the previous upgrade
  configuration pulled in 2,958 files through desktop presentation imports and
  produced 183 diagnostics. That is not a usable clean baseline or evidence of
  183 new runtime defects. Do not copy that configuration into CI.
- A further in-memory probe narrowed only the existing own-key-guarded `drafts[id]`
  read with `!`. The 300-file program then had zero diagnostics and emitted
  exactly the same JavaScript as the original. This demonstrates a type-only
  prerequisite; it has not been applied to the source. Keep the assertion local
  to the existing `Record<string, string>` own-property branch, with an explanation.
- A read-only extraction probe verified that the two settings returned-project
  predicates are identical after renaming their local variable. Sharing only the
  three snapshot field-agreement checks preserved values and thrown errors in
  480 representative predicate comparisons. This is targeted preparation
  evidence; it does not replace the complete browser characterization.
- `WorkflowLibraryModals.tsx` passes `onRefresh` as an inline function and keys
  the settings view by the tree row's `id`. Neither is a substitute for the
  stable project metadata ID. Depending on `onRefresh` or the whole project
  object in the new load effect would introduce repeat reads or draft resets.

No production code, tests, CI configuration or dependencies were changed during
planning. Compiler probes and test collection are preparation evidence, not
completed implementation or browser acceptance. The new boundary below replaces
the earlier six-state hook plus two draft-synchronization callbacks.

## Source owners and intended changes

All paths in the table are relative to `packages/studio-server-web/`.

| Owner                                                | Planned responsibility                                                                                                                          |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `dashboard/projectPublicationReview.ts` (new)        | Pure snapshot consistency and returned-publication identity checks; reuse `publicationVersion.ts`. No fetch, toast, state or timers.            |
| `dashboard/projectSettingsForm.ts`                   | Add the shared email-draft normalizer and move the existing pure dirty-draft merge here for focused tests. Keep endpoint/status helpers intact. |
| `dashboard/useProjectPublicationReview.ts` (new)     | One settings review session: snapshots, draft values/baselines, load/conflict state and explicit review/reconciliation operations.              |
| `dashboard/useProjectSettingsActions.ts`             | Preserve the public facade, validation, mutation busy flags, publication/access handlers and deletion lifetime. Delegate review-session state.  |
| `dashboard/ProjectSettingsModal.tsx`                 | Replace only the duplicate parser call/import. Preserve rendering, button conditions, tabs, history busy propagation and props.                 |
| `dashboard/WorkflowPublishedVersionHistoryModal.tsx` | Reuse the proven pure checks; keep its own fetch effect, review state, mutations, optimistic star/comment behavior and busy lifetime.           |
| `tests/project-publication-review.test.ts` (new)     | Small table-driven tests for shared predicates, email normalization and compatibility edge cases.                                               |
| `tsconfig.project-publication.json` (new)            | Maintained no-emit project for the moved logic, action facade, history panel and focused tests.                                                 |

Supporting changes are limited to the web package's test/check scripts, a narrow
ESLint project override, browser fixtures/specs, editor test registration and
owning developer docs. Add no dependency merely to move these functions.

The focused TypeScript project can follow the existing no-emit/Bundler/React
settings and Node/Vite types, but must select the actual owner roots explicitly.
Include the history panel: its own dependency graph is small enough. Do not claim
this checks the whole `ProjectSettingsModal` desktop dependency graph. Its small
consumer edit still needs the real build and browser verification below.
Keep imports one-way: views use the existing facade, the facade uses the session
hook, and both use pure helpers/types. The new hook must not import its facade or
a view. Pure helpers must not import React, `workflowApi.ts` or test fixtures.

## Behavior contract to capture before moving code

| Situation                                       | Existing result to preserve                                                                                                                                                                                                       |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Initial settings load                           | Clear old server data and web-app draft baselines; fetch once; adopt only a response consistent with the requested path and captured project identity.                                                                            |
| Valid response without sufficient review tokens | Preserve the current distinction between displaying coherent server data and authorizing a mutation. Missing tokens never become fabricated empty/default approvals.                                                              |
| Invalid snapshot                                | Clear review eligibility and retain the existing conflict/error behavior. An explicit review failure must not erase edited fields or adopt another project's data.                                                                |
| Explicit Review latest                          | Clear review first, read the web-app snapshot, await tree refresh, then apply that snapshot with draft preservation. A null/failed tree refresh cannot approve it.                                                                |
| Endpoint publish                                | Review the release first; then inspect dirty root/dependency IDs; require the existing missing-rollback confirmation; submit exactly once with the existing preconditions.                                                        |
| Returned publication                            | Same path and project, nonempty returned revision, and exactly one publication-version advance. A changed draft can update displayed server state but cannot silently become reviewed for another publish.                        |
| Web-app publish/access/unpublish                | Validate the returned project before the follow-up web-app read. Bind that read to the returned publication version and the previously reviewed draft. Preserve dirty values, update clean values and remove retired app entries. |
| History open/review                             | Read versions and the current project snapshot concurrently. Require current project ownership for all version rows and sufficient review tokens before enabling Restore.                                                         |
| History Restore                                 | Use the reviewed current endpoint address and project/publication preconditions. Validate the new current history entry, project identity, address and exact version advancement. Keep draft files and unsaved editors untouched. |
| Restore follow-up                               | Keep the restore busy state through `onRestored`, including its tree refresh and final `reviewLatestPublication` callback. A new row or a sent request alone is not settled completion.                                           |
| Lost/unreadable acknowledgement                 | Preserve `isUnconfirmedPublication` classification. Retire old approval, refresh through the existing path and require review; never replay the mutation automatically.                                                           |
| Other failures                                  | Preserve the differences between ordinary 4xx errors, publication-prefixed 409 conflicts, and uncertain transport/408/5xx outcomes. Do not globally invalidate or globally retain review for every error.                         |
| Background tree update                          | Preserve edited endpoint/web-app values and the current reviewed revision. Unrelated refresh cannot approve a newer draft.                                                                                                        |
| Replacement/close                               | Retain the current keyed modal mount, path/project-identity dependencies and stale-read cancellation. A late response cannot enter a replacement review.                                                                          |
| Delete                                          | Retain `useWorkflowLibraryActionLifetime`, namespace identity, confirmation, fully-unpublished checks and post-delete reconciliation. Do not route deletion through publication acceptance.                                       |

Also retain exact email behavior: split on newline/comma/semicolon, trim, lowercase,
discard empty entries, deduplicate in first-occurrence order. Keep invalid-email
validation and its messages where they currently belong. Do not change server
allowlist parsing or reuse this browser-draft helper for server authorization.

Two less obvious behaviors are also part of this contract:

- `applyWebAppSnapshot`, `acceptReturnedPublication` and `reloadWebApps` normally
  report rejected evidence through state/toasts and return without throwing.
  A mutation caller can still perform its existing tree refresh afterward.
  Do not change these methods to throwing validators or make callers skip that
  refresh on a new boolean result.
- Capture the submitted preconditions and payload at the same point as today.
  Completion checks use that captured token, not the latest token from a ref.
  Conversely, endpoint publishing intentionally calls `getDirtyProjectIds()`
  after awaiting release review; moving that read before the await misses edits
  made while the review was in flight. Preserve optional legacy release-review
  results and the existing `submitting` transitions/error classification.

## Extraction design

### Pure checks first

Move the current `publicationSnapshotFromProject` behavior without changing its
missing-value semantics. Extract the common returned-project predicate used by
`reloadWebApps` and `acceptReturnedPublication`.

For snapshot consistency, share the three field agreements between
`snapshot.project` and the response's project ID, draft revision and publication
version. Keep path, captured-owner, nonempty-token and canonical-version checks
at their existing call sites and in their existing order. History also retains
the check of every version row's owner. This smaller helper removes duplication
without inventing one validator for two different acceptance policies.
Document that this helper runs after the caller's existing project/path guard;
it is not a new general-purpose malformed-response parser.

Only the settings owner's two returned-project paths share the new returned
publication predicate. Leave History Restore's acknowledgement validation inline
and unchanged: it has a distinct returned-version/address/current-marker policy.
History's use of the existing version helpers is already shared. No helper should
normalize missing fields, replace current messages or catch an error that its
caller currently handles.

Move the identical email normalizer into `projectSettingsForm.ts`, replace both
call sites and delete both copies. Move `carryEditedWebAppDrafts` into that same
pure form owner so its type-only correction and dirty/clean/missing-key behavior
can be tested without mounting the action hook. Do not move unrelated slug
generation, formatting or status rendering just to reduce file length.

### One settings review-session owner

The new hook takes only `activeProject`, `isOpen` and `onRefresh`. It owns these
existing nine state values:

- `reviewedPublication`, `snapshotProject`, `publicationConflict`;
- `webApps`, `hasMainGraph`, `loadingWebApps`;
- `settingsDraft`, `webAppSlugDrafts`, `webAppAllowedEmailDrafts`.

Move all three existing draft-baseline refs, the initial-load effect and the
endpoint synchronization effect with that state. Move the current draft-change
handlers and private slug/email initialization functions without redesigning
them. The shared draft-merge and email-normalization functions remain pure.
Keep the endpoint-sync effect before the initial-load effect, and keep the
facade's existing deletion-lifetime hook ahead of the new session hook. Moving
ownership must not reorder effect cleanup relative to those existing lifetimes.

Move `applyWebAppSnapshot`, `reloadWebApps`, `reviewLatestPublication`,
`acceptReturnedPublication` and `refreshUnconfirmedPublication` with their exact
ordering and return behavior. Expose these existing operations, draft-change
handlers and one small `markPublicationChanged` command, rather than raw state
setters. Keep error presentation where the moved operation currently performs
it; a notification bus is out of scope.

The parent retains the four mutation busy flags (`savingSettings`,
`savingEndpointAccess`, `savingWebApps`, `deletingProject`), derived validation,
mutation handlers, confirmation/dirty-project checks and deletion ownership.
It continues to return the same explicit public field/handler list to the view.
Do not spread every internal method from the new hook into that public facade.

No draft-reset/adoption callback bridge is needed. Keeping the snapshot and its
draft baselines together preserves the existing synchronous update sequence and
avoids a second synchronization protocol. Across the two hooks, retain the
original 13 state hooks, three refs and two effects; moving them is not a reason
to add new state, effects or ref-backed copies.

The load effect retains dependencies on open state, the primitive path and
captured metadata ID through the existing stable snapshot callback. It must not
depend on the whole `activeProject`, the changing inline `onRefresh`, draft values
or new return-object identities. Explicit review operations can use the current
render's `onRefresh` without making it a load-effect dependency. Do not re-key the
parent modal or assume its tree-row key guarantees a new metadata identity.

Preserve the initial effect's logical `cancelled` flag; transport aborts or request
coalescing would be separate changes. Mutation requests are not canceled or
replayed by this extraction. Do not replace boolean loading/busy flags with a new
counter or tie the existing close/tab lock to `loadingWebApps`.

The history panel does not consume this hook. It retains its own state, effects,
optimistic edits, restore callbacks and navigation locks.

## Ordered implementation and gates

### 1. Establish a runnable behavior baseline

1. Recheck HEAD, worktree, package/runtime versions and applicable instructions.
   Keep private evidence under a new ignored `artifacts/` directory.
2. Inspect all functions above, the settings view, history callbacks, `workflowApi.ts`
   response validation and the shared DTOs. Preserve HTTP payloads and mutation
   headers exactly; `workflowApi.ts` is not part of the extraction.
3. Run the two complete browser suites against a fresh built frontend. Existing
   shared fixtures already use `mockHostedEditorBootstrap`; inspect remaining
   unhandled API calls before assuming they are completely isolated. Keep a
   rejecting fallback for mutations; never let a characterization case reach an
   ambient production or development API.
4. Record actual emitted cases, failures, request order/counts, per-case work and
   preview cleanup. Current collection is 38 cases, not a passing-run receipt.
5. Resolve the owned TS2322 diagnostic with a local, documented type narrowing
   under the existing own-property guards. Preserve indexed lookup/default
   semantics; do not add value normalization, change map keys or weaken compiler
   options to make it disappear. The verified in-memory candidate is the single
   guarded `drafts[id]!` read described above. Verify identical emitted JavaScript
   before applying it. This is a type-only prerequisite, not a runtime bug fix.
6. Establish the maintained focused no-emit check described above, including its
   actual resolved file list. Include it in the web test script and use its project
   for typed lint of moved owners. Start with existing roots; add new helpers,
   hook and tests as their files are introduced. Do not reference nonexistent
   planned files in the baseline check. New helpers/tests must not import
   presentation owners that pull in the desktop app.

**Gate:** both original browser suites run successfully, the focused typecheck is
clean, and any unrelated/transitive diagnostics are identified rather than hidden.
An actual behavioral defect needs its own reproduction and separate disposition
before redefining the comparison baseline.

### 2. Fill only the missing characterization coverage

Keep existing browser scenarios and assertions. Add targeted cases only where
the following seam is not already proven:

- Initial review delayed across close/reopen and same-path replacement; release
  the old response last and prove it cannot arm the new review. Test metadata
  identity changes even when the tree-row key stays the same.
- Draft edits plus unrelated parent rerenders, including a new inline `onRefresh`
  function, leave initial review request count unchanged and retain field values.
- Coherent display data without usable tokens cannot enable publication; malformed
  and mismatched responses preserve their current error/conflict behavior.
- Returned mutation advances a publication version while a follow-up snapshot
  advances again or changes the draft. Approval stays retired; edited fields stay.
- A successful mutation followed by failed refresh differs from an uncertain
  mutation. Assert actual request bodies/counts, continued tree refresh after
  rejected receipt validation, and current review eligibility.
- Restoration requires the returned new row's identity and completion of its
  follow-up callback. Keep the recently fixed restored-control wait; asserting
  an old row's endpoint/Current text cannot prove settlement.

Use held responses, explicit receiver acknowledgements and cleanup in `finally`.
Count requests by exact method/path and operation phase. No sleeps, force clicks,
shortened deadlines or blanket retries. Where controlled time is needed, remember
that installing Playwright's clock does not pause it, and freezing an unsettled
modal can strand its exit transition.

Create a coverage inventory against the existing 38 cases before adding tests.
Do not add a new browser case for a contract already established there. The
shared fixture seeds missing publication versions with `'0'`; malformed/missing
token cases must override the response after that setup so the fixture cannot
repair the fault they intend to test.

Specify pure-test inputs and expected results now, but add those tests with the
extracted helpers in step 3. Private helpers do not need temporary public exports
or committed source-reading tests merely to make the baseline pass. Cover the
shared agreement predicate, wrong returned identity/version, dirty/clean/removed
draft keys, and email separators/order/case. Keep `publication-version.test.ts`
as the version-codec owner; do not duplicate its whole matrix. Include own-property
keys such as `constructor`/`__proto__` for the merge helper. Expected results must
be independently specified, not computed by the helper being tested.

**Gate:** the added characterization passes against the original ownership. Save
that baseline before extracting the model or hook.

### 3. Extract pure policy and email normalization

1. Add `projectPublicationReview.ts` with the smallest predicates above.
2. Move the email normalizer and dirty-draft merge into the existing form helper.
3. Add the prepared pure tests and select them in the maintained web test command.
4. Update the action hook and history/view consumers while preserving each
   caller-specific branch, message, short-circuit and mutation sequence.
5. Run focused tests/typecheck/typed lint, the frontend build and both browser
   suites. Compare response acceptance and request counts with the baseline.

**Gate:** no React ownership changes yet; the helper-only slice is behaviorally
equivalent. Do not combine it with a validation-policy change.

### 4. Extract the settings review hook

1. Move the nine session states, three baseline refs and both effects together.
2. Move the existing draft-change/initialization functions with their state.
   Keep state updates in their original order; add no callback bridge.
3. Move review/reconciliation operations without changing awaits, caught errors,
   normal returns after validation refusal or captured precondition arguments.
4. Keep mutation handlers, `submitting` classification, dirty-dependency checks,
   confirmations, busy flags and deletion in the facade.
5. Confirm the parent still has the same public return surface and the history
   panel still has its independent owner. Verify the combined 13 states, three
   refs and two effects did not grow to synchronize the two hooks.
6. Repeat the focused and complete browser gates and compare the captured request
   sequences. Check that typing, parent rerenders and tree arrival do not restart
   the initial read or trigger extra network work.

**Gate:** all characterization passes with unchanged requests, messages, review
eligibility, draft values, locks and disposal behavior.

### 5. Put the missing settings suite into ordinary CI

The current editor selector has 45 specs in five required jobs, two browser workers
per job, a 12-minute test step, a 20-minute job limit and a 1,080-second per-shard
work-hint allowance. Its allocations are 985/985/985/980/980 seconds.

Register `project-settings-modal.spec.ts` in `scripts/ci/editor-test-shards.mjs`
using measured total case work, not a guessed zero weight or whole-file wall time.
The observe configuration records trace/video for successful cases too; do not
treat that timing as the final CI cost. Use its measured work only as an explicitly
labelled initial estimate, then measure this suite with the ordinary CI runner
and its failure-only artifacts before settling the weight. Keep serial scheduling
initially. History is already selected; do not register it twice. Adding the 28
existing settings cases changes the previous 502-case selection to 530 before
additional regression cases; actual final collection is authoritative.

Update `scripts/ci/ci-performance.test.mjs` for 46 specs, membership and exact-once
selection. Retain the 5% balance and 1,080-second allowance checks. Preserve five
jobs if the measured allocation fits. If it does not, stop and present the real
capacity tradeoff; do not silently remove tests, lower old weights, relax budgets
or create another worker/job. Change workflow YAML and its guard only if the final
capacity decision requires it, then run actionlint too.

List all five final selectors and compare their membership with the baseline.
The greedy assignment can move existing specs between lanes. Run every lane whose
membership changed, not just the lane receiving the new file, through the actual
CI configuration with its fresh-preview ownership and cleanup. Keep receipts for
each final membership; a focused new-suite pass does not replace those runs. Use
distinct ports if running lanes concurrently; finish build-mutating checks first.

After an authorized push, inspect all required hosted conclusions and measure
queue, setup, case work and total elapsed time. Added coverage changes CI workload;
local timing is not a hosted speedup claim.

## Verification commands and completion

Build dependencies in the repository's normal order before compiling consumers.
For the complete final checks, use the maintained commands:

```text
yarn test:style
yarn workspace @valerypopoff/rivet-studio-server-web run test
yarn workspace @valerypopoff/rivet-studio-server-web run build
yarn studio-server:verify:test-style
git diff --check
```

The new web check script should be named `check:project-publication`; wire the
focused test into the existing web `test` command. Root style owns workflow/shard,
import-boundary and documentation checks. Finish its build-mutating work before
browser runs. Run changed-file formatting and typed lint; reuse passing results
for unchanged inputs rather than repeating every suite after a documentation edit.

For baseline and extraction checkpoints, start an owned preview on a free port:

```text
yarn workspace @valerypopoff/rivet-studio-server-web run preview --host 127.0.0.1 --port 5174 --strictPort
```

In the verification terminal:

```powershell
$env:PLAYWRIGHT_HEADLESS = '1'
$env:PLAYWRIGHT_SLOW_MO = '0'
$env:PLAYWRIGHT_BASE_URL = 'http://127.0.0.1:5174'
yarn studio-server:ui:observe project-settings-modal.spec.ts published-revision-history.spec.ts --workers=2
```

For a final changed lane, stop that manual preview first, set
`RIVET_EDITOR_TEST_SHARD` to the actual final selector and run
`yarn studio-server:ui:ci`. The CI config owns its own preview; preserve
`reuseExistingServer: false`. Inspect failure artifacts under `artifacts/playwright/`
and verify automatic cleanup/port closure. Retain native deadlines and the Windows
process permissions needed by the runner's existing cleanup.

Completion requires all of the following:

1. Shared policy has one owner, without erasing the settings/history differences.
2. The review-session/draft state and mutation execution have explicit owners;
   the old public facade and view behavior remain compatible. No new callback
   synchronization layer, effects or network work.
3. Focused compiler/lint/tests pass, including the owned baseline type diagnostic.
4. All original and added browser cases pass, and final changed CI lanes pass
   without skips or retry-masked failures.
5. Standard CI selects the settings suite exactly once with measured capacity.
6. Update this record, `workflow-publication.md`, `refactor-history.md`,
   `ci-performance.md` and the developer-doc index with final ownership, actual
   test counts/timings and remaining hosted evidence. Keep private receipts ignored.

No backend benchmark, migration, Kubernetes rehearsal or deployment is required
for this frontend-only extraction. Preserve existing HTTP call counts and cold
versus warm behavior so the UI cannot increase workflow-endpoint or policy-store
load. Report implementation completion separately from any later hosted release.

## Implementation record - 2026-11-25

The delivered boundary follows the design: `useProjectPublicationReview.ts`
owns all nine review/draft state values, three refs and two effects. The action
facade retains four mutation flags, validation, release/dirty-project checks and
deletion. Its public field list is unchanged. A source-structure comparison
verified every moved declaration and both effects, their ordering, and the
unchanged mutation and History Restore handlers. The view's body differs only
in its use of the shared email parser; formatting changes are immaterial.

`projectPublicationReview.ts` owns the three pure publication helpers.
`projectSettingsForm.ts` owns the shared parser and dirty-field merge. Seven
focused tests cover token extraction, agreement versus admission, returned
publication identity/advancement, email normalization and dirty/clean/missing/
prototype-key drafts. The existing two version-codec tests retain their own
matrix. The local `drafts[id]!` typing correction emits identical JavaScript;
no assertion was broadened into an input cast or weaker compiler option.

The focused type project resolves 303 files and covers the session hook, action
facade, pure owners, history and focused tests. It intentionally does not pull
the entire desktop presentation graph into the hosted-web typecheck. The normal
frontend build and browser gates cover the unchanged settings view.

### Browser characterization inventory

| Contract                                            | Evidence retained or added                                                                                                                                             |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Initial load, close/reopen and late responses       | Added a held initial read released after reopening, editing and receiving a fresh review; the submitted body must retain the new revision/version and edited endpoint. |
| Missing or malformed approval tokens                | Added coherent responses with an empty draft revision or noncanonical version; display data must not authorize publication.                                            |
| Same-path foreign project                           | Existing replacement-owner case remains; pure checks also keep the tree-row id constant while changing metadata identity.                                              |
| Parent rerenders and dirty/clean fields             | Extended the existing two-app conflict review to assert no extra review reads during editing and exactly one explicit review read.                                     |
| Rejected returned receipt                           | Extended nonsequential-version coverage to require subsequent tree refresh while retaining zero extra publication reads.                                               |
| Concurrent saved drafts and publication versions    | Existing endpoint/background-tree, web-app publish/unpublish and incoherent-snapshot cases remain.                                                                     |
| Uncertain success, failed reads and draft retention | Existing lost/incomplete acknowledgement and failed-refresh cases remain.                                                                                              |
| Restore acceptance and busy lifetime                | Existing history cases require the new restored row's enabled control and follow-up review before navigation.                                                          |
| Release dependencies and deletion                   | Existing dirty-dependency-during-review, missing rollback, Main Graph, incoming references and deletion-lifetime cases remain.                                         |

The baseline's 38 cases passed before extraction. Three new cases bring the
focused selection to 41 (31 settings, ten history). The closed context fixture
permits the neutral dashboard bootstrap reads, rejects all other unhandled API
reads and fails on unhandled mutations. Scenario-specific page routes remain
authoritative; none of these cases uses the ambient local API.

Two preparation assumptions were corrected against the existing implementation:
an unchanged published endpoint correctly has a disabled Update button, so the
access-mutation case waits for the actual access control; and the library/editor
have independent tree reconciliation reads, so their combined count is not a
single settings-hook request. The regression requires continued tree refresh
and counts the independently owned publication reads exactly.

| Checkpoint                                    | Result                                                                            |
| --------------------------------------------- | --------------------------------------------------------------------------------- |
| Original 38 browser cases                     | 38 passed, 99.9s elapsed                                                          |
| Expanded baseline, original ownership         | 41 passed, 102.6s elapsed                                                         |
| Pure helpers, original React ownership        | 41 passed, 109.1s elapsed                                                         |
| Extracted review hook                         | 41 passed, 105.9s elapsed                                                         |
| Focused compiler, typed lint and policy tests | Passed; nine policy/version tests                                                 |
| Complete web test command                     | 319 passed (280 TypeScript tests, 39 dev/production tests)                        |
| CI-config settings calibration                | 31 passed, 99.7s elapsed; 94.4s total case work                                   |
| Standard repository checks                    | Root style/boundary/workflow/doc checks and Studio Server test-style guard passed |

These are local observations, not a performance comparison. The same guarded
request sequences, user-facing messages, drafts and review eligibility are the
acceptance contract. Backend handlers, auth checks, schema, stored recordings,
deployment safeguards and execution paths are unchanged.

The final CI selection contains 533 cases in 46 files. The settings suite is
registered once, retains its serial scenarios and initially uses a 105-second
case-work hint from the higher local observe measurement (102.9s, rounded up).
All five memberships changed under greedy allocation, so all five were run with
the actual CI configuration. In the complete receiving shard, Settings measured
95.7 seconds of case work; the 105-second hint still covers the observed work.

The first local sweep ran two CI jobs on the same Windows desktop. Shard 1
passed all 122 cases. Shard 2 passed 126 cases and failed one upgrade case before
dashboard startup: Chromium reported `net::ERR_NO_BUFFER_SPACE` while loading
the shared CSS asset. That asset has the same hash as in the original build and
served HTTP 200 immediately afterward. A later resource snapshot did not identify
the exact allocation limit. This is not evidence of an upgrade/publication logic
failure, and it is not treated as a passing run. Its trace and full log remain in
the ignored evidence directory.

The remaining local runs executed one CI job at a time, retaining the actual
two-worker configuration, deadlines and fresh-preview cleanup. No application
fallback, automatic test retry or shorter observation window was added. Hosted
jobs continue to use their separate runners; their concurrency is unchanged.

| Final CI shard                 | Cases passed | Local elapsed time |
| ------------------------------ | -----------: | -----------------: |
| 1/5                            |          122 |             303.4s |
| 2/5, complete isolated rerun   |          127 |             394.7s |
| 3/5, includes Project Settings |          120 |             255.1s |
| 4/5                            |           88 |             263.0s |
| 5/5                            |           76 |             295.8s |

The final receipts cover all 533 cases and all 46 selected files exactly once,
with no skips, flaky results or Playwright retries. Each runner exited cleanly.
Independent TCP probes confirmed that every owned preview port was closed;
the disposable cost-test PostgreSQL/MinIO containers were also gone.

No hosted workflow or release was started. Hosted queue, setup and total elapsed
time still require an authorized push and exact-commit verification. These local
results establish the extraction and its local CI gates, not a hosted speedup or
production rollout. Private source snapshots, traces and receipts remain under
the Git-ignored `artifacts/publication-review-refactor-20261125/` directory.

## Reassessment - pending opening reads and restore review

The original extraction preserved the opening effect's local `cancelled` flag.
That guards closing and project changes, but it does not retire the opening read
when History finishes a restore within the same modal. Two browser reproductions
against the pre-fix build established the gap:

- After a successful restore and fresh review, releasing the opening response
  changed the next submitted preconditions from the new draft/version 1 back to
  the old draft/version 0. The server correctly rejected that stale update.
- After a lost restore acknowledgement, releasing the opening response enabled
  Update without the required explicit review.

The fix stays with the opening read. One pending-read identity ref replaces its
local cancellation flag. Explicit review and uncertain-outcome reconciliation
retire it only for the captured project/path owner. Its success, error, loading
completion and cleanup all check that identity. Retiring an opening read after
an uncertain result also settles its loading indicator so explicit review remains
available. HTTP requests are not aborted or repeated; mutation, restore receipt
validation and server guards remain unchanged.

This evidence justifies one change to the extraction's initial three-ref limit:
the final owner has four refs, still 13 state hooks and two effects across the
facade and review hook. It adds no general request coordinator or duplicate state
store. Other review operations keep their existing ordering and results.

The endpoint change handler now accepts only `endpointName`, its sole caller's
string field. It no longer uses a generic cast that also purported to accept
transport-only boolean settings. A compiler comparison verified identical emitted
JavaScript for this typing cleanup. Shared predicates and mutation handlers were
compared structurally and remain unchanged.

The two regressions use held responses and assert the eventual request tokens,
uncertain-state lock and explicit recovery. They add two history cases, bringing
the focused settings/history selection to 43 and ordinary editor selection to
535 cases in the same 46 files. Shard membership and weight hints are unchanged.
Follow-up validation passed:

| Check                                                | Result                                                                                                                         |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Both new race regressions                            | Failed on the pre-fix build at the stale-token/enabled-control assertions; passed after the fix                                |
| Complete settings/history and modal-layout selection | 45 passed (31 settings, 12 history, two layout cases), 100.4s elapsed                                                          |
| Complete web test command                            | 319 passed, including the focused no-emit check                                                                                |
| Affected CI shard 1/5                                | 124 passed, 253.4s elapsed                                                                                                     |
| Affected CI shard 3/5                                | 120 passed, 261.2s elapsed                                                                                                     |
| Source/format checks                                 | Typed lint, frontend build, structural comparisons, test-style guard, shard guards, documentation links and diff checks passed |

The affected-shard runs have no skips, flaky results or retries. Their selected
files and case counts match the current CI selector exactly. Preview ports were
independently verified closed, and no disposable cost-storage containers remained.
The unchanged CI shards retain the earlier full-extraction receipts above; this
review does not represent another complete five-shard or hosted run. Evidence is
kept under the Git-ignored `artifacts/publication-review-reassessment-20261125/`
directory. No commit, push or rollout was performed.

## Adjacent read-lifetime correction (2026-11-25)

The opening-read fix above did not cover a pending manual `Review latest` read.
Two additional browser cases reproduced the same failure against that build:
after a confirmed History Restore, releasing the older manual response submitted
draft `revision-1` and publication version `0` instead of the restored review's
`reviewed-before-restore` and version `1`; after an unconfirmed Restore, it enabled
Update without fresh review. Both failures occurred at the intended state/token
assertions. The existing server preconditions continued to reject stale writes.
Inspection also confirmed that the unguarded manual-review path was present in
the committed action hook; it was retained by the extraction, not introduced by it.

The fourth ref now holds the modal/project read owner and its current read
identity. Opening, manual review and web-app mutation follow-up reads use this
same identity. Starting a replacement read, accepting a mutation result or
marking a changed/uncertain publication retires its predecessor. Async success,
error and completion paths check the identity, including both sides of manual
review's awaited tree refresh. Closing or replacing the project clears the owner.
Uncertain mutations still refresh the global project tree even when their modal
owner has retired. No HTTP request is aborted and no mutation is retried.

There are still 13 state hooks, four refs and two effects across the facade and
review hook. The follow-up loader no longer needs callback memoization because
only action handlers consume it; the new completion helper is stable because
the opening effect consumes it. Shared snapshot validation, draft merge rules,
the public hook return fields, mutation handlers, Restore receipt checks and
modal rendering were compared structurally and preserved.

The existing held-response test now covers opening/manual reads crossed with
confirmed/unconfirmed Restore outcomes, rather than duplicating its fixture and
assertions. It verifies the final submitted preconditions, uncertainty lock,
explicit recovery and exact publication-read counts. This adds two cases: the
focused selection is now 47 (31 settings, 14 history and two layout cases), and
the ordinary CI selection is 537 cases in the same 46 files. Shard membership,
worker counts, observation windows and scheduling hints remain unchanged.

Final local validation for this correction:

| Check                                                | Result                                                                                                                 |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Two new manual-review regressions                    | Both failed before the correction at the intended assertions                                                           |
| Four opening/manual Restore races                    | Four passed after the correction, 30.0s elapsed                                                                        |
| Complete settings/history and modal-layout selection | 47 passed, 114.3s elapsed                                                                                              |
| Complete web test command                            | 319 passed, including the focused no-emit check                                                                        |
| Affected CI shard 1/5                                | 126 passed, 257.9s elapsed                                                                                             |
| Affected CI shard 3/5                                | 120 passed, 253.9s elapsed                                                                                             |
| Other checks                                         | Typed lint, frontend build, structural comparisons, test-style/CI guards, formatting, doc links and diff checks passed |

There were no skips, flaky results or retries in these browser runs. The selected
files and per-file case counts in both affected shards match the current
537-case selector. The other shards retain their earlier full-extraction receipts;
this was not another complete five-shard or hosted run. History's 14 cases used
54.1 seconds of CI case work and Settings' 31 cases used 93.7 seconds, within the
existing 90/105-second hints. Local observations do not establish a hosted speedup.

All three owned preview ports were independently verified closed, and no
disposable cost-storage containers remained. Evidence, including both failing
baseline cases, is retained under the Git-ignored
`artifacts/publication-review-adjacent-20261125/` directory. No commit, push or
deployment was performed.

## Test consolidation and robustness review (2026-11-25)

The publication test review removes one duplicate browser case. The old
`conflicting publishing` variant enabled tree-read failure but rejected the
publication before any refresh occurred. The dedicated stale-publication case
already checks that rejection, disabled controls, explicit review, corrected
preconditions and successful retry. The successful-publication/tree-failure case
remains, along with all distinct invalid-response, owner-change, draft-retention,
Restore and uncertain-outcome cases.

The shared fixture now constructs publication snapshots in one place, preserving
missing/malformed fields instead of normalizing them. Project lookup rejects an
unknown relative or absolute path rather than silently using the first project;
history responses also assert their owning path. The existing focused compiler
and typed lint project now includes this fixture. That exposed and fixed absent
`allowedEmails` in published summaries, an unsafe optional-precondition read and
a widened status type. These are test-fixture changes, not application changes.

An unasserted screenshot and a second full page load in the endpoint-reuse case
were removed. History's failed-refresh scenario now waits for the restored
version's enabled control before leaving the tab. The incomplete-acknowledgement
scenario proves that review restores usable controls and clears uncertainty,
rather than accepting a published label alone. A private fault-injection check
confirmed the difference: a manual review response with a missing draft token
passed the old assertion and failed the stronger one. An aborted review already
failed the original assertion; that existing coverage was retained.

The resulting focused browser selection contains 46 cases: 30 settings,
14 history and two layout checks. The four opening/manual and
confirmed/unconfirmed Restore races remain separate because they exercise
different read lifetimes and recovery policies. The fast policy/version tests
retain coverage of parsing, equality and draft reconciliation; the version test
also rejects a malformed previous version even when arithmetic would advance it.
One small table-driven case adds the missing distinction between unconfirmed
transport/408/5xx results and confirmed 4xx rejections. There are now ten such
tests. No fixed sleeps, test-runner retries, shorter observation windows or new
test suite were added. CI still selects the same 46 files, now containing
536 cases, with the existing shards and work estimates.

The first full rerun found two fixture assumptions to correct. Project loading
accepts either the exact owned relative path or absolute path; restricting it to
absolute paths incorrectly rejected the LLM settings journey. Also, the four
Restore/read races now open the context menu without activating an editor.
They explicitly verify that no editor project load occurred. Independent tree
reconciliation can still legitimately supersede an automatic settings review.
For a confirmed Restore, the race test therefore establishes a usable new review
before releasing the stale response, using the offered explicit review action
if necessary. It counts that read and still verifies the final submitted tokens;
it does not recover after releasing a stale response or retry a write. Other
editor-dependent journeys keep their existing activation behavior. Failed runs
remain in the evidence; production behavior and test-runner retry/timeout
settings were not changed to pass them.

One local rerun also reported a Chromium context-close error. It remains in the
failed-run evidence; the later headless verification uses normal Windows process
cleanup permissions and does not suppress teardown failures.

Final validation of the test cleanup:

| Check                                       | Result                                                                    |
| ------------------------------------------- | ------------------------------------------------------------------------- |
| Full settings/history/layout selection      | 46 passed, 96.9s elapsed                                                  |
| Both affected suites under CI configuration | 44 passed, 98.2s elapsed                                                  |
| Complete web test command                   | 320 passed: 281 TypeScript tests and 39 dev/production tests              |
| Focused compiler and typed lint             | Passed, including the shared fixture and version tests                    |
| Test-style and CI guards                    | Passed; 21 guard tests                                                    |
| Final collection                            | 536 cases in the same 46 CI files                                         |
| Application source and cleanup              | Publication application hashes unchanged; both owned preview ports closed |

The successful browser runs have no skips, flaky results or retries. The CI run
uses the ordinary two-worker configuration and failure-only artifacts, filtered
to the two suites that consume the changed fixture. This is not a new full
five-shard or hosted run. Existing shard membership, work estimates and safety
windows remain unchanged; local timings do not prove a hosted improvement.
The final format, documentation-link and diff checks passed. Full evidence,
including the fault-injection comparison and initial failures, is retained in
the Git-ignored `artifacts/publication-test-review-20261125/` directory.
No commit, push or deployment was performed.

## Comparison with the committed version (2026-11-25)

The current work was compared with `1b96fb815ac758bb53d31948fb8f7db653ecdcf2`.
The original source copies used for structural comparison were checked against
that actual Git revision. Mutation handlers, deletion ownership, Restore receipt
validation and the settings view still match, apart from the shared email-parser
call. The focused compiler and the current-source/evidence checks passed again.

The assessment is favorable within this diff: duplicated policy is centralized,
the review/draft lifetime has a separate owner, and the reproduced late-read
failures are closed. The additional lifetime guard uses one ref; the combined
owners retain 13 state hooks and two effects. No new timer, background poll or
ordinary publication request was added. Execution, database, recording-format,
authorization and deployment code are unchanged by this work.

One existing UX limitation remains. The settings review awaits a tree refresh;
another tree refresh can supersede it and return `null`, so a successful History
Restore can still leave the user needing to choose **Review latest**. It fails
closed, preserves the successful Restore and does not retry the mutation. The
same dependency and failure behavior exist in the committed action hook. This
is a future coordination improvement, not evidence of stale publication approval
or a regression introduced by the extraction.

The final 320-test web, 46-case observe and 44-case CI-configuration receipts
above apply to the current application sources. This comparison did not repeat
unchanged browser suites. Hosted CI for the final commit and a new production
rollout remain unperformed; local timings establish no hosted speedup.

## Commit preparation (2026-11-25)

Final cleanup retains the reviewed production code and the passing browser
receipts above. Root `test:style` passed, including the import/file-tree,
generated-asset, CI-workflow and dependency-boundary checks. The focused
publication compiler, typed lint, Studio Server test-style guard, structural
comparison and current-source receipt verification passed afterward.

The required fresh pre-push npm audit passed with the repository's existing
reviewed exceptions (51 moderate and 11 low findings); runtime glob scope passed.
A fresh unfiltered Rust audit was checked against the seven current temporary
exceptions, then the configured `cargo audit --no-fetch` passed. No security
exception was added or broadened. Private operator packets and local test/audit
receipts remain Git-ignored. These checks do not replace hosted CI or production
qualification for the resulting commit.
