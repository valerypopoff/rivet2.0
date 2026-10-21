# Runtime HA qualification publication

The compact singleton layout and drain-aware autoscaler need separate exact-image
provider evidence in addition to ordinary replicated-HA qualification. Local
functional tests are not a GKE certificate.

## Release order

1. Freeze a reviewed main candidate and let its normal **Build Images** run finish
   successfully. Retain its candidate/promoted manifests, exact predecessor and
   image digests. Do not install this unqualified candidate in production yet.
2. Complete local and separately approved isolated GKE verification against those
   exact images/chart/policy: regional/compact transfer and reversal, mixed-image
   compact upgrade, cold runtime independence, browser OAuth/actions, maintenance
   peaks/recovery, real metrics/RBAC, accepted-work drain, restart and node headroom.
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
6. Pin that qualified manifest. Install it at the existing replicated layout
   through normal HA first. Then perform regional13->10 ownership transfer,
   compact10->6 rollout, and separate autoscaler6->7 enablement, accepting each.

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

Control must cover both regional and compact profiles. Failed, local, incomplete,
uncleaned, mismatched source/images/chart/policy or different-operation inputs
are rejected. No copied unit-test checklist can establish provider qualification.

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

An operator may not turn an aborted rehearsal into runtimeControl or
runtimeAutoscaling evidence. If the human separately approves a direct offline
maintenance cutover, keep that decision outside the promoted release manifest.
The private2026-10-22 operation records qualification as `waived`, not `passed`.
It uses an opt-in deployment-tool overlay pinned to the exact original launcher
SHA256; the frozen application checkout, chart and image digests remain intact.
The normal published launcher and qualification workflow are unchanged.

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
