# Runtime HA qualification publication

The compact singleton layout and drain-aware autoscaler need separate exact-image
provider evidence in addition to ordinary replicated-HA qualification. Local
functional tests are not a GKE certificate.

For a schema-changing pair, HA release creation and rolling admission additionally
require the [rolling database contract](deployment-operations.md#rolling-database-compatibility-contract).
Startup/schema verification alone cannot produce that receipt. The image gate
runs old/new repository workers; the ordinary runtime gate repeats that pair
alongside its protected traffic window. Unchanged-schema releases skip the DB
workers. A future schema transition without a reviewed behavioral matrix fails
closed, even if its declared rollback floor would otherwise permit rolling.

The dispatch-only [automated orchestration](automated-runtime-qualification.md)
executes a reviewed hash-pinned provider driver and compiles publication input
only after successful probes and verified cleanup. It remains disabled until the
maintained reusable driver, independent janitor, runners and access are
reviewed/installed under separate infrastructure approval. The concrete code and
render-only package command are documented in the linked guide; local verification
does not activate them. Publication is reusable by that workflow and retains the
manual path for separately reviewed adoption declarations.

## Release order

1. Freeze a reviewed main candidate and let its normal **Build Images** run finish
   successfully. Retain its candidate/promoted manifests, exact predecessor and
   image digests. Do not install this unqualified candidate in production yet.
2. Complete local and separately approved isolated GKE verification against those
   exact images/chart/policy. For an **ordinary upgrade of the existing seven-pod
   installation**, test the exact installed predecessor directly to the candidate
   in compact/singleton mode, with the execution controller and proxy HPA active.
   Do not traverse historical regional/control-topology conversions. Keep the
   separate autoscaling, browser, recovery and capacity qualification requirements.
   A **first adoption or topology change** instead needs the explicit adoption
   cases, including regional/compact transfer and reversal and maintenance sizing.
3. Settle every observer/worker, retain truthful terminal diagnostics and clean
   up the exact recorded test resources. Do not combine failed/partial windows
   into a passing certificate or derive maintenance sizing from tiny exports.
4. Run **Publish qualified runtime HA** on that same main source, supplying the
   successful Build Images run ID and the two sanitized provider declarations.
   It downloads the original candidate and ordinary-HA promotion; it never
   rebuilds images, runs a GCP experiment or deploys workloads.
5. The resulting immutable manifest retains the source/images/chart/schema and
   predecessor, adds the exact runtime evidence, and records this publication's
   actual workflow run as promotion provenance. It advances the artifact pointer
   only while main and the original ordinary-HA production pointer still match.
6. Pin that qualified manifest. For an already-adopted compact/singleton seven-pod
   installation, use the normal HA installed-to-candidate rollout directly.
   Only first adoption follows the separate replicated installation,
   regional13->10 transfer, compact10->6 and autoscaler6->7 transitions.

Evidence changes the manifest digest. Never edit an installed manifest in place
or bypass predecessor validation to bolt on a certificate. If the unqualified
manifest was already installed, create a new compatible candidate with that exact
installed manifest as predecessor. Same images do not authorize a sibling rollout.

## Dispatch declaration contract

Each JSON input is at most 16,384 characters with exactly these fields:

- `protocol`:1, `provider`:"gke", `scope`:"isolated-provider", `outcome`:"passed",
  `cleanupVerified`:true.
- `operationId`, `projectId`, `projectNumber`: the same approved isolated operation
  in both declarations. Never use production resources as the test target.
- `startedAt`, `finishedAt`: the actual completed UTC ISO observation window
  (`YYYY-MM-DDTHH:mm:ssZ`, optionally with 1-9 fractional-second digits).
  Both must be timestamp strings with valid calendar dates, with end after start;
  date-only strings, locale dates and JavaScript-coerced arrays are rejected.
- `reportSha256`: SHA-256 of the retained sanitized terminal provider report.
- `evidence`: the exact runtimeControl/runtimeAutoscaling shape in
  `lib/ha-release-evidence.mjs`, constructed only after every required check passes.
- Autoscaling additionally needs `policy`: all normalized `autoscalerPolicy`
  fields. Its canonical digest must match the evidence.

Control protocol1 is the historical adoption contract and must cover both regional
and compact profiles. Control protocol2 is the ordinary-upgrade contract: compact
only, `purpose:"ordinary-upgrade"`, `controlPlaneMode:"singleton"`, the exact
`predecessorManifestDigest` and `autoscalerPolicyDigest`, and the complete
`HA_ORDINARY_RUNTIME_CHECKS` list. It cannot authorize first adoption, a topology
change, developer overlap or a different scaling policy. Publication also requires
cooperative autoscaling protocol2 with the same policy digest. Both installed
values and rendered destination resources are checked: backend1, web1, proxy2,
execution2, autoscaler1; execution floor2 with a live controller and proxy HPA
floor2/ceiling4/CPU75%. Seven is a baseline, not a ban on safe temporary growth.
Rendered mode/policy checks inspect the named backend and autoscaler containers;
an unrelated sidecar cannot satisfy missing configuration on the actual owner.

Failed, local, incomplete,
uncleaned, mismatched source/images/chart/policy or different-operation inputs
are rejected. No copied unit-test checklist can establish provider qualification.

Control protocol3 is the compact ordinary mixed-image upgrade plus developer
overlap contract. It retains the exact predecessor/policy fields from protocol2,
uses `controlPlaneMode:"singleton-overlap"`, and includes `developerOverlap` with
protocol2, the normalized explicit sizing `profile`, its SHA256 `profileDigest`
and all `HA_PROVIDER_OVERLAP_CHECKS`. It does not require historical regional
topology conversions. The same-image bridge is preparation, not a promise of
uninterrupted developer editing; customer observers remain active through it.
The resulting certificate is compiled only from
actual provider observations and verified cleanup; local test facts cannot
qualify an image. It uses cooperative autoscaling protocol2 and preserves the
same seven-pod floor. Rendered target pool/resource settings must match the
qualified profile; a protocol2 singleton receipt cannot enable overlap.
See [automated qualification](automated-runtime-qualification.md) for profile
selection, the accepted-acknowledgement interruption and budget validation.

## Ordinary local qualification command

`kubernetes-runtime-control-local.mjs` defaults to
`RIVET_RUNTIME_QUALIFICATION_PURPOSE=ordinary-upgrade` and compact mode. Supply
`RIVET_RUNTIME_CONTROL_BASELINE_MANIFEST` (the exact promoted installed manifest)
and `RIVET_RUNTIME_CONTROL_CANDIDATE_MANIFEST` (candidate or promoted target), plus
the existing managed-release-gate context, registry, image and artifact settings.
The candidate images must match those settings and its chart must match the
checkout. An optional `RIVET_RUNTIME_AUTOSCALER_POLICY` file pins the execution
policy; omission uses the documented default, never infers production settings.
Run with `yarn node deploy/studio-server/scripts/kubernetes-runtime-control-local.mjs`.

Use a fresh explicitly allowed `rivet-runtime-ha10-*` local context and
`rivet-runtime-control-*` namespace, loopback Kubernetes API, distinct proxy hosts
and a surge host, two topology domains, and functioning metrics-server. The
historical context prefix is retained for safety/compatibility, not a ten-pod
test requirement. Set the per-operation kubeconfig explicitly; do not change the
developer's active context. Dependencies and the test edge are fixture pods and
are not counted as application pods.
Retain `namespace-identity.json` immediately after fresh namespace creation; do
not wait for the rollout journal to preserve the UID needed after a bootstrap
failure. A missing receipt is not proof that creation did not happen.
Namespace creation uses create-only admission with its ownership label and saves
the UID returned by that CREATE. It must never delegate to delete-before-create
fixture reset logic: an item appearing after the preliminary GET is a conflict,
not permission to remove it. Lost creation acknowledgements require inspection.

The runner starts with seven predecessor application pods, retains the existing
non-retrying workflow/web traffic observers, and uses the shared actual rollout
coordinator. Each original execution owner accepts an early-output/background
run, then must durably save exactly one matching recording before removal.
Service/PVC identities and a downloaded immutable export are checked after the
upgrade. Fresh controller samples, return to seven candidate pods and published
OAuth actions/schedule recordings while developer pods are absent are required.
Cold proxy replacement is included. Do not race the adoption fixture's manual
execution scaling with the live controller: cold execution/node-loss/eviction
cases remain separate autoscaling/provider tests. Singleton developer/web
availability is not promised by this production-execution continuity test.
Before any fixture upload it waits for all seven exact-image owners and probes
the developer GET route through every proxy. Helm's completion is not sufficient
for an `OnDelete` StatefulSet, particularly while a fresh node pulls its API image.
A failed preparation is retained and inspected; do not blindly replay its upload.
Fixture preparation can also briefly scale execution above two: wait for natural
controller stabilization before opening the seven-pod observation window. Never
manually shrink it for the test. A settled baseline excludes terminating owners.
The ordinary fixture takes backend/execution CPU and memory requests from the
chart defaults. Do not inherit the historical adoption fixture's 100m requests:
they inflate CPU utilization and can request unschedulable extra ordinals on a
three-node local cluster. Local node exhaustion blocks the proof; it does not
authorize a manual shrink, disabled autoscaler or relaxed metrics. Provider
qualification still requires the actual deployment's sizing and node headroom.

Pod Ready is not CPU-metric readiness. The shared rollout coordinator waits
read-only, under its existing bounded timeout, for a typed missing execution
sample or missing/stale proxy sample. A missing execution sample is not zero and
must not be sent through the CPU quantity parser. Execution snapshots bind their
expected workload UID before those reads. The waiter reruns the complete
execution/proxy headroom checks before permitting
withdrawal. Identity changes, unknown ownership, invalid requests/policy and
confirmed insufficient capacity remain terminal. A persistent metrics outage
still blocks; no freshness limit, replica floor or mutation guard is relaxed.
Failed reports retain partial accepted-work identities for exact settlement.

Local transport shutdown is part of settlement, not just a `kill()` request.
The managed gate waits for the port-forward child's actual `close` event before
replacing its transport or deleting its namespace. An unconfirmed close blocks
cleanup. On Windows, a recognized Chocolatey kubectl shim is resolved to its
existing native target for port-forward only; shims with fixed extra arguments
are rejected rather than silently dropping those arguments. Ordinary short-lived
kubectl commands keep their existing behavior. Diagnostic Helm reads are also
bound to the operation's explicit context, never the machine's default context.

The local `20261028-f` ordinary window passed with exact predecessor `81a46463`
and candidate `06d315785`: 2,938 workflow requests, 949 web-app requests, zero
failed requests, and a durable recording for each of the two accepted background
drain probes. Across 1,288 readiness observations, execution and proxy capacity
never fell below two ready owners. The window returned naturally to seven pods;
service/PVC identity, the saved export and fresh autoscaler samples passed.
The actual headless browser OAuth/action scenario passed while developer
services were absent. Its separate autoscaler-only browser scenario was not
enabled; it is not an additional passing scenario. This is local functional
evidence, not GKE qualification or uninterrupted singleton developer/web access.
The retained report is
`artifacts/runtime-ordinary-20261028/proof-f/runtime-ordinary-upgrade-report.json`.
Earlier failed local windows remain failed, with their diagnostics retained.
The per-deployment timeout bounds individual waits; it is not an aggregate
timer that can invalidate an otherwise completed multi-phase qualification.
An explicit caller expiry signal still fences new phase admission.

To run historical conversions, explicitly set
`RIVET_RUNTIME_QUALIFICATION_PURPOSE=adoption`; its existing baseline/next-image
inputs and required reversal/ownership checks remain unchanged. Ordinary results
never stand in for those checks.

Reports are `local-functional-only`, not provider attestations or permission to
deploy. Failed windows stay failed; no write is retried and no observation windows
are joined. Capture the first failure's diagnostics while traffic is still
observable, then settle observers and retain terminal diagnostics. Context-bound
Helm inspection must not fall back to the machine's active context. Namespace
retention is intentional: settle accepted work and verify exact ownership before
explicit cleanup; killing a local runner is not proof of settlement.
The managed gate's deployment timeout bounds each readiness/settlement phase,
not the sum of a multi-phase qualification. In particular, do not reuse its
default ten minutes as a whole-proof timer: normal drain, stabilization,
withdrawal and schedule checks together can legitimately exceed that. Traffic
sample accumulation uses the same bounded waiter, not an unbounded polling loop.
Provider operators retain their independent approved expiry signal/budget; the
shared runner honors a supplied signal and never extends or resets that clock.

Local regressions: `runtime-upgrade-qualification.test.mjs` (real HTTP, Helm
rendering and deterministic rollout adapters), `runtime-control-local.test.mjs`,
`ha-release-evidence.test.mjs`, `installed-upgrade-plan.test.mjs` and
`runtime-qualification-publication.test.mjs`. Adapter tests are not a real cluster
upgrade; record the separate cluster command's result before claiming continuity.

## Recorded 502: evidence and limits

The retained failed window for operation `rivet-runtime-ha-20261028-06d3157`
contains a single NGINX HTTP502 on request
`8e95134d-e2c5-41c5-b730-f0e1e9b2e682`, starting
`2026-10-28T03:27:46.170Z` and ending `.269Z`, during
`predecessor-regional-13-to-10`. It also records 1732 successful workflow samples
and 671 successful web samples. This was **not** the ordinary seven-to-seven path.
The available summary has a response fingerprint, not correlated proxy/upstream
error logs; it cannot distinguish a stale upstream, routing propagation, reset or
an application error. Changing paths or fixing the claim race does not establish
this 502's root cause or prove it resolved.

New failed windows retain request IDs/timestamps/status/response fingerprints and
immediately capture fixture logs, endpoints, events and pod identities before
they can be truncated by a long rollout. The test edge's probe-only access log
contains upstream address/status/connect/header/response timing. Raw logs remain
private; publish only sanitized diagnostics. Any HTTP502 fails the window rather
than being retried, softened or hidden by an aggregate success percentage.

These are trusted-operator attestations backed by reviewed retained reports.
The workflow checks release/policy binding, structure, main build provenance and
publication lineage; a report hash is provenance, not remote cryptographic proof
that GKE performed a test. The job itself never runs or inspects the paid experiment.

Do not include credentials, project contents, prompts, outputs or raw logs.
Unknown declaration fields are rejected, and malformed values are not echoed in
validation errors. Only normalized declarations/evidence and the promoted manifest
are retained for 90 days. The content-addressed GHCR artifact is the durable record.

## Recovery and boundaries

The workflow is manual/main-only, uses the protected staging environment and shares
the normal main image-promotion concurrency group. A newer main push may cancel it.
Changed pointers are inspected, never overwritten. Publication changes artifacts
only: production backup, identities, shared-database budget, capacity, approval and
guarded deployment checks remain mandatory.

If acknowledgement/upload fails, inspect the immutable artifact and pointer before
retrying publication. The registry write may already have succeeded. Do not start
another paid rehearsal or replace already-qualified evidence to repair an artifact
upload. Source/image/chart/policy changes require a new reviewed candidate.
After declaration preparation succeeds, CI attempts to retain the sanitized packet
even if a later registry operation fails or the job is cancelled. The promoted
manifest is included if it was produced. Invalid or partially validated declaration
inputs are never uploaded. Cancellation/runner loss can still prevent upload, so
an absent artifact never proves that the registry write did not happen.

`runtime-qualification-publication.test.mjs` covers source/build provenance,
declaration rejection, release/policy binding, pointer identity and CLI input-log
redaction. The existing CI workflow-policy checker owns the YAML/permissions,
manual/main-only and publication-order checks. These are not a provider certificate.

## Isolated operator and maintenance-probe safeguards

Keep cloud creation gated until the complete case runner, failure settlement,
terminal export and exact-inventory cleanup have been checked locally. Package
the frozen source and a closed allowlist of operation helpers with content
hashes; never transfer a developer checkout's environment, Git remotes,
production values, host credentials or historical cleanup inventories.

Prepare Linux dependencies and compiled test helpers locally on the exact pinned
operator image. Restore the resulting hash-bound runtime on that same image in a
network-disabled container and recheck the source tree, Node ABI, helper imports
and headless browser before cloud dispatch. The paid operator must restore and
verify this tested packet rather than install packages or rebuild during the
qualification window. Keep its compressed and extracted sizes inside the
reviewed ephemeral-storage budget; this packet is not a new Rivet release image.

An in-cluster operator can continue using the cluster's own CA and rotating
service-account token without depending on a developer PC's management stream.
The separate public HTTPS observer must not import a Kubernetes client or resolve
a management context. Retain its single actual window, in-flight settlement and
precise process identity; a management disconnect must not silently restart the
observer or splice a replacement window into a passing result. GKE DNS management
endpoints use ordinary public CA trust, not the in-cluster CA override; preserve
hostname verification for both transports.

Before generating a one-time storage credential, verify the host's installed GKE
authentication plugin is resolvable and the exact new namespace is accessible.
Keep the SDK configuration explicit. If setup loses an unused credential before
its Secret is created, preserve the failed intent, verify and retire only that
exact new key, then journal one replacement; never replay account, environment or
key creation blindly. No application may have started for this setup-only path.
For large private runner uploads, explicitly disable the SDK's parallel-composite
upload mode when cleanup is restricted to recorded prefixes and content MD5 is
required. Keep conditional create-only writes and verify actual object identity,
size and checksum; do not silently accept unrecorded temporary components.

Concurrent developer probes must use separate logical editor sessions and
request IDs. Do not repeat global latest-debugger pause/resume exercises while
setting up independently paused developer runs: mesh/control qualification is a
separate case. Before submitting synthetic paused work, retain its scoped resume
capability privately on its exact owner, never in diagnostic exports or command
arguments. On a harness failure, finish only that original input request and
resume it; do not resubmit or silently abort it. A successful maintenance case
verifies each session completed once, an accepted export survived owner
replacement, and imported member contents match the original hashes.

Journal namespace roots before Helm/helper creation, preserve actual immutable
UIDs and historical identities, and capture controller children through their
recorded parent UID. A creation acknowledgement, resource label or name prefix
alone is not cleanup authority. List the complete namespace at closure; unknown
roots or changed UIDs block namespace deletion. Record namespace-controller
defaults at bootstrap and remove only the new operator's exact cluster RBAC.
An uncertain write is inspected, not blindly replayed. For failed retirements,
match pod UID, process incarnation and operation ID against durable intent:
observe an existing drain without reissuing it, and refuse to repeat an
unconfirmed begin/withdraw command.

Export terminal evidence only after the actual operator containers and external
observer have stopped and accepted work has drained. A report file, supervisor
PID or stale completion marker alone is insufficient. Keep original failed
reports immutable; if a report header is wrong, add a hash-linked identity
correction backed by the actual namespace/workload observations rather than
overwriting it or rerunning only to obtain a cleaner receipt. Provider evidence
and cleanup verification remain separate from local functional results.
If a terminal object-store upload fails, failed/aborted cleanup may recover the
settlement receipt from the exact durable journal UID after verifying the actual
operator and observer stopped. This does not recover or manufacture a passing
qualification; all original case and observer evidence is still required.

An unmanaged test-runner Pod can be preempted by GKE system components during
cold node startup. A replacement is setup recovery, not a repeated qualification,
ONLY when the original UID is confirmed absent beyond its grace interval, the
durable work journal is empty, no release resources or bootstrap-completion/
baseline/seed/observer receipts exist, and cluster/DNS startup has settled. Retain
the original failed UID and preemption evidence. Once any qualification work or
observation starts, never use this path to obtain a clean second window. Lifecycle
helpers must select exactly one active recorded incarnation, ignoring verified
retired history but rejecting ambiguous or foreign entries. Keep the same packet,
release, namespace and original expiry; do not automatically replace a lost runner.

A preparation failure before any application release or observation window is
not a failed application-availability test, but it still leaves provider
qualification incomplete. Preserve its terminal report and stop/clean the same
environment; do not quietly replace it with a passing retry. Namespace closure
must include GKE Dataplane V2 CiliumEndpoint records: these use a non-controller
owner reference to the exact Pod UID. Record that real relationship explicitly
instead of inventing a controller flag or adopting a label match. Include managed
fields when checking legacy Endpoints provenance. Diagnostic SHA-256 comparisons
must normalize hexadecimal casing without changing identity comparisons for
resource names, UIDs or ownership. Re-review cleanup-only corrections against
the stopped, hash-bound terminal export; they must not admit new test work or
reset the original clock.

Metadata watchers must obtain typed lists through the raw Kubernetes API, not
the formatted `kubectl get ... -o json` aggregate: kubectl can return a generic
`List` with an empty list cursor. Validate the expected list type/API group and
retain its opaque `resourceVersion` as text, including values beyond JavaScript's
safe-integer range. Raw typed-list items may omit their individual kind and API
version; supply these only from the exact requested collection and reject foreign
namespaces or mismatched provided types. URL-encode the unchanged cursor on
reconnect, persist identities before advancing it, and refuse missing/expired
cursors rather than silently relisting and losing historical ownership evidence.

### Offline runner preparation before another paid window

The local follow-up is recorded under
`artifacts/runtime-runner-preflight-20261021/preparation-result.json`; it is
**local preparation, not GCP qualification**. The original GCP attempt and its
failed terminal export remain unchanged and closed. Do not reuse its operation
identity, namespace, approval clock, bucket or cleanup inventory.

Before another paid operation, reproduce the old preparation failure against a
real local Kubernetes API, then exercise the corrected raw-list/watch path with
namespace-scoped credentials, actual Job/Deployment children, a server-timeout
reconnect for each watched collection, durable identity writes, UID-fenced
settlement, terminal export and exact namespace cleanup. Keep existing local
workloads protected by their recorded UIDs. In this check the old failure was
reproduced and cleaned up in 15.9 seconds; the corrected path passed in 82.9
seconds, including cleanup, with two connections each for Pods, Jobs and
ReplicaSets. This small synthetic test does not exercise application upgrade,
GKE scheduling, public routing or production policy timers.

Deployment roots are journaled but are not part of the Pod/Job/ReplicaSet watch.
Prove their removal using the UID-fenced delete and durable journal rather than
waiting for a Deployment event on an unwatched collection. Preserve failed local
attempts separately; never relabel a test-assertion or environment failure as a
passing uninterrupted observation window.

Restore the exact hash-bound runtime/helper packet on its pinned Linux image
without networking or credentials. The final packet's restore passed in 18.9
seconds and its container was verified absent. Check the boot ConfigMap's entire
pre-download module dependency closure against the restored helper manifest:
new relative imports must be mounted before the entry point starts, not merely
present inside an archive that the entry point has not downloaded yet. The
offline renderer checks all four boot modules and rejects missing or changed
bytes. Ten focused preparation/stream regressions passed; the actual transfer
client was also exercised separately against a local Postman simulation with
synthetic credentials. Those checks are not provider or full web-UI acceptance.

Avoid transferring the original source archive a second time when the verified
compiled runtime already contains the frozen Git source/tree. Retain the
original source-archive SHA-256 as provenance and verify it matches the runtime;
probe/download the runtime object itself. The prepared payload is 1,277,460,771
bytes instead of 1,786,044,847: 508,584,076 bytes (28.5%) are omitted without
changing application images, chart, source, limits or qualification assertions.
Conditional create-only uploads, actual object generation/size/checksum checks
and uncertain-write inspection remain mandatory. The slim dispatch artifact is
an offline, deliberately blocked review template, not permission to execute the
closed operation or a fully admitted future operator.

For a future separately approved operation, finish identity rebinding and review
locally before billable activation. Start the independent cluster/SQL creation
operations, stage the frozen payload while they provision where admission and
ownership permit, then dispatch exactly once after identity/readiness checks.
Keep inventory writers serialized; cloud operations may progress independently
but must not race ledger writers. This overlap is a planned orchestration step,
not measured cloud speedup. Do not rebuild images, install packages, discover
basic bootstrap bugs or redesign the harness inside the paid test window. Keep
all required scale-up, safe drain/scale-down, mixed-version, browser-continuity,
maintenance and failure-settlement assertions and real stabilization timers.
Provisioning, provider propagation and cleanup duration remain variable; the
local measurements do not guarantee a 60–90-minute GCP run.

The subsequent fresh-operation draft (before its later explicit approval) is
`artifacts/gcp-runtime-ha-20261021-b7f9e2c/`, with its final offline review in
`offline-review-final.json`. Its inventory is empty, every creation/test gate is
closed, approval is false and all activation/deadline fields are null. Do not
inherit the closed operation's certificate, payload-upload consent, observer
window, resource IDs or expiry automation admission. The previous operation's
inventory is now an additional protected inventory, never a resource pool.

This draft implements the transfer/provisioning overlap locally: the existing
conditional SDK uploader is in `stage-operator-payload.ps1` and requires only the
exact newly created bucket, not a ready cluster/namespace. It persists a unique
stage intent while holding the inventory lock. A partial/uncertain stage is not
replayed. `prepare-operator.ps1` performs no upload: it checks the accepted stage,
all exact object generations/metagenerations, sizes and MD5s before recording a
one-time launch intent or adding the new operator's bucket grants. It still
requires the exact ready cluster and namespace. Both entry points reject missing
explicit consent for the new bucket/prefix before credentials or cloud access.
The SDK transport itself was not rewritten. The actual new staged-object
verifier was run over local HTTP for success, changed generation and HTTP503;
an uncertain intent was rejected before HTTP. Owner-mock discovery was skipped
because no Postman login was used; the local fixture models the existing GCS
metadata contract, not a new provider proof.

Fresh-bound private regressions passed58/58; seven additional binding, split,
approval and range checks passed. A fresh real local Kubernetes watch/ownership
smoke passed in85.7s, including UID cleanup and preservation of the protected
fixture. The final helper packet restored without networking in31.5s. The initial
draft's ranges overlapped a protected default subnet; the old packet/restore
were retained, and only its local operation-config was corrected to unused
ranges and re-frozen. The exact watch/ownership module hashes match the smoke
receipt; component evidence is not presented as one uninterrupted provider run.

Read-only staging review found seven networks using a limit of seven, with no
clusters, SQL instances, buckets, VMs or disks. Other reviewed quota headroom,
the pinned Stable GKE version and corrected range non-overlap passed. A new
network needs an explicitly approved limit7->8 increase; never delete/reuse held
networks to bypass this. The historical6->7 write helper is disabled. Fresh
budget/window, payload upload, temporary certificate/terms and rebinding of the
existing expiry-only safeguard needed approval before paid activation.
Capture a new capacity observation after any approved quota change and select it
by validated filename/hash; retain the older blocked observation unchanged.

The user subsequently approved that exact isolated operation. Its paid clock
started at2026-10-21T19:41:43.905425Z; admission ends22hours later and the absolute
window ends24hours later. The historical NETWORKS preference was updated once
and independently observed at8; preserve it during cleanup. The existing
expiry-only heartbeat is bound to the new operation, not any closed inventory.
The new cluster and private SQL instance became ready while the frozen runtime
payload was being staged. This is setup progress, not provider qualification:
tests remain blocked until actual identity, bootstrap, trusted regional HTTPS,
temporary challenge cleanup and source/image/chart admission all pass. Consult
the operation's current preflight/inventory and terminal receipts, not this
historical checkpoint, for its eventual result.

A new-node kubelet log read may briefly return `No agent available` even after
the bootstrap Job is Complete. Re-read only the exact Job/Pod status and logs;
do not repeat SQL or namespace creation. If resuming cleanup after a successful
read, bind the completed Job UID, namespace UID and actual SQL creation identity
and use only the unchanged reviewed post-Job tail with a one-time dispatch
receipt. This setup interruption is not an application or recovery-test result.

Explicit human cancellation is distinct from expiry. Do not weaken the
expiry-only helper's deadline guard: use a separately recorded cancellation that
verifies the exact operator Pod/namespace UID, process start ticks and script
hash before cooperative stop. Actual descendant/work settlement and sanitized
`aborted` export are still required before exact-inventory teardown. An operator
exit alone is not proof that application Pods or accepted work have stopped.
Accepting production downtime does not manufacture runtime provider evidence.

### Explicit operation-scoped maintenance exception

The historical receipts below describe the private adoption procedure. New
operations use the supported [`--maintenance-plan` contract](deployment-operations.md)
with exact operator-values/manifest binding, frozen backup verification and
same-layout validation for already-HA releases. Do not reuse the old launcher
string-transform overlays. This implementation does not retroactively qualify
that installation or authorize another deployment.

An operator may not turn an aborted rehearsal into runtimeControl or
runtimeAutoscaling evidence. If the human separately approves a direct offline
maintenance cutover, keep that decision outside the promoted release manifest.
The private2026-10-22 operation records qualification as `waived`, not `passed`.
It uses an opt-in deployment-tool overlay pinned to the exact original launcher
SHA256; the frozen application checkout, chart and image digests remain intact.
At that operation, the normal published launcher and qualification workflow were unchanged.

This exception is limited to one exact installed/target source+manifest pair,
production context and namespace UID, reviewed compact singleton topology and
autoscaler policy. It requires explicit downtime/interruption acceptance, refuses
data-loss acceptance and any schema change (both sides must remain16), validates
a fresh local SQL restore/object-coverage receipt and its recovery bytes, and
retains the existing CAS maintenance ownership/stopped-reader procedure. It does
not authorize raw Helm mutation, automatic image/database rollback, a changed
target, or production use of unrelated data. Ordinary rolling predecessor checks
remain mandatory outside the private exception; the offline source pair is bound
separately because all old readers stop before installation. No mixed-version or
zero-downtime claim can be made from that operation.

Private settings and backups may contain sensitive information. Obtain explicit
approval for the local export; keep them out of chat, Git, uploads and CI logs.
Never restore the shared production database as a whole to repair Rivet.

For an offline cutover, take the final Rivet-scoped recovery snapshot after the
CAS owner has stopped every release writer, but before installing validation
code. Bind that snapshot to the same journal token, waiver hash and namespace
UID; a failed snapshot must leave admission closed and prevent installation.
An uncertain snapshot intent is inspected, never blindly replayed. Recovery
after a lost installation acknowledgement must require the exact unfinished
journal token and waiver, even if the exact candidate is already installed.
The temporary non-HA validation phase must also override the compact edge profile
to `regional` while its GKE HA-only requirement is disabled. Render both temporary
and final values locally; final-value lint alone cannot catch that combination.
This does not change the final compact edge or permit traffic during validation.
After cutover, the execution autoscaler can legitimately replace the completed
shared ownership journal with an autoscaling journal. Retain the qualification
decision in the durable deployment receipt; do not infer it from a later lease.
Provider node consolidation may evict the singleton developer backend even after
a healthy seven-pod observation. Report that editor-availability tradeoff honestly
and distinguish it from the independent replicated production execution tier.

The2026-10-22 private maintenance adoption completed at2026-10-21T21:11:34Z
(UTC): pinned source `a5153202380749298f46b64c7a3a4f0f58fffc6e`, Helm47,
schema16, seven Ready pods (backend1/web1/execution2/proxy2/autoscaler1), execution
range2-7 and proxyHPA2-4. Scoped backup/restore, saved-reference/key/PVC checks,
public pages, transient arithmetic and repeated browser/Remote Debugger acceptance
passed. Eight neighbouring controllers and the public edge remained unchanged
at acceptance; continuous unrelated-app availability was not instrumented.
The canceled staging operation's billables were removed; only its recorded
non-billable VPC/private-range hold remains. Provider runtime qualification is
still explicitly waived: these acceptance receipts are not a stress, arbitrary
burst, mixed-version or zero-downtime certificate and must not be promoted as one.
Aggregate existing-node capacity is only a placement feasibility check, not
provider qualification or a guarantee that GKE needs no new node. Reusing the
same PVC without resizing does not require another persistent data disk.

The capacity promise is finite: measure offered, admitted, completed, rejected
and failed work, latency, scale-up delay and resource peaks at the reviewed
replica ceiling. Automatic scaling does not promise instantaneous acceptance of
arbitrary bursts. Keep full policy timers in provider qualification, and do not
change resource limits or claim full node-ephemeral coverage from only cgroup
memory and mounted-volume measurements.

### Rebinding an older provider runner to a new release

An old successful local runner packet is reference material, not a reusable
provider admission. Prepare a fresh operation without copying approval clocks,
inventories, private settings or historical completion receipts. Freeze the
actual predecessor/candidate manifests, source tree, chart, immutable images
and a metadata-only projection of the installation's current controller policy
and resource requests. Preserve the original operation files unchanged.

Check the adapter contracts as well as the release IDs:

- Current rollout/topology entry points require `createDeploymentSafety` with
  explicit `rehearsal` scope and a live exact-namespace/cluster baseline check.
  Never remove the permanent safety requirement to keep an older runner working.
- Bootstrap the predecessor using its own declared schema version. The candidate
  phase must exercise the real forward migration; creating the candidate schema
  first cannot prove the predecessor-to-candidate migration boundary.
- Fixture uploads, folder creation/conversion and bundle imports must supply
  the current guarded structural admission and exact namespace/destination
  identities, with the existing explicit-intent headers. Do not weaken routes
  or silently retry a fixture write when updating the test client.
- Cooperative autoscaling requires protocol-2 evidence, including real capacity
  growth under both an active updater lease and a deliberately paused updater.
  A safe pause is before issuing retirement: retain the exact owner/token, let
  the actual updater lease expire, demonstrate growth without shrink, settle
  accepted finite work and recover through that same token. Never fake lease
  timestamps, substitute another journal or declare these checks from unit tests.

Test the new helper dependency closure and exact source in Linux before cloud
activation. A code-only source packet should contain one shallow commit, no
remotes, credentials or unrelated Git history. Build locally, then verify the
frozen runtime/helper packet without network access on the pinned operator
image. A browser-launch smoke is preparation, not full application acceptance.
Keep failed local attempts separate from corrected results.

The current local preparation is recorded in
`artifacts/gcp-runtime-ha-20261028-06d3157/`. Budget/temporary-certificate,
code-only-upload and replacement expiry-monitor approvals are recorded there;
they do not authorize production writes or constitute provider qualification.
The candidate checkout remains frozen; this developer note is maintained in the
primary develop checkout. Consult the new operation's preflight, not old status
paragraphs above, for actual admission and first billable activation. A missing
cleanup monitor must not be treated as a valid old safeguard: obtain approval
for a replacement and verify its exact operation binding before activation.

Before admitting that new provider operation, verify the actual final helper
packet—not just a draft—with network-disabled Linux restore/import/browser
checks. Keep a separate real PostgreSQL/object-storage predecessor-to-candidate
migration probe and a real local Kubernetes watch/UID/namespace-closure probe.
Remove only their recorded local container/cluster/network identities, preserving
all pre-existing local applications. A failed setup remains failed evidence;
record a corrected attempt separately instead of rewriting the old result.

Capture a fresh protected staging baseline, existing account/key metadata and
regional quota/version/range observations. Range proposals must be checked
against all subnet secondary ranges and private-service reservations, not just
the previous operation's chosen CIDRs. Freeze cloud provisioning, admission,
terminal export and exact cleanup helpers before opening creation gates. Leave
the paid clock null until the first new billable dispatch. Local checks and a
successful main build never substitute for the actual provider cases.

Terminal cleanup must also confirm any operation-owned temporary certificate
container is stopped or absent with matching identity/removal receipts. A
terminal application operator alone does not prove that local certificate work
settled. Keep host-only cleanup corrections revisioned separately from an
unchanged, already verified runtime packet; never silently replace frozen hashes.

Before protected admission, a runner-only correction may resume the same paid
environment only with explicit approval, exact process shutdown and actual
application-writer settlement. Preserve the previous boot, journal, receipts and
failed preparation result. Use a distinct journal and create-only receipt prefix
for the replacement; transfer only verified resource identities, not active
retirement or completion markers. Bind host terminal export to the current
operator/journal incarnation so prior settlement cannot authorize later cleanup.
Keep the original budget clock, source, images and certificate identity. Test
every scheduled case label through the real object-key validator: report labels
such as `proxyHpa` need a canonical lowercase transport key, not a weaker path
validator. A stopped preparation attempt is not provider qualification.

Cold-start Gateway setup must finish before seed or protected observation:
GKE can report `LoadBalancerNegWithoutHealthCheck` as a true readiness gate
before the NEG is attached to a health-checked backend. Pod Ready is therefore
not the strict frontend admission used by this qualification. Keep the existing
positive `LoadBalancerNegReady`, placement and identity validator unchanged.
The operation-local host preparation may refresh a stale pre-test proxy only
when its exact Deployment/ReplicaSet ancestry is recorded, all six proxies are
stable and an independently positively healthy peer remains in the affected
zone. Use one UID/resourceVersion-bound policy/v1 eviction at a time, honor the
PDB and normal termination grace, and wait for a stable positive replacement.
Never patch readiness status or admit HTTPS/seed/protected traffic early. An
unknown acknowledgement or PDB refusal stops writes; no eviction is replayed.
Retain pre-test repair diagnostics separately from protected availability
evidence. Terminal export must also verify the exact host preparation process
has actually exited, rather than trust a finished file alone.
Launch the independent observer with its explicit frozen source-root path as
well as PATH/SystemRoot, while excluding SDK/Kubernetes credentials. Test the
actual sanitized child-process import, not only an import in the parent's
already configured environment. Bind its precise process identity to the
reviewed script SHA as well as the PID, start time and script path.
When the peer's Pod condition is itself stale, peer health must instead come
from fresh Compute `getHealth` data tied to the exact recorded Gateway backend
ID, current Service UID/NEG annotation, zone, Pod IP and serving port. A name,
Ready bit or old health observation is insufficient. This is pre-test refresh
eligibility only: the unchanged final validator still requires positive NEG
health on every current proxy before seed or protected observation starts.
Transient management-connection failures may retry bounded read-only GETs;
never retry an eviction. After the exact original host process has exited, an
acknowledged eviction can resume by independently verifying the old UID is gone
and current, positively healthy replacements belong to the exact recorded
Deployment/ReplicaSet and immutable proxy image. If GKE simultaneously
consolidates a node, retain the full observed replacement-UID set rather than
invent one-to-one attribution. Never retarget a replacement; an original target
already absent may be skipped only with durable UID deletion history. Preserve
the checkpoint and original preparation
deadline; an ambiguous or unacknowledged write blocks this recovery. Include
every host-preparation incarnation in terminal process-settlement verification.
A local preparation-admission timeout stops further evictions, not physical
settlement of evictions already acknowledged. Preserve that failed result.
Verification-only recovery may observe their completion and record fresh strict
readiness without replaying any write, resetting a deadline, reusing an observer
window or claiming that the earlier preparation passed. It must confirm all
original targeted UIDs absent, pinned predecessor images, every application Pod
Ready and the unchanged strict regional frontend validator before admission.

The public staging dummy-OAuth fixture also requires the deployment-owned
development-auth capability and a narrowly verified client-network policy.
Saving `provider: dummy` or `dummyAllowNonLocalhost: true` does not grant that
capability. The current operation's third preparation reached its successful
seed and access-policy writes, then received 403 on the login GET because its
own values explicitly disabled development auth. This is a fixture admission
failure, not evidence of broken external-provider OAuth. Preserve the accepted
seed; do not repeat upload, publication or the smoke workflow to recover it.
Enabling dummy impersonation requires explicit staging-only approval, verified
test-client allowlists and local checks before another hash-bound operator may
start. Never enable it in production, open it to all networks, weaken the
application guard or merge failed preparation into a protected test window.

The approved scoped auth repair now uses two verified public `/32` test-client
addresses, not a wildcard or private-subnet allowance. It reuses the accepted
OAuth settings and access update. Recovery checks the original project ID,
draft/publication revisions, endpoint, app slug/access policy and exact catalog
artifact key through reads before creating a fresh login session; it never
repeats project upload, publication or the seed workflow. The independent host
also checks its server-verified client address before starting observation.
If either egress address changes, admission fails rather than widening access.
Keep the old failed result, exact seed object-generation metadata and all prior
operator identities. A naturally absent terminal Pod can be recorded absent
after verifying the prior terminal/settlement receipts and current namespace;
never issue a name-only delete to recreate it. A new operator must pass fresh
strict regional readiness; old positive frontend evidence cannot be reused.

Local evidence for this repair is recorded separately: 74 operation regressions,
the final network-disabled Linux packet's eight focused tests and 20 real
application OAuth tests, and real HTTP recovery simulation with zero modifying
requests. SQL in that simulation is a stand-in; actual provider catalog reads,
public TLS/cookies and browser acceptance remain separate live gates. No such
local result is GKE qualification, permission to replay writes, or a production
deployment approval.

Regional Gateway client provenance has a separate deployment boundary:
`RIVET_TRUST_INCOMING_FORWARDED_HEADERS` controls forwarded host/protocol; it
does not trust client-IP forwarding. Configure `RIVET_TRUSTED_FORWARDING_PROXIES`
with the verified operation-owned proxy-only subnet and exact forwarding-rule
IP, while keeping `RIVET_DEVELOPMENT_AUTH_CLIENTS` restricted to the actual
public test clients. Google appends both client and frontend IPs to
[`X-Forwarded-For`](https://docs.cloud.google.com/load-balancing/docs/https#x-forwarded-for_header).
Omitting the frontend hop can resolve the wrong address even after trusting
the transport peer. Never solve a failed provenance check by allowing the
proxy subnet to impersonate users. The frozen real-NGINX regression verifies
nearest-untrusted-hop selection, spoof rejection, full proxy templates,
executor WebSockets and revocation; the provider still checks its actual
resolved public client before admitting OAuth or observation.

For raw Cloud Quotas REST calls, explicitly send the staging project in
`x-goog-user-project`; a native SDK environment variable does not route a
separate HTTP client's quota. Keep explicit rejections distinct from uncertain
acknowledgements. The approved global CPU32-to64 preference was subsequently
verified through its exact identity and effective Compute limit, without
inventing the failed creation acknowledgement. Preserve that non-billable
preference on cleanup, along with the historical network/SSD preferences;
never increase test replicas or reset the budget clock to use new headroom.

Keep accepted Helm-intent finalization on the metadata-only transport after a
cooperative stop. Stopping test admission must reject a new Helm batch without
blocking inspection of a batch already dispatched. If that inspection did not
finish, verify actual process/writer shutdown, retain the original uncertain
archive, and reconcile only its exact intent IDs against immutable identities
and Helm ownership. CAS only the operation journal; never rerun Helm to learn
whether it succeeded or replace that journal with an empty one. A separate
reconciled receipt must preserve the original record hash. The final auth-repair
packet includes this teardown regression on real Linux (11 focused tests),
20 application OAuth guard tests and 75 operation regressions. These remain
local preparation evidence, not a completed protected provider window.

Pre-test proxy refresh should request Compute backend health only when an
affected zone lacks a positively NEG-ready peer. A stale Service NEG-zone
annotation must not block the already-supported positive-peer path. Keep the
authoritative-health fallback's identity checks and the final strict regional
validator unchanged. Preserve a failed read-only preparation receipt, verify
its precise process has stopped, and retain its original admission deadline
when correcting that read dependency; do not replay an eviction or reset time.

After host admission, the isolated runner must use the existing bounded
`waitForGkeFrontendAvailability` before seed recovery. A prior successful
snapshot does not guarantee that GKE will not begin node consolidation between
the host and operator reads. The waiter only repeats observations, retains all
positive-NEG/placement checks and operation-identity guards, and remains bounded
by the deployment timeout and original operation expiry. A timeout still fails
preparation and settles accepted work; it never starts or repeats a protected
window. Keep pre-test readiness failures separate from OAuth or application
failures. The fifth preparation stopped at this boundary before recovering the
seed, authenticating OAuth or starting the observer; its actual drained-owner
and supervisor receipts must remain in history.

A separately approved readiness-repair resume uses a new hash-bound operator
incarnation and its own journal/receipt prefix. Extend the closed identity
allowlists for that exact incarnation, including failure settlement and expiry
cleanup, before dispatch. Prove the prior operator's containers and all API
writers stopped, preserve its complete journal, and carry forward resource
identities only—not old processes, completion markers or test admission. Restore
the new packet without networking on the unchanged pinned Linux image, including
the actual strict-wait regression, application OAuth guards and headless browser.
The existing synthetic seed is recovered by identity/revision checks and reads;
never repeat its upload, publication, settings or access writes. The allowance
and first-activation deadline remain the original operation's values.

For the approved pre-test refresh, a Service's NEG `zones` annotation may lag
actual backend membership after node consolidation. When positive Pod peers
are unavailable, bind the existing backend groups to the Gateway inventory's
exact NEG self-links, immutable IDs and Service UID, then read those identities
again and verify the operation network/subnet before using backend `getHealth`.
Do not adopt a new/recreated group or treat the annotation alone as ownership.
The local real-HTTP regression rejects changed IDs and unavailable metadata;
normal UID/resourceVersion/PDB eviction and final positive Pod NEG health remain
mandatory. This host-only preparation correction does not change the running
operator packet or qualify a protected observation window.

The independent public observer needs distinct credentials for distinct public
surfaces: UI/OAuth cookies do not replace the workflow endpoint's Bearer API key.
Keep any key in memory/private stdin only, never environment, arguments, receipts
or diagnostic logs. A failed warm-up remains a failed observer window even when
protected cases were not admitted. Preserve it, verify the exact observer process
exited, and cooperatively stop only the waiting producer before normal accepted
work drains. Do not restart that observer or combine windows to obtain a pass.

The sixth staging preparation demonstrated seed recovery and dummy OAuth, but
its first observer workflow request lacked the separate Bearer header and was
rejected401; its web-app request succeeded. This is a runner authentication
failure, not completed availability qualification. The local transport repair
is kept separate from the failed observer's original bytes: synthetic real-HTTP
checks reproduce401 and verify credential-scoped success and continued rejection.
No real key is transferred and no replacement provider window is admitted by
those local tests. A subsequent provider window requires an explicit reviewed
decision; keep the original failed window immutable and never merge samples.

If all application pods stopped but the producer could not commit its final
settlement receipt, retain that failed report. Use the reviewed host-side failed
settlement recovery only after verifying the exact producer/observer processes
exited and the original namespace/cluster/journal identities. Keep the recovered
receipt separate and link it to that original operator UID; it can establish
failed-run cleanup eligibility, never a passing qualification. Close test
admission while awaiting a new explicit decision, preserving its earlier receipt
and the failed window's original source bytes.

After explicit human approval of the observer-auth repair and a fresh window,
use a separate operator/journal/object prefix and `host-observe-r7` receipts.
Pass the existing staging workflow Bearer key only through private stdin; it
must not enter process arguments, environment, receipts or logs. Scope that
header to `/workflows/`; web-app traffic retains only its UI/OAuth cookies.
The observer uses the locally verified transport without a simulation override.
Retain the failed sixth window's archived source/hash/process evidence, reject
reuse of its window ID, and never add its samples to the new report. While
waiting for admission, an already-terminal observer must fail the producer
promptly rather than leave it waiting for an admission that cannot arrive.
This approval changes neither production nor the first activation/deadline.

If the completed operator Pod has subsequently disappeared, its absence is not
a terminal exit receipt and cannot qualify a release. A failed-only exporter may
combine a fresh exact-namespace Pod observation with the current incarnation's
complete UID-bound durable settlement, matching immutable producer/supervisor
reports, stopped observer/helper processes and zero application controllers.
Retain the distinction: report the Pod as absent and its actual phase/container
exit fields as unavailable, not fabricated `Failed`/exit1 Kubernetes status.
Any replacement, mismatched journal, partial settlement or remaining writer
blocks cleanup. Preserve the original failed availability window unchanged.

Final cleanup verification includes recorded billable operator Pods, not only
cloud resources. Once the exact original cluster is freshly absent and its
recorded deletion operation is `DONE` without error, verify each Pod's recorded
UID, operation/project owner and original namespace lifetime against the removed
namespace UID. Parent deletion proves containment is gone; a cleanup timestamp
alone does not. This is not evidence of an individual Pod's exit status and must
not rewrite its billable classification or qualify a failed test window.

Verify the preserved billing association with an authenticated read-only
`projects/{project}/billingInfo` GET. Do not enable an API, link/unlink billing or
add a consumer-project override merely to complete cleanup verification. Keep
provider-blocked private peering/range/VPC holds explicit and non-billable; an
absence receipt must distinguish them from verified removed paid resources.

The `20261028-06d3157` staging operation ended with failed availability
qualification, followed by verified zero-billable cleanup. Its non-billable
private-network/range holds remain provider-blocked and must not be forcefully
removed. The subsequent production schema17-to18 upgrade used the explicitly
approved supported maintenance waiver, not that failed window as HA evidence.
Native deployment, autoscaler activation, actual headless application acceptance
and independent saved-catalog/storage/secret/neighbour checks passed. The
initial-claim CAS repair used for that deployment was operation-specific, not a
published permanent fix. The subsequent local permanent correction is described
in [fresh maintenance ownership claim](deployment-operations.md#fresh-maintenance-ownership-claim).
Its local regressions do not qualify a release or change the running deployment;
retain the original rejected-CAS and scoped-repair evidence as historical facts.
