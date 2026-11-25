# Bundle Merge controller refactor and verification

Status: complete. The original four implementation steps were verified on
2026-11-25; follow-up admission fixes and local validation completed on 2026-11-26.
Prepared on 2026-11-25 against `develop` at
`aec67d05d295a0839b960382dbfb0cc15d2c033e`, with a clean working tree before
planning. The planning sections preserve the original baseline and extraction
contract; the implementation and review records below describe the final code,
validation gates and remaining evidence limits.

Reassessed on 2026-11-25 against the same application commit. The revision
below adds the actual suggestion-cache contract, missing compatibility checks
and typed-lint preparation. It also reduces duplicate baseline runs and makes
the browser timing/settlement barriers explicit. Application code was still the
unextracted comparison baseline at reassessment; planning probes are not browser
acceptance.

## Goal and scope

Give the merge review one owner for editable choices, preview lifetimes,
acknowledgements and mutation settlement. Keep rendering and DOM interactions
in the existing modal. Adding a merge option should require changing a named
command and its presentation, without reproducing request cancellation and
review-validity rules in JSX.

The extraction preserves the dashboard's operating contract. Follow-up review
also fixed five reproduced admission races in Merge and Delete; those corrections
are recorded separately below. The operating contract remains
[Project bundles](project-bundles.md#merging-saved-project-changes). The existing
[bundle merge implementation plan](bundle-merge-plan.md) describes the implemented
feature and backend; this document records its UI ownership change.

Preserve API payloads, capability checks, namespace preconditions, review
fingerprints, warning IDs, structural receipts and the prohibition on automatic
write retries. Keep saved-draft merging, reference remapping, publication,
authorization, persistence, schema and deployment behavior unchanged. This work
needs no backend edit, new dependency, generic request hook, reducer, global store,
new modal component or CSS redesign.

Paths below are relative to the repository root. Line numbers in the planning
sections describe the pre-extraction baseline, not the current source layout.

## Preparation evidence and limits

This section describes the planning snapshot before extraction. The implementation
record at the end describes the current owners and fresh validation.

- `packages/studio-server-web/dashboard/WorkflowBundleMergeModal.tsx` has 911
  lines. Its main component begins at line 199 and contains 11 state hooks,
  nine refs and two effects. `MergeSelect` has its own additional ref/effect.
  These counts locate ownership; they are not reduction targets.
- Choice changes, preview dispatch and settlement, submission and project-choice
  handlers occupy lines 211-394. Destination reset, path editing, graph updates,
  acknowledgement changes and manual refresh also live in JSX callbacks.
- `bundleMerge.ts` already owns suggestion application, counterpart fallback,
  path conversion and reference labels. Its five existing tests passed during
  preparation. Retain this owner rather than introducing a parallel merge model.
- The repo observe runner collected **23 cases in `bundle-merge.spec.ts`**.
  Collection succeeded; no browser case was executed for this planning change.
- `scripts/ci/editor-test-shards.mjs` already selects the complete merge spec.
  At this baseline it belongs to shard **5/5**, among 46 selected specs, with a
  155-second case-work hint. That hint is historical balancing input, not a
  fresh timing, timeout or performance promise. Recompute ownership after any
  test-weight change.
- A read-only TypeScript probe used the existing focused hosted-web compiler
  options with `svgr.d.ts`, the current modal, `bundleMerge.ts` and its pure test
  as roots. It visited 396 source/declaration files with **zero diagnostics**.
  This supports a maintained focused project; it does not establish whole-web
  type safety or browser correctness.
- Reassessment exercised the proposed lint scope through an ignored temporary
  TypeScript project with the same compiler options. The modal and pure helper
  had no lint diagnostics. The existing pure test had five
  `@typescript-eslint/no-floating-promises` errors from bare `node:test`
  registrations. An in-memory `void test(...)` preparation passes with zero
  errors/warnings; its actual file was not edited during planning. Account for that cleanup
  in step 2 instead of suppressing the rule. Probe reports live under ignored
  `artifacts/bundle-merge-controller-plan-review-20261125/`.
- `packages/studio-server-api/src/routes/workflows/managed/bundle-merge.ts`
  attaches `suggestions` only when `suggestChanges`
  is requested. Ordinary successful previews intentionally omit it. The current
  browser fixture always includes suggestions and `mappedGraphs`, and derives
  its fingerprint only from the number of actions. It therefore cannot by
  itself establish cache preservation, legacy graph clearing or rejection of a
  different review with the same action count. The characterization below
  addresses those specific limitations.
- `WorkflowLibraryModals.tsx` keys the modal by source bundle ID and initial
  destination ID. `useWorkflowBundleActions.ts` owns opening, closing and opener
  focus restoration. Keep both boundaries unchanged.
- `LibraryMutationCompletion` returns `void`. Its tree owner schedules background
  reconciliation; it does not return a promise for the tree read. An acknowledged
  merge schedules that read and closes the mounted modal. Success toast delivery
  occurs later, through the callback, only when the read returns a tree.

Do not reuse earlier release receipts as acceptance evidence. Before moving
production code, execute the existing cases and the added characterization on
the unextracted modal and record the exact source/build identity.

## Ownership after extraction

| Owner                                                                                   | Responsibility                                                                                                                                                                                                            |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/studio-server-web/dashboard/useWorkflowBundleMergeController.ts` (new)        | Choices, retained catalogs, current review, loading/error/busy/unknown state, suggestions, warning acknowledgements, preview debounce/cancellation, synchronous action admission, mutation settlement and named commands. |
| `packages/studio-server-web/dashboard/WorkflowBundleMergeModal.tsx`                     | Existing props, JSX, option presentation, tables, counts and readiness text; select portal/events, accessible names, DOM refs, scrolling and focus.                                                                       |
| `packages/studio-server-web/dashboard/bundleMerge.ts`                                   | Existing pure merge helpers. Share the current small value/key codecs here when both the controller and view need them.                                                                                                   |
| `workflowApi.ts` and `workflowNamespaceMutations.ts`                                    | Unchanged transport, request serialization, namespace preconditions, receipt recovery and outcome-unknown classification.                                                                                                 |
| `WorkflowLibraryModals.tsx`, `useWorkflowBundleActions.ts`, `useWorkflowLibraryTree.ts` | Unchanged modal identity, opening/closing, opener focus and authoritative background tree reconciliation.                                                                                                                 |
| `playwright-observe/bundle-merge.spec.ts`                                               | Existing feature/browser checks plus targeted characterization of the moved lifetimes.                                                                                                                                    |
| `tests/bundle-merge.test.ts`                                                            | Existing pure-helper checks; extend only for a real uncovered helper boundary.                                                                                                                                            |

The controller receives `source`, `initialDestinationBundleId`, `onClose` and
`onStructuralMutation`. It does not need the candidate `bundles` list, select
options, DOM elements, React events or layout values. Use the existing shared
bundle types and `LibraryMutationCompletion`; do not mirror their schemas.

Return a plain object containing the data the view currently reads:
`choices`, `form`, `preview`, `suggestions`, `error`, `loading`, `busy`, `unknown`,
`acknowledged`, `openSelect` and `canMerge`. Keep raw catalogs/review objects,
initialization/comparison flags, refresh counter, abort controller and admission
refs private. Expose named commands:

- `selectDestination`, `updateAction` and `updateDependency`;
- `updateActionPath` and `updateDependencyPath`;
- `selectGraph` and `clearGraph` for the legacy mapping fallback;
- `setWarningAcknowledged` and `refreshReview`;
- `submit`, `close` and stable `trackSelect`.

Do not export state setters or a general `change(choices)` command. Keep the
existing internal `change` operation as the single invalidation path. Path
commands receive the selected row choice and converted string value, preserving
the current object-identity comparison. Graph commands retain the current tuple
identity and filter/append order. Avoid silently replacing captured-render
behavior with ID-based rebasing against a new latest-state abstraction.

### Select tracking without a second lifecycle owner

Keep the scalar open-menu ID and stable `trackSelect(id, open)` callback in the
controller, alongside the existing mounted ref. That callback currently rejects
cleanup updates after disposal and clears an ID only if it is still current.
It is part of close eligibility, not DOM ownership. Its identity must remain
stable so child cleanup cannot reset menu state on each controller render.

Keep `MergeSelect` itself in the view, including its local menu-open ref,
unmount cleanup, portal target, Escape propagation and supplied Select handlers.
Keep the modal's Escape/overlay props and all actual DOM/focus operations in
the view. This moves the main component's existing 11 state hooks, seven non-DOM
refs and two effects together; the two DOM refs remain in the view. Do not add
a second mounted ref/effect or expose a lifecycle ref merely to keep the menu
ID outside the controller.

### Keep presentation simple

Leave candidate filtering, formatted options, project/dependency/graph row
selection, column labels, counts, `siteLabel`, readiness-message priority and
the simple `busy || unknown` display condition in the view. They consume
controller data without initiating requests. Keep `ProjectChoicesTable`,
`ProjectChoiceRow`, `MergeSelect`, element IDs and stylesheet imports intact.

The existing `actionValue`, `dependencyValue` and `graphKey` helpers are used by
behavior and presentation. Move their existing bodies into `bundleMerge.ts`
and import them from both owners. Preserve `JSON.stringify([projectId, graphId])`
for graph identity. Do not duplicate the codecs, replace them with delimiter
concatenation, or create a new helper module for three small functions.
`emptyChoices` becomes controller-private; `countLabel` stays in the view.

## Behavior contract to preserve

### Mount, preview and retained fields

1. The parent key defines a modal session. The initial destination initializes
   choices on mount; it is not a continuously synchronized draft. Keep the
   parent's key and conditional mount. Do not add a prop-reset effect.
2. Mount cleanup retires the owner and aborts the outstanding preview. Keep the
   mount effect before the preview effect and preserve their dependency and
   cleanup behavior, including effect re-entry.
3. A destination-bearing choice set starts a preview after the existing
   **180 ms debounce**. Editing cancels the old timer/request and clears review,
   acknowledgements and error through `change`. Missing destination and
   outcome-unknown state each prevent preview dispatch. Add no polling, focus
   refresh, new client request timeout or automatic retry. The existing backend
   preview's 30-second budget remains unchanged.
4. Preview success must pass the current abort, exact choices-reference and
   synchronous pending checks. Preview failure must retain its existing abort
   and choices-reference checks. An old completion cannot replace data, clear a
   newer error, change loading, apply suggestions or enable submission.
5. Preserve the distinction between the latest choices ref and a state value.
   A reference changes synchronously on an accepted edit, before React publishes
   the next render. Do not substitute deep equality or add request epochs where
   the existing abort/reference fences already express ownership.
6. Retained catalog data is available only for the selected destination. It keeps
   editable fields mounted during validation and errors. Only the review tied
   to the current choices object can authorize submission; retained form data
   and cached suggestions never can.
7. Initial saved-content comparison may supply suggestions and create another
   choice object, which legitimately causes another debounced preview. Preserve
   that sequence, including automatic required dependencies. Do not optimize it
   into a different request or claim one preview per destination.
8. Suggestions are cached per selected destination. An omitted `suggestions`
   field retains the prior cache and presentation state; it is the ordinary
   validation response after comparison. `[]` explicitly replaces that cache
   with an authoritative empty array. Metadata fallback applies only when no
   suggestions have been obtained in this destination session. A destination
   change clears the cache; manual refresh retains it until a supplied array
   replaces it. Set initialization/comparison flags at their existing successful
   settlement points, including after a first successful legacy response that
   supplies no suggestions.

### Edits, refresh and acknowledgement invalidation

1. Reselecting the same destination, action or dependency is a no-op at its
   existing guard. It must retain custom paths, choices, review and request count.
   Do not broaden that rule to graph reselection or unrelated handlers.
2. A different destination resets choices, retained catalogs, suggestions and
   both initialization/comparison flags in the current order. It cannot briefly
   render the previous destination's fields as the new form.
3. Project action/counterpart changes keep current filter/append ordering and
   remove that source project's old graph choices. Path edits keep the current
   row-object guard. Keep display/storage suffix conversion in
   `ProjectChoiceRow` before it calls the path command.
4. Graph selection retains one tuple entry and its current target ID. Preserve
   the `mappedGraphs === undefined` compatibility path and the existing
   object-identity removal performed by its Change graph button.
5. Checking a warning changes its acknowledgement list without invalidating the
   review or fetching again. Pass the checkbox's immediate boolean into the
   command; do not retain its event. An accepted choice edit clears all warning
   acknowledgements, even if the next preview repeats the same warning ID.
6. Manual Refresh review aborts the old preview, requests content comparison,
   clears review/acknowledgements and increments the refresh counter. It retains
   choices, custom paths, cached form/suggestions and the fact that initial
   top-level choices were already initialized. Refresh must not reselect a
   deliberately skipped project or overwrite an edited addition path.

Move entire handler bodies, including destination-reset steps before `change`,
in their current order. Do not add blanket guards to the newly named commands
or silently normalize no-op/queued-event behavior. Characterization that reveals
an actual admission gap must receive the separate baseline-fix treatment below.

### Mutation admission, settlement and disposal

1. Keep both the rendered `canMerge` calculation and the stronger synchronous
   submit guard. Admission still checks pending, unknown, loading, error,
   fingerprint, latest-versus-reviewed choices and every current warning. Do not
   remove the ref checks to deduplicate similar-looking eligibility expressions.
   Keep the server fingerprint authoritative for plan validity; do not duplicate
   server blockers, graph/path validation or access policy in new client rules.
2. Set pending and abort the preview before the first asynchronous boundary.
   One admitted submission sends one structural write. Keep the exact captured
   choices, fingerprint, acknowledged-warning list and both namespace IDs.
   The transport continues capturing immutable wire/hash inputs before WebCrypto.
3. While pending, all dismissal paths remain blocked by the synchronous close
   guard and existing busy presentation. Ordinary preview loading still allows
   cancellation. Closing must continue through the parent's callback so opener
   focus is restored by its existing animation-frame logic.
4. After an acknowledged or receipt-recovered success, call the existing
   `onStructuralMutation` once, with the current failure warning and callback;
   then close if mounted. Do not await that `void` callback, add a preliminary
   tree fetch, or show success before a successful authoritative read.
5. An acknowledged write followed by a failed tree read stays acknowledged.
   Preserve the existing refresh warning and avoid another merge write.
6. A definite merge rejection retains edited fields, clears the review and
   displays its error. It needs a fresh review before a new explicit attempt.
   Do not manufacture an immediate preview by changing effect dependencies.
7. `MutationOutcomeUnknownError` still triggers reconciliation and locks this
   modal against editing, refreshing and submitting. Close remains available
   after settlement. The transport may perform its existing receipt read; it
   must never replay the write. Keep this error class and handling authoritative.
8. Disposing a modal aborts previews, not an admitted mutation. Preserve accepted
   and unknown-outcome reconciliation outside mounted-only UI updates. An old
   mutation cannot close or write state into a replacement modal. Do not change
   this into a general latest-callback/ref mechanism or move receipt ownership
   into the controller.

A fresh review does not require a different fingerprint when the selected
content and server facts are unchanged. Freshness comes from this owner accepting
a preview for the current choices, not from treating the fingerprint as a nonce.

### DOM and accessibility

Keep Destination autofocus, select portal positioning/z-index, dropdown-before-
dialog Escape handling, overlay rules, accessible names, tab order, table
structure, loading labels and header/footer visibility. Preserve the View error
handler's existing geometry calculation, scrolling and `focus({ preventScroll:
true })`. It and its DOM refs belong in the view. No layout or text change is
needed to complete this extraction.

## Characterization before moving production code

### Reuse the existing checks

The 23 collected cases already cover opening through drag and context menu,
capability boundaries, successful and recovered writes, failed tree refresh,
obsolete previews after edits, graph/warning gates, unknown acknowledgements,
manual review retry, suggestions, empty states, retained path focus, no-op
destination/action reselection, pending dismissal, layout and long-error focus.
The five pure tests cover counterpart ambiguity, labels, path round-tripping
and suggestion initialization/preservation. Keep these owners and assertions.

In particular, the existing automatic-suggestions case already checks Escape
inside an open dropdown and preservation of a skipped action through manual
refresh. Strengthen that case rather than adding another journey for those
facts. Add separate cases only for different request ordering or lifetimes.

| Boundary                                         | Preparation work and required observation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Suggestion cache and refresh intent              | Make the existing automatic-suggestions case follow the real wire contract: supply suggestions for `suggestChanges=1`, omit them for ordinary validation. Verify comparison labels/filtering and discovered dependency choices survive omission. Extend its existing skip/refresh sequence with an edited addition/dependency path and warning acknowledgement reset. Warning toggles and same action/destination/dependency reselection add no preview; explicit refresh requests comparison without restoring skipped actions or default paths.          |
| Legacy optional fields                           | Add one compact browser case advertising merge support but omitting `suggestions` and `mappedGraphs`. Initial top-level choices remain manual, unique dependency metadata still provides its current fallback, and resolving then clearing a graph uses the existing Change graph control and clears its acknowledgement. Add a small table to the existing pure tests distinguishing absent suggestions from `[]`; an authoritative empty array must not invoke metadata fallback. Do not repeat the whole modern-server journey for each optional field. |
| Debounce and cancellation before dispatch        | After the modal transition has settled, establish one edit's timer boundary: no preview at 179 ms and one at 180 ms. Edits inside the window dispatch only the last choices. Allow legitimate suggestion follow-ups to settle outside the measured interval. At the end, cancel during a newly scheduled debounce and verify that it dispatches nothing. Keep this timing case separate from a long mutation journey.                                                                                                                                      |
| Obsolete success and failure after an edit       | Strengthen the existing obsolete-preview case with a response-consumption barrier. Release a held successful preview or held error only after another edit's visibly different review has settled. Neither may change the newer ready/blocked state, error, fields or acknowledgements. Parameterize only these success/failure paths, not a Cartesian product of every form event. Refresh is disabled while loading; do not invent overlapping refresh requests.                                                                                         |
| Disposal and destination replacement             | Cover actual close/reopen with a held preview, and a different destination chosen while an earlier preview is held. Use distinct catalogs and identities. Old completion cannot restore old fields, suggestions, acknowledgement or review authority. The next admitted write uses the selected destination's preview namespace. Share route/gate utilities; keep the two owner transitions independently observable.                                                                                                                                      |
| Synchronous submit admission and tree settlement | Strengthen the existing submit-once/pending case with two events in one browser task and evidence that both preceded published disabled/busy state. Observe one write with the reviewed choices, fingerprint, warning IDs and namespace preconditions. Hold post-acknowledgement reconciliation separately: the modal closes before that read finishes; success appears only after a valid read. Retain the existing recovered-with-failed-refresh case.                                                                                                   |
| Definite rejection versus uncertainty            | Add a definite 409 merge rejection: no receipt lookup, automatic write or review retry; edited fields remain and submission needs a new explicit review. Strengthen the existing unknown-outcome case to assert editing remains disabled and close/reopen sends no write. Keep transport-level receipt/hash coverage in its existing tests.                                                                                                                                                                                                                |
| Menu and focus lifetime                          | Reuse the existing dropdown-Escape checks and extend the focus/reselection coverage so a later Escape closes the modal and returns focus to its opener. Exercise normal graph-control removal in the graph/legacy case, checking no lingering portal/menu state. Review stable callback identity and ID-scoped cleanup directly. Keep the narrow-error/focus and viewport checks.                                                                                                                                                                          |

A preview fingerprint in the current fixture depends only on action count.
Use distinct valid 64-character hexadecimal fingerprints for deliberately
different server snapshots in the stale-result, destination and submission
checks. Assert the exact accepted token in the write, alongside warning IDs
and both namespace identities. Do not require fingerprint rotation for an
unchanged server snapshot or rewrite unrelated fixtures just for this refactor.

### Request and settlement barriers

Use exact method/path/body matching to distinguish preview, commit, tree and
receipt traffic. Own fixture API responses explicitly and fail unexpected
writes; do not let mocked cases fall through to a real local or production API.
The shared bootstrap helper is not a catch-all API isolation boundary. A small
merge-local fixture may own the remaining bootstrap reads and reject unowned
API traffic, following the existing schedule fixture's pattern without importing
its schedule-specific setup. Keep the fixture typed and avoid a new framework.

Count merge writes and previews separately from library synchronization reads.
The parent can coalesce reconciliation and has other legitimate read triggers;
do not assert a global fixed tree-read count as if the modal owned that lifetime.
Establish that pre-action reads have settled before holding the acknowledged
phase's tree read. Verify one merge, the existing reconciliation behavior and
toast ordering without adding a preliminary tree fetch.

For debounce tests install Playwright Clock before navigation and finish
bootstrap with time flowing. Pause before opening the modal with no initial
destination, advance its transition while no preview is scheduled, then make
the measured selection/edit. Wait for the checking state that establishes the
effect has registered its timer before advancing 179/1 ms. Use `runFor` for exact
boundaries and due callbacks. Keep unrelated real-service journeys on real time
and preserve production/backend timing constants.
For no-extra-preview assertions, first settle the relevant response/event, then
observe a complete debounce window in the controlled clock case. An immediate
unchanged request counter can miss a newly scheduled preview. Reuse that case
for request-count proof instead of adding arbitrary sleeps to every UI journey.

A held route that fetch has already aborted cannot prove that a late result
reached application code. For the stale-settlement tests, parse the exact
preview body with the original `Response.json`, then hold its returned value
before delivering it to the caller. For the error path, hold the parsed JSON
error body before the existing response parser constructs its HTTP error.
Preserve the original fetch arguments and AbortSignal. A small test-only
`fetch`/`Response.json` wrapper is sufficient; no production dependency
injection or requester rewrite is needed.

The gate must distinguish request arrival, body parsed, explicit release and
promise consumption. Release the old body only after the replacement review
settles. Drain its promise continuation and a render frame before asserting
unchanged state; with the test clock paused, advance that frame explicitly.
A negative assertion already true before release is not evidence of rejection.
Use response-specific sentinels and observe the next allowed action where
helpful. Gates need bounded waits and `finally` release/disposal, including on
test failure; restore the fixture by settling gates before waiting for route
teardown. Do not swallow route errors or add test-runner retries.

For submit admission, reuse the existing same-task dispatch pattern from
`scheduled-runs.spec.ts` and capture disabled/busy state before each event.
Two submits admit one write. The obsolete-preview/edit case checks the complete
choice-ownership condition; review the synchronous latest-ref assignment and
submit comparison directly as well. Do not manufacture an input-event ordering
or bypass normal React dispatch merely to test redundant guards individually.
An ordinary `dblclick` alone cannot prove pre-render admission. Do not inspect
React private fields or add production attributes for this check.

Pending mutation dismissal is intentionally blocked, and collapsing the sidebar
does not unmount the library. Do not label either action a mutation-unmount test.
Preserve post-disposal reconciliation by structural review of the moved
continuation. If an existing reachable parent-disposal seam can exercise it,
reuse it; do not add a production control or navigate out of the whole JavaScript
realm and claim that it proved a late continuation ran. React discarding an
unmounted component's state update also does not prove the update was rejected
by the controller.

All added characterization must pass on the unextracted modal. If it exposes
a real baseline defect, retain the reproduction and separate a minimal repair
and documentation from extraction. Do not weaken the test or silently redefine
the behavior-preserving baseline.

## Ordered implementation and gates

### 1. Establish the comparison baseline

Recheck HEAD, the whole diff and applicable instructions. Read the owning bundle
docs and relevant recurrence-checklist entries. Preserve unrelated changes and
private artifacts. Save source hashes, commands, selected case identities,
request counts and timing evidence in a new Git-ignored artifact directory.

Add/strengthen the browser and pure-helper characterization above first, with
runtime code unchanged. Build the original web application and run the complete
augmented merge spec once, including all 23 existing cases, plus the pure tests.
An extra full run before adding those tests is unnecessary unless investigating
a baseline failure. Use the same production build/preview path before and after
extraction; collection is not this gate.

**Gate:** original and added browser checks pass on the original owner, and
request sequences, legitimate suggestion follow-ups and settlement ordering
are recorded. Resolve baseline failures explicitly before extraction.

### 2. Establish maintained checks and share only existing codecs

Add `packages/studio-server-web/tsconfig.bundle-merge.json` using the existing
focused projects' no-emit, non-composite, Bundler/ESNext, React JSX, Vite/Node
settings. Start with `svgr.d.ts`, the current modal, `bundleMerge.ts` and its
pure test. Add the controller root when creating it, not a missing-file entry
or unused placeholder. Include a new small merge fixture helper if its import
graph remains narrow; there is no need to pull every browser scenario into it.

Register `check:bundle-merge` in the web package and invoke it from the ordinary
web `test` script. Add a narrow root ESLint project override for the actual
changed owners/tests. The default desktop parser projects do not cover this
hosted modal. Do not disable typed rules or expand a desktop project to absorb it.

Convert the existing bare `node:test` registrations in `bundle-merge.test.ts`
to `void test(...)`, matching the typed rule without changing assertions or
runner-owned failure reporting. Use that registration form for the added pure
characterization too. Do not serialize registrations with new `await` wrappers
or suppress `no-floating-promises`. This is the confirmed preparation needed
by the lint probe, not a production behavior repair. The pure test is already
in the ordinary web test manifest; keep it enrolled exactly once.

Move only `actionValue`, `dependencyValue` and `graphKey` into the existing pure
module. Keep their semantics and imports unchanged otherwise. Extend the
existing pure test only for an uncovered compatibility boundary; do not add
tests that merely restate these trivial expressions.

**Gate:** maintained typecheck, typed lint and pure tests pass, with the original
modal still owning its lifetimes. No rule suppression or unrelated helper
reorganization is needed to make the extraction possible.

### 3. Move the owner and wire the existing view

Create the controller with the contract above. Move the main component's state,
non-DOM refs, stable menu callback, effects, internal invalidation and submission
continuation together. Preserve effect order/dependencies, synchronous ref
writes, success/error branches, cleanup and callback order.

Turn the existing destination, path, graph, warning and refresh JSX callbacks
into named commands by moving their bodies, retaining their argument and
identity semantics. Keep event-value extraction and DOM work in the view.
Compute `form`, `preview` and `canMerge` with their current expressions.
Do not memoize every command or derived array; only identity-sensitive existing
callbacks, particularly `trackSelect`, require stable identity.

Replace the view's behavioral handlers with controller calls. Preserve props,
parent key, helper components, JSX keys, labels, CSS and readiness-message order.
Remove unused imports and moved declarations. Reuse existing API, error,
reconciliation and pure-helper owners directly; do not add wrappers around them.

**Gate:** side-by-side review accounts for every moved branch and JSX handler.
The main view has no request, debounce, mutation-settlement or review-state
setter left. Typecheck, typed lint, pure tests and the full merge browser spec
pass against the extracted production build with matching request behavior.
Do final dependency/build checks before this full observe run when possible;
its passing receipt also satisfies step 4 if the tested inputs stay unchanged.

### 4. Review the result and complete integration

Review stale completions, menu cleanup, suggestion initialization, retained form
metadata, warning resets and synchronous admission independently of happy paths.
Check that accepted/unknown mutation reconciliation remains outside mounted-only
UI updates and that the transport/parent owners are unchanged. Run meaningful
new checks when this review exposes a gap; avoid duplicate suites or extra
production abstractions for test convenience.

Run final checks in dependency order: applicable root checks that rebuild shared
outputs first, then focused compiler/lint, test-style/repository checks, complete
web pure suite and production web build, then observe and affected CI shard.
Never replace shared build output while an owned API/browser fixture is running.
Stop only fixtures started for this work and verify they have settled.
Reuse the step 3 observe result if its source/build/fixture hashes still match;
do not require a second identical full run merely because this is a new step.

Keep the entire merge spec selected in ordinary editor CI. Measure its case work
and wall time; update the existing 155-second weight only if evidence warrants
it, with the current five-second rounding policy. Recompute and verify every
shard whose membership changed. Keep workers, five-shard policy, required gates,
timeouts and safety observation windows intact.

Update this document with implementation results, `project-bundles.md` with final
ownership/verification, and `refactor-history.md` with the completed extraction.
Keep the README link. Distinguish fresh results, reused unchanged results and
unresolved limitations. Before a later requested commit or push, reread the
optional ignored checklist for the final diff; do not commit it or private
receipts. Creating this plan does not include a commit, push or deployment.

## Validation commands and evidence

Use the supported repository toolchain. In this Windows checkout, put
`.data/tools/node/v24.22.3/win-x64` on PATH and invoke
`.yarn/releases/yarn-4.17.1.cjs` with that Node binary when the global Yarn shim
does not select it. Check `$LASTEXITCODE` after native commands.

After adding the focused project, run from the root:

```powershell
yarn workspace @valerypopoff/rivet-studio-server-web check:bundle-merge
yarn workspace @valerypopoff/rivet-studio-server-web exec tsx --test tests/bundle-merge.test.ts
yarn exec eslint packages/studio-server-web/dashboard/WorkflowBundleMergeModal.tsx packages/studio-server-web/dashboard/useWorkflowBundleMergeController.ts packages/studio-server-web/dashboard/bundleMerge.ts packages/studio-server-web/tests/bundle-merge.test.ts
yarn studio-server:verify:test-style
yarn studio-server:verify:repo-structure
yarn check:file-tree
yarn studio-server:verify:web-pure
yarn workspace @valerypopoff/rivet-studio-server-web build
```

Include changed typed fixture files in lint. Run applicable checks for edited
CI registration or weight policy if those files change. Apply the relevant
root style checks before final build/browser results; reuse passing checks
against unchanged inputs rather than repeatedly rerunning the same gates.

Serve the completed build on an unused loopback port, with mocked merge cases
owning their APIs. Use the required observe runner:

```powershell
$env:PLAYWRIGHT_HEADLESS = '1'
$env:PLAYWRIGHT_SLOW_MO = '0'
$env:PLAYWRIGHT_BASE_URL = 'http://127.0.0.1:5183' # Use the owned preview's port.
yarn studio-server:ui:observe bundle-merge.spec.ts
```

Use the installed matching Chromium through `PLAYWRIGHT_EXECUTABLE_PATH` when
appropriate, rather than downloading another browser for collection. Inspect
failures under `artifacts/playwright/`, including request traces, failing step
and gate/fixture cleanup. A stale build or cleanup failure is not a product pass.

Then run the **complete affected shard**, using its normal CI configuration,
two workers and the same completed build. Its preview port must be free:

```powershell
$env:CI = '1'
$env:RIVET_EDITOR_TEST_SHARD = '5/5' # Recompute before use; do not assume this is permanent.
yarn studio-server:ui:ci
```

Do not add a filename filter to the full-shard gate. Clear the shard variable
before collecting the full suite, and restore task-local environment settings
afterward. Existing shard fixtures retain their own required dependencies.
This UI scope needs no Kubernetes rehearsal, rollout or new PostgreSQL/MinIO
qualification. If the diff reaches backend, storage or execution behavior,
reassess scope and validation before proceeding.

Record source/build hashes, exact case counts, zero unexpected mutations,
request bodies/counts, debounce observations, reconciliation/toast ordering,
browser wall time, case work and setup/build time. Preserve endpoint request
shape and frequency; no workflow execution path changes or endpoint speedup
claim is part of this work. For later hosted timing comparisons include runner
queueing and setup separately. Local timings do not prove a hosted CI speedup.

## Completion criteria

- One feature-specific controller owns the existing merge review and mutation
  lifetime; the view owns DOM/presentation and the parent retains modal/focus
  and tree-reconciliation ownership.
- Every current behavior branch and compatibility fallback has an explicit
  home. No duplicate suggestion rules, review-validity owners, receipt logic,
  extra lifecycle effects or public state setters were introduced.
- Characterization passed before extraction and remains green afterward.
  Pure tests, maintained typecheck, typed lint, applicable repository checks,
  production build, required observe verification and complete affected-shard
  verification pass without weakened assertions, hidden skips or retry inflation.
- Wire values, request cadence, accepted/unknown settlement, warning reset and
  focus behavior match the recorded baseline. Backend safeguards remain owned
  by their existing code.
- Final documentation records exact evidence and limits. Mark this plan
  implemented only after these gates are complete; unresolved failures remain
  explicit rather than being described as successful refactoring.

## Initial extraction and local verification - 2026-11-25

All four implementation steps are present. At initial extraction, the original 911-line modal became
a 685-line view and a 287-line controller. The controller owns the existing 11
state hooks, seven non-DOM refs and two effects; the view retains two DOM refs.
`MergeSelect` and its own ref/effect are unchanged. No additional state/effect
owner, request framework, dependency or backend change was introduced.

The seven former JSX handlers use named controller commands. Their existing
path-object guards, graph tuple encoding/filter order, warning-list updates and
destination/refresh reset order are retained. The three existing codecs moved
to `bundleMerge.ts`; its six pre-existing pure functions remain unchanged.
Transport, parent mount key, opener focus and tree-reconciliation owners match
their baseline hashes.

Characterization added five net browser cases, bringing the complete spec from
23 to 28, and one pure-helper case, bringing that file from five to six. Existing
cases now cover the real suggestion-omission contract, uncertain-state editing,
pre-render duplicate submission and independently held post-acknowledgement tree
refresh. New cases cover parsed stale success/failure, modal disposal, destination
replacement, legacy optional fields and controlled debounce/explicit retry.
The browser fixture rejects ambient writes and separates request arrival, parsed
bytes and consumed responses. Its test registrations and the production owners
are included in the maintained focused typecheck and typed ESLint scope.

The initial focused characterization run found a test locator mistake: a disabled
Atlaskit select is excluded from the accessibility role query. Targeting its
existing label corrected the assertion. The original application then passed
all 28 cases before production movement, with zero skips/retries. That first
failure remains in the ignored evidence; it was not a production behavior fix.

The first full-shard invocation passed all 84 cases but stalled while its local
preview process tree was shutting down under restricted Windows process access.
The operator verified PID, parent, precise creation time and preview-port
arguments before stopping only that tree. That invocation is retained as
diagnostic evidence and excluded from automatic-cleanup acceptance. The accepted
final shard gate was a full rerun with normal Windows process access; it exited
and released its ports without that intervention. This concerned the local
Playwright preview tree; deployment and recording operators were unchanged.

The normal-access rerun settled automatically but one unchanged Run Statistics
case failed before its scenario began: Chromium reported
`net::ERR_NO_BUFFER_SPACE` for the shared
`/assets/useHostedSurfaceDismiss-CtelrUsv.css` stylesheet. The other 83 cases
passed, including all merge cases. A post-run snapshot showed 83 TCP connections
and 19.2 GiB free physical memory; it does not establish pressure at the instant
of failure or an underlying cause beyond the reported transport error. That run
and trace remain retained. The accepted full-shard recheck used unchanged source,
fixtures, assertions, worker count and build; all 84 cases passed with automatic
cleanup. No broader startup retry or application workaround was introduced.

Token-level comparison confirms the two effects in order, nine core moved
initializers/commands, eight presentation calculations, all three view helpers
and existing pure functions. The rendered JSX matches after normalizing the
seven intended handler bindings. The lifted handler argument conversions and
captured-value semantics were also reviewed directly. These checks complement
browser characterization; they are not a substitute for it.

| Gate                                          | Local result                                                                                                                                                                                                            |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Original build and augmented browser baseline | Passed: `DashboardPage-Uc7-AUr_.js`; 28/28 cases, 118.5 s wall / 114.5 s case work. Runtime hashes were checked unchanged before extraction.                                                                            |
| Helper-only stage                             | Maintained typecheck, typed lint and six pure tests passed before controller movement.                                                                                                                                  |
| Final compiler/lint/web tests                 | Passed: `check:bundle-merge`, typed ESLint, all four focused web typechecks and 326 web tests (287 TS cases plus 39 dev/production cases).                                                                              |
| Repository gates                              | Root `test:style`, Studio Server test-style/repository checks and import/file-tree checks passed. Root style retains eight existing POSIX/macOS-only skips on Windows; the relevant web/merge checks have none.         |
| Final production build                        | Passed: `DashboardPage-Bw86NYXU.js`, 54.2 s build time.                                                                                                                                                                 |
| Final observe browser verification            | Passed: the same 28 cases and fixture hashes, zero skips/retries; 119.3 s wall / 115.5 s case work on the final build.                                                                                                  |
| Complete affected editor shard                | Passed: shard `5/5`, all 84 cases in nine files, including all 28 merge cases; 320.0 s wall / 576.4 s summed case work. Merge case work was 110.2 s. No skips, retries, global teardown errors or cleanup intervention. |

The 155-second merge work hint and shard selection have not changed. The measured
110.2-second local CI merge work fits that conservative hint; refresh it with
hosted evidence rather than inferring a hosted speedup from local timings.
Keep endpoint performance and hosted CI performance claims separate from local
test timings: the requester/wire contract is unchanged, and no hosted run,
runner-queue comparison or production rollout has been performed for this UI
refactor.

Evidence is Git-ignored under
`artifacts/bundle-merge-controller-refactor-20261125/`. It includes the original
source hashes/copies, baseline verification receipt, failed preparation probe,
passing browser reports, structural/render comparisons and compiler/style/build
logs. `verification.json` binds the tested source, fixture and build hashes to
the accepted results and the retained earlier failures. Owned preview ports
5183 and 5184 reject new connections after shutdown; no fixture cleanup remains
pending. Do not commit generated evidence or private release packets.

## Follow-up reassessment - 2026-11-26

The original characterization established equivalence but did not exercise
different commands arriving in the same browser task. Four additional browser
cases reproduced gaps in the extracted controller; inspection confirmed the same
missing guards in the committed modal:

- Refresh review followed by Merge could submit the previous fingerprint before
  React published the cleared review.
- Cancel followed by Merge could start a write after dismissal was requested.
- Merge followed by Refresh could dispatch an extra review while the mutation was
  pending, leaving recovery state inconsistent after a definite rejection.
- Merge followed by a destination selection could clear retained catalogs and
  suggestion state before the central choices guard rejected the edit, hiding
  the edited form after rejection.

The correction reuses the existing abort signal and pending guard. Submission
rejects an aborted review; close aborts synchronously; refresh and destination
selection reject pending/unknown commands before resetting anything. The
controller is now 292 lines with the same state, ref and effect owners. Normal
request cadence, warning rules, selection behavior, transport, backend guards
and accepted/unknown reconciliation remain unchanged. These admission corrections
are intentional fixes beyond the mechanical extraction; the earlier token/render
comparisons describe the initial extraction, not the subsequent guards.

The reassessment also reproduced a fixture defect by revisiting a held path:
the old gate held every matching response rather than consuming one. Its release
promise is now created when armed, matched once and resolved even if disposed
before parsing. A separate cleanup probe reproduced an unanswered route arriving
after disposal; the route gate now answers that request with the fixture cleanup
503 and releases held handlers. Its reply operation no longer hides a second
arrival wait or depends on its object receiver. All maintained callers explicitly
wait for arrival before replying.

The two existing stale-result cases now revisit their old path. Four focused
command cases bring the spec to 32 cases, without new generic controller hooks,
test retries, reduced timeouts or shared startup workarounds. The alternative
destination fixture is shared between the existing replacement case and the
queued-destination case.

Follow-up evidence is Git-ignored under
`artifacts/bundle-merge-controller-review-20261125/`. The six focused failures
against the unchanged pre-review build, corrected route-cleanup probe and final
verification receipts are kept separately from the initial extraction evidence.

The focused typecheck, typed lint, formatting, test-style, repository/import and
file-tree checks passed. All four maintained web typechecks and 326 web tests
passed, with no skips. The rebuilt `DashboardPage-DLEvMojP.js` passed all six
focused regression probes (31.4 s wall) and all 32 observe cases (124.3 s wall /
120.1 s case work), with no retries, skips or global errors. API and parent/tree
owners still match the five original baseline hashes.

One local attempt overlapped the build and full web-test suite: V8 aborted the
build with `Worklist::Segment::Create` and two unrelated Node test processes with
native allocation errors. Their logs remain retained. Post-failure memory
counters cannot establish peak usage or the underlying resource cause. Repeating
the unchanged commands separately passed: production build in 52.6 s and all
326 web tests. No test assertion, timeout, retry, worker setting or build option
was changed to obtain those passes.

The complete local editor CI shard `5/5` then passed all 88 cases in nine files:
323.0 s wall / 599.7 s summed case work, including 127.3 s for the 32 merge cases.
There were no skips, retries, global errors or teardown intervention. The
155-second merge work hint remains unchanged. Both owned preview ports, 5183
and 5184, independently refused new connections after shutdown. `verification.json`
binds the reviewed source, fixtures, compiled asset and reports to these results.
These local measurements do not establish hosted timing or runner queue effects;
no hosted CI run, push or production rollout was performed for this review.

## Adjacent cancellation review - 2026-11-26

The follow-up checked warning acknowledgements, stale form events, immutable
mutation inputs and parent reconciliation before broadening any production code.
A new compact browser case confirms that two acknowledgements in one browser
task are both retained, unchecking one before a queued Merge prevents the write,
and acknowledging it again submits the exact current list. These checks passed
on the existing implementation; no warning state or lifecycle ref was added.

The neighboring Delete Bundle dialog did have the same close/admission gap.
With a correct name entered, Cancel followed by a queued Delete dispatched one
request after dismissal. This was reproduced using the existing blocked-deletion
fixture, not real workflow deletion. Closing now sets a private dismissal flag
synchronously; the submit guard rejects that retired dialog. The existing pending
guard, exact confirmation, mutation transport and post-write reconciliation are
unchanged. Reopening creates a fresh flag and empty confirmation.

The existing blocked-deletion browser case was extended to close and reopen before
its normal confirmed request. It checks zero requests from the dismissed dialog,
then retains the pending-state and server-rejection checks. The deletion component
joins the existing focused compiler/lint project. The larger explicit-bundles
browser spec keeps its existing execution checks: adding its API fixture graph to
the web compiler pulled in unrelated API SQLite typing assumptions, so that
experimental enrollment was removed without suppressing compiler rules.

Evidence for this follow-up is isolated in
`artifacts/bundle-merge-adjacent-review-20261126/`, including the failed pre-fix
deletion case and the passing warning probe. The merge spec now has 33 cases;
the explicit-bundles case count is unchanged.

The focused compiler, typed lint, test-style and repository/import checks passed,
as did all 326 web tests. The production build completed in 57.7 s. On that build,
all nine focused observe cases passed (43.5 s wall): the new warning case and
eight existing deletion cases, including the extended cancellation regression.

The first full shard `3/5` run passed 122/123 cases; an unchanged Bundle Comparison
case timed out on its initial Older-bundle picker click while waiting for browser
actionability. The picker was present, and the trace recorded no network failure
or page crash; the cause was not established. The exact case passed three
unchanged repeat executions, then the complete unchanged shard passed all 123
cases in 256.7 s, with no skipped cases, per-case retries, global errors or manual
teardown. The original failure and trace remain retained. No comparison code,
fixture, timeout or startup workaround was changed to obtain that pass.

The second affected shard, `5/5`, passed all 89 cases in 314.6 s, including all
33 merge cases (131.0 s case work). The accepted full-shard runs cover 212 cases
across 19 files; both used two workers and completed automatic teardown without
per-case retries, skips or global errors. The merge and explicit-bundle work
hints remain unchanged. Ports 5183 and 5184 independently refused new connections
after cleanup. The new `verification.json` binds the tested runtime, compiler
configuration, final documentation and accepted reports; earlier failed probes
remain diagnostic evidence. No commit, push, deployment or hosted timing claim
is part of this follow-up.

## Test maintenance review - 2026-11-26

The focused test audit keeps each distinct lifetime and compatibility boundary,
while consolidating duplicated setup and observations:

- The standalone destination/action reselection case was removed. Its field
  and review-table assertions now live in the existing controlled-clock case,
  which also checks dependency reselection and waits through a full debounce
  window before asserting that no request was sent.
- The presentation case no longer repeats that reselection/refresh journey.
  Obsolete assertions about removed buttons, old labels, filters and copy were
  removed; current headings, fields, option hints, table structure and layout
  remain covered. The successful and recovered-write cases retain their distinct
  receipt outcomes, with shared layout checks exercised once. Pre-render duplicate
  admission still belongs to the dedicated held-mutation case.
- The six pure cases now share a complete typed preview fixture with coherent
  project/destination identities. The partial double-cast fixture was removed.
- `bundleApiFixture.ts` owns the shared fallback API responses and rejects
  unclaimed mutations. Both merge and explicit-bundle scenarios use it, so
  background requests no longer reach an ambient API. Merge-only parsed-response
  holds remain in `bundleMergeFixture.ts`; its explicit fixture dependency releases
  those holds before shared route teardown. The `parsed()` barrier name distinguishes
  parsed response bytes from a held route's `received()` request-arrival barrier.
- That guard exposed a missing response in the lost-duplication-acknowledgement
  fixture: its legacy `/duplicate/recover` request previously fell through to an
  ambient API. The scenario now returns an explicit unknown receipt and checks
  that the lookup repeats the admitted body, with one write and one lookup.
- Both queued-command cases install Playwright Clock before page code starts,
  while leaving time flowing through setup. No test timeout, retry count, worker
  policy or application timing was changed.

The merge spec now contains 32 cases, explicit bundles retain 24, and the pure
file retains six. The complete files remain selected by normal CI. This is a
test-only change; application sources and the verified production build are
unchanged. Validation reuses that build and exercises both affected files under
the observe and normal two-worker CI configurations.

Validation passed the six pure cases, all four focused web typechecks and all
326 web tests, typed lint, test-style, repository/import and formatting checks.
The first full observe run passed 55/56 and exposed the missing legacy recovery
response above; after its explicit fixture repair, both duplication recovery
cases passed through observe. The final two-worker CI run executed all 56 cases
in both affected files, with zero skips, retries or global errors: 131.5 s wall /
195.9 s summed case work. Its case inventory differs from the prior suites only
by the removed duplicate. This is a focused CI-file run, not a new full-matrix
or hosted timing result. The earlier comparison timeout remains documented and
was not given a retry or timeout workaround.

Evidence is retained under `artifacts/bundle-merge-test-review-20261126/`.
Application and compiled-asset hashes match the pre-review receipt; both owned
preview ports were closed after verification. The 155-second merge and
180-second explicit-bundle weights are unchanged. Do not infer a hosted speedup
from this local run.

## Final comparison and commit scope - 2026-11-26

The comparison against `aec67d05d` found no new blocking regression in the
reviewed diff. The five reproduced admission races are fixed, and request/review
ownership is separate from rendering without adding a request framework, polling
or API round trip. Transport, parent reconciliation, backend, schema and deployment
owners remain unchanged.

The modal decreased from 911 to 685 lines, but the four affected production files
grew from 1,134 to 1,214 lines in total, including the new 292-line controller.
The maintainability gain is clearer ownership and stronger admission checks,
not a reduction in total source size.

Commit preparation verified the current source and build hashes against the
passing receipts above. Subsequent cleanup only clarifies documentation; it does
not invalidate the recorded 326 web tests, 56-case final browser run or earlier
full affected-shard application checks. The unexplained comparison startup
timeout and concurrent local native-allocation failure remain documented; passing
reruns did not establish their causes. Hosted timing and production behavior were
not remeasured. Local diagnostic artifacts and the recurrence checklist remain
Git-ignored and outside the commit.

## Investigation of intermittent local validation failures - 2026-11-26

Follow-up investigation used committed source `6e1e80160` and the same compiled
dashboard asset. Neither original failure was reproduced, so neither is marked
fixed. Application code, test assertions, timeouts, worker counts, Chromium
arguments and deployment safeguards were left unchanged.

### Browser action timeout

**Status: unresolved.** The original timeout's cause has not been established.

The retained failed trace contains a 12.8-second gap between rendered frames.
Playwright had found the Older bundle input but was still waiting for actionability;
the later screenshot shows the input unobstructed. Correlation with the original
shard report found that the other worker's independent `late AI results cannot
overwrite a retired switch session` case took 16.4 seconds during the same interval.
This supports investigating a shared browser or machine pause, but does not
identify its cause or prove an application rendering defect.

Fresh verification passed all 123 cases in the unchanged two-worker CI shard in
255.9 seconds. A diagnostic wrapper then passed ten repetitions of the exact
comparison case, followed by ten repetitions of each of the original concurrent
cases together (20 executions). The wrapper added passive long-task/visibility
observations and failure-state capture without replacing the application actions.
The longest observed main-thread task was 291 ms. These 30 diagnostic executions
supplement the standard shard; they are not additional distinct regression cases.
All runs had zero skipped cases, retries or global errors and settled their
preview processes normally. No forced click, animation override or longer timeout
was used. A persistent selector, modal or initialization failure was not established.

### Native allocation failures

**Status: unresolved.** The original allocation failures' cause has not been established.

The original logs show one Vite native allocation failure and two Node test
processes failing native allocation. The later measurements cannot reconstruct
the machine's resource state at that earlier instant. The Windows System log
query returned no resource-exhaustion events for the retained failure interval.

The diagnostic runs used Node 24.22.3 x64 on this 14-logical-processor machine,
with no `NODE_OPTIONS` override and a 4.2 GiB JavaScript heap limit. They sampled
system commit and physical-memory counters and the owned process group, including
native build tools. The process group's Windows Job Object had no memory limit.
The paging file was automatically managed and the system drive had about 60 GiB
free when checked. These are current observations, not evidence of the original
instant of failure.

| Local diagnostic command       | Wall time | Peak process-group commitment | Minimum system commit headroom | Result                                  |
| ------------------------------ | --------: | ----------------------------: | -----------------------------: | --------------------------------------- |
| Production web build alone     |    62.6 s |                       6.4 GiB |                        7.1 GiB | Passed                                  |
| Full web-test command alone    |    28.9 s |                       6.2 GiB |                        7.4 GiB | 326 tests and focused typechecks passed |
| Both commands started together |    69.3 s |                       9.2 GiB |                        4.2 GiB | Build and all 326 tests passed          |

The overlap probe would have stopped only its owned Node processes, after checking
creation identity, if system commit headroom fell below 2 GiB. That diagnostic guard
did not fire. The overlap's lowest available physical memory was 18.1 GiB, showing
why physical free memory alone is an incomplete description of the available
commit budget. Counter definitions follow the Windows
[performance information](https://learn.microsoft.com/en-us/windows/win32/api/psapi/ns-psapi-performance_information)
and [Job Object accounting](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_extended_limit_information)
contracts.

Keep local build and full-test verification sequential when resource headroom has
not been measured. The hosted web-test job already depends on the completed build
job. The single overlap trial is diagnostic evidence, not a parallelization or
hosted-speed recommendation. It establishes neither a leak nor the original
allocation cause, and does not justify changing heap limits, paging configuration,
test concurrency or retry policy.

Raw traces, passive browser probes, resource samples and command results are kept
under `artifacts/validation-diagnostics-20261126/`. Both original anomalies remain
unresolved observations. If either recurs, retain contemporaneous frame/long-task,
process and system commit evidence before changing code; passing reruns alone
must not close it. The application asset still matches its pre-investigation hash.
