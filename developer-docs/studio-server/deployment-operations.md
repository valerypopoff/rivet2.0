# Deployment operation contracts

The deployment command is `deploy/studio-server/scripts/deploy-kubernetes-release.mjs`.
It never automatically starts a provider rehearsal or deploys after tests. An
operator must explicitly select the context, release and namespace and confirm
the release name. The clean tracked checkout, exact promoted manifest source,
chart fingerprint, immutable images and schema controls remain mandatory.

## Schema 17 folder-parent repair

Schema 17 fixes managed folder moves and transactionally repairs inconsistent
folder parents from validated canonical paths. The move function's exact verified
body changes, so the release contract's minimum rollback-compatible schema is 17.
Older schema-16 images cannot verify/restart after this migration. Do not widen
their compatibility window or use automatic image rollback to bypass this gate.
The Kubernetes release gate reads the exact predecessor image and schema version
from the candidate's release lineage. If that version is below the rollback
floor, it records the predecessor as incompatible instead of demanding a
successful old-image verification. This does not certify rollback or prove the
maintenance cutover in a provider environment. Compatible predecessors still
must pass the old-image verification; missing or invalid predecessor metadata
fails configuration rather than silently assuming incompatibility.
The gate's JavaScript configuration and its adjacent TypeScript declaration
must both describe the predecessor schema version. Run `yarn studio-server:build`
as well as the focused release-gate tests: the test runner alone does not
type-check that declaration.
When the predecessor is below that floor, the HA gate tests the candidate
against itself and records bootstrap evidence, not a mixed-version certificate.
That evidence cannot authorize a rolling upgrade from the old installation;
the maintenance cutover remains necessary.
Parallel release qualification keeps upgrade and both recovery windows separate;
promotion requires their exact-run evidence assembly as described in
[GitHub Actions performance](ci-performance.md#parallel-ha-image-qualification).
Schema 17 also adds immutable internal folder identities and the
bounded namespace-mutation receipt table. Its DDL runs before parent repair to
avoid altering a table with pending deferred trigger events. These are internal
authoring fields, not changes to project or portable bundle formats; see the
[namespace mutation contract](project-bundles.md#namespace-mutation-contract-unreleased-schema-17).

Adopting this version from schema 16 requires the supported maintenance upgrade:
record the exact installation/release identities, take and verify the ordinary
recovery backup, settle existing work under the approved interruption policy,
then let the single migration owner apply the forward migration before candidate
serving workloads start. If path validation fails, the transaction rolls back
without repairing or replacing anything; investigate the reported topology before
retrying. Do not delete ambiguous folders or recreate missing parents automatically.
Existing backups remain recovery evidence, not permission to overwrite production.

For a blocked path preflight, use this read-only query against the verified Rivet
database to identify the rows requiring review. It mirrors the migration's path
checks; the stored parent is diagnostic only and is never the source of repair.

```sql
WITH paths AS (
  SELECT relative_path, parent_relative_path,
    CASE WHEN position('/' in relative_path) = 0 THEN ''
      ELSE regexp_replace(relative_path, '/[^/]+$', '') END AS expected_parent
  FROM workflow_folders
)
SELECT paths.* FROM paths
LEFT JOIN workflow_folders parent ON parent.relative_path = paths.expected_parent
WHERE paths.relative_path = ''
  OR paths.relative_path ~ '(^/|/$|//|(^|/)[.]{1,2}(/|$)|[[:cntrl:]])'
  OR strpos(paths.relative_path, chr(92)) > 0
  OR (paths.expected_parent <> '' AND parent.relative_path IS NULL)
ORDER BY paths.relative_path;
```

The regression gate proves fresh install and 16-to-17 repair on a disposable local
PostgreSQL database, including preservation of unrelated shared-database tables.
It does not authorize a production migration, GCP change or deployment.

`--timeout` accepts positive whole seconds, minutes or hours (for example `15m`).
Conversion and validation happen before input files or manifests are read. Zero,
malformed or oversized durations are rejected; milliseconds must fit Node's
2,147,483,647 ms timer limit. Backup and shutdown helpers enforce the same limit
for direct callers, before spawning or creating recovery files, so timer overflow
cannot turn a long deadline into an immediate backup termination.
This is a timeout for individual Helm/wait/adapter phases, not a wall-clock cap
for the complete upgrade. Long accepted work may extend the operation; reaching
a deadline preserves that work and reports the exact recovery operation.

## Recovering an inherited execution startup fence

`repair-execution-startup-fence.mjs` is a deliberately narrow **operator** tool,
not a release command, automatic deployment step or authorization to mutate a
live installation. Use separate approval for production apply. Never replace
the running controller image or erase its unfinished journal to bypass release
and policy binding.

The eligible legacy shape is phase `fencing`, an exact live target UID and serving
incarnation with no retirement already active, a template naming that target,
and a pod annotation naming a different ordinal of the same StatefulSet. An
expired controller lease is required for apply; a valid lease is never stolen.
Namespace UID, autoscaler Deployment UID/image/config, manifest, policy, workload,
pod and operation identities are rechecked. Unknown/divergent state fails closed.
The operator also rechecks matching execution-peer UIDs and status-only process
responses: at least two Ready serving peers are required, and a conflicting
retirement or changing peer blocks the repair.
Peer verification runs under the acquired lease immediately before a metadata
write; the lease is checked after all potentially slow inspection and renewed
by CAS before PATCH. Confirmation-only journal writes do not repeat the full
peer scan. A slow inspection that outlives the lease fails closed.
Plan expiry is also rechecked after initial installation inspection, before
acquiring a journal lease; inspection cannot turn expired approval into a write.

First create a private, read-only plan (15-minute validity):

```powershell
node deploy/studio-server/scripts/repair-execution-startup-fence.mjs --context <exact-context> --namespace <namespace> --namespace-uid <verified-uid> --release <release> --controller <exact-autoscaler-deployment> --output <private-plan.json>
```

An optional `--kubeconfig <path>` uses an existing configuration; the tool never
switches the current context. Verify the printed plan digest and private plan
against the installation and obtain approval before running:

```powershell
node deploy/studio-server/scripts/repair-execution-startup-fence.mjs --context <same-context> --apply <private-plan.json> --confirm <sha256:printed-plan-digest> --output <new-private-receipt.json>
```

Both files use exclusive creation and mode 0600; use an OS-private directory on
Windows as well. Do not upload, commit or print plans: they include operation
identity. Apply acquires the existing journal by CAS, writes an additive
`fenceRepair` intent, and changes only the exact pod annotation using UID and
resourceVersion checks. Other annotations, token, phase, original image and
policy remain intact. The transport refuses template patching, scaling,
deletion and any exec except the read-only retirement-status command. A lost
reply is observed under the same plan/intent; it does not authorize another
retirement or removal. Foreign/uncertain journal writes retain fencing rather
than being overwritten during cleanup. A fresh output path is required on each
invocation. If an attempt loses its receipt, preserve all files, inspect the
existing intent and lease, and reuse the exact unexpired plan only after its
identity checks pass. Never clear the journal to retry.

If that plan expired while an intent remains, rerun the same **read-only** plan
command into a fresh private file. This is an explicit renewal, not an automatic
extension: the new 15-minute plan names the previous intent digest in `supersedes`
and requires fresh approval of its own digest. Target, operation token, policy
and original annotation must still match. Apply CAS-replaces only that exact
intent digest, retains any confirmed metadata and records `previousPlanDigest`;
keep older private plans as the historical chain. A changed or missing intent
cannot be adopted by a renewal. Already observed metadata is never rewritten.
Apply rejects installation overrides; its identity comes exclusively from the
approved plan (plus the explicitly matching context).

If recovery and lease release both fail, the error retains both causes; release
failure does not hide the original failure or permit overwriting uncertain state.

`metadata-confirmed` means the annotations/generation were observed, **not**
that retirement or scale-down finished. The original controller resumes its
normal routing withdrawal and accepted-work/recording drain after lease release.
Observe its journal and logs until completion, check readiness and the retained
claim/storage identities, and let demand determine replica count. Long or paused
runs may legitimately prevent return to the minimum. Do not force that return.
If the old operation advanced, another identity appeared, or the plan expired,
inspect before preparing a new action; the helper has no broad fallback.

After the original operation settles, use the normal corrected-image release
path with backup, exact release evidence and application acceptance. The code
repair and a passing local test suite are not a GKE certificate or a new staging
waiver. This procedure does not enable backend overlap or change DB capacity.

## Rolling versus maintenance

Ordinary rolling upgrades retain exact installed-predecessor qualification.
`release-manifest:production` is a publication pointer, **not a record of what a
particular cluster has installed**. Publishing B and then C does not qualify an
installation of A for an A-to-C rolling upgrade. Obtain that exact qualification,
or explicitly approve the maintenance path below. Do not rewrite lineage or
attach another source's proof to a manifest.

During a rolling operation, the owned journal serializes replica changes. Fresh
execution slot/CPU and proxy CPU measurements must show adequate headroom before
template freeze and each retirement. Metrics/ownership failures are not zero
load. Surviving owners are checked again after routing withdrawal, immediately
before admission is fenced. A changing proxy Pod inventory invalidates the
sample rather than counting an unmeasured new owner as spare capacity.
Execution checks also reconfirm the entire Pod inventory and StatefulSet after
sequential process/CPU sampling. A previously sampled Pod that loses readiness,
changes UID or owner, or a changed replica count/startup fence invalidates the
observation. Metrics must still be fresh after this final confirmation.
With the execution controller enabled, the journal binds a `cooperativeScaling`
capability to the exact workload UID, image and policy. The controller stays
running and can increase replicas during a live or paused upgrade. It does not
claim or replace the deployment journal, retire pods, remove fences or scale
down. Both writers use UID/current-replica/resourceVersion preconditions, and
both changes are monotonic growth. The upgrader replaces only the original
execution ordinals and leaves surge/grown capacity for the controller to retire
after journal completion. Recovery accepts growth within the bound maximum,
while retaining the original replacement inventory. At the approved maximum,
retirement waits for sufficient measured capacity instead of exceeding the cap.
Cooperative execution requires an approved maximum of at least three owners.
Execution rollout inventory accepts the existing autoscaler ceiling of 100
owners, rather than rejecting a valid installation once growth exceeds 32.
Other owner tiers retain their 32-owner bound. This does not increase any
installation's configured maximum or waive provider/policy qualification, quota,
metrics, headroom or drain requirements.
The installed version is checked again under upgrade ownership after preparation.
A failed, untouched preflight is closed as aborted before any template command,
releasing ordinary scaling. A controller with this protocol can also CAS-close
an expired untouched preflight for its exact installed image/manifest; it never
abandons a templates/owners phase or a retirement. Initial adoption from an older
controller needs that controller replaced before this automatic recovery exists.

Proxy HPA also remains active with `scaleDown.selectPolicy=Disabled` during the
roll. Final values must restore its ordinary downscale policy. Developer tiers
remain fixed. Non-controller execution profiles retain the earlier frozen
execution policy.
Missing metrics still block capacity decisions; quotas, provisioning delay and
the approved maximum still limit burst handling. See [autoscaling](runtime-autoscaling.md).

An unchanged HA StatefulSet whose original owners are all current-revision,
current-image, Ready and serving no longer needs a temporary surge. Same-image
configuration changes still require replacement. Recovery never skips a surge
whose earlier scale or retirement may have committed.

## Installation policy and one deployment workflow

### Mandatory shared safety boundary

`lib/deployment-safety.mjs` is the single preparation/identity boundary for the
production command. The workflow creates its immutable contract only after
verified preparation; rolling, maintenance and topology strategies and their
Kubernetes adapters require that contract before their first cluster read.
An omitted object, a plain object with similar methods, a contract for another
mode, namespace or candidate, or a receipt from another preparation attempt is
rejected. Critical baseline/checkpoint hooks no longer have no-op defaults in
these production strategies.

The contract owns installation/policy/input binding, verified online recovery,
quiesced-checkpoint readiness, journal recovery identity and the owned baseline
check. Strategies keep the rules that genuinely differ: rolling retirement and
surge, maintenance quiescence/validation, and same-image storage-owner transfer.
Their existing CAS journal formats remain in place; the shared operation runner
owns lease heartbeats and checkpoint serialization. The safety contract checks
the runner/lease before invoking a baseline or recovery-capture operation.
Topology settlement stays under that lease too. Unlike an image upgrade, a
same-image ownership transfer intentionally leaves execution Pods on their
original revision (the template's control-mode setting can change). Its journal
pins the exact execution controller UID, replica count, source revision and all
original Pod UIDs. Settlement permits only those retained execution owners,
still Ready with candidate images, while requiring all replaced developer and
frontend owners to be current. A new execution UID/revision or changed capacity
blocks completion. Ordinary rolling/maintenance settlement has no such exception.
Verification-only can reuse that completed topology journal's retention binding
only for the exact namespace UID, candidate, original policy and input digest.
It still checks the recorded controller/Pod UIDs and revision; it does not create
a fresh allowance for old runtime revisions. This lets post-transfer acceptance
be retried without replacing runtime owners or reapplying Helm.
Maintenance cannot install templates until its owned quiesced capture verifies.
Every production strategy must return a fresh successful settlement receipt for
the same release/namespace before completing its journal; an omitted/no-op
settlement callback cannot silently mark the operation complete.
The shared contract also requires that callback at admission, before any
strategy/adapter cluster access; a missing callback must not be discovered only
after workloads have changed. Non-production fixture scopes retain their
explicit optional settlement behavior.
The online paths cannot acquire a prepared production contract without their
verified recovery report. Scope/mode and installation binding are recorded in
`deploymentSafety` in the existing journal; recovery must reproduce them exactly.
Completed historical journals can be replaced normally. An unfinished journal
from older tools must be recovered with its original tool/input version first;
it is never silently upgraded to a new safety contract.

Local tests, isolated rehearsals and first installation use explicitly named
non-production scopes, not fabricated production backup assertions. There is
no production CLI flag to select these scopes for an existing installation.
Release discovery uses `helm list --all` so a pending/uninstalling release is
not mistaken for a new installation. Legacy non-HA/direct installs retain
Helm's native release locking; they do not gain the HA strategies' CAS retirement
protocol or a zero-downtime claim. The same prepared backup/baseline contract
still gates their apply command. Verification-only mode cannot apply templates.
Direct and journaled paths use the same Helm upgrade argument builder, including
the migration-aware rule that only an explicit forward rollback is atomic.

### Shared operation lifecycle

`lib/deployment-operation.mjs` runs the journal lifecycle for rolling upgrades,
maintenance cutovers and same-image control-topology transfers. Strategies keep
their admission/inventory validation, rollout phases and failure policy; they do
not implement separate heartbeat queues or lease-release code.

The runner writes fresh ownership with the original token/protocol fields,
claims an explicitly validated expired recovery lease, serializes every phase
checkpoint with heartbeats, and fences further writes after an expired lease or
unconfirmed CAS. A checkpoint cannot replace the operation token or safety
binding. A lost initial ownership response reports its exact token and never
starts workload changes. There is no automatic write retry.

Completion stops new heartbeats and awaits any in-flight replacement before
writing `phase=complete`. Failure cleanup likewise waits for that queue. Failed
heartbeats fence cleanup as well as normal workload mutations. Only an exact,
still-owned **committed completion** can reconcile a lost completion response
within the same invocation; an older phase or changed identity cannot clear a
failed write. Maintenance never closes traffic after an acknowledged final
apply merely because completion observation failed. Other uncertain phases
remain for explicit recovery. Failure handlers retain both the original error
and a cleanup error rather than replacing the recovery reason.
The CLI applies the same rule to diagnostic export: a failed diagnostics write
cannot replace the original deployment failure, its recovery instructions or its
operation receipt. Both errors remain available; incomplete diagnostics do not
authorize replaying an uncertain command.

Lease release is a final best-effort, resourceVersion-bound write that leaves the
saved phase unchanged. An uncertain release is not retried blindly. No journal
schema migration is needed: HA/topology still use `protocol=1`, maintenance uses
`formatVersion=1`, and existing operation tokens, phases, inventory and policy
bindings remain authoritative. Strategies still validate recovered configuration
and never replay an uncertain migration/template command.

The continuous execution-autoscaler controller is not a deployment mode. Its
existing cooperative-growth and shared-journal exclusion rules are unchanged.
Maintenance takes its initial CAS version from the strategy's most recent
journal inspection, not the earlier release-preparation snapshot. An idle
autoscaler can legitimately update a completed journal during application
baseline checks. That completed foreign-kind record remains eligible only
after its identity/phase/lease checks pass; its current resourceVersion is
retained even though the maintenance strategy sees no unfinished cutover.
A newly busy autoscaler still blocks admission. A race after inspection still
fails CAS and is never automatically retried or treated as successful ownership.
The maintenance strategy may wait up to 30 seconds, using GET-only inspection,
for a completed autoscaler's sampling lease to be released. Every observation is
validated; an unfinished scaling/retirement operation still rejects admission.
Lease timeout never permits takeover. The approval deadline is checked again
before ownership, and there is no retry of a modifying request.
Legacy direct Helm installs also retain their existing native locking; this
runner does not invent a journal protocol or HA guarantees for that path.

Existing production installations now require `--deployment-policy <private.json>`.
This is an installation configuration, reviewed once and reused; changing its
bytes or values requires a new operation. It contains no blanket permission to
restore data or choose arbitrary production workflows. Local single-machine
and offline render paths retain their existing behavior.

Do not reuse `ha.rolloutResourceVersions` from saved Helm values as operator
configuration: those are transient CAS guards from a particular rollout. Fresh
deployments (including offline dry-runs) reject nonempty operator-supplied guards
before any cluster access. Remove them while preparing new reviewed inputs and
approval, not after admission. Read-only planning/acceptance and explicit-token
recovery preserve their original bytes; never edit a pending operation's bound
values to get past a conflict. A legacy paused operation may require a separately
approved, exact-UID/lease-bound refresh of its transient guards. This does not
authorize deleting guards blindly or replaying an uncertain Helm update.

HPA settlement supports clusters where `HPAGeneration` is not enabled: metadata
generation, status observed-generation and condition observed-generation can be
absent. Supplied epochs are validated and compared when available; exact HPA
UID/target/policy and `AbleToScale`/`ScalingActive` conditions remain mandatory.
An omitted optional epoch is not permission to ignore an unhealthy autoscaler.

```json
{
  "formatVersion": 1,
  "release": "rivet",
  "namespace": "rivet",
  "context": "explicit-reviewed-context",
  "namespaceUid": "exact-live-namespace-uid",
  "backup": { "script": "artifacts/<installation>/backup.mjs", "sha256": "sha256:<reviewed-script-digest>" },
  "acceptance": { "script": "artifacts/<installation>/acceptance.mjs", "sha256": "sha256:<reviewed-script-digest>" }
}
```

The ordered workflow is:

1. Check live installation identity and the installed-to-candidate version route.
2. Complete installed-state and local-readiness preflight, then run the approved
   application baseline (`stage=before`).
3. For ordinary rolling upgrades, capture and verify a fresh online recovery
   checkpoint. Every maintenance cutover takes a frozen checkpoint after
   quiescence instead; explicit maintenance plans retain their additional
   approval binding. Neither path restores production automatically.
4. Apply the owned upgrade, settle workloads and confirm controller activation.
5. Run approved application acceptance (`stage=after`), then report completion.

Adapters use the same bounded private Node process/request/receipt mechanism as
the frozen checkpoint. Every policy-adapter request/receipt binds requestId,
stage, operationId, release, namespace, context, namespaceUid,
installed/candidate manifest digests, valuesDigest and
operationPlanDigest (the policy checksum). Helpers/dependencies must be reviewed
and pinned too. There is no automatic retry of a workflow or uncertain write.

The backup adapter performs scoped **read-only production capture**, isolated
restore verification, object-version coverage and key recovery. Its receipt uses
`kind=rivet-recovery-checkpoint`, `consistency=online` and a valid local ISO
`capturedAt` between request start and verification, plus the four assertions and
four distinct checksummed artifacts described below. It must actually retain
recoverable bytes/versions; a bucket listing or unchecked dump is insufficient.
For a cutover the policy adapter receives `consistency=quiesced`, its actual
cutover journal token/phase/live lease, and returns
`kind=rivet-frozen-recovery-checkpoint` with the same recovery assertions and
binding. It cannot run as a frozen checkpoint before all writers stop.
The explicit maintenance-plan adapter uses this same receipt verifier, including
exact release/namespace/context, consistency and a capture timestamp within the
current request window. Its request now explicitly declares `quiesced`; adapters
must echo those fields and provide `capturedAt`, rather than relying on a missing
consistency/timestamp being accepted. Wrong-installation, stale, missing or
future-dated captures never produce `verified.json`. Keep the reviewed private
adapter checksum in sync when updating an older adapter to this contract.

The acceptance adapter must exercise installation-approved, side-effect-free
fixtures: a workflow, a web app (including its expected assets/auth journey), and
Remote Debugger. It returns `formatVersion=1`, `kind=rivet-deployment-acceptance`,
`passed=true` and `checks.workflow`, `checks.webApp`, `checks.remoteDebugger`.
Each check needs `passed=true`, `observed=true`, and an `evidence` path to a
nonempty private file in its attempt directory. Actual assertions belong in the
reviewed adapter; a successful HTTP health probe alone is not these journeys.
The adapter owns credentials and approved fixture IDs; never place them in chat,
tracked policy examples or public logs. This code does not select customer
projects or install production fixtures implicitly.

`deployment-result.json` distinguishes preparation failure, incomplete deployment,
completed infrastructure with failed application acceptance, unconfirmed result
acknowledgement, and complete verified deployment. Application failure after
infrastructure completion leaves traffic/scaling active and never invokes image
or data rollback. Inspect the private receipt and repair the actual problem.
Autoscaler activation is a separate post-settlement verification phase: a failed
observation records `infrastructure-complete-activation-unverified`, not
`deployment-incomplete`. It never re-enters workload replacement. Use the
verification-only path below after resolving the actual observation/controller
problem. A lost final success-file acknowledgement records
`infrastructure-complete-evidence-unconfirmed` when possible and exits nonzero;
even if the disk also prevents that receipt, the error preserves the original
verification cause and states that infrastructure is already applied. Do not
repeat an upgrade merely because saving its result failed.
Its additive `outcome` fields independently describe infrastructure
(`not-started`, `in-progress`, `unconfirmed`, `applied`, `checking-existing`,
`verification-incomplete`, `existing-verified` or `not-changed`), autoscaling (`not-verified`,
`verified`, `not-configured` or `unconfirmed`) and application acceptance
(`not-verified`, `passed`, `failed` or `not-configured`). The completed strategy
journal's token/phase is included as `operation`, not mistaken for application
acceptance. `phase=complete` in the journal only completes the owned workload
procedure; final command success still requires the post-release checks.
On failure the runner supplies the last acknowledged token/phase, acknowledgement
certainty and whether it durably aborted before workload changes. The command
preserves that receipt through its error wrapper. A confirmed untouched abort is
reported as `deployment-aborted` / infrastructure `not-changed`, not an unfinished
deployment. An uncertain completion write never becomes a successful report just
because the API might have committed it; the receipt marks its acknowledgement
unconfirmed and requires inspection/recovery. This keeps result reporting tied to
the journal lifecycle instead of independently guessing from a thrown message.
Preparation/deployment failures likewise preserve their original cause if
writing the failure report fails. The resulting aggregate retains both errors
and keeps the original message visible to the command-line operator; a report
IO failure never replaces the actual recovery reason.
`--acceptance-only` reruns settlement/controller/application verification for the
exact already-installed candidate without Helm, Secret preparation or migration;
it requires the policy and no unfinished operation. Approved fixture requests
still execute, so this is not a generic read-only production diagnostic.
During its baseline/settlement observation the result state is `verifying`, not
`deploying`. Failure there records `verification-incomplete` and explicitly says
no release changes were made: fix the observation/storage/access issue and retry
`--acceptance-only`. It must not report `deployment-incomplete`, request a new
backup, rerun pre-deployment application checks or imply templates need replay.

Recovery requires the original policy/values and journal workflow identity. It
reuses the recorded successful baseline checks, since a partially replaced
developer UI may be unavailable, takes a fresh recovery checkpoint and runs new
post-upgrade acceptance. A changed policy cannot silently redefine success.
Only an explicit matching recovery token can select that path; an absent journal
or two absent optional tokens are never a resumed operation. The original
installed-manifest digest remains bound in the workflow identity even after
Helm has advanced to the candidate during a partially completed upgrade.
The maintenance path rechecks the baseline under ownership before closing
admission. If that check fails on a fresh attempt, it records an aborted no-op
and releases ownership without touching workloads or HPAs. If it fails during
recovery, it preserves the unfinished journal for inspection without applying
cleanup to potentially newer traffic. Only an attempt that reached quiescence
may use the usual close-admission failure handler, and only until its final
apply has been acknowledged. Confirmed final-apply verification failures leave
traffic running; see the explicit recovery path below.
Losing the acknowledgement for an untouched abort does not permit fallback
traffic closure either: inspect the exact journal before any new operation.
The separate same-image control-topology transfer carries this same workflow
binding through its Kubernetes adapter and journal, including reverse transfer.
It rechecks the installed baseline after acquiring ownership, before any edge
patch or developer withdrawal. A fresh attempt that fails before any durable
mutation intent is closed as an aborted no-op; a recovered or uncertain attempt
keeps its original journal. Recovery cannot omit or replace its recorded policy,
values or operation identity, and never replays an uncertain template update.
The shared final-baseline check also rereads the policy-bound namespace UID and
rejects a terminating namespace. Matching names and a matching release version
do not authorize a same-name replacement namespace after a long preparation or
backup. This check runs before deployment mutations and again under HA,
maintenance or topology ownership; local paths without a policy retain their
existing version-only check.

## Planning from the installed version

### Mandatory non-disruptive preflight

Every fresh production upgrade with an installation policy performs this before
application baseline requests, recovery capture, journal ownership or maintenance:

- Require exactly one deployed Helm release and the policy-bound namespace UID.
- Read Helm's **installed** manifest and inspect its real controllers, pods and
  HPAs (not the not-yet-running candidate). Observation is bounded to 30 seconds.
- Refuse remaining execution startup fences; report the owning operation for
  separate inspection rather than automatically repairing it.
- Syntax-check the exact checksum-pinned local adapters. Source-quoting Node
  diagnostics go only to `adapter-syntax-private.log`, never ordinary output.
- Invoke the actual recovery adapter with `stage=preflight`, bounded to 60 seconds.
  For an explicit maintenance plan this is that plan's backup adapter. Verify its
  installation/input-bound prerequisite receipt, then reread the live baseline.

The reviewed adapter must implement the new preflight stage. It must inspect
local prerequisites without capturing/restoring production data or changing the
cluster: imports and runtimes, required executables, locally available helper
images, supported invocation paths (file URLs on Windows), output accessibility,
and free space against a bounded database/object estimate and scratch-copy budget.
It must not pull images, start maintenance or perform application journeys in
this stage. Small private scratch files for local checks/evidence are allowed.
This remains a reviewed adapter contract, not a sandbox for arbitrary scripts.

The receipt echoes the usual request identity, uses
`kind=rivet-deployment-preflight`, `passed=true`, and has
`checks.dependencies` and `checks.capacity`, each with `observed=true`,
`passed=true`, and an `evidence` path to a nonempty private file in that attempt
directory. Unknown/partial receipts fail closed. Existing installation adapters
must be updated and their policy checksums reviewed **before a new operation**;
do not change an unfinished operation's bound scripts/policy to adopt this stage.
Exact recovery skips fresh preparation and retains its original policy.

#### Implementing and preparing the private adapter

`lib/deployment-adapter-preflight.mjs` provides the reusable local implementation
of this contract. A reviewed private adapter calls `runDeploymentAdapterPreflight`
for `stage=preflight`, and keeps actual recovery capture in a separate branch.
Its requirements bind the installation and installed baseline, a nonempty
checksummed dependency inventory, cached PostgreSQL image ID, explicit tool
paths and positive database/object/copy/reserve capacity bounds. Capacity uses
integer byte arithmetic and checks the actual output filesystem, including a
small exclusive scratch-write/readback test. It never relaxes a capture bound
merely because the machine has more free space.

The fixed local checks are Helm version, **client-only** kubectl version, SQL
proxy version, tar version, cached-image inspection and a reviewed operator
probe. They do not pull images, start containers, authenticate to a cluster,
read production keys or invoke backup/restore. Failures do not produce a passed
receipt. Run this utility only inside the shared bounded adapter supervisor:
the outer 60-second timeout owns whole-tree shutdown. Do not add nested timeouts
that terminate just a probe parent and orphan its browser/SDK descendants.

`deployment-adapter-local-probe.mjs` is the Windows installation probe. Its
configuration is private and checksum-pinned. It verifies the exact clean
installed-schema helper checkout, PostgreSQL and schema imports, an actual
native esbuild transform, local Cloud SDK version, and DPAPI round-trip using
**synthetic bytes**, not a production key. It uses file URLs for imports. A
reviewed explicit esbuild binary is supplied to both this probe and the actual
capture helpers, preventing a successful probe in one dependency tree from
hiding a missing optional binary in the helper's tree.

The probe discovers the real acceptance test through
`yarn studio-server:ui:observe --config <reviewed-config> --list`, then launches
headless Chromium against static local content with offline context and a
closed proxy. Direct Node networking is blocked during imports. The reviewed
acceptance test must additionally refuse execution when
`RIVET_LOCAL_DEPLOYMENT_PREFLIGHT=1`; collection must not accidentally turn into
live acceptance if runner arguments drift. These are local prerequisite tests,
not a whole-UI or provider availability certificate.

Preserve completed deployment packets. Create a new ignored private kit, seal
new dependency/configuration/adapter hashes, and use a new policy. On Windows,
restrict the whole kit to the operator, SYSTEM and Administrators; POSIX file
modes alone do not establish Windows privacy. Do not copy a sealed kit to a new
path and reuse hashes blindly: materialize the actual paths and re-review/reseal
the dependencies before operation admission. Pin the recovery container by
image ID, not an unchecked mutable tag. Keep production data and keys out of Git.

Before a maintenance window, use the reviewed adapter's **online** backup path
to qualify the complete capture/isolated-restore pipeline while production stays
up. This is separately authorized read-only production capture, not the local
preflight, and its elapsed time is outside downtime. It exposes real object
growth, archive-size limits, credentials and storage dependencies early. It
does not replace the fresh frozen checkpoint after quiescence. Keep generation
and checksum checks when reusing local object bytes or retained cloud versions;
do not speed up recovery by skipping validation or uploading production data.

The next operation still needs a fresh live installation/settings snapshot,
normal exact-source publication/CI, route planning and explicit deployment
approval. A local readiness pass has no maintenance waiver, expiry extension,
publication or deployment authority. Never treat a copied historical settings
template as a fresh capture. Acceptance should resolve the actual current Helm
authentication references rather than use stale settings from an older release.

Use the normal exact manifest/source, values and policy arguments plus
`--preflight-only` to run just these checks. Add the same maintenance selection
and original plan if that is the proposed route. It needs no `--confirm`, writes
`deployment-preflight.json` and private prerequisite/settlement evidence, and
does not claim a journal, apply Helm, prepare Secrets, run migrations, capture a
backup or execute acceptance fixtures. It cannot combine with resume tokens,
`--acceptance-only`, `--plan-only` or `--dry-run`.

This is not authorization, provider qualification, or a held lease. A subsequent
apply repeats it and still needs confirmation, backup, ownership and under-lease
baseline checks. A completed preflight does not promise future quotas/capacity
or eliminate a later infrastructure failure. The old offline dry-run and version
route planner retain their narrower purposes.

### Verification-only recovery after final cutover intent

Maintenance journals now retain the verified frozen checkpoint location and a
versioned `finalApply` checkpoint. Protocol 2 records intent before final Helm,
then records its real acknowledgement **before** inspecting inventory. It never
changes `acknowledged: false` into true because later reads look healthy.
Observed workload, HPA and PVC identities are recorded separately.
An uncertain final apply, observation disconnection or lost completion reply
never triggers automatic traffic closure, template replay or data
rollback. The journal remains incomplete unless completion actually committed.

After diagnosing the real failure, use all original source/manifest, policy,
values, installation and (if present) maintenance-plan inputs, with:

```text
--resume-cutover <exact-original-token> --verify-only --confirm <release>
```

This explicitly claims only an expired lease of the same unfinished `resuming`
cutover, with the original safety/workflow identity and a recorded final-apply
intent or legacy protocol-1 acknowledged inventory.
It rechecks:

1. Original frozen request/receipt identity and every retained backup artifact's
   checksum. It does not trust a `verified.json` marker or capture a new backup.
   Schema-changing waivers also reverify retained restored-copy migration proof,
   its exact candidate image/schema binding and verification artifact bytes.
2. Namespace and final workload/PVC UIDs, deployed Helm status, and the entire
   stored final Helm manifest against the exact candidate render (ignoring only
   hook objects, transient metadata resourceVersions and policy-bounded elastic
   replica counts).
   If post-Helm inventory was lost, match the complete approved controller/HPA
   name/kind set and the original PVC UIDs, freeze the observed current controller
   identities, then reconfirm them after settlement. Intentional controller/HPA
   recreation during maintenance is not compared to its obsolete pre-stop UID.
3. Fresh stable workload/HPA settlement, approved live environment/command,
   storage-mount and service-account settings, no startup fences, and unchanged
   installation/UIDs after observation. Same-image manual execution-setting
   changes do not disappear behind an unchanged stored Helm manifest.
   Kubernetes may omit a literal empty `EnvVar.value` that Helm renders as `""`;
   only that omission is equivalent. Nonempty values, `valueFrom` sources,
   environment ordering, arguments and commands still retain their checks.
4. Durable same-operation completion, then normal controller activation and
   approved application acceptance. Workload procedure completion is still not
   application acceptance.

Only journal claim/heartbeat/completion/release writes are allowed in this path;
there is no Helm apply, Secret update, migration, scale, deletion, backup capture
or workload exec. Approved after-acceptance fixtures still execute, so it is not
a generic read-only diagnostic. A failed check retains precise recovery guidance
and leaves existing workloads untouched. Recovery never steals a valid lease.

If final completion already committed, inspect it and use `--acceptance-only`
instead, without a maintenance plan or cutover flags. It checks the exact installed
candidate/schema and normal final acceptance without re-demanding qualification
that maintenance explicitly waived. It cannot apply a release or turn a waiver
into qualification evidence. Both recovery routes use the same checks for deployed
Helm status, stored candidate configuration, live execution settings and startup
fences before and after stable observation, then recheck namespace/release identity.
The final full inventory is checked with the same settlement inspector: readiness,
controller/pod identities, revisions, capacity and HPA policy must still match the
stable window's fingerprint. A pod that becomes unready or is replaced just after
that window invalidates completion, even if settings and images are unchanged.
Final reads must also remain within the bounded observation-gap allowance
(2.5–10 seconds). Slow management reads require fresh verification, never a Helm
replay or an automatic workload restart.
Acceptance-only verification cannot mark a failed Helm release or same-image
settings drift as successful merely because its application journey passes.
Helm may retain a higher historical replica count after a busy upgrade: only
explicitly autoscaled targets may differ, and their saved counts must be within
the candidate's unchanged bounds. This reuses settlement's capacity policy;
static developer capacity, HPA/controller policy and application settings stay exact.
If final-apply intent is absent, validation is still active, the installed
Helm release differs from the candidate, resources change during observation,
or retained bytes are unavailable, this path
refuses admission. Inspect the actual operation and use ordinary exact-token
recovery only when re-quiescence is appropriate; do not fabricate a marker or
edit a journal to force verification. Historical journals do not acquire this
capability merely because the deployment tool was updated. No automatic write
retry, image rollback, backup restore or skipped failed check is introduced.

### Regression evidence and its limits

Implementation ownership stays within `deploy/studio-server/scripts/`:

| Owner | Responsibility |
| --- | --- |
| `deploy-kubernetes-release.mjs` | Select the complete route and coordinate the shared final-configuration checks. |
| `lib/managed-release-cutover.mjs` | Own maintenance phases, final-apply intent/acknowledgement and exact-token recovery. |
| `lib/maintenance-deployment-plan.mjs` | Validate explicit approvals, frozen metadata/artifacts and restored-copy migration proof. |
| `lib/deployment-readiness.mjs` | Compare approved manifests, live execution settings and retained identities. |
| `lib/kubernetes-release-settlement.mjs` | Own replica bounds, stable health observation and its final freshness/identity check. |
| `lib/ha-scenario-evidence.mjs` | Assemble independent exact-run qualification observations; never turn a maintenance waiver into a certificate. |

New deployment modes should reuse these owners. Do not add another environment
normalizer, capacity parser, write-retry loop or operation-specific safety bypass.

The actual command stand-in tests use real Helm renders, optional-generation-free
GKE-shaped HPA responses, stale workload resourceVersion rejection, concurrent
autoscaler journal changes/sampling leases and final-observation connection loss.
They check failed prerequisites before mutations and verification recovery with
corrupted backup bytes, retained identities and no additional deployment writes.
The schema-changing waiver cases use an older installed schema and an exact
candidate without HA evidence. They cover missing migration approval, unavailable
restore prerequisites before downtime, failed restored-copy validation before live
DDL, lost final Helm replies, failed post-Helm inventory, verification-only
completion and subsequent acceptance-only checks. Intentional removal/recreation
of the autoscaler during validation is followed by a fresh completed controller
sample; the old Deployment UID is not reused as controller identity.
Acceptance-only regressions reject failed Helm status, changed stored/live
settings and startup fences before any after-acceptance fixture runs; bounded
historical HPA-grown capacity remains acceptable without workload mutations.
They also inject readiness loss and pod replacement between stable observation
and the final inventory read, requiring verification-only refusal without writes.
Migration-proof regressions reject redirected checkpoint directories and unknown
or mismatched receipt stages, including when both retained files were edited.
Unit suites retain interrupted/unknown apply, lease loss and lost-acknowledgement
coverage. The readiness suite runs in `studio-server:verify:kubernetes`.
Migration adapter receipts in command stand-ins are synthetic: they prove the
orchestration and refusal rules, not that a particular production backup/image
has been migration-tested. Each real schema-changing operation still requires
the reviewed adapter to produce actual restored-copy proof from its own frozen
checkpoint. Run the focused route cases with:

```powershell
yarn node --test deploy/studio-server/scripts/maintenance-deployment-plan.test.mjs deploy/studio-server/scripts/managed-release-cutover.test.mjs deploy/studio-server/scripts/deployment-readiness.test.mjs deploy/studio-server/scripts/deployment-command.test.mjs
yarn workspace @valerypopoff/rivet-studio-server-api run test:migration-managed
```

The existing PostgreSQL/MinIO integration separately verifies real scoped
restoration, writer fencing, deployment migration ownership, unrelated SQL/S3
preservation and supervised recovery using synthetic local data. Keep it distinct
from the command stand-in's synthetic migration receipts and from any operation's
required exact-image, frozen-checkpoint proof.
These are local simulated-control-plane results, not GKE/provider qualification
or permission for another deployment or paid rehearsal.

`--plan-only` reads the selected installation and writes `upgrade-plan.json`
without applying resources or running adapters; it needs no `--confirm`.
It is separate from offline `--dry-run`. The planner walks at most 16 promoted,
digest-verified predecessors using immutable `manifest-<digest>` registry tags.
The installed version, not the mutable publication pointer, selects the start.
Each edge must meet schema and, for HA, exact image/browser/topology evidence.
Corrupt or unavailable manifests never become a guessed route.
An unknown or invalid installed schema-reader version reports
`maintenance-required` before lineage traversal, including when the manifest
digest is already the candidate. An absent number is not evidence of reader
compatibility.
A matching candidate digest also cannot hide a different numeric schema version
in the installed Helm metadata: the planner reports `maintenance-required` and
asks for installation inspection, rather than claiming `already-installed`.
This is not authority to change the database or guess its actual schema.

A direct route proceeds through the workflow. If publishing advanced A -> B -> C
while the installation stayed at A, the plan identifies the qualified B, C hops
with exact source SHA/chart/images. Each hop must execute from its pinned clean
source/chart with recovery and acceptance checks; the command does not silently
switch checkouts or deploy B using C's chart. A multi-hop plan stops before
mutation with those concrete inputs. A missing exact pair is reported as
`qualification-required`; it does not become a maintenance waiver. No CI run,
provider rehearsal, publication or deployment is started by planning.

Scale-up during deployment adds provider requirements: autoscaling evidence v2
includes `upgrade-scale-up-only` and `paused-upgrade-scale-up` alongside the v1
checks. Historical v1 receipts remain readable but do not authorize the new
coordination. Local regression success is not v2 provider qualification.

## Explicit maintenance route, including forward schema changes

`--maintenance-cutover --maintenance-plan <private-plan.json>` admits a reviewed
interruption with qualification recorded as **waived**, not passed. It replaces
operation-local source-string transforms; do not patch the deployment program to
skip gates. This route requires an existing promoted installation, a fresh
frozen recovery checkpoint, and a bound
namespace UID. It cannot be combined with rollback, topology transfer,
single-machine mode or `--resume-ha`.
The combined route decision is exported as `deployment-route.json` before
application journeys, backup capture, journal acquisition or workload changes.
It binds the installed and target releases/schemas, maintenance approval and
qualification status; it never marks waived qualification as passed.

The plan is a regular file within this repository (normally ignored under the
operation's `artifacts/` directory). Its exact bytes are hashed into the shared
cutover journal. Example shape; placeholders are intentionally not valid approval:

```json
{
  "formatVersion": 1,
  "kind": "rivet-maintenance-deployment",
  "release": "rivet",
  "namespace": "rivet",
  "context": "explicit-reviewed-context",
  "namespaceUid": "exact-live-namespace-uid",
  "candidateManifestDigest": "sha256:<candidate-manifest-digest>",
  "installedManifestDigest": "sha256:<actually-installed-manifest-digest>",
  "installedManifestPath": "artifacts/<operation>/installed-manifest.json",
  "valuesDigest": "sha256:<exact-operator-values-or-env-file-bytes-digest>",
  "issuedAt": "<approval-time-ISO>",
  "expiresAt": "<admission-deadline-ISO-within-two-hours>",
  "accepts": { "interruption": true, "qualificationWaived": true, "dataLoss": false },
  "reason": "<operator-approved reason and interruption scope>",
  "backup": {
    "script": "artifacts/<operation>/reviewed-backup-adapter.mjs",
    "sha256": "sha256:<reviewed-adapter-bytes-digest>"
  },
  "schemaMigration": {
    "fromVersion": 16,
    "toVersion": 17,
    "script": "artifacts/<installation>/reviewed-migration-validation.mjs",
    "sha256": "sha256:<reviewed-migration-adapter-bytes-digest>"
  }
}
```

The installed manifest must itself be promoted and hash to the recorded live
Helm manifest digest. It need not be the immediate **published** predecessor;
the maintenance procedure stops old readers before starting the
candidate. It does not certify mixed-version compatibility or reverse-image
rollback. Other applications sharing a DB instance remain outside this release's
ownership and must be excluded from the recovery adapter's scope.
The plan also binds the operator values/environment file checksum. All release
modes read that input once and use a private frozen copy for rendering and Helm,
so editing a settings file during a long drain cannot redirect the later phase.

Omit `schemaMigration` for an unchanged schema. A forward schema change requires
this explicit extra approval: versions must match the exact baseline/candidate,
and the migration adapter's bytes must match the reviewed checksum. A downgrade,
unknown live schema, missing adapter or mismatched transition fails before
downtime. A two-stage/intermediate deployment cannot bypass these rules.

### Restored-copy migration validation

The installation's reusable migration adapter uses the same private
`--request/--receipt` protocol as backup adapters. It accepts two stages:

1. `migration-preflight`: before downtime, verify the pinned candidate API image
   and local restore environment are actually available. Return kind
   `rivet-maintenance-migration-preflight`, `passed`, `supportsSchemaMigration`,
   `candidateImageVerified`, `restoreEnvironmentReady` and `unrelatedDataExcluded`
   as true, with checksummed nonempty verification evidence. This stage must not
   start a production migration, capture production data or modify workloads.
2. `migration-validation`: after release readers stop and the fresh frozen
   checkpoint is verified, restore **that checkpoint** only into isolated local
   scratch storage, run the exact candidate image's migration, verify its target
   schema and saved-data preservation, and settle all children before returning.
   Never point the candidate migration at production during this stage.

Both requests include `schemaMigration` with `fromVersion`, `toVersion` and
`candidateApiImage` (repository plus immutable digest). The actual validation
also binds the checkpoint request ID, checkpoint receipt SHA-256 and local
checkpoint directory to the original token, plan and release identities.
`checkpointReceiptDigest` hashes the UTF-8 bytes of
`JSON.stringify(parsedCheckpointReceipt)`, not the receipt file's whitespace.
Echo these bindings, `formatVersion: 1`, a fresh `verifiedAt`, and an `artifacts`
inventory containing at least one `role: verification` file with its SHA-256.
The receipt must echo the exact request `stage` and `checkpointDirectory` as well;
retained validation must still name its own original frozen checkpoint directory.
Redirecting both request and receipt to another location cannot pass recovery.
The validation receipt kind is `rivet-maintenance-migration-validation`; require
all of `isolatedRestore`, `migrationApplied`, `targetSchemaVerified`,
`preservedDataVerified`, `oldDatabaseReadersStopped` and `unrelatedDataExcluded`
to be true. The reviewed adapter owns the actual restore/migration and any
installation-specific read-only checks for Rivet database consumers outside the
Helm release. An unclassified consumer blocks migration, not another app's data.

The tool verifies the bindings and bytes, rechecks that validation did not alter
the backup, and admits live migration only after this proof. A failed, timed-out
or uncertain adapter pauses the owned cutover without applying candidate DDL.
There is no automatic adapter retry, schema rollback or production backup restore.
The existing single migration owner and database restore/job fences still apply.
Downtime includes frozen capture and restored-copy migration validation; this
route deliberately makes no HA/zero-downtime claim. The adapter is reviewed once
per installation and consumes release identities from requests, not per-release
source-string patches.

The two-hour deadline limits **new admission**. It is rechecked immediately before
ownership acquisition, after inventory, so slow preflight reads do not admit an
expired plan. A validly started operation can finish later.
Explicit `--resume-cutover <token> --maintenance-plan <same-file>`
can recover an expired admission only when the live unfinished journal has that
exact token, candidate and plan digest. It cannot start another operation or
replace an approved plan with edited settings. Recovery re-quiesces and captures
a new checkpoint, including writes accepted during a partially completed resume.

`--dry-run` performs offline source/chart/render checks. It does not read the live
release, prove ownership/capacity, create a backup, or authorize a later run.

## Frozen recovery adapter

After the journal is owned, release autoscalers and admission stop, and all old
writers disappear, the command invokes the reviewed, hash-pinned `.mjs` adapter:

```text
node <adapter> --request <private-request.json> --receipt <private-receipt.json>
```

There is no shell interpolation, automatic retry, production restore, backup
upload or generic whole-database dump. The environment-specific adapter is
reviewed code, not an arbitrary operator command string. It must perform
read-only production capture and restore verification only in isolated local
scratch storage, settle its children, exclude unrelated tables/objects and keep
credentials in private local files. Hash-pin all helper dependencies it invokes
as part of that review; pinning the entry script alone cannot audit its imports.

Each invocation gets a new private directory and request ID. The request binds
release, namespace, context, namespace UID, cutover token, plan digest and both
manifest digests. The receipt must echo requestId, token, namespaceUid,
operationPlanDigest, installedManifestDigest and candidateManifestDigest, plus:

```json
{
  "formatVersion": 1,
  "kind": "rivet-frozen-recovery-checkpoint",
  "databaseRestoreVerified": true,
  "objectReferencesCovered": true,
  "encryptionKeysRecoverable": true,
  "unrelatedDataExcluded": true,
  "artifacts": [
    { "role": "database", "path": "rivet.dump", "sha256": "sha256:<digest>" },
    { "role": "objects", "path": "referenced-objects.archive", "sha256": "sha256:<digest>" },
    { "role": "keys", "path": "recovery-keys.private", "sha256": "sha256:<digest>" },
    { "role": "verification", "path": "local-restore-verification.json", "sha256": "sha256:<digest>" }
  ]
}
```

All artifact paths are unique regular files inside that checkpoint directory;
checksums are streamed, so large object archives are not loaded into memory.
The checkpoint directory's physical identity and repository containment are
rechecked after the adapter returns and before recording verified success;
replacing it with a symlink/junction or another directory invalidates the result.
Checkpoint request/receipt bytes must stay unchanged during verification. The
backup adapter may create its receipt, but may not rewrite its input request;
the migration adapter may create its own proof, but may not edit the frozen
parent metadata. Both proof paths compare persisted metadata to the bytes they
actually validated before returning success. A mismatch preserves partial files
and blocks `verified.json` and live installation rather than trusting a stale
in-memory object.
An object inventory alone is not recovery data: the reviewed adapter must ensure
the referenced object versions can actually be recovered. The deployment tool
verifies binding, inventory and bytes; the adapter's reviewed implementation is
responsible for the actual scoped restore/reference/key checks. A receipt is
not provider availability qualification.

Release-owned workload/HPA changes use freshly inspected immutable UID and
resourceVersion preconditions. Unknown reader controllers or active migration
Jobs block quiescence. An ordinary recovery may explicitly quiesce again; it
retains previous final-apply metadata as history before leaving `resuming`.

Failed/uncertain adapters block installation. Their logs stay in
`adapter-private.log`, not console output. Inspect them privately; never commit
or upload settings, keys or data. Preserve the original request/receipt and use
explicit journal recovery, not blind replay. POSIX modes are restrictive; on
Windows retain the existing private workspace ACLs as well.
An adapter timeout stops only its freshly spawned process tree (a private
process group on POSIX, exact PID tree on Windows). Shutdown confirmation has a
separate five-second bound and requires both parent closure and tree-stop
confirmation. Unconfirmed shutdown blocks installation and requires the operator
to settle those children before recovery. The reviewed adapter must still settle
any detached daemons or remote jobs itself; OS process-tree termination is not
proof about such work.

## Validation and honest completion

Already-HA maintenance retains controller kinds/names and PVC identities. Public
tiers remain at zero, schedulers/background claimers remain off, APIs deny
application requests and socket upgrades, but actual health/DB checks still run.
Readiness is not forced green. Validation probes use rendered container names
and ports; they must not assume that the execution container is named execution.
Fenced validation pods alone skip preStop sleep. Before reopening, these
OnDelete owners stop so none retain the maintenance environment. Legacy-to-HA
adoption keeps its existing temporary singleton path.
Final resume disables the migration hook already verified during validation;
it does not run the same migration Job a second time. The next release still
generates its own normal migration policy from its immutable manifest.

Both ordinary and maintenance releases export `release-settlement.json`:

Each observation attempt first overwrites any earlier receipt with a sanitized
in-progress, not-settled result. A failed first read or parse cannot leave an
older success looking current; an in-progress receipt after interruption is not
settlement evidence.

- Every intended workload observes its generation and has the candidate images.
- Deployment/ReplicaSet and StatefulSet revision/Pod UID owner chains agree.
- No old, unknown-owner, Pending, failed or terminating serving pods remain.
- Live desired replicas are satisfied. HPA/custom-controller growth within the
  rendered policy is valid; seven is a baseline, not a hard-coded success count.
- Live HPA target/range/metric/behavior policy matches the rendered policy and
  its scaling conditions are healthy; custom controller configuration matches.
- The observation remains settled for 30 seconds; owner/revision/count changes,
  backward clock movement or more than 10 seconds between complete inventories
  restart the default window. A slow read cannot count its blind interval as
  stability or report success after the deadline. Terminal migration-hook
  history is not a serving pod.

HPA comparisons normalize [Kubernetes API defaults](https://github.com/kubernetes/kubernetes/blob/v1.35.0/pkg/apis/autoscaling/v2/defaults.go),
not an assumed cluster-wide downscale window. Missing HPA observed-generation
status is supported on older clusters; a supplied stale generation is rejected.

The maintenance and normal HA journals do not complete until this gate passes.
After the journal is released, `execution-autoscaler-activation.json` separately
requires a fresh successful controller observation for the exact manifest/policy.
Its journal must be `complete` with a released lease. A fresh demand sample in
an unfinished fencing/draining/removal intent does not confirm activation, even
when its lease has expired. Legitimate in-progress scale-down is allowed to
finish; this observer does not interrupt or restart it. HA completion also
reconfirms each owner's UID, readiness and revision after reading its status.
Activation likewise replaces any prior success with an in-progress receipt
before its first journal read.
That observation cannot happen while deployment owns the shared journal. A
missing activation returns a nonzero command result with an explicit
"workloads settled, autoscaling not verified" outcome; it does not close healthy
traffic or pretend the earlier deployment failed to apply. No custom controller
means this additional check is skipped without a Kubernetes read.
Settlement failure after maintenance resume closes admission again while the
runner still owns its lease; post-journal activation failure does not. No force
deletion, schema rollback or backup restore is automatic.
Healthy observation is not proof of future provider availability. Live-data
acceptance should check recovery invariants and reference reachability, not exact
row-count equality after traffic has resumed: legitimate new writes are expected.

## Local regression coverage

`yarn studio-server:verify:kubernetes` registers plan/checkpoint, fenced validation,
settlement, capacity and existing ownership/recovery suites. Coverage includes
delayed/flapping routing withdrawal, restart/error observation resets, fresh
no-op versus old revision, insufficient/stale load, lost acknowledgements,
expired plans versus exact recovery, mismatched/changed backup artifacts,
premature Helm success, healthy scaled-up releases, stalled observations,
unfinished autoscaler intents, peer failure during route propagation, changing
Pod inventories, execution owners changing during sequential sampling, metric
expiry during final capacity confirmation and settlement failure.
These tests do not change GCP or replace an actual exact-image provider proof.
`deployment-operation.test.mjs` runs the same eight-case lifecycle matrix against
all three actual strategies: completion/protocol compatibility, uncertain initial
ownership and exact-token recovery, changed recovery binding, expired lease,
failed heartbeat, untouched abort, failed abort acknowledgement and lost
completion acknowledgement. Existing strategy tests retain mode-specific drain,
late-heartbeat, failed-resume and routing propagation coverage.

`deployment-command.test.mjs` additionally launches the **real deployment CLI**
in an isolated temporary clean Git repository containing the current sources
and chart. The fixture creates its ignored `artifacts` parent before allocating
a unique workspace; a fresh checkout must not depend on earlier local diagnostics or a
previous CI step. The missing-parent/concurrent-allocation regression starts
with an empty temporary checkout. Cleanup removes only the exact fixture child,
never the shared artifacts parent or another operation's diagnostics.
Git admission, immutable manifest validation, argument parsing,
private backup/acceptance adapter subprocesses and real Helm lint/render run
normally. A test-only Node preload maps exactly the selected Helm/kubectl
executables to strict local stand-in child processes; an empty kubeconfig
prevents accidental cluster access. Unknown operations fail rather than passing
through to a service. The stand-in maintains workload/Pod UIDs, resourceVersion
preconditions, retirement state and durable journals across CLI invocations.
StatefulSet reconciliation distinguishes normal `RollingUpdate` replacement
from HA's explicit `OnDelete` retirement instead of treating both as manual rolls.
Polling wall/monotonic clocks are simulated together to avoid real propagation
waits. The simulated wall-clock offset persists across interrupted command and
recovery/verification invocations, so a released lease cannot appear active
because the test clock restarted. This does not alter production timeouts or
prove GKE convergence.

These command tests cover pending-release discovery, failed-backup admission,
wrong-installation acceptance receipts before backup or mutation,
and interrupted rolling/maintenance/topology operations followed by exact-token
recovery. They assert that recovery retains the same policy/input/operation
identity, captures a fresh recovery checkpoint, does not repeat an acknowledged
baseline or an uncertain begin, and reaches post-upgrade acceptance. The
direct non-HA case checks the shared Helm flags and migration rollback policy.
A combined lost-template-acknowledgement and diagnostics-write failure checks
that the maintenance recovery token and truthful incomplete result survive. The
verification-only coverage also injects an unavailable management inventory,
checks the truthful failure state and absence of Helm/preparation replay, then
performs the successful acceptance-only retry. Application
journeys and backup bytes here are explicitly synthetic fixture evidence, not
production restore tests or provider qualification. Temporary fixture commits
are confined to the test repository; the user's branch is never committed.
