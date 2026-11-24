# Refactor History

This document records intentional architecture and cleanup changes that future maintainers should understand before changing the same area again.

It is not a changelog. Keep entries focused on why a refactor happened, which ownership boundary changed, and which verification paths should be kept alive.

## 2026-11-25 - Project Settings Publication Review Ownership

Project Settings previously combined reviewed snapshots and editable draft
reconciliation with every publication mutation. `useProjectPublicationReview.ts`
now owns that single review session; `useProjectSettingsActions.ts` retains its
public interface, validation, mutation locks, release review and deletion.
The combined owners still have 13 state hooks and two effects. Three refs retain
draft baselines; a fourth identifies the current read within its modal/project owner.
The extraction adds no request, timer, cache or state-synchronization callback.

`projectPublicationReview.ts` shares only the common field-agreement and returned
settings-publication rules. History keeps its own review and restore receipt
policy. The identical email parsers and the existing dirty-field merge now live
in `projectSettingsForm.ts`; `publicationVersion.ts` remains authoritative for
version encoding and advancement. An own-key-guarded non-null assertion fixes
the existing indexed-access type diagnostic without changing emitted JavaScript.

Reassessment reproduced overlaps between History Restore and both the opening
read and an explicit review. A late response could replace the restored review
with older tokens or re-enable an uncertain review. The existing server
preconditions still rejected stale writes. Opening, explicit review and mutation
follow-up reads now share one read identity; newer reads and mutation outcomes
retire their predecessor. The same identity check protects result, error and
loading completion, and closing or replacing the owner retires every pending
read. This uses one ref without adding requests or changing mutation/restore
receipt rules. Uncertain mutations still reconcile the project tree. The endpoint
draft handler also accepts only its actual string field, removing an unnecessary
generic cast over transport-only boolean fields.

The focused no-emit project and typed lint cover the moved owners, action facade,
history and pure tests. Project Settings joins the ordinary editor CI selection.
Its browser checks cover late reads after reopen or Restore, unusable review tokens,
draft preservation and request counts, alongside the existing mutation/recovery
and history scenarios. See the [implementation record](project-publication-review-refactor-plan.md)
for baseline and final validation evidence and hosted-measurement limits.

The test review removed a publish-conflict case that duplicated the stronger
retry scenario and never exercised its claimed refresh failure. Shared snapshot
construction and strict fixture project lookup replace repeated response bodies
and permissive fallback to the first project. The existing compiler/lint project
now includes that fixture. Recovery assertions prove that review controls become
usable; fault injection showed that checking only the displayed status could
miss a missing review token. The four distinct opening/manual and
confirmed/unconfirmed Restore races remain covered.

## 2026-11-24 - Local Storage Upgrade Screen Ownership

The upgrade screen previously mixed rendering with polling, mutation settlement,
revision-bound attestations and recovery. A pure `localStorageUpgradeModel.ts`
now owns derived policy; `useLocalStorageUpgradeController.ts` keeps one mounted
request/action lifetime. The existing screen renders their state and named
commands. Its 16 state hooks, eight refs and six effects retain their order;
there is no additional poller, reducer or global store. Setup caching, read/action
timeout differences, fresh reconciliation and server authority remain intact.

A separate baseline correction prevents an absent ready fingerprint payload from
crashing proof adoption when maintenance is also absent. The browser regression
failed before the presence guard and passed on the corrected baseline. Backup
and resume bindings retain their distinct formats; preparation and interrupted
repair retain their separate disabled rules.

The web-test lane now typechecks the actual screen/model/controller and their
focused policy tests. Existing panel/prompt browser cases use a closed fixture
and run in the normal editor selection, with explicit races for stale reads,
acknowledgement identity, automatic validation and diagnostic replacement. A fifth
editor shard supplies coverage capacity while preserving the existing worker,
timeout and work-budget rules. New modules use shared-package paths and remove
the screen's two obsolete deep-import allowances. The
[implementation record](local-storage-upgrade-screen-refactor-plan.md) separates
local checks from hosted CI and actual upgrade/recovery qualification.

Reassessment retained the production implementation and removed nine redundant
empty-tree and paused-editor route overrides in favor of the shared fixture.
A new lost-validation-acknowledgement case models the real journal's revision
advance: fresh durable evidence reconciles success without replay or an inherited
resumption acknowledgement. The old diagnostic remains visible. An unchanged-
revision validation-success mock would invent a recovery failure that the real
journal cannot produce; it is not a reason to change production controls.

Adjacent review on 2026-11-25 reproduced a real preparation exception to the
connection lock: after a failed preparation response and failed reconciliation,
the spinner stopped but the initial Prepare button became enabled. The pure model
now receives the existing `statusError` and includes it in that button's gate.
A fresh successful setup read restores explicit preparation without replay or
clearing the action diagnostic. Fresh setup still permits initial preparation
when ordinary upgrade status is unavailable. No state hook, effect, request,
timer or backend guard was added or changed.

The test review removed duplicate panel navigation, replaced the optional prompt
timeout probe with a scoped locator handler, and made button-lock checks one
auto-waiting collection assertion. Request-count cases explicitly pause the clock
before mounting the upgrade controller, after the modal transition has settled;
`clock.install()` alone does not pause time. Real stalled-read cases retain their
native deadlines. The 70 independently isolated panel cases can share the existing
two workers; the 23 prompt cases keep their serial scheduling. No scenario was
removed or production source changed in this test cleanup. The implementation
record above owns the measured local results and their hosted-evidence limits.

## 2026-11-24 - Hosted Recording Transition Ownership

`withRecordingStorageTransition` owns settings reads, real database coordination,
storage/restore identity, required encodings, the loopback guard and optional
pinned proxy transport. The standalone operator and shared qualified-release
library use this one lifetime. A source-only ESM bridge lazily imports the helper
from the exact qualified workspace and supervises the existing CLI directly.
Production-only preflight shares preparation without gaining apply side effects.

Protected setup accepts closed installation data and materializes private inputs
outside deployment archives. Existing CLI compatibility checks, admission fences,
recovery journals, backup/acceptance adapters and observation windows retain their
ownership. The managed command runner shares the existing owned-tree shutdown
primitive; its strict Windows path needs a creation-time kernel Job Object and
explicit inherited handles. Ordinary failed CLI attempts preserve their original
receipt-managed observer for acceptance-only recovery. Cancellation remains a
failure and does not authorize replay.

Real PostgreSQL contracts reuse the recording-durability lane and the extracted
deployment-command fixture. They exercise actual locks, settings, guard, qualified
preflight/apply and ownership loss; native lifecycle checks remain in the source
gate. The clean Linux check identified and removed an unnecessary desktop native
packaging dependency from production operator preparation. Ordinary application
request paths, schema and recording formats are unchanged. The
[implementation record](hosted-recording-transition-repair-plan.md) separates local
verification from pending hosted preflight and production activation.

Reassessment reproduced a Linux completion hang caused by inherited output pipes,
PostgreSQL host/port query overrides escaping canonical proxy routing, credential
reads preceding standalone identity validation, and rejected secret-file line
endings. Strict settlement now starts at process exit, identity uses the existing
validator before credential access, and URL/credential handling have shared
owners. Cancellation during proxy cleanup cannot report success. The managed
lane tests the real qualified TypeScript loader from an isolated controller,
covering cancellation and successful acquisition with PostgreSQL locks and the
live guard; the overlapping loader-only unit test was removed. Existing guarded
preflight/apply cases execute the actual CLI. Managed fixture cleanup attempts
every disposer and preserves earlier failures.

An adjacent PostgreSQL characterization found URL startup options could replace
the settings reader's read-only mode and query bound. A private operator
connection helper now enforces the original 15-second timeout and read-only
lookup, preserving other startup options and converter write access. The
managed lane checks actual session settings, including repeated-option
precedence, without adding another fixture service or a timeout-length wait.

Holistic review found that the transition outcome stayed empty during execution,
and production setup diagnostics did not survive runner disposal. An immutable,
flushed intent now precedes the guarded CLI and enters its existing archive before
mutation; the final outcome remains separate. Production preparation also reuses
the private failure writer under the current hosted run/attempt, without acquiring
a deployment fence. Regression checks cover evidence visibility before invocation,
refusal when intent persistence fails, and private archival after access denial.

The private evidence writer treats response-body loss like other lost upload
acknowledgements: exact metadata readback can confirm ordinary evidence, while
exclusive admission stays uncertain without replay or adoption. Transition
configuration also shares one Windows environment-key matcher for credential
reads and private-input filtering; differently cased aliases cannot survive
stripping or bypass the protected configuration digest. Existing HTTP and native
contract suites cover both boundaries; Linux retains case-sensitive semantics.

The extracted deployment fixture also owns its environment boundary. It removes
inherited production archival and recording-transition bindings before using
local stand-ins, passes the same environment through qualified preparation, and
honors the bridge's filtered child environment. The managed guard contract uses
an environment-backed settings key to verify the fixture cannot put that key
back into the CLI environment. Original native journey assertions are retained.

Windows proxy shutdown now reuses the creation-time Job Object supervisor rather
than launching `taskkill` at cleanup. A bounded local contention reproduction
with the original helper output handles made all 32 helpers miss the original
five-second deadline. All 32 job-owned shutdowns passed. The new proxy mode
uses owner EOF to request termination and requires zero active job processes;
spontaneous zero exit, failed confirmation and deadline expiry cannot succeed.
The five-second bound, real coordination and journaled observer retention remain.
Native tree tests and the existing real PostgreSQL lane own these checks. The
original uninstrumented failure has no helper result, so its exact trigger cannot
be established retrospectively from that log.

## 2026-11-24 - Hosted Evaluation Persistence Ownership

`HostedEvaluationJobStore` owns durable job transitions and their complete
transactions. `HostedEvaluationCoordinator` owns process-local scheduling and
the public facade. They borrow the same managed pool and run store; the
extraction adds no pool, schema, background service or endpoint middleware.
Existing projection and deletion helpers remain authoritative.

Preserve commit-before-notification and notification-before-release for
cancellation/retry, release-before-notification for submission, and the
coordinator's unconfirmed-retirement flag when terminal ownership is lost.
Acceptance/heartbeat require an unexpired lease; terminal writes retain the
existing worker/fence check without an additional expiry predicate.

The [implementation record](hosted-evaluation-persistence-refactor-plan.md)
tracks baseline/candidate PostgreSQL concurrency, source and compiled workers,
mounted HTTP coverage and the bounded endpoint performance comparison. The
new concurrency helper runs inside the existing managed integration job.

The original and extracted code passed the same 26 PostgreSQL scenarios. Initial
verification passed 134 focused API tests, the full managed and published-execution
suites, and three headless browser cases. All 84 SQL calls and bindings stayed
identical. Four local performance conditions and a bounded reversed-order
diagnostic repeat found no reproducible latency or evaluation-throughput
regression at the recorded resolution; the implementation record retains the
CPU variation and confidence limits rather than claiming a speedup.

A subsequent review reproduced two identifier-collision defects: active jobs from
different runs could share an encoded job ID and overwrite cancellation ownership,
and colon-containing project/run pairs could share a recovery-cache key, leaving
one recovered run marked running. One promise-keyed map now owns active metadata
and draining, and recovery uses a JSON tuple key. Persisted identifiers and all
SQL remain unchanged. The post-commit callback type rejects asynchronous callbacks.
The native worker fixture also distinguishes unexpected exit from explicit fault
injection and coalesces concurrent cleanup; its release callbacks use a set.
All 29 PostgreSQL cases, 103 focused API tests and the three selected browser
cases passed after these fixes. A six-pair loaded-combined comparison passed
12,000 measured endpoint requests and all expected recording audits without a
reproducible latency increase; the implementation record retains its uncertainty
and local-workload limits.

The completion audit additionally compared executed SQL/bindings and transaction
paths across 23 shared PostgreSQL scenarios using the frozen original runtime.
Source and compiled worker acknowledgements now include the resolved coordinator
module URL. Fast boundary checks retain rejection of disabled retry and invalid
context before database access. These close verification gaps without changing
production behavior.

An adjacent review reproduced the same identity-risk pattern in the shared
evaluation adapters. Slash-containing project/resource pairs could overwrite
in-memory run or recording entries. Their private map keys now use JSON tuples.
Library mutations also mistook inherited object properties for collaboration
versions, rejecting valid IDs such as `constructor`; a deleted resource could
expose an inherited function as its conflict version. Server checks and client
diff/retry lookups now require own properties. Persisted IDs, PostgreSQL queries,
access checks and the collaboration protocol are unchanged.
The dataset-toggle browser fixture now owns its bootstrap and library responses
and verifies saved toggle values, avoiding an unrelated ambient-API dependency.
The subsequent test audit removed six redundant coordinator unit cases, moved
their remaining assertions into existing PostgreSQL scenarios, and reused the
shared fixture in the projection contract. Rollback failure remains covered in
the consolidated unit case. Real lease/recovery and source/compiled checks retain
their observation windows. Browser fixtures use current string version tokens.

## 2026-11-24 - Run Recordings Read Ownership

`useRecordingRunsQuery.ts` owns root browsing, progressive input search, filter
state and query-specific deletion reconciliation. `useRecordingSubRuns.ts`
owns child metadata pagination, validation, retry state and family reconciliation.
`useRunRecordingsController.ts` keeps the public facade, independent catalog
requests, session/selection policy, shared view generation and deletion sequence.
The existing count-decrement calculation is shared in `recording-run-counts.ts`.

Keep the owners mounted across retained dismissal. Stable lifecycle commands
must not acquire dependencies on input drafts or query results; catalog arrival
and progressive append cannot restart the root query. A confirmed deletion is
reconciled locally before refresh, and the parent checks its view/mutation token
after each awaited read before accepting results. The manual post-delete page
read returns data without publishing its completion, preserving that check and
the page effect's ownership of last-page correction.

The normal modal suite retains its existing cases and adds seven characterization
cases for same-root replacement, continuation validation/deduplication and
post-delete catalog races. All 90 passed both against the original controller
and against the final built application. The two extraction checkpoints also
passed the required headless repo runner. See the [implementation record](run-recordings-controller-refactor-plan.md)
for final verification results and the pre-existing focused typecheck diagnostics.

A follow-up review reproduced a count-reconciliation defect in the preserved
logic: deleting a child after a count-free continuation discarded root-only scope
counts and fell back to recording totals. Child deletion now retains the matching
cached scope. Cached and page counts share one inclusion condition. The stateless
grouped-page request helper is a module function, with options derived from the
existing API signature, rather than a React callback and a copied request type.
That 91-case suite passed locally through both the required headless
repo runner and the normal two-worker CI configuration after that correction.

An adjacent audit found that the continuation guard rejected only immediate
repeats: an injected A → B → A sequence could keep the client requesting older
pages. Each input search now remembers followed opaque tokens and stops on any
revisit, preserving partial results and the existing error message. No server
cursor format or valid-search budget changed. Additional held-continuation and
catalog-failure deletion probes confirmed the cached-count fix already covered
those paths and required no further runtime change.
The expanded 94-case suite passed locally under the normal CI configuration;
all four focused adjacent probes also passed through the headless repo runner.
The [comparative assessment](run-recordings-controller-refactor-plan.md#comparative-assessment-against-the-committed-version)
records the larger combined source/interface cost and the remaining dashboard
typecheck coverage gap. The extraction improves ownership without removing the
need to review cross-owner reset and mutation coordination.

## 2026-11-23 - Shared OAuth Mechanics

`oauth-browser-state.ts` owns the existing signed-envelope verification/signing
and cookie mechanics. `oauth-provider-client.ts` owns external request formation,
response validation and email-claim extraction. The original UI/visitor modules
keep their exports, dummy branches, policy and HTTP registration. Secret lookup
remains deferred inside the original signature-error boundary. Token and profile
wrappers keep their response/JSON awaits and logging at the original points.

Settings context is unchanged: both mounted HTTP callbacks use the request's
captured revision, direct helper calls retain their existing repository reads,
and watch/Socket reauthorization still escapes the opening snapshot. Preserve
the distinct fingerprints, UI secret fallback, return-target comparison and
cookie wire representation when extending either surface.

The source/prebuilt HTTP tests use one owned local provider fixture, with held
token/profile responses, independent settings changes and actual request capture.
Two browser journeys share one fixture per worker while retaining isolated
browser contexts; they cover real redirects, cookie admission, allowlist denial
and independent logout. API discovery and the hosted browser manifest include
the new tests. Fixture cleanup waits for process settlement before removing its
owned root and rejects missing shutdown acknowledgements or abnormal exits;
lifecycle regressions cover unexpected exit and startup failure. Mounted
callbacks also cover dropped provider connections.
The initial browser weight reflects local case work only;
hosted timing remains a separate measurement. See the
[implementation record](oauth-mechanics-refactor-plan.md) for validation results
and their release boundaries.

An adjacent fixture review also repaired failed-send deadline cleanup and
async-workflow owner loss. The workflow child uses its real SIGTERM drain when
IPC ownership ends, and guarded replies cannot abort that drain on a closed
channel. Keep its startup and acknowledged held-reply owner-loss regressions with
the existing recording lifecycle suite; production auth and shutdown policy are
unchanged. Cookie compatibility is always checked against synthetic baseline
values; request snapshots verify their original signing key and settings version.

## 2026-11-22 - Managed Recording Retention Ownership

`managed/recording-retention.ts` owns the existing PostgreSQL retention task,
protected-evidence parsing and independent JavaScript policy reference.
`managed/recordings.ts` composes the callback and preserves its selector export,
task registration, startup recovery gate and public cleanup method. Scheduling,
leases, outbox draining and shared-snapshot protection retain their owners.

The SQL and transaction body were moved unchanged. Current settings are read per
pass; lease validation, metadata deletion and outbox writes commit together.
Input-cache invalidation retains its storage-owner namespace and pre-commit
placement. Recovery becomes enabled when startup maintenance settles, including
logged failures; offline-mode suppression remains in the backend.

The adjacent ownership fix validates the current pass lease inside each outbox
claim. An expired or replaced owner leaves new work for a later owner instead of
claiming it. Already issued object-store calls keep their per-key claim fencing.

The real PostgreSQL characterization ran before extraction and after it. It
reuses the existing statistics integration database, covering conditional policy
paths, protected evidence, bounded tied batches and failure after real enqueue.
It also covers blocked-intent reopening and expiry with a real lease successor.
Keep those checks alongside service lifecycle/cache tests and the independent
PostgreSQL/MinIO recovery/shared-snapshot suite. The
[extraction record](managed-recording-retention-refactor-plan.md) records the
scope and final validation boundaries.

## 2026-11-15 - Project-tree Bundle Action Ownership

`useWorkflowBundleActions.ts` collects bundle modal state, conversion and
duplication requests, merge initiation, and upload/deletion completion handling.
The project-tree controller composes the hook and forwards its existing public
members. Tree synchronization, comparison, drag/drop interpretation and the
modal implementations retain their existing owners.

Keep the synchronous conversion/duplication guard, action-lifetime checks and
fresh-tree reconciliation together. Obsolete completions still reconcile
accepted mutations while suppressing stale presentation. Download target and
visibility remain independent so closing and reopening preserves the mounted
export job. Merge close restores focus to a connected opener.
Committed-folder expansion flattens the fresh tree once and uses its current
location. The existing conversion/duplication scenario includes a copy moved
under another parent before reconciliation, preserving coverage of stable
identity and ancestor expansion.

Controlled-response browser cases cover changing project selection during
duplication success and conversion rejection. Existing bundle browser scenarios
cover modal lifetime, focus, capability fallback, uncertain outcomes and tree
synchronization. The [separation record](bundle-actions-separation-plan.md)
contains verification results and the extraction's behavior contract.

An adjacent review reproduced an older deletion race. The editor chose its
target by path despite receiving the deleted project ID, so a delayed result
could close and clear a replacement project. Deletion now uses that ID for tab,
revision and local-state cleanup, with normalized-path compatibility for older
callers. Dashboard selection follows the editor's actual close transition.
Regression checks cover path reuse, a moved/deleted tab, an already-closed tab
and legacy commands, plus receipt recovery after selecting another project.
An additional browser reproduction found that deletion could finish before an
earlier project load and leave the deleted member open. Deletion now shares the
existing project-command queue, preserving receive order with opens, refreshes,
path moves and reconciliation. Its regression holds the real editor's project
load until the server deletion completes, then verifies the member tab closes.
Command context reads project, tab and loaded-path state from the Jotai store
instead of mirrored React refs. This makes the preceding queued command's
updates visible immediately and removes three redundant refs and two props.
Keep the two real-editor deletion regressions and their acknowledged project-ID
checks. Pending menu guards share the navigation scenarios, common deletion
presentation is checked once, and failed-reload assertions stay with the
conflict-settlement test. This removes duplicate setups while keeping coverage
of path reuse, command ordering, explicit confirmation and uncertain outcomes.

## 2026-11-15 - Evaluation HTTP Ownership

The Evaluation API previously combined shared-library operations, hosted job
controls and run evidence in one file. `hosted-evaluation-http.ts` and
`evaluation-library-http.ts` now register their five handlers each on the
original router. The parent keeps thirteen run/evidence handlers, both parsers
and five existing exports. Stores, scheduling, notifications and workflow
execution are unchanged; registration occurs only at startup.

Full-app HTTP tests cover authorization before parsing, hosted admission/error
translation, disabled submissions with accessible state/cancel, and coordinator
ownership of deletion. A real filesystem-library scenario checks revision
conflicts, ordered notifications, idempotent imports and an accepted mutation
finishing exactly once after its client disconnects. Preserve these behavior
checks rather than introducing permanent source-shape tests. Suite normalization,
in-use dataset rejection and atomic suite/dataset removal also run through the
real HTTP route; invalid hosted-state queries must not reach the coordinator. The
[separation record](evaluation-http-separation-plan.md) holds local verification
and timing evidence.

An adjacent review found an older stream-opening race: a library mutation could
finish between the initial revision read and notification subscription. The
stream owner now subscribes before that read and retains only the latest event
until handover, with epoch and failed/disconnected-read handling. This correction
uses one snapshot read and changes no workflow execution path.

Keep library import/conflict coverage in the real HTTP library fixture and the
incremental-run fixture focused on start, progress and finalization. Shared
profile tests own authentication coverage. Stream races use complete parsed
events and controlled handoffs; isolated event tests retain only reset/error
cases that cannot be exercised conveniently through normal HTTP. Avoid copying
the same setup or adding sleeps to prove ordering.

## 2026-11-14 - App Settings Upgrade And Migration HTTP Ownership

`local-upgrade-http.ts` owns sixteen local-upgrade handlers and their download
guard; `vm-migration-http.ts` owns ten VM migration handlers and four schemas.
The parent App Settings router keeps its three parser instances, early VM guard,
ordinary settings and compatibility exports. Handler bodies, middleware order
and the existing service singletons are preserved, with no added execution work.

Profile tests retain authorization-before-parsing, exact body limits, storage
error responses and route absence on execution/evaluation. Recordings,
publication and storage-operator routes share one server fixture per profile;
keep their distinct assertions without duplicating setup. The isolated backup
and repair scenarios exercise pre-header errors, post-header failures and
client-disconnected responses retaining accepted work until the callback settles.
Completion observes the real accepted-work release, without an event-loop delay;
stream consumers reject premature closure even when no `error` event is emitted.
Direct status-read checks retain operator authorization without mutation intent.
Full-app checks also establish that trusted-client access to ordinary settings
cannot bypass either migration guard, including when ordinary UI authentication
is disabled. Download tests reject timeout-driven closure as false evidence of
correct callback cleanup.
The migration browser fixture now supplies setup eligibility so tab visibility
does not depend on an ambient server. See the
[separation record](app-settings-http-separation-plan.md) for local results.

## 2026-11-14 - Publication And Version-history HTTP Ownership

`publication-http.ts` owns the thirteen publication/history handlers and their
schemas. Two registration calls preserve the original blocks and leave reference
routes between them; no nested router or request-time abstraction is added.
The existing parser, notifier, publication services and storage owners are reused.

The history fixture exercises actual HTTP reads, downloads, annotations and
restoration while checking saved bytes, unchanged state after rejection, and tree
notifications, including binary dataset restoration through HTTP. Recording and
publication checks share full-app fixtures per profile and preserve authentication
before parsing and route absence on execution/evaluation. Existing publication,
endpoint access and web-app suites retain execution-dependent behavior. See the
[separation record](publication-http-separation-plan.md) for local evidence.

## 2026-11-14 - Recording And Run-statistics HTTP Ownership

The workflow parent router mixed recording browsing, input search, replay and
statistics with unrelated project mutations and publication routes.
`recording-http.ts` now owns the ten recording/statistics registrations and
their six schemas. A single registration call keeps the existing router,
middleware instances and ordering; no extra router traversal or execution work
is introduced. Search, storage and execution implementations remain unchanged.

`api-profile.test.ts` checks route exposure and operator access in all four
profiles; remaining shared validation branches run once on the control profile.
`workflow-recordings-http.test.ts` uses the control API harness and directly
persisted fixtures for browsing and deletion. Actual execution-to-recording tests
keep the execution harness. Its cancellation test checks that disconnecting one
of two searches cancels only its input read, retains accepted work until
completion and forwards ordinary failures. Completion checks use the accepted-work
drain rather than an event-loop timing assumption.
The [implementation record](recording-http-separation-plan.md) contains the
structural comparison, compiled measurements and browser verification. Keep
that distinction: mocked browser journeys prove UI compatibility; actual API
tests and compiled probes exercise the handlers.

## 2026-11-14 - Web-app HTTP And Workflow Endpoint Ownership

### Why

One module owned six routers, mixing workflow bearer authorization and execution
with web-app browser authorization, action preparation and HTML rendering. The
shared runtime/session owners already existed; combining HTTP and WebSocket
execution would change their deliberate lifecycle differences.

### Ownership

- `web-app-http.ts` owns published/latest web-app HTTP routes, including one
  shared action-preflight counter and prepared-request map.
- `execution.ts` owns workflow endpoints and keeps all compatibility exports.
- `execution-http-support.ts` owns common response/timing/telemetry functions
  and published capacity acquisition. Function bodies and request ordering are
  preserved apart from removing the unreachable missing-graph branch after
  successful preflight; this is not another middleware or execution framework.
- App mounts, shared runtime options, `ExecutionSession`, storage adapters and
  the WebSocket gateway remain unchanged.

### Verification To Preserve

- Profile and body-admission tests retain authorization-before-parsing, dynamic
  paths and distinct error envelopes. Web-app HTTP/Socket tests cover revisions,
  browser storage, context filtering and recordings. A missing draft UI graph
  must still reject malformed action JSON with 404 before parsing, while its
  published snapshot remains executable.
- `workflow-async-process.test.ts` retains real early-response, client-loss,
  concurrent-request and shutdown coverage; registry unit tests alone do not
  prove that routes hold their permits through physical completion.
- The [separation record](web-app-http-separation-plan.md) tracks local checks
  and paired HTTP measurements. Timing measurements count complete responses
  and persisted recordings; queue drain alone cannot prove recording success.
- Published/latest HTML and JSON snapshot checks share a fixture while asserting
  each surface separately. Coordinator and preflight unit tests advance controlled
  clocks; actual HTTP, WebSocket and process-shutdown tests retain their real
  transport coverage.

## 2026-11-14 - Workflow Storage Compatibility Facade

### Why

The workflow storage facade mixed routing with filesystem transactions, project
materialization and repeated publication dispatch. SQL backends already shared
narrow repository contracts; forcing legacy filesystem storage into the same
combined adapter would hide real result and path differences.

### Ownership

- `legacy-project-storage.ts` owns filesystem tree/hosted IO and identity-safe
  save orchestration around the existing transaction helper. Derived statistics
  remain post-commit, with execution invalidation guaranteed by `finally`.
- `legacy-execution-storage.ts` owns filesystem execution/reference loading and
  cache/policy invalidation. One web-app loader handles published snapshots and
  saved drafts without duplicating materialization. `filesystem-project-identity.ts`
  shares the physical ID scan between save reconciliation and Subgraph resolution.
- `storage-backend.ts` keeps compatibility exports and shared routing/policy.
  One publication-selector callback replaces seven private dispatch helpers.
  Command snapshots, invalid-command error precedence and legacy writer admission
  retain their existing timing. Recording persistence reuses its existing option
  contract and remains asynchronous.
- `WorkflowStorageServices` and serving/offline resource composition are
  unchanged. No schema, stored format, protocol, cache design or feature changed.

### Verification To Preserve

- `hosted-project-title.test.ts` checks legacy save result shape, save identity
  and request capture before waiting and after file promotion. Returned and tree
  revisions must describe the stored project/dataset pair. Stale-save conflicts
  cover project-only and dataset-only edits independently; fixture cleanup has
  one suite owner.
- The hosted Save As browser case verifies new project identity and a subsequent
  in-place save against disposable PostgreSQL/MinIO. Its forwarded browser routes
  drain before the API fixture closes, preserving failure evidence and cleanup.
- `workflow-publication-filesystem.test.ts` covers snapshots, unknown-command
  rejection before storage construction and writer ordering against a later read.
- Existing execution/cache, tree, web-app, SQLite, recording and owner suites
  remain the behavior checks. `test:async-managed` exercises actual managed
  serving with local PostgreSQL/MinIO; mocked browser cases prove UI compatibility.
- The existing local-upgrade runtime's ordinary SQLite serving case checks the
  real facade's save, publish, published/latest split and unpublish, while the
  parent checks that the retained legacy files are unchanged. Adapter-only tests
  do not replace this routing coverage.
- `workflow-execution-filesystem.test.ts` verifies saved graphs are refreshed
  without rebuilding the routing index, including after statistics writes fail.
  Equal-size edits retain the original file timestamp so metadata revalidation
  cannot conceal missing invalidation. Assert returned graphs instead of private
  cache-method calls.
- Backup status tests create only private control storage. Archive tests add real
  source files and fingerprint them; status-only cases need no recording payload
  or source-tree scan.
- See [workflow-storage-routing-plan.md](./workflow-storage-routing-plan.md) for
  the selected browser checks and paired endpoint measurements.

Final verification also isolated an existing Windows local-upgrade defect:
status readers could make atomic progress-file replacement fail with `EPERM`.
The separate control-record fix retries only the same frozen record's promotion,
with a small Windows-only bound; preparation, backup status and repair-journal
writers share that primitive. It never repeats work or changes endpoint IO.
Real-handle regressions fail before the repair and pass afterward. Backup-status
failure also cleans its owned temporary file while preserving prior evidence.

## 2026-09-03 - Crash-Safe Filesystem Project Saves

### Why

The filesystem hosted-save path previously replaced `.rivet-project` before writing or deleting `.rivet-data`. An ordinary sidecar error or process termination between those operations could expose two different save generations while still leaving callers unsure which part committed.

### Ownership

- `filesystem-project-transactions.ts` owns validation, exclusive staging, checksummed journals, backup/promotion order, the durable committed marker, cleanup, startup and path-specific recovery, the storage capability probe, and the shared filesystem read/write coordinator.
- `legacy-project-storage.ts` now keeps hosted identity validation and calls the injected execution invalidator; `storage-backend.ts` selects it for filesystem IO. Canonical project/dataset persistence crosses the transaction helper. Derived project statistics update only after the committed marker and are never recovery evidence.
- Server startup does not listen until recovery completes. Ambiguous evidence fails closed and remains on disk. Shutdown drains the coordinator, while hard-stop correctness comes from journal recovery.
- The Kubernetes chart remains managed-storage-only and singleton at the backend. Its StatefulSet uses ordered, single-ordinal rolling replacement—the StatefulSet equivalent of a no-overlap Recreate rollout—and execution replicas remain the scaling boundary.
- This closes mixed filesystem project/dataset generations. Stale-revision conflict detection between administrators remains separate work; the save-target identity check prevents cross-project writes but does not reject two edits based on the same older revision.

### Verification To Preserve

- Transaction checkpoints: `yarn workspace @valerypopoff/rivet-studio-server-api run test:files -- src/tests/filesystem-project-transactions.test.ts`
- Hosted save and tree invalidation: `yarn workspace @valerypopoff/rivet-studio-server-api run test:files -- src/tests/hosted-project-title.test.ts src/tests/workflow-filesystem-tree.test.ts`
- API build and full suite: `yarn workspace @valerypopoff/rivet-studio-server-api run build` and `yarn workspace @valerypopoff/rivet-studio-server-api run test`
- Kubernetes render/contract gate: `yarn studio-server:verify:kubernetes`

## 2026-07-14 - Settings Repository And Frontend Orchestration Split

### Why

App Settings had grown into one modal with independent copies of loading, normalization, dirty tracking, and persistence logic, while API settings domains each performed their own filesystem reads and writes. The workflow-library controller and editor bridge had also accumulated unrelated state machines in single modules. This made small domain changes risky and allowed one request to observe settings from different moments.

### Ownership

- `packages/studio-server-api/src/app-settings/settings-repository.ts` owns cached immutable settings snapshots, schema versions/migrations, atomic revisioned updates, external-file refresh, subscriptions, and request-scoped snapshot capture. Refreshes and writes are serialized per settings file so the external-file poller cannot restore a stale read over a completed UI save. Domain files keep only their defaults, validation, public/private projection, and typed runtime accessors.
- `captureAppSettingsSnapshot` captures every registered domain synchronously at request entry. Runtime request handlers must use domain repository accessors instead of reading settings JSON directly.
- `/api/app-settings/*` uses shared GET/PATCH wiring with `ETag` and `If-Match`. A stale browser save returns `409`; the web form layer refreshes its baseline while preserving the user's current edits for review and retry.
- `AppSettingsModal.tsx` is a composition shell. Domain forms live under `packages/studio-server-web/dashboard/app-settings/` and share `useSettingsFormResource.ts`; the modal presents one Save/Revert row for the active tab and persists every changed domain section in that tab. Route-config callbacks use functional state updates, so concurrent route/auth saves cannot restore stale route fields.
- `EditorMessageBridge.tsx` composes `useEditorCommandBridge.ts`, `usePreviewProjectLifecycle.ts`, `useWorkflowRecordingBridge.ts`, and `useEditorBridgeInteractions.ts`. The command hook owns only origin validation, dispatch, and FIFO ordering; project-open, detached preview/replay, and delete/path-move implementations live in the focused `editorProject*Commands.ts` modules.
- `useWorkflowLibraryController.ts` composes focused tree, selection, drag/drop, mutation, saved-version, and retained-recordings hooks. Path moves still converge on one acknowledged editor-bridge operation.
- App Settings, Project Settings, published-version history, and workflow overlay CSS live in focused files imported by `WorkflowLibraryPanel.css`; selector behavior and cascade intent remain unchanged.

### Verification To Preserve

- Repository and App Settings tests: `yarn workspace @valerypopoff/rivet-studio-server-api run test:files -- src/tests/settings-repository.test.ts src/tests/app-settings.test.ts`
- API and web production builds: `yarn workspace @valerypopoff/rivet-studio-server-api run build` and `yarn workspace @valerypopoff/rivet-studio-server-web run build`
- Pure web and style guards: `yarn studio-server:verify:web-pure` and `yarn studio-server:verify:test-style`
- Browser-visible dashboard/editor behavior: set `PLAYWRIGHT_HEADLESS=1` and `PLAYWRIGHT_SLOW_MO=0`, then run `yarn studio-server:ui:observe`
- Full non-browser gate: `yarn studio-server:test`

## 2026-05-21 - Test Refactor Final Prune

### Why

After the workflow, static-contract, managed-storage, Playwright, and style-guardrail phases landed, the remaining risk was drift from leftover compatibility files or helper exports that no longer had a real owner. Phase 7 closed that loop without changing product behavior.

### Ownership

- Retired or merged-away suites remain deleted: `workflow-services.test.ts`, `workflow-publication.test.ts`, `phase4-static-contract.test.ts`, and `managed-backend-sql.test.ts`.
- `deploy/studio-server/scripts/verify-test-style.mjs` remains the cheap guard that prevents those suite names and hidden nested test files from returning.
- Shared test helpers should keep active call sites. Do not keep an unused helper as a placeholder for possible future suites; add it back when a real second call site appears.

### Verification To Preserve

- API build: `yarn workspace @valerypopoff/rivet-studio-server-api run build`
- Default API suite: `yarn workspace @valerypopoff/rivet-studio-server-api run test`
- Test style guard: `yarn studio-server:verify:test-style`
- Pure web helper command: `yarn studio-server:verify:web-pure`
- Repo structure guard: `yarn studio-server:verify:repo-structure`
- Kubernetes render contracts when static helpers or chart-facing contracts change: `yarn studio-server:verify:kubernetes`

## 2026-05-21 - Playwright Suite Review

### Why

The browser specs were useful, but a few of them mixed UI/controller contracts with real storage mutation. That made routine Playwright runs heavier and riskier, especially in managed or S3-backed environments where a UI-only assertion should not create durable workflow state.

### Ownership

- `hosted-editor-observe.spec.ts` owns the manual observable hosted-editor focus and clipboard recovery flow. It now mocks workflow tree/project load responses, then opens the real iframe editor without creating or deleting workflow storage.
- `project-settings-modal.spec.ts` is split between publish controls and published-version-history actions, so publish validation/delete ownership does not share one large scenario with history pagination, star, preview, and restore behavior.
- `run-recordings-modal.spec.ts` is split between input filter/pagination/menu-portal behavior and replay/delete behavior.
- Specs that mutate real workflow state remain limited to persistence/path contracts and must keep managed-mode mutation guards explicit.

### Verification To Preserve

- Test style guard: `yarn studio-server:verify:test-style`
- Repo structure guard: `yarn studio-server:verify:repo-structure`
- Browser-visible spec changes: `PLAYWRIGHT_HEADLESS=1`, `PLAYWRIGHT_SLOW_MO=0`, `yarn studio-server:ui:observe`

## 2026-05-21 - Managed Publication Test Split

### Why

`managed-backend-sql.test.ts` mixed true SQL/schema invariants with source-string checks against managed publication implementation details. That made publication refactors noisy even when the managed service contract stayed correct.

### Ownership

- `managed-workflow-schema.test.ts` owns managed DDL contracts, folder-move wildcard escaping, published-version schema shape, and published/latest execution lookup query contracts.
- The schema test imports `MANAGED_WORKFLOW_SCHEMA_SQL` instead of reading `schema.ts` as text, so TypeScript template-literal escaping bugs are covered by the same SQL string the app sends to Postgres.
- `managed-publication-history.test.ts` owns managed publication behavior through a mocked transaction context: legacy history backfill, normal and legacy restore-as-new-publish, restore invalidation, star persistence, and save-target selection.
- `managed-backend-sql.test.ts` is retired and should not be reintroduced.

### Verification To Preserve

- Default API suite: `yarn workspace @valerypopoff/rivet-studio-server-api run test`
- Test style guard: `yarn studio-server:verify:test-style`

## 2026-05-21 - Test Style Guardrails

### Why

After the workflow and static-contract suite split, the next failure mode was command drift: a new test file could be forgotten in `packages/studio-server-api/package.json`, Kubernetes tests could slip back into the default API suite, or a temporary `.only` could land because the repo had no cheap style check for test files.

### Ownership

- `deploy/studio-server/scripts/verify-test-style.mjs` owns test command manifests and style guardrails.
- Root `yarn studio-server:test` must compose the non-browser repo-local gate after the standard `pretest` dependency bootstrap: API build, default API tests, pure web tests, test-style guardrails, repo-structure guardrails, and Kubernetes launcher/chart contracts.
- The default API test command must list every non-Kubernetes API test exactly once.
- `verify:web-pure` must list every pure web test exactly once.
- `verify:kubernetes` owns `kubernetes-*.test.ts` API contract tests plus the Helm render verifier.
- Runnable API, pure web, and Playwright test files stay in their expected top-level suite folders so helper directories cannot become hidden suites.
- Retired mixed/broad suites such as `managed-backend-sql.test.ts`, `workflow-services.test.ts`, and `phase4-static-contract.test.ts` must not be reintroduced.
- Wrapper tests and helpers must not assert upstream `packages/app/src` implementation shapes beyond the approved host entry/style seam; use wrapper seams, focused helper tests, or `deploy/studio-server/scripts/update-check.sh` for upstream compatibility scanning.

### Verification To Preserve

- Test style guard: `yarn studio-server:verify:test-style`
- Repo structure guard: `yarn studio-server:verify:repo-structure`
- Pure web helper command still proves command manifest alignment: `yarn studio-server:verify:web-pure`

## 2026-05-21 - Static Contract Test Reduction

### Why

`phase4-static-contract.test.ts` had become a second implementation checklist for proxy templates, Dockerfiles, CI YAML, hosted editor seams, upstream Rivet source shapes, UI behavior, docs wording, and Helm chart contracts. That made harmless refactors noisy and kept Helm in the default API test path.

The static coverage is now split by contract boundary, with Kubernetes render checks isolated behind the Kubernetes verification command.

### Ownership

- `proxy-image-contract.test.ts` owns proxy route ownership, proxy timeout behavior, UI-gate prompt staging, API/executor image contracts, GHCR login/tag/publish behavior, and production launcher image behavior.
- `hosted-editor-seams.test.ts` owns wrapper-facing hosted editor seams: `RivetAppHost` mounting, provider injection, workspace command bridge usage, hosted file-menu policy, hosted executor URL wiring, shortcut shims, and stale override removal.
- `kubernetes-contract.test.ts` owns Helm/chart topology assertions and runs through `yarn studio-server:verify:kubernetes`, not the default API test command.
- Before the monorepo import, the Kubernetes contract also guarded the two
  filtered Rivet Docker contexts. The monorepo migration retired those
  secondary contexts; current images build from the repository root and are
  guarded by direct workspace-copy assertions instead.
- `verify:repo-structure` owns structural guardrails such as shell-script LF normalization.
- `verify:web-pure` owns exported web helper contracts such as hosted shortcut matching, Vite override alias selection, and alignment between active module overrides and `deploy/studio-server/scripts/update-check.sh`.

### Verification To Preserve

- API build: `yarn workspace @valerypopoff/rivet-studio-server-api run build`
- Focused static contract run: `yarn workspace @valerypopoff/rivet-studio-server-api exec tsx --test packages/studio-server-api/src/tests/proxy-image-contract.test.ts packages/studio-server-api/src/tests/hosted-editor-seams.test.ts`
- Web pure helpers: `yarn studio-server:verify:web-pure`
- Repo structure guard: `yarn studio-server:verify:repo-structure`
- Kubernetes render contracts: `yarn studio-server:verify:kubernetes`

## 2026-05-21 - Workflow API Test Suite Split

### Why

`workflow-services.test.ts` had become a mixed API suite covering workflow-tree mutations, copy/import/export routes, publication state, published-version history, endpoint execution, execution-cache behavior, and recordings. That made future cleanup risky because unrelated workflow contracts lived behind one file name and one local setup block.

The workflow API tests are now split by behavior domain so a future change has an obvious home and can run a smaller focused suite before the full API test command.

### Ownership

- `workflow-filesystem-tree.test.ts` owns filesystem workflow-tree CRUD, sidecars, duplicate/upload/download flows, and their HTTP route coverage.
- `workflow-publication-filesystem.test.ts` owns filesystem publication state, endpoint reservation and uniqueness, full unpublish behavior, and published/latest source selection rules.
- `workflow-published-history-filesystem.test.ts` owns filesystem published-version history, legacy fallback, star/restore behavior, and restore cache invalidation.
- `workflow-execution-filesystem.test.ts` owns filesystem endpoint execution contracts, request context normalization, execution-cache refresh behavior, debug headers, and missing-root recovery.
- `workflow-recordings-http.test.ts` owns recording-producing endpoint runs plus recording list/filter/delete/cleanup route behavior.
- `workflow-filesystem-suite-harness.ts` owns the shared temp-root/env bootstrap, temp-root cleanup, and dynamic workflow-module import ordering for those split suites.

### Verification To Preserve

- API build: `yarn workspace @valerypopoff/rivet-studio-server-api run build`
- Focused split-suite run: `yarn workspace @valerypopoff/rivet-studio-server-api run test:files src/tests/workflow-filesystem-tree.test.ts src/tests/workflow-publication-filesystem.test.ts src/tests/workflow-published-history-filesystem.test.ts src/tests/workflow-execution-filesystem.test.ts src/tests/workflow-recordings-http.test.ts` from the monorepo root
- Full API suite: `yarn workspace @valerypopoff/rivet-studio-server-api run test`
- Repo structure guard: `yarn studio-server:verify:repo-structure`

## 2026-05-19 - Published Version History

### Why

Publishing a workflow used to behave like a single mutable pointer: publishing overwrote the current stored snapshot, and unpublishing removed that snapshot. That made it impossible to inspect or recover earlier published states after repeated publishes.

The dashboard now treats each successful publish as a durable version-history entry. Project Settings exposes that history so an operator can download, preview, star, label with comments, or restore notable published versions without reconnecting preview snapshots to the editable source project.

### Ownership

- Filesystem mode stores history under the workflow root's hidden `.published/` directory.
- Managed mode stores history in Postgres `workflow_published_versions`, pointing at immutable workflow revision blobs in object storage.
- The editor preview path is a wrapper-owned virtual path, not a real workflow project path.
- Published-version previews are detached and read-only; they must not become publishable workflow-tree projects.

### Important Details

- Every publish creates a new version id. The current published endpoint points at the newest version, while older versions stay in history.
- Starred state and short operator comments are durable server state, not browser state.
- Restore creates a new current history entry from the selected version instead of moving the current pointer back to an existing row.
- Restoring also replaces the saved live project/dataset with the selected snapshot so the project status remains coherent after restore.
- After restore, the dashboard sends `refresh-open-project-from-disk` for the restored path. If that project is active, the editor replaces the current tab from storage with `reloadFromDisk`; if it is open in a hidden tab, the editor clears that hidden tab's cached snapshot/session so switching back reloads from storage without stealing focus.
- Filesystem restore is not transactional, so the restore path backs up the live project/dataset before overwriting it and restores those bytes plus the old settings if a later published-artifact or settings write fails.
- Filesystem restore rejects a stored snapshot whose embedded project id no longer matches the history owner, which keeps a corrupt history artifact from changing the live workflow identity.
- Legacy already-published projects are backfilled into history before a later publish or unpublish can clear their only current pointer.
- In filesystem mode, the metadata filename is the authoritative version id. A mismatched internal JSON `id` is ignored so a stale metadata file cannot redirect actions to another snapshot.
- Duplicating or uploading a project creates a fresh workflow id, so published history does not copy across.
- Deleting a project deletes its published version history along with live project sidecars and recording history.

### Key Files

- `packages/studio-server-api/src/routes/workflows/published-versions.ts`
- `packages/studio-server-api/src/routes/workflows/workflow-mutations.ts`
- `packages/studio-server-api/src/routes/workflows/managed/publication.ts`
- `packages/studio-server-shared/workflow-types.ts`
- `packages/studio-server-shared/editor-bridge.ts`
- `packages/studio-server-web/dashboard/WorkflowPublishedVersionHistoryModal.tsx`
- `packages/studio-server-web/io/HostedIOProvider.ts`
- `docs/workflow-publication.md`
- `docs/editor-bridge.md`

### Verification To Preserve

- API build: `yarn workspace @valerypopoff/rivet-studio-server-api run build`
- Web build: `yarn workspace @valerypopoff/rivet-studio-server-web run build`
- Filesystem history tests for multiple publishes, legacy backfill, star persistence, restore, and mismatched metadata ids
- Managed SQL/schema tests for `published_version_id`, `workflow_published_versions`, `is_starred`, and restore pointer updates
- Playwright Project Settings modal coverage for history visibility, pagination, star persistence, preview opening, and restore confirmation
