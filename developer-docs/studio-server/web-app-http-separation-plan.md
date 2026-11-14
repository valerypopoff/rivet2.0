# Web-app HTTP and workflow endpoint separation

Status: complete and locally verified, with the Windows host-permission
exception recorded below. Reviewed on 2026-11-14 against
`853e735d9fbc45c4d02070f11c6d8e6fe7f0be28` in the `develop` checkout. Existing
uncommitted Docker/Yarn bootstrap changes are separate work and must be preserved.
All five implementation steps are complete. Committing and releasing the changes
are separate from this refactor's local completion.

## Goal and reassessed scope

Separate web-app HTTP handling from ordinary workflow endpoints so each has a
clear owner. Preserve behavior, execution work, resource lifetime and performance.
The benefit is easier navigation and smaller changes when extending one surface;
a substantial reduction in total lines or a runtime speedup is not promised.

Before extraction, `routes/workflows/execution.ts` had 1,263 lines and exported six
routers. It combined workflow bearer authorization and execution, web-app browser
authorization/OAuth, HTTP action preparation, HTML/JSON delivery, and common HTTP
response/telemetry helpers. Graph execution and recording already had shared
owners, which the refactor preserves. Do not introduce another execution
controller, transport framework, service registry or universal handler factory.

The first recommendation needs these corrections:

- HTTP and WebSocket actions are not interchangeable. HTTP uses
  `runRecordedWebAppAction` and `ExecutionSession`; WebSockets use Node's prepared
  action/gateway lifecycle. Their input handling, early responses, reconnection
  and error handling must not be unified during this refactor.
- Runtime options, execution resolution and recording persistence are already
  shared through `web-app-execution.ts`. Reuse them without relocating their
  implementation or changing their contract.
- `app.ts` already separates control and published execution profiles and mounts
  configurable paths. A shorter router module does not require new app wiring.
- Helpers shared by both HTTP surfaces must have an independent module. Having
  the new web-app module import helpers from `execution.ts` would introduce a
  dependency cycle when `execution.ts` re-exports its routers.
- Workflow and web-app action errors deliberately have different envelopes and
  exposure rules. Sharing transport helpers must not harmonize these policies.

## Target ownership

All module names below are relative to
`packages/studio-server-api/src/routes/workflows/`. Two new production files
implement the split; keep their private helpers together rather than extracting each
concern into another file.

| Module                                                              | Responsibility                                                                                                                                                                                                               |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `execution.ts`                                                      | Four workflow endpoint routers, bearer/capability checks, request input/output mapping, latest debugger binding and endpoint execution. Retain existing compatibility re-exports, including the two web-app routers.         |
| `web-app-http.ts` (new)                                             | Two web-app HTTP routers; browser authorization, OAuth redirects and logout-link insertion; project resolution; action preflight and its shared state; action body validation/execution; HTML/JSON/action response delivery. |
| `execution-http-support.ts` (new)                                   | Existing common JSON/duration and workflow-error formatting, debug/telemetry headers and their flag checks, and the small published-execution permit helper. No route registration or new initialization work.               |
| `web-app-execution.ts` (existing)                                   | Existing shared execution definitions, request-context filtering, runtime options, recording identity/persistence, and socket preparation. Leave its implementation and compatibility exports unchanged.                     |
| `execution-session.ts` and `web-app-action-websocket.ts` (existing) | Existing lifecycle, recording and WebSocket ownership. No implementation changes are part of this plan.                                                                                                                      |

The support module exports only `sendJsonWithDuration`,
`sendWorkflowErrorWithDuration`, `shouldCollectCodeRunnerTelemetry`,
`setWorkflowExecutionDebugHeaders`, `setCodeRunnerTelemetryHeaders`, and
`acquirePublishedExecutionPermit`. Keep `isEnvFlagEnabled` and
`shouldEmitWorkflowExecutionDebugHeaders` private there. Bearer parsing and
workflow request context stay in `execution.ts`; HTML and action-error formatting
stay in `web-app-http.ts`.

Dependency direction: both HTTP modules consume the support module and existing
shared execution modules. `execution.ts` re-exports the web-app routers from
`web-app-http.ts`. Neither the web-app router nor the support module imports
`execution.ts` or `index.ts`. WebSocket code continues to import shared execution
directly and must not acquire an HTTP-router dependency.

Keep imports/exports in `routes/workflows/index.ts` and mounts in `app.ts`
unchanged. Preserve every existing runtime and type export from `execution.ts`,
including those used by the filesystem suite harness and
`web-app-action-coordinator.test.ts`. Each router remains one module-owned
instance, created once; re-exports must reference that same instance.
Keep `Router()` options and registrations unchanged. Do not add a parent router,
another `router.use()` layer or a per-request factory: those can change parameter
scope, URL handling, fallthrough and middleware work even with the same handlers.

## Observable contracts to preserve

The following are current default mount paths, not constants to introduce.
Keep the existing settings-based dynamic dispatch and legacy environment aliases.
`endpointName` on latest workflow routes retains its debugger-channel syntax.

| Router                             | Default mount and methods                                                     | Runtime profiles    |
| ---------------------------------- | ----------------------------------------------------------------------------- | ------------------- |
| `publishedWorkflowsRouter`         | `POST /workflows/:endpointName`                                               | execution, combined |
| `internalPublishedWorkflowsRouter` | `POST /internal/workflows/:endpointName`                                      | execution, combined |
| `latestWorkflowsRouter`            | `POST /workflows-latest/:endpointName`                                        | control, combined   |
| `internalLatestWorkflowsRouter`    | `POST /internal/workflows-latest/:endpointName`                               | control, combined   |
| `publishedWebAppsRouter`           | `GET /apps/:slug`, `GET /apps/:slug/app.json`, `POST /apps/:slug/actions/run` | execution, combined |
| `latestWebAppsRouter`              | Same three suffixes under `/apps-latest`                                      | control, combined   |

The evaluation profile mounts none of these. WebSocket upgrade handling and OAuth
callback/logout routes retain their existing separate owners and exposure.

1. **Middleware and authorization order.** Keep the app's settings snapshot,
   maintenance barriers and route mounts intact. Workflow public authorization
   precedes its JSON parser; internal endpoint routes retain their current trust
   boundary. Web-app initial browser/origin authorization precedes storage
   resolution; resolved OAuth allowlists precede action body parsing. Preserve
   trusted-client/proxy rules, cookies, redirects, cache headers and rejection
   connection closing. Do not replace these with a general auth middleware.
2. **Body admission and preparation ownership.** Keep the workflow limit at
   100 MiB and web-app action limits request-scoped. Move the existing
   `preparedWebAppActions` WeakMap, 16-operation preflight counter and preparation
   functions together. Published and latest web apps share that single counter.
   The 15-second client deadline does not release the underlying preflight
   permit before storage settles. Preserve finish/close cleanup and the captured
   setting used by the parser; never reread it midway through preparation.
3. **Execution and cancellation.** Move the current action runner intact;
   preserve revision checks, UI input mapping, browser storage patches, context
   filtering and runtime option construction. Keep published versus latest
   debugger behavior and capacity admission differences. Registration, signals
   and permit release remain at their existing points. An endpoint's early
   response must not release still-running background work or its processor.
   Client disconnect semantics must not change as a side effect of extraction.
4. **Recordings and outcomes.** Retain one session/recorder owner per execution,
   run/correlation identity, status, costs and enqueue ordering. Evidence and
   recording persistence stay asynchronous. Response-binding/delivery failure
   after successful graph completion must not rewrite that graph's outcome.
   Never rerun a graph or replay an uncertain external write.
5. **Responses and observations.** Preserve JSON primitives, falsy/null outputs,
   existing object `durationMs`, `x-duration-ms`, optional debug/telemetry headers,
   error envelopes/codes, `Retry-After`, logging and HTML bytes. Keep timing start
   points and synchronous settings/environment reads where they are today.
   Preserve Express GET/HEAD behavior, trailing-slash handling, unsupported
   methods and unknown-route fallthrough. OAuth callback/logout registration
   remains ahead of web-app slug handling in `app.ts`.

For comparisons, validate timing fields and generated identities by shape and
within-run consistency, not raw equality between different runs. Ignore only
explicitly identified variable values; compare status, payload structure, header
presence, redirect targets and cookie attributes exactly. An HTML fixture with
fixed project/revision IDs should remain byte-equivalent.

## Ordered implementation

1. **Capture the baseline.** Record commit and dirty diff, supported Node 24 and
   pinned Yarn versions, profiles, storage/recording configuration and exact
   commands under ignored `artifacts/`. Preserve unrelated edits. Inventory
   existing exports, router registrations and function bodies for a one-time
   before/after comparison. Run the four-file baseline command below and capture
   endpoint latency before moving implementation. A failing baseline must be
   investigated and documented separately, not silently fixed in the extraction.
2. **Extract only common HTTP support.** Move the six shared helpers and their
   two private flag helpers unchanged. Rewire imports in the original module;
   compile before proceeding. Do not generalize error formatting or add another
   wrapper/await around requests. Intermediate extraction needs a build, not
   another full behavior-test run when function bodies remain unchanged.
3. **Move web-app HTTP ownership.** Move its two routers, handlers, private
   helpers, types, constants, counter and WeakMap into `web-app-http.ts`.
   Preserve handler bodies, per-router registration order and middleware lists.
   Re-export the routers from `execution.ts`; remove now-unused imports. Leave app mounts,
   shared runtime, storage adapters and WebSocket implementation untouched.
4. **Verify equivalence and performance.** Compare the baseline with the final
   diff, including moved functions, all exports and router instance identity.
   Run the final full API suite once, local managed integration once, browser
   checks and paired HTTP measurements below. The full suite already includes
   the baseline files and the other tests in the coverage map; do not run them
   all separately again. Use focused reruns only to investigate failures or
   validate subsequent fixes. Add a behavior test only for a real uncovered
   extraction risk; use existing fixtures and actual HTTP routes. No permanent
   source-text/line-count tests or duplicate suite/framework are needed.
5. **Update ownership documentation.** Update `architecture.md` and the relevant
   notes in `access-and-routing.md`, then add a concise completed entry to
   `refactor-history.md`. Update this document with actual evidence and limits.
   Keep user docs unchanged when behavior is unchanged. Before an eventual
   requested commit/push, apply relevant entries in `ci-pre-push.local.md`.

Each extraction depends on the preceding step's build passing. Do not mix this
work with the pending Docker fix, API policy changes, version bumps, storage changes,
workflow changes or a release. There is no deployment or cloud test in this plan.

## Validation using existing owners

Use the pinned workspace toolchain and build changed packages before compiled
consumers. Record baseline and final results separately; historical successes do
not certify the refactor. Run the small baseline before extraction, compile each
step, and run the full API suite once on the final implementation. The following
table is a coverage map, not a sequence of separate mandatory test runs.

| Concern                                                                                                       | Existing API test files under `src/tests/`                                                                      |
| ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Runtime profiles, real route exposure, early auth rejection and settings-based paths                          | `api-profile.test.ts`, `app-settings.test.ts`, `body-admission.test.ts`                                         |
| Workflow inputs/outputs, public/internal routes, context, debugger, caches and asynchronous recordings        | `workflow-execution-filesystem.test.ts`                                                                         |
| Published/latest web-app HTML, revisions, storage patches, OAuth/UI gate, HTTP/Socket recordings and failures | `workflow-web-apps-filesystem.test.ts`                                                                          |
| Capacity, shutdown registration and preflight deadline ownership                                              | `published-execution-admission.test.ts`, `active-http-executions.test.ts`, `web-app-action-coordinator.test.ts` |
| OAuth protocol and existing qualification-session compatibility                                               | `web-app-oauth.test.ts`, `release-gate-web-app-auth.test.ts`                                                    |
| Physical completion, evidence and recording failure semantics                                                 | `recording-durability.test.ts`, `hosted-runtime-policy.test.ts`                                                 |
| Real HTTP early responses, physical tails, concurrent request ownership, client loss and process shutdown     | `workflow-async-response.test.ts`, `workflow-async-process.test.ts`                                             |

Baseline command from the repository root:

```sh
yarn workspace @valerypopoff/rivet-studio-server-api build
yarn workspace @valerypopoff/rivet-studio-server-api test:files src/tests/api-profile.test.ts src/tests/workflow-execution-filesystem.test.ts src/tests/workflow-web-apps-filesystem.test.ts src/tests/workflow-async-process.test.ts
```

Final API verification after extraction:

```sh
yarn workspace @valerypopoff/rivet-studio-server-api build
yarn workspace @valerypopoff/rivet-studio-server-api test
yarn workspace @valerypopoff/rivet-studio-server-api test:async-managed
```

Use the maintained suite/manifest; do not invent another API test runner. Preserve
existing platform skips and report their limits. The legacy-filesystem tests
exercise the common HTTP code but do not alone verify managed storage. The
existing `test:async-managed` integration starts and removes its own disposable
PostgreSQL/MinIO containers and exercises actual SQL/S3 publication, workflow
HTTP execution and asynchronous tails. Check Docker availability and fixture
image availability first; do not manually start a duplicate stack. It does not
exercise web-app `/actions/run` HTTP requests, so do not claim managed web-app
route coverage from it. The real web-app HTTP behavior is covered by the common
router's filesystem tests; this refactor leaves managed resolution/persistence
implementations unchanged. No GCP or production credentials are required.

Because routing/rendered HTML can affect browser behavior, run the existing
headless browser cases after implementation against the current local build:

```powershell
$env:PLAYWRIGHT_HEADLESS = '1'
$env:PLAYWRIGHT_SLOW_MO = '0'
# Set PLAYWRIGHT_BASE_URL to the current local app URL when needed.
yarn studio-server:ui:observe rivet-web-app.spec.ts project-preview-mode.spec.ts web-app-accepted-resume.spec.ts --workers=1
```

Several browser cases deliberately mock transport and the provider journey is
fixture-gated. Report that distinction and any skips. Browser client fixtures
complement the real HTTP/API tests; they cannot prove backend routing by
themselves. Do not create a cloud fixture to unskip a provider test for this
refactor. Inspect `artifacts/playwright/` if a browser check fails.

## No-slower-runs acceptance

The primary protection is structural: identical request/execution bodies and
ordering, direct static imports, and the same number of parser, authorization,
resolution, processor and recording operations. No new database/storage reads,
serialization, copying, dynamic imports, IPC, timers, logging or awaited evidence
may be added to the request path. Imported modules must not add initialization
work or evaluate request-scoped flags/settings at module load.

Measure actual HTTP requests, not just direct graph execution. Reuse the current
HTTP test harness with deterministic local graphs and no paid model calls.
Compare baseline and candidate in separate processes on the same Node 24 build,
machine, storage, inputs, recording settings and connection policy. Keep the
unrelated Docker edits equal in both samples. Include published and latest
workflow requests, a web-app HTTP action, and a small concurrent-request sample.
Consume and validate complete response bodies; drain accepted background work
and recording queues before terminating each process. Use test-owned ports,
roots and fixtures and identify the loaded source/build in
each report, so a stale local server cannot accidentally supply the results.

For recording-enabled measurements, use batches below the existing queue bound,
drain between batches outside individual request timings, and verify that every
expected top-level recording persisted exactly once. Set identical test-only
retention limits sufficient for that count in both disposable runs. Queue metrics
expose active/pending work but do not count dropped writes; an empty queue alone
is not evidence of successful recording. Report total throughput including drain
time separately from request latency. Do not accept a speed result obtained by
dropping recordings or leaving accepted work unfinished.

Use a high-resolution `performance.now()` probe, at least 50 warmups and 500
measured small requests per case, and retain samples for median/p95 and
throughput. If differences exceed baseline variation, reverse the run order to
check machine/cache effects, with at most three baseline/candidate pairs per
case. Do not keep rerunning until a favorable sample appears. For larger bodies,
use an additional smaller fixed sample to catch accidental copying.
Separate diagnostic-header-enabled checks from normal latency measurements.
The existing `workflow-execution:measure` rounds to milliseconds and is useful
for smoke diagnosis, not proof of sub-millisecond parity. An ignored local probe
is sufficient; no new benchmark subsystem or noisy CI latency gate is required.
Always compare like-for-like recording/admission settings; do not disable them
in the candidate alone. Retain failed-request counts as well as successful
timings.

Accept when there is no added hot-path work and no repeatable median/p95 or
throughput regression beyond observed baseline variation. If measurements remain
ambiguous, report that limit rather than claiming exact performance neutrality.
Any confirmed slowdown must be explained and removed before completion.

## Completion and stop conditions

Complete only when the ownership split exists, all existing exports/routes and
their instances remain compatible, behavior tests and local integrations pass,
required browser checks pass with disclosed skips, performance evidence shows no
repeatable regression with disclosed measurement limits, and documentation
describes implemented ownership.
Review total changed/new production code as well as the shorter original file:
reject scaffolding that only shifts complexity or duplicates behavior.

Stop and reassess if the split requires changing a handler's decisions, creating
another session/recorder or admission pool, rewriting a transport, widening auth,
changing persistence, or adding work to graph invocation. Record an unrelated
bug separately instead of disguising its behavior change as a refactor. Failed
local prerequisites remain explicit gaps; no cloud attempt, deployment, commit
or push follows automatically from finishing this plan.

## Implementation and evidence (2026-11-14)

The extraction is implemented in the original checkout. `execution.ts` decreased
from 1,263 to 377 lines; `web-app-http.ts` has 806 lines after the review below and the shared HTTP
support module has 139. Across the three files, nonblank lines increased from
1,124 to 1,169 because the module imports and exports are explicit. The benefit
is ownership clarity, not a claim that total implementation code shrank.

The initial extraction's TypeScript syntax-tree comparison confirmed 62 identical declarations,
including all 48 function bodies, parameters and return annotations. All ten
route registrations and their per-router order are preserved, as are all 21
runtime/type export bindings. Source and compiled checks confirmed the same 17
runtime exports and the identity of the router/helper re-exports. App mounts,
shared runtime/session code, storage facade and WebSocket implementation are
unchanged. The new module uses the existing workspace package path for its
type-only recording import; that avoids new import-policy debt and emits exactly
the same JavaScript as the original type import.

Completed local checks on Node 24.22.1:

- The pre-extraction baseline passed all 80 selected API tests. The API builds
  passed before extraction, after helper extraction and after the complete split.
- The local PostgreSQL/MinIO integration passed its actual publication,
  cross-process execution, early-response, recording and terminal-tail checks.
  Its two temporary containers were removed.
- A fresh frontend build passed. Headless browser verification passed nine cases
  covering previews, revision mismatch, access revocation, logout presentation,
  browser persistence and accepted-run resumption. One provider-only journey
  remained intentionally skipped; these client fixtures do not certify a cloud
  rollout. The test-owned static server was stopped afterward.
- Import boundaries, AI runtime boundaries, rich-text ownership, formatting and
  documentation-link checks passed. No test assertion was relaxed.
- The final full API run completed 1,903 tests: 1,896 passed, six were skipped,
  and one failed. The Windows descendant-cleanup test was denied process-tree
  termination in the restricted host. The unchanged six-test `exec.test.ts`
  file passed with normal host permissions, including the descendant check.
  These invocations overlap; do not add their totals. The original full run
  retains its failed exit status in the evidence. No application assertion was
  weakened and no process-management code was changed to hide this permission
  limitation. All workflow endpoint and web-app tests passed in the full run.

Two before/after passes exercised published/latest workflows, both HTTP web-app
actions, four concurrent requests and 256 KiB bodies. A third, focused pair
checked the latest web-app action independently of accumulated recording
history. Across the six runs, all 12,320 accepted synthetic executions produced
exactly one recording and all responses were complete. Recording drain was
included in throughput observations.

Windows filesystem/queue timing varied between the multi-case passes; those
numbers must not be presented as a product speedup or proof of identical timing
for every workload. In the focused pair, median HTTP latency was 15.63 ms before
and 15.58 ms after; p95 was 25.42 ms and 22.23 ms respectively. The extraction adds
no request operation, serialization, resource owner, database/storage read or
await, and the compared function bodies remain unchanged. Detailed local
evidence is retained under ignored `artifacts/web-app-http-refactor-20261114/`.

### Post-extraction review

The action handler no longer repeats the missing-UI-graph response after
preparation. Its private prepared-request map can only contain a non-null graph;
the real 404 remains in preflight, before parsing the action body. A new HTTP
regression removes a draft's UI graph while preserving project identity, submits
malformed action JSON and checks the 404 and closed connection. It also executes
the unaffected published snapshot. The case passes against both the frozen
original implementation and the final reviewed code.

The workflow router now uses the same existing workspace type import as the
web-app router, allowing removal of its legacy relative-import exception.
Workflow-router and shared-helper JavaScript remain byte-identical. The source
comparison confirms that the other 47 function bodies, all route registrations,
all compatibility exports and the shared runtime owners remain unchanged. No
unused declarations or type errors were found in the three refactored modules.

The affected API suites passed 62 tests. Headless browser checks again passed
nine cases with the same provider-only skip. The identity-preserving missing-graph
fixture was also rechecked individually against original and final code. The
full-suite figures above describe the initial extraction; this review reuses that
unchanged coverage instead of rerunning the entire suite. No latency-producing
operation was added, and the existing timing evidence remains applicable.

### Adjacent lifecycle review

A follow-up review checked parser/preflight handoffs, prepared-request cleanup,
singleton router imports, the separate WebSocket execution owner, and HTTP
execution/recording lifetime. No additional defect was confirmed in these paths.
Production code remains unchanged by this review.

On Node 24.22.1, the existing `body-admission`, `active-http-executions`,
`web-app-action-coordinator`, `workflow-async-response` and `shutdown-http` suites
passed all 39 tests with no skips. They cover rejected and cancelled uploads,
retained body reservations, preflight timeout ownership, early-response tails,
success/failure/abort recording paths, and bounded shutdown with complete response
delivery. The focused run is recorded in
`artifacts/web-app-http-refactor-20261114/adjacent-review-tests.log`; it supplements
the earlier full API and browser results rather than replacing them.

Fresh-process checks also imported each of the three HTTP modules first, in
both source and compiled form. All six load orders preserved the same six router
instances and registration counts, without relying on the suite harness to warm
the module graph. A separate local HTTP probe held 16 read-only lookup stubs
across both web-app routers: the seventeenth request was rejected before parsing,
disconnecting a client retained the underlying lookup's permit, and resolving or
rejecting lookups released capacity without leaking body reservations or accepted
request work. These checks found no further defect. Their ignored evidence is
`cold-import-check.log` and `preflight-concurrency-check.log` in the same artifact
directory; the stubbed lookup probe does not establish database health.

### Test maintenance

The published/latest HTML and app-JSON checks now share one project, publication
and server fixture. Both surfaces still assert their status, content, socket path
and JSON name, and explicitly require distinct revision keys. The missing-draft
pre-parser regression remains separate, as do HTTP/WebSocket execution and
cross-process shutdown coverage.

Coordinator polling and preflight timeout tests use controlled clocks rather
than elapsed-time polling or a keepalive interval. The polling test verifies both
duplicate suppression and delivery of a new sequence. It imports preflight from
its shared owner instead of loading the HTTP compatibility module. These changes
affect tests only; production behavior and timeouts are unchanged.

The focused two-file command passed all 36 tests after cleanup (37 before the
shared-fixture consolidation), with no skips. API type checking, test-style
validation and the maintained test-manifest check passed. Both runs took about
26 seconds locally; the removed timer waits and repeated fixture are a
determinism/maintenance improvement, not a demonstrated whole-suite speedup.
