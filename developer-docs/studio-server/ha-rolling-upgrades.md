# HA rolling-upgrade implementation status

## Required guarantee

The target is continuous request availability during planned upgrades, with
accepted executions finishing on their existing owners and durable outcomes
persisted once. Browser sockets may reconnect; reconnection must never replay an
uncertain execution. A long-running or paused execution may block retirement.
This is not a guarantee against simultaneous provider failure or arbitrary pod
termination. Legacy restore remains an explicitly destructive maintenance task.

### Latest exact-pair qualification

The 2026-10-17 disposable local `0704d0181` to `d9ea8dd17` upgrade passed after
the candidate's complete image CI (`39049988451`). Primary traffic recorded
2,591 successes/zero failures, recovery traffic 1,988 successes/zero failures,
and primary readiness never fell below two ordinary backends. Both retained
browser journeys used different old/new build identities and passed save,
execution, output, recording and lazy-screen checks without reload. Both real
lost-acknowledgement and controller-lease-conflict recovery probes passed.
These are exact-source local compatibility receipts, not permission to rewrite
canonical release lineage. The subsequent isolated GKE/PostgreSQL/GCS/trusted
HTTPS upgrade also passed: 6,261 primary workflow requests, 9,136 recovery
workflow requests and 5,300 separate public web-app checks, all with zero
failures. Both retained-browser journeys, lost-begin-acknowledgement recovery
and real controller-lease-conflict recovery passed; each original begin command
was issued once. At least two ordinary backends remained ready. The primary
and recovery streams' slowest observed workflow requests were 758 ms and
929 ms respectively; these are continuity observations, not capacity claims.
The full private export was hash-verified locally and sanitized evidence saved.
Staging teardown verified no remaining rehearsal billable resources and the
expiry monitor was paused. Only an unused dedicated VPC/private-service
connection/internal range awaits Google's four-day Cloud SQL producer-retention
hold; see [the provider residual inventory](gcp-ha-staging.md#provider-retained-networking).
The restored project and its pre-existing identity/key, default network and
billing association were preserved. Production has not been accessed, and its
first singleton/older-browser-contract conversion still requires a separately
approved maintenance transition. These receipts do not replace the canonical
source/image-bound production promotion safeguards.

### Post-qualification session hardening

The 2026-10-18 review reproduced a delayed executor-owner discovery race: a
lookup started by an idle retiring session could return after a manual disconnect,
an explicit executor replacement, newly accepted work or its recovery deadline.
Discovery now checks the original socket/generation, idle work state and deadline
both before and after the asynchronous lookup. A stale answer cannot reconnect
Node, replace a user-selected executor or reject a run belonging to the session.
The same predicate owns both checks; no extra session owner, retry mechanism or
wire-protocol change was introduced. Five controlled unit regressions cover these
races; the hosted observer also switches to Browser while the lookup is pending.
The browser fixture matches only root `/api/` requests, so it cannot intercept
Vite source imports from `src/api/`. The nine headless hosted-origin checks pass
against the freshly built production frontend, including the delayed lookup and
recording-reconnect journeys. Session/coordinator/registry tests (122), focused
retirement/rollout/evidence tests (87), API owner/relay/export tests (18), Node
session tests (6) and retained-asset tests (7) pass, as do the offline Kubernetes
lane, app TypeScript/lint checks and frontend build. These are bounded audit
checks, not a capacity measurement or a repeat of the provider rehearsal.
The optional host-compatibility shell scan was not counted as passed on this
Windows host: WSL Bash refused access and Git Bash could not reliably fork its
utilities. A read-only fallback confirmed all seven provider-seam markers are
present; the normal Linux CI scanner remains required.

The qualification receipts above remain evidence for `0704d0181` to `d9ea8dd17`,
not this later source change. Commit/build and qualify the final immutable image
pair through the existing release gates before production rollout. Offline tests
and a mocked-transport browser check are not a new mixed-version certificate.

The adjacent review then reproduced premature readiness on reused open sockets,
discovery attempts blocking replacement sessions, and dropped dataset responses
after a physical reconnect. Reusing a socket now preserves its protocol state;
only the existing replay-ready acknowledgement enables commands. A small
session-local discovery token is invalidated on disconnect, replacement and
transport loss. Its late completion cannot clear a newer attempt.

Dataset operations still execute once through the existing provider bridge.
Only their completed responses survive an HA transport gap, bound to the logical
resume capability. They flush after replay-ready on that same owner, never to a
replacement session. The disconnected response budget is 64 responses / 8 MiB;
overflow or a failed send fails the session with an unknown run outcome rather
than repeating a dataset mutation. Connected large responses retain their
existing behavior. Manual disconnect, replacement and resume expiry discard
retained responses. Legacy hosted, desktop and external debugger dataset bridges
keep their physical-socket behavior; no server wire format or retry was added.
Unit tests verify the existing dataset response contract and one write invocation
across reconnect, with late-result isolation, bounded retention and unchanged
connected large-payload support. The real-browser recording fixture also performs
an IndexedDB dataset write across replacement and waits for its acknowledgement
before declaring the run complete.
The final adjacent-source verification passed 135 session/coordinator/registry
tests, six Node-session tests and all nine headless hosted-origin checks against
a fresh production frontend build, plus TypeScript, focused lint, test-style and
documentation-link checks. No chart, cluster or production resource was changed.
These checks still do not authorize deployment of an unqualified image pair.

The next bounded review verified the resume acknowledgement itself. Each
physical HA socket must acknowledge protocol 1 and the original logical
capability before it can dispatch dataset work, replay diagnostics or release
retained results. A missing, malformed or changed identity fails with the
existing unknown-outcome result and discards retained responses; it never adopts
a new session under an old run. The replay-ready message is not identity proof.
Seven controlled regressions cover invalid acknowledgements, pre-acknowledgement
dataset writes and reconnect timing. Failed connection attempts now retain the
existing increasing retry delay (capped at two seconds), instead of resetting
to 150 ms on each attempt. A successful transport or explicit replacement resets
the delay. The 60-second HA recovery deadline and no-replay policy are unchanged.
This removes an erroneous reset and adds socket-local validation, not another
session owner or a new handshake protocol.
That review passed 142 session/coordinator/registry tests, six Node-session
tests and all nine headless hosted-origin checks, along with a fresh
frontend build, TypeScript, focused lint, test-style and documentation checks.
Production and the isolated GCP resource inventory were not accessed.

The whole-session reassessment reproduced one remaining initial-connect gap:
a newly opened HA socket exposed run/recording readiness before the identity and
ready acknowledgements, and could remain apparently ready when negotiation
stalled. Fresh owned sessions now use the same ready gate as resumes. The first
logical connect notification follows ready exactly once, including when the
transport is lost after identity acknowledgement but before its first ready.
Initial negotiation uses the existing 60-second deadline without extending it
on reconnect, then fails closed if negotiation never completes. No new timer
owner or wire message was added; legacy hosted, desktop and external debugger
readiness remains unchanged. Seven controlled regressions cover readiness,
notification lifetime, stalled negotiation and timer disposal. A separate
headless browser check holds both handshake stages and verifies that Run stays
disabled until ready.
Current verification: all 149 session/coordinator/registry tests, six Node-session
tests and ten headless hosted-origin checks pass, together with the production
frontend build, app TypeScript, focused lint, test-style and documentation-link
checks. Only a task-owned local preview was started and stopped. These source
checks do not replace the final immutable image-pair qualification before GCP.

### Final-candidate delivery

Commit the complete reviewed session hardening before selecting its immutable
candidate. A push to `develop` runs Build and Verify Studio Server, but Build
Images requires an explicit dispatch on that same branch. Leave all protected
provider, capacity, Evaluation and lineage-bootstrap inputs disabled for this
local qualification step. Do not advance the source until the complete image
run and its validated manifests have been harvested.

Qualify the final candidate against the retained browser-contract baseline and
an exact previous HA image set; a same-image bootstrap certificate is not a
mixed-version upgrade result. The existing local `prepare`, `roll` and `recovery`
phases retain their normal traffic, readiness and browser assertions. Never
rewrite canonical release lineage to substitute an ad-hoc predecessor. Save
additional exact-pair receipts separately when its predecessor differs from the
candidate's canonical production lineage.

The previous isolated provider resources were removed. Recreating paid staging
resources requires a new approved allowance and expiry inventory. Neither CI
dispatch nor local qualification authorizes a production merge, promotion,
singleton-to-HA maintenance conversion or live deployment. Stop before those
actions, obtain the applicable approval and qualify the final provider image
pair before activating HA in GCP.

### Traffic failure evidence

Primary and recovery probes send each workflow POST once, with the same 15-second
deadline and 25-millisecond cadence. They stop admission and await the last
in-flight request **before** asserting zero failures. A late timeout during probe
shutdown must fail qualification too. Reports retain request IDs, dispatch phase,
UTC start/end, elapsed time, HTTP status and transport error code, plus the slowest
request; they do not retain authorization, bodies or error stacks. The disposable
local edge access records contain only correlated probe IDs, status and upstream
timings (no URL, query, headers or bodies), so pod replacement cannot erase the
edge evidence. Ordinary nginx error logs remain private diagnostic material.
The recovery-only `recovery` command reuses a prepared disposable local fixture
and immutable images; it is not a production deployment or a substitute for the
full mixed-version/browser qualification. Never retry a failed workflow POST or
raise its deadline to make qualification pass.

The local HA fixture overrides the shared managed-disruption overlay's zero
pre-stop delay with 5 seconds for endpoint withdrawal, while retaining its short
15-second application shutdown challenge. Its termination grace is 45 seconds,
the minimum allowing pre-stop + shutdown + the chart's 25-second finalization
margin. A rendered-Helm regression checks the effective merged values, not just
the override object. Accepted editor work (25 seconds) and the longer recovery,
background and Evaluation probes (45 seconds) exceed the application shutdown
deadline; the separate paused-browser probe stays paused until old frontend UIDs
are actually removed. Do not lengthen shutdown to make these proofs pass.
The disruption fixture intentionally interrupts sockets; inheriting its immediate
nginx exit caused real Service connection refusals during the recovery rollout.
Provider rehearsals continue to use their independently qualified provider values,
including the longer GKE edge propagation and drain windows.

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
- Resumable editor recording capture belongs to the logical executor session,
  not its current physical socket. Recorders receive the same admitted, ordered,
  duplicate-free events as display subscribers, after terminal ownership is
  updated. A proxy reconnect does not finalize capture. Manual disconnect,
  session replacement, cursor loss or recovery expiry closes incomplete capture;
  it cannot become a successful recording. Legacy/desktop recorders retain
  their physical-socket lifetime. Core's recording channel requires only event
  subscription and ready state, not WebSocket transport ownership.
  Browser-continuity contract **2** establishes this guarantee. Contract 1
  browser code can terminate recording on reconnect; a backend update cannot
  repair code already loaded in that tab. The supported browser baseline must
  therefore reset through maintenance, not a falsely certified rolling upgrade.
  This is release evidence metadata, not a change to the socket's wire protocol.
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

### Production browser-version continuity

HA web replicas publish their complete build before opening their listener. HTML
selects a SHA-256 build identity and a `/__rivet_web/<build>/` base before any
script, stylesheet or preload. Vite emits relative import/worker URLs. A
dashboard pins its editor iframe to that same build with `webBuild`; direct
openings still select the local replica's current build. No automatic reload,
service worker or browser-side storage credential is introduced.

The web process owns this publication/serving boundary, using the existing S3
SDK and object-storage location. HA projects the S3 credential Secrets (or a
storage-only Vault dotenv projection), never PostgreSQL, encryption or UI keys,
into the web container. Objects are gzip-compressed but deliberately have no S3
`Content-Encoding`, preventing GCS decompressive transcoding. Keys are derived
only from installation identity and content hashes beneath
`<objectStorage.prefix>web-assets/<installation SHA-256>/`. A small hashed
manifest describes each complete build. Every replica serves retained builds
from that namespace; immutable creation and read-back reconciliation handle
concurrent publishers and lost acknowledgements without overwrites.

Builds are limited to 4,096 files / 512 MiB total / 64 MiB per file. Publication
has four workers, serving has 32 in-flight handlers, and each process caches at
most 16 manifests. Old files are deduplicated by content and **not automatically
deleted**: a suspended tab may request a lazy chunk months later. Do not apply
an object-expiration rule to this namespace unless intentionally ending support
for those tabs. Normal workflow/restore/retention owners do not own these keys.
Workflow reconciliation still counts their stored bytes, but excludes the exact
frontend-key shape from orphan findings; malformed lookalikes remain reportable
and workflow stale-upload deletion never accepts frontend keys.
Readiness fails closed on publication failure. Missing versioned files return
404, never SPA HTML. Existing UI authorization remains on the proxy path.
Non-HA static serving has no added credentials and retains its local behavior;
development keeps its separate HMR/generation implementation.

GCS conditional XML requests use the Node-only shared
`gcs-xml-signing.ts` transport adapter. The AWS SDK still serializes requests,
hashes payloads and owns HTTP; immediately before sending a generation-guarded
request, the adapter normalizes extension headers and re-signs using Google's
[GOOG4 HMAC dialect](https://docs.cloud.google.com/storage/docs/authentication/signatures).
GCS rejects mixed `x-amz-*` and `x-goog-*` headers. Do not replace the real
`x-goog-if-generation-match` precondition with an `x-amz-*` lookalike: the isolated
live probe accepted a duplicate write with that lookalike, proving it was ignored.
This adapter serves both frontend publication and the API's shared-export guards;
ordinary S3/MinIO requests keep their original signing path and retry policy.
Loopback HTTP/XML regressions require a single header dialect and preserve gzip
bytes, signed generation guards, immutable metadata, and exact-generation reads.
Real GCS verification additionally requires successful first creation and a 412
for a second guarded write; a stub accepting any headers is insufficient evidence.

The image-wiring contract in `proxy-image-contract.test.ts` verifies that the
production Dockerfile bundles this source-owned server, copies the resulting
module into the runtime image and executes it, without the superseded global
`serve` dependency. The legacy Compose Dockerfile still uses its separately
pinned `serve` package. Keep these distinct: requiring that legacy package in
the production image incorrectly rejects the version-aware server. Behavioral
asset coverage lives in `production/*.test.mjs` in the web unit-test lane;
image wiring alone is not proof of browser continuity.

HA evidence v3 requires a real production dashboard held across replacement of
all original web/proxy pods: start and pause an accepted Node execution before
upgrading, retain a real
unsaved Text-node edit, save it through the candidate API, start a second Node
run through owner rediscovery, inspect the changed full output and open its
durable recording through Run recordings and the existing **Play Recording**
action. Loading a recording is not automatic playback; replay must expose the
edited output without submitting another live run. Both runs must produce one successful
recording each. The first run remains paused until every original frontend Pod
UID is absent, then resumes through the public endpoint before API-owner
retirement. A short run that finishes during warm-up is not continuity evidence.
Lazy modal, pinned editor, fresh current tab and zero reload/
asset-error checks remain required. The gate uses the deployment controller.

The supported browser window is **all releases in the current browser contract
epoch**, not a silently sliding N-1 window. `HA_BROWSER_CONTRACT` in the release
evidence owner declares that API/executor contract. The first v3 certificate
pins its immutable frontend image and source as the oldest supported baseline.
Subsequent certificates inherit that exact baseline; every release exercises
the complete journey above in both the predecessor UI and this oldest UI against
the candidate backend. The old publisher is a digest-pinned, Service-less Pod
in the disposable fixture, removed before rollout; its files use the normal
retained-asset publication path. Missing/unavailable baseline images fail the
gate; do not silently replace them with the latest UI. Keep those registry
images as well as S3 assets. The baseline and protocol are stored in generated
production Helm values; a rolling command rejects either changing or missing.

Within an epoch, maintain browser-facing HTTP shapes, project/revision semantics,
recording and executor protocols backwards-compatibly. The oldest/predecessor
journeys complement existing contracts; they are not exhaustive proof of every
intermediate release or optional feature. If an incompatible change is necessary,
bump the contract, establish a new bootstrap baseline and use explicit maintenance
with an operator-coordinated save/export and browser refresh. Never force reload
or discard unsaved work to make certification pass. Historical v1/v2 evidence
remains readable for lineage/maintenance but cannot authorize this v3 guarantee.
The first singleton/legacy-HA conversion also requires maintenance.

The completed local retained-browser journey is recorded under
`artifacts/browser-workflow-full-upgrade-f/ha-report.json`, with predecessor and
oldest-baseline screenshots beside it. The real mixed-image rollout served
1,367 requests with zero failures and kept at least two ordinary backends ready.
Both retained tabs preserved the unsaved edit, saved it through the candidate,
ran again, inspected the changed output and played the stored recording with
zero dashboard/editor reloads and exactly two successful recording uploads per
tab (playback created no third live run). Every original web pod was replaced.
The first epoch's local baseline is also its predecessor frontend; unit coverage
separately verifies that later release selection retains that original baseline
rather than sliding forward. Clean source-bound CI must perform the same journey
against the inherited immutable baseline on subsequent releases.

The earlier D/E attempts remain failed receipts. Their acceptance test loaded a
recording but omitted **Play Recording**, incorrectly expecting replay outputs
immediately. A no-upgrade control and an isolated idle-owner handoff both retained
completed output; the corrected F journey above passed without changing the
application's recording/replay semantics. The focused headless recording test
also enforces the separate load/play actions. These are local working-tree image
receipts, not production deployment authorization or provider-edge qualification.

### Production qualification boundary

For an installation without staging, use the
[isolated GCP qualification plan](./gcp-ha-staging.md). It is a preparation and
approval document, not permission to provision or mutate the live installation.

Do not substitute a local overlay receipt for clean, source-bound CI evidence.
Before activating HA in GCP, qualify the exact promoted images through the
protected provider gate described in [Kubernetes](./kubernetes.md#repo-local-verification)
using a dedicated `rivet-staging-*` namespace, separate database and bucket (or
explicitly isolated provider resources), staging Secrets and HTTPS origin. Never
point a destructive fixture, restore or capacity gate at the production release,
database or workflow prefix. Reuse the production Gateway/controller policy
shape, not the production route or credentials. Verify authentication, private
route rejection, retained asset/query routing, WebSocket/SSE reconnection, health
withdrawal and connection draining through that real edge. Measure representative
workload and surge peaks, database connection headroom and recording persistence;
idle `kubectl top` is inventory, not a capacity certificate.

The 2026-10-16 read-only GCP inspection found one backend, one execution replica,
one web replica and two proxies. `rivet-web` routes the public hostname's `/`
prefix to `rivet-rivet-proxy`; its route and proxy policies report accepted/
attached. The proxy backend policy sets a 3,600-second request timeout; the health
policy checks `/readyz` on port 8080. No explicit connection-draining duration was
present in that backend policy, so actual draining still needs provider rehearsal,
not an assumed default. No live resources or Secrets were changed. Snapshots are
under `artifacts/browser-workflow-gcp-readonly-*.log`. This inspection does not
authorize the first maintenance conversion or certify GCS publication permissions.

Restore and unfinished bundle preparation may briefly return unavailable while
their singleton maintenance owner is replaced. This administrative interruption
is accepted; ordinary serving and already-published shared bundle downloads do
not depend on that owner remaining available.

Local verification on 2026-10-16 used two distinct immutable frontend images
and a mixed API-image upgrade in the isolated `rivet-ha-proof` cluster. The
original production dashboard remained open while every original web pod was
replaced: its lazy Run Statistics screen and pinned old editor loaded without
a reload, while a fresh tab selected the candidate build. The upgrade served
1,247 requests with zero failures, kept at least two ordinary backends ready,
and recorded zero candidate container restarts. Paused editor runs, hosted
Evaluations, background recordings and shared bundle downloads also passed.
The separate lost-acknowledgement/lease-conflict recovery rehearsal served
1,653 requests with zero failures and issued the original owner's begin command
exactly once in each case. Receipts and the browser screenshot are retained in
`artifacts/web-continuity-full-upgrade-c/` (`ha-report.json`,
`ha-recovery-probes.json`, `ha-browser.png`). Earlier failed attempts remain
failed evidence, not substituted receipts. The subsequent inventory-only
exclusion above passed focused reconciliation/retention tests and the API build.
These are local working-tree overlay receipts, **not** a clean, source-bound
production release certificate; CI must qualify the final committed image pair
before deployment. No GCP resources were changed by this verification.

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
The inventory and recovery journal bind the StatefulSet UID as well as the pod
UID. Recreating a controller under the same name is not continuation of an owned
rollout. Template guards, revision reads, surge scaling and removal observations
all reject that replacement. `kubectl scale` carries both the current-replica and
resource-version preconditions; a same-count concurrent update cannot slip past
the replica check and redirect a scale command to a different controller.
Identity comparisons are structural: API-server ordering of fields inside
Secret references is not a credential change. Kubernetes omits empty literal
environment values in returned objects, so `value: ""` and an omitted `value`
on the same literal EnvVar compare equally (including the default AWS S3
endpoint). Removing that EnvVar, supplying a nonempty endpoint or replacing it
with a Secret reference remains a configuration change. This normalization does
not alter the exact rendered-configuration digest used for operation recovery.
Different Secret names/keys or
missing owner identity still block the rollout before template changes.
This includes Vault injection identity (role/path/template/TLS and service
account), credential `envFrom` references, application-settings wiring and owned
serving ports/paths. Vault resource requests/limits and ordinary pod tuning may
still change without pretending to be credential rotation. Existing release
Services cannot disappear or change selectors, ports or headless/ready-routing
policy during rolling replacement: old owners would still use the old contract.
New Services are allowed. API-assigned cluster IPs and defaulted TCP/target ports
do not count as a routing change. Use a separate maintenance cutover for actual
authentication or serving-route changes.

Recovery also binds a SHA-256 digest of the complete rendered configuration,
including workload settings, Services and autoscalers. The same source/images
with different values are not the same operation: final autoscaler restoration
must not introduce an unreviewed pod template after retirement finished. Resource
and object-key ordering does not affect this identity; ordered arrays do. Restore
the original values for `--resume-ha`. Unfinished older journals without this
binding require explicit operator reconciliation, not an inferred configuration.

Every Helm update in the HA controller carries each StatefulSet's freshly read
`metadata.resourceVersion` alongside the preserved replica count. A capacity
change before that read is rejected; a scale or status update after it conflicts
at the Kubernetes API instead of letting Helm write stale capacity over a new
owner. The private `ha.rolloutResourceVersions` map is generated by the controller,
not an operator configuration knob. It changes resource metadata only, not pod
templates. Conflicts fail closed with the existing unknown-template recovery
rules; do not retry a migration or remove an owner to clear one. Maintenance
validation disables **all** chart autoscalers, including web, so Helm cannot
recreate a controller that reopens a deliberately stopped tier.
Before and after final autoscaler restoration, the controller rechecks every
original capacity slot against its current image/revision, readiness and serving
retirement state. Journal `completed` entries describe earlier work, not current
health. A changed or retiring completed owner blocks completion, including on
exact-token recovery, without replaying its retirement or deleting more pods.
Missing controller/pod revision evidence is never treated as a match merely
because both fields are absent. Focused regressions cover these completion
checks before and after the final Helm acknowledgement, controller recreation
both mid-rollout and on recovery, and route/credential preflight rejection.

Owner-relay disposal covers pending handshakes as well as established tunnels.
A late upstream acknowledgement cannot resurrect a disposed relay. Peer-debugger
cursor gaps warn already-connected observers immediately; reconnect deduplication
still prevents duplicate diagnostics and never replays an execution or control.

The preparation audit verified a real Helm/Kubernetes stale-resource-version
conflict in the disposable `rivet-ha-proof` cluster: the stale update failed,
both scheduling-gated test owners remained, and a fresh guarded update succeeded.
That isolated namespace was removed and the profile returned to its stopped
state; the ordinary local Rivet stack and GCP were not changed. The receipt is
`artifacts/ha-audit-cas/result.json`. Separate current-source checks passed 64
owner/recovery/evidence tests, 116 adjacent API tests, 36 Helm contract tests and
seven headless origin/handoff browser checks, plus API/web builds and the offline
Kubernetes lane. These are audit regressions, **not** a fresh full mixed-version
release certificate. Promotion must rerun the source-bound HA certification for
the new commit/chart/images before any production rollout.
The adjacent review then passed 61 focused rollout/cutover/evidence regressions
and the offline Kubernetes lane. The same real local CAS fixture additionally
proved that `kubectl scale --resource-version` rejects a stale observation even
with an unchanged replica count, and accepts a fresh one. Its scheduling-gated
pods execute no application work; the fixture namespace was deleted afterward.

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
mixed-version certificate. Normal deployment remains singleton by default;
enabling HA requires explicit operator values and the applicable certificate.
No production/GCP zero-downtime upgrade is certified by the focused tests below.

## Historical local completion and production qualification

These working-tree receipts predate the exact-source qualification at the top
of this guide. They document the progression, not the current acceptance status.

The final reviewed controller and H runtime candidate completed a fresh mixed-image
upgrade with **1,188 public requests, zero failures, at least two ready backends
throughout and zero candidate restarts**. Lost-acknowledgement and real ConfigMap
lease-conflict recovery served **1,591 requests with zero failures**. Both cases
preserved the original owner and issued each original begin command once.
The run includes both old/new project/library notifications and a separate final
candidate-to-candidate empty-folder/library notification check. Paused editor
sessions, hosted Evaluations, background recordings and shared bundle reads passed.

Those historical receipts are under `artifacts/ha-final-rehearsal-h/`, including
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

Before any production GCP change, separately review the actual Gateway
routing/readiness configuration and first singleton-to-HA maintenance transition. The existing
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

Earlier focused verification after co-located Evaluation integration:
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
Those local steps did not modify production or GCP resources. The chart guard
remains in place.

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
Its WebSocket upstream read timeout is 45 seconds: Node's existing 30-second
protocol pings keep healthy paused sockets alive, while a deleted proxy's
blackholed TCP flow must not remain apparently connected for ten minutes.
Ordinary HTTP observation retains its 600-second timeout; workflow probes still
use their independent 15-second deadline. There is no request/control retry.
The runner selects `ha-edge-v2` before opening its browsers, so a fixture prepared
by an older release cannot silently reuse the old timeout. The old disposable
edge remains untouched until namespace teardown; application seeding is not replayed.
After old proxy UIDs disappear, the retained-browser probe separately waits for
every original socket to close and replacement logical sessions to finish ordered
replay before clicking Resume once. Pod disappearance alone does not prove
browser reconnection. With an external gateway and only web-pod replacement, a
healthy unchanged API socket remains valid; the probe does not force reconnects.
An uncertain Resume is not sent again by cleanup.
Bounded control/event traces retain owner names, timings, request IDs and replay
readiness, never signed owner paths, capabilities or request/response bodies.

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
heartbeat. Both interrupted runners must retain their exact original pod UID.

Lease-loss injection is placed immediately before the serialized runner's next
journal replacement, after begin is accepted. The injector commits through the
real API, then the original stale-version write must receive an explicit API
`Conflict`. Injecting immediately after begin can instead race the heartbeat and
make the injector lose the CAS; that is not controller-fencing evidence. Unknown
injection outcomes are never retried, and a different operation/runner blocks
injection. An unknown begin acknowledgement never arms the lease-loss fault in
runner cleanup. The original failure remains chained if the expected conflict is
absent.
Explicit exact-token recovery must observe the command, never issue it twice.
The paused-editor fixture measures its hold with a monotonic clock and rechecks
the minimum duration after timer wakeups. It does not infer elapsed time from a
VM wall clock or weaken the 45-second observation. Individual editor receipts are
saved before validation, including on a failed recovery observation.
Public requests continue during both fault/recovery sequences. Their receipts
and zero-failure traffic report are required before certificate generation.
The standalone `recovery` phase can exercise these faults after a successful
local `roll`, without calling the destructive fixture preparation path again.
