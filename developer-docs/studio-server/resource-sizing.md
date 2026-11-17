# Kubernetes resource-sizing handoff

The opt-in [runtime autoscaler](runtime-autoscaling.md) has its own pod requests
and ceiling: the compact production baseline is five application Pods plus one controller. Its
execution maximum must fit the real DB/node/provider budgets. Local protocol
tests are not representative-load or GKE capacity measurements.

## Separate execution profiles for production and staging

**Configuration published November 17, 2026; profiles not deployed or load-certified.**
The first activation stopped in retained preparation before workload changes
because its new progress step was missing from the provider's source-owned list.
The local repair covers profiled bootstrap/reuse through the real progress wrapper
and the exported receipt through the production verifier. A failed attempt remains
failed; quarantine and its recovery lock are not authority to retry or deploy.
Keep these installation-specific targets in operator-owned values; the shared
production overlay retains its conservative admission default.

| Environment                | Execution minimum | Active published runs per Pod | CPU / RAM requests per execution Pod                                   |
| -------------------------- | ----------------- | ----------------------------- | ---------------------------------------------------------------------- |
| Production candidate       | 2                 | 32                            | 2 CPUs / 4 GiB                                                         |
| Retained staging candidate | 1                 | 4                             | Existing reservations; this installation currently admits 500m / 1 GiB |

`publishedExecutionAdmission.maxActiveRunsPerPod` owns
`RIVET_DEPLOYMENT_PUBLISHED_EXECUTION_MAX_ACTIVE_RUNS`; keep admission in
`enforce` mode. Two production workers provide 64 admission slots, not a proven
64-run throughput guarantee. The controller already scales from occupied slots
as well as CPU: at its 60% slot target, 39 active runs across two 32-slot workers
recommend a third worker, subject to the existing observation/cooldown rules.
CPU/RAM here are requests. Preserve existing limits and ephemeral-storage
settings; a new 4-GiB hard limit requires separate workload evidence.

The [production override](../../deploy/studio-server/examples/execution-production.values.example.yaml)
and [idle staging override](../../deploy/studio-server/examples/execution-staging.values.example.yaml)
change only execution requests, admission and replica floors. Merge them after
installation values and the existing HA/autoscaler overlays. The idle staging
override explicitly opts into `ha.stagingSingleExecution`; chart rendering and
controller startup reject that flag outside a `rivet-staging-*` namespace.
The examples describe steady state/new installation. For a running staging
release, use the owned retained-cleanup transition, which preserves its live
replica count; do not apply the example's one-replica count to a busy pool.
Production qualification/deployment still requires at least two workers and
rejects the staging flag. Even a sole staging worker retains the controller's
disruption budget and accepted-work drain checks.

The private hosted-release configuration supports these narrow fields (this is
a fragment, not a complete installation configuration):

```json
{
  "production": {
    "executionProfile": {
      "minReplicas": 2,
      "maxActiveRunsPerPod": 32,
      "requests": { "cpu": "2", "memory": "4Gi" }
    }
  },
  "staging": {
    "executionProfile": {
      "minReplicas": 1,
      "maxActiveRunsPerPod": 4,
      "requests": { "cpu": "500m", "memory": "1Gi" }
    }
  }
}
```

`production.executionProfile` describes the intended target; source Helm/settings
digests remain observations of the installation before the change. The protected
production values must match that target. `staging.executionProfile` requires the
retained focused suite. It overrides only staging execution CPU/RAM requests and
admission, and is bound alongside production's target in the qualification
configuration digest and archived operation. Omitting both fields preserves the
legacy behavior and qualification digests.
The public continuation receipt also preserves `stagingExecutionProfile`; otherwise
production-only verification cannot reproduce the qualified configuration digest.

Test preparation raises retained staging to three workers and restores the normal
two-worker test policy before observation. Successful cleanup first proves accepted
work has finished and removes its fixtures, then restores the one-worker minimum.
Helm preserves live replica counts; the normal autoscaler withdraws and drains
spare workers. Cleanup verifies a fresh healthy controller observation of the new
floor, without waiting out an additional stabilization window on the release
critical path. More than one worker may therefore remain briefly after cleanup.
Failed tests keep the existing quarantine behavior. Both floor transitions record
intent before writing; recovery reads back an uncertain write and never replays it.
Preparation changes only the existing controller policy and an upward replica
count using UID/version guards; it does not reapply a newer chart to predecessor
workloads. If a new test starts before background scale-in has finished, its
read-only preparation waits for the idle floor and completed journal first,
preventing test preparation from racing an unfinished retirement. Cleanup may
lower the floor while a test-policy retirement is already running: the controller
finishes that exact retirement with its original policy and two-peer requirement,
then adopts the one-worker floor on the next complete observation. A changed
image or any other steady policy change still requires explicit recovery.
Retained values are read together with Helm's release status; pending/failed
revisions cannot prove a completed profile update, even if their saved values
look correct. Cleanup verification also requires a settled idle-profile receipt
after a lost application-finish acknowledgement.
Retained requests/admission must already match the selected staging profile;
changing that profile on an existing retained installation requires an explicit
owned preparation, rather than silently adopting mismatched predecessor Pods.

During a journal-owned paired handoff, demand checks validate each pool's metrics
and uniform admission limit separately, then size candidate growth using the
candidate's limit. This supports four-to-32-slot adoption without weakening the
mixed-limit guard within a pool or outside an owned transition. CPU demand is
also converted from each observed Pod's utilization and CPU request to the
smallest admitted candidate request, so a change in CPU size does not compare
incompatible percentages or assume extra provider capacity. The retirement check
also verifies uncapped demand at full slot/CPU capacity; reaching the scaling
ceiling cannot turn an overloaded replacement pool into sufficient capacity.
CPU summation roundoff is tolerated at that boundary, but real overload is not.
Admission changes use paired replacement even when application images stay the
same. If pairing is unavailable or unqualified, stop before applying templates
instead of mixing incompatible admission limits in a serially replaced pool.
Existing placement, terminating-Pod and resource headroom checks still run before retirement. With two
old and two new production-sized workers, execution alone reserves 8 CPUs / 16 GiB
during future paired updates; larger live pools require their actual larger budget.

Before calling 32-slot production capacity validated, run a separate approved
representative 32-concurrent-run trial on temporary production-sized staging
workers, then restore the cheap profile. Check latency, CPU/memory peaks,
overload handling, OOM/restarts and complete recordings. Routine four-slot staging
rollouts prove rollout behavior, not production throughput. This calibration is
not required again on every release. Use `helm template` as a rendering check:
Helm `lint` can log a template `fail` as information and still exit zero.

The autoscaler implementation is bundled into the API image by
`images/lib/prepare-autoscaler-runtime.mjs`. Supporting its one-worker policy
therefore requires a matching API image; a tooling-only publication cannot
update the running controller. Local preparation does not authorize publishing
configuration, spending on a cloud test or deploying production.

Local coverage includes profile validation and qualification identity, three-worker
preparation and idle cleanup, uncertain-write recovery, staging floor transitions,
and paired handoffs in both directions between four- and 32-slot workers. The
maintained rollout source suite and Helm rendering checks cover these paths;
they do not establish provider capacity or production throughput.

## Web and proxy reservation candidate

The November 3, 2026 DevOps review of October 27-November 3 production usage
identifies two request-only candidates. The reported CPU peaks are one-minute
averages and memory peaks are sampled, so neither establishes a safe hard limit.

| Container  | Reported current request | Candidate request | Reported CPU peak / memory peak |
| ---------- | ------------------------ | ----------------- | ------------------------------- |
| Web        | 500m / 512Mi             | 50m / 128Mi       | 95m / 60Mi                      |
| Each proxy | 500m / 512Mi             | 100m / 128Mi      | 95m / 14Mi                      |

The [candidate values](../../deploy/studio-server/examples/gke-web-proxy-resources.values.example.yaml)
are outside the chart and change only these four request fields. Merge them
**after installation values**; the live installation explicitly overrides the
already-smaller chart defaults. The override changes no chart template or
application code. Keep existing limits and ephemeral storage,
the controller at 100m/128Mi, and backend/execution at 500m/1Gi each. Backend and
execution bursts in the review argue against reducing their requests now.

Keep the proxy's existing 75% CPU target and replica bounds for the first trial.
At 100m CPU requested, that target is 75m average CPU per Pod, down from 375m
with the reported old request. Earlier scale-up is expected; observe replica
counts, latency and total admitted reservations together. Do not compensate by
raising the target to 375%: the current rollout headroom guard supports 1-100%.
Do not add a CPU limit equal to the smaller request; a request is a reservation,
and the web's reported CPU peak already exceeds its proposed request.

The narrow staging trial needs cold startup/readiness, frontend/editor loading,
an existing WebSocket journey, a representative allowed upload and concurrent
public traffic through the proxies. Check readiness, restarts/OOMs, errors and
latency, and retain the HPA's actual scale-up/down behavior. Reuse existing
immutable images and retained staging infrastructure. This does not require
running the full execution-capacity scenario matrix below. Before accepting a
savings estimate, inspect **admitted Pod requests** and limits: Autopilot can
raise values to its compute-class minimums/ratios, and clusters without bursting
can set limits equal to requests. See [Autopilot resource requests](https://docs.cloud.google.com/kubernetes-engine/docs/concepts/autopilot-resource-requests)
and [Pod-based billing](https://cloud.google.com/kubernetes-engine/pricing#general-purpose_autopilot_workloads).

**Release Rivet** now accepts an optional `sizing_requests` JSON input:

```json
{ "web": { "cpu": "50m", "memory": "128Mi" }, "proxy": { "cpu": "100m", "memory": "128Mi" } }
```

This example expresses the proposed reservations, not an accepted GKE profile.
The November 3 trial was rejected during installation: the existing required
Pod anti-affinity needs at least **500m CPU and 512Mi memory** on general-purpose
Autopilot. Resolve that placement/resource choice explicitly; changing or
removing a staging assertion cannot bypass GKE admission. See the
[existing availability guidance](production-ha-cutover.md#apply-and-recover).

Effective Helm values, including installation overrides, own the intended
requests and limits. Staging does not choose them or require a separate sizing
approval for an ordinary rolling update. This opt-in observation mode is useful
for investigating resource behavior; its result does not authorize deployment.

Set `deploy_production=false`. A nonempty sizing input selects an observation-only
trial; production-enabled or invalid input fails before cloud setup. Only these
four positive quantity strings are accepted, with intentional increases and
decreases both allowed. Installed facts remain unchanged. The candidate images start
with the requested reservations; there is no rolling update or topology/shutdown
profile adoption in this mode. The regular release path still copies production
sizing and retains its existing qualification requirements.

The trial reuses fixture preparation, authentication, expiry, resource inventory,
private evidence and independent cleanup. The existing observation phase runs the
browser journey, an 8 MiB valid project upload and four concurrent non-retrying
workflow streams plus published-app traffic, with at least a minute of resource
observations. It records configured and admitted requests/limits as information;
provider adjustments do not fail the trial or certify the proposed savings.
Readiness, restarts/OOMs, public traffic, fresh CPU/RAM samples and HPA health
remain the observation checks. Healthy HPA growth is allowed; reaching the ceiling or
returning to an exact proxy count is not required. Observations use the installed
one- or two-proxy minimum. No CPU-burn or separate
autoscaler stress phase is added. This is a sizing observation, not a measured
throughput ceiling or a seven-day peak guarantee.

After verified cleanup, the result is `sizing-observed`, with no runtime-control
or autoscaling certificate. Workflow publication and production jobs are disabled,
and the production command also rejects sizing packets. Keep these results with
the exact requests for later production planning. A resource change replaces Pods;
the first protected rollout is still required before relying on the new
300-second shutdown protection for subsequent configuration updates.

The updated runner must be published and pass the existing exact-source image,
driver and cleanup-worker gates before cloud use. A previously built actor is
not evidence for changed runner code. Local implementation does not start a test
or reuse a closed operation allowance.

This candidate has not been successfully installed or measured. A local Helm render proves
merge order and generated settings, not performance, Autopilot admission or savings.
The DevOps estimate of roughly USD57/month is conditional on actual admitted
requests, prices and replica counts; it is not a measured reduction in billing.

## Broader workload sizing

Status: **measurement pending**. Do not replace the production overlay's
`resourceLimitAcknowledgements` with guessed values. This is a staging-only
procedure for when DevOps can provide the cluster and monitoring access. The
current [published-capacity gate](kubernetes.md#published-execution-capacity-calibration-and-certificate)
proves a deterministic execution envelope; it does **not** size every Rivet
container or exercise arbitrary user graphs.

The opt-in [runtime-HA/singleton-control profile](runtime-ha-singleton-control-plan.md)
has six proxies, one web, one editor/maintenance backend and two execution pods.
Ten is its steady-state count, not its surge ceiling. Maintenance is embedded,
not removed: include archive upload/extraction/export, restore recovery and editor
activity together in backend peak measurements. Removing three old reservations
does not prove that the merged backend can keep its old memory/CPU budget. Its
published scheduler shares the ordinary per-pod execution admission envelope.

## Before running a trial

- Freeze the candidate image digests, Helm values, admission/HPA settings,
  replica counts, node types, and staging gateway route. Keep this identity
  with every observation. Use the protected `rivet-managed-staging`
  environment and provider-gate workflow, never production.
- Let the execution HPA settle to its intended idle replica count before the
  baseline. A baseline Pod that later disappears fails certification, even if
  it was removed by an otherwise normal scale-down.
- Confirm the active workload inventory from the rendered chart. External
  gateway mode normally has `web`, combined `backend`, and `execution` Pods;
  `resources.api` also budgets the migration Job and is used by legacy
  compatibility paths. Include `evaluation` only if hosted Evaluations are
  enabled, and `proxy` only in embedded-gateway mode. Do not reintroduce
  `resources.executor` for the combined backend.
- DevOps must verify the monitoring queries against **live staging** labels and
  Pod identities before the run. The capacity runner requires one finite,
  nonnegative Prometheus vector element per configured query, but it cannot
  establish that the query covers the intended containers or full storage usage.
  Its required `memoryHighWaterBytes` and `nodeEphemeralHighWaterBytes` names
  describe observations, not built-in Prometheus metrics. The optional
  `downstreamConcurrency` observation is useful only when an actual
  provider/tool concurrency metric exists; the built-in fixture makes no
  downstream calls. Rivet does not emit a metric named
  `rivet_provider_requests_in_flight`. Measure provider concurrency separately
  during representative scenarios instead of substituting a constant.
- Retain per-Pod, per-container time series for memory, CPU usage and
  throttling, plus total local ephemeral usage. Validate that storage evidence
  includes writable layers, logs, and disk-backed `emptyDir` volumes. A
  container filesystem query alone can miss the volumes. `/tmp` and
  `/var/tmp` in this chart are disk-backed bounded `emptyDir`, not memory
  tmpfs; keep their high-water observations separate from the Pod total.
  Confirm the scrape interval and query lookback can capture short execution
  peaks; the runner's periodic instant-query samples alone cannot prove that.
  Check that the gate captured an idle, healthy baseline and at least one
  active run; an idle-only sample is not a valid load measurement. Check for
  OOM kills, evictions, Pod replacements, failed writes, recording drops,
  queue depth, admission rejections, and latency during the same time window.
- Prepare approved, non-sensitive test projects and a known cleanup owner.
  Keep credentials, request headers, project contents, prompts, and outputs
  out of committed configuration and sizing reports.

## Scenario matrix

Run each applicable row several times with a clean baseline and a retained
time window. Record both cold and warm behavior; do not average away valid
peaks. The built-in gate exercises only the deterministic fast, long, and
overload parts of the `execution` row; the other trials need separate staging
work.

| Workload                        | Trial                                                                                             | Evidence needed                                                                                                                           |
| ------------------------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `web`                           | Idle, dashboard/editor load, reconnect                                                            | Memory/CPU and local-ephemeral high-water; browser error rate                                                                             |
| `backend`                       | Cold startup, editor Node runs, concurrent editor sessions, settings/recording activity           | Combined API **and** executor process memory under the same container; readiness and restart history                                      |
| `execution`                     | Built-in fast, long, and overload stages; representative published graphs with recordings         | Per-Pod memory/CPU/storage peaks, p95/p99 latency, 429 admission behavior, queue/drops, provider concurrency                              |
| `backend`, then `execution`     | Install a runtime library through the backend worker, then run a graph using it on execution Pods | Backend package-manager scratch and install duration; execution cache/download and run peaks; failed writes and post-install steady state |
| Migration Job (`resources.api`) | First install and upgrade against representative metadata volume                                  | Peak memory, temporary storage, completion time, failure/retry behavior                                                                   |
| `evaluation` (if enabled)       | Dedicated Evaluation and joint public-load trial                                                  | Worker peaks, retry/cancellation, public-route interference                                                                               |
| `proxy` (embedded only)         | Public routes, WebSockets, large allowed uploads                                                  | Request-body scratch, connection count, latency, failed writes                                                                            |

The deterministic Code-plus-Delay gate does not call an external LLM or tool,
install a runtime library, or reproduce customer-specific memory spikes.
Representative projects need their own approved staging trials. Do not use
customer data without an explicit data-handling decision.

## Run, review, then propose

1. In **Build Images**, select `run_managed_kubernetes_capacity_observe` for
   the immutable candidate and protected staging configuration. Keep its
   `capacity-report.json`, `capacity-review.md`, provider dashboards, and
   image/Helm identity together. Observe mode cannot promote images. Run the
   other scenario-matrix trials in the same staging topology and retain their
   time series and cleanup records.
2. For every active workload, fill the worksheet below from **multiple**
   complete trials. Separate normal sustained usage, valid peak, and startup
   peak. A missing metric, restarted Pod, or incomplete cleanup invalidates a
   sizing conclusion; investigate and repeat instead of treating the lower
   observed value as safe.
3. Propose memory and `ephemeral-storage` requests that schedule normal use
   with reserve, and limits above valid measured peaks with reviewed headroom.
   Check node allocatable capacity at the intended maximum replicas. Do not
   derive a hard limit from an idle sample or one deterministic trial. Keep
   CPU requests and execution HPA targets aligned with observed saturation;
   add CPU limits only after testing throttling impact.
4. Put the reviewed request/limit pairs under `resources.<workload>` in
   `deploy/studio-server/helm/overlays/prod.yaml`. Clear the matching
   `resourceLimitAcknowledgements.<workload>.memory` and `.ephemeralStorage`
   fields. Helm rejects an acknowledgement left alongside a complete pair.
   Keep the separate `writableVolumeLimits` and `tmpVolume` sizes based on
   their own observed high-water marks.
5. Render and test the candidate values with
   `yarn studio-server:verify:kubernetes`, then deploy **staging** with those
   exact values. Repeat the representative trials and run the protected
   `run_managed_kubernetes_capacity_gate` certificate. Check OOM/eviction,
   failed writes, latency, recording loss, and HPA/admission behavior before
   proposing production rollout. Stage a rollback of the resource values;
   lowering a limit can interrupt an otherwise valid run.

## Evidence and decision worksheet

Copy this table into the private change review; do not fill it with example
numbers. One row is needed per active component, including the migration Job
and optional workloads. Attach charts rather than credentials or payloads.

| Component and scenario          | Image/Helm identity | Replicas, admission, HPA | Normal / valid-peak memory | Normal / peak CPU and throttling | Total local-ephemeral and `/tmp`/`/var/tmp` peaks | Restarts, OOM, evictions, failed writes | Proposed requests / limits and headroom rationale | Reviewer |
| ------------------------------- | ------------------- | ------------------------ | -------------------------- | -------------------------------- | ------------------------------------------------- | --------------------------------------- | ------------------------------------------------- | -------- |
| `web`                           | Pending             | Pending                  | Pending                    | Pending                          | Pending                                           | Pending                                 | Pending                                           | Pending  |
| `backend`                       | Pending             | Pending                  | Pending                    | Pending                          | Pending                                           | Pending                                 | Pending                                           | Pending  |
| `execution`                     | Pending             | Pending                  | Pending                    | Pending                          | Pending                                           | Pending                                 | Pending                                           | Pending  |
| Migration Job (`resources.api`) | Pending             | Pending                  | Pending                    | Pending                          | Pending                                           | Pending                                 | Pending                                           | Pending  |

Before approval, confirm that the monitoring time range includes startup and
the entire run, query results are scoped to the selected candidate Pods, all
expected components have evidence, proposed requests fit cluster capacity at
maximum replicas, and the new limits passed the same staging trials. The
capacity certificate is supporting evidence, not automatic sizing approval.
