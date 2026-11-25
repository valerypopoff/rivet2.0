# Scheduled Runs controller refactor plan

Status: complete. All five implementation steps and local validation gates were
verified on 2026-11-25.
Prepared on 2026-11-25 against `develop` at
`4d8569533a7b4e5b750e5601c5d57d95f16abff5`. The tracked working tree was clean
before planning. Record implementation and validation separately at the end;
planning probes are not browser acceptance.

Reassessed on 2026-11-25 against the same application commit. The revised
boundary below keeps creation defaults in the controller and separates modal
disposal from poll-effect cleanup. Browser characterization remains a prerequisite,
including the additional recording-command and captured-edit checks below.

## Goal and scope

Separate Scheduled Runs request and form ownership from rendering, without
changing behavior. A developer adding a schedule field or action should have
one place to review request settlement and one place to review form conversion.
The view should retain layout, accessibility, modal stacking and DOM focus.

The operating contract remains [Scheduled runs](scheduled-runs.md). This is a
dashboard refactor: no changes to scheduling, execution, recordings, backend
authorization, persistence, schemas, route contracts or deployment safeguards.
Do not change polling frequency, request deadlines, observation windows,
idempotency policy or automatic retry behavior. No endpoint speedup is claimed.

Keep the existing request ledger, project picker and sidebar summary poll as
independent owners. Add no generic resource hook, polling framework, reducer,
global store, command bus, dependency or additional production component merely
to reduce file size.

All paths below are relative to the repository root unless linked.

## Preparation evidence and limits

- `packages/studio-server-web/dashboard/ScheduledRunsModal.tsx` has 822 lines,
  13 state hooks, seven refs and five effects in this baseline. These counts
  describe the investigation; they are not reduction targets.
- The modal's polling and action owner is at lines 153-211. Editor initialization,
  draft changes, input conversion and kind changes are at lines 212-277. Save
  and Preview still contain request logic in JSX callbacks.
- `WorkflowLibraryPanel.tsx` conditionally mounts the modal and passes the stable
  React setter `setEnabledScheduleCount`. Closing the list unmounts the modal;
  it does not dispose `scheduledRunApi.ts`'s module-owned request ledger.
- Playwright collection through the repo observe runner found two cases in
  `playwright-observe/scheduled-runs.spec.ts`: pagination/live updates, and the
  authenticated real-API execution/restart/recovery journey. Collection passed
  during planning; those cases were not executed for this document.
- `scripts/ci/editor-test-shards.mjs` already selects that complete spec, with a
  90-second case-work hint. The hint is a balancing input, not a new measurement
  or an execution deadline. At reassessment it belongs to shard `3/5` among 46
  selected specs. The full-shard command collected 119 cases in nine files;
  these were not executed. Compute the owner again after any weight edit.
  No new CI job or spec registration is needed.
- A read-only, in-memory TypeScript probe selected the modal, requester, picker,
  picker model, their existing pure tests and `svgr.d.ts`. With the existing
  focused projects' Bundler/React options and the correct configuration path,
  it visited 369 source/declaration files with zero diagnostics. This supports
  a small maintained typecheck project; it does not typecheck the full dashboard.
- In the preceding analysis of the same commit, all four
  `tests/scheduled-run-api.test.ts` cases passed. They establish requester
  behavior, not React lifecycle or browser timing.
- The installed Playwright Clock contract distinguishes `runFor` (all due
  callbacks) from `fastForward` (each due timer at most once). Use the former
  for cadence and successive busy-tick assertions. A single due-poll jump in a
  lifetime case does not need to simulate every unrelated editor animation frame.

Preparation probes and prior focused logs are Git-ignored under
`artifacts/refactor-candidates-20261125/`. Do not commit them or use unrelated
production receipts as evidence for this refactor.

## Owners and target structure

| Owner                                                                                 | Responsibility after refactoring                                                                                                                                                             |
| ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/studio-server-web/dashboard/scheduledRunForm.ts` (new)                      | Pure request payload conversion and schedule-kind transitions. Reuse shared schedule types. No React, transport, timers or browser globals.                                                  |
| `packages/studio-server-web/dashboard/useScheduledRunsController.ts` (new)            | List state, loading/error state, polling, epoch and action admission, draft/edit/input/preview state, dirty baseline and named feature commands.                                             |
| `packages/studio-server-web/dashboard/ScheduledRunsModal.tsx`                         | Existing props and JSX; pagination; select-menu tracking; list-stack foreground state; opener/close/content DOM refs; focus restoration and alert scrolling; confirmations and event wiring. |
| `packages/studio-server-web/dashboard/scheduledRunApi.ts`                             | Unchanged transport, JSON/error parsing, 20-second timeout and page-owned uncertain-action ledger. Import the existing singleton in the controller.                                          |
| `packages/studio-server-web/dashboard/WorkflowLibraryPanel.tsx`                       | Unchanged modal mount, enabled-count setter and independent closed-modal summary polling.                                                                                                    |
| `ScheduledProjectSelect.tsx`, `scheduledProjectOptions.ts`, `SegmentedControl.tsx`    | Unchanged controls and project identity/presentation rules.                                                                                                                                  |
| `packages/studio-server-web/tests/scheduled-run-form.test.ts` (new)                   | Small table-driven tests for moved form behavior.                                                                                                                                            |
| `packages/studio-server-web/playwright-observe/scheduled-runs.spec.ts`                | Retain both existing cases; add controlled lifecycle characterization before moving production code.                                                                                         |
| `packages/studio-server-web/playwright-observe/helpers/scheduledRunsFixture.ts` (new) | Shared closed API fixture and explicit request gates for the new lifecycle cases, if needed by their multiple callers. No scheduler/database implementation.                                 |
| `packages/studio-server-web/tsconfig.scheduled-runs.json` (new)                       | Focused no-emit checking for the actual changed owners and their pure tests.                                                                                                                 |

Imports flow from view to controller to form helpers/shared contracts. The
controller also imports `scheduledRunApi.ts`. Neither helper nor controller
imports the view. Do not move shared DTOs into dashboard code or make API code
depend on the new form helper.

Use one controller per mounted modal. Return a bounded `{ state, actions }`
result, inferred where practical. State includes `data`, `loaded`, `busy`,
`error`, `pollError`, `draft`, `editing`, `input`, `times` and `dirty`. Keep
`mounted`, `epoch`, `working`, `initialForm`, request plumbing and raw setters
private. Do not expose a second set of synchronized view/controller state.

Provide named commands for opening/closing the editor, updating draft/input,
changing schedule kind, saving, previewing, toggling enabled state, deleting,
running now, cancelling, retrying and opening a recording. Requests and
post-request state changes must leave JSX. Retain the finite existing action
wrapper privately; a public `action(operation, refresh)` API would leave feature
behavior split between controller and view.

The view's editor-opening wrapper records the actual opener element and clears
the select-menu state, then calls the controller's editor command. The close
command retains the synchronous busy guard; return whether the local close was
accepted so the view clears its menu state only for an accepted close. That
boolean describes a local draft close, never a server acknowledgement.

Confirm Delete and Retry in the view with their existing text, then call their
named commands. The controller must not receive DOM events or elements.
Keep `date`, schedule description, select option labels and simple display
conditions in the view. Moving formatting provides no ownership benefit here.

## Behavior contract

### Polling and owner lifetime

1. Mount starts one immediate list request. Each poll captures the current
   epoch before dispatch. Only a non-aborted result from the same epoch may
   change data, loading/errors or the enabled-count callback.
2. Schedule the next poll with `setTimeout(..., 3000)` after the prior poll
   settles, including failures and ticks skipped while an action is working.
   This is not a fixed interval. A slow request must not create overlapping
   polls or catch-up requests.
3. Preserve the polling effect's dependency on `onEnabledCountChange`, currently
   a stable parent setter. Draft changes, typing, pagination, errors and derived
   return objects must not recreate the effect or trigger immediate requests.
4. Retain the two distinct effects: the empty-dependency mount effect sets
   `mounted.current = true`, then marks it false and advances the epoch only
   on its cleanup. The polling effect depends on `onEnabledCountChange`; its
   cleanup only aborts that poll controller and clears its timer. Do not merge
   them or mark the mounted instance disposed when just restarting its poll.
   Both cleanups run on actual unmount, preventing obsolete poll updates.
5. The closed-modal sidebar still owns its separate visible-page 30-second
   summary poll and visibility-return refresh. The open modal supplies the
   count from its existing list responses. Do not merge these pollers.
6. Action admission/settlement does not reset the ordinary poll timer. A tick
   skips while busy and schedules its next check three seconds later; one can
   therefore be due just after an action finishes. Distinguish that existing
   timer from an additional action-triggered refresh in request-count tests.

### Actions and settlement

1. Keep the synchronous `working.current` admission guard. Set it and advance
   the epoch before the first await, then set busy and clear the action error.
   A rendered disabled button is not a substitute for this guard.
2. Invalidate an already-dispatched poll on action admission, on both its
   success and failure paths. Do not let it overwrite post-action data or
   install a stale error. The existing poll need not be aborted on admission.
3. A successful mutation is followed by exactly one immediate list GET. Keep
   busy through that GET. Apply its data/count and clear `pollError` only while
   mounted. A failed mutation does not add a settlement GET; the ordinary poll
   remains its independent recovery path.
4. Only after the mutation promise resolves does the wrapper mark it
   acknowledged. If its subsequent GET fails, use the exact existing
   `reconnectWarning`, never the original mutation-failure message. A successful
   ordinary poll clears this warning, but does not clear unrelated action errors.
5. Save closes the editor only after its request is acknowledged, before the
   list refresh. Failed or uncertain Save retains all draft/input state.
   A failed post-Save refresh leaves the editor closed and reports the accepted
   action on the list. Do not reopen it and invite another Save.
6. Preview and Open recording use the same busy/error guard and epoch advance,
   but neither performs the immediate list GET nor claims an acknowledged
   mutation. The normal poll can resume afterward. Preview changes only
   `times`; it does not make the form dirty or close it.
7. Pass the recording ID to the existing `onOpenRecording` callback. Its
   resolved value is not interpreted by the current modal, including a resolved
   `{ opened: false }` result; only rejection enters its action error path.
   Do not introduce new recording-open validation while extracting this owner.
8. List Close remains the existing unconditional `onClose`. Do not introduce a
   global busy lock. Editor Close, Escape and overlay dismissal retain their
   current busy restrictions and synchronous close guard.
9. An action admitted before list unmount may continue, including its existing
   immediate settlement GET after an acknowledged mutation. Keep those requests
   and the page ledger alive; suppress only obsolete browser updates. Do not
   start cancelling all requests on cleanup, replay work, or share a global
   action lock between old and replacement modal instances.
10. Preserve `describeError`, timeout wording, error precedence and when
    `loaded`, `pollError` and action errors change. Preserve the current swallowed
    action-error behavior; event handlers should not gain unhandled rejections.

### Transport and wire payloads

The requester keeps `cache: 'no-store'`, JSON header/body omission, encoded IDs,
status handling and `parseJsonResponse` unchanged. It continues combining an
optional caller signal with the existing 20-second bound. Do not instantiate
`createScheduledRunRequester()` inside the hook.

| Command        | Existing request before settlement                                                                            |
| -------------- | ------------------------------------------------------------------------------------------------------------- |
| Add            | `POST ''`, `{ draft: payload() }`; requester adds its request ID.                                             |
| Edit           | `PUT '/<scheduleId>'`, `{ draft: payload(), revision: editing.revision }`.                                    |
| Pause/Unpause  | `PUT '/<scheduleId>'`, `{ revision: schedule.revision, draft: { ...schedule, enabled: !schedule.enabled } }`. |
| Delete         | `DELETE '/<scheduleId>'`, `{ revision: schedule.revision }`.                                                  |
| Run now        | `POST '/<scheduleId>/run'`, `{ revision: schedule.revision }`; requester adds its request ID.                 |
| Cancel         | `POST '/runs/<runId>/cancel'`, `{}`.                                                                          |
| Retry          | `POST '/runs/<runId>/retry'`, `{ confirmSideEffects: true }`; requester adds its request ID.                  |
| Preview        | `POST '/preview'`, the draft payload directly, without a `draft` wrapper.                                     |
| Open recording | Existing callback only; no schedule mutation or settlement GET.                                               |

The ledger's exact intent serialization matters: it keys on `JSON.stringify`
of path/body before adding `requestId`. Preserve payload field order and captured
values. Retain its 24-hour age limit, 100-unresolved-intent limit, validated
acknowledgement checks and definitive/uncertain error distinctions. Existing
requester tests own those rules; do not duplicate them in the new form suite.

### Form defaults and conversion

Keep the creation-default object in the controller next to opening an editor.
It has one caller and does not need another exported constructor or a test
that mirrors a literal. Preserve blank name/description, `latest`, enabled,
daily `10:00`, recordings on, 60-minute timeout and `missed: 'skip'`.

Move only these two pure calculations into `scheduledRunForm.ts`:

- Payload conversion with the current diagnostic text. Missing draft and missing
  project remain errors; blank/whitespace input omits `input`; `{}` remains an
  explicit empty object. Malformed JSON, `null`, arrays and primitives remain
  invalid. Remove the draft's old `input` before applying the text value.
- Kind defaults/transitions using the previous schedule, selected kind and an
  explicitly supplied current time. Preserve daily/weekly/monthly time when
  switching among them; otherwise use `10:00`. Weekly starts on Monday, monthly
  on day one, Once has blank local time and Interval starts at 60 minutes with
  an anchor one hour after the selection event. Never generate that anchor on
  render or poll.

Keep browser reads (`Intl.DateTimeFormat` and `Date.now`) in the controller's
commands. Do not resolve the timezone when merely editing an existing schedule.
Default project selection is the first supplied project with a metadata ID;
missing IDs produce the existing blank selection, never a path fallback.

Editing continues to `structuredClone` the saved schedule and pretty-print its
input with two spaces. Do not sanitize the clone down to nominal draft fields:
its existing ID/revision/other returned fields currently travel through the
payload and can affect ledger identity. Preserve them during this refactor.
`editing` remains the snapshot captured on opening, including its revision;
never derive it from the latest polled list. A newer list must not silently
rebase the pending edit or turn a stale Save into approval of another revision.
Named commands capture the supplied row/draft/callback at the same point as the
existing event handler; do not look up a newer row after awaiting another step.

Dirty detection remains the opening `JSON.stringify({ draft, input })` compared
with the same current expression. Input text whitespace is meaningful for that
comparison. Do not normalize JSON, replace this with semantic equality or derive
the opening baseline from later polls. Every draft/input change still clears
Preview results. Polling can update the list without replacing an open draft.

### Presentation and interaction

Keep the two-dialog DOM structure, form ownership of Save/Preview, native
required-field validation, names, IDs, classes, copy and existing CSS unchanged.
Keep `onSubmit`'s dirty guard and its `preventDefault` behavior.

Retain the view's pagination state and clamp effect: ten per page on opening,
same-size selection preserves the page, changed size starts at one, shrinking
history clamps without later resurrecting the old page, and polling preserves
the native history disclosure's expansion. Closing/reopening resets that view.

Keep select-menu tracking in the view, including rejection of a retired select's
close event. Escape closes an open select without dismissing the editor. Keep
the existing stack-foreground state and `requestAnimationFrame` focus restore
after editor exit, with a disconnected opener falling back to list Close.
Keep alert scrolling in its existing effect without moving focus or the footer.

## Characterization before extraction

First retain and execute both existing browser cases unchanged. They already
cover project identity, drafts/dirty controls, schedule controls, focus and
layout, preview busy behavior, lost Create/Run/Retry acknowledgements, restart
persistence, actual root/child recordings, stale edits, cancellation and accepted
mutation followed by list failure. Do not replace that real-API evidence with
a mocked controller suite or repeat those full journeys for each new race.

Then strengthen the existing stale-edit step in the real-API journey: after the
external update, wait until the browser list has actually adopted its changed
name/revision before submitting the open draft. Assert the editor retains its
fields and the request still uses its opening revision; the server must reject
it and preserve the external change. The current immediate Save can race ahead
of the poll and does not establish this particular boundary. Add this observation
to the existing case, without another server or a duplicate stale-edit scenario.

Add the following controlled cases to the existing spec before moving runtime
code. Parameterize only the genuinely distinct stale-poll success/failure paths.
Combine assertions that share one owner transition; do not create a scenario for
every field or duplicate the existing requester ledger tests.

| Case                                           | Required evidence                                                                                                                                                                                                                                                                                                                           |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Poll timing and busy admission                 | Hold a list response beyond virtual poll time and verify no overlapping GET. After consuming it, verify no poll at 2,999 ms and one at 3,000 ms. Draft edits/rerenders add none. Hold Preview across known due ticks: no new poll while busy. Complete it between ticks: no action-triggered list refresh, then the original timer resumes. |
| Old poll succeeds after acknowledged mutation  | Hold a background poll, complete a mutation and its immediate list refresh, then release the old response with visibly different schedules/count. Data and sidebar count remain at the acknowledged state; one user action produced one mutation.                                                                                           |
| Old poll fails after acknowledged mutation     | Same controlled ordering, returning a failure for the old poll. It cannot install an alert or retire the fresh data.                                                                                                                                                                                                                        |
| Dispose a pending poll and reopen              | Verify request cancellation/owner retirement, no further old timer, and exactly the new mount's initial poll. Releasing the owned route must not change replacement data or its badge. Do not claim a response reached application code after fetch had already been aborted.                                                               |
| An admitted mutation settles after list close  | Close the list while a mutation acknowledgement is held; reopen with distinct data, then release the old action and its settlement read. The mutation was sent once, its existing continuation still occurs and old completion cannot update the new modal/count.                                                                           |
| Lost Create acknowledgement across modal close | Hold an old poll, fail Save with an uncertain acknowledgement, then release stale successful list data. Draft/input/error and the last accepted list/count remain intact, with no mutation-settlement GET. Close/reopen and recreate the identical draft: reopening sends no mutation; explicit Save reuses the prior request ID.           |
| Open recording uses read-only settlement       | Through the existing editor, hold the exact fixture recording GET after clicking the history link. Verify busy/duplicate-click protection and no new poll at a due tick. Release a controlled load failure; the existing callback resolves with `opened: false`. Busy clears with no new action error or immediate list refresh.            |

The isolated cases need only one valid project/schedule/history fixture and
explicit responses. Route methods and exact pathnames separately so list,
summary, Preview and mutation requests cannot be confused in counts. Use
non-secret fixture inputs. Unexpected API mutations must fail the fixture;
bootstrap reads are explicitly owned, with no ambient API fallback.
For the initial Add selection, include an unreadable/missing-metadata-ID project
before a valid project and assert the selected/persisted metadata identity;
reuse a lifecycle case instead of a new default-object unit test.

For the isolated cases install `page.clock` before navigation, let bootstrap
finish with time flowing, then pause before mounting the schedule modal. Do not
install fake timers after that modal has already started a native poll timer.
Use `runFor` for exact cadence and successive busy ticks. `fastForward` or
`pauseAt` can skip intermediate firings and cannot establish those assertions;
the other lifecycle cases use `fastForward` only when one due poll is sufficient.
Allow modal/focus animation frames to settle, then establish the timer boundary.

Route gates must signal request receipt and completion; advance time after the
response has been consumed, not merely after a route was released. Observe
the response-specific UI sentinel where applicable and allow its asynchronous
continuation to finish before negative request/error assertions. Release old
responses after settling the mutation GET but before the next ordinary poll,
so a later good poll cannot conceal a stale overwrite. Do not assume clock
advancement controls native fetch deadlines or the real API scheduler. Keep
the real-API journey on real time. No production timing constants change.

The recording case uses the already-mounted editor and the fixture ID's exact
`GET /api/workflows/recordings/<id>/recording` and `/summary` routes. Hold the
recording response; return an explicitly owned unavailable summary; then return
a controlled JSON 503 for the recording. Wait for the editor's matching
`project-open-failed` acknowledgement and cleared busy state, rather than a
bridge timeout. This checks the command without creating recording bytes or
replaying a graph. Assert the matching source/origin/path/request-ID bridge failure
and absence of the schedule modal's action alert. Do not infer acknowledgement
from toast rendering while animation timers are frozen. Retain the editor's
diagnostic without suppressing unrelated errors. Existing recording suites
continue owning successful playback.

Every held route has a `finally` release and bounded received/completed waits.
Keep the existing real-fixture restart cleanup: navigate to `about:blank`, await
pending route settlement, then stop the owned API; reinstall its routes after
restart. No arbitrary sleeps, swallowed route errors or test-runner retries.

All characterization must pass against the unextracted modal. If a new check
exposes an actual baseline bug, record the reproduction and separate its
minimal repair from extraction. Do not weaken the assertion, silently change
behavior or call a failed baseline a refactor regression. Remeasure after an
explicitly justified repair before continuing.

## Implementation sequence and gates

### 1. Freeze the baseline and establish checks

- Recheck HEAD and the whole working tree; preserve unrelated changes.
- Read the owning guide and relevant entries in the optional ignored
  `developer-docs/studio-server/ci-pre-push.local.md`. Do not force-add that file.
- Save exact source hashes, test commands, selected case counts, request counts
  and before timings under a new ignored artifact directory.
- Complete the characterization above first, using the same production build
  path that will be used after extraction. Passing collection alone is not this
  gate. Keep the existing two cases, assertions and backend fixture semantics.
- Run Core/runtime rebuilds and root checks that rebuild them before starting
  owned API/browser fixtures. Never replace shared `dist` output during an API
  restart test. If root `test:style` is run, finish it before the corresponding
  final lint/typecheck and browser results. Stop only fixtures started for this work.

Gate: all original and added browser cases pass before production movement;
ledger/picker tests pass; expected payloads and request ordering are recorded.

### 2. Add the focused typecheck and pure form helpers

Create `tsconfig.scheduled-runs.json` from the existing focused hosted-web project
options: no emit, non-composite, Bundler/ESNext, React JSX, Vite/Node types. Start
with `svgr.d.ts`, the existing modal/requester/picker/options, the new form helper,
shared segmented control where directly relevant and their focused pure tests.
Add the controller root when creating it in step 3; do not select a missing file
or create an unused placeholder to pass this step. Include an added small
fixture helper if its import graph stays narrow; do not import the real API
browser journey into this project just to increase coverage claims.

Add `check:scheduled-runs` to the web package and invoke it from the maintained
web `test` script. Add a narrow corresponding root ESLint project override.
Check the actual roots; do not claim whole-dashboard type safety.

Extract the two pure calculations. Add `scheduled-run-form.test.ts` to the
normal web test list exactly once in its required sorted order. Use small
table-driven cases for:

- Blank input versus `{}`, object input, stale draft input removal, nested input,
  malformed JSON and non-object rejection, with the existing messages/order.
- Preservation and non-mutation of an edited object's returned fields and input.
- Every kind default, calendar-time preservation and fixed injected-time anchor.

Do not duplicate the requester's tests or re-test the full server's calendar
algorithm here. The pure tests own browser form conversion only.

Gate: focused compiler, typed ESLint, pure helpers and unchanged requester tests
pass; browser characterization still passes with the modal using the helpers.
Run `yarn check:file-tree` after adding or changing imports. Leave creation
initialization beside the captured edit/dirty baseline in the controller.

### 3. Move request and form ownership mechanically

Move the state/refs/effects and private action wrapper into
`useScheduledRunsController.ts`, retaining hook initial values and effect
dependencies. Do not introduce memoization or reduce state/ref counts as part
of the move. Move Save/Preview and other request callbacks into named commands
without changing their await, snapshot, error or mounted-check ordering.

Keep pagination, select tracking, list foreground, DOM refs and the two DOM
effects in the view. Wire their existing opening/close behavior to the named
commands. Preserve the public component props and its caller unchanged.

Review the before/after code structurally: request URL/method/body expressions,
action admission, epoch checks on success/failure, `finally` settlement, dirty
comparison, JSX conditions, modal props and focus effects. A private AST/diff
probe can support this review; do not commit source-shape tests as a new product
contract. No transport/ledger changes are expected.

Gate: all focused checks and all Scheduled Runs browser cases pass with no
request-count, payload, diagnostic, focus or timing regression.

### 4. Review the boundary and remove move-only clutter

Ensure no requests, post-request setters or mutable request refs remain in JSX;
no DOM refs, events or view imports enter the controller; no clock/browser reads
enter the form helper; and no new effect synchronizes duplicated state.

Remove dead imports/temporary wrappers and prefer the existing finite action
wrapper to a new action type system. Keep confirmations in the view, readable
feature commands in the hook and one authoritative form baseline. Do not merge
the hook with sidebar polling or broaden the task to refactor the picker/CSS.

Gate: another focused review finds a simpler owner boundary, not just relocated
lines or a long public list of setters. Behavior remains identical.

### 5. Complete integration and update documentation

Run final integration in this order: applicable root style/asset checks with no
live fixtures; then focused compiler/lint, file-tree and test-manifest checks;
then the complete web pure suite and exact web production build; then observe
and CI-config browser verification. Root asset checks can rebuild Core exports,
so an earlier compiler/build receipt is not the final receipt after that rebuild.
Update this plan's implementation record, the owning Scheduled Runs guide and
Studio Server refactor history with final owners, exact validation results and
limits. Keep this plan linked from `developer-docs/README.md`.

Keep `scheduled-runs.spec.ts` fully selected in ordinary editor CI. Measure its
new total case work and refresh the 90-second hint only if warranted, using the
existing five-second rounding convention. If shard membership changes, verify
every affected shard. Keep the five-shard policy, balance checks, workers,
timeouts, job limits and required gates intact. Do not omit cases to fit a hint.

No commit, push, release or deployment is part of creating this plan.

## Validation commands and evidence

Run from the repository root with its supported Node/Yarn toolchain. On this
Windows checkout, use `.data/tools/node/v24.22.3/win-x64/node.exe` to invoke
`.yarn/releases/yarn-4.17.1.cjs`, with that Node directory on PATH; do not rely
on a potentially stale global Yarn shim. Check `$LASTEXITCODE` after native
commands and stop on failure.

During implementation, the focused commands will be:

```powershell
yarn workspace @valerypopoff/rivet-studio-server-web check:scheduled-runs
yarn workspace @valerypopoff/rivet-studio-server-web exec tsx --test tests/scheduled-run-form.test.ts tests/scheduled-run-api.test.ts tests/scheduled-project-options.test.ts
yarn exec eslint packages/studio-server-web/dashboard/ScheduledRunsModal.tsx packages/studio-server-web/dashboard/useScheduledRunsController.ts packages/studio-server-web/dashboard/scheduledRunForm.ts packages/studio-server-web/dashboard/scheduledRunApi.ts packages/studio-server-web/tests/scheduled-run-form.test.ts
yarn studio-server:verify:test-style
yarn studio-server:verify:repo-structure
```

Include any changed typed fixture/helper files in ESLint. Before finishing run
the complete `yarn studio-server:verify:web-pure` and
`yarn workspace @valerypopoff/rivet-studio-server-web build`. Run applicable
root `yarn test:style` checks before the final lint/typecheck/build and browser
fixtures, and run `yarn check:file-tree` after import edits. Reread the ignored local
checklist before any later requested commit/push and apply entries for the final
diff. Reuse passing unchanged checks instead of repeating unrelated suites.

Serve the exact web build on an owned loopback preview port, then use the required
repo runner (substitute the actual owned port):

```powershell
$env:PLAYWRIGHT_HEADLESS = '1'
$env:PLAYWRIGHT_SLOW_MO = '0'
$env:PLAYWRIGHT_BASE_URL = 'http://127.0.0.1:5183'
yarn studio-server:ui:observe scheduled-runs.spec.ts
```

Inspect failures under `artifacts/playwright/`, including the failing step,
request trace and fixture cleanup. The test owns an isolated API for its real
journey; the preview must not give mock cases an ambient production API.

Execute the entire affected editor shard using `playwright.ci.config.ts`, with
its usual two workers and the same exact build. The baseline owner was `3/5`;
the measured 100-second hint assigns it to `5/5` in this implementation. Recompute
the owner from `scripts/ci/editor-test-shards.mjs` after any weight change.
The required full-shard command has **no spec filename filter**:

```powershell
$env:CI = '1'
$env:RIVET_EDITOR_TEST_SHARD = '5/5' # Substitute the recomputed owner if different.
yarn workspace @valerypopoff/rivet-studio-server-web exec playwright test -c playwright.ci.config.ts
```

The CI configuration owns its preview port and requires that port to be free;
do not reuse the observe preview. Run any other shard whose membership changed
after a weight edit. A filename-filtered diagnostic run is additional evidence,
not the full-shard gate. Clear `RIVET_EDITOR_TEST_SHARD` before collecting the
complete selection, or it silently restricts collection; restore task-local
environment settings when finished. Use the installed matching Chromium/normal
Windows process permissions. Do not treat process-cleanup or stale-build
failures as passing product evidence.

This UI-only scope does not require Kubernetes rehearsals, deployments, real
PostgreSQL qualification or unrelated server-wide integration reruns. Existing
browser shard fixtures still keep their own required dependencies. If the
diff reaches backend, execution or storage code, stop and reassess scope and
required gates before proceeding.

## Performance and completion criteria

For matched before/after fixtures, retain the exact mutation counts, immediate
settlement GET counts, initial poll count, single-flight behavior and
completion-relative cadence. Keep request deadlines unchanged. New fields or
rerenders must not start extra polls. Pure helper extraction must not serialize
whole schedule/history lists or add work to every poll beyond existing behavior.

Record local browser wall time and total case work separately from build/setup
time. Increased test work for new race coverage is not slower product behavior.
If hosted workflow performance is compared, include runner queueing, setup and
artifact transfer; local timings cannot establish hosted speedup. Workflow
execution endpoints are unchanged by this scope, so no endpoint acceleration
or production latency result is implied.

Implementation is complete only when:

- One mounted controller owns request/form lifetime; the view owns presentation,
  pagination and DOM interactions, with no duplicate synchronized state.
- The existing singleton ledger, mount boundary, controls, payloads, error and
  callback semantics, request ordering and timing are preserved.
- Original and new characterization, pure tests, typecheck, typed lint, production
  build, observe and affected-shard checks pass. There are no hidden skips,
  retries, weakened assertions or shortened safety windows.
- The original real-API restart, lost-acknowledgement, recording and cancellation
  evidence remains. Mock cases supplement rather than replace it.
- The final diff contains no backend/schema/security policy or dependency drift;
  all changed code is documented and all owned fixtures are settled and stopped.
- The result record identifies source/build identity, exact test counts,
  request-count/cadence evidence, fresh versus earlier results, and any unresolved
  limits. A local pass is not a hosted CI or production qualification claim.

## Reassessment findings

The second source review narrowed the helper module to two calculations and
removed the proposed constructor and literal-mirroring defaults test. It also corrected the
effect cleanup distinction, captured-edit revision contract, virtual-clock
setup and full-shard command. Characterization now checks stale data after a
failed Save and the actual recording-command settlement rather than inferring
them from successful mutations or Preview. The existing real-API case gains a
deterministic polled-revision observation instead of another stale-edit test.

The 369-file compiler probe still has zero diagnostics and the current two
browser cases still collect. These checks do not execute the added scenarios;
they must pass against unchanged runtime code before extraction begins.

## Implementation record

Implemented against the original application commit above. The view now owns
presentation, pagination and DOM interactions; the controller owns requests and
form state; the helper module contains the two pure calculations. The combined
owners retain 13 state hooks, seven refs and five effects. Neither the requester
nor `WorkflowLibraryPanel.tsx` changed. Backend, CSS and dependencies are unchanged.

### Characterization and local verification

- Original two browser cases passed before production edits: 81.2 seconds wall
  time, 74.7 seconds case work. The strengthened stale-edit assertion also passed
  on the original modal in the subsequent characterization run.
- All seven controlled lifecycle cases passed on the original production build
  before extraction, then passed again after extracting only the form helpers.
  The fixtures use exact owned paths and distinguish ordinary polls, immediate
  mutation reads and sidebar summary reads. The uncertain response case verifies
  the same full request body/request ID after closing and recreating the draft.
- Four new pure form cases plus the five existing requester/picker cases passed.
  The complete web suite passed 324 cases: 285 TypeScript and 39 development/
  production tests. The focused compiler, typed lint, file-tree, test-style,
  repository-structure and root `test:style` checks passed.
- A private structural audit verified unchanged polling and mount effects,
  dependencies, cleanup, action settlement, dirty comparison, payload body,
  confirmations and rendered structure except the moved handler calls. Thirty
  injected-time schedule transitions matched the original implementation.
  Requester and parent source hashes still match the baseline.
- The final production web build passed (`DashboardPage-DeChq7nU.js`). All nine Scheduled Runs observe cases
  passed in 94.1 seconds wall time / 87.0 seconds case work; the CI-config run
  passed the same nine in 108.7 seconds wall time / 97.5 seconds case work.
  Neither run had skips or retries. The added recording request-count assertion
  is also included in the full CI sweep below.
- The work hint is 100 seconds, rounding the higher measured case work upward
  to five seconds. The complete selection contains 543 cases in 46 files; no
  existing case was removed. The weight update affects all five partitions, so
  the final gate executes the entire selection in one CI-config invocation with
  the normal two workers. This covers every affected partition without claiming
  five independent hosted job runs. Shard balance and work-headroom checks pass.

The full 543-case CI-config sweep finished in 23 minutes 39.3 seconds: 542
passed, one failed, with no skips, retries or global cleanup errors. All nine
Scheduled Runs cases passed. The sole failure was an existing Project Settings
geometry assertion, which sampled the first and second tab in separate protocol
calls while the modal was entering. The trace records those calls across about
45 milliseconds; comparing positions from different frames reported a negative
gap despite the unchanged four-pixel CSS gap. Both rectangles are now sampled
in one browser evaluation, retaining the original separation and alignment
assertions without adding a delay or loosening tolerances. No product code
changed for this correction.

The corrected case passed ten consecutive CI-config repetitions in 26.9 seconds.
The complete affected shard `3/5` then passed all 123 cases in four minutes
29.6 seconds with the normal two workers and no filename filter. Neither run had
skips, retries or global cleanup errors. Across the full sweep and the fresh
complete shard, every one of the 543 selected cases has passing evidence. This
does not describe a second entirely green 543-case invocation: the original
failed report, screenshot and trace remain alongside the follow-up results.
Scheduled Runs' case work in the full sweep was 95.1 seconds, still below the
97.5-second focused measurement used for the 100-second work hint.

All owned fixtures settled, and preview ports 5183, 5184 and 5185 reject new
connections after shutdown. The ignored `verification.json` ties the reports to
the original source snapshot, unchanged requester/parent hashes, final changed
source hashes and the tested dashboard build asset. The initial full-run failure
is explicitly retained in that receipt; the fresh shard covers the exact same
123 case identities as its part of the full selection.

### Preparation corrections and limits

The first root style invocation failed in a sandboxed temporary local Git fetch;
the normal-permission run and final normal-permission run passed. The original
failure log remains. A browser invocation started before the form build had
completed is discarded as validation; the completed-build rerun passed.

The initial lifecycle fixture tried to pause at a just-read timestamp that could
already be in the past when its next protocol call arrived. Pausing at a future
point before the modal mounts, holding its first response until transitions
settle and then measuring its timer fixed the fixture. Exact cadence/successive
ticks retain `runFor`; other cases jump only one relevant poll with `fastForward`.
The recording check now observes the actual matching bridge failure, not toast
presentation under frozen animation timers. Failed preparation evidence remains
separate from passing results under `artifacts/scheduled-runs-refactor-20261125/`.

The local timings compare different case sets and execution conditions; they
do not establish a product or hosted workflow speedup. No hosted queue-inclusive
timing, deployment, Kubernetes rehearsal or production acceptance was performed
for this UI refactor. No safety observation window or transport timeout changed.

### Post-implementation reassessment

The request/form ownership, callback wiring, captured editing revision, disposal,
payload compatibility and focused checks were reviewed again against the original
modal. No functional regression was found. Save and Preview now call
`scheduledRunPayload(draft, input)` directly, removing the extracted controller's
redundant payload closure without changing when validation or transport runs.

The recording lifecycle case previously clicked again only after busy was
rendered. It now also dispatches two clicks in one browser task and asserts both
saw `busy=false`, then verifies exactly one owned recording request. The later
busy click, failure receipt, polling cadence and read-only settlement checks
remain in the same case; no fixture, case or timing delay was added.

Fresh verification passed all 324 web tests, focused typechecks, typed lint,
formatting, both test-style guards and the structural equivalence audit. The new
production build is `DashboardPage-EyC3u17Y.js`. All nine observe cases passed in
95.7 seconds wall time / 88.9 seconds case work, and the same nine passed in the
CI configuration in 96.0 seconds / 84.9 seconds. Both runs had no skips, retries
or cleanup errors. The CI configuration retains its two-worker limit; this
focused command selects the one serial spec. The 100-second work hint is unchanged.

Earlier full-selection and root-style results above remain earlier evidence;
the fresh checks cover this review's two changed code files. The ignored
`reassessment/verification.json` records their hashes, the current build asset
and the unchanged case identities. All owned fixtures settled, and ports 5183
and 5184 reject new connections after shutdown.

### Plan completion audit

The final audit found no missing implementation. The post-review run above had
selected only the Scheduled Runs spec, so the plan's complete affected-shard
gate was refreshed against the current reviewed source and production build.

| Plan step                       | Completed work and evidence                                                                                                                                                                                       |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Baseline and behavior checks    | Original real-API cases and all seven added lifecycle cases passed on the unextracted modal; original source hashes and failed preparation evidence remain available.                                             |
| Pure helpers and focused checks | Both calculations, four pure cases, the maintained typecheck, typed ESLint override and ordinary test registration are present; the complete web suite passes 324 cases.                                          |
| Controller extraction           | One controller owns request/form state and named commands. The view retains presentation, pagination, confirmations and DOM effects. The singleton requester, parent mount and sidebar poll remain unchanged.     |
| Boundary review and cleanup     | Structural comparison preserves effects, cleanup, action settlement, payload conversion and render shape. The redundant payload closure was removed; duplicate-click coverage now exercises pre-render admission. |
| Integration and documentation   | The current production build passed observe and focused CI checks, then the full affected shard. The owning guide, history, README link and implementation record are updated.                                    |

The complete current shard `5/5` passed **79 cases in nine specs** in five minutes
24.6 seconds wall time / nine minutes 12.9 seconds total case work. Both configured
workers were used. All cases passed on their first attempt, with no skips, flaky
results or global cleanup errors. The run had no spec filename or grep filter;
all 79 case identities match the recomputed shard's part of the full selection.
Its nine Scheduled Runs cases used 92.1 seconds of case work, retaining the
100-second balancing hint.

The ignored `reassessment/completion-verification.json` verifies the current
build hash and all 13 recorded source hashes against the prior successful
review, then ties them to this complete-shard result. All owned fixtures settled;
ports 5183 and 5184 reject new connections. No implementation or required local
validation remains pending. Commit, push, hosted timing and deployment remain
outside this refactor's scope.

### Adjacent review: rejected retries must retain uncertain identities

A subsequent failure-path review reproduced a bug in the existing requester,
which the mechanical extraction had left unchanged:

1. The real API committed a Create, but its reply was dropped.
2. A retry with the same ID was rejected by the real authentication middleware,
   before the original receipt could be looked up.
3. The client discarded that ID. The next authenticated Save used a new ID and
   created a second schedule. The failing browser trace contains both schedules.

Three of the five requester cases failed before the repair, covering sequential
rejection and an older rejection arriving after an overlapping uncertain retry.
The real-API journey also failed with a changed third request ID; the recorded
list responses contained two schedules. Failed evidence and the original
requester source remain under `artifacts/scheduled-runs-refactor-20261125/adjacent-review/`.

Each pending entry now has one shared reuse flag. A rejection may retire a key
only while its ID has served a single attempt. After reuse, a rejection cannot
settle other attempts' history; validated success retires the matching key.
Mutating the shared flag lets an older in-flight attempt observe a later reuse.
Fresh single-attempt rejection, validated-success fencing, age/capacity limits,
request deadlines and explicit-only retry behavior are preserved. Authentication
still runs before receipt lookup on every request. This is a separate adjacent
bug fix; the earlier extraction and completion receipts describe their original
source snapshots.

The existing real-API journey now checks the lost committed reply, a genuine
403 caused by invalid fixture proxy authentication, restored authentication,
three identical request IDs and exactly one saved schedule. It adds no separate
API fixture or browser case. The requester suite has five focused cases; its
changed tests now use the existing typed ESLint project as well as typechecking.

Fresh verification passed all **325 web tests** (286 TypeScript and 39 development/
production tests), all five requester cases, focused typechecking, typed lint,
formatting and both test-style guards. The tested production build is
`DashboardPage-CM3jwZNh.js`. All nine observe cases passed in 99.3 seconds wall
time / 92.6 seconds case work. The complete current shard `5/5` passed all
**79 cases in nine specs** in five minutes 16.6 seconds wall time / nine minutes
1.2 seconds case work, using both workers with no filename or grep filter. Neither
browser run had skips, retries, flaky results or cleanup errors. Scheduled Runs
used 87.2 seconds of case work in the shard, keeping the existing 100-second hint.

The ignored `adjacent-review/verification.json` ties the failed reproduction,
passing results, 14 source hashes and the tested build hash together. All owned
fixtures settled, and ports 5183 and 5184 reject new connections after shutdown.

### Test review: distinct contracts and controlled polling

The relevant form, picker, requester, browser and fixture checks were reviewed
for stale expectations, duplicated setup and masked boundaries. The four form
cases and picker case already own distinct fast contracts. The seven lifecycle
cases and authenticated execution journey remain separate because they exercise
different owner transitions or real persistence/execution behavior.

The requester suite still has five cases. A shared request recorder removes
repeated fetch/ID setup, and one acknowledgement table covers Create, Run now and
Retry. Fresh HTTP classification now tests 400/403 versus 408/409/503 before reuse
can mask the exception branch. Response-body entry replaces the scheduler-turn
wait in the retired-success case; both deferred cases have bounded test deadlines.
The age check retries just before 24 hours, then verifies exact expiry still uses
the original time. Overlapping rejection and newer-identity fencing retain their
own cases. Sequential lost-reply/auth-rejection remains in the real-API journey.

Pagination now reuses the closed API/clock fixture, removing its separate
bootstrap routes and four real-time poll waits. All page-size, keyboard, narrow
viewport, clamping, expansion and reopen checks remain. Four controlled ticks
and the replacement mount produce exactly six consumed list reads and no writes.
The real-API journey remains on real time. Its Create/restart checkpoints use
one response snapshot each, removing four redundant GETs and a repeated editor-
closed assertion. Footer button coordinates are sampled in one browser evaluation.

Private fault probes confirmed the old tests missed removal of the fresh
408/409 exception, acceptance of revision zero and extension of expiry on retry.
The revised tests reject all three. Both old and new suites reject removal of
the reused-identity rejection guard, preserving the duplicate-work regression.
These deliberately defective copies and their results are ignored artifacts;
the routine suite contains no source-reading or fault-injection framework.

Fresh verification passed all **325 web tests**, focused typechecking, typed
lint, formatting and both test-style guards. All **nine browser cases** passed
in 82.3 seconds wall time / 75.8 seconds case work. The complete affected shard
passed **79 cases in nine specs**, using both workers, in five minutes 16.3
seconds / nine minutes of case work. Both browser runs had no skips, retries,
flaky results or cleanup errors; the full shard used no filename or grep filter.

In the observe comparisons on the unchanged build, pagination used 14.9 seconds
of case work before this review and 4.0 seconds afterward. This is a local test
comparison. Whole-shard wall time was effectively unchanged (previously five
minutes 16.6 seconds); no hosted or queue-inclusive speedup is established. The
100-second work hint, shard selection, workers and production timing are unchanged.

The ignored `test-review/verification.json` checks unchanged application/build
hashes, the two changed test files, stable browser case identities, guard-probe
results and successful reports. All owned fixtures settled, and ports 5183 and
5184 reject new connections after shutdown.

### Final assessment and commit preparation

The final comparison against `4d8569533` confirms the extracted polling effects,
cleanup, action settlement, payload conversion and rendered structure are
preserved. The original 822-line view becomes a 643-line view, 181-line controller
and 34-line form helper. Their combined 13 state hooks, seven refs and five
effects are unchanged; clearer ownership, rather than less total code or state,
is the maintainability improvement. The separately reproduced requester repair
prevents duplicate work after a lost acknowledgement and rejected retry.

Commit preparation compares all 14 recorded source files and the built asset
against the passing 325 web tests, nine browser cases and complete 79-case
receiving shard. Final formatting normalizes CRLF to LF in the requester and its
unit test; both are byte-for-byte identical to the tested copies after line-ending
normalization. The other 12 source hashes and built asset are unchanged.
Documentation cleanup does not change application behavior. These are local
regression results, not production qualification or hosted queue-inclusive timing.
