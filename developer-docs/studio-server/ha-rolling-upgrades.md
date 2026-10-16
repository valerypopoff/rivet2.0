# HA rolling-upgrade implementation status

## Required guarantee

The target is continuous request availability during planned upgrades, with
accepted executions finishing on their existing owners and durable outcomes
persisted once. Browser sockets may reconnect; reconnection must never replay an
uncertain execution. A long-running or paused execution may block retirement.
This is not a guarantee against simultaneous provider failure or arbitrary pod
termination. Legacy restore remains an explicitly destructive maintenance task.

## Implemented prerequisites

- An opt-in hosted executor session now has one process-local logical owner,
  independent of the current WebSocket. A separate 256-bit resume capability is
  sent only over the freshly authorized socket and presented in WebSocket
  subprotocols, never query parameters. Reconnection may reach a draining owner;
  it cannot admit a new session there. A resumed socket replaces and fences the
  previous observer. Uploaded state, dataset provider, caches and processor
  controls remain with the original logical client. Run request identities are
  retained as bounded tombstones; duplicate requests do not execute twice.
- Diagnostic replay uses ordered sequence numbers and bounded buffers (8 MiB /
  8,192 events per session, 32 MiB globally, 64 sessions). It does not parse/copy
  large already-sanitized output objects. An unavailable cursor or expired owner
  fails explicitly instead of creating a replacement run. Disconnected idle
  sessions expire after 30 minutes, but accepted preparation/run/cleanup retains
  its session. Slow observers are disconnected instead of growing a send queue.
  The browser retains pending runs during resume, drops duplicate events, refuses
  cursor gaps and stops after 60 seconds of unsuccessful recovery with an unknown
  outcome; it never resends run commands. Standalone/desktop sessions keep their
  original non-resuming lifecycle.
- A private opt-in API owner relay signs the installation, pod and random process
  incarnation. The public path remains on the current browser origin, preserving
  tunnel and Kubernetes TLS behavior. Any ready API can forward to the addressed
  pod, which verifies its current incarnation before forwarding to its local
  executor. Fresh UI/proxy authorization is required at every hop. Target hosts
  and ports come only from validated deployment identity; arbitrary URLs, stale
  incarnations and foreign-installation signatures are rejected. No connection or
  request is replayed on an alternate executor after failure. This relay remains
  activated only by the guarded HA chart composition described below.

- Runtime-library workers now distinguish retirement from stopped/disposed state.
  Retirement fences new jobs and claims while preserving accepted-job heartbeats,
  in-flight claims, outcome persistence and observation. The API includes accepted
  library work in its existing bounded SIGTERM shutdown grace.
- Scheduled-run owners expose non-interrupting retirement. They stop polling and
  claiming, await an outstanding claim before snapshotting accepted runs, and keep
  execution leases and the store alive until terminal persistence completes.
  Initialization finishing after runtime retirement cannot start a new scheduler.
  Terminal cleanup also waits for an outstanding heartbeat. `finish` explicitly
  acknowledges whether this owner persisted the outcome; a refused/lost outcome
  or claim acknowledgement blocks retirement even after the active count reaches
  zero. Runtime-library workers similarly latch unresolved activation/claim
  evidence for retirement, while preserving their established forced-disposal
  behavior. Neither path retries execution or overwrites interruption evidence.
  These fail-closed latches require operator reconciliation of the uncertain
  work; an ordinary later successful poll is not proof of the earlier outcome.
- Non-interrupting drains do not allocate lazy resources or imply disposal.
  Missing drain capabilities fail explicitly instead of falsely confirming safety.
- Focused owner tests exercise retained heartbeats, delayed claim acknowledgement,
  new-work fencing, late cleanup, idempotent drain and unchanged forced shutdown.
- A versioned pod-local retirement protocol binds one operation to one random
  process incarnation. Fencing is synchronous; settlement is asynchronous and
  irreversible. Failed fences or unknown cleanup outcomes remain failed, never
  silently drained. Repeated commands for the same operation are observational;
  another operation or incarnation cannot take ownership.
- `AcceptedWork` and the HTTP request barrier count actual work lifetimes. An
  async handler retains its admission after response close, so disconnect cannot
  make an accepted save/upload disappear from drain accounting. Health probes,
  metrics and the private retirement route are outside application admission.
- The editor executor owns preparation before plugin/bundle/options awaits and
  retains the lifetime through background run completion and debugger cleanup.
  Retirement rejects new runs and new-session socket upgrades, but does not revoke existing
  controls. Upgrade authorization is checked again after asynchronous auth,
  while existing sockets continue their original periodic authorization checks.
- The combined supervisor withdraws readiness but stays live during retirement.
  It verifies both participants' protocol/incarnation while reporting `checking`
  without withdrawing readiness. Incompatible participants block replacement
  without disruption. After preflight it waits for the executor **before**
  retiring its co-located API: accepted editor runs
  may still need API runtime configuration. API retirement waits for accepted
  handlers, HTTP/background/web-app runs, schedules, library jobs, bundle packaging
  and workflow-store persistence. It rechecks live restore ownership and the
  durable journal after handler drain; unfinished restores block replacement.
  The existing resource composition root fences scheduled claims, library claims
  and WebSocket action admission synchronously; it does not wait for an unrelated
  long HTTP handler before stopping those producers. Accepted-work settlement
  and store closure remain separate phases with their existing owners.
- Supervisor control uses an optional mode-0600 Unix socket in `/tmp`, not a
  public Service route. Its API participant uses a separate random, loopback-only
  capability; UI/proxy keys and Origin-bearing requests cannot use it. Executor
  acknowledgements are nonce-correlated IPC messages. Dotenv cannot replace the
  supervisor-owned protocol, token or incarnation. The API image includes the
  client and supervisor modules; the default chart does not activate this path.

`RIVET_ROLLING_RETIREMENT_PROTOCOL=1` and
`RIVET_ROLLING_RETIREMENT_SOCKET=/tmp/rivet-retirement.sock` are private composition
settings for isolated tests/future certified orchestration, **not** a supported HA
deployment switch. The supervisor creates the incarnation and API token; never
set those in operator dotenv or user-managed environment settings. The local
client's status-only invocation is `node /opt/rivet/retire-backend.mjs`; an owned
retirement supplies `<operation-uuid> <observed-incarnation> <wait-seconds>`.
Polling expiry blocks replacement and leaves accepted work alive. It never sends
SIGTERM/SIGKILL, retries a lost begin acknowledgement, or rolls back data.

## Integrated HA composition

The opt-in chart now composes 2-8 ordinary ready backends, one dedicated
maintenance owner, and OnDelete public execution owners. The maintenance owner
has no editor executor. Only it mounts the existing restore RWO claim and owns
upload/preparation recovery. Authenticated restore and unfinished bundle-job
requests stream to its fixed internal Service without buffering/retrying writes.
Ordinary APIs do not compete to recover its journal. Restore continues using the
existing PostgreSQL serving fence, installation scope and importer.

Completed bundle ZIPs and their small manifests are published to an
installation-derived `ha-exports/` namespace. Any API can download the immutable
compressed bytes. A workspace epoch prevents stale post-restore reads; the owning
job journal can still remove expired previous-epoch exports. Multipart parts are
bounded, published bytes are hashed, and lost publication acknowledgement is
reconciled by reading rather than uploading twice. Unknown publication/cleanup
blocks maintenance retirement. This is disposable export storage, not a second
workflow catalog or backup format.
The export client sets SDK `maxAttempts: 1`: automatic storage retries must not
replay an unacknowledged multipart allocation or publication before its owner can
reconcile it. Other storage clients keep their existing retry policies. A real
HTTP 503 regression verifies that the production export client sends one request.
Google Cloud Storage XML endpoints use signed `x-goog-if-generation-match`
guards for creation/deletion and exact `generation` reads, using identities
captured from response headers. Do not substitute S3 ETag delete preconditions:
[Cloud Storage documents generation guards for DELETE](https://docs.cloud.google.com/storage/docs/xml-api/delete-object).
S3/MinIO retain their version/ETag behavior. A confirmed missing archive permits
idempotent manifest cleanup; a changed generation or uncertain multipart abort
does not. A local real HTTP/XML regression verifies the serialized signed guards;
it is not a live provider certificate.

Latest-debugger observations use the fixed bounded backend ordinal mesh. An
installation/pod/incarnation MAC authenticates each internal socket, browser
Origins are refused, and controls traverse each owner once without retry. Each
processor remains on its original owner. Replay buffers are bounded and gaps are
reported; per-owner cursors prevent evicted event IDs from being replayed as new
events. No generic broker or extra PostgreSQL connection is introduced. Existing
managed-store invalidations refresh workflow tree observers on other API owners.
Evaluation library writes also issue a transaction-scoped notification on that
same LISTEN connection. The originating API suppresses its own echo; another API
notifies its existing library SSE observers. Listener loss/reconnect rotates the
observer epoch so missed revisions cause a snapshot refresh, not silent staleness.
Singleton deployments keep their original subscription footprint.
The hosted-editor seam contract requires both the initial executor URL and the
bounded owner-discovery callback on the existing `RivetAppHost` executor prop.
Discovery rejects explicit/custom overrides; the shared app session remains the
only socket/run owner. Structural seam checks complement, rather than replace,
the behavioral current-origin and idle-owner-handoff browser regressions.
Catalog-only changes use a `catalog-changed` hint on that same transaction-scoped
channel. Empty-folder create/rename/move/delete and draft-only/new project saves
must refresh other editor backends even when no published execution pointer
changes. Receiving these hints does not evict published execution caches or
invalidate WebSocket access policy. No-op and rejected mutations do not emit one.
Catalog notification tests use the controller's injected clock when comparing
resolve snapshots: their capture timestamp is not an invalidation generation.
They also assert that neither targeted nor global access-policy invalidation ran.

A positively settled idle editor receives `executor-owner-retiring`. Only then
may its host resolve a fresh same-origin signed URL via the existing configuration
API. Pending, active or uncertain runs cannot change owners. Custom executor URLs
and desktop hosts do not use this discovery. Late SSE observer setup is fenced:
retirement closes passive tree/library/job observers without canceling durable
jobs or creating a storage-maintenance marker.
Hosted Evaluation claims now run on these ordinary editor backends, not a fourth
HA workload. Their accepted trials, heartbeats and terminal persistence participate
in backend retirement. The maintenance owner never claims trials. Dedicated
Evaluation pods remain only in the explicit predecessor-compatibility chart path,
which cannot be combined with HA.

`ha.enabled` is not permission to run a raw Helm upgrade. The release helper
requires HA evidence inside the promoted immutable manifest. Mixed-version
evidence binds the exact predecessor source/images, candidate source/images,
chart, required behavioral checks and successful sustained request samples.
Bootstrap evidence never authorizes an ordinary rolling singleton conversion.
The offline Kubernetes lane lints the HA composition as well as the singleton
production profile. Helm's renderer can split a malformed multi-document
separator that its stricter linter rejects; keep the backend/maintenance YAML
separator on its own line, outside whitespace-trimming template assignments.
The old deployment must first use an explicitly owned maintenance cutover.
An image rebuild of the same source commit is not an exemption: different
immutable artifact sets still require actual predecessor-to-candidate
qualification. Identical artifact sets can only produce bootstrap/template
qualification, not mixed-artifact evidence. Both source identities and every
image identity remain bound to the exact manifests; an arbitrary same-source
image cannot use the reconfiguration shortcut.

For an HA upgrade the helper retains actual HPA-created capacity, freezes
automatic scale-down, installs OnDelete templates, and adds a ready surge owner
before retiring an original owner. Its CAS journal binds command operation,
process incarnation and Kubernetes pod UID before sending the command. Lost
begins are observed during exact-token `--resume-ha` recovery, never replayed.
Maintenance cutover and HA rollout CAS the same release-operation ConfigMap;
neither can steal an unfinished operation, even after its runner lease expires.
After an explicitly completed foreign-kind operation, the new owner CAS-replaces
its journal rather than deleting it. Recovery distinguishes original capacity
from its own retained surge; it rejects unrecorded scaling or a different token.
Environment-file Secret preparation in a maintenance cutover runs only after
the shared journal is owned and old readers have stopped. Ordinary HA upgrades
only verify existing Secrets; credential rotation is a separate maintenance task.
The adapter waits for public EndpointSlice withdrawal and uses a UID-preconditioned
deletion. Surge work is drained before scale-down too. Lease loss, timeout,
unknown template acknowledgement or failed cleanup leaves owners alive. No
automatic rollback or force deletion is part of this path. HPA may add public
capacity; removing it requires controlled retirement.
Surge scale-down is journaled before dispatch too. Recovery of a retiring surge
never scales it back up or resends an unacknowledged scale-down. The Kubernetes
adapter checks the observed surge UID and uses a current-replica precondition;
unexpected capacity changes block the command. Completion waits for both the
desired original replica count and actual surge-pod disappearance before
restoring autoscalers. An unconfirmed command that did not apply requires
operator reconciliation, not an automatic retry against a new owner.
Current-owner detection compares the controller-observed StatefulSet revision as
well as the image digest. A same-image configuration/resource update must not be
silently skipped by OnDelete, and readiness must refer to the desired revision.
Identity comparisons are structural: API-server ordering of fields inside
Secret references is not a credential change. Different Secret names/keys or
missing owner identity still block the rollout before template changes.

Routing withdrawal and admission fencing are distinct owned commands. A capable
supervisor advertises `withdrawalProtocol: 1`, verifies its participants, marks
supervisor readiness false and asks its API to close idle keep-alive connections
while still accepting requests. The release owner waits for the exact pod UID to
leave every public Service's ready EndpointSlices **before** sending the admission
fence. It then waits for accepted work and persistence to finish before deletion.
An omitted/null EndpointSlice readiness condition still counts as routable,
as required by the [Kubernetes EndpointSlice API](https://kubernetes.io/docs/reference/kubernetes-api/discovery/endpoint-slice-v1/#endpointconditions).
Only an explicit false condition or removal proves withdrawal; tests cover both
missing and null conditions before allowing any admission fence.
Execution readiness probes use the supervisor's health port in HA mode, not the
still-serving application port. Both commands are journaled before dispatch and
lost acknowledgements are only observed on exact-token recovery. Older prototype
owners without this capability fail preflight, before any template or admission
change. A prototype journal already fenced without withdrawal proof cannot be
silently upgraded into a successful HA operation.

This ordering was required by the actual local traffic test: immediate fencing
left old execution pods routable until readiness propagation and produced real
503 responses. Those failed attempts remain failed artifacts. A fresh complete
proof is required after the ordering fix; successful editor-only portions do not
override that failure.

The local proof runner extends the existing managed PostgreSQL/MinIO release
fixture and uses only explicitly allowed disposable local contexts. It now checks
for at least 20 GiB free before cluster mutation. Its `prepare` and `roll` phases
retain diagnostic artifacts and never substitute a same-image rollout for a
mixed-version certificate. Normal deployment remains singleton by default until
the complete HA proof is available. No production/GCP zero-downtime upgrade is
certified by the focused tests below.

## Local completion and production qualification

The final reviewed controller and H runtime candidate completed a fresh mixed-image
upgrade with **1,188 public requests, zero failures, at least two ready backends
throughout and zero candidate restarts**. Lost-acknowledgement and real ConfigMap
lease-conflict recovery served **1,591 requests with zero failures**. Both cases
preserved the original owner and issued each original begin command once.
The run includes both old/new project/library notifications and a separate final
candidate-to-candidate empty-folder/library notification check. Paused editor
sessions, hosted Evaluations, background recordings and shared bundle reads passed.

Current receipts are under `artifacts/ha-final-rehearsal-h/`, including
`ha-report-final.json`, `ha-workload-probes.json` and `ha-recovery-probes.json`.
The immutable API pair is
`sha256:4fbc4e26663383eb95a09f078448b3b9d0ad9df6bc12d94a67b01ca788dca71a`
to `sha256:ffe9b668ac38f49913e77e8eb905930494cc4749c37dccea539395f455c488d9`.
These remain local working-tree-image receipts, not deployment-authorizing
source-bound production certificates. Failed earlier attempts are retained as
failures; none were converted into successful evidence.

### Earlier runtime receipts

The earlier F runtime candidate completed an actual mixed-image upgrade with 1,083
public requests, zero failures, at least two ready backends throughout and zero
candidate restarts. Both paused editor sessions resumed exactly once through
another API; latest-debugger controls, accepted hosted Evaluations, full-run
background recordings and a bundle download during maintenance-owner withdrawal
passed. The intentional Evaluation co-location is retained.

The same disposable cluster passed lost-acknowledgement and real ConfigMap CAS
conflict injection. Exact-token recovery sent each original begin command once,
preserved its original UID until safe replacement, and completed the paused run.
Both recovery sequences served 1,412 public requests with zero failures. A
separate worker-disabled predecessor pod, excluded from Services, verified
bidirectional tree and Evaluation-library notifications across old/new images.

Receipts are retained under `artifacts/kubernetes-ha-proof-f1/`: `ha-report.json`,
`ha-workload-probes.json`, `ha-recovery-probes.json` and
`ha-mixed-notifications.json`. The immutable API pair is
`sha256:4fbc4e26663383eb95a09f078448b3b9d0ad9df6bc12d94a67b01ca788dca71a`
to `sha256:c3f04a4262f8a06fa70c0c1b6fd9931dc0cc5b70258a5ac89748ee7725d5cc3a`.
`ha-local-verification.json` summarizes these receipts and explicitly cannot
authorize deployment. After verification the task-owned minikube profile and
loopback registry were stopped; their diagnostic artifacts and profile data are
retained. The regular local Rivet containers remained healthy.
The latter includes the observed schema/claim deadlock fix. The identical real
PostgreSQL lock-upgrade workload reproduced the pre-fix deadlock and passed with
the fix; it is enrolled in the existing managed migration integration lane.

The full PostgreSQL/MinIO migration and original/modified legacy-backup restore
suite also passed, including automatic compiled-worker/editor restarts and
unrelated SQL/S3 preservation. Seven current-build headless browser checks,
Linux supervisor tests, real executor retirement, debugger/session compatibility,
API/chart tests and offline Kubernetes rendering provide separate regression
coverage. Earlier disk exhaustion, socket recovery and failed traffic attempts
remain failed evidence; no factory reset or user-data deletion was used.

These are local runtime receipts for reviewed working-tree images, **not** a
source-bound promoted release or a live GKE/GCS ingress certificate. The evidence
producer and mandatory image-release CI enrollment are implemented; a clean
committed candidate must pass that job before promotion. CI retrieves the exact
immutable predecessor manifest, distinguishes bootstrap from actual old/new
artifacts and binds every source/image/chart identity. Missing proof is rejected.

### Post-proof recovery review

The controller review additionally covers lost surge scale-down acknowledgement,
recovery during surge drain, pending pod deletion, replica-count races and a
replacement surge UID. These regressions use the same controller and Kubernetes
adapter as deployment, including the actual `kubectl scale` precondition arguments.
The evidence producer requires an integer paused-run duration and an explicit
successful Evaluation-preservation receipt; omitted, non-finite or string values
must not pass JavaScript's permissive comparisons. The tests remain in the
existing Kubernetes verification lane, not a second test runner.

The subsequent full rehearsal also found missing catalog-only invalidation and
an undersized physical connection limit in the disposable PostgreSQL fixture.
Those were corrected and the complete H rehearsal above reran the revised
controller and runtime. The committed release must still pass the source-bound
mandatory CI gate before promotion; local image receipts cannot replace it.

Before any GCP change, separately review the actual Gateway routing/readiness
configuration and first singleton-to-HA maintenance transition. The existing
singleton cannot retroactively provide resumable owners. Keep its database,
bucket, keys, gateway and unrelated apps unchanged until that operator step has
explicit approval. A local certificate does not authorize a production rollout.

## Regression coverage and earlier receipts

Focused lifecycle coverage lives in the existing `scheduled-runs.test.ts`,
`runtime-library-artifact-activation.test.ts`, `runtime-libraries.test.ts` and
`server-resource-lifecycle.test.ts` API files, already enrolled in the explicit
API test manifest. Run the API build and these tests after editing these owners.
For the earlier lifecycle slice, the API build, 69 focused lifecycle/stream/deadline tests,
real PostgreSQL scheduler integration and four headless UI checks passed locally.
The separate live npm-install cancellation browser scenario was attempted against
a static frontend without an installer API and timed out waiting for the job log;
it is not passed evidence. It needs an isolated live-installer fixture, not the
production installation. The four passing UI checks include a real authenticated
API scheduler run with cross-project execution and recording persistence.
Additional protocol regressions live in `process-retirement.test.ts`,
`backend-retirement.test.mjs`, `backend-supervisor.test.mjs`,
`executor.retirement.test.mts`, `debugger.test.ts`, `legacy-restore.test.ts` and
`project-bundle.test.ts`. The API manifest and production-cutover lane enroll the
new explicit files; real executor retirement runs in the build-backed editor lane
after Core/Node artifacts are restored, not in source-only contracts. The real executor test holds asynchronous preparation, pauses
an accepted graph, rejects another run, then supplies user input and resumes to
the unchanged result before confirming drain. The supervisor subprocess test
keeps accepted work alive beyond a deliberately short forced-shutdown grace.
These are behavioral process-level regressions, **not** mixed-version Kubernetes
or provider-ingress certificates.

Protocol verification also passed the affected API/profile/restore/library/
scheduler suites, the complete debugger file, a real PostgreSQL scheduler run and
the four headless browser checks described above. The supervisor suite runs in a
disposable network-isolated Linux container to verify the Unix socket is mode
0600, stale-incarnation rejection, no TCP control exposure, cleanup on close and
both dotenv-preservation branches. The existing local Rivet containers and GCP
are not modified. Node ESM, API, shared-contract and hosted-executor builds,
affected production-file lint, documentation links, structure and migration
ledger checks are separate from these runtime receipts.

Full HA acceptance additionally requires the managed PostgreSQL/MinIO integration,
headless repository Playwright runner, disposable mixed-version Kubernetes gate,
and protected provider-ingress rehearsal. Do not report those gates as passed
based only on these focused lifecycle tests.

Current-source focused verification after co-located Evaluation integration:
91 API/Evaluation/chart/invalidation/export tests and 25 HA/cutover/evidence tests
passed. Seven immutable-build headless executor-origin checks passed, including
idle-owner handoff. These receipts do not close the interrupted cluster gate.
The subsequent storage-guard/recovery review passed 79 focused API tests (including
real HTTP/XML generation guards), all 25 HA/cutover tests, and the complete offline
Kubernetes render lane. Its first run had one transient Windows shell-process
failure; the isolated case and full rerun passed. The seven browser checks were
also rerun successfully. No Docker-backed or mixed-version cluster success is
inferred from these receipts.

The subsequent editor-owner slice passed the real executor subprocess in both
legacy and resuming modes, including socket loss while paused during retirement,
the authenticated API owner-relay tests, debugger/proxy regressions, editor
session tests, Linux supervisor tests and seven current-source headless origin
checks. The Kubernetes launcher/chart lane, app/Node/API/executor/frontend builds,
lint and documentation/style/ledger checks are separate receipts. Resumption
control is admitted by the existing transport parser before payload decoding,
so streamed output is not parsed twice. Custom/legacy URLs do not negotiate the
new protocol. An isolated local `rivet-ha-proof` minikube profile was provisioned;
cluster creation alone is **not** mixed-version application rehearsal evidence.
Do not assume the isolated profile is stopped merely because its API is unreachable.
No production/GCP resources were modified. The chart guard is still in place.

### Local workload probes

`lib/ha-release-probes.mjs` is disposable verification code, not an alternative
execution or storage owner. It downloads the saved project before preparing
Evaluations so installation-assigned project identities satisfy the same catalog
constraints as the editor. Each accepted Evaluation is bound to the retiring
pod's worker identity and must retain attempt 1 and its terminal result.
The editor probe starts on one owner through the other API, pauses past the
fixture's forced-shutdown grace, disconnects and resumes without resending the
execution, then completes before that exact UID may be removed. Latest-debugger
pause/resume and observations cross that same peer boundary. Early outputs must
leave a durable, single full-run recording before execution-owner removal.
The shared bundle is downloaded and hashed after the maintenance owner has
withdrawn from Service endpoints, proving reads do not depend on that owner.
Readiness samples require at least two ordinary ready backends throughout.
Pre-retirement fixture setup runs before `beginIssued` is journaled; a failed
test setup must not masquerade as an unknown production command acknowledgement.
Failure artifacts remain failures; rebuilding the disposable namespace starts a
new test, never converts the failed attempt into passed evidence.
`prepare` refuses an existing namespace rather than deleting it or rotating its
Secrets. Use a fresh namespace for another attempt: dependency hostPath data is
intentionally retained across namespace deletion in the managed fixture.

The test edge is separate from release-owned proxies. A stable port-forward to
that edge reaches the actual proxy Service; otherwise a proxy image upgrade
would merely terminate kubectl's chosen pod and incorrectly look like a serving
outage. The edge has no release workload labels, stores no application data and
is removed with its disposable namespace. Normal deployment charts are unchanged.

CI runs `yarn node deploy/studio-server/scripts/kubernetes-ha-release-gate.mjs certify` with
`RIVET_HA_CANDIDATE_MANIFEST` and, when lineage exists,
`RIVET_HA_PREDECESSOR_MANIFEST`. The Yarn Node wrapper is required for Plug'n'Play dependencies such as
`yaml`; bare `node` fails before certification starts. CI policy checks enforce
the wrapper, while the offline Kubernetes lane imports and tests the real gate.
The candidate must match the clean tracked
checkout, chart and exact configured image set before cluster mutation.
Certification explicitly allows a candidate state in the source/chart identity
helpers; their default remains promoted-only for deployment. The gate's shared
preflight validates source, chart, image identities and exact predecessor before
fixture creation. Offline regressions exercise this preflight with real candidate
manifests, including mismatches and rejection of promoted certification inputs.
Bootstrap uses a same-image template revision change to exercise retirement but cannot
authorize a mixed-source rollout. The report producer verifies real readiness
samples, per-owner workload receipts, withdrawn UIDs, replacement UIDs and both
baseline/candidate image identities before creating `ha-evidence.json`.
Cross-owner tree and Evaluation-library SSE probes run in both directions
before each original backend retires. They verify the committed library snapshot
as well as its notification, using disposable project renames and migration markers.
The predecessor may predate catalog-only notifications, so a separate final
candidate-to-candidate probe verifies empty-folder notifications in both directions;
that receipt is required for certification, not inferred from execution-cache events.
The disposable PostgreSQL fixture starts with an actual 250-connection limit,
matching the HA fixture's declared budget including surge owners. This is not an
automatic change to an operator's production database capacity.
Certification additionally injects a lost begin acknowledgement and a real
ConfigMap resource-version conflict into that same disposable Kubernetes API.
The latter holds an accepted editor paused beyond the 30-second journal
heartbeat. Both interrupted runners must retain their exact original pod UID;
explicit exact-token recovery must observe the command, never issue it twice.
Public requests continue during both fault/recovery sequences. Their receipts
and zero-failure traffic report are required before certificate generation.
The standalone `recovery` phase can exercise these faults after a successful
local `roll`, without calling the destructive fixture preparation path again.
