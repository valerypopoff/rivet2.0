# Kubernetes Managed Mode Audit

- Audit date: 2026-08-26
- Scope: managed storage and managed PostgreSQL on Kubernetes
- Evidence basis: current repository source, Helm templates, contract tests, a disposable local PostgreSQL concurrency check, and developer documentation
- Confidence boundary: source/static contracts plus a real single-host PostgreSQL check; no live multi-node Kubernetes cluster was exercised for this audit

## Executive Summary

The repository has substantial managed-mode support: workflow revisions and publication metadata use PostgreSQL, large workflow and recording artifacts use object storage, evaluation history has a PostgreSQL implementation, runtime-library archives use object storage, and web-app WebSocket runs have PostgreSQL-backed ownership and recovery support. Those are confirmed capabilities, not assumptions.

Problem 1 from the original audit is now implemented: workflow schema initialization is serialized, versioned, and owned by a Helm migration Job in Kubernetes. The two most prominent remaining production risks are:

1. App settings and bootstrap state still use a shared filesystem as a distributed coordination boundary, which forces an RWX claim and leaves multiple writers coordinated only inside each process.
2. Health, readiness, shutdown, and replica policy are not yet strong enough for dependable rolling updates and backend high availability.

A fourth issue limits confidence in all three areas: automated Kubernetes verification is static. It validates templates and contracts but does not run a managed-mode stack in a cluster or exercise failover, concurrent startup, or persistence.

## Evidence Standard

Each problem below separates four kinds of information:

- **Observed evidence**: behavior directly visible in current code, templates, tests, or documentation.
- **Risk inference**: a failure mode that follows from the observed design. It is not presented as a reproduced production incident unless explicitly stated.
- **Suggested plan**: an implementation sequence with migration and acceptance criteria.
- **Risks of fixing**: ways the remediation itself could cause regressions or operational problems.

Line links may move as the repository changes. Symbol and file names are included so evidence remains findable after line drift.

## Confirmed Managed Capabilities

- Managed workflow storage persists projects, drafts, published revisions, endpoint mappings, and web-app publications in PostgreSQL and stores project/dataset payloads through the configured artifact store. Evidence: [`managed/context.ts`](wrapper/api/src/routes/workflows/managed/context.ts), [`managed/schema.ts`](wrapper/api/src/routes/workflows/managed/schema.ts), and [`managed/revisions.ts`](wrapper/api/src/routes/workflows/managed/revisions.ts).
- Managed run recordings keep searchable metadata in PostgreSQL and recording/replay payloads in object storage. Evidence: [`managed/recordings.ts`](wrapper/api/src/routes/workflows/managed/recordings.ts) and the recording blob-key fields in [`managed/schema.ts`](wrapper/api/src/routes/workflows/managed/schema.ts).
- Managed evaluation definitions and run history use the PostgreSQL evaluation store. Datasets, suites, run payloads, and recording references are JSON/columns in PostgreSQL; this audit does not assume evaluation payloads are separately written to object storage. Evidence: [`evaluation-runs/store.ts`](wrapper/api/src/evaluation-runs/store.ts) and [`evaluation-runs/managed-store.ts`](wrapper/api/src/evaluation-runs/managed-store.ts).
- Managed runtime libraries keep metadata in PostgreSQL, archives in object storage, and extracted packages in a pod-local cache. Their schema initializer already uses a PostgreSQL advisory lock because concurrent DDL can deadlock. Evidence: [`runtime-libraries/managed/schema.ts`](wrapper/api/src/runtime-libraries/managed/schema.ts), [`runtime-libraries/managed/blob-store.ts`](wrapper/api/src/runtime-libraries/managed/blob-store.ts), and [`runtime-libraries/managed/local-cache.ts`](wrapper/api/src/runtime-libraries/managed/local-cache.ts).
- LLM profile health state uses PostgreSQL locking rather than process-local state in managed mode. Evidence: [`llm-profile-health/managed-store.ts`](wrapper/api/src/llm-profile-health/managed-store.ts).
- Rivet web-app WebSocket runs use a PostgreSQL run store, lease ownership, coordinator notifications with polling fallback, a stable pod host identity, and interrupted-run recovery. Evidence: [`web-app-action-websocket.ts`](wrapper/api/src/web-app-action-websocket.ts), [`web-app-action-run-store.ts`](wrapper/api/src/web-app-action-run-store.ts), and [`web-app-action-coordinator.ts`](wrapper/api/src/web-app-action-coordinator.ts).

These implementations make managed mode credible. The problems below concern orchestration and shared-state boundaries around those stores.

## Resolved Problem 1: Serialize and Version Workflow Schema Initialization

**Implementation status (2026-08-26): resolved in code, static Kubernetes contracts, focused fault tests, and a disposable PostgreSQL 16 concurrency check. No live Kubernetes rollout was performed.**

The wrapper now routes every managed workflow schema operation through [`schema-migrations.ts`](wrapper/api/src/routes/workflows/managed/schema-migrations.ts). Migration mode uses one checked-out PostgreSQL client, one transaction, a dedicated `pg_advisory_xact_lock`, bounded lock/statement timeouts, and migration-specific retries limited to PostgreSQL `40001`, `40P01`, and `55P03`; callers retain the existing bounded connection-error retry. The `managed_workflow_schema_migrations` ledger records version, name, SHA-256 checksum, application version, and application time. Existing unversioned databases rerun the idempotent baseline and are marked current only after every migration-1 table column type/nullability and required default, table DML privilege and row-level-security state, exact operational-index signature and valid/ready state, semantic and validated constraint with usable primary/unique backing indexes, and the schema-qualified folder-move function's body/language/volatility/security/result signature plus API-role execute privilege validate in the same transaction. Logging callbacks are isolated from migration control flow, so logger failures cannot rewrite committed, failed, or retried database outcomes.

The explicit `workflow-schema:migrate` and `workflow-schema:verify` commands use that same library. The Helm chart runs the candidate API image in a `pre-install,pre-upgrade` migration Job, while backend and execution API pods are forced into verify-only mode after Vault dotenv loading. The Job reuses the chart's pre-populate-only Vault contract, avoiding an injected sidecar that would keep a one-shot hook alive. It bootstraps candidate deployment storage settings in an isolated `emptyDir` app-data root instead of mounting the shared claim, so old serving pods cannot observe candidate database or object-storage settings during a failed or still-pending upgrade. Docker retains automatic migration mode by default. Evidence: [`workflow-schema-migration-job.yaml`](charts/templates/workflow-schema-migration-job.yaml), [`_helpers.tpl`](charts/templates/_helpers.tpl), [`_env.tpl`](charts/templates/_env.tpl), [`image/api/entrypoint.sh`](image/api/entrypoint.sh), and [`managed-workflow-schema-migrations.test.ts`](wrapper/api/src/tests/managed-workflow-schema-migrations.test.ts).

The migration Job currently uses the chart's normal workload identity and configured managed-database credentials. This change did **not** add a dedicated Kubernetes service account or a narrower database migrator role. Those remain optional defense-in-depth work and must be designed together with the serving role's verify-time catalog access.

### Pre-Fix Evidence

1. Managed workflow initialization calls the complete `MANAGED_WORKFLOW_SCHEMA_SQL` string through a process-local `schemaReadyPromise`. Evidence: `ensureManagedWorkflowSchema()` in [`managed/context.ts`](wrapper/api/src/routes/workflows/managed/context.ts).
2. That SQL contains both idempotent table/index statements and database-global DDL such as `DROP FUNCTION IF EXISTS` followed by `CREATE FUNCTION`. Evidence: [`managed/schema.ts`](wrapper/api/src/routes/workflows/managed/schema.ts).
3. Every API process that initializes managed workflow storage can enter this initializer. The promise deduplicates calls only inside one Node process; it does not coordinate pods. Evidence: the module-local promise in [`managed/context.ts`](wrapper/api/src/routes/workflows/managed/context.ts) and startup initialization in [`server.ts`](wrapper/api/src/server.ts).
4. The shared database helper retries connection/network failures only. Its retryable-code list includes `ECONNREFUSED`, `ECONNRESET`, `ETIMEDOUT`, `EHOSTUNREACH`, and `ENETUNREACH`; it does not include PostgreSQL deadlock, serialization, or lock-timeout codes such as `40P01`, `40001`, or `55P03`. Evidence: [`managed/db.ts`](wrapper/api/src/routes/workflows/managed/db.ts).
5. The runtime-library subsystem already documents this class of issue and protects its own DDL with a PostgreSQL advisory lock. Evidence: `ensureManagedRuntimeLibrariesSchema()` and its advisory-lock implementation in [`runtime-libraries/managed/schema.ts`](wrapper/api/src/runtime-libraries/managed/schema.ts), plus the first-boot note in [`docs/kubernetes.md`](docs/kubernetes.md).

### Pre-Fix Risk Inference

If two backend or execution pods initialize the workflow schema concurrently, PostgreSQL may serialize the statements, block one initializer, or raise a DDL conflict/deadlock. The current code does not guarantee failure, but it also does not establish cross-pod serialization. Because startup treats initialization failure as fatal, a transient conflict can make a pod restart even when the schema itself is valid.

Repeatedly running a monolithic current-schema script also provides no durable record of which schema version was applied. That makes mixed-version rollouts, rollback compatibility, and future non-idempotent migrations harder to reason about.

### Implemented Design

#### Transaction and Lock Ownership

1. `createManagedWorkflowContext()` no longer executes the schema SQL directly. It selects `migrate` or `verify` and calls the shared migration library.
2. Each attempt checks out one PostgreSQL client, starts one transaction, applies bounded lock and statement timeouts, and acquires the repository-specific transaction advisory lock before creating the ledger or executing workflow DDL.
3. Migration retries are limited to `40001`, `40P01`, and `55P03`, with bounded backoff and a new transaction per attempt. Existing connection-level retries remain outside the migration library.
4. Commit, rollback, uncertain-client disposal, and logger-failure paths have focused regression coverage. Logging cannot change a migration's database result.

#### Ledger and Compatibility Contract

1. Migration 1 wraps the previous full managed-workflow schema as an immutable checksummed baseline. New changes must be added as ordered migrations rather than modifying the released SQL.
2. The ledger records version, name, checksum, application version, and application time.
3. Baseline and verify mode check all 125 required columns, 34 required defaults, 20 operational indexes, and 35 semantic constraints. Index checks include relation ownership, access method, uniqueness, expressions, sort/null options, predicates, and valid/ready state. Constraint checks include normalized definition, validation state, and usable primary/unique backing indexes.
4. Required data tables must be ordinary usable relations with row-level security disabled and `SELECT`, `INSERT`, `UPDATE`, and `DELETE` available to the current API role.
5. The folder-move function is resolved by schema and argument types, then checked for stored-body checksum, language, volatility, security-definer state, result type, and execute privilege.

#### Deployment Ownership

1. Root and API-package commands expose the same explicit `workflow-schema:migrate` and `workflow-schema:verify` entrypoint.
2. Docker and simple single-process managed deployments retain automatic migration mode.
3. Helm runs the candidate API image as a `pre-install,pre-upgrade` hook Job. The Job consumes chart/Vault database settings from an isolated `emptyDir` app-data root and does not mount or mutate the shared app-data claim observed by old pods.
4. Backend and execution API workloads receive a chart-owned verify-only setting. The API entrypoint reapplies it after Vault dotenv loading so a stale or user-controlled dotenv value cannot turn serving replicas back into schema writers.
5. Disabling the chart Job requires an explicit external-migration acknowledgement; serving workloads remain verify-only and therefore fail closed when the external step is missing.

#### Deliberately Deferred

1. No dedicated migrator Kubernetes service account or separate database role was introduced.
2. No non-transactional or destructive migration exists yet. Future schema work still needs expand-and-contract design and a new migration version.
3. No live Minikube/Kind or production-cluster rollout was run as part of this implementation.

### Residual Risks and Guardrails

- A successful pre-upgrade migration remains applied if a later Helm rollout step fails. Every future migration must therefore be backward-compatible with the old serving image until rollout completion; use expand-and-contract changes.
- Hook deletion, retry, Vault injection, and provider-specific Job scheduling are only statically verified. Migration ids/checksums make database retries safe, but a live cluster gate is still needed to prove delivery behavior.
- The migrator and serving processes currently share database credentials. Introducing separate roles later must preserve migrate-time DDL rights and serving-role catalog reads plus table/function runtime privileges.
- Rolling back to an older image that predates verify-only ownership may reintroduce startup DDL behavior. Rollback compatibility must be evaluated per release rather than assumed.
- Exact catalog compatibility was exercised on PostgreSQL 16. Other supported managed PostgreSQL versions still need release-environment coverage.
- Destructive or non-transactional migrations are not covered by the current baseline-only implementation. Add explicit resumability and mixed-version tests before introducing either.

### Coverage and Remaining Acceptance Criteria

- Automated fake-PostgreSQL tests start four contenders; exactly one applies migration 1 and all four observe version 1.
- A disposable PostgreSQL 16 check started four real connection pools concurrently; exactly one applied migration 1, the other contenders waited and observed version 1, and a separate verify-only connection accepted the resulting schema.
- Automated tests cover a fresh database, the only pre-ledger baseline, missing metadata, checksum mismatch, future versions, missing or malformed objects, all required column defaults, table DML privileges, row-level-security drift, exact index and constraint definitions, invalid/unready indexes, unvalidated constraints, folder-function body drift, logger isolation, transactional rollback, and clean retry.
- Helm contracts prove one pre-install/pre-upgrade Job, isolated candidate settings without the shared app-data PVC, pre-populate-only Vault injection, verify-only backend/execution pods, and fail-closed behavior when migration ownership is delegated externally.
- A live Kubernetes disruption gate is still part of Problem 4. It should exercise lock timeout/deadlock/connection loss/process termination and mixed-image rollout behavior across real pods; the local PostgreSQL check and static Helm render do not prove those cluster/provider properties.

## Problem 2: Remove the Shared RWX App-Data Volume as a Distributed State Boundary

### Observed Evidence

1. Helm validation requires `storage.appData.existingClaimName`; its message says the claim must support `ReadWriteMany` when proxy/execution scale. Evidence: [`validate-values.yaml`](charts/templates/validate-values.yaml).
2. Backend and execution pods mount the app-data claim read/write, while the proxy mounts it read-only. Evidence: [`backend-statefulset.yaml`](charts/templates/backend-statefulset.yaml), [`execution-deployment.yaml`](charts/templates/execution-deployment.yaml), and [`proxy-deployment.yaml`](charts/templates/proxy-deployment.yaml).
3. Saved app settings remain individual JSON files under app data, including public routes, OAuth, trusted hosts, runtime limits, recording policy, executor proxy/URL overrides, environment overlays, and deployment storage. Evidence: [`app-settings/schema.ts`](wrapper/api/src/app-settings/schema.ts) and [`deployment-storage-settings.ts`](wrapper/api/src/deployment-storage-settings.ts).
4. The settings repository serializes writes with a process-local operation queue, writes temp files followed by rename, polls for changes every five seconds, and captures immutable per-request snapshots. Evidence: [`app-settings/settings-repository.ts`](wrapper/api/src/app-settings/settings-repository.ts), [`settings-file-writer.ts`](wrapper/api/src/settings-file-writer.ts), and [`middleware/app-settings-snapshot.ts`](wrapper/api/src/middleware/app-settings-snapshot.ts).
5. That queue coordinates callers in one process only; it is not a filesystem or distributed lock shared across pods. This follows directly from the module-local queue implementation in [`app-settings/settings-repository.ts`](wrapper/api/src/app-settings/settings-repository.ts).
6. Normal settings mutation routes are mounted only by the control-plane profile. Evidence: `mountControlPlaneRoutes()` in [`app.ts`](wrapper/api/src/app.ts) and profile ownership in [`runtime-profile.ts`](wrapper/api/src/runtime-profile.ts). This reduces normal multi-writer exposure but does not make the file format itself multi-writer safe.
7. Backend and execution deployments both run the deployment-storage bootstrap init container. Its create-if-missing path checks existence and then writes the final file directly; it has no distributed lock and no temp-file rename. Evidence: deployment templates above and [`bootstrap-deployment-storage-settings.mjs`](image/lib/bootstrap-deployment-storage-settings.mjs).
8. The proxy is a separate process that reads route/runtime configuration from the same volume and reloads independently. Evidence: [`image/proxy/entrypoint.sh`](image/proxy/entrypoint.sh), [`proxy-bootstrap/bootstrap.mjs`](wrapper/bootstrap/proxy-bootstrap/bootstrap.mjs), and the proxy deployment template.

### Risk Inference

The current design can work with a correctly provisioned RWX filesystem and one effective settings writer. Its weaknesses are portability and coordination: not every cluster has a reliable RWX storage class, filesystem rename/cache semantics vary across network filesystems, and the concurrent init-container create path can race on a fresh deployment.

Settings are also outside the managed PostgreSQL/object-storage control plane. A transient volume problem can therefore affect route generation, auth policy, runtime credentials, and startup even when the database and object store are healthy.

### Detailed Suggested Plan

#### Phase 1: Harden the Existing PVC Design

1. Make one workload the bootstrap owner. The backend should create initial settings; execution pods should wait for a valid settings document instead of racing to create it.
2. Change bootstrap writes to temp-file-plus-atomic-rename and validate the complete document before publishing it.
3. Add a settings manifest containing format version and revision. Reject malformed, unsupported, or partially written documents with a precise startup/readiness error.
4. Expose active settings revision and last reload time in diagnostics without exposing secret values.
5. Document tested storage classes and required semantics: RWX, atomic rename within a directory, coherent reads after rename, ownership, and backup expectations.

#### Phase 2: Add a Managed Settings Repository

1. Add a PostgreSQL `app_settings` table with setting domain, encrypted payload, monotonic revision, update timestamp, and actor/change-source metadata.
2. Use compare-and-swap updates (`WHERE revision = expected_revision`) so two administrators cannot silently overwrite each other.
3. Publish change notifications with PostgreSQL `NOTIFY`, but retain revision polling because notifications are not durable.
4. Keep the existing immutable request-snapshot contract: one request must resolve all settings from one captured revision.
5. Encrypt secret-bearing fields at the application layer using a deployment master key supplied by Kubernetes Secret or Vault. Do not store the encryption key in the same table.
6. Add schema versioning and domain-specific migrations for settings payloads.

#### Phase 3: Remove Runtime Dependence on the Shared Volume

1. Move API and executor settings reads to the managed repository behind the existing typed settings interfaces.
2. Replace proxy file watching with a small authenticated configuration endpoint or generated ConfigMap/controller flow. Preserve "validate nginx config before reload" behavior.
3. Keep pod-local filesystem cache only as an availability optimization; PostgreSQL remains authoritative and cached revisions must never accept writes.
4. After all consumers report database-backed settings readiness, remove the app-data mount from execution and proxy pods, then make it optional for backend compatibility/migration only.

#### Migration and Rollback

1. Import existing files once, preserving a hash of each source file and recording the imported revision.
2. Run a read-compare period in which database and file projections are compared but only the existing source is authoritative.
3. Switch to PostgreSQL authority with optional one-way file projection for rollback diagnostics.
4. Never support unconstrained dual writes. Rollback should select one authority explicitly and verify revisions before changing it.

### Risks of Fixing

- Moving settings into PostgreSQL increases the blast radius of a database outage. Cached last-known-good settings need explicit freshness and security semantics.
- Application-level encryption introduces key rotation and disaster-recovery obligations. Losing the master key can make stored OAuth and environment secrets unrecoverable.
- A proxy configuration API is security-sensitive. It must be internal, authenticated, revisioned, and unable to return unrelated secrets.
- `NOTIFY` can be dropped during disconnects; using it without revision polling would reintroduce stale settings.
- A dual-authority migration can create split brain. The implementation must identify exactly one writer/source at every stage.
- Some upstream/editor execution paths may assume files exist. Remove the PVC only after every consumer has contract coverage.
- Removing RWX too early can break rollback to old images that still read settings files.

### Tests and Acceptance Criteria

- Concurrent initialization from backend and execution replicas produces one valid initial settings revision.
- Two updates against the same expected revision yield one success and one explicit conflict.
- Every request sees one settings revision even if an update occurs mid-request.
- Kill and reconnect the notification listener; polling must converge to the newest revision.
- Rotate the encryption key through the documented procedure and verify old and new secrets remain readable during the transition.
- Run with no app-data volume after migration and verify API, execution, proxy routes, OAuth, runtime libraries, recordings, and environment overlays.

## Problem 3: Strengthen Lifecycle, Readiness, and Replica Safety

### Observed Evidence

1. `/healthz` always returns `{ ok: true }` once Express is serving; it does not inspect PostgreSQL, object storage, settings freshness, WebSocket coordinator state, or schema compatibility. Evidence: [`app.ts`](wrapper/api/src/app.ts).
2. Backend and execution readiness/liveness probes both target `/healthz`. Evidence: [`backend-statefulset.yaml`](charts/templates/backend-statefulset.yaml) and [`execution-deployment.yaml`](charts/templates/execution-deployment.yaml).
3. The chart has no `startupProbe`, PodDisruptionBudget, topology-spread constraints, affinity policy, explicit rollout strategy, pre-stop hook, or chart-controlled termination grace period. Evidence: the deployment templates and the unsupported-capabilities list in [`docs/kubernetes.md`](docs/kubernetes.md).
4. Server shutdown starts WebSocket drain, waits a fixed five seconds, force-closes connections, interrupts remaining web-app runs, and flushes recording writes. Evidence: `SHUTDOWN_GRACE_MS` and `shutdown()` in [`server.ts`](wrapper/api/src/server.ts).
5. Helm currently requires `backend.replicaCount: 1`. The validation message attributes this to process-local latest-workflow, latest-web-app, and debugger state. Evidence: [`validate-values.yaml`](charts/templates/validate-values.yaml).
6. Execution replicas can scale independently and the proxy routes published workflow/web-app traffic to them. Evidence: [`values.yaml`](charts/values.yaml), [`execution-deployment.yaml`](charts/templates/execution-deployment.yaml), and proxy route generation in [`proxy-bootstrap/config.mjs`](wrapper/bootstrap/proxy-bootstrap/config.mjs).
7. The web-app coordinator reconnects its PostgreSQL listener and retains polling fallback. The current code does not expose listener connectivity as readiness state, so this audit does not claim that a listener disconnect automatically makes a pod unready. Evidence: [`web-app-action-coordinator.ts`](wrapper/api/src/web-app-action-coordinator.ts).

### Risk Inference

Kubernetes can route traffic to a process that is alive but cannot complete its assigned work because a required managed dependency or schema is unavailable. Conversely, making every optional dependency a hard readiness condition would cause unnecessary fleet-wide outages, so readiness must reflect each runtime profile's actual responsibilities.

The fixed five-second shutdown window can be shorter than configured command or workflow durations. During rolling updates, accepted runs may be interrupted before Kubernetes removes and drains the pod unless termination grace and application drain behavior are coordinated.

The single-backend restriction is an explicit availability limit for control-plane/editor features. It does not mean all published execution is single-replica: execution pods scale separately. Raising the backend count before removing process-local ownership would risk inconsistent latest/debugger sessions.

### Detailed Suggested Plan

#### Phase 1: Define Profile-Specific Health Contracts

1. Keep `/livez` shallow: event loop responsive, startup completed, shutdown not terminally stuck.
2. Add `/readyz` with checks selected by runtime profile:
   - backend/control: compatible schema, settings snapshot loaded, required database connectivity, and control-plane initialization complete;
   - execution: compatible schema, artifact-store access required for published execution, runtime-library readiness, and WebSocket gateway acceptance state;
   - combined: union of the responsibilities above.
3. Do not perform expensive object-store/database operations on every probe. Refresh dependency state periodically with strict timeouts and expose the cached result plus age.
4. Add `startupProbe` so migrations, cache hydration, or initial object-store checks do not trigger liveness restarts.
5. Expose structured reason codes and metrics for not-ready/degraded states without leaking connection strings or secrets.

#### Phase 2: Coordinate Shutdown and Placement

1. Make application drain timeout configurable and align `terminationGracePeriodSeconds` to exceed it plus recording flush and network-close margin.
2. Mark readiness false immediately on SIGTERM, then drain new WebSocket/action acceptance before closing listeners.
3. Add a small `preStop` delay only if endpoint propagation measurements show it is needed; do not use it as a substitute for readiness-first drain.
4. Add PodDisruptionBudgets for workloads with more than one replica. Avoid a backend PDB that falsely implies HA while replicas are fixed at one.
5. Add preferred topology spread/anti-affinity defaults, with configurable strictness for small clusters.
6. Set and test an explicit rolling-update strategy (`maxUnavailable` and `maxSurge`) per workload.

#### Phase 3: Remove the Single-Backend Constraint Deliberately

1. Inventory every process-local backend owner: active latest/debugger sessions, preview/open-project coordination, caches, and any background maintenance loops.
2. Move authoritative state to PostgreSQL/object storage or introduce leases/leader election for singleton work.
3. Define stable routing or reconnect semantics for stateful WebSockets; never rely on accidental service affinity.
4. Add fencing tokens to leased work so a paused old leader cannot write after a new leader takes ownership.
5. Only then remove the `backend.replicaCount == 1` validation and test two or more backend replicas.

#### Rollout Sequence

1. Ship observability-only dependency state.
2. Add startup and readiness probes in warning mode/staging, tune timeouts, then enforce readiness.
3. Align graceful termination and rolling strategy.
4. Add disruption and topology policies.
5. Resolve process-local ownership and finally enable backend scaling.

### Risks of Fixing

- Making a shared dependency a hard readiness check can remove every pod simultaneously during a provider outage. Required versus optional/degraded dependencies must be explicit.
- An overly generous startup probe can hide a permanent configuration error for too long; failures still need a bounded deadline and clear events.
- Long termination grace slows deployments and node drains. It must be based on measured run durations and cancellation semantics.
- A strict PDB can block voluntary maintenance when capacity is already low.
- Required anti-affinity can make small clusters unschedulable; preferred placement is the safer default.
- Incorrect leader election can duplicate maintenance work or lose it. Leases need fencing and idempotent jobs.
- Sticky routing can create hot pods and is insufficient by itself for restart recovery.

### Tests and Acceptance Criteria

- Readiness fails for each required dependency independently and reports the correct reason; liveness remains healthy for recoverable dependency outages.
- Startup probes tolerate the measured slowest valid initialization but eventually fail permanent misconfiguration.
- During a rolling update, stop a pod with active HTTP and WebSocket runs; new work routes elsewhere and accepted work reaches a defined completed/cancelled/interrupted terminal state.
- Drain a node under the configured PDB/topology policy and verify service availability.
- With multiple execution replicas, kill the current web-app run owner and verify explicit recovery behavior rather than an endless loading state.
- Before enabling multiple backend replicas, run editor, latest endpoint, latest debugger, project save, and settings-update concurrency scenarios.

## Problem 4: Add a Live Managed-Kubernetes Release Gate

This is a confidence gap rather than proof that managed Kubernetes is broken.

### Observed Evidence

1. `npm run verify:kubernetes` runs Kubernetes contract tests and [`scripts/verify-kubernetes.mjs`](scripts/verify-kubernetes.mjs). The script performs Helm lint/template checks and static manifest assertions.
2. The Kubernetes tests inspect chart/image/launcher contracts but do not create a cluster or make requests to running workloads. Evidence: Kubernetes-focused tests under [`wrapper/api/src/tests`](wrapper/api/src/tests) and [`scripts/verify-kubernetes.mjs`](scripts/verify-kubernetes.mjs).
3. The repository provides manual Minikube commands through `dev:kubernetes-test`. Evidence: root [`package.json`](package.json) and [`scripts/dev-kubernetes.mjs`](scripts/dev-kubernetes.mjs).
4. The GitHub image workflow's verification job currently runs repository-structure and test-style checks; it does not run the full test suite, `verify:kubernetes`, or a live cluster rehearsal. Evidence: [`.github/workflows/build-images.yml`](.github/workflows/build-images.yml).
5. The current static verification passed during this audit, so the report is not alleging a known template-rendering failure.

### Risk Inference

Static rendering cannot prove runtime behavior that depends on Kubernetes scheduling, Services, persistent-volume semantics, DNS, rolling termination, multiple pods, or real PostgreSQL/object-store concurrency. Regressions in those areas can therefore reach an image build even while the current static checks pass.

### Detailed Suggested Plan

#### Stage 1: Strengthen the Fast Pull-Request Gate

1. Add `npm run verify:kubernetes` to the GitHub verification job.
2. Keep Helm lint/template and contract tests fast and deterministic.
3. Render at least local-managed and external-managed values, then validate image tags/digests, security contexts, probes, Services, volumes, environment sources, and route ownership.
4. Fail if chart defaults and runtime profile assumptions diverge.

#### Stage 2: Add a Live Managed Smoke Job

1. Create an ephemeral Kind cluster in CI. Keep Minikube as the documented local equivalent.
2. Deploy PostgreSQL and MinIO (or compatible test services) and the exact images produced by the workflow.
3. Deploy at least two proxy and two execution replicas. Backend remains one until Problem 3 is resolved.
4. If the current chart still requires RWX, use a CI storage solution that genuinely exercises shared semantics. A hostPath shortcut may test wiring but must not be reported as RWX portability proof.
5. Exercise only through the public proxy:
   - health/readiness;
   - open/save/publish a project;
   - published and latest workflow execution;
   - published and latest web-app HTML, HTTP compatibility action, and WebSocket action;
   - recording list/detail/replay and statistics;
   - evaluation definition and scoring-run persistence;
   - runtime-library install/use;
   - settings propagation and dynamic routes.

#### Stage 3: Add Persistence and Disruption Scenarios

1. Restart every workload and verify projects, publications, evaluations, recordings, settings, and runtime-library metadata survive.
2. Delete an execution pod during an active long web-app run and verify documented reconnect/interruption behavior.
3. Start several pods against an empty database to exercise schema initialization.
4. Perform a rolling update under load and a voluntary node drain.
5. Run explicit data-migration tests from the oldest supported release.

#### Stage 4: Validate the Production Topology Separately

1. Periodically run the same suite against the real managed PostgreSQL provider, S3-compatible provider, ingress controller, TLS setup, and RWX storage class used in production.
2. Treat this as a release/staging certification, not a replacement for the fast PR job.

#### Harness Requirements

- Use unique namespaces and deterministic cleanup.
- Capture pod events, logs, rendered manifests, probe failures, and failed HTTP/WebSocket transcripts as artifacts.
- Bound every wait and retry. Record retries so they cannot hide flaky startup.
- Use generated test secrets and redact them from logs/artifacts.
- Assert the deployed image digest matches the image under test.
- Require an explicit kube-context/namespace guard for local destructive commands.

### Risks of Fixing

- A full live-cluster gate increases CI time, cost, and flakiness. Separate fast PR smoke from slower scheduled/release disruption suites.
- Kind/Minikube networking and storage differ from production; passing locally is not proof of cloud ingress or RWX behavior.
- Broad retries can turn deterministic defects into intermittent green builds. Retry only named transient setup operations and publish retry counts.
- Logs and manifests can leak credentials. Test-secret generation and artifact redaction are mandatory.
- Cleanup scripts can target the wrong cluster. Require an ephemeral-context marker and namespace ownership label.
- Testing prebuilt tags instead of the just-built digest can certify the wrong image.

### Tests and Acceptance Criteria

- Every image release runs the static Kubernetes gate.
- A live managed smoke suite passes from a clean cluster using the exact candidate images.
- The suite proves persistence after pod restarts and exposes artifacts for every failure.
- Scheduled disruption tests cover concurrent startup, execution-pod loss, rolling update, and node drain.
- Production topology is separately certified before relying on provider-specific ingress, object storage, PostgreSQL, or RWX behavior.

## Assumptions Checked

| Assumption                                                                     | Audit result              | Evidence / qualification                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------ | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Recent features have managed persistence implementations.                      | Supported.                | Workflow revisions/publications, recordings, evaluations, runtime libraries, LLM health, and web-app WebSocket run state have managed stores cited above.                                                                                  |
| All evaluation artifacts are stored in object storage.                         | Not supported; corrected. | The managed evaluation store persists its definitions and run payloads in PostgreSQL. Recording artifacts referenced by evaluation runs follow the recording store, but the evaluation store itself is not an object-store implementation. |
| Any API replica can normally edit app settings.                                | Not supported; corrected. | Settings mutation routes are control-plane-only. Execution replicas still read shared settings and participate in deployment-storage bootstrap.                                                                                            |
| Workflow-schema startup retries protect against PostgreSQL DDL deadlocks.      | Supported, narrowly.       | The migration library serializes DDL with an advisory lock and retries only PostgreSQL `40P01`, `40001`, and `55P03`; the common query retry policy remains network-only.                                                                    |
| A web-app coordinator listener disconnect necessarily makes the pod unhealthy. | Not supported; removed.   | The coordinator reconnects and polls. No readiness integration was found, so listener state is an observability/readiness design question rather than a confirmed outage behavior.                                                         |
| The chart currently depends on shared app-data storage.                        | Supported.                | Helm requires an existing claim and mounts it into backend, execution, and proxy workloads; validation calls out RWX for scaled consumers.                                                                                                 |
| `verify:kubernetes` is a live cluster test.                                    | Not supported; corrected. | It is a static Helm/template/contract gate. Manual cluster tooling exists separately.                                                                                                                                                      |
| Current Kubernetes managed mode is definitely broken.                          | Not established.          | Static verification passes and managed stores exist. The report identifies unproven HA/operations paths and concrete design risks, not a reproduced blanket failure.                                                                       |

## Recommended Work Order

1. Add `verify:kubernetes` to GitHub verification so the current static contract becomes a release gate.
2. Add live managed smoke coverage before making larger storage or replica changes; it provides the runtime regression harness for the now-versioned schema path and later changes.
3. Introduce profile-specific startup/readiness endpoints and align graceful termination.
4. Harden the existing settings/bootstrap filesystem path, especially single-writer initialization and atomic publication.
5. Move settings authority to PostgreSQL, remove the RWX runtime dependency, and only then pursue multi-backend control-plane replicas.

This order keeps behavior stable while adding evidence and containment before the largest architectural migration.

## Useful Verification Commands

```powershell
npm run verify:kubernetes
npm run verify:repo-structure
npm run test
git diff --check
```

For a local live rehearsal after the CI harness exists:

```powershell
npm run dev:kubernetes-test
```

That manual command is useful operational evidence, but it should not be treated as a substitute for a repeatable automated managed-mode gate.
