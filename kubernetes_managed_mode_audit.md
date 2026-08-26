# Kubernetes Managed Mode Audit

- Audit date: 2026-08-26
- Scope: managed storage and managed PostgreSQL on Kubernetes
- Evidence basis: current repository source, Helm templates, contract tests, a disposable local PostgreSQL concurrency check, and developer documentation
- Confidence boundary: source/static contracts plus a real single-host PostgreSQL check; no live multi-node Kubernetes cluster was exercised for this audit

## Executive Summary

The repository has substantial managed-mode support: workflow revisions and publication metadata use PostgreSQL, large workflow and recording artifacts use object storage, evaluation history has a PostgreSQL implementation, runtime-library archives use object storage, and web-app WebSocket runs have PostgreSQL-backed ownership and recovery support. Those are confirmed capabilities, not assumptions.

Problems 1 and 2 from the original audit are now implemented:

1. Workflow schema initialization is serialized, versioned, and owned by a Helm migration Job in Kubernetes.
2. App Settings authority has moved from a shared RWX filesystem to encrypted, revisioned PostgreSQL rows. Runtime pods use only disposable local compatibility projections, and the proxy consumes an authenticated non-secret API snapshot.

The most prominent remaining production risk is Problem 3: health, readiness, shutdown, and replica policy are not yet strong enough for dependable rolling updates and backend high availability. Problem 4 still limits confidence in all areas because automated Kubernetes verification is static; it does not yet run the complete managed stack in a live cluster or exercise failover, concurrent startup, key rotation, or persistence.

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
3. Helm runs the candidate API image as a `pre-install,pre-upgrade` hook Job. The Job consumes chart/Vault database settings from an isolated `emptyDir` app-data root and does not mutate settings observed by old pods.
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
- Helm contracts prove one pre-install/pre-upgrade Job, isolated candidate settings before managed settings import, pre-populate-only Vault injection, verify-only backend/execution pods, and fail-closed behavior when migration ownership is delegated externally.
- A live Kubernetes disruption gate is still part of Problem 4. It should exercise lock timeout/deadlock/connection loss/process termination and mixed-image rollout behavior across real pods; the local PostgreSQL check and static Helm render do not prove those cluster/provider properties.

## Resolved Problem 2: Remove the Shared RWX App-Data Volume as a Distributed State Boundary

**Implementation status (2026-08-26): resolved in code, focused fault tests, full repository verification, and static Helm render/contracts. No live multi-node Kubernetes rollout was performed.**

### Implemented Evidence

1. Managed workflow migration 2 creates `app_settings` with a domain key, monotonic revision, payload schema version, AES-GCM ciphertext/IV/authentication tag, encryption key id, legacy source hash, and update time. Its table, columns, default, primary key, and field-shape checks are part of verify-mode's required manifest. The migration is immutable and checksummed with the rest of the managed schema. Evidence: [`schema-migrations.ts`](wrapper/api/src/routes/workflows/managed/schema-migrations.ts).
2. `VersionedSettingsRepository` now selects a file backend for single-host compatibility or a PostgreSQL backend when `RIVET_APP_SETTINGS_BACKEND=postgres`. Managed writes use revision compare-and-swap; stale explicit revisions fail with `409`. Reads retain the existing immutable per-request snapshot contract. Evidence: [`settings-repository.ts`](wrapper/api/src/app-settings/settings-repository.ts) and [`middleware/app-settings-snapshot.ts`](wrapper/api/src/middleware/app-settings-snapshot.ts).
3. Managed payloads are encrypted with AES-256-GCM and authenticated against the settings domain key and schema version, preventing ciphertext from being replayed as another domain/version. A dedicated primary key is preferred, `RIVET_KEY` is a compatibility fallback, and one previous key may decrypt old rows during rotation. A fallback-key read rewrites the row with the primary key. Missing key material fails explicitly instead of replacing settings with defaults. Evidence: [`managed-settings-crypto.ts`](wrapper/api/src/app-settings/managed-settings-crypto.ts) and [`managed-settings-store.ts`](wrapper/api/src/app-settings/managed-settings-store.ts).
4. PostgreSQL `LISTEN`/`NOTIFY` accelerates cross-replica invalidation, while a five-second revision poll remains the durable convergence mechanism after listener disconnects or dropped notifications. Notification delivery is isolated from the already-committed compare-and-swap write, and a replica acknowledges a revision only after every matching repository refresh succeeds; failed refreshes therefore remain eligible for the next poll. Overlapping poll cycles are suppressed and shutdown waits for the active poll before closing the pool. Same-process backend initialization is promise-deduplicated, and settings-domain updates remain serialized per repository. Evidence: [`managed-settings-store.ts`](wrapper/api/src/app-settings/managed-settings-store.ts) and [`settings-repository.ts`](wrapper/api/src/app-settings/settings-repository.ts).
5. The Helm migration Job deliberately runs workflow schema migration with `RIVET_APP_SETTINGS_BACKEND=file` before importing managed settings, because the database settings table does not exist before migration 2. Both phases reuse one rendered database credential set rather than declaring duplicate environment names. An optional legacy app-data claim is mounted only by that Job, read-only. Missing rows are seeded independently: a matching regular, valid legacy JSON file wins for that domain, while missing or unusable legacy entries preserve the candidate bootstrap/default. Imported rows retain a source hash and existing database rows always win. Evidence: [`workflow-schema-migration-job.yaml`](charts/templates/workflow-schema-migration-job.yaml), [`_env.tpl`](charts/templates/_env.tpl), [`import-managed-app-settings.ts`](wrapper/api/src/scripts/import-managed-app-settings.ts), and [`settings-repository.ts`](wrapper/api/src/app-settings/settings-repository.ts).
6. Backend and execution workloads now use independent `emptyDir` app-data volumes. Init containers hydrate only deployment-storage and node-proxy compatibility files for consumers that still require local files. PostgreSQL remains authoritative, and repository subscriptions refresh those projections. Hosted package-plugin directories are explicitly reconstructible pod-local caches: both install and load routes ensure the package is ready under a per-package process lock, so consecutive browser requests remain correct when a Service sends them to different control replicas. Evidence: [`backend-statefulset.yaml`](charts/templates/backend-statefulset.yaml), [`execution-deployment.yaml`](charts/templates/execution-deployment.yaml), [`project-managed-app-settings.ts`](wrapper/api/src/scripts/project-managed-app-settings.ts), [`deployment-storage-settings.ts`](wrapper/api/src/deployment-storage-settings.ts), [`node-executor-proxy-settings.ts`](wrapper/api/src/node-executor-proxy-settings.ts), and [`plugin-installer.ts`](wrapper/api/src/routes/plugin-installer.ts).
7. The proxy no longer mounts app data. It fetches a revisioned, deliberately non-secret snapshot from the control API through the existing `RIVET_KEY`-derived trusted-proxy credential. Fetch failure preserves the last valid include; startup fails if no valid initial snapshot is available; nginx reload still requires `nginx -t`. Evidence: [`proxy-settings-snapshot.ts`](wrapper/api/src/proxy-settings-snapshot.ts), [`app.ts`](wrapper/api/src/app.ts), [`proxy-deployment.yaml`](charts/templates/proxy-deployment.yaml), and [`normalize-workflow-paths.sh`](image/proxy/normalize-workflow-paths.sh).
8. The chart rejects any Kubernetes settings backend other than PostgreSQL and no longer exposes `storage.appData`. The local Kubernetes launcher and overlays no longer create or require an app-data PVC. Evidence: [`validate-values.yaml`](charts/templates/validate-values.yaml), [`values.yaml`](charts/values.yaml), chart overlays, and [`kubernetes-launcher-config.mjs`](scripts/lib/kubernetes-launcher-config.mjs).

### Resulting Guarantees

- PostgreSQL is the only writable App Settings authority after cutover; there is no dual-write mode.
- Two administrators cannot silently overwrite the same revision.
- Each settings domain is pinned to the immutable snapshot captured at request start; a notification or concurrent save cannot change that domain midway through the request.
- A dropped PostgreSQL notification can delay convergence by at most the polling interval under normal database availability; it cannot make stale cache state permanent.
- Security-sensitive settings are encrypted before storage, and the proxy endpoint cannot return OAuth, environment, database, object-storage, or signing secrets.
- Normal Kubernetes runtime no longer needs an RWX storage class for App Settings.
- Docker and other single-host deployments retain the existing atomic JSON-file behavior.

### Migration and Rollback Contract

1. Back up PostgreSQL and keep the old app-data claim before upgrading.
2. Set `appSettings.legacyImport.existingClaimName` only for the cutover release. The migration Job mounts it read-only and imports only absent rows.
3. Verify the backend, execution replicas, proxy routes, OAuth, environment overlays, and executor proxy behavior before changing settings.
4. Keep the legacy claim through the rollback window, then remove the chart value in a later release. Old images cannot see settings changed after PostgreSQL cutover, so rolling back after new settings writes requires an operator-approved restore/reconciliation plan.
5. Key rotation requires two compatibility rollouts. First deploy every replica with the old key still primary and the new key supplied as the previous/secondary key, so every old-generation pod is replaced by a pod that can decrypt both keys. Then deploy the new key as primary and the old key as previous, wait for every replica to initialize every domain, and remove the old key only in a later rollout. Fallback-key reads rewrite rows with the local primary, so the second rolling overlap may produce extra revisions but remains decryptable. Back up database data and key material separately but restore them together.

### Residual Risks and Follow-Up

- PostgreSQL availability now gates uncached settings startup and updates. Existing in-process snapshots can serve active requests, but a fresh pod cannot safely invent defaults when the database or decryption key is unavailable.
- Losing all valid encryption keys makes secret-bearing settings unrecoverable. Key backup and the two-rollout compatibility sequence are operational requirements, not optional hardening; skipping the first compatibility rollout can make new-key rows unreadable to old pods during a rolling update.
- The proxy's last-known-good behavior protects an already-running pod, but a new proxy pod fails closed when it cannot obtain its first authenticated snapshot.
- Pod-local projections are compatibility seams, not general caches. New consumers must use the typed repository or an authenticated narrow API rather than adding another file authority.
- Static tests prove rendered topology and repository contracts, not a real multi-node provider. Problem 4 must still exercise legacy import, concurrent replicas, listener reconnect, key rotation, proxy/API interruption, and rollback in a live managed cluster.

### Automated Coverage

- Settings tests cover one-time and partial legacy import, malformed/non-file fallback, database-wins semantics, compare-and-swap retry/conflict behavior, replica invalidation, notification-failure isolation, refresh acknowledgement/retry, immutable request snapshots, subscriber failure isolation, ciphertext/no-plaintext storage, domain/version authentication, fallback-key reads, and missing-key failure. Plugin tests cover deduplicated pod-local preparation and complete packages that intentionally skip dependency installation.
- Managed schema tests cover migration 2's immutable checksum and complete table manifest alongside concurrent migration ownership.
- API profile tests cover authentication and secret exclusion for the internal proxy snapshot.
- Proxy image contracts cover API-snapshot polling plus the retained single-host file fallback.
- Helm and launcher contracts prove no runtime shared app-data claim, pod-local projections, a proxy with no app-data mount, optional read-only legacy import, schema-before-settings migration ordering, and unique Rivet environment names in the migration Job.

### Verification Record

- `npm run test` completed with 545 passing tests, zero failures, and two optional fixture skips. The command also completed the API build, web pure tests, style checks, repository-structure checks, and Kubernetes verification.
- Focused managed-settings and plugin-cache regression tests passed, including committed-write notification failure, failed-refresh retry, and pod-local plugin preparation deduplication.
- `npm run verify:kubernetes` completed all Kubernetes contract tests plus Helm lint and local/production render checks.
- `git diff --check` completed without whitespace errors. Line-ending conversion warnings on this Windows checkout are informational.
- This verification remains static/single-host evidence. Live legacy import, multi-replica convergence, key rotation, proxy interruption, and rollback remain acceptance work under Problem 4.

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
4. Verify that App Settings survive pod replacement and propagate across control/execution replicas without any shared app-data claim.
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

1. Periodically run the same suite against the real managed PostgreSQL provider, S3-compatible provider, ingress controller, TLS setup, and ingress/TLS topology used in production.
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
- Kind/Minikube networking and storage differ from production; passing locally is not proof of cloud ingress or managed-service behavior.
- Broad retries can turn deterministic defects into intermittent green builds. Retry only named transient setup operations and publish retry counts.
- Logs and manifests can leak credentials. Test-secret generation and artifact redaction are mandatory.
- Cleanup scripts can target the wrong cluster. Require an ephemeral-context marker and namespace ownership label.
- Testing prebuilt tags instead of the just-built digest can certify the wrong image.

### Tests and Acceptance Criteria

- Every image release runs the static Kubernetes gate.
- A live managed smoke suite passes from a clean cluster using the exact candidate images.
- The suite proves persistence after pod restarts and exposes artifacts for every failure.
- Scheduled disruption tests cover concurrent startup, execution-pod loss, rolling update, and node drain.
- Production topology is separately certified before relying on provider-specific ingress, object storage, or PostgreSQL behavior.

## Assumptions Checked

| Assumption                                                                     | Audit result              | Evidence / qualification                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------ | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Recent features have managed persistence implementations.                      | Supported.                | Workflow revisions/publications, recordings, evaluations, runtime libraries, LLM health, and web-app WebSocket run state have managed stores cited above.                                                                                  |
| All evaluation artifacts are stored in object storage.                         | Not supported; corrected. | The managed evaluation store persists its definitions and run payloads in PostgreSQL. Recording artifacts referenced by evaluation runs follow the recording store, but the evaluation store itself is not an object-store implementation. |
| Any API replica can normally edit app settings.                                | Not supported; corrected. | Settings mutation routes are control-plane-only. Execution replicas read the PostgreSQL settings repository and receive pod-local compatibility projections; they do not share a writable settings filesystem.                              |
| Workflow-schema startup retries protect against PostgreSQL DDL deadlocks.      | Supported, narrowly.       | The migration library serializes DDL with an advisory lock and retries only PostgreSQL `40P01`, `40001`, and `55P03`; the common query retry policy remains network-only.                                                                    |
| A web-app coordinator listener disconnect necessarily makes the pod unhealthy. | Not supported; removed.   | The coordinator reconnects and polls. No readiness integration was found, so listener state is an observability/readiness design question rather than a confirmed outage behavior.                                                         |
| The chart currently depends on shared app-data storage.                        | No; fixed.                | App Settings are encrypted PostgreSQL rows. Backend/execution app data is pod-local `emptyDir`, proxy has no app-data mount, and a legacy PVC is optional migration-only input. |
| `verify:kubernetes` is a live cluster test.                                    | Not supported; corrected. | It is a static Helm/template/contract gate. Manual cluster tooling exists separately.                                                                                                                                                      |
| Current Kubernetes managed mode is definitely broken.                          | Not established.          | Static verification passes and managed stores exist. The report identifies unproven HA/operations paths and concrete design risks, not a reproduced blanket failure.                                                                       |

## Recommended Work Order

1. Add `verify:kubernetes` to GitHub verification so the current static contract becomes a release gate.
2. Add live managed smoke coverage before making larger storage or replica changes; it provides the runtime regression harness for the now-versioned schema path and later changes.
3. Introduce profile-specific startup/readiness endpoints and align graceful termination.
4. Exercise the implemented PostgreSQL App Settings cutover, key rotation, proxy interruption, and legacy-import rollback in the live managed smoke suite.
5. After lifecycle/readiness and live-cluster evidence are in place, reassess whether the singleton control-plane constraint can be relaxed.

This order now focuses on runtime evidence and lifecycle safety after the two largest architectural migrations have landed.

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
