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

`studio-server-qualify-release.yml` implements Actions orchestration;
`execute-runtime-qualification.mjs` owns its command boundary. Neither authorizes
GCP access, enables automation, installs credentials or deploys production. The
main-only, dispatch-only workflow fails when
`RIVET_AUTOMATED_QUALIFICATION_ENABLED` is not exactly `true`.

The maintained inner fixture uses a **dedicated staging cluster**. The latest
operator decision is temporary infrastructure, removed after qualification;
the earlier always-on reusable-cluster proposal is not current spending approval.
Each inner operation creates only its temporary namespace and
synthetic resources. Keep the shared cluster, network, Gateway, certificate and
administrative identities out of its cleanup inventory. This removes repeated
cluster startup when infrastructure is retained, but leaves idle cost. Creating/configuring
temporary infrastructure and removing its foundation is a separate approved setup action; no historical
environment is silently repurposed.

The inner fixture's namespace cleanup is **not** full temporary-environment
cleanup: its cluster, Gateway, certificate, addresses and network remain excluded.
The maintained outer provision/expiry/teardown route is
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

Actions readiness on an initial singleton reports `adoption-preflight-passed`
and these pending steps, not `deployment-preflight-passed`. It derives private
sizing values, pulls the predecessor by digest and runs the real read-only
command. It does not approve or perform the adoption. An already-overlap
installation continues through the ordinary readiness path.
If the source pool already matches the profile, readiness starts at ownership
and the provider skips an unnecessary singleton pool-preparation replacement.

The maintained concrete adapter lives in `scripts/qualification/`; package it
with `scripts/package-reusable-staging.mjs`. The resulting administrator-reviewed,
hash-pinned bundle implements all seven phases. The separate
`scripts/reusable-staging-janitor.mjs` uses the same ownership and cleanup modules,
not an Actions `always()` job. Packaging renders installation manifests; it does
not install them or provision GCP. Archived operation-specific scripts and their
resource identities remain excluded. Local tests are not provider qualification.

## Three distinct results

1. **Built:** requested main Build Images run succeeded for this commit. Its
   candidate/promotion agree on exact images, chart, schema, source, creation and
   lineage. Pull the predecessor by immutable digest, never the moving registry
   `production` pointer. Compare it with the actual installation before paid work.
2. **Qualified:** the approved driver executed ordinary seven-pod upgrade and
   autoscaling probes and verified cleanup. The command derives the existing
   declarations from completed facts; dispatch inputs cannot supply a list of
   passed check names. Publication reuses the existing guarded workflow. Legacy
   manual publication remains for separately reviewed adoption declarations.
3. **Production preflight passed:** after publication, the supported deployment
   command runs with `--preflight-only`. Recheck actual predecessor, namespace,
   settings and exact operator-value bytes against the qualification input, and
   inspect the immutable qualified target. This is a timestamped observation,
   not approval to deploy or a permanent readiness flag. No backup or application
   journey is run; deployment must repeat ordinary safety/backup checks.

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

Installation observation rechecks the namespace and cluster lifetimes after
reading Helm. The production-preflight wrapper checks all installation/settings
identities before **and after** the supported command, rejecting drift during
the check rather than claiming production was unchanged from an earlier read.

## Configuration requiring separate approval

Use dedicated self-hosted Linux labels `rivet-qualification` and
`rivet-production-readonly`, never an untrusted-PR/developer runner. Install
Node24, Corepack/Yarn, native kubectl/Helm, Docker for immutable OCI retrieval and
the reviewed probe dependencies. Do not persist checkout credentials.

Protected `rivet-managed-staging` configuration:

- `RIVET_AUTOMATED_QUALIFICATION_ENABLED` (also a repository variable for the
  initial planning job), `RIVET_QUALIFICATION_PROJECT_ID` / `_PROJECT_NUMBER`.
- `RIVET_QUALIFICATION_MAX_USD` and `_MAX_SECONDS`: explicit approved positive
  allowance, not a hard billing cap. The Actions path admits at most two hours
  of tests, leaving an hour of its three-hour timeout for settlement. Never
  reset/extend the original deadline or first billable-activation clock.
- `RIVET_QUALIFICATION_DRIVER_DIRECTORY` / `_DRIVER_SHA256`: administrator
  installed read-only driver bundle and complete manifest hash, not commands
  chosen by a dispatch input.
- `RIVET_QUALIFICATION_PRIVATE_STORE`: persistent private directory outside the
  checkout. It holds exact input, intent records, receipts, stderr and a lock;
  it must survive checkout cleanup and runner/job loss. Never upload or commit it.
- `RIVET_QUALIFICATION_STAGING_KUBECONFIG`: private staging-only credential path.
- `RIVET_QUALIFICATION_CLUSTER_UID` (the approved staging `kube-system` UID),
  `_CLUSTER_SERVER` (trusted HTTPS origin), `_GATEWAY_UID`: shared infrastructure
  identities. Staging's cluster UID must differ from the freshly read production
  cluster UID, even if contexts/project labels look different.
- Production read-only `RIVET_QUALIFICATION_PRODUCTION_` variables:
  `KUBECONFIG`, `CONTEXT`, `NAMESPACE`, `NAMESPACE_UID`, `RELEASE`, `VALUES_FILE`.
  They select fixed read commands, not shell snippets. Production RBAC must not
  permit the qualification driver to mutate workloads or saved data.

`rivet-production-readiness` supplies the production variables and the existing
reviewed `RIVET_QUALIFICATION_PRODUCTION_POLICY_FILE`. Keep its observations and
credentials narrowly scoped; do not broaden access to make a failed preflight
pass. Actual credentials/settings remain private files, not variables/artifacts.
Missing prerequisites fail, rather than create a successful skipped job.

For a fresh runner checkout, that policy file may live in a protected external
directory alongside its two self-contained, checksum-pinned `.mjs` adapters.
Only read-only qualification preflight validates the installation and adapter
bytes, copies them into a new private packet directory and rewrites their local
paths. Path escapes, redirected directories, changed checksums and retained
output are rejected. No adapter executes during copying. Keep any private
prerequisite evidence outside the checkout and pin it in the reviewed adapter.
When the actual recovery operator uses another OS, its dependency and capacity
checks must run there; the read-only coordinator may verify their exact bound
receipt, but cannot claim it ran those tools locally. Actual backup and application
acceptance remain required on the deployment operator, using its own freshly
validated policy; this copy step neither delegates writes nor permits deployment.

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
`POD_UID`. No general desktop/VM runner is supported by this adapter. It must have
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
a shared Gateway accepting only labelled qualification namespaces, trusted
wildcard DNS/TLS for a new staging domain, dedicated runner/control namespaces,
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
