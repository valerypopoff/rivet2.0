# Automated release qualification

## Implementation versus activation

The optional [bounded request-continuity extension](production-update-continuity.md)
adds real five-minute HTTP/1 and HTTP/2 bodies, late WebSocket admission/resume,
proxy replacement and HPA removal to either compact suite. Select its reviewed
`requestContinuityProfile` in the hash-pinned private driver settings (and staging
`region`), or `RIVET_QUALIFICATION_CONTINUITY_PROFILE` for temporary staging.
Its nested runtime-control certificate is compiled only after validated upgrade,
autoscaling and cleanup facts. Version 2 additionally requires the duration
matrix, return handoff, real pre-removal admissions and native-roll timing.
Long HTTP cohorts run one at a time to keep fixture demand within the compact
runtime's admitted capacity. Qualification preflight derives its timeout from
the qualified lifecycle profile rather than using the shorter legacy default.
This extension has no provider activation receipt
yet and cannot be inferred from the existing short-request certificate.

`studio-server-qualify-release.yml` (Actions name **Release Rivet**) implements the
normal release: validate an existing successful main `Build Images` run, qualify
its immutable images in reusable staging, publish the certificate, then deploy
that exact manifest through the protected `rivet-production` environment.
`deploy_production` defaults to true; false stops after qualification/publication.
There is no rebuild between staging and production and no separate readiness job.
`execute-runtime-qualification.mjs` owns the command boundary. The workflow does
not install credentials, provision shared infrastructure or enable itself. It is
main-only and dispatch-only and fails when
`RIVET_AUTOMATED_QUALIFICATION_ENABLED` is not exactly `true`.

The standard workflow uses a **dedicated reusable staging cluster**. Install its
cluster, Gateway/TLS, access and independent janitor once. GitHub-hosted
Linux jobs coordinate short-lived in-cluster actors; no permanent runner VM is
required. A new operation
still creates an isolated namespace with synthetic data and deletes its complete
fixture afterward. Staging settings require `region` and a reviewed
`trustedForwardingProxies` list containing the proxy-only subnet CIDR and exact
Gateway frontend IP. The provider passes this to
`RIVET_TRUSTED_FORWARDING_PROXIES`; `trustedClients` remains the separate allowlist
of actual public test clients. Shared admission checks the live Gateway frontend
against that list before namespace creation. Missing lists, too few peers,
duplicates or universal ranges fail packaging/admission. The temporary factory derives both
hops from its owned subnet/address. Before fixture seeding or dummy OAuth, the
provider reads the authenticated current-request diagnostic and checks that the
actual resolved client belongs to its frozen public-client allowlist. Forwarding
peer addresses cannot stand in for that client. See [client provenance](trusted-clients.md).

First-transition bridge creation dry-runs its Deployment through the actual
Kubernetes admission chain before creating any bridge resources or changing HPA.
Provider mutations to the requested specification block that transition. This
uses the existing actor/deployer create permission and persists no dry-run
resource. Read-only installation inspection remains read-only. The GKE profile
uses 360-second LB drain, 420-second preStop and 600-second termination grace;
the previous 900-second grace was capped to 600 by Autopilot. A successful dry
run does not replace exact-image upgrade/autoscaling or cleanup evidence.

Cleanup waits within its existing deadline for a newly discovered NEG's pending
Gateway backend to appear before withdrawing routes. Only the typed pending
backend condition is polled; denied, partial, ambiguous or rebound inventories
still stop immediately. Previously this normal controller delay could stop
settlement before route withdrawal.

If the controller stopped during an owned execution withdrawal, settlement
requires inspected recovery. Match the exact Pod UID, process incarnation and
retirement operation to the stopped controller's journal. Verify controller
absence and continuously observe the actual execution Service's ready endpoints
for the full withdrawal interval; headless discovery endpoints are not dispatch
routing evidence. Then the existing `retire-backend.mjs OPERATION INCARNATION
--begin-only` command can complete that same withdrawal. Preserve a private
intent and acknowledgement, and continue the original cleanup after accepted
work drains. Unknown owners, replaced processes and lost modifying acknowledgements
retain their existing fences. Never clear the registry, cancel work or force
Pod deletion to make cleanup appear successful.

If a failed operation's final exec acknowledgement is lost after its command
exits, the coordinator can read the final cleanup receipt from the original
control-namespace registry. The provider saves it only after gate/child cleanup
and exact worker closure. The coordinator pins the registry UID returned by
`armExpiry`, operation hash, actor UID and verification worker, requires all
workers closed, and applies the usual complete-inventory/absence validation.
It then closes only the exec transport, without replaying or signalling the
command. Prior failed workers are marked closed only after `/proc` confirms
their original PID/start-time incarnation is gone; denied or racing observations
remain fenced. This receipt proves cleanup, never upgrade success.

If no exact receipt can be confirmed, preserve bounded private diagnostics and
verify cleanup independently.
Require the exact namespace and every journaled Kubernetes/cloud resource absent,
no live test writers in the original actor, and the same actor/Job UIDs. Close
only that idle Job using normal termination grace, then confirm actor removal
and terminal workflow failure with publication/deployment skipped before releasing
the exact owner/generation lock. Record the unreceived coordinator acknowledgement
separately from independent absence proof; this recovery cannot qualify a release
or authorize another paid operation. Preserve the retained foundation.

The previous temporary campaign is closed. On 2026-10-31,
after the user's explicit request to create and retain staging, the persistent
cluster foundation was installed independently of that campaign. It has a
dedicated VPC/subnet, private Autopilot nodes, outbound NAT, a keyless node account
with the default-node role, and an authenticated DNS control-plane endpoint with
IP endpoint access disabled. The same region, GKE version and release channel as
production were selected at creation. HTTPS egress and CSI persistence across
separate Jobs passed; their namespace and blank disk were removed afterward.
Production configuration/network and all seven ready production pod UIDs were
preserved, as were every pre-existing staging network, subnet, address and firewall.
Exact identities and receipts remain in ignored
`artifacts/reusable-staging-20261031/`, outside public source.

This is a usable cluster foundation, **not release qualification or completed CI
activation**. Its dedicated regional Gateway now has a trusted automatically
renewed certificate on a fixed staging hostname. HTTP port 80 admits only
same-namespace ACME challenge routes; HTTPS port 443 admits fixture namespaces
with the maintained qualification label. Cert-manager leader-election Leases
must use its own namespace: Autopilot denies their creation in `kube-system`.
The reviewed CI access installation and independent janitor must finish before
admission. No full Rivet qualification or production update has passed yet.
Keep the foundation; release cleanup must never delete it. Its approximate idle
base is USD 73/month for GKE management plus USD 3.65/month for the retained NAT
IP before applicable credits and additional usage. Worker workloads, traffic,
logging and future frontend/runner components are additional; these figures are
not a provider billing cap. See [GKE pricing](https://cloud.google.com/kubernetes-engine/pricing)
and [Cloud NAT pricing](https://cloud.google.com/nat).
Each inner operation creates only its temporary namespace and
synthetic resources. Keep the shared cluster, network, Gateway, certificate and
administrative identities out of its cleanup inventory. This removes repeated
cluster startup when infrastructure is retained, but leaves idle cost. Creating/configuring
temporary infrastructure and removing its foundation is a separate approved setup action; no historical
environment is silently repurposed.

The inner fixture's namespace cleanup is **not** full temporary-environment
cleanup: its cluster, Gateway, certificate, addresses and network remain excluded.
The exceptional outer provision/expiry/teardown route remains
`scripts/temporary-staging.mjs`, selected explicitly by the qualification CLI.
It coordinates from a durable external Linux host, creates the new foundation,
uses a UID-bound actor for the existing inner tests and requires full provider
cleanup before exposing publication outputs. See [Temporary staging](temporary-staging.md)
for exact boundaries, host/image/configuration prerequisites, allowance clock,
failure recovery and local verification. It is not activated by these repo changes.

The existing `compact-seven-v1` suite qualifies **singleton** developer backends
and customer execution only. The opt-in `compact-seven-overlap-v1` suite adds the
maintained provider-handover path. Its implementation and local regressions are
not GKE evidence: an actual approved provider run must still pass before release
publication. A singleton certificate cannot certify developer continuity.

The overlap suite performs the same-image predecessor bridge **before** starting
its developer-continuity observation window. Customer workflow/web observers and
two-ready execution/proxy floors remain active through that bridge too. Initial adoption may interrupt
developer activity and still requires separate production approval. It then runs
the real deployment coordinator with same-node placement, exclusive housekeeping
transfer in both directions, per-candidate authenticated API/editor acceptance,
accepted paused editor runs, cross-project bundle debugger events, retained
browser editing/saving/replay and continuous authenticated developer GETs. It
deliberately suppresses exactly one successful acquire acknowledgement, waits
for the previous runner lease to expire and resumes that same journal token.
Unrelated errors are never retried. The ordinary workflow/autoscaling probes,
storage checks and exact-inventory cleanup remain mandatory.

To opt in, put a reviewed `developerOverlapProfile` in the private settings passed
to `package-reusable-staging.mjs`. Packaging pins it in the driver dependency
closure and selects the distinct suite. The CLI freezes it in the operation; each
phase rejects a mismatch. No dispatch field selects arbitrary values or scripts.
For the observed seven-worker ceiling / 200-connection allowance, this is a
**locally validated proposal**, not approval to change production:

```json
{
  "protocol": 1,
  "maxConnections": 200,
  "reservedConnections": 30,
  "poolMaxPerApiPod": 9,
  "backendResources": {
    "requests": { "cpu": "750m", "memory": "1536Mi", "ephemeral-storage": "256Mi" },
    "limits": { "memory": "3Gi", "ephemeral-storage": "2Gi" }
  }
}
```

The profile cannot increase the observed connection allowance or reduce its
reserve. It does not change the execution ceiling. The full Helm validation runs
locally before janitor arming or fixture writes, including budgeting the active
maintenance worker, temporary backend, scheduler and restore connections. Ten
pooled connections require 201 at ceiling seven and fail; nine fit the existing
200 allowance. This proves configuration feasibility, not DB throughput or GKE
node headroom. The existing exact-node overlap preflight remains mandatory.

### First activation and installed lineage

The source pool is observed and frozen in the provider certificate, not silently
replaced before installing the predecessor fixture. For a singleton source, the
provider first runs a same-image singleton preparation reducing the pool, then
the same-image ownership transfer. Customer observers span both; developer
continuity is asserted only after adoption. The ordinary candidate rollout then
exercises the overlap path. The concrete provider adapter persists each journal
once before invoking its handover observer; observer errors are terminal.

`Build Images` has a main-only dispatch input `installed_predecessor_digest`.
Use the freshly observed immutable installed manifest digest when the registry
publication head has advanced without deployment. The candidate keeps that
installed predecessor for compatibility/rollback and additionally freezes
`lineage.publicationHead`. Promotion still rejects any change to that exact
publication head. This is not a pointer rewind, qualification waiver or authority
to deploy an unobserved predecessor. Omitted input preserves historical lineage
and digest semantics. The actual installed snapshot must still match before any
provider test can start.
The local HA scenarios and container launcher validate that installed predecessor,
including its complete immutable manifest identity. They do not substitute the
newer publication head as the fixture's source. Promotion separately rechecks the
frozen publication head, so this distinction preserves the freshness fence.

First production activation uses the existing deployment command in three
separately journaled steps, with normal policy, backup, ownership and acceptance
checks. Obtain approval for the initial developer interruption first.

1. Pin `--manifest` to the exact installed predecessor; use the qualified candidate
   as `--overlap-adoption-certificate`, and `--overlap-adoption-stage sizing`.
   Values keep singleton mode and use the certified pool. Only the pool-size
   literal can change across the same-image owner-identity check; no credentials,
   endpoint, image, schema or other owner settings are exempted.
2. Keep that predecessor manifest and certificate; use
   `--overlap-adoption-stage ownership --ha-control-plane-transition` and values
   enabling the certified overlap profile. The unchanged autoscaler may stay
   active: the topology adapter pins its template and exact runtime owners.
   An unsized source is rejected rather than changing pools during transfer.
3. Deploy the qualified candidate normally, after the first two steps pass.

Run `--preflight-only` before each step. Certificate, stage, values and original
installation are included in safety and recovery bindings. Resume only the exact
unfinished token; a lost template acknowledgement is inspected, not replayed.
The source and candidate chart must be identical and schema unchanged for this
bounded delegation. Other adoption combinations remain rejected.
The sizing phase disables the migration Job. Its lost template acknowledgement
can be resolved only by read-only checks of the recorded controllers, exact
desired templates and paused proxy scale-down. It never reruns Helm. Ordinary
image/schema rollouts do not inherit that narrow exception. Template comparison
is shared with topology recovery and rejects a Secret-derived value in place of
an empty literal.

The optional CLI preview on an initial singleton reports `adoption-preflight-passed`
and these pending steps, not `deployment-preflight-passed`. It derives private
sizing values, pulls the predecessor by digest and runs the real read-only
command. It does not approve or perform the adoption. An already-overlap
installation continues through the ordinary preview path. The standard production
action currently handles singleton customer-request continuity; use qualification-only
mode and the explicit ownership procedure for developer overlap adoption.
If the source pool already matches the profile, readiness starts at ownership
and the provider skips an unnecessary singleton pool-preparation replacement.

The maintained concrete adapter lives in `scripts/qualification/`; package it
with `scripts/package-reusable-staging.mjs`. The resulting administrator-reviewed,
hash-pinned bundle implements all seven phases. The separate
`scripts/reusable-staging-janitor.mjs` uses the same ownership and cleanup modules,
not an Actions `always()` job. Packaging renders installation manifests; it does
not install them or provision GCP. Archived operation-specific scripts and their
resource identities remain excluded. Local tests are not provider qualification.

## Release stages

1. **Built:** requested main Build Images run succeeded for this commit. Its
   candidate/promotion agree on exact images, chart, schema, source, creation and
   lineage. Pull the predecessor by immutable digest, never the moving registry
   `production` pointer. Compare it with the actual installation before paid work.
2. **Qualified:** the approved driver executed ordinary seven-pod upgrade and
   autoscaling probes and verified cleanup. The command derives the existing
   declarations from completed facts; dispatch inputs cannot supply a list of
   passed check names. Publication reuses the existing guarded workflow. Legacy
   manual publication remains for separately reviewed adoption declarations.
3. **Deployed:** the protected production runner pulls the published immutable
   manifest and invokes `deploy-kubernetes-release.mjs` once. Its ordinary path
   performs current identity/baseline/capacity/routing checks, the existing online
   recovery checkpoint, rolling update and application acceptance. The settings
   digest observed for staging qualification is checked against the Helm values
   already read by that command (`--expected-installed-settings-digest`). Operator
   values and namespace UID are also bound to the qualification. Drift blocks
   before writes; no second read-only readiness run is needed. A failed or unknown
   update retains its journal and serving capacity for exact recovery, with no
   automatic rollout retry or rollback. Only a sanitized successful deployment
   summary is uploaded; detailed receipts stay private.

The release concurrency lock spans qualification through deployment and never
cancels an in-progress operation. A manual `--preflight-only` remains available
as a preview; it is not part of the standard release and does not grant lasting
readiness.

## Automatic test depth

`lib/release-qualification-policy.mjs` defaults to focused qualification for a
singleton release with the bounded request-continuity profile, including its
first protected rollout. Source/chart/settings changes and the absence of an
older stress certificate do not automatically add hours of stress testing.
Exact-source/chart/image, schema compatibility and live configuration checks
still apply; a changed or unsafe contract cannot bypass those validators.

Focused qualification upgrades the exact
predecessor to the new images, observes public workflow/web traffic and two-ready
floors, preserves recordings/storage, exercises browser OAuth/action/schedule and
runs fresh five-minute HTTP/1, pooled HTTP/1 and HTTP/2 cohorts spanning execution
retirement and native proxy replacement, plus accepted action resume. Its separate
autoscaler phase observes the current policy/floors and at least 100 workflow and
100 web completions. It omits autoscaling chaos/HPA removal and the separate
60/180/295-second duration matrix. First adoption additionally tests the temporary
bridge, policy adoption and return handoff: 18 complete five-minute requests
instead of the nine for an already protected installation. It retains the same
safe shutdown/admission checks and bridge cleanup requirement.

For autoscaler capacity/fault-policy changes, select `qualificationSuite: "full"`
in the reviewed private staging settings and approve the appropriate test window.
The full suite remains available for growth, retirement, metrics faults, HPA and
duration-matrix tests. Developer overlap and releases without the bounded profile
also retain full qualification. An explicit incompatible focused selection or an
unknown suite fails before actor admission. Dispatch inputs cannot waive checks.

Focused runtime-control v4, autoscaling v3 and nested continuity v3 explicitly
describe those observations; they cannot be relabeled full tests. Both declarations
carry identical version-2 qualification metadata with source/configuration
fingerprints. There is no inherited full-baseline requirement. Version-1 metadata
remains readable as historical evidence. The provider recomputes selection from
verified source and its hash-pinned private settings; publication checks the
source digest again. Custom legacy drivers without settings remain full-only.
No old pass is rewritten for a new image.

Before another provider attempt, run the local operation, continuity, coordinator
and publication regressions through the real command/HTTP/WebSocket boundaries.
`yarn studio-server:verify:kubernetes` includes these tests, Linux process/lock
checks and Helm renders; it does not deploy a cluster or start qualification.
On Windows, set `RIVET_STAGING_PROCESS_TEST_IMAGE=node:24-alpine` to include the
network-disabled Linux fixture-process check with a locally available image.
The clock-driven five-minute observer regression must renew the two-minute lease
without admitting the next mutation. The cleanup tests deliberately withhold the
final exec status, retain or close the socket, and reject foreign receipts,
active workers and missing evidence. Local success remains distinct from a GKE
certificate; no failed/expired test grants an automatic paid retry.

Raw Helm settings may contain credentials. The installation snapshot contains
only identities, hashes, normalized policy and allowlisted sizing/drain fields,
never raw settings. Provider
children do not inherit production-prefixed variables, production KUBECONFIG,
GitHub tokens or Actions variables. Only sanitized success packets are uploaded;
failed reports, bounded stderr and exact inventories stay in private storage.

Credential filtering is enforced by the driver factory itself, not only its
CLI caller. Names are compared case-insensitively (including Windows environment
aliases); GitHub/Actions and GH Enterprise tokens are removed and KUBECONFIG is
always replaced with the explicit staging file. A process error is not exit
evidence: wait for its actual close before permitting settlement to proceed.

Protected phase receipts are privately copied and frozen before validation.
Later driver activity cannot rewrite earlier evidence or inventory authority.
Admission/cancellation/deadline checks run both before dispatch and after each
test acknowledgement; cleanup still runs after a late cancellation or expiry,
but the operation cannot publish a pass. Upgrade and autoscaling observations
must occupy ordered, non-overlapping windows, and **each** must report its own
workflow/web samples and zero failures. Autoscaling declarations use autoscaling
traffic totals, never borrowed upgrade totals.

Installation observation rechecks namespace and cluster lifetimes after reading
Helm. Actual deployment checks the qualified settings inside its own fresh live
preflight; staging cannot prove that production stayed unchanged while it ran.

## Hosted CI installation

The normal workflow uses `ubuntu-latest` for orchestration and production deploy.
`studio-server-publish-qualification-images.yml` is a reusable, main-only workflow:
it builds an actor from the exact committed source, pulls the pinned MinIO image,
verifies both archive identities, scans the actor and publishes immutable digests.
MinIO is pulled from the maintained immutable GHCR mirror because the original
Quay digest rejects anonymous downloads. Its disposable hosted runner explicitly
uses Docker's classic image store before any build or pull: Docker 29's default
containerd store reports manifest/index IDs, while this archive and scanner
contract compares configuration digests. This setting affects only the publication
job's fresh Docker daemon; cluster runtimes and application image jobs are unchanged.
The publisher still checks the exact vendor image ID and release version, retains the original vendor provenance,
and refuses changed bytes; it adds no registry credential to a test Pod.
It runs alongside application-image building in main Build Images. The release
qualification job accepts that exact successful build run's same-source publication
receipt, without rebuilding the actor at release time. The legacy administrator
archive publisher remains a CLI; normal CI needs no prebuilt host archive.

Google authentication uses pinned `google-github-actions/auth` and `setup-gcloud`
actions, refreshable Workload Identity Federation credentials and the GKE auth
plugin. Bind the provider to the exact repository/owner IDs, main ref and release
workflow ref. Bind each Google service account to its exact protected environment
subject. No long-lived Google key, untrusted-PR runner or checkout credential is
required. The generated `gha-creds-*.json` files are Git/Docker ignored.

Set these protected environment variables during the separately approved
installation:

- Both environments: `RIVET_GOOGLE_WORKLOAD_IDENTITY_PROVIDER`,
  `RIVET_GOOGLE_SERVICE_ACCOUNT`, and `RIVET_DEPLOYMENT_CONFIGURATION` (JSON).
- Staging: `RIVET_AUTOMATED_QUALIFICATION_ENABLED=true`, also a repository variable
  for input validation, and explicit `RIVET_QUALIFICATION_MAX_USD` / `_MAX_SECONDS`.
  Historical retained attempts used USD 30 / 7200 seconds. That time limit is
  too tight for the optional full suite's sequential real stabilization windows: returning
  seven workers to two alone requires five separate five-minute low-load windows,
  after its 15-minute fixture. Cooperative growth, busy retirement, missing/stale
  metrics, CPU growth and the update probes add further serial work. Prepare a
  separately approved full-test window of up to four hours; the workflow allows
  another hour for cleanup plus 30 minutes for setup (330 minutes total).
  The shared hosted-command limit accepts whole-second windows through 14400.
  The workflow validates it before Google authentication; both preparation and
  execution enforce the same limit. Real CLI regressions cover two/four-hour execution and over-limit
  rejection before private setup. A failed setup grants no retry allowance.
  A longer workflow timeout grants no additional test allowance. Fixture OAuth
  sessions cover at least the frozen operation window, so a longer full test
  cannot outlive the old three-hour fixture session limit.
  The explicit spend allowance is not a provider billing cap. Do not reuse a closed
  temporary campaign or automatically authorize a second paid attempt.
- Production: its separately scoped configuration selects a generation-pinned
  private installation object, never values/scripts supplied by dispatch.

`prepare-hosted-release.mjs` materializes these fixed configurations in a fresh
private directory under `RUNNER_TEMP`. Staging configuration has `protocol:1`,
`staging` (the validated reusable settings plus `clusterName`/`dnsEndpoint`),
`production` (cluster identity, context, namespace/release/UID and reviewed
`valuesDigest`), `janitorServiceAccount`, and `evidenceBucket`. Production
configuration has `protocol:1`, the same `production` identity, its separate
`evidenceBucket`, and immutable `installationUri` (`gs://.../NAME.json#GENERATION`).
That private object contains `valuesBase64`, checksum-pinned installation `policy`,
and `adapters.backup` / `adapters.acceptance` as base64 files. Never put those
bytes in a public workflow variable, log, source file or uploaded artifact.

An administrator installs initial ServiceAccounts, RBAC and janitor-health
ConfigMap once. The coordinator can create/exec/delete Jobs only in the runner
namespace and update code ConfigMaps/Deployment only in the control namespace.
It cannot grant RBAC. Cluster connect/read and production namespace Helm-Secret
reads are separate from production deployment rights. The actor and janitor
receive staging-only in-cluster identities and staging Compute read access;
they receive no GitHub credential, production kubeconfig, raw production values
or evidence-bucket access. The production identity has normal Helm workload and
exec rights only in the installed namespace plus cluster/network metadata reads.
Namespace Secret/workload/exec rights can expose credentials; review that scope
explicitly. Federation identities persist for ordinary releases and require
explicit installation approval and documented revocation, not an expired campaign.

Before each test, hosted preparation acquires an exclusive generation-bound lock
in private GCS, packages the source-pinned driver, and updates only the janitor's
versioned immutable code ConfigMap and Deployment. Its health and approved driver
hash must pass admission. `lib/reusable-staging-coordinator.mjs` creates one
non-retrying finite-lifetime actor Job, journals its intent/UID before waiting,
checks exact source, real offline browser fixture and kubectl version skew, then
installs the reviewed bundle through WebSocket stdin. Each phase is dispatched
once with a finite deadline. Lost acknowledgements never replay a write. Cleanup
must be verified before diagnostics export and UID-bound actor removal. Expiry
and the independent janitor retain ownership after coordinator loss.

Local and remote phase drivers share one hour across settlement, cleanup,
verification and diagnostics export, starting at the first settlement dispatch.
Each phase receives only the remaining time; an exhausted allowance prevents
another command from starting. Timeout is not writer-absence or cleanup proof:
unverified work remains owned by the independent janitor. Once cleanup is
verified, normal UID-bound actor removal is still attempted if diagnostic
export, local persistence or upload fails. Diagnostic failure still blocks
publication, and a simultaneous removal failure preserves both errors. Neither
export nor deletion is replayed. Timers do not impose a hard cloud billing cap.

The actor Pod requests Autopilot extended-duration protection with
`cluster-autoscaler.kubernetes.io/safe-to-evict: "false"`, so voluntary node
scale-down does not normally evict a silent test runner. This preserves the
existing absolute Job deadline and zero retries; it is not a guarantee against
node failure. See [GKE extended-duration Pods](https://docs.cloud.google.com/kubernetes-engine/docs/how-to/extended-duration-pods).
During each exec the coordinator checks the exact actor UID/readiness every five
seconds. Loss or an unreadable liveness observation aborts the local wait, records
an unknown outcome privately and never replays the phase. Independent cleanup
still requires writer absence and exact resource inventory, rather than treating
the interrupted connection as proof of deletion.

Kubernetes exec completes on its explicit status-channel result, matching the
[official JavaScript client](https://github.com/kubernetes-client/javascript/blob/main/src/exec.ts).
It does not wait for a forwarding socket to close afterward. Failure status,
missing status, malformed status, cancellation and deadlines remain failures;
no uncertain command is replayed. Real HTTP/WebSocket regressions keep the socket
open after success/failure to exercise this boundary through actor cleanup.

Private journals are content-addressed immutable GCS objects, with checksum and
generation verification and no overwrite. Recover an uncertain operation from
its exact `qualification/OPERATION` journal and cluster registry before removing
the global `qualification/active.lock`. A stale PID or elapsed timeout is not
cleanup proof. A failed/unknown attempt holds that lock and cannot silently start
another test. Successful fixture cleanup removes only the exact lock generation;
the shared cluster, Gateway, certificate and identities remain.

Production uses a separate private bucket and per-operation replay fence. Its
command persists all online recovery files before admitting workload mutation,
and persists subsequent journal artifacts as they are acknowledged. Detailed
values, backups, receipts and errors remain private; only the successful
sanitized deployment summary is a GitHub artifact. The private local directory
is outside checkout cleaning; GCS preserves evidence after hosted-runner loss.
An installation adapter that keeps a live external observer must also keep its
mutable files outside the checkpoint upload tree. Persist phase acknowledgements
directly, then copy observer history into final evidence only after the exact
observer process has exited and owned fixtures are cleaned. This prevents a
concurrent append from invalidating checkpoint size/checksum verification.
Existing CLI users can still supply durable external directories and explicit
credential/policy paths without hosted preparation.

Revoke persistent access by disabling release automation/environment access,
removing federation impersonation and the dedicated Kubernetes/bucket bindings,
then removing the dedicated identities/provider after inspecting active locks.
Keep recovery journals and retained serving infrastructure intact.

## Provider driver contract

`driver.json`: `protocol:1`, `suite:"compact-seven-v1"` or the explicitly opted-in
`"compact-seven-overlap-v1"`, `provider:"gke"`,
`scope:"isolated-provider"`, a relative `.mjs` `entrypoint`, and `files` mapping
**every** other file to its byte SHA256. The configured manifest digest is
SHA256 of `JSON.stringify` of the parsed manifest. Extra/missing files, symlinks,
path escapes or changed bytes fail before each phase. Pin the entire dependency
closure; do not fetch mutable code or import an unpinned external toolkit.

The entrypoint receives one phase name in argv and `{operation,privateDirectory}`
through private stdin; stdout is one JSON receipt. Stderr is privately retained
up to 1MiB per phase. Receipts bind `protocol`, `operationId`, `inputHash`,
`projectId`, `projectNumber`. The immutable operation freezes manifests, observed
installation, normalized policy, driver digest, budget and deadline.

The table describes full qualification. Focused operations replace the stress
matrix in `autoscaling` with current policy/two-ready-floor observations under
their own public traffic; they do not claim growth, failure injection or HPA tests.
When qualification tooling changes, repackage/review its pinned bundle and update
the existing janitor's approved digest. Ordinary image changes reuse that reviewed
tooling; no cluster, VM, IAM or certificate setup is repeated per release.

| Phase           | Required actual work                                                                                                                                                                                                                                                                                                                                                                                                     |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `armExpiry`     | Arm an existing **independent** janitor before paid activation. Return exact `identity`, original `expiresAt`, `maxUsd`, `independent:true`, `armed:true`, `billableActivation:false`. It must survive Actions and runner loss.                                                                                                                                                                                          |
| `prepare`       | Create new synthetic staging resources; persist intents/immutable identities around writes, install the exact predecessor/seven-pod layout/policy and preserve the janitor identity. Return complete inventory. Lost create acknowledgement requires inspection, never replay.                                                                                                                                           |
| `upgrade`       | Execute shared ordinary-upgrade probes over real trusted HTTPS/GKE routing, not a kubectl forward labelled public. Return `qualification:"isolated-provider"`, exact pair/chart/policy, initial/final counts7, uninterrupted workflow/web observations, both accepted recordings, two-ready floors, storage/export, browser OAuth/action/schedule and fresh controller facts required by `assertOrdinaryProviderReport`. |
| `autoscaling`   | Execute real slot/CPU growth, maximum provider-node capacity, safe busy retirement/recordings, returning demand, controller restart/lost-ack/serialization, stale/missing metrics, eviction fences, active/paused growth and proxy HPA. Supply completed facts required by `assertProviderAutoscalingReport`, not check names. Two cooperative surge steps require a ceiling of at least four.                           |
| `settle`        | Stop admission, settle all exact writers/accepted work and inspect uncertain writes. Return `writersStopped`, `acceptedWorkSettled`, `inventoryComplete` and complete inventory including controller children. Process exit/PID/marker alone is not settlement. Failure here prevents deletion.                                                                                                                          |
| `cleanup`       | Use reviewed helpers and the durable inventory lock. Await exact deletions; never use prefix discovery, delete historical/pre-existing resources, replace IAM policies or force peering.                                                                                                                                                                                                                                 |
| `verifyCleanup` | Fresh independent observations for every exact resource, bound to SHA256 of settled inventory: absent or an explicit non-billable hold, with zero uncertain writes. Billable holds, omissions or reclassification block qualification.                                                                                                                                                                                   |

Inventory entries contain full immutable `id`/UID (not mutable name/prefix),
`kind`, `operationId`, `projectNumber`, `newlyCreated:true`, `billable`. Discover
exact controller children without dropping/reclassifying earlier identities;
retain inventory history. The independent janitor must use these same reviewed
helpers. Actions `always()` alone cannot provide expiry protection.

On SIGTERM stop admission and cooperatively settle owned children/work. The
command waits for actual driver close before settlement; timeout or lost
acknowledgement never repeats a phase. A hard runner kill still requires the
independent janitor. Timers do not authorize stealing ownership.

Each phase intent is persisted before dispatch. Existing operation directories
never restart. A failed/unknown operation retains `active.lock` even if normal
cleanup succeeded, preventing a new paid test from passing over unreviewed work.
Recovery must verify that exact operation, janitor, writer shutdown and residual
inventory before explicitly releasing the lock. A stale PID is not authority.

## Maintained fixture and independent expiry cleanup

### Completion boundary

The maintained fixture is implemented locally, not installed or GKE-qualified by
these tests. Its one-time reusable infrastructure and activation remain separately
approved actions. Do not present a passing unit/browser fixture as a release's
provider qualification, or reuse a failed protected window as a passing one.

| Requirement            | Maintained implementation and local regression                                                                                                                                                     |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authentication         | One UI-cookie/Bearer adapter, real dummy-OAuth redirect/session flow and the shared browser action journey; no seed or accepted-write replay.                                                      |
| Certificates and setup | Strict TLS/SNI preflight of each operation hostname, current Gateway/listener conditions, namespace-scoped route admission, CSI Delete reclaim and fresh metrics before per-run resource creation. |
| Readiness              | Exact predecessor images/seven owners plus positive NEG health; transient propagation uses the bounded strict waiter, not a one-shot probe or relaxed health check.                                |
| Observers              | Independent upgrade/autoscaling request windows, accepted-work recordings and a fresh browser OAuth/action check; a failed window cannot be merged into another.                                   |
| Cleanup                | Shared normal/expiry settlement and exact immutable inventory, independent janitor and process/node checks; shared reusable infrastructure is explicitly excluded.                                 |
| Local reproduction     | HTTP/exec-WebSocket/TLS regressions, actual driver packaging/Helm rendering, real Linux process checks and intercepted headless browser contract. These are not live GKE evidence.                 |

`armExpiry` first runs the intercepted headless browser contract on the actual
runner, catching missing browser binaries/libraries before paid setup. It then
checks the existing shared infrastructure read-only before creating its registry.
`prepare` repeats the infrastructure preflight before creating its namespace,
PostgreSQL/MinIO or CSI claims. Public TLS verification sends no HTTP, credentials
or workflow requests and has a 15-second handshake deadline. It validates the
system-trusted certificate and exact hostname; there is no ignore-certificate flag.

Gateway/listener conditions must match the current `metadata.generation`, as
required by the [Gateway API status contract](https://gateway-api.sigs.k8s.io/docs/concepts/troubleshooting/).
The reviewed listener uses HTTPS/443 and `*.DOMAIN` (or the exact operation
hostname), admits HTTPRoute and selects namespaces with exactly
`matchLabels: {rivet.dev/qualification-route: "true"}`. Storage must use
`pd.csi.storage.gke.io` with Delete reclaim. Node metrics must be complete,
nonempty and fresh under the approved policy's `metricsMaxAgeSeconds`.
Provision these prerequisites once through the separately reviewed setup; the
fixture diagnoses failures but never repairs the shared Gateway/certificate,
storage class, metrics service or IAM automatically. No setup failure permits
replaying uncertain writes, extending the operation clock or silently starting
another environment.

`qualification/provider-entry.mjs` owns preparation, actual ordinary-upgrade and
autoscaling probes, phase receipts and settlement. It reuses the shared release
runner and accepted-work/recording probes. Provider probes use public trusted
HTTPS through the fixed Gateway; port forwarding cannot become provider evidence.
Positive NEG health, working UI-gate and workflow Bearer authentication, and the
exact predecessor's seven ready owners precede the one-time synthetic seed.
Bootstrap first creates the exact chart proxy Service with fresh-namespace Helm
ownership, then its HTTPRoute/health policy, and waits for two-zone NEG discovery
**before** installing proxy Pods. Otherwise those Pods may miss GKE's injected
readiness gate. Helm adopts that Service without replacing it. This bootstrap
ordering never weakens the later positive load-balancer-health check.

Fixture setup and proxy-handoff preflight share the same Deployment-availability
and regional endpoint-health checks in `lib/gke-proxy-health.mjs`. Pod `Ready`
alone does not complete setup: the proxy Deployment must observe its current
generation, update its desired replicas and report the required available floor.
This honors its configured `minReadySeconds` through Kubernetes status, without
adding a separate sleep. Setup polls within its existing proof/operation deadline;
normal startup settling does not fail the test immediately. Deadline errors retain
the specific unmet condition. Preflight and handoff waits also identify missing
availability, Pod/NEG readiness, node/zone spread or backend health instead of
reporting every failure as missing two-zone placement. Ownership and protected
shutdown checks retain their existing fences.

The fixture trusts that approved Gateway's forwarded HTTPS host/protocol so
OAuth redirects and Secure cookies retain the public origin. Restrict edge access
to the shared Gateway in the dedicated cluster/network setup; no extra public
Service/Ingress, arbitrary forwarded host or production DNS is introduced.

The fixture copies only installed chart resource requests/limits, drain/probe
timings, rollout stabilization, connection budgets, admission limits and restore
claim size. It never copies production env, saved data, credentials or CAS guards.
Dependency PostgreSQL/MinIO use reviewed digest-pinned images and new CSI claims.
Long-running provider checks keep the actual stabilization/withdrawal intervals;
they are not the accelerated local test. Upgrade and autoscaling have independent
public workflow/web observers; any failed window stays failed.
Each protected phase is bounded by the original operation deadline, not a shorter
arbitrary per-phase timer that cuts off valid real stabilization windows. Settlement
has at most the remaining Actions allowance (one hour); the independent janitor
remains responsible if the runner/job disappears before settlement completes.

Seed HTTP, explicit conflict probes, recording replay and WebSocket actions share
the fixture's authenticated adapter/headers. Phase processes obtain a fresh
web-app session through real dummy OAuth, never repeat seed writes or forge a
session cookie. The shared browser journey checks the exact approved HTTPS origin
and one actual `action.completed` message; local intercepted-browser coverage is
only a fixture-contract check, not evidence of GKE/TLS readiness.

The qualified runner must be an **ephemeral Pod in the dedicated staging cluster**,
labelled `rivet.dev/qualification-runner=true`, with Downward API `POD_NAME` and
`POD_UID`. A GitHub-hosted coordinator uses that Pod; a desktop/VM cannot execute the provider phases directly. It must have
a private persistent operation store, the exact clean candidate checkout and
immutable Yarn install, native Helm/kubectl, OpenSSL, browser dependencies and
staging-only credentials. Every CLI command validates the staging kube-system
UID, including probes using the inherited transport. Neither a context name nor
a default kubeconfig establishes isolation.

An operation's ConfigMap in the pre-existing control namespace freezes its input
hash, CREATE nonce, namespace UID, runner Pod UID, phase/process intents, cleanup
owner and cumulative inventory. The independent janitor publishes fresh health
bound to its Pod UID and approved driver digest. Missing/stale health or a
different driver prevents paid preparation. Registry updates use resourceVersion
CAS without retries. A paused owner blocks takeover until that exact Pod is gone.

At expiry the janitor closes admission, requests normal deletion of only that
exact ephemeral runner Pod and observes its actual absence. It then settles
nonce-bound remote CPU fixtures and uses the supported retirement CLI to drain
accepted API/background work without aborting it. It stops the per-run controller,
removes only the per-run HTTPRoute, and deletes only the nonce/UID-bound namespace.
The shared Gateway/listener, certificate, cluster, network and administrative
identities are never deletion targets.

Cleanup records PVC/PV/CSI disk and Service NEG immutable identities plus Gateway
backend/health-check children linked through those exact NEGs. Only Kubernetes/
GKE controllers delete provider resources; the janitor's Compute IAM is read-only.
Verification observes each recorded identity absent. Pending CSI creation,
incomplete NEG status, pre-existing children, failed cloud reads, changed UIDs,
unknown retirement or unacknowledged DELETE block cleanup. Missing acknowledgement
never authorizes another write. A lost namespace CREATE can be inspected through
its already-recorded unique nonce; a name/prefix alone is never ownership.

Cleanup reconciliation keeps historical identities separate from current targets.
A replaced autoscaler Deployment stays in inventory history, but only the freshly
observed, inventoried current UID may receive the conditional stop patch. The
janitor claims cleanup once per pass; settlement and post-deletion verification
use that same ownership boundary.

Before withdrawing routes, cleanup records a complete edge inventory and the
exact `retiringNegIds`. GKE may then remove those already-recorded backends and
health checks while API owners drain. That disappearance is expected, not an
incomplete-creation failure; their identities remain in the cumulative inventory.
A new NEG identity still requires full backend/health-check discovery, and failed
provider reads or incomplete aggregated results still block cleanup.
This includes HTTP-200 lists with `unreachables`, pagination or any warning other
than `NO_RESULTS_ON_PAGE` (see the [Compute aggregated-list contract](https://cloud.google.com/compute/docs/reference/rest/v1/backendServices/aggregatedList)).
Listing a backend name is not ownership: its fresh GET must retain the listed
numeric ID, NEG bindings and health-check references before any child is recorded.
A replacement or relationship change requires a new complete observation, never
an inferred successful inventory or a modifying retry.

Normal HPA completion and expiry cleanup share one cooperative fixture-stop
command. It validates the Pod UID at the caller and the process start ticks plus
nonce-bearing command before writing that fixture's stop file. An absent/exited
process or a reused PID means the original fixture ended; no stop file is written
for the replacement. A live matching incarnation with the wrong nonce still blocks.
This settlement evidence never turns a lost/failed exec acknowledgement into a
passed qualification; the normal HPA probe still requires its own successful result.

`settling` becomes `settled` atomically with the final complete inventory, after
accepted work has drained. A failed final read cannot authorize namespace deletion.
Migration/test Jobs must have a terminal Complete/Failed condition and no live
Job-owned Pods. A zero `status.active` value alone is not completion: it can also
mean the Job has not started, or its controller status has not caught up.
Verification waits for the namespace itself to disappear before checking retained
resource histories; an empty inventory never overrides a live namespace. A known
namespace disappearing without this operation's recorded deletion intent is an
unexpected outcome requiring inspection, not proof of successful cleanup.

Normal completion invokes the same cleanup code. A failed operation retains its
private lock and diagnostics for explicit recovery even if cleanup later succeeds.
Expiry does not invent a pass, reset the deadline, or release an operation lock.
The reusable infrastructure and idle janitor continue to cost money after run
cleanup; namespace cleanup is not a claim of zero staging spend.

### Render-only setup

First separately approve/provision a **dedicated** reusable cluster with metrics,
CSI Delete-reclaim storage, sufficient node autoscaling in at least two zones,
a shared Gateway accepting only labelled qualification namespaces,
trusted TLS for a dedicated fixed `hostname` (or wildcard per-operation DNS), dedicated runner/control namespaces,
and Workload Identity. Do not reuse historical resources implicitly.
Preserve the runner's private operation store on separately approved persistent
storage; browser traces/reports are directed there, not public Actions artifacts.
Expiry takeover also requires the runner's original node UID to remain Ready:
an API Pod disappearing during an unknown-node event is not process-exit proof.

Supply a private JSON settings file with `protocol:1`, `mode:"reusable-cluster"`,
`projectId`, `projectNumber`, exact `clusterUid`/`clusterServer`/`context`,
`gatewayUid`/`gatewayNamespace`/`gatewayName`, `controlNamespace`, `runnerNamespace`,
`storageClassName`, `domain`, nonempty narrow `trustedClients` CIDRs (never `/0`),
and digest-pinned `postgresImage`/`objectStorageImage`.
For private images, optionally supply `registrySecret:{name,uid}` pointing to an
explicit staging-only dockerconfigjson Secret in the runner namespace. Preparation
verifies its immutable UID and copies only that registry credential into the new
namespace; the original is never cleanup-owned. GitHub/production tokens are not
substituted, and a missing image-pull permission must fail rather than fall back.

```text
yarn node deploy/studio-server/scripts/package-reusable-staging.mjs SETTINGS_JSON NEW_OUTPUT_DIRECTORY API_IMAGE_AT_DIGEST JANITOR_GSA_EMAIL
```

The command refuses an existing output directory. Review `janitor.yaml` and the
package hashes before a separate installation action. It renders a singleton
Recreate janitor Deployment, immutable code/settings ConfigMap, health ConfigMap,
ServiceAccount and narrow resource-type RBAC. Namespace/Pod delete privileges are
cluster-scoped: Kubernetes RBAC cannot restrict them to name prefixes. This is why
the dedicated cluster, exact UID guards and separate approval are mandatory.
The janitor GSA must be staging-project-only with Compute read permission and the
explicit Workload Identity binding; the packager neither grants IAM nor changes
quota/billing. Runner RBAC is a separate reviewed installation capability: it
needs namespace creation, fixture/Helm CRUD and exec only in this isolated cluster.
It also needs read-only access to the exact shared Gateway, the selected
`storage.k8s.io` StorageClass and `metrics.k8s.io` node metrics for preflight.
The independent janitor does not gain those additional runner capabilities.

Install the driver read-only outside checkout and pin its returned digest in the
protected workflow configuration. Install matching janitor code/settings first;
armExpiry refuses an older janitor digest. Preserve its operation registries
across janitor replacement. Replacing janitor code/its immutable ConfigMap requires
an explicit idle, reviewed installation update—not an operation cleanup action.

## Local verification and activation boundary

Committing this implementation does not activate the workflow or grant a cloud
budget. Before the first provider run, publish a reviewed candidate through normal
CI, verify its exact installed predecessor, and separately approve/install the
reusable infrastructure, matching driver/janitor, runner access and idle/test
budgets. A historical operation's allowance does not authorize a new operation.
Production deployment and first developer-overlap adoption remain separate
approval boundaries after the relevant provider evidence passes.

```text
yarn node --test deploy/studio-server/scripts/runtime-qualification-execution.test.mjs deploy/studio-server/scripts/runtime-qualification-publication.test.mjs
yarn node --test deploy/studio-server/scripts/reusable-staging.test.mjs
yarn node --test deploy/studio-server/scripts/provider-overlap.test.mjs
yarn node --test deploy/studio-server/scripts/reusable-staging-transport.test.mjs

# Headless, intercepted local fixture; no staging domain or cloud access needed:
# Set PLAYWRIGHT_HEADLESS=1 and PLAYWRIGHT_SLOW_MO=0, then:
yarn studio-server:ui:observe runtime-control-fixture-contract.spec.ts
yarn node scripts/checks/check-ci-workflows.mjs
```

Before paid overlap preparation, also run the synthetic bundle fixture against
an explicitly selected current API image (digest or full local image ID):

```text
RIVET_HOUSEKEEPING_TEST_IMAGE=API_IMAGE_AT_DIGEST yarn node deploy/studio-server/scripts/verify-housekeeping-managed.mjs --provider-fixture
```

This uses disposable local PostgreSQL/MinIO and the real HTTP upload/conversion,
publication and bundle-export routes, then checks housekeeping handover and restore
journal preservation. The helper is bundled from this checkout and sent through
local Docker stdin; no code is uploaded to GCP. The option rejects mutable image
tags and never pulls an image implicitly. The historical default-image smoke
without this option remains available, but cannot validate current release/schema
behavior.

The process-stop regression executes real `/proc` checks on Linux. On Windows,
set `RIVET_STAGING_PROCESS_TEST_IMAGE` to a reviewed cached Alpine-compatible image
ID to run it in a disposable `--network none --pull never` container; without it,
that one Linux test is explicitly skipped. The check covers exact stop, repeated
stop, exit, PID-incarnation mismatch and wrong-nonce refusal, not node scheduling.

These tests cover immutable admission, privacy, real CLI/child processes using
a local driver, late cancellation/expiry, receipt mutation, phase-specific
traffic/window validation, namespace replacement, cleanup ownership, credential
filtering, no replay and existing publication composition—not GKE execution.
Existing real local seven-pod/browser evidence is separate in
[runtime qualification](runtime-ha-qualification.md).

To activate: review the generated package/manifests, approve shared infrastructure,
runner/IAM and idle/test budgets, install and verify the independent janitor, then
run a separately approved isolated GKE window. Nothing in the local implementation
or tests applies those manifests, enables the workflow or qualifies a release.
