# Online adoption of overlapping editor backends

## Starting point

Build 44564262037 deployed with managed schema 22, one editor backend and two
ready published execution replicas. That rollout enabled frozen dependency
capture using the singleton path. The saved paired-pool policy allows up to
seven regular execution replicas and seven temporary ones during a handoff.
Refresh the installed values, versions and owners during preflight.

The serial first-adoption operator drains the only editor and scales it to
zero before replacement. The online operator reuses the steady overlap
retirement and ownership protocol for a singleton with paired execution
pools. The first transfer starts with housekeeping inside the legacy editor
API, so it has its own sequencing and provider proof.

The design addresses three constraints from the installed layout.

- Helm and the rolling operator now accept paired execution pools with editor
  overlap under the existing HA and protected-routing requirements.
- The chart budgets editor and execution surges separately. The saved
  305-connection allowance fits the 304-connection bound for this shape,
  including one session for the restore coordinator. Supply explicit memory
  and ephemeral-storage limits for the replacement editor.
- Both execution StatefulSet templates retain the installed runtime scope.
  Adoption leaves the active slot, controller, and published routes in place.

[First-adoption operator](../../deploy/studio-server/scripts/lib/ha-control-topology.mjs) ·
[Paired-pool preparation](../../deploy/studio-server/scripts/lib/execution-pool-resources.mjs) ·
[Helm validation](../../deploy/studio-server/helm/templates/validate-values.yaml) ·
[Workload environment](../../deploy/studio-server/helm/templates/_env.tpl)

## Availability contract

Adopt overlap on the installed images and schema 22. Keep the web and proxy
workloads, published routes, authentication, and execution pools in place.
Once adoption is qualified and settled, use the online rolling path for the
next separately qualified application update.

From before the first change through settlement, existing browser sessions
can read and save projects and start editor runs. New sessions can sign in.
Accepted runs and paused debugger work finish on their original process.
Idle streams can reconnect in the same browser session, preserving open tabs
and unsaved edits. A save on one editor must be visible on the other.
Published endpoints and web apps must return complete results throughout,
including requests that cross a handoff and requests using normal
authentication. The proxy uses the editor API for UI authentication, so a
healthy execution pool alone cannot prove that the installation is usable.
[Proxy routing and authentication](../../deploy/studio-server/images/proxy/default.conf.template)

The steady state is one editor backend and one housekeeping worker. Use a
second editor on the same node only during handoff. New backup-restore and
bundle-preparation requests can wait for housekeeping. Accepted work and
completed downloads must survive. This contract covers a planned rollout.
Both editors share a node and its storage during overlap.

## 1. Preserve capacity and routing

Permit paired execution pools with overlap in the chart and the operator
under the existing HA, admission, request-protection and execution-controller
requirements. Compare the renders and live inventory by resource identity.
Limit changes to the editor backend and temporary editor API and executor
Service selectors. Keep the exact execution templates, active slot and
autoscaler policy, and the same Gateway, routes, storage and credentials.
Scope the editor mode change away from execution without dropping the
environment setting that gives execution its published-schedule scope.
Verify Latest schedules and the execution-backed proxy health route too.
[Schedule ownership](../../packages/studio-server-api/src/ha-control-plane.ts)

Retain the installed execution limits and PostgreSQL pool size. Reuse the
[existing sequential workload loop](../../deploy/studio-server/scripts/lib/ha-rolling-upgrade.mjs)
and execution-pool ownership checks. Before an editor surge, prove the
inactive or retiring pool is empty. Before a paired execution surge, prove
the extra editor and its database sessions are gone. Check these conditions
on resume as well as on a fresh run. The active pool can autoscale within
its ordinary range during editor overlap.

Budget for the larger enforced peak. The saved seven-plus-seven policy and
current per-process allowances give preliminary bounds of 201 connections
with seven execution replicas, two editors and a housekeeping worker, and
303 with fourteen execution replicas, one editor and a worker. Both include
the 30-connection reserve, shared query and LISTEN connections, schedulers
and restore pools. Count the additional restore-coordinator session during
adoption, along with any concurrent operator and backup connections. Verify
the real allocation and usage and cover terminating processes before
changing phases. If the envelope does not fit, hold for an online capacity
solution. The current serial pool-sizing stage takes the editor offline.

Size the editor with and without its housekeeping worker. Use the existing
750m CPU and 1536 MiB request as a starting point for measurement. Verify
CPU, RAM, ephemeral storage and a pod slot on the actual backend node,
including init containers, sidecars and other occupants. Keep the exact
bound PVC and PV. Verify both editors' placement and mount identity.
ReadWriteOnce supports sharing on the same node. The staging rehearsal must
confirm it with the actual storage driver.
[Kubernetes access modes](https://kubernetes.io/docs/concepts/storage/persistent-volumes/#access-modes)

## 2. Adopt with the existing deployment journal

Extend the existing deployment command with a first-adoption path under
`--require-online`. Keep the current serial stages blocked under that
guard. Reuse the operation lease, resource and owner checks, retirement
protocol, and authenticated acceptance adapter.

The current certificate delegates serial adoption using the same chart as
the installed release and relies on mixed-image qualification. Bind a
topology-only receipt to the installed promoted manifest, identical
application image digests and schema, and the exact bootstrap, fenced and
final renders. Verify their allowed changes against the installed resources.
Keep ordinary mixed-image checks intact. Record the settled chart
and configuration identity with the installed image manifest so the next
qualification can start from the actual predecessor.
[Existing adoption authority](../../deploy/studio-server/scripts/lib/overlap-adoption.mjs)

Capture the backend template, Service selectors, volume identities, active
execution pool and source pod UID and process incarnation. Verify an online
recovery checkpoint covering database metadata and object data. Start
both traffic observers before any template or routing mutation.

Hold the existing PostgreSQL restore-coordinator lock on one dedicated
session during handoff. Then check that restore and other source maintenance
work are idle. This is the lock the legacy restore service takes *before*
it writes `draining`, so it closes the race left by an idle status check.
Keep the separate serving lock and workspace epoch in place. Verify schema
22 without running the migration Job, which also needs the coordinator
lock. Loss of that session stops mutations until the lock and restore
state are rechecked. Release it on verified settlement or safe abort.
[Restore coordinator and serving lock](../../packages/studio-server-api/src/legacy-restore/control.ts) ·
[Restore confirmation](../../packages/studio-server-api/src/legacy-restore/service.ts) ·
[PostgreSQL advisory locks](https://www.postgresql.org/docs/current/explicit-locking.html#ADVISORY-LOCKS)

1. **Keep the source serving while the standby starts.** Limit the normal
   editor API and executor Services to ordinal `-0` with the StatefulSet's
   existing pod-name label. A recreated source can still match that
   selector while the standby is unready. Keep the headless Service
   available for existing owner-addressed sessions. Use an exact
   ordinal-aware bootstrap template on the existing OnDelete StatefulSet
   and scale to two. With the pinned images, `-0` can still start in
   legacy mode and `-1` starts as an overlap editor without housekeeping.
   Verify both restart behaviors. [Kubernetes StatefulSet pod labels and updates](https://kubernetes.io/docs/concepts/workloads/controllers/statefulset/#on-delete)
2. **Verify and admit the standby.** Check both its UID and incarnation.
   Verify authenticated project reads, saves and the executor handshake
   against the candidate directly. A green health probe alone can also
   describe a restore-only process. Label both accepted pods with one
   operation-owned admission label. Replace the source-name selector
   filter with that label on both ordinary Services, preserving the
   original selector fields. Verify actual routed traffic to the standby
   and a serving endpoint on each Service as the changes propagate.
3. **Drain the legacy owner.** Only after the standby serves on both
   Services, arm the pinned supervisor's per-ordinal startup fence for a
   newly created `-0`. It cannot change the spec of the existing Pod or a
   restart in that Pod. Remove the old pod's admission label, observe
   routing withdrawal and close its admission through the existing
   retirement protocol. Leave accepted debugger, editor, scheduled,
   export and housekeeping work to finish with their original owner.
   Reconfirm the standby and the exact old UID and incarnation at the
   admission and deletion boundaries. Require the old pod's graceful,
   UID-preconditioned termination before transferring housekeeping.
   A replacement or restarted incarnation invalidates the old drain proof.
   If accepted work is still running when the wait expires, retain its owner
   and hold the operation at the recorded phase.
   [Pinned supervisor startup fence](../../deploy/studio-server/images/api/backend-supervisor.mjs) ·
   [Kubernetes graceful termination](https://kubernetes.io/docs/tasks/run-application/force-delete-stateful-set-pod/#statefulset-considerations)
4. **Start the final owner.** After recording termination of the legacy
   processes and children, apply the final overlap template at two
   replicas. If Kubernetes already created a fenced `-0`, verify its
   identity and that it admitted no work before replacing it gracefully.
   Confirm that the new `-0` acquired the existing housekeeping lock
   and published the matching owner descriptor. Check completed exports
   and restore status. Accept the new editor directly, admit it to both
   Services, and verify routed traffic before withdrawing `-1`.
5. **Settle with one editor.** Withdraw and drain `-1` while `-0` serves.
   Keep owner-addressed routing until the accepted sessions finish.
   Scale down with the guarded retirement protocol. A recreated standby
   lacks the admission label. After it is gone, restore the normal
   Service selectors while `-0` remains selected, then remove the
   temporary label. Verify the final chart, one editor, one housekeeping
   worker, the original execution pool state and live routed traffic.

Journal each write before issuing it. Bind preconditions and acknowledgements
to exact workload, Service and Pod identities and resource versions. Before
each selector change, check that the proposed selector still matches the
ready editor that will keep serving. Restore the normal selectors only after
ordinal `-1` is absent and the StatefulSet is back to one replica.

An abort before source withdrawal keeps the ordinal-aware bootstrap template
until the standby is gone. If the source startup fence was armed, disarm it
and restart any unadmitted, startup-fenced placeholder while the standby
serves. Confirm source routing, drain any admitted standby, then restore
the legacy template and normal selectors. A restarted source can keep
serving from the bootstrap revision in legacy mode. A later adoption's
preflight verifies that exact retained Pod and controller revision.

On resume, a recreated serving editor must pass the authenticated checks on
an approved template and regain its operation-owned routing label before the
handoff can continue. A completed acceptance check is reused for the same
UID and incarnation. A change to the departing process after withdrawal
starts invalidates its drain proof and stops retirement. Lost locks, failed
probes and unconfirmed retirement writes also stop advancement.

## 3. Prove both transitions

1. **Local checks.** Render singleton, bootstrap and settled overlap
   with the saved paired-pool settings. Assert the exact allowed diff,
   schema verification with the migration Job disabled, execution
   scheduling scope, both surge bounds and guard behavior. Exercise both
   operator paths, including resume. Test a source restart before
   standby admission, a recreated serving replacement, an unschedulable
   standby, an abort after fencing, restore confirmation racing the lock,
   loss of the lock, and a departing incarnation restarting during drain.
   Verify recovery after interrupted label, selector, deletion and scale
   writes, including a standby ordinal that lingers after scale-down.
2. **Local rehearsal.** Extend the existing overlap fixture with the
   pinned predecessor, paired pools and disposable PostgreSQL, object
   storage and restore volume. Hold a browser session with unsaved
   edits, save across the two APIs, start new runs during each
   withdrawal, and finish a paused run on its original owner. Verify
   cross-editor refresh and successful reconnection for streams and
   debugger sessions. Confirm accepted runs and scheduled jobs complete
   once, with no lost writes, forced reloads or failed visible actions.
3. **Staging qualification.** With separate approval, run the exact
   adoption on a production-shaped GKE fixture. Start both observers
   before the first mutation and keep them running through cleanup.
   Check fresh login and existing authenticated sessions, public and
   protected published workflows and web apps, and requests near the
   protected 300-second deadline. Use fresh and reused connections,
   full-result checks and recording checks. Require actual requests
   crossing each withdrawal and ownership transfer. Record identities,
   database and node headroom, retained storage and final cleanup. The
   existing mixed-image qualification alone cannot certify adoption.
4. **Production decision.** Recheck the installed manifest, live
   configuration, backup, active leases and capacity against the
   qualified operation. A mismatch or failed continuity check blocks
   advancement. Keep the same continuous checks during the approved
   handoff. Qualify the frozen dependency release separately from the
   settled overlap baseline, including paired execution handoff and
   the editor handoff in the same rolling operation. Use schema 22
   compatibility and the online guard for both.
   Check allocatable resources on the current editor node, including platform
   reservations. The shared ReadWriteOnce volume requires same-node placement
   for the handoff. Free capacity elsewhere in the cluster does not satisfy
   this check.

## Operator inputs and recovery

Use the existing deployment command with `--require-online`,
`--online-editor-adoption <receipt.json>`, the installed promoted
`--manifest`, the reviewed target `--values` and `--deployment-policy`.
Pin the Kubernetes context, namespace and release as usual. Use the same
inputs for `--plan-only`, `--preflight-only` and authorized execution.
Plan and preflight are read-only with respect to the cluster.

The receipt is a JSON object with `formatVersion: 1`, kind
`rivet-online-editor-adoption`, the installed manifest digest, schema and
Helm revision, the reviewed operator Git SHA (`operatorSource`) and
`chart` identity. It binds `installedSettingsDigest`, `valuesDigest`,
`sourceResourcesDigest` and `configurationDigest`. The last two are
`getHaConfigurationDigest` over the original pinned Helm manifest and the
target render respectively. Use the deployment command's render inputs with
the installed images, schema verification and the migration Job disabled.
Release identity records the adopted editor mode and the reviewed chart digest.
The installed application manifest, source, images and schema remain pinned
until the separately qualified image update.
The bootstrap and fenced templates are derived from that render.

Under `qualification`, record the passing isolated-provider outcome,
`operatorSource`, `chartDigest`, `installedManifestDigest`, zero
`failedRequests`, verified cleanup and the actual
`online-editor-adoption-observations.json` value as `observations`.
`evidenceDigest` is the SHA-256 of `JSON.stringify(observations)`.
The deployment policy pins the full receipt file as
`onlineEditorAdoption.receiptSha256`. The provider path measures full responses
on fresh and pooled HTTP/1 and HTTP/2 connections. Each cohort must be
accepted before the first mutation at its boundary and finish after that
boundary settles. The housekeeping cohort starts before the original editor
is deleted. The evidence must show actual HTTP/1 connection reuse and match
each protected request to one recording. The provider upgrade report carries
the same observations. Verify cleanup before issuing the receipt.

The reviewed application adapter handles the usual `before`, `backend` and
`after` stages. In the `online` adoption stage, `backend` proves
`developerApi`, `projectSave` and `editorSession` for the exact candidate
incarnation. The `online-overlap` stage echoes `handoffPhase` and any
`backendCandidate` identity and verifies `workflow`, `webApp`,
`developerApi` and `editorSession` against the ordinary routes. Keep the
reviewed traffic observation running across the whole handoff. The existing
online backup stage supplies the recovery checkpoint.

Use `--resume-ha <token>` with the original inputs after an interruption.
Only before source withdrawal can `--abort-online-adoption` restore source
routing and drain the standby. Once withdrawal starts, resume with the same
journal. The final Helm write checks the reviewed installed revision, restore
lock and routed editor. If the guard refuses before Helm is invoked, the owned
journal can clear the write intent. If delivery is uncertain, preserve the
serving layout and inspect Helm history. Resume confirms the expected deployed
revision and manifest before completing the journal. The settled Helm
revision records the handoff identity so verification can still run after
the autoscaler takes the shared journal. Use the original inputs with
`--acceptance-only` and supply the original `--acceptance-request` when
resuming its observer.

Local validation covers the production-shaped Helm render, the handoff
against a deterministic Kubernetes fixture, interrupted retirement and
routing writes, protected evidence validation, and headless debugger replay.
The source-contract CI job runs the handoff and recovery tests without a
cluster. The restore lock was checked against a disposable PostgreSQL database.
The exact GKE rehearsal and live production capacity remain release gates.

[Steady overlap contract](developer-backend-overlap.md) ·
[Provider qualification](automated-runtime-qualification.md) ·
[Online rollout planning](deployment-operations.md#online-rollout-planning)
