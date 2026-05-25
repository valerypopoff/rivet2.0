# Image Build Optimization Plan

## Purpose

Reduce GitHub Actions image build time and improve build reliability for the
Rivet Studio Server wrapper images without changing runtime behavior.

The current bottleneck is repeated upstream Rivet bootstrap, dependency
installation, and package build work across image jobs. Wrapper TypeScript and
application code are not the main cost.

## Current Build Shape

The GitHub Actions workflow is `.github/workflows/build-images.yml` and builds
four images:

- `proxy`: `image/proxy/Dockerfile`
- `web`: `image/web/Dockerfile`
- `api`: `image/api/Dockerfile`
- `executor`: `image/executor/Dockerfile`

Current platform matrix:

- `proxy`: `linux/amd64`, `linux/arm64`
- `web`: `linux/amd64`, `linux/arm64`
- `api`: `linux/amd64`, `linux/arm64`
- `executor`: `linux/amd64`

Rivet source is bootstrapped by `npm run setup:rivet`, which uses
`scripts/bootstrap-rivet.mjs` to clone `RIVET_REPO_URL` at `RIVET_REPO_REF`.
The workflow currently defaults to:

```text
RIVET_REPO_URL=https://github.com/valerypopoff/rivet2.0.git
RIVET_REPO_REF=main
```

The Docker builds receive the checked-out source as the named build context
`rivet_source=./rivet`.

Local Docker launchers use a filtered Rivet source snapshot under
`.data/docker-contexts/rivet-source`, prepared by
`scripts/lib/rivet-source-context.mjs`. The GitHub image workflow currently
does not use that helper; it passes the freshly bootstrapped `./rivet`
directory directly as `rivet_source`.

## Diagnosis

The expensive work is repeated across image jobs:

- `setup:rivet` runs in every matrix job, including `proxy`, even though
  `proxy` does not use Rivet.
- `api`, `web`, and `executor` each run their own Rivet `yarn install`.
- `@valerypopoff/rivet2-core` is built in all three Rivet-consuming images.
- `@valerypopoff/rivet2-node` is built in both `api` and `executor`.
- Buildx cache is scoped by service, so shared Rivet layers are not shared
  across `api`, `web`, and `executor`.
- The `api` image currently builds for `linux/arm64`; recent logs showed the
  QEMU arm64 Rivet install/link step is both slow and fragile.
- Dockerfiles copy full Rivet source before `yarn install`, so ordinary source
  changes can invalidate the expensive dependency install layer.
- The publish workflow passes `build-contexts: rivet_source=./rivet` to every
  service build. If `proxy` skips Rivet bootstrap while this input still points
  at a missing `./rivet` directory, the Buildx step can fail before the
  proxy Dockerfile has a chance to ignore that context.

## Desired Ownership Split

Wrapper-owned improvements:

- CI matrix and platform policy.
- Dockerfile layer structure.
- Buildx cache scope and artifact reuse.
- Exact Rivet ref pinning for wrapper release images.
- Optional shared Rivet artifact/base-image flow.

Upstream Rivet improvements:

- Smaller documented build targets for wrapper-facing use cases.
- Exact-commit built artifacts for `core`, `node`, and optionally `trivet`.
- A documented build-time benchmark recipe for install/build phases.

## Phase 0: Baseline And Contract Audit

Status: Pending

Capture the current state before changing build structure.

1. Save one plain-progress GitHub Actions log for the current slow image build.
2. Record current timings for:
   - Rivet bootstrap.
   - Rivet Yarn install.
   - `core` build.
   - `node` build.
   - `trivet` build.
   - app-executor bundle.
   - wrapper npm install.
   - wrapper build.
   - final image packaging.
3. Reconcile the current image platform contract across:
   - `.github/workflows/build-images.yml`
   - `wrapper/api/src/tests/proxy-image-contract.test.ts`
   - `docs/kubernetes.md`
4. Record whether the intended contract is:
   - `proxy`, `web`, `api`: `linux/amd64`, `linux/arm64`; `executor`:
     `linux/amd64`
   - or `proxy`, `web`: `linux/amd64`, `linux/arm64`; `api`, `executor`:
     `linux/amd64`

Acceptance checks:

- The plan's "Current Build Shape" matches the actual workflow at the start of
  implementation.
- The contract test and Kubernetes docs are identified as required changes for
  any platform-matrix edit.

## Phase 1: Low-Risk CI Fixes

Status: Pending

1. Skip Rivet bootstrap for `proxy`.
   - `proxy` does not consume the `rivet_source` build context.
   - Keep repo structure and test-style verification unchanged.
   - Add an explicit matrix field such as `needsRivet: false` for `proxy`.
   - Do not pass `build-contexts: rivet_source=./rivet` to `proxy` unless the
     workflow also creates a harmless existing context directory for it. The
     cleaner fix is a separate conditional Buildx step or conditional
     `build-contexts` input for Rivet-consuming services only.

2. Decide whether `api` can become `linux/amd64` only.
   - `executor` is already `linux/amd64` only.
   - If production deployments are amd64-only, this avoids the fragile QEMU
     arm64 API build path.
   - Update Kubernetes/operator docs and image contract tests if the platform
     matrix changes.
   - If `api` must stay multi-arch, treat that as a separate build-path task:
     avoid QEMU for the expensive Rivet install/build path or use native arm64
     runners. Do not keep the current QEMU path just because the manifest
     contract says multi-arch.

3. Keep QEMU setup scoped to builds that actually need non-native platform
   execution.
   - `proxy` and `web` still need it while they remain multi-arch on an
     amd64 GitHub runner.
   - `executor` does not need it while it remains amd64-only.

Acceptance checks:

- `proxy` image build does not run `npm run setup:rivet`.
- `proxy` image build does not require `./rivet` to exist.
- Published platform docs match `.github/workflows/build-images.yml`.
- `wrapper/api/src/tests/proxy-image-contract.test.ts` matches the chosen
  platform matrix.
- `npm run verify:repo-structure`
- `npm run verify:test-style`

## Phase 2: Docker Dependency Layering

Status: Pending

Split dependency-install layers from source-copy layers.

For Rivet-consuming images:

1. Copy only dependency metadata first:
   - root `package.json`
   - `yarn.lock`
   - `.yarnrc.yml`
   - `.yarn/releases`
   - `.yarn/patches`
   - workspace `package.json` files needed by the install
2. Run `YARN_NODE_LINKER=node-modules yarn install`.
3. Copy full Rivet source.
4. Run the required workspace builds.

Implementation note:

- Avoid hand-maintaining a fragile list of all workspace manifests directly in
  three Dockerfiles. Prefer extending `scripts/lib/rivet-source-context.mjs` or
  adding a sibling helper that prepares a small Rivet dependency-metadata
  context. That helper can copy all workspace `package.json` files while still
  excluding source, build output, dependency folders, VCS data, and Yarn cache
  artifacts.
- Keep GitHub Actions and local Docker launchers aligned. If CI starts using a
  filtered or split Rivet context, update the local launcher path too so local
  `prod:custom`, `dev:docker`, and `dev:kubernetes-test` exercise the same
  contract.

For wrapper packages:

- `api`: copy API package manifests before `npm ci`, then copy API/shared
  source after dependencies are installed.
- `web`: copy web package manifests before `npm install`, then copy web/shared
  source after dependencies are installed.
- Do not copy all of `wrapper/` before the web dependency install. That makes
  API/executor/shared changes invalidate the web npm layer even when
  `wrapper/web/package-lock.json` did not change.

Acceptance checks:

- A non-lockfile source-only Rivet change does not invalidate the Yarn install
  layer.
- A wrapper source-only change does not invalidate wrapper npm dependency
  install layers.
- Image builds still work from GitHub Actions and local Docker contexts.

## Phase 3: Release Reproducibility

Status: Pending

Pin Rivet image builds by exact commit SHA for release/published image builds.

Development can still use `RIVET_REPO_REF=main`, but release builds should use
an immutable ref so caches and image contents are reproducible.

Implementation options:

- Update `scripts/bootstrap-rivet.mjs` to support commit SHAs explicitly. The
  current clone path uses `git clone --depth 1 --branch <ref>`, which is safe
  for branches/tags but not a complete arbitrary-SHA checkout strategy.
- Set `RIVET_REPO_REF` to a specific commit SHA in the workflow for release
  builds after the bootstrap script supports it.
- Make the workflow fail if publishing `latest` from `main-rivet2` without an
  explicit resolved Rivet SHA in image labels.
- Keep `.upstream-version` inside the bootstrapped `rivet/` source so image
  provenance can be inspected later.

Acceptance checks:

- Image labels or build logs show the exact upstream Rivet commit.
- Re-running the same wrapper commit with the same Rivet SHA uses cache more
  predictably.

## Phase 4: Shared Rivet Build Artifacts

Status: Pending

Add a shared Rivet artifact or base-image flow after the simpler cache fixes
land.

Possible shapes:

- Build one reusable Rivet base image keyed by exact Rivet commit SHA.
- Or add a CI job that bootstraps Rivet once, builds the needed artifacts, and
  uploads them for image jobs.

Required artifacts by image:

- `api`: built `core` and `node`, plus Rivet `node_modules`.
- `executor`: built `core` and `node`, plus app-executor bundle inputs.
- `web`: app source, built/usable `core`, and built/usable `trivet`.

Platform boundary:

- Treat Rivet `node_modules` and any native/transpiled outputs as
  platform-sensitive unless proven otherwise.
- If `api` remains multi-arch, the shared artifact/base-image key must include
  the target platform or the build must run on native builders for each target.
- If `api` becomes amd64-only, the first shared-artifact version can stay
  simpler because both `api` and `executor` consume amd64 Node runtime
  artifacts, while `web` emits static browser assets.

Acceptance checks:

- `core` is not built independently in all three image jobs.
- `node` is not built independently in both `api` and `executor`.
- Artifact/base-image cache key includes exact Rivet commit SHA and lockfile
  identity.
- Image jobs fail clearly if artifact and source revisions do not match.

## Phase 5: Upstream Contract Adoption

Status: Waiting On Upstream

Adopt upstream minimal build scripts/artifacts when available.

Useful upstream additions:

- `build:runtime`: build only `core + node`.
- `build:hosted-web-deps`: build only `core + trivet`.
- `build:npm-public`: build `core + node + trivet + cli`.
- Extended `scripts/create-built-package-artifacts.mjs` support for `trivet`.
- Documentation of wrapper-facing build contracts:
  - API endpoint runtime needs built `core + node`.
  - Hosted web/editor needs app source plus `core + trivet`.
  - Executor needs app-executor plus `core + node`.

## Timing Evidence To Capture

For each slow image, collect plain-progress logs and split timing into:

- Rivet bootstrap.
- Rivet Yarn install.
- `core` build.
- `node` build.
- `trivet` build.
- app/app-executor build or bundle.
- wrapper npm install.
- wrapper build.
- final image packaging.

Keep at least one cold build and one no-source-change rebuild log after each
phase.

The timing log should also state whether each Buildx step used:

- `cache-from: type=gha`
- a warm BuildKit cache mount
- a cache hit for the dependency install layer
- a cache hit for the workspace build layer

This prevents a false win where one run is faster only because the GitHub cache
happened to be warm.

## Recommended Order

0. Capture baseline timings and reconcile the current platform contract.
1. Skip Rivet bootstrap and Rivet build context for `proxy`.
2. Decide and document whether `api` should be amd64-only.
3. Split Docker dependency layers.
4. Teach `setup:rivet` to support exact SHA checkout and pin release builds.
5. Add shared Rivet artifacts or a reusable base image.
6. Adopt upstream minimal build scripts/artifacts when available.

## Do Not Do Yet

- Do not add a shared Rivet artifact/base image before the simpler cache and
  platform-contract fixes are measured. It is the largest structural change and
  should pay for itself with evidence.
- Do not make `proxy` depend on a placeholder Rivet checkout just to avoid
  conditional Buildx inputs. That would hide the real ownership boundary.
- Do not hand-maintain workspace manifest lists in multiple Dockerfiles if a
  small generated dependency context can keep the list accurate.
- Do not pin `RIVET_REPO_REF` to an arbitrary SHA until
  `scripts/bootstrap-rivet.mjs` can actually fetch arbitrary SHAs reliably.
