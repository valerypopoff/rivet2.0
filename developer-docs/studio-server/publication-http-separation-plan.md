# Publication and version-history HTTP separation

Status: implemented and locally verified on 2026-11-14 against `develop` commit
`2ae74a1f17678184b614573d08f755a55193708f`. The preceding
[recording HTTP extraction](recording-http-separation-plan.md) is committed.
The scope and local verification below are complete. Image publication and
deployment remain separate release steps.

## Goal and scope

Give project publication and saved-version HTTP handling one clear owner without
changing functionality, stored data or execution speed. Before this extraction,
`packages/studio-server-api/src/routes/workflows/index.ts` was 811 lines and mixed
these handlers with project mutations, reference checks and other control routes.

Move 13 route registrations and their publication-specific validation into one
new `routes/workflows/publication-http.ts`. This is an HTTP ownership change;
`publication-policy.ts`, `publication-command.ts`, `storage-backend.ts` and the
existing storage adapters retain their responsibilities. Do not redesign the
publication service, unify storage implementations or standardize error responses.
The expected benefit is easier maintenance, not a guaranteed net line reduction.

All source paths below are relative to `packages/studio-server-api/src/` unless
the repository root is stated explicitly.

Expected product changes are limited to `routes/workflows/index.ts`, the new
`publication-http.ts` and the transferred import allowance. Existing test files
and developer docs may change. No dependency, package entry point, build-script,
database, frontend or storage-service changes are prerequisites.

## Verified route inventory

Paths remain under `/api/workflows`.

| Method | Path                                    | Existing responsibility to preserve                                                    |
| ------ | --------------------------------------- | -------------------------------------------------------------------------------------- |
| GET    | `/projects/published-versions`          | List saved version history.                                                            |
| POST   | `/projects/published-versions/download` | Send the exact saved project text with attachment headers.                             |
| POST   | `/projects/published-versions/preview`  | Return the saved project/dataset preview.                                              |
| PATCH  | `/projects/published-versions/star`     | Update one version and return `{ version }`.                                           |
| PATCH  | `/projects/published-versions/comment`  | Update one comment and return `{ version }`.                                           |
| POST   | `/projects/published-versions/restore`  | Dispatch `restore-version`, notify the tree after success, return the existing result. |
| GET    | `/projects/web-apps`                    | List web-app publication state.                                                        |
| POST   | `/projects/web-apps/publish`            | Dispatch `publish-web-apps`, notify, return `{ project }`.                             |
| PATCH  | `/projects/web-apps/access`             | Dispatch `set-web-app-access`, notify, return `{ project }`.                           |
| POST   | `/projects/web-apps/unpublish`          | Dispatch `unpublish-web-app`, notify, return `{ project }`.                            |
| POST   | `/projects/publish`                     | Dispatch `publish-endpoint`, notify, return `{ project }`.                             |
| POST   | `/projects/unpublish`                   | Dispatch `unpublish-endpoint`, notify, return `{ project }`.                           |
| POST   | `/projects/endpoint-access`             | Dispatch `set-endpoint-access`, notify, return `{ project }`.                          |

These are **two blocks**, not one contiguous block:

1. Six history registrations follow `/projects/download` and precede GET
   `/projects/references`.
2. Seven web-app/publication registrations follow POST `/projects/references`
   and precede DELETE `/projects`.

The reference routes between the blocks stay where they are. General project
download, duplicate/upload/create/rename/delete, graph-reference validation,
tree streaming, recording routes and compatibility exports stay in the parent.

## Implementation shape

Use two small startup registration functions in the same new module:

```ts
export function registerWorkflowPublishedVersionHttpRoutes(router: Router, jsonBody: RequestHandler): void;

export function registerWorkflowPublicationHttpRoutes(router: Router, jsonBody: RequestHandler): void;
```

Replace each original block with its corresponding call at the same location.
Both receive the **existing parent JSON parser instance**. Register directly on
the existing router: no extra `Router()`, `use()` layer, dynamic imports, generic
route table, per-request wrapper or dependency container.

Move these 13 publication-owned schemas into the new module at module scope:

- `publicationPreconditionsSchema`, `draftPublicationPreconditionsSchema`;
- `publishProjectSchema`, `endpointAccessSchema`, `publicationPathSchema`;
- `publishProjectWebAppsSchema`, `updateProjectWebAppAccessSchema`,
  `unpublishProjectWebAppSchema`;
- `publishedVersionsQuerySchema`, `publishedVersionDownloadSchema`,
  `publishedVersionRestoreSchema`, `publishedVersionStarSchema`,
  `publishedVersionCommentSchema`.

The parent still needs `workflowPathSchema` and `pathOnlySchema` for unrelated
project operations. Keep those private parent schemas. Use identical private
schema adapters in the new module, calling the existing
`normalizeWorkflowRelativePath(value, { allowProjectFile: true })`; do not copy
the normalization algorithm. This small adapter duplication avoids a third
module, a dependency on the parent, or a schema factory/registration framework.
Both copies must preserve the same parsing behavior. The publication schemas
themselves move unchanged, including their `.extend()` relationships.
In particular, do not substitute `z.string()` for the path's `z.unknown().transform()`:
the existing normalizer throws its own public error, and validation order matters.

Import backend functions, `notifyWorkflowTreeChanged`, download-header helper,
Zod and Express types directly from their existing modules. Do not import
`index.ts` or `execution.ts` into the new module. Move the existing relative
runtime import of `WORKFLOW_PUBLISHED_VERSION_COMMENT_MAX_LENGTH` and its
`scripts/checks/import-boundary-debt.json` allowance from the parent to the new
file. Do not add net import debt or replace it with an unverified package-name
`.js` import: compiled shared-package resolution caught that mistake during the
previous refactor.

## Behavior and lifecycle invariants

- Control/combined expose these routes behind the app's existing operator-auth
  and request-work middleware. Execution/evaluation do not gain them. Preserve
  authentication before body parsing, cache headers, GET/HEAD behavior and error
  handling in the full app, not just the lightweight fixture server.
- Retain parser size/timeout behavior and reuse its exact instance. Keep every
  schema's coercion, trimming, strictness, optional/default fields and field order.
  GET `.parse()` and POST/PATCH `validateBody()` have different error paths;
  preserve their actual status/message, including errors thrown by path transforms.
- Preserve project ID, publication version and required draft-revision checks.
  Endpoint/web-app publication and restore require a reviewed draft; policy-only
  access/unpublish operations keep their current rules. The legacy
  `settings.expectedRevisionId` field remains accepted only when it agrees with
  `preconditions.expectedDraftRevisionId`.
- Pass the same command and payload to the same backend once. Do not pre-read
  state, reacquire a writer, clone/reinterpret command data, or add automatic
  retries. Existing code owns capture of reviewed state and transactional checks.
- Notify the existing tree notifier at the same point after successful commands,
  with the original request so source-client identity is preserved. Do not add
  notifications to history reads, downloads, star/comment changes, or failed
  commands that did not previously notify. This concerns the HTTP notification;
  do not suppress separate adapter-owned invalidations or promise a single global
  event across multiple managed servers.
- Preserve exact response envelopes and download bytes, content type, filename
  escaping and status. Restore returns its existing result, not `{ project }`.
- Keep endpoint/slug uniqueness, batch slug swaps, OAuth access, dataset snapshots,
  cache invalidation, revision generation, locking, rollback and stored history
  unchanged in their existing owners.
- Keep the same shared notifier and storage instances. Existing dependencies may
  initialize shared objects/configuration on import; the extraction must not add
  a storage owner, timer, worker, connection or request-time initialization.
- Published/latest execution, web-app HTTP and WebSocket serving, recordings and
  shutdown admission are outside this change. Their production sources must
  remain unchanged; no additional execution-time await, lookup or serialization.

## Ordered work and validation

### 1. Capture the baseline and fill only demonstrated coverage gaps

Confirm the checkout/branch and complete diff. Use supported Node 24 and the
repository's pinned Yarn. Save the original parent module and hashes of execution,
publication-policy/command, backend, notifier, parser and path-normalizer files
under an ignored `artifacts/` folder. After adding the missing tests below, build
and run the five focused suites once against the unchanged production source:

```sh
yarn workspace @valerypopoff/rivet-studio-server-api build
yarn workspace @valerypopoff/rivet-studio-server-api test:files src/tests/workflow-publication-filesystem.test.ts src/tests/workflow-published-history-filesystem.test.ts src/tests/workflow-web-apps-filesystem.test.ts src/tests/workflow-execution-filesystem.test.ts src/tests/api-profile.test.ts
```

Existing publication tests cover missing/stale reviewed state, conflicting
legacy revision fields, commit versus rollback notifications and public/latest
execution. Web-app tests cover independent publication, access updates, slug
swaps and publication-dependent serving. The execution suite owns the existing
HTTP endpoint-access regression; include it rather than duplicating that journey.
Keep those behavioral tests.

Two gaps require explicit attention:

1. The history suite primarily calls the backend directly; local-upgrade tests
   exercise list/download, and a publication test rejects restore without a draft
   token. That is not successful coverage of all six extracted history routes.
   Extend the existing saved-version journey to use **HTTP** for list, download,
   preview, star, comment and restore while retaining its storage assertions.
   Assert exact download/preview contents, attachment headers, `{ version }`
   responses and restore's `{ project, version }` result. Include missing-version,
   invalid-star/oversized-comment and stale-restore rejection without changing
   data or the tree revision; a deliberately refreshed restore must succeed.
   Do not create a second elaborate multi-version fixture or route success through
   both HTTP and the direct backend just to assert it twice.
2. The generic profile tests do not characterize this extracted group. Add small
   full-app cases for history read/restore and endpoint/web-app publication:
   missing credentials, proxy-only credentials with UI auth enabled and a valid
   operator session. Authorized invalid requests must reach route validation on
   control/combined and stay 404 on execution/evaluation, so a missing resource
   cannot be mistaken for an unmounted route. Keep successful writes in the
   publication/history fixtures, rather than provision projects in every profile.
   Check GET validation versus malformed/invalid JSON bodies, normalized paths
   versus traversal, and unsupported methods with a compact table on one exposed
   profile. Preserve observed status and message; a JSON-shape check alone is weak.
   Keep its expected responses independent of the schema/parser being tested.
   In these two GET routes, a missing/non-string `relativePath` reaches the
   existing normalizer and throws public 400 (`Missing relativePath`); traversal
   throws public 400 (`Invalid relativePath`). Preserve that behavior rather
   than copying the invalid-query 500 expectation from the recording refactor.

Prove any new characterization tests against the original parent first. Tests
of stale state must send explicitly captured tokens through raw HTTP; fixture
helpers that automatically fetch a fresh baseline would hide that failure.
Initialize disposable storage before serving and close HTTP, recording storage
and workflow owners before deleting their roots. Do not introduce public test hooks.
The lightweight workflow API harness does not mount operator authentication or
the general API error handler; only full-app checks establish those contracts.
Keep the existing successful/failed publication tree-notification test; use the
history fixture's tree revision to check that annotation-only updates remain quiet
and successful restore still notifies. The existing tree-stream suite already
checks source-client propagation; do not rebuild that SSE harness here.

Preserve this baseline compiled output before the extraction build replaces it.
Store recorded method/path order and results alongside it. On Windows, external
Node loaders need an absolute file URL: Yarn changes cwd for workspace commands.

### 2. Extract and check the actual compiled graph

Make the move described above, remove only unused parent imports/declarations,
and build the API. Compare parsed registration statements after expanding the
two registration calls: all original registrations, middleware and handler bodies
must appear in the same order. Permit only the two identical private path-schema
adapters as intentional duplication; publication schemas remain equivalent.
Include the existing recording registration and reference routes in the runtime
order check, not just the two new blocks.

In fresh processes import the parent first and new module first, in both source
and compiled mode. Inspect the actual router: six history plus seven publication
registrations appear exactly once, on the same router, with the original parser.
Parent exports remain intact. Import the route before checking storage ownership,
rather than accidentally preloading its dependencies in the probe.
Compare the same complete registration sequence, including inherited GET/HEAD
and trailing-slash behavior. These must not be inferred solely from matching
the 13 path strings. The two GET endpoints can be checked through the existing
fixture without adding another browser scenario.

Use ignored one-off verification scripts for this extraction comparison. Do not
add permanent source-text assertions or a new architecture-testing framework.

### 3. Run the final behavior checks

Run the five focused suites above, then these small adjacent contracts:

```sh
yarn workspace @valerypopoff/rivet-studio-server-api test:files src/tests/workflow-publication-policy.test.ts src/tests/workflow-contracts.test.ts src/tests/workflow-filesystem-tree.test.ts src/tests/vm-migration-maintenance.test.ts
yarn workspace @valerypopoff/rivet-studio-server-api exec tsc -p tsconfig.runtime.json --noEmit
yarn check:file-tree
yarn studio-server:verify:test-style
yarn node scripts/checks/check-test-style.mjs
yarn node scripts/checks/check-doc-links.mjs
git diff --check
```

Ensure changed/new tests are in the existing API manifest. Run the root style
gate during commit preparation as required by the local CI checklist; if it
rebuilds workspace assets, finish it before dependent builds/typechecks.
Do not rerun checks for unchanged inputs without a reason.
This route-only change does not require rerunning every storage-adapter integration
or a live PostgreSQL/S3 campaign. If a backend or policy file must change, reassess
that scope and its storage-mode coverage explicitly.

Run four existing headless project-settings journeys. Their names were verified
with Playwright `--list` on this baseline:

```powershell
$env:PLAYWRIGHT_HEADLESS = '1'
$env:PLAYWRIGHT_SLOW_MO = '0'
# Set PLAYWRIGHT_BASE_URL to the isolated local frontend when needed.
yarn studio-server:ui:observe project-settings-modal.spec.ts --workers=1 --grep "stale publishing requires explicit review before retry|changes endpoint access immediately even with unpublished graph changes|publishes and unpublishes multiple web apps from project settings|published version history paginates, stars, previews, and restores versions"
```

Use an existing verified browser executable if available. These journeys use
mocked transports; report them as UI compatibility coverage, not proof of the
real publication handlers. The API suites provide the latter. Inspect failure
artifacts under `artifacts/playwright/` rather than loosening assertions.
Use the same compiled local frontend before/after if its source and dependencies
are unchanged; no extra frontend rebuild or new browser scenario is required.

### 4. Verify no execution overhead was introduced

Structural equivalence and unchanged execution-source hashes are the primary
checks. Both new registration calls run during startup, not per request.

Reuse the previous extraction's ignored full-app measurement and cleanup approach;
do not copy its hard-coded recording counts or unrelated search setup. One project
with two saved versions and a deterministic endpoint is sufficient. Snapshot this
prepared fixture after its owners close. Run original and candidate sequentially
at the same absolute paths: version-history listing followed by endpoint calls,
10 warmups and 50 samples per case. Keep auth, recording policy, connection policy
and order identical, with retention high enough for all fixture and measured runs.
Count timings through complete response consumption, verify output and every
expected recording, then drain and dispose owners before restoring the fixture.
Capture measurements before and after extraction in the same local session;
old benchmark numbers alone are not a baseline. Do not benchmark repeated
publication mutations or create another benchmark framework.

If timing suggests a regression, inspect the changed path and allow one reversed
comparison to distinguish order/warmup effects. A repeatable slowdown must be
resolved before completion; finite samples cannot promise identical production
latency. Do not claim a runtime speedup from this organizational change.

### 5. Document the completed result

Update `workflow-publication.md`, `architecture.md`, `access-and-routing.md`,
`refactor-history.md` and this plan with actual ownership, tests, measurements
and limitations. Keep planned work separate from completed results. Add to the
Git-ignored CI notes only if a new repeatable failure yields an actionable check.

## Completion and stop conditions

Complete when all 13 routes have one module owner, original route order and
schemas are preserved, parent exports and parser identity remain intact,
targeted API/browser/build checks pass, and execution has no added work or
repeatable slowdown. Record real results rather than marking work complete from
file movement alone.

Stop and reassess if extraction requires changes to storage transactions,
publication policy, schema, authentication, execution lifecycle or public API
behavior. Fix independently confirmed defects separately and explain any scope
expansion. A live database campaign, Kubernetes rehearsal, image build, deployment,
version bump, commit or push is not part of implementing this plan unless requested.

## Implementation and local evidence — 2026-11-14

All five steps are complete. `publication-http.ts` contains the thirteen
registrations, thirteen publication schemas and two private path adapters.
`index.ts` retains general project operations, references, recording registration
and its compatibility exports. Its size falls from 811 to 532 lines; the new
module is 308 lines. Combined production source grows by 29 lines for explicit
imports, registration functions and the two adapters. The improvement is clearer
ownership, not fewer total lines.

The syntax-tree comparison verifies unchanged registration statements and handler
bodies after expanding both calls, unchanged existing declarations and exactly
the two intended duplicate path adapters. Eleven baseline hashes confirm that
app mounts, execution/session code, recording routes, publication policy/command,
backend, notifier, parser and path normalizer were not changed. The relative
runtime-import allowance moved to the new module; total import debt stays at 402.

Fresh source and compiled processes, with both parent-first and child-first
imports, confirm thirteen routes in the original positions, shared parser
identity, seven preserved parent exports and no new storage owner on import.

Validation before the final test simplification:

- The five focused API suites pass all 115 tests against the original handlers
  and after extraction. The added history test exercises all six real HTTP routes,
  exact project/dataset contents, attachment headers, response envelopes, rejected
  annotations and stale restore, followed by successful reviewed restoration.
  It also checks GET/HEAD/trailing-slash behavior and tree revision changes.
- The four profile cases prove authentication precedes malformed body parsing,
  authorized requests reach validation on control/combined, and the routes remain
  absent on execution/evaluation. Missing paths retain their existing 400 errors.
- All 61 adjacent policy, path-contract, workflow-tree and maintenance tests pass.
- The API build, runtime-target TypeScript, import/file-tree, test-style and
  test-manifest checks pass. Documentation links and whitespace are checked at
  completion.
- Four existing headless project-settings cases pass in 27.6 seconds: stale
  publication review, endpoint access, multi-app publication and version history.
  Their transports are mocked; the API suites above verify real handlers.

The compiled full-app probe uses one stopped fixture with two saved versions,
10 warmups and 50 measured requests per case. Both runs consume complete responses
and verify every expected recording. A reversed pair checks timing variation.

| Case     | Original median / p95 (ms) | Extracted median / p95 (ms) | Reversed original median / p95 | Reversed extracted median / p95 |
| -------- | -------------------------- | --------------------------- | ------------------------------ | ------------------------------- |
| History  | 3.630 / 4.170              | 4.027 / 4.549               | 5.271 / 7.419                  | 3.346 / 4.231                   |
| Endpoint | 2.552 / 10.546             | 2.294 / 9.873               | 2.577 / 12.119                 | 2.419 / 10.538                  |

History and endpoint output hashes match across all four runs; endpoint hashes
exclude only the existing variable `durationMs` field, which is still validated.
Every run persisted all 60 expected recordings. The initial history difference
did not repeat in reversed order. No request-time wrapper, lookup, serialization
or await was added. These bounded local samples support no detected regression;
they do not establish an execution speedup or a production latency guarantee.

Ignored evidence is under `artifacts/publication-http-refactor-20261114/`.
No cloud test, deployment, schema change or application version bump was made.

### Adjacent download-header correction

A separate browser probe reproduced a pre-existing bug in the shared attachment
encoder: `café's draft.rivet-project` downloaded as `caf_'s draft.rivet-project`
because `encodeURIComponent` leaves apostrophes literal, invalidating the UTF-8
filename parameter. The encoder now percent-encodes the additional RFC 5987
characters (`'()*`) while preserving the existing ASCII fallback. Ordinary
project downloads and saved-version downloads use the same correction.

This is a narrow behavior fix alongside the completed extraction, not a change
to publication policy, stored data or workflow execution. The contract and HTTP
fixtures cover Unicode and punctuation together. The headless Chromium probe
now preserves all three tested filenames, and the four existing project-settings
Playwright cases passed again (27.5 seconds). All nine affected API suites passed
together: 177 tests before the test simplification below.

### Test simplification

Recording and publication exposure checks share one full-app fixture per runtime
profile. This removes four server/storage setup cycles while preserving every
authentication, routing, malformed-body and path-validation case. The existing
HTTP history journey now uses non-UTF-8 dataset bytes and checks both the restored
draft and newly published snapshot byte-for-byte; the separate restore fixture
is no longer needed. Filename encoding assertions live with the existing project
download test, keeping the small contract suite free of the download module's
larger dependency graph.

The focused recheck passes 88 tests with six fewer top-level cases and unchanged
behavioral coverage. The final five history tests also pass after replacing
repetitive field assertions with complete history comparisons. Separate
corruption, legacy metadata, foreign snapshot and transaction rollback tests
remain because they exercise different failure paths. The history fixture
changes parsed metadata and asserts that the revisions differ, avoiding silent
no-op serialized-text replacements. Reads after unpublish use HTTP as well.

### Final checks and limits

The original-handler comparison still passes against the exact parent from the
base commit, and all eleven protected source hashes are unchanged. Runtime
TypeScript, the full API build including test sources, both test-style guards,
the API manifest, import boundaries and documentation links pass. The full root
`test:style` gate passed during commit preparation. No further runtime change was
justified by review.

The benefit is narrower ownership and stronger HTTP regression coverage. The
extraction adds 29 production lines rather than reducing total code; its two
small private path adapters reuse the existing normalizer. The download
correction adds work only when generating attachment headers. No execution-time
lookup, allocation, await or service ownership was introduced. Test cleanup does
not change the runtime paths covered by the browser and timing evidence above.
These are local results; remote CI, image qualification and deployment remain
separate release checks.
