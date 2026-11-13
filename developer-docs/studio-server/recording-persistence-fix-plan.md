# Recording persistence after failed LLM profile chains

Status: implemented and validated locally, 2026-11-13. Staging qualification and
production deployment remain separate release steps through the normal pipeline.

## Implementation and local verification

- Runtime capture/write settings have their own environment-only reader. Managed,
  SQLite and filesystem writes no longer read retention settings to serialize or
  compress a recording. Live authorization and deletion policy remain strict.
- The queue's initial validated capacity and repository subscription are bound
  through the existing storage initialization/disposal facade. Initialization
  races, unchanged seeds, stale cache, overflow and owner replacement are covered.
- Legacy first writes establish the index without requesting cleanup. Startup
  cleanup remains ordered, and its failure does not invalidate the index.
- Post-save callback errors are reported separately and cannot remove the replay
  or cause another insert. Queue and direct-upload diagnostics carry bounded
  identifiers and a safe failure classification.
- The follow-up review reproduced a notification error whose throwing accessor
  escaped diagnostic reporting and reached the filesystem writer's rollback.
  All diagnostic inspection now runs inside its non-throwing boundary, and
  post-save notifications sit outside the filesystem rollback scope. Regressions
  cover error accessors, a failed logger, the next queued write and the retained
  indexed artifact.
- The adjacent-path review reproduced a scheduled replay lost to a dataset
  export even though dataset capture was disabled. Schedules now consult the
  shared runtime policy before exporting. It also reproduced logging failures
  escaping cleanup and queue-overflow handling; these reports are now best
  effort without changing retention or admission decisions.
- Hosted Node previews now capture recordings. Tests cover exhausted profiles,
  early answers followed by failure, overlapping requests and incomplete history.

Validation completed locally:

- Focused API suites for managed settings, queue, all recording backends,
  published/latest and web-app execution, schedules and debugger channels. A
  debugger test harness that skipped storage initialization was corrected and
  its entire suite rerun successfully. The exhaustion integration also expires
  live policy during serialization and checks the subsequent run.
- 96 editor/executor/recording tests and 29 headless Playwright checks passed.
- API and App TypeScript checks, source/test-style and documentation checks passed.
  Targeted lint is clean outside 16 pre-existing violations in the SQLite and
  storage facades; linting their HEAD contents reproduces the same violations.
- The 21-case hosted-executor browser suite passed in about 2.7 minutes locally;
  its CI balancing hint includes the added recording cases.
- The follow-up and adjacent-path reviews passed 192 tests across nine API
  suites, including notification rollback, queue/cleanup logging failures and
  scheduled dataset exclusion, along with API type checking, scoped lint,
  test-style and documentation-link checks. These reviews changed no browser
  behavior; the prior browser checks remain applicable.
- A synthetic local serializer check measured about 38 ms for 1 MiB and 297 ms
  for 8 MiB; compression took about 4/18 ms and local writes under 1 ms. These
  single-machine samples do not establish the cause or duration of production
  stalls, and were not used to alter resource limits or truncate recordings.

The sections below retain the implemented requirements and release limits. The
shared writer/queue repair and hosted preview capture ship together.

## Goal and evidence

An enabled, fully captured run must remain recordable when its LLM profiles are
exhausted. This includes published/latest endpoints, published web-app actions,
ordinary editor execution and hosted editor web-app previews. Successful runs
must retain the same behavior.

The investigation confirmed:

- Exhaustion is a normal node failure. The processor settles and its recorder can
  serialize and replay the failure. Local published/latest API tests with two
  synthetic HTTP-503 providers already persist failed recordings successfully.
- Production queued recording writes have failed in the dataset-policy check
  with `Managed app settings synchronization is unavailable or stale.` The queue
  reports the failure and does not retain that task for later recovery.
- The combined recording configuration reader loads live queue/retention limits
  even when its caller only needs environment-defined dataset or compression
  settings. A settings-age transition during serialization reproduces the loss.
- Hosted Node preview persistence is separately excluded by the
  `options.webAppStorage === undefined` eligibility condition.
- The SQLite recording writer also uses the combined configuration reader. It
  needs the runtime-reader change even though the observed production failures
  came from managed storage.

Production endpoint logs strongly correlate the persistence errors with the
reported chat app. They do not identify individual exhausted runs. Production
serialization duration and the original source of the worker stalls remain
unmeasured. Private logs, project names and diagnostic fixtures stay outside Git.

## Design

Separate the configuration needed to save an artifact from the live limits used
to admit queued work and delete old artifacts. Fix the dependency that creates
the demonstrated exception; a general retry queue is unnecessary for this repair.

| Concern                                                            | Owner and behavior                                                                                                            |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| Recording enabled, capture options, dataset inclusion, compression | Environment-derived runtime configuration; no managed-settings read                                                           |
| Pending-write limit                                                | Queue-owned last successfully validated limit, initialized before admission and updated by the existing settings subscription |
| Retention age/count/total bytes                                    | Existing maintenance owner; validate policy before deletion and defer cleanup if policy is unavailable                        |
| Selected database/blob backend                                     | Existing initialized storage-services owner; no alternate backend or credential fallback                                      |
| Endpoint/editor authorization                                      | Existing fresh authorization checks, independent of recording configuration                                                   |

The queue's saved capacity limit is a resource bound, not an authorization or
data-retention bypass. Never add a general public `read stale settings` helper,
extend the global freshness timeout, or pin all app settings for a long-lived
WebSocket. Preserve existing explicit zero/unlimited queue-limit semantics.

## 1. Add the failing regressions before changing behavior

Owning tests:

- `packages/studio-server-api/src/tests/managed-settings-sync.test.ts`
- `packages/studio-server-api/src/tests/recordings-store.test.ts`
- `packages/studio-server-api/src/tests/managed-recordings.test.ts`
- `packages/studio-server-api/src/tests/workflow-recordings-http.test.ts`
- `packages/studio-server-api/src/tests/sqlite-workflow-backend.test.ts`, using
  its real temporary catalog fixtures

Promote the demonstrated settings-expiry case into maintained tests. Use the real
managed-settings freshness implementation with mocked PostgreSQL I/O and a
controlled clock; no real database or provider is required. Expire the cache
during recording serialization and replay-project serialization. Also start an
otherwise valid save while the settings cache is already stale.

Assert that authorization/current-settings readers still reject stale policy,
while the recording write completes once with unchanged replay evidence. Include
the managed blob-upload path: its compression reader is a second occurrence of
the same dependency. The old code must fail these assertions for the intended
reason, rather than an uninitialized test repository or malformed fixture.

Cover the SQLite writer and a legacy filesystem first save, not just an already
initialized root. Run the production regression outside an inherited HTTP
settings snapshot, which could otherwise hide the stale-cache bug.

## 2. Split recording runtime configuration from live limits

Owning files:

- `packages/studio-server-api/src/routes/workflows/recordings-config.ts`
- `packages/studio-server-api/src/routes/workflows/recordings.ts`
- `packages/studio-server-api/src/routes/workflows/managed/revision-factory.ts`
- `packages/studio-server-api/src/routes/workflows/storage-backend.ts`
- `packages/studio-server-api/src/local-metadata/sqlite-workflow-backend.ts`

Add one narrow environment-only runtime reader/type. Keep the existing combined
reader where maintenance or compatibility callers genuinely need it. Route
`isWorkflowRecordingEnabled`, recorder options and dataset-inclusion decisions
through the runtime reader. Filesystem writing, SQLite recording persistence and
managed compression must also use it; changing only
`shouldSnapshotWorkflowRecordingDatasets` would leave another failure later in
the same write. SQLite's separate `cleanupRecordings` reader must continue to
require validated retention policy.

Keep defaults, environment parsing, compression encoding and artifact formats
unchanged. Dataset filtering stays server-owned for every producer, including
editor uploads and called-project runs. No client-supplied configuration may
override it. Retention readers continue to require validated live policy.

Audit the complete write path through the already selected storage-services
instance. Ordinary saves must not reconstruct storage configuration after
serialization or run retention cleanup as a prerequisite to a save. Preserve
startup validation and existing backend/generation ownership checks.

Legacy `ensureStorage` previously rebuilt the index and ran cleanup together.
The write path now requests required storage/index readiness independently, so a
first save can establish its index without waiting for retention policy to
recover. Cleanup retains its existing startup/maintenance owner; no periodic job
was added, and required index failures still reject. Offline migration retains
its `skipCleanup` behavior. An unavailable cleanup policy is a logged/deferred
maintenance outcome, not a failed recording-store initialization or a reason to
discard the first recording.

## 3. Keep queue admission and metrics independent of cache freshness

Owning files:

- `packages/studio-server-api/src/routes/workflows/recordings-store.ts`
- `packages/studio-server-api/src/routes/workflows/recordings.ts`
- `packages/studio-server-api/src/routes/workflows/storage-backend.ts` for its
  existing initialization/disposal facade

Initialize the queue's limit from a successful settings read before recording
admission opens in managed, SQLite and legacy modes. Use the existing repository
subscription to replace that validated scalar when the setting changes. Subscribe
and seed without a missed-update window: a later subscriber notification must
not be overwritten by an older initial-read result. Use callback order or a
local binding generation, not a content-hash revision as a sequence. A same-value
read may emit no notification, so seed from its validated return value as well.
Do not invent a second polling loop.

Prefer binding through `initializeWorkflowStorage`/`disposeWorkflowStorage`.
Server startup already initializes app settings before workflow storage. Other
supported entry points and test harnesses must use the same initialization;
direct queue unit tests should supply explicit validated policy/fixture setup.
Do not redesign `WorkflowStorageServices` or add another queue service to own
one scalar and an unsubscribe callback.

Admission and metrics read the queue's owned limit rather than synchronously
consulting managed app settings on every call. If initialization never succeeded,
fail explicitly instead of silently selecting unlimited/default capacity. A
temporary synchronization failure after initialization retains the last validated
limit. A lower limit applies to new admissions without deleting accepted work.

Preserve FIFO processing, current queue bounds and storage drain order. Stop
producers and finish accepted writes before disposing the policy binding; an
unconfirmed storage close must not detach it early. Reset between tests/storage
generations. An old app-data path, restore/bootstrap snapshot or late refresh
must not seed a new owner or reopen admission.

Do not retry graph execution, replay a workflow dispatch, or blindly repeat a
recording insert after an uncertain storage result. This repair introduces no
automatic storage-write retries. Real storage failures remain explicit failures.

## 4. Apply the common write behavior to every producer

Review these call sites against the same regression:

- `routes/workflows/execution.ts`: published/latest HTTP execution.
- `web-app-action-websocket.ts`: successful and failed web-app actions.
- `routes/workflows/web-app-execution.ts`: queued root recordings.
- `routes/workflows/subgraph-recordings.ts`: separate called-project recordings.
- `routes/workflows/local-editor-recordings.ts`: browser/Node editor uploads and
  called-project uploads.
- Scheduled execution callers of the shared persistence boundary.

Preserve each producer's eligibility rule. Scheduled runs require both
`draft.record` and the global recording switch; do not enable recordings for
schedules that opted out. Editor runs and previews still honor their recording
toggle and hosted capability.

Keep graph status, cost, execution identity, creation time and failure evidence
from the accepted run. Saving must not depend on response delivery or an editor
tab remaining active. A failure in recording persistence must not replace the
original graph error. Root and called-project records remain distinct.

Test uncaught and caught failures separately. Uncaught exhaustion records a
failed run. A graph that handles `Run failed` or a Subgraph's Error output keeps
its actual root outcome and records the failure evidence. Do not force every
run containing an exhausted node into root failure or merge cancellation and
unknown outcome into that status.

## 5. Enable recording capture for hosted Node previews

Owning files:

- `packages/app/src/hooks/useRemoteExecutor.ts`
- `packages/app/src/utils/editorRunRecording.ts`, only if necessary
- Existing editor recording and executor recovery tests

Remove the preview-only exclusion from otherwise eligible internal-hosted Node
execution. Retain the recording toggle, hosted capability/path validation,
request-scoped capture and one finalization per accepted request. This is not
a claim of exactly-once durable delivery across process loss or uncertain HTTP
acknowledgements.

A successful early chat answer is not full graph completion. Persist after the
actual root terminal event and accepted background work settle. Keep storage
patches and dataset operations attached to their current owners. Confirm that
published web-app execution still owns its separate server recording and does
not acquire a second editor recorder.

Exercise overlapping preview actions with distinct request/correlation IDs.
Closing or changing a tab must not move a late recording into another run. An
early answer followed by background failure must keep the real final outcome
without withdrawing the answer already delivered to the chat.

Keep the existing incomplete-diagnostics/unknown-outcome safeguards: enabling
preview capture must not label an incomplete replay complete or invent an error
after a successful response. Test both ordinary failure and the existing v2
session-recovery path, since that code is also changing in the current worktree.
Browser-mode preview execution must continue to produce one recording.

## 6. Make failures attributable without exposing run contents

Extend the existing queued task with optional diagnostic context: project ID,
graph ID when known, run kind/surface and execution correlation ID. Use that
context in queue-rejection and persistence-failure logs. Direct editor-upload
failures need equivalent context.

Use three producer-level phases: serialization, persistence and post-save
notification. A fixed safe error name/code plus those identifiers is sufficient;
do not add an exception framework or instrument every artifact/SQL step. Reuse
the existing best-effort health-outcome reporting helpers. Do not dump prompts,
raw provider bodies, credentials, project contents or arbitrary error causes.
Keep recording availability separate from execution success/failure. A failed
post-save notification must not imply that an already committed recording was
lost or cause another insert.

Measure serialization/preparation and write durations in the focused diagnostic
fixture. Do not add worker threads, truncate failure evidence, or increase Pod
resources unless measurements establish a separate problem requiring that work.

## Validation and completion criteria

| Case                                                 | Required result                                                                   |
| ---------------------------------------------------- | --------------------------------------------------------------------------------- |
| Cache expires during recording/project serialization | One replayable recording; no settings-staleness write failure                     |
| Cache already stale after queue initialization       | Admission respects the last validated bound; accepted recording persists          |
| Stale authorization or retention policy              | Authorization still rejects; destructive cleanup is deferred                      |
| Queue-limit update, overflow and shutdown            | Existing bounds apply; accepted work drains; no subscription leak or reopening    |
| Two synthetic providers return HTTP 503              | Failed published/latest and web-app-action recordings include exhaustion evidence |
| Ordinary editor and preview, Browser and hosted Node | One failed recording each when enabled; successful cases remain correct           |
| Called-project failure                               | Correct child recording plus the caller's own outcome, without duplicates         |
| Recording disabled / datasets excluded               | No bypass; no disabled recording or prohibited dataset artifact                   |
| Incomplete session history or lost executor          | Explicit unavailable/unknown evidence; no false complete recording                |
| Blob/SQL write fails or acknowledgement is uncertain | No automatic replay, duplicate insert or replacement of the graph error           |
| Post-save health-evidence notification fails         | Existing recording remains available; no second storage write                     |

Run focused API tests for configuration, settings freshness, queue behavior,
managed artifact persistence, HTTP recordings and web-app actions. Add cases to
the existing suites rather than introducing an independent test framework.
Use a shared exhaustion fixture and table-driven cases where harnesses match.
Prove cache-expiry behavior at the shared boundaries, then test producer-specific
ownership separately. Do not multiply every producer by every cache/toggle/fault
combination. Use focused local browser checks; normal required CI still applies.

Additional targeted cases required by the ownership review: SQLite and legacy
first-write behavior; initial-read/update races, same-value seeding and generation
reset; a schedule with `record=false`; a graph that catches exhaustion; and
concurrent previews with an early answer followed by a background failure.
Run affected App recording/recovery tests, API/App type checks, relevant lint,
test-style checks and documentation-link validation. Review the local CI notes
before any later commit/push and register new test files in existing discovery
or shard metadata if required.

Preview capture changes require headless Playwright, using the repo runner:

```powershell
$env:PLAYWRIGHT_HEADLESS = '1'
$env:PLAYWRIGHT_SLOW_MO = '0'
$env:PLAYWRIGHT_BASE_URL = 'http://127.0.0.1:8080' # Use the local app's actual URL.
yarn studio-server:ui:observe local-editor-recordings.spec.ts hosted-executor-origin.spec.ts
```

Use synthetic LLM responses and locally owned test storage. Inspect
`artifacts/playwright/` on failure. No Kubernetes rehearsal is needed for the
local repair. Finish by updating `architecture.md` and `editor-bridge.md` with
the implemented configuration/recording ownership, validation and actual limits.

## Release and limits of the repair

After local acceptance, publish through the normal develop/main CI process and
the existing staging-to-production release path when authorized. Verify a
synthetic exhausted-chain run in staging, recording discovery/replay and clean
shutdown before production. After production, observe new saves and bounded
diagnostics; use synthetic failures rather than replaying a user's real action.

Publication requires the deterministic cache-expiry regression, focused producer
tests, type/lint checks and focused browser checks to pass. A failed gate stops
progression for diagnosis. If later staging/production verification loses its
synthetic recording, stop progression and inspect the evidence; do not replay
the action automatically. General serialization optimization or durable retries
require a separately demonstrated problem and are outside this repair.

This plan adds no database migration, artifact-format change, service, permanent
cloud resource or new retry system. It prevents the demonstrated future loss;
recordings discarded before any durable write cannot be reconstructed by this
repair. Process crashes, genuine storage outages, disabled recording and explicit
capacity rejection remain different outcomes and must not be described as fixed.
