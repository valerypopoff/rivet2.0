# Development

See also: [Mistakes and Misconceptions](./mistakes-and-misconceptions.md)
See also: [Repo structure](./repo-structure.md)
See also: [Wrapper ManagedCodeRunner Speed Plan](./wrapper-managed-code-runner-speed-plan.md)

## Setup commands

- `corepack enable`
  - makes the repository-pinned Yarn release available on a fresh machine
- `yarn install --immutable`
  - installs every Rivet and Studio Server workspace from the root `yarn.lock`
  - uses the repository-pinned Yarn release and PnP linker
  - fails when package manifests and the lockfile disagree
  - is the only supported dependency installation path; do not add nested
    lockfiles or package-local installs
- `yarn studio-server:build`
  - builds the Rivet packages required by Studio Server, then all five Studio
    Server workspaces in dependency order
  - is the fastest complete check that workspace exports and generated outputs
    line up after a cross-package change
- `yarn studio-server:setup:k8s-tools`
  - downloads the pinned Helm release into `.data/tools/helm/`
  - use this when you want Kubernetes verification or the local Kubernetes launcher to work without a system Helm install

## Main commands

The command contract is deliberate: `yarn dev` starts the Rivet desktop/editor,
while `yarn studio-server:dev`, `yarn studio-server:prod`, and
`yarn studio-server:prod:custom` own Studio Server development and deployment.
The retired `npm run prod` and `npm run prod:custom` commands have no
compatibility aliases.

| Command                                                                                                                                                                                | What it does                                                                                                                                                                                      | Typical use                                                                                                         |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `yarn studio-server:clean`                                                                                                                                                             | Prunes Docker stopped containers, unused networks, unused images, and BuildKit cache without pruning Docker volumes                                                                               | Recover VM disk space after repeated pulls/builds or `ENOSPC` failures                                              |
| `yarn studio-server:dev` / `yarn studio-server:dev:docker`                                                                                                                             | Starts or reuses the Docker dev stack and reconciles changed Compose files or overlays                                                                                                                            | Closest-to-production browser testing                                                                               |
| `yarn studio-server:dev:docker:recreate`                                                                                                                                               | Rebuilds and recreates the complete Docker dev stack                                                                                                                                              | Force a full reset after Dockerfile, image, or mounted-runtime changes                                               |
| `yarn studio-server:dev:docker:build`                                                                                                                                                  | Builds the Docker dev images from the monorepo root                                                                                                                                               | Validate image inputs without starting services                                                                     |
| `yarn studio-server:dev:docker:config`                                                                                                                                                 | Renders the unexpanded Docker dev Compose topology without starting containers or printing dotenv values                                                                                          | Inspect launcher/Compose structure safely                                                                           |
| `yarn studio-server:dev:docker:services`                                                                                                                                               | Lists the Docker dev services enabled by the selected dotenv and Compose profiles                                                                                                                 | Verify whether optional managed dependencies are active                                                             |
| `yarn studio-server:prod:config`                                                                                                                                                       | Renders the unexpanded production Compose topology without pulling images or starting containers                                                                                                  | Inspect production launcher/Compose structure safely                                                                |
| `yarn studio-server:prod:services`                                                                                                                                                     | Lists the production services enabled by the selected dotenv and Compose profiles                                                                                                                 | Verify profile selection without pulling images or starting containers                                              |
| `yarn studio-server:dev:docker:down` / `yarn studio-server:dev:down`                                                                                                                   | Stops the Docker dev stack                                                                                                                                                                        | Cleanup                                                                                                             |
| `yarn studio-server:dev:recreate`                                                                                                                                                      | Alias for `yarn studio-server:dev:docker:recreate`                                                                                                                                                | Preserve the pre-monorepo command surface                                                                           |
| `yarn studio-server:dev:docker:ps`                                                                                                                                                     | Shows Docker dev container status                                                                                                                                                                 | Diagnostics                                                                                                         |
| `yarn studio-server:dev:docker:logs`                                                                                                                                                   | Streams Docker dev logs                                                                                                                                                                           | Diagnostics                                                                                                         |
| `yarn studio-server:dev:kubernetes-test`                                                                                                                                               | Builds local images, deploys the local Kubernetes rehearsal stack, and starts a proxy port-forward                                                                                                | Most authentic local browser rehearsal against managed external services                                            |
| `yarn studio-server:dev:kubernetes-test:recreate`                                                                                                                                      | Rebuilds images, recreates the local Kubernetes rehearsal namespace/release, and restarts the proxy port-forward                                                                                  | Reset the local Kubernetes rehearsal cleanly                                                                        |
| `yarn studio-server:dev:kubernetes-test:config`                                                                                                                                        | Generates the local Kubernetes values file and renders the Helm manifest                                                                                                                          | Verify local Kubernetes launcher wiring without deploying                                                           |
| `yarn studio-server:dev:kubernetes-test:ps`                                                                                                                                            | Shows local Kubernetes rehearsal pods, deployments, statefulsets, and services                                                                                                                    | Diagnostics                                                                                                         |
| `yarn studio-server:dev:kubernetes-test:logs`                                                                                                                                          | Streams logs for the local Kubernetes rehearsal release                                                                                                                                           | Diagnostics                                                                                                         |
| `yarn studio-server:dev:kubernetes-test:down`                                                                                                                                          | Stops the proxy port-forward and removes the local Kubernetes rehearsal release/namespace                                                                                                         | Cleanup                                                                                                             |
| `yarn studio-server:dev:local`                                                                                                                                                         | Starts API, web, and executor as local processes                                                                                                                                                  | Process-level debugging                                                                                             |
| `yarn studio-server:dev:local:api`                                                                                                                                                     | Starts only the API locally                                                                                                                                                                       | API debugging                                                                                                       |
| `yarn studio-server:dev:local:web`                                                                                                                                                     | Starts only the Vite web app locally                                                                                                                                                              | Frontend work                                                                                                       |
| `yarn studio-server:dev:local:executor`                                                                                                                                                | Starts only the executor locally                                                                                                                                                                  | Executor debugging                                                                                                  |
| `yarn studio-server:prod`                                                                                                                                                              | Pulls the prebuilt Rivet 2 images, force-recreates the production-style Docker stack, and waits for health                                                                                        | Normal VM deployment/update path                                                                                    |
| `yarn studio-server:prod:restart`                                                                                                                                                      | Force-recreates the production-style Docker stack from already-local images without pulling or building                                                                                           | Pick up `.env` changes without changing the running image version                                                   |
| `yarn studio-server:prod:custom`                                                                                                                                                       | Builds and force-recreates the production-style Docker stack from the current monorepo commit                                                                                                     | Test unpublished Rivet and Studio Server changes together                                                           |
| `yarn studio-server:test`                                                                                                                                                              | Verifies the migration ledger, builds Studio Server dependencies/workspaces, runs API and pure web tests, and executes host-compatibility, test-style, repo-structure, and Kubernetes contracts   | One-command pre-commit or branch verification                                                                       |
| `yarn studio-server:verify:filesystem`                                                                                                                                                 | Runs the repo-local compatibility baseline for single-host filesystem mode                                                                                                                        | Check that filesystem mode still has build/test and launcher-contract coverage                                      |
| `yarn studio-server:verify:filesystem:docker`                                                                                                                                          | Verifies the filesystem Docker launcher shape with a disposable env/fixture root                                                                                                                  | Check that Docker launcher config still supports filesystem mode without managed services                           |
| `yarn studio-server:verify:local-docker`                                                                                                                                               | Verifies managed-storage local-Docker launcher shape with a disposable env/fixture root                                                                                                           | Check that the managed rehearsal still enables local Postgres plus explicit object-storage wiring                   |
| `yarn studio-server:verify:local-docker:split`                                                                                                                                         | Runs split-topology repo-local checks plus local-Docker launcher validation                                                                                                                       | Check that split-era control/execution contracts still fit the local-Docker managed rehearsal model                 |
| `yarn studio-server:verify:migration-ledger`                                                                                                                                           | Reconciles every file in the preserved Studio Server import tree with its reviewed monorepo disposition and current destination                                                                   | Prove that no tracked source file was silently omitted during consolidation                                         |
| `yarn studio-server:verify:repo-structure`                                                                                                                                             | Verifies the intended authored repo layout and blocks legacy path drift                                                                                                                           | Catch misplaced runtime/deployment/tooling files before they spread                                                 |
| `yarn studio-server:verify:test-style`                                                                                                                                                 | Verifies test command manifests and test-suite style guardrails                                                                                                                                   | Catch accidental focused tests, missing command entries, broad suite reintroduction, and upstream-source assertions |
| `yarn studio-server:verify:web-pure`                                                                                                                                                   | Runs the pure web helper tests with `tsx --test`                                                                                                                                                  | Catch regressions in extracted non-React dashboard/protocol helpers quickly                                         |
| `yarn studio-server:verify:kubernetes`                                                                                                                                                 | Runs Kubernetes launcher/chart contract tests, including protected capacity/Evaluation runner configuration, then renders the local rehearsal values path and lint-renders the production overlay | Catch local/prod chart or operator-runner drift before handing the repo to operators                                |
| `yarn workspace @valerypopoff/rivet-studio-server-api run workflow-execution:measure -- --base-url http://localhost:8080 --endpoint hello-world --kind published --runs 5 --warmups 1` | Calls one published/latest workflow endpoint repeatedly and prints workflow and optional CodeRunner timing headers                                                                                | Measure filesystem or managed execution behavior safely                                                             |
| `yarn workspace @valerypopoff/rivet-studio-server-api run workflow-execution:benchmark-fixture -- --runs 50 --warmups 10`                                                              | Publishes the benchmark fixture into an isolated temp filesystem workflow root and compares legacy-compatible CodeRunner flags with the optimized path                                            | Repeat the local graph-fixture before/after benchmark without touching real workflows                               |
| `yarn studio-server:runtime-libraries:managed:audit`                                                                                                                                   | Audits managed runtime-library release/job/object state and writes a JSON snapshot                                                                                                                | Inspect live managed runtime-library state safely                                                                   |
| `yarn studio-server:runtime-libraries:managed:prune`                                                                                                                                   | Builds a dry-run prune plan for managed runtime-library state                                                                                                                                     | Review cleanup impact before applying it                                                                            |
| `yarn studio-server:ui:observe:install`                                                                                                                                                | Installs Playwright Chromium for observable frontend runs                                                                                                                                         | First-time browser setup                                                                                            |
| `yarn studio-server:ui:observe`                                                                                                                                                        | Runs the headed slow-motion Playwright flow against the current hosted app                                                                                                                        | Watch the browser click through a real scenario                                                                     |
| `yarn studio-server:ui:observe:debug`                                                                                                                                                  | Runs the same flow with Playwright Inspector enabled                                                                                                                                              | Step through or pause browser actions                                                                               |
| `yarn studio-server:ui:observe:report`                                                                                                                                                 | Opens the last Playwright HTML report                                                                                                                                                             | Review traces, screenshots, and videos after a run                                                                  |

`yarn studio-server:clean` is intentionally Docker-volume-safe but Docker-host-wide. It can remove stopped containers and unused images for any project on that Docker host, but it does not pass `--volumes` to Docker prune commands and does not run `docker volume prune` or `docker system prune`. Local Compose volumes that may hold Postgres data, app data, workspace cache, or runtime-library state are preserved. Filesystem workflow and recording host paths are also outside Docker's prune surface. `yarn studio-server:verify:repo-structure` checks that this cleanup script stays volume-safe. The tradeoff is that unused images and build cache are removed, so stopped stacks may need to pull images again and custom/dev builds may rebuild layers.

## Environment loading

Studio Server launcher scripts load env with `deploy/studio-server/scripts/lib/dev-env.mjs`.

Current behavior:

- they look for `.env` first, then `.env.dev`
- if `.env` exists, `.env.dev` is ignored
- if `RIVET_ENV_FILE` is set, the launchers and compatibility verification scripts use that explicit env file instead of `.env` / `.env.dev`
- Docker launchers attach that exact selected dotenv as a runtime-only `env_file` for the `api` and `executor` services. This makes arbitrary provider credential aliases available to published workflow endpoints, web-app actions, and editor Node-executor runs without copying the host's unrelated ambient environment or injecting the dotenv into `web`/browser code.
- Treat projects allowed to run in Node/headless mode as trusted code. A Code node with `Allow process` enabled can inspect the executor/API process environment, so the runtime-only dotenv boundary protects browser JavaScript but is not a sandbox between server-side workflows and other secrets in that dotenv.
- missing values get defaults for:
  - `RIVET_WORKSPACE_ROOT`
  - `RIVET_APP_DATA_ROOT`
  - `RIVET_RUNTIME_LIBRARIES_ROOT`
- if `RIVET_ARTIFACTS_HOST_PATH` is present, the launcher resolves it to an absolute host path and derives:
  - `RIVET_WORKFLOWS_HOST_PATH=<artifactsRoot>/workflows`
  - `RIVET_WORKFLOW_RECORDINGS_HOST_PATH=<artifactsRoot>/workflow-recordings`
  - `RIVET_RUNTIME_LIBS_HOST_PATH=<artifactsRoot>/runtime-libraries`
- image builds use the repository root as their only build context; the root
  Yarn metadata and required workspace sources therefore come from one commit
- if `RIVET_WORKFLOWS_HOST_PATH`, `RIVET_WORKFLOW_RECORDINGS_HOST_PATH`, or `RIVET_RUNTIME_LIBS_HOST_PATH` is present, the launcher resolves it to an absolute host path before invoking Docker Compose
- explicit `RIVET_WORKFLOWS_HOST_PATH`, `RIVET_WORKFLOW_RECORDINGS_HOST_PATH`, and `RIVET_RUNTIME_LIBS_HOST_PATH` values override the derived paths from `RIVET_ARTIFACTS_HOST_PATH`

Operational note:

- `deploy/studio-server/.env.example` intentionally lists only launcher/bootstrap/deployment-owned environment knobs. Settings that operators can change from the App Settings modal should stay out of that file as concrete variables; document their owning Settings tab instead, so new installs do not learn two competing configuration paths.
- `Settings` -> `Storage` is the operator surface for choosing filesystem versus managed storage and saving managed database/object-storage credentials. Single-host deployments persist `settings/deployment-storage.json`. Kubernetes persists the same typed domain as encrypted PostgreSQL settings and writes a disposable compatibility projection before API/executor startup. If no value exists, built-in `Local folders` plus `Local Docker Postgres` defaults seed the first revision. Restart/recreate Docker services or roll out Kubernetes API/executor pods after changing storage settings so singleton backends are rebuilt.
- Kubernetes requires `appSettings.backend=postgres`. Prefer a dedicated Secret/Vault value for `RIVET_APP_SETTINGS_ENCRYPTION_KEY`; `RIVET_KEY` is a compatibility fallback. Rotation is a three-rollout operation: first deploy the old primary with the new key as the accepted secondary, then deploy the new primary with the old key as secondary, and remove the old key only after every pod runs the new primary. This prevents old rolling-update pods from encountering rows encrypted with a key they do not know.
- `RIVET_ARTIFACTS_HOST_PATH` remains the launcher bootstrap/default for filesystem-mode host mounts
- `RIVET_WORKFLOWS_HOST_PATH`, `RIVET_WORKFLOW_RECORDINGS_HOST_PATH`, and `RIVET_RUNTIME_LIBS_HOST_PATH` remain compatibility overrides for the launcher
- use the repo launchers (`yarn studio-server:dev`, `yarn studio-server:prod`, `yarn studio-server:dev:docker:*`, or the Docker launcher scripts) for Docker runs; a raw `docker compose --env-file .env ...` invocation only reads the variables already present in the env file and does not derive absolute workflow, recording, or runtime-library host paths from `RIVET_ARTIFACTS_HOST_PATH`. When those per-path host variables are omitted, Compose falls back to isolated `.data/workflows`, `.data/workflow-recordings`, and `.data/runtime-libraries` directories under the repo rather than the external artifact root.
- Docker launchers intentionally drop ambient host `NODE_OPTIONS` unless `.env` defines `NODE_OPTIONS` explicitly. This keeps Yarn 4/PnP host preloads such as `--require F:\...\.pnp.cjs` from being interpolated into Linux container startup commands while leaving non-Docker local runners alone.
- The Docker development `web` and `api` services install their disposable dependencies with Yarn's `node-modules` linker, but the repository itself stays on tracked Yarn PnP loaders. Before each container-side install, the Compose helper snapshots the host `.pnp.cjs` and `.pnp.loader.mjs` and restores their contents and ownership only if that install removed them. This makes `yarn studio-server:dev` safe to run alongside normal host Yarn commands. If the loaders are already missing, it fails before changing dependencies and tells you to run `corepack enable && yarn install --immutable`; do not work around it with a raw `npm install`.
- Docker dev mode bind-mounts the owning monorepo package sources. The API and
  executor consume built Rivet workspace exports, while the hosted web build
  aliases selected editor sources and hosted overrides through Vite.
- The hosted web package declares every browser dependency imported by its
  source graph directly. Keep those versions aligned with the owning Rivet
  workspaces instead of relying on incidental transitive dependencies.
- Set `PINECONE_API_KEY` in the launcher env file for Node-executed Pinecone Knowledge Stores, including the `Sync Knowledge Source` node. Docker passes it only to the API and Node executor containers: this covers published endpoint/web-app runs and editor Node-executor runs without exposing the secret to the browser. The same runtime-only path supports arbitrary built-in LLM credential aliases such as `BILLING_OPENAI_KEY`; configure the matching environment-variable name on the LLM Chat or LLM Profile node. Do not add server-only credentials to `RIVET_ENV_ALLOWLIST`; that allowlist is only for browser-visible hosted-env lookups. Pinecone Knowledge Stores are not supported by the Browser executor. Kubernetes deployments using the Vault dotenv integration should add the key to that injected dotenv so both API and executor pods inherit it.
- Changing a launcher dotenv credential does not mutate an already-running process environment. Recreate the relevant Docker services with `yarn studio-server:dev:docker:recreate` for development or `yarn studio-server:prod:restart` for production; a browser reload alone is not enough. Browser-executor aliases additionally require the exact variable name in `RIVET_ENV_ALLOWLIST`, then a container recreate and browser reload, unless the credential is supplied through Rivet Settings or the API-key input port. Protected server-credential names remain denied even when listed; this includes sensitive-name variants and common database credentials such as `PGPASSWORD`, `MONGODB_URI`, and `REDIS_URL`. Use a purpose-specific `*_API_KEY` alias for an intentionally browser-visible provider key instead of reusing a password, secret, token, credential, database, signing, encryption, or object-storage credential name.
- `Settings` -> `Environment variables` stores runtime overrides through the active App Settings repository. The compact settings table keeps saved values masked by default; an authenticated no-store eye action reveals only one requested value. These values override launcher dotenv values for every new workflow endpoint, web-app, and editor Node-executor run; active runs retain their captured immutable overlay. Kubernetes control and execution APIs read the encrypted PostgreSQL setting, and the co-located editor executor retrieves the current overlay through its authenticated loopback API. The `Browser` checkbox opts one value into Browser-executor lookup; protected secret-like names remain denied. External Remote Debugger processes do not receive wrapper-managed variables.
- App Settings -> `General` controls trusted-host bypasses. Exact saved hostnames/IPs bypass the UI key gate, web-app auth, and workflow endpoint bearer checks. App Settings -> `Shell execution` controls editor-side allowed-command timeout and captured-output limits, not workflow execution. The legacy `RIVET_UI_TOKEN_FREE_HOSTS` env var is ignored. In Kubernetes the proxy polls the authenticated non-secret settings endpoint and hot-reloads its trusted-host include only after nginx validation; single-host proxy images retain the file watcher.
- App Settings -> `Workflow endpoints` controls the published/latest workflow route slugs, the default-on `Authorization: Bearer <RIVET_KEY>` requirement for public workflow endpoint calls, and the nginx HTTP request timeout for `/api/*`, `${RIVET_PUBLISHED_WORKFLOWS_BASE_PATH}`, `${RIVET_PUBLISHED_APPS_BASE_PATH}`, `${RIVET_LATEST_WORKFLOWS_BASE_PATH}`, and `${RIVET_LATEST_APPS_BASE_PATH}`. The auth setting is stored at `settings/workflow-endpoint-auth.json`; the timeout is saved in seconds under `settings/runtime-limits.json` and defaults to `180`.
- App Settings -> `Web apps` -> `Button data` controls the largest JSON payload a web-app button may send when running a graph. It is shown in MiB, defaults to `100 MiB`, and is stored as `webAppActionRequestLimitBytes` in the runtime-limits settings domain. Saving updates API-side HTTP parsing immediately. The proxy receives the non-secret limit through its settings source and safely reloads nginx; Kubernetes uses the authenticated internal snapshot while single-host deployments use the file watcher. WebSocket `maxPayload` is captured when an API process starts, so gracefully restart/roll out API pods after active actions complete to apply a changed limit to new sockets. The `1 MiB` to `1 GiB` bound does not override an outer ingress/CDN/body limit.
- App Settings -> `Docker` controls how long the npm Docker launchers wait for Compose services to become healthy. The saved value is in seconds and defaults to `1200` when the settings file or a running container is unavailable. Kubernetes does not use this setting.
- Storage/database `.env` values are ignored by the Docker API/executor runtime. Use the Storage tab for workflow/runtime-library storage and database settings; in object-storage mode `RIVET_RUNTIME_LIBRARIES_ROOT` remains only a local cache/workspace
- optional managed runtime-library readiness tuning uses:
  - `RIVET_RUNTIME_LIBRARIES_SYNC_POLL_INTERVAL_MS`
  - `RIVET_RUNTIME_LIBRARIES_REPLICA_STATUS_RETENTION_MS`
  - `RIVET_RUNTIME_LIBRARIES_REPLICA_STATUS_CLEANUP_INTERVAL_MS`
- split-topology launches can also override:
  - `RIVET_API_PROFILE=combined|control|execution`
  - `RIVET_DEPLOYMENT_TOPOLOGY=single-host|replicated` — operational metadata for `Settings` -> `Deployment`; it describes the actual launcher topology and does not create replicas
  - `RIVET_RUNTIME_LIBRARIES_REPLICA_TIER=endpoint|editor|none`
  - `RIVET_RUNTIME_LIBRARIES_JOB_WORKER_ENABLED=true|false`

## Compatibility matrix

The non-cluster compatibility modes that should keep working are:

| Storage/runtime shape                        | Support status                                                               | What it is for                                                                                              | What must be true                                                                                                                      |
| -------------------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `filesystem + combined`                      | Supported                                                                    | Primary backward-compatible single-host operation                                                           | Local workflow tree and runtime-library root remain authoritative                                                                      |
| `filesystem + control`                       | Supported                                                                    | Secondary control-plane-only debugging and admin validation                                                 | Control-plane/admin/latest routes still boot without managed services                                                                  |
| `filesystem + execution`                     | Unsupported by design                                                        | None                                                                                                        | `RIVET_API_PROFILE=execution` must fail fast unless storage mode is `managed`                                                          |
| `managed + local-docker + combined`          | Supported                                                                    | Existing Postgres plus explicit object-storage rehearsal path through Docker dev or production-style Docker | Start the `workflow-managed` Compose profile and enter the MinIO URL/keys in Settings before restarting into object-storage mode       |
| `managed + local-docker + control/execution` | Supported through repo-local split validation and local dependency rehearsal | Split-era compatibility checks without Kubernetes                                                           | Split route/profile contracts must stay valid while storage still uses local Docker Postgres plus explicitly configured object storage |

Compatibility rules:

- `filesystem` compatibility is single-host only
- `local-docker` means the Storage tab uses the optional local Docker Postgres metadata database; object storage is still configured separately
- Docker combined-mode rehearsal is necessary but not sufficient to prove the real split runtime shape
- the repo-local split verification command proves the control-plane versus execution-plane contract; live Kubernetes validation is still required for real in-cluster routing and scaling behavior

## Local Kubernetes launcher

The repo now includes a local Kubernetes rehearsal launcher:

- `yarn studio-server:dev:kubernetes-test`
- `yarn studio-server:dev:kubernetes-test:recreate`
- `yarn studio-server:dev:kubernetes-test:down`
- `yarn studio-server:dev:kubernetes-test:config`
- `yarn studio-server:dev:kubernetes-test:ps`
- `yarn studio-server:dev:kubernetes-test:logs`
- `yarn studio-server:verify:kubernetes`

Current behavior:

- it builds local `proxy`, `web`, `api`, and `executor` images from the current workspace
- the API image build runs the workspace TypeScript build before it touches the cluster, so a type-contract failure stops the rehearsal before any Helm deployment changes
- the managed-schema migration validates catalog definitions after applying them; PostgreSQL may remove redundant outer parentheses from partial-index predicates, which the validator treats as equivalent rather than rejecting a healthy fresh database
- Minikube imports freshly built images sequentially and names each image as it starts; the first local deployment can therefore take several minutes before Helm begins, rather than appearing stalled
- every local `build`, `dev`, and `recreate` run stamps images with a fresh local tag, because Minikube can retain an older image behind a reused `:dev` tag; `up` reuses the recorded tag from the preceding build. Set `RIVET_K8S_IMAGE_TAG` only when you deliberately want to manage that identity yourself
- it deploys the real Helm chart into a dedicated local namespace
- it targets `RIVET_K8S_CONTEXT` explicitly without mutating your global `kubectl` current-context
- if `RIVET_K8S_CONTEXT` is unset, it uses the current `kubectl` context when one exists
- if no current `kubectl` context is set and `minikube` is installed, it falls back to the `minikube` context automatically
- on Docker Desktop Kubernetes, it imports the freshly built images into the cluster nodes automatically
- on Minikube, it loads the freshly built images with `minikube image load --daemon=true`
- on Minikube-backed `dev`, `up`, and `recreate`, it starts the target Minikube profile automatically if it is not already running
- it keeps `web=1`
- it keeps `backend=1`
- it scales the legitimate local rehearsal targets:
  - `proxy`
  - `execution`
- it creates Kubernetes secrets from the local Kubernetes renderer inputs:
  - `RIVET_KEY`
  - `RIVET_K8S_DATABASE_CONNECTION_STRING`
  - `RIVET_K8S_STORAGE_URL` or the explicit `RIVET_K8S_STORAGE_*` tuple
  - `RIVET_K8S_STORAGE_ACCESS_KEY_ID`
  - `RIVET_K8S_STORAGE_ACCESS_KEY`
- it starts a local `kubectl port-forward` for the proxy service so the app is available on `http://127.0.0.1:${RIVET_K8S_PROXY_PORT:-RIVET_PORT:-8080}`
- the proxy startup normalizes `RIVET_PROXY_RESOLVER` so Kubernetes DNS service hostnames resolve to the IPs nginx expects

Operational notes:

- this launcher is for the supported Kubernetes topology only:
  - `proxy>=2`
  - `web=1`
  - `backend=1`
  - `execution>=2`
- the scalable tiers do not grow in fixed pairs:
  - a new `execution` pod is only another execution-plane API pod
  - a new `proxy` pod is only another nginx proxy pod
- for endpoint-heavy load, `execution` is the primary scale target and `proxy` is the secondary ingress tier
- it is intentionally opinionated toward external managed Postgres plus external S3 or S3-compatible storage
- it does not replace the production chart or create a second deployment contract; it is a local wrapper around the same chart the real deployment should use
- by default it prefers:
  - the explicit `RIVET_K8S_CONTEXT`, if set
  - otherwise the current `kubectl` context, if one exists
  - otherwise the `minikube` context when the Minikube CLI is installed
  - otherwise the historical fallback `docker-desktop`
- Helm resolution order is:
  - `RIVET_K8S_HELM_BIN`
  - system `helm`
  - cached Helm under `.data/tools/helm/`
- if no explicit, system, or cached Helm is available, the launcher fails with an instruction to run `yarn studio-server:setup:k8s-tools`
- optional launcher-specific overrides are:
  - `RIVET_K8S_CONTEXT`
  - `RIVET_K8S_CLUSTER_PROVIDER`
  - `RIVET_K8S_CLUSTER_DOMAIN`
  - `RIVET_K8S_MINIKUBE_PROFILE`
  - `RIVET_K8S_MINIKUBE_BIN`
  - `RIVET_K8S_NAMESPACE`
  - `RIVET_K8S_RELEASE`
  - `RIVET_K8S_PROXY_PORT`
  - `RIVET_K8S_PROXY_REPLICAS`
  - `RIVET_K8S_WEB_REPLICAS`
  - `RIVET_K8S_EXECUTION_REPLICAS`
  - `RIVET_K8S_LOAD_LOCAL_IMAGES`

### Self-contained Minikube rehearsal

For a local machine that does not already have a safe Postgres and
S3-compatible endpoint, use the repository's disposable dependency manifest.
It creates a dedicated namespace with one Postgres instance, one MinIO
instance, and two 2 GiB local claims. It does not contact production services
and its credentials are intentionally public development-only values.

From PowerShell:

```powershell
minikube start -p rivet-local --driver=docker --cpus=4 --memory=8192
Copy-Item deploy/studio-server/.env.kubernetes-local.example .env.local
kubectl --context rivet-local apply -f deploy/studio-server/kubernetes-test/local-dependencies.yaml
kubectl --context rivet-local -n rivet-local rollout status deployment/rivet-local-postgres --timeout=180s
kubectl --context rivet-local -n rivet-local rollout status deployment/rivet-local-minio --timeout=180s
kubectl --context rivet-local -n rivet-local wait --for=condition=complete job/rivet-local-create-bucket --timeout=180s
$env:RIVET_ENV_FILE = '.env.local'
yarn studio-server:dev:kubernetes-test
```

The launcher's proxy port-forward exposes the editor at
`http://127.0.0.1:8090`. Inspect the deployed components with
`yarn studio-server:dev:kubernetes-test:ps`, or stream their logs with
`yarn studio-server:dev:kubernetes-test:logs`.

To remove the entire rehearsal—including its database and object-storage
contents—run:

```powershell
$env:RIVET_ENV_FILE = '.env.local'
yarn studio-server:dev:kubernetes-test:down
minikube delete -p rivet-local
```

Do not use `:down` against a namespace that contains any work you intend to
keep: the local launcher deliberately deletes its namespace.

For the operator-facing chart contract and handoff checklist, see:

- [Kubernetes](./kubernetes.md)

## Observable Playwright flow

The repo now includes a headed Playwright workflow for frontend debugging and demos where you want to watch the browser actions live.

Current behavior:

- `yarn studio-server:ui:observe` launches Chromium in headed mode with `slowMo`, trace capture, video capture, and HTML reporting enabled
- the runner loads the same `.env` / `.env.dev` file as the Docker scripts, so UI-gated hosts automatically reuse `RIVET_KEY`
- unless `PLAYWRIGHT_BASE_URL` is already set, the runner targets `http://127.0.0.1:${RIVET_PORT}` from your env file, defaulting to `8080`
- the main hosted-editor observable spec uses mocked workflow/project API responses to open a two-node project, then visibly exercises the hosted editor focus, copy, cut, and paste path without mutating workflow storage
- trace, video, screenshots, and the HTML report are written under `artifacts/playwright/`

Managed-state safety:

- most browser-visible specs should stay non-mutating and prefer mocked API responses when the behavior under test is modal/controller/UI wiring rather than storage persistence
- every spec must seed or intercept the workflow state it needs; an empty workflows volume with no pre-existing folders or projects is the supported suite baseline
- hosted-editor shortcut/focus coverage should also prefer mocked workflow/project routes when the behavior only needs an open project shape, not durable workflow storage
- browser-only fixture assets must resolve from direct `studio-server-web` dependencies; observable specs must not use another workspace's `package.json` as a module-resolution anchor
- mutating workflow specs are blocked against Storage-tab `Object storage` mode unless `PLAYWRIGHT_ALLOW_MANAGED_MUTATIONS=1` is set explicitly
- specs that assert managed virtual workflow paths should call the managed-mode guard and skip under filesystem stacks; filesystem runs should not be expected to produce `/managed/workflows/...` save paths
- shared Playwright workflow helpers use Playwright's request context for setup and cleanup, not `page.evaluate(fetch(...))`, so they go through the same proxy-auth path as the real browser shell
- if a mutating spec creates real workflow state in managed mode, it is responsible for explicit cleanup before the run finishes

Typical usage:

1. start the app you want to watch, for example `yarn studio-server:dev` or `yarn studio-server:prod:custom`
2. if this is the first Playwright run on the machine, run `yarn studio-server:ui:observe:install`
3. run `yarn studio-server:ui:observe`
4. if you want the Playwright Inspector alongside the browser, run `yarn studio-server:ui:observe:debug`
5. after the run, open `yarn studio-server:ui:observe:report`

Windows PowerShell override example:

1. `$env:PLAYWRIGHT_BASE_URL='http://127.0.0.1:8086'`
2. `$env:PLAYWRIGHT_SLOW_MO='500'`
3. `yarn studio-server:ui:observe`

## Local direct-process mode

`yarn studio-server:dev:local` starts:

- API on `http://localhost:3100`
- Vite web app on `http://localhost:5174`
- executor websocket service on port `21889`

The local executor is the wrapper entrypoint, not the upstream standalone executable. It injects an HTTP-backed LLM Profile health store into Node-mode editor runs. By default it calls `http://127.0.0.1:3100/api/workflows/llm-profile-health`; set `RIVET_LLM_PROFILE_HEALTH_API_URL` only when the local API is exposed elsewhere. `RIVET_KEY` must match the API because the executor derives the normal trusted proxy token from it. When a key is configured, the Vite development proxy derives the same proxy-auth digest server-side for its `/api/*` forwarding; the browser never receives the shared key or that header value.

The dashboard's outer Project Settings > LLM profile suspension tab administers that same
server state. It is intentionally outside the embedded Rivet editor, and the
embedded provider configuration carries only the runtime store. Upstream
standalone Rivet can save Reliability settings but does not enforce them or
create local suspension state. The tab keeps an expired suspension visible as
awaiting recovery, then marks its leased recovery request as in progress, so an
empty panel means there is no suspension or pending recovery lifecycle.

Important constraints:

- host Node must be `24+` for local API execution because the API now uses Node's built-in `node:sqlite`
- this mode does not recreate the nginx trusted-proxy layer
- the Vite dev server only proxies `/api/*` to the API and `/ws/executor*` to the executor; when `RIVET_KEY` is configured, its `/api/*` proxy adds the derived internal proxy-auth header server-side
- Vite does not proxy the published/latest workflow route families, Rivet web app route families, `/ui-auth`, or `/ws/latest-debugger`; it remains a narrower development seam than the deployed nginx proxy
- use it for service-level debugging, direct API/executor work, or frontend iteration that does not rely on fully wired hosted-shell control-plane routing
- Docker dev remains the best path for testing the full hosted browser flow exactly as deployed

## Docker launcher behavior

The Docker launchers now render layered Compose files:

- the API uses its own `PORT` contract
- the executor websocket service is pinned separately to `21889`
- do not treat `PORT` in `.env` as a shared port for every container; the executor must stay on `21889` unless the nginx upstreams change with it
- the executor service sets `RIVET_EXECUTOR_HOST=0.0.0.0` in Docker so the proxy container can connect to it over the compose network; do not change that back to `127.0.0.1` unless the proxy and executor are collapsed into the same process/network namespace
- the executor service sets `RIVET_LLM_PROFILE_HEALTH_API_URL=http://api:80/api/workflows/llm-profile-health` and receives `RIVET_KEY`; this keeps Node-mode editor circuit-breaker state aligned with API-owned endpoint and web-app runs

- `yarn studio-server:dev` / `yarn studio-server:dev:docker:*` use `deploy/studio-server/compose/docker-compose.managed-services.yml` plus `deploy/studio-server/compose/docker-compose.dev.yml`; set `RIVET_METRICS_ENABLED=true` only when a private host or Docker-network scraper needs the direct API container's pull-only `/metrics` endpoint. The public proxy intentionally does not route that endpoint.
- Published web-app Chat state and Stored Values use browser IndexedDB. The API-only `RIVET_WEB_APP_BROWSER_STORAGE_*` settings bound the optional on-demand WebSocket storage RPC; Compose and Helm supply safe defaults. See [web-app-browser-storage.md](web-app-browser-storage.md) before changing limits or proxy timeouts, because these ceilings must be sized with execution-replica memory and admission capacity.
- `yarn studio-server:prod`, `yarn studio-server:prod:prebuilt`, `yarn studio-server:prod:restart`, and `yarn studio-server:prod:custom` use `deploy/studio-server/compose/docker-compose.managed-services.yml` plus `deploy/studio-server/compose/docker-compose.yml`
- the shared file only contributes the optional managed Postgres/MinIO services; enable them explicitly with `COMPOSE_PROFILES=workflow-managed` when rehearsing object-storage mode locally

Current behavior:

- the browser entrypoint is still `http://localhost:8080` through nginx by default; override it with `RIVET_PORT` if needed
- `yarn studio-server:prod` (and its explicit `yarn studio-server:prod:prebuilt` alias) pulls prebuilt images under `ghcr.io/valerypopoff/rivet2.0-studio-server/{proxy,web,api,executor}:${RIVET_IMAGE_TAG:-latest}`, then force-recreates the stack with `--no-build`; set `RIVET_PROXY_IMAGE`, `RIVET_WEB_IMAGE`, `RIVET_API_IMAGE`, or `RIVET_EXECUTOR_IMAGE` to pin any service to a different image. Keep the image examples in `deploy/studio-server/.env.example` on that same namespace. The retired `cloud-hosted-rivet2-wrapper/*` packages are not release targets for this monorepo; use the explicit per-service image overrides only when intentionally pinning a historical image.
- `yarn studio-server:prod:restart` skips the pull/build step and force-recreates the stack from the images already present locally. Use it after changing `.env` when you want containers to pick up new env values without updating to newer GHCR images.
- Project Settings reads route prefixes from runtime `/api/config`, not the prebuilt web bundle. App Settings edits workflow and web-app route domains through one typed settings repository. API dispatch is dynamic, and the proxy regenerates its server-block include, validates it with `nginx -t`, and reloads. Kubernetes proxies poll the authenticated `/internal/app-settings/proxy-config` projection; single-host proxies watch their local files. The modal waits for `/api/config` to report the active paths before showing `Saved.`, so no manual stack restart is required.
- Server UI access starts from deployment env, then uses the active settings repository for OAuth provider/session details and admin emails. Bootstrap with `RIVET_SERVER_UI_AUTH_MODE=none` or `key`, save OAuth and admin settings, then switch the deployment env to `oauth`. Changing the env mode requires process restart/rollout; changing saved OAuth/admin settings propagates through the repository and invalidates old sessions.
- App Settings -> `Run recordings` saves recording queue depth, newest-runs-per-endpoint, and age retention through the active repository. Kubernetes stores the domain in encrypted PostgreSQL; the file backend retains `settings/run-recordings.json`. Legacy `RIVET_RECORDINGS_MAX_PENDING_WRITES`, `RIVET_RECORDINGS_MAX_RUNS_PER_ENDPOINT`, and `RIVET_RECORDINGS_RETENTION_DAYS` are ignored. Each settings tab keeps one separated Save/Revert row for all changes in that tab.
- App Settings -> `Web apps` -> `Auth`, `OAuth`, and `Server UI access` edit one web-app-auth domain. `Key`, `OAuth`, and `No gate` retain their existing behavior. The file backend uses owner-only `settings/web-app-auth.json`; Kubernetes stores the payload encrypted in PostgreSQL. Legacy web-app/OAuth env values are ignored. OAuth state and session cookies remain bound to the saved revision, so provider, credential, scope, allowlist, or session-policy changes fail closed and may require visitors to sign in again.
- App Settings -> `Workflow endpoints` -> `Access control` writes workflow endpoint bearer-token policy to `settings/workflow-endpoint-auth.json`. It defaults to requiring `Authorization: Bearer <RIVET_KEY>`, and the legacy `RIVET_REQUIRE_WORKFLOW_KEY` env var is ignored so workflow endpoint auth has one operator-owned source of truth.
- App Settings -> `Workflow endpoints` -> `Routes` and App Settings -> `Web apps` -> `Routes` edit one public-route settings domain. In file mode it is `settings/public-routes.json`, with the old `settings/web-app-routes.json` as a read-only import fallback. Kubernetes stores it in PostgreSQL. Slugs are unique single top-level path segments and cannot collide with reserved routes.
- App Settings -> `Storage` writes workflow/runtime-library storage choices through the active settings repository. The tab keeps artifact storage and metadata database settings separate. `Local folders` uses launcher-mounted host paths; `Object storage` uses S3-compatible storage; the database section independently chooses local Docker or managed PostgreSQL. Secrets are never returned to the browser. Storage/database env values are ignored by Docker API/executor runtime. Restart Docker or roll out Kubernetes after changes so workflow and runtime-library singleton backends use the new configuration.
- Managed workflow schema changes live in ordered immutable migrations under `packages/studio-server-api/src/routes/workflows/managed/schema-migrations.ts`. Migration 1 is the workflow baseline; migration 2 adds encrypted `app_settings`; migration 3 adds the fenced maintenance lease and deletion outbox; migration 4 adds reconciliation state and integrity findings. Never edit a released migration or checksum. The Helm pre-install/pre-upgrade Job first bootstraps deployment storage and runs schema migration with `RIVET_APP_SETTINGS_BACKEND=file`, then enables PostgreSQL settings. Each absent row independently uses a matching regular, valid legacy JSON file or falls back to the candidate bootstrap/default; never switch the entire app-data root to a partial legacy tree. Serving API pods remain verify-only. Add each future change as N+1 with complete manifest, backward-compatibility declaration, and concurrency/upgrade coverage.
- Web-app action graph context strips browser/session headers such as `cookie`, `authorization`, proxy auth, and trusted-host hints. Keep public web-app actions on that narrower context contract; workflow endpoint routes may still expose request headers because they are API-style execution surfaces with their own bearer/trusted-host contract.
- Web-app actions carry a browser-owned `storage` snapshot for Rivet Stored Value nodes. Both the HTTP compatibility route and the WebSocket gateway must return the per-run `storagePatch`; do not persist or reuse that snapshot server-side unless a deliberate trusted host store is introduced.
- App Settings -> `Node executor proxy` stores runtime `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`, and optional executor/debugger websocket overrides through the active repository; `.env` proxy/URL overrides are ignored. Kubernetes init projects only the proxy compatibility JSON into each pod-local `emptyDir`, and the control pod shares that local volume with its co-located executor. API processes read PostgreSQL snapshots directly and refresh their dispatcher after saves. Single-host mode retains owner-only JSON files and polling. Blank websocket overrides keep host-derived defaults, including HTTPS-to-WSS hardening.
- In file mode, App Settings writes use unique temporary files followed by atomic rename. In PostgreSQL mode, updates use compare-and-swap revisions; a stale explicit revision returns `409` rather than overwriting another administrator. PostgreSQL notification failure after commit is logged without reporting the committed save as failed. Notifications accelerate replica invalidation, while revision polling repairs missed notifications and retries repository refreshes whose revision was not yet acknowledged.
- Missing file-backed settings or absent PostgreSQL rows mean first-run defaults. A present malformed file or an unreadable/decryption-failed database row fails loudly instead of falling back to env/defaults. Web-app auth remains fail-closed. Every HTTP request pins one immutable settings snapshot, so a concurrent save cannot mix policy revisions within the request.
- `Web apps`, `OAuth`, and `Server UI access` edit the same web-app-auth record. The modal loads that record once per opening and keeps the shared draft while those tabs are switched, so changing tabs cannot overwrite unsaved OAuth or admin-email edits with a second fetch.
- For local web-app OAuth testing without a real provider, open App Settings -> `Web apps` -> `Auth` and choose `OAuth`, then open App Settings -> `OAuth`, choose `Local dummy`, provide a session signing secret, and optionally set the default dummy email. The Sign in flow then opens `/apps/auth/dummy` unless the active published-app route prefix has changed, accepts a test email, and returns through the same callback/session-cookie path as real OAuth. Dummy OAuth is localhost-only by default; do not use it for shared or production deployments. OAuth web-app allowlists are fail-closed, so add the dummy email to the app's allowed-email list before testing access.
- `yarn studio-server:prod:custom` rebuilds all four images and the stack from the current monorepo commit
- dev Docker exposes the API directly on `http://localhost:3100` for diagnostics, but it binds that port to `127.0.0.1` by default through `RIVET_LOCAL_BIND_HOST`; keep it private/firewalled on shared or public machines because the hosted auth model expects browser traffic to enter through nginx
- local-docker managed Postgres and MinIO diagnostic ports also bind to `127.0.0.1` by default. Set `RIVET_LOCAL_BIND_HOST=0.0.0.0` only on a trusted/firewalled network.
- credentialed CORS is same-origin by default. Set `RIVET_CORS_ALLOWED_ORIGINS` only when a known external browser origin must call the API or workflow routes directly.
- `yarn studio-server:dev` is idempotent: it reuses a healthy existing dev stack rather than restarting services just because the command is run again. Use `yarn studio-server:dev:docker:recreate` after Dockerfile, executor-source, image, or mounted nginx-template changes; API and web source are already watched in their live-mounted dev services. If the root lockfile changed, it instead rebuilds and restarts the **whole dev stack** in one Compose operation; this keeps its shared development dependencies coherent and avoids unsafe one-container replacement. The dev API explicitly clears the production-image entrypoint so its Compose development command owns this marker and source-watch process. If an earlier dev stack was started with different Compose source files or overlays—for example, before adding `.env`, which adds the API/executor runtime-env overlay, or after changing the dev Compose configuration—the launcher force-removes only the project's stale development containers, then lets Compose start the complete stack again. This avoids waiting for the production API's long graceful-stop window during local recovery. Ordinary `.env` value changes are left to Docker Compose's normal per-service reconciliation, avoiding an unnecessary full-stack restart. Optional local managed services receive the same identity label, so enabling that profile does not cause repeat restarts. The automatic replacement preserves the project network and never uses `--volumes`, so the named dependency/app-data volumes and mounted workflows, recordings, runtime libraries, and repository remain intact. A requested `dev:docker:recreate` also caps its development-only shutdown wait at 20 seconds. Saved public-route changes normally apply through the proxy watcher without rerunning the launcher. If a new proxied route such as `${RIVET_LATEST_APPS_BASE_PATH:-/apps-latest}` falls through to the Studio UI, check the proxy logs for a failed nginx reload before using `yarn studio-server:dev:docker:recreate` for a full reset.
- The proxy preserves the request port for browser-facing URLs by deriving `X-Forwarded-Host` from the request `Host` header. This matters for local OAuth and dummy OAuth on `http://localhost:8081`; if generated links start pointing at `http://localhost/...`, check the forwarded-host maps before changing API URL generation. Incoming `X-Forwarded-Host` / `X-Forwarded-Proto` headers are ignored unless `RIVET_TRUST_INCOMING_FORWARDED_HEADERS=true`, which should only be used behind a trusted ingress that overwrites client-supplied forwarded headers.
- proxy startup scripts are Linux shell scripts; dev Compose mounts them from the repo, while production images bake them into the proxy image. The repo pins `*.sh` files to LF line endings so Windows checkouts do not inject CRLF characters into `/bin/sh`
- The proxy does not serve a static UI-gate prompt. It protects dashboard/editor, API, and editor websocket routes with nginx `auth_request`, then proxies denied browser requests to the API-rendered `/ui-auth/prompt`. The prompt posts or redirects with a sanitized local `return_to` path so successful key or OAuth sign-in returns to the requested dashboard/editor or published web-app URL instead of always landing on `/`. Dev and production nginx templates proxy URI-suffixed auth/websocket targets through `set` upstream variables; keep that pattern for named locations such as `@web_with_ui_gate_prompt`, because nginx rejects `proxy_pass http://host/path` directly inside named locations.
- standard proxied HTTP routes default to a `180s` upstream timeout through App Settings -> `Workflow endpoints`; websocket routes stay long-lived separately
- the local Docker stacks keep `RIVET_API_PROFILE=combined` by default, so `/api/*`, `${RIVET_LATEST_WORKFLOWS_BASE_PATH}`, `${RIVET_LATEST_APPS_BASE_PATH}`, `${RIVET_PUBLISHED_APPS_BASE_PATH}`, and `${RIVET_PUBLISHED_WORKFLOWS_BASE_PATH}` all land on the same `api` container there
- the `web` service runs the Vite dev server inside the container with live bind mounts
- the dev proxy mounts `deploy/studio-server/compose/nginx/default.dev.conf.template`; keep the Compose-relative path at `./nginx/...` when moving deployment files, otherwise nginx starts with its stock welcome page while still appearing healthy
- the dev stack keeps container dependency state in Docker named volumes and keys its freshness marker to the root Yarn metadata. The live-mounted web and API services set `YARN_NODE_LINKER=node-modules` for their entire process lifetime, so post-install workspace commands use the same layout as the mounted dependency volume. They also put `YARN_INSTALL_STATE_PATH` inside that volume and use the shared named Yarn cache. Vite's optimized-dependency cache has its own named volume, so its atomic directory swaps never run inside a Windows bind mount. A container install must never overwrite the host checkout's PnP install state or add platform-specific cache archives to it. Do not reuse host-native unplugged artifacts inside Linux containers. Development uses the isolated `rivet-studio-server-dev` Compose project. Production detects a single historical standalone `ops_rivet_data` or `compose_rivet_data` volume and adopts that Compose project identity for an in-place monorepo cutover. `compose` remains the fresh-install default. If both legacy volumes exist, set `RIVET_STUDIO_SERVER_COMPOSE_PROJECT` explicitly rather than letting production data selection be ambiguous.
- Docker dev rebuilds the `api` and `executor` services from Dockerfiles while running `web` through Vite; `yarn studio-server:prod:custom` rebuilds `proxy`, `web`, `api`, and `executor`
- the launchers compute host bind mounts before calling Compose. With `RIVET_ARTIFACTS_HOST_PATH=../` from the repo root, both dev and production-style Docker mount `<repo>/../workflows` at `/workflows`, `<repo>/../workflow-recordings` at `/workflow-recordings`, and `<repo>/../runtime-libraries` at `/data/runtime-libraries`. If you bypass the launcher and run Compose directly, set those three `RIVET_*_HOST_PATH` values explicitly; otherwise Compose uses isolated repo-local `.data/*` directories and will not show the external workflow tree.
- the production web image installs from the root Yarn metadata, builds the required Rivet workspaces, then builds `studio-server-web`; the root `package.json` remains the About-modal version source
- the API image builds `core`, `node`, `evaluations`, shared/bootstrap, and the API through workspace commands from the same source revision
- the web image builds `core`, `evaluations`, shared, and the hosted web workspace through the root workspace graph
- hosted Evaluations use the full upstream `EvaluationStore` contract. Suite/dataset/baseline definitions live in the API store (`evaluation-runs.sqlite` in filesystem mode or PostgreSQL in managed mode), while runs and replay evidence remain project-scoped. Do not reintroduce `evaluationRunStore`, write definitions into project YAML/sidecars, or remove the explicit Evaluation-library flush before hosted project saves. The IndexedDB `LocalEvaluationRunStore` import in `hostedRivetProviders.ts` is an idempotent one-time compatibility bridge for browsers used with older wrapper releases.
- the executor image builds `core`, `node`, Evaluations, bootstrap, and the Studio Server executor from the root workspace graph. It deliberately does not run upstream `build:executor-runtime`, because that target also compiles the native desktop sidecar and requires Rust; the hosted container uses the Studio Server's JavaScript-only esbuild bundle.
- local and image API entrypoints resolve Rivet packages through Yarn workspaces. Do not add direct imports from another package's `src` tree merely to bypass its declared exports.
- API `tsc` builds include `src/tests`, but the private service does not emit declaration files. This keeps test-helper inference portable under both PnP and the node-modules linker used by Docker. Both API Dockerfiles include the monorepo source modules that tests import statically; keep those imports inside the root image context.
- Playwright helpers that load browser assets owned by another workspace must anchor `createRequire` to that workspace's real `package.json` through `import.meta.url`. Do not derive the anchor from `process.cwd()`, because `yarn workspace ... exec` intentionally changes the working directory.
- the Docker dev API mounts the deployment scripts required by package tests and launchers at their monorepo-relative paths, so the same workspace commands run locally and inside Compose
- `yarn studio-server:dev:docker` maps Docker's supported `host-gateway` address to `host.docker.internal` in the API and Node executor containers, so Node-mode editor runs and headless endpoint runs can call a service on the developer machine at `http://host.docker.internal:<port>` without editing the launch command or `.env`; it also bypasses any configured Node executor proxy for that hostname. The target service must still listen on `0.0.0.0` (or another non-loopback interface), because a process bound only to `127.0.0.1` or `[::1]` cannot accept a Docker connection. This mapping is dev-only and is not used by production Compose or Kubernetes.
- Docker image builds use the monorepo root context. The root `.dockerignore` excludes local dependency materializations, Rust/Tauri targets, desktop sidecars, test artifacts, and prior build output while retaining the checked-in Yarn cache/releases and all workspace source required by the hosted images. `yarn studio-server:dev:docker:build` builds those images without starting the stack.
- the Docker Compose stacks set `HOME=/home/rivet` and keep npm/Yarn caches there so pulled non-root images and locally built images use the same runtime cache contract
- the launcher waits for ready services; App Settings -> `Docker` -> `Startup wait timeout` controls the overall wait window when a previous API/proxy container can provide the saved settings file, otherwise the first-run launcher default is `1200s`. Docker API healthchecks use `/readyz` and keep a long startup grace because cold starts may reconcile runtime libraries, initialize workflow storage, refresh npm dependencies, copy Rivet package sources, or relink local package overlays. `/livez` and legacy `/healthz` are liveness-only. Startup does not become complete until the HTTP listener has bound, and shutdown cleanup is serialized so late startup completion cannot leave a backend worker or pool alive. Managed readiness checks propagate cancellation into PostgreSQL and S3, cap PostgreSQL/S3 connection waits at 10 seconds, and cap idle S3 socket waits at 60 seconds; these transport bounds also protect normal managed requests from waiting forever. Compose grants the API `150s` to stop so the default `120s` application drain still leaves time for recording flush and resource cleanup before Docker kills the container
- on Windows/Docker Desktop, if Compose fails before containers start with `error while creating mount source path '/run/desktop/mnt/host/<drive>/...'` and `file exists`, first verify the host folder exists, then run `wsl --shutdown` from PowerShell to reset Docker Desktop's WSL file-sharing bridge before retrying `yarn studio-server:dev:docker`
- in Storage-tab `Object storage` mode, both workflow state and runtime-library releases come from managed services, while `/data/runtime-libraries` remains only an extracted local cache/workspace inside each container
- in Storage-tab `Object storage` mode, published/latest endpoint execution also keeps API-local warm caches for endpoint pointers and immutable revision contents; the first hit after startup or after a workflow mutation can still be slower, but repeated hits for the same unchanged trivial workflow should settle onto the warm local path
- a later cleanup pass did not change that behavior; it extracted the managed execution invalidation/service code, replaced brittle source assertions with behavioral tests, added a measurement tool, and hardened listener startup/shutdown plus same-process self-notify handling without changing the public execution contract
- if the Storage tab uses `Managed Postgres`, runtime-library replica-status rows also live in the shared Postgres database, so stale rows from older containers can survive a Docker recreate until retention cleanup runs or you clear them explicitly
- when the Runtime Libraries modal shows stale rows that are only historical dev noise, use the `Clear stale replicas` action or call `POST /api/runtime-libraries/replicas/cleanup`
- set `RIVET_WORKFLOW_EXECUTION_DEBUG_HEADERS=true` when you want additive execution timing headers for local diagnosis of endpoint resolve/materialize/execute stages
- set `RIVET_CODE_RUNNER_TELEMETRY=true` alongside workflow debug headers when you also want ManagedCodeRunner call counts, prepare/compile/execute timing, and cache hit/miss headers
- use `RIVET_MANAGED_CODE_RUNNER_DISABLE_CACHE=true` to disable only the API-side compiled Code/Expression function cache
- use `RIVET_MANAGED_CODE_RUNNER_FORCE_PREPARE_EVERY_CODE=true` to restore the previous per-code runtime-library preparation behavior without disabling telemetry or the compiled-function cache
- local Docker still does not prove multi-backend latest-debugger support; the supported Kubernetes contract is a singleton control-plane backend plus independently scalable execution replicas

## Recording-storage notes

Workflow recordings use two persistence locations:

- in `filesystem` mode:
  - compressed replay artifacts under `RIVET_WORKFLOW_RECORDINGS_ROOT`
  - a SQLite index under `RIVET_APP_DATA_ROOT`: `recordings.sqlite`; it uses rollback journaling instead of WAL so Docker volumes and Kubernetes PVCs do not need SQLite shared-memory support
  - queue and retention limits under `RIVET_APP_DATA_ROOT`: `settings/run-recordings.json`
- in `managed` mode:
  - recording metadata rows in Postgres
  - recording and replay artifacts in managed object storage
  - queue and retention limits under `RIVET_APP_DATA_ROOT`: `settings/run-recordings.json`

Filesystem-mode Docker topology now splits the hot paths intentionally:

- `RIVET_WORKFLOWS_HOST_PATH` backs `/workflows` for live projects and `.published/`
- `RIVET_WORKFLOW_RECORDINGS_HOST_PATH` backs `/workflow-recordings` for replay bundles
- `rivet_data` is shared by the API, proxy, and executor for settings and installed package plugins. Every runtime mount is no-copy; the root-only `filesystem-artifacts-init` service is its sole initializer, preventing Docker from racing to populate a fresh volume from multiple image paths.
- this keeps high-churn recording writes off the workflow-source bind mount on Windows/Docker Desktop
- the official API and executor images run as uid/gid `10001:10001`. Before either service starts, each Docker topology runs the root-only `filesystem-artifacts-init` service against the configured workflow, recording, runtime-library, and app-data mounts. It creates missing roots and repairs their ownership to that uid/gid, preserving existing files while letting an upgraded deployment reuse mounts previously created by root. It scans a mount tree only when that mount root still has legacy ownership, so ordinary restarts do not repeatedly walk runtime-library contents. Non-Compose deployments must grant the same uid/gid access themselves.
- if `/workflows` is not writable, hosted editor saves fail and the API now returns an explicit workflow-storage permission error instead of a generic hidden 500
- if `/data/runtime-libraries` is not writable, `/api/runtime-libraries` now returns an explicit runtime-library storage permission error instead of a generic hidden 500

Migration note for existing local Docker setups:

1. stop the stack
2. move `D:\Programming\workflows\.recordings` to `D:\Programming\workflow-recordings`
3. keep `RIVET_ARTIFACTS_HOST_PATH=../` so the launcher derives `D:\Programming\workflow-recordings` automatically
4. recreate the stack

For host-based API execution, filesystem-mode recording persistence still requires `node:sqlite` (Node 24+). If your host Node version is older, use the Docker dev stack instead of `yarn studio-server:dev:local`.

Filesystem-mode recording startup reconciliation is intentionally non-fatal for stale-bundle cleanup. If an old bundle directory cannot be removed because of host-side permissions, the API logs the cleanup error and still starts; the undeleted bundle simply remains on disk until permissions are corrected.

The SQLite file is only a rebuildable metadata index. If a deployment from an older image cannot open a stale `recordings.sqlite-wal` or `recordings.sqlite-shm` sidecar, stop the API, move the three `recordings.sqlite*` files out of app data as a backup, and restart. The API rebuilds the index from the recording bundles; do not remove `/workflow-recordings` or the workflow/Postgres volumes.

Filesystem-mode startup reconciliation validates `recordings.sqlite` against completed bundle metadata under `RIVET_WORKFLOW_RECORDINGS_ROOT`. The workflow-summary route may schedule the same check in the background, at most once per five minutes, but list and artifact requests do not wait for a filesystem-wide scan. A repair reads bundle metadata before opening its short SQLite replacement transaction, so concurrent requests cannot observe a cleared or partially rebuilt index. If a normal recording write or delete changes the index while that scan is running, the repair's revision guard skips the stale replacement:

- empty workflow-level recording directories do not count as completed bundles
- bundle-key signatures detect equal-count swaps between disk and SQLite
- if repair cannot converge, such as when a corrupt `metadata.json` exists, the API logs the mismatch once
- repeated repair is skipped until the completed-bundle signature or indexed counts change

The background filesystem scan stats recording metadata in bounded batches rather than opening every bundle concurrently. This avoids descriptor and I/O spikes on histories with thousands of runs.

During a rebuild, workflow display metadata is selected from the newest completed bundle for that workflow. Filesystem directory order must not let an older recording overwrite a newer project name or path in the rebuilt index.

`GET /api/workflows/recordings/workflows` and ordinary run pages read indexed metadata only; they do not decompress recording/replay bundles. The workflow list also skips graph/node project statistics and aggregate web-app publication comparisons because the Run recordings UI does not use them. If this endpoint approaches an outer-proxy timeout, inspect SQLite health and API logs first: the number or compressed size of recording payloads should no longer be part of its synchronous request cost.

Recording persistence is intentionally backgrounded after an HTTP or WebSocket action result is ready. On `SIGTERM`/`SIGINT`, the API first marks readiness as draining, stops accepting new web-app actions, and closes HTTP acceptance. Existing HTTP connections and accepted web-app runs may finish within `RIVET_SHUTDOWN_GRACE_SECONDS` (default `120s`). At the deadline, Rivet aborts tracked HTTP graph processors before forcing their client connections closed; it closes upgraded WebSocket clients without interrupting their accepted durable action processors, which can reconnect to another execution replica. Terminal WebSocket hooks can therefore enqueue their final recorders before the recording queue is flushed and managed Postgres connections are disposed. A hard kill, host failure, exhausted drain deadline, or exhausted recording queue can still prevent a recording from being stored; workflow execution results remain independent and queue drops/errors are logged under `[workflow-recordings]`.

Managed Postgres/S3 deployments apply the same `Run recordings` age and per-endpoint limits as filesystem deployments. The per-endpoint limit groups by workflow id plus historical endpoint name, so a slug reused by another project gets an independent history allowance. The control-plane API performs a global retention pass during startup and then on the chart-owned managed-maintenance timer (five minutes by default); each pass selects candidates in PostgreSQL and deletes at most the configured maintenance batch while holding its fence, so a backlog converges without loading all history into Node or using one unbounded metadata transaction. Normal endpoint writes do not initiate a global cleanup scan. The execution Deployment has that scheduler disabled and does not construct the reconciliation task or its secondary runtime-library S3 client, which keeps published `/workflows/...` traffic from multiplying retention I/O or allocating audit-only storage resources. The worker validates a PostgreSQL fencing lease inside the row-deletion transaction, enqueues the affected recording/replay object keys durably, rechecks metadata ownership before deletion, and retries transient object-store failures with bounded exponential backoff. A still-referenced object is marked `blocked` for operator investigation, never deleted by that pass; a later deletion intent reopens it after its final metadata reference has gone away. Managed byte counts use UTF-8 bytes rather than JavaScript character counts. This covers endpoint recording retention, explicit managed recording/project deletion, and blobs successfully uploaded by a request that later fails to attach them to metadata. That last path queues the known keys first and deliberately leaves them untouched if the outbox cannot be persisted, because safety beats an unchecked delete. The same owner now performs a checkpointed, audit-only reconciliation pass: it finds missing workflow references, Evaluation recordings without a parent run, and old unreferenced workflow/runtime-library object candidates, but it never deletes or queues unknown prefix objects. Object-list prefix markers are ignored; object scans persist the last prefix-relative key rather than an expiring provider continuation token; and a malformed persisted Evaluation checkpoint restarts that bounded scan rather than leaving it stuck. Findings remain provisional until their full generation commits under the maintenance fence, so their completed-scan count cannot advance after an interrupted page. A process crash between object upload and queueing is therefore detected only after the object passes the 24-hour minimum-age gate; converting a durable candidate into deletion requires a separate, reviewed retention policy.

For slow `GET /api/workflows/recordings/workflows` diagnosis in Docker, compare:

- completed bundle files under `/workflow-recordings`:
  `find /workflow-recordings -mindepth 3 -maxdepth 3 -name metadata.json -type f | wc -l`
- indexed run rows in `/data/rivet-app/recordings.sqlite`:
  `node -e "const {DatabaseSync}=require('node:sqlite'); const db=new DatabaseSync('/data/rivet-app/recordings.sqlite'); console.log(db.prepare('select count(*) n from recording_runs').get())"`

The `Run recordings` modal can also filter a workflow's runs by recorded request input. It includes both workflow endpoint runs and Rivet web-app button action graph runs. The workflow dropdown shows each workflow's saved recording count as a neutral badge so developers can pick busy histories quickly without implying publish status. Use the `Input JSON path` control with a path such as `$.foo`, an operator such as `==`, and a value such as `bar`. The API evaluates `$` against the root graph input value stored in the recording's `inputs.input.value` event. For workflow endpoint runs, that value is the HTTP request body. For web-app action runs with an `input` graph port, that value is the UI state mapped to that port; if the action target graph uses other input port names instead, `$` falls back to an object of all captured graph input values keyed by port name. Each run row shows the stored `endpointNameAtExecution` value, which is historical metadata from the time the route ran rather than the workflow's current endpoint name. Workflow endpoint runs store the endpoint slug; web-app action runs store the app route path, such as `/apps/my-tool` or `/apps-latest/my-tool`. For `contains`, when the filter value parses as a string, the resolved left operand is treated as full text too; strings are searched as-is, and objects/arrays are searched recursively across object keys and primitive values without JSON escaping, so `$ contains 'request_id'` searches the whole recorded input object and `$.foo contains 'foobar'` can match text nested inside an object at `foo`. Missing paths match `not_exists`, do not match `exists`, and resolve to actual `undefined` for the other operators; the filter value literal `undefined` also parses as `undefined`. Ordering comparisons with `undefined` do not match. This filter reads existing recording artifacts after workflow/status narrowing, newest first. For input-filtered requests a response can be non-exhaustive, including a scan window with no matches: `totalRunsExact: false`, `hasMore: true`, and `nextInputCursor` mean the dashboard can show the newest matches immediately, continue with the next cursor automatically, and append newly found runs to the visible list. The dashboard shows searching/completed/stopped status and exposes `Stop search`. Opening a recording hides the modal without resetting it, and the left panel shows a compact `Found: N` badge on the `Run recordings` row until the user explicitly clicks the modal close button. The explicit close path, filter clear/hide path, and stop button abort in-flight recordings requests; simple hide-for-replay keeps the current modal state available for reopening.

The separate `Run statistics` modal uses the SQLite/Postgres index only, so large replay bundles do not delay timing analysis. It defaults to successful published runs for the preceding seven days and can switch endpoint/web-app action targets with the left-aligned header control, set a 24-hour/7-day/30-day/90-day/custom period, and choose Published, Latest, or Both. A full-width target dropdown sits before the period and version filters and becomes searchable for longer endpoint or web-app action lists; there is no separate target sidebar. It shows the all-run `Run outcomes` counts and percentages first; those outcome rates are independent of duration analysis. A full-width divider and dedicated top spacing separate the following `Statistics` section, which defaults to successful runs and offers explicit include-failed/include-warning controls for median, P95, average, fastest, slowest, and the duration chart. `Chart grouping` keeps the compatible adaptive behavior in `Auto`, or groups non-empty chart buckets by UTC calendar day or Monday-starting ISO week. Metric cards are compact two-line value summaries for the selected period; the query and response intentionally contain no previous-period comparison payload, because period-wide change is inspected through the duration chart and a wider selected period. This avoids reading an unused second time window from the recording index. Chart series deliberately use blue for Median and violet for P95, reserving green/yellow/red for run outcomes. The modal uses the same dark overlay, surface, margins, header spacing, and body spacing contract as `Run recordings`. Duration means processor execution time, not HTTP transport, queueing, or background recording persistence. New rows retain the executed endpoint graph or web-app UI graph/component identity so renames do not merge action histories. Older path-only web-app rows, and malformed historical web-app rows without both stable UI graph and component IDs, are listed under `Legacy action`; historical rows without a leading-slash route remain endpoint runs. Target keys are opaque shared values, never delimiter-joined IDs. The API routes are `GET /api/workflows/run-statistics/targets` and `POST /api/workflows/run-statistics/query`; both are metadata-only reads.

The statistics UI keys the retained-target catalog only to the active surface, and keys timing responses to the active target, period, version, outcome, and chart-grouping controls. A slower or aborted earlier request must never render stale metrics, outcomes, or an old error under newer filters.

The target selector is a portaled modal control. Its menu must use the shared modal-menu stacking level so mouse activation remains visible above the modal surface as well as keyboard selection.

Recording playback state is project-scoped in upstream Rivet. The hosted editor bridge must attach a loaded recorder to the exact replay project id returned by the workspace open operation; writing the older `{ recorder, path }` shape loads the project but intentionally leaves `Play Recording` hidden. Switching to another project must not globally clear that owner-scoped state, and closing a replay tab prunes its cached recorder payload. Replay datasets are optional. A `404` from the replay-dataset artifact endpoint means that run has no captured dataset snapshot, and `HostedIOProvider` must continue opening the replay project with an empty dataset rather than treating that response as a project-load failure.

Keep Studio Server recording cleanup on the stable shared `loadedRecordingState` export and perform the project ownership comparison in the hosted application. Do not import an internal convenience atom such as `clearLoadedRecordingForProjectState` merely because it exists in the same monorepo: use the public host seam so Rivet editor refactors and Studio Server changes remain independently reviewable in one commit.

## Source of truth

- authored Studio Server source lives under `packages/studio-server-*`, `deploy/studio-server/`, `developer-docs/studio-server/`, and the namespaced GitHub workflows
- runtime/bootstrap code belongs under `packages/studio-server-bootstrap/`, not under deployment topology directories
- hosted editor patches that must survive production image builds should live under `packages/studio-server-web/overrides/`, `packages/studio-server-web/dashboard/`, or other tracked wrapper files
- the hosted web image builds upstream `packages/app` through `packages/studio-server-web/vite.config.ts`, not through upstream Rivet's app Vite config. When upstream app/core code imports browser-only virtual modules or browser runtime dependencies such as `nspell`, `dictionary-en`, `rivet-cspell-words`, or Zod's V4 API surface, mirror the required Vite plugin/dependency seam in the wrapper config and cover it in `packages/studio-server-web/tests/vite-aliases.test.ts`. The hosted bundle explicitly resolves bare `zod` imports to `zod/v4`, so upstream core schemas do not accidentally receive Zod's legacy default surface.
- shared Rivet source lives in the owning `packages/app`, `packages/core`, `packages/node`, `packages/app-executor`, and `packages/evaluations` workspaces. Studio Server consumes those workspaces directly; hosted-only behavior belongs in the explicit host/provider/override seams, while behavior shared by every Rivet host belongs in the owning Rivet package
- generated build output should not be treated as authored source

## Internal ownership boundaries

When adding new code, keep the post-refactor ownership seams explicit instead of rebuilding large mixed-responsibility files:

- workflow-managed backend code goes under `packages/studio-server-api/src/routes/workflows/managed/`
  - `backend.ts` is the facade/composition root
  - DB retry/query helpers stay in `db.ts`
  - transaction sequencing stays in `transactions.ts`
  - row mapping stays in `mappers.ts`
- filesystem recording compatibility code stays under `packages/studio-server-api/src/routes/workflows/`
  - keep `recordings.ts` as the public orchestrator
  - keep artifact IO in `recordings-artifacts.ts`
  - keep metadata normalization in `recordings-metadata.ts`
  - keep index/cleanup/delete maintenance in `recordings-maintenance.ts`
  - keep queue/readiness state in `recordings-store.ts`
- managed runtime-library orchestration goes under `packages/studio-server-api/src/runtime-libraries/managed/`
  - keep `backend.ts` as the facade
  - keep job persistence, SSE streaming, worker flow, process tracking, and replica cleanup in their focused modules
- workflow/filesystem compatibility code should stay obvious in `packages/studio-server-api/src/routes/workflows/storage-backend.ts`
  - do not hide `filesystem` versus `managed` behavior behind a generic abstraction layer
- wrapper-owned app settings use `packages/studio-server-api/src/app-settings/settings-repository.ts`
  - add a domain descriptor for defaults, parsing, schema version/migrations, serialization, and any deliberate fail-closed recovery; do not add another request-path `readFileSync` cache
  - keep reusable primitive validation in `packages/studio-server-api/src/app-settings/schema.ts`; it is a Zod-backed helper layer, not a replacement for domain policy. Domain modules still own their exact fallback, partial-update, stored-file, secret-retention, and fail-closed behavior. Numeric helpers intentionally accept only numbers and numeric strings, never JavaScript-coercible booleans or objects.
  - initialize repositories before API startup and read runtime values through the domain's cached synchronous accessor
  - `captureAppSettingsSnapshot` captures all registered settings domains at request entry, so request code must not bypass the repository and reread settings files midway through a request
  - async refreshes, external-file polling, and writes are serialized per settings path; keep writes and poller refreshes on the repository operation queue so an older disk read cannot replace a newly saved cache entry
  - App Settings HTTP resources use `ETag` and `If-Match`; domain writers must merge scoped PATCH drafts into the repository's current value so independent tabs and concurrent browser sessions do not lose unrelated fields
  - missing files mean first-run defaults, schema upgrades require explicit migrations, writes remain atomic owner-only JSON files, and the repository poller is the compatibility path for external proxy/bootstrap writers
- dashboard controllers belong in `packages/studio-server-web/dashboard/`
  - `useWorkflowLibraryController.ts`, `useRunRecordingsController.ts`, `useProjectSettingsActions.ts`, `useDashboardSidebar.ts`, and `useEditorBridgeEvents.ts` are composition/orchestration seams; tree fetching, selection/preview debounce, drag/drop, project/folder mutations, version actions, and retained recording-modal state stay in their focused hooks instead of returning to the workflow controller
  - `AppSettingsModal.tsx` stays a tab-composition shell; each settings domain owns its form hook under `packages/studio-server-web/dashboard/app-settings/`, and all forms use `useSettingsFormResource.ts` for revision-aware load/save/conflict handling. A tab save must send only its scoped draft and must not reset unsaved fields in another tab
  - keep the workflow-library header block at `37px` high without a bottom divider; the whole open-state header row is the collapse control with square hover corners and the sidebar icon before the `Rivet Projects` title; collapsed mode should be a persistent full-height `30px` rail button with a centered `>` chevron rather than a small header button, show the opened project's larger status dot in the former header slot only when its aggregate endpoint/web-app publication status is `Published` or `Unpublished changes`, keep the active project card grey/green/yellow tinted from that same aggregate status where any `Unpublished changes` wins over `Published`, keep the workflow tree mounted while folded, reveal the contents only after the reopen width animation completes, and keep resize behavior pointer-captured with a forgiving splitter hit target, no width transition while dragging, and fold/unfold thresholding at half the minimum sidebar width
  - single-clicking a project row should open it through the bridge as a preview tab; double-clicking, editing, running, saving, activating Remote Debugger on the active preview, or any unsafe replacement condition promotes that tab to persistent. For a not-yet-open workflow project, the dashboard should send the tree display title with `open-project`, and the iframe should call `RivetWorkspaceHost.startOpeningProjectTab(...)` before loading the file so Rivet owns the immediate tab/preloader UI. Finish that same tab with `finishOpeningProjectTab(...)` after `HostedIOProvider` returns the real snapshot, or cancel it on load/duplicate-id failure; never fake a temporary project snapshot or write upstream tab state directly. Preview replacement belongs in `usePreviewProjectLifecycle.ts` plus the serialized open handler in `useEditorCommandBridge.ts`, where the bridge can read Rivet's dirty/run/session state and close only clean known preview tabs through `RivetWorkspaceHost.closeProject(...)`. A single-click on an already-open persistent project should only activate that tab and should not close the current preview slot; the slot is replaced only when another not-yet-open project opens as preview. Keep the single-click preview debounce in `useWorkflowLibrarySelection.ts`, not per project row, so clicking a different row cancels any older pending preview open before it can reselect the previous project. When the active editor tab is the clean preview being replaced, use `replaceCurrent` through `RivetWorkspaceHost` instead of closing it first, so the dashboard does not blink back to a persistent tab while the next preview loads. When replacing an inactive preview, keep `DashboardPage.tsx`'s pending-open guard intact so intermediate active-project callbacks from closing the old preview do not briefly select the persistent project before the new preview opens. Pass `tabUi: { preview: true }` for preview opens/replaces and clear it with `setProjectTabUiState(..., { preview: false })` when promoting, so upstream Rivet owns the italic editor-tab rendering. Remote Debugger promotion should observe only Rivet's `external-debugger` executor-session target, not hosted internal executor reconnects. The active project card should not reintroduce a separate `Edit` button; row click/double-click owns open intent, empty workflow-library body clicks clear only the selected card, and the fixed-height card keeps the project name above endpoint/web-app status lines, then the graph/node/web-app count line. The endpoint line and web-app line should always render for selected projects with the same status-row height whether the row contains a pill or plain text; projects with no current web apps show `Web app: none`, while projects with web apps load status from the existing project web-app summary endpoint only for the selected project. The tree project dots and collapsed rail dot should use the same aggregate status as the summary card: grey means no dot, green means green dot, and yellow means yellow dot. The card keeps a clear vertical gap before the visibly button-like `Settings` action and conditional `Save` button, and must reserve the same height when no project is selected so the project tree below it does not jump. `Save` is shown only when the selected workflow is the active editor project and Rivet reports unsaved changes through the editor bridge.
  - keep bottom panel actions in the mounted workflow-library panel; the app-level `Settings` modal uses a left vertical tab rail, shows general runtime config, owns the Run recordings retention form with shared tab-style mode choices, and owns the Node executor proxy form plus websocket URL override fields
  - keep project-settings validation and labels in `projectSettingsForm.ts`
  - keep run-recordings modal shell logic in `RunRecordingsModal.tsx` and its focused UI slices in `RecordingWorkflowSelect.tsx` and `RecordingRunsTable.tsx`
  - Run statistics targets are a catalog of every retained endpoint or web-app action for the selected surface. Period, published/latest version, and outcome checkboxes apply only to the selected target's query; when they match no runs, preserve the target selection and state that result directly below the filters.
  - portal run-recordings dropdown menus that can open inside the scrollable modal body, such as the input-filter operator select, so option lists are not clipped by modal overflow
  - keep `RuntimeLibrariesModal.tsx` as the shell, `useRuntimeLibrariesModalState.ts` as the public controller, and `runtimeLibrariesJobStream.ts` as the SSE/log-state helper layer
  - page/components should stay mostly render wiring
- dashboard/editor bridge wiring should stay explicit
  - `DashboardPage.tsx` is the composition root
  - `HostedEditorApp.tsx` mounts `RivetAppHost`, passes the hosted provider overrides from `hostedRivetProviders.ts`, captures the upstream `RivetWorkspaceHost` through `onWorkspaceHostReady`, and forwards upstream host callbacks for active project, open-project count, and save completion
  - `HostedEditorApp.tsx` also passes hosted UI policy through `RivetAppHost.ui`: `fileMenu.visibleItems` keeps the iframe File menu to `import_graph`, `export_graph`, `settings`, and `get_help`; `webApps.desktopPreview: false` hides the desktop-only `Run web app` preview action; and `keyboardShortcuts.saveProject: true` makes Rivet own iframe-focused `Ctrl+S` / `Cmd+S`. Keep these on upstream host policy seams instead of hiding DOM or aliasing command hooks
  - `useEditorCommandQueue.ts` owns pre-ready command buffering
  - `useEditorBridgeEvents.ts` owns dashboard-side message listeners and cross-iframe save shortcut capture
  - `EditorMessageBridge.tsx` is the editor-side composition root after the workspace host handle is ready. `useEditorCommandBridge.ts` owns command origin checks, FIFO dispatch, and acknowledgements; implementations stay split across `editorProjectOpenCommands.ts`, `editorDetachedProjectCommands.ts`, and `editorProjectLifecycleCommands.ts`. Preview state belongs in `usePreviewProjectLifecycle.ts`, replay restoration in `useWorkflowRecordingBridge.ts`, and find/duplicate/pointer focus behavior in `useEditorBridgeInteractions.ts`; do not rebuild one effect that owns all four domains or move every command implementation back into the queue hook
  - preview bookkeeping may read upstream dirty/run atoms to decide whether a tab is replaceable, but it should not mutate dirty-state atoms; clean promotion/replacement and transient preview-tab UI state still go through `RivetWorkspaceHost` methods. Path-move commands must acknowledge completion back to the dashboard after open tabs, preview state, session caches, hosted revision paths, and externally persisted title/path metadata are retargeted, so a user cannot immediately reactivate an already-open moved project through a stale path and force an unnecessary reload. Use `RivetWorkspaceHost.updateProjectMetadata(...)` for path-only folder moves too, not only file-name/title renames.
  - project-tree compare should stay a bridge command: the dashboard may send `compare-open-project-with` for another workflow project, or for the active/open project's current published-version preview when the row is in `Unpublished changes`. If the right-click reference project itself is in `Unpublished changes`, the dashboard should ask whether to compare against its saved live file or current published snapshot before sending the bridge command. `EditorMessageBridge.tsx` should load only the reference `.rivet-project` contents before calling `RivetWorkspaceHost.startProjectCompare(...)` with optional side labels. Do not persist compare state, open a detached preview tab for the published-reference path, import the reference project's datasets into the active hosted dataset provider, or write upstream compare atoms directly.
- hosted provider wiring should stay explicit
  - import the app shell and CSS through `packages/app/src/host.tsx` and `packages/app/src/host.css`
  - pass `HostedIOProvider`, an injected `HostedDatasetProvider`, the hosted environment provider, and the hosted path-policy provider through `RivetAppHost.providers`
  - keep hosted environment lookup cached and deduplicated in `packages/studio-server-web/overrides/utils/tauri.ts`; warm node settings panel opens should not issue repeated `/api/config/env/*` requests, including for empty or disallowed env values
  - keep `HostedIOProvider` and Rivet's active dataset provider on the same import/export-capable dataset-provider instance so project file IO, dataset UI, and runtime hooks observe the same imported datasets
  - keep `HostedDatasetProvider` pruning old per-project IndexedDB dataset rows before importing a project payload, otherwise datasets removed from a project can reappear from stale browser app storage
  - declare packages imported by the hosted Rivet import graph directly in `packages/studio-server-web/package.json`; the workspace declares `idb` because hosted dataset/storage modules import it. Do not rely on a coincidental transitive dependency.
- hosted project context values are editor-owned app state, not `.rivet-project` file contents
  - Rivet stores them under `projectContext__"<projectId>"`, so hosted open/reopen persistence depends on stable `project.metadata.id` values
  - keep `packages/studio-server-web/overrides/state/savedGraphs.ts` exporting the hosted `clearProjectContextState` compatibility helper by delegating normal tab cleanup to upstream `releaseProjectContextState`, so `RivetWorkspaceHost.closeProject()` and `replaceCurrent()` can close tabs without deleting those stored values
  - actual dashboard workflow deletion should forward the project id returned by `DELETE /api/workflows/projects`, then call `deleteHostedProjectContextState` and `clearHostedDatasetsForProject` from the iframe delete handler so stale editor-owned browser state does not remain even when the tab was already closed; the delete helper removes `projectContext__"<projectId>"` through the shared `project` storage group
- editor executor transport should prefer Rivet's upstream host/session seam
  - mount the editor through `RivetAppHost`
  - pass the hosted executor websocket through `executor.internalExecutorUrl`; it must come from runtime `/api/config`, defaulting to the current host's `/ws/executor/internal` unless App Settings has a saved websocket override
  - use `RivetAppHost.ui.fileMenu.visibleItems` for hosted File menu visibility and `RivetAppHost.ui.webApps.desktopPreview` for the hosted web-app preview capability; leave command execution in upstream Rivet
  - keep graph execution, upload, abort, pause/resume, and websocket message ownership in upstream Rivet hooks
  - do not alias `useExecutorSession`, `useRemoteDebugger`, `useGraphExecutor`, or `useRemoteExecutor`; upstream Rivet owns internal executor UI classification and debugger handoff for `executor.internalExecutorUrl`
  - stale wrapper transport override files were removed; do not reintroduce them unless the upstream seam no longer covers hosted behavior
- hosted opened-project hooks should preserve Rivet 2.0's split tab state
  - keep `projectsState.openedProjects` as lightweight tab metadata: project id, title, path, and opened graph
  - keep full in-memory project content in `openedProjectSnapshotsState`
  - prefer `RivetWorkspaceHost.openProjectSnapshot`, `replaceCurrent`, `closeProject`, `moveProjectPaths`, and `updateProjectMetadata` for the actual workspace transition or externally persisted title/path reconciliation
  - wrapper atom reads are acceptable for hosted path lookup, duplicate-project-id checks, and stale-empty-tab cleanup, but do not reimplement tab close fallback, path rewrite transitions, or live project metadata patching in wrapper code when the workspace host exposes them
  - normalize persisted opened-project metadata by dropping missing entries, orphan metadata, duplicate project ids, and legacy full-project payloads before the tab strip reads it; when damaged duplicate entries share an id, prefer the entry that still has a file path
  - resolve tab titles through the wrapper helper so old projects or legacy persisted tab entries fall back to the project filename instead of rendering missing, `undefined`, or `null` labels
  - when the visible tab strip is empty, the next workflow open must reset opened-project metadata and snapshots instead of merging hidden stale entries from older sessions
  - run that stale-empty-tab cleanup after `RivetWorkspaceHost` opens the requested snapshot, not before async project loading, so upstream sync effects cannot re-add the previous hidden project while loading is in flight
  - after the tab strip remounts, do not let the previous pathless `projectState` re-add itself; the sync hook may register the current project only when its project id is already present in the visible opened-project id list or the current project is still file-backed by `loadedProject.path`
  - prune pathless opened-project metadata when there is neither an active current project nor an `openedProjectSnapshotsState` entry that can activate that tab
  - project loading must read the latest atom store at call time, and direct workflow opens should pass their freshly loaded snapshot into the workspace host instead of depending on a just-written atom value to be visible immediately
  - if direct workflow activation fails, rely on the workspace host's boolean result and avoid posting `project-opened` to the dashboard
  - when fixing tab close/switch behavior, update the wrapper overrides rather than storing full project objects back into `projectsState.openedProjects`
  - if `useSyncCurrentStateIntoOpenedProjects` is overridden for hosted tab cleanup, carry forward upstream's dirty-digest sync as well: `buildCurrentProjectContentSnapshot`, `savedProjectContentDigestsState`, and `projectUnsavedChangesState` are what make the editor tab unsaved-changes dot appear after edits
  - carry forward upstream's per-project executor metadata in hosted opened-project overrides: the active tab must write `OpenedProjectInfo.executorMode`, and `useLoadProject` must pass `projectInfo.executorMode` back into `workspaceTransitions.loadProject(...)` so Browser, Node, and Remote Debugger choices are restored when switching tabs
- wrapper module overrides should stay scoped to upstream app importers
  - `packages/studio-server-web/vite.config.ts` resolves override files only when the importer is under `packages/app/src`
  - keep the `savedGraphs` override narrow: it re-exports upstream state, maps the hosted `clearProjectContextState` compatibility helper to upstream `releaseProjectContextState` for normal tab close/reopen, and exposes an explicit storage-removing delete helper for actual workflow deletion
  - keep the `state/settings` override narrow: delegate upstream settings exports and override only hosted executor/debugger defaults plus the wrapper update-check modal atom, so upstream UI settings such as canvas background preferences and custom theme color helpers are not copied into the wrapper
  - do not put wrapper-owned transport overrides back into `packages/studio-server-web/vite-aliases.ts`
  - do not alias `useSaveProject`, `useMenuCommands`, or `useWindowsHotkeysFix`; upstream `RivetAppHost.ui.keyboardShortcuts.saveProject`, `RivetWorkspaceHost.saveCurrentProject()`, `RivetAppHost.onProjectSaved`, and `RivetAppHost.ui.fileMenu.visibleItems` own the save/menu seam. The wrapper sends `save-project` only when focus is outside the iframe and reconciles saved title/path metadata through `RivetWorkspaceHost.updateProjectMetadata()` after successful saves
  - keep dashboard-focused `Ctrl+S` / `Cmd+S` narrow: prevent browser Save Page behavior, consume repeat keydowns without sending another bridge command, and let `useEditorCommandBridge` call `RivetWorkspaceHost.saveCurrentProject()`. Preview promotion must be driven by `RivetAppHost.onProjectSaved`, not by save invocation, so cancelled or failed saves stay previews
  - do not mutate `projectState`, `graphState`, `projectDataState`, or `openedProjectSnapshotsState` from save-completion callbacks. Upstream Rivet marks the saved snapshot clean inside its save transition, and post-save wrapper mutations to active project content can make the editor-owned unsaved-changes dot compare against the wrong digest.
  - if a future wrapper-owned save path bypasses Rivet's save command, call `RivetWorkspaceHost.updateProjectMetadata(..., { persistedExternally: true })` for externally persisted title/description updates, or `markCurrentProjectClean()` / `markProjectClean()` for clean-baseline-only reconciliation after the backend save succeeds; never import or mutate `savedProjectContentDigestsState`, `projectUnsavedChangesState`, or `projectDataUnsavedChangesState` from wrapper code
  - do not reintroduce wrapper copies of `TauriProjectReferenceLoader`, `io/datasets`, `io/TauriIOProvider`, or `utils/globals/ioProvider`; hosted relative-project reads belong in the path policy provider, and hosted project/dataset persistence belongs in `RivetAppHost.providers` plus `HostedIOProvider`
  - keep `deploy/studio-server/scripts/update-check.sh` aligned with that boundary: it should check the upstream provider seams, not treat provider-backed upstream modules as wrapper aliases
  - keep bare-package shims such as `@tauri-apps/api/*` separate from relative Rivet module overrides
  - do not keep stale component copies such as `OverlayTabs` in the wrapper; the current Rivet 2 workspace tab row is upstream-owned, and observer coverage should follow its accessible `Workspace navigation` buttons
- API workflow execution should resolve `@valerypopoff/rivet2-node` through its declared workspace dependency
  - keep the package-name import as the stable seam
  - build owning Rivet workspaces before API checks when their exports are generated
  - do not add direct API imports from another package's `src` tree
- API-local warm caches are derived accelerators only
  - use `lru-cache` for generic access-order and byte-budget eviction in managed execution and managed Code/Expression compilation/require caches
  - keep domain ownership of workflow-to-key reverse indexes, byte measurements, oversized-entry rejection, cross-replica invalidation, release-snapshot invalidation, and Node `require.cache` clearing; do not spread the library into filesystem freshness caches
- Kubernetes template reuse should stay shallow
  - use `_env.tpl` and `_pod.tpl` for genuinely repeated backend/execution blocks
  - keep `proxy` and `web` explicit unless extraction clearly improves readability

## Safe verification workflow

For Studio Server API changes:

1. `yarn workspace @valerypopoff/rivet-studio-server-api run test`
2. `yarn workspace @valerypopoff/rivet-studio-server-api run build`

Current repo-local baseline:

- `yarn studio-server:test` is the one-command root test gate for non-browser automation. Its `pretest` hook runs the same dependency bootstrap as the dev launchers, then the test command builds every Studio Server dependency/workspace, runs default API tests and pure web helper tests, executes the hosted-editor compatibility scanner, and finishes with test-style, repo-structure, and Kubernetes launcher/chart contracts. It intentionally does not run Playwright because those specs require a live browser/app target and, for some managed flows, deliberate mutation opt-in.
- The image-build workflow calls the reusable Studio Server verification workflow while immutable candidate images build in parallel. Promotion still requires the verification aggregator, all four image builds, and the authenticated candidate-image Compose smoke. The smoke starts the exact candidate API, web, executor, and proxy tags, verifies the UI key gate, proxy routing, the executor WebSocket, the direct API-only pull metrics endpoint (enabled only for that smoke), and a published workflow execution. It supplies the string Graph Input as a direct JSON string rather than an object wrapper, matching the published-workflow input contract. It exercises the same Compose ownership initializer used by development and production, so its disposable bind mounts model an upgrade from host-owned directories without a CI-only permission bypass. On failure it reports the causal assertion before container diagnostics and bounds Compose teardown, so a cleanup delay cannot hide the actual cause. Deployment-sensitive changes, tags, schedules, and manual releases additionally require the disposable Kind gate; ordinary application commits use the faster Compose gate. Public aliases are applied only after every applicable gate succeeds.
- `.github/workflows/studio-server-verify.yml` is both the direct `develop` verifier and the reusable same-commit image verifier. It builds once, uploads compiled dependencies, and runs four isolated API shards plus web tests, host compatibility, repository contracts, and Kubernetes/deployment contracts in parallel. The artifact paths share `packages/` as their common ancestor, so every dependent job restores them beneath `packages/`; extracting to the repository root would relocate workspace exports and cause false `ERR_MODULE_NOT_FOUND` failures. The one stable-named producer uses `overwrite: true` because Actions artifacts are immutable: retrying only a failing consumer still downloads the original artifact, while retrying the producer replaces it cleanly. The API manifest discovers test files recursively, so a newly nested API test fails validation until it is assigned to exactly one shard. The final `verify` job preserves the existing status identity. A lightweight changed-path classifier may skip heavy jobs on unrelated commits without omitting the final status check. Stale branch and pull-request verification is canceled; tag, schedule, and manual release verification is not.
- Job timing summaries are the current performance evidence. Both the generic Build and the Studio Server verification aggregators report their complete critical paths, while substantive jobs report their own wall time. Treat the former five-minute image note as historical; compare current Build, verification, candidate smoke, and optional Kind timings independently.
- If the full API suite fails with `ERR_MODULE_NOT_FOUND`, run `yarn install --immutable` and confirm the importing workspace declares the package directly before treating it as an application regression.
- The test-suite cleanup plan previously lived in the root `tests-refactor.md` working document; after final prune, keep the lasting outcomes in `docs/refactor-history.md` and keep the public verification commands stable for future cleanup.
- API workflow tests should reuse the shared helpers under `packages/studio-server-api/src/tests/helpers/` before adding local harness code. Workflow HTTP harnesses, JSON response handling, recording waiters, filesystem execution cache invalidation probes, temp workflow roots, root-level published-project fixtures, and the filesystem workflow suite bootstrap/cleanup live there.
- The canonical default API file list lives in `deploy/studio-server/scripts/api-test-files.mjs`. `yarn workspace @valerypopoff/rivet-studio-server-api run test` executes that complete manifest serially. CI uses `run-api-tests.mjs --shard-index N --shard-count 4` to divide the same sorted list across isolated runners while preserving `--test-concurrency=1` inside each shard. To run only specific files, use `yarn workspace @valerypopoff/rivet-studio-server-api run test:files -- src/tests/example.test.ts`.
- The old mixed `workflow-services.test.ts` suite has been split by behavior domain. Put new filesystem tree/import/export coverage in `workflow-filesystem-tree.test.ts`, publication-state, endpoint-reservation, and published project-reference coverage in `workflow-publication-filesystem.test.ts`, published-version-history coverage in `workflow-published-history-filesystem.test.ts`, endpoint execution/cache coverage in `workflow-execution-filesystem.test.ts`, and recording route coverage in `workflow-recordings-http.test.ts`. Project move coverage must use `moveWorkflowItemWithBackend(...)`, the same cache-invalidating boundary used by the production route.
- The old mixed `managed-backend-sql.test.ts` suite has been split. Put managed schema, folder-move SQL, and execution lookup query contracts in `managed-workflow-schema.test.ts`; put managed publication history, restore, star persistence, and save-target behavior in `managed-publication-history.test.ts`. Schema tests should import the exported SQL string, not read `schema.ts` as source text, so escaping regressions are tested against what the app actually sends to Postgres.
- The old broad `phase4-static-contract.test.ts` suite has been split. Put proxy, Docker image, CI image, and production launcher contracts in `proxy-image-contract.test.ts`; hosted editor wrapper/upstream seam guardrails in `hosted-editor-seams.test.ts`; and Helm/chart topology assertions in `kubernetes-contract.test.ts`.
- `yarn workspace @valerypopoff/rivet-studio-server-api run test` intentionally does not run Helm. Use `yarn studio-server:verify:kubernetes` for Kubernetes launcher tests, Helm-rendered chart contracts, and production overlay lint/template checks. The API suite runs with `--test-concurrency=1` because many API tests intentionally set process-wide `RIVET_*` roots before importing route modules; keep that serialization unless the affected tests are refactored to avoid global env mutation.
- Wrapper regressions built from upstream Rivet fixtures must derive fixture project and graph IDs from the parsed fixture instead of copying generated IDs into the test. For filesystem project-reference moves, cover a reused former hint path as well as the moved target: the wrapper must verify a hinted project's immutable ID before accepting it, then resolve the moved project by ID. When a fixture needs `Project.references`, set that field on the parsed project and serialize it with Rivet; do not rely on a version-specific YAML placeholder such as `references: []`.
- `yarn studio-server:verify:test-style` owns the test-suite style guardrails: root `yarn studio-server:test` must keep composing the non-browser repo-local gate after the standard `pretest` dependency bootstrap, the canonical API manifest must list every non-Kubernetes API test exactly once, `verify:web-pure` must list every pure web test exactly once, `kubernetes-*.test.ts` API files must stay behind `verify:kubernetes`, runnable test/spec files must stay in their expected top-level suite folders, retired or merged-away suites must not come back, `.only` tests are blocked, and wrapper tests/helpers must not assert upstream `packages/app/src` implementation paths beyond the approved host entry/style seam.
- Observable Playwright specs validate whichever app is currently running at `PLAYWRIGHT_BASE_URL`; that target can be an older rebuilt container or a published image. Do not read local `package.json` metadata from Playwright specs to assert deployed UI text. If version display is the behavior under test, assert that the live modal renders a version-shaped value, or explicitly run the spec against a freshly rebuilt local target.
- Tests that intentionally exercise negative paths should capture and assert expected `console.error` or `console.warn` output. A passing `yarn studio-server:test` should not print scary stack traces for failures that the test deliberately caused.
- Final-prune cleanup should not reintroduce a broad suite just to keep a helper alive. If a helper has no call sites after a split, delete the helper and let `yarn workspace @valerypopoff/rivet-studio-server-api run build` plus `yarn studio-server:verify:test-style` prove the manifest and type boundaries.
- `deploy/studio-server/scripts/update-check.sh` must list every active `createModuleOverrideAliases(...)` target. `yarn studio-server:verify:web-pure` checks that the scanner and Vite aliases stay aligned, and `yarn studio-server:verify:host-compatibility` executes the scanner from the monorepo root, so update both when adding or removing hosted overrides.
- `yarn studio-server:verify:kubernetes` lint-renders the Helm chart with real image repository overrides, including the restore-drill contract tests, and verifies the key negative cases:
  - placeholder image repositories are rejected
  - published-route-prefix overrides are rejected
  - the managed-only chart shape is enforced
- `yarn studio-server:verify:kubernetes:managed-restore` is a protected, mutation-capable operator drill—not an ordinary CI or development command. Run it only from the clean promoted checkout named by its backup manifest, with a provider-owned disposable target and explicit confirmation; the runner enforces that clean-checkout requirement. It requires a non-local HTTPS DNS host and rejects production identity reuse without trusting letter case or a DNS trailing dot (including a reused host on a different port), reads each driver YAML once before validating and applying that exact content, forbids HTTP redirect-following during target probes, requires provider restore/integrity/cleanup Jobs with positive object recovery/reference evidence, atomically labels and re-verifies its disposable namespace before teardown, confirms disposable-target deletion before reporting success, and leaves a sanitized local report; scheduling or a secret-bearing GitHub workflow requires an explicit operations approval.
- managed migration verification now has direct regression coverage for its comparison logic, but real import/cutover confidence still requires the managed Docker rehearsal described below.

For hosted editor shell changes, keep `packages/studio-server-web/index.html` loading the same font families that Rivet styles reference. Rivet uses both `Roboto` and `Roboto Mono`; loading only the monospace family leaves several upstream panels on browser fallbacks.

For packages/studio-server-web changes:

1. `yarn workspace @valerypopoff/rivet-studio-server-web run build`
2. if the change adds or changes pure helper logic under `packages/studio-server-web/dashboard/` or `packages/studio-server-web/overrides/hooks/`, run `yarn studio-server:verify:web-pure`
3. if the change affects browser-visible behavior, run `PLAYWRIGHT_HEADLESS=1`, `PLAYWRIGHT_SLOW_MO=0`, then `yarn studio-server:ui:observe`
4. if the Playwright coverage needs real workflow mutations in Storage-tab `Object storage` mode, set `PLAYWRIGHT_ALLOW_MANAGED_MUTATIONS=1` deliberately and keep cleanup explicit; prefer mocked API/browser tests for modal and controller coverage when storage mutation is not the point
5. if the change lives under `packages/studio-server-web/overrides/` or affects hosted editor save/hotkey behavior, also verify with `yarn studio-server:prod:custom`; `yarn studio-server:prod` deliberately pulls already-published images instead of using your local workspace changes

For workflow-library mutations that change on-disk project state:

1. `yarn studio-server:dev`
2. validate the browser flow through `http://localhost:8080` by default, or your configured `RIVET_PORT`
3. right-click a project in the left panel and run `Duplicate`
4. for `unpublished`, confirm the new project appears in the same folder as `Name [unpublished] Copy.rivet-project` and that the current selection/editor tab did not change
5. for `published`, confirm duplication uses the published snapshot and names the duplicate `Name [published] Copy.rivet-project`
6. for `unpublished_changes`, confirm the chooser appears and both saved versions duplicate correctly, including the expected `Name [published] Copy.rivet-project` vs `Name [unpublished changes] Copy.rivet-project` naming
7. confirm duplication still leaves the current selection/editor tab unchanged

For workflow-library project creation behavior:

1. `yarn studio-server:dev`
2. validate the browser flow through `http://localhost:8080` by default, or your configured `RIVET_PORT`
3. right-click a folder in the left panel and run `Create project`
4. enter a new project name when prompted
5. confirm the folder expands and the new project opens in the editor
6. confirm there is no inline `+` create-project button on folder rows anymore
7. try an existing name in the same folder and confirm the UI shows the API conflict instead of silently overwriting the file

For workflow-library folder creation behavior:

1. `yarn studio-server:dev`
2. validate the browser flow through `http://localhost:8080` by default, or your configured `RIVET_PORT`
3. click `+ New folder` at the bottom of the workflow library
4. enter a folder name when prompted
5. confirm the new folder appears at the root level of the tree
6. try an existing root-level name and confirm the UI shows the API conflict instead of silently overwriting anything

For workflow-library folder rename behavior:

1. `yarn studio-server:dev`
2. validate the browser flow through `http://localhost:8080` by default, or your configured `RIVET_PORT`
3. right-click a folder in the left panel and run `Rename folder`
4. confirm the folder row turns into an inline edit field with the current name selected
5. press `Esc`, then repeat and click elsewhere, and confirm both paths cancel without renaming
6. enter a new folder name and press `Enter`
7. confirm the edit field closes immediately and the old folder name shows a preloader while the rename is saving
8. confirm the folder remains in the tree under the new name
9. if the folder was collapsed before pressing `Enter`, confirm it stays collapsed after the renamed row appears
10. if the folder contained projects that are open in the editor, confirm those tabs still point at the renamed paths and save correctly afterward
11. try renaming to an existing sibling folder name and confirm the preloader clears and the UI shows the API conflict without leaving a stale edit field open

For workflow-library folder deletion behavior:

1. `yarn studio-server:dev`
2. validate the browser flow through `http://localhost:8080` by default, or your configured `RIVET_PORT`
3. right-click an empty folder in the left panel and run `Delete folder`
4. confirm the UI asks for confirmation before deletion
5. confirm the folder disappears only after confirming
6. right-click a non-empty folder and confirm the `Delete folder` action is disabled
7. if you call the API directly for a non-empty folder, confirm it still rejects with `Only empty folders can be deleted`

For workflow-library drag/drop move behavior:

1. `yarn studio-server:dev`
2. validate the browser flow through `http://localhost:8080` by default, or your configured `RIVET_PORT`
3. drag a project from one folder to another and confirm the tree updates after the drop
4. if that project is open in the editor, confirm saves still target the new path after the move
5. drag a folder into another folder and confirm all nested projects move with it
6. drag a project or folder back to the root area and confirm it is reparented to the root
7. try to drag a folder into itself or one of its descendants and confirm the move is rejected cleanly

For workflow-library upload behavior:

1. `yarn studio-server:dev`
2. validate the browser flow through `http://localhost:8080` by default, or your configured `RIVET_PORT`
3. right-click a folder in the left panel and run `Upload project`
4. choose a local `.rivet-project` file in the browser picker
5. note that some browsers may still show a generic picker instead of pre-filtering `.rivet-project`; selecting the wrong file type should fail cleanly without uploading anything
6. confirm the project appears in that folder
7. if the folder already contained that name, confirm the new file is saved as `Name 1`, `Name 2`, and so on
8. confirm the upload does not change the current selection, open a different tab, or expand folders automatically

For workflow-library download behavior:

1. `yarn studio-server:dev`
2. validate the browser flow through `http://localhost:8080` by default, or your configured `RIVET_PORT`
3. right-click a project in the left panel and run `Download`
4. for `unpublished`, confirm the browser downloads `Name [unpublished].rivet-project`
5. for `published`, confirm the browser downloads `Name [published].rivet-project`
6. for `unpublished_changes`, confirm the chooser appears and both saved versions download correctly
7. make unsaved editor changes and confirm downloads still reflect only the saved server-side versions
8. confirm the download flow does not change selection, open a different tab, or expand folders

For workflow-library project deletion behavior:

1. `yarn studio-server:dev`
2. validate the browser flow through `http://localhost:8080` by default, or your configured `RIVET_PORT`
3. right-click a project with no workflow endpoint publication and no published web apps in the left panel and run `Delete project`
4. confirm the context-menu action only opens Project Settings and does not delete immediately
5. confirm the project is deleted only after clicking `Delete project` again inside Project Settings
6. right-click a project that has a published workflow endpoint, unpublished workflow changes, or published web apps and run `Delete project`
7. confirm the UI shows `To delete a project, unpublish its workflow endpoint and web apps first`
8. confirm the guarded delete action does not change selection, open a different tab, or delete anything directly from the context menu

For workflow-library project rename entry behavior:

1. `yarn studio-server:dev`
2. validate the browser flow through `http://localhost:8080` by default, or your configured `RIVET_PORT`
3. right-click a project in the left panel and run `Rename project`
4. confirm the project row turns into an inline edit field with the current name selected
5. select the same project row again, press `F2`, and confirm it starts the same inline edit field
6. press `Esc`, then repeat and click elsewhere, and confirm both paths cancel without renaming
7. enter a new project name and press `Enter`
8. confirm the edit field closes immediately and the old project name shows a preloader while the rename is saving
9. confirm the saved `.rivet-project` now has `project.metadata.title` equal to the new tree name
10. if the project is already open, confirm the Rivet tab label, graph-list project header, Project Settings title, and other editor title surfaces change to the new tree name without closing or reloading the project
11. confirm the renamed row keeps the previous selection/open editor tab by following the returned `movedProjectPaths`
12. try renaming to an existing sibling project name and confirm the preloader clears and the UI shows the API conflict without leaving a stale edit field open
13. open Project Settings separately and confirm there is no modal-level rename button or title edit field

For hosted editor keyboard-node behavior:

1. `yarn studio-server:dev`
2. validate through `http://localhost:8080` by default, or your configured `RIVET_PORT`
3. open a workflow in the editor iframe and confirm the workflow-library row that opened it does not keep the visible browser focus outline
4. confirm the editor iframe receives keyboard focus after open without showing a visible white perimeter
5. click a node normally and confirm `Ctrl+C`, `Ctrl+X`, `Ctrl+V`, and `Ctrl+D` use the internal node clipboard/duplicate behavior
6. deliberately return focus to the workflow library, then confirm `Shift+click` multi-selection inside the editor reclaims iframe focus and still copies multiple nodes
7. deliberately return focus to the workflow library, then click blank canvas background and confirm `Ctrl+C` / `Ctrl+X` / `Ctrl+V` work again without an extra recovery click on a node
8. open and close an editor context menu or search UI, then confirm `Ctrl+C`, `Ctrl+X`, and `Ctrl+V` still work after returning to the canvas
9. deliberately return focus to the workflow library with a node still selected, then confirm `Ctrl+D` duplicates that node instead of opening the browser bookmark UI
10. deliberately return focus to the workflow library, then confirm `Ctrl+F` opens Rivet graph search instead of the browser find UI
11. focus the editor iframe/canvas, then confirm `Ctrl+F` still opens Rivet graph search and a physical `KeyF` find shortcut is also prevented from reaching browser find even when `event.key` is not `f`; with a Rivet search field already mounted, confirm the same shortcut focuses that field instead of closing overlays
12. confirm `Ctrl+S` works while focus is inside the workflow iframe on Windows/Linux, `Cmd+S` works on macOS, and dashboard-focused save produces one persistence request without browser Save Page UI
13. confirm `Ctrl+Shift+I` remains browser-owned for DevTools and does not open Rivet's graph import picker
14. confirm the browser can still type normally inside real text inputs and that copy/paste/duplicate/save/search shortcuts do not hijack active editor form fields

For hosted editor production-image regressions:

1. remember that `yarn studio-server:prod` and `yarn studio-server:prod:prebuilt` use pulled images, `yarn studio-server:prod:restart` keeps already-local images, and `yarn studio-server:prod:custom` builds the current monorepo workspace
2. if dev works but prod does not, compare the exact published image revision with the current monorepo commit and keep any hosted-only adaptation in the tracked Studio Server host/override seam rather than modifying shared editor behavior solely for the hosted application
3. for clipboard or graph-tree context-menu regressions specifically, check the tracked hosted overrides for `useCopyNodesHotkeys`, `useContextMenu`, and the canvas focus handoff in `EditorMessageBridge.tsx`; the context-menu override must keep upstream's virtual pointer anchor plus `setFloatingMenu` return and should not depend on removed graph-list positioning classes such as `graph-item-context-menu-pos` or `graph-list-context-menu-pos`

For slow hosted node settings panels:

1. open DevTools Network and filter for `/api/config/env/`
2. open the same node settings panel twice
3. a cold page may make one concurrent burst of env requests, but the warm open should not repeat them
4. repeated warm env requests usually mean `packages/studio-server-web/overrides/utils/tauri.ts` stopped caching empty env responses or stopped deduplicating pending requests
5. panel latency that is the same in small and large projects usually points to fixed hosted provider work, not `.rivet-project` YAML parsing or opened-project snapshot caching
6. after changing server env values, restart or recreate the app and reload the browser page because hosted env values are cached for the browser page session

For published-project save status behavior:

1. `yarn studio-server:dev`
2. validate through `http://localhost:8080` by default, or your configured `RIVET_PORT`
3. publish a workflow project
4. save it with no actual changes and confirm the sidebar stays `Published` without a brief `Unpublished changes` flicker
5. if you are in `managed` mode, also confirm the saved revision id does not change on that no-op save
6. then make a real saved change, save again, and confirm the sidebar updates to `Unpublished changes`

For workflow-tree stats performance:

1. `GET /api/workflows/tree` should not parse every managed project blob just to show graph/node counts; managed stats come from `workflow_revisions.stats_*`, with a one-time lazy blob read only for legacy revisions that have null stats
2. in filesystem mode, `*.wrapper-stats.json` is generated and can be deleted safely; the next tree read or hosted save rebuilds it
3. project rename, move, and delete flows must move/remove the stats sidecar with the project, but generated stats sidecars should not block user operations the way publication settings or dataset sidecars do
4. after save, keep status validation separate from stats caching: a no-op save on a published project must stay `Published`, while a real saved change must become `Unpublished changes`

For routing/auth/deployment changes:

1. `yarn studio-server:dev`
2. validate the browser flow through `http://localhost:8080` by default, or your configured `RIVET_PORT`

For the current Helm chart and images:

1. set all `images.*.repository` values to the GHCR repositories documented in [kubernetes.md](./kubernetes.md), and pin all four tags to the same published image tag for production
2. keep `replicaCount.proxy>=2` and let proxy autoscaling absorb ingress pressure from public endpoint traffic
3. keep `replicaCount.web=1` unless real dashboard/editor traffic becomes significant
4. keep `replicaCount.backend=1`
5. keep `autoscaling.backend.enabled=false`
6. keep `workflowStorage.backend=managed` and `runtimeLibraries.backend=managed`
7. keep `RIVET_PUBLISHED_WORKFLOWS_BASE_PATH=/workflows`, `RIVET_PUBLISHED_APPS_BASE_PATH=/apps`, `RIVET_LATEST_WORKFLOWS_BASE_PATH=/workflows-latest`, and `RIVET_LATEST_APPS_BASE_PATH=/apps-latest` unless you intentionally want different first-run route defaults before `settings/public-routes.json` exists
8. set `env.RIVET_PROXY_RESOLVER` for in-cluster nginx DNS resolution
9. provide `RIVET_KEY` through `auth.keySecretName` or Vault, even if server UI auth and public workflow bearer checks are disabled
10. keep the control-plane API on `RIVET_API_PROFILE=control` and the execution Deployment on `RIVET_API_PROFILE=execution`
11. keep control-plane runtime-library reporting at `RIVET_RUNTIME_LIBRARIES_REPLICA_TIER=none`
12. keep execution-plane runtime-library reporting at `RIVET_RUNTIME_LIBRARIES_REPLICA_TIER=endpoint` with `RIVET_RUNTIME_LIBRARIES_JOB_WORKER_ENABLED=false`
13. if Vault is enabled, make sure the injected `/vault/dotenv` carries the required managed Postgres/object-storage env vars before relying on it instead of Kubernetes secret refs
14. do not scale `proxy` and `execution` as if they were a fixed pair; they are separate deployments with separate pressure profiles
15. define concrete CPU and memory requests for at least `resources.proxy` and `resources.execution` before treating the CPU-based HPAs as production-ready
16. keep `lifecycle.terminationGracePeriodSeconds` greater than `lifecycle.shutdownGraceSeconds + lifecycle.preStopDelaySeconds`; chart validation also reserves a final 25-second margin
17. tune `lifecycle.health` from measured managed PostgreSQL/object-storage latency; `/readyz` uses the cached result while `/livez` and legacy `/healthz` remain shallow liveness
18. keep disruption budgets and preferred topology placement enabled for replicated proxy/execution tiers unless cluster capacity or maintenance policy requires an explicit override; the singleton backend intentionally receives no PDB

For managed endpoint latency and cache behavior:

1. run with Settings -> `Storage` set to `Object storage`
2. call the same trivial published or latest endpoint twice
3. expect the first request after startup or after a publish/save/rename/move to be the cold path
4. expect the second request for the same unchanged workflow to drop onto the warm local path
5. if you enabled `RIVET_WORKFLOW_EXECUTION_DEBUG_HEADERS=true`, confirm `x-workflow-cache` moves from `miss` to `hit` and inspect `x-workflow-resolve-ms` / `x-workflow-materialize-ms`

For endpoint measurement with the dedicated script:

1. run the app with either `Local folders` or `Object storage` selected in Settings -> `Storage`
2. optionally set `RIVET_WORKFLOW_EXECUTION_DEBUG_HEADERS=true` so the route emits stage timings; also set `RIVET_CODE_RUNNER_TELEMETRY=true` when diagnosing Code/Expression overhead
3. run `yarn workspace @valerypopoff/rivet-studio-server-api run workflow-execution:measure -- --base-url http://localhost:8080 --endpoint hello-world --kind published --runs 5 --warmups 1`
4. expect one output line per request with HTTP status, client duration, `x-duration-ms`, `x-workflow-resolve-ms`, `x-workflow-materialize-ms`, `x-workflow-execute-ms`, `x-workflow-cache`, and any enabled `x-code-runner-*` headers
5. compare Postman or browser total time against `x-duration-ms`; the difference is network, proxy, TLS, client, and response-transfer overhead
6. compare `x-duration-ms` against `x-workflow-execute-ms` and the Run recordings duration; recordings and `x-workflow-execute-ms` show the measured processor execution window, while `x-duration-ms` includes request handling, endpoint resolution/materialization, processor setup, and response shaping
7. recording persistence is intentionally deferred after the response turn, so recorder serialization, replay-project serialization, compression, and object/file writes should not explain a large `x-duration-ms` gap
8. if debug headers are disabled, expect those per-stage fields to print as `n/a` rather than failing
9. in `managed` mode, use the transition from `x-workflow-cache=miss` to `x-workflow-cache=hit` to verify cold-first-hit then warm-hit behavior
10. in `filesystem` mode, the startup-warmed path should normally report `x-workflow-cache=hit`; after a project-affecting mutation or other tracked filesystem-tree change, expect one rebuild `miss` and then a return to `hit`
11. in `filesystem` mode, `x-workflow-resolve-ms` covers endpoint-index freshness validation plus endpoint lookup, while `x-workflow-materialize-ms` covers materialization-cache validation plus any needed project/dataset reload, one-time project reparsing, and per-request dataset-provider reconstruction
12. in `filesystem` mode, `x-workflow-cache=bypass` means the cache deliberately fell back to uncached filesystem resolution because cached routing/materialization state was uncertain; that slower degraded path is the guardrail against stale cache execution
13. in local Docker on Windows, filesystem mode still reads `/workflows` through a host bind mount, so fixed filesystem overhead can remain materially higher than a direct local-process run even when the endpoint index and materialization path are warm
14. when CodeRunner telemetry is enabled, use `x-code-runner-prepare-ms` to find managed runtime-library sync cost, `x-code-runner-compile-ms` to find repeated function compilation cost, `x-code-runner-execute-ms` for actual user-code time, and cache hit/miss headers to confirm repeated Code/Expression nodes are reusing compiled functions

For the optional local graph fixture, use the local benchmark runner when you need a
repeatable before/after sanity check without importing into a real workspace:

```bash
yarn workspace @valerypopoff/rivet-studio-server-api run workflow-execution:benchmark-fixture -- --runs 50 --warmups 10
```

The runner creates a temporary filesystem workflow root, writes
`.fixtures/graph-fixture.rivet-project`, publishes it as
`graph-fixture-speed`, runs the real published endpoint path, and writes JSON
reports under `artifacts/benchmarks/`. By default it sends no request body,
which lets the fixture's Main Graph `Graph Input` default payload run. Passing
`--body '{}'` intentionally measures the explicit-empty-object request path and
will bypass most of the fixture's Code/Expression-heavy branch. It compares:

- `legacy-compatible`: `RIVET_MANAGED_CODE_RUNNER_DISABLE_CACHE=true` and
  `RIVET_MANAGED_CODE_RUNNER_FORCE_PREPARE_EVERY_CODE=true`
- `optimized`: the default optimized ManagedCodeRunner path

The default no-body fixture run is a representative CodeRunner-heavy endpoint
check for this app. It should execute dozens of CodeRunner calls, including many
Expression and Code New nodes, with no managed `require(...)` and no external
service call. If the report shows only one CodeRunner call, check whether the
command accidentally passed `--body '{}'` or another body that bypasses the
fixture's default test payload.

The fixture is intentionally optional in a clean checkout. The API test suite
skips the fixture safety checks when `.fixtures/graph-fixture.rivet-project` is
absent and runs them automatically when the benchmark fixture is present.

For the current execution-plane split specifically:

1. keep the control plane conservative and scale the execution Deployment instead of the backend StatefulSet
2. keep the proxy Deployment redundant because every published endpoint call still crosses it
3. treat `execution` as the primary endpoint-throughput scale boundary and `proxy` as a separate ingress tier rather than a one-for-one partner
4. confirm `${RIVET_PUBLISHED_WORKFLOWS_BASE_PATH}` and `${RIVET_PUBLISHED_APPS_BASE_PATH}` reach the execution-plane API while `${RIVET_LATEST_WORKFLOWS_BASE_PATH}` and `${RIVET_LATEST_APPS_BASE_PATH}` still reach the control-plane API
5. confirm `/api/*` and `POST /__rivet_auth` still reach the control-plane API
6. confirm `/internal/workflows/:endpointName` is not exposed through nginx and is only reachable inside the cluster
7. confirm runtime-library `Endpoint execution` readiness reflects execution-plane API replicas, not control-plane API replicas

## Validation boundaries

Use the three validation layers intentionally:

- repo-local:
  - proves API correctness, cache/invalidation behavior, config parsing, proxy/image static contracts, hosted-editor seam contracts, and most workflow/runtime-library backend logic
  - this is where `yarn workspace @valerypopoff/rivet-studio-server-api run build`, `yarn workspace @valerypopoff/rivet-studio-server-api run test`, `yarn studio-server:verify:web-pure`, `yarn studio-server:verify:test-style`, and `yarn studio-server:verify:repo-structure` belong
- Kubernetes render:
  - proves Helm chart syntax, local launcher values rendering, chart validation, and rendered control-plane versus execution-plane env/routing contracts
  - this is where `yarn studio-server:verify:kubernetes` and Helm lint/template checks belong
- managed Docker rehearsal:
  - proves managed-state behavior against disposable Postgres plus object storage
  - use this for workflow-storage migration rehearsal, `workflow-storage:verify`, managed endpoint and published web-app measurement, hosted browser flows, and runtime-library install/remove/readiness checks
  - the current Docker stacks still run the API in the `combined` profile, so they do not prove the real control-plane versus execution-plane split by themselves even though the route families are still exposed at their normal published/latest and web-app paths
- live Kubernetes validation:
  - proves the real split topology, ingress/proxy behavior, control-plane versus execution-plane routing, restart boundaries, and execution scaling
  - do not treat chart render success or Docker rehearsal as a substitute for this layer when the question is about real in-cluster behavior

Current follow-up expectations:

- if a change touches migration, cutover, or recording durability, run the managed Docker rehearsal instead of trusting repo-local proof alone
- if a change touches runtime-library readiness UI, prefer adding direct UI coverage and still validate the modal against the managed stack because backend aggregation tests do not fully prove the rendered browser state
- if a change touches the control-plane versus execution-plane boundary, finish with live Kubernetes validation in an isolated namespace

## Compatibility verification commands

Use the current compatibility commands intentionally:

- the repo-local test portions scrub ambient runtime-root, retired storage/database, execution-route, runtime-library, recording, trusted-host, and legacy web-app OAuth env such as `RIVET_WORKFLOWS_ROOT`, `RIVET_ARTIFACTS_HOST_PATH`, old storage/database runtime names, `RIVET_PUBLISHED_WORKFLOWS_BASE_PATH`, `RIVET_PUBLISHED_APPS_BASE_PATH`, `RIVET_LATEST_APPS_BASE_PATH`, `RIVET_WEB_APPS_BASE_PATH`, `RIVET_LATEST_WEB_APPS_BASE_PATH`, `RIVET_CORS_ALLOWED_ORIGINS`, `RIVET_TRUST_INCOMING_FORWARDED_HEADERS`, `RIVET_UI_TOKEN_FREE_HOSTS`, `RIVET_WEB_APPS_AUTH_MODE`, `OAUTH_PROVIDER`, `OAUTH_DUMMY_EMAIL`, `OAUTH_DUMMY_ALLOW_NON_LOCALHOST`, `OAUTH_AUTHORIZE_URL`, `OAUTH_TOKEN_URL`, `OAUTH_USER_URL`, `OAUTH_CLIENT_ID`, `OAUTH_CLIENT_SECRET`, `OAUTH_CALLBACK_URL`, `OAUTH_SCOPES`, `OAUTH_EMAIL_CLAIM`, `OAUTH_SESSION_SECRET`, `OAUTH_SESSION_TTL_SECONDS`, `OAUTH_CLIENT_AUTH_METHOD`, `OAUTH_DEBUG_LOG_PROFILE`, and `RIVET_ENV_FILE` before spawning API tests, so local `.env` or shell state cannot redirect those tests into a real workflow folder, route prefix, auth provider, CORS policy, trusted-host bypass, forwarded-header trust policy, runtime-library role, recording policy, or prove the wrong web-app auth source
- `yarn studio-server:verify:filesystem`
  - runs the repo-local baseline for filesystem compatibility:
    - `packages/studio-server-api` build
    - `packages/studio-server-api` tests
    - filesystem launcher/profile contract assertions
- `yarn studio-server:verify:filesystem:docker`
  - creates a disposable filesystem fixture root and explicit env file
  - verifies the Docker launchers can render `config` for filesystem mode without managed-service activation
- `yarn studio-server:verify:local-docker`
  - creates a disposable managed rehearsal env file
  - verifies `managed + local-docker` activates the `workflow-managed` launcher profile
  - verifies the Docker launchers can render `config` for that rehearsal shape
- `yarn studio-server:verify:local-docker:split`
  - reruns the split-topology repo-local assertions for API profiles, proxy/chart contracts, runtime-library tier ownership, and storage config
  - then verifies the local-Docker launcher contract for the managed rehearsal path

These commands do not replace full browser-level or live-cluster validation:

- use the managed Docker rehearsal for migration/import, hosted editor parity, runtime-library install/remove/readiness checks, endpoint measurement, and published web-app route checks
- use Kubernetes for real split-topology routing, restart, and scaling proof
