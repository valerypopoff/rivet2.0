# Kubernetes Managed Mode Reliability Audit and Implementation Plan

- Original audit date: 2026-08-26
- Reassessment date: 2026-08-30
- Scope: managed storage and managed PostgreSQL on Kubernetes
- Evidence basis: current monorepo source, Helm templates, contract tests, a disposable local PostgreSQL concurrency check, developer documentation, and the repository's static Kubernetes verification gate
- Confidence boundary: source/static contracts plus the recorded single-host PostgreSQL check and a current successful `yarn studio-server:verify:kubernetes` run; the reassessment did not itself execute Kind or the protected provider-backed staging gate

## Executive Summary

The repository has substantial managed-mode support: workflow revisions and publication metadata use PostgreSQL, large workflow and recording artifacts use object storage, evaluation history has a PostgreSQL implementation, runtime-library archives use object storage, and web-app WebSocket runs have PostgreSQL-backed ownership and recovery support. Those are confirmed capabilities, not assumptions.

Problems 1 through 5 from the original audit are implemented:

1. Workflow schema initialization is serialized, versioned, and owned by a Helm migration Job in Kubernetes.
2. App Settings authority has moved from a shared RWX filesystem to encrypted, revisioned PostgreSQL rows. Runtime pods use only disposable local compatibility projections, and the proxy consumes an authenticated non-secret API snapshot.
3. API lifecycle now separates liveness from dependency readiness, drains accepted work within an aligned termination budget, and gives replicated tiers explicit rollout, disruption, and placement policy.
4. The release gate always combines static chart validation and candidate-image smoke coverage; a path-classified full release additionally runs a disposable Kind managed-mode deployment using immutable candidate image digests before promotion. The full gate covers WebSocket owner loss/reconnect, App Settings key rotation, and PostgreSQL/MinIO recovery; a separate protected provider-staging runner covers HTTPS ingress, provider-aware outage manifests, and legacy rollback.
5. Managed PostgreSQL clients share a bounded per-process query pool, and the chart validates the maximum API replica connection budget against operator-declared provider capacity.

Problem 4 is now implemented as a Kind gate plus a protected manual provider-staging gate in source and GitHub Actions configuration. This audit has not itself observed a completed remote CI or provider-staging execution. The Kind gate supplies repeatable runtime evidence for the managed stack; the provider runner is ready to collect the remaining ingress, TLS, DNS, managed-Postgres, and object-store evidence after staging secrets/configuration are installed. Problem 3 deliberately retains a singleton control-plane boundary until latest-debugger and co-located editor-executor session ownership become distributed or stably routed.

The 2026-08-30 reassessment found six additional reliability boundaries. They concern release identity and rollback compatibility, cross-store disaster recovery, saturation control, durable maintenance/reconciliation, resumable hosted Evaluations, and production observability. Release/rollback and cross-store recovery are implemented in source and await operational certification. The bounded, audit-only reconciliation inventory and its telemetry baseline are now implemented alongside the earlier deletion outbox; deletion policy, remaining retention adapters, Evaluation continuation, capacity/SLO evidence, dashboards, tuned alerts, and correlation remain planned work. It also corrected two overstatements from the initial follow-up report: the singleton backend is already a documented residual boundary rather than a newly discovered defect, and fixed generic memory limits are not automatically safer than environment-specific limits established by load testing.

Historical sections below were migrated from the former standalone Studio Server repository. Their source references now resolve to current monorepo paths, and all verification commands use the root Yarn workspace.

## Document Purpose and Status Register

This is the detailed implementation authority for Kubernetes managed-mode reliability work. It records current evidence, required changes, delivery order, compatibility and rollout constraints, risks, and acceptance criteria. A problem is not considered resolved merely because code exists: its stated automated and operational evidence must pass. The shorter document under `developer-docs/studio-server/audits/` remains the maintained summary and links here for the complete plan.

Status labels have deliberately narrow meanings:

- **Resolved** means the scoped source design and its automated evidence are complete; any stated provider or load certification is still a deployment acceptance condition, not hidden implementation work.
- **Implemented; certification pending** means the source, chart, and test work are complete but the plan still needs a retained remote/provider result before that capability is operationally certified.
- **Open** may contain completed milestones. Those are marked inline; the problem stays open until its remaining acceptance criteria form one complete operational contract.

| Problem                            | Status                                                       | Production meaning                                                                                                                                                                                    |
| ---------------------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Workflow schema ownership       | Resolved; retain compatibility discipline                    | One versioned migration owner serializes schema change; serving replicas verify only.                                                                                                                 |
| 2. App Settings distributed state  | Resolved; key backup/rotation remains operationally critical | Encrypted PostgreSQL is authoritative; pod-local files are disposable projections.                                                                                                                    |
| 3. Lifecycle and replica safety    | Resolved for the supported topology                          | Execution tiers drain and scale; the control backend intentionally remains a singleton.                                                                                                               |
| 4. Managed Kubernetes release gate | Implemented; remote Kind and provider-stage evidence pending | Static validation and candidate smoke always run; classified full releases add Kind, while staging must certify real provider semantics.                                                              |
| 5. PostgreSQL capacity budget      | Resolved as a configuration bound                            | The chart prevents an impossible connection budget, but production throughput still requires load evidence.                                                                                           |
| 6. Release identity and rollback   | Implemented; remote certification still required             | Production requires a promoted digest manifest; rollback is forward-only and schema-compatible by contract.                                                                                           |
| 7. Backup and restore              | Implemented in source; provider certification remains        | A strict fresh-target restore drill verifies cross-store recovery; provider evidence and an approved schedule remain required.                                                                        |
| 8. Execution saturation            | Partially implemented; staging certificate pending           | Public admission/resource guardrails and the protected capacity harness are complete; provider evidence, measured ceilings, non-CPU scaling, downstream limits, and Evaluation isolation remain open. |
| 9. Retention and reconciliation    | Partially implemented; deletion policy remains gated         | A fenced owner, durable workflow-deletion retry, checkpointed audit inventory, and bounded reconciliation telemetry exist; no unknown object is automatically deleted.                                |
| 10. Hosted Evaluation continuation | Open; blocks Evaluation capacity isolation                   | Evaluation history is durable, but queued work is not resumed by a server-owned coordinator and cannot yet receive a real server-side batch quota.                                                    |
| 11. Production observability       | Partially implemented; metrics foundation complete           | Bounded API metrics and opt-in Prometheus resources exist; SLOs, dashboards, tuned alerts, correlation, and several signal domains remain open.                                                       |

## Expected Production Load Model

The capacity plan is intentionally asymmetric. Rivet Studio is an operator tool for approximately three people; it is not a high-traffic multi-tenant control plane. Product traffic is generated by tens of thousands of end users calling published workflow endpoints. User population alone is not a sizing input, so production sizing must measure request rate, concurrent executions, graph duration, memory and temporary-storage high-water marks, provider latency, and recording volume.

Current routing already establishes the correct physical boundary:

- `deploy/studio-server/images/proxy/normalize-workflow-paths.sh` routes the configured published `/workflows/...` path to `$execution_upstream`.
- `deploy/studio-server/helm/templates/proxy-deployment.yaml` binds that upstream to the independently scalable execution Service.
- `packages/studio-server-api/src/app.ts` gives the execution profile published workflow/web-app execution routes, while the control profile owns UI/API, project, settings, runtime-library, recording-inspection, and latest routes.
- `/workflows-latest/...` and latest web-app routes intentionally go to the control backend. They are development/debugging surfaces and must not be used as high-volume production endpoints.

| Surface                                                                                     | Expected load                                                      | Owning workloads                                                    | Scaling policy                                                                                                                                                   |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Studio UI, project open/save/create, settings, publication, recording/statistics inspection | About three operators; low request concurrency                     | Proxy, web, singleton backend API                                   | No throughput-driven web/backend scaling target. Preserve correctness, restart recovery, and honest singleton availability.                                      |
| Remote debugger and editor executor                                                         | About three operators; a few long-lived sessions                   | Proxy, singleton backend, co-located editor executor                | Keep singleton/stably owned. Do not undertake distributed session ownership merely for load.                                                                     |
| Evaluation authoring and run control                                                        | About three authors; low control request volume                    | Current client/control path and Evaluation store                    | No UI/control scaling target. Coordinator durability is a correctness feature, not a throughput requirement.                                                     |
| Evaluation target/evaluator trials                                                          | Potentially bursty fan-out despite few authors                     | Currently the editor-owned remote executor and downstream providers | Problem 10 must move dispatch server-side before a real batch quota can reserve published-execution capacity; do not claim execution-tier isolation before then. |
| Published `/workflows/...` execution                                                        | High; product-facing traffic from tens of thousands of users       | Proxy and execution Deployment                                      | Horizontal scaling, bounded admission, overload behavior, and production load testing are required here.                                                         |
| Published web-app actions, if used                                                          | Potentially product-facing and high                                | Proxy and execution Deployment                                      | Apply the same execution-plane capacity and admission contract as published workflows.                                                                           |
| Recording persistence and run-statistics writes                                             | Proportional to published executions even though UI reads are rare | Execution tier, PostgreSQL, object storage                          | Treat ingestion, queueing, retention, and storage I/O as execution-plane load. Sampling or retention policy must be explicit.                                    |
| PostgreSQL, object storage, LLM/tool providers, runtime-library cache                       | Driven primarily by executions, recordings, and graph behavior     | Shared managed dependencies                                         | Size from execution concurrency and artifact volume, not the number of Studio users.                                                                             |

### Consequences for This Plan

1. Do not add backend or web HPA as part of capacity hardening. `backend=1` and `web=1` are appropriate for the stated load model; backend HA remains optional future availability work, not a scaling prerequisite.
2. Concentrate load engineering on proxy, execution pods, published-route admission, PostgreSQL/object-store write paths, downstream-provider limits, and recording persistence.
3. Keep public product traffic on published routes. Add documentation and, where practical, rate/concurrency protection so `/workflows-latest/...` cannot accidentally become a product endpoint on the singleton backend.
4. Give interactive control traffic protected capacity by topology, not by scaling the control plane. Execution saturation must not consume control-backend CPU/memory or its editor-executor sessions.
5. Give Evaluations a separate bounded batch budget. A large suite must not take capacity needed by public workflows, but it also does not justify scaling the Studio UI or control backend.
6. Define separate SLOs: the published execution plane has the high-availability and throughput objective; the operator control plane has a lower-volume availability and recovery objective.

### Portfolio-Wide Delivery Rules

Every open problem must ship with all of the following:

1. A versioned configuration or data contract with backwards-compatible defaults.
2. A dry-run, observe-only, or disabled-by-default stage before destructive or rejecting behavior is enabled.
3. Focused tests plus a repository contract that prevents the safety property from being silently removed.
4. A staged or disposable-cluster failure-injection scenario for the failure mode being addressed.
5. An operator runbook covering rollout, diagnosis, rollback, and any action that can lose data or interrupt runs.
6. Secret-safe artifacts and telemetry. Prompts, credentials, OAuth secrets, arbitrary graph values, and decrypted App Settings must never enter CI artifacts or metric labels.
7. Explicit evidence ownership: the release record must say which automated gate ran, which operator/provider drill remains outstanding, and when the last successful operational drill completed.

## Evidence Standard

Each problem below separates four kinds of information:

- **Observed evidence**: behavior directly visible in current code, templates, tests, or documentation.
- **Risk inference**: a failure mode that follows from the observed design. It is not presented as a reproduced production incident unless explicitly stated.
- **Suggested plan**: an implementation sequence with migration and acceptance criteria.
- **Risks of fixing**: ways the remediation itself could cause regressions or operational problems.

Line links may move as the repository changes. Symbol and file names are included so evidence remains findable after line drift.

## Confirmed Managed Capabilities

- Managed workflow storage persists projects, drafts, published revisions, endpoint mappings, and web-app publications in PostgreSQL and stores project/dataset payloads through the configured artifact store. Evidence: [`managed/context.ts`](packages/studio-server-api/src/routes/workflows/managed/context.ts), [`managed/schema.ts`](packages/studio-server-api/src/routes/workflows/managed/schema.ts), and [`managed/revisions.ts`](packages/studio-server-api/src/routes/workflows/managed/revisions.ts).
- Managed run recordings keep searchable metadata in PostgreSQL and recording/replay payloads in object storage. Evidence: [`managed/recordings.ts`](packages/studio-server-api/src/routes/workflows/managed/recordings.ts) and the recording blob-key fields in [`managed/schema.ts`](packages/studio-server-api/src/routes/workflows/managed/schema.ts).
- Managed evaluation definitions and run history use the PostgreSQL evaluation store. Datasets, suites, run payloads, and recording references are JSON/columns in PostgreSQL; this audit does not assume evaluation payloads are separately written to object storage. Evidence: [`evaluation-runs/store.ts`](packages/studio-server-api/src/evaluation-runs/store.ts) and [`evaluation-runs/managed-store.ts`](packages/studio-server-api/src/evaluation-runs/managed-store.ts).
- Managed runtime libraries keep metadata in PostgreSQL, archives in object storage, and extracted packages in a pod-local cache. Their schema initializer already uses a PostgreSQL advisory lock because concurrent DDL can deadlock. Evidence: [`runtime-libraries/managed/schema.ts`](packages/studio-server-api/src/runtime-libraries/managed/schema.ts), [`runtime-libraries/managed/blob-store.ts`](packages/studio-server-api/src/runtime-libraries/managed/blob-store.ts), and [`runtime-libraries/managed/local-cache.ts`](packages/studio-server-api/src/runtime-libraries/managed/local-cache.ts).
- LLM profile health state uses PostgreSQL locking rather than process-local state in managed mode. Evidence: [`llm-profile-health/managed-store.ts`](packages/studio-server-api/src/llm-profile-health/managed-store.ts).
- Rivet web-app WebSocket runs use a PostgreSQL run store, lease ownership, coordinator notifications with polling fallback, a stable pod host identity, and interrupted-run recovery. Evidence: [`web-app-action-websocket.ts`](packages/studio-server-api/src/web-app-action-websocket.ts), [`web-app-action-run-store.ts`](packages/studio-server-api/src/web-app-action-run-store.ts), and [`web-app-action-coordinator.ts`](packages/studio-server-api/src/web-app-action-coordinator.ts).

These implementations make managed mode credible. The problems below concern orchestration and shared-state boundaries around those stores.

## Resolved Problem 1: Serialize and Version Workflow Schema Initialization

**Implementation status (2026-08-26): resolved in code, static Kubernetes contracts, focused fault tests, and a disposable PostgreSQL 16 concurrency check. No live Kubernetes rollout was performed.**

The wrapper now routes every managed workflow schema operation through [`schema-migrations.ts`](packages/studio-server-api/src/routes/workflows/managed/schema-migrations.ts). Migration mode uses one checked-out PostgreSQL client, one transaction, a dedicated `pg_advisory_xact_lock`, bounded lock/statement timeouts, and migration-specific retries limited to PostgreSQL `40001`, `40P01`, and `55P03`; callers retain the existing bounded connection-error retry. The `managed_workflow_schema_migrations` ledger records version, name, SHA-256 checksum, application version, and application time. Existing unversioned databases rerun the idempotent baseline and are marked current only after every migration-1 table column type/nullability and required default, table DML privilege and row-level-security state, exact operational-index signature and valid/ready state, semantic and validated constraint with usable primary/unique backing indexes, and the schema-qualified folder-move function's body/language/volatility/security/result signature plus API-role execute privilege validate in the same transaction. Logging callbacks are isolated from migration control flow, so logger failures cannot rewrite committed, failed, or retried database outcomes.

The explicit `workflow-schema:migrate` and `workflow-schema:verify` commands use that same library. The Helm chart runs the candidate API image in a `pre-install,pre-upgrade` migration Job, while backend and execution API pods are forced into verify-only mode after Vault dotenv loading. The Job reuses the chart's pre-populate-only Vault contract, avoiding an injected sidecar that would keep a one-shot hook alive. It bootstraps candidate deployment storage settings in an isolated `emptyDir` app-data root instead of mounting the shared claim, so old serving pods cannot observe candidate database or object-storage settings during a failed or still-pending upgrade. Docker retains automatic migration mode by default. Evidence: [`workflow-schema-migration-job.yaml`](deploy/studio-server/helm/templates/workflow-schema-migration-job.yaml), [`_helpers.tpl`](deploy/studio-server/helm/templates/_helpers.tpl), [`_env.tpl`](deploy/studio-server/helm/templates/_env.tpl), [`deploy/studio-server/images/api/entrypoint.sh`](deploy/studio-server/images/api/entrypoint.sh), and [`managed-workflow-schema-migrations.test.ts`](packages/studio-server-api/src/tests/managed-workflow-schema-migrations.test.ts).

The migration Job currently uses the chart's normal workload identity and configured managed-database credentials. This change did **not** add a dedicated Kubernetes service account or a narrower database migrator role. Those remain optional defense-in-depth work and must be designed together with the serving role's verify-time catalog access.

### Pre-Fix Evidence

1. Managed workflow initialization calls the complete `MANAGED_WORKFLOW_SCHEMA_SQL` string through a process-local `schemaReadyPromise`. Evidence: `ensureManagedWorkflowSchema()` in [`managed/context.ts`](packages/studio-server-api/src/routes/workflows/managed/context.ts).
2. That SQL contains both idempotent table/index statements and database-global DDL such as `DROP FUNCTION IF EXISTS` followed by `CREATE FUNCTION`. Evidence: [`managed/schema.ts`](packages/studio-server-api/src/routes/workflows/managed/schema.ts).
3. Every API process that initializes managed workflow storage can enter this initializer. The promise deduplicates calls only inside one Node process; it does not coordinate pods. Evidence: the module-local promise in [`managed/context.ts`](packages/studio-server-api/src/routes/workflows/managed/context.ts) and startup initialization in [`server.ts`](packages/studio-server-api/src/server.ts).
4. The shared database helper retries connection/network failures only. Its retryable-code list includes `ECONNREFUSED`, `ECONNRESET`, `ETIMEDOUT`, `EHOSTUNREACH`, and `ENETUNREACH`; it does not include PostgreSQL deadlock, serialization, or lock-timeout codes such as `40P01`, `40001`, or `55P03`. Evidence: [`managed/db.ts`](packages/studio-server-api/src/routes/workflows/managed/db.ts).
5. The runtime-library subsystem already documents this class of issue and protects its own DDL with a PostgreSQL advisory lock. Evidence: `ensureManagedRuntimeLibrariesSchema()` and its advisory-lock implementation in [`runtime-libraries/managed/schema.ts`](packages/studio-server-api/src/runtime-libraries/managed/schema.ts), plus the first-boot note in [`developer-docs/studio-server/kubernetes.md`](developer-docs/studio-server/kubernetes.md).

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
- The Kind release mode now exercises pod lifecycle, WebSocket owner interruption/replay, and local PostgreSQL/MinIO recovery. It cannot prove cloud-provider transport or mixed-image behavior; the protected provider gate must be run against the production-equivalent staging environment to collect that evidence.

## Resolved Problem 2: Remove the Shared RWX App-Data Volume as a Distributed State Boundary

**Implementation status (2026-08-26): resolved in code, focused fault tests, full repository verification, and static Helm render/contracts. No live multi-node Kubernetes rollout was performed.**

### Implemented Evidence

1. Managed workflow migration 2 creates `app_settings` with a domain key, monotonic revision, payload schema version, AES-GCM ciphertext/IV/authentication tag, encryption key id, legacy source hash, and update time. Its table, columns, default, primary key, and field-shape checks are part of verify-mode's required manifest. The migration is immutable and checksummed with the rest of the managed schema. Evidence: [`schema-migrations.ts`](packages/studio-server-api/src/routes/workflows/managed/schema-migrations.ts).
2. `VersionedSettingsRepository` now selects a file backend for single-host compatibility or a PostgreSQL backend when `RIVET_APP_SETTINGS_BACKEND=postgres`. Managed writes use revision compare-and-swap; stale explicit revisions fail with `409`. Reads retain the existing immutable per-request snapshot contract. Evidence: [`settings-repository.ts`](packages/studio-server-api/src/app-settings/settings-repository.ts) and [`middleware/app-settings-snapshot.ts`](packages/studio-server-api/src/middleware/app-settings-snapshot.ts).
3. Managed payloads are encrypted with AES-256-GCM and authenticated against the settings domain key and schema version, preventing ciphertext from being replayed as another domain/version. A dedicated primary key is preferred, `RIVET_KEY` is a compatibility fallback, and one previous key may decrypt old rows during rotation. A fallback-key read rewrites the row with the primary key. Missing key material fails explicitly instead of replacing settings with defaults. Evidence: [`managed-settings-crypto.ts`](packages/studio-server-api/src/app-settings/managed-settings-crypto.ts) and [`managed-settings-store.ts`](packages/studio-server-api/src/app-settings/managed-settings-store.ts).
4. PostgreSQL `LISTEN`/`NOTIFY` accelerates cross-replica invalidation, while a five-second revision poll remains the durable convergence mechanism after listener disconnects or dropped notifications. Notification delivery is isolated from the already-committed compare-and-swap write, and a replica acknowledges a revision only after every matching repository refresh succeeds; failed refreshes therefore remain eligible for the next poll. Overlapping poll cycles are suppressed and shutdown waits for the active poll before closing the pool. Same-process backend initialization is promise-deduplicated, and settings-domain updates remain serialized per repository. Evidence: [`managed-settings-store.ts`](packages/studio-server-api/src/app-settings/managed-settings-store.ts) and [`settings-repository.ts`](packages/studio-server-api/src/app-settings/settings-repository.ts).
5. The Helm migration Job deliberately runs workflow schema migration with `RIVET_APP_SETTINGS_BACKEND=file` before importing managed settings, because the database settings table does not exist before migration 2. Both phases reuse one rendered database credential set rather than declaring duplicate environment names. An optional legacy app-data claim is mounted only by that Job, read-only. Missing rows are seeded independently: a matching regular, valid legacy JSON file wins for that domain, while missing or unusable legacy entries preserve the candidate bootstrap/default. Imported rows retain a source hash and existing database rows always win. Evidence: [`workflow-schema-migration-job.yaml`](deploy/studio-server/helm/templates/workflow-schema-migration-job.yaml), [`_env.tpl`](deploy/studio-server/helm/templates/_env.tpl), [`import-managed-app-settings.ts`](packages/studio-server-api/src/scripts/import-managed-app-settings.ts), and [`settings-repository.ts`](packages/studio-server-api/src/app-settings/settings-repository.ts).
6. Backend and execution workloads now use independent `emptyDir` app-data volumes. Init containers hydrate only deployment-storage and node-proxy compatibility files for consumers that still require local files. PostgreSQL remains authoritative, and repository subscriptions refresh those projections. Hosted package-plugin directories are explicitly reconstructible pod-local caches: both install and load routes ensure the package is ready under a per-package process lock, so consecutive browser requests remain correct when a Service sends them to different control replicas. Evidence: [`backend-statefulset.yaml`](deploy/studio-server/helm/templates/backend-statefulset.yaml), [`execution-deployment.yaml`](deploy/studio-server/helm/templates/execution-deployment.yaml), [`project-managed-app-settings.ts`](packages/studio-server-api/src/scripts/project-managed-app-settings.ts), [`deployment-storage-settings.ts`](packages/studio-server-api/src/deployment-storage-settings.ts), [`node-executor-proxy-settings.ts`](packages/studio-server-api/src/node-executor-proxy-settings.ts), and [`plugin-installer.ts`](packages/studio-server-api/src/routes/plugin-installer.ts).
7. The proxy no longer mounts app data. It fetches a revisioned, deliberately non-secret snapshot from the control API through the existing `RIVET_KEY`-derived trusted-proxy credential. Fetch failure preserves the last valid include; startup fails if no valid initial snapshot is available; nginx reload still requires `nginx -t`. Evidence: [`proxy-settings-snapshot.ts`](packages/studio-server-api/src/proxy-settings-snapshot.ts), [`app.ts`](packages/studio-server-api/src/app.ts), [`proxy-deployment.yaml`](deploy/studio-server/helm/templates/proxy-deployment.yaml), and [`normalize-workflow-paths.sh`](deploy/studio-server/images/proxy/normalize-workflow-paths.sh).
8. The chart rejects any Kubernetes settings backend other than PostgreSQL and no longer exposes `storage.appData`. The local Kubernetes launcher and overlays no longer create or require an app-data PVC. Evidence: [`validate-values.yaml`](deploy/studio-server/helm/templates/validate-values.yaml), [`values.yaml`](deploy/studio-server/helm/values.yaml), chart overlays, and [`kubernetes-launcher-config.mjs`](deploy/studio-server/scripts/lib/kubernetes-launcher-config.mjs).

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
- Static tests prove rendered topology and repository contracts. The release Kind gate now covers durable WebSocket interruption/replay and in-cluster key rotation/dependency recovery; provider ingress, key rotation, legacy import, and rollback remain operational acceptance until the protected staging gate has a successful recorded execution.

### Automated Coverage

- Settings tests cover one-time and partial legacy import, malformed/non-file fallback, database-wins semantics, compare-and-swap retry/conflict behavior, replica invalidation, notification-failure isolation, refresh acknowledgement/retry, immutable request snapshots, subscriber failure isolation, ciphertext/no-plaintext storage, domain/version authentication, fallback-key reads, and missing-key failure. Plugin tests cover deduplicated pod-local preparation and complete packages that intentionally skip dependency installation.
- Managed schema tests cover migration 2's immutable checksum and complete table manifest alongside concurrent migration ownership.
- API profile tests cover authentication and secret exclusion for the internal proxy snapshot.
- Proxy image contracts cover API-snapshot polling plus the retained single-host file fallback.
- Helm and launcher contracts prove no runtime shared app-data claim, pod-local projections, a proxy with no app-data mount, optional read-only legacy import, schema-before-settings migration ordering, and unique Rivet environment names in the migration Job.

### Verification Record

- The then-current complete Studio Server test command completed with 545 passing tests, zero failures, and two optional fixture skips. It also completed the API build, web pure tests, style checks, repository-structure checks, and Kubernetes verification. The current monorepo equivalent is `yarn studio-server:test`.
- Focused managed-settings and plugin-cache regression tests passed, including committed-write notification failure, failed-refresh retry, and pod-local plugin preparation deduplication.
- The Kubernetes verification command completed all Kubernetes contract tests plus Helm lint and local/production render checks. The current monorepo equivalent is `yarn studio-server:verify:kubernetes`.
- `git diff --check` completed without whitespace errors. Line-ending conversion warnings on this Windows checkout are informational.
- The static verification is supplemented by the committed Kind and provider-gate harnesses. A completed protected provider-stage run is still required before treating legacy import, external key rotation, proxy interruption, and rollback as certified operational behavior.

## Resolved Problem 3: Strengthen Lifecycle, Readiness, and Replica Safety

**Implementation status (2026-08-26): resolved for the supported singleton-control/scalable-execution topology in code, focused lifecycle tests, Compose validation, and static Helm render/contracts. Live multi-node disruption testing remains under Problem 4.**

### Implemented Evidence

1. The API now exposes separate health contracts through [`runtime-health.ts`](packages/studio-server-api/src/runtime-health.ts): `/livez` is shallow process liveness, `/readyz` reports startup/drain state plus required dependency health, and `/healthz` remains a backward-compatible liveness alias. Readiness responses use stable, secret-free reason codes and `Cache-Control: no-store`; dependency errors are logged server-side rather than serialized into probe responses. Evidence: [`app.ts`](packages/studio-server-api/src/app.ts) and [`runtime-health.test.ts`](packages/studio-server-api/src/tests/runtime-health.test.ts).
2. Health checks run in the background on a configurable interval and the HTTP probe reads cached frozen check results. Concurrent starts and refreshes are promise-deduplicated. Each wait has a strict timeout and abort signal: cooperative dependency checks release their resources immediately, while a dependency that ignores cancellation remains deduplicated until its separately bounded transport operation settles instead of starting a pileup. Draining or stopping aborts pending checks, stale results make readiness fail, and failure/recovery logs are transition-based. The defaults are five-second refresh, three-second timeout, and twenty-second stale threshold. Evidence: `RuntimeHealthController` and `getRuntimeHealthOptionsFromEnv()` in [`runtime-health.ts`](packages/studio-server-api/src/runtime-health.ts).
3. The required checks cover the App Settings repository, workflow storage, runtime libraries, and the web-app action gateway. Managed settings and web-app coordination verify PostgreSQL with `SELECT 1`; managed workflow and runtime-library storage verify PostgreSQL plus S3-compatible object storage with `HeadBucket`; filesystem checks verify the owned root/cache state. PostgreSQL health cancellation destroys the checked-out probe client, S3 health cancellation reaches the AWS request, managed PostgreSQL acquisition is capped at 10 seconds, and each managed S3 client owns a handler with a 10-second connection bound and 60-second idle socket bound. The gateway check also refuses readiness after it stops accepting new actions. Evidence: [`managed-health.ts`](packages/studio-server-api/src/managed-health.ts), [`managed-settings-store.ts`](packages/studio-server-api/src/app-settings/managed-settings-store.ts), [`storage-backend.ts`](packages/studio-server-api/src/routes/workflows/storage-backend.ts), [`runtime-libraries/backend.ts`](packages/studio-server-api/src/runtime-libraries/backend.ts), and [`web-app-action-websocket.ts`](packages/studio-server-api/src/web-app-action-websocket.ts).
4. Startup is cancellation-aware. App Settings, runtime-library reconciliation, workflow storage, WebSocket coordination, and the initial health refresh complete before the HTTP listener opens; the listener bind and bind failure are part of the awaited startup operation. A signal cannot let the initial health refresh reopen readiness, and draining aborts its provider checks. Resource cleanup is serialized and repeatable, so an initializer that settles after an earlier cleanup pass receives a second pass instead of leaking its pool, listener, or worker. Managed runtime-library initialization is stop-aware and waits for its in-flight initialization before final cache/pool disposal. Evidence: `startServer()`, `StartupCancelledError`, and `assertStartupActive()` in [`server.ts`](packages/studio-server-api/src/server.ts), plus [`runtime-libraries/managed/backend.ts`](packages/studio-server-api/src/runtime-libraries/managed/backend.ts).
5. `SIGTERM`/`SIGINT` immediately changes readiness to draining, aborts pending health checks, and rejects new web-app actions. The API closes HTTP acceptance while allowing accepted HTTP connections and active web-app runs to finish until `RIVET_SHUTDOWN_GRACE_SECONDS` (default 120 seconds). Only work still active at the deadline is force-closed/interrupted; recorder persistence is flushed before managed storage/settings resources are disposed. Managed subsystems release reference-counted PostgreSQL pool leases, the shared pool closes after its final owner releases it, and managed workflow/runtime-library S3 clients each own and destroy their own handler/agent so temporary maintenance clients cannot tear down live backend sockets. The latest Remote Debugger now closes clients, closes its no-server WebSocket server, and detaches its HTTP upgrade listener. Evidence: `shutdown()` and `disposeResources()` in [`server.ts`](packages/studio-server-api/src/server.ts), [`managed-postgres-pool.ts`](packages/studio-server-api/src/managed-postgres-pool.ts), [`managed-health.ts`](packages/studio-server-api/src/managed-health.ts), and [`latestWorkflowRemoteDebugger.ts`](packages/studio-server-api/src/latestWorkflowRemoteDebugger.ts).
6. Helm now renders startup, liveness, and readiness probes. API startup/liveness use `/livez`, readiness uses `/readyz`, and the co-located executor has corresponding TCP probes. Proxy and web also receive startup/liveness/readiness probes. Probe timing, cached health timing, application drain, pre-stop delay, and pod termination grace are explicit chart values with validation that preserves shutdown margin. The API entrypoint captures those chart-owned values before Vault dotenv loading and reapplies them afterward. Evidence: [`_pod.tpl`](deploy/studio-server/helm/templates/_pod.tpl), [`values.yaml`](deploy/studio-server/helm/values.yaml), and [`validate-values.yaml`](deploy/studio-server/helm/templates/validate-values.yaml).
7. Every workload has an explicit rolling-update strategy and preferred topology spread plus pod anti-affinity. Proxy and execution use zero unavailable/one surge by default. PodDisruptionBudgets are rendered only for tiers whose effective minimum replica count exceeds one; the singleton backend deliberately gets no PDB that would block voluntary node maintenance while pretending to provide HA. Evidence: the workload templates and [`disruption-budgets.yaml`](deploy/studio-server/helm/templates/disruption-budgets.yaml).
8. Docker Compose API healthchecks use `/readyz` and grant the API a 150-second stop grace period, leaving a 30-second finalization window after the default 120-second application drain. Both production and development Compose render successfully. Evidence: [`docker-compose.yml`](deploy/studio-server/compose/docker-compose.yml), [`docker-compose.dev.yml`](deploy/studio-server/compose/docker-compose.dev.yml), and [`proxy-image-contract.test.ts`](packages/studio-server-api/src/tests/proxy-image-contract.test.ts).

### Resulting Guarantees

- A recoverable PostgreSQL or object-storage outage removes an affected API pod from service without asking Kubernetes to restart an otherwise live process.
- Readiness is not a database/object-store transaction per kubelet request; probe pressure cannot amplify a provider outage.
- Cold initialization is protected by startup probes, while permanent startup failures still hit a bounded failure threshold.
- A terminating API stops advertising readiness and accepting new work, gives already accepted work a defined drain window, and records explicit interruption only when that window is exhausted.
- Replicated proxy and execution tiers roll with no planned unavailability, receive preferred cross-node placement, and retain a disruption budget when their effective minimum scale is greater than one.
- Docker uses the same readiness distinction and enough Compose stop grace to let the application execute its normal shutdown path.

### Deliberately Retained Control-Plane Boundary

`backend.replicaCount=1` remains a validated supported constraint. This is no longer justified by web-app action history: managed web-app run ownership, replay, and cancellation are PostgreSQL-backed and execution replicas scale safely. The remaining blockers are process-local latest-debugger and co-located editor-executor session routing:

- `/ws/latest-debugger` terminates on one backend process and `maybeGetLatestWorkflowRemoteDebugger()` attaches latest executions to the debugger object in that same process.
- `/ws/executor/internal` and `/ws/executor` terminate at the co-located executor selected through the singleton backend StatefulSet.
- The backend Service and executor Service would select replicas independently if the count were raised, so accidental multi-replica deployment could split an editor/debugger session across owners.

The chart therefore rejects backend scaling and backend HPA instead of exposing a topology that appears highly available but loses stateful sessions. Future backend HA should:

1. Give latest-debugger and editor-executor sessions durable/distributed ownership, or route every related HTTP/WebSocket operation to one stable fenced owner.
2. Define reconnect and takeover semantics, including fencing so a stale owner cannot emit after replacement.
3. Exercise editor execution, latest workflow/web-app debugging, project save, settings update, and owner loss with at least two backend replicas.
4. Remove the Helm singleton guard only after those tests pass.

### Operational Risks and Tuning

- Too-short dependency timeouts or stale thresholds can flap readiness during ordinary provider latency. Tune `lifecycle.health` from observed PostgreSQL/S3 latency, while keeping stale-after greater than refresh plus timeout.
- A provider-wide outage can make every execution replica unready because those dependencies are genuinely required. Liveness remains healthy so recovery does not create a restart storm.
- The default 120-second drain improves completion probability but lengthens a rollout or node drain when work is slow. Increase or decrease it together with `terminationGracePeriodSeconds`, never independently.
- The five-second pre-stop delay is endpoint-propagation margin, not the drain mechanism. The application still marks itself draining on the subsequent termination signal.
- A PDB can delay voluntary maintenance when capacity is low. It is intentionally omitted for singleton workloads and configurable for replicated tiers.
- Preferred topology rules improve placement without making a small single-node rehearsal cluster unschedulable. Changing them to hard constraints requires matching cluster capacity.
- Health check timeouts abort the supported PostgreSQL and S3 probe operations. PostgreSQL acquisition and S3 transport waits have longer fixed bounds than the default three-second health wait, so a saturated pool or non-cooperative provider can retain one deduplicated operation briefly after readiness has failed, but cannot accumulate an unbounded probe pileup.
- Managed object-storage readiness uses `HeadBucket`. Least-privilege credentials must include the provider's bucket-metadata permission (commonly `s3:ListBucket` on AWS S3) as well as ordinary object access, or pods will correctly remain unready even if some object operations happen to work.

### Automated Coverage and Remaining Acceptance

- [`runtime-health.test.ts`](packages/studio-server-api/src/tests/runtime-health.test.ts) covers failure, recovery, secret exclusion, frozen cached results, refresh deduplication, drain during the initial refresh, cancellable timeout recovery, PostgreSQL probe-client destruction, and independent liveness/readiness HTTP statuses.
- [`managed-health.test.ts`](packages/studio-server-api/src/tests/managed-health.test.ts) covers PostgreSQL acquisition bounds, S3 connection/socket bounds, and per-client S3 agent isolation for workflow and runtime-library storage.
- [`latest-workflow-remote-debugger.test.ts`](packages/studio-server-api/src/tests/latest-workflow-remote-debugger.test.ts) covers disposal and safe reinitialization of the HTTP upgrade listener in addition to existing debugger routing/auth behavior.
- [`kubernetes-contract.test.ts`](packages/studio-server-api/src/tests/kubernetes-contract.test.ts) covers rendered probes, lifecycle values, shutdown-margin validation, rollout strategy, placement, conditional disruption budgets, and the retained backend singleton guard.
- [`proxy-image-contract.test.ts`](packages/studio-server-api/src/tests/proxy-image-contract.test.ts) covers Compose readiness and stop-grace contracts; both Compose topologies also pass `docker compose ... config --quiet`.
- `yarn studio-server:test` passes the complete repository gate: API build and full API suite, web-pure tests, test-style/repository checks, and Kubernetes lint/render verification. The production and development Compose topologies pass `config --quiet`, and Alpine `sh -n` validates the API entrypoint used by Linux images.
- Problem 4 release mode now runs proxy rollout, execution-node drain, long-running web-app WebSocket forced owner loss/reconnect, three-phase App Settings encryption-key rotation, and PostgreSQL/MinIO outage/recovery in a disposable Kind cluster. Provider ingress/TLS/DNS/object-store semantics require the separate protected staging gate.

## Implemented Problem 4: Live Managed-Kubernetes Release Gate

**Implementation status (reassessed 2026-08-29): implemented in monorepo code and GitHub Actions configuration. The image workflow is present on `main` and carries the weekly schedule. This audit still has no retained evidence of a successful protected provider-backed staging certification.**

The image workflow always makes `verify:kubernetes` part of repository verification, builds the four candidate images under unique staging tags, and runs the candidate-image smoke gate. Its central change classifier selects the full Kubernetes path for chart, image, deployment, schema-migration, and release-workflow changes, and for tags, schedules, and manual dispatches. Only that full path then creates an ephemeral four-node Kind cluster (one control plane plus three workers). The live gate resolves each candidate to an immutable OCI digest, verifies that the Helm manifest uses that exact digest, deploys disposable PostgreSQL 16 and MinIO services, and installs the real managed-mode Helm chart with one backend, two proxy replicas, and two execution replicas. It exposes no direct API port: all smoke traffic uses a port-forward to the proxy Service. A fast-path application release may promote only after static verification and the candidate-image smoke gate; it must never be presented as Kind-certified.

The runner requires `RIVET_K8S_RELEASE_GATE_CONTEXT` and `RIVET_K8S_RELEASE_GATE_ALLOW_CONTEXT` to be identical and to match `kubectl config current-context`; it limits generated artifacts to the repository's ignored artifact directory; it creates one labelled namespace; and it will delete only a namespace with its own ownership label. It generates per-run PostgreSQL, MinIO, App Settings encryption, and Rivet key material in memory, applies those only as Kubernetes Secrets, and excludes Secrets from captured artifacts. A successful gate also requires cleanup to succeed, so a leaked disposable namespace cannot produce a green result. Failure artifacts include rendered manifests, workload state, events, pod descriptions, and container logs.

The smoke scenario verifies managed schema initialization, object-store setup, proxy readiness, App Settings write/read plus execution-runtime propagation, project upload/publish, published/latest workflows, published/latest web-app HTML and HTTP actions, a web-app WebSocket action, recordings/replay-project, the statistics catalog, and persistence after backend and execution-pod replacement. Release-mode runs additionally restart the proxy, drain one execution node, force-delete the persisted owner of an accepted long-running web-app action and verify its reconnect emits `action.interrupted` after lease recovery, rotate the App Settings key through old/new, new/old, and new-only generations, and prove PostgreSQL/MinIO readiness failure then recovery. After the monorepo migration, `.github/workflows/studio-server-images.yml` carries the weekly schedule on `main`; the runner bounds deployment, HTTP, recording-convergence, and disruption waits and does not blanket-retry failed product assertions.

### Residual Coverage Boundaries

- The committed monorepo workflow includes the weekly schedule on `main`. A retained successful scheduled-run artifact is still operational evidence; source and local verification prove the harness and workflow shape, not that GitHub scheduling or provider services completed successfully.

- The Kind gate uses in-cluster networking and disposable Postgres/MinIO. The protected provider runner deploys immutable candidates through the real staging ingress and checks HTTPS, DNS, workflows, web apps, persisted-settings key rotation, optional scoped NetworkPolicy outage/recovery, and optional legacy-import rollback. Until it completes successfully with the staging provider configuration, those remain unverified operational evidence rather than a certification claim.
- The smoke uses a small checked-in Rivet project fixture. It proves workflow/web-app action paths and recording contracts, not every node type, runtime-library install, or evaluation-suite shape. Those have focused unit/API coverage and should gain live scenarios when their external dependencies can be made deterministic.
- The release Kind gate now kills the exact persisted WebSocket action owner for a deliberately long-running graph and reconnects as the same owner scope, asserting the durable interrupted terminal event. It does not prove cross-process live processor migration; the accepted contract is explicit interruption after owner loss.
- A classified full release makes image promotion wait for the Kind smoke job; a fast-path release instead requires the candidate-image smoke gate and an explicit classifier result. When manually selected, the protected provider gate is additionally required. A failed or unavailable required runner can delay promotion; this is intentional release safety, and artifacts make environmental failures diagnosable.

### Operational Commands

- `yarn studio-server:verify:kubernetes` runs the static chart and contract gate.
- `yarn studio-server:verify:kubernetes:managed-live` runs the disposable smoke gate after explicit context, image digest, and registry credentials are supplied.
- `yarn studio-server:verify:kubernetes:managed-disruption` adds the controlled proxy rollout, execution-node drain, WebSocket owner-loss/reconnect, App Settings key rotation, and PostgreSQL/MinIO recovery. It must be aimed only at the dedicated Kind context.
- `yarn studio-server:verify:kubernetes:managed-provider` runs only with the explicit protected staging config, exact staging context, immutable candidate digests, and `RIVET_K8S_PROVIDER_GATE_CONFIRM=deploy-staging`.
- `yarn studio-server:verify:kubernetes:managed-capacity` runs the protected published-route capacity harness only after the provider gate has deployed the exact immutable candidate images. Certification additionally requires `RIVET_K8S_CAPACITY_GATE_CONFIRM=certify-staging`; use observe mode first when establishing or materially changing an environment's capacity envelope.

Release/provider configuration and safety requirements are documented under [Managed release gate](developer-docs/studio-server/kubernetes.md#managed-release-gate); the load contract is documented separately under [Published execution capacity certificate](developer-docs/studio-server/kubernetes.md#published-execution-capacity-certificate).

## Resolved Problem 5: Bound Scaling by PostgreSQL and Workload Capacity

**Implementation status (2026-08-28): resolved in process pool ownership, Helm defaults, render-time validation, focused tests, and operator documentation. Production-like load testing and confirmation of the provider's real `max_connections` remain deployment acceptance work.**

The four managed query consumers that previously created independent pools in one API process now acquire leases from [`managed-postgres-pool.ts`](packages/studio-server-api/src/managed-postgres-pool.ts). Identical database configurations share one bounded pool, controlled by chart-owned `RIVET_DEPLOYMENT_DATABASE_POOL_MAX`; app settings, workflow invalidation, and web-app action coordination retain three dedicated session connections for PostgreSQL `LISTEN`. Releasing one subsystem cannot close the pool while another still owns it, and the final release closes it exactly once.

The chart now declares `postgres.maxConnections`, `postgres.reservedConnections`, and `postgres.poolMaxPerApiPod`. It computes the worst case from the singleton backend plus the execution HPA maximum and rejects any render where `reserved + API pods * (pool + 3 listeners)` exceeds the declared database capacity. The production overlay's `200/30/10` values support one backend plus ten execution pods at a worst-case budget of 173 connections. The chart also supplies baseline resource requests for every workload and rejects CPU autoscaling when the relevant CPU request is absent, so HPA percentages have a coherent denominator.

This protects configuration consistency, not provider truth or application throughput. Helm cannot change or discover managed PostgreSQL capacity, and request volume is determined by peak concurrency and workflow behavior rather than registered-user count. Production acceptance must confirm the real provider limit, observe active connections and pool wait latency, and load-test representative endpoint graphs before treating ten execution replicas or the baseline CPU/memory requests as final sizing.

Automated evidence is in [`managed-postgres-pool.test.ts`](packages/studio-server-api/src/tests/managed-postgres-pool.test.ts) and [`kubernetes-contract.test.ts`](packages/studio-server-api/src/tests/kubernetes-contract.test.ts). Operational calculation and provider checks are in [`developer-docs/studio-server/kubernetes.md`](developer-docs/studio-server/kubernetes.md#postgresql-connection-budget).

## Implemented Problem 6: Production Release Identity and Database-Compatible Rollback

**Implementation status (2026-08-29): implemented in source, chart contracts, CI wiring, and focused tests; not yet observed in a completed remote CI run. Production rendering now requires a promoted immutable release manifest, the canonical release command captures pre/post-upgrade diagnostics and performs only forward rollback, and the full Kind gate verifies the previous promoted API image against the candidate schema when a prior image exists. Bootstrap releases explicitly record that no previous image is available.**

### Observed Evidence

1. `deploy/studio-server/helm/values.yaml` still has convenient tag defaults for local/rehearsal usage, but `overlays/prod.yaml` enables `release.production`. `validate-values.yaml` now requires source SHA, CI evidence, schema identity, a canonical chart-content digest, and a SHA-256 digest for proxy, web, API, and executor. The resolved identity is also retained in `release-identity-configmap.yaml`.
2. `.github/workflows/studio-server-images.yml` creates a candidate manifest from resolved OCI digests after every candidate build, then promotes and retains a separate 90-day manifest only after the existing repository, smoke, and required Kubernetes gates pass. Before assigning mutable main aliases, it verifies that the workflow SHA is still the current `main` head, so a queued scheduled/manual run cannot publish stale bytes over a newer main release.
3. `deploy/studio-server/scripts/deploy-kubernetes-release.mjs` consumes that promoted artifact, refuses a checkout whose source SHA, tracked source state, or chart name/version/content digest differs, layers the production overlay, performs lint/template preflight, stores rendered values and Helm history, and requires `--confirm <release>` before `--wait --wait-for-jobs` mutates a cluster. A normal release deliberately omits `--atomic`: a committed migration cannot be rolled back by Helm. Only an explicit forward rollback, which does not mutate the schema, may be atomic. `developer-docs/studio-server/kubernetes.md` no longer documents raw production Helm commands as a supported release path.
4. `schema-migrations.ts` now has an explicit source-owned rollback compatibility lower bound. Serving API pods accept only chart-owned verify windows; the migration Job remains exact-version. `createForwardRollbackHelmValues()` disables the migration Job and restores old image digests only when the failed release declares the target schema compatible.
5. The full Kind gate resolves the prior `api:latest` digest when one exists and launches it in an isolated verify-only Job against the candidate-migrated database. Schema source changes are classified as full-Kubernetes changes, so they cannot use the fast image path. The first release after bootstrap records a skipped prior-image check because no prior promoted image exists.

### Risk Inference

A tag can resolve to different bytes during retry or rollback, making the deployed state and incident evidence ambiguous. Separately, an automatic Helm rollback can restore an older Kubernetes workload after a candidate migration advances the database. Normal production release commands now refuse that unsafe automatic rollback path and require explicit forward recovery; it still needs remote evidence against the registry and a real predecessor image before it can be called operationally certified.

### Proposed Solution

1. Keep digest enforcement production-only, with local/rehearsal values intentionally flexible. Do not weaken the manifest validator or allow environment values to override chart-owned release/schema fields.
2. Retain each promoted manifest in the deployment system of record (for example a protected GitOps repository or release registry) before GitHub artifact expiry. The current GitHub artifact is sufficient for CI evidence but is not a long-term disaster-recovery store.
3. Continue using `yarn studio-server:kubernetes:release` for normal deployment and forward rollback. Capture its artifacts in the operator change record; do not substitute `helm rollback` after migration.
4. Every future migration must explicitly choose its `MINIMUM_ROLLBACK_COMPATIBLE_MANAGED_WORKFLOW_SCHEMA_VERSION`. Expand-only migrations may retain the previous supported schema; destructive/non-transactional changes must advance the minimum version and provide a database restore/forward-repair plan.
5. Observe the prior-image compatibility Job in remote CI after this change lands. The pre-existing `api:latest` bootstrap target can prove schema-version parity; the first schema-changing release after this baseline must prove a genuinely expanded-schema predecessor check.

### Required Change Surfaces and Rollout

- **Release contract:** implemented in `scripts/lib/studio-server-release-manifest.mjs` and `create-release-manifest.mjs`. It binds source, chart, schema contract, candidate evidence, promotion evidence, and all four digest-pinned images.
- **Helm safety:** implemented in `values.yaml`, `overlays/prod.yaml`, `validate-values.yaml`, and the release identity ConfigMap. Direct production rendering now fails without generated manifest values.
- **Migration compatibility:** implemented as a chart-owned minimum/maximum verify window. Known migration checksums remain mandatory; a successor ledger row is accepted only inside the release-tool-provided expand-only window. This is intentionally one short window, not indefinite mixed-version support.
- **Automation:** implemented in the image workflow and `deploy-kubernetes-release.mjs`, including preflight, artifact capture, bounded non-atomic candidate upgrade, and a forward-rollback path that refuses undeclared compatibility. The forward rollback alone is atomic because it does not run a migration.
- **Documentation:** implemented in `developer-docs/studio-server/kubernetes.md`. The remaining operator action is retaining promoted manifests beyond GitHub artifact retention.

Rollout is now source-complete: validate static render/contracts, observe one remote candidate run, then complete a protected staging deployment using the promoted manifest. Existing tag-only local installations remain valid because only the production overlay enables the contract.

### Risks of Fixing

- Requiring digests without producing ergonomic release values can encourage operators to bypass the chart. The CI artifact and canonical command reduce this risk, but manifest retention and access control remain an operator responsibility.
- A normal candidate release can leave failed candidate resources present for diagnosis because it deliberately avoids an unsafe automatic rollback after a possible migration. The release command retains Helm evidence; cluster-level job/pod diagnostics should be captured by the deployment platform, and recovery must be an explicit forward repair or forward rollback.
- Supporting more than one schema generation indefinitely creates migration debt. The compatibility window remains explicit and short; accepting a future ledger row does not bypass validation of every known object/checksum.

### Acceptance Criteria

- [x] Production-profile rendering fails when any image lacks a digest or has incomplete release identity.
- [x] The promoted artifact binds all four images, source SHA, chart/schema version, and candidate/promotion run identity.
- [x] The release runner retains pre/post Helm history and rendered values without automatically restoring a possibly schema-incompatible workload; its forward-rollback path states explicitly that the database schema remains advanced.
- [ ] The previous supported API verify Job passes in a retained remote full-Kubernetes run when a prior image exists; bootstrap skips are recorded, not treated as proof.

## Implemented Problem 7: Cross-Store Backup and Restore Requires Provider Certification

**Implementation status (2026-08-29): the repository now has a strict `yarn studio-server:verify:kubernetes:managed-restore` operator runner. It validates a non-secret promoted-release backup manifest, restores only through provider-owned Jobs into a fresh `rivet-restore-*` namespace/database/bucket prefix, checks every representative durable surface, requires positive restored-object/reference counts and a deliberate missing-object negative test, emits a sanitized measured RPO/RTO report, rejects a dirty checkout, literal IP targets, case-variant source database/bucket identities, and reused source hostname even on another port or with a DNS trailing dot; it also refuses redirect-following target probes, atomically owns and re-verifies the live namespace before teardown, validates and applies each provider driver from one in-memory YAML snapshot, and confirms teardown before reporting success. It has focused contract coverage. It is not yet provider-certified: a provider restore driver, protected credentials/values, sanitized recovery fixture, retained report, and approved scheduling remain operational work.**

### Observed Evidence

1. Managed metadata and encrypted App Settings live in PostgreSQL, while workflow revisions, datasets, recordings, replay data, and runtime-library archives can live in object storage. Restoring only one side can leave valid database references pointing at absent objects or retained objects with no database owner.
2. `developer-docs/studio-server/kubernetes.md` explicitly says PostgreSQL and encryption-key material must be backed up separately and restored together. It also tells operators to back up before migration and key rotation.
3. The Kind disruption gate proves temporary PostgreSQL/MinIO outage and recovery of the same live data. That is availability evidence, not backup/restore evidence: it does not restore a historical database plus object-store version set into a clean namespace.
4. The restore runner now requires probes for App Settings, OAuth, a saved project, published workflow, web app, recording, Evaluation, and runtime library. Repository tests cover manifest validation, target separation, exact recovery/key/schema binding, and a precise missing-reference failure. No real provider restore has yet been run.

### Risk Inference

Provider snapshots can be individually healthy but mutually inconsistent. Loss of the encryption key makes secret-bearing settings unrecoverable even when the database is intact. Best-effort object deletion also means a restore procedure must distinguish harmless orphan objects from missing referenced objects.

### Proposed Solution

1. **Implemented in source:** the runner takes explicit maximum RPO/RTO objectives and rejects a backup whose object-version retention is shorter than the requested RPO. Provider PostgreSQL PITR/snapshot and key-backup capability remains an environment prerequisite.
2. **Implemented in source:** a strict, non-secret manifest binds a promoted immutable release, schema, database/object recovery IDs and timestamps, bucket/prefix, version-retention window, and App Settings key IDs. Unsupported fields such as credentials are rejected.
3. **Implemented as a protected operator command:** `yarn studio-server:verify:kubernetes:managed-restore` requires an exact allowlisted context plus an explicit disposable-target acknowledgement. A CI schedule/workflow is deliberately not added until the protected provider environment, safe report destination, and cleanup owner are explicitly approved.
4. **Implemented in the runner contract:** all eight durable-surface probes are mandatory and have independent response markers. The provider restore/integrity/cleanup drivers are constrained to one owned no-retry Job each in the fresh namespace.
5. **Implemented in the runner contract:** the sanitized report contains measured RPO/RTO, exact recovery/release/schema/key identities, restored object count, missing references, and orphan count. A provider-backed successful report and a production SLO schedule remain acceptance work.

### Required Change Surfaces and Rollout

- **Provider contract:** implemented in `deploy/studio-server/scripts/kubernetes-managed-restore-drill.mjs` and its configuration library. Each provider supplies restore/integrity/cleanup Jobs through a protected environment; credentials remain workload-identity/Vault owned and never enter the manifest or report.
- **Backup manifest:** implemented as an exact JSON schema, reusing the promoted immutable release manifest rather than copying deploy/studio-server/images/schema identity.
- **Restore verifier:** implemented with a one-time `rivet-restore-*` namespace, digest-pinned Helm install, eight named probes, and forced teardown.
- **Integrity audit:** the runner now requires a provider driver to return missing-reference/orphan counts and prove missing-reference detection with a restore-target fixture. A reusable full reconciler remains Problem 9 work.
- **Operations:** developer documentation now defines the manifest, Jobs, evidence report, fixture-first rollout, teardown, and scheduling boundary. Production ownership, actual provider retention, recovery fixture, and the last green drill must still be recorded by operations.

First run the drill against synthetic data in a disposable provider project. Then restore a sanitized production-shaped snapshot. Only after both pass should the drill become scheduled. The restore target must always use a distinct namespace, database, bucket/prefix, hostname, and OAuth callback configuration so verification cannot mutate or impersonate production.

### Risks of Fixing

- Application-owned logical backups can be weaker than provider-native PITR. The repository should orchestrate and verify provider backups, not replace them with ad hoc exports.
- A restore test can expose sensitive artifacts. Use a protected environment, restricted namespace, short retention, and sanitized uploaded diagnostics.
- Object lifecycle rules shorter than the database recovery window can make a nominal PITR restore unusable.

### Acceptance Criteria

- [x] The restore runner refuses success unless every representative durable-surface check passes in a clean target.
- [x] The sanitized report contract records measured RPO/RTO and verifies the required encryption key IDs.
- [x] The provider-driver contract requires a missing-reference negative test and a precise integrity result rather than allowing silent success.
- [ ] A protected provider-backed clean restore has produced a retained successful report with the deliberate missing-reference failure also observed.
- [ ] Production operations name backup ownership, frequency, retention, and the last successful restore drill.

## Partially Implemented Problem 8: Execution Saturation Still Needs a Measured Capacity Envelope

**Implementation status (2026-08-30): the chart scales the correct high-load workloads—proxy and execution—while keeping web and backend fixed. PostgreSQL connection count and CPU-HPA denominators are validated. A typed, per-execution-pod published-work admission gate is implemented for workflow endpoints and web-app actions, with no hidden queue, immediate overload responses, drain rejection, Helm ownership, and profile-safe WebSocket routing. Shutdown closes idle upgraded clients without interrupting accepted durable actions, and separately aborts HTTP graph processors that exceed their drain deadline before shared storage is disposed. Every chart-managed writable `emptyDir` now has an explicit size limit, managed-storage init containers inherit the same resource policy as the workload they prepare, and the external Vault dotenv agent is injected first with its own bounded CPU/memory/node-ephemeral policy. Production rendering now requires a complete memory/node-ephemeral request-and-limit pair for every workload or a component-specific acknowledgement explaining why that resource ceiling is deferred; stale acknowledgements are rejected once a complete policy is supplied. These are intentional guardrails, not proof of safe values. A protected provider-staging capacity gate is now implemented in source: it verifies the deployed immutable images and the credential-free public-route posture, publishes isolated deterministic fixtures, loads only the proxy-backed published route through a bounded no-retry Job, captures direct control canaries plus execution metrics/events, writes a sanitized partial report even for setup or Job failure, and fails if cleanup leaks a temporary fixture or Kubernetes resource. No provider-backed certificate has been retained yet, so measured resource limits, Evaluation batch isolation, non-CPU autoscaling, downstream-provider capacity, production load evidence, and the remaining Problem 11 metrics/dashboard work remain open.**

### Observed Evidence

1. `deploy/studio-server/helm/values.yaml` supplies CPU and memory requests, but no generic default limits. A generic hard memory limit can OOM-kill valid long graph runs, so every production component must now either supply complete memory and `ephemeral-storage` request/limit pairs or carry a 24-character component-level acknowledgement that documents the deferred decision. Acknowledgements must be removed when the matching complete policy is set.
2. The backend and execution templates no longer mount unbounded chart-managed `emptyDir` volumes: `writableVolumeLimits` bounds workspace, workflow materialization, app-data projections, and runtime-library cache storage, while `tmpVolume.sizeLimit` bounds `/var/tmp`. The generic and production overlays start with the same conservative limits; they still require load evidence before being treated as final capacity values.
3. The Vault Injector contract is pre-populate-only and init-first, so chart bootstrap/projection and migration init containers cannot race `/vault/dotenv`. Its explicit `vault.agentResources` requests/limits cover CPU, memory, and node-ephemeral storage for the injected agent; chart-owned annotations override same-name generic extras. The Injector-owned shared memory volume has no standard annotation for a chart-owned `sizeLimit`, so this contract is intentionally limited to a small dotenv. Helm verifies only annotations, so provider staging must still inspect the webhook-mutated Pod.
4. Proxy and execution HPAs use CPU utilization only. They do not observe active graph runs, request rejection, PostgreSQL pool wait, object-store latency, memory pressure, or runtime-library preparation.
5. The recording persistence queue is intentionally bounded and drops new recordings when full. Published endpoint and web-app execution share a typed per-pod active-run admission gate; it has no in-memory queue, rejects excess work immediately in enforce mode, and prevents new public work during drain. The initial production bound is intentionally conservative and has not yet been validated by a representative load gate.
6. PostgreSQL connection validation bounds one downstream resource, but increasing execution replicas can still amplify provider calls, memory use, temporary files, and object-storage traffic.
7. Published workflows and web-app actions route to the execution Service, while UI/API and latest routes terminate on the backend. Evaluation execution is currently initiated through the editor-owned remote executor, not the scalable public execution Deployment. A chart-level Evaluation quota would therefore be cosmetic today; Problem 10 must first add durable server-owned dispatch before batch capacity can be isolated or reserved. `/workflows-latest/...` remains a control/debug surface and must not be used as a product endpoint.

### Risk Inference

A burst can fill memory or node ephemeral storage before CPU-based scaling reacts. Kubernetes may evict pods, graph runs may be interrupted, and adding replicas can move the bottleneck to PostgreSQL, S3, an LLM provider, or cluster scheduling. Separately, an externally injected Vault Agent can start after chart init containers or consume unreserved pod capacity unless the chart makes that mutation contract explicit and verifies it in a real cluster. An unbounded in-memory queue would only convert overload into latency and memory pressure.

### Proposed Solution

1. **Implemented guardrail, measured values open:** the environment-specific capacity profile requires every writable `emptyDir` to be bounded, injects the typed Vault dotenv agent first with explicit CPU/memory/node-ephemeral requests and limits, and requires every production workload to supply complete memory/ephemeral-storage request-and-limit pairs or an explicit acknowledgement for a deferred limit. Replace the supplied production acknowledgements with load-tested values and inspect the mutated Vault Agent Pod in provider staging after Injector changes.
2. **Implemented:** add per-execution-pod active-run admission for published routes with immediate `429/503` plus `Retry-After`; do not use a local queue. Do not add hidden graph/LLM retries; callers and graph retry settings remain authoritative.
3. After Problem 10 makes Evaluation dispatch durable and server-owned, add a separate bounded batch quota for Evaluation target/evaluator trials. Published endpoints get reserved capacity and higher scheduling priority by default; both classes remain visible and configurable. Do not retrofit a quota to the public execution Deployment while Evaluation trials do not run there.
4. Keep control/editor traffic on the existing backend topology. Do not introduce backend HPA or distributed debugger/editor ownership as part of this load work. Protect latest routes with documentation and an optional low concurrency/rate ceiling.
5. Export published active runs, batch active runs, admission saturation/rejections, memory/ephemeral usage, recording queue/drop rate, PostgreSQL pool wait, runtime-library preparation, and downstream error latency. Allow execution HPA/KEDA policies to use active published work in addition to CPU; if a durable Evaluation coordinator later owns batch dispatch, it may additionally expose its bounded batch backlog.
6. **Implemented harness; scenario matrix and provider evidence open:** the protected provider-staging capacity runner publishes unique short and long deterministic Code-plus-Delay fixtures, runs bounded success and overload stages only through the proxy-backed published endpoint, never retries a rejected request, checks direct control readiness canaries, and captures metric/event and immutable-image evidence. Add representative parallel/tool/provider scenarios after their data and idempotency boundaries are approved. Add a concurrent Evaluation batch scenario only after it is server-owned to prove batch work cannot starve public traffic. Derive requests, limits, HPA targets, and maximum replicas from retained provider evidence while retaining the PostgreSQL connection formula.

### Required Change Surfaces and Rollout

- **Admission (implemented):** one per-execution-process active-run limiter covers published endpoint/web-app HTTP and WebSocket execution, including trusted in-cluster published endpoints. It has no queue or queue timeout: enforce mode returns `429 execution_capacity_exceeded` with `Retry-After`, shutdown returns `503 execution_draining`, and WebSocket actions receive the matching protocol rejection code. Permits release on execution completion, setup failure, cancellation/interruption, and gateway disposal. During shutdown, the durable WebSocket gateway closes only its client sockets so accepted action processors can continue through the grace period; a separate HTTP-execution registry aborts remaining processors at the deadline before shared storage resources close. Latest/control work remains on its separate backend and cannot consume these slots.
- **Work classes (Problem 10 dependency):** once Evaluation dispatch is server-owned, classify public endpoint work and Evaluation batch work at dispatch. Reserve public slots; give batch work a separate limit and lower default priority without creating hidden retries or silently preempting an accepted trial.
- **Configuration:** expose limits through typed server configuration and Helm values; validate the positive per-pod ceiling and retry hint, and set client request timeouts coherently with shutdown grace. The admission design has no queue or queue-timeout setting.
- **Storage and resources (guardrail implemented):** all chart-managed writable `emptyDir` volumes have explicit limits. The typed Vault dotenv injector is pre-populate-only, init-first, and has explicit CPU/memory/node-ephemeral requests and limits so it cannot race chart init containers or remain an unaccounted pod resource. In a production render, each workload must otherwise carry memory and `ephemeral-storage` requests plus limits or a reviewable acknowledgement for each deferred resource; a stale acknowledgement fails once a complete pair exists. The remaining work is to replace deferrals and conservative volume sizes with measured capacity values, then inspect the injected container in provider staging because Helm does not execute the admission webhook.
- **Autoscaling:** use the Problem 11 metrics to scale proxy and execution only, combining CPU with active published work where the cluster supports Prometheus Adapter or KEDA. A future durable Evaluation coordinator may export its bounded batch backlog separately. Keep hard maxima consistent with PostgreSQL and downstream-provider capacity; leave backend/web fixed for this load model.
- **Load evidence (source harness implemented):** `yarn studio-server:verify:kubernetes:managed-capacity` requires exact staging acknowledgements and the already-deployed immutable candidate images, then creates isolated short/long deterministic fixtures and a single bounded candidate-image load Job. It can construct only `POST /workflows/<safe-generated-endpoint>` calls through the in-cluster proxy, not backend or `/workflows-latest/...`; its schema rejects arbitrary request headers and it has no retry path, no management credential, and no Kubernetes service-account token; its generated Job is explicitly non-root, read-only, and capability-free. Before creating fixtures, the host-side runner reads the protected staging Workflow endpoint access setting and refuses bearer-protected endpoints rather than placing `RIVET_KEY` in the Job; a protected-endpoint certificate requires separately scoped workload credentials and remains future work. It validates the emitted report against the exact configured stages, request/outcome totals, and control-canary counts before calculating thresholds; it records p50/p95/p99, status/rejection counts, direct control `/readyz` canaries, active/admission/recording metrics, per-Pod recording-drop counters compared to the pre-load baseline (new Pods start at zero), per-Pod restart counters, OOM state, and eviction events. It persists a sanitized partial report with the last completed phase, available snapshots, and cleanup outcome on every normal finalization path, then fails closed on temporary-resource cleanup; a local evidence-write failure is itself fatal and cannot claim certification. A pre-load sample may legitimately contain no execution Pod, but certification still requires complete metrics from at least one live execution-pod sample. Provider monitoring must still add memory/node-ephemeral high-water marks, downstream-provider concurrency, and external tool behavior. Evaluation-batch interference remains explicitly deferred until Problem 10 owns dispatch.

The generic chart begins with admission disabled; the production overlay uses an initial four-run enforce ceiling per execution pod. Before a real deployment adopts or changes that value, deploy `observe` mode in staging, report threshold crossings, establish measured limits from published-route traffic, enable rejection there, then retain conservative production headroom. Never silently retry rejected or interrupted graph runs.

### Risks of Fixing

- Limits chosen without measurement can reduce reliability. Defaults should remain conservative; the production overlay should be explicit and evidence-backed.
- Retrying rejected non-idempotent endpoint calls can duplicate side effects. Return clear overload metadata and leave retry decisions to an idempotency-aware caller.
- Adding a queue inside every replica would make load balancing unfair and reintroduce latent memory pressure. Preserve immediate, visible rejection instead of adding a local queue.

### Acceptance Criteria

- [x] Published workflow and web-app overload is rejected immediately without a local queue, and shutdown rejects new public work while admitted work drains.
- [x] A production render cannot accidentally leave writable-volume, memory, or node-ephemeral-storage policy unspecified: every writable volume is bounded and every omitted pod resource ceiling has an explicit rationale.
- [x] A protected, bounded, no-retry source harness targets only temporary published proxy endpoints, asserts visible overload rejection, captures direct control canaries plus metrics/events, records immutable-image-bound sanitized evidence, and fails if fixture/Job/ConfigMap cleanup leaks.
- [ ] A protected provider-staging run has retained evidence that sustained overload produces bounded latency/rejection and no OOM/ephemeral-storage eviction for the declared workload envelope.
- [ ] Retained provider evidence includes memory and node-ephemeral high-water marks for the proxy and execution Pods, so resource requests, limits, writable-volume sizes, admission ceilings, and HPA maxima are based on measured headroom rather than only the absence of OOM or eviction.
- [ ] Administrative/control operations remain usable during published-endpoint saturation.
- [ ] Proxy/execution HPA growth respects both workload demand and the validated database/downstream capacity ceiling; web/backend remain fixed.
- [ ] After Problem 10 moves dispatch server-side, an Evaluation batch cannot consume reserved published-execution capacity or materially breach the published endpoint SLO.
- [x] The capacity worker accepts only a generated safe endpoint slug and always builds `/workflows/<slug>` against the proxy Service; it cannot be configured with `/workflows-latest/...`, a backend URL, arbitrary headers, or a retry policy.

## Partially Implemented Problem 9: Managed Retention and Object Reconciliation Need One Durable Maintenance Owner

**Implementation status (2026-08-30): managed endpoint-recording retention, explicit managed recording/project deletion, known pre-commit upload failures, and dry-run reconciliation are implemented. Schema migration 3 adds the PostgreSQL-fenced singleton maintenance worker and transactional deletion outbox; migration 4 adds durable reconciliation state and findings. The control-plane API runs one bounded page per reconciliation domain at startup and on the existing five-minute timer by default; execution replicas remain excluded. Workflow metadata is checked with `HEAD`, workflow/runtime-library prefixes are list-only candidate sources, and Evaluation recording rows are checked for missing parent runs. Missing references and old unreferenced candidates are retained as evidence only. Candidates must be at least 24 hours old and recur across two completed scans before a future reviewed deletion phase may consider them. The worker never deletes or queues unknown objects.**

### Implemented Evidence

1. [`maintenance.ts`](packages/studio-server-api/src/routes/workflows/managed/maintenance.ts) owns one process-local scheduler and acquires the cross-pod lease from `managed_maintenance_leases`. Each destructive retention transaction calls `lease.assertCurrent()` under `FOR UPDATE` before PostgreSQL selects its bounded candidate batch; a stale owner cannot commit after another pod has advanced the fencing token.
2. `managed_object_deletion_outbox` is introduced by immutable schema migration 3. [`recordings.ts`](packages/studio-server-api/src/routes/workflows/managed/recordings.ts) removes expired/over-cap recording rows and queues their recording/replay keys in the same PostgreSQL transaction. Explicit recording deletion and project deletion in [`catalog.ts`](packages/studio-server-api/src/routes/workflows/managed/catalog.ts) queue their keys through the same primitive.
3. The worker claims one due key at a time with `FOR UPDATE SKIP LOCKED`, verifies that no workflow revision or recording still references it, then deletes it from object storage. A transient failure remains `pending` with bounded exponential backoff. A still-referenced key is marked `blocked` and retained for investigation instead of being deleted; a later metadata-deletion intent reopens that key after its final reference has gone away. Completed entries are held for seven days before purge.
4. [`revision-factory.ts`](packages/studio-server-api/src/routes/workflows/managed/revision-factory.ts) queues blobs known to have been uploaded before an insert/transaction failure through that same durable outbox rather than deleting them directly. If the queue write fails, it deliberately leaves the object intact: a rare orphan is safer than an unchecked delete of a duplicate/live key.
5. [`_env.tpl`](deploy/studio-server/helm/templates/_env.tpl), [`values.yaml`](deploy/studio-server/helm/values.yaml), and [`validate-values.yaml`](deploy/studio-server/helm/templates/validate-values.yaml) make the control-plane-only ownership and interval/lease/batch bounds chart-owned. Chart contract tests prove execution replicas do not schedule maintenance and callers cannot smuggle an override through `env`; the managed context gates reconciliation-only storage clients on that same configuration.
6. Migration 4's [`reconciliation.ts`](packages/studio-server-api/src/routes/workflows/managed/reconciliation.ts) stores a stable prefix-relative per-domain cursor, phase, generations, completion/error timestamps, and durable findings. It checks workflow references using object metadata only; scans workflow and runtime-library prefixes in bounded pages; skips runtime-library auditing safely before its separate schema exists; and detects Evaluation recording rows without their required Evaluation run. It never calls object deletion or the deletion outbox.
7. A candidate object is recorded only after the 24-hour minimum age and a fresh metadata ownership recheck. `consecutive_complete_scans` advances only across completed generations. [`metrics.ts`](packages/studio-server-api/src/metrics.ts) exports finite-label page/outcome/phase counters plus completed-generation and open-finding gauges. `yarn studio-server:managed-reconciliation:status` exposes every domain (including a read-only `not-started` state on a fresh database), aggregate counts/timestamps, and never raw object keys.

### Remaining Work

1. The crash window after object upload but before a durable deletion intent (plus historical objects) now becomes an age-gated evidence candidate, not a deletion. A separate reviewed policy must define which candidate kinds may ever be deleted, their minimum age/scan threshold, a final ownership recheck, operator approval, and recovery behavior.
2. Runtime-library auditing is scheduled, but runtime-library release retention remains its own policy. Do not substitute a prefix candidate for the runtime-library cleanup command or delete extracted pod-local caches from this worker.
3. Evaluation auditing detects a recording without a run; Evaluation temporary recording, run, snapshot, and baseline retention still need a reference-safe lifecycle before they share destructive maintenance.
4. The status command and finite Prometheus metrics expose reconciliation phase, completion, page outcomes, and open counts. They do not yet expose outbox pending/blocked age, scan byte volume, SLO alerts, dashboards, or an authenticated detailed-finding workflow.
5. Object listings are candidate evidence only and may be eventually consistent. No generic future adapter may skip the age gate, two completed scans, and database ownership recheck; no automatic deletion is authorized by migration 4.

### Guardrails and Rollout

- Migration 4 is additive. A normal v4 release verifies exactly schema `4`; only a guarded forward rollback renders the prior v3 image with `2..4` compatibility, preserving the migrated schema without asking serving pods to apply or reverse DDL.
- Do not enable maintenance on execution replicas. The `/workflows/...` plane is the high-load tier and must not multiply global retention scans.
- An outbox key is unique and is never deleted while any durable workflow revision/recording references it. A `blocked` record is not retried on its timer alone; a later durable deletion intent reopens it, which handles the normal case where its final reference is removed after the earlier safety check.
- Reconciliation finding subjects and prefix-relative last-key cursors remain PostgreSQL-only; scans never persist provider continuation tokens. Object keys never become metric labels, status output, or ordinary logs. A list result is never a deletion decision.
- The only automatic destructive adapter in this slice is bounded, unpinned endpoint-recording retention plus explicit recording/project deletion. Do not route Evaluation, runtime-library, or generic orphan deletion through it until each has its own policy and protected-artifact tests.

### Acceptance Status

- [x] Idle managed installations enforce endpoint-recording retention from the singleton control plane.
- [x] Deleted managed recording/project artifacts survive transient object-store failure as durable retry work.
- [x] Stale maintenance contenders cannot commit the fenced recording-retention transaction.
- [x] Helm proves only the control plane schedules maintenance and validates its bounds.
- [x] A known pre-commit upload failure queues exact keys or leaves them intact when that queue cannot be persisted; it never falls back to an unchecked direct delete.
- [x] A safe dry-run/reconcile pass inventories workflow and runtime-library objects plus Evaluation recording/run integrity without deleting or queueing unknown objects.
- [x] Missing referenced artifacts create durable integrity findings, while true old workflow/runtime candidates need two completed audit generations before any later deletion policy may consider them.
- [ ] Production alert routing must turn persistent missing-reference/open-finding gauges into owned incidents; migration 4 intentionally does not configure an unreviewed alert threshold.
- [ ] Evaluation, runtime-library, short-lived web-app transport, and stale-upload adapters need independent destructive retention and protected-artifact semantics.
- [ ] Operations still need outbox pending/blocked age, scan-byte, and maintenance-freshness dashboards/SLOs; the status command provides only a safe aggregate reconciliation baseline.

## Open Problem 10: Hosted Evaluation Runs Are Durable but Not Server-Resumable

**Implementation status (2026-08-29): run definitions, snapshots, incremental observations, and recording references are durable. The scheduler remains client/Rivet-owned and does not automatically resume after browser, control-pod, or executor ownership loss.**

This is not a control-plane scaling problem for the expected three authors. It is a correctness and batch-isolation problem: one author can still launch cases × trials × evaluators worth of graph execution work.

### Observed Evidence

1. The hosted Evaluation store checkpoints `run-started`, `trial-settled`, and `run-finalized` state and preserves completed trials after interruption.
2. `developer-docs/studio-server/editor-bridge.md` explicitly records that the current scheduler does not resume an interrupted Evaluation automatically and that total Evaluation history/retained-artifact policy remains open.
3. The Kubernetes release gate exercises normal workflow/web-app persistence and WebSocket owner interruption, but it does not start a multi-trial Evaluation, kill its owner, and prove deterministic continuation.

### Risk Inference

A long or expensive Evaluation can stop when the initiating browser closes or its runtime owner disappears. Completed trials remain inspectable, but queued trials do not finish and the user has no authoritative server-owned continuation contract. Blindly re-running in-flight trials would violate the Evaluation rule that Rivet must not introduce hidden retries.

### Proposed Solution

1. For hosted mode, add a server-owned Evaluation run coordinator with durable run/trial state, bounded worker claims, leases, cancellation commands, and deterministic trial IDs.
2. Persist each trial transition before dispatch and settle by unique `(run, case, trial)` identity. After owner loss, keep settled trials, mark any accepted in-flight trial explicitly interrupted, and continue only never-started queued trials. Retrying an interrupted trial must be an explicit user/suite policy, not an invisible recovery action.
3. Let execution replicas claim target/evaluator work subject to the separate Evaluation batch quota from Problem 8. Preserve deterministic result ordering independent of completion order and reserve published endpoint capacity.
4. Add Evaluation-specific retention: per-suite run age/count, total metadata/snapshot bytes, retained-recording bytes, and exclusions for baselines/manual pins. Dataset snapshots shared by retained runs require reference-safe leases before deletion.
5. Add Kubernetes disruption coverage for cancellation, owner loss, queued-trial continuation, and no-duplicate observations.

### Required Change Surfaces and Rollout

- **Run model:** extend the hosted Evaluation run schema with coordinator state, deterministic trial identity, claim/lease owner and expiry, accepted/interrupted timestamps, cancellation state, and an optimistic revision.
- **Coordinator:** add server-owned claim/dispatch/finalization services in `packages/studio-server-api`; workers must settle idempotently and preserve deterministic result ordering.
- **Execution bridge:** route target and evaluator graphs through the execution tier's batch work class, while preserving separate target/evaluator cost and provenance. Do not execute graph workload on the singleton control backend.
- **UI/API:** expose queued/running/interrupted/continuing state, owner-loss explanations, explicit retry of interrupted trials, and cancellation acknowledgement. Do not imply that interrupted work was retried automatically.
- **Retention:** make run/snapshot/recording retention reference-safe and integrate it with the Problem 9 maintenance owner.

Introduce the server coordinator behind a hosted capability flag. Start new runs on it while old records remain readable through the existing normalizer. Do not transfer an already-running client-owned run. After browser-close and pod-loss tests pass in staging, make server ownership the hosted default; retain a clearly labeled local/browser executor path for non-hosted use.

### Risks of Fixing

- Moving scheduling from the browser to the server changes execution ownership and credential availability. Browser-only credentials must be rejected or explicitly projected through an allowed server contract.
- At-least-once dispatch can repeat non-idempotent graphs. Durable state must distinguish never-started work from interrupted accepted work.
- A centralized coordinator can become another singleton. Use database claims and horizontally scalable workers.

### Acceptance Criteria

- [ ] Closing the browser does not stop a hosted Evaluation.
- [ ] Killing the active worker preserves settled trials, marks accepted work accurately, and continues queued work without hidden retries.
- [ ] Cancellation prevents new claims and retains already settled observations.
- [ ] Retention never deletes a baseline, manual pin, active-run snapshot, or artifact referenced by another retained run.

## Partially Implemented Problem 11: Production SLO Telemetry and Alerts Need Completion

**Implementation status (2026-08-30): implemented a bounded in-process Prometheus text surface for the direct control and execution API services. It instruments finite-label HTTP, health, public admission, recording persistence, PostgreSQL-pool, managed object-storage, and runtime-library-job signals; normal execution is protected from telemetry failures. The Helm chart now has opt-in ServiceMonitor and conservative PrometheusRule templates, while Compose and candidate-image smoke exercise the same API-only opt-in without exposing it through the public proxy. It has not been enabled in a production overlay, validated under the Problem 8 load gate, connected to a dashboard/paging policy, or extended to settings, maintenance, evaluations, proxy/executor correlation, and integrity signals.**

### Observed Evidence

1. `packages/studio-server-api/src/metrics.ts` provides a pull-only Prometheus text registry. It has fixed route/method/status and domain/operation/outcome labels, adds only the bounded `control` or `execution` profile, and never records a project, graph, prompt, secret, raw input, request ID, or error message.
2. `packages/studio-server-api/src/app.ts` serves `/metrics` only when `RIVET_METRICS_ENABLED=true`; the route refreshes cached health and reads process-local PostgreSQL/recording queue snapshots. Probe and scrape requests are explicitly excluded from application HTTP metrics.
3. `deploy/studio-server/helm/templates/metrics.yaml` optionally renders two direct-Service `ServiceMonitor` resources and a small `PrometheusRule`; `_env.tpl`, `validate-values.yaml`, and the API entrypoint make the enablement chart-owned after Vault dotenv loading.
4. `deploy/studio-server/compose/docker-compose.yml`, `deploy/studio-server/compose/docker-compose.dev.yml`, and the candidate-image smoke runner pass `RIVET_METRICS_ENABLED` only to the direct API service. Candidate smoke enables the endpoint and probes it from that container; the public proxy has no `/metrics` route.
5. Run statistics remain product-facing history. The first metrics slice exposes recording drops and operational dependencies, but does not yet cover maintenance/outbox lag, settings convergence, Evaluation batch scheduling, proxy/executor behavior, missing-reference integrity, restart/OOM/eviction, or correlation/tracing.

### Risk Inference

The system can fail closed correctly yet still provide too little warning before an incident. Operators may first learn about queue drops, storage growth, provider latency, or control-plane loss through user reports and logs that lack an SLO view.

### Proposed Solution

1. Extend the implemented low-cardinality, secret-free metrics surface beyond its HTTP/health/admission/recording/PostgreSQL/object-storage/runtime-library baseline to settings convergence, maintenance/reconciliation, Evaluation batch work, proxy/executor behavior, and integrity state.
2. Keep the implemented optional ServiceMonitor/PrometheusRule path disabled by default; add a PodMonitor only if the ClusterIP Service contract cannot be used in a target cluster.
3. Define separate SLOs for published execution availability, latency, and overload; control/editor availability and recovery; recording durability; and maintenance freshness. The published execution SLO is the primary product SLO. The singleton backend must have an honest low-volume control-plane SLO rather than being presented as HA.
4. Propagate a request/run correlation ID through proxy, API, executor, recording, and Evaluation logs/traces. Never attach prompts, secrets, arbitrary input values, workflow names, or unbounded IDs as metric labels.
5. Add alert rules for missing ready replicas, restart/OOM/eviction, database pool saturation, object-store error bursts, recording drops, stuck runtime-library jobs, stale maintenance leases, missing referenced objects, and failed scheduled/provider gates.

### Required Change Surfaces and Rollout

- **Instrumentation:** retain the implemented API registry and extend it to settings convergence, Evaluations, maintenance, proxy/executor behavior, and integrity state. Do not turn API-only metrics into a public-proxy endpoint.
- **Correlation:** generate or accept a bounded request/run correlation ID at the trusted edge and propagate it through proxy, API, executor, recordings, and structured logs without using it as an unbounded metric label.
- **Chart:** retain the implemented optional ServiceMonitor and PrometheusRule templates plus validation that leaves minimal installations independent of Prometheus; add a PodMonitor only if a target cluster cannot use the direct-Service contract.
- **SLO assets:** version separate dashboards and alert rules for the published execution plane and low-volume control plane. The execution dashboard must show public versus Evaluation-batch work, proxy/execution saturation, downstream dependencies, execution outcomes, recording ingestion/drops, and maintenance freshness.
- **Failure policy:** telemetry exporters must be asynchronous and bounded. Export failure must never block execution, alter a quality verdict, or make a healthy dependency appear unhealthy.

Roll out the implemented endpoint and ServiceMonitors without PrometheusRule alerts first, validate cardinality and overhead under the Problem 8 load gate, then publish separate dashboards. Enable recording alerts next, followed by paging alerts only after thresholds are tuned from observed staging/production behavior. Test every critical alert with controlled failure injection.

### Risks of Fixing

- High-cardinality labels can overload the monitoring system and leak project data. Keep project/run detail in logs or traces behind access control.
- Synchronous telemetry export can slow workflow execution. Metrics must be in-process and bounded; traces/log export must be asynchronous with backpressure/drop policy.
- Alerts without measured thresholds create noise. Seed rules conservatively and tune them with the Problem 8 load gate and real provider latency.

### Acceptance Criteria

- [x] HTTP, readiness, published admission, recording persistence, PostgreSQL pool, managed object-storage, and runtime-library signals have bounded labels and a pull-only scrape endpoint.
- [x] Metrics remain bounded in label cardinality under many projects/runs.
- [x] Telemetry failure cannot make the API unready or block graph execution.
- [ ] A synthetic database/object outage, overload burst, recording-queue overflow, and stuck maintenance job each produce a specific signal and tuned actionable alert.
- [ ] Dashboards distinguish control-plane health from published execution-plane health.

## Cross-Problem Delivery Roadmap

The problems are related and should not be implemented as six isolated feature branches.

### Current Implementation Frontier

As of 2026-08-30, the immediate **operational** sequence remains Phase 1: retain a successful digest-pinned release/previous-image compatibility result and a clean provider-backed restore report before using load evidence to tune production. Then run the protected published-capacity gate against the same production-equivalent staging topology: collect an observe-mode baseline first, add provider memory/node-ephemeral and downstream-concurrency evidence, run the manually selected CI certificate, and retain its report. That evidence must drive the production resource pairs, writable-volume sizes, admission ceiling, and proxy/execution scaling bounds; a green synthetic run must not be used to bless the current placeholder values unchanged.

While protected provider access and recovery fixtures are being arranged, the completed Problem 9 audit inventory can collect evidence without deleting unknown objects. The next substantial source-code milestone is Problem 10's server-owned Evaluation coordinator; it is required before Evaluation work can receive a real execution-tier batch budget. Problem 9 destructive retention policy and Problem 11 alerting remain parallel follow-ups, but neither should be improvised from prefix listings. This does not waive the Phase 1 or Phase 2 operational exit gates.

### Phase 1: Make Releases and Recovery Auditable

Certify the already implemented Problem 6 immutable release manifest/mixed-version migration check and Problem 7 clean restore drill. These protect against the two hardest-to-reverse failures: deploying unknown bytes and discovering during an incident that durable stores cannot be restored together.

**Exit gate:** one digest-pinned staging release can fail and roll back compatibly; one clean restore report verifies every durable surface within the stated RPO/RTO.

### Phase 2: Measure and Bound Published Runtime Load

Validate and extend the implemented Problem 11 metrics baseline while completing the public-execution slice of Problem 8 around the already implemented admission, storage guardrails, and protected capacity harness. Run the existing harness first in observe mode and then through its manually selected certificate path; retain immutable-image-bound evidence, add provider memory/node-ephemeral high-water marks and downstream-concurrency observations, replace temporary resource deferrals with measured values, and add proxy/execution autoscaling signals within the validated database/provider ceiling. Extend the scenario matrix only with deterministic, approved provider/tool workloads. Do not attempt Evaluation batch isolation in this phase because Evaluation dispatch is still editor-owned; that dependency belongs to Phase 4. Do not set hard production limits before the relevant high-water marks are observable, and do not add backend/web autoscaling for the stated operator load.

**Exit gate:** a production-shaped published-route overload remains bounded, produces intentional rejection rather than eviction/OOM collapse, preserves control-plane usability, and is observable through the metrics/dashboard contract. Problem 8 remains partially open for its Evaluation-dependent slice until Phase 4.

### Phase 3: Make Durability Maintenance Convergent

Complete Problem 9 beyond its implemented audit inventory: define reviewed stale-upload and runtime-library/Evaluation retention policies, add alert/dashboard ownership for persistent findings and outbox lag, and retain the shared lease/outbox primitives rather than creating a second scheduler.

**Exit gate:** injected object-delete failures converge after recovery; idle systems still enforce retention; missing referenced artifacts produce incidents rather than silent deletion.

### Phase 4: Make Hosted Evaluations Server-Owned and Capacity-Isolated

Implement Problem 10 on top of admission, metrics, and maintenance primitives. Once dispatch is durably server-owned, complete the Evaluation-dependent slice of Problem 8 with a separate bounded batch quota, reserved public-execution capacity, and visible batch metrics. This order avoids a cosmetic chart quota that cannot control editor-owned work and avoids creating a second scheduler, queue, lease system, or retention owner with different semantics.

**Exit gate:** browser and worker loss preserve settled trials, continue only never-started work, expose interrupted work accurately, and never create hidden retries or duplicate observations; a concurrent Evaluation batch cannot materially breach the published endpoint SLO.

### Phase 5: Certify Provider Operations and Reconsider Control-Plane HA

Retain scheduled Kind and protected provider-stage evidence for release, restore, outage, key rotation, and alert behavior. Only then design distributed/fenced latest-debugger and editor-executor ownership if the control-plane SLO requires more than the supported singleton backend.

**Exit gate:** current provider evidence is retained and reviewable; any backend scale-out has explicit ownership, fencing, reconnect, and takeover tests before the Helm singleton guard is removed.

## Production-Ready Definition of Done

Managed Kubernetes should be described as production-ready for a specific environment only when all applicable statements are true:

- The deployed release is bound to source, chart, schema version, and four immutable image digests.
- The previous supported image is proven compatible with the current expanded schema, or the release is explicitly non-rollbackable with a tested restore plan.
- PostgreSQL, object storage, and App Settings key material have a current clean-environment restore report meeting declared RPO/RTO.
- Published execution overload is bounded by measured admission, proxy/execution resources, autoscaling, database, recording, and downstream-provider limits; Evaluation batch work cannot consume reserved public capacity.
- Retention and object deletion have one fenced owner, durable retry, integrity reporting, and protected-artifact semantics.
- Hosted Evaluations survive initiator loss according to explicit no-hidden-retry behavior.
- Metrics and dashboards distinguish control-plane, execution-plane, storage, and maintenance health; critical failure modes have tested alerts.
- Kind and protected provider-stage evidence is current for the deployed topology.
- The backend singleton boundary is shown honestly in the low-volume control-plane availability model. Distributed ownership is required only if a future control-plane availability requirement—not throughput—justifies it.
- Operator documentation names owners for releases, backups, keys, capacity, maintenance, alerts, and incident response.

## Assumptions Checked

| Assumption                                                                     | Audit result              | Evidence / qualification                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------------------------ | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Recent features have managed persistence implementations.                      | Supported.                | Workflow revisions/publications, recordings, evaluations, runtime libraries, LLM health, and web-app WebSocket run state have managed stores cited above.                                                                                                                                                                             |
| All evaluation artifacts are stored in object storage.                         | Not supported; corrected. | The managed evaluation store persists its definitions and run payloads in PostgreSQL. Recording artifacts referenced by evaluation runs follow the recording store, but the evaluation store itself is not an object-store implementation.                                                                                            |
| Any API replica can normally edit app settings.                                | Not supported; corrected. | Settings mutation routes are control-plane-only. Execution replicas read the PostgreSQL settings repository and receive pod-local compatibility projections; they do not share a writable settings filesystem.                                                                                                                        |
| Workflow-schema startup retries protect against PostgreSQL DDL deadlocks.      | Supported, narrowly.      | The migration library serializes DDL with an advisory lock and retries only PostgreSQL `40P01`, `40001`, and `55P03`; the common query retry policy remains network-only.                                                                                                                                                             |
| A web-app coordinator listener disconnect necessarily makes the pod unhealthy. | Not supported; corrected. | The coordinator reconnects and polls. Readiness checks gateway acceptance and its owned PostgreSQL pool, not the optional notification channel, so a recoverable listener reconnect does not remove the pod from service.                                                                                                             |
| The chart currently depends on shared app-data storage.                        | No; fixed.                | App Settings are encrypted PostgreSQL rows. Backend/execution app data is pod-local `emptyDir`, proxy has no app-data mount, and a legacy PVC is optional migration-only input.                                                                                                                                                       |
| `verify:kubernetes` is a live cluster test.                                    | Not supported; corrected. | It is a static Helm/template/contract gate. Manual cluster tooling exists separately.                                                                                                                                                                                                                                                 |
| Current Kubernetes managed mode is definitely broken.                          | Not established.          | Static verification passes and managed stores exist. The report identifies unproven HA/operations paths and concrete design risks, not a reproduced blanket failure.                                                                                                                                                                  |
| The backend can safely scale beyond one replica today.                         | Not supported.            | The chart intentionally enforces one backend because latest-debugger and co-located editor-executor sessions still have process-local ownership. This is an explicit topology boundary, not an accidental omission.                                                                                                                   |
| The PostgreSQL connection formula and CPU HPA fully bound execution load.      | Not supported.            | They bound database connections and give CPU scaling a valid denominator. The public per-pod admission gate, bounded writable volumes, and explicit production resource-policy decisions add guardrails, but measured resource ceilings, Evaluation isolation, and downstream-provider concurrency still lack one validated envelope. |
| Provider-outage recovery proves disaster recovery.                             | Not supported.            | The disruption gate recovers the same live PostgreSQL and MinIO instances. It does not restore a mutually consistent historical database, object set, and encryption-key set into a clean environment.                                                                                                                                |
| Durable Evaluation rows imply resumable Evaluation execution.                  | Not supported.            | Settled observations survive, but the current client-owned scheduler does not automatically continue queued trials after its owner disappears.                                                                                                                                                                                        |
| Omitting default hard memory limits is necessarily a chart defect.             | Not established.          | Generic limits can OOM-kill legitimate long runs. Production now requires a complete resource pair or an explicit acknowledgement for each intentional deferral; the remaining actionable gap is the production-specific, load-tested capacity and admission envelope.                                                                |
| Few Studio users mean the whole server has low load.                           | Not supported.            | UI/control traffic is low, but published `/workflows/...` traffic, recording ingestion, storage access, and provider calls scale with product usage.                                                                                                                                                                                  |
| Recording load is low because few operators open recordings.                   | Not supported.            | Recording reads are low-volume; recording creation, metadata writes, blob storage, queue pressure, and retention work are proportional to published executions.                                                                                                                                                                       |
| Three Evaluation authors imply negligible Evaluation execution load.           | Not supported.            | Authoring/control is low-volume, but one suite can fan out cases × trials × evaluators. Problem 10 must first move dispatch server-side; then it needs a bounded batch quota that cannot starve public endpoints.                                                                                                                     |

## Useful Verification Commands

```powershell
yarn studio-server:verify:kubernetes
yarn studio-server:verify:repo-structure
yarn studio-server:test
git diff --check
```

For a local live rehearsal:

```powershell
yarn studio-server:dev:kubernetes-test
```

That manual command is useful operational evidence, but it should not be treated as a substitute for a repeatable automated managed-mode gate.
