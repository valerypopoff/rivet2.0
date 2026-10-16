# Isolated GCP HA qualification plan

Status: the owner approved the isolated rehearsal's USD 50 allowance for at
most 24 hours. This is not a hard billing cap and does not authorize a production
upgrade. The retained-browser local journey has passed. Cloud provisioning is
still gated on publishing the reviewed sources and obtaining a clean
source-bound candidate certificate; do not consume the paid window while waiting
for that prerequisite. Record the first billable activation and derive the
24-hour expiry from it, rather than from the earlier approval conversation.

Read-only preflight confirmed access to the existing open billing account and
the deployment account. No staging project or billable resources have been
created. Use that billing account only for the new staging project: do not alter
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

## Proposed resources

| Resource | Rehearsal purpose |
| --- | --- |
| Separate Autopilot cluster | Same controller behavior with independently scheduled old/new Rivet pods |
| Dedicated PostgreSQL 18 instance and database | Real managed PostgreSQL without production connection/CPU contention |
| Private regional Standard GCS bucket | Real XML/S3 interoperability and compressed retained assets |
| Staging-only service accounts and Secrets | No production credential copies or permission changes |
| Independent Gateway, HTTPS frontend and certificate | Real health withdrawal, connection draining, TLS and WebSocket/SSE behavior |
| `rivet-staging-ha` namespace/release | Existing protected-provider gate's staging-only boundary |

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
