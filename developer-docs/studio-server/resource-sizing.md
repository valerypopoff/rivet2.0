# Kubernetes resource-sizing handoff

Status: **measurement pending**. Do not replace the production overlay's
`resourceLimitAcknowledgements` with guessed values. This is a staging-only
procedure for when DevOps can provide the cluster and monitoring access. The
current [published-capacity gate](kubernetes.md#published-execution-capacity-calibration-and-certificate)
proves a deterministic execution envelope; it does **not** size every Rivet
container or exercise arbitrary user graphs.

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

| Workload | Trial | Evidence needed |
| --- | --- | --- |
| `web` | Idle, dashboard/editor load, reconnect | Memory/CPU and local-ephemeral high-water; browser error rate |
| `backend` | Cold startup, editor Node runs, concurrent editor sessions, settings/recording activity | Combined API **and** executor process memory under the same container; readiness and restart history |
| `execution` | Built-in fast, long, and overload stages; representative published graphs with recordings | Per-Pod memory/CPU/storage peaks, p95/p99 latency, 429 admission behavior, queue/drops, provider concurrency |
| `backend`, then `execution` | Install a runtime library through the backend worker, then run a graph using it on execution Pods | Backend package-manager scratch and install duration; execution cache/download and run peaks; failed writes and post-install steady state |
| Migration Job (`resources.api`) | First install and upgrade against representative metadata volume | Peak memory, temporary storage, completion time, failure/retry behavior |
| `evaluation` (if enabled) | Dedicated Evaluation and joint public-load trial | Worker peaks, retry/cancellation, public-route interference |
| `proxy` (embedded only) | Public routes, WebSockets, large allowed uploads | Request-body scratch, connection count, latency, failed writes |

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

| Component and scenario | Image/Helm identity | Replicas, admission, HPA | Normal / valid-peak memory | Normal / peak CPU and throttling | Total local-ephemeral and `/tmp`/`/var/tmp` peaks | Restarts, OOM, evictions, failed writes | Proposed requests / limits and headroom rationale | Reviewer |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `web` | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending |
| `backend` | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending |
| `execution` | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending |
| Migration Job (`resources.api`) | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending |

Before approval, confirm that the monitoring time range includes startup and
the entire run, query results are scoped to the selected candidate Pods, all
expected components have evidence, proposed requests fit cluster capacity at
maximum replicas, and the new limits passed the same staging trials. The
capacity certificate is supporting evidence, not automatic sizing approval.
