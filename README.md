# Rivet 2

![License](https://img.shields.io/github/license/valerypopoff/rivet2.0)

Rivet is a visual IDE and runtime for building AI workflows, agents, prompt chains, graph-based tools, and reusable automation flows. This repository is the Rivet 2 monorepo: it contains the desktop app, graph runtime, Node runtime, CLI, app executor sidecar, Evaluations test tooling, documentation site, and maintainer developer docs. Rivet 2 continues the previous Rivet codebase as an independently maintained project.

[Download Rivet 2 desktop app](https://valerypopoff.github.io/rivet2.0/download)

[Rivet 2 website](https://valerypopoff.github.io/rivet2.0/)

[User documentation](https://valerypopoff.github.io/rivet2.0/user-guide)

This checkout is also designed to be embedded by wrapper applications that vendor Rivet source code. Wrappers can import from local source paths and use the supported app-host seams without depending on public npm packages.

For the self-hosted Rivet 2 service, see [Rivet Studio Server](deploy/studio-server/README.md).

## Contents

- [What This Repo Contains](#what-this-repo-contains)
- [Getting Started](#getting-started)
- [Common Commands](#common-commands)
- [Execution Modes](#execution-modes)
- [Plugins](#plugins)
- [Embedding Rivet In A Wrapper](#embedding-rivet-in-a-wrapper)
- [npm Packages](#npm-packages)
- [Stable and Developer Releases](#stable-and-developer-releases)
- [Documentation](#documentation)
- [License](#license)

## What This Repo Contains

Rivet 2 is organized as a Yarn workspace monorepo:

| Package                            | Purpose                                                                                                                                                     |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@valerypopoff/rivet2-core`        | Shared graph model, execution engine, built-in nodes, serialization, provider integrations, plugin assembly, and runtime contracts.                         |
| `@valerypopoff/rivet-app`          | Tauri and React desktop IDE, graph editor, settings, plugins UI, debugger surfaces, Run Activity, prompt designer, data studio, and hosted app entrypoints. |
| `@valerypopoff/rivet-app-executor` | Node executor sidecar used by the app for Node-mode graph execution.                                                                                        |
| `@valerypopoff/rivet2-node`        | Node runtime adapter for loading and running Rivet projects programmatically.                                                                               |
| `@valerypopoff/rivet2-cli`         | CLI commands for running and serving Rivet graphs.                                                                                                          |
| `@valerypopoff/rivet2-evaluations`             | Graph-oriented test utilities and test serialization.                                                                                                       |
| `packages/docs`                    | Docusaurus documentation site.                                                                                                                              |

The repo also includes `developer-docs/`, which documents current architecture
and integration contracts, and `refactor-history.md`, which consolidates
completed refactor notes and residual watchlist items.

## Getting started with local development

### Prerequisites

- Node.js 20.4.x or a compatible Node 20 runtime.
- Yarn through the checked-in Yarn release (`packageManager` currently points at Yarn 4.17.1).
- Rust stable and the Tauri platform prerequisites if you are building desktop bundles.
- On Windows desktop builds, Visual Studio Build Tools with the Windows SDK must
  be installed and available on `PATH` so Tauri can find `RC.EXE`; using
  Developer PowerShell for Visual Studio is the usual way to get that environment.

### Install Dependencies

```powershell
yarn install --immutable
```

### Start The Desktop App In Development

```powershell
yarn dev
```

The root `dev` script starts the Rivet app workspace and opens the Vite/Tauri development flow used by the desktop IDE.

Studio Server uses the same root Yarn installation but keeps its commands
explicitly namespaced: use `yarn studio-server:dev` for server development,
`yarn studio-server:prod` for published production images, or
`yarn studio-server:prod:custom` to build production images from this checkout.
There is no bare `prod` command.

## Common Commands

```powershell
# Build all main workspaces in dependency order
yarn build

# Run workspace tests
yarn test

# Run workspace lint checks
yarn lint

# Build only the desktop app frontend/package
yarn workspace @valerypopoff/rivet-app run build

# Build local package artifacts for package-consumer checks
yarn build:packages:local

# Sync desktop installer metadata from packages/app/package.json
yarn sync:desktop-version
```

To create a Tauri desktop bundle locally:

```powershell
cd packages/app
yarn tauri build --verbose
```

## Execution Modes

Rivet supports several execution surfaces:

- Browser execution runs graphs in-process inside the app for lightweight local execution.
- Node execution uses `@valerypopoff/rivet-app-executor`, a websocket sidecar that runs graph work in Node.
- Programmatic Node execution uses `@valerypopoff/rivet2-node` and the CLI without the desktop editor.
- Hosted editor execution lets wrappers provide an internal executor websocket URL instead of asking browser-hosted Rivet to start a Tauri sidecar.

The app executor defaults to a desktop-safe loopback websocket host, and hosted/containerized environments can override it with `RIVET_EXECUTOR_HOST`, `RIVET_EXECUTOR_PORT`, and `executor.internalExecutorUrl`. Code-node runtime-library resolution can be redirected with `RIVET_CODE_RUNNER_REQUIRE_ROOT`.

## Plugins

Rivet 2 treats plugin installation as app-level state:

- Installing a plugin makes its nodes available in the node picker for every project.
- A project records a plugin in its YAML only when a graph actually uses a node owned by that plugin.
- Removing all nodes from that plugin removes the plugin from the project's serialized plugin list.
- Opening a project that references plugins not installed in the app shows an explicit install-choice modal instead of silently installing them.

The YAML project format remains unchanged; the app derives the `plugins` list from graph contents when saving, running, and uploading project data.

## Embedding Rivet In A Host

Hosted workspaces in this monorepo can import the source-level app host from the
sibling app workspace. For example, from another workspace under `packages/`:

```ts
import { RivetAppHost } from '../app/src/host';
import '../app/src/host.css';
```

`RivetAppHost` provides the app shell needed for embedding the full Rivet editor:

- React Query, providers, async storage bootstrap, and executor-session wiring.
- Hosted executor configuration through `executor.internalExecutorUrl`.
- First-class lifecycle callbacks such as project save/open notifications.
- Workspace host APIs for opening snapshots, opening path-backed projects, closing projects, moving project paths, and replacing the active project.
- Provider-only integration points for IO, datasets, environment variables, storage, path policies, and wrapper bridge components.

Hosts should prefer these source-level seams over private editor internals. The
workspace package names describe ownership boundaries, while the monorepo keeps
the host and editor source on the same commit.

## Rivet 2 NPM Packages

The public npm packages are published under the `@valerypopoff` scope:

- `@valerypopoff/rivet2-core`
- `@valerypopoff/rivet2-node`
- `@valerypopoff/rivet2-evaluations`
- `@valerypopoff/rivet2-cli`

Package versions are lockstep and start at `2.x`. The `package.json` version in those four packages is the source of truth: patch releases are `2.0.1`, compatible feature releases are `2.1.0`, and the workflow refuses to publish anything outside major version `2`.

On pushes to `main`, `.github/workflows/publish-npm-packages.yml` builds those four workspaces, stages package-manager-neutral npm package directories, rewrites internal `workspace:^` dependencies to the same public `^2.x` version, and publishes versions that do not already exist on npm. The npm package manifests are the source of truth for npm versions.

Main-branch publishing is tokenless npm trusted publishing. Each package is configured on npm to trust the GitHub Actions publisher `valerypopoff/rivet2.0` and the `publish-npm-packages.yml` workflow for the `npm publish` action. The workflow grants `id-token: write`, uses npm `11.5.1`, and publishes provenance; it deliberately has no `NPM_TOKEN` repository secret or token environment variables. Do not restore one as a routine CI fallback.

For exceptional local recovery or the first publish of a new package, `scripts/publish-npm-packages.mjs` can read `NPM_TOKEN` from a repo-root `.env` file and passes it to npm through a temporary `.npmrc` that is removed after the attempt. `.env` is ignored by Git and must stay local. A package must exist on npm before its trusted publisher can be configured, so bootstrap a new package once with a short-lived, scope-limited granular token, configure its trusted publisher immediately afterward, then revoke the token.

## Stable and Developer Releases

This repo publishes desktop installer assets to rolling GitHub Release feeds and exposes their metadata through the GitHub Pages documentation site:

- `.github/workflows/official-windows-release.yml` runs on pushes to `main`, updates the current stable Windows/macOS assets in the `rivet-2-stable-feed` GitHub Release, and publishes their metadata.
- `.github/workflows/developer-windows-release.yml` runs on pushes to `develop`, updates the current developer Windows/macOS assets in the `rivet-2-developer-feed` prerelease, and publishes their metadata.

On pushes to `develop`, the workflow:

1. Verifies the checked-in AI Graph Builder assets, then builds Windows and macOS bundles in parallel after the pinned Yarn install and desktop-version sync.
2. Builds Windows MSI and NSIS installers plus a signed and notarized universal macOS DMG from `packages/app`.
3. Builds the Docusaurus documentation site from `packages/docs` in parallel with the platform bundles.
4. Uploads the latest developer installer assets to the rolling GitHub Release feed and adds their metadata to the docs build.
5. Publishes the docs site to GitHub Pages.

On pushes to `main`, the stable release workflow runs the same desktop installer and documentation build path, but updates the stable GitHub Release feed and writes `official-release.json` instead of the developer feed.

For desktop releases, `packages/app/package.json` is the version source of
truth. The release workflows run `yarn sync:desktop-version` before packaging so
Tauri/Cargo metadata and Windows installer filenames follow that package
version automatically.

The GitHub Pages site at `https://valerypopoff.github.io/rivet2.0/` presents
Rivet 2 and hosts the documentation. The User Guide starts at `/user-guide`.
The top-right Download link opens a downloads page with the latest stable
Windows/macOS installers from `main` and latest developer Windows/macOS
installers from `develop`.

GitHub Pages must either be enabled once in repository settings with Source set to GitHub Actions, or the repository must provide a `PAGES_ENABLEMENT_TOKEN` Actions secret that can enable Pages for the workflows. The stable release workflow deploys through the `github-pages` environment and should be allowed from `main`. The developer workflow deploys through `developer-windows-pages` so develop-branch installer deployments are not blocked by production `github-pages` environment rules; if that environment is protected later, it must allow `develop`.

Both Pages release workflows intentionally build installer artifacts only. They do not sign updater bundles and do not require Tauri updater private-key secrets. Production/tagged updater release workflows are separate.

## Developer documentation

Useful current developer docs:

- [Developer Docs Index](developer-docs/README.md)
- [Building Complex Rivet Projects With An AI Agent](developer-docs/AI-ASSISTED-PROJECT-AUTHORING.md)
- [Developer Docs Overview](developer-docs/OVERVIEW.md)
- [Repo File Tree](developer-docs/REPO-FILE-TREE.md)
- [Package Boundaries](developer-docs/PACKAGES.md)
- [Build And CI](developer-docs/BUILD-AND-CI.md)
- [App Architecture](developer-docs/APP-ARCHITECTURE.md)
- [Plugin System](developer-docs/PLUGIN-SYSTEM.md)
- [Execution Data Flow](developer-docs/EXECUTION-DATA-FLOW.md)
- [Refactor History](refactor-history.md)

The public docs site lives in `packages/docs`.

## License

Rivet is licensed under the [MIT License](LICENSE).
