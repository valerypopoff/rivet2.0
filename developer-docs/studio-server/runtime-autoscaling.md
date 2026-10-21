# Drain-aware runtime autoscaling

## Scope and delivery status

Opt-in implementation, not a general GKE capacity certificate. One installation
was enabled through the explicitly approved operation-scoped maintenance waiver
recorded in [runtime qualification](runtime-ha-qualification.md); that exception
does not manufacture provider qualification for this policy or other installs.
Existing/local/non-HA installations keep their behavior. Ordinary HA execution
HPA still adds capacity only. The new controller replaces that HPA when enabled;
it is never a second writer of the same replica count.

The compact singleton layout has **seven baseline pods**: two proxies, one web,
one developer backend (including rare maintenance), two execution owners, and
one independent controller. Developer workloads do not scale with customer
traffic. The controller uses the API image but starts only a small Node program,
with no application DB pool, app key, storage credentials, editor or workflow.

Apply `gke-runtime-autoscaling.yaml` after `gke-ha.yaml`, `gke-runtime-ha.yaml`
and `gke-compact-edge.yaml` in a qualified installation. This policy enables
proxy HPA (2–4), with a five-minute downscale window and at most one removal per
minute, and execution controller scaling (2–10). These bounds are not measured
throughput. Never raise `postgres.maxConnections` just to pass rendering: use the
Rivet connection allowance within the real provider limit, preserving capacity
reserved for other applications on a shared database/instance. The chart budgets
maximum execution capacity, deployment surge, scheduler pools and
maintenance/restore connections.

The generic 2–10 overlay is not an installation-specific capacity approval.
With singleton control, the default 30 reserved connections, query pool of 10 and
the standard restore/scheduler/surge budget, a 200-connection Rivet allowance fits
at most 7 execution owners (186 budgeted connections); 8 needs 203 and 10 needs 237.
Set a lower reviewed `autoscaling.execution.maxReplicas` in installation values
rather than consuming other applications' headroom. This arithmetic is a safety
ceiling, not throughput or provider-capacity evidence.

Production enablement requires `evidence.runtimeAutoscaling`, bound to exact
source, images, chart and canonical controller-policy digest. Promotion accepts
`--runtime-autoscaling-evidence <receipt.json>`. Old HA, compact or singleton
receipts cannot qualify automatic retirement. Required GKE checks are exported
as `HA_AUTOSCALING_CHECKS`; do not fabricate receipts from unit tests or reuse
another image's results. Publication, provider tests and rollout need separate
approval. None are performed by local verification.

Use the separate [qualification publication workflow](runtime-ha-qualification.md)
after the exact isolated experiment and cleanup. It attaches evidence to the
original successful main candidate without rebuilding its tested images. It does
not run GCP tests or deploy workloads; install the qualified replicated bridge
before its separate same-image control ownership transition.

## Policy and demand

Capacity remains in `autoscaling.execution.minReplicas`, `maxReplicas` and
`targetCPUUtilizationPercentage`. Set `autoscaling.execution.enabled=false`,
`autoscaling.executionController.enabled=true`, `metrics.enabled=true` and
enforced published admission. The chart rejects two execution replica writers,
developer autoscalers, missing disruption budgets and maintenance validation.
Execution CPU requests and the Kubernetes Metrics API must be available.

Each serial reconciliation reads the exact StatefulSet/pod UIDs, retirement
incarnations, occupied slots and CPU samples. It takes the larger aggregate slot
and CPU recommendation, bounded by the approved range. Slots count accepted runs
waiting on external providers and scheduled published work, not only CPU-heavy
execution. Targets default to 60% occupied slots and 75% CPU requests.
Pending/unready/replaced pods, inconsistent limits, stale/missing metrics,
failed exec, a foreign HPA or unknown ownership block mutations instead of
becoming zero demand.
After an already-issued scale/removal, observation and journal completion do not
require load metrics or unrelated worker exec. Missing metrics still block the
next capacity decision; they cannot strand an otherwise settled retirement.

Scale-up happens on the next valid sample. Scale-down needs five continuous
minutes of low samples and a one-minute post-scale cooldown. Missing/error
samples reset stabilization. Defaults poll every 15 seconds and reject CPU
timestamps older than 90 seconds. Policy/image changes reset idle stabilization;
they cannot take over an unfinished operation from another policy/image.

Autoscaling is not instantaneous or unlimited. A jump beyond ready admission
capacity can still receive the existing overload response while nodes/pods
start. This change adds no durable submission queue and never replays requests.
Replica caps, provider limits, DB capacity, GCP quotas and provisioning time
remain limits. Measure representative peak demand and retain headroom; an idle
test cannot guarantee arbitrary-spike, zero-error service.

## Retirement, fencing and recovery

The controller CAS-acquires the **same release-operation ConfigMap** as upgrades,
topology transfer and maintenance cutover. `autoscalingProtocol:1` records the
policy, runner lease, token, workload/pod UID and process incarnation. Completed
idle records release their lease every tick. Unfinished records stay protected
even after lease expiry; a replacement controller with the same image/policy
can resume observation once the old lease expires. A second runner, failed CAS,
expired lease or foreign operation cannot mutate execution.
Peer inspection may be slow, so ownership is rechecked after it and CAS-renewed
immediately before the bounded mutating action. An expired/stolen lease cannot
write or clear startup fences. A still-valid but nearly expired lease is renewed
instead of allowing the following request to run into another runner's window.

Scale-down retires one highest ordinal at a time:

1. Persist the target. Patch both the existing pod and OnDelete pod-template annotation
   `rivet.dev/execution-retirement-fence` to its exact name. Wait for Kubernetes
   `observedGeneration`. A replacement of that ordinal reads the downward-API
   annotation and refuses to spawn API/executor children. The existing pod's
   annotation likewise fences a container restart that retains the same pod UID.
   Both writes must be confirmed before withdrawal. Other ordinals and
   already-running accepted work are unaffected.
2. Reconfirm two Ready serving peer UIDs/incarnations. Use Kubernetes exec to
   request withdrawal through the existing supervisor socket. Do not expose the
   loopback retirement endpoint or distribute its token. Wait for the public
   execution Service's EndpointSlices to exclude the UID, plus the withdrawal
   delay (chart minimum 60 seconds).
3. Begin the existing API/executor drain once. Wait for actual `drained` status,
   including accepted runs and recording durability. Active counter zero is
   insufficient. No timeout force-kills accepted work, including paused runs.
4. Reconfirm peers, target drain and startup fencing. CAS-patch the scale
   subresource with workload UID/resourceVersion/old-count preconditions. Wait
   for the old UID to disappear, clear only its startup fence and close the
   operation. The fence prevents a newly recreated tail from accepting work in
   the status-check/scale-down race.

Scale-down completion requires the retired ordinal itself to disappear, not
merely its old UID. An unexpected replacement at that removed ordinal blocks
completion and preserves the template fence for inspection; it is not silently
treated as a successful shrink or deleted as if it were the recorded owner.

If demand returns during drain, capacity can grow within the same cap. If higher
ordinals were added, never shrink through them. Clear the old startup fence and
UID-precondition-delete only the confirmed drained interior owner, then wait for
its replacement to serve before completing.
The existing pod's fence is never cleared: it vanishes only with that exact pod.
Only the template fence is removed, so new capacity can start normally without
reopening a retired process during UID-precondition deletion.

Execution PDB becomes `minAvailable: "100%"`, so voluntary node eviction cannot
bypass drain. This may delay node scale-down/maintenance: a small application
baseline does not guarantee that every extra node immediately disappears.
Qualified tools explicitly remove owned, drained processes. PDBs cannot protect
against forced node loss, OOM or arbitrary administrative deletion.

Writes are not blindly retried. Lost acknowledgements are observed through
actual scale/pod/retirement state. An unconfirmed intent blocks for inspection;
it is not assumed unsent. Never erase an unfinished journal, replay its begin,
clear a startup fence manually, force-delete a busy owner or manually scale the
StatefulSet just to finish a deployment. Preserve journal, sanitized controller
logs, UIDs/incarnations, generation and EndpointSlices for recovery.

## Deployment and security

The normal HA tool sets `autoscaling.executionController.suspended=true` during
template application (zero controller replicas), then restores it under the HA
journal. It keeps controller mode enabled so execution PDB and startup-fence
environment remain intact. The controller cannot act until that operation
finishes and releases its lease. Maintenance validation disables it; cutover
inventory includes its workload. Unfinished drain blocks these operations rather
than being interrupted. An idle observation can briefly hold the lease: wait
for it to settle, never delete its journal. Disable/settle autoscaling in a
separate guarded release before a control-topology transfer. Do not use raw Helm
to overwrite preserved runtime capacity or combine enablement and topology
ownership transfer.
Proxy/web HPAs are frozen for template replacement. Their live replica counts
are preserved, with UID checks and resourceVersion preconditions on the same
Helm update, rather than resetting HPA-grown capacity to the static baseline.
Restore the original autoscaling policy only after owned execution replacement
settles. This operational pause does not change the qualified demand policy.
Local rehearsal identity uses the API image reference, not only chart version;
production continues to use the exact promoted manifest digest. Local mutable
tags are not equivalent to production immutable-image qualification.

The schema migration guard explicitly treats this standalone controller as a
non-reader (it has no DB connection); incompatible execution pods/controllers
still block migration. A zero-replica workload cannot be resurrected by this
controller: inventory outside its approved floor blocks scaling.

The controller's namespace Role can read workload/metrics, list
pods/EndpointSlices/HPA, patch only the execution StatefulSet fence/scale and
the bounded execution pods' startup annotations,
exec/delete only bounded execution pod names and update only the exact journal.
Kubernetes cannot name-restrict ConfigMap creation, so create is namespace-wide
while the client creates only the deterministic journal. It cannot read Secrets
or mutate developer workloads. Treat exec capability as privileged within the
execution pods. Mounted rotating tokens and the service-account CA enforce
strict HTTPS, deadlines and bounded output. No redirect/retry, token/body
logging or shell-evaluated command is used. Exec requires explicit successful
exit status. HTTP loopback injection is a local-test seam, not a deployed env
switch.

The bounded `pods/exec` rule grants both `get` and `create`: Kubernetes 1.35+
also checks CREATE for a WebSocket GET upgrade. Without it, all demand samples
fail with 403 and the controller safely blocks instead of scaling. Keep this rule
separate from Pod annotation/deletion permissions; it must not grant Pod creation,
Secret access or exec outside the approved execution ordinals (plus HA surge).
Do not disable the API-server authorization feature to work around the failure.
See [the upstream WebSocket authorization contract](https://www.kubernetes.dev/resources/keps/4006/#proposal-synthetic-rbac-create-authorization-check).

## Verification

`yarn studio-server:verify:kubernetes` includes core and real HTTP/exec-WebSocket
fixtures: slot/CPU demand, stabilization, long work plus recording drain using
the real supervisor protocol, returning traffic, UID/startup fencing, restarts,
lost acknowledgements, lease conflicts, JSON/HTML errors and timeouts. Supervisor
tests verify that the startup fence blocks only its matching ordinal.

The lease regressions delay peer inspection beyond expiry, replace journal
ownership, and approach expiry without losing it. They assert that only the last
case may proceed after a CAS renewal. Removal regressions recreate the retired
tail with a different UID and assert that completion remains blocked without
clearing the template fence or deleting the unrecorded replacement. These run
through both the reconciliation fixture and the actual HTTP/WebSocket adapter;
they are local protocol evidence, not a GKE availability certificate.

The gated `runtime-control-independence.spec.ts` browser journeys separately cover
developer services being absent and the public web app after an owned real
autoscaler shrink. Both verify uncached loading, OAuth, one completed action and
no browser errors. The shrink runner must first establish drain/recording/pod
evidence; browser success alone is not proof of safe retirement. Non-fixture
invocations skip these tests rather than targeting another installation.

Supplementary local Postman simulation:

```powershell
postman simulation run deploy/studio-server/scripts/fixtures/autoscaler-kube/simulation.sim.yaml --port 4900 --no-history --output ndjson
# Another terminal:
$env:RIVET_AUTOSCALER_SIMULATION='http://127.0.0.1:4900'
yarn node --test --test-name-pattern='optional Postman' deploy/studio-server/scripts/execution-autoscaler-kubernetes.test.mjs
```

Confirm request events for success, missing, JSON and HTML errors and the client
timeout for the hanging path. Stop afterward. This fixture was authored from the
consumed Kubernetes HTTP contract; owner-mock discovery was skipped because the
CLI was signed out. Full stateful HTTP+exec coverage is in the Node fixtures.
No paid mock, sign-in, workspace publication or GCP is needed.

Still required for full provider qualification: exact-image local Kubernetes autoscaling
exercise, representative protected capacity measurements, and separately approved
GKE verification of node/quota headroom, Metrics API RBAC, startup-generation
fencing, Gateway withdrawal and proxy connection drain. Include long/paused
workflows, recordings, returned demand, controller death at each intent boundary,
mixed-version upgrades and voluntary node maintenance. Mocks cannot certify
these provider facts.

## Read-only production review — 2026-10-21

The installation-specific policy is execution2-7 and proxy2-4, not the generic
execution2-10 overlay. At21:24UTC, seven pods were Ready with zero restarts; the
controller produced40 valid low-demand decisions over ten minutes and its sample
timestamp advanced across independent reads. Proxy HPA had valid CPU metrics and
desired/current2. The execution startup-fence environment, OnDelete strategy,
single replica writer and `minAvailable: "100%"` PDB were present; no unfinished
retirement or stale startup fence was found. Fifty local controller, real local
HTTP/exec-WebSocket and supervisor regressions passed; the optional Postman check
was skipped. No production mutation, injected traffic or paid rehearsal occurred.

No actual production execution scale cycle had occurred (`lastScaleAt=0`). These
are healthy observation/configuration and local protocol results, not proof of a
live production scale-up/long-run-drain/scale-down cycle.

### Remaining proxy connection-continuity limitation

Execution-owner drain and proxy HPA retirement are different mechanisms. The live
proxy HPA can remove one pod per minute after five minutes of stabilization. Its
load-balancer drain is60seconds, proxy preStop120seconds and pod termination grace
270seconds, while the backend request timeout is3600seconds and the proxy supports
long-lived streams. Therefore an in-flight long request/connection can be cut
during proxy downscale even when the execution owner is protected from premature
removal. This is a configuration-derived risk, not an induced/observed production
incident. Do not claim uninterrupted long connections from the execution drain
tests, and do not silently "fix" it by increasing only one timer.

Plan proxy admission withdrawal, connection completion/reconnect behavior and
consistent provider/pod time bounds as a separate change before claiming complete
long-request continuity. Google documents that Application Load Balancers stop
sending all traffic to a removed endpoint when its drain timeout expires; see
[connection draining](https://docs.cloud.google.com/load-balancing/docs/enabling-connection-draining#how_connection_draining_works)
and [GKE timeout guidance](https://docs.cloud.google.com/kubernetes-engine/docs/troubleshooting/load-balancing#customize_timeouts).

Contract references: [HPA](https://kubernetes.io/docs/concepts/workloads/autoscaling/horizontal-pod-autoscale/),
[disruptions/PDBs](https://kubernetes.io/docs/concepts/workloads/pods/disruptions/),
[exec protocol](https://github.com/kubernetes/apimachinery/blob/master/pkg/util/remotecommand/constants.go).
