# Evaluation API HTTP separation

Status: fully implemented and locally verified on 2026-11-15 against `develop`
commit `7ccce0dd7`. The completion audit found no outstanding implementation or
local-validation work. Verification evidence is recorded below. Commit, push
and deployment remain separate release steps; this record does not claim a
deployment or production performance qualification.

## Goal and scope

Separate Evaluation Library HTTP handling and hosted Evaluation controls from
run history/evidence. Preserve existing behavior and add no work to workflow
execution. The original `routes/workflows/evaluation-runs.ts` had 833 lines and
23 route registrations; its storage and scheduler owners already exist.

The behavior-preserving extraction limits production edits to three files under
`packages/studio-server-api/src/routes/workflows/`:

| File                               | Responsibility                                                                                             |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `evaluation-runs.ts`               | Existing router, both parsers, compatibility exports and thirteen run/evidence handlers                    |
| `evaluation-library-http.ts` (new) | Five library handlers, their private schemas, normalization and HTTP conflict translation                  |
| `hosted-evaluation-http.ts` (new)  | Five hosted-control handlers, submission/scope schemas and HTTP availability/capacity/conflict translation |

Tests and developer documentation change with them. No new dependency, schema,
configuration, worker, public package API or deployment change. Do not refactor
storage, scheduling, graph execution, request middleware or notification delivery.
The benefit is clearer ownership, not a promised net line reduction.

## Registration and schema ownership

All paths below are relative to `/api/workflows/evaluation-runs`. Preserve this
order on the **same** `evaluationRunsRouter` instance:

| Group                 | Method and path in existing order                                                                                                                                                                                                                                                                             |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hosted control        | `GET /hosted/capability`; `POST /hosted`; `GET /:runId/hosted-state`; `POST /:runId/cancel-hosted`; `POST /:runId/retry-interrupted`                                                                                                                                                                          |
| Library               | `GET /library/events`; `GET /library`; `PUT /library`; `POST /library/mutations`; `POST /library/import`                                                                                                                                                                                                      |
| Retained run/evidence | `PUT /events/:runId`; `GET /history`; `GET /`; `PUT /datasets/:fingerprint`; `GET /datasets/:fingerprint`; `GET /:runId`; `PUT /:runId`; `PATCH /:runId`; `DELETE /:runId`; `PUT /recordings/:recordingId`; `GET /recordings/:recordingId`; `PATCH /recordings/:recordingId`; `POST /:runId/promote-baseline` |

Replace the first two handler blocks with direct startup calls:

```ts
registerHostedEvaluationHttpRoutes(evaluationRunsRouter, jsonBody);
registerEvaluationLibraryHttpRoutes(evaluationRunsRouter, jsonBody);
```

Both functions accept `(router: Router, jsonBody: RequestHandler): void`.
They register complete relative paths; no nested router, wrapper, asynchronous
registration, generic route table or dependency container is needed.

Move definitions with their sole consumer:

- Hosted module: `hostedSubmissionSchema`, `hostedRunScopeSchema`,
  `hostedRetrySchema`, `getConfiguredHostedCoordinator`,
  `requireHostedSubmissionCoordinator`, `sendHostedEvaluationCapacityError`.
- Library module: `evaluationLibrarySchema`, `replaceLibrarySchema`,
  `libraryMutationChangeSchema`, `libraryMutationSchema`, `importLibrarySchema`,
  `normalizeLibraryMutation`.
- Parent: all other schemas, including `runEventSchema`, the run/trial contract
  and its exhaustive quality-enum checks. Keep its `projectSchema`; the hosted
  module may declare the identical two-field project/run scope locally to avoid
  an import back into the parent. Preserve field order, bounds and strictness.

Re-export `hostedSubmissionSchema` from its original parent path. Preserve the
parent's five named exports: that schema, `evaluationRunSchema`,
`evaluationRecordingSchema`, `MAX_EVALUATION_RECORDING_BYTES` and
`evaluationRunsRouter`. Registration functions are internal module exports, not
new parent exports. Existing consumers need no import changes.

Reuse the same store/coordinator error classes, storage getters and
`evaluation-library-events.ts` module. Children never import the parent or
construct an operation owner. Preserve runtime versus type-only imports.
Import checks must compare existing initialization, not demand an empty module
graph: loading existing helpers is allowed; new stores, timers and implicit
route registration are not.

## Preservation contract

| Boundary               | What must remain unchanged                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mounts and access      | `app.ts` and `workflows/index.ts` remain untouched. Control/combined expose the API; execution/evaluation do not. Outer operator authorization precedes parsing. Preserve inherited GET cache headers, CORS/OPTIONS and trailing-slash behavior.                                                                                                                              |
| Request lifetime       | Keep the same `asyncHandler`, including accepted-work and parsed-body retention through handler settlement. Client disconnect must not cancel or replay an accepted mutation.                                                                                                                                                                                                 |
| Parsers and validation | Parent retains the general 100 MiB parser and distinct 24 MiB recording parser. Preserve `validateBody`, schema strictness/passthrough, bounds, UTF-8 checks and error precedence. Schema errors are 400, while some later normalization exceptions currently become generic 500; do not normalize those differences away.                                                    |
| Hosted controls        | Capability can report disabled state. Submit/retry require enabled coordination; state/cancel require configured coordination without the enabled check. Preserve project/run scope, sidecars, normalization order and exactly-once calls. Capacity remains 429 with `Retry-After` and `{ error, code, limit }`; duplicate submission and stale retry retain 409 translation. |
| Library mutation       | Preserve revision checks, resource-ID checks, normalization, re-read versus direct responses, conflict details and `SHA256(JSON.stringify(normalizedLibrary))` import identity. Keep notification timing and exact revision comparisons, including concurrent behavior. Never replay a write after an uncertain response.                                                     |
| Library stream         | Existing notifier, epoch, client ID, authorization/maintenance watchers, heartbeat and cleanup stay in their owner. Do not add a second listener or notifier.                                                                                                                                                                                                                 |
| Retained evidence      | History pagination, dataset fingerprints, project scoping, baseline retention and run deletion stay unchanged. Managed deletion must still use the coordinator when present; otherwise it uses the store.                                                                                                                                                                     |
| Route precedence       | `/library` and `/history` keep precedence on their registered methods. Do not add wildcard reserved-prefix guards: other methods must preserve their existing fallthrough or `/:runId` interpretation.                                                                                                                                                                        |
| Execution cost         | Same call/await order, serialization and resource acquisition. No new per-run scan, query, copy, timer, promise or middleware. `hosted-coordinator.ts`, `hosted-execution.ts`, `ExecutionSession` and worker lifecycle remain untouched.                                                                                                                                      |

Do not consolidate the duplicated recording-expiry validation in this refactor.
It is outside the extracted groups and changing it risks issue-path/precedence
differences without improving the chosen boundary.

## 1. Capture baseline and close the real HTTP gaps

Use the existing checkout, Node 24 and repository-pinned Yarn. Read the applicable
local CI notes, confirm the full diff, and save the original source plus matching
compiled parent under ignored `artifacts/`. Do not snapshot private live data.

Reuse existing tests and fixtures:

| Owner under `packages/studio-server-api/`                                   | Work                                                                                                                                                                                                                                                                               |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/tests/api-profile.test.ts`                                             | Extend the existing four-profile fixture with representative Evaluation reads/writes. Malformed bodies must be rejected by missing/proxy-only credentials before parsing; signed-in requests reach validation. Check unknown paths and reserved-method precedence once on control. |
| `src/tests/evaluation-runs-filesystem.test.ts`                              | Add real library mutation/conflict and notification assertions. Retain existing duplicate-import, run-event, history and recording tests instead of rewriting them.                                                                                                                |
| `src/tests/evaluation-runs.test.ts`                                         | Retain schema/export checks; add a compact full-app hosted HTTP group with typed coordinator doubles at the existing resource seam.                                                                                                                                                |
| Existing coordinator, execution, event, body-admission and retirement tests | Reuse their scheduler, transaction, recording, parsed-body and lifecycle coverage; do not reproduce those algorithms in HTTP tests.                                                                                                                                                |

Test each distinct hosted HTTP contract without multiplying all cases across
all profiles and storage modes:

- Filesystem capability fallback/unavailable submission; disabled managed
  submit/retry; successful normalized submission with the unchanged sidecar.
- Successful and missing state/cancel results, including access while new
  submissions are disabled; path/body mismatch without a service mutation.
- Duplicate submission and stale retry at 409; successful retry; submission and
  retry capacity errors with both limit labels, without a full cross-product.
- One semantic normalization failure and one unexpected coordinator failure
  through the real full-app error handler. Preserve generic 500 and no replay.
- The parent's DELETE dispatches to the coordinator when present and to the
  store otherwise. Existing tests continue proving scheduler deletion safety.

Assert exact service-call counts and payloads. A prototype has already verified
`WorkflowStorageServices.prototype.getManaged` can be mocked for these full-app
checks. Use a typed `Pick` of required methods, adapting only at the mocked
boundary; do not build a fake scheduler or add production injection hooks.
Dispose existing ownership before changing mode/roots, reset settings with the
existing helper, and seed only disposable settings. Keep these tests sequential
within their file. Cleanup must close listeners, dispose stores and restore
mocks/env even when an earlier cleanup step fails.

The filesystem harness mounts the actual router but omits outer authorization
and uses simplified error handling. Use `createApiApp` for access and public error
envelopes; do not infer those contracts from the narrower harness.

For the library, share one real-store scenario covering a valid resource edit,
an independent resource edit and a stale same-resource edit. Assert the 409
code, conflicts, returned current snapshot and unchanged stored state on failure.
Retain duplicate-import/no-op behavior and one resource-ID validation case.

For events, open one real SSE stream and consume its initial state. In a
single-writer sequence, perform a no-op and rejected mutation, then a successful
mutation with a distinct revision/client ID. Await that success event on the
same stream; its position detects an unexpected earlier notification without a
sleep. Bound reads and always close the stream. Compare epoch consistency within
one process, not random epochs across processes. Use the filesystem store to
exclude independent managed invalidation notifications. Existing policy-revocation
and retirement tests retain ownership of those unchanged stream mechanisms.

For lifetime, hold one real library-route mutation at the store boundary,
disconnect the client, then verify accepted work stays held until the operation
settles exactly once. Observe server close and work release with bounded waits;
a client deadline alone is not cleanup evidence. Use the existing `AcceptedWork`
and `createApiApp` option. Generic parsed-body retention is already tested.

Verify the recording route's 24 MiB assignment with an oversized declared
Content-Length, without allocating/transmitting a large body, and retain existing
non-ASCII schema checks. Do not add large-payload permutations or a 100 MiB test.

**Run new assertions against the original implementation before extraction.**
If an assertion fails there, resolve the incorrect expectation or record a
separate defect; do not silently turn this work into a behavior change.

## 2. Extract and verify structural equivalence

Move the specified bodies/definitions unchanged, add the two startup calls and
compatibility re-export, and remove only unused imports. Keep the thirteen
remaining handlers and both parsers in place.

Use one ignored TypeScript comparison to expand the registration calls and
compare all 23 handlers, middleware, schemas, helpers and exports. Compare the
hosted scope's identical field contract separately because its shared one-field
base remains private to the parent. No permanent source-text tests are needed.

In fresh compiled processes compare normal parent-first import and one
child-first order. Verify export names, re-export identity within the same
process, all route order/methods and parser identities. Do not compare object or
function identity across processes. Check the new import edges and existing
notifier/coordinator identity, with no new initialization beyond the baseline.
Do not build concurrently with these checks.

## 3. Run focused validation

After the new baseline assertions pass, run the affected tests on the extracted
source, then build once after the final source edit:

```sh
yarn workspace @valerypopoff/rivet-studio-server-api test:files src/tests/api-profile.test.ts src/tests/evaluation-runs.test.ts src/tests/evaluation-runs-filesystem.test.ts src/tests/evaluation-library-events.test.ts src/tests/hosted-evaluation-coordinator.test.ts src/tests/hosted-evaluation-execution.test.ts src/tests/body-admission.test.ts
yarn workspace @valerypopoff/rivet-studio-server-api build
yarn workspace @valerypopoff/rivet-studio-server-api exec tsc -p tsconfig.runtime.json --noEmit
yarn check:file-tree
yarn studio-server:verify:test-style
yarn node scripts/checks/check-test-style.mjs
yarn node scripts/checks/check-doc-links.mjs
```

The full API build includes tests; source-run success alone does not prove they
type-check. Apply relevant root style checks before final builds if they rebuild
shared outputs. Keep changed tests in `deploy/studio-server/scripts/api-test-files.mjs`.
Only add a new test file if existing owners cannot sensibly hold the coverage.

Temporarily remove one library registration or corrupt capacity error translation
in an ignored loader and prove a focused HTTP assertion fails for that reason.
Do not commit a mutation framework or rerun unrelated storage/cloud campaigns.

## 4. UI compatibility and performance

Use the repo runner on an owned local frontend for three existing browser cases:
one library/history journey and both recording success/failure trial journeys.
The other history-race permutations exercise unchanged client code.

```powershell
$env:PLAYWRIGHT_HEADLESS = '1'
$env:PLAYWRIGHT_SLOW_MO = '0'
# Set PLAYWRIGHT_BASE_URL to the owned frontend.
# Set PLAYWRIGHT_EXECUTABLE_PATH to verified cached Chromium when available.
yarn studio-server:ui:observe evaluation-history-paging.spec.ts evaluation-trial-orchestration.spec.ts --grep 'retryable initial read|Browser evaluation uses shared trial orchestration' --workers=1
```

Confirm the count with `--list` and inspect failures under `artifacts/playwright/`.
These mocked browser journeys prove UI compatibility; real HTTP tests above
prove handlers. Both specs already belong to the editor CI inventory. No new
shards, live infrastructure or cloud qualification are needed.

For performance, structural equivalence and an unchanged execution path are the
primary evidence. Supplement with one small paired local comparison, reusing the
existing endpoint fixture rather than creating permanent benchmark machinery:

- Original/final compiled parents in separate processes, same dependencies,
  Node runtime, fixture paths, settings, inputs and recording policy. Select the
  original parent through an ignored local loader so unrelated older code does
  not contaminate the comparison.
- Measure a real library read, a hosted submission with the deterministic double,
  and one tiny recorded workflow endpoint: 20 warmups and 100 measured sequential
  requests per case. Use separate process/fixture modes for filesystem work and
  the managed double; never change a serving owner's storage mode mid-process.
- Compare complete responses, exactly-once calls and expected persisted endpoint
  recordings. Flush asynchronous recording work after requests, outside measured
  response latency. Do not contact an external provider, database or object store.
- Report median/p95 and sample limitations. Repeat with reversed variant order
  only if the first pair suggests a regression or conflicting results. Investigate
  a reproducible increase; do not invent a new latency allowance or remove an
  assertion to make it pass.

No finite benchmark proves exact zero latency difference. The implementation
must add no execution work regardless of measurements; do not claim production
performance qualification from this local check.

## Completion

Update this plan, `architecture.md`, `refactor-history.md` and `../EVALUATIONS.md`
with actual ownership, checks and limitations. Keep the developer-doc index
link. No user-doc change is needed if behavior is preserved. Finish formatting,
documentation links and `git diff --check`; exclude private/generated artifacts.
Commit, push and deployment are separate follow-up requests.

Complete only when all ten moved routes, thirteen retained routes, five exports,
parsers and operation order are preserved; new assertions pass before/after;
compiled/browser checks pass; and no added execution work or reproducible
slowdown is found. Stop for a changed error, schema, side effect, notification,
authorization, storage call, module lifecycle or execution behavior. A blocked
or skipped required check remains an explicit gap.

## Implementation and verification record

Implemented on `develop` from commit `7ccce0dd7`. The extraction moves ten
handlers into the two HTTP modules and retains thirteen handlers, both parsers
and five exports in the parent. No store, coordinator, execution or middleware
implementation changed.

### Adjacent stream correction

A deterministic HTTP test reproduced an existing race in `GET /library/events`:
a concurrent edit could commit after the initial revision read but before the
stream subscribed. The stream would announce the old revision and miss the edit.
The test also fails against the original committed implementation.

`openEvaluationLibraryEventStream` now listens before reading the revision. It
retains at most one notification during setup and hands over synchronously to
the live stream. Opening snapshot and reset observations stay separate state
events: a reset cannot overwrite a newer snapshot or be ignored as the same
browser's save. The temporary listener detaches on client close, read failure
or completed handover. Authorization and maintenance checks still control the
live stream. The route keeps one snapshot read, with no polling or extra query.

This is the sole intentional behavior correction beyond the extraction.
The source comparison matches the other 22 handlers and all 43 schema/helper
definitions; compiled checks preserve all 23 registrations, wrappers, parsers
and five exports. Parent-first and child-first imports work without creating
storage resources in the child modules.

### Test ownership

- The existing four-profile HTTP fixture owns authentication, validation order,
  parser limits and route exposure.
- Real filesystem HTTP tests own library import/replacement, duplicate imports,
  resource conflicts, suite normalization, dependent-resource deletion and
  ordered notifications. A disconnected accepted edit must settle exactly once.
- The incremental-run test covers start, progress and terminal persistence.
- One real-stream race test uses a controlled snapshot read and complete parsed
  events. A small isolated event test covers reset, failed read and closed-read
  cases. Keep token/epoch expectations local to one process.
- Existing store, coordinator and execution suites own transactions, job safety,
  retention, checkpoints and recording failures. Do not duplicate those
  algorithms in route tests.

The test cleanup removed duplicate history-authentication and fake SSE delimiter
checks, retaining their coverage in real HTTP fixtures. Duplicate library setup
was removed from the run-event scenario. Write-order testing now uses a bounded,
controlled first-write promise instead of a timed sleep. No new test file,
framework or CI shard was introduced; all affected files are in the normal
test inventory.

### Validation

New HTTP assertions passed against the original implementation before extraction.
Final commit preparation passed all **129 tests** across the nine Evaluation,
API-profile, body-admission, authorization and maintenance suites, with no skips
or failures. The lower count reflects the two duplicate tests removed above.
All three selected headless browser journeys passed on the final runtime code.

API compilation includes test type-checking; runtime type-checking, root and
Studio Server test-style rules, file-tree/import checks, documentation links and
`git diff --check` passed. The full root `test:style` command also passed during
commit preparation. The unrelated existing table formatting in `../EVALUATIONS.md`
is intentionally untouched.

Temporary ignored loaders proved that tests reject a capacity response changed
from 429 to 428, bypassed write serialization, and the old stream-opening race.
The last two were rechecked after test cleanup. Evidence lives under ignored
`artifacts/evaluation-http-refactor-20261115/`; none is required by product code.

### Local timing evidence

Each cell is median / p95 milliseconds, with 20 warmups and 100 measured
sequential requests. Processes, fixture paths, inputs and dependencies matched.
The second pair reversed variant order because the first suggested a slowdown.

| Case                       | First pair: original | First pair: extracted | Reversed pair: original | Reversed pair: extracted |
| -------------------------- | -------------------- | --------------------- | ----------------------- | ------------------------ |
| Library read               | 0.69 / 0.93          | 1.12 / 2.41           | 0.73 / 0.97             | 0.72 / 0.94              |
| Recorded workflow endpoint | 2.80 / 11.65         | 4.72 / 14.71          | 2.95 / 11.67            | 2.55 / 11.93             |
| Hosted submission          | 0.81 / 1.15          | 0.84 / 1.24           | 0.88 / 1.39             | 0.84 / 1.19              |

The first slowdown did not reproduce. Each local variant persisted all 120
endpoint recordings; each hosted variant made exactly 120 submission calls.
Recording work flushed outside measured response latency. No remote database,
provider or object store was involved. These samples establish no reproducible
local regression, not a production latency guarantee.

There is no added workflow execution work. The later stream correction only
runs while opening a library notification stream, so repeating an endpoint
benchmark after that change or test-only cleanup would add no relevant evidence.

### Release boundary

Implementation and local validation are complete. No cloud test or deployment
was run. Commit and publication are separate from production qualification;
keep those claims distinct.
