# Development

See also: [Mistakes and Misconceptions](./mistakes-and-misconceptions.md)
See also: [Repo structure](./repo-structure.md)
See also: [Wrapper ManagedCodeRunner Speed Plan](./wrapper-managed-code-runner-speed-plan.md)

## Setup commands

- `npm run setup`
  - ensures `wrapper/api` and `wrapper/web` dependencies exist
  - clones `rivet/` from the configured Rivet 2 repo if it is missing
  - installs upstream Yarn dependencies with `YARN_NODE_LINKER=node-modules` and builds `@valerypopoff/rivet2-core` and `@valerypopoff/rivet2-node` when needed
  - links `wrapper/api/node_modules/@valerypopoff/rivet2-core`, `@valerypopoff/rivet2-node`, and Rivet 2's `@rivet2/*` runtime aliases to generated package overlays under `wrapper/api/node_modules/.rivet-package-links`; those overlays point `dist` at the built packages under `rivet/` and resolve package dependencies through `rivet/node_modules`
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
| `npm run dev` | Starts the Docker dev stack | Closest-to-production browser testing |
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
| `npm run verify:local-docker` | Verifies managed-storage local-Docker launcher shape with a disposable env/fixture root | Check that `managed + local-docker` still enables the expected Postgres/MinIO rehearsal path |
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
- `RIVET_SOURCE_BUILD_CONTEXT_PATH` points Docker image builds at a filtered Rivet source snapshot. If it is unset, build-capable launchers recreate `.data/docker-contexts/rivet-source` from `RIVET_SOURCE_HOST_PATH`, copying package source plus Yarn release metadata while excluding dependency folders, build output, VCS data, and Yarn cache artifacts.
- `RIVET_DEPENDENCY_BUILD_CONTEXT_PATH` points Docker image builds at the smaller Rivet dependency-metadata snapshot used before `yarn install`. If it is unset, build-capable launchers recreate `.data/docker-contexts/rivet-dependency-metadata` from `RIVET_SOURCE_HOST_PATH`, copying root dependency files, `.upstream-version` when present, Yarn release/patch/plugin metadata, and declared workspace `package.json` files only.
- if `RIVET_WORKFLOWS_HOST_PATH`, `RIVET_WORKFLOW_RECORDINGS_HOST_PATH`, or `RIVET_RUNTIME_LIBS_HOST_PATH` is present, the launcher resolves it to an absolute host path before invoking Docker Compose
- explicit `RIVET_WORKFLOWS_HOST_PATH`, `RIVET_WORKFLOW_RECORDINGS_HOST_PATH`, and `RIVET_RUNTIME_LIBS_HOST_PATH` values override the derived paths from `RIVET_ARTIFACTS_HOST_PATH`

Operational note:

- `RIVET_ARTIFACTS_HOST_PATH` is the primary public filesystem-mode contract
- `RIVET_WORKFLOWS_HOST_PATH`, `RIVET_WORKFLOW_RECORDINGS_HOST_PATH`, and `RIVET_RUNTIME_LIBS_HOST_PATH` remain compatibility overrides for the launcher
- use the repo launchers (`npm run dev`, `npm run prod`, `npm run dev:docker:*`, or the Docker launcher scripts) for Docker runs; a raw `docker compose --env-file .env ...` invocation only reads the variables already present in the env file and does not derive absolute workflow, recording, or runtime-library host paths from `RIVET_ARTIFACTS_HOST_PATH`
- Docker launchers intentionally drop ambient host `NODE_OPTIONS` unless `.env` defines `NODE_OPTIONS` explicitly. This keeps Yarn 4/PnP host preloads such as `--require F:\...\.pnp.cjs` from being interpolated into Linux container startup commands while leaving non-Docker local runners alone.
- `RIVET_PROXY_READ_TIMEOUT` controls nginx `proxy_read_timeout` and `proxy_send_timeout` for `/api/*`, `${RIVET_PUBLISHED_WORKFLOWS_BASE_PATH}`, and `${RIVET_LATEST_WORKFLOWS_BASE_PATH}` in the Docker stacks; the default tracked value is `180s`
- `RIVET_COMMAND_TIMEOUT` is unrelated to workflow HTTP lifetime; it only bounds hosted shell execution under `/api/shell/exec`
- `RIVET_STORAGE_MODE=managed` switches both workflows and runtime libraries to managed Postgres plus object storage; in that mode `RIVET_RUNTIME_LIBRARIES_ROOT` remains only a local cache/workspace
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
| `managed + local-docker + combined` | Supported | Existing Postgres/MinIO rehearsal path through Docker dev or production-style Docker | Docker launchers must auto-enable `workflow-managed` |
| `managed + local-docker + control/execution` | Supported through repo-local split validation and local dependency rehearsal | Split-era compatibility checks without Kubernetes | Split route/profile contracts must stay valid while storage still uses local Docker Postgres/MinIO |

Compatibility rules:

- `filesystem` compatibility is single-host only
- `local-docker` means `RIVET_STORAGE_MODE=managed` with `RIVET_DATABASE_MODE=local-docker`
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
- it creates Kubernetes secrets from the canonical managed-service envs already used by the app:
  - `RIVET_KEY`
  - `RIVET_DATABASE_CONNECTION_STRING`
  - `RIVET_STORAGE_URL` or the explicit `RIVET_STORAGE_*` tuple
  - `RIVET_STORAGE_ACCESS_KEY_ID`
  - `RIVET_STORAGE_ACCESS_KEY`
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
- mutating workflow specs are blocked against `RIVET_STORAGE_MODE=managed` unless `PLAYWRIGHT_ALLOW_MANAGED_MUTATIONS=1` is set explicitly
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
- Vite does not proxy the published/latest workflow route families, `/ui-auth`, or `/ws/latest-debugger`, and it does not inject the trusted proxy headers that those control-plane routes expect
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
- the shared file only contributes the managed Postgres/MinIO services, and the launcher auto-enables the `workflow-managed` profile only when `RIVET_STORAGE_MODE=managed`

Current behavior:

- the browser entrypoint is still `http://localhost:8080` through nginx by default; override it with `RIVET_PORT` if needed
- `npm run prod` and `npm run prod:prebuilt` pull prebuilt images under `ghcr.io/valerypopoff/cloud-hosted-rivet2-wrapper/{proxy,web,api,executor}:${RIVET_IMAGE_TAG:-latest}`, then force-recreate the stack with `--no-build`; set `RIVET_PROXY_IMAGE`, `RIVET_WEB_IMAGE`, `RIVET_API_IMAGE`, or `RIVET_EXECUTOR_IMAGE` to pin any service to a different image. Keep the image examples in `.env.example` on that same namespace so VM overrides do not accidentally pull the legacy wrapper images.
- `npm run prod:restart` skips the pull/build step and force-recreates the stack from the images already present locally. Use it after changing `.env` when you want containers to pick up new env values without updating to newer GHCR images.
- `npm run prod:custom` rebuilds the stack from the current wrapper repo and the current `rivet/` source folder, using the filtered `rivet_source` and `rivet_dependency_metadata` Docker build contexts
- the API is also exposed directly on `http://localhost:3100` for diagnostics
- proxy startup scripts are Linux shell scripts; dev Compose mounts them from the repo, while production images bake them into the proxy image. The repo pins `*.sh` files to LF line endings so Windows checkouts do not inject CRLF characters into `/bin/sh`
- proxy startup copies the UI gate prompt from its mounted or baked source into `/tmp/nginx/html` before nginx starts; nginx serves the staged copy instead of repeatedly reading a host-mounted HTML file on each gated request
- standard proxied HTTP routes now default to a `180s` upstream timeout through `RIVET_PROXY_READ_TIMEOUT`; websocket routes stay long-lived separately
- the local Docker stacks keep `RIVET_API_PROFILE=combined` by default, so `/api/*`, `${RIVET_LATEST_WORKFLOWS_BASE_PATH}`, and `${RIVET_PUBLISHED_WORKFLOWS_BASE_PATH}` all land on the same `api` container there
- the `web` service runs the Vite dev server inside the container with live bind mounts
- Docker dev rebuilds the `api` and `executor` services from Dockerfiles while running `web` through Vite; `npm run prod:custom` rebuilds `proxy`, `web`, `api`, and `executor`
- the launchers compute host bind mounts before calling Compose. With `RIVET_ARTIFACTS_HOST_PATH=../` from the repo root, both dev and production-style Docker mount `<repo>/../workflows` at `/workflows`, `<repo>/../workflow-recordings` at `/workflow-recordings`, and `<repo>/../runtime-libraries` at `/data/runtime-libraries`. If you bypass the launcher and run Compose directly, set those three `RIVET_*_HOST_PATH` values explicitly or Compose may fall back to repo-local defaults.
- the production web image installs wrapper web dependencies from `wrapper/web/package.json` and `wrapper/web/package-lock.json` before copying web/shared source, then uses the root `package.json` as build metadata for the About modal version. Keep `wrapper/web/package.json` free of `file:../..` root dependencies so GitHub Actions can build the web image from the same minimal context.
- the API image builds `rivet/packages/core` and `rivet/packages/node`, then links `wrapper/api` to those built package directories before compiling the API; this keeps hosted endpoint execution on the same Rivet source tree as the editor and executor
- the Docker dev API waits for the web service to populate the shared `rivet_node_modules` volume, then copies only `rivet/packages/core` and `rivet/packages/node` into `/app/.rivet-source`, attaches `/workspace/rivet/node_modules` beside that copy, and points the generated `@valerypopoff/rivet2-core`, `@valerypopoff/rivet2-node`, and `@rivet2/*` package overlays at the internal copy. That keeps Node package resolution inside the container even when `rivet/` is a Windows junction target, avoids duplicating the upstream dependency install, and avoids writing API helper links into the external Rivet checkout.
- local and image API entrypoints run with symlink preservation (`preserveSymlinks` for TypeScript and `--preserve-symlinks` for Node/tsx), while `scripts/link-rivet-node-package.mjs` creates generated package overlays that expose the built Rivet package `dist` folders and route third-party dependency lookup back to `rivet/node_modules`
- the Docker dev API mounts the repo scripts directory at `/scripts`, matching the `../../scripts/...` path seen from `/app`, so the same `wrapper/api` package scripts run locally and inside Compose
- Docker image builds receive upstream Rivet through the named `rivet_source` and `rivet_dependency_metadata` build contexts instead of `COPY rivet/` from the main repo context; local launchers feed those contexts from `.data/docker-contexts/rivet-source` and `.data/docker-contexts/rivet-dependency-metadata` so linked Rivet checkouts do not send `node_modules`, `.git`, or Yarn cache artifacts to BuildKit
- `npm run dev:docker:prepare-rivet-context` refreshes those filtered contexts without starting Docker, which is useful before manual `docker build --build-context rivet_source=.data/docker-contexts/rivet-source --build-context rivet_dependency_metadata=.data/docker-contexts/rivet-dependency-metadata ...` checks
- the Docker Compose stacks set `HOME=/home/rivet` and keep npm/Yarn caches there so pulled non-root images and locally built images use the same runtime cache contract
- the launcher waits for healthy services; `RIVET_DOCKER_WAIT_TIMEOUT` controls the overall wait window, while the Docker dev API healthcheck has a longer startup grace period because cold starts may need to refresh npm dependencies, copy Rivet package sources, and relink local package overlays before `/healthz` is available
- on Windows/Docker Desktop, if Compose fails before containers start with `error while creating mount source path '/run/desktop/mnt/host/<drive>/...'` and `file exists`, first verify the host folder exists, then run `wsl --shutdown` from PowerShell to reset Docker Desktop's WSL file-sharing bridge before retrying `npm run dev:docker`
- in `RIVET_STORAGE_MODE=managed`, both workflow state and runtime-library releases come from managed services, while `/data/runtime-libraries` remains only an extracted local cache/workspace inside each container
- in `RIVET_STORAGE_MODE=managed`, published/latest endpoint execution also keeps API-local warm caches for endpoint pointers and immutable revision contents; the first hit after startup or after a workflow mutation can still be slower, but repeated hits for the same unchanged trivial workflow should settle onto the warm local path
- a later cleanup pass did not change that behavior; it extracted the managed execution invalidation/service code, replaced brittle source assertions with behavioral tests, added a measurement tool, and hardened listener startup/shutdown plus same-process self-notify handling without changing the public execution contract
- if `RIVET_DATABASE_MODE=managed`, runtime-library replica-status rows also live in the shared Postgres database, so stale rows from older containers can survive a Docker recreate until retention cleanup runs or you clear them explicitly
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
  - a SQLite index under `RIVET_APP_DATA_ROOT`: `recordings.sqlite`
- in `managed` mode:
  - recording metadata rows in Postgres
  - recording and replay artifacts in managed object storage

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

Filesystem-mode recording list requests also validate `recordings.sqlite` against completed bundle metadata under `RIVET_WORKFLOW_RECORDINGS_ROOT`:

- empty workflow-level recording directories do not count as completed bundles
- if repair cannot converge, such as when a corrupt `metadata.json` exists, the API logs the mismatch once
- repeated repair is skipped until the completed-bundle signature or indexed counts change

For slow `GET /api/workflows/recordings/workflows` diagnosis in Docker, compare:

- completed bundle files under `/workflow-recordings`:
  `find /workflow-recordings -mindepth 3 -maxdepth 3 -name metadata.json -type f | wc -l`
- indexed run rows in `/data/rivet-app/recordings.sqlite`:
  `node -e "const {DatabaseSync}=require('node:sqlite'); const db=new DatabaseSync('/data/rivet-app/recordings.sqlite'); console.log(db.prepare('select count(*) n from recording_runs').get())"`

The `Run recordings` modal can also filter a workflow's runs by recorded request input. Use the `Input JSON path` control with a path such as `$.foo`, an operator such as `==`, and a value such as `bar`. The API evaluates `$` against the root workflow request body stored in the recording's `inputs.input.value` event. Missing paths match `not_exists`, do not match `exists`, and resolve to actual `undefined` for the other operators; the filter value literal `undefined` also parses as `undefined`. Ordering comparisons with `undefined` do not match. This filter reads existing recording artifacts after workflow/status narrowing, newest first. For input-filtered requests a response can be non-exhaustive, including a scan window with no matches: `totalRunsExact: false`, `hasMore: true`, and `nextInputCursor` mean the dashboard can show the newest matches immediately, continue with the next cursor automatically, and append newly found runs to the visible list. The dashboard shows searching/completed/stopped status, exposes `Stop search`, and aborts an in-flight recordings request through the same stop path when the filter is cleared/hidden or the modal closes/dismisses.

## Source of truth

- authored source lives under `wrapper/`, `image/`, `ops/`, `charts/`, `scripts/`, `docs/`, and `.github/`
- runtime/bootstrap code belongs under `wrapper/bootstrap/`, not under `ops/`
- hosted editor patches that must survive production image builds should live under `wrapper/web/overrides/`, `wrapper/web/dashboard/`, or other tracked wrapper files
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
- dashboard controllers belong in `wrapper/web/dashboard/`
  - `useWorkflowLibraryController.ts`, `useRunRecordingsController.ts`, `useProjectSettingsActions.ts`, `useDashboardSidebar.ts`, and `useEditorBridgeEvents.ts` should own orchestration
  - keep the workflow-library header block at `37px` high without a bottom divider; the whole open-state header row is the collapse control with the sidebar icon before the `Rivet Projects` title; collapsed mode should be a persistent full-height `30px` rail button with a centered `>` chevron rather than a small header button, show the opened project's larger grey/green/yellow status dot in the former header slot when a project is open, keep the active project card grey/green/yellow tinted from the selected project's publication status, keep the workflow tree mounted while folded, and reveal the contents only after the reopen width animation completes
  - keep bottom panel actions in the mounted workflow-library panel; the `About` modal shows the official `Rivet Studio Server` app name and reads the hosted app version from the root `package.json` through the Vite build constant
  - keep project-settings validation and labels in `projectSettingsForm.ts`
  - keep run-recordings modal shell logic in `RunRecordingsModal.tsx` and its focused UI slices in `RecordingWorkflowSelect.tsx` and `RecordingRunsTable.tsx`
  - portal run-recordings dropdown menus that can open inside the scrollable modal body, such as the input-filter operator select, so option lists are not clipped by modal overflow
  - keep `RuntimeLibrariesModal.tsx` as the shell, `useRuntimeLibrariesModalState.ts` as the public controller, and `runtimeLibrariesJobStream.ts` as the SSE/log-state helper layer
  - page/components should stay mostly render wiring
- dashboard/editor bridge wiring should stay explicit
  - `DashboardPage.tsx` is the composition root
  - `HostedEditorApp.tsx` mounts `RivetAppHost`, passes the hosted provider overrides from `hostedRivetProviders.ts`, captures the upstream `RivetWorkspaceHost` through `onWorkspaceHostReady`, and forwards upstream host callbacks for active project, open-project count, and save completion
  - `HostedEditorApp.tsx` also passes `RivetAppHost.ui.fileMenu.visibleItems` so the iframe File menu shows only `import_graph`, `export_graph`, `settings`, and `get_help`; keep this on the upstream host UI policy seam instead of hiding menu DOM or aliasing menu command hooks
  - `useEditorCommandQueue.ts` owns pre-ready command buffering
  - `useEditorBridgeEvents.ts` owns dashboard-side message listeners and cross-iframe save shortcut capture
  - `EditorMessageBridge.tsx` owns editor-side message handling after the workspace host handle is ready, and should pass that `RivetWorkspaceHost` through to project open, replace-current, close, and path-move commands instead of rewriting Rivet tab atoms directly
- hosted provider wiring should stay explicit
  - import the app shell and CSS through `rivet/packages/app/src/host.tsx` and `rivet/packages/app/src/host.css`
  - pass `HostedIOProvider`, an injected `HostedDatasetProvider`, the hosted environment provider, and the hosted path-policy provider through `RivetAppHost.providers`
  - keep `HostedIOProvider` and Rivet's active dataset provider on the same import/export-capable dataset-provider instance so project file IO, dataset UI, and runtime hooks observe the same imported datasets
  - keep `HostedDatasetProvider` pruning old per-project IndexedDB dataset rows before importing a project payload, otherwise datasets removed from a project can reappear from stale browser app storage
- hosted project context values are editor-owned app state, not `.rivet-project` file contents
  - Rivet stores them under `projectContext__"<projectId>"`, so hosted open/reopen persistence depends on stable `project.metadata.id` values
  - keep `wrapper/web/overrides/state/savedGraphs.ts` overriding only `clearProjectContextState` so `RivetWorkspaceHost.closeProject()` and `replaceCurrent()` can close tabs without deleting those stored values
  - actual dashboard workflow deletion should forward the project id returned by `DELETE /api/workflows/projects`, then call `deleteHostedProjectContextState` and `clearHostedDatasetsForProject` from the iframe delete handler so stale editor-owned browser state does not remain even when the tab was already closed
- editor executor transport should prefer Rivet's upstream host/session seam
  - mount the editor through `RivetAppHost`
  - pass the hosted executor websocket through `executor.internalExecutorUrl`
  - use `RivetAppHost.ui.fileMenu.visibleItems` for hosted File menu visibility and leave command execution in upstream `useMenuCommands`
  - keep graph execution, upload, abort, pause/resume, and websocket message ownership in upstream Rivet hooks
  - do not alias `useExecutorSession`, `useRemoteDebugger`, `useGraphExecutor`, or `useRemoteExecutor`; upstream Rivet owns internal executor UI classification and debugger handoff for `executor.internalExecutorUrl`
  - stale wrapper transport override files were removed; do not reintroduce them unless the upstream seam no longer covers hosted behavior
- hosted opened-project hooks should preserve Rivet 2.0's split tab state
  - keep `projectsState.openedProjects` as lightweight tab metadata: project id, title, path, and opened graph
  - keep full in-memory project content in `openedProjectSnapshotsState`
  - prefer `RivetWorkspaceHost.openProjectSnapshot`, `replaceCurrent`, `closeProject`, and `moveProjectPaths` for the actual workspace transition
  - wrapper atom reads are acceptable for hosted path lookup, duplicate-project-id checks, and stale-empty-tab cleanup, but do not reimplement tab close fallback or path rewrite transitions in wrapper code when the workspace host exposes them
  - normalize persisted opened-project metadata by dropping missing entries, orphan metadata, duplicate project ids, and legacy full-project payloads before the tab strip reads it; when damaged duplicate entries share an id, prefer the entry that still has a file path
  - resolve tab titles through the wrapper helper so old projects or legacy persisted tab entries fall back to the project filename instead of rendering missing, `undefined`, or `null` labels
  - when the visible tab strip is empty, the next workflow open must reset opened-project metadata and snapshots instead of merging hidden stale entries from older sessions
  - run that stale-empty-tab cleanup after `RivetWorkspaceHost` opens the requested snapshot, not before async project loading, so upstream sync effects cannot re-add the previous hidden project while loading is in flight
  - after the tab strip remounts, do not let the previous pathless `projectState` re-add itself; the sync hook may register the current project only when its project id is already present in the visible opened-project id list or the current project is still file-backed by `loadedProject.path`
  - prune pathless opened-project metadata when there is neither an active current project nor an `openedProjectSnapshotsState` entry that can activate that tab
  - project loading must read the latest atom store at call time, and direct workflow opens should pass their freshly loaded snapshot into the workspace host instead of depending on a just-written atom value to be visible immediately
  - if direct workflow activation fails, rely on the workspace host's boolean result and avoid posting `project-opened` to the dashboard
  - when fixing tab close/switch behavior, update the wrapper overrides rather than storing full project objects back into `projectsState.openedProjects`
- wrapper module overrides should stay scoped to upstream app importers
  - `wrapper/web/vite.config.ts` resolves override files only when the importer is under `rivet/packages/app/src`
  - keep the `savedGraphs` override narrow: it re-exports upstream state, changes only `clearProjectContextState` for normal tab close/reopen, and exposes an explicit delete helper for actual workflow deletion
  - do not put wrapper-owned transport overrides back into `wrapper/web/vite-aliases.ts`
  - do not alias `useSaveProject` or `useMenuCommands`; upstream `useWorkspaceTransitions`, `RivetAppHost.onProjectSaved`, and `RivetAppHost.ui.fileMenu.visibleItems` own the save/menu seam, while the wrapper sends `save-project` when focus is outside the iframe and reconciles hosted title metadata after successful saves
  - do not reintroduce wrapper copies of `TauriProjectReferenceLoader`, `io/datasets`, `io/TauriIOProvider`, or `utils/globals/ioProvider`; hosted relative-project reads belong in the path policy provider, and hosted project/dataset persistence belongs in `RivetAppHost.providers` plus `HostedIOProvider`
  - keep `scripts/update-check.sh` aligned with that boundary: it should check the upstream provider seams, not treat provider-backed upstream modules as wrapper aliases
  - keep bare-package shims such as `@tauri-apps/api/*` separate from relative Rivet module overrides
  - do not keep stale component copies such as `OverlayTabs` in the wrapper; the current Rivet 2 workspace tab row is upstream-owned, and observer coverage should follow its accessible `Workspace navigation` buttons
- API workflow execution should resolve `@valerypopoff/rivet2-node` through `scripts/link-rivet-node-package.mjs`
  - keep local setup and API image builds linking generated package overlays for `rivet/packages/node` plus `rivet/packages/core`
  - keep the `@rivet2/rivet-node` and `@rivet2/rivet-core` aliases linked to the same overlays, because older built outputs in a local upstream checkout may still reference those aliases
  - do not add direct API imports from `rivet/packages/*/src`; the package-name import remains the stable seam
  - keep `wrapper/api` symlink-preserved when compiling or running so these package links resolve without writing dependency helper links into `rivet/`
- Kubernetes template reuse should stay shallow
  - use `_env.tpl` and `_pod.tpl` for genuinely repeated backend/execution blocks
  - keep `proxy` and `web` explicit unless extraction clearly improves readability

## Safe verification workflow

For wrapper/API changes:

1. `npm --prefix wrapper/api test`
2. `npm --prefix wrapper/api run build`

Current repo-local baseline:

- `npm run test` is the one-command root test gate for non-browser automation. Its `pretest` hook runs the same dependency bootstrap as the dev launchers, then the test command runs the API build, default API tests, pure web helper tests, test-style guardrails, repo-structure guardrails, and Kubernetes launcher/chart contracts. It intentionally does not run Playwright because those specs require a live browser/app target and, for some managed flows, deliberate mutation opt-in.
- The image-build workflow runs the cheap repo guardrails (`npm run verify:repo-structure` and `npm run verify:test-style`) before image packaging. The API image build still compiles the API inside Docker; full API test runs remain developer/compatibility verification commands, not the image-publish workflow.
- If the full API suite fails with `ERR_MODULE_NOT_FOUND` for upstream Rivet packages such as `ai`, `openai`, or `@ai-sdk/anthropic`, refresh the embedded Rivet dependency baseline with `npm run setup` before treating the failure as a wrapper test regression.
- The test-suite cleanup plan previously lived in the root `tests-refactor.md` working document; after final prune, keep the lasting outcomes in `docs/refactor-history.md` and keep the public verification commands stable for future cleanup.
- API workflow tests should reuse the shared helpers under `wrapper/api/src/tests/helpers/` before adding local harness code. Workflow HTTP harnesses, JSON response handling, recording waiters, filesystem execution cache invalidation probes, temp workflow roots, root-level published-project fixtures, and the filesystem workflow suite bootstrap/cleanup live there.
- The old mixed `workflow-services.test.ts` suite has been split by behavior domain. Put new filesystem tree/import/export coverage in `workflow-filesystem-tree.test.ts`, publication-state and endpoint-reservation coverage in `workflow-publication-filesystem.test.ts`, published-version-history coverage in `workflow-published-history-filesystem.test.ts`, endpoint execution/cache coverage in `workflow-execution-filesystem.test.ts`, and recording route coverage in `workflow-recordings-http.test.ts`.
- The old mixed `managed-backend-sql.test.ts` suite has been split. Put managed schema, folder-move SQL, and execution lookup query contracts in `managed-workflow-schema.test.ts`; put managed publication history, restore, star persistence, and save-target behavior in `managed-publication-history.test.ts`. Schema tests should import the exported SQL string, not read `schema.ts` as source text, so escaping regressions are tested against what the app actually sends to Postgres.
- The old broad `phase4-static-contract.test.ts` suite has been split. Put proxy, Docker image, CI image, and production launcher contracts in `proxy-image-contract.test.ts`; hosted editor wrapper/upstream seam guardrails in `hosted-editor-seams.test.ts`; and Helm/chart topology assertions in `kubernetes-contract.test.ts`.
- `npm --prefix wrapper/api test` intentionally does not run Helm. Use `npm run verify:kubernetes` for Kubernetes launcher tests, Helm-rendered chart contracts, and production overlay lint/template checks.
- `npm run verify:test-style` owns the test-suite style guardrails: root `npm run test` must keep composing the non-browser repo-local gate after the standard `pretest` dependency bootstrap, default API tests must list every non-Kubernetes API test exactly once, `verify:web-pure` must list every pure web test exactly once, `kubernetes-*.test.ts` API files must stay behind `verify:kubernetes`, runnable test/spec files must stay in their expected top-level suite folders, retired or merged-away suites must not come back, `.only` tests are blocked, and wrapper tests/helpers must not assert upstream `rivet/packages/app/src` implementation paths beyond the approved host entry/style seam.
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
4. if the Playwright coverage needs real workflow mutations in `RIVET_STORAGE_MODE=managed`, set `PLAYWRIGHT_ALLOW_MANAGED_MUTATIONS=1` deliberately and keep cleanup explicit; prefer mocked API/browser tests for modal and controller coverage when storage mutation is not the point
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
3. right-click an `unpublished` project in the left panel and run `Delete project`
4. confirm the context-menu action only opens Project Settings and does not delete immediately
5. confirm the project is deleted only after clicking `Delete project` again inside Project Settings
6. right-click a `published` or `unpublished_changes` project and run `Delete project`
7. confirm the UI shows `To delete a project, unpublish it first`
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
9. confirm the renamed row keeps the previous selection/open editor tab by following the returned `movedProjectPaths`
10. try renaming to an existing sibling project name and confirm the preloader clears and the UI shows the API conflict without leaving a stale edit field open
11. open Project Settings separately and confirm there is no modal-level rename button or title edit field

For hosted editor keyboard-node behavior:

1. `npm run dev`
2. validate through `http://localhost:8080` by default, or your configured `RIVET_PORT`
3. open a workflow in the editor iframe and confirm the workflow-library row that opened it does not keep the visible browser focus outline
4. confirm the editor iframe receives keyboard focus after open without showing a visible white perimeter
5. click a node normally and confirm `Ctrl+C`, `Ctrl+X`, and `Ctrl+V` use the internal node clipboard
6. deliberately return focus to the workflow library, then confirm `Shift+click` multi-selection inside the editor reclaims iframe focus and still copies multiple nodes
7. deliberately return focus to the workflow library, then click blank canvas background and confirm `Ctrl+C` / `Ctrl+X` / `Ctrl+V` work again without an extra recovery click on a node
8. open and close an editor context menu or search UI, then confirm `Ctrl+C`, `Ctrl+X`, and `Ctrl+V` still work after returning to the canvas
9. deliberately return focus to the workflow library, then confirm `Ctrl+F` opens Rivet graph search instead of the browser find UI
10. focus the editor iframe/canvas, then confirm `Ctrl+F` still opens Rivet graph search and a physical `KeyF` find shortcut is also prevented from reaching browser find even when `event.key` is not `f`; with a Rivet search field already mounted, confirm the same shortcut focuses that field instead of closing overlays
11. confirm `Ctrl+S` works while focus is inside the workflow iframe, including on Windows browsers
12. confirm `Ctrl+Shift+I` remains browser-owned for DevTools and does not open Rivet's graph import picker
13. confirm the browser can still type normally inside real text inputs and that copy/paste/save/search shortcuts do not hijack active editor form fields

For hosted editor production-image regressions:

1. remember that `npm run prod` and `npm run prod:prebuilt` use pulled images, `npm run prod:restart` keeps already-local images, and `npm run prod:custom` uses your current workspace and `rivet/` folder
2. if dev works but prod does not, diff the behavior against clean upstream `rivet` and move any hosted-only patch into tracked wrapper code before trusting the local result
3. for clipboard regressions specifically, check the tracked hosted overrides for `useCopyNodesHotkeys`, `useContextMenu`, and the canvas focus handoff in `EditorMessageBridge.tsx`

For published-project save status behavior:

1. `npm run dev`
2. validate through `http://localhost:8080` by default, or your configured `RIVET_PORT`
3. publish a workflow project
4. save it with no actual changes and confirm the sidebar stays `Published` without a brief `Unpublished changes` flicker
5. if you are in `managed` mode, also confirm the saved revision id does not change on that no-op save
6. then make a real saved change, save again, and confirm the sidebar updates to `Unpublished changes`

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
7. keep `RIVET_PUBLISHED_WORKFLOWS_BASE_PATH=/workflows` and `RIVET_LATEST_WORKFLOWS_BASE_PATH=/workflows-latest`
8. set `env.RIVET_PROXY_RESOLVER` for in-cluster nginx DNS resolution
9. provide `RIVET_KEY` through `auth.keySecretName` or Vault, even if the optional UI gate and public workflow bearer checks are disabled
10. keep the control-plane API on `RIVET_API_PROFILE=control` and the execution Deployment on `RIVET_API_PROFILE=execution`
11. keep control-plane runtime-library reporting at `RIVET_RUNTIME_LIBRARIES_REPLICA_TIER=none`
12. keep execution-plane runtime-library reporting at `RIVET_RUNTIME_LIBRARIES_REPLICA_TIER=endpoint` with `RIVET_RUNTIME_LIBRARIES_JOB_WORKER_ENABLED=false`
13. if Vault is enabled, make sure the injected `/vault/dotenv` carries the required managed Postgres/object-storage env vars before relying on it instead of Kubernetes secret refs
14. do not scale `proxy` and `execution` as if they were a fixed pair; they are separate deployments with separate pressure profiles
15. define concrete CPU and memory requests for at least `resources.proxy` and `resources.execution` before treating the CPU-based HPAs as production-ready

For managed endpoint latency and cache behavior:

1. run in `RIVET_STORAGE_MODE=managed`
2. call the same trivial published or latest endpoint twice
3. expect the first request after startup or after a publish/save/rename/move to be the cold path
4. expect the second request for the same unchanged workflow to drop onto the warm local path
5. if you enabled `RIVET_WORKFLOW_EXECUTION_DEBUG_HEADERS=true`, confirm `x-workflow-cache` moves from `miss` to `hit` and inspect `x-workflow-resolve-ms` / `x-workflow-materialize-ms`

For endpoint measurement with the dedicated script:

1. run the app in either `RIVET_STORAGE_MODE=filesystem` or `RIVET_STORAGE_MODE=managed`
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
4. confirm `${RIVET_PUBLISHED_WORKFLOWS_BASE_PATH}` reaches the execution-plane API while `${RIVET_LATEST_WORKFLOWS_BASE_PATH}` still reaches the control-plane API
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
  - use this for workflow-storage migration rehearsal, `workflow-storage:verify`, managed endpoint measurement, hosted browser flows, and runtime-library install/remove/readiness checks
  - the current Docker stacks still run the API in the `combined` profile, so they do not prove the real control-plane versus execution-plane split by themselves even though the route families are still exposed at their normal published/latest paths
- live Kubernetes validation:
  - proves the real split topology, ingress/proxy behavior, control-plane versus execution-plane routing, restart boundaries, and execution scaling
  - do not treat chart render success or Docker rehearsal as a substitute for this layer when the question is about real in-cluster behavior

Current follow-up expectations:

- if a change touches migration, cutover, or recording durability, run the managed Docker rehearsal instead of trusting repo-local proof alone
- if a change touches runtime-library readiness UI, prefer adding direct UI coverage and still validate the modal against the managed stack because backend aggregation tests do not fully prove the rendered browser state
- if a change touches the control-plane versus execution-plane boundary, finish with live Kubernetes validation in an isolated namespace

## Compatibility verification commands

Use the current compatibility commands intentionally:

- the repo-local test portions scrub ambient runtime-root, managed-storage, execution-route, runtime-library, and recording env such as `RIVET_WORKFLOWS_ROOT`, `RIVET_ARTIFACTS_HOST_PATH`, `RIVET_DATABASE_CONNECTION_STRING`, `RIVET_STORAGE_URL`, `RIVET_PUBLISHED_WORKFLOWS_BASE_PATH`, and `RIVET_ENV_FILE` before spawning API tests, so local `.env` or shell state cannot redirect those tests into a real workflow folder, database, object store, route prefix, runtime-library role, or recording policy
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

- use the managed Docker rehearsal for migration/import, hosted editor parity, runtime-library install/remove/readiness checks, and endpoint measurement
- use Kubernetes for real split-topology routing, restart, and scaling proof
