# Kubernetes

Open managed-mode risks and recommended remediation work are tracked in
[`kubernetes-managed-mode.md`](./audits/kubernetes-managed-mode.md).

This repo supports one Kubernetes topology today:

- `proxy`: scalable
- `web`: fixed at `1` in the current endpoint-heavy recommended shape
- `backend`: singleton
- `execution`: scalable

That split is intentional. The singleton `backend` owns:

- `/api/*`
- `/ui-auth`
- `${RIVET_LATEST_WORKFLOWS_BASE_PATH:-/workflows-latest}`
- `${RIVET_LATEST_APPS_BASE_PATH:-/apps-latest}`
- `/ws/latest-debugger`

The `execution` Deployment owns:

- `${RIVET_PUBLISHED_WORKFLOWS_BASE_PATH:-/workflows}`
- `${RIVET_PUBLISHED_APPS_BASE_PATH:-/apps}`
- `/internal/workflows/:endpointName`

Do not scale `backend` horizontally in the current chart shape. Latest workflow execution, latest web-app action execution, and `/ws/latest-debugger` are still process-local control-plane features.

The chart enforces `backend=1` and disables backend autoscaling. The backend is a StatefulSet, so Kubernetes does not offer the Deployment-only `Recreate` strategy named in some deployment guidance. Its `OrderedReady` plus single-ordinal `RollingUpdate` is the equivalent single-writer replacement here: ordinal `0` is terminated before its replacement is created, accepting a short control-plane interruption and preventing an old and new backend from serving together. Execution replicas remain independently scalable.

The supported chart currently requires managed workflow and runtime-library storage, so canonical workflow bytes are transactional in PostgreSQL/object storage and do not use the filesystem save journal. Filesystem deployments still use the same API image and startup recovery code in local Docker and single-host installations. A downstream Kubernetes shape that re-enables filesystem workflow storage must keep the backend singleton, mount project files, dataset sidecars, and `.rivet-transactions` from one PVC at the same workflow-root mount, and retain serial pod replacement. Prefer `ReadWriteOncePod` when the CSI driver supports it. `ReadWriteOnce` alone may allow multiple pods on one node and is not a single-writer guarantee. Scaling a filesystem-backed control plane above one replica is unsupported; high availability requires shared locking or the managed transactional backend.

Workflow storage initializes before the API listens. Its filesystem capability probe and journal recovery therefore gate readiness. An ambiguous recovery leaves the pod unready and logs a transaction ID plus safe project-relative path; do not delete that transaction evidence until the underlying storage state has been inspected. The configured termination grace period normally lets active filesystem operations drain, but crash correctness comes from recovery rather than graceful shutdown.

## Scaling model

Scaling in this chart is per Deployment or StatefulSet, not in fixed pod pairs.

- a new `execution` pod is only another execution-plane API pod
- a new `proxy` pod is only another nginx proxy pod
- a new `web` pod is only another dashboard shell pod
- the `backend` StatefulSet stays at one pod because the current control-plane and latest-debugger behavior is still process-local

That means rising endpoint demand should usually add `execution` pods first. `proxy` should stay redundant and may also scale, but it does not need to grow one-for-one with `execution`.

Recommended operator mental model:

- scale `execution` for workflow endpoint throughput
- keep `proxy` redundant so ingress and websocket termination do not become a single bottleneck
- keep `web=1` when the dashboard is only used by one operator and temporary UI hiccups are acceptable
- keep `backend=1` until the process-local control-plane constraints are removed architecturally

Typical endpoint-heavy production shape:

- `proxy`: `2` to `5`
- `execution`: `2` to `10`
- `web`: `1`
- `backend`: `1`

Do not treat that as a forced ratio. `execution=8` with `proxy=2` can be correct. The tiers scale independently.

## Hosted Evaluations

Managed hosted Evaluations are an opt-in, server-owned batch scheduler. They are not a browser-executor feature and they do **not** use published workflow capacity. Enable them only with managed workflow storage and an approved batch budget:

```yaml
hostedEvaluations:
  enabled: false # set true only for an approved managed deployment
  workerConcurrency: 1 # per Evaluation-worker pod; 1..8
  leaseMs: 60000 # 15,000..600,000
  pollMs: 1000 # 250..30,000
  maxJobsPerRun: 2000 # 1..100,000
  maxOutstandingJobs: 10000 # maxJobsPerRun..1,000,000
  scheduling:
    # Use a dedicated batch node pool in production when one exists.
    nodeSelector: {}
    # Otherwise use a class below the public execution tier's priority.
    priorityClassName: ''
```

When enabled, Helm renders a dedicated internal `evaluation` Deployment and ClusterIP Service. The control-profile/backend API accepts authenticated submissions; the `evaluation` profile is the only Kubernetes worker profile that claims trials. It exposes health and (when explicitly enabled) metrics, but no `/api/*`, latest-editor, published `/workflows/*`, or web-app routes. The `execution` Deployment remains reserved for product-facing published workflows and web-app actions. A `combined` process may still run workers for local-development parity only.

The worker Deployment has no proxy upstream or public Service. It mounts the same managed PostgreSQL, object storage, runtime-library cache, and app-settings projection as the other API workloads, so it executes the same Node `GraphProcessor` contract without routing through the public execution tier. It deliberately has no HPA: batch concurrency is bounded first by `replicaCount.evaluation × workerConcurrency`, then by the two global job quotas. Production chart rendering requires at least one Evaluation replica and either a batch `nodeSelector` or an explicitly lower-priority `priorityClassName`, preventing an unreviewed batch tier from competing for public capacity.

Submission creates the immutable project snapshot, normal `.rivet-data` sidecar snapshot, visible run projection, content-addressed dataset snapshot, scheduler parent, and deterministic trial rows in one PostgreSQL transaction. Before any row is written, the coordinator rejects a suite that exceeds `maxJobsPerRun`. Inside the same transaction it takes a transaction-scoped PostgreSQL advisory lock, counts queued, claimed, and accepted jobs through a partial outstanding-job index, and rejects a submission that would exceed `maxOutstandingJobs`. This is an installation-wide decision, not a best-effort process-local check, and it does not scan terminal job history as retained Evaluation runs grow. Capacity rejection returns `429 evaluation_batch_capacity_exceeded` with `Retry-After: 5`; it creates no partial run and the hosted editor does not silently fall back to browser execution. Retrying interrupted trials takes the same advisory lock and reserves the same outstanding-job budget before it requeues anything, so recovery work cannot bypass the batch ceiling. A caller-supplied run ID is accepted only by the transaction-owned run-projection insert, so a concurrent duplicate produces a conflict and rolls back every related write.

The immutable dataset snapshot, visible run projection, scheduler parent, and all deterministic jobs are committed together before any worker can claim work. A job has a stable run/case/trial identity and fencing token. It is **claimed** first and becomes **accepted** immediately before graph execution. An expired pre-accept claim, or a claim observed while its worker is already shutting down, is automatically returned to the queue because no graph can have started. An accepted worker loss is shown as an interrupted trial and is never silently repeated; only a durable cancel request produces cancellation evidence. The process-local cancellation index is scoped by both project and run, matching the database isolation boundary even when a caller reuses a run ID in another project. During pod shutdown, active trials receive an abort signal and the coordinator waits only a bounded fraction of the lease before yielding to API resource disposal; a graph runner that ignores cancellation remains an accepted lease and is later recorded as an explicit interruption. Turning `hostedEvaluations.enabled` off stops new submissions and worker claims, but retained hosted runs remain inspectable and cancelable; an active hosted run cannot be deleted, so re-enabling the feature cannot resurrect an orphaned schedule. The hosted Runs UI reads the scheduler's stable state and only shows retry controls for an enabled hosted scheduler with individually interrupted jobs. It defaults to no selection, lets an operator refresh and select exact trials, and requires confirmation that a retry can repeat model calls, tools, external side effects, and cost. The authenticated `POST /api/workflows/evaluation-runs/:runId/retry-interrupted` route then rechecks each job's interrupted/canceled state and the same global capacity budget in its transaction; stale selection returns a conflict, canceled work is never revived, and no browser reload or background task retries accepted work.

Cancellation and explicit retry take the same transaction-scoped PostgreSQL advisory lock for that durable run before they read mutable jobs, so a cancellation cannot miss a trial that a concurrent retry has just returned to the queue.

Retry is additionally fail-closed against inconsistent scheduler state: every selected job must still be `interrupted`, and its parent must still be `interrupted` or already `running` because another selected retry reactivated it. A `queued`, `completed`, or `canceled` parent returns a conflict instead of being revived.

An operator may requeue only a selected subset. If another job remains interrupted, its warning and individual retry control remain visible while the parent is running the selected work. Scheduler refreshes revalidate the operator's selected job IDs against the latest durable state without clearing selections that are still interrupted.

Requeue removes only facts derived from the selected interrupted trials: it clears the interruption warning and recomputes accounting from settled retained trials, retaining partial accounting only when such evidence remains. If other jobs are still interrupted, their single warning is retained without accumulating duplicate messages across partial retries.

When `metrics.enabled=true`, the control API reports finite submission outcomes, while the Evaluation worker reports queued/claimed/accepted outstanding jobs, the outstanding-job limit, active trials, and worker-concurrency limit. Enabling `metrics.serviceMonitor.enabled=true` adds a direct internal Evaluation ServiceMonitor; it is never exposed through the proxy. Use those signals together with the existing execution admission metrics to demonstrate that a batch cannot breach the published endpoint SLO.

### Evaluation retention

Managed Evaluation evidence is retained by the singleton, PostgreSQL-fenced maintenance owner, never by an arbitrary browser, history read, or published execution replica. Helm starts with the chart-owned `evaluationRetention.mode: audit`, which reports bounded counts through `rivet_managed_evaluation_retention_candidates` without deleting data. Inspect that signal for the real installation first, then explicitly change the value to `enforce`; `disabled` is available only for a controlled maintenance pause. The chart rejects a raw environment override.

In enforce mode, the task holds the current lease and rechecks it immediately before every destructive delete. It deletes only expired `temporary` replay artifacts, and excludes a recording while its hosted parent is `queued` or `running` or any trial job is queued, claimed, or accepted. `failure`, `baseline`, and `retained` references are never cleanup candidates. Compact run history and the dataset snapshot used as a run's provenance stay durable. A dataset snapshot may be removed only after one hour when no stored run in that project still references its fingerprint. The same active-parent/job predicate keeps an expired provisional replay readable while hosted work is still active; terminal finalization then renews or pins its reference atomically. Evaluation artifacts are PostgreSQL-owned today; any future object-store payload must use the durable object-deletion outbox rather than this metadata-only worker.

The Runs tab makes temporary expiry explicit and offers **Keep replay recordings** and **Release replay recordings**. Keeping converts only still-live temporary recordings to `retained`; releasing `retained` recordings starts a fresh 24-hour temporary window. Every operator-initiated retention update confirms that its artifact still exists: if cleanup won a race, the UI leaves that item unchanged and asks the operator to refresh. Hosted terminal projection instead updates replay retention in the same PostgreSQL transaction as the final run state; if an artifact is already missing, that transaction rolls back and the worker records explicit interruption evidence rather than publishing a final reference it cannot fulfill. Deleting a run remains an explicit destructive action: it removes its replay artifacts, while an already saved compact baseline remains comparable but no longer has those replays.

This source-level isolation does not substitute for operational evidence. Keep the feature disabled in high-volume production until the worker-loss/cancellation and concurrent batch-versus-public capacity scenarios have passed with the immutable release images. See the [managed-mode audit](./audits/kubernetes-managed-mode.md) for those gates.

### Hosted Evaluation disruption certificate

`yarn studio-server:verify:kubernetes:managed-evaluations` is the protected staging certificate for the durable hosted-Evaluation path. In GitHub **Build Images**, enable `run_managed_kubernetes_evaluation_gate`; it first deploys the current immutable candidate through the existing provider gate, then runs this certificate in the same protected `rivet-managed-staging` environment. It requires `RIVET_K8S_EVALUATION_GATE_CONFIRM=disrupt-staging-evaluations`, the exact allowlisted staging context, and exactly one Evaluation worker replica so that the worker-loss transition is unambiguous. If the same manual dispatch also requests the published-capacity certificate, that certificate completes first; the destructive worker-loss certificate never runs concurrently with it. Provider deployment, capacity, and Evaluation certificate jobs share one non-canceling staging lock across workflow runs, so another manual dispatch cannot mutate the release at the same time.

For the deliberate joint scenario, select both `run_managed_kubernetes_evaluation_gate` and `run_managed_kubernetes_evaluation_joint_capacity_gate`, **without** either separate capacity input. The provider job rejects any other joint selection before it deploys staging. The protected provider configuration must supply the ordinary `capacity` block and `hostedEvaluationGate.jointCapacity.trialDelayMs`. The runner rejects a trial delay shorter than `capacity.jobTimeoutSeconds + 60 seconds` and a capacity timeout above 14 minutes. It verifies the dedicated Evaluation trial immediately before the public-load Job is created and again at the Job-completion boundary, before report collection or cleanup can consume the trial's duration. It then cancels only that generated joint run before the independent worker-loss/retry/cancellation scenarios begin. This preserves the single-worker certificate precondition. It reuses the exact capacity runner, temporary endpoints, scoped credential, cleanup, and sanitized evidence contract; it does not introduce another load engine or a batch request path. The Evaluation artifact retains both `hosted-evaluations/` and `published-capacity/`, including the sanitized capacity report and calibration review, so the joint lifecycle and load evidence cannot be separated.

After durable acceptance, the runner force-deletes only that selected Evaluation worker (`--grace-period=0 --force`). It does not delete the backend, execution, proxy, web, database, or object-store workloads. The protected confirmation and one-worker precondition make this a deliberate, bounded worker-loss test rather than an ordinary rollout action.

Add this bounded non-secret block to the protected provider-gate JSON:

```json
{
  "hostedEvaluationGate": {
    "waitSeconds": 240,
    "publicProbeRequests": 8,
    "jointCapacity": {
      "trialDelayMs": 180000
    }
  }
}
```

`jointCapacity` is ignored unless the joint manual-dispatch input is selected. Its delay is not a performance knob: set it to at least the configured capacity Job timeout plus 60 seconds, after reviewing the Evaluation execution timeout for the staging release. Do not add it as an unsafely long default to a general production chart.

The runner submits a one-trial, execution-only snapshot of the long deterministic fixture and immediately abandons its initiating request path: no browser connection is required after the server returns `202`. It proves duplicate submission returns `409`, waits for one accepted trial, probes the independently scalable published endpoint while that trial is running, deletes only the exact Evaluation worker Pod, and requires one explicit interrupted trial. It then requests the selected retry and requires exactly one settled second attempt; it separately proves a durable cancellation. Its report keeps only run/job IDs, state transitions, attempt counts, timestamps, public status counts, and failure classes. It never stores response bodies, project content, provider headers, or credentials, and it deletes only its generated hosted runs. A passing report is staging evidence, not a license to enable hosted Evaluation retention enforcement without a separate audit-mode review.

## Autoscaling prerequisites

The current HPAs are CPU-based:

- `proxy` HPA targets the `proxy` Deployment
- `execution` HPA targets the `execution` Deployment

Before relying on those HPAs in production, set real CPU and memory requests in the chart values for at least:

- `resources.proxy`
- `resources.execution`

Without CPU requests, CPU-utilization HPA behavior is not trustworthy. The chart shape is ready for autoscaling, but operators should treat resource sizing as a required part of the production handoff.

## Local rehearsal

Use the local Kubernetes launcher when you want the closest practical browser-level rehearsal of the real chart:

```bash
yarn studio-server:dev:kubernetes-test
```

If Helm is not already on PATH, install the pinned cached copy first:

```bash
yarn studio-server:setup:k8s-tools
```

Current behavior:

- builds local `proxy`, `web`, `api`, and `executor` images
- deploys the real Helm chart into a dedicated namespace
- uses the explicit `RIVET_K8S_CONTEXT` when set
- otherwise uses the current `kubectl` context when one exists
- otherwise falls back to the `minikube` context automatically when the Minikube CLI is installed
- keeps `backend=1`
- keeps `web=1`
- scales `proxy` and `execution`
- port-forwards the proxy service for local browser access
- on Docker Desktop, imports freshly built images into the cluster node containers
- on Minikube, loads freshly built images with `minikube image load --daemon=true`
- on Minikube-backed `dev`, `up`, and `recreate`, starts the target Minikube profile automatically when needed

The launcher expects:

- external managed Postgres
- external S3 or S3-compatible storage
- local renderer inputs named `RIVET_K8S_DATABASE_*` and `RIVET_K8S_STORAGE_*`

The local overlay at [deploy/studio-server/helm/overlays/local-kubernetes.yaml](../../deploy/studio-server/helm/overlays/local-kubernetes.yaml) is not a standalone values file. It is meant to be merged with the generated values file from `deploy/studio-server/scripts/dev-kubernetes.mjs`.

Managed runtime-library startup now serializes its shared Postgres schema initialization behind a PostgreSQL advisory lock. That avoids first-boot deadlocks when the control-plane API and execution/editor processes start against the same managed database at the same time.

## Managed Release Gate

`yarn studio-server:verify:kubernetes` is the fast deterministic gate. It renders and validates the chart plus Kubernetes contracts, but it does not start a cluster.

The image workflow now also runs a disposable live managed-mode gate before it promotes public tags. It creates a four-node Kind cluster (one control plane plus three workers), starts isolated PostgreSQL and MinIO dependencies, installs the real chart with the exact OCI digest for every candidate image, and accesses the app only through the proxy. The smoke suite verifies:

- singleton backend plus two proxy and two execution replicas;
- Helm schema migration, managed PostgreSQL App Settings with execution-runtime propagation through a replacement pod, and managed object storage;
- published/latest workflow requests;
- published/latest web-app HTML and HTTP actions;
- a web-app WebSocket action;
- recordings, replay-project retrieval, and the statistics catalog;
- the release mode additionally proves long-running web-app WebSocket owner loss, reconnect replay as an explicit interruption, App Settings encryption-key rotation, and PostgreSQL/MinIO readiness failure then recovery. The disposable Kind fixtures keep dependency data in node-local directories while their pods are replaced, so these checks exercise an outage and recovery without silently turning the probe into a data-loss test;

The runner generates a dedicated Rivet key for each disposable namespace and
uses it as a bearer token for public workflow probes. Control-plane API probes
continue through the proxy's trusted internal boundary, so the gate exercises
the same public workflow authentication contract as an external caller.
During forced WebSocket owner loss, reconnect attempts tolerate transient proxy
handshake failures while replacement pods converge, but the replay assertion
remains bounded to two minutes and still requires the durable interrupted event.

- persistence after backend and execution-pod replacement.

`develop` uses `.github/workflows/studio-server-verify.yml`. The reusable verifier builds Studio Server once, then runs four isolated API shards, web tests, host compatibility, repository contracts, and Kubernetes render/contracts in parallel while preserving the final `verify` status. Its changed-path classifier skips heavy Studio Server jobs for unrelated commits; direct `yarn studio-server:test` remains the complete sequential local gate.

The image workflow is path-gated to Studio Server and its Rivet runtime/deployment dependency closure. Repository verification and immutable candidate-image construction start concurrently. Every candidate set must pass the authenticated Compose smoke (`yarn studio-server:verify:candidate-images`), which verifies API/web routing, the key gate, executor WebSocket connectivity, and a published workflow execution through the production proxy.

The disposable Kind gate remains mandatory when Helm, Kubernetes launchers, production Compose/deployment scripts, proxy or image contracts, or the image workflow changes, and for version tags, scheduled runs, and manual dispatches. Ordinary main-branch application changes may promote after repository verification, all four builds, and the Compose smoke without paying the Kind startup cost. Promotion accepts a skipped Kind job only when classification explicitly selected this fast path; a full-path release requires a successful Kind result. Scheduled runs and the `run_managed_kubernetes_disruption` workflow-dispatch input use `yarn studio-server:verify:kubernetes:managed-disruption`; the latter adds controlled proxy rollout, execution-node drain, long web-app WebSocket owner-loss/reconnect, App Settings encryption-key rotation, and PostgreSQL/MinIO outage/recovery checks. GitHub runs schedules only from the default branch. Full-gate artifacts remain non-secret manifests, events, pod descriptions, and logs.
After an execution-node drain, the release gate retries the public workflow probe for a bounded 90-second recovery window. A connection that was already attached to the evicted pod may close once during endpoint turnover; the gate still fails if the public route does not recover within the window.

For a deliberate local run, first create the disposable Kind topology and then provide the exact candidate image repositories and digests. The runner will refuse to run unless both context variables exactly match the active context; it also deletes only a namespace carrying its own ownership label.

```bash
kind create cluster --name rivet-managed-release --config deploy/studio-server/scripts/kind-managed-release-cluster.yaml
export RIVET_K8S_RELEASE_GATE_CONTEXT=kind-rivet-managed-release
export RIVET_K8S_RELEASE_GATE_ALLOW_CONTEXT=kind-rivet-managed-release
export RIVET_K8S_RELEASE_GATE_PROXY_IMAGE_REPOSITORY=ghcr.io/<owner>/<repo>/proxy
export RIVET_K8S_RELEASE_GATE_PROXY_IMAGE_DIGEST=sha256:<digest>
# Set the corresponding WEB, API, and EXECUTOR repository/digest variables too.
export RIVET_K8S_RELEASE_GATE_REGISTRY_USERNAME=<registry-user>
export RIVET_K8S_RELEASE_GATE_REGISTRY_PASSWORD=<registry-token>
yarn studio-server:verify:kubernetes:managed-live
```

The default image pull policy is `Always`, which is the required setting for CI
and shared registries. For a disposable local Kind cluster only, load the exact
digest-pinned candidate images into every node and set
`RIVET_K8S_RELEASE_GATE_IMAGE_PULL_POLICY=IfNotPresent`. The gate still requires
and renders each `repository@sha256:digest`; the override changes only whether
Kubernetes contacts a registry for an image already present on the node.

Use `yarn studio-server:verify:kubernetes:managed-disruption` only against this disposable Kind context. Set `RIVET_K8S_RELEASE_GATE_KEEP_NAMESPACE=true` when investigating a failure; otherwise the owned namespace is removed after artifacts are collected.

This gate proves the repository's chart/runtime interaction on Kind. It does not replace staging certification against the real managed PostgreSQL service, object store, ingress controller, TLS, DNS, and network policies used by production.

### Provider-backed staging gate

The disposable Kind gate is the release candidate's cluster contract. The protected provider gate is the separate, manual certification path for the actual ingress controller, DNS, TLS, managed PostgreSQL, S3-compatible storage, and network policy implementation used by a staging environment. It is deliberately not run on every image push: it mutates the selected staging Helm release, so it requires a protected GitHub environment approval and an explicit workflow-dispatch choice.

Create the GitHub environment `rivet-managed-staging`, require the appropriate approvers, and configure:

- repository variable `RIVET_K8S_STAGING_CONTEXT` with the exact kube-context name;
- environment secrets `RIVET_K8S_STAGING_KUBECONFIG_B64`, `RIVET_K8S_STAGING_VALUES_B64`, and `RIVET_K8S_STAGING_CONFIG_B64` as base64-encoded kubeconfig, Helm values, and gate configuration respectively; and, when outage drills are configured, `RIVET_K8S_STAGING_INTERRUPTION_MANIFESTS_TGZ_B64` as a base64-encoded gzip tarball of the referenced NetworkPolicy manifests;
- a protected job token with `packages: write`, plus GHCR package policy that permits the staging cluster to pull the immutable candidate images.

The values file remains an environment-owned Helm overlay. It should reference existing Secrets or Vault paths, not contain plaintext production credentials. The workflow creates the protected file paths from `RUNNER_TEMP` in a shell step after the job starts, because GitHub does not expose `runner.temp` in job-level expressions. The gate configuration is restored only into that runner temporary directory and is never uploaded. Its shape is:

```json
{
  "namespace": "rivet-staging-rivet",
  "release": "rivet-staging",
  "baseUrl": "https://rivet-staging.example.test",
  "requestHeaders": { "authorization": "Bearer <staging-key-or-session>" },
  "workflowProbe": {
    "path": "/workflows/provider-gate",
    "method": "POST",
    "body": { "input": "provider-gate" },
    "contains": "provider-gate"
  },
  "webAppProbe": {
    "path": "/apps/provider-gate",
    "contains": "Provider gate"
  },
  "keyRotation": {
    "currentSecretName": "rivet-settings-old",
    "nextSecretName": "rivet-settings-new",
    "secretKey": "encryptionKey"
  },
  "legacyImport": {
    "probe": {
      "path": "/workflows/legacy-import",
      "method": "POST",
      "body": { "input": "legacy" },
      "contains": "legacy"
    }
  },
  "interruptionManifests": {
    "postgres": {
      "applyFile": "block-postgres.yaml",
      "restoreFile": "block-postgres.yaml",
      "restoreAction": "delete"
    }
  }
}
```

`namespace` must begin with `rivet-staging-`; the runner requires both configured context values to exactly equal the active context and requires `RIVET_K8S_PROVIDER_GATE_CONFIRM=deploy-staging`. It accepts only same-origin HTTPS probes. Each workflow and web-app probe must include a response marker, so a generic 200 page cannot pass as execution evidence.

For each configured dependency outage, put the config-relative Kubernetes manifests in the optional interruption archive under the same relative paths. The workflow rejects archive path traversal and symbolic or hard links before extracting into the runner temporary directory; the runner also rejects missing or symlinked referenced manifests. Each manifest may contain only a `NetworkPolicy` explicitly in that staging namespace. `restoreAction: "delete"` deletes the named test policy after the readiness-failure assertion; `"apply"` applies a separate restoring policy. The runner attempts the restore even if the apply command fails after changing an earlier resource, so a later rejection does not normally leave the configured staging outage in place. This is intentionally narrow: the runner will not execute arbitrary shell commands or apply cluster-scoped resources. Configure the policies to sever only the selected staging dependency, then the gate verifies `/readyz` becomes unready, restores the policy, waits for recovery, and re-runs both workflow and web-app probes.

When `keyRotation` is supplied, the gate writes an unchanged Run recordings settings snapshot to ensure an encrypted row exists, performs the documented old/new, new/old, and new-only Helm rollouts, and reads the same settings after every phase. When `legacyImport` is supplied, the staging release must already exist and retain its legacy PVC during the test. The gate checks the supplied legacy-data probe, rolls back to the preceding Helm revision, checks it again, then reinstalls the candidate and checks both current and legacy probes. This is a staging-only destructive acceptance test, not a recovery recipe for production.

Run it from **Build Images** -> **Run workflow**, enabling `run_managed_kubernetes_provider_gate`. The protected job allows up to 180 minutes because candidate deployment, optional three-phase key rotation, legacy rollback, and outage recovery are each bounded independently; the default Helm operation bound is 15 minutes. The job resolves the candidate images to digests, verifies the rendered release uses them, checks the public ingress host and TLS endpoint, and uploads only workload/manifest/log artifacts under `artifacts/kubernetes-managed-provider-gate`. Candidate Helm upgrades are atomic: a failed rollout rolls the release back instead of leaving a partial failed candidate deployed. The ingress check is restricted to objects owned by the selected Helm release, so an unrelated staging ingress cannot satisfy it. When upgrading an existing staging release, the gate reuses its existing Helm values so omitted values are not reset; a new staging release uses only the supplied values. The gate treats any Helm history error other than an explicitly absent release as a failure, rather than risking an install-style upgrade with no inherited values. The gate labels and owns only its configured registry pull secret (by default, `rivet-managed-provider-gate-registry`) and refuses to overwrite a same-named secret without its ownership label. A first green run is required operational evidence; repository tests can validate this harness but cannot substitute for access to the real provider services.

### Published execution capacity calibration and certificate

`yarn studio-server:verify:kubernetes:managed-capacity` is the protected **staging capacity** command for the high-volume published execution plane. It is not a generic load-test utility and it must never be aimed at production. GitHub **Build Images** has two mutually exclusive manual dispatches, both of which first run the provider gate to deploy the current immutable candidate image set in the protected `rivet-managed-staging` environment:

- `run_managed_kubernetes_capacity_observe` records a baseline in `observe` mode. It never promotes candidate aliases, even if every ordinary release gate succeeds.
- `run_managed_kubernetes_capacity_gate` runs `certify` mode. A failed certificate blocks that manually requested candidate from promotion.

Selecting both inputs fails before any capacity work begins and the provider deployment is not started. An observe run is isolated from the destructive hosted-Evaluation certificate; use a later, explicitly reviewed run for the joint saturation scenario.

The runner requires both the provider-gate acknowledgement (`RIVET_K8S_PROVIDER_GATE_CONFIRM=deploy-staging`) and its separate exact acknowledgement (`RIVET_K8S_CAPACITY_GATE_CONFIRM=certify-staging`). Both configured context variables must exactly match the active context, the namespace must begin `rivet-staging-`, and the live Helm manifest must contain all four requested `repository@sha256:digest` images. It does not upgrade an arbitrary release: the provider gate owns candidate deployment. The capacity runner only adds short-lived owned resources and removes them before returning:

- two uniquely identified temporary projects based on the deterministic Code-plus-Delay fixture, published as one short and one long endpoint;
- one uniquely named ConfigMap containing a non-secret worker configuration;
- when endpoint bearer authentication is enabled, one uniquely named Secret containing only an expiring, endpoint-scoped capability; and
- one single-attempt bounded Job using the candidate API image, explicitly non-root/read-only/capability-free and without a service-account token; and
- the temporary projects, Job, ConfigMap, and disposable capability Secret during cleanup. Cleanup failure fails the run rather than leaving undisclosed staging artifacts.

The worker can construct only `POST /workflows/<safe-generated-endpoint>` URLs. It cannot accept a path, a `/workflows-latest/...` route, an internal execution-service target, arbitrary request headers (the schema rejects `requestHeaders`), or a retry policy. It sends neither a management credential nor a Kubernetes service-account token. When bearer authentication is enabled, the host-side runner derives an HMAC capability from the protected runner credential and places that capability—not `RIVET_KEY`—in a disposable Secret. The capability expires with the Job (at most three hours) and is valid only for the two fixture endpoints; the published route verifies the signature, expiry, and normalized endpoint name. The ConfigMap and JSON report cannot contain it. The normal `/workflows-latest/...` route never accepts it. This preserves the proxy-to-execution public-runtime proof while keeping the shared key out of the Job and its artifacts.

Add a `capacity` object to the existing protected provider-gate JSON. Keep the JSON, request headers, kubeconfig, and Helm values in the protected environment secrets; do not commit them.

```json
{
  "capacity": {
    "serviceNamePrefix": "rivet-staging",
    "requestTimeoutMs": 30000,
    "controlCanaryEveryRequests": 10,
    "controlCanaryTimeoutMs": 5000,
    "sampleIntervalMs": 5000,
    "jobTimeoutSeconds": 900,
    "requireExecutionMetrics": true,
    "prometheus": {
      "baseUrl": "https://prometheus.staging.example.test",
      "headers": { "authorization": "Bearer <prometheus-read-token>" },
      "queries": {
        "memoryHighWaterBytes": "max(container_memory_working_set_bytes{app_kubernetes_io_name=\"rivet\"})",
        "nodeEphemeralHighWaterBytes": "max(container_fs_usage_bytes{app_kubernetes_io_name=\"rivet\"})",
        "downstreamConcurrency": "sum(rivet_provider_requests_in_flight)"
      }
    },
    "stages": [
      { "name": "warmup", "scenario": "fast", "expect": "success", "concurrency": 4, "requests": 40 },
      { "name": "steady", "scenario": "long", "expect": "success", "concurrency": 12, "requests": 120 },
      { "name": "overload", "scenario": "long", "expect": "overload", "concurrency": 48, "requests": 160 }
    ],
    "thresholds": {
      "maximumP95Ms": { "warmup": 3000, "steady": 10000, "overload": 15000 },
      "maximumUnexpectedRate": 0.01,
      "maximumControlCanaryFailureRate": 0,
      "maximumRecordingDrops": 0
    }
  }
}
```

`serviceNamePrefix` is optional: omit it when the chart service prefix is the Helm release name, or set it to the actual service prefix when the staging Helm values use `fullnameOverride`; it identifies the proxy and control API ClusterIP Services. Stage names are unique lowercase DNS fragments; each stage is capped at 256 concurrent workers and 20,000 requests, with a 50,000-request cap for the whole run. At least one stage must explicitly expect overload. `fast` uses a 75 ms deterministic graph and `long` uses a 1.5 s deterministic graph. They intentionally prove request scheduling, admission, recording persistence, proxy routing, and Code-node execution without invoking an external LLM, tool, or provider. Add provider/tool scenarios only after their data, idempotency, and cost boundaries are separately approved.

Before certification, enable direct execution metrics in the staging values:

```yaml
metrics:
  enabled: true
```

The operator identity also needs read access to execution Pods and Events plus Kubernetes API pod-proxy access for `pods/<name>:8080/proxy/metrics`. Metrics remain internal ClusterIP endpoints; this does not publish `/metrics` through the proxy. Each sample records bounded active-run/admission gauges, recording queue, and per-Pod drop counters compared with the pre-load baseline (a Pod first seen after the baseline uses zero), plus per-Pod restart/OOM evidence and eviction events. The Job makes a direct backend `/readyz` control canary at the configured interval while the proxy receives load. The report includes p50/p95/p99, exact status counts, rejected/failed/timeout counts, canary outcomes, metric samples, pod-event evidence, the selected stage thresholds, and the immutable candidate image references. It excludes request headers, raw request bodies, prompts, outputs, and provider credentials.

The observe dispatch sets `RIVET_K8S_CAPACITY_GATE_MODE=observe` and uploads both sanitized `capacity-report.json` and `capacity-review.md`. The review summarizes only stage latencies/outcomes, aggregate safety signals, and external high-water observations; it never contains headers, PromQL, credentials, project content, prompts, or outputs. It derives restart counts as the per-Pod increase from the pre-load baseline and de-duplicates newly observed OOM/eviction Pods, so repeated sampling cannot inflate incident counts. It also records the mandatory review decisions: validate query scope, compare several representative runs, then propose explicit resource, admission, and HPA values through normal review. A missing, unsupported, or incomplete report stays diagnostic and cannot support sizing or promotion.

The certificate dispatch sets `RIVET_K8S_CAPACITY_GATE_MODE=certify`. Certification requires `requireExecutionMetrics: true`, the `capacity.prometheus` block, and a complete report whose stage names, request totals, outcome totals, and control-canary counts exactly match the declared configuration. A scheduling-edge sample with no execution Pod is retained as evidence but does not require metrics; every sampled live execution Pod must have all three external high-water values as one finite Prometheus vector sample. The gate otherwise fails if a required event/Prometheus sample is unavailable, a stage exceeds its p95 or unexpected-result limit, a control canary fails, recording drops increase beyond the limit, an overload stage never receives visible `429` admission rejection, or a new restart/OOM/eviction occurs after the baseline sample. Both modes require the exact staging acknowledgement and refuse non-staging contexts. On every normal finalization path, the gate writes `capacity-report.json`, including setup, scheduling, Job, and cleanup failures: it records the completed phase, available Pod snapshots and report data, plus cleanup outcome and only a failure class—not a raw exception, request header, PromQL expression, or credential. If writing the local evidence artifact itself fails, the command fails explicitly rather than claiming a certificate. The separate diagnostic logs retain the bounded command context.

This certificate is deliberately not proof of final production sizing. It records provider-side memory/node-ephemeral high-water and downstream concurrency when certifying, but it does not infer safe limits or provider/tool correctness from one run. Retain the provider charts and JSON report together. Do not change HPA bounds, admission ceilings, Evaluation quotas, placement, or resource limits automatically from one run. First establish a stable staging envelope, then promote explicit values through normal review. The separate hosted-Evaluation certificate probes public traffic while Evaluation work is active; the optional joint dispatch adds the bounded high-concurrency case, but it still needs retained staging evidence before it can support final public-SLO claims.

### Cross-store backup and restore drill

`yarn studio-server:verify:kubernetes:managed-restore` is the protected **operator** command for disaster-recovery evidence. It deliberately does not create database snapshots or object copies itself: PostgreSQL PITR/snapshot creation, object-store version retention, and encrypted-key backup are provider-owned controls. The command takes their recovery point as input, restores it through provider-owned Kubernetes Jobs, and verifies that the restored stores work together.

Run the command only from the exact clean checkout named by the promoted release manifest captured with the backup. The runner rejects a dirty or different checkout, a chart-digest mismatch, a non-promoted release, a context that does not exactly match its allowlist, a missing `RIVET_K8S_RESTORE_DRILL_CONFIRM=restore-disposable-target` acknowledgement, or any target namespace that already exists. It creates only a namespace beginning `rivet-restore-` with the drill ownership label in the same Kubernetes create request, deploys only the manifest's immutable image digests, then rechecks that live ownership label before it removes the Helm release, runs the provider cleanup Job, deletes the namespace, and waits up to five minutes for that deletion to finish. The runner reads each provider driver YAML once, validates that exact in-memory document as one owned no-retry Job, then applies that same document; a driver Job that reports failure fails immediately instead of consuming its full timeout. It never contacts the source namespace, database, bucket/prefix, or hostname after the provider driver has received its declared recovery point.

The protected, non-secret configuration file and Helm values are environment-owned. Keep credentials, kubeconfigs, authenticated probe headers, backup credentials, and key values out of Git. A restore target must use all-new identities: namespace, Helm release, a non-local HTTPS DNS hostname (including a non-production OAuth callback configuration), database identifier, and object-storage bucket/prefix. Hostname, database identifier, and bucket separation are checked without trusting letter case; hostname comparison also canonicalizes DNS trailing dots, so reusing the source hostname on another HTTPS port or as a fully-qualified DNS name is still rejected. Every HTTP probe refuses redirects, so a misrouted target cannot obtain success from another host. The backup manifest has this exact shape; `release` is the existing promoted Studio Server release manifest, not a tag:

```json
{
  "formatVersion": 1,
  "createdAt": "2026-08-29T04:00:00.000Z",
  "source": {
    "namespace": "rivet-production",
    "baseUrl": "https://rivet.example.com"
  },
  "release": "<complete promoted Studio Server release manifest>",
  "database": {
    "provider": "managed-postgres",
    "sourceId": "rivet-production-postgres",
    "recoveryPointId": "provider-snapshot-or-pitr-id",
    "recoveryPointAt": "2026-08-29T03:55:00.000Z"
  },
  "objectStorage": {
    "provider": "s3-compatible",
    "bucket": "rivet-production-artifacts",
    "prefix": "rivet/production",
    "recoveryPointId": "object-version-set-id",
    "recoveryPointAt": "2026-08-29T03:55:00.000Z",
    "versioningRetentionSeconds": 604800
  },
  "appSettings": {
    "encryptionKeyIds": ["0123456789abcdef"]
  }
}
```

`release` must be an object with the complete promoted manifest created by the release pipeline; the string above is only a documentation placeholder. The manifest accepts no extra fields, so credentials and key material cannot be accidentally placed in the backup receipt. Object version retention must be at least the requested maximum RPO. The App Settings identifiers are the 16-character derived key IDs stored in PostgreSQL, never the key values themselves.

The restore configuration supplies the manifest, distinct target, objective, authenticated probes, and three provider Jobs:

```json
{
  "backup": "<backup-manifest object above>",
  "target": {
    "namespace": "rivet-restore-20260829",
    "release": "rivet-restore",
    "baseUrl": "https://rivet-restore.example.net",
    "databaseId": "rivet-restore-postgres",
    "objectStorage": { "bucket": "rivet-drills", "prefix": "2026-08-29" }
  },
  "objectives": { "maximumRpoSeconds": 86400, "maximumRtoSeconds": 7200 },
  "requestHeaders": { "authorization": "Bearer <restore-target-only credential>" },
  "probes": {
    "appSettings": { "path": "/api/app-settings/run-recordings", "contains": "retentionDays" },
    "oauth": { "path": "/api/app-settings/web-app-auth", "contains": "provider" },
    "project": { "path": "/api/...", "contains": "synthetic-restored-project" },
    "workflow": {
      "path": "/workflows/restored",
      "method": "POST",
      "body": { "input": "restore" },
      "contains": "restored-workflow"
    },
    "webApp": { "path": "/apps/restored", "contains": "Restored web app" },
    "recording": { "path": "/api/...", "contains": "synthetic-restored-recording" },
    "evaluation": { "path": "/api/...", "contains": "synthetic-restored-evaluation" },
    "runtimeLibrary": { "path": "/api/...", "contains": "synthetic-restored-library" }
  },
  "restoreDriver": { "applyFile": "restore.yaml", "jobName": "restore-driver", "timeoutSeconds": 1800 },
  "integrityDriver": { "applyFile": "integrity.yaml", "jobName": "integrity-driver", "timeoutSeconds": 900 },
  "cleanupDriver": { "applyFile": "cleanup.yaml", "jobName": "cleanup-driver", "timeoutSeconds": 900 }
}
```

Every `applyFile` is a regular, non-symlink file below the config directory. It must render exactly one `batch/v1` Job in the restore namespace, with `backoffLimit: 0`, `restartPolicy: Never`, `rivet.restore-drill/owned: "true"`, and the matching `rivet.restore-drill/role` of `restore`, `integrity`, or `cleanup`. The restore driver uses environment-owned workload identity/Vault/provider credentials to restore the named PostgreSQL point and object version set to the target. It writes one non-secret final log line:

```text
RIVET_RESTORE_DRIVER_REPORT={"formatVersion":1,"completedAt":"...","database":{"recoveryPointId":"...","targetId":"...","managedWorkflowSchemaVersion":3},"objectStorage":{"recoveryPointId":"...","bucket":"...","prefix":"...","objectsRestored":42},"encryptionKeyIds":["0123456789abcdef"]}
```

The integrity driver must inspect database-owned object references against the restored object store, report missing references and orphan count, and run a negative fixture: remove one known synthetic referenced object, prove it is reported missing, restore it, then emit:

```text
RIVET_RESTORE_INTEGRITY_REPORT={"formatVersion":1,"checkedAt":"...","referencedObjectCount":42,"missingReferences":[],"orphanObjectCount":3,"negativeProbe":{"missingReference":"...","detected":true,"restored":true}}
```

The restore and integrity reports must each prove positive object recovery/reference counts; this prevents a nominal drill from skipping object-backed recordings and runtime libraries. Any nonempty `missingReferences` fails the drill with the exact object IDs. Orphans are counted rather than automatically deleted. The app-settings and OAuth probes must read restored encrypted rows, so a missing declared App Settings key cannot be hidden by a nominal HTTP success. The report records exact release/schema/key IDs, both provider recovery IDs, target identity, actual RPO from the oldest restored store point, and end-to-end RTO. A run is marked passed only after the owned namespace deletion is confirmed; a failure report records only the controlled failure stage and cleanup status, while raw command diagnostics stay in protected operator logs. It never contains request headers, credentials, key material, or raw provider-driver logs.

Start with a synthetic disposable provider project, then a sanitized production-shaped backup. Preserve the last successful JSON report in the operations evidence store and record the owner, frequency, retention windows, RPO/RTO objectives, and source release. Do **not** schedule the command until that protected operating procedure and target-cleanup ownership are approved: scheduling a provider-credentialed restore is an operational authorization, not a source-code default.

## Managed workflow schema migrations

Managed workflow DDL is versioned and serialized separately from ordinary API startup:

- `managed_workflow_schema_migrations` records each immutable migration version, name, SHA-256 checksum, application version, and application time.
- Each migration runs in a PostgreSQL transaction behind a repository-specific `pg_advisory_xact_lock`, with bounded lock and statement timeouts. The migration library retries only PostgreSQL lock-timeout, deadlock, and serialization failures, and every retry starts a new transaction; callers retain the existing bounded retry for connection-level network failures.
- Existing databases from releases before the ledger are baselined by rerunning migration 1 idempotently, validating every migration-1 table column type/nullability and required default, required table DML privileges with row-level security disabled, exact operational-index signature and usable catalog state, semantic and validated primary/unique/foreign-key/check constraint with usable primary/unique backing indexes, plus the schema-qualified folder-move function's body, execution signature, and API-role execute privilege, and then recording version 1 in the same transaction.
- Local Docker and simple managed single-process deployments default to startup mode `migrate`, preserving their automatic first-run behavior.
- Kubernetes API pods are forced into `verify` mode after Vault dotenv loading. They take a shared advisory lock, validate the ledger/checksum and critical schema shape, and fail startup with a precise compatibility error instead of applying DDL.

The chart owns migration execution through the `workflow-schema-migration` Helm hook Job. It runs `pre-install,pre-upgrade` with the candidate API image. The Job bootstraps candidate deployment-storage settings into an isolated `emptyDir`, runs workflow schema migration with the file settings backend so migration 2 can create `app_settings`, then enables the PostgreSQL backend and seeds each absent domain from its matching regular, valid legacy JSON file when available. Both phases reuse one rendered database credential set; the Job does not declare duplicate database environment names. A missing, malformed, symlinked, or non-file legacy entry leaves that domain on the candidate bootstrap/default instead of replacing the whole bootstrap root. Serving pods remain verify-only. Vault injection is pre-populate-only and explicitly init-first, so the injected agent renders `/vault/dotenv` before this Job sources it and no sidecar can keep the one-shot hook alive. A successful hook is deleted; a failed hook remains for logs and blocks the release.

For a normal chart install, keep:

```yaml
workflowSchema:
  migrationJob:
    enabled: true
    backoffLimit: 2
    activeDeadlineSeconds: 600
```

Set `workflowSchema.migrationJob.enabled=false` only when an external delivery pipeline runs the exact candidate API image's schema command before Helm rolls API pods. API pods remain verify-only in that mode; disabling the Job without an external migration makes an install or upgrade fail closed.

### Managed maintenance

Migration 3 adds the managed-maintenance lease and durable object-deletion outbox. Migration 4 adds durable reconciliation checkpoints and integrity findings. Migrations 5 through 7 add the hosted-Evaluation coordinator, outstanding-work index, and Evaluation-retention indexes. Migration 8 adds the nullable workflow-recordings correlation_id with a 16-to-96-character database check. Migration 9 adds non-negative per-domain active and last-completed object-inventory byte totals to reconciliation state. Migration 10 adds the partial terminal-row index that bounds web-app action transport retention. A normal release verifies exactly the current schema version, presently `10`, and its migration Job applies that exact version before serving pods start. Every current migration is additive, but a guarded **forward rollback** must satisfy two independent checks: the target is the candidate manifest's canonical predecessor, and that predecessor API accepts the candidate's declared schema window. Never copy a historical `2..4` window, select an older ancestor merely because its schema is in range, or widen a normal serving release to bypass verification.

Only the singleton `control` API pod receives `RIVET_MANAGED_MAINTENANCE_ENABLED=true`. The scalable `execution` Deployment receives `false`, so published endpoint traffic cannot create one global retention scan per replica or allocate the reconciliation-only runtime-library S3 client. Helm owns this boundary and the `managedMaintenance.intervalMs` (default `300000`), `leaseMs` (default `60000`), and `batchSize` (default `100`) values; `env` overrides for those variables are rejected. The worker uses a PostgreSQL fencing token, so a stale control pod cannot commit the recording-retention mutation after a successor owns the lease. Each pass selects candidates in PostgreSQL and removes at most `batchSize` recording rows while holding the fence, so a large backlog converges without loading its history into the API process or using one unbounded transaction. Recording/replay object keys are queued in the same transaction as removed metadata, then deleted only after a fresh database-reference recheck. Temporary blob-store failures retry with exponential backoff; still-referenced keys become `blocked` rather than being removed. A later deletion intent reopens a blocked key, because its final reference may have been removed after the earlier safety check.

The same fenced pass also runs a bounded, **audit-only** reconciliation page for each domain. Workflow metadata is checked with object `HEAD` requests; workflow and runtime-library prefixes are listed only as candidate sources; and Evaluation recording rows are checked for a parent Evaluation run. A missing referenced object or a missing Evaluation parent creates durable integrity evidence. An unreferenced workflow/runtime object must be at least 24 hours old and appear in two completed scans before it is eligible for any policy. The reconciler itself never deletes an object and never enqueues the deletion outbox. It stores prefix-relative last-key checkpoints and raw subjects only in PostgreSQL; the checkpoints never depend on provider continuation tokens. Fenced, committed object-list pages add only their returned metadata sizes to the durable active or last-completed generation total; this is inventory size, not payload-download or provider-billing usage. Logs, metrics, and status use finite aggregate summaries and never expose object keys.

Detailed reconciliation subjects stay out of metrics, ordinary status output, and logs. An authenticated control-plane operator can inspect one bounded page through `GET /api/workflows/maintenance/reconciliation/findings?state=open&domain=workflows&pageSize=50&offset=0`. The endpoint exists only for managed workflow storage, limits `pageSize` to 100 and `offset` to 10,000, and returns raw subject keys only in its authenticated response; it is deliberately not a dashboard or public endpoint.
This timer owns managed endpoint-recording retention plus explicit recording/project deletion. Known blobs that a request uploaded but failed to attach to durable metadata also enter this outbox before any direct delete is attempted; if PostgreSQL cannot accept that intent, Rivet leaves the object untouched rather than risking a duplicate-key delete of a live artifact. It also owns the separately reviewed workflow stale-upload policy. Helm exposes `staleUploadRetention` with `mode: audit`, `minimumCandidateAgeHours: 24`, and `requiredCompletedScans: 2`. Audit mode reports only finite eligible/ineligible candidate gauges. An operator may choose `enforce` only after reviewing retained findings and metrics; each enforce pass locks one bounded candidate page, so a candidate that became referenced again is considered once without preventing later safe candidates in that page from being reviewed. Enforcement accepts exactly Rivet-created revision/recording artifact key shapes, requires the configured age from the current uninterrupted open finding (a resolved finding starts that clock again), repeats the live workflow-metadata reference query in the same fenced transaction, then queues the typed `workflow-stale-upload-reconciliation` intent. The outbox repeats the reference check immediately before the blob delete. Switching back to `audit` or `disabled` blocks pending stale-upload intents instead of deleting them. Unknown outbox reasons fail closed, and object keys/provider errors remain in authorized durable records rather than ordinary logs. It also owns short-lived terminal web-app action **transport** rows: these are reconnect/cancellation state, not Run recordings. The chart starts `webAppActionRetention` in `audit` mode, reports a bounded candidate gauge, and requires the same PostgreSQL fence plus a terminal/age recheck before an operator enables `enforce`. It also owns the separate P10-C Evaluation lifecycle: expired temporary replays and unreferenced dataset snapshots are observed in `audit` mode by default. Only after retained candidate evidence may an operator select `evaluationRetention.mode: enforce`; its destructive worker locks bounded recording/snapshot candidate pages, then still excludes active hosted work and failure, baseline, or manually retained replays. The audit does not replace the runtime-library cleanup command or authorize future object-store payload domains. Those domains require their own retention policy, reference adapter, protected-artifact tests, and an explicitly reviewed deletion phase.
Outside Kubernetes, the equivalent operator commands are:

```bash
yarn studio-server:workflow-schema:migrate
yarn studio-server:workflow-schema:verify
yarn studio-server:managed-reconciliation:status
```

`managed-reconciliation:status` is a read-only managed-PostgreSQL operator command. It reports every domain, explicitly marks a fresh database as `not-started`, and otherwise reports phase, completed generation, active and last-completed object-inventory bytes, error timestamps, and aggregate finding counts. It intentionally never prints object keys, prompts, run payloads, or credentials. Run it from a control-plane environment with the same managed-storage configuration and database credentials as the API.

These commands migrate PostgreSQL schema only. They are distinct from `workflow-storage:migrate` / `workflow-storage:verify`, which copy and compare workflow data between filesystem and managed storage.

Recovery rules:

- If the hook times out or loses its database connection, inspect the retained Job logs and rerun the release after fixing connectivity. Transaction rollback plus migration ids/checksums make a retry safe.
- Do not edit migration ledger rows or change released migration SQL to bypass a checksum mismatch. Deploy a compatible image or add a new corrective migration.
- A database with a future migration version must not be served by an older image. Roll forward to a compatible image; database rollback requires an explicitly designed backward migration and should not be improvised.
- Add future schema work as a new ordered migration in `schema-migrations.ts`. Keep overlapping releases compatible with expand-and-contract changes; defer destructive contraction until old pods cannot still be running.

Useful commands:

- `yarn studio-server:dev:kubernetes-test:config`
- `yarn studio-server:dev:kubernetes-test:ps`
- `yarn studio-server:dev:kubernetes-test:logs`
- `yarn studio-server:dev:kubernetes-test:down`

Useful Minikube-specific overrides:

- `RIVET_K8S_CONTEXT=minikube`
- `RIVET_K8S_CLUSTER_PROVIDER=minikube`
- `RIVET_K8S_MINIKUBE_PROFILE=minikube`
- `RIVET_K8S_MINIKUBE_BIN=/path/to/minikube`

Helm resolution order for the local launcher and `yarn studio-server:verify:kubernetes` is:

1. `RIVET_K8S_HELM_BIN`
2. system `helm`
3. cached Helm under `.data/tools/helm/`

If none of those exist, the launcher/verification flow fails with an explicit instruction to run `yarn studio-server:setup:k8s-tools`.

## DevOps handoff map

This repo is already shaped like a Kubernetes application, but it is not the single-container sample chart shape. Treat it as a custom four-workload app:

| DevOps expectation                            | This repo                                                                                                                                                                                                                                                                                          |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Root `deploy/studio-server/images/` directory | Present. It contains four runtime images: `deploy/studio-server/images/proxy/Dockerfile`, `deploy/studio-server/images/web/Dockerfile`, `deploy/studio-server/images/api/Dockerfile`, and `deploy/studio-server/images/executor/Dockerfile`.                                                       |
| Application user `uid/gid=10001`              | Present. Runtime images and chart security contexts run workloads as `10001:10001`.                                                                                                                                                                                                                |
| Environment overlays                          | Present under [deploy/studio-server/helm/overlays](../../deploy/studio-server/helm/overlays). If your GitLab template requires `deploy/overlays`, point that wrapper at these values or copy environment overrides from here; do not replace the custom chart with a generic single-service chart. |
| Helm chart                                    | Present under [deploy/studio-server/helm](../../deploy/studio-server/helm). It renders `proxy`, `web`, singleton `backend`, scalable `execution`, services, ingress, HPAs, Vault annotations, and validation guards.                                                                               |
| CI image build                                | Current publishing is GitHub Actions at [.github/workflows/studio-server-images.yml](../../.github/workflows/studio-server-images.yml). If deploying from GitLab CI, create equivalent jobs for all four Dockerfiles or reuse the published GHCR images.                                           |
| Vault AppRole                                 | The chart uses Vault Injector annotations through `vault.role`, `vault.authPath`, `vault.secretPath`, and `vault.dotenvTemplate`. The containers source `/vault/dotenv` during startup.                                                                                                            |

Do not deploy this app with a generic one-Deployment chart unless that chart can faithfully express the four workload roles and their routing:

- public browser traffic enters `proxy`
- dashboard/editor assets come from `web`
- `/api/*`, latest workflow execution, and `/ws/latest-debugger` go to singleton `backend`
- published workflow endpoint traffic goes to scalable `execution`
- the internal editor Node executor websocket goes to the executor sidecar in the singleton `backend`

If company delivery requires a root `.gitlab-ci.yml`, treat the current GitHub workflow as the image-publish reference and the Helm values in this document as the deploy reference. The GitLab pipeline must either:

- reuse the published GHCR images and only run Helm deploy stages, or
- build and push four images, one per Dockerfile, then pass the resulting repositories and one shared tag through `images.*`

Environment-specific Vault AppRoles from CI should line up with the chart values:

- CI/deploy credentials belong in the GitLab pipeline template
- the pod runtime Vault role belongs in `vault.role`
- the Vault auth mount, when not default, belongs in `vault.authPath`
- the secret rendered into `/vault/dotenv` belongs in `vault.secretPath`

Do not use `vault.roleIdSecretName`; that value is retired and the chart rejects it during render.

## Cluster prerequisites

Have these ready before the first `helm upgrade --install`:

- a `linux/amd64` node pool, unless the API and executor images are rebuilt for another platform
- an ingress controller that supports websocket upgrades and long-lived websocket connections
- DNS for the public Rivet hostname and a TLS secret or certificate-manager integration
- a Kubernetes Secret or Vault value for the App Settings encryption key; the shared `RIVET_KEY` works only as a compatibility fallback
- managed Postgres reachable from the cluster
- the provider's PostgreSQL `max_connections` value, so `postgres.maxConnections` can describe real capacity instead of an estimate
- S3 or S3-compatible object storage reachable from the cluster
- Vault Injector installed when `vault.enabled=true`
- `metrics-server` or equivalent resource metrics if the CPU HPAs are enabled
- GHCR image-pull access, either anonymous for public images or `imagePullSecrets` for private packages

The pods need outbound network access to Postgres, object storage, Vault, and GHCR during image pulls. The proxy also needs in-cluster DNS resolution through `env.RIVET_PROXY_RESOLVER`; the default value is `kube-dns.kube-system.svc.cluster.local`.

## Production handoff

The production starting point is [deploy/studio-server/helm/overlays/prod.yaml](../../deploy/studio-server/helm/overlays/prod.yaml).

Before DevOps installs it, they must replace or confirm:

- `images.*.repository` and `images.*.tag`
- `clusterDomain` if the cluster does not use `cluster.local`
- ingress hostnames and DNS annotations
- Vault role, secret path, and dotenv template if Vault is used
- managed Postgres secret wiring
- `postgres.maxConnections`, `postgres.reservedConnections`, and `postgres.poolMaxPerApiPod` against the provider's actual database limit and the execution HPA maximum
- object-storage bucket, region, endpoint, and secret wiring
- `auth.keySecretName` or equivalent Vault-provided `RIVET_KEY`
- `writableVolumeLimits.*` from measured workspace, workflow, app-data, and runtime-library high-water marks
- for every workload, complete memory and node-ephemeral-storage request/limit pairs, or the documented temporary rationale under `resourceLimitAcknowledgements`; remove an acknowledgement as soon as its measured limit is supplied

The chart defaults deliberately use `example.invalid/...` image repositories and the templates fail validation until those placeholders are replaced. This keeps production installs from silently using stale or accidental images.

The Rivet 2 wrapper image pipeline publishes the default GitHub Container Registry repositories as:

```yaml
images:
  proxy:
    repository: ghcr.io/valerypopoff/rivet2.0-studio-server/proxy
    tag: latest
  web:
    repository: ghcr.io/valerypopoff/rivet2.0-studio-server/web
    tag: latest
  api:
    repository: ghcr.io/valerypopoff/rivet2.0-studio-server/api
    tag: latest
  executor:
    repository: ghcr.io/valerypopoff/rivet2.0-studio-server/executor
    tag: latest
```

The `rivet2.0-studio-server/*` packages are owned by this monorepo; the retired `cloud-hosted-rivet2-wrapper/*` packages are not release targets. The `latest` tag is promoted only from the current `main` head; commit-SHA and version-tag image tags are produced by the same workflow. All four images build from one monorepo commit, first publish under the attempt-isolated `candidate-<commit SHA>-<run ID>-<attempt>` tag, and receive public tags only after the complete image matrix and release gates succeed. This prevents a rerun from overwriting another candidate before its gates resolve; promotion then resolves each candidate to its immutable OCI digest. Runs for the same Git ref are serialized, and the final alias step re-reads `main`, so overlapping pushes or a delayed scheduled/manual run cannot race an older image set back onto `latest`.
Tags remain convenient for local and rehearsal installs. Production must use the promoted release manifest described below; it supplies the exact digest for every image and the chart rejects tag-only production values.
If the GHCR packages are private, configure `imagePullSecrets`; public packages should pull anonymously.

Current published image platforms:

- `proxy` and `web`: `linux/amd64` and `linux/arm64`
- `api` and `executor`: `linux/amd64`

Run the production chart on `linux/amd64` nodes unless the API and executor images are rebuilt for another platform.

### Environment values skeleton

Use this as the shape for an environment override file, whether your pipeline stores it as `deploy/studio-server/helm/overlays/prod.yaml`, `deploy/studio-server/helm/overlays/test.yaml`, or a company-standard `deploy/overlays/<env>.yaml` wrapper:

```yaml
fullnameOverride: rivet

imagePullSecrets:
  # Required only when the GHCR packages are private.
  # - name: ghcr-pull-secret

images:
  proxy:
    repository: ghcr.io/valerypopoff/rivet2.0-studio-server/proxy
    tag: <published-tag> # Or set digest: sha256:<immutable-manifest>.
  web:
    repository: ghcr.io/valerypopoff/rivet2.0-studio-server/web
    tag: <published-tag> # Or set digest: sha256:<immutable-manifest>.
  api:
    repository: ghcr.io/valerypopoff/rivet2.0-studio-server/api
    tag: <published-tag> # Or set digest: sha256:<immutable-manifest>.
  executor:
    repository: ghcr.io/valerypopoff/rivet2.0-studio-server/executor
    tag: <published-tag> # Or set digest: sha256:<immutable-manifest>.

ingress:
  enabled: true
  className: <ingress-class>
  host: <rivet-hostname>
  externalDNSHostname: <rivet-hostname>
  tlsSecretName: <tls-secret-name>
  annotations:
    # Use the equivalent long-timeout/websocket annotations for the target ingress controller.
    nginx.ingress.kubernetes.io/proxy-body-size: 100m
    nginx.ingress.kubernetes.io/proxy-read-timeout: '86400'
    nginx.ingress.kubernetes.io/proxy-send-timeout: '86400'

vault:
  enabled: true
  role: <vault-approle-name>
  authPath: <vault-auth-path>
  secretPath: <vault-secret-data-path>
  tlsSkipVerify: false
  caSecretName: <vault-ca-secret>
  caCertPath: /vault/tls/ca.crt
  dotenvFileName: dotenv
  dotenvTemplate: |
    {{- with secret "<vault-secret-data-path>" -}}
    {{- range $key, $value := .Data.data }}
    {{ $key }}={{ $value | toJSON }}
    {{- end }}
    {{- end }}
  # Keep this small-dotenv injector bounded; do not use it for large files.
  agentResources:
    requests:
      cpu: 50m
      memory: 64Mi
      ephemeral-storage: 64Mi
    limits:
      cpu: 250m
      memory: 128Mi
      ephemeral-storage: 256Mi

postgres:
  mode: managed
  # Must equal the provider-side max_connections value.
  maxConnections: 200
  # Kept free for migration Jobs, provider administration, and incident access.
  reservedConnections: 30
  # Shared query-pool connections available to each API process.
  poolMaxPerApiPod: 10
  host: <postgres-host>
  port: 5432
  database: <postgres-database>
  username: <postgres-username>
  sslMode: require
  # If Vault is disabled, also set passwordSecretName/passwordSecretKey

objectStorage:
  endpoint: <s3-or-compatible-endpoint>
  bucket: <bucket-name>
  region: <bucket-region>
  prefix: workflows/
  forcePathStyle: false
  # If Vault is disabled, also set accessKeySecretName and secretKeySecretName

auth:
  # If Vault is disabled, set keySecretName/keySecretKey.
  # If Vault is enabled, /vault/dotenv may provide RIVET_KEY instead.
  keySecretName: ''

metrics:
  # Enable only with an internal scraper/NetworkPolicy plan.
  enabled: false
  serviceMonitor:
    enabled: false
  prometheusRule:
    enabled: false

resources:
  proxy:
    requests:
      cpu: 100m
      memory: 128Mi
  execution:
    requests:
      cpu: 500m
      memory: 1Gi
```

The chart ships baseline CPU and memory requests for every workload so CPU HPAs have a real denominator. Treat them as a starting point: load-test representative workflows, observe CPU, memory, temporary-storage use, request latency, and external-provider latency, then tune requests and HPA targets. A generic hard memory limit can kill a valid long-running workflow during a temporary peak, so the chart does not pretend that one default fits every environment.

Helm validates every chart-owned integer that becomes a runtime limit or a Kubernetes integer field from its raw value. This rejects fractional native YAML/JSON values instead of allowing Helm's `int` conversion to truncate them before the pod starts. The coverage includes hosted Evaluation quotas, published-execution admission, PostgreSQL pool/capacity values, API replica and HPA bounds, lifecycle/probe settings, schema/maintenance controls, and availability settings. Component service and database ports must also be whole TCP ports in the `1`–`65535` range. Keep these fields as ordinary whole numbers in environment overlays and generated release values; do not rely on `--set-json` or a JSON/YAML value being coerced safely.

Every chart-managed disposable writable volume is nevertheless bounded: `writableVolumeLimits` caps workspace, workflow materialization, app-data projections, and runtime-library cache storage; the existing `tmpVolume.sizeLimit` caps `/var/tmp`. These prevent a single pod from consuming unbounded node ephemeral storage, but their starting values are not capacity evidence.

For a production release, Helm requires each of `proxy`, `web`, `api`, `executor`, and `execution` to provide either both memory request/limit and both `ephemeral-storage` request/limit values, or a non-trivial component-specific explanation under `resourceLimitAcknowledgements`. Those values must be Kubernetes quantity strings (for example `750Mi`, `2Gi`, or `1G`); Helm rejects non-string values and common unsupported quantity forms before a release reaches the cluster, while Kubernetes remains the final admission authority. The acknowledgement is a deliberate temporary decision, not a second configuration source: Helm rejects it once the corresponding complete resource policy exists. The supplied production overlay records the current measured-limit deferral explicitly. Replace those explanations with tested values after the published-route capacity gate.

The sample `service.type: NodePort` / single `service.targetPort` pattern from simple apps does not apply here. This chart creates component services internally, keeps them as `ClusterIP`, and routes ingress to the `proxy` service.

`nginx.ingress.kubernetes.io/proxy-body-size` is the ingress-side ceiling. If App Settings -> `Web apps` -> `Button data` is set above `100 MiB`, raise this annotation to the same or a larger value too; the running app can reload its own proxy configuration but cannot rewrite an ingress controller's annotations.

If you are adapting a standard single-app overlay, do not expect these sample keys to do anything until the chart explicitly supports them:

- `writableDirs`
- `sidecar`
- `probes`
- `strategy`
- `topologySpreadConstraints`
- `pdb`
- single-service `hpa`

Use this chart's existing `autoscaling.proxy`, `autoscaling.execution`, `resources.*`, `ingress`, `vault`, and component `service.*` values instead. Add new chart support intentionally if the cluster standard requires one of the unsupported knobs.

### Prometheus metrics and alerts

The API has an opt-in, pull-only Prometheus text endpoint at `/metrics`, exposed by the direct `api` and `execution` **ClusterIP** Services. The proxy has a separate opt-in exporter: it reads only NGINX aggregate `stub_status` counters over Pod-local loopback and exposes `/metrics` only on an internal proxy-Service port. Neither surface is routed through the public proxy listener or Ingress. API scrapes do not open PostgreSQL connections, call object storage, or create a worker; every source is collected independently, and telemetry failure cannot change workflow execution, recording persistence, readiness, or the remaining scrape data.

Enable the endpoint only after deciding how the monitoring namespace is allowed to reach those services:

```yaml
metrics:
  enabled: true
  proxyExporter:
    # Optional aggregate NGINX process counters; no routes, inputs, or IDs.
    enabled: true
  serviceMonitor:
    enabled: true
    interval: 30s
    scrapeTimeout: 10s
    # Add the label required by the installed Prometheus Operator, if any.
    additionalLabels:
      release: kube-prometheus-stack
  # Start disabled. Enable only after observing the rule thresholds in staging.
  prometheusRule:
    enabled: false
    for: 10m
    additionalLabels:
      release: kube-prometheus-stack
  # Optional ConfigMap definitions for an operator-provided Grafana importer.
  # This neither installs Grafana nor enables any scrape.
  grafanaDashboards:
    enabled: true
    additionalLabels:
      grafana_folder: Rivet
```

When `proxyExporter.enabled=true`, the chart starts the digest-pinned `nginx/nginx-prometheus-exporter` sidecar with a read-only non-root filesystem. Its memory request and limit are mandatory, so enabling observability cannot introduce an unbounded sidecar; node-ephemeral storage is intentionally not required because the sidecar has no writable filesystem. NGINX binds its `stub_status` page to `127.0.0.1:18080`, so it is reachable only within the proxy Pod; the exporter reads it over the shared Pod network namespace and uses the proxy Service's internal `metrics` port `9113`. The public listener has no `/metrics` or `/stub_status` location. Enable a matching NetworkPolicy before a monitoring namespace scrapes that Service. The exporter port and the `webAppActionRetention.retentionHours` lifecycle window are strict positive whole numbers: the chart rejects fractional values before a Pod can receive an environment value that the API would reject at startup.

`proxyExporter.enabled`, `serviceMonitor.enabled`, `prometheusRule.enabled`, and `grafanaDashboards.enabled` are independent opt-ins, and each requires `metrics.enabled=true`. The ServiceMonitor and PrometheusRule resources require the Prometheus Operator CRDs to be installed. `grafanaDashboards.enabled` creates one labeled ConfigMap containing the versioned `rivet-control-plane` and `rivet-published-execution` dashboard JSON definitions; the cluster's own Grafana sidecar or import controller must be configured to discover that label. Each dashboard uses an interactive Prometheus-datasource selector, so it does not assume a deployment-specific datasource UID. The chart does not install Grafana, make dashboards public, or enable metrics merely by rendering the ConfigMap. All values are chart-owned, so Vault or `env` cannot override the final deployment policy after the API entrypoint loads dotenv. Their interval and alert hold values accept positive Prometheus durations such as `30s`, `10m`, or `1h30m`. Minimal installations can leave the whole block disabled and do not need Prometheus, Grafana, or their CRDs.

After the monitoring stack is reachable and its labels have been checked, an operator can enable the additional failure-mode rules explicitly:

```yaml
metrics:
  enabled: true
  prometheusRule:
    enabled: true
    for: 10m
    failureModeAlerts:
      enabled: true
      postgresPoolWaiting: 1
      maintenanceStaleSeconds: 900
      outboxBlockedEntries: 1
      evaluationQueueUtilization: 0.9
    # Requires kube-state-metrics to be scraped by this Prometheus.
    clusterStateAlerts:
      enabled: true
      restartIncrease: 1
```

These opt-in rules cover PostgreSQL pool waiters, runtime-library job failures, stale fenced maintenance, blocked deletion-outbox rows, hosted-Evaluation outstanding-job saturation, and aggregate-by-namespace/profile App Settings synchronization. `clusterStateAlerts` adds proxy/execution restart, OOM-kill, and eviction rules from the standard `kube-state-metrics` series. It deliberately stays disabled unless the target Prometheus scrapes `kube-state-metrics`; Rivet does not duplicate Kubernetes state into application metrics. Enable the rules only after confirming the Prometheus Operator's namespace/pod labels and routing policy. Their defaults are conservative starting points, not a production paging policy; inject each relevant failure in staging, tune it, assign an owner, and retain the evidence before it pages anyone.

The current metric families are intentionally low-cardinality and contain no project IDs, workflow names, prompts, inputs, secrets, request IDs, or error text:

- HTTP request count and duration, labeled only by bounded route class, method, and status class;
- process liveness/readiness and the fixed health-check names;
- published execution admission decisions, active runs by public surface, draining, and forced shutdown interruptions;
- recording persistence queue depth/active write count, drops, and write failures;
- aggregate NGINX proxy connection states and total HTTP requests, with no route, status, project, workflow, request-ID, or payload labels;
- shared PostgreSQL pool totals/idle/waiting counts, read in memory without a database query;
- managed workflow/runtime-library object-storage operation count and duration, labeled only by fixed domain, operation, and success/error;
- runtime-library job activity and terminal outcome;
- control-plane maintenance attempt/success timestamps and bounded pass outcomes;
- durable deletion-outbox entries and oldest entry age by the fixed pending, claimed, and blocked states;
- managed App Settings synchronization timestamps, listener/poll state, and bounded source/outcome counters; and
- reconciliation page outcomes, returned work-item counts, durable completion/error timestamps, and open finding counts.

#### Request correlation

Each proxy template overwrites any client-provided `X-Rivet-Correlation-Id` with Nginx's `$request_id`. The API accepts the forwarded value only when the internal proxy-auth header validates; direct callers receive a generated `rvt-UUID`. The API echoes the ID in its response header, exposes it to CORS callers, adds it to sanitized graph request context, and retains it in filesystem SQLite or managed PostgreSQL recording identity. The proxy-auth header itself is never passed to graph context.

The correlation ID is a bounded diagnostic field, not a Prometheus label. Do not add it, a workflow name, prompts, input values, credentials, or error text to metrics. Executor and hosted-Evaluation structured-log/trace propagation are planned follow-up work, so today the reliable join is proxy/API log or retained recording identity rather than a distributed trace.

#### Control-plane freshness and backlog reference

These metric families are updated by the existing maintenance worker, reconciliation task, and App Settings notification/poll paths. /metrics only renders their in-process state: it does **not** query PostgreSQL, list object storage, or run a worker. The outbox snapshot is scheduled only after the outbox-drain stage completes; one snapshot per control process may be in flight, and its outcome cannot delay or change deletion behavior.

| Metric family                                                                                                                                                                                                                                                                                                                                                                              | Meaning and scope                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| rivet_managed_maintenance_passes_total, rivet_managed_maintenance_last_attempt_timestamp_seconds, rivet_managed_maintenance_last_success_timestamp_seconds                                                                                                                                                                                                                                 | The control API's fenced maintenance attempts. A completed pass ran every registered task and drained the outbox; failed, lease_lost, and not_owner are distinct bounded outcomes. Timestamps are process-local and reset when the pod is replaced.                                                                                                                                                                                                                                                               |
| rivet_managed_object_deletion_outbox_entries, rivet_managed_object_deletion_outbox_oldest_entry_age_seconds, rivet_managed_object_deletion_outbox_operations_total                                                                                                                                                                                                                         | Durable deletion backlog state. claimed means a pending row currently has an unexpired claim; blocked is intentionally retained for investigation. An age of 0 means that state currently has no rows, not that the outbox was never sampled.                                                                                                                                                                                                                                                                     |
| rivet_managed_reconciliation_pages_total, rivet_managed_reconciliation_returned_items_total, rivet_managed_reconciliation_scanned_object_bytes_total, rivet_managed_reconciliation_active_object_bytes, rivet_managed_reconciliation_last_completed_object_bytes, rivet_managed_reconciliation_last_completed_timestamp_seconds, rivet_managed_reconciliation_last_error_timestamp_seconds | One bounded audit page per domain. “Returned items” means keys/objects returned by workflow/runtime pages or candidate integrity rows returned by the Evaluation query. `scanned_object_bytes_total` counts only object metadata sizes from fenced, committed object-list pages; it is neither payload-download volume nor provider-billing usage, and metadata/Evaluation phases add zero. The two per-domain gauges are durable generation aggregates; the status command is the authoritative checkpoint view. |
| rivet_managed_settings_listener_connected, rivet_managed_settings_poll_in_flight, rivet_managed_settings_synchronization_total, rivet_managed_settings_last_success_timestamp_seconds, rivet_managed_settings_last_failure_timestamp_seconds                                                                                                                                               | One API process's PostgreSQL LISTEN and poll synchronization activity. A successful local poll proves that replica refreshed its revision index; it does not prove that every replica has converged.                                                                                                                                                                                                                                                                                                              |

Use the target's normal instance/Pod labels to inspect every API replica. The maintenance/outbox series normally come from profile="control"; managed App Settings series can appear on each API profile. A new or restarted pod has no maintenance-success timestamp until it completes a pass, so pair freshness queries with target availability/readiness rather than treating an absent series as a successful timestamp.

Useful starting PromQL, to be tuned from staged evidence rather than paged immediately:

```promql
# Seconds since the latest successful control-plane maintenance pass.
time() - max(rivet_managed_maintenance_last_success_timestamp_seconds{profile="control"})

# Backlog by safety state; investigate blocked rows rather than retrying them blindly.
sum by (state) (rivet_managed_object_deletion_outbox_entries{profile="control"})

# Oldest outstanding work in each nonempty state.
max by (state) (
  rivet_managed_object_deletion_outbox_oldest_entry_age_seconds{profile="control"}
  * on (state) group_left
  (rivet_managed_object_deletion_outbox_entries{profile="control"} > 0)
)

# Domain freshness and recent local App Settings synchronization failures.
time() - max by (domain) (rivet_managed_reconciliation_last_completed_timestamp_seconds{profile="control"})
sum by (profile, source) (
  increase(rivet_managed_settings_synchronization_total{outcome="failure"}[15m])
)
```

The optional rule set is a conservative starting signal for an unready execution pod, sustained enforced public-admission saturation, recording drops, and object-storage errors. Reconciliation progress/open-finding and Evaluation-retention candidate/deletion metrics are also available, but they do not yet have tuned incident rules. The proxy exporter adds bounded edge-process state, but the baseline still does not replace Kubernetes restart/OOM/eviction alerts, executor telemetry, or end-to-end correlation/tracing. Enable it without paging first, validate cardinality and overhead during the published-route load gate, then create separate control-plane and high-load execution-plane dashboards and tune thresholds from staging/production evidence. The singleton backend remains a low-volume control service, not a throughput or HA claim.

### PostgreSQL connection budget

The number of registered or occasional endpoint users does not directly determine the database size. What matters is the peak number of requests running at the same time, how long their database work takes, and how many execution pods Kubernetes may create. Slow LLM calls do not hold a PostgreSQL connection for their whole duration; the pool checks connections out only for database operations.

Each managed API process shares one query pool across workflow storage, runtime libraries, App Settings, and resumable web-app action state. `postgres.poolMaxPerApiPod` controls that pool and defaults to `10`. Each API pod may also own three dedicated `LISTEN` connections for settings invalidation, workflow cache invalidation, and web-app action coordination. The chart reserves separate headroom for migrations, provider maintenance, and emergency access.

The chart validates this worst-case formula:

```text
required connections = reservedConnections
                     + (backend replicas + maximum execution replicas)
                       * (poolMaxPerApiPod + 3 LISTEN connections)
```

The production starting point is `30 + (1 + 10) * (10 + 3) = 173`, declared against `postgres.maxConnections=200`. The backend remains one pod for the small editor audience; only `execution` scales for `/workflows/*` and `/apps/*` traffic. A provider capped at 100 connections can support at most four execution pods with the same 30/10 settings: `30 + (1 + 4) * 13 = 95`. Helm refuses an unsafe combination before deployment.

`postgres.maxConnections` is validation input only; Helm cannot change the provider's database setting. Confirm it on the target database or in the provider console. With sufficient privileges, the direct checks are:

```sql
SHOW max_connections;
SELECT count(*) AS open_connections FROM pg_stat_activity;
```

When increasing `autoscaling.execution.maxReplicas`, either prove the existing database budget still fits, increase provider capacity, reduce the per-pod pool only after load testing, or introduce a carefully designed connection proxy. PostgreSQL notification listeners require session semantics, so do not place them behind transaction-pooling mode without a separate direct-listener path.

### Persistence and storage

LLM Profile circuit-breaker health is part of managed operational state. Every backend and execution replica uses the shared `llm_profile_health` Postgres table; do not replace it with pod-local memory, a browser snapshot, or SQLite in a multi-replica cluster. The table stores the exact project id for efficient project-scoped listing and atomic reset, plus the serialized state used by row-locked begin/finish/renew transitions. Transitions and reset operations also share a project-scoped PostgreSQL advisory lock, which closes the new-row race between a project reset and a transition whose placeholder has not stored its project id yet.

The backend's hosted executor sidecar calls the loopback `/api/workflows/llm-profile-health` route and authenticates with the existing `RIVET_KEY`-derived proxy token. Published and latest endpoint runs plus HTTP/WebSocket web-app actions are injected directly with the managed store. No additional public Service or Ingress route is required for executor coordination.

Half-open ownership is a renewable lease. Postgres time is authoritative across replicas; renewals are monotonic, a successful probe invalidates permits from the pre-open health generation, and a stale finish after a project reset is a no-op. These guarantees depend on all replicas using the same Postgres database and applying the managed schema before serving traffic.

In Kubernetes, production should stay on managed storage:

- `workflowStorage.backend=managed`
- `runtimeLibraries.backend=managed`
- workflow metadata, publication state, recording metadata, resumable web-app action state, and runtime-library state live in managed Postgres
- workflow blobs, recording/replay blobs, and runtime-library artifacts live in object storage

Kubernetes requires `appSettings.backend=postgres`. Every App Settings domain is stored in the managed PostgreSQL `app_settings` table as an AES-256-GCM-encrypted payload with a monotonic revision. Compare-and-swap writes prevent silent administrative overwrites. PostgreSQL notifications invalidate replica caches quickly, and a five-second revision poll converges after dropped notifications. Notification failure cannot change the result of an already-committed save, and replicas acknowledge revisions only after successful repository refresh so transient failures remain retryable. Each HTTP request captures one immutable settings snapshot.

Backend and execution pods receive separate pod-local `emptyDir` app-data volumes. The control pod mounts its local volume at `/data/rivet-app` for the API and at `/home/rivet/.local/share/com.valerypopoff.rivet2` for the co-located executor. Init containers project deployment-storage and node-proxy compatibility JSON before startup; PostgreSQL remains authoritative, and repository subscriptions refresh those projections. Hosted package plugins are also pod-local, reconstructible caches: install and load routes independently ensure the requested package is ready, with same-pod concurrent preparation deduplicated, so requests routed to different control replicas do not depend on shared files. Execution API pods read the repository directly. The proxy mounts no app-data volume: it polls the authenticated control-plane `/internal/app-settings/proxy-config` endpoint, which returns only route prefixes, timeout/body limits, trusted hosts, backend kind, and a revision. Failed fetches preserve the last valid nginx config, and every candidate still passes `nginx -t` before reload.

Published/latest workflow and web-app processes therefore share storage credentials, recording policy, endpoint auth, OAuth, runtime limits, route slugs, environment overlays, websocket overrides, and proxy settings through PostgreSQL rather than a network filesystem. Storage/database changes still require a pod rollout because backend singletons are process-scoped. Dynamic route, timeout, trusted-host, auth, recording, and environment changes propagate without a shared-volume mount. The Docker-only startup wait setting remains ignored by Kubernetes.

The managed schema also stores short-lived web-app action runs, sequenced replay/progress events, and cross-pod cancellation commands. Every API pod receives `RIVET_RUNNER_SLOT_ID` from its Kubernetes pod name. The gateway keeps the graph processor on that owning pod, renews its database lease while it is running, and uses Postgres notifications plus polling to deliver durable events/cancellation across pods. A browser reconnect can therefore land on another API pod and resume the same authorized action; a crashed or drained owner eventually emits an explicit interrupted terminal event. The database run ledger is intentionally short-lived (terminal rows are pruned after 24 hours) and separate from the long-term Run recordings artifacts. WebSocket action message limits are captured when the API process starts, so roll out API pods after raising or lowering `Settings` -> `Web apps` -> `Button data`.

Runtime-library local files are caches/workspaces, not the source of truth in managed mode. The default is `emptyDir` for execution replicas. Only set `runtimeLibraries.cache.existingClaimName` if the PVC can be mounted by every pod that needs it; with more than one `execution` replica, that usually means an RWX-capable volume. A single RWO claim reused by multiple execution pods can leave pods stuck waiting for volume attachment.

`tmpVolume` is an `emptyDir` mounted at `/var/tmp` with a default `2Gi` size limit. Increase `tmpVolume.sizeLimit` if workflows write larger temporary files; do not use the unsupported generic `writableDirs` overlay key.

### Ingress and public routes

Ingress should route all public traffic to the chart's `proxy` service. The proxy then routes internally:

| Public path                                | Internal target                                           |
| ------------------------------------------ | --------------------------------------------------------- |
| `/`                                        | `web`                                                     |
| `/api/*` and `/ui-auth`                    | singleton `backend` API                                   |
| `/workflows/*`                             | scalable `execution` API                                  |
| `/workflows-latest/*`                      | singleton `backend` API                                   |
| `/apps/*`                                  | scalable `execution` API                                  |
| `/apps-latest/*`                           | singleton `backend` API                                   |
| `/apps/*/actions/ws`                       | scalable `execution` API websocket                        |
| `/apps-latest/*/actions/ws`                | singleton `backend` API websocket                         |
| `/ws/latest-debugger`                      | singleton `backend` API websocket                         |
| `/ws/executor/internal` and `/ws/executor` | executor container in the singleton `backend` StatefulSet |

Keep ingress body-size limits high enough for project import/export and keep websocket timeouts long. The tracked nginx overlay examples use `100m` body size and `86400` second read/send timeouts. For non-nginx ingress controllers, translate those annotations to the controller-specific equivalents.

Do not route `/workflows` directly to `execution` from the external ingress. External traffic should still enter through `proxy`, because the proxy injects the trusted `X-Rivet-Proxy-Auth` header and handles the optional UI/public workflow auth policies consistently.

### Published execution admission

The execution API has a per-process admission gate for product-facing graph work. It is
shared by published `/workflows/*`, trusted in-cluster `/internal/workflows/*`, published
web-app HTTP actions, and published web-app WebSocket actions. It does not apply to
`/workflows-latest/*`, `/apps-latest/*`, or editor/control traffic: those remain on the
singleton backend, which preserves protected operator capacity. WebSocket upgrades also
enforce the same API-profile split as their HTTP routes, so a direct request to a control
pod cannot bypass the execution-plane policy.

On shutdown, the execution runtime first becomes unready and rejects new public work, then sends
server.draining and closes upgraded web-app client sockets. Accepted graph runs remain owned by
the draining pod for the normal grace period; managed clients can reconnect and resume their
durable action stream through a healthy replica. Closing the client socket prevents Node's HTTP
server from waiting for an idle upgraded connection for the entire pod grace period. HTTP graph
processors are tracked separately: if they still run at the deadline, Rivet aborts them before
forcing their client connections closed, then uses the chart's reserved finalization margin to
let processor cleanup and recording finalization settle before storage is disposed.

The gate deliberately keeps **no local waiting queue**. Kubernetes may add execution pods,
but a waiting queue in every existing pod would turn a burst into unbounded latency and
memory use. Each `execution` API pod uses these typed values:

```yaml
publishedExecutionAdmission:
  # disabled | observe | enforce
  mode: disabled
  maxActiveRunsPerPod: 4
  retryAfterSeconds: 1
```

- `disabled` retains legacy admission behavior. It still rejects new published requests
  while the API is draining for shutdown.
- `observe` tracks active published graph runs and logs threshold crossings, but continues
  admitting work. Use it to collect staging load evidence without changing caller behavior.
- `enforce` rejects immediately once `maxActiveRunsPerPod` is active. A workflow or HTTP
  web-app action receives `429`, `Retry-After`, and
  `execution_capacity_exceeded`; drain returns `503` and `execution_draining`.
  A WebSocket action receives the corresponding `action.rejected` code after its protocol
  handshake. Rejected work is neither executed nor recorded, and Rivet does not retry it.

Admission event logging is edge-triggered once per saturation or drain period, so an
overload burst or a rolling shutdown cannot create its own log storm.

The generic chart default is `disabled`; the production overlay selects the conservative
initial envelope of four active runs per execution pod. With its current 2–10 execution
replica range, that is 8–40 active public graph runs. Treat this as a safety ceiling, not
proof of a production capacity target: first run the published-route staging load gate in
`observe` mode, then tune requests, limits, HPA bounds, and the enforced value from actual
provider, storage, and recording evidence. Helm owns these environment variables and
reapplies them after Vault dotenv loading, so a stale secret cannot override the deployment
policy.

### Writable-volume and pod-resource policy

`emptyDir` limits and pod resource limits solve different failure modes. The former bounds a particular disposable filesystem; the latter gives the scheduler an honest memory/node-ephemeral reservation and ceiling for the entire container. Configure both from the published-route load gate rather than copying the starting values into production unchanged:

```yaml
writableVolumeLimits:
  workspace: 2Gi
  workflows: 2Gi
  appData: 1Gi
  runtimeLibraries: 8Gi

resources:
  execution:
    requests:
      cpu: 500m
      memory: <measured-reservation>
      ephemeral-storage: <measured-reservation>
    limits:
      memory: <measured-ceiling>
      ephemeral-storage: <measured-ceiling>
```

The same component resource map is applied to its startup init containers. This keeps Kubernetes scheduling and a future measured ceiling honest across storage bootstrap, settings projection, and the running API process rather than limiting only the final container. While a safe measured ceiling is not yet available, production may instead retain a component-specific `resourceLimitAcknowledgements.execution.memory` and `.ephemeralStorage` rationale. It must explain the deferral; the production chart rejects a missing/short rationale, and it also rejects a stale rationale once both request and limit are set. This makes a deferred limit reviewable without silently claiming that the chart has a tested capacity envelope. Do not use an acknowledgement to bypass a known safe limit.

### Health, lifecycle, and availability

The chart owns health and lifecycle policy explicitly. Do not try to override it through arbitrary dotenv keys; use the typed `lifecycle`, `rollout`, and `availability` values. API containers capture the chart-owned lifecycle values before loading Vault dotenv and reapply them afterward, so a stale secret file cannot silently change probe timing or shutdown policy.

API health endpoints have separate meanings:

- `GET /livez`: shallow process liveness. It remains `200` during a recoverable dependency outage and while the process is draining; it becomes unhealthy only after the runtime reaches its stopped state.
- `GET /readyz`: startup/drain and required-dependency readiness. It returns `503` while starting, draining, stopped, stale, or unable to use a required dependency.
- `GET /healthz`: backward-compatible alias for liveness. New probes should use `/livez` or `/readyz` according to intent.

Readiness does not open a new database/object-storage transaction for every kubelet request. Each API process refreshes a cached health snapshot in the background. The default required checks cover App Settings, workflow storage, runtime libraries, and web-app action coordination. In managed mode this includes PostgreSQL and S3-compatible object-storage checks; in filesystem mode it verifies the owned roots/cache state. Responses contain stable reason codes, check names, timestamps, and durations, but never raw dependency errors or secrets. A timed-out or draining health refresh aborts checked-out PostgreSQL probe clients and S3 `HeadBucket` requests. PostgreSQL connection acquisition is capped at 10 seconds, while S3 connection establishment is capped at 10 seconds and idle socket waits at 60 seconds; the socket limit is not a total upload-duration limit.

Managed object-storage credentials must allow the S3-compatible `HeadBucket` operation used by readiness, in addition to the object operations used by normal storage. On AWS S3 this commonly requires bucket-level `s3:ListBucket`; verify the equivalent permission for the selected provider.

Default health timing is controlled by:

```yaml
lifecycle:
  health:
    refreshSeconds: 5
    checkTimeoutSeconds: 3
    staleAfterSeconds: 20
```

Keep `staleAfterSeconds` greater than `refreshSeconds + checkTimeoutSeconds`. Short values can flap readiness during normal provider latency. The provider transport bounds are deliberately independent from the shorter readiness wait: a dependency implementation that ignores cancellation remains deduplicated until its bounded transport operation settles instead of accumulating retries. A provider-wide outage may make every execution pod unready because PostgreSQL/object storage are required to execute published work; liveness deliberately stays healthy so Kubernetes does not create a restart storm.

The rendered probe contract is:

| Workload               | Container  | Startup        | Liveness       | Readiness      |
| ---------------------- | ---------- | -------------- | -------------- | -------------- |
| `backend` StatefulSet  | `api`      | `GET /livez`   | `GET /livez`   | `GET /readyz`  |
| `backend` StatefulSet  | `executor` | TCP `21889`    | TCP `21889`    | TCP `21889`    |
| `execution` Deployment | `api`      | `GET /livez`   | `GET /livez`   | `GET /readyz`  |
| `proxy` Deployment     | `proxy`    | TCP proxy port | TCP proxy port | TCP proxy port |
| `web` Deployment       | `web`      | `GET /`        | `GET /`        | `GET /`        |

Startup probes tolerate cold reconciliation without letting liveness restart a valid slow boot forever. Permanent failures remain bounded by `lifecycle.probes.startup.failureThreshold` and its period.

Termination is coordinated across Kubernetes and the API:

- `preStopDelaySeconds` defaults to `5` to give endpoint removal time to propagate before SIGTERM. It is only propagation margin, not the application drain mechanism.
- SIGTERM immediately makes API readiness false, stops accepting new web-app actions, and closes HTTP acceptance. A concurrent initial health refresh cannot return the pod to ready.
- accepted HTTP connections and active web-app actions may finish within `shutdownGraceSeconds`, default `120`.
- cleanup is serialized and may run again after a late startup initializer settles; managed runtime-library initialization cannot start its worker once shutdown begins.
- work still active at the deadline is force-closed or persisted as interrupted; recording persistence is flushed before managed resources close.
- `terminationGracePeriodSeconds` defaults to `150` and validation requires room for shutdown grace, pre-stop delay, and a 25-second finalization margin.

Tune shutdown and pod termination values together. Longer drain windows improve completion probability but slow rollouts and node maintenance.

Every workload has an explicit rolling strategy and preferred topology spread plus pod anti-affinity. Proxy and execution default to `maxUnavailable: 0` and `maxSurge: 1`. PodDisruptionBudgets are emitted only when a tier's effective minimum replica count is greater than one; by default this protects proxy and execution. The singleton backend intentionally has no PDB, because a one-pod PDB would block voluntary disruption without creating high availability. Placement defaults are preferred rather than required so Minikube and small clusters remain schedulable.

The backend remains a validated singleton. Managed web-app action run history/replay/cancellation is replica-safe, and execution replicas scale normally. The remaining control-plane blockers are process-local latest-debugger ownership and the co-located editor executor: their related Services could choose different backend pods if backend replicas were increased. Do not disable the singleton validation until those sessions have distributed ownership or stable fenced routing and are tested with owner loss.

### Vault dotenv contract

Runtime images source `/vault/dotenv` at startup and also accept the Vault Injector default fallback path `/vault/secrets/<dotenvFileName>`. API and executor workloads receive the configured full dotenv; the proxy's chart-owned template writes only `RIVET_KEY` to that path.

The chart's typed dotenv contract emits `agent-pre-populate-only: "true"` and `agent-init-first: "true"`. The latter is essential: backend/execution bootstrap and settings-projection init containers, plus the schema-migration Job, source `/vault/dotenv`; the Vault Agent must therefore complete before them. It also emits explicit CPU, memory, and node-ephemeral requests and limits from `vault.agentResources` (`50m`/`64Mi`/`64Mi` requested and `250m`/`128Mi`/`256Mi` limited by default). These small bounds are intentionally separate from the long-running graph workloads, because the injected agent only renders the dotenv file. The Injector owns the shared in-memory secret volume and its standard annotations do not expose a chart-owned `sizeLimit`; do not use this dotenv contract for large rendered payloads.

`vault.annotations` remains available for extra Injector configuration, but chart-owned dotenv injection, ordering, and agent-resource annotations render afterward and take precedence over the same annotation keys. The chart validates all six `vault.agentResources` quantities as positive Kubernetes quantities whenever its typed injector is active. Helm can prove only the admission annotations; a provider-backed staging release must inspect a resulting Pod and confirm that `vault-agent-init` is first, has those resources, and rendered the expected file. See HashiCorp's [Vault Agent Injector annotation reference](https://developer.hashicorp.com/vault/docs/deploy/kubernetes/injector/annotations) before changing the injector implementation or annotation names.

When Vault is enabled, the dotenv file should provide the sensitive values that should not live directly in Helm values:

```dotenv
RIVET_KEY=<shared-random-secret>
RIVET_DEPLOYMENT_DATABASE_PASSWORD=<postgres-password>
RIVET_DEPLOYMENT_STORAGE_ACCESS_KEY_ID=<object-storage-access-key-id>
RIVET_DEPLOYMENT_STORAGE_ACCESS_KEY=<object-storage-secret-access-key>
# Arbitrary provider aliases used by LLM Chat/Profile are supported too:
BILLING_OPENAI_KEY=<provider-api-key>
```

You may provide `RIVET_DEPLOYMENT_DATABASE_CONNECTION_STRING` instead of `RIVET_DEPLOYMENT_DATABASE_PASSWORD`, but keep the non-secret `postgres.host`, `postgres.database`, and `postgres.username` values in the Helm values because chart validation uses them to catch incomplete managed-storage configuration. The migration Job uses these bootstrap values to seed the encrypted deployment-storage row only when it is absent. API and execution replicas then read PostgreSQL; the editor executor sees only the pod-local compatibility projection created before startup.

The managed settings projection receives each database setting from the deployment-storage bootstrap environment exactly once. Keep the rendered init-container environment free of duplicate names; Kubernetes apply behavior can otherwise discard one of the declarations even when both currently carry the same value.

Vault dotenv injection is the preferred place for production LLM/provider credentials. The full injected file is sourced only by backend API, execution API, and editor executor workloads, so custom credential names do not require a fixed chart template list. The proxy receives a generated one-variable dotenv containing only `RIVET_KEY`; it does not receive provider credentials. Non-secret development values may use `env`, which is likewise projected into execution workloads while the proxy receives only its route/resolver settings. Do not commit provider keys in Helm values. Browser access remains separately restricted by `RIVET_ENV_ALLOWLIST`; server-side availability never makes a secret browser-readable.

`RIVET_KEY` must be available to both the proxy and API workloads. It is used for trusted proxy-to-API identity and for optional public route/UI access checks.

If Vault is disabled, create Kubernetes secrets that match the chart values. For example:

```bash
kubectl -n your-namespace create secret generic rivet-shared-key \
  --from-literal=RIVET_KEY='<shared-random-secret>'

kubectl -n your-namespace create secret generic rivet-postgres \
  --from-literal=password='<postgres-password>'

kubectl -n your-namespace create secret generic rivet-object-storage \
  --from-literal=accessKeyId='<object-storage-access-key-id>' \
  --from-literal=secretAccessKey='<object-storage-secret-access-key>'
```

Then set:

```yaml
vault:
  enabled: false

auth:
  keySecretName: rivet-shared-key
  keySecretKey: RIVET_KEY

postgres:
  passwordSecretName: rivet-postgres
  passwordSecretKey: password

objectStorage:
  accessKeySecretName: rivet-object-storage
  accessKeySecretKey: accessKeyId
  secretKeySecretName: rivet-object-storage
  secretKeySecretKey: secretAccessKey
```

Use `postgres.connectionStringSecretName` instead of the host/database/username/password tuple only if your operations standard prefers a single connection-string secret.

### App Settings key rotation

1. Back up PostgreSQL and create the new key Secret.
2. Compatibility rollout: keep the old key configured as `appSettings.encryptionKeySecretName` and expose the new key through `appSettings.previousEncryptionKeySecretName`. Wait until every old-generation pod has been replaced. All running pods can now decrypt either key, while writes still use the old key.
3. Primary-key rollout: switch `appSettings.encryptionKeySecretName` to the new key and `appSettings.previousEncryptionKeySecretName` to the old key. Wait until the migration Job, backend, and every execution replica complete a healthy rollout. Startup initializes every registered settings domain, so fallback-encrypted rows are read and rewritten with each pod's primary. During the rolling overlap, old-primary and new-primary pods may rewrite a row more than once, but both generations can decrypt it.
4. Removal rollout: only after every pod uses the new primary, remove `previousEncryptionKeySecretName`.

Never perform the primary-key swap as the first rolling step: an old pod that knows only the old key cannot decrypt a row already rewritten by a new pod. Never remove the old key before all rows have been re-encrypted. A row encrypted by an unavailable key fails startup/read explicitly; it never falls back to defaults. PostgreSQL backup and the encryption keys must be backed up separately and restored together.

Configure the App Settings backend and encryption key in environment values:

```yaml
appSettings:
  backend: postgres
  encryptionKeySecretName: rivet-app-settings
  encryptionKeySecretKey: encryptionKey
```

Create `rivet-app-settings` as a Kubernetes Secret or supply the same variable through Vault. Prefer a dedicated random secret of at least 32 characters. If no dedicated key is configured, the API falls back to `RIVET_KEY` for compatibility; do not rotate that shared key casually when it is also the only settings decryption key.

For a one-time upgrade from a chart release that used the shared app-data PVC, keep the old claim provisioned and add:

```yaml
appSettings:
  legacyImport:
    existingClaimName: rivet-app-data
```

Only the migration Job mounts that claim, read-only. Each JSON domain seeds PostgreSQL only when its row is absent. Legacy files are considered independently, so a partial old claim cannot discard candidate bootstrap settings for domains it does not contain; unusable legacy entries are ignored with a warning. Rerunning the hook therefore cannot replace newer database settings. Keep the old claim intact through the rollback window, then remove `legacyImport.existingClaimName` in a later release. A rollback to an old image can read the old PVC but cannot see settings changed after database cutover; take a PostgreSQL backup before upgrade and avoid changing settings until rollback acceptance is complete.

### Immutable production release and rollback

Do not deploy the production overlay with ad hoc image tags or a raw `helm upgrade`. A successful **Build Images** workflow retains one promoted Studio Server release manifest. It binds the source commit, a canonical digest of the complete Helm chart, managed-workflow schema contract, CI run, the exact OCI digest for proxy, web, API, and executor, and one canonical predecessor release. The production chart retains the promoted manifest's own semantic digest in its release-identity ConfigMap, rejects incomplete identity, and the deployment command rejects a manifest whose chart contents do not match the checked-out chart.

Promoted manifests are published to `ghcr.io/valerypopoff/rivet2.0-studio-server/release-manifest` under `manifest-<canonical-sha256>` tags. The publisher rejects a tag that does not equal the manifest's semantic digest and refuses to overwrite different content. The `production` retag command first pulls and validates that exact promoted artifact, requires the source and destination to use the same repository, and permits only the `production` destination. The pointer advances only after repository/image gates pass, the candidate's predecessor is rechecked, its immutable manifest artifact is published, and the complete runtime image set is promoted. Treat the content-derived tags as permanent release evidence and exclude them from registry cleanup. The 90-day GitHub Actions artifact is a convenient downloadable copy, not the durable authority.

Download the manifest from the successful workflow run into this repository, for example as `artifacts/releases/<run-id>/release-manifest.json`, then check out the artifact's exact `source.sha`. Both manifest commands and the deployment command reject paths outside this checkout; the deployment command also rejects a different Git `HEAD`, tracked local modifications, or chart contents, so an operator cannot run an old artifact through newer release tooling by accident. Untracked environment values and generated release diagnostics remain allowed. Keep the environment values file limited to cluster-specific configuration and secret references; do not put `images.*`, `release.*`, or `workflowSchema.compatibility.*` in it.

#### One-time release-lineage cutover

Before the first workflow using manifest format 2, seed the durable pointer from the promoted legacy manifest that exactly matches the currently promoted runtime images. From an authenticated Docker session, with that manifest downloaded beneath this checkout:

```bash
manifest=artifacts/releases/<current-run-id>/release-manifest.json
digest="$(node deploy/studio-server/scripts/create-release-manifest.mjs digest --input "$manifest")"
reference="ghcr.io/valerypopoff/rivet2.0-studio-server/release-manifest:manifest-${digest#sha256:}"
node deploy/studio-server/scripts/release-manifest-oci.mjs push --reference "$reference" --input "$manifest"
node deploy/studio-server/scripts/release-manifest-oci.mjs retag \
  --source "$reference" \
  --destination ghcr.io/valerypopoff/rivet2.0-studio-server/release-manifest:production
```

The next candidate can read a version-1 promoted predecessor and writes a version-2 lineage manifest. Legacy manifests remain deployable and usable as a first predecessor, but a failed legacy release cannot itself authorize automated forward rollback because it has no predecessor record.

If no matching legacy manifest can be verified, run **Build Images** manually with `allow_release_lineage_bootstrap` only after explicitly accepting that this one transition has no automated rollback target. An ordinary push refuses to erase an existing image history silently. A true initial installation with neither promoted images nor a manifest pointer bootstraps automatically.

First render exactly what would be installed. This changes no cluster state and retains the rendered manifest plus values under `artifacts/kubernetes-production-release/<release>/`:

```bash
yarn studio-server:kubernetes:release -- \
  --manifest artifacts/releases/<run-id>/release-manifest.json \
  --values path/to/environment-values.yaml \
  --release rivet \
  --namespace your-namespace \
  --dry-run
```

After reviewing the generated artifacts, deploy with the explicit release-name confirmation:

```bash
yarn studio-server:kubernetes:release -- \
  --manifest artifacts/releases/<run-id>/release-manifest.json \
  --values path/to/environment-values.yaml \
  --release rivet \
  --namespace your-namespace \
  --confirm rivet
```

The command always layers `deploy/studio-server/helm/overlays/prod.yaml`, then the environment values, then generated digest-pinned manifest values. It runs Helm lint/template preflight, captures release history, and uses `helm upgrade --install --wait --wait-for-jobs --timeout 15m` for a normal release. It deliberately does **not** add `--atomic`: once the pre-upgrade migration Job commits, automatically restoring an older workload would leave that workload pointed at a newer database schema. On failure, inspect the saved history, rendered values, and migration diagnostics; repair forward or use the explicit forward rollback below. The forward-rollback command may use `--atomic` because it disables the migration Job and does not change the database schema.

Never use ordinary `helm rollback` after a migration Job may have committed. To restore the exact tested predecessor image set while deliberately preserving the newer database schema, use a **forward rollback**. It succeeds only when the target promoted manifest's canonical digest, source/schema summary, and four image digests reproduce the failed release's predecessor reference, and the failed release also declares that predecessor schema compatible:

```bash
yarn studio-server:kubernetes:release -- \
  --manifest artifacts/releases/<failed-run-id>/release-manifest.json \
  --rollback-to artifacts/releases/<previous-run-id>/release-manifest.json \
  --values path/to/environment-values.yaml \
  --release rivet \
  --namespace your-namespace \
  --confirm rivet
```

That operation disables the schema-migration Job, uses the predecessor's immutable images, and widens only that API's verify-only schema upper bound to the candidate schema version. A sibling, older ancestor, modified manifest, bootstrap release, or lineage-less failed release is rejected even when its schema number falls in the broad compatibility interval. If the command rejects either identity or schema compatibility, do not force Helm rollback: use a forward repair release or the provider-backed database restore procedure.

With release name `rivet`, the default Kubernetes object names are prefixed as `rivet-rivet-*` because the chart name is also `rivet`. Set `fullnameOverride: rivet` in the environment values if the desired object prefix is just `rivet-*`.

### First deploy checks

After install or upgrade, check the rollout from the cluster side before opening the browser:

```bash
kubectl -n your-namespace get pods,svc,ingress
kubectl -n your-namespace rollout status deployment/rivet-proxy
kubectl -n your-namespace rollout status deployment/rivet-web
kubectl -n your-namespace rollout status deployment/rivet-execution
kubectl -n your-namespace rollout status statefulset/rivet-backend
```

If Helm stops on the schema hook, inspect the retained Job before retrying:

```bash
kubectl -n your-namespace get jobs -l app.kubernetes.io/component=workflow-schema-migration
kubectl -n your-namespace logs job/<release>-rivet-workflow-schema-migration
```

Then port-forward the proxy service and verify the proxy-facing routes:

```bash
kubectl -n your-namespace port-forward svc/rivet-proxy 8080:80
curl -i http://127.0.0.1:8080/
```

If server UI auth is disabled with `env.RIVET_SERVER_UI_AUTH_MODE: "none"` or the forwarded host is listed in `Settings` -> `General` -> `Trusted hosts`, `/api/config` should be reachable through the proxy directly:

```bash
curl -i http://127.0.0.1:8080/api/config
```

If server UI auth is in key mode for the forwarded host, authenticate first and reuse the cookie:

```bash
curl -i -c rivet-cookies.txt \
  -H 'Content-Type: application/json' \
  -d '{"key":"<RIVET_KEY>"}' \
  http://127.0.0.1:8080/__rivet_auth

curl -i -b rivet-cookies.txt http://127.0.0.1:8080/api/config
```

If server UI auth should use OAuth, do not provide retired `RIVET_SERVER_UI_OAUTH_*` env values. Instead:

1. First deploy with `RIVET_SERVER_UI_AUTH_MODE=none` or `key`.
2. Open `Settings` -> `OAuth` and save the shared OAuth provider settings and session policy.
3. Open `Settings` -> `Server UI access` and save `Server UI admin emails`.
4. Register `https://<public-host>/__rivet_auth/oauth/callback` with the provider for the server UI callback. If web-app OAuth is also enabled, register the app callback path configured in the same OAuth tab, usually `https://<public-host>/apps/auth/callback`.
5. Change deployment env to `RIVET_SERVER_UI_AUTH_MODE=oauth` and roll out the backend API so the mode env is re-read.

For a new GitOps install, bootstrap the server UI with `RIVET_SERVER_UI_AUTH_MODE=none` or `key`, then save OAuth and admin-email settings through the authenticated UI before switching the deployment mode to `oauth`. Do not insert plaintext JSON into `app_settings`; payload encryption and revisioning are application-owned. An upgrade may instead use the one-time read-only legacy PVC import described above.

Public workflow execution routes require `Authorization: Bearer <RIVET_KEY>` when `Settings` -> `Workflow endpoints` -> `Access control` is enabled. It is enabled by default and stored in the encrypted workflow-endpoint-auth settings domain.

Web-app routes under `/apps/*` and `/apps-latest/*` follow the persisted `Settings` -> `Web apps` -> `Auth` mode:

- `Key` is the default. Visitors enter the Rivet key before opening web apps.
- `OAuth` redirects web-app page visitors through the configured OAuth provider, returns them to the originally requested app URL after callback, and then checks the per-web-app allowed-email list stored in Project Settings. The allowlist is fail-closed: leave it empty only when nobody should be able to open that app yet.
- `No gate` leaves web-app routes open at the API layer and should only be used behind an external access-control layer.

Hosts listed in `Settings` -> `General` -> `Trusted hosts` bypass web-app auth in every mode. OAuth provider/session settings and trusted hosts are encrypted App Settings rows; per-web-app email allowlists remain publication metadata. External OAuth URLs must use HTTPS, local dummy OAuth is development-only, and profile debug logging should stay off because it can expose profile data. Keep `RIVET_CORS_ALLOWED_ORIGINS` empty unless a known external browser origin needs direct API access. The proxy receives only a non-secret trusted-host projection and keeps `RIVET_TRUST_INCOMING_FORWARDED_HEADERS=false` unless a trusted ingress rewrites forwarded headers.

If an ingress or gateway rewrites the upstream `Host` or terminates TLS before the Rivet proxy and the API must see the original public host/scheme, configure that ingress to strip any client-supplied `X-Forwarded-Host` / `X-Forwarded-Proto` headers and write its own trusted values, then set `env.RIVET_TRUST_INCOMING_FORWARDED_HEADERS: "true"`. Leave it false for directly internet-facing proxies or untrusted ingress chains. The effective host/proto feed OAuth callback construction, same-origin web-app action checks, trusted-host matching, server UI cookie security, and `/api/config` browser URLs.

If `fullnameOverride` is not set, replace `rivet-*` with the rendered object names from `kubectl get`.

Common first-deploy failure patterns:

- `ImagePullBackOff`: check GHCR visibility, tag names, and `imagePullSecrets`
- `Pending`: check image pulls, runtime-library cache PVC attachment when configured, and any optional legacy-import PVC; normal App Settings no longer require a shared claim
- Vault injector never creates `/vault/dotenv`, or a chart init container starts before it exists: check `vault.role`, `vault.authPath`, `vault.secretPath`, Vault auth policy, Injector installation, and the mutated Pod's first `vault-agent-init` container plus its `vault.agentResources` reservations
- API pods crash during startup: check Postgres connection values, object-storage credentials, and whether the secret keys match the names in `postgres.*`, `objectStorage.*`, or `/vault/dotenv`
- HPA shows missing metrics: install/fix `metrics-server` and set CPU requests for `resources.proxy` and `resources.execution`
- Helm reports `PostgreSQL capacity is too small`: confirm the provider's actual `max_connections`, then adjust provider capacity, execution `maxReplicas`, or `postgres.poolMaxPerApiPod`; do not raise `postgres.maxConnections` only to silence validation
- browser loads but websockets disconnect through ingress: check websocket upgrade support and long read/send timeout annotations on the ingress controller

The production contract today is:

- `workflowStorage.backend=managed`
- `runtimeLibraries.backend=managed`
- `replicaCount.proxy=2`
- `replicaCount.web=1`
- `replicaCount.backend=1`
- `replicaCount.execution=2`
- `autoscaling.proxy.enabled=true`
- `autoscaling.web.enabled=false`
- `autoscaling.backend.enabled=false`
- `autoscaling.execution.enabled=true`
- `autoscaling.execution.maxReplicas=10`
- `postgres.maxConnections=200`, `postgres.reservedConnections=30`, and `postgres.poolMaxPerApiPod=10`, which budget 173 worst-case connections for one backend plus ten execution pods
- `env.RIVET_PUBLISHED_WORKFLOWS_BASE_PATH=/workflows`
- `env.RIVET_LATEST_WORKFLOWS_BASE_PATH=/workflows-latest`
- `env.RIVET_PUBLISHED_APPS_BASE_PATH=/apps`
- `env.RIVET_LATEST_APPS_BASE_PATH=/apps-latest`
- `/ws/latest-debugger` is enabled by default for latest workflow and latest web-app action debugging; set `env.RIVET_ENABLE_LATEST_REMOTE_DEBUGGER=false` only for deployments that intentionally forbid this hosted debugger websocket
- `appSettings.backend=postgres` is required; no shared app-data PVC or RWX storage class is required for App Settings
- storage/database, routes, trusted hosts, endpoint/web-app auth, OAuth, runtime limits, recording policy, environment overlays, websocket overrides, and executor proxy settings are persisted as encrypted PostgreSQL App Settings. Storage changes require pod rollout; dynamic non-startup settings propagate by revision notification/polling. The proxy consumes only the authenticated non-secret projection and has no app-data mount
- `clusterDomain=cluster.local` unless the cluster DNS suffix is different
- `env.RIVET_PROXY_RESOLVER` must be set for in-cluster nginx DNS resolution
- control-plane runtime-library reporting should stay at `RIVET_RUNTIME_LIBRARIES_REPLICA_TIER=none` with the job worker enabled there
- execution-plane runtime-library reporting should stay at `RIVET_RUNTIME_LIBRARIES_REPLICA_TIER=endpoint` with `RIVET_RUNTIME_LIBRARIES_JOB_WORKER_ENABLED=false`
- executor runtime-library reporting should stay at `RIVET_RUNTIME_LIBRARIES_REPLICA_TIER=editor`
- `proxy` and `execution` scale independently; they are not a tied pair
- baseline resource requests are defined for every workload; tune them from production-like load tests before treating the HPA thresholds as final

Chart-maintainer note:

- backend/execution chart reuse is intentionally shallow
- shared env and pod fragments live in `_env.tpl` and `_pod.tpl`
- backend and execution pods use independent `emptyDir` app-data volumes; the control pod exposes its one local volume at `/data/rivet-app` to the API and at `/home/rivet/.local/share/com.valerypopoff.rivet2` to the co-located executor for compatibility projections
- `proxy` and `web` remain mostly explicit so rendered pod shape stays operator-readable

## Repo-local verification

Run this before handing the repo to DevOps:

```bash
yarn studio-server:verify:kubernetes
```

That command proves:

- the local rehearsal values path still renders cleanly
- the static Kubernetes contract tests still pass
- the production overlay still lint-renders with concrete image repository overrides

For a live-cluster local check, also run:

```bash
yarn studio-server:dev:kubernetes-test
```

Then validate:

- the proxy URL opens successfully
- `/api/config` returns the expected published/latest base paths
- published workflow runs succeed through the scaled `execution` Deployment
- latest workflow runs and latest web-app action runs still debug through the singleton `backend`

## Operator checklist

- scale `execution` for endpoint demand
- keep `proxy` redundant and autoscaled because all endpoint traffic still crosses it
- keep `web` fixed at `1` unless real dashboard traffic becomes significant
- keep the control plane conservative and do not scale `backend`
- do not couple `proxy` and `execution` replica counts mechanically; let each tier scale for its own pressure
- keep `postgres.maxConnections` equal to the real provider limit and re-check the rendered connection formula whenever execution `maxReplicas` or the per-pod pool changes
- load-test and tune the chart's baseline CPU and memory requests before treating HPA behavior as production-ready
- keep the same `RIVET_KEY` available to both `proxy` and the API workloads
- route `${RIVET_LATEST_WORKFLOWS_BASE_PATH}`, `${RIVET_LATEST_APPS_BASE_PATH}`, and `/ws/latest-debugger` to the singleton control plane
- route `${RIVET_PUBLISHED_WORKFLOWS_BASE_PATH}` and `${RIVET_PUBLISHED_APPS_BASE_PATH}` to the execution plane
- keep runtime-library job ownership on the singleton control plane and keep execution replicas in sync-only mode
- treat the local launcher as a rehearsal wrapper around the real chart, not a separate deployment contract
