# Runtime Libraries

Managed runtime libraries let hosted Rivet `Code` nodes `require()` packages that are not baked into the base images.

The dashboard exposes this through the `Runtime libraries` button in the left panel.

## Backend modes

Runtime libraries now follow `RIVET_STORAGE_MODE`:

- `filesystem`
- `managed`

`filesystem` preserves the original single-host layout and is only valid when the
backend is not scaled beyond one replica.

`managed` stores:

- release metadata, activation state, and job state in Postgres
- immutable release artifacts in object storage
- `current/` under `RIVET_RUNTIME_LIBRARIES_ROOT` as a local extracted cache

Managed mode reuses the same database and object-storage connection settings as
managed workflow storage and uses the fixed object key prefix `runtime-libraries/`.
That means `RIVET_STORAGE_MODE=managed` switches both workflows and runtime libraries
to the managed backend together.

## Backend wiring

The runtime-library backend is still selected once per process in
`wrapper/api/src/runtime-libraries/backend.ts`:

- `filesystem` creates the legacy single-host backend
- `managed` creates `ManagedRuntimeLibrariesBackend`

That managed facade keeps the supported runtime modes visible instead of hiding them:

- `managed/backend.ts` owns lifecycle, chooses whether this process is worker-enabled or sync-only, and preserves the public API surface
- `managed/context.ts` owns the shared Postgres/blob-store/local-cache/process identity dependencies
- `managed/job-store.ts` owns job persistence, job-log appends, heartbeats, and cancellation flags
- `managed/job-stream.ts` owns SSE framing and termination semantics
- `managed/job-worker.ts` owns claim/heartbeat/recovery loops for worker-enabled processes
- `managed/artifact-activation.ts` owns build-upload-activate-finalize sequencing
- `managed/process-registry.ts` owns in-flight child-process tracking and termination
- `managed/replica-status.ts` owns stale-replica cleanup helpers
- `managed/cleanup.ts` remains the separate audit/prune orchestrator for historical releases, jobs, and orphaned artifacts

Canonical managed config:

- `RIVET_STORAGE_MODE=managed`
- `RIVET_DATABASE_MODE=local-docker|managed`
- `RIVET_DATABASE_CONNECTION_STRING`
- `RIVET_DATABASE_SSL_MODE=disable|require|verify-full`
- recommended object-storage URL form:
  - `RIVET_STORAGE_URL`
  - `RIVET_STORAGE_ACCESS_KEY_ID`
  - `RIVET_STORAGE_ACCESS_KEY`
- optional explicit S3 tuple form:
  - `RIVET_STORAGE_BUCKET`
  - `RIVET_STORAGE_REGION`
  - `RIVET_STORAGE_ENDPOINT`
  - `RIVET_STORAGE_ACCESS_KEY_ID`
  - `RIVET_STORAGE_ACCESS_KEY`
  - `RIVET_STORAGE_PREFIX`
  - `RIVET_STORAGE_FORCE_PATH_STYLE`
- optional runtime-library sync tuning:
  - `RIVET_RUNTIME_LIBRARIES_SYNC_POLL_INTERVAL_MS`
- optional replica-status retention tuning:
  - `RIVET_RUNTIME_LIBRARIES_REPLICA_STATUS_RETENTION_MS`
  - `RIVET_RUNTIME_LIBRARIES_REPLICA_STATUS_CLEANUP_INTERVAL_MS`
- explicit process role for readiness reporting:
  - `RIVET_RUNTIME_PROCESS_ROLE=api|executor`
- explicit split-topology readiness tier override:
  - `RIVET_RUNTIME_LIBRARIES_REPLICA_TIER=endpoint|editor|none`
- explicit per-process job-worker ownership override:
  - `RIVET_RUNTIME_LIBRARIES_JOB_WORKER_ENABLED=true|false`

The official API and executor images set `RIVET_RUNTIME_PROCESS_ROLE` automatically.
Custom launches should set it explicitly when `RIVET_STORAGE_MODE=managed` so replica-readiness
reporting lands in the correct tier.

Default inference rules when you do not override the topology envs:

- `RIVET_RUNTIME_PROCESS_ROLE=api` defaults `RIVET_RUNTIME_LIBRARIES_REPLICA_TIER` to `endpoint`
- `RIVET_RUNTIME_PROCESS_ROLE=executor` defaults `RIVET_RUNTIME_LIBRARIES_REPLICA_TIER` to `editor`
- `RIVET_RUNTIME_LIBRARIES_JOB_WORKER_ENABLED` defaults to `true`

That means the repo-local Docker stacks, which run one combined `api` service with `RIVET_RUNTIME_PROCESS_ROLE=api` and no explicit tier override, report that single API container as `Endpoint execution`.

The current chart split uses the runtime-library topology envs like this:

- control-plane `api`
  - `RIVET_RUNTIME_PROCESS_ROLE=api`
  - `RIVET_RUNTIME_LIBRARIES_REPLICA_TIER=none`
  - `RIVET_RUNTIME_LIBRARIES_JOB_WORKER_ENABLED=true`
- execution-plane `api`
  - `RIVET_RUNTIME_PROCESS_ROLE=api`
  - `RIVET_RUNTIME_LIBRARIES_REPLICA_TIER=endpoint`
  - `RIVET_RUNTIME_LIBRARIES_JOB_WORKER_ENABLED=false`
- `executor`
  - `RIVET_RUNTIME_PROCESS_ROLE=executor`
  - `RIVET_RUNTIME_LIBRARIES_REPLICA_TIER=editor`

Default replica-status retention policy:

- `RIVET_DATABASE_MODE=local-docker`
  - retain stale replica rows for `24h`
  - run background stale-row cleanup every `15m`
- `RIVET_DATABASE_MODE=managed`
  - retain stale replica rows for `15m`
  - run background stale-row cleanup every `5m`

Retired aliases such as `RIVET_WORKFLOWS_STORAGE_*`, `RIVET_OBJECT_STORAGE_*`,
`RIVET_STORAGE_BACKEND`, and `RIVET_RUNTIME_LIBS_SYNC_POLL_INTERVAL_MS` now fail fast.

## On-disk layout

Runtime libraries use a simple persistent layout rooted at `RIVET_RUNTIME_LIBRARIES_ROOT`:

```text
<root>/
  manifest.json
  current/
    package.json
    node_modules/
  jobs/
```

During activation, the runtime-library backend may also create a transient `current.previous`
backup while swapping the extracted release into place.

In `managed` mode, this root is a local cache/workspace only. The authoritative source
of truth is:

- Postgres for release metadata, activation state, and job state
- object storage for immutable `runtime-libraries/releases/<releaseId>/release.tar` artifacts

## Execution bootstrap

Runtime-library sync is part of execution wiring, not only the admin UI:

- `prepareRuntimeLibrariesForExecution()` goes through the root runtime-library backend singleton
- API-side `Code` node execution reaches that path through `ManagedCodeRunner` only when Rivet enables `require(...)` for that code invocation
- plain JS Code/Expression executions that do not receive `require(...)` skip runtime-library preparation, because they cannot resolve wrapper-managed packages
- `ManagedRuntimeLibrariesBackend.prepareForExecution()` forces the managed backend to initialize and reconcile the local `current/` cache before managed-package code execution continues
- in managed mode, `managed/context.ts` prefers the process-local `globalThis.__RIVET_PREPARE_RUNTIME_LIBRARIES__` hook when one exists, then falls back to `localCache.sync(force)`
- that keeps API processes and executor processes on the same "prepare then resolve `current/node_modules`" contract even though they are different runtimes

`ManagedCodeRunner` is still request-scoped, but it now keeps runtime-library
preparation lazy and stable inside one workflow request:

- if no code node requests `require(...)`, the request performs no
  runtime-library sync
- the first `includeRequire=true` code invocation prepares the active
  runtime-library snapshot
- later `includeRequire=true` invocations in the same workflow request reuse
  that same preparation promise
- package installs/removals are therefore observed on a later workflow request,
  not in the middle of a running workflow

The runner also keeps a bounded process-level cache of successful
`AsyncFunction` compilations. The cache key contains the generated code and the
exact argument-name shape. Request values such as `inputs`, `graphInputs`,
`context`, `require`, and `Rivet` are never cached; they are passed fresh on
every invocation.

For `require(...)`-enabled code, the runner creates the managed `require`
resolver lazily after runtime-library preparation and reuses it for the
workflow request. Resolver caching is keyed by the runtime-library root, the
active `node_modules` path, and the manifest snapshot (`activeReleaseId` when
available, otherwise `updatedAt`, otherwise the active `node_modules`
timestamp). When a later request observes a different snapshot for the same
local runtime-library path, the wrapper drops the stale managed resolver and
clears CommonJS modules loaded from that `node_modules` tree so the next
request resolves the newly active packages.

Operational flags:

- `RIVET_CODE_RUNNER_TELEMETRY=true` enables ManagedCodeRunner aggregate timing
  telemetry for endpoint runs when workflow debug headers are also enabled
- `RIVET_MANAGED_CODE_RUNNER_DISABLE_CACHE=true` disables only the compiled
  function cache
- `RIVET_MANAGED_CODE_RUNNER_FORCE_PREPARE_EVERY_CODE=true` restores the old
  per-code runtime-library preparation behavior without disabling telemetry or
  the compiled-function cache

## API surface

The runtime-library API lives under `/api/runtime-libraries`:

- `GET /` returns the current manifest, `hasActiveLibraries`, `updatedAt`, and any active job
- in `managed` mode, `GET /` also returns `replicaReadiness` for the current active release
- `POST /install` starts an install job
- `POST /remove` starts a removal job
- `POST /replicas/cleanup` immediately deletes rows that are already stale by heartbeat TTL
- `GET /jobs/:jobId` returns the current/most-recent job state
- `POST /jobs/:jobId/cancel` requests cancellation of a queued or running job
- `GET /jobs/:jobId/stream` streams job logs and status changes over SSE

Only one install/remove job can run at a time.

In `managed` mode that exclusivity is enforced in Postgres, not only in process memory.
In the current split, install/remove job ownership stays on the control-plane API while execution-plane API replicas run in sync-only mode.
In combined local modes, the single API process owns both the admin flow and any published-execution-side reconciliation it still performs.

Current `activeJob` semantics are intentionally mode-specific:

- in `filesystem` mode, `GET /api/runtime-libraries` exposes only a currently running job
- once a filesystem job reaches `succeeded` or `failed`, it is no longer returned as modal state on later refreshes or reopen
- `GET /api/runtime-libraries/jobs/:jobId` still returns that finished filesystem job by id so an already-open modal session can keep its terminal view
- in `managed` mode, job state and logs remain persisted in Postgres and continue to survive refreshes and process restarts

Managed `replicaReadiness` is observational only:

- `endpoint` readiness reflects execution-plane API replicas
- `editor` readiness reflects executor-process replicas
- control-plane API replicas are excluded from endpoint readiness by reporting `tier=none`
- only replicas that have heartbeated recently are counted in the live denominator
- stale rows are excluded from the live denominator and reported separately
- polling `GET /api/runtime-libraries` does not trigger convergence by itself

The cleanup route is also observational only:

- it deletes only rows that are already stale
- it does not affect the active release, local caches, or reconciliation
- it is useful when managed Postgres still contains stale rows from previous containers, pods, or crashed processes and you want the modal to stop showing historical noise immediately

## Replica-status retention and cleanup

Replica-status rows exist to explain recent convergence and recent failures. They are not part of execution correctness.

Current behavior:

- rows become `stale` when their heartbeat is older than the current heartbeat TTL
- stale rows are excluded from the live denominator immediately
- background cleanup later removes old stale rows using the retention policy above
- `POST /api/runtime-libraries/replicas/cleanup` can remove the currently stale rows immediately without waiting for the retention window

Typical sources of stale rows:

- a Docker container restart against a persistent managed Postgres database
- a Kubernetes rollout that replaced old pods with new ones
- a pod crash, node loss, or network partition that prevented clean shutdown
- a replica that stopped reporting because it could not reach Postgres

## Job lifecycle

Current job statuses are:

- `queued`
- `running`
- `validating`
- `activating`
- `succeeded`
- `failed`

The dashboard opens an `EventSource` to `/jobs/:jobId/stream` and appends log lines live while the job runs.

Cancellation behavior:

- the UI or API can request cancellation while a job is queued or running
- the backend records `cancelRequestedAt` and stops the install/remove flow as soon as it can do so safely
- cancellation does not create a partial successful release; the previously active release remains active
- the current terminal state remains `failed`, with the cancellation time preserved in the job payload

## Install/remove model

Install and remove both rebuild a complete candidate release:

1. Read the active package set from the selected backend.
2. Add or remove the requested package entries from the candidate set.
3. Recreate a temporary candidate directory.
4. Generate a synthetic `package.json` with the candidate dependencies.
5. Run `npm install --omit=dev --no-audit --no-fund` when dependencies are present.
6. Validate every requested package by resolving it from the candidate `node_modules`.
7. In `managed` mode, archive the full release and upload it to object storage.
8. Activate the new release.
9. Update the local `current/` cache and `manifest.json`.

If activation fails after moving the previous `current/` aside, the runtime-library backend restores the backup release.

## Resolution behavior

Both execution paths resolve managed libraries from `current/node_modules`:

- the API uses `ManagedCodeRunner`
- the executor image sets `RIVET_CODE_RUNNER_REQUIRE_ROOT` to the same runtime-library root and relies on Rivet 2.0's app-executor `CodeRunner` seam instead of patching Rivet source
- the shared proxy bootstrap also applies UI-managed Node executor proxy settings before installing Undici's proxy dispatcher: it clears process proxy env first, API processes read `settings/node-executor-proxy.json` under `RIVET_APP_DATA_ROOT` for headless endpoint execution, and the editor executor reads the same relative file from its desktop-style app-data mount
- the API image links `@valerypopoff/rivet2-node`, `@valerypopoff/rivet2-core`, and Rivet 2's `@rivet2/*` runtime aliases to the built embedded `rivet/` packages before compiling the API, so hosted endpoint execution and editor-side execution use the same Rivet 2.0 runtime behavior

That means newly activated libraries take effect on the next workflow execution without restarting the API container.
In `managed` mode the executor bootstrap now reconciles the same active release into its own local `current/` cache before code-node `require()` resolution, so it no longer depends on a shared authoritative runtime-library mount.
API processes do the same before endpoint-side execution, so both endpoint execution and editor execution converge to the same active managed release.

In the current split, that means:

- execution-plane API replicas consume the active release for published execution
- control-plane API replicas can still reconcile managed releases for any local execution they retain, but they do not count toward `Endpoint execution` readiness

In combined local-Docker mode, those responsibilities collapse into the single API container, so it both reconciles managed releases and reports as the sole `Endpoint execution` replica by default.

If no managed runtime-library set is active, code execution falls back to the dependencies baked into the running image / normal Node resolution.

## Persistence and reconciliation

Current persistence rules:

- runtime libraries live outside the container image and survive rebuilds/restarts
- startup creates missing directories
- startup migrates the older `active-release` plus `releases/<id>/` layout into the current `current/` layout if needed
- if `manifest.json` says packages are installed but `current/node_modules` is missing, startup clears the stale manifest state and starts clean
- in `managed` mode, startup reconciles the local `current/` cache from the active managed release before execution uses it
- in `managed` mode, job logs and status survive refreshes and API restarts because they are stored in Postgres
- in `filesystem` mode, finished install/remove jobs are intentionally not re-exposed through `GET /api/runtime-libraries` after the modal session ends; the durable success signal is the installed package set in the manifest/current release
- in `managed` mode, executor processes run the same reconciliation logic through the bootstrap layer before code execution
- in `managed` mode, replica-status rows also live in Postgres, so stale rows can survive process restarts until background cleanup or explicit stale-row cleanup removes them

## Managed cleanup tooling

Managed runtime-library state accumulates historical release rows, job rows, and
release artifacts. The repo now includes safe cleanup commands:

- `npm run runtime-libraries:managed:audit`
- `npm run runtime-libraries:managed:prune`
- `npm run runtime-libraries:managed:prune -- --apply`

`audit` is read-only and writes a JSON snapshot under:

- `artifacts/runtime-library-cleanup/<timestamp>/audit.json`

Those generated snapshots are operational artifacts, not source files, and are ignored by Git.

`prune` is dry-run by default. It writes a pre-prune snapshot and prints the exact
release rows, job rows, and orphaned object-storage keys that would be deleted.

Retention policy:

- never delete the active release
- never delete releases referenced by queued/running/validating/activating jobs
- never delete releases newer than 7 days
- always retain the 5 newest inactive releases
- keep successful job rows for 30 days
- keep failed/cancelled job rows for 14 days
- delete orphaned runtime-library artifacts only if they are older than 24 hours

Integrity rule:

- release rows whose artifact is already missing are reported as integrity errors
- prune does not auto-delete those release rows
- post-prune verification fails if any retained release still points to a missing artifact

## UI behavior

The current wrapper UI exposes a simple single-package workflow:

- install one package name/version at a time
- remove installed packages one at a time
- cancel a queued or running job from the modal
- show the live job log inline in the modal
- in `filesystem` mode, closing the modal clears the transient terminal view; reopening the modal shows the installed libraries list and only resumes job logs/status if another job is still actively running
- in `managed` mode, show `Replica readiness` for:
  - `Endpoint execution replicas`
  - `Editor execution replicas`
- while the modal is open in `managed` mode, poll `/api/runtime-libraries` every 5 seconds even when no job is active
- in `managed` mode, persisted job state can still be rehydrated across refreshes/reopen because the backend stores logs and status durably
- keep replica details collapsed by default, with expandable per-replica sync/error detail for debugging partial convergence
- when stale rows exist, show a `Clear stale replicas` action that calls the cleanup route and refreshes readiness state
- `RuntimeLibrariesModal.tsx` remains the shell, `useRuntimeLibrariesModalState.ts` remains the public controller, and `runtimeLibrariesJobStream.ts` owns SSE connection helpers plus log/status patching so those state transitions are not duplicated inside the hook

The underlying API accepts arrays for install/remove requests, so bulk operations are possible programmatically even though the dashboard currently uses one-at-a-time actions.

## Related feature

The adjacent `Run recordings` action is separate. It browses stored workflow execution recordings, can filter runs by recorded request input, opens replay bundles back into the editor by `recordingId`, and can delete individual runs; see [workflow-publication.md](workflow-publication.md).

## Key files

- `wrapper/api/src/runtime-libraries/backend.ts` - root backend singleton chooser and public `prepareForExecution()` entrypoint
- `wrapper/api/src/runtime-libraries/managed/backend.ts` - managed facade that keeps job-worker-enabled versus sync-only ownership explicit
- `wrapper/api/src/runtime-libraries/managed/context.ts` - managed Postgres/blob-store/local-cache context plus global prepare-hook fallback
- `wrapper/api/src/runtime-libraries/managed/job-store.ts` - managed job persistence, logs, cancellation, and heartbeats
- `wrapper/api/src/runtime-libraries/managed/job-stream.ts` - SSE framing and done/error termination
- `wrapper/api/src/runtime-libraries/managed/job-worker.ts` - worker loop, job claiming, and stale-job recovery
- `wrapper/api/src/runtime-libraries/managed/artifact-activation.ts` - build-upload-activate-finalize flow
- `wrapper/api/src/runtime-libraries/managed/process-registry.ts` - running-process tracking and termination
- `wrapper/api/src/runtime-libraries/managed/replica-status.ts` - stale-replica cleanup helpers
- `wrapper/api/src/runtime-libraries/managed/cleanup.ts` - audit/prune tooling for historical managed state
- `wrapper/api/src/runtime-libraries/managed-code-runner.ts` - API-side `Code` node resolution path with lazy managed-package preparation, compiled-function caching, and endpoint telemetry
- `wrapper/web/dashboard/RuntimeLibrariesModal.tsx` - modal shell
- `wrapper/web/dashboard/useRuntimeLibrariesModalState.ts` - public dashboard controller for runtime-library admin flows
- `wrapper/web/dashboard/runtimeLibrariesJobStream.ts` - browser-side SSE/log/status helper layer
