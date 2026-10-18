# Isolated GCP HA qualification plan

## Taint-aware placement correction (2026-10-18): provider proof pending

The next candidate retains the six-proxy, three-zone, separate-host policy and
adds the missing native `nodeTaintsPolicy: Honor`. Helm rejects disabling it in
the guarded GKE profile, and provider preflight checks the actual frontend Pod
specifications, not only submitted values. Generic chart defaults still omit
the field. No new placement controller, zonal deployment split or looser
availability criterion was introduced.

The real local kube-scheduler regression passed all six cases: an untolerated
empty domain blocks `Ignore` but not an `Honor` mixed-revision surge; losing a
required zone still leaves replacement Pending; a tolerated taint makes its
domain eligible. It also checks three-zone surge placement when old pods on
untolerated draining hosts inflate the counts. The runner refuses reschedulable local
application workloads before creating synthetic Nodes; this refusal was verified
without mutation. Exact fixture Node/namespace UIDs are removed afterward.
The 96 focused HA tests and Kubernetes local/production render lane passed.
These checks establish native placement behavior, not that Autopilot's previous
20-minute rollout failure is fixed.

The full local prepublication upgrade passed with the changed chart and existing
immutable main images (`59dd224f4` to `1a00f3293`): 1,519 primary workflow,
1,740 recovery and 1,121 web-app successes, zero failures, both retained-browser
journeys and both recovery scenarios. The repository headless executor/origin
Playwright suite also passed all ten cases. This is not a certificate for rebuilt
images: normal exact main-image CI and a new provider rehearsal are still
required. Private local evidence is under `artifacts/ha-honor-prepublication/`.

The user approved this correction, publication after local qualification and a
new isolated operation **within the same existing USD 50 allowance and original
deadline**. Do not reopen the closed failed operation below, restart its clock,
reuse its retained network, or extend its budget. Protect every prior inventory
as pre-existing; review cumulative spend/remaining cost and arm the exact new
inventory expiry guard before provisioning anything billable. Production remains
out of scope.

## GKE frontend-profile rehearsal (2026-10-18): not qualified

The promoted main release `1a00f32935e54eee7c6fee4f948383dbd5d09278`
passed its exact-image main CI and local qualification, but did not complete the
new isolated provider operation `rivet-ha-gke-20261018-1a00f3293`. Do not deploy
this profile as a qualified GKE zero-downtime configuration on that evidence.

The baseline reached six positively health-checked proxies on separate hosts,
two per zone, and two web replicas. Initial pods created before Gateway health
check attachment retained `LoadBalancerNegWithoutHealthCheck`; preparation
replaced only those exact initial proxy UIDs, serially through policy/v1 Eviction,
after independently confirming all six actual backend endpoints were healthy.
The strict preflight subsequently passed. Pod status was never patched and the
health criterion was not relaxed. Keep this bootstrap preparation separate from
upgrade qualification, and never apply it as an unreviewed production restart.

Candidate frontend replacement then exceeded Helm's 1,200-second deadline. A
proxy remained unschedulable after autoscaling added a node; scheduling events
reported topology-spread and memory-fit failures. Google's
[Standard autoscaler guide warns about strict topology spreading](https://docs.cloud.google.com/kubernetes-engine/docs/concepts/cluster-autoscaler).
The more specific [Autopilot guidance](https://docs.cloud.google.com/kubernetes-engine/docs/concepts/autopilot-overview#pod_topology_spread_constraints)
recommends `nodeTaintsPolicy: Honor` to prevent scale-down/scale-up loops; that
setting is missing from this profile. It also recommends `ScheduleAnyway` to
avoid unschedulability during temporary imbalance. These are provider-specific
design constraints, not proof of the exact cause of every pending-pod event.
Test the missing taint policy and rollout interactions first. Consider explicit
zonal placement only if necessary to retain the availability contract without
unsupported assumptions; do not immediately replace the deployments with a
larger topology framework. Increasing a timeout alone is not sufficient
qualification. Do not infer precise per-node memory rejection from an aggregated
scheduler message. Require actual provider convergence and zero failed requests.

The primary stream recorded 2,868 successful workflow requests and zero failures;
the source-owned web stream recorded 1,805 successes and zero failures. API and
execution retirement, retained-browser completion, controller recovery and the
final eviction proof were not reached. These successful requests are not a
completed mixed-version HA certificate.

The first independent observer stopped after an unclassified observation error,
with 2,823 workflow and 1,048 web successes and no public failures. Its original
catch omitted the message, so its precise cause is unknown. A separate second
window retained error stage/message and completed with 1,886 workflow and 715 web
successes, no failures and no observer errors. Preserve both windows; never claim
they form uninterrupted independent observation or silently discard the first.

Private receipts are under `artifacts/gcp-ha-gke-1a00f3293/`. All original test
processes stopped before the hash-bound failed `operation-finished.json` was
exported. Exact-inventory teardown verification completed at 14:45 UTC: zero
rehearsal-created billable resources remain. All 14,430 frozen object generations,
their bucket, ten Gateway children, three Service-owned NEGs and the CSI disk are
gone; original GKE and SQL deletion operations completed without errors. New
credentials/identities, address, certificate, NAT, router and subnet were removed.
Pre-existing networks, accounts/keys, IAM members/conditions and billing were
verified preserved. The expiry safeguard was paused only after verification.
Production was not accessed or changed. The approved staging-only
SSD quota increase to 1,500 GiB allocates no disks and does not extend the USD 50
or 24-hour allowance.

Only free VPC `rivet-ha-gke-20261018`, its private connection and internal range
`rivet-ha-gke-psa-1018` remain. The normal connection-delete operation returned
`FLOW_SN_DC_RESOURCE_PREVENTING_DELETE_CONNECTION`, consistent with Google's
[four-day Cloud SQL producer retention](https://docs.cloud.google.com/vpc/docs/configure-private-services-access).
The exact IDs, original rejected operation and next action are recorded in
`retained-networking.json`; review no earlier than 2026-10-22 16:00 UTC and never
force peering removal. Managed DNS deletion and its DNS-update step completed;
Google's normal 30-day service soft-delete retention is not an active endpoint.
A post-delete 403 was not treated as an absence check. The newly approved quota
preference/API setting is non-billable and retained separately from resources.

## Final main-image rehearsal (2026-10-18): not qualified

The exact promoted main release `59dd224f41f590fc8a8d37e92a6d219544e734ca`
was tested against baseline `d9ea8dd17092fad93460404795a439cc4fa381a4` in
the newly approved isolated operation `rivet-ha-final-20261018-5bd9465`.
The local exact-image proof passed with 1,738 primary and 1,769 recovery
workflow successes and no failed requests. Main's image workflow `39108140262`
also passed. These are not substitutes for the provider result below.

The real GKE/PostgreSQL/GCS/trusted-HTTPS primary upgrade passed with 5,753
workflow successes, no failed requests and at least two ready ordinary backends.
Both retained-browser journeys passed, including saved edits, new executions,
outputs and recording playback across distinct original/candidate browser builds.
Both controller-recovery scenarios also passed their fencing assertions: lost
begin acknowledgement, a real API-server CAS conflict and one original begin
command per scenario. However, recovery traffic recorded **34 HTTP 503 failures**
alongside 8,110 successful workflow requests. The independent web-app stream
recorded **3 HTTP 503 failures** alongside 5,316 successes. Therefore the complete
provider qualification failed; this main release is **not approved for a live
zero-downtime upgrade** by these receipts.

All failures occurred in the same 2026-10-18 10:12 UTC node-consolidation window.
GKE evicted both co-located proxy replicas. Audit events show that the PDB first
blocked the second eviction, then accepted it after the first replacement was
marked `LoadBalancerNegWithoutHealthCheck` in a newly populated zone. Its NEG
was not yet attached to a health-checked backend. This sequence is consistent
with Google's documented [NEG readiness race](https://docs.cloud.google.com/kubernetes-engine/networking/docs/known-issues).
The exact response-producing hop is not proven because response bodies were
not retained; do not invent that detail, discard the failed requests, or call
the incident harmless network noise. Deployment `minReadySeconds` and a long
pre-stop delay alone did not protect this provider-driven eviction path.

Before production, repair and regression-test load-balancer-aware proxy
availability during provider-driven replacement, including placement and
premature-ready cases. Preserve the failed attempt and repeat a source-bound,
exact-image provider rehearsal. Do not weaken the zero-failed-request criterion,
disable normal provider disruption merely to pass, or silently change the
configuration of a running proof.

Private receipts are under `artifacts/gcp-ha-final-5bd9465/`, including the
sanitized `qualification-summary.json`, `availability-failure-evidence.json`
and hash-bound stopped-test `operation-finished.json`. Cleanup is admitted for
failed as well as successful qualification only after diagnostics are exported
and every original test/monitor process has stopped. It remains exact-inventory
and UID/immutable-identity fenced; production and pre-existing resources are
outside the operation. Cleanup verification is recorded separately from test
qualification, never inferred from a failed or successful test process exit.

Teardown verification completed at 2026-10-18 11:15 UTC: zero remaining
rehearsal-created billable resources, all ten recorded load-balancer children
and all three Service-owned NEGs absent, the CSI disk reclaimed, and all 23,230
frozen bucket-object generations and their bucket deleted. The original cluster
and SQL delete operations completed without errors. New credentials/identities,
the address, certificate, router, NAT and subnet were removed. Existing networks,
accounts, public key identities, IAM members/conditions and the billing
association were checked and preserved. Production was neither accessed nor
changed. The expiry safeguard was paused only after this verification.

Only the new non-billable VPC `rivet-ha-final-20261018`, its private-service
connection and internal range `rivet-ha-final-psa-1018` remain. Google's normal
connection deletion returned `FLOW_SN_DC_RESOURCE_PREVENTING_DELETE_CONNECTION`:
Cloud SQL retains producer resources for four days after instance deletion.
The exact identities, original failed operation and required next action are in
`artifacts/gcp-ha-final-5bd9465/retained-networking.json`. Revisit no earlier than
2026-10-22 12:00 UTC; inspect the failed operation and revalidate ownership before
a newly reviewed cleanup attempt. Never force peering removal. The older
`rivet-ha-20261017` network/range remain protected by their separate inventory.
The deleted managed DNS service also has Google's normal 30-day soft-delete
tombstone; its original deletion and DNS-update steps completed successfully.

Cleanup exposed a private operator-helper locking defect: PowerShell's default
non-terminating error behavior allowed one helper to continue after lock
acquisition failed. Both cloud targets remained exact owned staging resources,
but local receipt writes overlapped. All eight cleanup entry points now set
`$ErrorActionPreference = 'Stop'` before opening the lock. Fresh-process held-lock
negative checks reject every entry point and preserve the inventory hash.
The affected subnet/DNS receipts were reconciled from actual absence and their
original successful operation, without replaying deletion. Serialize mutation
helpers and await their process exit; a yielded process is still running.

Autopilot does not expose its underlying node VMs or boot disks through the
customer Compute API. Record actual Kubernetes node UIDs and the provider-managed
mode, then verify the exact owned GKE delete operation completed and the cluster
is absent. Verify the visible CSI disk independently; do not invent managed
boot-disk IDs or claim they were individually inspected. Also retain actual NEG
IDs from the new Service UID/network binding and check their absence after
controller cleanup. See [GKE node visibility](https://docs.cloud.google.com/kubernetes-engine/docs/concepts/cluster-architecture).
Namespace-filtered CPU, memory, connection and historical storage observations
are supporting telemetry, not a production capacity certificate.

## Superseded hard-spread candidate: frontend placement and provider eviction

The source-owned `deploy/studio-server/helm/overlays/gke-ha.yaml` profile is
tested in the failed operation above; it has **not** passed a GCP rehearsal.
Its six proxies, hard three-zone spread and required per-component
hostname separation replace the failed attempt's two co-located proxies. Do not
reuse the closed operation, mutate its receipts, or provision under its old
allowance. Obtain fresh budget/expiry approval and record new exact identities.

Merge the GKE profile before new installation values. Retain its
`availability.gkeGateway=true` marker so Helm validation and the provider runner's
frontend eviction check cannot be accidentally omitted. Review the requirement
for six separate proxy hosts, three eligible zones, surge capacity and extra
cost before provisioning. Set the operator-created Gateway backend policy's
connection drain to the rehearsed 60 seconds. Keep real HTTPS, authenticated
requests and the ordinary provider disruption behavior; do not pin an artificial
quiet cluster to avoid the observed failure.
The new operation's provider configuration must declare `haProof.provider: gke`.
The runner validates this before cluster access and refuses a GKE operation
without the guarded profile. Non-GKE provider proofs explicitly declare `other`;
a GKE DNS endpoint cannot use that declaration to skip the frontend proof.

Before mutation, verify operator permissions for node metadata reads and
namespace-scoped policy/v1 pod evictions, while preserving denial of writes in
other namespaces. The runner's new check uses only UID-preconditioned frontend
evictions on two distinct nodes, never a shared-node drain. It waits for positive
NEG health observations rather than accepting the no-health-check Ready reason.
Keep a real provider consolidation/replacement observation as a separate required
part of the rehearsal: a successful voluntary frontend eviction is not proof that
GKE safely moves every workload on a node.

Public web-app observation is now owned by the provider runner through primary
rollout, controller recovery and frontend evictions. Both workflow and web-app
streams must finish and report zero failures. Preserve
`provider-webapp-traffic.json` and `provider-frontend-evictions.json` together
with the existing exact-image/browser/recovery receipts. An exclusive eviction
start receipt forbids replay after an uncertain command; reconcile the recorded
UIDs and outcome rather than rerunning the phase. Export sanitized HTTP failure
fingerprints and provider events if anything fails. Follow the unchanged
exact-inventory cleanup rules on both success and failure.

## Earlier qualification result (2026-10-17)

Candidate `d9ea8dd17` completed image workflow `39049988451` successfully;
its exact promoted manifest was validated and saved before continuing. The
actual `0704d0181` to `d9ea8dd17` disposable local mixed-version proof then
passed: 2,591 primary workflow requests and 1,988 recovery requests, with zero
failures in either stream and at least two ready ordinary backends throughout
the primary rollout. Both retained browser journeys passed with genuinely
different original/candidate build identities, no dashboard/editor reload,
saved edits, new executions, output viewing and recording playback. Lost-begin-
acknowledgement and real controller-lease-conflict recovery both passed.

Those local receipts are preserved separately from the earlier failed attempts.
The isolated GKE baseline setup completed after the namespace-scoped operator
read repair described below. The actual `0704d0181` to `d9ea8dd17` primary
upgrade through real PostgreSQL, GCS and trusted HTTPS then passed with 6,261
workflow requests/zero failures and both retained-browser journeys passed.
The full provider recovery then passed: 9,136 additional workflow requests with
zero failures, both lost-acknowledgement and controller-lease-conflict recovery
passed, and each original begin command was issued once. The separate public
web-app observation finished with 5,300 successes and zero failures under normal
TLS verification. Primary readiness never fell below two ordinary backends;
the slowest observed workflow request was 758 ms during primary rollout and
929 ms during recovery. These finite continuity probes are not a production
capacity benchmark or a guarantee against arbitrary provider failure.

The complete private evidence archive was downloaded and SHA-256 verified
(`4bd5850dfde4442cdb88b3b210642044df467cba8b4f1f2bfe1a47254f2d4430`),
and a sanitized summary was exported. Exact-inventory teardown verified zero
remaining rehearsal billable resources, including all 27,028 bucket-object
generations, the cluster, SQL instance, operator VM/disks and load balancer. The
expiry monitor was then paused and its saved state verified. The restored
project, billing association, default network and pre-existing service account
and key were preserved; production was not accessed.

Only the dedicated VPC `rivet-ha-20261017`, private-service connection and internal
range `rivet-ha-psa-20261017` remain. Google rejected normal connection deletion
because Cloud SQL retains producer resources for four days after instance
deletion. Revisit these non-billable network artifacts after
2026-10-21 20:00 UTC, checking the original numeric identities and known failed
operation before issuing a new cleanup attempt. Do not force peering removal,
recreate services, extend the billable window or delete the restored project.
See [provider-retained networking](#provider-retained-networking).

Qualification does not authorize a production change. The `d9ea8dd17` candidate
follow-up changed only the local test edge and browser observation readiness,
not application runtime, chart or wire protocol. Later browser-session hardening
requires a new source-bound candidate and final image-pair qualification; see
[final-candidate delivery](ha-rolling-upgrades.md#final-candidate-delivery).
Recreating the removed paid staging resources is outside the expired allowance
and requires fresh approval before provisioning.

The owner approved a temporary private operator VM after Cloud Shell restarted
twice and discarded its temporary checkout/local cluster, including during an
active keepalive. Lost sessions are incomplete evidence, not successful proofs.
Operator source, caches, browser binaries and private receipts now belong on its
persistent boot disk. Run long phases detached with separate PID, log and exit
receipts; reconnect to inspect them rather than replaying an uncertain phase.
Use a new keyless identity with cluster-metadata access and namespace-limited
Kubernetes RBAC, IAP-only SSH and an authenticated host-key pin. Do not grant
production access or reuse pre-existing service-account keys. Record the VM,
auto-delete disk, firewall, identity and bindings in the same exact-identity
cleanup inventory. This does not extend the original allowance or expiry.
Delete the operator and verify disk reclamation after exporting evidence and
before removing the rehearsal network. Cloud Shell remains optional transport,
not the lifetime owner of a running proof.
Verify the actual GKE subject: a VM metadata-token service account can authenticate
as its immutable numeric ID rather than its email. Bind only that new identity,
then prove both allowed staging operations and denied unrelated namespace or
cluster-wide operations before starting a rehearsal.
Include `get`, `list` and `watch` for `endpointslices` in API group
`discovery.k8s.io` in the namespace-scoped Role: retirement verifies actual
EndpointSlice withdrawal, not only Pod readiness. The first baseline continuation
exposed this missing read permission after template installation. Fixing the exact
Role does not require a broader Google IAM role. Check the required reads before
mutation, and verify that EndpointSlice deletion, foreign-namespace Pod listing,
namespace deletion and cluster-wide writes remain denied. A CLI usage error is
not evidence of denied access. Recover an interrupted baseline only with its
original token and matching rendered configuration; never replay setup/seeding or
turn that interruption into a passed provider certificate.
Check client/server version skew too: the operator's `kubectl` must be within one
minor of each tested cluster. This rehearsal uses a 1.35 client to bridge local
1.34 and GKE 1.36, with its exact patch version and official binary checksum
recorded privately. Do not infer compatibility from a successful metadata GET.

The `956bcb5ba` and `5d7a51a2e` image attempts are not qualified: their primary
browser/rollout journeys passed, but recovery traffic observed a timeout and
Service connection refusals respectively. The local HA runner inherited the
managed-disruption overlay's immediate nginx shutdown. Its HA-specific values
now allow endpoint withdrawal without weakening the zero-failure criterion.
Qualified baseline `0704d0181` completed image workflow
`39040608728` successfully, including the full primary/browser and recovery gate
(the optional provider/capacity/Evaluation jobs were not requested). Its validated
promoted manifest was harvested before advancing `develop`. Its follow-up narrows
the local-only lifecycle values to pre-stop 5, inherited shutdown 15 and termination
45 seconds (the chart's minimum finalization margin), rather than unnecessarily
copying production's long shutdown deadlines. This is covered by an actual Helm
render regression. Traffic observations also await the final request and retain safe
request/phase/timing evidence. Candidate `e4baec121` completed normal image workflow
`39044504747`, including primary/browser and recovery qualification. The subsequent
actual `0704d0181` to `e4baec121` local mixed-version attempt failed at the retained
browser's Resume after old frontend removal, before owner withdrawal. Its 610
successful HTTP requests and zero reloads are partial observations, not a passing
upgrade. A focused two-browser long-proxy-drain reproduction exposed an apparently
open observer socket after its upstream proxy disappeared. The local test edge
now bounds WebSocket silence and the probe waits for ordered session resumption
before sending Resume once. That reproduction passes with unchanged application
images; it does not replace the full mixed-version and recovery proof. Long idle
pause and single-browser replacement controls also passed. Preserve failed receipts
and do not change runtime protocols based only on a test transport failure.
Do not use the failed `956bcb5ba` or `5d7a51a2e` CI runs as a promoted baseline or advance a source branch
until its complete image run and validated manifest have been harvested.

Freeze the baseline and candidate identities before testing the pair. Harvest
their complete CI manifests before advancing either source.
Re-use the existing staging installation and original synthetic seed; do not
provision another project or replay seeding. Keep private operation artifacts in
persistent operator storage, independent of the SSH session. A provider proof
remains incomplete until its full mixed-version,
retained-browser and recovery reports pass, followed by sanitized export and
inventory-fenced cleanup. Production is outside this operation.

## Rehearsal history and boundaries

The following history predates the latest qualification summary above; partial
or failed receipts below are not the current acceptance status.

The owner approved the isolated rehearsal's USD 50 allowance for at
most 24 hours. This is not a hard billing cap and does not authorize a production
upgrade. The retained-browser local journey and source-bound CI qualification
for `98f2b3c82cdbda2bca3fda477a1dd5fd8938ef33` have passed. The attempted fresh
project creation was blocked by account project quota. The owner then explicitly
approved restoring and repurposing `unstructured-448515` (project number
`601520844163`) for staging. It is restored and named **Rivet HA Staging**.
On 2026-10-17 the owner explicitly approved unlinking `convio-test-7fec7` from
`019402-7112FC-E5BA0A` and linking staging to that account. Both associations
were verified; production's billing association is unchanged. The isolated
Autopilot cluster, private PostgreSQL 18 instance and private GCS bucket have
now been provisioned. The rehearsal's recorded billable window runs from
2026-10-17 08:20 UTC to 2026-10-18 08:20 UTC; an hourly expiry-review heartbeat
and project-scoped USD 50 budget alert are configured. Neither is a hard billing
cap. Baseline application deployment, normally trusted HTTPS, key authentication,
synthetic workflow/web-app publication and a headless Node-editor observation
had passed. Mixed-version provider qualification was not complete at that point:
the first attempt failed on operator-session probe authentication and public-edge 503s,
as detailed below. The first cloud baseline exposed GCS rejecting
AWS-signed generation-guard requests with mixed `x-amz`/`x-goog` headers. Repair
`eb5a900fa0aaca34dcb47496a610c5afade688f4` uses one GOOG4 HMAC dialect for guarded
requests; real GCS create/duplicate rejection, compressed frontend assets and
multipart bundle publication/read/cleanup passed. Its normal CI image build
`39019193862` passed and it became the working baseline. Candidate
`f33b99f0b19774ea6dc8d566709bea7159bbd1fc` also passed all server image gates in
`39022749961`, but its provider attempt failed; CI qualification alone is not
GCP zero-downtime evidence. The next candidate,
`b24376234e90ff532239c8ae24dc6b64d7a0b07b`, passed all 25 image jobs in
`39026971409`. Its provider attempt observed 523 successful workflow requests,
zero workflow failures and at least two ready backends, but stopped safely on
an uncertain journal PUT after an operator-to-GKE TLS handshake timeout. It is
also **not** complete qualification. Read retries never replay that write. A
trusted Cloud Shell operator connection now runs with its own temporary checkout
and Kubernetes configuration to avoid the unstable local control-plane path.
The subsequent `8ee6840c3` image run `39030159548`
failed the strengthened frontend-UID check: bootstrap reused the proxy image,
but the fixture did not mark its proxy template for replacement. The fresh
web/proxy generation markers described below repair that fixture gap without
weakening the actual replacement or zero-failed-request requirements. This
candidate is not qualified. Its successor `1b63ee21a` passed frontend replacement
but failed recording persistence after reconnect: the recorder was bound to the
old physical socket and reported an unavailable outcome. The logical-session
recording repair establishes browser-continuity contract 2; old contract-1
browser code cannot be repaired by changing its backend. Establish the repaired
staging baseline before a fresh distinct-version proof, rather than relaxing the
recording checks or silently reloading retained tabs. Production remains
untouched. The project ID and numeric identity are
unchanged. Post-restore
inventory found no buckets, BigQuery datasets, Firestore databases, default
Datastore database, API keys or Dataform repositories. One pre-existing service
account and its user-managed key are preserved, not staging runtime credentials.
The project IAM policy retains the existing sole owner. Firestore's API was
temporarily enabled for inventory and then disabled again. These are inventory
receipts, not proof of a deployed or qualified staging installation.
Record the first billable activation and derive the 24-hour expiry from it,
rather than from the earlier approval conversation.

The five private Studio Server packages are patch-versioned together as
`1.26.2`; the repository contract rejects a web-only bump. The web package's existing
`VITE_APP_VERSION` stamp makes the second contract-2 candidate's browser bundle
distinct from the qualified `0704d0181` / `1.26.1` baseline, without changing the executor wire
protocol or mutating previously published assets. Both exact revisions passed
normal image qualification; actual mixed-version local and provider proofs remain required;
a package version or different image digest alone is not continuity evidence.
The isolated reconnect browser regression also refuses unowned API requests,
so optional background subscriptions cannot contact an ambient local server.

Read-only preflight confirmed access to the existing open billing account and
the deployment account. Use
that billing account only for the selected staging project: do not alter
the existing production project's billing association, IAM or resources. The
owner separately approved reviewing, committing and pushing the prepared HA
changes to `develop` and building the exact revision through normal CI. This
approval does not authorize merging to `main`, production promotion or deployment.

## Isolation boundary

Prefer a new temporary GCP project for the rehearsal, billed only after approval.
This is stronger isolation than another namespace or cluster in the production
project: it avoids sharing project IAM, API configuration and project quotas.
Use the production region (`europe-central2`) and policy shape, but create new
resources and synthetic application data. Do not import a production backup.

Protected existing identities (never provisioning or cleanup targets):

- Project `wartime-storyteller`, cluster `rivet-cluster`.
- Cloud SQL instance `rivet-and-support-db`, including `rivet-support-db`.
- Bucket `rivet-storage` and every other existing bucket.
- Namespace/release `rivet`, existing service accounts, Secrets and Gateway.
- Hostname `storyteller-rivet.litnet.com` and existing DNS records/certificates.

The owner must approve the new project ID, billing account, time window and
spend allowance before creation. Use a fresh `rivet-ha-staging-*` project ID;
record its numeric project number and exact resource identities in a local
operation inventory immediately after creation. Refuse adoption of pre-existing
resources under matching names. Every command supplies an explicit project or
Kubernetes context and namespace; never change the ambient production context.
Do not grant project-wide permissions to the production runtime identities or
create cross-project network peering to production.

### Explicitly approved restored-project exception

Only `unstructured-448515` / `601520844163` may be reused under the owner's
explicit approval; this is not permission to adopt another existing project.
Check the numeric identity on every provisioning/cleanup operation, preserve
the existing owner grant, and inventory resources and credential identities
before enabling billing. A newly restored project can report `ACTIVE` before
service APIs recognize it. `NOT_FOUND`, `CONSUMER_INVALID` or permission errors
are incomplete inventory, never evidence of an empty project. Wait for service
recovery rather than widening IAM grants to work around these errors.

Create new staging-only names, accounts and credentials; do not reuse an
unreviewed old credential. Record anything already present separately from
resources created by the rehearsal. Cleanup owns only the latter and must
retain the restored project and pre-existing IAM/resources unless the owner
separately approves their removal. Project-level deletion is not the default
teardown for this exception. Billing activation and all created resources remain
subject to the original USD 50 / 24-hour envelope.

## Protected provider HA runner

`deploy/studio-server/scripts/kubernetes-ha-provider-gate.mjs` reuses the local
gate's `runHaReleaseRollout` observations and the production retirement controller;
it does not override the local runner's cloud-context refusal. It takes the
existing protected provider gate environment/configuration, operator-owned values,
and an additional `haProof` object containing `clusterServer`, `namespaceUid`,
`operation` (the namespace's `rivet.dev/ha-rehearsal` label) and `expiresAt`.
Every apply checks the exact current context, cluster endpoint, namespace UID,
ownership label and expiry. Provision infrastructure, Secrets, namespace and
HTTPS edge separately; this runner never creates a cloud account or namespace.
Its operator values own `imagePullSecrets`; public images need no unused registry
token. The original provider deployment runner still requires registry credentials.

Use Yarn's Node wrapper and explicit phases:

```bash
yarn node deploy/studio-server/scripts/kubernetes-ha-provider-gate.mjs prepare
# Wait for normally trusted HTTPS and verify anonymous access is rejected.
yarn node deploy/studio-server/scripts/kubernetes-ha-provider-gate.mjs seed
yarn node deploy/studio-server/scripts/kubernetes-ha-provider-gate.mjs roll
```

`RIVET_HA_PROVIDER_BASELINE_MANIFEST` pins an existing promoted v3 release.
`RIVET_HA_PROVIDER_CANDIDATE_MANIFEST` pins the different promoted candidate for
`roll`; configured image digests must match. The roll requires its exact clean
checkout/chart and distinct source/image identities in the same browser contract.
It verifies the installed Helm manifest uses the baseline image set before
starting. `prepare` refuses an existing release. `seed` writes an exclusive
started marker before application mutations, so an uncertain or partial seed
cannot be automatically replayed. Inspect its accepted writes before any manual
recovery; do not remove the marker merely to retry.
Failed phases retain Kubernetes diagnostics and leave accepted work intact; there
is no automatic uninstall, rollback or replay. Closing any provider phase always
retains the operator-owned namespace, regardless of local fixture cleanup options;
only the separate identity-checked operation inventory owns infrastructure teardown.
The provider transport retries an operator-side TLS handshake timeout at most
twice (one- and two-second delays) for explicit Kubernetes `get` and read-only
`config` observations. It never retries `exec`, retirement, scaling, journal
writes, apply or deletion. Other errors and identity mismatches fail immediately;
exhausted reads still stop safely. This addresses observed local-to-GKE TLS
timeouts, not failed application requests: public traffic probes retain their
zero-failure criterion with no success-only retries.
Expiry is rechecked after identity observations, so a read retry cannot carry a
new mutation across the approved end of the rehearsal window.
Preparation failure must be reviewed
before an operator removes that exact disposable release and starts again.

Private HTTP and browser probes sign in through the ordinary UI key gate; do not
turn authentication off for testing. Database observations execute read-only
SELECTs through the installed API's actual managed PostgreSQL connection, not a
local fixture. The shared bundle download retains that UI session as well.
The public key-login route is `/__rivet_auth`; `/ui-auth` is the API's internal
upstream path, not an edge login URL. The HTTP regression verifies the public
login request against a loopback HTTP server and preserves the issued session
cookie without following redirects. It does not inspect nginx source text;
the real HTTPS rehearsal verifies that the deployed proxy exposes that route.
For repository UI observations against this installation, set `RIVET_ENV_FILE`
to an isolated rehearsal file, not the developer's root `.env`; the observe runner
loads file values over process values. Keep the staging key only in the process
environment. Node recording observations must use the real `/api/config` response
so the executor gets the current HA owner incarnation, rather than the browser-only
bootstrap fixture's unowned `/ws/executor/internal` URL.
The real browser probe pauses its accepted Node run before template changes and
keeps it paused until **all original web and proxy Pod UIDs are absent**. Merely
being unready or terminating is insufficient. It then resumes through the public
endpoint, requires successful completion and one recording, retains the unsaved
edit through API replacement, and verifies a second run, output modal, recording
playback and lazy statistics view afterward. This closes the timing loophole in
the earlier 20-second run, which could finish before GKE's readiness stabilization
window. Failed probes attempt to resume their own paused fixture before closing
the browser; they never relax production drain or force-delete an accepted owner.
Each proof uses a fresh template-generation annotation on both web and proxy,
as well as the execution owners, while preserving operator annotations. This
forces real frontend replacement even when bootstrap certification reuses the
same image digests or consecutive candidates share an unchanged proxy image.
The proof still requires the old frontend UIDs to disappear; an unchanged proxy
must not be mistaken for a successful replacement, nor cause an artificial
timeout because the fixture forgot to request its replacement.

The in-pod cross-owner fixtures carry both proxy authentication and a key-mode
UI session, just like an authenticated operator. Proxy identity alone must not
bypass the operator middleware. The notification regression executes the real
fixture against a session-enforcing HTTP/SSE server, including mutations in both
directions; it does not inspect fixture source text.

Provider reports bind both exact manifests but are supplementary observations:
they never rewrite canonical production lineage or become a deployment-authorizing
manifest when the tested baseline differs from that manifest's predecessor.
The `roll` phase also reuses the local recovery probes for lost retirement
acknowledgement and runner-lease loss against the same staging cluster. Rendering
uses the operator's provider values, not local fixture connection/auth defaults;
the recovery path checks the same identity and expiry guard before injecting faults.
Both the primary rollout and injected-fault recovery use the configured
`RIVET_K8S_PROVIDER_GATE_DEPLOYMENT_TIMEOUT_SECONDS` for owner observations (900
seconds in this rehearsal), not a separate three-minute local-fixture deadline.
GKE termination grace plus replacement scheduling/pull can exceed that shorter
deadline. This is only an observation budget: expiry, retirement fences, unknown
outcomes and the prohibition on force deletion remain unchanged.

The isolated GKE values pair a 60-second `GCPBackendPolicy` connection-draining
timeout with `lifecycle.preStopDelaySeconds: 120`, `shutdownGraceSeconds: 120`
and `terminationGracePeriodSeconds: 270`. The pre-stop includes a 60-second
propagation allowance: [GKE requires it to cover drain timeout plus NEG removal
latency](https://docs.cloud.google.com/kubernetes-engine/docs/troubleshooting/load-balancing).
These are rehearsal settings, not a universal timing guarantee; preserve the
zero-failed-request check and measure real withdrawal. A short local-cluster
pre-stop default is not provider-edge qualification.
The first real mixed-version attempt exposed GKE's
`LoadBalancerNegWithoutHealthCheck` readiness false positive: both replacements
became Kubernetes-ready before the new zone's NEG was attached to the load
balancer, and the public workflow/web-app probes received 503. That attempt is
failed evidence, not a qualified upgrade. `rollout.minReadySeconds` now controls
the web/proxy Deployment availability stabilization window (default zero for
compatibility); the provider rehearsal uses 120 seconds before old pods may be
retired. This is distinct from pre-stop withdrawal protection. Qualify the chosen
window with continuous external traffic; it is not proof that arbitrary provider
propagation delays are bounded. GKE documents this
[NEG readiness race](https://docs.cloud.google.com/kubernetes-engine/networking/docs/known-issues).
The temporary retained-UI publisher never joins a Service and omits the serving
container's lifecycle hook, so its cleanup does not wait for an irrelevant edge
drain. Normal web/backend/execution pods retain their configured drain protection.

Keep operation inventory writes serialized. Overlapping provider operations can
finish in another order than they started; an old in-memory inventory snapshot
must not overwrite newer creation receipts. The local provisioning scripts hold
an exclusive process-lifetime inventory file lease. Teardown must use recorded
creation IDs/UIDs, not reconstruct a deletion list by discovering similar names.

## Proposed resources

| Resource                                            | Rehearsal purpose                                                           |
| --------------------------------------------------- | --------------------------------------------------------------------------- |
| Separate Autopilot cluster                          | Same controller behavior with independently scheduled old/new Rivet pods    |
| Dedicated PostgreSQL 18 instance and database       | Real managed PostgreSQL without production connection/CPU contention        |
| Private regional Standard GCS bucket                | Real XML/S3 interoperability and compressed retained assets                 |
| Staging-only service accounts and Secrets           | No production credential copies or permission changes                       |
| Independent Gateway, HTTPS frontend and certificate | Real health withdrawal, connection draining, TLS and WebSocket/SSE behavior |
| `rivet-staging-ha` namespace/release                | Existing protected-provider gate's staging-only boundary                    |

Provide a temporary HTTPS hostname through its DNS owner, adding a new record
only; do not repoint an existing hostname. If no hostname/certificate can be
provided, retain local/port-forward evidence but mark public-ingress qualification
blocked. A port-forward or disabled TLS verification is not equivalent evidence.
An alternative to touching `litnet.com` is a new staging-project-owned
`<name>.endpoints.<staging-project>.cloud.goog` DNS entry: Google documents
[mapping that name to a target IP through Service Management](https://docs.cloud.google.com/endpoints/docs/openapi/cloud-goog-dns-configure).
This would be DNS configuration in the new project only, not an ESP proxy added
to the Rivet traffic path. Verify successful managed-certificate issuance and
normal client trust before accepting this option as HTTPS evidence; DNS mapping
alone is not proof of a usable certificate. Do not purchase a domain or change
production DNS as an implicit workaround.

Set database connections for the reviewed backend/execution maximum **plus
surge**, maintenance and migration/probe connections. Use real provider capacity,
not a larger declared number to silence validation. Bound replicas, test data,
request rate, parallel executions, log retention and test duration. Do not use
Spot/preemptible capacity for the planned-upgrade guarantee. Do not run a stress
test merely because a functional smoke passed.

## Cost approval and expiry

This plan creates billable compute, database, load-balancing, disk, logging,
object operations and network resources. Before creation, price the final
regional machine/database requests and load-balancer configuration using the
current [GKE](https://cloud.google.com/kubernetes-engine/pricing),
[Cloud SQL](https://cloud.google.com/sql/pricing),
[Cloud Storage](https://cloud.google.com/storage/pricing) and
[load-balancing](https://cloud.google.com/vpc/network-pricing#lb) schedules.
Do not count free-tier credits or commitments as guaranteed savings. Autopilot
can adjust admitted Pod requests; compare the actual admitted requests with the
estimate before starting sustained work. A rough planning allowance is not a
regional quote or a hard spending cap.

Propose a maximum 24-hour window and an explicitly approved spend allowance.
For initial approval, reserve **USD 50 for up to 24 hours** as a conservative
planning allowance, not a guaranteed cap or an exact Warsaw SKU quote. An
illustrative small functional rehearsal (up to 6 requested vCPUs / 24 GiB total
Pod memory including surge, a 2-vCPU / 8-GiB dedicated database, small disks and
one low-traffic HTTPS frontend) is roughly **USD 20-40 per day** at published
on-demand list-price order of magnitude. Reprice the concrete regional resources
before creation; taxes, admitted resource adjustments, retained backups/logs,
network and traffic can change this estimate. These sizes bound the rehearsal
proposal; they are not measured production capacity recommendations. Refuse a
configuration above the approved resource envelope rather than silently enlarging
the staging cluster or database.
Create billing alerts scoped only to the new project, but remember alerts do
not stop spending. Record `expiresAt`, the responsible operator and a scheduled
cleanup review. Stop admitting new test runs before expiry so accepted work and
diagnostic export can finish. If evidence requires more time or resources, obtain
approval before extending them. Never disable shared billing as a cleanup method.

## Verification order

1. Complete local browser save/run/output/recording continuity, runtime and
   recovery checks; preserve failed attempts as failed evidence.
2. Commit/release the reviewed sources through normal CI; pin candidate,
   predecessor and oldest supported UI images by digest. Never deploy local
   overlay images as a production-qualified release.
   `Build Images` does not run on a `develop` push automatically: dispatch
   `studio-server-images.yml` explicitly on that exact branch revision. Leave
   provider/capacity/Evaluation inputs disabled until the isolated environment
   exists. A `develop` dispatch cannot advance the `production` manifest pointer;
   that step is restricted to `main`. Verify the run's `head_sha` against the
   reviewed commit before consuming its artifacts.
3. Provision only the approved new-project inventory. Deploy staging-only
   credentials and exact images using the repository chart and protected provider
   gate. No Secret values belong in logs or committed values files.
4. Verify anonymous authentication enforcement, private-route rejection,
   immutable asset paths/query preservation, fresh and retained UI versions,
   recordings and real PostgreSQL/GCS persistence through the HTTPS edge.
5. Exercise the same guarded retirement/controller path through that edge with
   original browser edits, paused/long executions, hosted Evaluations and
   early-output/background recording persistence. Test real Gateway connection
   draining and recovery. The existing provider smoke gate alone is **not** an
   actual mixed-version HA rollout certificate; do not bypass the local HA
   runner's context allowlist to aim it at a cloud cluster.
6. Measure protected workloads and surge high-water marks before any capacity
   claim. Keep provider-edge, browser, workload and source/image receipts together.
7. Review results and separately obtain approval for the production singleton-to-HA
   maintenance transition. Passing staging never authorizes that live change.

## Cleanup safety

Export sanitized diagnostics before cleanup. Teardown must
operate from the recorded new-project inventory, check project ID **and numeric
project number**, ownership labels and exact resource identities, and print a
reviewable deletion plan. Reject all protected identities above and refuse empty
or wildcard targets. Delete only resources recorded as created by that operation;
never use an organization-wide/project-prefix search as a deletion list.

Remove staging DNS only if it still points to the exact recorded staging target;
a changed record belongs to its current owner. Remove staging credentials and
HMAC keys without altering production credentials. Verify that disks, database
backups, reserved addresses, load balancers, log sinks and bucket versions are
accounted for so teardown does not leave unnoticed recurring charges. Never
delete a project, database, bucket or cluster inferred from the current context.

### Provider-retained networking

Cloud SQL can acknowledge instance deletion while retaining its producer-side
resources for four days. During that period normal private-connection deletion
fails with `FLOW_SN_DC_RESOURCE_PREVENTING_DELETE_CONNECTION`; this is a known
failed operation, not an uncertain acknowledgement to replay. Google explicitly
warns against deleting the underlying VPC peering directly. Preserve the exact
connection, internal range and dedicated VPC until the hold clears, then
revalidate their recorded IDs/ownership and delete in dependency order. See
[Google's private-services cleanup guidance](https://docs.cloud.google.com/vpc/docs/configure-private-services-access#deleting-connection).

The unused connection has no hourly/data charge of its own, and internal IP
addresses have no charge; provisioned producer resources and traffic are separate
charges. Therefore verify the SQL delete operation completed, all compute,
storage, public addresses and NAT are gone, and no live producer instances remain
before classifying these network-only residuals as non-billable. Keep this residual
inventory distinct from the completed billable teardown, and never claim every
network artifact was deleted. See [Google's VPC pricing](https://cloud.google.com/vpc/pricing).
