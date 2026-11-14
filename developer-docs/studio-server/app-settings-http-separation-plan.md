# App Settings migration and upgrade HTTP separation

Status: implemented and locally validated on 2026-11-14, based on `develop`
commit `16c2ef0b2`. The plan below records the preservation contract; the final
implementation and validation record follows it. No cloud operation or deployment
was performed.

## Goal and scope

Separate local-storage upgrade and VM-to-managed migration HTTP handling from
ordinary App Settings. Preserve every current route, response, authorization
decision, body limit, side effect and execution path.

The original `packages/studio-server-api/src/routes/app-settings.ts` was 632 lines.
It combined ordinary settings registration and session information with 16 local
upgrade routes and 10 VM migration routes. The underlying operations already
belong to `local-metadata/operator-service.ts` and `vm-migration-service.ts`.
Keep those service boundaries; this is an HTTP extraction, not a redesign of
migration, backup, settings storage or server lifecycle.

The intended production diff is limited to:

- `packages/studio-server-api/src/routes/app-settings.ts`;
- new `packages/studio-server-api/src/routes/local-upgrade-http.ts`;
- new `packages/studio-server-api/src/routes/vm-migration-http.ts`;
- transferring the existing runtime-import allowance in
  `scripts/checks/import-boundary-debt.json` if required by its new owner.

The final diff also adds one explicit test-helper import allowance for the
existing `AcceptedWork` implementation. The shared package has no public runtime
entrypoint for this class. Tests reuse the actual implementation rather than
copying it or changing production exports for a refactor test.

Tests and developer docs may change. No new dependency, public API, schema,
configuration variable, worker, service, deployment or version bump is needed.
Clearer ownership is the benefit; do not promise a net line reduction or speedup.

## Exact ownership and registration order

The parent keeps `appSettingsRouter`, its existing compatibility exports, all
three body-parser instances, ordinary settings registration, server UI session
handling and trusted-client request information.

Preserve this effective order on the **same router**:

1. `use('/vm-migration', requireVmMigrationOperatorAuth)` remains in the parent
   before any route registration, including unknown VM-migration paths.
2. Existing `GET /server-ui-session` remains in the parent.
3. Register local-upgrade routes at the location of the original local block.
   Inside that registration, `GET /local-upgrade/setup` and
   `POST /local-upgrade/prepare` keep their explicit setup authorization. The
   prefix `requireLocalUpgradeOperatorAuth` follows those two routes, before all
   remaining local-upgrade handlers and unknown local-upgrade paths.
4. Register VM-migration handlers at the original VM handler location, after the
   local block. Their early prefix guard from step 1 remains authoritative.
5. Existing `GET /trusted-clients/current-request` and ordinary settings follow.

Do not merge, rename or replace authorization functions because they currently
alias the same implementation. Keep their distinct responsibilities visible.
Keep the VM guard at its original position rather than rearranging middleware
as part of the extraction. Its relative order is a preservation requirement;
do not claim that every alternative ordering necessarily changes a response.

Use two direct startup registration functions:

```ts
export function registerLocalUpgradeHttpRoutes(
  router: Router,
  parsers: {
    migrationJsonBody: RequestHandler;
    localPreparationJsonBody: RequestHandler;
  },
): void;

export function registerVmMigrationHttpRoutes(router: Router, migrationJsonBody: RequestHandler): void;
```

These register full existing paths on the provided router. They create no nested
router or request-time wrapper and install no independent lifecycle owner. Do
not add a generic route table, dependency container, service facade or options
framework. The VM registration is not a separately mountable, independently
authenticated router; document its required parent guard.

### Local-upgrade routes

All paths remain relative to `/api/app-settings`. `small` means the existing
shared 16 KiB parser; `preparation` means the existing 1 MiB parser; a dash means
no route body parser, not an empty-body validator.

| Method | Path                               | Body parser | Existing result             |
| ------ | ---------------------------------- | ----------- | --------------------------- |
| GET    | `/local-upgrade/setup`             | —           | Setup capabilities          |
| POST   | `/local-upgrade/prepare`           | small       | 202, `{ restarting: true }` |
| POST   | `/local-upgrade/restart`           | small       | 202, `{ restarting: true }` |
| GET    | `/local-upgrade`                   | —           | Current upgrade status      |
| GET    | `/local-upgrade/project-reference` | —           | Read-only reference lookup  |
| GET    | `/local-upgrade/inventory`         | —           | Source inspection           |
| POST   | `/local-upgrade/preparation`       | preparation | 202, preparation result     |
| GET    | `/local-upgrade/repair/download`   | —           | Stream repair archive       |
| GET    | `/local-upgrade/fingerprint`       | —           | `{ sourceFingerprint }`     |
| GET    | `/local-upgrade/report`            | —           | Upgrade report              |
| POST   | `/local-upgrade/pause`             | small       | 204                         |
| POST   | `/local-upgrade/backup`            | small       | 202, `{ started: true }`    |
| GET    | `/local-upgrade/backup/key`        | —           | Existing key attachment     |
| GET    | `/local-upgrade/backup/download`   | —           | Stream verified archive     |
| POST   | `/local-upgrade/copy`              | small       | 202, `{ started: true }`    |
| POST   | `/local-upgrade/action`            | small       | 204                         |

Move local-upgrade-only imports and private `assertBackupDownloadRequest` with
these handlers. Leave inline Zod parsing in place; extracting schemas is not a
prerequisite. Transfer the relative runtime import of
`LOCAL_UPGRADE_PREPARATION_KINDS` without increasing import debt. Do not replace
it with an unverified package deep import. Keep the existing
`duplicateRepairChoicesSchema` owner.

### VM-migration routes

| Method | Path                                | Body parser | Existing result                |
| ------ | ----------------------------------- | ----------- | ------------------------------ |
| GET    | `/vm-migration`                     | —           | Current migration status       |
| GET    | `/vm-migration/inventory`           | —           | Source inventory               |
| POST   | `/vm-migration/test-database`       | small       | `{ ok: true }` or existing 400 |
| POST   | `/vm-migration/test-object-storage` | small       | `{ ok: true }` or existing 400 |
| POST   | `/vm-migration/maintenance`         | —           | Enter-maintenance result       |
| DELETE | `/vm-migration/maintenance`         | small       | `{ restartRequired: true }`    |
| POST   | `/vm-migration/recover`             | small       | Current migration status       |
| POST   | `/vm-migration/precopy`             | small       | 202, precopy result            |
| POST   | `/vm-migration/run`                 | small       | 202, migration result          |
| POST   | `/vm-migration/deployment-review`   | small       | 202, review result             |

Move the four VM schemas unchanged: `migrationTargetSchema`,
`migrationDatabaseSchema`, `migrationObjectStorageSchema` and
`migrationDeploymentReviewSchema`. Move only their service imports. The schema
`pick()` relationships, field order and strictness remain as written.

## Invariants and specific risks

- Full-app operator authorization remains outside the router. Migration routes
  retain the additional signed-in-operator and request-intent checks. Trusted
  client access or a proxy credential alone must not acquire migration authority.
  Preserve outer CORS/preflight and maintenance handling as well; do not assume
  every HTTP method reaches this router's guard.
- Preserve key, OAuth and no-UI-auth behavior. The current sensitive guard treats
  every method other than GET, including HEAD, as requiring migration intent;
  do not silently normalize that during extraction.
- Preserve the exact parent parser instances and middleware order. The 16 KiB
  parser is shared by both features. Ordinary settings keep their existing
  100 MiB parser and remain outside the sensitive migration guards.
- Preserve validation/error boundaries. These handlers parse Zod inside
  `asyncHandler`; changing to `validateBody` can change status and public error
  messages. Database/S3 test routes deliberately translate both validation and
  service failures inside their current `try/catch`; leave that behavior intact.
- Do not add a parser to `POST /vm-migration/maintenance`, require fields on the
  pause route, or tighten the current `/recover` boolean check. Retain DELETE
  maintenance's conditional JSON target parsing. Those are behavior changes.
- Preserve all cache and attachment headers, 200/202/204 statuses and response
  envelopes. Backup and repair use `res.download`, not buffered reads or JSON.
  Keep `assertBackupDownloadRequest`, actual Host/Origin comparison and fetch-site
  policy before reading archives or key material.
- Keep failed/canceled download handling: an error after headers destroys the
  response and settles the handler; it must not attempt to send a second JSON
  response. Keep work retained until the original callback settles.
- Keep calls to migration/preparation services exactly once. No retries or
  automatic resumption. Do not reinterpret an uncertain response as a failed
  mutation or update a journal from HTTP error handling.
- Settings ETags, `If-Match`, PUT/PATCH registration, normalization and
  `afterWrite` reload behavior remain untouched. Preserve the four existing
  settings-function re-exports from `app-settings.ts`.
- Keep imports acyclic: the new modules never import `app-settings.ts` or
  `server.ts`. Existing service imports may initialize shared configuration;
  both operation services also retain module-level job state. Import those same
  modules, without copying state, creating another instance or changing their
  file identity. Extraction must not create another store, timer, worker or
  connection. Do not add lazy imports to disguise an initialization problem.
- App mounts, maintenance allowlists, server startup/shutdown, execution,
  recording and migration/backup implementations remain unchanged. No new
  per-execution await, allocation, lookup or middleware is allowed.

## Implementation and verification sequence

### 1. Capture the original behavior

Confirm the target checkout and full diff. Use the repository-pinned Yarn and
Node 24. Read this plan, `local-metadata-upgrade.md`, `vm-to-managed-migration.md`
and the optional `ci-pre-push.local.md`.

Save the original TypeScript and matching compiled parent plus its import/export
and route sequence under an ignored `artifacts/` directory. Record the three
parser identities and their call sites, including ordinary settings. Review the
final diff to ensure app mounts, auth, parsing, lifecycle, operation services and
workflow execution remain untouched; do not build a second file-hashing system.

Run the existing baseline suites before extraction:

```sh
yarn workspace @valerypopoff/rivet-studio-server-api build
yarn workspace @valerypopoff/rivet-studio-server-api test:files src/tests/app-settings.test.ts src/tests/ui-auth.test.ts src/tests/api-profile.test.ts src/tests/vm-migration-maintenance.test.ts
```

The UI-auth fixture installs `express.json()` before authorization. It establishes
session policy but **cannot prove authorization-before-body-parsing**. Extend the
existing full-app profile cases for that gap; do not duplicate the global fixture.

Add only missing behavioral checks and prove new assertions against the original
router before moving it. Reuse profile/auth fixtures, with every storage/control
root confined to temporary directories and local restart/health hooks disabled.
The original profile fixture did not clear every local-upgrade launcher variable;
the implementation makes this isolation explicit instead of inheriting the
developer's installation.

| Contract                      | Smallest useful check                                                                                                                                                                                                                                     |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Profile exposure              | Control/combined expose setup and the three safe POST probes below; execution/evaluation return their existing absent-route response.                                                                                                                     |
| Guard placement               | Exercise setup's explicit guard, the local prefix guard and the VM prefix guard with missing session/intent, cross-site and invalid/mismatched Origin. Reuse existing key/OAuth/none policy coverage rather than multiplying every case by every profile. |
| Authentication before parsing | Send malformed JSON without the required credentials/intent: receive the original authorization response, not a parser response. With valid authorization, the same invalid JSON reaches the parser.                                                      |
| Parser assignment             | Use `/local-upgrade/prepare` and `/local-upgrade/preparation` for the 16 KiB and 1 MiB boundaries; a small invalid POST to `/vm-migration/run` plus parser-identity comparison proves VM sharing.                                                         |
| Prefix/method behavior        | One unknown path under each prefix and representative unsupported method/HEAD checks preserve observed status, headers and body behavior. HEAD has no response body; outer OPTIONS handling must remain unchanged.                                        |
| Ordinary settings             | One settings read/write remains usable without migration intent; existing settings tests cover ETags, partial updates, redaction and reload behavior.                                                                                                     |

For each limit, send ASCII JSON `null` padded with spaces to exactly the limit
and one byte over it. The current parser uses `strict: false`, so `null` parses
and then fails the handler's object schema before any operation starts. Require
the original validation result at the limit and 413 above it; do not mistake a
syntax error for a size-limit test. There is no need for a third size matrix on
VM routes or a 100 MiB settings allocation. Reuse existing admission tests for
Content-Length, encoding, timeouts and generic reservation cleanup.

Derive exact expected parser/validation responses from the original full app.
Zod failures currently reach the storage-specific 500 error policy, whereas the
two VM connection-test routes catch validation/service errors and return their
fixed 400 responses. Keep those catches unchanged and cover each with invalid
input that cannot reach a database or object store. Never send a valid operation
request from these profile probes. Setup before provisioning and real operations
in a provisioned, isolated installation are covered by the runtime cases below.
Add the download failure assertions described in step 3 at this stage too, and
run the changed runtime cases against the original router before extraction.
The remaining unchanged runtime cases need only run against the final revision.

### 2. Perform the extraction

Create the two registration modules, move unchanged handler bodies and their
private definitions/imports, then replace the two original handler blocks with
registration calls. Leave the early VM prefix guard in the parent. Pass the
existing parser instances; remove only genuinely unused imports, including
`NextFunction` if still unused.

Use one temporary syntax-tree comparison to expand the calls and verify identical
registration statements, middleware, handler bodies and schema declarations.
Compare type-only imports as type-only and verify parent exports and untouched
settings registrations. Keep its report under ignored `artifacts/`; it is an
extraction check, not a permanent source-layout test.

Build once after the final source change. In fresh processes, smoke-test the
compiled parent with parent-first and child-first imports: the parent still
registers each of the 26 routes once on its exported router, with the original
guards and parser references. Importing a child must not register routes by
itself. Preserve the original module-level service state; compare initialization
with the baseline instead of asserting that the existing application has zero
resource owners. The current local import graph has no path from either service
back to `app-settings.ts`; keep it that way.

Do not add permanent source-text tests or a route-testing framework for this move.

### 3. Validate the actual operation paths locally

Run the baseline suites and new checks against that compiled revision. Reuse
these four isolated runtime cases for real setup, preparation, archives and repair:

```powershell
$previousRuntime = $env:RIVET_API_TEST_RUNTIME
$previousShard = $env:RIVET_API_RUNTIME_SHARD
try {
  $env:RIVET_API_TEST_RUNTIME = 'prebuilt'
  Remove-Item Env:RIVET_API_RUNTIME_SHARD -ErrorAction SilentlyContinue
  yarn workspace @valerypopoff/rivet-studio-server-api test:files --test-name-pattern '^isolated local upgrade runtime scenarios (operator setup status.*|background preparation accepts.*|authenticated browser backup.*|guided duplicate identity repair.*)$' src/tests/local-upgrade-runtime.test.ts
  if ($LASTEXITCODE -ne 0) { throw 'Selected local-upgrade runtime checks failed.' }
} finally {
  $env:RIVET_API_TEST_RUNTIME = $previousRuntime
  $env:RIVET_API_RUNTIME_SHARD = $previousShard
}
```

The existing helper owns disposable roots and launches separate processes;
never point it at live local data. Confirm all four selected cases actually
executed. Node matches the full suite-plus-test name, so an
incorrect filter or an all-skipped run is not evidence. Use prebuilt mode only
with the matching current compiled output; do not guess a child entrypoint.

The backup case already verifies a real downloaded archive's hash, source
preservation, key response and unsafe-origin rejection. The repair case covers
its distinct download path. Neither baseline case proved the HTTP callback failure
branches. Add focused pre-header error and post-header failure checks for both
download handlers, reusing the isolated fixture and passing an `AcceptedWork`
instance through the existing `createApiApp` `requestWork` option. A controlled
`res.download` callback can exercise those branches without large archives or
timing-dependent client disconnects; restore any stub before the real download
assertions. Verify ordinary error forwarding before headers,
response destruction after headers, and release of retained work after callback
settlement. Add these assertions before extraction so they pass on the baseline.
Do not add test hooks to production interfaces or create another backup harness.

Service/recovery algorithms are unchanged. Do not rerun their unrelated drain,
progress, full PostgreSQL/S3 migration or Kubernetes campaigns for this move.
If a service or lifecycle file must change, stop and reassess scope and tests.

### 4. Browser and structural checks

Use the repo's headless runner on an isolated local frontend with the existing
mocked UI journeys:

```powershell
$env:PLAYWRIGHT_HEADLESS = '1'
$env:PLAYWRIGHT_SLOW_MO = '0'
# Set PLAYWRIGHT_BASE_URL to the owned local frontend when needed.
yarn studio-server:ui:observe vm-migration.spec.ts --workers=1
yarn studio-server:ui:observe local-storage-upgrade.spec.ts --workers=1 --grep 'guided migration prepares from UI|browser backup survives reload|local upgrade controls fail closed'
```

Use the verified cached Chromium executable when available. Run `--list` first
to confirm the selected existing test names; inspect failure artifacts rather
than skipping cases. These mocked journeys verify UI compatibility; the real
API/runtime tests above establish server behavior. The separate origin browser
spec requires an enabled provisioned server and otherwise skips; it is not a
substitute for those full-app checks and does not justify using live local data.

Finish with:

```sh
yarn workspace @valerypopoff/rivet-studio-server-api exec tsc -p tsconfig.runtime.json --noEmit
yarn check:file-tree
yarn studio-server:verify:test-style
yarn node scripts/checks/check-test-style.mjs
yarn node scripts/checks/check-doc-links.mjs
git diff --check
```

Verify test manifest membership if any new file is unavoidable. At commit
preparation run the relevant local CI checklist, including root `test:style`
before final builds/typechecks if it rebuilds shared workspace outputs. Reuse
successful checks for unchanged inputs; do not repeat cloud or whole-repository
acceptance work simply because HTTP ownership moved.

### 5. Document and hand off

Update `local-metadata-upgrade.md`, `vm-to-managed-migration.md`,
`access-and-routing.md`, `architecture.md`, `refactor-history.md` and this plan
with the actual module owners and validation results. Record measured line counts
and distinguish historical baseline evidence from the final checks. Keep any
repeatable CI lesson in the Git-ignored local notes only.

No endpoint benchmark or repeated migration is needed just to produce a speed
number. Equivalent handler bodies, an unchanged execution path, shared parser
identity and startup-only registration establish that no per-run work was added.
This is not a measured latency claim. If startup or request behavior suggests a
slowdown, measure that specific path against the saved baseline before completion.

## Completion and stop conditions

Complete when all 26 routes have the intended owner, effective route/middleware
order and parser sharing are unchanged, parent exports and ordinary settings
behavior are preserved, targeted API/runtime/browser checks pass, and documentation
reports the result accurately.

Stop for a demonstrated change in authentication, validation/errors, streaming,
operation ownership, journal transactions, settings semantics, server lifecycle
or execution behavior. Fix an independently confirmed bug separately rather than
hiding it in the extraction. A skipped/blocked required check must be reported.

Implementation does not authorize external migration probes, production-data
copies, cloud tests, deployment, package publication, commits or pushes.

## Plan verification

The inventory and ordering above were checked against the original source; a
TypeScript import-graph check confirmed no local dependency path from either
operation service back to the parent router, and counted 26 routes plus the two
prefix guards. Parser source confirms primitive JSON is accepted before route
validation; the full-app error handler has a separate storage-error policy.
Existing runtime cases were inspected for their real coverage, including the
missing download callback failure assertions identified above. The
existing Playwright `--list` command confirms five `vm-migration.spec.ts` cases
and the three selected `local-storage-upgrade.spec.ts` cases. A small Node 24
test-runner probe confirmed that the anchored suite-plus-case pattern selects
only the intended nested case. Documentation links and whitespace checks pass.
Those planning checks are separate from the implementation checks below.

## Implementation and validation record

### Final ownership

- `app-settings.ts` is 255 lines, down from 632. It keeps the original router,
  three parser instances, early VM guard, session/trusted-client responses,
  ordinary settings and four compatibility exports.
- `local-upgrade-http.ts` owns the sixteen local-upgrade routes in 239 lines;
  `vm-migration-http.ts` owns the ten VM routes and four schemas in 163 lines.
  Direct startup registration adds no nested router or per-execution work.
  Total production code grows by 25 lines for the two module boundaries.
- Handler bodies, schemas, middleware order, shared parser identities and service
  ownership remain unchanged. App mounts, authentication, parser implementations,
  startup/shutdown and workflow execution are untouched.
- The existing runtime-import allowance moves with the local-upgrade constant.
  One test-helper allowance uses the real `AcceptedWork` implementation without
  adding a production export or copying lifecycle logic.

### Regression coverage and test cleanup

One server/environment fixture per profile now covers recording, publication
and storage-operator routes. This removes four duplicate fixture lifecycles and
net 20 test lines while preserving the route assertions. Two redundant unsigned
unknown-route requests were removed because they stopped at the outer API guard.

The full-app tests prove ordinary settings are accessible to a trusted client
before checking that both inner migration guards still reject it, including
unknown routes and malformed bodies, with ordinary UI authentication enabled or
disabled. Signed-in status reads remain uncached and require no mutation intent.
HEAD, unsupported methods, outer OPTIONS handling, 16 KiB/1 MiB parser boundaries
and the existing storage error responses retain explicit coverage.

The existing provisioned backup/repair fixtures cover three distinct download
failures: before headers, after headers and a client disconnect before callback
settlement. They observe actual accepted-work release, reject timeout-driven
closure as a false success, and restore mocks after every case. Real archive,
source-preservation and key-download checks remain in those fixtures.

The VM browser fixture now supplies the setup eligibility that controls tab
visibility, so Migration appears without opening unrelated upgrade onboarding.
This is a fixture correction; the UI gating behavior is unchanged.

### Local validation

- **106 API tests passed** across the profile, App Settings, UI authentication,
  browser-backup and VM-maintenance suites after test cleanup. Earlier 95/100
  counts were intermediate baseline/review runs, not the final suite count.
- **Four isolated runtime cases passed**: operator setup, background preparation,
  authenticated browser backup and guided duplicate-identity repair. Both changed
  download scenarios also passed after the last download-test hardening.
- **Eight headless Playwright journeys passed** through the repository runner:
  five VM-migration cases (34.6 seconds) and three local-upgrade cases (31.1
  seconds). These observation specs are outside the default editor CI shards;
  the API profile and isolated-runtime files remain in the normal API manifest.
- The API build, runtime TypeScript check, root and Studio Server test-style
  checks, import/file-tree checks, formatting and documentation links passed.
  Existing root-policy skips are distinct from these selected API, runtime and
  browser cases, none of which was skipped.
- A temporary source comparison verified all 42 registration/call statements,
  14 definitions, imports and re-exports. Compiled parent-first and child-first
  imports preserved the router stack, all 26 moved routes and parser identities.
- Deliberately removing either migration prefix guard makes the authorization
  test fail. Removing post-header response destruction makes the real backup
  test fail its explicit timeout assertion. These temporary mutation checks and
  their artifacts are not a new permanent CI framework.

Validation used disposable local roots and an isolated frontend serving the
unchanged UI. Mocked browser tests establish UI compatibility; actual API and
child-process checks establish server behavior. No live data, external
PostgreSQL/S3 probe, cloud qualification or deployment was used. No latency
improvement is claimed: the refactor preserves the execution path and adds no
per-run work. Remote CI and deployment remain separate release steps.
