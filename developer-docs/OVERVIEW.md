# Rivet Developer Docs Overview

> Internal maintainer-facing documentation for the current monorepo.
> These docs are intended to support refactors, not just orientation.

## What This Repo Contains

Rivet is a monorepo organized around one shared graph runtime and several product surfaces built on top of it.

At a high level:

1. `@valerypopoff/rivet2-core` defines the graph model, execution engine, built-in nodes, built-in plugins, serialization, and shared runtime contracts.
2. `@valerypopoff/rivet-app` is the Tauri/React desktop IDE.
3. `@valerypopoff/rivet2-node` adapts core for Node environments.
4. `@valerypopoff/rivet2-cli` exposes run/serve workflows on top of `rivet-node`.
5. `@valerypopoff/rivet-app-executor` is the Node sidecar used by the desktop app.
6. `@valerypopoff/trivet` provides graph-oriented testing utilities and serialization.
7. `packages/docs` is the Docusaurus documentation site.

## Workspace Layout

```text
packages/
  app/            Desktop app
  app-executor/   Node sidecar for the app
  cli/            CLI for running and serving graphs
  core/           Runtime engine, graph model, built-in nodes/plugins
  docs/           Docusaurus site
  node/           Node integration library
  trivet/         Test-runner package
developer-docs/   These internal docs
refactor-history.md  Consolidated record of completed refactors and residual watchlist
.github/         CI workflows and release scripts
```

## Dependency Structure

The core dependency direction is intentionally simple:

```text
core
|- node
|  `- cli
|- app
|- app-executor
`- trivet
```

Important implications:

- `core` is the foundation and does not depend on other workspace packages.
- `node`, `app`, `app-executor`, and `trivet` all rely on `core` concepts and types.
- `cli` is not an independent runtime; it is a thin operational layer over `rivet-node`.
- the app uses both `core` directly and the sidecar protocol indirectly.

## Main Architectural Layers

### 1. Shared runtime layer

Owned by `packages/core`.

Contains:

- project and graph types
- data type system
- node registration and node execution
- built-in nodes
- built-in provider plugins
- serialization
- execution recording support
- public programmatic APIs

### 2. Desktop IDE layer

Owned by `packages/app` and `packages/app/src-tauri`.

Contains:

- graph editor UI
- project workspace UI
- local and sidecar execution orchestration
- plugin installation/loading UX
- Trivet integration
- prompt-designer integration
- updater/debugger/data overlays
- Tauri-native bridging

### 3. Node runtime layer

Owned by `packages/node`.

Contains:

- file-based project loading
- Node-native execution defaults
- remote debugger server
- dataset/debugger/project-reference helpers
- re-exported core APIs

### 4. Operational surfaces

Owned by:

- `packages/cli`
- `packages/app-executor`
- `packages/trivet`
- `packages/docs`

These packages expose the runtime in different ways rather than redefining it.

## Execution Model

There are three execution contexts worth distinguishing:

### Browser execution

Used by the desktop app when the live `selectedExecutorState` is `browser`.

- runs `GraphProcessor` in-process inside the app
- uses browser/Tauri-facing adapters
- supports the editor's immediate local run flow
- editor run-from execution builds an explicit partial-run plan, preloads only already-computed boundary inputs, and then reruns the selected node plus downstream nodes through `GraphProcessor`

### Sidecar Node execution

Used by the desktop app when the live `selectedExecutorState` is `nodejs`.

- the app starts or connects to `app-executor`
- communication happens over `ws://127.0.0.1:21889/internal`
- execution runs via the debugger/server protocol
- supports Node-specific APIs and plugin installation scenarios
- connection ownership is centralized in the app's shared `executorSession` runtime and `useExecutorSessionCoordinator` policy hook rather than in `useRemoteExecutor` itself
- the selected executor mode is remembered per open project tab in editor-owned metadata, not in `.rivet-project` YAML; Browser and Node modes restore through `selectedExecutorState`, while a Remote Debugger tab stores the external debugger URL and reconnects that target when the project tab is reactivated
- sidecar process lifecycle is now isolated in a small runtime helper (`executorSidecarRuntime.ts`) instead of being reassembled inside the React hook that mounts it
- hosted wrappers can bind the app-executor server to a non-loopback host with `--host` or `RIVET_EXECUTOR_HOST`, override the port with `--port` / `-p` or `RIVET_EXECUTOR_PORT` using a valid TCP port from `1` to `65535`, and redirect Code-family `require()` resolution with `RIVET_CODE_RUNNER_REQUIRE_ROOT` / `RIVET_CODE_RUNNER_REQUIRE_ANCHOR`
- hosted wrappers that mount through `RivetAppHost` can pass `executor.internalExecutorUrl` so browser-hosted Node executor mode connects to an externally managed app-executor websocket instead of trying to start a Tauri sidecar

### Hosted editor embedding

Hosted or wrapper applications that mount the Rivet editor from source should
import directly from their embedded/custom `rivet/` checkout rather than from
public npm packages. A wrapper that vendors Rivet at `wrapper-repo/rivet` should
import the host component and styles from local source paths:

```ts
import { RivetAppHost } from '../rivet/packages/app/src/host';
import '../rivet/packages/app/src/host.css';
```

`host.css` is the complete shared style entrypoint for both standalone and
embedded mounts. It includes the GitHub Markdown skin, Rivet's app theme files,
and the Atlaskit CSS reset so node Markdown, including Comment node paragraphs,
does not pick up different browser-default margins in hosted wrappers.

That host seam provides the same React Query, provider, executor-session, and
storage-bootstrap wrapper used by the desktop app while still allowing external
shells to inject IO, datasets, environment variables, storage, path policies, an
internal executor websocket URL, wrapper UI policy, and post-app bridge
components. The first wrapper UI policy is
`ui.fileMenu.visibleItems`, which filters the browser top-bar Menu by stable item
ids, including optional app-level items such as `settings` and `get_help`,
while leaving command behavior owned by the app command layer.

Wrapper shells can receive a stable imperative workspace handle through
`RivetAppHost`'s `onWorkspaceHostReady` callback, render
`RivetWorkspaceHostBridge`, or call `useRivetWorkspaceHost()` from their own
bridge component inside the host tree. That handle opens snapshots, opens
path-backed projects, closes projects, moves remembered project paths, and
updates the metadata for already-open projects without wrapper-specific Jotai
access. Use `updateProjectMetadata(...)` for wrapper-owned external renames or
description changes; it updates the tab title/path plus active or inactive
project metadata and can treat the change as externally persisted without
clearing pre-existing unsaved graph edits. The handle also exposes
`markCurrentProjectClean(...)` and `markProjectClean(...)` so wrapper-owned save
flows can mark an already-open project clean after a successful external save
without importing app-internal dirty-state atoms.
Project save/open lifecycle notifications should go through `RivetAppHost`
callbacks rather than wrapper-specific subscriptions.

### Standalone Node execution

Used by `rivet-node`, `rivet-cli`, and external Node consumers.

- runs `GraphProcessor` directly in Node
- uses Node-native providers like `NodeNativeApi`, `NodeCodeRunner`, and `NodeProjectReferenceLoader`
- can optionally attach a debugger server

## Cross-Cutting Concepts

### Global node registry

The repo relies heavily on a shared `globalRivetNodeRegistry` from core.

This registry is:

- pre-populated with built-in nodes
- mutated when plugins are registered
- rebuilt through `assembleRegistry()` + `replaceGlobalRivetNodeRegistry()` in app/plugin-loading flows

Registry construction is centralized in [`RegistryAssembly.ts`](../packages/core/src/model/RegistryAssembly.ts). Both the app (`useProjectPlugins`) and sidecar (`executor.mts`) use `assembleRegistry()` to build a fresh registry from plugin specs, keeping the assembly logic in one place.

That makes registry state one of the key global couplings in the repo.

### Project serialization

Serialization is versioned in `packages/core/src/utils/serialization/`.

Current repo-visible serialized artifacts include:

- `.rivet-project`
- `.rivet-data`
- `.rivet-recording`

### Attached/test/static data split

Several parts of the system intentionally keep large or auxiliary data outside the central graph structures:

- static project data can live separately from `projectState`
- remembered graph/subgraph/viewport state lives separately in `projectEditorStateByProjectIdState`
- app state stores Trivet and runtime context separately
- recording and debugger flows serialize execution data separately

This split shows up repeatedly in app save/load code and should be treated as architectural, not incidental.

### Runtime settings normalization

Runtime execution settings are normalized in core through `resolveProcessSettings(...)`. The app, Node package, and Trivet should pass their available runtime/env values into that shared resolver instead of each package reconstructing a full legacy `Settings` object. Editor-only preferences may still live in persisted app settings, but they should not become required inputs for backend/programmatic workflow execution.

## Current Refactor Hotspots

Based on the current code, the highest-risk/highest-value refactor areas are:

- `packages/app/src/components/NodeCanvas.tsx` and related canvas hooks
- `packages/app/src/hooks/useGraphExecutor.ts`, `useLocalExecutor.ts`, `useRemoteExecutor.ts`, and `executorSession.ts`
- `packages/app/src/domain/graphEditing/*` and the remaining graph-editor consumers that have not yet moved onto those shared action helpers
- `packages/app/src/components/RenderDataValue.tsx` and `packages/app/src/components/renderDataValue/*` as new data-renderer extension points
- `packages/app/src/hooks/useProjectPlugins.ts`
- `packages/app/src/hooks/useWorkspaceTransitions.ts` and `packages/app/src/utils/workspaceTransitions.ts`
- `packages/core/src/model/GraphProcessor.ts`, `NodeExecutionPlanner.ts`, and `SubprocessorBridge.ts`
- `packages/core/src/model/SplitRunProcessor.ts`
- `packages/core/src/model/NodeRegistration.ts`
- serialization contracts in `packages/core/src/utils/serialization/`
- debugger/server protocol surfaces between app, app-executor, and node

Completed refactors and the residual watchlist live in
[`../refactor-history.md`](../refactor-history.md). Use that history to see
which seams already changed and which small watchlist items were intentionally
deferred.

## How To Use These Docs

Recommended reading order:

1. [../refactor-history.md](../refactor-history.md) for completed refactors and deferred watchlist items
2. [APP-ARCHITECTURE.md](./APP-ARCHITECTURE.md) for desktop IDE structure and state flows
3. [CORE-ENGINE.md](./CORE-ENGINE.md) for the runtime model and execution engine
4. [EXECUTION-DATA-FLOW.md](./EXECUTION-DATA-FLOW.md) for how execution data, graph views, subgraph runs, and the run switcher interact
5. [PLUGIN-SYSTEM.md](./PLUGIN-SYSTEM.md) for node/plugin registration and loading behavior
6. [PACKAGES.md](./PACKAGES.md) for package-by-package operational detail
7. [REPO-FILE-TREE.md](./REPO-FILE-TREE.md) for source-layout and cleanup guardrails
8. [BUILD-AND-CI.md](./BUILD-AND-CI.md) for build, release, and publish workflows

When planning refactors, treat these docs as a map of current seams and constraints, not a guarantee that every area is cleanly isolated.
