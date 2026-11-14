# Recording and run-statistics HTTP separation

Status: implemented and locally verified on 2026-11-14, based on
`6cc0151dc856842951f4d94d65e55a870bc25dc5` on `develop`. The preceding
[web-app HTTP separation](web-app-http-separation-plan.md) is already committed.
All five implementation steps below are complete. This record accompanies the
source, regression tests and ownership documentation; publication and deployment
remain separate work.

## Goal and verified boundary

Move recording browsing, search, replay downloads and statistics HTTP handling
out of `routes/workflows/index.ts`. Preserve behavior and execution speed.
This is an ownership refactor, not a search optimization or database change.

The original parent had 1,042 lines. The extraction comprises ten contiguous
route registrations, twelve method/path combinations including aliases, six
schemas, and the private `isAbortError` helper. Existing storage, search,
statistics, recording and execution services remain the owners of their work.

Important shared boundaries:

- The real app applies settings snapshots, maintenance/request-work barriers and
  `requireOperatorAuth` before these routes. The lightweight recording HTTP test
  harness omits some of those layers, including operator auth and the production
  error handler; it cannot prove their behavior.
- The parent's GET cache-header middleware precedes these routes. Its `timing`
  and `jsonBody` instances also serve unrelated routes.
- `createRequestAbortSignal` is shared with two graph-reference routes. Keep it
  in the parent rather than duplicating it or extracting another utility file.
- Catalog requests prepare the existing input-extraction worker after their
  metadata read. Compiled serving uses workers; source-mode tests can extract
  inline. Neither import-time preparation nor source-only validation is enough.

## Implementation: one new module

All source paths here are relative to `packages/studio-server-api/src/`.

Create `routes/workflows/recording-http.ts` with:

- `registerWorkflowRecordingHttpRoutes(router, shared): void`.
- The ten existing registrations, unchanged handler bodies and full relative paths.
- Module-level `recordingsRunsQuerySchema` and the five `runStatistics*Schema`
  declarations, plus private `isAbortError`.
- Direct imports of existing dependencies, with no parent/index or execution-router
  import or new storage owner. Transfer the existing shared-runtime relative-import
  allowance from `index.ts` to this module; do not add another allowance. The
  shared package exposes TypeScript sources, so its package-name `.js` runtime
  import does not resolve in the compiled API. Keep the original working import.

The small startup-only argument is:

```ts
shared: {
  timing: RequestHandler;
  jsonBody: RequestHandler;
  createRequestAbortSignal(
    req: Request,
    res: Response,
  ): { signal: AbortSignal; cleanup(): void };
}
```

Use Express types and destructure these references once. Keep schemas at module
scope and leave the existing inline sub-run schema derivation alone. Do not pass
repositories, settings, arbitrary callbacks or factories.

In `index.ts`, replace exactly the contiguous recording/statistics block with
one call using the existing router and shared references. Its position is
**after `/maintenance/reconciliation/findings` and before `/move`**. Retain all
other middleware, registrations, helpers and compatibility exports; remove only
now-unused imports/schemas. This is direct registration on the existing router,
not a nested router or additional request-time call.

## Behavior to preserve

Paths remain under `/api/workflows`:

| Method | Path                                                         | Preserved behavior                                                           |
| ------ | ------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| GET    | `/recordings`, `/recordings/workflows`                       | Catalog aliases, evidence flag, timing headers and worker-preparation order. |
| GET    | `/run-statistics/targets`                                    | Surface validation and metadata-only target catalog.                         |
| POST   | `/run-statistics/query`                                      | Existing parser, defaults, validation, period errors and backend call.       |
| GET    | `/recordings/runs`, `/recordings/workflows/:workflowId/runs` | Pagination, filters, continuation scope, cancellation and response handling. |
| GET    | `/recordings/:recordingId/sub-runs`                          | Additional `requireAuth`, bounded ID/pagination and child-scope mapping.     |
| GET    | `/recordings/:recordingId/recording`                         | Recording artifact and text content type.                                    |
| GET    | `/recordings/:recordingId/replay-project`                    | Project artifact and text content type.                                      |
| GET    | `/recordings/:recordingId/replay-dataset`                    | Dataset artifact and text content type.                                      |
| GET    | `/recordings/:recordingId/summary`                           | Summary, missing-recording behavior and response shape.                      |
| DELETE | `/recordings/:recordingId`                                   | One deletion call and `{ deleted: true }`.                                   |

Preserve middleware order and identity, array aliases, Express GET/HEAD and
trailing-slash behavior, decoded parameters, cache policy and error forwarding.
Schema coercion, optional fields and unknown-field handling must not change.

Query `.parse()` errors and POST `validateBody()` errors currently follow different
paths. The general app does not map every Zod error to 400. Record and retain the
observed status/envelope for each, including the difference between the full app
and the lightweight harness. Do not standardize errors during extraction.

Search keeps roots versus family/child scopes, ordered results, evidence flags,
partial costs, count-free continuations and current limits. Retain both supported
continuation versions and the existing scope rules, including project-only
Subgraph inclusion; do not redesign tokens. Keep abort listeners and their cleanup
at the same points. Suppress only the current combination of an aborted signal
and an `AbortError`; an ordinary backend failure must not become an empty page.

Do not edit execution, persistence/recovery, retention, database schemas/indexes,
scanner/cache algorithms, artifact formats, frontend behavior or the existing
local-editor recording upload router.

## Ordered implementation and checks

1. **Capture baseline.** Confirm checkout/diff and supported Node 24/pinned Yarn.
   Save the original module, compiled baseline and relevant file hashes under
   ignored `artifacts/`. Run the baseline command below. Add only missing
   characterization cases, and prove them on the original implementation first.
2. **Extract.** Make the single-module move. Build once before testing the result.
   Preserve the baseline compiled output before this build replaces it.
3. **Verify structure.** Compare syntax trees and runtime registration once:
   ten moved registrations and six schemas are unchanged; all other parent
   registrations retain their positions; router, middleware and export identities
   are preserved. In separate processes import the new module first and the
   parent first, using source and compiled output. Check for duplicate registration
   and new import-time side effects. Keep these one-off checks out of product code.
4. **Verify behavior and overhead.** Run the final focused checks, compiled probe
   and four browser cases below. A failure requires diagnosis, not repeated runs
   hoping for a pass.
5. **Document completion.** Update architecture, access/routing, recording-search
   ownership and refactor history. Record actual results/limitations here.
   Review combined parent/new-module code; a shorter parent alone is not success.

### Focused API coverage

Run before and after:

```sh
yarn workspace @valerypopoff/rivet-studio-server-api build
yarn workspace @valerypopoff/rivet-studio-server-api test:files src/tests/workflow-recordings-http.test.ts src/tests/api-profile.test.ts
```

The recording suite covers aliases, replay, deletion, family browsing, searches,
continuations and statistics. The full-app profile suite must cover recording
GET/DELETE and malformed statistics POST: missing proxy credentials, proxy-only
credentials when a UI session is required, and valid operator access. Assert
specific outcomes and that control/combined expose the routes while
execution/evaluation do not. Reuse existing disposable fixtures and keep any
necessary cases in the existing suites.

If equivalent coverage is absent, add one targeted HTTP cancellation/error case:
hold a backend read through an existing repository/test seam, disconnect the
client, observe abort and cleanup, then verify a genuine read error is forwarded.
Do not mock the HTTP handler or introduce production test hooks. Also characterize
malformed queries, reversed periods and unknown methods/paths without changing
their current responses.

Run these adjacent checks once after extraction:

```sh
yarn workspace @valerypopoff/rivet-studio-server-api test:files src/tests/recording-input-filter.test.ts src/tests/recording-input-worker.test.ts src/tests/recording-statistics.test.ts src/tests/recording-statistics-sql.test.ts
yarn workspace @valerypopoff/rivet-studio-server-api exec tsc -p tsconfig.runtime.json --noEmit
```

The API build compiles tests; the container-target check verifies production
inputs. Confirm the new module and worker exist in the fresh compiled output.
Run relevant import, test-style, test-manifest, documentation-link and whitespace
checks. Reuse passing checks when their inputs are unchanged.

A full API sweep, database campaign or Kubernetes rehearsal is not required for
this bounded move. Legacy-fixture checks do not certify live managed storage.
If backend or execution code unexpectedly needs changes, stop and reassess scope
and the required integrations rather than quietly expanding this refactor.

### Browser coverage

Use the repo runner against the current local frontend:

```powershell
$env:PLAYWRIGHT_HEADLESS = '1'
$env:PLAYWRIGHT_SLOW_MO = '0'
yarn studio-server:ui:observe run-recordings-modal.spec.ts run-statistics-modal.spec.ts --workers=1 --grep "filters and paginates runs with the operator menu|deletes a run and opens replay|immediate count-free continuations|shows available cost estimates"
```

The selection was checked with Playwright `--list`: four existing cases in two
files. Verify that count at execution time. These mocked-transport journeys cover
browsing, search, deletion/replay and statistics UI compatibility; API tests cover
the actual handlers. No new browser suite or live cloud fixture is needed.

## Performance and fixture discipline

The primary protection is structural: unchanged execution and handler bodies,
one router, the same middleware and no new request-time wrapper, await, read,
serialization, logging or timer. Importing the new module must not open storage,
prepare a worker or introduce another resource owner. Existing dependencies
still initialize shared caches and read their configuration on import; preserve
that behavior rather than claiming imports have no side effects.

Use one small ignored before/after probe against the **compiled full API**.
Seed about 30 root recordings across two projects, with a few children and fixed
IDs, times and statistics periods. Preserve the stopped fixture and restore it
to the same absolute paths between sequential runs; stored metadata contains
absolute source paths, so blindly cloning to different roots is not equivalent.
Compare complete results, available existing counters and latency for catalog,
ordinary pages, statistics and request-ID search. A scanner's separate benchmark
HTTP wrapper does not measure these routes.

Keep this bounded: one cold process per version, then a warm run with 20 warmups
and 100 measured requests per chosen case. A cold search precedes catalog warming.
Follow continuations to compare ordered final results; budget-driven page splits
may differ. Normalize only documented timing/request IDs. Capture median/p95,
failures and the exact loaded source/build. If timing suggests a regression,
inspect it and allow one reversed-order comparison, not repeated favorable-sample
selection or a new benchmark framework.

After read measurements, run one deterministic endpoint workload using the same
sample counts, recording configuration and connection policy in both versions.
Validate outputs and all expected recordings; drain in bounded batches outside
individual request timings. Run it after browsing so appended recordings cannot
alter the fixed read corpus. This checks the user's execution-speed requirement
without a separate load-test matrix.

Dispose accepted work, workers, HTTP servers and storage before restoring/removing
the exact owned fixture roots, including on failure. No production data, paid model
calls or deployed services are needed. Measurements can catch a repeatable
regression; they do not prove identical latency for every production workload.

## Completion and stop conditions

Complete when the ownership split is in place, preserved contracts have evidence,
targeted checks pass, execution has no added work or repeatable regression, and
docs describe the result. Disclose skips and environment limits.

Stop if the move requires new router traversal, policy/validation changes,
settings capture changes, new resource owners or altered search/deletion/
execution behavior. Treat any independently discovered defect as a separate,
justified repair. Commit/push, image publication, cloud tests and deployment
require their own task; none follows automatically from this plan.

## Implementation and local evidence — 2026-11-14

The implementation follows the single-module boundary above. `index.ts` is now
811 lines and `recording-http.ts` is 253 lines (excluding the trailing empty
line). Combined production source grows by 22 lines for explicit imports and
registration; the benefit is clearer ownership, not fewer total lines.

One plan assumption needed correction during verification: package-name imports
work for shared **types**, but the shared package has no directly runnable `.js`
file for `WORKFLOW_RECORDING_INPUT_FILTER_OPERATORS`. A compiled API probe caught
that attempted import before release. The final implementation retains the
original relative runtime import and transfers its existing allowance to the
new file; the allowance count stays at 402. No package/build redesign was added.

Verification:

- Syntax-tree comparison: all 51 parent registration statements retain their
  order and handler bodies; ten move into the new function. All 40 existing
  declarations, including the six schemas, are identical. Hashes confirm that
  app mounting, execution, web-app HTTP, sessions, storage, persistence, input
  filtering/extraction and statistics source files are unchanged.
- Fresh source and compiled processes import the parent first and child first.
  Both orders retain seven parent exports, ten moved registrations, shared
  timing/parser identity and no storage owner created by import. Each probe
  imports its route first, before inspecting storage ownership.
- The 54-test recording/profile suite passes against the original handlers and
  the extracted handlers. Added coverage checks all four profiles, missing
  proxy/UI credentials, valid operator reads/deletion, invalid query/body
  behavior, and disconnect cleanup. The read test holds the actual input-cache
  boundary with two simultaneous searches. Disconnecting one aborts only its
  read; both accepted reads remain owned until they settle, and the connected
  caller still receives its genuine backend error. Listener cleanup is checked
  against the pre-route baseline, and completion uses the existing accepted-work
  drain rather than a timing delay. Its fixtures close recording storage before
  removing Windows directories.
- Twenty compiled full-app comparisons against the original router match:
  GET/HEAD, catalog aliases, trailing slashes, encoded IDs, replay artifacts and
  missing resources retain status, content, cache headers and timing-header
  presence.
- All 60 adjacent filtering, compiled-worker and statistics tests pass.
- The API build, production-target TypeScript, import-boundary/file-tree,
  test-style, test-manifest, documentation-link and whitespace checks pass.
- Four existing headless browser cases pass: filtering/pagination, count-free
  continuations, replay/deletion and statistics. They use the unchanged local
  frontend with mocked transports; HTTP suites and probes test real handlers.

### Compiled full-app measurements

An ignored probe restores the same stopped fixture at the same absolute paths:
30 roots and three children across two projects. Each case has 20 warmups and
100 measured requests. A cold search precedes catalog warming. One reversed-order
pair checks timing variation; it is not a production load test.

| Case              | Original median / p95 (ms) | Extracted median / p95 (ms) | Reversed original median / p95 | Reversed extracted median / p95 |
| ----------------- | -------------------------- | --------------------------- | ------------------------------ | ------------------------------- |
| Catalog           | 4.765 / 6.100              | 4.521 / 5.348               | 5.296 / 7.934                  | 4.491 / 5.386                   |
| Run page          | 1.427 / 1.612              | 1.352 / 1.644               | 1.348 / 1.570                  | 1.380 / 1.608                   |
| Statistics        | 1.330 / 1.551              | 1.328 / 1.548               | 1.434 / 1.695                  | 1.249 / 1.532                   |
| Request-ID search | 1.573 / 1.895              | 1.609 / 2.490               | 1.487 / 1.688                  | 1.543 / 1.761                   |
| Recorded endpoint | 3.043 / 12.905             | 2.877 / 13.243              | 2.622 / 11.636                 | 2.621 / 13.029                  |

Cold first-search timings were 244/276 ms, then 273/264 ms in the reversed pair.
All read-result hashes and ordered complete search IDs match. Every endpoint
response matched its expected output and all 120 endpoint recordings per run
persisted (153 recordings including the seed). No request-time wrapper, await,
storage read or serialization was added. Median endpoint timings are unchanged;
p95 varied by up to 1.4 ms, so these finite local samples do not establish exact
latency equality or a production tail-latency guarantee.

The ignored evidence directory is `artifacts/recording-http-refactor-20261114/`.
It contains the frozen original module, structural comparison, full-app probe,
fixture and test logs. No live managed-storage campaign, image publication,
cloud test or deployment was performed.

### Review conclusions

The cancellation test uses the real input-cache boundary, imports the router
after its fixture establishes the environment, and checks explicit error
messages. An isolated compiled-code mutation removing signal forwarding fails
the regression assertion. The final 54-test suite also passes against the
original router, so these tests characterize preserved behavior rather than a
new contract.

The adjacent recording HTTP/cache/worker suite passes all 75 tests. Review of
worker preparation/recovery, cancellation, backend delegation, error forwarding,
accepted-work retention and runtime packaging found no additional runtime
defect. The final route hashes still match the measured implementation; browser
and performance results remain applicable.

The benefit is a clearer HTTP ownership boundary with stronger regression
coverage. This refactor does not fix existing API error-policy differences or
prove live managed-storage performance. Neither requires a behavior change in
this extraction.

### Test maintenance

The four-profile matrix keeps recording GET/DELETE and malformed statistics POST
checks for missing credentials, proxy-only credentials and operator access. The
remaining shared validation cases run once on the control profile, and assertions
check public responses rather than counting console messages.

Browsing, statistics, replay-upload and deletion cases use the existing control
API harness without starting execution routes or WebSocket services. A small
fixture helper persists ordered recordings for pagination, deletion and
cancellation. Pagination verifies both pages and includes failed/suspicious runs;
deletion verifies its response as well as index/artifact removal. Separate
end-to-end cases still execute published/latest workflows, including exhausted
profiles, and verify their resulting recordings. No execution-coverage test was
removed and no production test hook was added.

The same 54 focused tests pass before and after this cleanup, including against
the frozen original handlers. TypeScript, test-style, manifest, file-tree and
documentation-link checks pass. Local pagination and single-deletion cases
decreased from about 244/307 ms to 127/205 ms; the complete two-file suite remains
about 25 seconds. These are sample timings, not a CI speed guarantee.
