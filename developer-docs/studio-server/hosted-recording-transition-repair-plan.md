# Hosted recording-storage deployment repair plan

Status: implemented with passing local checks. One earlier Windows proxy
shutdown-confirmation failure remains unexplained; the traced concurrent repeat
passed without changing shutdown deadlines or safeguards. Baseline
source: `6c923679e8817764fe5c9e5f00539404feb8c775`, 2026-11-24.
Hosted production preflight and production activation remain unverified.
No deployment, protected credentials, installation bundle or release pointer
has been changed by this implementation.

## Implementation record

The shared qualified-release library and supported readiness entry now use
`recording-transition-command.mjs`. It validates the exact qualified Node/CLI
target, installation and private evidence paths, then lazily source-loads
`withRecordingStorageTransition`. The standalone command calls that lifetime
directly. The obsolete manual child waiter has been removed.

The lifetime retains the existing real lock, restore-serving lease, guard and
encoding inventory. Settings inputs are explicit; no temporary global environment
mutation or settings initialization/rotation was introduced. Concurrent live
guard/heartbeat checks coalesce only an in-flight query on their shared owner
connection. Failed acquisition/action/cleanup remains a failure, with all
disposers attempted and both primary/archival failures retained.

Protected installation data now supports bound credential references and an
optional pinned Cloud SQL Auth Proxy. Hosted setup can materialize its binary
from a generation-pinned storage object and verifies its checksum. Local use can
instead name an existing pinned executable. Private configuration stays outside
deployment archives; non-secret binding evidence stays inside the attempt.
See the [operating contract](deployment-operations.md#hosted-recording-storage-coordination).

Native Windows testing established two necessary process details beyond the
original small-helper extraction: strict CLI descendants need a creation-time
kernel Job Object, and detached observers must not inherit extra copies of the
owner's output pipes. The managed runner implements that platform seam without
another deployment state machine. Ordinary failed journaled commands retain the
original observer for acceptance-only recovery; cancellation uses strict shutdown.
Existing maintenance adapter timeout/receipt logic retains its separate owner.

The clean Linux build disproved the proposed use of
`studio-server:build:dependencies`: that target also invokes desktop Rust/native
packaging. Production now builds only Core, Node and Evaluations, in that order,
in the selected qualified checkout. A fresh offline Debian/Node 24.22.3 fixture
with no compiled workspace exports passed the helper import and all seven native
command contracts. It prohibited import-time networking, checked environment
stability and verified copied tracked source hashes after building. The measured
dependency compilation was 20.467 seconds locally; lifecycle installation hooks
were skipped for the offline fixture. This is not hosted queueing/elapsed-time
evidence or a release speedup claim.

Local verification records live under the Git-ignored
`artifacts/recording-transition-repair-20261124/`. The maintained commands below
remain the reproducible owners; those logs are not deployment certificates.
The full recording-durability suite and all 32 native deployment-command journeys
passed. Follow-up contracts additionally cover unavailable/previous settings keys
without rotation, empty/mixed/historical/unknown encoding inventories and pinned
proxy startup failure. Source-only tests retain their existing platform skips;
the new lifecycle cases ran with no skips on both Windows and Linux.

| Verification owner                                                                                     | Result                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Root `test:style`, then final changed-file format/style, documentation, repository and workflow checks | Passed; `actionlint` and exact import-boundary checks passed.                                                                                                                                           |
| Source-only rollout gate                                                                               | Passed: 911 main-suite checks, 10 observation checks and 3 shutdown checks; 6 existing platform skips. The seven native transition cases are included in that main count.                               |
| API build, focused transition/recompression tests and typed lint                                       | Passed; 8 focused tests, no skips. The real-loader contract is consolidated into the managed lane.                                                                                                      |
| Real PostgreSQL/object-storage recording-durability lane                                               | Full suite passed in the traced concurrent repeat and final uninstrumented run. One earlier Windows shutdown-confirmation failure remains unexplained; see the assessment and commit preparation below. |
| Native deployment CLI                                                                                  | All 33 checks passed in the latest assessment, including the fixture-isolation check and all existing native journeys.                                                                                  |
| Native provider contracts                                                                              | Passed in the exact qualification toolchain: 205 checks, one existing optional Postman simulation skip. No network access was needed.                                                                   |
| Production cutover/runtime packaging                                                                   | Passed, including source-only maintenance exclusion; existing platform skips retained.                                                                                                                  |
| Kubernetes contracts                                                                                   | 141 API checks passed, followed by the complete local render/Linux-housekeeping/native-command verification. No live cluster was used.                                                                  |
| Clean Linux startup and native lifecycle                                                               | Passed on Node 24.22.3; final native rerun passed all 7 cases with no skips.                                                                                                                            |
| Owned fixture cleanup                                                                                  | Completed; both cold-test volumes removed after label/in-use checks, with no owned transition child or database fixture remaining. The developer stack was left healthy.                                |

The initial sandboxed adapter/Docker checks lacked native shutdown/Docker access;
the affected maintained commands passed with that local access enabled. A
non-executable proxy test also exposed Windows' synchronous `spawn EFTYPE`
result; its assertion now accepts that real native refusal as well as the
asynchronous startup failure on Linux. A copied Windows environment's `Path`
lookup is normalized in the strict runner and covered by the native argument
case. These results do not establish production credentials or connectivity.

### Subsequent deployment-automation reassessment

The review reproduced four gaps before changing their owners:

- A successful Linux CLI could remain pending until cancellation because a
  descendant kept inherited output pipes open. Strict group settlement now
  starts at `exit` and the runner still awaits `close`; the existing native case
  exercises both ignored and inherited child output without adding a new suite.
- The PostgreSQL driver honored `host`/`port` URL query parameters after a proxy
  rewrite. Configured bootstrap and decrypted canonical storage URLs now share a
  parser that requires an explicit hostname and refuses those routing overrides.
  Database paths must also be explicit, and missing ports become 5432 in
  connection overrides, preventing ambient `PGDATABASE`/`PGPORT` from changing
  configured targets. Canonical stored identity inputs remain unchanged.
  Other URL parameters, existing TLS policy and storage identity hashes remain.
- A standalone configured transition resolved credentials before rejecting a
  foreign installation. The credential resolver now calls the existing bound
  configuration validator first; the later duplicate identity loop is gone.
  Guard labels use that validated snapshot. Proxy host/port mapping is also
  checked before starting its process.
- Newline-terminated Kubernetes secrets were rejected despite the existing
  settings reader's trimming behavior. All credential providers now use one
  bounded normalization path, retaining internal key text and private handling.

The real PostgreSQL contract additionally exercises interruption as the owned
proxy exits during final cleanup. A late interruption cannot become a successful
wrapper result. Its fixture owner now attempts every disposer, preserves primary
and cleanup failures, and reports success only after cleanup. This restores the
cleanup behavior supplied by `node:test` before extracting the shared fixture.

The managed lane also copies the inert bridge into an isolated controller and
loads the real helper from the qualified workspace, without a fake `load`.
It checks both an already cancelled invocation and a successful invocation with
real PostgreSQL coordination and the live loopback guard. An independent
connection proves the coordination lock is held; the command boundary is called
exactly once with the qualified working directory. Cancellation retains its
exact reason, writes a failed non-secret receipt and never reaches that boundary.
The existing guarded preflight/apply cases separately execute the actual CLI.
The overlapping cancellation-only loader unit test was removed.

Review evidence is retained under the Git-ignored
`artifacts/recording-transition-review-20261124/`. The source gate, full managed
recording-durability suite, native Linux/Windows contracts, API build/focused
tests and typed lint were rerun for the repair. Hosted activation remains a
separate gate; no production dispatch or safety-window change was made.

The plan's activation phase remains outstanding: a new successful main
build/qualification, reviewed immutable installation configuration, fresh hosted
production-only preflight, then a separately authorized apply with unchanged
recovery and acceptance proofs. Maintenance source is still classified as an
application input. No source-classifier waiver or old-publication patch was added.

### Earlier completion audit

The earlier audit completed implementation and local verification. The later
comparison below records an additional fixture fix and an unresolved shutdown
check; this earlier evidence does not close that issue. The default-loader contract, API build, eight
focused tests, typed lint and repository/documentation checks passed. Evidence
is retained under the Git-ignored
`artifacts/recording-transition-completion-20261124/`.

The original issue is not yet verified resolved in hosted production. Phase 8
still requires a reviewed immutable installation configuration, a successful
main build and qualification containing this repair, a fresh hosted
production-only preflight, and a separately authorized rollout with the existing
acceptance, recovery and cleanup proofs. Local fixtures do not replace those
gates. This audit performed no production operation.

### Adjacent connection-policy audit

A follow-up PostgreSQL characterization reproduced URL startup `options`
overriding the settings reader's explicit read-only mode and statement timeout.
The same driver precedence allowed a URL `statement_timeout` to replace the
lease pool's intended bound. A private connection-policy helper now enforces
the existing 15-second timeout for both owners and read-only settings lookup,
while preserving other startup options, the driver's last-value precedence and
the converter's write access. Application connection configuration is unchanged.

The managed contract uses a fixture-only schema/view that exposes settings only
when the real session has the required read-only mode and timeout. It reproduced
the failure before the fix. An actual converter connection additionally checks
its timeout, writable mode and preserved search path. These checks reuse the
existing database lane, without another service or a 15-second timeout wait.
The full managed recording-durability suite passed, followed by a focused rerun
covering the final repeated-option case. API build, all eight focused API tests,
typed lint with the API project, repository/test-style, formatting and local
documentation-link checks also passed.
Evidence is retained under the Git-ignored
`artifacts/recording-transition-adjacent-20261124/`. Hosted activation remains
unverified and requires the same release gates above.

### Holistic failure-lifetime audit

Tracing setup, command execution, archival and recovery together exposed two
evidence gaps that successful end-state checks had missed:

- The transition outcome file remained empty while the CLI ran. The wrapper now
  exclusively writes and flushes an immutable `recording-transition-intent.json`
  after real guard preparation and before invoking the CLI. Its existing
  pre-mutation archive can therefore retain the reviewed binding, installation
  reference and encoding inventory even if the controller dies. The intent
  records neither completion nor permission to replay. Its persistence failure
  prevents invocation; the final outcome format is unchanged.
- Production setup failures wrote their bounded details only under runner-local
  temporary storage. After validating the protected bucket and pinned
  installation reference, production now reuses the existing private failure
  writer at `production/setup/RUN_ID-RUN_ATTEMPT/`, including Kubernetes credential
  refusal after workflow authentication. Successful preparation uploads no
  failure object and acquires no deployment/staging lock. An unavailable cloud
  diagnostic sink preserves the original failure through the existing aggregate.

Both gaps were reproduced before their fixes. Checks stay in the existing bridge
and hosted-preparation suites; evidence lives under the Git-ignored
`artifacts/recording-transition-holistic-20261124/`. Application routes, recording
formats, source admission, observation windows and recovery fences are unchanged.
The complete source gate passed 911 checks with its six existing platform skips,
plus ten observation and three shutdown checks. All seven native Linux transition
contracts passed without skips, as did the focused managed PostgreSQL guard/CLI
lane and repository/test-style, formatting and documentation checks.

The remaining hosted gate must prove the production identity's Secret access,
Cloud SQL transport and private evidence writes, as well as the reviewed
installation adapters' backup/restore and acceptance lifecycle. Local PostgreSQL
and synthetic provider tools cannot certify those installation-specific paths.
No production configuration, release pointer or workload was changed by this audit.

### Follow-up acknowledgement and environment audit

Two further failures were reproduced in the existing focused suites:

- A stored cloud upload followed by a truncated JSON acknowledgement escaped the
  normal lost-acknowledgement handling. The response body is now read inside that
  same boundary. Ordinary evidence is confirmed by a checksum/size metadata GET;
  there is still only one POST. Exclusive admission remains explicitly uncertain
  without GET adoption, reacquisition or overwrite. Existing checksum-mismatch
  validation still fails independently of transport recovery.
- Copying a Windows environment turned native case-insensitive variables into
  case-sensitive properties. This could reject valid credential references or
  leave differently cased stale guards/bootstrap keys in the child environment.
  One private matcher now handles reads of credentials, configuration/digest and
  kubectl bindings, and removes all matching aliases when filtering private
  inputs. Read precedence matches a native Windows child; Linux remains
  case-sensitive. Regression cases also reject a wrong digest before loading
  the helper and preserve the original caller environment.

The four private-cloud contracts and seven transition contracts are extended in
place, without another fixture service or test suite. The cloud contracts remain
in their existing Kubernetes verification lane. Evidence is retained under the
Git-ignored `artifacts/recording-transition-followup-20261124/`. This audit changes
no production configuration, recording format or application request path.
Final verification passed: all four Windows cloud contracts; the complete source
gate with 911 passes, six existing platform skips, ten observation checks and
three shutdown checks; all eleven Linux cloud/transition contracts without skips;
and the real PostgreSQL guard/CLI lane. Repository/test-style, formatting and local
documentation checks also passed. Hosted production verification remains pending.

### Assessment against the last commit

The comparison baseline is `6c923679e8817764fe5c9e5f00539404feb8c775`.
All working-tree changes are deployment/maintenance tooling, tests or developer
documentation. Application routes, UI, schema/migrations and recording formats
are unchanged. AST comparison confirms identical bodies for recording operator
transactions, storage fingerprints, encoding inventory and the three extracted
shutdown primitives. All 23 original native deployment test patterns retain their
assertions; two additional patterns cover coordination refusal and fixture
environment isolation.

The source improves deployment safety: the shared hosted path
acquires real coordination, explicit configuration replaces private bootstrap
workarounds, and cancellation, diagnostic persistence and archival failures have
clear owners. The trade-off is more operational code and platform-specific
process handling, especially the Windows kernel Job Object seam. It improves
ownership and failure behavior rather than reducing total implementation size.
Six explicit maintenance/test import edges remain recorded in the existing debt
ledger; no broad source-admission waiver was introduced.

The assessment found a test-fixture isolation defect. Inherited production cloud
bindings could activate real evidence archival from an operator shell, and the
qualified fixture merged its original environment back over the command
environment after private-key filtering. The fixture now removes inherited
archival/guard/configuration bindings, supplies that isolated environment to the
shared library, and honors the filtered child environment. A sentinel-only probe
reproduced the inherited cloud bindings without invoking the deployment CLI or
making cloud requests. The managed contract now resolves a fixture-owned
environment key and checks that it never reaches the real CLI boundary. Its
namespace identity comes from the actual fixture state.

Comparison and validation evidence is retained under the Git-ignored
`artifacts/recording-transition-assessment-20261124/`. This is a checkout review,
not a new production health or performance measurement. Hosted activation
remains unverified. A successful new
main build/qualification, reviewed immutable private configuration, fresh hosted
preflight and the real installation adapters' recovery/acceptance lifecycle are
still required before declaring the deployment issue operationally closed.

Fresh API build, typed lint and all 33 native deployment checks passed. The
full managed suite reached the guarded-apply/key-isolation assertions, then
failed the normal Windows proxy cleanup with `Recording database proxy shutdown
is unconfirmed.` A separate focused diagnostic passed: both proxy `taskkill`
helpers returned 0 in approximately 1.3-1.6 seconds. The full failure occurred
while the native suite was also running; its cause has not been established.
The focused pass does not resolve it. No owned test process/container remained
after the failed run. This unresolved local verification failure and hosted
activation prevent an unconditional release-readiness sign-off.

### Commit preparation

The complete managed suite was repeated with the same concurrent native
deployment workload and an ignored diagnostic preload. It passed, including the
guarded environment-key isolation check, recovery and shared-replay compaction.
Both normal proxy shutdown helpers returned 0 in approximately 1.1-1.2 seconds,
and their owned proxy closures were observed. Diagnostic output contains only
owned process IDs, timing and helper status; it is not part of the shared source.

After the root style gate and final API build, the complete managed suite also
passed without the diagnostic preload. Final checks passed: root `test:style`,
the source gate (911 main, 10 observation and 3 shutdown checks, with 6 existing
skips), all 33 native deployment checks, the API build and 8 focused tests, typed
lint, 4 private-cloud evidence checks and workflow `actionlint`.

The native provider contracts passed in the cached, immutable qualification
toolchain image with Node 24.22.1, kubectl 1.36.6 and Helm 3.22.1: 205 passed,
with one existing optional Postman simulation skip. An initial run with the
general local Node 24.22.3 cache failed the intentional exact-version assertion;
the correct toolchain passed without changing the contract. Its image identity,
versions and logs are retained alongside the other commit-preparation evidence.

The earlier unconfirmed Windows shutdown has not been explained or labelled
fixed. No timeout was increased, no shutdown assertion was weakened and no
observation window changed. Retain that finding separately from the successful
repeat and from the still-required hosted production preflight/activation.
Commit-preparation logs live under the Git-ignored
`artifacts/recording-transition-commit-20261124/`.

## Intended result

The normal hosted release and the reuse-of-qualified-release path establish
real recording-storage coordination before invoking the qualified deployment
CLI. Production-only preflight uses the same connection and guard preparation,
then stops after its existing read-only checks. A missing guard, lost database
session, incompatible recording reader or uncertain command outcome remains a
failure, with private evidence sufficient for recovery.

The repair adds orchestration around the existing release command. Application
request handling, recording formats, retention, SQL schema, replica counts,
concurrency and observation windows remain unchanged.

## Initial baseline verified before implementation

| Owner                                                                    | Current behavior and consequence                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `deploy/studio-server/scripts/lib/deploy-qualified-release.mjs`          | Validates qualified identities, prepares private inputs and deployment fences, then calls the raw `deploy-kubernetes-release.mjs`. It does not acquire recording coordination.                                                                                                                                            |
| `deploy/studio-server/scripts/execute-runtime-qualification.mjs`         | Its `deploy` branch uses that library. Its separate readiness `preflight` branch also constructs a raw CLI invocation. Both call sites need classification and coverage.                                                                                                                                                  |
| `deploy/studio-server/scripts/deploy-qualified-production.mjs`           | Reused deployments load the original qualified implementation from `qualified/`. Production-only preflight uses the current controller's preparation library but still invokes the qualified CLI. Fixing current source does not alter an old qualified implementation.                                                   |
| `packages/studio-server-api/maintenance/recording-storage-transition.ts` | Existing wrapper reads installed storage settings, takes a real operator lease, checks the restore installation name, inventories encodings, serves a loopback guard and waits for the child to physically close. It accepts only this checkout's journaled deployment CLI.                                               |
| `packages/studio-server-api/maintenance/recording-storage-operator.ts`   | Reads encrypted settings without initialization/rotation writes and owns database connections and maintenance locks. It already exports `recordingStorageIdentity`.                                                                                                                                                       |
| `deploy/studio-server/scripts/prepare-hosted-release.mjs`                | Production setup materializes values and checksum-pinned backup/acceptance adapters. It does not establish the wrapper's installed-settings database connection and encryption context. Values and Kubernetes credentials alone must not be assumed sufficient.                                                           |
| `deploy/studio-server/scripts/deploy-kubernetes-release.mjs`             | Requires a real guard when the installed or candidate recording contract requires coordination. This includes production preflight. It combines inventoried encodings with the installed writer's capabilities and checks candidate/checkpoint readers.                                                                   |
| Existing tests                                                           | Wrapper unit tests exercise command restriction and child closure with simulated children. Deployment-command tests supply a worker-based guard fixture. Qualification command tests intercept the raw command. These are useful boundaries but do not prove hosted setup holds a real database lock around the real CLI. |

The private historical release receipts confirm a successful guarded operator
deployment and normal lease release. They also explicitly record the missing
hosted integration. They are historical evidence, not a fresh production-health
check or permission to replay that completed operation. No private installation
values or implementation packet belong in this change.

### Lock semantics to preserve

This is not a new exclusive deployment lock. Recording converters take the
exclusive advisory lock; transitions take its shared side so nested transition
participants can join without deadlocking. The restore-serving lease is also
retained. Hosted release serialization and the existing local/cloud admission
fences have separate responsibilities. A passing preflight releases its temporary
coordination; deployment must acquire and verify it again.

## Implementation decisions

1. Reuse the existing source-owned transition wrapper and operator. Do not create
   another guard server, SQL lock implementation, lease heartbeat or deployment
   state machine.
2. Extract one callable `withRecordingStorageTransition` lifetime from
   `maintenance/recording-storage-transition.ts`. It owns connection setup,
   the real lease, identity/encoding checks and the guard, then awaits a supplied
   deployment action before disposing them. The existing standalone CLI uses
   this same lifetime. It retains its restricted deployment target.
3. Add one ESM bridge,
   `deploy/studio-server/scripts/lib/recording-transition-command.mjs`. Resolve
   `tsx/esm/api` with `createRequire` from the qualified API workspace and use
   `tsImport` to load that qualified maintenance helper lazily. This loading
   pattern already exists in `deployment-adapter-local-probe.mjs`. Do not start
   Yarn, another Node wrapper, or a second CLI supervisor around deployment.
   Imports must not acquire a database connection or mutate `process.env`.
4. Let `deployQualifiedRelease` retain input validation, admission fences,
   receipts and result validation. Its existing `run` action starts the qualified
   CLI directly, with the transient guard URL and combined cancellation signal.
   Both full releases and reuse of a newly qualified repaired release reach
   this owner. The separate readiness invocation reuses the same guard lifetime
   through the same bridge, preserving its own selected manifest and flags.
5. Carry the connection bootstrap in the existing protected installation bundle,
   with one strictly validated recording-transition configuration. Materialize
   it in the private runner directory and export only its path. Do not add
   another arbitrary installation script or general plugin system.
6. Extend the existing helper only as needed to consume that bound private
   configuration, validate expected storage identity and own any required
   database proxy. Preserve the documented local command and direct-connection
   defaults. Keep the guard capability transient and local to the child process.
7. Activate through a newly verified tooling/release selection. Do not replace
   old qualified libraries with current controller code or edit an old qualified
   checkout to make a previously published certificate appear repaired.

Keep one bridge and one shared guard lifetime. The bridge validates the exact
Node/CLI target and source-root agreement before invoking its action; the action
is an internal dependency, not an executable or shell expression from dispatch.
Use the existing managed command runner as the single CLI supervisor.

### Assumptions corrected during reassessment

- A lease-loss abort in the current wrapper sends only `SIGTERM` to its direct
  child. It does not abort `runManagedGateCommand`, whose escalation requires an
  aborted signal. The revised lifetime passes lease loss into that runner.
- The managed runner kills process groups on Linux but only the direct child on
  Windows. It does not currently prove whole-tree shutdown on both platforms.
- The normal qualification workflow uses the reusable actor's preflight. It does
  not call `execute-runtime-qualification.mjs preflight`. That supported readiness
  mode is still covered, but repairing it must not introduce a new production
  preflight job into staging or change the actor's synthetic checks.
- The readiness mode may pass the predecessor as `--manifest` and the candidate
  as an adoption certificate. Hosted production-only preflight uses the qualified
  candidate. These are distinct input contracts, not interchangeable wrappers.
- A second predecessor download and a second recording-protocol decision in the
  bridge are unnecessary. The CLI remains the authoritative installed/candidate
  compatibility check; configured managed deployments establish coordination
  before calling it.
- Production currently runs `yarn install --immutable` without building workspace
  exports. The maintenance helper reaches packages whose exports point to `dist`;
  TypeScript loading alone cannot provide those files. Add the existing
  dependency build in the qualified checkout before guarded production work.
- A database proxy proves neither network reachability from GitHub nor access to
  the settings encryption key. Windows-protected local key material is not an
  unattended Linux credential source. These remain hosted verification gates.
- `recordingStorageIdentity` describes configured canonical storage, not
  cryptographic proof of the server reached through a proxy. Bind the reviewed
  proxy target, canonical configuration and queried restore-installation identity.

These were the pre-implementation plan corrections. The implementation record
above reports the subsequent changes and keeps hosted activation separate.

One bounded local probe resolved the installed `tsx/esm/api` through the API
workspace and imported the current transition helper with networking disabled
and no environment changes. This verifies the loading seam in this built
checkout, not clean-checkout readiness or the proposed callable lifetime.

## Work sequence and completion gates

### 1. Establish failing behavior checks before changing the invocation

Extend the existing qualification and command suites to cover this entry matrix:

| Entry                                               | Required coverage                                                                                                                                                                             |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| New qualification followed by production deployment | `execute-runtime-qualification.mjs deploy` through the shared library; exactly one qualified deployment invocation under a real guard.                                                        |
| Existing qualified publication                      | Controller/qualified-checkout separation, source and manifest binding, and delegation to the repaired qualified implementation once.                                                          |
| Hosted production-only preflight                    | Current controller preparation, qualified CLI, real guard, `--preflight-only`, no `--confirm`, no deployment admission fence and no fallthrough to deployment.                                |
| Qualification readiness preflight                   | Cover the supported command and its adoption branches without inserting it into the normal staging workflow. Preserve its predecessor/candidate distinction, values and readiness validation. |
| Legacy contracts without coordination               | Preserve their existing admissibility rules. Do not invent recording capabilities or bypass the installed-contract check.                                                                     |
| Frozen older tooling missing the integration        | Retain a safe refusal and document selection of repaired qualified tooling. Never silently substitute a current deployment implementation.                                                    |

Add a positive test that reaches the real CLI guard check with real PostgreSQL
coordination, plus a negative test using the same entry without coordination.
The positive test must not create its own `serveRecordingTransitionGuard` stand-in.
Fast bridge tests may use stand-ins for argument and error assertions.

Before extracting the callable lifetime, use the existing standalone wrapper as
the positive control against that same owned database and CLI fixture. The raw
hosted invocation must reproduce the missing-guard failure. This establishes the
working primitive and broken integration without relying on an export that does
not exist yet. After extraction, both entry forms must reach the shared lifetime.

Use the existing recording-durability PostgreSQL fixture for the lock-backed
contract and the existing deployment-command native fixture for the journaled
CLI. Its guard worker must be explicitly disabled for the real-guard variant;
that variant obtains its guard only from the real lease owner. Expose a narrow
fixture factory without registering/running its entire test file on import.
Place the bridge test in the existing managed lane, through a small helper under
`packages/studio-server-api/maintenance/tests/` if needed. Do not copy the fixture
provisioner or make the early source-only lane start PostgreSQL.

Invoke the real CLI asynchronously while the parent serves the guard. A
synchronous child invocation would block the same event loop that must answer
its guard requests. Observe the lock independently with another database
connection and verify conflicting maintenance cannot acquire it while the CLI
is held at a known gate. Do not use elapsed sleeps as proof of ownership.

**Gate:** record the baseline failure at the missing guard or connection setup.
Unrelated fixture/import failures do not establish the deployment defect.

### 2. Define and verify the production connection bootstrap

Inspect the supported production installation configuration, settings backend,
credential references, database network path and runner permissions. Establish
these facts with synthetic fixtures first, then with the actual protected runner
during the later hosted-preflight gate.

The private configuration must bind:

- Context, namespace, release and namespace UID to the selected installation.
- The installed-settings database connection and required decryption-key source.
  When settings are PostgreSQL-backed, read them through the existing read-only
  settings path; do not initialize settings or rotate encrypted values.
- The expected storage fingerprint using the existing `recordingStorageIdentity`
  calculation, including the canonical database and object-storage scope.
  Establish this expectation from the reviewed installed configuration; do not
  make a check that merely compares a value with itself from the same connection.
- Direct connection or a reviewed proxy connection, with explicit TLS/authentication
  settings and a pinned tool identity when a proxy is necessary.
- The qualified source root and private path ownership. Missing bindings such as
  `RIVET_QUALIFICATION_SOURCE_ROOT` and `RIVET_PRODUCTION_PRIVATE_STORE` must fail
  explicitly where required, rather than depend on a previous local shell.

Keep this a closed, versioned configuration with no arbitrary environment map,
command, module, preloader or initialization hook. Allow only the settings-reader
fields and direct/proxy connection fields actually consumed by the implementation.
Reject unknown keys and conflicting direct/proxy choices. Use references to the
existing authorized credential provider where available, with explicit key
version/rotation handling. Do not depend on interactive login or a developer's
Windows key store for GitHub-hosted Linux.

Extend `prepare-hosted-release.mjs` and its tests to materialize and validate this
configuration from the immutable installation bundle. Reject missing required
configuration, changed installation identity, redirected paths and malformed
values before invoking the deployment command. Do not extract credentials by
executing an API container's startup or copying its entire environment.

Read a bounded regular file from the expected private directory, reject symlink
or directory redirection and validate one immutable parsed copy. Enforce the
existing operator ACL requirements on Windows; POSIX mode bits alone are not
privacy there. Use secret sentinels in failure tests to prove neither credentials
nor the guard capability enter public stdout/stderr or serialized errors.

Only private paths and non-secret identifiers may enter `GITHUB_ENV`. Credentials
must stay in the protected private file or the minimal child environment, never
command-line arguments, job outputs, public summaries or logged assertion values.
Treat the loopback guard URL as a private capability too. Existing encrypted
bundle/storage mechanisms remain authoritative.

Pass the bootstrap explicitly to the callable helper. Refactor only the required
settings-reader inputs away from global `process.env`; preserve its existing
defaults for standalone use. Neither temporary environment mutation nor a cached
storage configuration may leak into concurrent adapters or a later attempt.
The deployment CLI receives its normal environment plus the guard URL; do not
forward bootstrap-only database credentials and keys to it.

Keep the bootstrap file outside the checkout's recursively archived deployment
artifact directory. Record its immutable installation-object generation and
non-secret configuration binding in private receipts. Recovery rematerializes
that same reviewed binding; it does not silently switch to the newest bundle.
Do not archive transient credential values or the guard URL for later reuse.

If a proxy is required, the wrapper owns its startup, readiness and shutdown.
Use a loopback endpoint with an owned port and bounded readiness checks. Retain
the canonical storage configuration for fingerprinting; do not change the storage
identity merely because this attempt uses an ephemeral proxy port. If necessary,
add a narrow database-connection override to the operator rather than rewriting
stored settings. Prove that it connects to the expected database/installation.
Keep settings-read and lease-connection transport consistent, including the
two-connection operator pool and the same reviewed remote database. Preserve
explicit TLS/CA/server-name rules: a loopback proxy address is not permission to
silently disable verification. A production CI identity's IAM permission alone
does not make a private database address reachable from its runner network.

**Gate:** an isolated fixture proves direct/proxy connectivity, decryption,
identity checking, cleanup and rejection of a different database/object scope.
No real lease is advertised by configuration validation alone.

### 3. Wrap the qualified CLI at the existing command boundary

Implement the callable lifetime and ESM bridge, then use them in
`deploy-qualified-release.mjs` and the supported readiness call site. The
configured managed production path always establishes real coordination for both
apply and preflight. The CLI continues to evaluate both installed and candidate
contracts. Do not pull another predecessor or reproduce that compatibility
policy in the bridge.

Missing configuration for a candidate that declares protocol 1 is a setup
failure. For an explicitly supported legacy installation without transition
configuration, preserve its existing raw invocation: the CLI's fresh installed
contract check must still reject it if coordination is required. A malformed
configuration, failed lease or failed guarded command never falls back to raw
execution. Cover the installed-requires/candidate-omits case as a safe refusal.

Preserve this sequence:

1. Validate manifest, source/tooling, application-input and safety digests,
   predecessor, namespace identity, installed settings and private policy.
2. Prepare the existing fresh private attempt directories and, for apply, the
   existing durable local/cloud admission fences. Static connection validation
   may precede these fences; changing their replay semantics is out of scope.
3. Lazily load the callable helper from the qualified workspace, start any
   owned connection transport and use `withRecordingOperatorLease`
   with the existing `transition` role.
4. Check the restore installation and expected canonical storage identity while
   the lease is live; obtain required encodings from the database under that lease.
5. Serve the existing checked loopback guard and call the supplied existing
   managed runner directly with the exact qualified Node/CLI target. Preserve
   manifest, values, policy, identity, timeout and expected-installed-settings
   arguments. Combine lease loss, caller cancellation and scoped SIGINT/SIGTERM
   into its command signal. Set `cwd` explicitly to the qualified checkout.
6. Keep the existing guard checks before consequential operations and keep the
   CLI's combination of stored encodings and installed writable encodings.
   Candidate and checkpoint readers must support the resulting set.
7. Await command closure and owned local descendant settlement, dispose the
   guard/database resources and settle the owned transport. Preserve failure
   evidence and the existing deployment/preflight result validation and
   archive/cloud receipt handling. Attempt every required cleanup and preserve
   both the primary and cleanup failures; do not let a later upload error erase
   the recorded command outcome.

Resolve the TypeScript loader and helper from the verified qualified root, not
the controller checkout, a globally installed package or `dist`. The source-only
bridge import remains cheap and inert; load API/storage dependencies only when
executing a guarded action. Test controller and qualified roots that differ, plus
clean-checkout dependency resolution, import safety and explicit working directory.
Use `shell: false`; no shell escaping or extra Yarn process chain is needed.

In the production job of `studio-server-qualify-release.yml`, build the existing
Core, Node and Evaluations workspaces after installing the selected qualified
checkout's dependencies and before private preparation/guarded execution. Run
in the same source root used by deployment, including `qualified/` in reuse mode.
The clean Linux check established this dependency closure. Do not invoke desktop
executor native packaging or assume an API/web build is necessary. No new
packaging format or separate build artifact is needed; the guard remains
source-loaded.
Verify the dependency build leaves tracked source clean. Test the production
step ordering and run one Linux clean-checkout build/import check without
pre-existing `dist` output. Do not remove another local task's build outputs to
simulate this check. Measure this real added preparation time against the hosted
job budget without shortening any observation/drain stage.

Preserve the existing exact-revision assertion-preload compatibility tests.
It must not become global `NODE_OPTIONS` or leak into unrelated descendants.
Older qualified sources are not made compatible by passing Node import flags
through an arbitrary-command escape hatch in the wrapper.

**Gate:** the new/full and reused-release entry tests reach a guarded qualified
CLI once, retaining identical deployment arguments and acceptance requirements.

### 4. Preserve cancellation, ownership and uncertain-outcome handling

Use `runManagedGateCommand` for the qualified CLI itself, while the callable
helper holds coordination in its parent. Pass the combined signal into that
runner so lease loss triggers its existing escalation, not just a standalone
`child.kill`. The standalone wrapper must share this execution path rather than
retain a second, weaker supervision implementation.

The standalone CLI calls the extracted lifetime directly; it must not call back
through the ESM bridge/loader and create a module-loading cycle. Once callers
share the managed runner, remove the obsolete manual spawn/wait implementation
and consolidate its still-useful close/error/interrupted-zero-exit assertions.
Do not retain an unused production helper solely to keep its old tests passing.

Install scoped interruption handling before asynchronous connection/proxy setup,
check cancellation between acquisition steps, and remove listeners in `finally`.
Keep active acquisition/cleanup promises owned until they settle. Do not use
`Promise.race` to abandon a still-running proxy or database connection attempt.

Add native-process checks for:

- Successful completion, nonzero exit, failure to spawn and error before close.
- Cancellation before readiness and during the CLI, SIGINT/SIGTERM, database
  owner loss, idle pool error and proxy failure while the child is active.
- A CLI that ignores the first termination request, plus an owned descendant
  that closes/inherits no output pipes and outlives the CLI. Prove escalation and
  whole-tree settlement; `close` or exit zero from the parent is insufficient.
- Cleanup errors alongside the primary failure, and evidence-upload failure
  after an otherwise completed CLI. Neither is a reason to replay deployment.

Check an already-aborted signal after asynchronous setup and before spawning.
No guard should answer successfully after coordination loss. Treat an interrupted
cooperative zero exit as failure. Normal cleanup must prove that a subsequent
conflicting maintenance operation can acquire the lock.
Physical process death necessarily releases its PostgreSQL session; durable
deployment journals and replay fences remain responsible for uncertain remote
work after that point. Do not claim a local lease survives a killed runner.

The current managed runner's Windows `child.kill` and Linux signal delivery are
not whole-tree settlement proofs. Reuse the owned-process shutdown primitives
already implemented by the maintenance-adapter supervisor where needed. Extract
only that small ownership/termination seam if sharing requires it; do not replace
the adapter's separate timeout/receipt logic with a new process framework.
Scope strict descendant-settlement behavior to the guarded release command and
its owned proxy. Preserve the existing behavior of unrelated background and
receipt-managed adapter commands; their long-lived observers have their own
shutdown protocol. Retain those observer/adapter shutdown receipts as separate
proofs: process-group inspection alone does not certify detached or remote work.
Retain existing command termination budgets and distinguish them from unchanged
Pod drain/observation windows. If descendant shutdown is unconfirmed, report an
uncertain failure and retain journal/fence evidence; never claim cleanup success.

**Gate:** native tests show the correct lifetime and no owned child/proxy left
behind. Uncertain remote outcomes retain their original journals and operation
fences and require observation/recovery, not a second apply.

### 5. Make preflight exercise the production path safely

Run the same callable lifetime, connection setup, storage identity, lock acquisition and
codec inventory as apply. Pass the existing qualified CLI `--preflight-only`.
Retain its existing adapter prerequisites, current settings/namespace checks,
read-only data-access checks and private evidence.

Temporary session advisory locks and private diagnostics are allowed. Preflight
must not update application/settings data, rotate keys, create a deployment
journal, consume the production apply admission fence, capture a backup, migrate,
apply Helm, start acceptance/endpoint fixtures or change workload objects.
Existing read-only inspections and server-side dry-run checks keep their current
semantics. A successful result remains `preflight-passed` with
`workloadMutations=false` and `applicationJourneysRun=false`.

Preserve the separate preflight evidence prefix, unique check identity and no
fallthrough to deployment. Release coordination and transport at the end; a
later apply repeats the live checks. The deployment CLI's bounded preflight
adapter deadline and all rollout observation/drain windows remain unchanged.

Keep the two readiness modes distinct. Hosted production-only preflight retains
its current no-`--confirm` invocation and `preflight-passed` result. The supported
`execute-runtime-qualification.mjs preflight` mode currently includes `--confirm`
and may use predecessor/adoption inputs; preserve those arguments and its
`deployment-readiness.json` validation. In both modes `--preflight-only` remains
the non-mutating route. Neither is a staging actor replacement or an apply step.

**Gate:** hosted-preflight-shaped local tests check both the positive result and
absence of deployment/fixture side effects. A held converter lease or missing
codec proof fails before any workload mutation.

### 6. Cover storage and platform boundaries without duplicating suites

| Check                      | Maintained owner and required assertion                                                                                                                                                                                                                |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Command/source binding     | Existing qualified command/input suites plus an inert-bridge suite; wrong checkout, identity, manifest, flags and private paths cannot choose another executable or implementation.                                                                    |
| Clean hosted startup       | Dependency-build ordering in both production modes and a clean Linux checkout; helper imports succeed without borrowed `dist` output and leave tracked source clean.                                                                                   |
| Real lock interaction      | Existing recording-durability PostgreSQL integration; a transition blocks a converter, a converter blocks a transition, nested shared transitions remain possible, and cleanup releases ownership.                                                     |
| Storage identity           | Synthetic installations with matching names but different canonical storage; the hosted wrapper rejects a mismatched reviewed fingerprint.                                                                                                             |
| Encoding compatibility     | Identity/gzip/Brotli, empty inventory, historical evidence references and unknown encoding; candidate/checkpoint checks include installed writer capabilities, not just currently observed rows. Reuse existing codec tests for encode/decode details. |
| Database/settings loss     | Real owner-session termination and settings/decryption failures; no successful guard or deployment result and no initialization/rotation writes.                                                                                                       |
| Process lifecycle          | Wrapper boundary unit tests plus a small native child/proxy matrix on hosted Linux and the maintained Windows operator path. Do not multiply every deployment scenario by every process fault.                                                         |
| Qualified reuse and fences | Existing qualification execution/controller suites; exact source/run/attempt, immutable operation identity, unchanged local/cloud replay fences and failure receipts.                                                                                  |
| Actual CLI                 | Extend the existing deployment-command fixture with the real storage wrapper; keep its existing rollback, recovery and acceptance cases. A fake guard test alone cannot close this gate.                                                               |

The bridge's unit suite imports no storage dependencies. Its managed counterpart
uses the real callable lifetime and database; an injected fake guard cannot
satisfy that success case. Review any new exact source-package import edges and
run `check:file-tree`; do not add a blanket allowance or use dynamic loading to
hide an unreviewed dependency.

Use the Windows incidents from the release handoff as targeted checks, not a
reason to copy private patches into shared code: exercise native database/proxy
transport; every SDK invocation style actually used, including `spawnSync` when
present; CRLF tar-list parsing where archive handling is touched; explicit
environment bindings; and precise process creation identity in any observer
adapter that changes. Retain the private observer's before -> cutoff -> abort
lifecycle proof if that adapter must be republished. Do not change the macOS
runner strategy or unrelated platform utilities.

Register source-only command tests in `scripts/ci/verify-rollout-source.mjs`.
Keep tests importing API/storage code in their existing build-backed API or
managed lane; the early source gate intentionally needs no compiled exports,
Docker, browser or cloud. No new required long-running CI lane is needed.

**Gate:** each required assertion has one primary owning test and a real CI
command that selects it. Record failures and fixture cleanup separately.

### 7. Verify source and update the operating documentation

Run checks in dependency order; root style can rebuild Core, so finish it before
build-dependent tests. Use the checkout's pinned Node/Yarn. The base commands are:

```text
yarn test:style
yarn node scripts/ci/verify-rollout-source.mjs
yarn workspace @valerypopoff/rivet2-core run build
yarn workspace @valerypopoff/rivet2-node run build
yarn workspace @valerypopoff/rivet2-evaluations run build
yarn workspace @valerypopoff/rivet-studio-server-shared run build
yarn workspace @valerypopoff/rivet-studio-server-bootstrap run build
yarn workspace @valerypopoff/rivet-studio-server-api run build
yarn workspace @valerypopoff/rivet-studio-server-api run test:files src/tests/recording-storage-transition.test.ts src/tests/recording-recompression.test.ts
yarn workspace @valerypopoff/rivet-studio-server-api run test:recording-durability-managed
yarn node --test deploy/studio-server/scripts/deployment-command.test.mjs
yarn studio-server:verify:production-cutover
yarn studio-server:verify:kubernetes
yarn studio-server:verify:repo-structure
yarn check:file-tree
yarn node scripts/checks/check-doc-links.mjs
git diff --check
```

Add focused typed lint/format checks for changed files. The source gate already
selects qualification execution, qualified command/input, hosted preparation and
release-tooling suites; avoid running those unchanged suites again without a
reason. If workflow YAML changes, also run
`actionlint -shellcheck= -pyflakes= <changed workflow paths>` and the workflow
policy check. Wrapper packaging/launch tests must prove source-only maintenance
code remains excluded from application runtime images and resolves in a clean
qualified checkout. Reuse the existing runtime packaging test owner.

Update `automated-runtime-qualification.md`, `deployment-operations.md`,
`recording-brotli-plan.md` and the refactor/history record with the final command
ownership, private configuration contract, preflight semantics, replay/recovery
procedure and actual verification. Keep this plan's status explicit. Read the
Git-ignored recurrence checklist before a requested commit/push, record only new
repeatable pitfalls there and never force-add it or private artifacts.

No browser-facing code is planned. If implementation affects browser/acceptance
behavior, run the relevant headless checks through
`PLAYWRIGHT_HEADLESS=1 PLAYWRIGHT_SLOW_MO=0 yarn studio-server:ui:observe` using the
shell-appropriate environment syntax. Preserve existing hosted browser acceptance
in the real rollout regardless of whether a local UI regression is needed.

### 8. Qualify and activate the repaired path as a separate operation

This phase requires a concrete reviewed source diff, passing local checks and an
explicitly authorized hosted operation. Preparing the plan or implementation is
not that authorization.

1. Determine the application/tooling build requirement with the existing source
   classifier and digest proof. Maintenance files under
   `packages/studio-server-api/maintenance/` are currently not classified as
   tooling-only, even when excluded from runtime packaging. Do not widen the
   classifier to avoid a required build. Current application changes also cannot
   reuse an older build merely because this repair is orchestration work.
2. Produce/select successful main application and tooling runs as required.
   Qualify the repaired tooling through the existing protected staging process
   and publish the exact matching certificate. Keep immutable images and selected
   sources bound by the normal checks. No local receipt stands in for hosted CI.
   Keep application rebuild requirements separate from the production runner's
   dependency compilation: the latter prepares source imports and does not
   rebuild, select or replace the qualified service images.
3. If the protected installation bundle needs new connection configuration or
   adapter fixes, publish a new immutable version and review the protected
   configuration pointer. Preserve old packets and unfinished-operation bindings;
   do not rewrite a pending operation's policy or substitute staging storage.
4. From a fresh hosted runner, dispatch production-only preflight for a valid
   qualified publication whose predecessor matches the actual installation. Use
   the real production CI identity, installed settings and network path. Verify
   real coordination/codec/identity evidence, a passed preflight receipt, clean
   owned-process shutdown and no persistent workload/data mutations.
5. Review that concrete preflight result before an independently authorized
   production apply. Apply reacquires coordination and repeats fresh baseline
   checks. Require the unchanged checkpoint, rollout, browser/editor/web-app,
   endpoint-recording, acceptance and owned-fixture cleanup proofs.
6. Verify the final deployment journal and live release identity independently.
   An older release's already-completed operation or private replay fence cannot
   be reused for a new apply. After any uncertain result, observe/recover the
   original attempt before considering another operation.

Measure added bootstrap/guard time separately from the unchanged observation
windows. For workflow claims, retain queue time, run/attempt/source and total
elapsed hosted duration. This repair adds required coordination; it has no
predeclared speedup or shorter safety window. It adds no middleware, SQL or
network work to ordinary workflow endpoint requests.

## Stop conditions and evidence

Stop before workload mutation if private configuration, key access, database
identity, storage fingerprint, codec support, predecessor/settings/namespace,
qualified source, live coordination or replay-fence checks fail. Keep the useful
private failure evidence without logging secrets. Never replace the real guard
with the worker fixture or a configured environment flag to continue.

Report completion in three separate states:

1. **Implemented locally:** code/docs complete; all selected unit, native and
   real PostgreSQL contracts pass and owned local fixtures are cleaned.
2. **Hosted preflight verified:** fresh protected runner proves the production
   connection, real guard and read-only preflight path with exact identities.
3. **Production automation verified:** an authorized rollout using repaired
   qualified tooling completes its original recovery/acceptance requirements,
   independent live verification and owned-fixture cleanup.

Do not mark the entire issue resolved at state 1 or infer state 3 from staging.
If an older frozen publication remains intentionally unsupported, document its
safe refusal and replacement qualification requirement rather than claiming it
was retroactively repaired.
