# Isolated GCP HA qualification plan

Status: the owner approved the isolated rehearsal's USD 50 allowance for at
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
have passed. Mixed-version provider qualification is not complete: the first
attempt failed on operator-session probe authentication and public-edge 503s,
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

The repaired hosted web package is patch-versioned as `1.26.1`. Its existing
`VITE_APP_VERSION` stamp makes the second contract-2 candidate's browser bundle
distinct from the repaired `1.26.0` baseline, without changing the executor wire
protocol or mutating previously published assets. Both exact revisions still
need successful normal image qualification and the provider rollout proof;
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

Export sanitized diagnostics before cleanup. A later cleanup implementation must
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
