# Repository Structure

Rivet Studio Server is part of the Rivet monorepo. This document defines where
its code and deployment assets belong and which root-level systems it shares
with the public Rivet packages in the same workspace graph.

## Top-Level Map

- `packages/`
  - public Rivet packages and the five private Studio Server workspaces
- `deploy/studio-server/`
  - images, Docker Compose files, Helm chart, launchers, fixtures, and
    deployment verification
- `developer-docs/studio-server/`
  - Studio Server architecture, contributor, operator, audit, and migration
    documentation
- `.github/workflows/studio-server-*.yml`
  - Studio Server verification and image publication
- `scripts/`
  - shared Rivet monorepo build and policy scripts

Generated or local runtime data belongs under ignored roots such as `.data/`,
`artifacts/`, and local workflow/recording directories. It must not be added to
package or deployment source trees.

## Studio Server Workspaces

- `packages/studio-server-api/`
  - API profiles, settings, workflow storage and execution, publication,
    recordings, runtime libraries, auth, and guarded host capabilities
- `packages/studio-server-web/`
  - dashboard, hosted editor entrypoint, shared-editor aliases, browser
    shims, pure tests, and Playwright specs
- `packages/studio-server-executor/`
  - packaged Node executor websocket service
- `packages/studio-server-shared/`
  - contracts shared by browser and server packages
- `packages/studio-server-bootstrap/`
  - deployment bootstrap imported before API and executor processes

The packages are private and use the normal root Yarn workspace. Dependencies
on Rivet or another Studio Server package use `workspace:^`. Do not add nested
lockfiles, nested package managers, generated package links, or a second copy
of Rivet source.

## Deployment Ownership

`deploy/studio-server/images/` owns canonical production Dockerfiles and their
runtime assets. Every image builds from the monorepo root context so package
manifests, the root lockfile, and source all come from the same Git commit.

`deploy/studio-server/compose/` owns Docker Compose topology and Compose-only
proxy/Dockerfile assets. Runtime bootstrap code does not belong here.

`deploy/studio-server/helm/` owns the Kubernetes chart and environment
overlays. `deploy/studio-server/scripts/` owns Studio Server launchers, local
Kubernetes gates, and deployment verification. Shared monorepo build tooling
continues to live under the root `scripts/` directory.

Linux shell scripts are LF-normalized by the root `.gitattributes` file.

## Documentation Ownership

Reference and operator documentation belongs under
`developer-docs/studio-server/`. The deployment README is the short entrypoint
for operators. Root Markdown follows the existing Rivet repository policy; do
not add Studio Server working documents at the root.

## Commands

Use the root Yarn command surface:

```bash
yarn studio-server:build
yarn studio-server:test
yarn studio-server:verify:host-compatibility
yarn studio-server:verify:migration-ledger
yarn studio-server:verify:repo-structure
yarn studio-server:verify:test-style
yarn studio-server:verify:kubernetes
```

Use `yarn workspace <workspace-name> run <script>` only for a focused package
check. There is one root `yarn.lock` and the root-pinned Yarn release is the
only supported dependency installer.

The root preinstall guard rejects npm and pnpm dependency installation with the
fresh-machine recovery commands. The repository structure verifier also rejects
secondary `yarn.lock`, `package-lock.json`, and
pm-shrinkwrap.json` files,
per-workspace package-manager declarations, ambiguous root production aliases,
and root or workspace scripts that dispatch monorepo work through
pm run`
or
pm --prefix`.

The intentional npm boundaries are narrower than dependency management for the
monorepo: npm-registry publication, isolated synthetic Code-node runtime-library
installation, and the exactly pinned static web-image helper.

Helm resolution order for repository tooling is:

1. `RIVET_K8S_HELM_BIN`
2. system `helm`
3. the cached Helm binary under `.data/tools/helm/`

Install the pinned cached binary with
`yarn studio-server:setup:k8s-tools` when needed.

## Guardrails

- keep hosted product behavior in the owning Studio Server workspace
- prefer existing public Rivet package seams; change an upstream package when
  the behavior genuinely belongs to Rivet itself
- keep shared browser/server contracts in `studio-server-shared`
- keep route modules thin and domain logic in focused services/helpers
- keep image definitions, Compose topology, Helm, and launchers in their
  deployment subdirectories
- do not reintroduce clone/ref bootstrap variables, package-link overlays,
  nested installs, or dual-repository Git labels
- keep `deploy/studio-server/migration/source-file-ledger.json` fresh when a
  migration-era destination is deliberately moved or retired; record its reviewed
  current successor and reason while retaining the original blob proof
- keep test manifests explicit and protected by the repository verifiers

The monorepo migration and history-preservation details are recorded in
[monorepo-migration.md](./monorepo-migration.md).
