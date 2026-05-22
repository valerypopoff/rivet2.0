# Workflow Publication

Workflows can be published as HTTP endpoints. This document describes the current publication, execution, and recording model.

In the current deployment model:

- published execution belongs to the execution surface
- latest execution belongs to the control surface
- internal published-only execution also belongs to the execution surface

In `RIVET_API_PROFILE=combined`, the same API process serves both surfaces. In split deployments, `RIVET_API_PROFILE=control` and `RIVET_API_PROFILE=execution` separate them.

## Concepts

- **Project file** (`*.rivet-project`): the live, editable workflow file
- **Settings sidecar** (`*.rivet-project.wrapper-settings.json`): stores the endpoint draft plus publication state
- **Published snapshot** (`.published/<snapshotId>.rivet-project`): frozen copy of the currently published project version
- **Published version history**: every successful publish creates a durable downloadable history entry for that project
  - in `filesystem` mode: `.published/<versionId>.rivet-project` plus `.published/<versionId>.json` metadata and an optional `.rivet-data` sidecar
  - in `managed` mode: a `workflow_published_versions` row pointing at a durable `workflow_revisions` project blob in object storage
  - version stars are stored on the version metadata/row, so starred history survives browser reloads and server restarts
- **Dataset sidecar** (`*.rivet-data`): optional data associated with a project, published alongside it
- **Execution recording artifacts**
  - in `filesystem` mode: replayable bundles under `<RIVET_WORKFLOW_RECORDINGS_ROOT>/<workflowId>/<recordingId>/`
  - in `managed` mode: replayable blobs in managed object storage, keyed from Postgres metadata
- **Recording metadata index**
  - in `filesystem` mode: SQLite metadata index under `<RIVET_APP_DATA_ROOT>/recordings.sqlite`
  - in `managed` mode: metadata rows in Postgres `workflow_recordings`

Projects live under the workflow root configured by `RIVET_WORKFLOWS_ROOT` in the API container and backed by `RIVET_WORKFLOWS_HOST_PATH` on the host in Docker modes.

Published snapshots always belong to workflow storage, but recording storage is backend-specific:

- in `filesystem` mode, recording bundles live under `RIVET_WORKFLOW_RECORDINGS_ROOT` and the metadata index lives under `RIVET_APP_DATA_ROOT` as `recordings.sqlite`
- in `managed` mode, recording metadata lives in Postgres and recording artifacts live in managed object storage

Published version history also belongs to workflow storage. It is not stored in the editor, browser IndexedDB, or recording storage.

## Stored settings model

The settings sidecar stores five publication-related fields:

- `endpointName`
  - the editable draft endpoint name shown in the UI
- `publishedEndpointName`
  - the endpoint name currently exposed by the public routes
- `publishedSnapshotId`
  - the snapshot ID under `.published/`
- `publishedStateHash`
  - SHA-256 of `endpointName + project file + dataset state` at publish time
- `lastPublishedAt`
  - ISO timestamp of the last successful publish operation

Important current behavior:

- publishing updates both `endpointName` and `publishedEndpointName`
- publishing also updates `lastPublishedAt`
- unpublishing clears only the `published*` fields and keeps `endpointName` as the saved draft/default
- that saved draft endpoint does not keep either public execution route open after full unpublish
- fully unpublished saved draft endpoints do not reserve the endpoint name; another workflow can publish on that endpoint, and the old project must choose a free endpoint before republishing
- unpublishing keeps `lastPublishedAt`, so the UI can still show when the project was last published once it becomes published again
- endpoint lookup is case-insensitive, but the stored/public casing is preserved

## Status model

Each project has a derived status:

| Status | Meaning |
|---|---|
| `unpublished` | No published endpoint is currently active |
| `published` | The live file matches the published snapshot/hash |
| `unpublished_changes` | An endpoint is published, but the live file has diverged from the published state |

Status is derived from the stored settings plus a fresh state hash; it is not stored as the source of truth.

The dashboard does not maintain its own separate optimistic publication-status model after save. It refreshes `/api/workflows/tree` and uses the API's derived status.

In Project Settings:

- `Published` and `Unpublished changes` show `Last published at ...`
- `Unpublished` does not show that line
- older already-published projects that predate the explicit `lastPublishedAt` field fall back to the settings-sidecar file timestamp
- the `Published version history` secondary action sits to the right of the idle publish/unpublish controls and opens the version-history modal for the current project
- when an unpublished project is in the endpoint-entry publish UI, the history action is hidden and a `Cancel` button hides the publish UI without saving

## Publish flow

1. User sets an endpoint name and clicks `Publish`.
2. Server validates the name:
   - non-empty
   - letters, numbers, and hyphens only
   - unique across active published and latest endpoint identities, case-insensitively
3. Server computes a SHA-256 hash of `endpointName + project file + dataset state`.
4. Server writes a new published version snapshot and history metadata.
5. Server writes the settings sidecar with `endpointName`, `publishedEndpointName`, `publishedSnapshotId`, `publishedStateHash`, and `lastPublishedAt`.

Every publish gets a new version ID. The latest publish becomes the current `publishedSnapshotId`, while older snapshots remain in published version history.

In managed mode, publish inserts a `workflow_published_versions` row and updates `workflows.published_version_id` to that row. The row points at the draft revision that was published, so the actual project bytes remain in the same managed object-storage revision store as ordinary workflow revisions.

## Save flow after publish

1. User saves the project in the editor.
2. The save path compares the saved project state with the currently saved draft state and, when relevant, the published state.
3. The save path persists the updated project state, or reuses the existing saved revision/state when the save is a no-op.
4. The editor emits `project-saved`.
5. The dashboard refreshes `/api/workflows/tree`.
6. The sidebar updates from the API's derived status.

That means:

- saving a published project with real saved changes transitions to `unpublished_changes` once the refresh returns
- saving a published project with no actual saved changes stays `published` and does not briefly flicker to `unpublished_changes`

Current backend-specific behavior:

- in `filesystem` mode, status is derived from the fresh publication state hash after the save completes
- in both storage modes, the workflow tree/file name is the hosted project title source of truth; saving rewrites `data.metadata.title` back to the current tree name if the editor changed it, and the hosted editor reconciles the visible open tab title immediately after save without reopening the project
- in `managed` mode, a no-op save does not create a new draft revision
- in `managed` mode, if the saved contents match the published revision exactly, the save path reuses that published revision instead of creating a distinct draft revision that would incorrectly appear as `unpublished_changes`

## Unpublish flow

1. Server clears the current published pointer.
2. Server clears `publishedEndpointName`, `publishedSnapshotId`, and `publishedStateHash`.
3. Server keeps `endpointName` in the settings sidecar as the saved draft endpoint name.
4. The saved draft endpoint no longer participates in endpoint uniqueness until the project is published again.

Unpublishing does not delete published version history. It closes the public/latest route lineage, but previous published versions remain downloadable from Project Settings. If a pre-history legacy project still has only a current published pointer, unpublish first backfills that current snapshot/revision into history before clearing the pointer.

In the current dashboard UI, the project-row context menu exposes `Rename project`, `Download`, `Duplicate`, and `Delete project`.

- `Rename project` edits the project name inline in the tree; `Enter` closes the edit field and shows a preloader on the project name while the API saves, while `Esc` or focus leaving the edit field cancels without calling the API

The folder-row context menu exposes `Rename folder`, `Create project`, `Upload project`, and `Delete folder`.

- `Rename folder` edits the folder name inline in the tree; `Enter` closes the edit field and shows a preloader on the folder name while the API saves, while `Esc` or focus leaving the edit field cancels without calling the API
- `Delete folder` is enabled only for empty folders in the dashboard, and the API still rejects non-empty folder deletion if called directly

`Delete project` is still guarded:

- for `unpublished` projects, clicking it opens Project Settings and the user must click `Delete project` there to complete deletion
- for `published` or `unpublished_changes` projects, the dashboard shows a toast telling the user to unpublish first

The API delete route itself still handles cleanup even if called directly for a published project.

## Folder management

Workflow folders are managed through:

- `POST /api/workflows/folders`
- `PATCH /api/workflows/folders`
- `DELETE /api/workflows/folders`

Current folder behavior:

- the workflow library's `+ New folder` action creates new folders at the root level
- `Rename folder` shows the shared inline edit field on the selected folder row, hides that field immediately when the user presses `Enter`, shows a preloader on the folder name while the backend rename is pending, returns `movedProjectPaths`, and lets the dashboard retarget open editor tabs without closing them
- pressing `Esc` or clicking away from the inline folder edit field cancels without calling the rename API
- a folder keeps its previous expanded or collapsed state after rename, even when the active project path inside that folder is retargeted
- folder rename preserves expanded-state intent by remapping the saved expanded-folder ids to the new relative path
- `Delete folder` is restricted to empty folders only
- the dashboard shows `Delete folder` as disabled for non-empty folders, and the API enforces the same rule with `409 Only empty folders can be deleted`
- projects and folders can be moved by drag-and-drop, which calls the move route and returns `movedProjectPaths` when project paths changed
- folder moves and renames are intentionally path-based operations; they do not create new workflow IDs or duplicate any project state

## Project creation

Projects can now also be created inside workflow folders from the folder-row context menu or through:

- `POST /api/workflows/projects`

Current creation behavior:

- folder-level project creation currently exists only in the folder-row context menu's `Create project` action
- the dashboard prompts for a new project name and posts that name plus the target folder path to the API
- the server writes a new blank `.rivet-project` file in the selected folder and returns it as a normal unpublished workflow project
- after successful creation, the dashboard expands the folder, refreshes the tree, and opens the new project in the editor
- unlike upload/duplicate/download, creation is intentionally disruptive to the current editor session because opening the new project is part of the UX
- if the folder already contains that exact project name, the API returns `409` instead of auto-numbering or overwriting

## Project rename

Projects are renamed from the workflow-library project context menu or by pressing `F2` while the selected project row has focus, not from Project Settings. The project row uses the same shared inline edit field as folder rename, with the current name selected. `Esc` or click-away cancels without an API call, and `Enter` hides the field immediately while a row preloader remains until `PATCH /api/workflows/projects` resolves.

When the API returns `movedProjectPaths`, the dashboard retargets the selected project, open editor tabs, and Project Settings state to the new absolute path without opening a different project. If the API rejects the rename, the preloader clears and the tree returns to the original row name while the error toast reports the server message.

## Project duplication

Projects can now be duplicated from the workflow tree's project-row context menu or through:

- `POST /api/workflows/projects/duplicate`

Current duplication behavior:

- the duplicate is created in the same folder as the source project
- `POST /api/workflows/projects/duplicate` now accepts `{ "relativePath": string, "version"?: "live" | "published" }`
- duplicate names use the same saved-version tag model as downloads:
  - `Name [unpublished] Copy`
  - `Name [published] Copy`
  - `Name [unpublished changes] Copy`
- if that exact duplicate stem already exists in the folder, the API numbers it as `... Copy 1`, `... Copy 2`, and so on
- duplicating an already duplicated project stays literal, so `Name [unpublished] Copy` becomes `Name [unpublished] Copy [unpublished] Copy` before numbered variants are needed
- for `unpublished`, the dashboard duplicates the saved live file immediately
- for `published`, the dashboard duplicates the published snapshot immediately
- for `unpublished_changes`, the dashboard opens a chooser so the user can duplicate either the published snapshot or the saved live file with unpublished changes
- the server loads the chosen saved source version, assigns a fresh `project.metadata.id`, updates `project.metadata.title` to the generated duplicate name, and serializes a brand-new `.rivet-project` file
- the duplicate is therefore an independent workflow project, not a filesystem clone that still shares the original project ID
- the dashboard refreshes the tree after duplication but does not auto-select, auto-open, auto-expand folders, highlight, or otherwise change the current editor session

What duplication does **not** copy:

- the settings sidecar (`*.wrapper-settings.json`)
- the dataset sidecar (`*.rivet-data`)
- published snapshots under `.published/`
- execution recording history

That means a duplicated published project starts as a normal unpublished workflow with no endpoint draft, no published endpoint, no snapshot, and no copied recording history.

## Project uploading

Projects can now also be uploaded into workflow folders from the folder-row context menu or through:

- `POST /api/workflows/projects/upload`

Current upload behavior:

- the custom upload action currently exists only on folder rows
- the dashboard opens a browser file picker and reads the chosen `.rivet-project` file locally before sending it to the API
- some browsers do not reliably pre-filter Rivet's custom `.rivet-project` extension in that picker, so the dashboard validates the selected filename after picking and the API validates it again
- the server parses the uploaded project, assigns a fresh `project.metadata.id`, updates `project.metadata.title` to the final saved name, and writes a brand-new `.rivet-project` file into the selected folder
- name collisions are resolved as `Name`, then `Name 1`, `Name 2`, and so on
- the uploaded project starts as a normal unpublished workflow because only the project file is imported
- the dashboard refreshes the tree after upload but does not auto-select, auto-open, auto-expand folders, highlight, or otherwise change the current editor session

What upload does **not** copy:

- the source machine's settings sidecar (`*.wrapper-settings.json`)
- the source machine's dataset sidecar (`*.rivet-data`)
- published snapshots under `.published/`
- execution recording history

## Project downloading

Projects can now also be downloaded from the workflow tree's project-row context menu or through:

- `POST /api/workflows/projects/download`
- `GET /api/workflows/projects/published-versions?relativePath=<project>`
- `PATCH /api/workflows/projects/published-versions/star`
- `POST /api/workflows/projects/published-versions/download`
- `POST /api/workflows/projects/published-versions/preview`
- `POST /api/workflows/projects/published-versions/restore`

The custom context menu currently exists only on project rows. Folder rows still do not expose download actions.

Download behavior is based on saved server-side state only:

- unsaved editor changes are ignored
- only the `.rivet-project` file is downloaded
- dataset sidecars, settings sidecars, published datasets, and recordings are not included

Current download behavior by status:

- **Unpublished**
  - downloads the saved live project file
  - filename tag: `[unpublished]`
- **Published**
  - one-click `Download` in the dashboard downloads the published version, even if the saved live file currently matches it
  - filename tag: `[published]`
- **Unpublished changes**
  - opens a chooser in the dashboard
  - `Download published` returns the published snapshot
  - `Download unpublished changes` returns the saved live project file with the unpublished edits
  - filename tags: `[published]` and `[unpublished changes]`

The download flow is non-destructive to the current UI state:

- it does not refresh the workflow tree
- it does not change the current selection
- it does not auto-open the downloaded project in the editor
- it does not auto-expand folders

Published version history downloads always return the stored `.rivet-project` snapshot for that publish event. They do not bundle datasets or settings sidecars, matching the normal project download contract. The preview endpoint is different: it returns JSON containing the stored project snapshot plus the optional stored dataset snapshot so the editor preview can reflect the saved publish payload without turning that version into a downloadable bundle.

Filename format is:

- `Name [unpublished].rivet-project`
- `Name [published].rivet-project`
- `Name [unpublished changes].rivet-project`

## Published version history

Project Settings exposes a `Published version history` link. The modal lists publish events newest-first, marks the version that is currently serving the published endpoint as `Current`, lets the user star or unstar special versions, paginates the list after 10 versions with the same paging controls used by Run recordings, grows vertically before introducing list scrolling, and lets the user download, preview, or restore any stored project snapshot.

Stars are persisted with the published version record:

- in `filesystem` mode, `isStarred` is stored in `.published/<versionId>.json`
- in `managed` mode, `is_starred` is stored on `workflow_published_versions`
- the dashboard updates the star optimistically but replaces the row with the API response, so the API remains the durable source of truth

In filesystem mode, the metadata filename is the authoritative version ID. If `.published/<versionId>.json` contains a mismatched internal `id`, the API ignores that metadata and falls back to the matching snapshot when it can, so a stale or hand-edited JSON file cannot point history actions at a different snapshot.

Preview opens a detached editor tab through the dashboard/editor bridge instead of opening the source workflow project. The iframe receives `open-published-version-preview`, loads the virtual path `published-version-preview://<encodedRelativePath>/<encodedVersionId>/preview.rivet-project`, fetches the project and optional dataset snapshot from `POST /api/workflows/projects/published-versions/preview`, rewrites the project id to a fresh `published-version-preview:*` id, and imports datasets under that detached id. Because the path and project id are synthetic, the dashboard does not treat the preview as an active workflow project, the Project Settings modal is closed before previewing, and save/publish controls cannot write back to the source workflow. `HostedIOProvider` also rejects both prompt and no-prompt saves for preview projects as a second line of defense.

Restore asks for browser confirmation before making server changes. If confirmed, the selected stored snapshot and dataset replace the saved live project state, then the API publishes that restored state as a brand-new current history entry at the top of the list. The restored entry uses the endpoint name stored on the selected version. In filesystem mode this writes a new `.published/<newVersionId>.rivet-project` snapshot and updates the live `.rivet-project` plus optional `.rivet-data` sidecar; if a later filesystem write fails, the API removes the new published artifacts and rolls the live project/settings back to their pre-restore state. Filesystem restore also refuses a stored snapshot whose embedded project `metadata.id` no longer matches the history owner, so a corrupt history artifact cannot detach the live project from its workflow identity. In managed mode this points both `current_draft_revision_id` and `published_revision_id` at the restored revision and creates a new `workflow_published_versions` row in one transaction. Restore invalidates the same published/latest execution-cache surface as a normal publish, including failed filesystem attempts that reached a concrete project path, so the next endpoint run resolves storage again instead of trusting a warmed older materialization. After restore, the dashboard sends `refresh-open-project-from-disk` for the restored path. If that workflow is active, the editor reloads the current tab from storage; if it is open in a hidden tab, the editor invalidates that tab's cached snapshot so it loads the restored version the next time the user switches back. Restoring a version therefore behaves like reverting the saved project to that version and clicking Publish, rather than moving the current pointer back to an old history row.

The history is keyed by the stable workflow/project ID, not the display name, so renaming or moving a project keeps its history attached. Duplicating and uploading intentionally create fresh workflow IDs, so they start with empty history.

For projects that were already published before the history feature existed, the API exposes the current published snapshot/revision as a single legacy history entry when the stored published pointer still exists. If the user publishes again, the API first backfills that legacy entry where possible, then writes the new version entry, so the previous current publish is not lost from history. New publish events use explicit history metadata/version rows.

Unpublishing clears the current published pointer but keeps history rows/snapshots. Deleting a project removes the project's history along with the live project, sidecars, and recording history.

## Endpoint resolution

Two public endpoint families exist:

- **Published** (`${RIVET_PUBLISHED_WORKFLOWS_BASE_PATH:-/workflows}/:endpointName`)
  - serves the frozen published snapshot
  - stable across live edits
  - belongs to the execution surface
- **Latest** (`${RIVET_LATEST_WORKFLOWS_BASE_PATH:-/workflows-latest}/:endpointName`)
  - serves the live draft project file for a workflow that still has active published lineage
  - uses the current draft endpoint name rather than the frozen published endpoint name
  - reflects unpublished changes immediately
  - belongs to the control surface

Both routes:

- are `POST`-only
- match endpoint names case-insensitively

Endpoint resolution is backend-specific:

- in `filesystem` mode, the API resolves published routes from the published endpoint identity and latest routes from the current draft endpoint identity, but latest is still gated on active published lineage
- in `managed` mode, the API resolves endpoint ownership and the selected revision from Postgres, with project/dataset blobs stored in object storage
- in `managed` mode, the first request after startup or after an invalidating mutation can still be a cold shared-state miss, but warm requests reuse API-local derived caches instead of repeating remote Postgres/object-storage reads for the same revision
- in `managed` mode, API replicas invalidate endpoint-pointer cache entries through same-process post-commit invalidation plus Postgres `LISTEN/NOTIFY`; immutable revision-payload cache entries remain valid by revision id

Fully unpublished projects are not served by either public route family.

There is also an internal published-only route:

- `POST /internal/workflows/:endpointName`

That route is mounted on the execution surface, is not exposed through nginx, and intentionally skips public bearer auth for trusted intra-stack callers.

## HTTP execution contract

Current request/response behavior for all execution routes:

- the incoming JSON request body becomes the workflow `input`
- an empty body is treated as `{}`
- published, internal published, and latest execution routes expose the incoming request headers as `context.headers`
  - header names follow Node/Express lowercase normalization
  - `context.headers` is always a plain JSON object with string values
  - duplicate or multi-value headers are joined with `, `
  - invalid header names, unsafe prototype keys, undefined values, and non-string internal values are omitted
- if the final `output` port is typed as `any`, the response body is that raw output value
- otherwise the response body is the full outputs object
- every response sets `x-duration-ms`
- when `RIVET_WORKFLOW_EXECUTION_DEBUG_HEADERS=true`, execution responses also emit additive debug headers:
  - `x-workflow-resolve-ms`
    - in `filesystem` mode: endpoint-index freshness validation, possible lazy rebuild, and endpoint lookup
    - in `managed` mode: endpoint pointer resolution
  - `x-workflow-materialize-ms`
    - in `filesystem` mode: materialization-cache validation, possible raw file reload plus one-time reparsing, and per-request dataset-provider reconstruction
    - in `managed` mode: immutable revision materialization
  - `x-workflow-execute-ms`
  - `x-workflow-cache`
    - in `filesystem` mode: `hit`, `miss`, or degraded `bypass`
    - in `managed` mode: `hit` or `miss`
- successful object responses get `durationMs` injected unless already present
- failures return JSON with `error.name`/`error.message` plus `durationMs`

## Filesystem hot path

In `filesystem` mode, the published/latest routes now keep a local derived warm path while staying compatibility-first:

- the API warms a local endpoint index at startup for published/latest endpoint pointers
- the cache facade now sits on top of an authoritative uncached filesystem execution source, so uncertain cache state can fall back to the real filesystem rules instead of guessing
- raw project and dataset contents are materialized lazily and validated by file stat before reuse
- the materialization cache now also keeps the parsed `Project` plus attached data for the current file signature, so warm hits avoid reparsing the YAML project file on every request
- the API still rebuilds a fresh `NodeDatasetProvider` per request, so dataset mutations do not leak across runs

Freshness rules stay explicit:

- the filesystem tree remains authoritative
- out-of-band on-disk edits are still honored without restart
- freshness comes from validation against the filesystem, not from a watcher
- global cache validation tracks the workflow tree shape through directories plus workflow settings sidecars
- the selected published endpoint pointer also validates the live inputs that can change published eligibility without a settings-file edit
- project-affecting mutations dirty the endpoint index and the next request can be a one-time rebuild `miss`
- plain hosted saves only invalidate the live-project materialization; they do not need to dirty the endpoint index
- referenced-project loading still stays on the older compatibility path in this pass; the filesystem cache only accelerates published/latest endpoint execution

Filesystem `x-workflow-cache` semantics are now:

- `hit`
  - the startup-warmed endpoint index stayed fresh and served the pointer directly
- `miss`
  - the index had to rebuild because tracked workflow-tree state changed or startup warmup had not happened yet
- `bypass`
  - the cache deliberately fell back to the uncached filesystem source because the cached routing/materialization state was uncertain
  - slower degraded execution is preferred over knowingly serving a stale cached endpoint target

In local Docker, `/workflows` is usually a host bind mount. On Windows/Docker Desktop that bind-mounted filesystem path can still add fixed per-request overhead, but steady-state trivial requests no longer pay the old full recursive endpoint scan and full project/dataset reload every time.

## Managed hot path

In `managed` mode, shared services remain authoritative, but steady-state endpoint execution is intentionally local on each API replica that serves workflow execution:

- the endpoint-pointer cache stores `runKind + normalizedEndpointName -> workflow id + relative path + revision id`
- `workflow_endpoints` stores ownership only for active published/latest public identities, not for fully unpublished saved draft endpoint names
- endpoint sync prunes stale `workflow_endpoints` rows whose lookup no longer matches the owning workflow's active latest or published endpoint identity
- the revision-materialization cache stores immutable raw project and dataset contents by `revisionId`
- the API rebuilds a fresh per-request `Project`, attached data, and `NodeDatasetProvider` from cached raw contents so request isolation is preserved
- publish, save, unpublish, rename, move, and delete operations invalidate the affected endpoint-pointer entries immediately
- if the invalidation listener is unhealthy, the API clears and bypasses the pointer cache until listener health is restored; correctness wins over latency in degraded mode

That means a managed endpoint can have a slower first hit after pod start or after an invalidating workflow mutation, while repeated hits for the same trivial workflow settle onto the warm local path.

That cache/invalidation model is reused unchanged across both API planes:

- execution-plane API replicas serve the published route
- control-plane API replicas still serve the latest route
- both planes stay correct through the same managed invalidation and immutable-revision cache rules

In local Docker combined mode, those same route families still terminate at the single `api` container because the local stacks do not split the API profile by default.

The later cleanup pass did not change those cache semantics. It was structural only:

- execution invalidation and execution loading were extracted out of the large managed backend file into focused internal modules
- behavioral race/degradation tests replaced brittle source-regex assertions
- same-process post-commit invalidation remains authoritative for the writer replica, and the later hardening pass makes that replica ignore its own `NOTIFY` payload when Postgres reflects the same committed change back
- listener lifecycle is hardened so backend initialization waits for the invalidation listener, failed initialization can be retried cleanly, and disposal cannot accidentally let a late listener startup become healthy afterward
- no public execution route contract changed
- negative caching and publish-time prewarm are still intentionally absent in the first version

## Internal wiring

The public routes stayed the same, but the internal ownership boundaries are now explicit:

- `storage-backend.ts` is still the intentional filesystem-versus-managed dispatch seam for hosted workflow operations
- filesystem recording compatibility stays under `wrapper/api/src/routes/workflows/`
  - `recordings.ts` is the public orchestrator
  - `recordings-artifacts.ts` owns bundle-path and artifact read/write helpers
  - `recordings-metadata.ts` owns stored metadata normalization and legacy metadata reads
  - `recordings-maintenance.ts` owns index rebuild, retention cleanup, and run deletion helpers
  - `recordings-store.ts` owns storage readiness, queue backpressure, cleanup scheduling, and test reset state
- managed workflow storage stays under `wrapper/api/src/routes/workflows/managed/`
  - `backend.ts` is the facade/composition root
  - `context.ts`, `db.ts`, `transactions.ts`, `mappers.ts`, `revision-factory.ts`, and `endpoint-sync.ts` own the shared infrastructure seams
  - `catalog.ts`, `revisions.ts`, `publication.ts`, and `recordings.ts` stay domain-local
  - `execution-cache.ts`, `execution-invalidation.ts`, `execution-service.ts`, and `execution-types.ts` stay local to managed execution rather than becoming a generic platform layer
- managed virtual hosted-file semantics stay explicit through `managed-virtual-io.ts` instead of being folded into the filesystem branch

## Workflow execution auth

Public execution auth is separate from the browser UI gate:

- when `RIVET_REQUIRE_WORKFLOW_KEY=true`, both public route families require `Authorization: Bearer <RIVET_KEY>`
- hosts allowlisted in `RIVET_UI_TOKEN_FREE_HOSTS` bypass that public-route auth because nginx forwards a trusted internal-host signal
- if public auth is enabled but `RIVET_KEY` is empty, the public execution routes fail with `500`

See [access-and-routing.md](access-and-routing.md) for the nginx-side details.

## Execution recordings

Every endpoint execution is eligible to persist a recording bundle that the hosted editor can later load and replay:

- published endpoint runs
- latest endpoint runs
- internal published-only runs

Recording capture is intentionally best-effort observability:

- the endpoint response is sent first
- recording persistence is queued in the background after execution finishes
- both successful and failed runs are eligible for recording
- successful runs whose final `output` is `control-flow-excluded` are marked as `suspicious`
- if the queue is full, new recordings are dropped so endpoint execution is not slowed or blocked

Each bundle stores:

```text
<RIVET_WORKFLOW_RECORDINGS_ROOT>/
  <workflowId>/
    <recordingId>/
      metadata.json
      recording.rivet-recording.gz
      replay.rivet-project.gz
      replay.rivet-data.gz     # only when dataset snapshots are enabled and data was present
```

That on-disk layout is the `filesystem`-mode representation.

In `managed` mode, the same logical recording artifacts are stored as object blobs referenced by the `workflow_recordings` row:

- `recording_blob_key`
- `replay_project_blob_key`
- `replay_dataset_blob_key`

- `recording.rivet-recording.gz` is the serialized `ExecutionRecorder` output
- `replay.rivet-project.gz` is an immutable replay snapshot of the executed project state
- `replay.rivet-data.gz` is the dataset snapshot, when present
- `metadata.json` stores timestamp, endpoint, run kind, verdict, duration, encoding, and byte counts

Bundles are keyed by the source workflow metadata ID, so recordings stay attached across project renames, moves, and endpoint-name changes. Project deletion removes that recording history as part of workflow cleanup.

Legacy uncompressed bundles are still readable in `filesystem` mode. Startup reconciliation rebuilds the SQLite index from on-disk metadata and normalizes old `version: 1` metadata into the current index shape there. Retention cleanup during that reconciliation is best-effort: a stale bundle that cannot be removed logs a warning but does not block API startup. In `managed` mode, the source of truth is the Postgres row plus the recording/replay blob keys in object storage.

## Recording defaults and retention

Recording behavior is controlled by env vars:

| Variable | Purpose | Default |
|---|---|---|
| `RIVET_RECORDINGS_ENABLED` | Enable workflow recording persistence | `true` |
| `RIVET_RECORDINGS_COMPRESS` | Blob encoding (`gzip` or `identity`) | `gzip` |
| `RIVET_RECORDINGS_GZIP_LEVEL` | Gzip compression level | `4` |
| `RIVET_RECORDINGS_MAX_PENDING_WRITES` | Background queue size before new recordings are dropped | `100` |
| `RIVET_RECORDINGS_INCLUDE_PARTIAL_OUTPUTS` | Include partial outputs in recorder payloads | `false` |
| `RIVET_RECORDINGS_INCLUDE_TRACE` | Include trace data in recorder payloads | `false` |
| `RIVET_RECORDINGS_DATASET_MODE` | Dataset snapshot mode (`none` or `all`) | `none` |
| `RIVET_RECORDINGS_RETENTION_DAYS` | Delete runs older than this many days (`0` disables) | `14` |
| `RIVET_RECORDINGS_MAX_RUNS_PER_ENDPOINT` | Keep only the newest N runs per endpoint (`0` disables) | `100` |
| `RIVET_RECORDINGS_MAX_TOTAL_BYTES` | Global compressed-byte cap across recordings (`0` disables) | `0` |

Operational defaults are intentionally conservative:

- recordings are enabled and compressed by default
- partial outputs and trace capture are disabled by default
- dataset snapshots are disabled by default
- retention cleanup runs automatically

## Recording index and API shape

The browser does not scan recording bundles directly. The API serves recording lists and artifact lookup from the active backend:

- in `filesystem` mode, from `recordings.sqlite` plus `RIVET_WORKFLOW_RECORDINGS_ROOT`
- in `managed` mode, from Postgres `workflow_recordings` plus recording/replay blobs in object storage

In `filesystem` mode, the API validates the SQLite index against completed recording bundles on disk before serving recording lists and artifacts. A completed bundle is a bundle directory with `metadata.json`; abandoned empty workflow-recording directories under `RIVET_WORKFLOW_RECORDINGS_ROOT` are ignored for drift detection so they do not force every recordings request to rebuild the index.

If repair still cannot converge, for example because a `metadata.json` file exists but cannot be parsed into an index row, the API logs the static mismatch and suppresses repeated repair until the on-disk completed-bundle signature or indexed counts change.

That backend data serves:

- workflow summaries ordered by most recent run
- per-workflow run pagination
- bad-only filtering, where `status=failed` includes both `failed` and `suspicious`
- optional input filtering against each recording's captured workflow request input
- artifact lookup by `recordingId`
- single-run deletion by `recordingId`

The main recordings routes are:

- `GET /api/workflows/recordings/workflows`
- `GET /api/workflows/recordings/workflows/:workflowId/runs?page=1&pageSize=20&status=all|failed&inputPath=$.foo&inputOperator=%3D%3D&inputValue=bar&inputCursor=0`
- `GET /api/workflows/recordings/:recordingId/recording`
- `GET /api/workflows/recordings/:recordingId/replay-project`
- `GET /api/workflows/recordings/:recordingId/replay-dataset`
- `DELETE /api/workflows/recordings/:recordingId`

`GET /api/workflows/recordings` still exists as a compatibility alias for the workflow-list response, but the dashboard uses `/recordings/workflows`.

## Recording browser

The dashboard exposes a `Run recordings` action next to `Runtime libraries`.

Current browser behavior:

- lists currently published workflows and workflows that still have recording history from earlier publication
- sorts workflows by most recent run
- pages runs from the API instead of materializing the whole history at once
- sorts runs by newest first with a recording-ID tie-breaker, so same-millisecond runs keep a stable order across pages and filters
- supports `All` and `Bad only`, where `Bad only` includes both `failed` and `suspicious`
- supports an optional input filter. The filter uses a JSON path where `$` is the workflow request input object recorded under Rivet's `inputs.input.value`; for example, request input `{ "foo": "bar" }` matches `$.foo == bar`. Filtered searches scan newest-first, append matches to the visible list as each cursor response returns, and keep searching automatically until the history is exhausted or the user clicks `Stop search`. Clearing or hiding the filter, closing the modal, or dismissing the modal uses the same stop path and aborts the in-flight request.
- lets the user delete individual stored runs
- opens a run by `recordingId`, not by raw filesystem path
- `useRunRecordingsController.ts` owns workflow loading, run paging/filtering, and delete flow
- `RecordingWorkflowSelect.tsx` and `RecordingRunsTable.tsx` render the focused UI slices instead of leaving all of that state and rendering in `RunRecordingsModal.tsx`

Input filtering does not change how recordings are created. When `inputPath` is present, the API reads existing serialized recording artifacts after the workflow/status filter, newest first, restores Rivet string-table references from each serialized recording payload, extracts the recorded root request input from the `start` or `graphStart` event, and applies the JSON-path/operator/value predicate. The response may return before the full history has been exhausted, even when the current scan window has no matches; in that case `totalRunsExact` is `false`, `hasMore` is `true`, and `nextInputCursor` can be passed back as `inputCursor` to continue searching older recordings. The dashboard uses that cursor automatically, appending each newly found run to the same filtered list and showing a searching/completed/stopped status. This keeps old recordings readable, avoids adding wrapper-specific fields to the recording write path, and makes recent-request lookups responsive even when historical artifacts live in object storage. The browser request is abortable, and the API stops the artifact scan after the current small read batch when the client closes the modal, stops the search, or navigates away. Supported operators are `==`, `!=`, `>`, `>=`, `<`, `<=`, `contains`, `exists`, and `not_exists`. A missing JSON path matches `not_exists`, does not match `exists`, and resolves to actual `undefined` for the other operators; the filter value literal `undefined` also parses as `undefined`. Ordering comparisons with `undefined` do not match.

Deleting a run removes both:

- in `filesystem` mode:
  - the bundle under `RIVET_WORKFLOW_RECORDINGS_ROOT`
  - the corresponding SQLite row
- in `managed` mode:
  - the recording/replay blobs in object storage
  - the corresponding Postgres row

If that was the last run for the workflow:

- in `filesystem` mode, the API also removes the workflow-level recordings directory and workflow row from the SQLite-backed index
- in `managed` mode, the API removes the final `workflow_recordings` row while the workflow itself remains discoverable through normal workflow state

When a run is opened, the hosted editor:

- fetches the serialized recorder payload
- deserializes that payload with the runtime `ExecutionRecorder` export before setting Rivet's loaded-recording state
- opens a virtual replay project path such as `recording://<recordingId>/replay.rivet-project`
- loads the replay project and optional dataset through `HostedIOProvider`
- switches the live selected executor to browser replay mode
- serializes recording/project open commands in the editor iframe so overlapping async loads cannot mix a replay project from one run with a recorder payload from another
- restores the recorder that belongs to the active virtual replay path when the user switches between open recording tabs
- refetches and restores the serialized recorder from the virtual replay path after an iframe/page reload, so a replay tab does not fall back to running the graph with default inputs
- clears any staged recorder cache if the replay project fails to open, so a later retry cannot inherit a stale recorder
- treats the replay snapshot as read-only

## Project rename, move, and delete behavior

When a project or folder is renamed, moved, duplicated, uploaded, downloaded, or deleted, sidecars and publication artifacts stay consistent:

- **Folder rename/move**
  - recomputes every affected project path under that folder
  - returns `movedProjectPaths` so the dashboard/editor bridge can retarget already-open tabs
  - does not create new workflow IDs or copy project contents
- **Folder delete**
  - succeeds only when the folder is empty
  - never implicitly deletes child projects, snapshots, sidecars, or recordings
- **Rename/move**
  - `moveProjectWithSidecars()` renames the project, `.rivet-data`, and `.wrapper-settings.json`
  - folder moves calculate all affected absolute project paths so the dashboard/editor bridge can retarget open tabs
- **Duplicate**
  - creates only a new `.rivet-project` file in the same folder
  - can duplicate either the saved live file or the published snapshot when both exist
  - gives the duplicate a fresh workflow metadata ID and updates its stored title
  - does not copy `.rivet-data`, `.wrapper-settings.json`, `.published/`, published version history, or any recording history
- **Upload**
  - creates only a new `.rivet-project` file in the selected folder
  - gives the uploaded project a fresh workflow metadata ID and updates its stored title to the final saved filename base
  - does not create `.rivet-data`, `.wrapper-settings.json`, `.published/`, published version history, or any recording history
- **Download**
  - reads either the saved live project file or the published snapshot
  - never downloads unsaved editor state
  - never bundles `.rivet-data`, `.wrapper-settings.json`, `.published/`, or any recording history
- **Delete**
  - deletes the project file and sidecars
  - deletes the current published snapshot and the project's published version history
  - deletes recording history by workflow ID and by legacy source-path lookup
  - in `filesystem` mode, that means recording bundles under `RIVET_WORKFLOW_RECORDINGS_ROOT` plus SQLite index rows
  - in `managed` mode, that means recording/replay blobs plus Postgres `workflow_recordings` rows

## Dashboard wiring

The workflow-publication UI now follows the same controller-versus-view split as the backend:

- `WorkflowLibraryPanel.tsx` renders the shell, while `useWorkflowLibraryController.ts` owns refresh, selection, drag/drop, duplicate/download/upload, and modal orchestration
- `ProjectSettingsModal.tsx` is mostly presentational
- `useProjectSettingsActions.ts` owns publish, unpublish, and guarded delete flows
- `WorkflowPublishedVersionHistoryModal.tsx` lists published versions for a project and stars, downloads, previews, or restores a selected stored snapshot
- `projectSettingsForm.ts` owns endpoint validation, last-published labels, and status labels
- `workflowApi.ts` keeps endpoint-specific calls flat while `apiRequest.ts` owns shared JSON/text parsing and error extraction

## Key files

- `wrapper/api/src/routes/workflows/endpoint-names.ts` - shared endpoint-name validation and case-insensitive lookup normalization
- `wrapper/api/src/routes/workflows/publication.ts` - filesystem publication logic, status derivation, and endpoint lookup
- `wrapper/api/src/routes/workflows/published-versions.ts` - filesystem published-version history metadata, star state, listing, download, preview, restore, and cleanup
- `wrapper/api/src/routes/workflows/execution.ts` - public/latest/internal execution handlers and recording enqueue path
- `wrapper/api/src/routes/workflows/hosted-project-contents.ts` - hosted project content normalization shared by filesystem and managed saves
- `wrapper/api/src/routes/workflows/storage-backend.ts` - explicit filesystem-versus-managed dispatch for hosted workflow operations
- `wrapper/api/src/routes/workflows/managed/backend.ts` - managed workflow facade/composition root
- `wrapper/api/src/routes/workflows/managed/context.ts` - managed initialization/disposal ordering and shared dependency container
- `wrapper/api/src/routes/workflows/managed/db.ts` - managed DB retry/query helpers
- `wrapper/api/src/routes/workflows/managed/transactions.ts` - managed transaction runner plus commit/rollback hook sequencing
- `wrapper/api/src/routes/workflows/managed/mappers.ts` - shared row mappers and SQL column constants
- `wrapper/api/src/routes/workflows/managed/revision-factory.ts` - revision/blob-key creation and rollback cleanup helpers
- `wrapper/api/src/routes/workflows/managed/endpoint-sync.ts` - endpoint ownership sync and conflict checks
- `wrapper/api/src/routes/workflows/managed/catalog.ts` - managed folder/project CRUD plus duplicate/upload/download flows
- `wrapper/api/src/routes/workflows/managed/revisions.ts` - managed save/import flows and revision persistence
- `wrapper/api/src/routes/workflows/managed/publication.ts` - managed publish/unpublish mutations plus published-version history star/list/download/preview/restore
- `wrapper/api/src/routes/workflows/managed/recordings.ts` - managed recording import, persistence, listing, artifact reads, and deletion
- `wrapper/api/src/routes/workflows/managed/execution-cache.ts` - managed endpoint-pointer and immutable revision-payload caches
- `wrapper/api/src/routes/workflows/managed/execution-invalidation.ts` - managed execution invalidation listener lifecycle and degraded-mode handling
- `wrapper/api/src/routes/workflows/managed/execution-service.ts` - managed published/latest execution loading and debug info production
- `wrapper/api/src/routes/workflows/recordings.ts` - filesystem recording orchestrator
- `wrapper/api/src/routes/workflows/recordings-artifacts.ts` - filesystem recording artifact path/read/write helpers
- `wrapper/api/src/routes/workflows/recordings-metadata.ts` - filesystem recording metadata normalization and legacy metadata reads
- `wrapper/api/src/routes/workflows/recordings-maintenance.ts` - filesystem retention cleanup, index rebuild, and run deletion helpers
- `wrapper/api/src/routes/workflows/recordings-store.ts` - filesystem recording queue/readiness/cleanup state owner
- `wrapper/api/src/routes/workflows/recordings-config.ts` - recording env parsing and defaults
- `wrapper/api/src/routes/workflows/recordings-db.ts` - SQLite recording index
- `wrapper/api/src/routes/workflows/workflow-mutations.ts` - duplicate, upload, publish, unpublish, rename, move, and delete orchestration
- `wrapper/api/src/routes/workflows/workflow-download.ts` - project-download resolution and attachment filename generation
- `wrapper/api/src/routes/workflows/workflow-query.ts` - workflow tree and hosted-project query helpers
- `wrapper/api/src/routes/workflows/managed-virtual-io.ts` - managed virtual-path helpers used by hosted native IO
- `wrapper/api/src/scripts/measure-workflow-execution.ts` - read-only filesystem/managed endpoint measurement helper for route-timing diagnosis
- `wrapper/web/dashboard/useWorkflowLibraryController.ts` - workflow-tree controller
- `wrapper/web/dashboard/WorkflowInlineRenameInput.tsx` - shared inline rename input used by folder and project tree rows
- `wrapper/web/dashboard/useProjectSettingsActions.ts` - project-settings mutations
- `wrapper/web/dashboard/projectSettingsForm.ts` - project-settings validation and label helpers
- `wrapper/web/dashboard/useRunRecordingsController.ts` - run-recordings controller
- `wrapper/web/dashboard/RecordingWorkflowSelect.tsx` - workflow selector for run recordings
- `wrapper/web/dashboard/RecordingRunsTable.tsx` - paged runs table for run recordings
- `wrapper/shared/workflow-recording-types.ts` - shared recording types and virtual replay path helpers
- `wrapper/shared/workflow-types.ts` - shared workflow types plus managed and published-version preview virtual path helpers
