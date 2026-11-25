# Local storage upgrade screen refactor plan

Status: implementation and local verification are complete, including the
preparation-read guard and test review on 2026-11-25. Hosted exact-commit CI and operational
qualification remain separate.
Source baseline: `develop` at
`3e73a396a52add579e0e292d6d1f6b5dce0c2ee5`, reviewed on 2026-11-24. The checkout
was clean before planning. The sequence and invariants below remain the delivery
contract; the implementation record at the end distinguishes measured results
from pending hosted and operational qualification.

## Goal and scope

Separate the local-upgrade screen's request/state ownership from its rendering,
and make control eligibility and acknowledgement binding independently testable.
Preserve functionality, compatibility, request sequences, timing, diagnostics,
downloads, accessibility and recovery safeguards.

The baseline owner was
[`LocalStorageUpgradeSettingsTab.tsx`](../../packages/studio-server-web/dashboard/app-settings/tabs/LocalStorageUpgradeSettingsTab.tsx).
It had 1,158 lines, 16 state hooks, eight refs and six effects. Those counts are
investigation context, not reduction targets. The useful outcome is one place to
review polling/actions and one place to review eligibility, without introducing
another migration state machine or a wider coordination interface.

There is one explicit prerequisite correction, separate from the extraction:
the current preparation-fingerprint adoption can dereference an absent payload.
Characterize and fix that case before setting the refactor comparison baseline.
Preserve all supported behavior; do not describe that bug fix as a mechanical move.

The backend journal and authenticated operator service remain authoritative.
This refactor changes no route, wire format, storage format, schema, backend
transition, authorization policy, deployment setting or observation window.
Keep `LocalStorageUpgradePrompt`, `DuplicateProjectRepairPanel`, the Settings
mount boundary and existing CSS behavior intact. Test-fixture and CI registration
changes described below establish coverage; they do not enable a live upgrade.

The operating contract remains [Local metadata storage upgrade](local-metadata-upgrade.md).
Its [completion plan](local-metadata-upgrade-completion-plan.md) separately tracks
operational/recovery qualification.

## Source owners to inspect before editing

- Screen: `packages/studio-server-web/dashboard/app-settings/tabs/LocalStorageUpgradeSettingsTab.tsx`.
  `refresh` starts at line 221, polling at 283, `act` at 306, preparation admission
  at 377, backup binding at 454, resume binding at 475, automatic validation at
  512, and copy eligibility at 532 in the baseline.
- Mount: `packages/studio-server-web/dashboard/AppSettingsModal.tsx` conditionally
  renders this tab. Leaving it ends this controller's browser session. Durable
  server preparation can survive reopening; browser attestations do not become
  durable acknowledgements.
- Repair presentation: `packages/studio-server-web/dashboard/app-settings/tabs/DuplicateProjectRepairPanel.tsx`.
  Preserve its analysis-token React key, local choices and confirmation lifetime.
- Prompt: `packages/studio-server-web/dashboard/LocalStorageUpgradePrompt.tsx`.
  Its page dismissal, polling and retry rules are independent; do not merge them
  with the panel's two-second poll.
- Settings eligibility: `AppSettingsModal.tsx` independently reads setup with a
  five-second bound and schedules another read three seconds after settlement.
  Its authorization/completion rules can unmount the tab. Transient read failure
  preserves visibility. Keep this owner unchanged and account for its requests.
- Transport errors: `packages/studio-server-web/dashboard/apiRequest.ts`.
  Retain `parseJsonResponse`, including HTML/gateway and incomplete-JSON handling.
- Shared DTO members: `packages/studio-server-shared/local-upgrade-types.ts`.
  Preserve the screen's optional capability fields for older-server responses.
- Server boundaries, for reference only:
  `packages/studio-server-api/src/routes/local-upgrade-http.ts` and
  `packages/studio-server-api/src/local-metadata/operator-service.ts`.

All paths in this plan are relative to the repository root unless linked.

## Small target structure

Use three production modules in the existing `app-settings/tabs/` directory:

| Module                                      | Owns                                                                                                                                                        |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `localStorageUpgradeModel.ts` (new)         | Screen-local DTO/state types and pure derivation of tokens, current proofs, capability branches, progress identity and control eligibility.                 |
| `useLocalStorageUpgradeController.ts` (new) | The existing state/refs/effects, request helper, polling, action serialization, reconciliation, named commands, form edits and imperative download effects. |
| `LocalStorageUpgradeSettingsTab.tsx`        | Rendering, action labels/progress copy, `UpgradeActionButton`, accessibility, layout and wiring to named controller actions.                                |

The model imports no React, browser globals, timers or transport. The controller
imports the model and shared contracts; it does not import the view. The view
imports both. Define the action union in the model and check the view's existing
`actionProgress` with `satisfies Record<UpgradeAction, string>` so labels remain
exhaustive without a circular import.

The controller should return a bounded `{ state, derived, actions }` result,
inferred from its implementation where practical. Expose the values the screen
already uses and named actions; do not duplicate that entire result in another
handwritten interface. Keep `act`, `request`, raw state setters and mutable refs
private. The screen must not retain request branches inside JSX callbacks.

Keep simple presentation conditions and formatting in the view. Centralize
permission/proof calculations, not every JSX expression. The existing typed
transition-action helper may remain one controller method for its finite action
union; six forwarding wrappers would add no ownership benefit. Other commands
retain names that describe their user intent, not endpoint strings.

Keep closely related work together. A separate transport service, global store,
generic polling framework, command dispatcher and independently mounted hooks
are unnecessary. Moving download effects into named controller actions preserves
their ordering without adding another owner. Do not split the JSX into more
panels merely to meet a line-count target.

## Behavior contract

### Request lifetime and timing

1. Keep the immediate mount poll and two-second interval. The poll remains
   single-flight and does not start while `actionInFlight.current` is true.
   Preserve the existing setup-cache condition: ordinary settlement reads status
   once; first-time preparation can require setup plus status or setup alone.
2. In `refresh`, setup and status each keep their own ten-second bound; this is
   not a shared ten-second bound on the combined read. In-action reads, including
   status reads in guided pause/transition flows, currently have no explicit
   timeout and retain that behavior. Diagnostic lookup keeps its ten-second
   timeout and cleanup abort. Preparation POST admission keeps its ten-second
   acknowledgement timeout; durable work can outlive it. Do not add timeouts to
   the other existing action requests.
3. Preserve `cache: 'no-store'`, suffixes, GET/POST selection, JSON headers,
   `X-Rivet-Migration-Intent: '1'`, body omission and HTTP-204 handling exactly.
   Reuse the current JSON/error parser; add no automatic request retries.
4. `act` sets its synchronous ref guard and invalidates older reads before its
   first await. It stays busy through the action and its post-action status read.
   Rendering state alone cannot replace the ref that rejects rapid repeated clicks.
5. Success and failure both attempt fresh status while still mounted. A failed
   reconciliation locks controls and preserves the action diagnostic. A lost
   response does not permit replay of a pause, preparation, copy or transition.
6. Keep request-sequence checks on both successful and failed refreshes. Unmount
   invalidates pending reads and clears the timer. It does not cancel or replay
   accepted server work, persist browser attestations, or create a second poller.
7. Preserve captured operation context across awaits. A fingerprint belongs to
   the maintenance session captured when it was requested; a validation failure
   belongs to its captured resume token. Reading a newer ref after the await must
   not relabel an older result as evidence for a replacement session.
8. Preserve the intentional fresh read before a guided restart after a successful
   non-validation transition. Restart uses that response's revision. The five-minute
   restart-warning grace remains; fresh available status without restart required
   clears it. Neither a fulfilled restart request nor an elapsed timer proves ready.

Serialization and sequence ownership are local to the mounted tab. Preserve the
existing continuation of an action already awaiting a response after unmount;
its remaining request steps do not gain cancellation or automatic replay. Its
late browser updates cannot enter a newly mounted controller. Server fencing
remains the authority across operator/browser sessions; add no global action lock.

Keep the empty-dependency polling effect's lifetime semantics when moving it.
Do not recreate its interval whenever status, inputs or derived objects change.
Keep interval ticks that skip while busy; a timeout scheduled after settlement
would change the cadence and must not replace this interval.
Do not add memoization or reduce state/ref counts during the mechanical move.

### Exact acknowledgement bindings

Retain these expressions, including optional values, empty strings, field order
and null behavior. Do not add required fields while moving them:

```ts
const sourceFingerprint =
  frozenSource?.pausedAt === status?.maintenance?.enteredAt ? frozenSource?.fingerprint ?? '' : '';
const normalizedBackupReference = backupReference.trim();
const backupToken =
  sourceFingerprint && normalizedBackupReference && backupFingerprint === sourceFingerprint
    ? JSON.stringify([
        status?.maintenance?.enteredAt,
        transition?.revision,
        sourceFingerprint,
        normalizedBackupReference,
      ])
    : null;
const resumeToken =
  validating && transition?.generationId
    ? `${transition.generationId}:${transition.phase}:${transition.revision}:${status?.maintenance?.enteredAt}`
    : null;
```

Backup and key attestations compare against `backupToken`. Write-resumption
acknowledgement and validation-failure presentation compare against `resumeToken`.
They are different bindings; do not replace them with one generic token or add
fields during this behavior-preserving extraction.

In particular, the backup token does not currently contain the generation ID.
The separate proof-adoption correction below does not change either token format.

Preserve the current resets:

- Editing either backup field clears both backup/key attestations. Reference text
  is trimmed for comparison; fingerprint input is trimmed on edit as today.
- New repair identity clears inventory, frozen source and backup/key proofs.
- Unreadable preparation status clears those preparation proofs. A replacement
  fingerprint job invalidates old proof even when the new read fails or stops.
- A ready automated backup is adopted once per backup ID; it sets the exact
  browser-backup reference and fingerprint and clears attestations/download notice.
- Failed/unavailable operator status clears resume acknowledgement. Validation
  start clears its acknowledgement and previous local validation failure.
- Preparation acknowledgement clears the local action error only when its ID
  matches `preparationRequest.current`; unrelated retained jobs cannot clear it.

Automatic validation remains one attempt per resume token, recorded before
dispatch. Preserve its readiness/drain guards, explicit manual retry and failure
presentation. Polling never becomes automatic resumption or repeated validation.

### Control eligibility and presentation

Extract the existing expressions rather than replacing their policies. In
particular, preserve:

| Boundary             | Required behavior                                                                                                                                                                                                                                          |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Preparation          | Disable while busy, awaiting restart or setup/status reconciliation has failed. A fresh setup confirming incomplete prerequisites still permits preparation despite unavailable upgrade status. The read-error gate is the explicit 2026-11-25 correction. |
| Repair recovery      | Use `operationDisabled`, `!!status?.repairStatusUnreadable` or `restartRequired`. The first retains busy/restart/preparation/copy/unavailable gates. Do not substitute global `disabled`, which also blocks applying repair and can lock recovery.         |
| Older capabilities   | Preserve `!== false` versus `=== true`. Absent encryption capability still requires key attestation; explicit plaintext settings do not. Guided readiness requires `runtimeReady === true`; manual compatibility retains its current rule.                 |
| Capacity             | Guided pause-and-backup requires its inspection to pass. Advanced pause keeps its own conditions. Copy retains optional-field compatibility and every current backup/fingerprint check.                                                                    |
| Copy retry           | Include `retryJobId` only for retained failed/interrupted work matching the current fingerprint and backup reference. Other attempts are previous evidence, not reusable authority.                                                                        |
| Validation           | Durable validation, running/selected backend and drain gates control success. HTTP 204 alone is not proof. A current local validation failure blocks acknowledgement/resumption.                                                                           |
| Resumption           | Initial resume and Finish durable resumption keep distinct visibility, disabled predicates and progress identity, although both send action `resume`.                                                                                                      |
| Progress             | Local pending action, server operation, preparation stage and copy phase retain their precedence. Server activity can remain visible when its initiating row is unavailable.                                                                               |
| Optional diagnostics | Preserve preparation-versus-copy reference precedence, token matching, reference validation and cancellation. Lookup failure cannot unlock controls or hide durable failure.                                                                               |
| Downloads            | Backup/key navigation keeps its separate window, `noopener noreferrer` and absence of a forced download attribute. Starting a download is not an attestation. Report Blob creation, filename and deferred URL revocation stay intact.                      |

Keep labels, descriptions, alert/status roles, checkbox associations, details
defaults, hidden sections, responsive wrapping and the child repair key unchanged.
Secrets are not added to controller state, URLs, logs, reports or test artifacts.

## Command inventory: move every current inline branch

Expose named handlers for these current flows. Preserve their existing ordering
and mounted checks; this table is not a new dispatch abstraction.

| Flow                   | Existing transport/ordering to retain                                                                                                                                                                |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Prepare server         | `act` -> `/prepare` with `{}` through the restart helper -> reconciliation.                                                                                                                          |
| Guided pause/backup    | Clear inventory; prefer preparation `pause-backup`; older fallback reads inventory, checks capacity, posts pause, reads fresh status, then requests backup only if quiet and no restart is required. |
| Advanced inspection    | Clear inventory; preparation `inspect` or `/inventory` GET; adopt only under current mounted rules.                                                                                                  |
| Advanced pause         | Preparation `pause` or `/pause` POST with `{}`.                                                                                                                                                      |
| Fingerprint            | Clear frozen proof; preparation `fingerprint` or the existing synchronous `/fingerprint` GET; bind the result to the captured maintenance session and retain its current timeout behavior.           |
| Backup creation        | Preparation `backup` or `/backup` with the captured transition revision.                                                                                                                             |
| Duplicate repair       | Preparation `repair-inspect`, `repair` with choices, or `repair-recover`; preserve pre-repair proof resets.                                                                                          |
| Copy                   | `/copy` with revision, trimmed reference, fingerprint, restored acknowledgement, conditional key acknowledgement and conditional matching retry ID.                                                  |
| Transition             | `/action` with captured revision and action; validation has its existing proof/error resets; successful guided non-validation transitions reread status before an optional restart.                  |
| Restart                | `/restart` with the server-selected revision through the existing restart helper.                                                                                                                    |
| Report                 | `/report` GET inside `act`, Blob download, deferred URL revocation, then ordinary action reconciliation.                                                                                             |
| Backup/key download    | Existing authenticated attachment URL and notice; no status mutation or inferred completed download.                                                                                                 |
| Form/attestation edits | Named setters preserving trimming, proof resets and the token captured by each checkbox handler.                                                                                                     |

The transition handlers include activation, validation, resume, finish-resume,
return to legacy and cancel. Do not retain a generic `act(async () => ...)` escape
hatch in the view after the extraction is complete.

## Implementation sequence and gates

### 1. Establish coverage against the unchanged screen

Record baseline commit/diff, Node/Yarn/browser versions, built frontend identity,
commands, case counts, skips and timings under an ignored artifact directory.
Run the existing panel and prompt suites before changing production source.

The existing suites are:

- `packages/studio-server-web/playwright-observe/local-storage-upgrade.spec.ts`:
  polling/actions, lost acknowledgement, preparation, repair, backup evidence,
  capability fallbacks, validation, restart, layout and generation-bound resumption.
- `packages/studio-server-web/playwright-observe/local-storage-upgrade-prompt.spec.ts`:
  page/session guidance and opening/closing the surrounding Settings flow.

Some existing cases rely on a live dashboard/API bootstrap. Make these two suites
self-contained against a fresh frontend preview before registering them in normal
CI: reuse `mockHostedEditorBootstrap`, owned empty-tree/editor responses and the
existing helpers. Register defaults before case-specific overrides. Do not mask
unexpected API mutations with a blanket successful response. Retain all existing
scenario assertions; complete the fixture work against the unchanged screen.

Keep all upgrade mutations inside the fixture. Install a rejecting fallback
before scenario-specific routes, and record/fail unexpected methods or paths;
unhandled requests must not reach an ambient API through Vite's proxy. Keep
context-level mocks for attachment/pop-up requests, which a page-only route
cannot reliably intercept. Do not put upgrade-specific defaults into the shared
editor bootstrap helper or change unrelated suites.

Use existing cases as the primary owner. Add only missing held-response/count
assertions for stale reads, rapid duplicate activation, unmount/reopen, exact
preparation acknowledgement identity, automatic-validation uniqueness and late
diagnostic lookup. Browser clock control already exists in this suite; reuse it
for bounded polling assertions rather than adding sleeps or timing benchmarks.
Installing that clock does not pause it. Exact-count cases now opt into a paused
clock after Settings opens and before selecting the upgrade tab. At that point
the upgrade controller has not mounted, so clock setup cannot advance one of its
timers. Advance polling explicitly with `runFor`; leave native deadline cases on
real time. Do not pause before dismissing the prompt: its modal exit transition
needs timers to complete.

Count requests by exact path/method and controlled phase. Dismiss and settle the
prompt before tab-specific counts; account separately for Settings' setup poll.
Use held responses and release them in cleanup even when assertions fail. Do not
assume the browser clock advances native `AbortSignal.timeout`; retain the real
stalled-read deadline case. Record case-work timings without counting artificial
clock advancement as elapsed runtime or treating whole-file duration as case work.

**Gate:** record the unchanged screen's complete hermetic-suite results and any
failures, with request order/count evidence and cleanup. Resolve the confirmed
baseline defect in step 2 before demanding a fully passing extraction baseline.
Any other defect gets its own reproduction and explicit disposition; do not
quietly change behavior while claiming extraction equivalence.

### 2. Establish a passing baseline and required verification

The normal web `build` runs a Google-hosted override check and Vite. It does not
typecheck this dashboard screen. Add a narrow, maintained
`packages/studio-server-web/tsconfig.local-storage-upgrade.json` and a package
script `check:local-storage-upgrade`. Follow the existing package's TypeScript
compiler invocation pattern. An in-memory TypeScript 5.7.3 probe has already
checked the unchanged screen with `ESNext` modules, `Bundler` resolution,
`react-jsx`/`@emotion/react`, `types: ['vite/client']`, inherited strict flags,
`composite: false`, `declaration: false` and `noEmit: true`. Use explicit roots
and a real web-project configuration path; do not inherit the whole desktop app
graph. The probe read 245 source/declaration files and found only two diagnostics:
TS18048 at line 366, where `preparation.fingerprint` may be absent.

A second read-only probe evaluated the exact existing adoption expression: the
missing-payload/no-maintenance case throws `TypeError`. A virtual presence guard
returns null for that case, retains the complete matching payload's result and
leaves zero compiler diagnostics. No application file was written. This confirms
the narrow correction's feasibility; it is not browser or recovery acceptance.

This is an actual baseline gap, not compiler noise: `ready` fingerprint work
without a fingerprint payload and without maintenance makes both optional
timestamps `undefined`; their equality then admits the dereference. The shared
DTO and retained preparation-record schema allow an absent payload. Establish
a regression case before touching this branch, verify the exception against the
unchanged screen, then add an explicit payload-presence guard at proof adoption.
The corrected case must clear old proofs, keep the panel mounted and leave copy
and resume unavailable; a complete matching payload must still be adopted.
Keep that small bug fix distinct from extraction and rerun both full mocked
suites to establish the new passing comparison baseline. Do not alter server
schemas, token formats or observation periods, or hide the diagnostics with a
non-null assertion, `any`, suppression or fake declaration.

Include the model, hook and model tests as introduced, with actual transitive
dependencies and appropriate Node test types. Confirm the compiler's file list.

Wire that command into the existing web `test` script. This keeps the check in
the required web-test lane with a complete checkout rather than introducing a
test-file dependency into production image builds. Confirm the actual include
list; a Vite build is not the substitute. Before this change, root ESLint selected
`packages/*/tsconfig.eslint.json`, so the new project is not picked up by its name
alone. Add a narrow override in the existing `eslint.config.mjs` for the three
production modules and model test using this project. Preserve existing rules;
do not expand lint scope or add another configuration framework. Run typed lint
from the root on changed files and inspect moved effect dependencies explicitly.

At baseline, neither mocked upgrade spec was in `editorCiSpecs` in
`scripts/ci/editor-test-shards.mjs`. Add both after hermetic baseline verification,
using measured case-work hints labelled as local estimates, with the existing
serial/parallel rules during extraction. The separate test review below enables
parallel cases only for the independently isolated panel suite. The baseline four
shards each contained exactly 1,080 seconds
of work hints: all 4,320 seconds of their combined allowance are allocated.
Adding positive work cannot fit that four-shard plan. Do not lower old weights,
use zero weights, exclude cases or relax the 1,080-second allowance/5% balance
check to conceal this.

Use five shards in the existing editor matrix, provided measured new work fits
the resulting allocation. Keep this a fixed fifth shard, not a generic sharding
framework. Update these owners together:

- `scripts/ci/editor-test-shards.mjs`: five groups, selectors `1/5` through `5/5`,
  explicit errors for invalid selections, all 45 specs selected exactly once.
- `scripts/ci/ci-performance.test.mjs`: spec membership/count (43 -> 45), all five
  selectors, rejection of retired `/4` selections, five-shard count and unchanged
  per-shard budget/balance checks. Keep omitted selection meaning the full set.
- `.github/workflows/studio-server-verify.yml`: five editor entries with unique
  labels and `max-parallel: 5`. Keep two browser workers per job, the existing
  12-minute test/20-minute job bounds, `fail-fast: false`, required aggregation,
  exact compiled inputs, browser container ownership and cleanup.
- `scripts/checks/check-ci-workflows.mjs`: matching matrix/concurrency assertions.
  Preserve API/deployment shard counts; they are separate owners.
- `developer-docs/studio-server/ci-performance.md`: current selection/count and
  reproduction commands. Preserve historical measurements as historical.

Verify emitted cases for all five selections with `playwright.ci.config.ts`
and `--list`; run the complete local shard(s) receiving the upgrade suites.
Check report/artifact uniqueness and rejection of invalid selectors. If measured
work does not fit five shards, stop CI registration and report the measured gap;
do not claim completion or silently change budgets/test parallelism. The added
job also consumes runner capacity. After an authorized push, verify all five
hosted conclusions and queue/setup/test/total elapsed times. This is coverage
capacity, with no established speedup. There is no new workflow or browser lane.

**Gate:** the explicit baseline correction and maintained typecheck pass; both
full suites pass on that baseline under normal built-preview configuration;
five-shard membership, capacity, workflow policy and selection are proven locally.
Hosted acceptance remains pending until an authorized push has finished.

### 3. Extract the pure model first

Move screen-local types and existing derived calculations to
`localStorageUpgradeModel.ts`. Keep optional fields, token formulas, returned
object references and distinctions between preparation, ordinary actions and
repair recovery. Derive common flags before their dependent proofs/controls;
keep state-reset effects in the component until the next slice.

Add `packages/studio-server-web/tests/local-storage-upgrade-model.test.ts` to the
explicit web unit-test command. Use small, hand-authored expected outcomes:

- Matching/mismatching backup identity and each token's invalidation inputs.
- Guided/manual capability absence, plaintext/encrypted settings and unknown
  capacity/readiness values.
- Matching versus previous copy attempts and unavailable evidence.
- Preparation availability and recoverable applying-repair exceptions.
- Running/selected backend mismatch, current validation failure and resumption.
- Progress and diagnostic identity precedence.

Do not duplicate selector expressions inside assertions or reproduce the entire
browser matrix as unit tests. These tests own combinatorial policy; browser tests
own real request lifetimes and UI wiring.

**Gate:** original component using the extracted model has identical observable
behavior to the passing baseline established in step 2, passes the focused
typecheck/unit cases and the full mocked panel suite.

### 4. Move one controller lifetime and leave a rendering shell

Move the existing state, refs, effects and request helper into
`useLocalStorageUpgradeController.ts`. Initially preserve their order, guards,
closures, dependency lists and control flow. Keep one synchronous action guard,
one refresh sequence and one mount-bound polling effect. Move the optional
diagnostic lookup as its existing independent effect, not into action admission.

Replace every inline business callback with a named controller action from the
inventory above. Preserve captured revisions/tokens, setup snapshot caching,
preparation UUID ownership, automatic-validation attempt identity and all mounted
checks. Keep form resets and browser downloads with their current actions.

Keep effect dependencies on their current primitive identities. A freshly
allocated `derived` object must not replace those dependencies, retrigger
proof-reset/adoption effects or start repeated validation. Preserve the separate
diagnostic effect's token and abort lifetime. Introduce no reducer, event bus,
additional polling hook or new callback memoization during the move.

Call the hook unconditionally once from the existing screen component. Leave the
App Settings mount boundary, repair component/key, action renderer, strings and
CSS untouched. Return only the state/derived values/actions the view needs.
Do not export mutable refs or copy request policy back into the rendering module.

Compare combined source/interface cost against the baseline. An extra layer that
only forwards a broad set of setters/callbacks is not completion; keep coordination
inside the controller. Further simplification needs evidence after the mechanical
move, not a simultaneous reducer/effect rewrite.

**Gate:** both full mocked suites pass, including response loss, unauthorized and
stalled reads, duplicate clicks, reopening, revision changes and all progress/layout
cases. Compare route/method/body order and counts with the baseline.

### 5. Final verification and documentation

Run checks in dependency order. Root style may rebuild Core; finish it before
build-dependent checks. Use the same recorded Node/Yarn and a freshly built
frontend for the before/after browser comparison. Use focused checks while
editing: the new typecheck/model test, changed-file typed lint, the two shard
tests and workflow policy for CI edits. Do not repeat those commands separately
after unchanged inputs pass their broader owner. Final verification is:

```text
yarn test:style
yarn workspace @valerypopoff/rivet-studio-server-web run test
yarn workspace @valerypopoff/rivet-studio-server-web run build
yarn studio-server:verify:test-style
git diff --check
```

Root `test:style` already owns the shard tests, workflow policy, file-tree and
documentation-link checks. Web `test` will own the focused typecheck and new
model test. Retain these relationships instead of duplicating their final runs.
For the planned workflow YAML edit also run the expression check documented in
`ci-performance.md`: `actionlint -shellcheck= -pyflakes= .github/workflows/studio-server-verify.yml`.
No shell/Python bodies are planned to change; lint any such bodies if scope changes.

Run changed-file formatting and typed lint using the maintained browser project.
Baseline/build dependencies must exist before these commands; use the repository's
normal workspace dependency order, not an unrelated desktop native packaging job.
Reuse passing checks for unchanged inputs rather than repeating all suites after
every documentation edit.

For routine browser verification, start a fresh preview on an available port:

```text
yarn workspace @valerypopoff/rivet-studio-server-web run preview --host 127.0.0.1 --port 5174 --strictPort
```

In the verification terminal (PowerShell example; set the actual verified port):

```powershell
$env:PLAYWRIGHT_HEADLESS = '1'
$env:PLAYWRIGHT_SLOW_MO = '0'
$env:PLAYWRIGHT_BASE_URL = 'http://127.0.0.1:5174'
yarn studio-server:ui:observe local-storage-upgrade.spec.ts local-storage-upgrade-prompt.spec.ts
```

Also run the affected normal CI shards through `yarn studio-server:ui:ci` with
their selected `RIVET_EDITOR_TEST_SHARD` (`1/5` through `5/5` after registration);
the CI config starts its own fresh preview. Do not run two previews on the same
port. A complete passing CI-config execution of both mocked suites on the same
build can satisfy their final browser gate without repeating the observe run.
Record emitted selection, skips and exit codes. Inspect `artifacts/playwright/`
when a browser case fails.

The live/origin specs retain their existing, separate prerequisites. The live
spec requires `RIVET_LOCAL_UPGRADE_REHEARSAL_MANIFEST` and the disposable
production-image rehearsal; never run it as a migration against an ordinary VM
or developer stack. Do not add those gated specs to ordinary mocked CI, weaken
their guards, or count a skipped live case as passed. A UI-only extraction does
not require a Kubernetes rehearsal or change existing operational qualification.

Update `local-metadata-upgrade.md` with the final frontend owners, this plan with
actual outcomes/evidence limits, and `refactor-history.md` with the reason for the
ownership change and explicit baseline bug fix. Reconcile current shard commands
in `ci-performance.md`; keep one operating contract. If a commit/push is requested,
read the ignored recurrence checklist and stage reviewed source/docs only.

## Completion criteria and regression handling

- [x] Every current transport/action branch has a named owner; JSX has no hidden
      request workflow, raw setters or token construction. Permission policy stays in
      the model; ordinary presentation conditions remain readable in the view.
- [x] Pure derivation is side-effect free. Controller state/effects retain one mounted
      lifetime; no extra polls, status reads, retries, durable acknowledgements or
      automatic mutations were introduced.
- [x] Current UI, error/status precedence, downloads, old-server compatibility,
      revision bindings and operator safeguards match the passing baseline after the
      separately recorded baseline corrections.
- [x] The focused typecheck is maintained, includes all new modules, and runs in CI.
      New unit tests and both existing mocked browser suites are actually selected.
- [x] The five-shard allocation fits the unchanged work allowance; workflow selectors,
      matrix, policy assertions, report identities and current docs agree.
- [x] Unit/browser checks have distinct primary assertions, and all selected final
      checks pass without hiding diagnostics or weakening observation windows.
- [x] Source/interface overhead is explained, relevant docs are reconciled, owned
      browser/preview fixtures are cleaned, and no real installation has been changed.

On a mismatch, stop that extraction slice, preserve the failure evidence and
resolve it at its owner before continuing. Do not compensate by changing server
semantics, adding retries, accepting old status, shortening timeouts, broadening
mock responses or relaxing shard budgets. Unexpected baseline defects and
unrelated compiler failures are reported separately from refactor equivalence.

Implementation completion, hosted CI results and production/recovery qualification
remain separate claims. The implementation record below reports only the checks
that were actually run.

## Implementation record - 2026-11-24

### Delivered owners and compatibility

The three production modules are in `dashboard/app-settings/tabs/`:

| Owner                                 | Current responsibility                                                                                              | Lines |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ----: |
| `LocalStorageUpgradeSettingsTab.tsx`  | Rendering, labels, accessibility and bindings to named commands. No fetches, mutable setters or token construction. |   641 |
| `useLocalStorageUpgradeController.ts` | The original mount-bound state/effects, transport, serialized actions, reconciliation, form edits and downloads.    |   500 |
| `localStorageUpgradeModel.ts`         | Screen contracts, pure diagnostic/proof calculations and the explicitly named `controlDisabled` policies.           |   259 |

Their combined 1,400 lines exceed the original 1,158 by 242 lines. The additional
typed model input, named commands and grouped view interface have an explicit
maintenance cost; this is an ownership refactor, not a source-size reduction.
The controller returns inferred `state`, `derived` and `actions` groups and keeps
setters, refs, transport and action admission private. One typed transition
method retains the existing finite action union instead of forwarding wrappers.
There is no new reducer, polling framework, memoization or retained/global session.

An AST comparison against the corrected pre-extraction screen confirms the same
16 state hooks, eight refs and six effects in the same order. All six effect
callbacks/dependency arrays, `request`, `refresh`, `act`, `startPreparation`,
`downloadBackup`, `requestRestart`, `restartBackend` and the transition action
function retain their code after formatting. Inline action branches moved into
named controller methods. Request timing/count rules, captured revisions/tokens,
setup caching, compatibility fallbacks and download behavior remain governed by
the contract above.

The prerequisite baseline functional correction is explicit payload presence before
adopting a ready preparation fingerprint. The original expression dereferenced
an absent payload when both optional timestamps were undefined. The browser
regression reproduced a disappearing panel before the guard; after correction,
incomplete evidence clears old proof and cannot authorize copy or resumption.
No server schema or token format was changed.

The maintained `check:local-storage-upgrade` project includes all three production
modules and the policy test, and runs at the start of normal web `test`. A scoped
root ESLint override uses the same project. The web workspace declares its Node
test types directly, with the existing workspace version and regenerated Yarn
lock/PnP state. This check is not added to the production image build.
Shared-package imports replace the screen's two old deep-relative allowances;
no new import-boundary allowance was introduced.

### Behavior checks and measured limits

- The unchanged screen passed all 85 existing panel/prompt cases, without skips
  or retries, against a fresh production build. Node was 24.22.3 and Playwright
  was 1.62.1. The focused compiler independently reproduced the two TS18048
  fingerprint diagnostics before the guard.
- The corrected pre-extraction baseline passed all 91 cases: the 85 existing
  cases plus six new cases covering incomplete fingerprint proof, late success
  and failure polls with rapid activation, preparation acknowledgement identity,
  automatic-validation attempt identity and replacement diagnostic lookup.
  The fingerprint regression waits for the intended response and DOM transition;
  a prior-state assertion is not accepted as proof that the bad response rendered.
- The intermediate model extraction passed all 68 panel cases, the 11 focused
  policy tests, the maintained compiler and typed lint before the controller move.
- Existing browser cases retain their assertions. A shared closed fixture owns
  bootstrap/empty-tree/editor defaults and rejects unmatched upgrade methods or
  responses without contacting an ambient API. Duplicate bootstrap setup was
  removed. The five existing held-response owners now release their gates in
  `finally`; new race cases do the same. Native read-deadline cases retain their
  real timeout observations.
- Normal CI registers both mocked suites in five required editor shards.
  Initial Playwright collection selected 45 files and 500 unique cases exactly
  once, including all 91 upgrade cases in shard 2/5. The 455/140-second local
  work hints preserve serial file behavior and the existing 1,080-second
  per-shard allowance; allocated work is 985/985/985/980/980 seconds.
- The final production sources passed root `test:style`, typed lint and all
  312 web tests (273 TypeScript tests, including the 11 model cases, plus 39
  development/production-runtime tests). The final frontend build passed.
  Workflow policy and actionlint 1.7.12 passed for the five-entry matrix.
- The pre-reassessment receiving CI shard passed all 134 cases without skips,
  retries or failures, including all 91 upgrade cases. It used two workers and
  a fresh preview, completed in 545.3 seconds, and automatically stopped its
  preview; the port was independently confirmed closed. Final collection across
  the five shards was 120/134/103/76/67 cases, with all 45 files and 500 cases
  selected exactly once. This is local evidence, not a hosted speedup result.

Local source snapshots, JSON reports and diagnostic receipts are under the ignored
`artifacts/local-upgrade-screen-refactor-20261124/` directory. They certify local
checks of the working-tree source, not a new committed/deployed release. One CI
startup correctly refused the occupied standalone-preview port; that preview
was stopped through its owning execution session before a fresh CI preview was
allowed to start. `reuseExistingServer: false` was retained.

The first final shard also passed all 134 cases, but sandbox permissions denied
Playwright's Windows `taskkill` during preview cleanup. A disposable owned-child
probe reproduced the access denial. Only the verified test preview was stopped
outside the sandbox; a complete rerun under ordinary Windows permissions then
proved automatic teardown. The blocked cleanup interval is excluded from timing
claims. No application, CI process-cleanup or deployment safeguards were weakened.

Hosted execution of all five exact-commit shards, runner queue/setup/elapsed
measurements and normal release gates remain pending an authorized push. No
hosted speedup is established. The live/origin rehearsal prerequisites and actual
installation recovery/upgrade qualification were not exercised or changed.

### Reassessment - 2026-11-24

The ownership review retained the production implementation. A read-only AST
comparison regenerated all three expected owners from the corrected baseline
and matched the current modules. There is no further hook/model change or added
state, effect, timer or coordination abstraction. Nine duplicate empty-tree and
paused-editor route overrides were removed; their cases now use the shared
fixture and retain their assertions.

The new lost-validation-acknowledgement case follows the real journal contract:
`recordRuntimeValidation` commits its evidence and increments the revision in
one transaction. Fresh durable success therefore has a new resumption token,
does not inherit the earlier revision's browser validation failure, and needs no
automatic validation replay. The old action diagnostic remains visible; the
resumption checkbox remains unchecked until the operator confirms it. A failed
validation with no successful new revision retains its existing failure gates.

An initial candidate mock held the revision fixed while committing success and
thus appeared to strand the retry control. That state cannot be produced by the
real journal. Its proposed UI change was removed and the mock corrected before
acceptance. The rejected candidate's failing trace and interrupted suite are
diagnostic artifacts, not evidence of a production defect or final verification.

The production build, all 312 web tests, maintained typecheck, typed lint and
test-style guard passed again. All 92 panel/prompt browser cases passed without
skips or retries: 69 panel cases and 23 prompt cases, including the corrected
lost-acknowledgement case. The fresh built-preview observation used two workers
and completed in 462.8 seconds; the preview was stopped and its port independently
confirmed closed. Production and fixture source hashes stayed unchanged during
the accepted run.

Final CI collection selected 501 unique cases in 45 files exactly once, with
120/135/103/76/67 cases across the five shards and all 92 upgrade cases in shard
2/5. The existing work hints and budgets remain unchanged. This reassessment
executed both complete upgrade suites locally; the earlier full CI-config shard
receipt predated the additional case. The completion audit below records the
current CI-config execution. Hosted timing and release qualification
remain separate and pending. Reassessment evidence is in ignored
`artifacts/local-upgrade-screen-refactor-review-20261124/`.

### Completion audit - 2026-11-24

All seven implementation criteria above were checked against the current code,
configuration and accepted test evidence. No implementation work remains in this
refactor's scope. The final receiving CI shard was rerun to include the last
regression: `RIVET_EDITOR_TEST_SHARD=2/5 yarn studio-server:ui:ci` with list/JSON
reporters and an owned output directory. All 135 cases passed without skips,
retries or failures, including all 92 upgrade cases and the new journal-revision
reconciliation case.

The run used the existing two workers and CI configuration, took 533.3 seconds
locally, and automatically terminated its fresh preview. An independent port
check confirmed closure. Production and fixture source hashes still match the
accepted observation run. This closes the local CI-config verification gap;
it is not a hosted timing or release result. The `completion-ci` logs, JSON
report and summary are in the reassessment evidence directory above. These
receipts cover a working-tree build; hosted exact-commit checks and operational
qualification remain separate, as described above.

### Adjacent safety review - 2026-11-25

The earlier missing-payload defect and rejected validation mock prompted checks
at the owning schemas and supervisor. Ready backup records already require a
non-null archive hash and positive size; invalid records become unreadable
evidence. Successful validation already commits evidence and revision together.
Neither case justifies additional frontend parsing or an alternate recovery path.

First-time preparation did expose a real gap. The supported unconfigured setup
has an available preparation capability and a missing control root. If the
preparation response and its fresh setup reconciliation both fail, the existing
`statusError` locks ordinary storage controls but previously left Prepare enabled
after its spinner stopped. The parent Settings owner intentionally retains the
tab during HTTP 503 failures, so this is not resolved by a remount or server-side
provisioning guards. The browser regression failed on that enabled button before
the correction, after explicitly waiting for `aria-busy=false`.

The model now receives the controller's existing `statusError` and disables
Prepare while that read-error state is present. No new state, effect, poll,
request, timeout or retry is introduced. A successful fresh setup read clears
the error gate, preserves the original action diagnostic and permits an explicit
retry without starting one. Unavailable ordinary upgrade status still does not
block initial preparation after a successful setup read. The original AST
identity receipts describe the mechanical extraction before this separate
policy correction.

The focused browser regression passed against a fresh build after the correction.
All 312 web tests, including the 11 model cases with the added read-error/recovery
assertions, the maintained typecheck, typed lint, build and test-style guard passed.
The complete receiving CI shard then passed all 136 cases without skips or retries,
including all 93 upgrade cases (70 panel and 23 prompt). It used the unchanged two
workers, took 544.0 seconds locally and automatically terminated its preview; the
port was independently confirmed closed. Source hashes stayed unchanged during
that run.

Actual collection across all five selectors selected 502 unique cases in 45 files
exactly once: 120/136/103/76/67 cases. Work hints, budgets and worker counts are
unchanged. A direct source comparison confirms that the controller delta is only
passing the existing error into the model, and the model delta is only that input
and the preparation gate. Evidence is retained under the ignored
`artifacts/local-upgrade-screen-adjacent-review-20261124/` directory. These local
checks establish no hosted speedup or new operational qualification.

### Comparison against the last commit - 2026-11-25

The assessment baseline is `3e73a396a52add579e0e292d6d1f6b5dce0c2ee5`.
Before the test review below, the complete working diff had 22 files, including
the six new files; ordinary
`git diff --stat` excludes those new files. Backend, schema, shared wire-contract,
executor and deployment sources are unchanged. There were no hidden tracked-file
change flags. No additional confirmed functional regression was found.

A fresh extraction from the actual Git HEAD, allowing only the documented
fingerprint-presence and preparation-read-error corrections, matched all three
current production modules structurally. The 16 state hooks, eight refs and six
effects remain. The original browser test declarations and assertion expressions
are retained. Current production, fixture and model-test hashes match the accepted
312-web-test and 136-browser-case evidence; no unchanged suite was rerun merely
to refresh the date of the result.

The generated PnP change declares the web workspace's existing Node type version
directly and coalesces six equivalent peer variants. Physical package versions,
the generated loader's runtime code and non-Node-type dependency resolutions
remain unchanged. All package references resolve. The loader/lock hashes still
match the successful immutable cached reinstall. Comparison evidence is in ignored
`artifacts/local-upgrade-screen-assessment-20261125/`.

The verdict is a net improvement for this scope: two confirmed baseline failures
are fixed, eligibility/proof policy is independently testable, and both upgrade
browser suites plus the focused typecheck enter required CI. This does not reduce
the inherent state-machine complexity. The three owners total 1,400 lines versus
1,158 before, and the controller still requires careful lifecycle review. The
additional interface cost is justified by ownership and checks, not fewer lines.

CI now has five required editor jobs instead of four. That adds coverage capacity
and another job's setup/runner cost; hosted queueing, cost and total workflow
impact have not been measured. Only the affected 136-case shard was executed in
the final local CI run; collection proves selection of 502 cases, not execution
of all 502. All five hosted conclusions and their queue/setup/test/total timings
remain outstanding. This is a working-tree reliability assessment, not production
qualification or proof of a workflow speedup.

### Test review - 2026-11-25

The 11 pure model cases cover policy/token calculations; the 70 panel cases cover
request/action lifetimes and rendered controls, and the 23 prompt cases cover the
surrounding page/Settings journey. These are complementary boundaries, so no case
was removed as stale or redundant. The live/origin suites still require their
separate enabled-instance or disposable-rehearsal prerequisites; this test-only
review does not run them against an ordinary development installation.

The panel suite now uses its common navigation helper instead of three duplicate
openers (six call sites). Its optional prompt dismissal uses a scoped locator
handler during Settings opening instead of an unconditional one-second probe and
catch. Two per-button assertion loops use one auto-waiting collection assertion
that no enabled button remains. Scenario names, request assertions and recovery
checks are retained.

Exact-count polling cases now explicitly pause the browser clock before the
upgrade controller mounts. A real browser probe confirmed `clock.install()` alone
keeps advancing, which allowed assertion time on a slow machine to introduce an
uncontrolled poll. Clock setup happens after the prompt has closed and Settings
has opened; pausing before navigation was rejected because it stalled the modal
exit transition. No active upgrade timer is fast-forwarded during setup. Native
stalled-read deadline cases, real observation windows and production timeouts are
unchanged.

All panel cases own their browser context, route state and output paths, with no
real upgrade or shared fixture service. They now opt into parallel scheduling on
the existing two workers. Prompt cases keep their serial scheduling. This removes
a scheduling tail without adding a worker or relaxing assertions, retries, work
hints or CI budgets. Full receiving-shard verification is recorded after the
final run below.

The first full shard passed all 93 upgrade cases but exposed a neighboring
published-history test race. That test counted the restore request and checked
endpoint/Current text that already existed before restoration, then navigated
while the mutation was still settling. Its trace shows the tab was initially
enabled during Playwright's actionability check and disabled before the click
completed. The existing navigation guard correctly kept history open. The test
now waits for the newly restored version's enabled comment control before
navigating, proving both the new identity and mutation settlement without a sleep
or relaxed timeout. No production source changed. The failing trace and first
report remain in the ignored test-review evidence directory.

Final verification passed 24 targeted panel executions (12 cases repeated twice)
and four executions of the corrected history journey. The complete receiving CI
shard then passed all 136 cases, including all 93 upgrade cases and the ten
published-history cases, without skips, failures or retries. Both existing workers
ran panel cases. The runner automatically terminated its preview, and an
independent connection check returned `ECONNREFUSED` for its port. The eight
reviewed source/fixture/test input hashes stayed unchanged during that final run.
The test-style guard, documentation links and diff checks passed. Application,
fixture and model-test sources still match the accepted 312-web-test/build
evidence; unchanged owners were not rerun just to refresh their receipts.

The successful final local shard took 403.6 seconds, compared with the preceding
544.0-second run of the same 136 cases. Panel/prompt case work was 498.1/122.8
seconds, versus 481.3/125.9 seconds before this review. Elapsed time decreased in
this local comparison while panel case work increased slightly; this is not a
claim of lower CPU cost or a hosted workflow speedup. The 455/140-second scheduling
hints, two-worker limit and CI budgets remain unchanged pending hosted evidence,
including runner queueing. Reports, source hashes, the failed first-run trace and
port proof are retained under ignored
`artifacts/local-upgrade-test-review-20261125/`. This does not qualify a production
upgrade or the separate live/origin rehearsals.

### Commit preparation - 2026-11-25

The final diff contains the screen/model/controller extraction, the two documented
baseline corrections, focused model checks, isolated browser coverage and the
five-shard CI registration. No backend, schema, recording format or deployment
source is included. The reviewed dependency loader and lockfile still match the
successful immutable reinstall; no additional package version changed.

The last cleanup formats the touched published-history spec. Its TypeScript
syntax tree is unchanged before and after formatting; the other seven
accepted application/fixture/test inputs remain byte-identical to the successful
136-case CI run. Existing 312-web-test/build and browser evidence is retained
instead of rerunning unchanged behavior. Developer documentation records current
ownership and the separate hosted/operational gates. Private receipts and the
local recurrence checklist remain ignored and outside the commit.
