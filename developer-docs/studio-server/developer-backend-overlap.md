# Developer backend overlap

Implemented as an opt-in protocol; local integrated qualification passed (2026-10-23).
Not provider-qualified or enabled in production.
First activation now has explicit same-image `sizing` and `ownership` stages in
the existing production command, delegated by the exact candidate certificate.
Pool preparation is separate from ownership transfer and uses the original
singleton procedure; it is not a developer-continuity claim. Certificate and
stage are bound into backup, admission and recovery. No old manifest is rewritten.
See the first-activation procedure in the qualification guide below.
The maintained provider runner now has an opt-in overlap suite; see
[automated qualification](automated-runtime-qualification.md). Local runner/Helm
regressions do not replace the outstanding exact-image GKE qualification.
This is planned-upgrade continuity, not node-failure HA or whole-UI availability.
Schema-changing overlap qualifications must also satisfy the
[rolling database contract](deployment-operations.md#rolling-database-compatibility-contract).
DB compatibility does not qualify same-node placement, lock handover or editor
session continuity, and passing those overlap checks does not certify a migration.
The web server remains independent and single-instance. No GCP changes are part
of local implementation or testing.

## Contract

`ha.controlPlane.mode: singleton-overlap` retains one steady backend plus the
existing six other compact-runtime pods. An owned upgrade briefly grows the
backend StatefulSet to two. Only these backends co-locate on one node; other
tiers retain their placement rules. The original ReadWriteOnce restore claim
is preserved. Managed storage and disposable runtime caches are mandatory.
Do not raise `replicaCount.backend` from one to two to enable redundancy.
Keep it at one in this mode; only the recorded deployment operation owns temporary
overlap. The warning is also documented beside this setting in `values.yaml`.

A maintenance-only API worker lives inside the owning backend, not another pod.
The developer API and executor remain usable while that worker is unavailable.
Standbys start no maintenance worker or maintenance DB pools. The connection
budget includes the extra worker and temporary developer surge; pod count alone
is not a resource-consumption measurement.

The default combined `resources.backendOverlap` request is **750m CPU / 1536Mi**
per backend (developer API/executor plus the active maintenance process). During
surge Kubernetes reserves that envelope twice on the same node. It is a conservative
request, not a measured peak or permission to reuse old memory-limit acknowledgements.
Production renders require separate `backendOverlap` memory/ephemeral-storage limits
or explicit sizing acknowledgements. The PostgreSQL budget includes one maintenance
API process and one surge process, their shared query/LISTEN/restore pools, and the
existing scheduler pools. Only the active worker starts maintenance pools.

With the current generic pool/reserve/restore arithmetic, singleton control with
seven maximum execution owners budgets 186 connections. Overlap with the same
seven-owner maximum needs 201, so a 200-connection Rivet allowance correctly
rejects it. A six-owner overlap ceiling budgets 184, but reducing capacity is an
operator decision, not an automatic migration. Do not raise the recorded
allowance or lower production capacity just to enable this optional mode.

An alternative locally rendered staging profile keeps ceiling seven, the existing
200-connection allowance and reserve30, but uses nine pooled connections per API
process. It retains the 750m/1536Mi backend request and explicit 3Gi memory/2Gi
ephemeral-storage limits. Both overlap backends reserve this envelope during
replacement. The provider profile is explicit/hash-bound, never a change to Helm
defaults or an automatic production adjustment. Real capacity/throughput and
same-node scheduling still need provider verification and operator approval.

The worker starts only after kernel `flock` on a persistent, non-symlink lock
file. The inode is never replaced/deleted. Descriptor 3 is inherited by worker
children; an orphaned archive/npm/restore child blocks takeover even after its
parent dies. There is no TTL or force-unlock. Unsupported subprocess helpers
fail closed instead of dropping the descriptor. Existing PostgreSQL restore
fences remain authoritative for application quiescence.

Subprocess environment sanitization (notably restore package reinstallation)
must retain the authoritative lock root and ownership preload. The spawn boundary
adds those invariants without restoring stripped credentials or replacing the
child's own `NODE_OPTIONS`. A worker that exits while its descriptor is being
published is failed, never advertised as a confirmed owner; its supervisor still
retains the kernel lock for inspection.

The owner descriptor is private, atomically published after readiness and bound
to namespace UID, pod UID, incarnation and an internal capability. It is a routing
hint, never permission to steal a lock. Maintenance requests remain authenticated,
streamed and non-retrying. During handover they may return HTTP 503 with code
`housekeeping_handover`; the operator can explicitly try again. Never retry an
upload whose outcome is uncertain without checking its existing operation.

New restore uploads and bundle preparations close before worker retirement.
Status/downloads and confirmation/cancellation of an already accepted restore stay
available while it settles. An awaiting-confirmation, failed or unfinished restore
blocks transfer; it is never silently abandoned. The restore's own acknowledged
generation restart has a separate settled-journal check, so it does not wait on
its own planned-upgrade fence. That exception is not available to normal upgrades.

During a restore, developer consumers restart independently of the housekeeping
worker. The developer API sends an incarnation-bound IPC notice before its
restore-driven exit; the supervisor cycles only that API and editor executor.
The worker and its kernel lock stay alive until the durable restore coordinator
acknowledges a generation restart. Recovery ownership starts even while the
developer API is fenced. The private worker contract exposes `maintenanceReady`
separately from ordinary developer `/readyz`; readiness of the developer API
must not become a prerequisite for recovering the restore that fences it.

After requesting child shutdown, the supervisor closes developer retirement IPC
so its message listener cannot keep a settled executor alive. It observes actual
developer process exit; it does not use IPC-close bookkeeping as a work-completion
signal. This does not alter maintenance ownership: that worker still waits for
actual close and its descendants retain the inherited kernel lock.

## Upgrade and recovery

The normal deployment journal records release/acquire intent before commands.
The exact candidate must pass installation-adapter `stage=backend` acceptance:
`developerApi` and `editorSession` each require observed, passing, nonempty
evidence, with the exact `backendCandidate.uid` and `incarnation` echoed in the
receipt. Health checks alone cannot withdraw the previous backend.

Accepted editor runs and maintenance work must drain. Timeouts retain owners and
the claim; they do not abort work. Unknown acknowledgements are observed, not
replayed. A changed UID/incarnation or missing same-node placement blocks removal.
Hand back maintenance to ordinal zero before retiring the temporary ordinal.
Both nested housekeeping and supervisor identities must agree before a handover
command. Recovery observations must match the journal's operation token as well
as protocol, pod UID and incarnation; another operation's `released`/`owner` state
cannot satisfy an uncertain command. Repeated acquire for the same operation is
idempotent; a foreign acquire is rejected without poisoning a healthy owner.
Before recording a new handover, the target must be `standby` or `released`.
Developer acceptance does not prove that its independent housekeeping lifecycle
can acquire ownership. A failed, busy, stopped or unknown target blocks transfer
without closing the old worker's admission or recording a release intent. A
previously released target remains reusable; recorded lost-acknowledgement recovery
continues to observe its existing intent instead of starting another handover.
Before the release intent is issued, re-read the exact target incarnation and its
acquirable state, including when resuming an initial checkpoint. Once release
intent exists, preserve the existing observation-only recovery rule.

Preflight reads the existing backend node's allocatable capacity, all scheduled
pod requests (including init sidecars and pod overhead), and remaining pod slots.
Insufficient overlap capacity fails before candidate templates. Kubernetes still
makes the final scheduling decision; failed scheduling never permits old-owner
removal. The journal binds maintenance PVC UID, volume name, access mode and
requested size; recheck this identity before each transfer and final settlement.
Before the initial journal CAS the runner refreshes a completed shared journal
that the idle autoscaler may have advanced during read-only preflight. It never
retries a failed ownership write. The topology bridge preserves the independent
autoscaler template and capacity instead of treating it as a frontend.

First adoption requires a same-image bridge with `housekeepingOverlapProtocol=1`
and `maintenanceIdle=true`, and a separate recorded topology transition. Idle
inspection is read-only: unknown, corrupt or nonterminal bundle journals and
unfinished restore operations block adoption rather than initializing recovery,
deleting scratch or discarding work. Old ownership-unaware images must
first be upgraded serially; that initial developer interruption needs separate
production approval. Never use generic Helm scale or rollback to enable this.

## Diagnostics and exact recovery

Serving readiness and `housekeepingReadiness` are separate status fields. A readable
descriptor is not sufficient: status probes the authenticated worker contract and
matches both pod UID and process incarnation. Housekeeping unavailability does
not make the developer readiness probe fail.
In overlap mode `/api/deployment-status` also includes `servingReadiness`
(`ready`, `state`, `checkedAt`, optional `code`) from the current developer API's
health reader, including restore-maintenance and debugger-peer fencing. This is
not the runtime-library sync registry and is not a replacement for the combined
backend/executor acceptance check. Existing restore-standby probe behavior is
unchanged; the status correctly distinguishes it from serving developer work.

1. Retain the original manifest, chart, values, installation identity, private
   backup evidence and operation journal. Read the exact pod retirement socket
   (`node /opt/rivet/retire-backend.mjs` inside that recorded backend) and compare
   pod UID/incarnation, not merely a name or ordinal.
2. For a paused/long editor run, finish or explicitly resume the original run;
   do not abort it to unblock an upgrade. New editor work belongs on ready capacity.
3. For `waiting` housekeeping, inspect its existing restore/job status and finish
   or cancel that exact operation through the normal UI. Never re-upload to hide
   an uncertain response. For `failed` or unknown ownership, retain both backends
   and disk; inspect exact worker/descendant process identities. Do not delete the
   lock inode, reset a timestamp, kill unknown processes, or force ownership.
4. Once the original runner has stopped and its lease has expired, resume the
   **same** deployment command with its exact `--resume-ha <token>`, original
   inputs and installation acceptance adapter. Retain
   `--ha-control-plane-transition` for adoption recovery. Recovery reads recorded
   release/acquire/removal intent and actual state; it does not repeat an unknown
   write. A lost acknowledgement that never applied may require explicit operator
   investigation, not a new deployment or rollback.
5. Finish only after ordinal zero is serving, the temporary ordinal is absent,
   there is one confirmed housekeeping owner, the original claim is unchanged,
   startup fences are absent, and application acceptance passes.

## Local evidence

Mandatory Linux tests run the actual worker process and kernel flock, including
paused owners, parent death, surviving grandchildren, symlink rejection and
handover with preserved bytes. No test may report these as passing via a Windows
skip. Stand-in Kubernetes tests are command/protocol evidence only; scheduling,
storage attachment, real bundle/restore operations and browser continuity need
their separate local integration checks before completion is claimed.

Local entry points (none use the operator's current Kubernetes context):

- `node deploy/studio-server/scripts/verify-housekeeping-linux.mjs`: real flock,
  paused owner, surviving descendant, guarded paths and busy-worker handover.
  Windows runs the Linux fixture in Docker; absence of Docker is a failure, not
  a passing platform skip. This runs in `verify-kubernetes.mjs` too.
- `node deploy/studio-server/scripts/verify-housekeeping-managed.mjs`: disposable
  PostgreSQL/MinIO, real maintenance API, preserved export bytes and accepted
  restore journal, with new uploads fenced and no request replay.
- `RIVET_RESTORE_OVERLAP_LINUX=1 yarn workspace
@valerypopoff/rivet-studio-server-api test:legacy-restore-managed`: full compiled
  Linux restore, real editor executor, PostgreSQL/MinIO and supervised generation
  changes. Windows orchestrates Linux containers; it generates a Linux backup
  from synthetic source bytes so archive integrity checks are not disabled for
  host filesystem differences. This also restores a deliberately modified archive
  only through the existing explicit integrity-override workflow.
- `RIVET_OVERLAP_LOCAL_NODE=<explicit-local-minikube-container>` plus
  `verify-backend-overlap-scheduling.mjs`: initial self-affinity, blocked oversized
  surge without losing the original, same-node RWO mount and unchanged bytes.
- `kubernetes-developer-overlap-local.mjs`: production-style local images, serial
  bridge adoption, mixed-image overlap, authenticated per-pod API/WebSocket
  acceptance, paused editor runs, retained headless browser and seven-pod return.
  The images must be built locally using the image Dockerfiles first; development
  web/proxy containers are not compatible substitutes. Prepared immutable local
  image inventories can be reused without rebuilding or remote publication.

The browser proof distinguishes backend-only replacement from a frontend rollout.
It requires the original web-pod UIDs to remain for the former, and to disappear
for the latter; backend continuity must not be reported as web-server continuity.
The dashboard Save Playwright regression records even transient conflict notices,
not just the final absence of a warning after an own-save.

The local overlap fixture requests 500m CPU for execution owners. Generic smoke
fixtures use 100m, which can make ordinary startup CPU exceed the real retirement
headroom budget. The overlap test waits for actual fresh metrics and budgets
startup resources; it never fabricates zero samples or relaxes the production
headroom guard. These local requests are not production sizing recommendations.
Its combined functional run uses five-second controller polling, thirty-second
stabilization and five-second cooldown, while retaining the real sixty-second
withdrawal windows and actual metrics. Production defaults remain fifteen,
three hundred and sixty seconds respectively. After application acceptance,
the fixture waits up to ten minutes for the real controller to return to seven
ready pods; it never manually shrinks execution capacity. This is functional
evidence, not a measurement of production timing.

Command/receipt tests include lost housekeeping release/acquire acknowledgements;
Helm tests reject unowned replicas, shared caches, absent namespace identity and
insufficient connection budgets. Local limits/requests are fixture envelopes and
are not provider capacity measurements. See `artifacts/overlap-*.log` and the exact
`artifacts/developer-overlap-*/` receipts; failed attempts remain failed evidence.

### Provider-path local verification (2026-10-29)

The opt-in provider driver and publication contract have local coverage for the
explicit sizing profile, same-node/UID/incarnation observations, both handovers,
original-token acknowledgement-loss recovery, retained browser/editor work,
bundle-project execution identity, unchanged PVC/PV and rejected incomplete facts.
The combined focused matrix passes 100 tests with no failures or skips; the real
Linux ownership suite passes 12 checks. Four additional rollout/recovery checks
include both actual-command lost-housekeeping-acknowledgement journeys. Four
headless browser checks (fixture auth plus bundle HA replay, failure and
shared stop) also pass.

The new `verify-housekeeping-managed.mjs --provider-fixture` option runs the exact
bundle-preparation helper through real guarded HTTP routes against the published
`4d19782ea` API image and disposable schema-18 PostgreSQL/MinIO. It verifies saved
two-project export, preserved bundle bytes and accepted restore-journal recovery
through housekeeping transfer, using the proposed nine-connection pool and a
200-connection local database. Temporary containers/network are removed; existing
developer containers remain. The intentionally invalid restore upload is an
admission/fencing test, not a successful restore or a production-data operation.

These are local implementation checks. They do **not** certify GKE scheduling,
provider handover/traffic, production throughput, first adoption, or whole-UI
zero downtime. The provider suite must still run against reviewed immutable
release/driver inputs after normal publication and separate staging approval.

### Verified local checks (2026-10-23)

- `artifacts/developer-overlap-caa23ce0/developer-overlap-result.json`: the complete
  mixed-image Kubernetes operation passes, including serial bridge adoption,
  both exclusive housekeeping transfers, accepted per-owner editor work, retained
  browser editing/saving, outputs, recording playback and return to **seven ready
  release pods**. The browser has zero dashboard/iframe reloads and exactly two
  explicitly requested runs, with playback submitting no third live run.
  Its `ha-rollout.json` is complete and preserves the original PVC/PV identity.
  `cleanup.json` verifies removal of the exact disposable namespace and volume.
  Pre-existing local cluster, registry and build caches were preserved. Earlier
  failed attempts remain failed evidence and are not combined into this result.
- `artifacts/overlap-complete-verified-regressions.log`: 521 passing deployment
  regressions, zero failures, plus local/production Helm renders. Two unrelated
  optional checks were skipped (Docker partial-startup and Postman simulation).
  Mandatory Linux ownership tests executed separately and were not skipped.
- `artifacts/overlap-linux-lifecycle-final.log`: nine real Linux ownership/process
  tests, all passing; `overlap-supervisor-linux-verified.log`: 31 supervisor and
  retirement tests, all passing without platform skips.
- `artifacts/overlap-api-final-native.log`: 45 API/restore/ownership checks pass;
  `overlap-types-verified.log`: API TypeScript check passes.
- `artifacts/overlap-managed-verified.log`: real PostgreSQL/MinIO bundle archive
  bytes and an accepted restore journal survive exclusive worker handover; new
  uploads are fenced and no accepted request is replayed.
- `artifacts/overlap-restore-linux-verified.log`: original and explicitly modified
  backup restores pass through compiled Linux workers, editor executor and actual
  supervised generation restarts. `overlap-restore-participant-final.log`: five
  additional restore participant regressions pass.
- `artifacts/rivet-overlap-6607677b/inventory.json`: actual multi-node initial
  scheduling, insufficient-capacity blocking with the original ready, same-node
  surge and unchanged shared RWO bytes pass; exact namespace/volume cleanup was
  verified in that operation's cleanup receipt.
- `artifacts/overlap-ui-regressions.log`: 14 headless editor/bundle-debugging,
  saving and deployment-status regressions pass. The strengthened own-save
  transient-conflict check also passes in `overlap-ui-save-conflict-verified.log`.
- `artifacts/overlap-browser-proof-regression-verified.log`: 38 proof-harness
  regressions pass, including the backend-only versus frontend identity contract.
- `artifacts/overlap-observed-status-verified.log`: 26 API/profile/forwarding checks
  pass, including real HTTP separation of serving readiness from unavailable
  housekeeping and restore standby. This additive status reporting is verified
  independently of the immutable container used by the mixed-image lifecycle proof.

These receipts establish local behavior only. They do not certify GKE, whole-UI
zero downtime, a production release, or permission for first production adoption.

### Follow-up ownership review (2026-10-23)

The follow-up regressions reproduce and close three boundary failures: accepting
another operation's handover state, reporting an owner after a worker exits during
descriptor publication, and losing the lock root/caller Node options in sanitized
restore subprocesses. Worker failure still retains fencing; no force takeover or
write retry was added. Tests that inspect generated descriptors, plans and journal
receipts declare the repository's fixture-read annotation; they do not assert
implementation source text or expand the source-reading allowlist.

The earlier mixed-image Kubernetes receipt remains evidence for its exact images,
not a rerun of these subsequent changes. Follow-up process, managed-storage,
command-stand-in and headless UI checks are recorded separately in
`artifacts/overlap-review-*.log`; scheduling and pod-count configuration are unchanged.

- `overlap-review-kubernetes.log`: 527 passing deployment regressions, zero
  failures, two unrelated optional skips, and successful local/production Helm
  renders. Actual command recovery covers lost release/acquire acknowledgements.
- `overlap-review-linux.log`: all 11 real Linux ownership/lifecycle tests pass,
  with no platform skips, including crash-during-publication and sanitized child
  environment regressions.
- `overlap-review-managed.log`: real disposable PostgreSQL/MinIO handover
  preserves bundle ZIP bytes and the accepted restore journal, without replay.
- `overlap-review-ui.log`: both headless Save and deployment-status checks pass.
  The fixture's labeled containers and network are verified absent afterward.

The adjacent admission review adds a real-process failed-target check: the old
worker stays serving when the replacement cannot open its lock mount. The
handover suite also covers failed/busy/unknown target states, reuse of a released
target and interruption after the initial checkpoint, before release intent.
`overlap-adjacent-review.log` records 119 passing focused deployment/Helm checks;
`overlap-adjacent-linux.log` records 12 passing Linux process/lock checks, without
skips; `overlap-adjacent-ui.log` records two passing headless UI checks. Both selected
actual-command lost-acknowledgement checks pass, with no skips, in
`overlap-adjacent-command.log`. No new provider or immutable-image qualification
is claimed by this review.

### Commit-preparation checks (2026-10-24)

The current checkout re-runs all 12 mandatory Linux lock/lifecycle checks and
all 19 backend supervisor checks in isolated Linux containers, with no skips.
The focused API profile, ownership, maintenance and restore suites pass all 73
tests, and API TypeScript compilation passes. Receipts are recorded separately
in `artifacts/commit-prep-*.log`; these checks do not replace the earlier exact
mixed-image lifecycle receipt or claim a new GKE qualification.
The full local deployment regression run passes 538 tests with two optional
checks skipped, followed by successful local/production Helm renders. The
mandatory Linux tests above run separately without platform skips. Repository
style, documentation links, Studio Server test-style and structure checks pass.
