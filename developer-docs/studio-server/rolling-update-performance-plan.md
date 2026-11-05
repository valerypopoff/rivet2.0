# Faster ordinary staging and production updates

Status: **implemented and locally validated; not activated or provider-qualified** (2026-11-04).
The four larger optimizations below are implemented alongside the initial frontend
and worker overlap. The public source is included in the develop update; a separate
private production adapter copy remains local and excluded from Git. No image publication, workflow dispatch, persistent
staging application, production update or access change was performed.

## Measured baseline

The successful [Release Rivet 41793031762](https://github.com/valerypopoff/rivet2.0/actions/runs/41793031762)
reused Build Images 41788374693. Workflow wall time was about 100 minutes; its
ordinary-upgrade report covered 73m 53s and its instrumented HA portion 72m 2s.
These were first-adoption timings, not timings for an already-protected update.
The exported report and timing bytes match their recorded SHA256 hashes.

| Part of the successful staging HA update                                                  |                   Measured elapsed |
| ----------------------------------------------------------------------------------------- | ---------------------------------: |
| Establish first-adoption bridge                                                           |                            14m 39s |
| Apply templates and wait in Helm                                                          |                            10m 14s |
| Serial backend/execution replacement, between template acknowledgement and return handoff |                      About 29m 34s |
| Return handoff                                                                            |                             7m 50s |
| Final routing acknowledgement                                                             |                                 9s |
| Remove bridge                                                                             |                             8m 13s |
| Other inspection, settlement and journal work                                             | Remainder of the 72-minute HA span |

The owner interval includes routing withdrawal, accepted work, startup and
readiness, probe hooks, capacity checks and observations. It is not 29 minutes
of an unconditional sleep. The two original execution owners each accepted a
315-second background job. Three transport variants already run concurrently;
the first-adoption test has three successive five-minute cohorts.

Production phase observations from the completed operation show about 13m 29s
in templates, 20m 13s in owners, 7m 46s returning traffic, and 17m 38s removing
the bridge. Those are sampled phase spans, with observation/command latency,
not precise timers for an individual sleep. Preparation repairs and the later
verification-only recovery are not normal rollout-duration baselines.

## Implemented execution path

```text
Independent online checkpoint + baseline acceptance (join both)
                              |
Blocking compatible-schema hook; one acknowledged template apply
                              |
Exact templates + ready controller + protected serving floors
                              |
          +-------------------+---------------------+
          |                   |                     |
 Native web/proxy       Backend retirement     Ready candidate workers
 replacement            existing ownership     two separate pool slots
          |                   |                     |
          |                   +---------------------+
          |                         |
          |              Both old workers withdraw together
          |              propagation -> fence -> accepted work settles
          |              old pool -> zero; candidates become steady
          +-------------------------+
                              |
Full frontend/worker/GCP join; last mutation finished
                              |
Close new long-probe admission; keep short availability observation
Independent final journeys + accepted long responses finish (join all)
                              |
Recording/data proof; scoped cleanup; release ownership
```

There is one updater, one Helm writer and one release journal. Bounded independent
reads settle all started siblings even when one fails. Every write still checks
its lease and exact ownership. Unknown write acknowledgements require observation
or explicit recovery, never automatic replay. The existing 300-second requests,
315-second accepted background jobs, recordings and protected shutdown profile
remain required. Speed is not an additional pass/fail deadline.

### Retained staging application

`reusable-staging` settings can opt into `retainedApplication: {protocol: 2,
namespace: "rivet-staging-persistent", recordName: "rivet-staging-application"}`
with a fixed staging hostname and the focused suite. This retains the disposable
application namespace, database, object store, secrets, route and NEG. The first
use still installs them; subsequent tests reuse them only when their recorded and
actual installed manifest/images match the exact production predecessor.

The publication boundary must preserve application identity: staging records the
tested candidate, whereas production installs that build with added promotion/GKE
evidence and a different manifest digest. Reuse binds the prior closed operation
and original build, compares all immutable application fields and retains the
actual staging manifest for Helm and rollout-journal checks. A different image,
chart, schema, source, lineage or original build remains a reseed/recovery case.
Identical-image releases still render and journal the intended candidate identity.

A separate permanent ConfigMap owns application identity. Each test acquires it
by resourceVersion CAS, binds namespace/registry UIDs, and creates one unique
fixture folder. Cleanup joins producers, verifies accepted work has settled,
deletes only that folder with its namespace ID precondition, checks the candidate
installation/public route, and releases the application as healthy and idle.
This is logical data deletion; normal housekeeping handles historical blobs.
The operation receipt explicitly identifies retained resources, rather than
claiming their absence. The legacy disposable-namespace path is unchanged.

Repeat preparation uses UID/resourceVersion-bound server dry-run replacement for
existing controllers. A leftover migration hook is previewed under a disposable
dry-run name, matching Helm's recreate behavior without touching the live Job.
Fresh workloads still use dry-run creation. Optional private-image credentials
refresh from the exact pinned runner Secret into the identity-bound application
copy; unchanged credentials cause no write and app/database keys are retained.

The coordinator validates the report and compiles continuity/pool evidence before
passing `qualificationPassed` through either provider transport. Only an explicit
true decision allows retained fixture deletion and healthy release. A rejected
report, missing decision or janitor cleanup preserves data and quarantines, even
when the upgrade process itself acknowledged completion.

A failed/unknown test quarantines the application and preserves its data. The
independent janitor stops expired writers, settles accepted work and quarantines;
it never deletes this namespace or guesses which application writes to replay.
An attempt rejected before acquisition closes without touching another owner.
Staging ahead of production, incompatible schema, uncertain fixture creation or
quarantine needs explicit recovery/reseed before another attempt. There is no
automatic downgrade. Persistent application cost must be approved before activation.

Owners: `lib/retained-staging-{application,cleanup}.mjs`, staging state/janitor,
provider entry/gate and runtime qualification receipt validation.

### Unchanged proxy images

Build Images computes a conservative Git-object fingerprint of the proxy tree,
shared environment loader, Docker ignore file and build/reuse policies. It checks
ancestry using a blob-filtered history checkout, avoiding a download of historical
desktop/image files. A genuinely absent unpinned manifest builds normally; missing
explicit lineage and registry errors still fail before reuse. It then verifies
the exact promoted predecessor, ancestor source, pinned base and supported COPY
inputs. Unsupported recipes or changed/missing inputs build normally. Reuse is
currently limited to proxy; API/web/executor continue their existing builds.

Unchanged bytes keep their original digest and revision label. The current
candidate manifest records `imageOrigins.proxy` with original source SHA, input
digest and exact predecessor manifest digest. Normalization, semantic digest,
promotion and the local image rehearsal preserve/check it. Reused images are
still freshly scanned on every published architecture and exercised with the
candidate application set. A failed scan cannot silently authorize reuse. Change
the Dockerfile/base/package floors to rebuild when a dependency refresh is needed.
A changed Pod template still rolls even with an unchanged image.

The first build introducing this policy normally builds the proxy because its
predecessor lacks that policy input. Common later API/frontend-only edits can
reuse it. This avoids manufacturing a proxy rollout solely for a new repo SHA.

### Two-worker pool handoff

Opt in with `ha.executionPools.enabled=true`. The automatic `active` slot (`a`
or `b`) and `retiringReplicas` are updater-owned runtime state, not a manual
operator sequence. Two stable StatefulSets share the existing execution Service;
only the active pool has replicas after settlement. The original selector stays
immutable. The new slot has an additional pool selector; all Pods are checked
against exact controller UIDs. Owned Pods are never orphaned for adoption.

The fast procedure applies to a settled two-worker singleton installation with
protected continuity, a controller, at least four approved total worker slots
and no shared PVC worker volume. Larger pools or shared claims keep the serial
procedure. No capacity or DB connection allowance is raised. The candidate pool
starts during independent backend/native replacement and must have two ready,
current serving workers before any old worker withdraws.

A versioned pool subrecord persists each original Pod UID/incarnation, command
intent and candidate controller UID. Both old workers accept their own background
probe, withdraw, complete routing propagation, then fence admission. Their work
drains concurrently. Old capacity is scaled to zero only after both report
drained and their recording proofs pass. The updater joins actual Pod absence
and candidate/public health before completion. Timeouts preserve old owners.
Existing unfinished single-owner journals use their original recovery procedure.

The serial fallback is exercised with an autoscaler-grown three-worker starting
pool. The newly created zero-replica standby is bound to its acknowledged
template UID before final restoration. It does not need to become serving
capacity to count as an acknowledged controller.

The autoscaler tracks the active Service annotation, reads both pools, permits
only monotonic candidate growth during handoff and accounts for logical replicas
and physical/terminating Pods against the same maximum. The old controller cannot
write the new pool or journal. RBAC grants mutations only on the active slot;
the peer has exact-name reads and required named-Pod exec. Steady state rejects
an unexpected live peer. Final source/manifest verification aligns the active
slot but retains all template, image, settings, policy and permission checks.

Qualification records `executionPools: true` only when the updater observed the
paired layout. A successful serial fallback can qualify that layout using the
ordinary traffic, accepted-work, recording and capacity checks. Production keeps
using serial retirement for such a release, even when its live count is two.

Parallel handoff requires the additional `executionPool` certificate: the two original accepted
jobs actually overlapped, distinct recordings completed, at least two candidates
remained ready, physical capacity stayed in policy and the predecessor pool was
removed. The production CLI enables parallel handoff only with that certificate.
Older receipts without the layout claim cannot authorize the paired topology.
Pool evidence is compiled once during report validation, before retained cleanup.

Final removal rechecks both original UIDs/incarnations and drained states after
slow evidence/capacity checks, then reads a fresh StatefulSet resourceVersion
after the scale intent is durable. Slow diagnostics cannot turn an otherwise
valid removal into a predictable stale-version conflict. The two recorded
owners must match the two accepted-work receipts one for one.

Owners: `lib/execution-pool-*.mjs`, HA orchestration, autoscaler, Helm execution
and controller templates, runtime probes and release evidence validators.

### Parallel production preparation and acceptance

A reviewed installation policy can opt into `preparation: "parallel-online"`.
Only a fresh ordinary online deployment runs baseline journeys and the recovery
checkpoint together; maintenance, recovery and acceptance-only retain their
existing ordering. Both adapters are joined before mutation. If either fails,
the new `abort-preparation` acceptance stage stops/joins its observer, settles
accepted work and cleans its owned fixture, producing a bound private receipt.
An uncertain launch or partial fixture write is preserved for inspection.

The locally prepared private adapter copy implements that stage, overlaps
independent web/tree/workflow/browser journeys, and closes long-probe admission
after the final mutation. Short availability probes continue until final checks
and all accepted long responses finish. Marker/process bindings, response bodies,
recordings, observer exit and fixture cleanup remain required. The original
production evidence/bundle is unchanged. Prepared bundle hashes and encoded
installation contents are regenerated together; publishing its pointer remains
a separate reviewed operational action.

## Expected speed and limits

These are counterfactual budgets from the historical trace, **not measured new
GKE results**. Compare like-for-like ordinary protected releases, excluding image
build and GitHub queue time.

| Complete operation    | Earlier ordinary path | Initial overlap only | Target with all four changes |
| --------------------- | --------------------: | -------------------: | ---------------------------: |
| Staging workflow      |          about 69 min |         about 64 min |              about 25-35 min |
| Production deployment |          about 45 min |         about 35 min |              about 15-22 min |

An illustrative staging budget is 6 minutes preparation/cleanup/publication,
3 minutes migration/prerequisites, 14 minutes parallel replacement/test and
4 minutes final proof: **27 minutes**. Production could be 4 minutes preparation,
3 minutes prerequisites, 9 minutes replacement and 3 minutes final acceptance:
**19 minutes**. These are assumptions to measure, not guarantees.

The first retained-staging bootstrap still pays application installation cost.
A first policy build may also rebuild proxy. Schema changes, a real proxy
replacement, larger pools, load or cold GKE scheduling can exceed the target.
Do not subtract proxy savings twice when they already overlap worker work.

The two-times-faster objective applies to the complete ordinary path with these
features enabled, not every release shape. A three-worker starting pool retains
serial retirement; a first retained bootstrap still provisions its dependencies;
an actual proxy change can leave a graceful termination tail. Report those
conditions with the timings instead of treating the target as measured evidence.

The already-protected normal path avoids the one-time bridge automatically;
keep its verified fallback for genuine adoption. Do not shorten the current
360/420/600-second drain/preStop/grace profile. Those protections are not all
additive sleeps. Do not skip migration hooks or recover by automatically rerunning
an upgrade whose acknowledgement was lost.

## Review against earlier failed attempts

The October 30-November 4 attempt history exposed distinct failure families. A
green helper suite alone does not establish that their assembled entry points
work. The local review therefore covers the actual deployment command, packaged
provider preparation/cleanup, rendered Helm resources and detached autoscaler
bundle, alongside the source contracts. It adds no new cloud test or release gate.

| Earlier failure family                                                                              | Current protection and local evidence                                                                                                                                                                                                                                                                                                                                                                                                    |
| --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Repeated cluster/bootstrap, access, dependency and cleanup setup failures                           | Reuse the cluster and opt into the retained application. Native provider contracts exercise rendering, admission, auth, persistence, phase receipts and cleanup; separate retained tests cover ownership, credential rotation and scoped deletion. Actual GCP admission, TLS, NEG health and current permissions still require provider observations.                                                                                    |
| Provider defaults or normal intermediate state rejected as an invariant violation                   | Compare Kubernetes/Gateway semantics, retain safe provider-adjusted resource observations, and wait for legitimate bounded progress. A reproduced proxy race now refreshes CPU/readiness when an owned predecessor begins draining during inspection and two proxies remain ready. It does not authorize retirement from the stale sample. Lost floor, replaced identity, foreign owner, unsafe policy and excessive demand still block. |
| Packaged controller missing a transitive module                                                     | Build and boot the actual detached autoscaler dependency bundle, including `release-operation-state.mjs`. Missing dependency and occupied-port negative cases fail the same startup check.                                                                                                                                                                                                                                               |
| Autoscaler-filled `OnDelete` surge slot never becomes a candidate automatically                     | Complete rendered updater tests cover both pool directions and the three-worker serial fallback. Serial retirement reconciles existing old ordinals; parallel handoff requires its separately compiled behavior proof.                                                                                                                                                                                                                   |
| Lease expiry, exec completion handoff, lost acknowledgement or late proof rejection                 | One journal writer, renewal independent of long-probe completion, immutable phase receipts and observation-only recovery. Compile qualification proofs before releasing retained staging; the real deployment-command tests cover interrupted operations and prohibit replay of uncertain writes.                                                                                                                                        |
| Moving baseline, reservation policy or excessive synthetic checks obscured the deployment objective | Keep the installed immutable predecessor and exact successful build. The focused suite observes one actual update with approved capacity ranges; it adds no warmup, forced proxy restart, architecture disruption or second release. Preserve real availability, complete response bodies, accepted work and recording/data checks.                                                                                                      |
| Production-only adapter, checkpoint and observation failures                                        | Bind/check the reviewed adapter bytes and encoded installation together. Local adapter/prerequisite contracts and real command recovery tests cover invocation and receipts; historical database/object recovery evidence remains private. Final application failure uses verification-only recovery, not another rollout. The new private adapter's authenticated production journeys remain untested until activation.                 |

The new overlap does not relax the proxy safety floor. If native replacement
changes a sampled serving Pod into a draining Pod, the headroom guard pauses
retirement, waits within its existing observation deadline, and recomputes demand
including the draining CPU. Both a previously visible surge and a surge arriving
during confirmation are covered by failing-first regressions. No write is retried,
no additional unconditional delay is added, and the shared guard protects staging
and production alike.

The production review also reproduces a readiness-receipt disk failure after
parallel preparation has completed but before the infrastructure command starts.
That failure now invokes the existing preparation-abort stage once and records
infrastructure as `not-started`. A diagnostic write failure must not strand the
observer or claim that a deployment command had an uncertain acknowledgement.

A subsequent handoff review reproduces production acceptance-only recovery with
an observer bound to the original operation. A fresh verification identity cannot
find that observer; the predecessor's qualification settings digest also cannot
equal the already-installed candidate. `--acceptance-request` now accepts the
original saved after-request only with `--acceptance-only`, validates its exact
installation/candidate/values/policy binding and retains its operation, predecessor
and observation boundary. Current final configuration and health remain mandatory.
The prepared private adapter revalidates the original completed observation window
and runs fresh journeys; it does not demand that a stopped observer cover a later
retry. Failed or incomplete original observations remain failures. No new normal
rollout wait, fixture, backup, cloud test or automatic write retry was added.

The adjacent readiness review also reproduces a stale Deployment failure status
immediately after candidate application. The waiter previously rejected the new
candidate using `Progressing=False` from a generation the controller had not yet
updated. It now waits for current-generation acknowledgement before interpreting
that condition. Candidate readiness, current-generation failures, ownership and
the existing bounded deadline remain required for staging and production.

Retained cleanup also has a reproduced committed-write/lost-reply case: the
application records its healthy `idle` completion and removes ownership, but the
attempt does not receive that acknowledgement. Recovery previously demanded the
removed owner and blocked indefinitely. It now observes only the same operation's
completed result, matching application UID, nonce, namespace UID, settled-work
proof and exact receipt/manifest. It records that result without repeating folder
deletion or the finish write. Quarantine stays quarantined; changed identities and
uncertain fixture deletion still block. This closes cleanup bookkeeping and does
not turn an unsuccessful qualification into successful evidence.

## Validation and activation

Local tests cover pooled drain ordering, failure settlement, lost acknowledgements,
capacity loss and timeout; exact-controller inventory and physical scaling bounds;
real Helm output and both A-to-B/B-to-A complete updater paths; immutable proxy
input/provenance/manifest contracts; retained ownership, quarantine and scoped
cleanup; concurrent preparation and observer shutdown. Existing serial/recovery,
provider preparation, CLI and policy suites remain required. CI runs the native
pool contract before expensive image work. These establish local behavior, not
provider scheduling, GCP admission or measured wall-time savings.

After retained-cleanup recovery review, the local source gate passed **406 tests on Windows and Linux**, plus
workflow policy. The Linux Node 24.22.1 / kubectl 1.36.6 / Helm 3.22.1 native
suite passed **166 tests with one optional simulation skip**; the deployment Helm 3.20.1
migration-hook contract passed four tests. The related release-manifest,
qualification, evidence and native pool suite passed **122 tests with one platform
skip**, including complete three-worker serial fallback and serial/parallel proof
publication. The complete deployment-command suite passed all
**28 scenarios** in the process review; the reassessment also passed **two headless
browser fixture journeys**. Formatting, test style and
local documentation links passed. The private adapter passed syntax/cold-entry
checks and its encoded scripts, values and policy checksums agree. These are
local validations; no private production API journey or cloud update ran.
The added deployment-command observer-recovery journey covers rejected request
bindings and final configuration drift before successful verification, with no
additional backup or workload writes. A local test of the actual prepared private
observer also checks a completed original window during later recovery and rejects
failed or incomplete observations; it uses synthetic recordings and no live API.

Next operational sequence:

1. Review and publish one candidate plus its prepared private adapter/configuration.
   Keep credentials and private values out of public Git.
2. With a fresh allowance covering persistent application use and one test, install
   the matching retained-staging settings/cleanup worker and enable the paired
   profile. Reuse the existing cluster, hostname and access. First bootstrap cost
   is reported separately; no automatic retry or manufactured second release.
3. Run one focused qualification of those exact images against installed production.
   Require unchanged availability, complete responses, accepted-work/recording/data
   preservation, explicit pool evidence and verified scoped cleanup. Compare phase
   timing; slow-but-correct provider scheduling does not fail qualification.
4. Only after qualification and authorization, use the same source/images, paired
   values and reviewed adapter for production. Measure the full deployment and
   retain recovery evidence. Further routine updates reuse the retained application
   at the newly installed production predecessor.
