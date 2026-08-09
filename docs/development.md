# Development

See also: [Mistakes and Misconceptions](./mistakes-and-misconceptions.md)
See also: [Repo structure](./repo-structure.md)
See also: [Wrapper ManagedCodeRunner Speed Plan](./wrapper-managed-code-runner-speed-plan.md)

## Setup commands

- `npm run setup`
  - ensures `wrapper/api` and `wrapper/web` dependencies exist
  - clones `rivet/` from the configured Rivet 2 repo if it is missing
  - installs upstream Yarn dependencies with `YARN_NODE_LINKER=node-modules` and builds `@valerypopoff/rivet2-core` and `@valerypopoff/rivet2-node` when needed
  - verifies the vendored Rivet workspace dependencies inside `rivet/node_modules`, where Vite resolves upstream source imports; wrapper package installs are not considered a substitute
  - links `wrapper/api/node_modules/@valerypopoff/rivet2-core`, `@valerypopoff/rivet2-node`, and Rivet 2's `@rivet2/*` runtime aliases to generated package overlays under `wrapper/api/node_modules/.rivet-package-links`; those overlays point `dist` at the built packages under `rivet/` and build a generated dependency overlay from installed `rivet/`, API, and web package dependencies
  - removes retired generated API package links from older setup runs before writing the current Rivet 2 package links
  - keeps API runtime and TypeScript resolution on symlink-preserved paths, so setup does not need to create helper dependency links inside the external `rivet/` checkout
  - accepts either a Git checkout, a valid upstream snapshot, or a local symlink/junction already present in `rivet/`
- `npm run setup:k8s-tools`
  - downloads the pinned Helm release into `.data/tools/helm/`
  - use this when you want Kubernetes verification or the local Kubernetes launcher to work without a system Helm install
- `npm run setup:rivet`
  - downloads the configured Rivet 2 source ref into `./rivet`
  - defaults to `https://github.com/valerypopoff/rivet2.0.git` at `main`
  - override the source with `RIVET_REPO_URL` and `RIVET_REPO_REF` when rehearsing a different fork, branch, tag, or exact commit SHA
  - use this when you want a clean upstream snapshot for local Docker builds
  - `npm run setup:rivet -- --force` replaces an existing non-empty `rivet/` directory

## Main commands

| Command | What it does | Typical use |
|---|---|---|
| `npm run clean` | Prunes Docker stopped containers, unused networks, unused images, and BuildKit cache without pruning Docker volumes | Recover VM disk space after repeated pulls/builds or `ENOSPC` failures |
| `npm run dev` | Starts the Docker dev stack and refreshes an already-running dev proxy | Closest-to-production browser testing |
| `npm run dev:recreate` | Rebuilds and recreates the Docker dev stack | Pick up Dockerfile/env/runtime changes |
| `npm run dev:docker:recreate` | Rebuilds and recreates the Docker dev stack without going through the alias | Useful when you want the exact script name that repo instructions refer to |
| `npm run dev:docker:config` | Renders the merged Docker dev Compose config without starting containers | Verify launcher/env/Compose wiring |
| `npm run dev:docker:prepare-rivet-context` | Refreshes the filtered upstream Rivet source and dependency-metadata Docker build contexts | Manual build-context checks without starting Docker |
| `npm run dev:down` | Stops the Docker dev stack | Cleanup |
| `npm run dev:docker:ps` | Shows Docker dev container status | Diagnostics |
| `npm run dev:docker:logs` | Streams Docker dev logs | Diagnostics |
| `npm run dev:kubernetes-test` | Builds local images, deploys the local Kubernetes rehearsal stack, and starts a proxy port-forward | Most authentic local browser rehearsal against managed external services |
| `npm run dev:kubernetes-test:recreate` | Rebuilds images, recreates the local Kubernetes rehearsal namespace/release, and restarts the proxy port-forward | Reset the local Kubernetes rehearsal cleanly |
| `npm run dev:kubernetes-test:config` | Generates the local Kubernetes values file and renders the Helm manifest | Verify local Kubernetes launcher wiring without deploying |
| `npm run dev:kubernetes-test:ps` | Shows local Kubernetes rehearsal pods, deployments, statefulsets, and services | Diagnostics |
| `npm run dev:kubernetes-test:logs` | Streams logs for the local Kubernetes rehearsal release | Diagnostics |
| `npm run dev:kubernetes-test:down` | Stops the proxy port-forward and removes the local Kubernetes rehearsal release/namespace | Cleanup |
| `npm run dev:local` | Starts API, web, and executor as local processes | Process-level debugging |
| `npm run dev:local:api` | Starts only the API locally | API debugging |
| `npm run dev:local:web` | Starts only the Vite web app locally | Frontend work |
| `npm run dev:local:executor` | Starts only the executor locally | Executor debugging |
| `npm run prod` | Pulls the prebuilt Rivet 2 images, force-recreates the production-style Docker stack, and waits for health | Normal VM deployment/update path |
| `npm run prod:prebuilt` | Same prebuilt-image deployment path as `npm run prod` | Explicit published-artifact verification |
| `npm run prod:restart` | Force-recreates the production-style Docker stack from already-local images without pulling or building | Pick up `.env` changes without changing the running image version |
| `npm run prod:custom` | Builds and force-recreates the production-style Docker stack from this repo plus the current `rivet/` folder | Test custom wrapper/Rivet source changes |
| `npm run test` | Runs the root repo-local automated test gate after the standard dependency bootstrap: API build, API tests, pure web tests, test-style guardrails, repo-structure guardrails, and Kubernetes chart/launcher contracts | One-command pre-commit or branch verification |
| `npm run verify:filesystem` | Runs the repo-local compatibility baseline for single-host filesystem mode | Check that filesystem mode still has build/test and launcher-contract coverage |
| `npm run verify:filesystem:docker` | Verifies the filesystem Docker launcher shape with a disposable env/fixture root | Check that Docker launcher config still supports filesystem mode without managed services |
| `npm run verify:local-docker` | Verifies managed-storage local-Docker launcher shape with a disposable env/fixture root | Check that the managed rehearsal still enables local Postgres plus explicit object-storage wiring |
| `npm run verify:local-docker:split` | Runs split-topology repo-local checks plus local-Docker launcher validation | Check that split-era control/execution contracts still fit the local-Docker managed rehearsal model |
| `npm run verify:repo-structure` | Verifies the intended authored repo layout and blocks legacy path drift | Catch misplaced runtime/deployment/tooling files before they spread |
| `npm run verify:test-style` | Verifies test command manifests and test-suite style guardrails | Catch accidental focused tests, missing command entries, broad suite reintroduction, and upstream-source assertions |
| `npm run verify:web-pure` | Runs the pure web helper tests with `tsx --test` | Catch regressions in extracted non-React dashboard/protocol helpers quickly |
| `npm run verify:kubernetes` | Runs Kubernetes launcher/chart contract tests, renders the local rehearsal values path, and lint-renders the production overlay | Catch local/prod chart drift before handing the repo to operators |
| `npm --prefix wrapper/api run workflow-execution:measure -- --base-url http://localhost:8080 --endpoint hello-world --kind published --runs 5 --warmups 1` | Calls one published/latest workflow endpoint repeatedly and prints workflow and optional CodeRunner timing headers | Measure filesystem or managed execution behavior safely |
| `npm --prefix wrapper/api run workflow-execution:benchmark-fixture -- --runs 50 --warmups 10` | Publishes `.fixtures/graph-fixture.rivet-project` into an isolated temp filesystem workflow root and compares legacy-compatible CodeRunner flags with the optimized path, sending no request body so the fixture's Main Graph input default applies | Repeat the local graph-fixture before/after benchmark without touching real workflows |
| `npm run runtime-libraries:managed:audit` | Audits managed runtime-library release/job/object state and writes a JSON snapshot | Inspect live managed runtime-library state safely |
| `npm run runtime-libraries:managed:prune` | Builds a dry-run prune plan for managed runtime-library state | Review cleanup impact before applying it |
| `npm run ui:observe:install` | Installs Playwright Chromium for observable frontend runs | First-time browser setup |
| `npm run ui:observe` | Runs the headed slow-motion Playwright flow against the current hosted app | Watch the browser click through a real scenario |
| `npm run ui:observe:debug` | Runs the same flow with Playwright Inspector enabled | Step through or pause browser actions |
| `npm run ui:observe:report` | Opens the last Playwright HTML report | Review traces, screenshots, and videos after a run |

`npm run clean` is intentionally Docker-volume-safe but Docker-host-wide. It can remove stopped containers and unused images for any project on that Docker host, but it does not pass `--volumes` to Docker prune commands and does not run `docker volume prune` or `docker system prune`. Local Compose volumes that may hold Postgres data, app data, workspace cache, or runtime-library state are preserved. Filesystem workflow and recording host paths are also outside Docker's prune surface. `npm run verify:repo-structure` checks that this cleanup script stays volume-safe. The tradeoff is that unused images and build cache are removed, so stopped stacks may need to pull images again and custom/dev builds may rebuild layers.

## Environment loading

The root launcher scripts load env with `scripts/lib/dev-env.mjs`.

Current behavior:

- they look for `.env` first, then `.env.dev`
- if `.env` exists, `.env.dev` is ignored
- if `RIVET_ENV_FILE` is set, the launchers and compatibility verification scripts use that explicit env file instead of `.env` / `.env.dev`
- missing values get defaults for:
  - `RIVET_WORKSPACE_ROOT`
  - `RIVET_APP_DATA_ROOT`
  - `RIVET_RUNTIME_LIBRARIES_ROOT`
- if `RIVET_ARTIFACTS_HOST_PATH` is present, the launcher resolves it to an absolute host path and derives:
  - `RIVET_WORKFLOWS_HOST_PATH=<artifactsRoot>/workflows`
  - `RIVET_WORKFLOW_RECORDINGS_HOST_PATH=<artifactsRoot>/workflow-recordings`
  - `RIVET_RUNTIME_LIBS_HOST_PATH=<artifactsRoot>/runtime-libraries`
- `RIVET_SOURCE_HOST_PATH` points dev bind mounts at the embedded upstream Rivet source. If it is unset, the launchers resolve `<repo>/rivet` through `fs.realpathSync.native()`, so a Windows junction such as `rivet -> D:\Programming\Rivet2.0` becomes the real host path before Docker sees it.
- `RIVET_SOURCE_BUILD_CONTEXT_PATH` points Docker image builds at a filtered Rivet source snapshot. If it is unset, build-capable launchers recreate `.data/docker-contexts/rivet-source` from `RIVET_SOURCE_HOST_PATH`, copying package source, the upstream `scripts/` directory used by wrapper build targets, and Yarn release metadata while excluding dependency folders, build output, VCS data, and Yarn cache artifacts. The context prep validates the upstream wrapper build scripts and the app, app-executor, core, node, and trivet workspaces before Docker starts.
- `RIVET_DEPENDENCY_BUILD_CONTEXT_PATH` points Docker image builds at the smaller Rivet dependency-metadata snapshot used before `yarn install`. If it is unset, build-capable launchers recreate `.data/docker-contexts/rivet-dependency-metadata` from `RIVET_SOURCE_HOST_PATH`, copying root dependency files, `.upstream-version` when present, Yarn release/patch/plugin metadata, and declared workspace `package.json` files only.
- if `RIVET_WORKFLOWS_HOST_PATH`, `RIVET_WORKFLOW_RECORDINGS_HOST_PATH`, or `RIVET_RUNTIME_LIBS_HOST_PATH` is present, the launcher resolves it to an absolute host path before invoking Docker Compose
- explicit `RIVET_WORKFLOWS_HOST_PATH`, `RIVET_WORKFLOW_RECORDINGS_HOST_PATH`, and `RIVET_RUNTIME_LIBS_HOST_PATH` values override the derived paths from `RIVET_ARTIFACTS_HOST_PATH`

Operational note:

- `.env.example` intentionally lists only launcher/bootstrap/deployment-owned environment knobs. Settings that operators can change from the App Settings modal should stay out of `.env.example` as concrete variables; document their owning Settings tab instead, so new installs do not learn two competing configuration paths.
- `Settings` -> `Storage` is the operator surface for choosing filesystem versus managed storage and for saving managed database/object-storage credentials. It writes `settings/deployment-storage.json` under app data; API and executor processes read that file at startup. If the file is absent, Docker/API runtime uses built-in `Local folders` plus `Local Docker Postgres` defaults. Restart or recreate Docker services, or roll out Kubernetes API/executor pods, after saving storage settings.
- `RIVET_ARTIFACTS_HOST_PATH` remains the launcher bootstrap/default for filesystem-mode host mounts
- `RIVET_WORKFLOWS_HOST_PATH`, `RIVET_WORKFLOW_RECORDINGS_HOST_PATH`, and `RIVET_RUNTIME_LIBS_HOST_PATH` remain compatibility overrides for the launcher
- use the repo launchers (`npm run dev`, `npm run prod`, `npm run dev:docker:*`, or the Docker launcher scripts) for Docker runs; a raw `docker compose --env-file .env ...` invocation only reads the variables already present in the env file and does not derive absolute workflow, recording, or runtime-library host paths from `RIVET_ARTIFACTS_HOST_PATH`. When those per-path host variables are omitted, Compose falls back to isolated `.data/workflows`, `.data/workflow-recordings`, and `.data/runtime-libraries` directories under the repo rather than the external artifact root.
- Docker launchers intentionally drop ambient host `NODE_OPTIONS` unless `.env` defines `NODE_OPTIONS` explicitly. This keeps Yarn 4/PnP host preloads such as `--require F:\...\.pnp.cjs` from being interpolated into Linux container startup commands while leaving non-Docker local runners alone.
- Docker dev mode bind-mounts the live upstream Rivet checkout into the web and API containers. Because the API links `@valerypopoff/rivet2-node` through built `dist` files, API startup runs `scripts/ensure-rivet-runtime-build.mjs` against the mounted Rivet source before linking packages. If upstream `packages/core` or `packages/node` source is newer than the required runtime outputs, it resolves the upstream checkout's declared `.yarnrc.yml` `yarnPath` and runs `yarn build:runtime`; otherwise it logs that the runtime dist is fresh. This prevents fixed upstream source, such as published web-app renderer changes, from being hidden by stale local `dist` files or a wrapper-pinned Yarn release.
- The hosted web package deliberately mirrors browser dependencies that upstream Rivet source imports while Vite compiles the vendored editor. Keep its versions aligned with the upstream workspace requirements; `@gentrace/core` also needs an explicit subpath alias because upstream's browser-safe adapter imports provider modules directly.
- Set `PINECONE_API_KEY` in the launcher env file for Node-executed Pinecone Knowledge Stores, including the `Sync Knowledge Source` node. Docker passes it only to the API and Node executor containers: this covers published endpoint/web-app runs and editor Node-executor runs without exposing the secret to the browser. Do not add it to `RIVET_ENV_ALLOWLIST`; that allowlist is only for browser-visible hosted-env lookups. Pinecone Knowledge Stores are not supported by the Browser executor. Kubernetes deployments using the Vault dotenv integration should add the key to that injected dotenv so both API and executor pods inherit it.
- App Settings -> `General` controls hosted shell execution limits and trusted host bypasses. `Command timeout` is saved in seconds and `Maximum captured output` is saved in MiB for the UI while the API stores bytes internally. `Trusted hosts` writes exact hostnames/IPs to `settings/trusted-hosts.json`; when the proxy sees one of those browser-facing hosts, it bypasses the UI key gate, web-app auth, and workflow endpoint bearer checks. The legacy `RIVET_UI_TOKEN_FREE_HOSTS` env var is ignored/rejected, and the proxy hot-reloads the saved trusted-host include from the shared app-data volume.
- App Settings -> `Workflow endpoints` controls the published/latest workflow route slugs, the default-on `Authorization: Bearer <RIVET_KEY>` requirement for public workflow endpoint calls, and the nginx HTTP request timeout for `/api/*`, `${RIVET_PUBLISHED_WORKFLOWS_BASE_PATH}`, `${RIVET_PUBLISHED_APPS_BASE_PATH}`, `${RIVET_LATEST_WORKFLOWS_BASE_PATH}`, and `${RIVET_LATEST_APPS_BASE_PATH}`. The auth setting is stored at `settings/workflow-endpoint-auth.json`; the timeout is saved in seconds under `settings/runtime-limits.json` and defaults to `180`.
- App Settings -> `Web apps` -> `Button data` controls the largest JSON payload a web-app button may send when running a graph. It is shown in MiB, defaults to `100 MiB`, and is stored as `webAppActionRequestLimitBytes` in `settings/runtime-limits.json`. Saving updates API-side HTTP action parsing immediately and the shared proxy watcher safely reloads nginx so the configured published/latest web-app route families receive the same `client_max_body_size`; the proxy reload can take a few seconds. New web-app pages use a WebSocket action transport whose `maxPayload` is captured when the API process starts, so gracefully restart/recreate the API after active actions complete to apply a changed limit to new sockets. The limit is bounded from `1 MiB` to `1 GiB`; choose a value that fits the API container's memory because JSON bodies are buffered before the action runs. A separate host nginx, ingress, CDN, or load balancer must be configured with an equal or larger request-body limit itself.
- App Settings -> `Docker` controls how long the npm Docker launchers wait for Compose services to become healthy. The saved value is in seconds and defaults to `1200` when the settings file or a running container is unavailable. Kubernetes does not use this setting.
- Storage/database `.env` values are ignored by the Docker API/executor runtime. Use the Storage tab for workflow/runtime-library storage and database settings; in object-storage mode `RIVET_RUNTIME_LIBRARIES_ROOT` remains only a local cache/workspace
- optional managed runtime-library readiness tuning uses:
  - `RIVET_RUNTIME_LIBRARIES_SYNC_POLL_INTERVAL_MS`
  - `RIVET_RUNTIME_LIBRARIES_REPLICA_STATUS_RETENTION_MS`
  - `RIVET_RUNTIME_LIBRARIES_REPLICA_STATUS_CLEANUP_INTERVAL_MS`
- split-topology launches can also override:
  - `RIVET_API_PROFILE=combined|control|execution`
  - `RIVET_RUNTIME_LIBRARIES_REPLICA_TIER=endpoint|editor|none`
  - `RIVET_RUNTIME_LIBRARIES_JOB_WORKER_ENABLED=true|false`

## Compatibility matrix

The non-cluster compatibility modes that should keep working are:

| Storage/runtime shape | Support status | What it is for | What must be true |
|---|---|---|---|
| `filesystem + combined` | Supported | Primary backward-compatible single-host operation | Local workflow tree and runtime-library root remain authoritative |
| `filesystem + control` | Supported | Secondary control-plane-only debugging and admin validation | Control-plane/admin/latest routes still boot without managed services |
| `filesystem + execution` | Unsupported by design | None | `RIVET_API_PROFILE=execution` must fail fast unless storage mode is `managed` |
| `managed + local-docker + combined` | Supported | Existing Postgres plus explicit object-storage rehearsal path through Docker dev or production-style Docker | Start the `workflow-managed` Compose profile and enter the MinIO URL/keys in Settings before restarting into object-storage mode |
| `managed + local-docker + control/execution` | Supported through repo-local split validation and local dependency rehearsal | Split-era compatibility checks without Kubernetes | Split route/profile contracts must stay valid while storage still uses local Docker Postgres plus explicitly configured object storage |

Compatibility rules:

- `filesystem` compatibility is single-host only
- `local-docker` means the Storage tab uses the optional local Docker Postgres metadata database; object storage is still configured separately
- Docker combined-mode rehearsal is necessary but not sufficient to prove the real split runtime shape
- the repo-local split verification command proves the control-plane versus execution-plane contract; live Kubernetes validation is still required for real in-cluster routing and scaling behavior

## Local Kubernetes launcher

The repo now includes a local Kubernetes rehearsal launcher:

- `npm run dev:kubernetes-test`
- `npm run dev:kubernetes-test:recreate`
- `npm run dev:kubernetes-test:down`
- `npm run dev:kubernetes-test:config`
- `npm run dev:kubernetes-test:ps`
- `npm run dev:kubernetes-test:logs`
- `npm run verify:kubernetes`

Current behavior:

- it builds local `proxy`, `web`, `api`, and `executor` images from the current workspace
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
- if no explicit, system, or cached Helm is available, the launcher fails with an instruction to run `npm run setup:k8s-tools`
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

For the operator-facing chart contract and handoff checklist, see:

- [Kubernetes](./kubernetes.md)

## Observable Playwright flow

The repo now includes a headed Playwright workflow for frontend debugging and demos where you want to watch the browser actions live.

Current behavior:

- `npm run ui:observe` launches Chromium in headed mode with `slowMo`, trace capture, video capture, and HTML reporting enabled
- the runner loads the same `.env` / `.env.dev` file as the Docker scripts, so UI-gated hosts automatically reuse `RIVET_KEY`
- unless `PLAYWRIGHT_BASE_URL` is already set, the runner targets `http://127.0.0.1:${RIVET_PORT}` from your env file, defaulting to `8080`
- the main hosted-editor observable spec uses mocked workflow/project API responses to open a two-node project, then visibly exercises the hosted editor focus, copy, cut, and paste path without mutating workflow storage
- trace, video, screenshots, and the HTML report are written under `artifacts/playwright/`

Managed-state safety:

- most browser-visible specs should stay non-mutating and prefer mocked API responses when the behavior under test is modal/controller/UI wiring rather than storage persistence
- hosted-editor shortcut/focus coverage should also prefer mocked workflow/project routes when the behavior only needs an open project shape, not durable workflow storage
- mutating workflow specs are blocked against Storage-tab `Object storage` mode unless `PLAYWRIGHT_ALLOW_MANAGED_MUTATIONS=1` is set explicitly
- specs that assert managed virtual workflow paths should call the managed-mode guard and skip under filesystem stacks; filesystem runs should not be expected to produce `/managed/workflows/...` save paths
- shared Playwright workflow helpers use Playwright's request context for setup and cleanup, not `page.evaluate(fetch(...))`, so they go through the same proxy-auth path as the real browser shell
- if a mutating spec creates real workflow state in managed mode, it is responsible for explicit cleanup before the run finishes

Typical usage:

1. start the app you want to watch, for example `npm run dev` or `npm run prod:custom`
2. if this is the first Playwright run on the machine, run `npm run ui:observe:install`
3. run `npm run ui:observe`
4. if you want the Playwright Inspector alongside the browser, run `npm run ui:observe:debug`
5. after the run, open `npm run ui:observe:report`

Windows PowerShell override example:

1. `$env:PLAYWRIGHT_BASE_URL='http://127.0.0.1:8086'`
2. `$env:PLAYWRIGHT_SLOW_MO='500'`
3. `npm run ui:observe`

## Local direct-process mode

`npm run dev:local` starts:

- API on `http://localhost:3100`
- Vite web app on `http://localhost:5174`
- executor websocket service on port `21889`

Important constraints:

- host Node must be `24+` for local API execution because the API now uses Node's built-in `node:sqlite`
- this mode does not recreate the nginx trusted-proxy layer
- the Vite dev server only proxies `/api/*` to the API and `/ws/executor*` to the executor
- Vite does not proxy the published/latest workflow route families, Rivet web app route families, `/ui-auth`, or `/ws/latest-debugger`, and it does not inject the trusted proxy headers that those control-plane routes expect
- use it for service-level debugging, direct API/executor work, or frontend iteration that does not rely on fully wired hosted-shell control-plane routing
- Docker dev remains the best path for testing the full hosted browser flow exactly as deployed

## Docker launcher behavior

The Docker launchers now render layered Compose files:

- the API uses its own `PORT` contract
- the executor websocket service is pinned separately to `21889`
- do not treat `PORT` in `.env` as a shared port for every container; the executor must stay on `21889` unless the nginx upstreams change with it
- the executor service sets `RIVET_EXECUTOR_HOST=0.0.0.0` in Docker so the proxy container can connect to it over the compose network; do not change that back to `127.0.0.1` unless the proxy and executor are collapsed into the same process/network namespace

- `npm run dev` / `npm run dev:docker:*` use `ops/compose/docker-compose.managed-services.yml` plus `ops/compose/docker-compose.dev.yml`
- `npm run prod`, `npm run prod:prebuilt`, `npm run prod:restart`, and `npm run prod:custom` use `ops/compose/docker-compose.managed-services.yml` plus `ops/compose/docker-compose.yml`
- the shared file only contributes the optional managed Postgres/MinIO services; enable them explicitly with `COMPOSE_PROFILES=workflow-managed` when rehearsing object-storage mode locally

Current behavior:

- the browser entrypoint is still `http://localhost:8080` through nginx by default; override it with `RIVET_PORT` if needed
- `npm run prod` and `npm run prod:prebuilt` pull prebuilt images under `ghcr.io/valerypopoff/cloud-hosted-rivet2-wrapper/{proxy,web,api,executor}:${RIVET_IMAGE_TAG:-latest}`, then force-recreate the stack with `--no-build`; set `RIVET_PROXY_IMAGE`, `RIVET_WEB_IMAGE`, `RIVET_API_IMAGE`, or `RIVET_EXECUTOR_IMAGE` to pin any service to a different image. Keep the image examples in `.env.example` on that same namespace so VM overrides do not accidentally pull the legacy wrapper images.
- `npm run prod:restart` skips the pull/build step and force-recreates the stack from the images already present locally. Use it after changing `.env` when you want containers to pick up new env values without updating to newer GHCR images.
- Project Settings reads route prefixes from the runtime `/api/config` response, not just from the prebuilt web bundle. Workflow and web-app route prefixes are operator settings now: App Settings -> `Workflow endpoints` -> `Routes` edits the published/latest workflow route slugs, and App Settings -> `Web apps` -> `Routes` edits the published/latest web-app route slugs. Both tabs write `settings/public-routes.json`; the API reads that file dynamically, and the proxy watches it, regenerates its public-route include, validates it with `nginx -t`, and reloads nginx. The generated public-route fragment contains `location` blocks, so it is written as a server-block include at `/tmp/nginx/rivet-public-routes.inc`, not as a top-level `conf.d/*.conf` file. The App Settings -> `Workflow endpoints` HTTP timeout writes a separate `/tmp/nginx/rivet-proxy-timeout.inc` snippet used by both `/api/*` and generated public-route locations, so timeout changes also apply after the same safe nginx reload. The settings modal waits for `/api/config` to report the new paths before showing `Saved.`, so route slug changes do not require a manual Docker/Compose/Kubernetes stack restart. The route env names are first-run defaults when no saved route settings file exists.
- Server UI access starts from deployment env, then uses saved settings for OAuth details. Bootstrap with `RIVET_SERVER_UI_AUTH_MODE=none` or `key`, open `Settings` -> `OAuth` to save the shared OAuth provider settings, open `Settings` -> `Server UI access` to save `Server UI admin emails`, then switch `.env` / Kubernetes env to `RIVET_SERVER_UI_AUTH_MODE=oauth`. The legacy `RIVET_REQUIRE_UI_GATE_KEY=true` maps to key mode only when `RIVET_SERVER_UI_AUTH_MODE` is unset. After changing the server UI auth mode env, use `npm run prod:restart` or recreate/roll out the stack so the API re-reads the mode; changing saved OAuth provider/admin settings is read from app data and invalidates old sessions without needing retired `RIVET_SERVER_UI_OAUTH_*` env values.
- App Settings -> `Run recordings` writes recording history limits to the shared app-data volume at `settings/run-recordings.json`. `Queued recording writes` controls how many background recording-save jobs can wait in memory before new recordings are skipped. `Runs kept per workflow endpoint` lets operators choose between keeping every run for each endpoint or keeping only the newest N runs. `Days to keep recordings` lets operators choose between keeping recordings forever or deleting them after N days. The legacy `RIVET_RECORDINGS_MAX_PENDING_WRITES`, `RIVET_RECORDINGS_MAX_RUNS_PER_ENDPOINT`, and `RIVET_RECORDINGS_RETENTION_DAYS` env vars are ignored so operators do not have two competing sources for the same policy. App Settings tabs should use the shared field-grid pattern; it applies the standard row gap so labels, controls, and helper text do not visually merge. Save/Revert actions use the same large button tier as Project Settings publish actions and sit in a separated action row.
- App Settings -> `Web apps` -> `Auth` writes only the web-app auth mode, App Settings -> `OAuth` writes the shared provider/session settings, and App Settings -> `Server UI access` writes server UI admin emails. They are persisted in the shared app-data volume at `settings/web-app-auth.json`. `Key` asks app visitors for the Rivet key, `OAuth` uses the configured provider plus each app's allowed-email list, and `No gate` leaves app routes open at the API layer. Legacy `RIVET_WEB_APPS_AUTH_MODE`, `OAUTH_*`, and retired `RIVET_SERVER_UI_OAUTH_*` env vars are ignored so a local shell or `.env` cannot silently override the UI setting. Because this file can contain OAuth client and session secrets, settings saves write it with owner-only permissions on filesystems that support POSIX modes. OAuth state and session cookies are bound to the saved auth settings version; after an operator changes provider, mode, client credentials, scope, email claim, admin emails, or session policy settings, in-flight sign-ins fail closed and existing server UI/web-app visitors may need to sign in again.
- App Settings -> `Workflow endpoints` -> `Access control` writes workflow endpoint bearer-token policy to `settings/workflow-endpoint-auth.json`. It defaults to requiring `Authorization: Bearer <RIVET_KEY>`, and the legacy `RIVET_REQUIRE_WORKFLOW_KEY` env var is ignored so workflow endpoint auth has one operator-owned source of truth.
- App Settings -> `Workflow endpoints` -> `Routes` and App Settings -> `Web apps` -> `Routes` write non-secret route slugs to `settings/public-routes.json`. The legacy `settings/web-app-routes.json` file remains a read-only fallback for older deployments until the new public-route file is saved. Slugs are single URL path segments such as `workflows`, `workflows-latest`, `apps`, and `apps-latest`; all four route families must be unique and cannot collide with reserved top-level routes like `api`, `ws`, `internal`, `ui-auth`, `assets`, `node_modules`, or `__rivet_auth`.
- App Settings -> `Storage` writes workflow/runtime-library storage choices to the shared app-data volume at `settings/deployment-storage.json`. The tab keeps project artifact storage and metadata database settings as separate sections. `Local folders` keeps filesystem-mode projects, recordings, published snapshots, and runtime libraries on the mounted host paths. The host artifacts folder shown in this mode is read-only informational because Docker/Compose/Kubernetes bind mounts are chosen before the app starts; set `RIVET_ARTIFACTS_HOST_PATH` or the explicit host mount paths in the launcher environment when that host root must change. `Object storage` moves those artifacts to S3-compatible storage, while the database section controls whether managed metadata uses the optional local Docker Postgres service or an external managed PostgreSQL cluster. `Local Docker Postgres` does not edit or fill object-storage fields; if you want to use the optional local MinIO service, enter its object-storage URL and credentials in the project artifact storage section. Use `Managed Postgres` plus object-storage credentials for production-style managed storage. The settings API hides the managed PostgreSQL connection string and object-storage secret access key from the browser, preserving them when the corresponding password fields are left blank. Storage/database `.env` values are ignored by the Docker API/executor runtime; after changing saved storage settings, use `npm run prod:restart` for a production-style Docker stack when you want the current images to reread the settings file without pulling newer images.
- Web-app action graph context strips browser/session headers such as `cookie`, `authorization`, proxy auth, and trusted-host hints. Keep public web-app actions on that narrower context contract; workflow endpoint routes may still expose request headers because they are API-style execution surfaces with their own bearer/trusted-host contract.
- Web-app actions carry a browser-owned `storage` snapshot for Rivet Stored Value nodes. Both the HTTP compatibility route and the WebSocket gateway must return the per-run `storagePatch`; do not persist or reuse that snapshot server-side unless a deliberate trusted host store is introduced.
- App Settings -> `Node executor proxy` writes runtime `HTTP_PROXY`, `HTTPS_PROXY`, and `NO_PROXY` values to the shared app-data volume at `settings/node-executor-proxy.json`. The proxy bootstrap clears any `.env`/process proxy variables first, reads only that app-settings file, installs the Undici proxy dispatcher from the saved values, and polls the file while running. In API processes it reads from `RIVET_APP_DATA_ROOT` for headless endpoint execution, and saving through the settings API immediately reloads the dispatcher in that same API process. In the internal editor executor it falls back to the Rivet desktop app-data path under `HOME` and picks up changes through the poller. If the file is missing or cleared, runtime Node execution runs without a proxy. The saved proxy file is also written owner-only where supported because proxy URLs may include credentials. The same tab also writes optional hosted Node executor and default Remote Debugger websocket URL overrides to `settings/executor-url-overrides.json`; blank fields keep the request-host-derived `/ws/executor/internal` and `/ws/latest-debugger` defaults, and the old `RIVET_EXECUTOR_WS_URL` / `RIVET_REMOTE_DEBUGGER_DEFAULT_WS` env variables are ignored. If an HTTPS deployment's TLS terminator does not pass a trusted `X-Forwarded-Proto: https` through nginx to `/api/config`, the hosted browser still upgrades same-host `ws://` runtime config values to `wss://` before opening executor/debugger sockets so mixed-content blocking does not break the default routes. The same upgrade is applied to stored hosted Remote Debugger defaults and opened-project executor metadata, so users do not need to clear browser storage after this proxy/protocol mismatch has happened once.
- App Settings saves use unique temporary files followed by rename for `settings/node-executor-proxy.json`, `settings/executor-url-overrides.json`, `settings/run-recordings.json`, `settings/runtime-limits.json`, `settings/trusted-hosts.json`, `settings/deployment-storage.json`, `settings/workflow-endpoint-auth.json`, and `settings/web-app-auth.json`, so overlapping saves do not share the same temporary path.
- Missing App Settings files mean first-run defaults. Malformed or invalid saved settings files should fail loudly instead of silently falling back to `.env` or defaults, because a present app-settings file is operator intent. Web-app auth is the deliberate exception: if `settings/web-app-auth.json` cannot be read, public app routes fail closed until the operator fixes or removes the file.
- `Web apps`, `OAuth`, and `Server UI access` edit the same web-app-auth record. The modal loads that record once per opening and keeps the shared draft while those tabs are switched, so changing tabs cannot overwrite unsaved OAuth or admin-email edits with a second fetch.
- For local web-app OAuth testing without a real provider, open App Settings -> `Web apps` -> `Auth` and choose `OAuth`, then open App Settings -> `OAuth`, choose `Local dummy`, provide a session signing secret, and optionally set the default dummy email. The Sign in flow then opens `/apps/auth/dummy` unless the active published-app route prefix has changed, accepts a test email, and returns through the same callback/session-cookie path as real OAuth. Dummy OAuth is localhost-only by default; do not use it for shared or production deployments. OAuth web-app allowlists are fail-closed, so add the dummy email to the app's allowed-email list before testing access.
- `npm run prod:custom` rebuilds the stack from the current wrapper repo and the current `rivet/` source folder, using the filtered `rivet_source` and `rivet_dependency_metadata` Docker build contexts
- dev Docker exposes the API directly on `http://localhost:3100` for diagnostics, but it binds that port to `127.0.0.1` by default through `RIVET_LOCAL_BIND_HOST`; keep it private/firewalled on shared or public machines because the hosted auth model expects browser traffic to enter through nginx
- local-docker managed Postgres and MinIO diagnostic ports also bind to `127.0.0.1` by default. Set `RIVET_LOCAL_BIND_HOST=0.0.0.0` only on a trusted/firewalled network.
- credentialed CORS is same-origin by default. Set `RIVET_CORS_ALLOWED_ORIGINS` only when a known external browser origin must call the API or workflow routes directly.
- `npm run dev` / `npm run dev:docker` force-recreate only the already-running dev `proxy` service after the stack is up, so nginx re-reads mounted route templates without forcing a full API/web/executor recreate. The launcher also recreates a running dev `web` or `api` service when its named-volume dependency marker no longer matches the mounted lockfile; this refreshes web, API, and Rivet dependencies after a package change instead of leaving hot reload to run against stale `node_modules`. Saved public-route changes normally apply through the proxy watcher without rerunning the launcher. If a new proxied route such as `${RIVET_LATEST_APPS_BASE_PATH:-/apps-latest}` falls through to the wrapper UI, check the proxy logs for a failed nginx reload before using `npm run dev:recreate` for a full reset.
- The proxy preserves the request port for browser-facing URLs by deriving `X-Forwarded-Host` from the request `Host` header. This matters for local OAuth and dummy OAuth on `http://localhost:8081`; if generated links start pointing at `http://localhost/...`, check the forwarded-host maps before changing API URL generation. Incoming `X-Forwarded-Host` / `X-Forwarded-Proto` headers are ignored unless `RIVET_TRUST_INCOMING_FORWARDED_HEADERS=true`, which should only be used behind a trusted ingress that overwrites client-supplied forwarded headers.
- proxy startup scripts are Linux shell scripts; dev Compose mounts them from the repo, while production images bake them into the proxy image. The repo pins `*.sh` files to LF line endings so Windows checkouts do not inject CRLF characters into `/bin/sh`
- The proxy does not serve a static UI-gate prompt. It protects dashboard/editor, API, and editor websocket routes with nginx `auth_request`, then proxies denied browser requests to the API-rendered `/ui-auth/prompt`. The prompt posts or redirects with a sanitized local `return_to` path so successful key or OAuth sign-in returns to the requested dashboard/editor or published web-app URL instead of always landing on `/`. Dev and production nginx templates proxy URI-suffixed auth/websocket targets through `set` upstream variables; keep that pattern for named locations such as `@web_with_ui_gate_prompt`, because nginx rejects `proxy_pass http://host/path` directly inside named locations.
- standard proxied HTTP routes default to a `180s` upstream timeout through App Settings -> `Workflow endpoints`; websocket routes stay long-lived separately
- the local Docker stacks keep `RIVET_API_PROFILE=combined` by default, so `/api/*`, `${RIVET_LATEST_WORKFLOWS_BASE_PATH}`, `${RIVET_LATEST_APPS_BASE_PATH}`, `${RIVET_PUBLISHED_APPS_BASE_PATH}`, and `${RIVET_PUBLISHED_WORKFLOWS_BASE_PATH}` all land on the same `api` container there
- the `web` service runs the Vite dev server inside the container with live bind mounts
- the dev stack keeps `rivet/node_modules`, `rivet/.yarn/unplugged`, and `wrapper/web/node_modules` in Docker named volumes. The Rivet dependency install writes freshness markers into both Rivet volumes, so pruning one volume but not the other forces the next dev launch to reinstall. Do not use the host upstream checkout's `.yarn/unplugged` artifacts from Linux containers; they can contain Windows-native binaries and should stay isolated from Docker dev installs.
- Docker dev rebuilds the `api` and `executor` services from Dockerfiles while running `web` through Vite; `npm run prod:custom` rebuilds `proxy`, `web`, `api`, and `executor`
- the launchers compute host bind mounts before calling Compose. With `RIVET_ARTIFACTS_HOST_PATH=../` from the repo root, both dev and production-style Docker mount `<repo>/../workflows` at `/workflows`, `<repo>/../workflow-recordings` at `/workflow-recordings`, and `<repo>/../runtime-libraries` at `/data/runtime-libraries`. If you bypass the launcher and run Compose directly, set those three `RIVET_*_HOST_PATH` values explicitly; otherwise Compose uses isolated repo-local `.data/*` directories and will not show the external workflow tree.
- the production web image installs wrapper web dependencies from `wrapper/web/package.json` and `wrapper/web/package-lock.json` before copying web/shared source, then uses the root `package.json` as build metadata for the About modal version. Keep `wrapper/web/package.json` free of `file:../..` root dependencies so GitHub Actions can build the web image from the same minimal context.
- the API image uses upstream Rivet's wrapper-facing `yarn build:runtime` script to build `core + node`, then links `wrapper/api` to those built package directories before compiling the API; this keeps hosted endpoint execution on the same Rivet source tree as the editor and executor
- the web image uses upstream Rivet's `yarn build:hosted-web-deps` script to build `core + trivet` without the Dockerfile knowing Rivet's internal workspace build order
- the executor image uses `yarn build:runtime` for `core + node`, then keeps the wrapper's Docker-specific bundle-only app-executor step. Do not replace that with upstream `yarn build:executor-runtime` unless the image needs native app-executor sidecar binaries and the build runs on the same target platform; the current container runs `bin/executor-bundle.cjs` directly and deliberately skips the slower native `pkg` sidecar build. The wrapper bundler emits CommonJS, so it defines `import.meta.url` as `__filename`; this keeps upstream node modules that create an asset resolver with `createRequire(import.meta.url)` from crashing when they are imported by the app-executor bundle.
- the Docker dev API waits for the web service to populate the shared `rivet_node_modules` volume, then copies only `rivet/packages/core` and `rivet/packages/node` into container-local `/tmp/rivet-source`, attaches `/workspace/rivet/node_modules` beside that copy, and points the generated `@valerypopoff/rivet2-core`, `@valerypopoff/rivet2-node`, and `@rivet2/*` package overlays at the internal copy. Keeping this staging copy outside the `/app` bind mount avoids Windows host-volume link/copy failures while preserving Node package resolution inside the container, avoiding a duplicate upstream dependency install, and avoiding API helper links in the external Rivet checkout.
- local and image API entrypoints run with symlink preservation (`preserveSymlinks` for TypeScript and `--preserve-symlinks` for Node/tsx), while `scripts/link-rivet-node-package.mjs` creates generated package overlays that expose the built Rivet package `dist` folders and build a package-local `node_modules` overlay from the available installed dependency roots: `rivet/node_modules`, `wrapper/api/node_modules`, and `wrapper/web/node_modules`. This keeps aggregate API tests from depending on one mutable upstream install layout while still resolving hosted Rivet runtime dependencies without writing helper links inside the external `rivet/` checkout.
- the Docker dev API mounts the repo scripts directory at `/scripts`, matching the `../../scripts/...` path seen from `/app`, so the same `wrapper/api` package scripts run locally and inside Compose
- Docker image builds receive upstream Rivet through the named `rivet_source` and `rivet_dependency_metadata` build contexts instead of `COPY rivet/` from the main repo context; local launchers feed those contexts from `.data/docker-contexts/rivet-source` and `.data/docker-contexts/rivet-dependency-metadata` so linked Rivet checkouts do not send `node_modules`, `.git`, or Yarn cache artifacts to BuildKit
- `npm run dev:docker:prepare-rivet-context` refreshes those filtered contexts without starting Docker, which is useful before manual `docker build --build-context rivet_source=.data/docker-contexts/rivet-source --build-context rivet_dependency_metadata=.data/docker-contexts/rivet-dependency-metadata ...` checks
- the Docker Compose stacks set `HOME=/home/rivet` and keep npm/Yarn caches there so pulled non-root images and locally built images use the same runtime cache contract
- the launcher waits for healthy services; App Settings -> `Docker` -> `Startup wait timeout` controls the overall wait window when a previous API/proxy container can provide the saved settings file, otherwise the first-run launcher default is `1200s`. Docker API healthchecks have a longer startup grace period because cold starts may need to reconcile runtime libraries, initialize workflow storage, refresh npm dependencies, copy Rivet package sources, or relink local package overlays before `/healthz` is available
- on Windows/Docker Desktop, if Compose fails before containers start with `error while creating mount source path '/run/desktop/mnt/host/<drive>/...'` and `file exists`, first verify the host folder exists, then run `wsl --shutdown` from PowerShell to reset Docker Desktop's WSL file-sharing bridge before retrying `npm run dev:docker`
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
- this keeps high-churn recording writes off the workflow-source bind mount on Windows/Docker Desktop
- the official API and executor images run as uid/gid `10001:10001`, so bind-mounted host paths must grant that uid the expected read/write access
- if `/workflows` is not writable, hosted editor saves fail and the API now returns an explicit workflow-storage permission error instead of a generic hidden 500
- if `/data/runtime-libraries` is not writable, `/api/runtime-libraries` now returns an explicit runtime-library storage permission error instead of a generic hidden 500

Migration note for existing local Docker setups:

1. stop the stack
2. move `D:\Programming\workflows\.recordings` to `D:\Programming\workflow-recordings`
3. keep `RIVET_ARTIFACTS_HOST_PATH=../` so the launcher derives `D:\Programming\workflow-recordings` automatically
4. recreate the stack

For host-based API execution, filesystem-mode recording persistence still requires `node:sqlite` (Node 24+). If your host Node version is older, use the Docker dev stack instead of `npm run dev:local`.

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

Recording persistence is intentionally backgrounded after an HTTP or WebSocket action result is ready. On `SIGTERM`/`SIGINT`, the API first stops accepting requests and interrupts active web-app actions, then drains queued recorder persistence and cleanup before disposing managed Postgres connections. This lets terminal WebSocket hooks enqueue their final recorders during a rollout without losing them merely because the process exits immediately afterward. A hard kill, host failure, or exhausted recording queue can still prevent a recording from being stored; workflow execution results remain independent and queue drops/errors are logged under `[workflow-recordings]`.

Managed Postgres/S3 deployments apply the same `Run recordings` age and per-endpoint limits as filesystem deployments. The per-endpoint limit groups by workflow id plus historical endpoint name, so a slug reused by another project gets an independent history allowance. Startup performs a global retention pass; normal writes query the current workflow/endpoint plus age-expired rows, while `RIVET_RECORDINGS_MAX_TOTAL_BYTES` requires a global metadata scan. Postgres rows are deleted first, and only rows actually returned by that deletion schedule object-storage cleanup, which keeps concurrent replicas from deleting blobs retained by another replica. Managed byte counts use UTF-8 bytes rather than JavaScript character counts.

For slow `GET /api/workflows/recordings/workflows` diagnosis in Docker, compare:

- completed bundle files under `/workflow-recordings`:
  `find /workflow-recordings -mindepth 3 -maxdepth 3 -name metadata.json -type f | wc -l`
- indexed run rows in `/data/rivet-app/recordings.sqlite`:
  `node -e "const {DatabaseSync}=require('node:sqlite'); const db=new DatabaseSync('/data/rivet-app/recordings.sqlite'); console.log(db.prepare('select count(*) n from recording_runs').get())"`

The `Run recordings` modal can also filter a workflow's runs by recorded request input. It includes both workflow endpoint runs and Rivet web-app button action graph runs. The workflow dropdown shows each workflow's saved recording count as a neutral badge so developers can pick busy histories quickly without implying publish status. Use the `Input JSON path` control with a path such as `$.foo`, an operator such as `==`, and a value such as `bar`. The API evaluates `$` against the root graph input value stored in the recording's `inputs.input.value` event. For workflow endpoint runs, that value is the HTTP request body. For web-app action runs with an `input` graph port, that value is the UI state mapped to that port; if the action target graph uses other input port names instead, `$` falls back to an object of all captured graph input values keyed by port name. Each run row shows the stored `endpointNameAtExecution` value, which is historical metadata from the time the route ran rather than the workflow's current endpoint name. Workflow endpoint runs store the endpoint slug; web-app action runs store the app route path, such as `/apps/my-tool` or `/apps-latest/my-tool`. For `contains`, when the filter value parses as a string, the resolved left operand is treated as full text too; strings are searched as-is, and objects/arrays are searched recursively across object keys and primitive values without JSON escaping, so `$ contains 'request_id'` searches the whole recorded input object and `$.foo contains 'foobar'` can match text nested inside an object at `foo`. Missing paths match `not_exists`, do not match `exists`, and resolve to actual `undefined` for the other operators; the filter value literal `undefined` also parses as `undefined`. Ordering comparisons with `undefined` do not match. This filter reads existing recording artifacts after workflow/status narrowing, newest first. For input-filtered requests a response can be non-exhaustive, including a scan window with no matches: `totalRunsExact: false`, `hasMore: true`, and `nextInputCursor` mean the dashboard can show the newest matches immediately, continue with the next cursor automatically, and append newly found runs to the visible list. The dashboard shows searching/completed/stopped status and exposes `Stop search`. Opening a recording hides the modal without resetting it, and the left panel shows a compact `Found: N` badge on the `Run recordings` row until the user explicitly clicks the modal close button. The explicit close path, filter clear/hide path, and stop button abort in-flight recordings requests; simple hide-for-replay keeps the current modal state available for reopening.

The separate `Run statistics` modal uses the SQLite/Postgres index only, so large replay bundles do not delay timing analysis. It defaults to successful published runs for the preceding seven days and can switch endpoint/web-app action targets with the left-aligned header control, set a 24-hour/7-day/30-day/90-day/custom period, and choose Published, Latest, or Both. A full-width target dropdown sits before the period and version filters and becomes searchable for longer endpoint or web-app action lists; there is no separate target sidebar. It shows the all-run `Run outcomes` counts and percentages first; those outcome rates are independent of duration analysis. A full-width divider and dedicated top spacing separate the following `Statistics` section, which defaults to successful runs and offers explicit include-failed/include-warning controls for median, P95, average, fastest, slowest, and the duration chart. Metric cards are compact two-line value summaries for the selected period; the query and response intentionally contain no previous-period comparison payload, because period-wide change is inspected through the duration chart and a wider selected period. This avoids reading an unused second time window from the recording index. Chart series deliberately use blue for Median and violet for P95, reserving green/yellow/red for run outcomes. The modal uses the same dark overlay, surface, margins, header spacing, and body spacing contract as `Run recordings`. Duration means processor execution time, not HTTP transport, queueing, or background recording persistence. New rows retain the executed endpoint graph or web-app UI graph/component identity so renames do not merge action histories. Older path-only web-app rows, and malformed historical web-app rows without both stable UI graph and component IDs, are listed under `Legacy action`; historical rows without a leading-slash route remain endpoint runs. Target keys are opaque shared values, never delimiter-joined IDs. The API routes are `GET /api/workflows/run-statistics/targets` and `POST /api/workflows/run-statistics/query`; both are metadata-only reads.

The statistics UI keys catalog and timing responses to the active surface, target, period, version, and outcome controls. A slower or aborted earlier request must never render stale metrics, outcomes, or an old error under newer filters.

The target selector is a portaled modal control. Its menu must use the shared modal-menu stacking level so mouse activation remains visible above the modal surface as well as keyboard selection.

Recording playback state is project-scoped in upstream Rivet. The hosted editor bridge must attach a loaded recorder to the exact replay project id returned by the workspace open operation; writing the older `{ recorder, path }` shape loads the project but intentionally leaves `Play Recording` hidden. Switching to another project must not globally clear that owner-scoped state, and closing a replay tab prunes its cached recorder payload. Replay datasets are optional. A `404` from the replay-dataset artifact endpoint means that run has no captured dataset snapshot, and `HostedIOProvider` must continue opening the replay project with an empty dataset rather than treating that response as a project-load failure.

Keep wrapper-side recording cleanup on the stable upstream `loadedRecordingState` export and perform the project ownership comparison in the wrapper. Do not import newer convenience atoms such as `clearLoadedRecordingForProjectState` until they are part of the Rivet revision consumed by image builds; local `rivet/` development checkouts can be ahead of the exact upstream commit resolved by GitHub Actions.

## Source of truth

- authored source lives under `wrapper/`, `image/`, `ops/`, `charts/`, `scripts/`, `docs/`, and `.github/`
- runtime/bootstrap code belongs under `wrapper/bootstrap/`, not under `ops/`
- hosted editor patches that must survive production image builds should live under `wrapper/web/overrides/`, `wrapper/web/dashboard/`, or other tracked wrapper files
- the hosted web image builds upstream `rivet/packages/app` through `wrapper/web/vite.config.ts`, not through upstream Rivet's app Vite config. When upstream app code imports browser-only virtual modules or browser runtime dependencies such as `nspell`, `dictionary-en`, or `rivet-cspell-words`, mirror the required Vite plugin/dependency seam in the wrapper config and cover it in `wrapper/web/tests/vite-aliases.test.ts`.
- `rivet/` is upstream source that can be replaced or refreshed and should be treated as read-only input for this repo
- generated build output should not be treated as authored source

## Internal ownership boundaries

When adding new code, keep the post-refactor ownership seams explicit instead of rebuilding large mixed-responsibility files:

- workflow-managed backend code goes under `wrapper/api/src/routes/workflows/managed/`
  - `backend.ts` is the facade/composition root
  - DB retry/query helpers stay in `db.ts`
  - transaction sequencing stays in `transactions.ts`
  - row mapping stays in `mappers.ts`
- filesystem recording compatibility code stays under `wrapper/api/src/routes/workflows/`
  - keep `recordings.ts` as the public orchestrator
  - keep artifact IO in `recordings-artifacts.ts`
  - keep metadata normalization in `recordings-metadata.ts`
  - keep index/cleanup/delete maintenance in `recordings-maintenance.ts`
  - keep queue/readiness state in `recordings-store.ts`
- managed runtime-library orchestration goes under `wrapper/api/src/runtime-libraries/managed/`
  - keep `backend.ts` as the facade
  - keep job persistence, SSE streaming, worker flow, process tracking, and replica cleanup in their focused modules
- workflow/filesystem compatibility code should stay obvious in `wrapper/api/src/routes/workflows/storage-backend.ts`
  - do not hide `filesystem` versus `managed` behavior behind a generic abstraction layer
- wrapper-owned app settings use `wrapper/api/src/app-settings/settings-repository.ts`
  - add a domain descriptor for defaults, parsing, schema version/migrations, serialization, and any deliberate fail-closed recovery; do not add another request-path `readFileSync` cache
  - keep reusable primitive validation in `wrapper/api/src/app-settings/schema.ts`; it is a Zod-backed helper layer, not a replacement for domain policy. Domain modules still own their exact fallback, partial-update, stored-file, secret-retention, and fail-closed behavior. Numeric helpers intentionally accept only numbers and numeric strings, never JavaScript-coercible booleans or objects.
  - initialize repositories before API startup and read runtime values through the domain's cached synchronous accessor
  - `captureAppSettingsSnapshot` captures all registered settings domains at request entry, so request code must not bypass the repository and reread settings files midway through a request
  - async refreshes, external-file polling, and writes are serialized per settings path; keep writes and poller refreshes on the repository operation queue so an older disk read cannot replace a newly saved cache entry
  - App Settings HTTP resources use `ETag` and `If-Match`; domain writers must merge scoped PATCH drafts into the repository's current value so independent tabs and concurrent browser sessions do not lose unrelated fields
  - missing files mean first-run defaults, schema upgrades require explicit migrations, writes remain atomic owner-only JSON files, and the repository poller is the compatibility path for external proxy/bootstrap writers
- dashboard controllers belong in `wrapper/web/dashboard/`
  - `useWorkflowLibraryController.ts`, `useRunRecordingsController.ts`, `useProjectSettingsActions.ts`, `useDashboardSidebar.ts`, and `useEditorBridgeEvents.ts` are composition/orchestration seams; tree fetching, selection/preview debounce, drag/drop, project/folder mutations, version actions, and retained recording-modal state stay in their focused hooks instead of returning to the workflow controller
  - `AppSettingsModal.tsx` stays a tab-composition shell; each settings domain owns its form hook under `wrapper/web/dashboard/app-settings/`, and all forms use `useSettingsFormResource.ts` for revision-aware load/save/conflict handling. A tab save must send only its scoped draft and must not reset unsaved fields in another tab
  - keep the workflow-library header block at `37px` high without a bottom divider; the whole open-state header row is the collapse control with square hover corners and the sidebar icon before the `Rivet Projects` title; collapsed mode should be a persistent full-height `30px` rail button with a centered `>` chevron rather than a small header button, show the opened project's larger status dot in the former header slot only when its aggregate endpoint/web-app publication status is `Published` or `Unpublished changes`, keep the active project card grey/green/yellow tinted from that same aggregate status where any `Unpublished changes` wins over `Published`, keep the workflow tree mounted while folded, reveal the contents only after the reopen width animation completes, and keep resize behavior pointer-captured with a forgiving splitter hit target, no width transition while dragging, and fold/unfold thresholding at half the minimum sidebar width
  - single-clicking a project row should open it through the bridge as a preview tab; double-clicking, editing, running, saving, activating Remote Debugger on the active preview, or any unsafe replacement condition promotes that tab to persistent. For a not-yet-open workflow project, the dashboard should send the tree display title with `open-project`, and the iframe should call `RivetWorkspaceHost.startOpeningProjectTab(...)` before loading the file so Rivet owns the immediate tab/preloader UI. Finish that same tab with `finishOpeningProjectTab(...)` after `HostedIOProvider` returns the real snapshot, or cancel it on load/duplicate-id failure; never fake a temporary project snapshot or write upstream tab state directly. Preview replacement belongs in `usePreviewProjectLifecycle.ts` plus the serialized open handler in `useEditorCommandBridge.ts`, where the bridge can read Rivet's dirty/run/session state and close only clean known preview tabs through `RivetWorkspaceHost.closeProject(...)`. A single-click on an already-open persistent project should only activate that tab and should not close the current preview slot; the slot is replaced only when another not-yet-open project opens as preview. Keep the single-click preview debounce in `useWorkflowLibrarySelection.ts`, not per project row, so clicking a different row cancels any older pending preview open before it can reselect the previous project. When the active editor tab is the clean preview being replaced, use `replaceCurrent` through `RivetWorkspaceHost` instead of closing it first, so the dashboard does not blink back to a persistent tab while the next preview loads. When replacing an inactive preview, keep `DashboardPage.tsx`'s pending-open guard intact so intermediate active-project callbacks from closing the old preview do not briefly select the persistent project before the new preview opens. Pass `tabUi: { preview: true }` for preview opens/replaces and clear it with `setProjectTabUiState(..., { preview: false })` when promoting, so upstream Rivet owns the italic editor-tab rendering. Remote Debugger promotion should observe only Rivet's `external-debugger` executor-session target, not hosted internal executor reconnects. The active project card should not reintroduce a separate `Edit` button; row click/double-click owns open intent, empty workflow-library body clicks clear only the selected card, and the fixed-height card keeps the project name above endpoint/web-app status lines, then the graph/node/web-app count line. The endpoint line and web-app line should always render for selected projects with the same status-row height whether the row contains a pill or plain text; projects with no current web apps show `Web app: none`, while projects with web apps load status from the existing project web-app summary endpoint only for the selected project. The tree project dots and collapsed rail dot should use the same aggregate status as the summary card: grey means no dot, green means green dot, and yellow means yellow dot. The card keeps a clear vertical gap before the visibly button-like `Settings` action and conditional `Save` button, and must reserve the same height when no project is selected so the project tree below it does not jump. `Save` is shown only when the selected workflow is the active editor project and Rivet reports unsaved changes through the editor bridge.
  - keep bottom panel actions in the mounted workflow-library panel; the app-level `Settings` modal uses a left vertical tab rail, shows general runtime config, owns the Run recordings retention form with shared tab-style mode choices, and owns the Node executor proxy form plus websocket URL override fields. The `About` modal shows the official `Rivet Studio Server` app name and reads the hosted app version from the root `package.json` through the Vite build constant
  - keep project-settings validation and labels in `projectSettingsForm.ts`
  - keep run-recordings modal shell logic in `RunRecordingsModal.tsx` and its focused UI slices in `RecordingWorkflowSelect.tsx` and `RecordingRunsTable.tsx`
  - portal run-recordings dropdown menus that can open inside the scrollable modal body, such as the input-filter operator select, so option lists are not clipped by modal overflow
  - keep `RuntimeLibrariesModal.tsx` as the shell, `useRuntimeLibrariesModalState.ts` as the public controller, and `runtimeLibrariesJobStream.ts` as the SSE/log-state helper layer
  - page/components should stay mostly render wiring
- dashboard/editor bridge wiring should stay explicit
  - `DashboardPage.tsx` is the composition root
  - `HostedEditorApp.tsx` mounts `RivetAppHost`, passes the hosted provider overrides from `hostedRivetProviders.ts`, captures the upstream `RivetWorkspaceHost` through `onWorkspaceHostReady`, and forwards upstream host callbacks for active project, open-project count, and save completion
  - `HostedEditorApp.tsx` also passes hosted UI policy through `RivetAppHost.ui`: `fileMenu.visibleItems` keeps the iframe File menu to `import_graph`, `export_graph`, `settings`, and `get_help`, and `webApps.desktopPreview: false` hides the desktop-only `Run web app` preview action in hosted mode; keep both on the upstream host UI policy seam instead of hiding DOM or aliasing command hooks
  - `useEditorCommandQueue.ts` owns pre-ready command buffering
  - `useEditorBridgeEvents.ts` owns dashboard-side message listeners and cross-iframe save shortcut capture
  - `EditorMessageBridge.tsx` is the editor-side composition root after the workspace host handle is ready. `useEditorCommandBridge.ts` owns command origin checks, FIFO dispatch, and acknowledgements; implementations stay split across `editorProjectOpenCommands.ts`, `editorDetachedProjectCommands.ts`, and `editorProjectLifecycleCommands.ts`. Preview state belongs in `usePreviewProjectLifecycle.ts`, replay restoration in `useWorkflowRecordingBridge.ts`, and keyboard/focus capture in `useEditorBridgeInteractions.ts`; do not rebuild one effect that owns all four domains or move every command implementation back into the queue hook
  - preview bookkeeping may read upstream dirty/run atoms to decide whether a tab is replaceable, but it should not mutate dirty-state atoms; clean promotion/replacement and transient preview-tab UI state still go through `RivetWorkspaceHost` methods. Path-move commands must acknowledge completion back to the dashboard after open tabs, preview state, session caches, hosted revision paths, and externally persisted title/path metadata are retargeted, so a user cannot immediately reactivate an already-open moved project through a stale path and force an unnecessary reload. Use `RivetWorkspaceHost.updateProjectMetadata(...)` for path-only folder moves too, not only file-name/title renames.
  - project-tree compare should stay a bridge command: the dashboard may send `compare-open-project-with` for another workflow project, or for the active/open project's current published-version preview when the row is in `Unpublished changes`. If the right-click reference project itself is in `Unpublished changes`, the dashboard should ask whether to compare against its saved live file or current published snapshot before sending the bridge command. `EditorMessageBridge.tsx` should load only the reference `.rivet-project` contents before calling `RivetWorkspaceHost.startProjectCompare(...)` with optional side labels. Do not persist compare state, open a detached preview tab for the published-reference path, import the reference project's datasets into the active hosted dataset provider, or write upstream compare atoms directly.
- hosted provider wiring should stay explicit
  - import the app shell and CSS through `rivet/packages/app/src/host.tsx` and `rivet/packages/app/src/host.css`
  - pass `HostedIOProvider`, an injected `HostedDatasetProvider`, the hosted environment provider, and the hosted path-policy provider through `RivetAppHost.providers`
  - keep hosted environment lookup cached and deduplicated in `wrapper/web/overrides/utils/tauri.ts`; warm node settings panel opens should not issue repeated `/api/config/env/*` requests, including for empty or disallowed env values
  - keep `HostedIOProvider` and Rivet's active dataset provider on the same import/export-capable dataset-provider instance so project file IO, dataset UI, and runtime hooks observe the same imported datasets
  - keep `HostedDatasetProvider` pruning old per-project IndexedDB dataset rows before importing a project payload, otherwise datasets removed from a project can reappear from stale browser app storage
  - declare packages imported by the hosted Rivet import graph directly in `wrapper/web/package.json`; the wrapper declares `idb` because hosted dataset/storage modules import it. Do not rely on the vendored `rivet/` checkout's `node_modules` or a coincidental transitive dependency.
- hosted project context values are editor-owned app state, not `.rivet-project` file contents
  - Rivet stores them under `projectContext__"<projectId>"`, so hosted open/reopen persistence depends on stable `project.metadata.id` values
  - keep `wrapper/web/overrides/state/savedGraphs.ts` exporting the hosted `clearProjectContextState` compatibility helper by delegating normal tab cleanup to upstream `releaseProjectContextState`, so `RivetWorkspaceHost.closeProject()` and `replaceCurrent()` can close tabs without deleting those stored values
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
  - `wrapper/web/vite.config.ts` resolves override files only when the importer is under `rivet/packages/app/src`
  - keep the `savedGraphs` override narrow: it re-exports upstream state, maps the hosted `clearProjectContextState` compatibility helper to upstream `releaseProjectContextState` for normal tab close/reopen, and exposes an explicit storage-removing delete helper for actual workflow deletion
  - keep the `state/settings` override narrow: delegate upstream settings exports and override only hosted executor/debugger defaults plus the wrapper update-check modal atom, so upstream UI settings such as canvas background preferences and custom theme color helpers are not copied into the wrapper
  - do not put wrapper-owned transport overrides back into `wrapper/web/vite-aliases.ts`
  - do not alias `useSaveProject` or `useMenuCommands`; upstream `useWorkspaceTransitions`, `RivetAppHost.onProjectSaved`, and `RivetAppHost.ui.fileMenu.visibleItems` own the save/menu seam, while the wrapper sends `save-project` when focus is outside the iframe and reconciles saved title/path metadata through `RivetWorkspaceHost.updateProjectMetadata()` after successful saves
  - keep iframe-local `Ctrl+S` / `Cmd+S` idempotent: the hosted bridge should ignore already-prevented save shortcuts and call `stopImmediatePropagation()` when it handles one, because upstream in-app menu hotkey listeners can otherwise observe the same Windows keydown and trigger a second save
  - do not mutate `projectState`, `graphState`, `projectDataState`, or `openedProjectSnapshotsState` from save-completion callbacks. Upstream Rivet marks the saved snapshot clean inside its save transition, and post-save wrapper mutations to active project content can make the editor-owned unsaved-changes dot compare against the wrong digest.
  - if a future wrapper-owned save path bypasses Rivet's save command, call `RivetWorkspaceHost.updateProjectMetadata(..., { persistedExternally: true })` for externally persisted title/description updates, or `markCurrentProjectClean()` / `markProjectClean()` for clean-baseline-only reconciliation after the backend save succeeds; never import or mutate `savedProjectContentDigestsState`, `projectUnsavedChangesState`, or `projectDataUnsavedChangesState` from wrapper code
  - do not reintroduce wrapper copies of `TauriProjectReferenceLoader`, `io/datasets`, `io/TauriIOProvider`, or `utils/globals/ioProvider`; hosted relative-project reads belong in the path policy provider, and hosted project/dataset persistence belongs in `RivetAppHost.providers` plus `HostedIOProvider`
  - keep `scripts/update-check.sh` aligned with that boundary: it should check the upstream provider seams, not treat provider-backed upstream modules as wrapper aliases
  - keep bare-package shims such as `@tauri-apps/api/*` separate from relative Rivet module overrides
  - do not keep stale component copies such as `OverlayTabs` in the wrapper; the current Rivet 2 workspace tab row is upstream-owned, and observer coverage should follow its accessible `Workspace navigation` buttons
- API workflow execution should resolve `@valerypopoff/rivet2-node` through `scripts/link-rivet-node-package.mjs`
  - keep local setup and API image builds linking generated package overlays for `rivet/packages/node` plus `rivet/packages/core`
  - keep the `@rivet2/rivet-node` and `@rivet2/rivet-core` aliases linked to the same overlays, because older built outputs in a local upstream checkout may still reference those aliases
  - do not add direct API imports from `rivet/packages/*/src`; the package-name import remains the stable seam
  - keep `wrapper/api` symlink-preserved when compiling or running so these package links resolve without writing dependency helper links into `rivet/`
- API-local warm caches are derived accelerators only
  - use `lru-cache` for generic access-order and byte-budget eviction in managed execution and managed Code/Expression compilation/require caches
  - keep domain ownership of workflow-to-key reverse indexes, byte measurements, oversized-entry rejection, cross-replica invalidation, release-snapshot invalidation, and Node `require.cache` clearing; do not spread the library into filesystem freshness caches
- Kubernetes template reuse should stay shallow
  - use `_env.tpl` and `_pod.tpl` for genuinely repeated backend/execution blocks
  - keep `proxy` and `web` explicit unless extraction clearly improves readability

## Safe verification workflow

For wrapper/API changes:

1. `npm --prefix wrapper/api test`
2. `npm --prefix wrapper/api run build`

Current repo-local baseline:

- `npm run test` is the one-command root test gate for non-browser automation. Its `pretest` hook runs the same dependency bootstrap as the dev launchers, then the test command runs the API build, default API tests, pure web helper tests, test-style guardrails, repo-structure guardrails, and Kubernetes launcher/chart contracts. It intentionally does not run Playwright because those specs require a live browser/app target and, for some managed flows, deliberate mutation opt-in.
- The image-build workflow runs the cheap repo guardrails (`npm run verify:repo-structure` and `npm run verify:test-style`) once in a shared verification job before the image matrix starts. Image jobs publish only a deterministic staging tag keyed by the wrapper commit plus the exact Rivet commit resolved for that run. A final promotion job applies `latest`, branch, release-tag, and short-SHA tags only after all four images build successfully, so an image-build failure cannot leave the public tag set half-updated. Runs for the same Git ref are serialized, transient build/push failures receive one cache-backed retry, registry promotion receives bounded retries, and third-party actions are pinned to reviewed commit SHAs. GHCR cannot promote four separate image repositories as one transaction, so rerun a workflow if a persistent registry outage interrupts the final promotion job. The API image build still compiles the API inside Docker; full API test runs remain developer/compatibility verification commands, not the image-publish workflow.
- The current image-build optimization outcome is roughly 5 minutes for the GitHub image workflow, down from roughly 13-15 minutes before the CI/platform/layering/minimal-upstream-target work. Keep shared Rivet artifact/base-image work deferred unless new timing logs show repeated Rivet artifact builds are again the dominant cost.
- If the full API suite fails with `ERR_MODULE_NOT_FOUND` for upstream Rivet packages such as `ai`, `openai`, or `@ai-sdk/anthropic`, refresh the embedded Rivet dependency baseline with `npm run setup` before treating the failure as a wrapper test regression.
- The test-suite cleanup plan previously lived in the root `tests-refactor.md` working document; after final prune, keep the lasting outcomes in `docs/refactor-history.md` and keep the public verification commands stable for future cleanup.
- API workflow tests should reuse the shared helpers under `wrapper/api/src/tests/helpers/` before adding local harness code. Workflow HTTP harnesses, JSON response handling, recording waiters, filesystem execution cache invalidation probes, temp workflow roots, root-level published-project fixtures, and the filesystem workflow suite bootstrap/cleanup live there.
- To run only specific API test files, use `npm --prefix wrapper/api run test:files -- src/tests/example.test.ts`. Do not pass file names to `npm --prefix wrapper/api test -- ...`; the default API script is an explicit manifest and would still run the full suite before appending the extra files.
- The old mixed `workflow-services.test.ts` suite has been split by behavior domain. Put new filesystem tree/import/export coverage in `workflow-filesystem-tree.test.ts`, publication-state and endpoint-reservation coverage in `workflow-publication-filesystem.test.ts`, published-version-history coverage in `workflow-published-history-filesystem.test.ts`, endpoint execution/cache coverage in `workflow-execution-filesystem.test.ts`, and recording route coverage in `workflow-recordings-http.test.ts`.
- The old mixed `managed-backend-sql.test.ts` suite has been split. Put managed schema, folder-move SQL, and execution lookup query contracts in `managed-workflow-schema.test.ts`; put managed publication history, restore, star persistence, and save-target behavior in `managed-publication-history.test.ts`. Schema tests should import the exported SQL string, not read `schema.ts` as source text, so escaping regressions are tested against what the app actually sends to Postgres.
- The old broad `phase4-static-contract.test.ts` suite has been split. Put proxy, Docker image, CI image, and production launcher contracts in `proxy-image-contract.test.ts`; hosted editor wrapper/upstream seam guardrails in `hosted-editor-seams.test.ts`; and Helm/chart topology assertions in `kubernetes-contract.test.ts`.
- `npm --prefix wrapper/api test` intentionally does not run Helm. Use `npm run verify:kubernetes` for Kubernetes launcher tests, Helm-rendered chart contracts, and production overlay lint/template checks. The API suite runs with `--test-concurrency=1` because many API tests intentionally set process-wide `RIVET_*` roots before importing route modules; keep that serialization unless the affected tests are refactored to avoid global env mutation.
- `npm run verify:test-style` owns the test-suite style guardrails: root `npm run test` must keep composing the non-browser repo-local gate after the standard `pretest` dependency bootstrap, default API tests must list every non-Kubernetes API test exactly once, `verify:web-pure` must list every pure web test exactly once, `kubernetes-*.test.ts` API files must stay behind `verify:kubernetes`, runnable test/spec files must stay in their expected top-level suite folders, retired or merged-away suites must not come back, `.only` tests are blocked, and wrapper tests/helpers must not assert upstream `rivet/packages/app/src` implementation paths beyond the approved host entry/style seam.
- Observable Playwright specs validate whichever app is currently running at `PLAYWRIGHT_BASE_URL`; that target can be an older rebuilt container or a published image. Do not read local `package.json` metadata from Playwright specs to assert deployed UI text. If version display is the behavior under test, assert that the live modal renders a version-shaped value, or explicitly run the spec against a freshly rebuilt local target.
- Tests that intentionally exercise negative paths should capture and assert expected `console.error` or `console.warn` output. A passing `npm run test` should not print scary stack traces for failures that the test deliberately caused.
- Final-prune cleanup should not reintroduce a broad suite just to keep a helper alive. If a helper has no call sites after a split, delete the helper and let `npm --prefix wrapper/api run build` plus `npm run verify:test-style` prove the manifest and type boundaries.
- `scripts/update-check.sh` must list every active `createModuleOverrideAliases(...)` target. `npm run verify:web-pure` checks that the scanner and Vite aliases stay aligned, so update both when adding or removing hosted upstream overrides.
- `npm run verify:kubernetes` lint-renders the Helm chart with real image repository overrides and verifies the key negative cases:
  - placeholder image repositories are rejected
  - published-route-prefix overrides are rejected
  - the managed-only chart shape is enforced
- managed migration verification now has direct regression coverage for its comparison logic, but real import/cutover confidence still requires the managed Docker rehearsal described below.

For hosted editor shell changes, keep `wrapper/web/index.html` loading the same font families that Rivet styles reference. Rivet uses both `Roboto` and `Roboto Mono`; loading only the monospace family leaves several upstream panels on browser fallbacks.

For wrapper/web changes:

1. `npm --prefix wrapper/web run build`
2. if the change adds or changes pure helper logic under `wrapper/web/dashboard/` or `wrapper/web/overrides/hooks/`, run `npm run verify:web-pure`
3. if the change affects browser-visible behavior, run `PLAYWRIGHT_HEADLESS=1`, `PLAYWRIGHT_SLOW_MO=0`, then `node scripts/playwright-observe.mjs test`
4. if the Playwright coverage needs real workflow mutations in Storage-tab `Object storage` mode, set `PLAYWRIGHT_ALLOW_MANAGED_MUTATIONS=1` deliberately and keep cleanup explicit; prefer mocked API/browser tests for modal and controller coverage when storage mutation is not the point
5. if the change lives under `wrapper/web/overrides/` or affects hosted editor save/hotkey behavior, also verify with `npm run prod:custom`; `npm run prod` deliberately pulls already-published images instead of using your local workspace changes

For workflow-library mutations that change on-disk project state:

1. `npm run dev`
2. validate the browser flow through `http://localhost:8080` by default, or your configured `RIVET_PORT`
3. right-click a project in the left panel and run `Duplicate`
4. for `unpublished`, confirm the new project appears in the same folder as `Name [unpublished] Copy.rivet-project` and that the current selection/editor tab did not change
5. for `published`, confirm duplication uses the published snapshot and names the duplicate `Name [published] Copy.rivet-project`
6. for `unpublished_changes`, confirm the chooser appears and both saved versions duplicate correctly, including the expected `Name [published] Copy.rivet-project` vs `Name [unpublished changes] Copy.rivet-project` naming
7. confirm duplication still leaves the current selection/editor tab unchanged

For workflow-library project creation behavior:

1. `npm run dev`
2. validate the browser flow through `http://localhost:8080` by default, or your configured `RIVET_PORT`
3. right-click a folder in the left panel and run `Create project`
4. enter a new project name when prompted
5. confirm the folder expands and the new project opens in the editor
6. confirm there is no inline `+` create-project button on folder rows anymore
7. try an existing name in the same folder and confirm the UI shows the API conflict instead of silently overwriting the file

For workflow-library folder creation behavior:

1. `npm run dev`
2. validate the browser flow through `http://localhost:8080` by default, or your configured `RIVET_PORT`
3. click `+ New folder` at the bottom of the workflow library
4. enter a folder name when prompted
5. confirm the new folder appears at the root level of the tree
6. try an existing root-level name and confirm the UI shows the API conflict instead of silently overwriting anything

For workflow-library folder rename behavior:

1. `npm run dev`
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

1. `npm run dev`
2. validate the browser flow through `http://localhost:8080` by default, or your configured `RIVET_PORT`
3. right-click an empty folder in the left panel and run `Delete folder`
4. confirm the UI asks for confirmation before deletion
5. confirm the folder disappears only after confirming
6. right-click a non-empty folder and confirm the `Delete folder` action is disabled
7. if you call the API directly for a non-empty folder, confirm it still rejects with `Only empty folders can be deleted`

For workflow-library drag/drop move behavior:

1. `npm run dev`
2. validate the browser flow through `http://localhost:8080` by default, or your configured `RIVET_PORT`
3. drag a project from one folder to another and confirm the tree updates after the drop
4. if that project is open in the editor, confirm saves still target the new path after the move
5. drag a folder into another folder and confirm all nested projects move with it
6. drag a project or folder back to the root area and confirm it is reparented to the root
7. try to drag a folder into itself or one of its descendants and confirm the move is rejected cleanly

For workflow-library upload behavior:

1. `npm run dev`
2. validate the browser flow through `http://localhost:8080` by default, or your configured `RIVET_PORT`
3. right-click a folder in the left panel and run `Upload project`
4. choose a local `.rivet-project` file in the browser picker
5. note that some browsers may still show a generic picker instead of pre-filtering `.rivet-project`; selecting the wrong file type should fail cleanly without uploading anything
6. confirm the project appears in that folder
7. if the folder already contained that name, confirm the new file is saved as `Name 1`, `Name 2`, and so on
8. confirm the upload does not change the current selection, open a different tab, or expand folders automatically

For workflow-library download behavior:

1. `npm run dev`
2. validate the browser flow through `http://localhost:8080` by default, or your configured `RIVET_PORT`
3. right-click a project in the left panel and run `Download`
4. for `unpublished`, confirm the browser downloads `Name [unpublished].rivet-project`
5. for `published`, confirm the browser downloads `Name [published].rivet-project`
6. for `unpublished_changes`, confirm the chooser appears and both saved versions download correctly
7. make unsaved editor changes and confirm downloads still reflect only the saved server-side versions
8. confirm the download flow does not change selection, open a different tab, or expand folders

For workflow-library project deletion behavior:

1. `npm run dev`
2. validate the browser flow through `http://localhost:8080` by default, or your configured `RIVET_PORT`
3. right-click a project with no workflow endpoint publication and no published web apps in the left panel and run `Delete project`
4. confirm the context-menu action only opens Project Settings and does not delete immediately
5. confirm the project is deleted only after clicking `Delete project` again inside Project Settings
6. right-click a project that has a published workflow endpoint, unpublished workflow changes, or published web apps and run `Delete project`
7. confirm the UI shows `To delete a project, unpublish its workflow endpoint and web apps first`
8. confirm the guarded delete action does not change selection, open a different tab, or delete anything directly from the context menu

For workflow-library project rename entry behavior:

1. `npm run dev`
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

1. `npm run dev`
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
12. confirm `Ctrl+S` works while focus is inside the workflow iframe, including on Windows browsers
13. confirm `Ctrl+Shift+I` remains browser-owned for DevTools and does not open Rivet's graph import picker
14. confirm the browser can still type normally inside real text inputs and that copy/paste/duplicate/save/search shortcuts do not hijack active editor form fields

For hosted editor production-image regressions:

1. remember that `npm run prod` and `npm run prod:prebuilt` use pulled images, `npm run prod:restart` keeps already-local images, and `npm run prod:custom` uses your current workspace and `rivet/` folder
2. if dev works but prod does not, diff the behavior against clean upstream `rivet` and move any hosted-only patch into tracked wrapper code before trusting the local result
3. for clipboard or graph-tree context-menu regressions specifically, check the tracked hosted overrides for `useCopyNodesHotkeys`, `useContextMenu`, and the canvas focus handoff in `EditorMessageBridge.tsx`; the context-menu override must keep upstream's virtual pointer anchor plus `setFloatingMenu` return and should not depend on removed graph-list positioning classes such as `graph-item-context-menu-pos` or `graph-list-context-menu-pos`

For slow hosted node settings panels:

1. open DevTools Network and filter for `/api/config/env/`
2. open the same node settings panel twice
3. a cold page may make one concurrent burst of env requests, but the warm open should not repeat them
4. repeated warm env requests usually mean `wrapper/web/overrides/utils/tauri.ts` stopped caching empty env responses or stopped deduplicating pending requests
5. panel latency that is the same in small and large projects usually points to fixed hosted provider work, not `.rivet-project` YAML parsing or opened-project snapshot caching
6. after changing server env values, restart or recreate the app and reload the browser page because hosted env values are cached for the browser page session

For published-project save status behavior:

1. `npm run dev`
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

1. `npm run dev`
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

For managed endpoint latency and cache behavior:

1. run with Settings -> `Storage` set to `Object storage`
2. call the same trivial published or latest endpoint twice
3. expect the first request after startup or after a publish/save/rename/move to be the cold path
4. expect the second request for the same unchanged workflow to drop onto the warm local path
5. if you enabled `RIVET_WORKFLOW_EXECUTION_DEBUG_HEADERS=true`, confirm `x-workflow-cache` moves from `miss` to `hit` and inspect `x-workflow-resolve-ms` / `x-workflow-materialize-ms`

For endpoint measurement with the dedicated script:

1. run the app with either `Local folders` or `Object storage` selected in Settings -> `Storage`
2. optionally set `RIVET_WORKFLOW_EXECUTION_DEBUG_HEADERS=true` so the route emits stage timings; also set `RIVET_CODE_RUNNER_TELEMETRY=true` when diagnosing Code/Expression overhead
3. run `npm --prefix wrapper/api run workflow-execution:measure -- --base-url http://localhost:8080 --endpoint hello-world --kind published --runs 5 --warmups 1`
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
npm --prefix wrapper/api run workflow-execution:benchmark-fixture -- --runs 50 --warmups 10
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
  - this is where `npm --prefix wrapper/api run build`, `npm --prefix wrapper/api test`, `npm run verify:web-pure`, `npm run verify:test-style`, and `npm run verify:repo-structure` belong
- Kubernetes render:
  - proves Helm chart syntax, local launcher values rendering, chart validation, and rendered control-plane versus execution-plane env/routing contracts
  - this is where `npm run verify:kubernetes` and Helm lint/template checks belong
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
- `npm run verify:filesystem`
  - runs the repo-local baseline for filesystem compatibility:
    - `wrapper/api` build
    - `wrapper/api` tests
    - filesystem launcher/profile contract assertions
- `npm run verify:filesystem:docker`
  - creates a disposable filesystem fixture root and explicit env file
  - verifies the Docker launchers can render `config` for filesystem mode without managed-service activation
- `npm run verify:local-docker`
  - creates a disposable managed rehearsal env file
  - verifies `managed + local-docker` activates the `workflow-managed` launcher profile
  - verifies the Docker launchers can render `config` for that rehearsal shape
- `npm run verify:local-docker:split`
  - reruns the split-topology repo-local assertions for API profiles, proxy/chart contracts, runtime-library tier ownership, and storage config
  - then verifies the local-Docker launcher contract for the managed rehearsal path

These commands do not replace full browser-level or live-cluster validation:

- use the managed Docker rehearsal for migration/import, hosted editor parity, runtime-library install/remove/readiness checks, endpoint measurement, and published web-app route checks
- use Kubernetes for real split-topology routing, restart, and scaling proof
