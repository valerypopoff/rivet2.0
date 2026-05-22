# Repo Structure

This document defines the intended authored structure of the repo after the post-refactor cleanup.

## Top-level map

- `wrapper/`
  - application code and runtime/bootstrap code
- `image/`
  - canonical image build definitions and shared proxy-image runtime assets
- `ops/`
  - deployment-only assets
- `charts/`
  - Helm chart and overlays
- `scripts/`
  - root launchers, verification, and bootstrap helpers
- `docs/`
  - contributor and operator documentation
- `.github/`
  - CI workflows
- `rivet/`
  - upstream source input; treat as read-only in this repo

Non-authored local/generated roots include:

- `.data/`
- `artifacts/`
- `.claude/`
- `node_modules/`
- `workflows/` when used as a local filesystem-mode runtime root

## What belongs in `wrapper/`

- `wrapper/api/`
  - hosted API source
- `wrapper/web/`
  - dashboard, hosted editor overrides, Playwright-facing browser code
- `wrapper/shared/`
  - browser/server contracts
- `wrapper/executor/`
  - executor packaging and build helpers
- `wrapper/bootstrap/`
  - runtime/bootstrap code used by containerized API and executor processes

Runtime/bootstrap code belongs under `wrapper/bootstrap/`, not under `ops/`.

## What belongs in `image/`

`image/` is the canonical source for image build definitions and shared image runtime assets.

Examples:

- `image/api/Dockerfile`
- `image/executor/Dockerfile`
- `image/web/Dockerfile`
- `image/proxy/Dockerfile`
- shared proxy-image assets such as:
  - `image/proxy/default.conf.template`
  - `image/proxy/ui-gate-prompt.html`
  - `image/proxy/normalize-workflow-paths.sh`

Compose-only proxy templates do not belong here if they are specific to the local Docker topology.

Proxy shell scripts run inside Linux containers, so they must stay LF-normalized even on Windows checkouts. The root `.gitattributes` pins `*.sh` files to `eol=lf` for that reason.

## What belongs in `ops/`

`ops/` is deployment-only.

Current subdomains:

- `ops/compose/`
  - Docker Compose stacks
- `ops/docker/`
  - Compose-only Dockerfiles
- `ops/nginx/`
  - Compose-only nginx templates

`ops/` should not contain:

- runtime bootstrap packages
- executor build logic
- upstream-compatibility maintenance scripts
- duplicate proxy-image assets

## Root Markdown policy

Root Markdown is reserved for:

- `README.md`
- `AGENTS.md`
- the current approved working-doc baseline:
  - `backlog.md`
  - `repo-rearrangement.md`
  - `tests-refactor.md`

Reference docs, architecture docs, operator docs, and contributor docs belong under `docs/`.
The repo-structure verifier checks both tracked and untracked root Markdown files so new working docs fail early unless they are added to this approved set.

## Tooling expectations

- the root repo uses `npm run ...`
- root `package.json` intentionally omits `packageManager`; keep Yarn pinning out of the root launcher package so npm remains the canonical entrypoint
- upstream `rivet/` still uses Yarn internally where required by wrapper build/dev flows
- `npm run setup:k8s-tools` installs the pinned cached Helm binary under `.data/tools/helm/`
- `npm run verify:repo-structure` enforces the repo-structure guardrails
- `npm run verify:test-style` enforces the test command manifest and style guardrails without running the full API or browser suites

Helm resolution order for repo tooling is:

1. `RIVET_K8S_HELM_BIN`
2. system `helm`
3. cached Helm under `.data/tools/helm/`

## Guardrails

The repo-structure cleanup is meant to stay stable:

- keep deployment assets in `ops/`
- keep image build definitions in `image/`
- keep runtime/bootstrap code in `wrapper/bootstrap/`
- keep root Markdown limited to the approved working-doc set
- do not reintroduce tracked vendored helper binaries
- keep test-suite command manifests explicit and protected by `npm run verify:test-style`

Run:

```bash
npm run verify:repo-structure
npm run verify:test-style
```

after repo-structure changes to keep those boundaries honest.
