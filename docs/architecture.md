# Architecture

## Repository layout

- `rivet/` is upstream Rivet source consumed by this repo. `npm run setup` may clone it as a Git checkout for local development, while `npm run setup:rivet` downloads the configured Rivet 2 source ref into a clean snapshot for Docker builds. The default source is `https://github.com/valerypopoff/rivet2.0.git` at `main`, overrideable with `RIVET_REPO_URL` and `RIVET_REPO_REF`; `RIVET_REPO_REF` can be a branch, tag, or exact commit SHA. It may also be a local symlink or Windows junction to another Rivet checkout. Local Docker launchers copy the build-relevant subset into `.data/docker-contexts/rivet-source` and the install metadata into `.data/docker-contexts/rivet-dependency-metadata` before invoking BuildKit, while dev bind mounts still point at the live source path. Treat `rivet/` as read-only input here; repo-specific behavior belongs in the wrapper layer, and real Rivet changes should be contributed upstream.
- `wrapper/web/` contains the hosted dashboard, browser entrypoint, and the tracked alias-based override layer for upstream editor behavior.
- `wrapper/api/` contains workflow management, publication, recordings, runtime-library management, native IO shims, plugin install/load routes, and guarded shell/config endpoints.
- `wrapper/shared/` contains browser/server contracts such as hosted env constants, editor-bridge messages, workflow types, and recording helpers.
- `wrapper/executor/` is the packaged Node executor used behind the executor websocket.
- `wrapper/bootstrap/` contains runtime/bootstrap code used by the API and executor processes in containerized modes.
- `image/` contains the canonical image build definitions plus shared proxy-image runtime assets.
- `ops/` contains deployment-only assets: Compose files under `ops/compose/`, Compose-only Dockerfiles under `ops/docker/`, and Compose-only proxy templates under `ops/nginx/`.
- `scripts/` contains the root launchers, environment loading, and upstream bootstrap helpers.
- `.github/` contains CI workflows.

## Runtime shape

The route map below describes logical ownership. In `RIVET_API_PROFILE=combined`, one API process serves both the control-plane and published-execution surfaces. In split deployments, `RIVET_API_PROFILE=control` and `RIVET_API_PROFILE=execution` separate those surfaces into different API workloads.

```text
Browser
  |- /                       -> dashboard shell
  |- /?editor               -> hosted Rivet editor inside an iframe
  |- /api/*                 -> control-plane API
  |- /workflows/*           -> execution-plane API
  |- /workflows-latest/*    -> control-plane API
  |- /ws/latest-debugger    -> control-plane latest-workflow debugger websocket
  |- /ws/executor/internal  -> executor websocket used by the hosted editor
  `- /ws/executor           -> executor websocket kept for upstream-compatible clients
```

In Docker dev and production, nginx fronts the stack and injects the trusted proxy header the API expects.
The repo-local Docker stacks still run the API in `combined` mode, so both workflow route families terminate at the same `api` container there even though the published-vs-latest split remains a first-class deployment contract.
The executor websocket remains a separate internal service on port `21889` in those Docker modes; it does not follow the API's generic `PORT` contract.
The executor container listens on `0.0.0.0` inside the Docker network because the proxy is a separate container that connects to `executor:21889`; external browser access still flows through the proxy's `/ws/executor*` routes.
In local direct-process mode, the services run separately without nginx. The Vite dev server only proxies `/api/*` and `/ws/executor*`, so published/latest workflow endpoints, `/ui-auth`, and `/ws/latest-debugger` are not recreated there with production-like routing or trust behavior.

The current runtime keeps the control plane conservative while published execution scales separately:

- control plane
  - dashboard/editor APIs
  - workflow mutation and publication
  - runtime-library admin flows
  - plugin admin flows
  - latest execution and latest debugger
- execution plane
  - published endpoint execution only
  - internal published-only execution for trusted in-cluster callers

That control-plane singleton is intentional, not accidental. In the current supported Kubernetes topology:

- `backend` stays at one replica
- `execution` is the horizontal scale boundary for endpoint traffic
- `proxy` stays as a separate scalable ingress tier in front of the execution plane
- `web` may stay at `1` when dashboard/editor traffic is negligible
- latest-workflow execution and `/ws/latest-debugger` stay on the same control-plane process boundary
- published endpoint execution scales on the execution Deployment and remains non-debuggable
- the latest debugger is still process-local rather than a distributed cross-replica service

The important operational detail is that these tiers scale independently. A new execution replica is only another execution-plane API pod; it does not automatically imply a matching proxy pod. In an endpoint-heavy deployment, `execution` is the primary scale target, `proxy` is the supporting ingress tier, `web` can remain fixed at `1`, and `backend` remains singleton by constraint rather than by capacity preference.

## Hosted UI model

- The top-level page is the wrapper dashboard. It renders the workflow library, project settings, runtime libraries, run recordings, an About dialog with the app name and version, and an `<iframe src="/?editor">`.
- The workflow library header is the left panel chrome: it stays `37px` high without a bottom divider, and the whole open-state header row folds the sidebar while keeping the sidebar icon before the `Rivet Projects` title. Collapsed mode becomes a persistent full-height `30px` rail button with a centered `>` chevron and, when a workflow is open, a larger grey/green/yellow dot in the former header slot for the opened project's `Unpublished`, `Published`, or `Unpublished changes` status. Folding the panel hides the contents visually without unmounting the workflow tree, and reopening waits for the width animation to finish before revealing those contents. The open-state splitter has a wider pointer target than its visual line, disables width transitions during active pointer capture, and folds/unfolds while dragging when the pointer crosses half of the configured minimum width.
- The workflow library tree now includes custom context menus on both project and folder entries.
- The active project summary is driven from the selected `WorkflowProjectItem` returned by `GET /api/workflows/tree`, including both publication metadata and per-project graph/node stats. Graph/node stats are wrapper-owned cached metadata (`*.wrapper-stats.json` in filesystem mode, immutable revision columns in managed mode), while publication status remains derived from the existing settings/hash or managed revision state. Its card uses the normal grey background for `Unpublished`, a green-tinted grey for `Published`, and a yellow-tinted grey for `Unpublished changes`.
- Project rows currently expose `Rename project`, `Compare opened project with this one` when a different normal workflow project is open in the editor, `Compare to the published version` on the active/open project when it is in `Unpublished changes`, `Download`, `Duplicate`, and a guarded `Delete project` action. When the compare target itself is in `Unpublished changes`, the dashboard uses the same saved-version chooser pattern as download/duplicate so the user can compare against either that target's published snapshot or saved live file.
- Folder rows currently expose `Rename folder`, `Create project`, `Upload project`, and `Delete folder`; folder rename edits inline in the tree, closes the edit field on `Enter`, shows a row preloader until the backend rename returns, and preserves the row's expanded/collapsed state.
- `Delete folder` is enabled only for empty folders in the dashboard, and the API enforces the same empty-folder rule if called directly.
- The workflow library also exposes a root-level `+ New folder` action that creates top-level folders rather than nested ones.
- Folder-level project creation now lives only in the folder context menu, not in an inline `+` button on the row.
- Projects and folders can also be moved by drag-and-drop between folders or back to the root, with the dashboard retargeting open editor tabs when project paths change.
- `Create project` prompts for a name, creates a new blank `.rivet-project` in the target folder through the workflow API, expands that folder, refreshes the tree, and opens the new project in the editor.
- `Rename project` in the project context menu, or `F2` while the selected project row has focus, edits the project row inline in the tree. `Enter` hides the edit field immediately, shows a row preloader until the backend rename returns, and retargets any selected/open project paths through `movedProjectPaths`. Project Settings intentionally does not expose a second rename control.
- `ProjectSettingsModal.tsx` is now mostly presentational. Publish, unpublish, and guarded delete flows live in `useProjectSettingsActions.ts`, while endpoint validation plus status labels live in `projectSettingsForm.ts`.
- `Duplicate` creates a sibling project file through the API and refreshes the tree without changing the current selection or editor tab. Duplicate names now use the same saved-version tag model as downloads, such as `Name [published] Copy` or `Name [unpublished changes] Copy`; exact-name collisions get numbered variants, but duplicate-of-duplicate naming otherwise stays literal. For `unpublished_changes`, the dashboard opens a chooser so the user can duplicate either the saved live version or the published snapshot.
- `Download` streams a saved `.rivet-project` file to the browser. It ignores unsaved editor changes and, for `unpublished_changes`, lets the user choose between the saved live file and the published snapshot. The download flow also leaves selection, open tabs, and folder expansion unchanged.
- `Delete project` in the project context menu never deletes immediately. For unpublished projects it opens the existing Project Settings modal, where the user must click `Delete project` again. For published or `unpublished_changes` projects it shows a toast telling the user to unpublish first.
- `Upload project` opens a browser file picker, uploads a chosen `.rivet-project` into the target folder, refreshes the tree, and leaves selection, open tabs, and folder expansion unchanged.
- Project Settings shows `Last published at ...` next to the `Published` or `Unpublished changes` status badge. That timestamp comes from stored publication metadata, with a fallback for older already-published projects that predate the explicit field. It also links to a published-version-history modal that lists every successful publish for the project and lets users star, add comment labels, download, preview, or restore the selected stored snapshot.
- `Run recordings` is likewise controller-driven: `useRunRecordingsController.ts` owns workflow loading, status/input filtering, run paging, retained modal state, and delete flow, while `RecordingWorkflowSelect.tsx` and `RecordingRunsTable.tsx` render the focused UI slices. Opening a recording hides the modal without flushing that controller state; the explicit modal close button is the reset boundary.
- `Runtime libraries` keeps `useRuntimeLibrariesModalState.ts` as the public controller. SSE framing, log merging, and job status patching live in `runtimeLibrariesJobStream.ts`, while the modal panels stay largely presentational.
- in `filesystem` mode, that modal treats install/remove logs and terminal status as session-local UI state: once the modal is closed after a finished job, reopening it falls back to the installed libraries list unless another job is still actively running. `managed` mode keeps its persisted job-state behavior.
- Browser picker filtering for Rivet's custom file extensions is not fully reliable across browsers, so the dashboard validates the selected filename after picking and the API validates it again before writing anything.
- The iframe renders the upstream Rivet app plus wrapper-provided overrides and `EditorMessageBridge`, which coordinates open/delete/replay/compare commands plus parent-page save requests with the dashboard via `window.postMessage`. Save completion, active project changes, and open-project counts are forwarded through `RivetAppHost` callbacks instead of wrapper-owned copies of upstream save/menu hooks. `HostedEditorApp` captures the upstream workspace API through `RivetAppHost.onWorkspaceHostReady`, and open, close, replace-current, path-move, and compare commands enter Rivet through that `RivetWorkspaceHost` instead of wrapper-owned tab-state mutations. Project compare is intentionally transient editor UI state: the dashboard sends a saved-live reference project path, or a current-published-version preview virtual path when the chosen reference side is published, plus optional side labels, the iframe loads and deserializes only that `.rivet-project`, then calls `RivetWorkspaceHost.startProjectCompare(...)` without saving wrapper metadata or importing datasets for the reference project.
- Editor keyboard actions such as `Ctrl+C`, `Ctrl+X`, `Ctrl+V`, iframe-focused `Ctrl+D`, iframe-focused `Ctrl+S`, and Rivet find/search shortcuts stay anchored to editor-side behavior inside the iframe. The hosted wrapper now makes the node canvas itself a focus target, clears stale editor search/context-menu input focus on normal canvas interactions, relays dashboard-focused `Ctrl+F` and dashboard-focused `Ctrl+D` into the iframe before browser find/bookmark UI opens, catches iframe-focused physical `KeyF` find shortcuts before the browser opens find, focuses visible mounted editor search fields before falling back to graph search, suppresses the browser focus ring on the iframe/canvas, and lets upstream Rivet's save transition own the actual save behavior.
- `HostedIOProvider` replaces desktop file APIs with API-backed load/save behavior and supports virtual replay paths of the form `recording://<recordingId>/replay.rivet-project` plus read-only published-version preview paths of the form `published-version-preview://<encodedRelativePath>/<encodedVersionId>/preview.rivet-project`.
- Wrapper-specific UI lives under `wrapper/web/dashboard/`. Hosted editor hook/component overrides live under `wrapper/web/overrides/`. Upstream editor UI still lives under `rivet/packages/app/`.

## API surface overview

- `/api/workflows/*` manages workflow folders/projects, project creation/duplication/uploading/downloading, publication, published-version history, movement/rename, and the recordings browser APIs.
- `/api/runtime-libraries/*` manages runtime-library state, replica readiness, stale-replica cleanup, install/remove jobs, job cancellation, and live log streaming over SSE from the control plane.
- `/api/native/*` exposes the hosted editor's filesystem API, constrained to allowed roots and supported base dirs.
- `/api/projects/*` exposes hosted project discovery and IO helper routes (`/list`, `/open-dialog`, `/load`, `/save`, `/workspace-root`) for the hosted IO provider.
- `/api/plugins/*` downloads, extracts, and loads NPM plugins for upstream plugin flows.
- `/api/shell/exec` runs allowlisted shell commands (`git` and `pnpm` by default, extendable via env).
- `/api/config`, `/api/path/*`, and `/api/config/env/:name` expose hosted-mode configuration, app-data paths, and allowlisted env vars.
- `POST ${RIVET_PUBLISHED_WORKFLOWS_BASE_PATH}/:endpointName` executes the frozen published snapshot through the execution-plane API.
- `POST ${RIVET_LATEST_WORKFLOWS_BASE_PATH}/:endpointName` executes the latest live draft for a still-published workflow through the control-plane API, keyed by the current draft endpoint name.
- `POST /internal/workflows/:endpointName` is an internal published-only execution route mounted on the execution-plane API service and not exposed through nginx.
- In `managed` mode, those execution routes use API-local derived caches for warm endpoint execution; Postgres plus object storage remain authoritative, and cache invalidation is driven by same-process post-commit clearing plus Postgres `LISTEN/NOTIFY` across both control-plane and execution-plane API replicas.
- A later cleanup pass kept that behavior intact but extracted the managed execution subsystem into focused internal modules so the large managed backend remains orchestration-oriented instead of owning the whole execution state machine inline. The later hardening pass also made the writer replica ignore self-originated `NOTIFY` payloads and tightened listener startup/disposal behavior without changing route contracts or cache semantics.

## Core wrapper seams

- Workflow library management, publication, execution, and recordings live in `wrapper/api/src/routes/workflows/`.
- Managed workflow storage internals now live under `wrapper/api/src/routes/workflows/managed/`, with `backend.ts` acting as a facade/composition root over `context.ts`, `db.ts`, `transactions.ts`, `mappers.ts`, `revision-factory.ts`, `endpoint-sync.ts`, the domain services (`catalog.ts`, `revisions.ts`, `publication.ts`, `recordings.ts`), and the execution-support modules.
- Managed warm execution is internally split across `execution-cache.ts`, `execution-invalidation.ts`, and `execution-service.ts`; this is an internal maintainability boundary only, not a separate product/API surface.
- Filesystem recording compatibility code stays under `wrapper/api/src/routes/workflows/`, with `recordings.ts` as the public orchestrator over `recordings-artifacts.ts`, `recordings-metadata.ts`, `recordings-maintenance.ts`, `recordings-store.ts`, and `recordings-db.ts`.
- Native hosted filesystem routes stay under `wrapper/api/src/routes/`, with `native-io.ts` delegating managed virtual-path rules to `workflows/managed-virtual-io.ts` instead of mixing them into one long route file.
- Runtime-library management lives under `wrapper/api/src/runtime-libraries/`, with `backend.ts` choosing the per-process backend singleton and the managed path split into a facade plus `context.ts`, `job-store.ts`, `job-stream.ts`, `job-worker.ts`, `artifact-activation.ts`, `process-registry.ts`, and `replica-status.ts`. Historical retention and orphan cleanup stay in `managed/cleanup.ts` as a separate operator-facing orchestrator.
- Dashboard/editor iframe coordination lives in `wrapper/shared/editor-bridge.ts` and `wrapper/web/dashboard/`.
- Workflow-library UI orchestration now sits in `useWorkflowLibraryController.ts`, with menus and modal rendering split out of `WorkflowLibraryPanel.tsx`. Folder and project inline rename rows share `WorkflowInlineRenameInput.tsx`, and path-retargeting after move/rename is centralized in the controller so selected rows, Project Settings state, and editor tabs follow the same `movedProjectPaths` contract.
- Project settings, run recordings, and runtime-library modal logic now sit behind focused dashboard controllers and helpers instead of staying inline in the modal components.
- Dashboard shell orchestration now sits in `useDashboardSidebar.ts`, `useEditorBridgeEvents.ts`, and `editorBridgeFocus.ts`, with `DashboardPage.tsx` mostly composing those seams instead of owning all iframe, layout, and focus logic itself.
- Hosted editor mounting uses Rivet 2.0's `RivetAppHost` seam from `rivet/packages/app/src/host.tsx`, with `host.css` as the source-level style entrypoint. The wrapper passes `/ws/executor/internal` as `executor.internalExecutorUrl`, so Node executor mode reuses Rivet's upstream executor-session and remote-executor transport. The wrapper also passes explicit provider overrides from `hostedRivetProviders`: `HostedIOProvider`, an injected import/export-capable `HostedDatasetProvider`, hosted environment lookup, and hosted path-policy reads. Upstream Rivet owns internal executor classification, debugger handoff, save transitions, menu command dispatch, workspace open/close/path-move transitions, and the editor-owned clean baseline for the project-tab unsaved-changes dot. The wrapper must not alias `useExecutorSession`, `useRemoteDebugger`, `useGraphExecutor`, `useRemoteExecutor`, `useSaveProject`, `useMenuCommands`, `io/TauriIOProvider`, or `utils/globals/ioProvider`. If a future wrapper-owned save flow needs to reseed Rivet's clean baseline after backend success, use `RivetWorkspaceHost.markCurrentProjectClean()` or `markProjectClean()` instead of dirty-state atom imports. The wrapper uses the upstream `RivetAppHost.ui.fileMenu.visibleItems` policy to keep the iframe File menu to `import_graph`, `export_graph`, `settings`, and `get_help` while leaving command behavior in Rivet. Hosted builds do keep a narrow `savedGraphs` override so the hosted `clearProjectContextState` compatibility export delegates to upstream `releaseProjectContextState`, forgetting only the atom instance and not deleting editor-owned context values stored under `projectContext__"<projectId>"` when a tab is closed or replaced; actual workflow deletion uses the project id returned by the delete API plus the override's explicit delete helper, which removes that project storage key through the shared `project` storage group so closed-tab state is cleaned too. `HostedDatasetProvider` also prunes stale browser IndexedDB dataset rows for the project before importing the authoritative hosted project payload.
- Hosted environment lookup is cached and deduplicated in `wrapper/web/overrides/utils/tauri.ts`. Upstream node editor UI context creation may resolve OpenAI and plugin env defaults every time a node settings panel is opened, so the hosted shim must cache empty allowlist responses as well as real values, share pending requests, and resolve independent env names concurrently. Repeated warm `/api/config/env/*` calls while opening node settings are a hosted-wrapper regression, not a project YAML or opened-project snapshot caching issue.
- Hosted opened-project state follows Rivet 2.0's split model: tab metadata stays in `projectsState.openedProjects`, while full project content stays in `openedProjectSnapshotsState`. Wrapper hosted hooks should prefer `RivetWorkspaceHost` for open/replace/close/path-move behavior. Wrapper atom reads are still acceptable for hosted-only path lookup, duplicate-id checks, stale-empty-tab cleanup, and session/revision cache synchronization, but wrapper code should not manually reimplement tab close fallback or path rewriting when the workspace host provides it. If the wrapper overrides upstream opened-project sync, it must still preserve Rivet's saved-content digest comparison so `savedProjectContentDigestsState` and `projectUnsavedChangesState` keep driving the editor-owned unsaved-changes dot.
- Hosted Tauri API shims must cover every upstream `@tauri-apps/api/*` subpath used by Rivet's browser bundle; currently that includes the `tauri` subpath for guarded native `invoke` calls. Wrapper module overrides for Rivet internals are importer-scoped to `rivet/packages/app/src` so unrelated wrapper or dependency files with matching basenames are not rewritten accidentally. Prefer upstream host/provider/workspace seams such as environment providers, path policy providers, and `RivetWorkspaceHost` over wrapper copies of upstream modules.
- The hosted `state/settings` override delegates upstream settings exports and keeps only hosted-specific additions local: the hosted debugger default URL and the wrapper update-check modal atom. This keeps browser UI settings such as canvas background and custom theme colors on the upstream public module shape instead of copying them into the wrapper.
- API workflow execution keeps importing `@valerypopoff/rivet2-node`, but local setup and API image builds replace that package with generated package overlays under `wrapper/api/node_modules/.rivet-package-links`. Those overlays also expose `@rivet2/rivet-node` and `@rivet2/rivet-core` for stale local upstream build outputs that still reference that alias. The overlays point package `dist` folders at the built `rivet/packages/node` and `rivet/packages/core` outputs and point package dependency lookup at `rivet/node_modules`. API TypeScript and Node entrypoints preserve symlink paths without writing dependency helper links inside the external `rivet/` checkout. This keeps endpoint execution on the embedded Rivet 2.0 source tree without scattering deep upstream imports through `wrapper/api`.
- Docker and local Kubernetes image builds receive that embedded source through the named `rivet_source` build context and receive a smaller install-time manifest set through `rivet_dependency_metadata`. The root launchers default `RIVET_SOURCE_HOST_PATH` to the real path behind `<repo>/rivet`, then create `RIVET_SOURCE_BUILD_CONTEXT_PATH` under `.data/docker-contexts/rivet-source` and `RIVET_DEPENDENCY_BUILD_CONTEXT_PATH` under `.data/docker-contexts/rivet-dependency-metadata`, so linked checkouts outside the repo still build without sending their local dependency/cache state to BuildKit and source-only upstream edits do not invalidate the Yarn install layer. The source snapshot includes upstream `scripts/` because wrapper Dockerfiles call Rivet's minimal build scripts and those scripts can import local helpers, and context prep validates the required wrapper-facing scripts and image-facing workspaces before Docker starts. The dependency metadata snapshot follows declared upstream Yarn workspaces instead of scanning arbitrary local `package.json` files.
- Hosted browser/file IO lives in `wrapper/web/io/HostedIOProvider.ts`.
- Shared browser/backend contracts live in `wrapper/shared/`.

## Storage model

| Area | Purpose | Local direct-process default | Docker default |
|---|---|---|---|
| `RIVET_WORKSPACE_ROOT` | Allowed workspace root for general hosted file operations | repo root | `/workspace` |
| `RIVET_WORKFLOWS_ROOT` | Filesystem-mode workflow tree plus filesystem-mode `.published/` snapshots | `<repo>/workflows` | `/workflows` |
| `RIVET_WORKFLOW_RECORDINGS_ROOT` | Filesystem-mode recording bundles | `<repo>/workflows/.recordings` by default, or a separate configured root | `/workflow-recordings` in Docker when split |
| `RIVET_APP_DATA_ROOT` | App-level state such as plugins, logs, and filesystem-mode `recordings.sqlite` | `<repo>/.data/rivet-app` | `/data/rivet-app` |
| `RIVET_RUNTIME_LIBRARIES_ROOT` | Runtime-library local cache, manifest, and job workspace | `<repo>/.data/runtime-libraries` | `/data/runtime-libraries` |

In Docker-based modes:

- `RIVET_ARTIFACTS_HOST_PATH` is the normal shared host root for filesystem-backed artifacts; the launcher derives `workflows/`, `workflow-recordings/`, and `runtime-libraries/` from it unless the per-path envs are set explicitly.
- that derivation is launcher-owned. Direct raw Compose runs do not expand `RIVET_ARTIFACTS_HOST_PATH` into the per-path host mounts, so manual Compose diagnostics must either go through the dev/prod npm launcher scripts or provide explicit absolute `RIVET_WORKFLOWS_HOST_PATH`, `RIVET_WORKFLOW_RECORDINGS_HOST_PATH`, and `RIVET_RUNTIME_LIBS_HOST_PATH` values.
- `RIVET_WORKFLOWS_HOST_PATH` backs `/workflows`, so in `filesystem` mode it stores live projects and published snapshots.
- `RIVET_WORKFLOW_RECORDINGS_HOST_PATH` backs `/workflow-recordings`, so filesystem-mode recording writes no longer contend with workflow-source reads on the same Windows bind mount.
- `RIVET_RUNTIME_LIBS_HOST_PATH` backs `/data/runtime-libraries`.
- the official API and executor images run as uid/gid `10001:10001`, so filesystem bind mounts must grant that uid the required read/write access.
- the app-data directory is a separate volume and in `filesystem` mode holds `recordings.sqlite`, plugin files, and app logs.

Storage mode decides which of those paths are authoritative:

- `RIVET_STORAGE_MODE=filesystem`
  - workflows are authoritative under `RIVET_WORKFLOWS_ROOT`
  - published version history and its durable star/comment state live under the workflow root's hidden `.published/` directory
  - runtime libraries are authoritative under `RIVET_RUNTIME_LIBRARIES_ROOT`
  - published/latest workflow execution now keeps a local startup-warmed endpoint index plus a lazy materialization cache on the API process
  - the cache facade delegates uncached resolution/materialization to a dedicated filesystem execution source, so degraded requests can bypass the cache without inventing separate publication rules
  - that materialization cache keeps the parsed project for the current file signature, so warm hits do not reparse the YAML workflow file on every request
  - those filesystem caches are derived accelerators only; stat-validated filesystem contents remain authoritative and out-of-band edits are still honored without restart
  - cache freshness is split between global workflow-tree validation and selected-pointer routing validation, and uncertainty degrades to cold bypass rather than stale execution
  - full unpublish closes both public route families even though the saved draft `endpointName` remains stored for later republish convenience
- `RIVET_STORAGE_MODE=managed`
  - workflow metadata lives in Postgres and workflow blobs live in object storage
  - published version history and its durable star/comment state live in Postgres `workflow_published_versions` and points at durable workflow revision blobs in object storage
  - workflow recording metadata lives in Postgres `workflow_recordings`
  - workflow recording artifacts live in object storage
  - API replicas may keep local warm execution caches for endpoint pointers and immutable revision payloads; those caches are derived accelerators, not a new source of truth
  - runtime-library release metadata, activation state, and job state live in Postgres
  - runtime-library release artifacts live in object storage under the fixed `runtime-libraries/` prefix
  - `RIVET_RUNTIME_LIBRARIES_ROOT` remains a local extracted cache/workspace on each process, not the shared source of truth
  - execution-plane `RIVET_APP_DATA_ROOT` may remain ephemeral because the current published execution path does not use it as authoritative state
  - package-plugin registration is not currently part of the API-hosted published execution contract, so the execution plane does not assume persistent plugin state

## Supported compatibility matrix

Outside Kubernetes, the app still supports two non-cluster compatibility shapes:

| Shape | Status | Notes |
|---|---|---|
| `filesystem + combined` | Supported | Primary backward-compatible single-host mode |
| `filesystem + control` | Supported | Useful for control-plane/admin validation without managed services |
| `filesystem + execution` | Unsupported | Execution-only API requires managed storage |
| `managed + local-docker + combined` | Supported | Existing Docker rehearsal path backed by local Postgres and MinIO |
| `managed + local-docker + control/execution` | Supported through repo-local split validation plus local dependency rehearsal | Use this to keep split-era contracts honest without treating Docker combined mode as proof of the real split topology |

Interpretation rules:

- `local-docker` means `RIVET_STORAGE_MODE=managed` with `RIVET_DATABASE_MODE=local-docker`
- in that shape, workflows and runtime libraries are still authoritative in Postgres plus object storage; the difference is only that those services are local Docker dependencies instead of managed external services
- filesystem mode remains single-host by design and is not a multi-replica scaling target

## Important environment variables

### Routing and auth

- `RIVET_PUBLISHED_WORKFLOWS_BASE_PATH` and `RIVET_LATEST_WORKFLOWS_BASE_PATH` change the public execution route prefixes.
- `RIVET_ENABLE_LATEST_REMOTE_DEBUGGER` enables the API-hosted `/ws/latest-debugger` websocket for latest-workflow runs only.
- `RIVET_KEY` is the shared secret used for proxy-auth token derivation, public workflow bearer auth, and the optional UI gate.
- In any nginx/proxy-fronted deployment such as Docker or Kubernetes, `RIVET_KEY` must always be present on both `proxy` and `api` even if `RIVET_REQUIRE_WORKFLOW_KEY=false` and `RIVET_REQUIRE_UI_GATE_KEY=false`, because `/api/*`, `/ui-auth`, and `/ws/latest-debugger` still rely on the trusted proxy header derived from that key.
- `RIVET_REQUIRE_WORKFLOW_KEY` enables `Authorization: Bearer <RIVET_KEY>` checks on the public workflow routes.
- `RIVET_REQUIRE_UI_GATE_KEY` enables the browser-side nginx gate.
- `RIVET_UI_TOKEN_FREE_HOSTS` lists hosts that bypass the UI gate and public workflow bearer auth.
- The UI gate prompt is staged into container-local `/tmp/nginx/html` at proxy startup. Compose mounts the source HTML at `/tmp/ui-gate-prompt.html`, but nginx serves only the staged copy.
- `RIVET_PROXY_READ_TIMEOUT` controls nginx `proxy_read_timeout` and `proxy_send_timeout` for `/api/*`, `${RIVET_PUBLISHED_WORKFLOWS_BASE_PATH}`, and `${RIVET_LATEST_WORKFLOWS_BASE_PATH}`. The tracked Docker defaults now pin that to `180s`, while websocket routes keep their separate long-lived timeouts.

### Storage and runtime libraries

- `RIVET_STORAGE_MODE` switches both workflows and runtime libraries together between `filesystem` and `managed`.
- `RIVET_DATABASE_MODE`, `RIVET_DATABASE_CONNECTION_STRING`, and `RIVET_DATABASE_SSL_MODE` define the shared managed Postgres connection used by workflow storage and managed runtime libraries.
- `RIVET_STORAGE_URL` is the recommended object-storage config entrypoint; alternatively use the explicit tuple of `RIVET_STORAGE_BUCKET`, `RIVET_STORAGE_REGION`, `RIVET_STORAGE_ENDPOINT`, `RIVET_STORAGE_ACCESS_KEY_ID`, `RIVET_STORAGE_ACCESS_KEY`, and `RIVET_STORAGE_FORCE_PATH_STYLE`.
- `RIVET_ARTIFACTS_HOST_PATH` is the primary public filesystem-mode host root. The per-path host envs remain launcher-level compatibility overrides rather than the preferred contract.
- `RIVET_WORKFLOW_RECORDINGS_ROOT` controls only where filesystem recording bundles live; if it is unset outside Docker, the app falls back to `<RIVET_WORKFLOWS_ROOT>/.recordings`.
- `RIVET_WORKFLOW_EXECUTION_DEBUG_HEADERS` enables additive execution timing headers for endpoint resolve/materialize/execute stages in both filesystem and managed modes.
- `RIVET_RUNTIME_LIBRARIES_SYNC_POLL_INTERVAL_MS` tunes managed runtime-library background reconciliation for API and executor processes.
- `RIVET_RUNTIME_LIBRARIES_REPLICA_STATUS_RETENTION_MS` and `RIVET_RUNTIME_LIBRARIES_REPLICA_STATUS_CLEANUP_INTERVAL_MS` tune how long stale managed replica-status rows are kept and how often background cleanup runs.
- `RIVET_RUNTIME_PROCESS_ROLE=api|executor` tells managed runtime-library readiness reporting which process role the current runtime represents.
- `RIVET_RUNTIME_LIBRARIES_REPLICA_TIER=endpoint|editor|none` lets the split topology report execution-plane API replicas as `endpoint`, executor replicas as `editor`, and control-plane API replicas as `none`.
- `RIVET_ENV_FILE` is a launcher-level override that lets repo tooling load an explicit env file instead of `.env` / `.env.dev`; it exists for repeatable compatibility verification and custom local rehearsals

Development-only execution measurement is available through:

- `npm --prefix wrapper/api run workflow-execution:measure -- --base-url http://localhost:8080 --endpoint hello-world --kind published --runs 5 --warmups 1`
- this tool is read-only and meant for route-timing diagnosis; in managed mode it helps compare cold-hit versus warm-hit behavior, while in filesystem mode it exposes the fixed resolve/materialize cost directly without changing server behavior

### Safety and compatibility

- `RIVET_ENV_ALLOWLIST` extends the hosted env shim beyond the built-in OpenAI vars. Browser-side hosted env lookups are cached for the current page session, so restart/recreate the app and reload the browser after changing env values that the editor should see.
- `RIVET_SHELL_ALLOWLIST` extends the hosted shell-command allowlist beyond `git` and `pnpm`.
- `RIVET_EXTRA_ROOTS` adds more allowed filesystem roots.
- `RIVET_COMMAND_TIMEOUT` and `RIVET_MAX_OUTPUT` bound hosted shell execution. They do not control workflow HTTP proxy timeouts; use `RIVET_PROXY_READ_TIMEOUT` for that.

### Recording defaults

Workflow recording settings are documented in detail in [workflow-publication.md](workflow-publication.md). The current defaults are:

- enabled by default
- `gzip` compression at level `4`
- retention window `14` days
- `100` max pending background writes
- `100` max runs per endpoint
- dataset snapshots disabled by default
- trace and partial-output capture disabled by default

## Dev and production modes

| Mode | Entry command | Browser entry | Notes |
|---|---|---|---|
| Local direct-process | `npm run dev:local` | `http://localhost:5174` | Runs API, web, and executor directly. Good for process-level work, but it does not recreate nginx's trusted-proxy wiring, so browser-driven `/api/*`, `/ui-auth`, and `/ws/latest-debugger` behavior is not representative there. |
| Docker dev | `npm run dev` | `http://localhost:8080` by default | Closest to production while still using bind mounts and a Vite dev server. The proxy port can be overridden with `RIVET_PORT`. |
| Local Kubernetes rehearsal | `npm run dev:kubernetes-test` | `http://127.0.0.1:8080` by default | Builds local images, deploys the real Helm chart against the local Kubernetes cluster, keeps `web=1`, keeps `backend=1`, scales `proxy` and `execution`, and port-forwards the proxy service for browser testing. This is the closest local rehearsal of the supported Kubernetes topology. |
| Production-style Docker | `npm run prod` | `http://localhost:8080` by default | Pulls and force-recreates the prebuilt `cloud-hosted-rivet2-wrapper/*` images. Use `npm run prod:restart` to recreate from already-local images after `.env` changes, or `npm run prod:custom` when you need to build from the current wrapper repo and current `rivet/` folder. The proxy port can be overridden with `RIVET_PORT`, while the executor websocket stays pinned to internal port `21889`. |

The API now depends on Node's built-in `node:sqlite`, so host-based API execution requires Node 24+.

For the current Kubernetes handoff contract, see [kubernetes.md](kubernetes.md).

## Boundary guidelines

- Treat `rivet/` as replaceable upstream code, not as the default home for hosted features.
- Prefer implementing hosted behavior in `wrapper/` first.
- If a hosted fix needs to change upstream editor behavior, prefer `wrapper/web/overrides/` plus Vite aliasing over editing `rivet/` directly.
- `wrapper/shared/` is for contracts both the browser and server need.
- Route files should stay thin request/response glue; domain logic belongs in helpers or service modules.
