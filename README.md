# Rivet Studio Server

This repo exists because [Rivet 2](https://github.com/valerypopoff/rivet2.0) does not provide a cloud-hosted platform for editing workflows and serving them directly as hosted endpoints.

A typical workflow is manual: install the desktop Rivet app, build the workflow locally, move the `.rivet-project` file into your own backend, write custom code to execute it, and build your own server layer if you want to expose that workflow as an HTTP endpoint. Updating a workflow then usually means going back to a local machine, editing it there, shipping the changed file again, and redeploying the backend that serves it.

Rivet Studio Server is a self-hosted personal Rivet platform with a UI that you can run on a VM or locally. It gives you both a browser-based Rivet editor and a server that can publish workflows as endpoints with no coding required, just a UI.
- Rivet editor: runs right in the browser
- Rivet project manager: create and reorganize folders and Rivet projects in the UI
- Publishing workflows as endpoints in one click - no coding required
- Run recordings browser: inspect stored workflow runs, filter by recorded input, and replay a run in the editor
- Remote debugger: set up and ready to go
- Runtime libraries manager: install libraries through the UI for use in the Rivet "Code" node
- Security: built-in authentication and authorization for both the Studio UI and workflow endpoints (See "Optional external UI gate")

![Rivet Studio Server main screenshot](docs/img/main.PNG)


## Additional docs

- [Architecture](./docs/architecture.md)
- [Access and routing](./docs/access-and-routing.md)
- [Development](./docs/development.md)
- [Kubernetes](./docs/kubernetes.md)
- [Repo structure](./docs/repo-structure.md)
- [Editor bridge](./docs/editor-bridge.md)
- [Workflow publication](./docs/workflow-publication.md)
- [Runtime libraries](./docs/runtime-libraries.md)
- [Wrapper ManagedCodeRunner speed plan](./docs/wrapper-managed-code-runner-speed-plan.md)
- [Refactor history](./docs/refactor-history.md)

## Repository Map

- `wrapper/`
  - application code, hosted overrides, shared browser/server contracts, executor packaging, and runtime bootstrap under `wrapper/bootstrap/`
- `image/`
  - canonical image build definitions and shared proxy-image assets
- `ops/`
  - deployment-only assets:
    - `ops/compose/` for Docker Compose stacks
    - `ops/docker/` for Compose-only Dockerfiles
    - `ops/nginx/` for Compose-only proxy templates
- `charts/`
  - the Helm chart and overlays
- `scripts/`
  - root launcher, verification, and bootstrap commands
- `docs/`
  - contributor and operator documentation
- `.github/`
  - CI workflows
- `rivet/`
  - upstream input, treated as read-only in this repo; it can be a real checkout/snapshot or a local symlink/junction to one

## Root Working Docs

The repo root stays intentionally small. Root Markdown is reserved for:

- `README.md`
- `AGENTS.md`
- the current tracked working-doc baseline:
  - `backlog.md`
  - `image-build-optimization-plan.md`

Reference documentation lives under `docs/`, not at the repo root.

## Tooling Notes

- the root repo uses `npm run ...` as the supported command surface
- upstream `rivet/` still uses Yarn internally where the wrapper needs it
- `npm run setup:k8s-tools` installs the pinned cached Helm binary under `.data/tools/helm/`
- `RIVET_K8S_HELM_BIN` overrides Helm resolution for the Kubernetes launchers and verification scripts
- ordinary launcher and verification flows do not silently download Helm; they use an existing override, system install, or cached copy and otherwise fail with setup instructions

## Quick Start

### Prerequisites

- Node.js 24+ and npm for host-based setup/tests; Docker images carry their own runtime
- Git
- Docker and Docker Compose

### Deploy

```bash
npm run prod
```

`npm run prod` pulls the prebuilt Rivet 2 wrapper images from `ghcr.io`, force-recreates the Docker stack, and waits for the services to become healthy. This is the normal VM deployment/update path and does not build from the local checkout.

If the stack is already running and you only changed `.env`, use:

```powershell
npm run prod:restart
```

That recreates the production containers from the images already present on the machine, so the new environment values are picked up without pulling newer GHCR images.

Access the app at `http://localhost:8080` unless `RIVET_PORT` changes it.

If `npm run prod:prebuilt` or `docker compose pull` returns `denied` for the public GHCR images, clear any stale saved registry credentials first:

```bash
docker logout ghcr.io
```

Public images should pull anonymously. Old or invalid cached Docker credentials for `ghcr.io` can cause authenticated requests to fail even when the package itself is public.

For direct container diagnostics, use Docker Compose with the production files:

```bash
docker compose --env-file .env -f ops/compose/docker-compose.managed-services.yml -f ops/compose/docker-compose.yml ps
docker compose --env-file .env -f ops/compose/docker-compose.managed-services.yml -f ops/compose/docker-compose.yml logs -f --tail=120 proxy web api executor
```

To pin a specific image tag, set `RIVET_IMAGE_TAG` or override `RIVET_PROXY_IMAGE`, `RIVET_WEB_IMAGE`, `RIVET_API_IMAGE`, or `RIVET_EXECUTOR_IMAGE` in `.env`.

#### Explicit variants

| Command | Behaviour |
|---|---|
| `npm run prod` | Pull and run the prebuilt `cloud-hosted-rivet2-wrapper/*` images |
| `npm run prod:prebuilt` | Same as `npm run prod`, kept as the explicit published-image path |
| `npm run prod:restart` | Recreate production containers from already-local images without pulling |
| `npm run prod:custom` | Build and run images from this wrapper checkout plus the current `rivet/` folder |
| `npm run clean` | Prune Docker stopped containers, unused networks, unused images, and BuildKit cache without pruning volumes |

Run `npm run clean` when the VM is low on disk space or `npm run prod` fails with `ENOSPC`. This is a Docker-host cleanup, so it can remove stopped containers and unused images for any project on that Docker host. It does not run `docker volume prune`, `docker system prune`, or any `--volumes` cleanup, so Compose-managed Postgres/app-data volumes and filesystem workflow mounts are left alone. It can remove unused images and build cache, so a later `npm run prod` may need to pull images again if the stack is stopped, and a later custom/dev build may rebuild more layers.

#### Building locally from upstream Rivet source

If you need a custom local build, first make sure the upstream Rivet source is available in `./rivet`:

```bash
npm run setup:rivet
```

The script downloads the configured Rivet 2 source ref. By default that is `https://github.com/valerypopoff/rivet2.0.git` at `main`; override it with `RIVET_REPO_URL` and `RIVET_REPO_REF` when rehearsing another fork, branch, tag, or exact commit SHA.

If `./rivet` is a symlink or Windows junction to another checkout, the repo launchers resolve that link to its real host path for dev bind mounts. Local Docker image builds use a filtered source snapshot at `.data/docker-contexts/rivet-source` and a dependency-metadata snapshot at `.data/docker-contexts/rivet-dependency-metadata`, so large upstream working trees do not send `node_modules`, VCS data, or Yarn caches into BuildKit and source-only changes do not invalidate the Rivet install layer. Direct `docker build` commands need both build contexts explicitly; run `npm run dev:docker:prepare-rivet-context`, then use a command such as `docker build --build-context rivet_source=.data/docker-contexts/rivet-source --build-context rivet_dependency_metadata=.data/docker-contexts/rivet-dependency-metadata -f image/api/Dockerfile .`.

To replace an existing non-empty `rivet/` directory:

```bash
npm run setup:rivet -- --force
```

Then start the local build:

```bash
npm run prod:custom
```

### Development with Docker

From the repo root:

`npm run dev`

Useful follow-up commands:

```bash
npm run dev:docker:ps
npm run dev:docker:logs
npm run dev:docker:prepare-rivet-context
npm run dev:down
```

### Kubernetes shape

The supported Kubernetes topology today is:

- `proxy`: scalable
- `execution`: scalable
- `web`: fixed at `1` by default
- `backend`: fixed at `1`

That is intentional:

- published workflow endpoint traffic is meant to scale on `execution`
- `proxy` remains a separate ingress tier and does not need to scale one-for-one with `execution`
- `web` only serves the dashboard/editor shell and can stay single-replica when UI traffic is just one operator
- `backend` stays singleton because latest execution and `/ws/latest-debugger` are still process-local control-plane features

For the real chart contract, local Kubernetes rehearsal, production image repositories, and the Helm handoff checklist, see [docs/kubernetes.md](./docs/kubernetes.md).

## Runtime shape

```text
Browser -> nginx (proxy)
           |- / -> web
           |- /api/* -> control-plane api
           |- /workflows/* -> execution-plane api
           |- /workflows-latest/* -> control-plane api
           |- /ws/latest-debugger -> control-plane api
           `- /ws/executor* -> executor
```

Internally, the wrapper now keeps the major ownership seams explicit:

- workflow-managed backend code is split into a thin facade plus focused modules under `wrapper/api/src/routes/workflows/managed/`
- managed runtime-library orchestration is split into focused modules under `wrapper/api/src/runtime-libraries/managed/`
- dashboard-heavy UI state now lives in controller/helpers under `wrapper/web/dashboard/`
- editor-side Node execution uses Rivet 2.0's `RivetAppHost` external executor seam instead of wrapper-owned remote-executor hook overrides
- the executor container binds its websocket server to `0.0.0.0:21889` inside Docker so the proxy can reach it as the separate `executor` service; browser access still goes through `/ws/executor*` on the proxy
- endpoint/API workflow execution imports `@valerypopoff/rivet2-node` through a package-name seam, while setup and image builds link that package to the embedded `rivet/` source tree so replacing `rivet/` upgrades both editor-side and server-side execution

## Security

- filesystem access is restricted to configured roots
- env var access is allowlist-only
- shell commands are allowlist-only
- path traversal is rejected on path parameters

### Optional external UI gate

- set `RIVET_KEY` to the shared secret
- use `Settings` -> `Workflow endpoints` -> `Access control` to require `Authorization: Bearer <RIVET_KEY>` on workflow execution routes; it is enabled by default
- set `RIVET_REQUIRE_UI_GATE_KEY=true` to gate the browser UI and related websockets
- set `RIVET_UI_TOKEN_FREE_HOSTS` for hosts that should bypass the UI gate
