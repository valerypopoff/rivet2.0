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

Implemented platform matrix:

- `proxy`: `linux/amd64`, `linux/arm64`
- `web`: `linux/amd64`, `linux/arm64`
- `api`: `linux/amd64`
- `executor`: `linux/amd64`

Rivet source is bootstrapped by `npm run setup:rivet`, which uses
`scripts/bootstrap-rivet.mjs` to clone `RIVET_REPO_URL` at `RIVET_REPO_REF`.
The workflow currently defaults to:

```text
RIVET_REPO_URL=https://github.com/valerypopoff/rivet2.0.git
RIVET_REPO_REF=main
```

The Docker builds for Rivet-consuming images receive two named contexts:

```text
rivet_source=.data/docker-contexts/rivet-source
rivet_dependency_metadata=.data/docker-contexts/rivet-dependency-metadata
```

`proxy` does not receive a Rivet build context.
Both filtered contexts carry `.upstream-version` when the bootstrapped Rivet
source has it, so build-stage diagnostics can still identify the upstream
snapshot.

Local Docker launchers use the same filtered Rivet source and dependency
metadata snapshots, prepared by `scripts/lib/rivet-source-context.mjs`.
The GitHub image workflow now prepares those contexts before each
Rivet-consuming image build.

## Diagnosis

The expensive work is repeated across image jobs:

- Before this implementation, `setup:rivet` ran in every matrix job, including
  `proxy`, even though `proxy` does not use Rivet.
- `api`, `web`, and `executor` each run their own Rivet `yarn install`.
- `@valerypopoff/rivet2-core` is built in all three Rivet-consuming images.
- `@valerypopoff/rivet2-node` is built in both `api` and `executor`.
- Buildx cache is scoped by service, so shared Rivet layers are not shared
  across `api`, `web`, and `executor`.
- Before this implementation, the `api` image built for `linux/arm64`; recent
  logs showed the QEMU arm64 Rivet install/link step was both slow and fragile.
- Before this implementation, Dockerfiles copied full Rivet source before
  `yarn install`, so ordinary source changes could invalidate the expensive
  dependency install layer.
- Before this implementation, the publish workflow passed
  `build-contexts: rivet_source=./rivet` to every service build. If `proxy`
  skipped Rivet bootstrap while that input still pointed at a missing `./rivet`
  directory, the Buildx step could fail before the proxy Dockerfile had a
  chance to ignore that context.

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

## Phase 0: DONE - Baseline And Contract Audit

Status: Done.

Implementation notes:

- The image matrix, contract tests, Kubernetes docs, and Docker launcher paths
  were audited together.
- The selected published platform contract is `proxy` and `web` multi-arch,
  with `api` and `executor` on `linux/amd64`.
- The pre-change failure evidence is the QEMU arm64 API `yarn install`/link
  crash from the GitHub image workflow logs. Keep collecting plain-progress
  timing logs from subsequent workflow runs to measure the cache impact.

Capture the current state before changing build structure.

1. Save one plain-progress GitHub Actions log for the current slow image build.
   - Done from the failing workflow evidence already captured in the issue
     thread; keep a fresh post-change log after this lands.
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
4. Record the intended contract:
   - `proxy`, `web`: `linux/amd64`, `linux/arm64`
   - `api`, `executor`: `linux/amd64`

Acceptance checks:

- The plan's "Current Build Shape" matches the actual workflow at the start of
  implementation.
- The contract test and Kubernetes docs are identified as required changes for
  any platform-matrix edit.

## Phase 1: DONE - Low-Risk CI Fixes

Status: Done.

Implementation notes:

- `.github/workflows/build-images.yml` has an explicit `needsRivet` matrix
  field.
- `proxy` skips `setup:rivet`, skips Rivet context preparation, and uses a
  Buildx step with no Rivet build contexts.
- `api` is `linux/amd64` only, matching `executor` and avoiding the fragile
  QEMU arm64 API build path.
- QEMU setup is conditional on matrix platforms that include `linux/arm64`.

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

## Phase 2: DONE - Docker Dependency Layering

Status: Done.

Implementation notes:

- `scripts/lib/rivet-source-context.mjs` now prepares both
  `.data/docker-contexts/rivet-source` and
  `.data/docker-contexts/rivet-dependency-metadata`.
- Rivet-consuming Dockerfiles install Yarn dependencies from
  `rivet_dependency_metadata` before copying full `rivet_source`.
- API and web wrapper dependency layers now copy package manifests before
  source.
- Docker Compose and local Kubernetes image builds pass both named contexts.
- The dependency-metadata context copies root dependency files plus
  `package.json` files from declared Yarn workspaces only, so unrelated local
  scratch manifests in an upstream checkout do not invalidate the install
  layer.

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
  context. That helper can copy declared workspace `package.json` files while still
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

## Phase 3: DONE - Release Reproducibility

Status: Done.

Implementation notes:

- `scripts/bootstrap-rivet.mjs` supports exact commit SHAs by initializing a
  temporary checkout and fetching the resolved commit directly.
- The image workflow resolves `RIVET_REPO_REF` to an exact upstream commit
  before the matrix build.
- Rivet-consuming image builds run `setup:rivet` with the resolved commit SHA.
- Image metadata includes the upstream Rivet source, requested ref, and exact
  resolved revision.

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

## Phase 4: DEFERRED - Shared Rivet Build Artifacts

Status: Deferred by this plan.

Do not implement this phase until the simpler CI/platform/layering changes
have produced at least one cold build and one warm no-source-change build log.
The phase remains the next structural optimization candidate if repeated
`core`/`node`/`trivet` builds still dominate after cache behavior improves.

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

## Phase 5: DONE - Upstream Contract Adoption

Status: Done.

Implementation notes:

- Upstream Rivet now provides wrapper-facing scripts through
  `scripts/build-wrapper-target.mjs`.
- The filtered `rivet_source` context now includes that script and validates
  that the selected upstream ref provides it before Docker starts building.
- API images call `yarn build:runtime` for `core + node`.
- Web images call `yarn build:hosted-web-deps` for `core + trivet`.
- Executor images call `yarn build:runtime` for `core + node`, then keep the
  wrapper Docker-specific app-executor bundle-only step. Do not switch the
  Docker executor image to `yarn build:executor-runtime` unless the image needs
  native app-executor sidecar binaries; that upstream target also creates
  platform-specific native artifacts and must run on the target platform.
- Exact-checkout artifact helper adoption remains covered by Phase 4 because it
  is a larger CI topology change that should follow timing evidence.

Available upstream additions:

- `build:runtime`: build only `core + node`.
- `build:hosted-web-deps`: build only `core + trivet`.
- `build:executor-runtime`: build `core + node + app-executor`; available for
  future native sidecar/image artifact flows, not used by the current Docker
  executor image.
- `build:npm-public`: build `core + node + trivet + cli`.
- Extended `scripts/create-built-package-artifacts.mjs` support for runtime,
  hosted-web-deps, executor-runtime, wrapper, and custom include targets. The
  wrapper has not adopted this helper yet; that remains part of the deferred
  shared-artifact/base-image work in Phase 4.
- Documentation of wrapper-facing build contracts:
  - API endpoint runtime needs built `core + node`.
  - Hosted web/editor needs app source plus `core + trivet`.
  - Executor needs app-executor plus `core + node`.

Acceptance checks:

- Wrapper Dockerfiles no longer hardcode Rivet workspace build order for
  `core`, `node`, or `trivet`.
- Contract tests assert the upstream minimal build scripts stay wired.
- The executor Dockerfile preserves the bundle-only app-executor path until a
  native sidecar artifact flow is intentionally adopted.

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
5. Adopt upstream minimal build scripts where they fit the current image
   contract.
6. Use post-change timing logs to decide whether shared Rivet artifacts or a
   reusable base image are worth the larger CI topology change.

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
