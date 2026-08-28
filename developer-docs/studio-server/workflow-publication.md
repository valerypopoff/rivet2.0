# Workflow Publication

Workflows can be published as HTTP endpoints, and project-contained Rivet web apps can be published as browser pages. This document describes the current publication, execution, app-serving, and recording model.

In the current deployment model:

- published execution belongs to the execution surface
- latest execution belongs to the control surface
- internal published-only execution also belongs to the execution surface

In `RIVET_API_PROFILE=combined`, the same API process serves both surfaces. In split deployments, `RIVET_API_PROFILE=control` and `RIVET_API_PROFILE=execution` separate them.

## Concepts

- **Project file** (`*.rivet-project`): the live, editable workflow file
- **Settings sidecar** (`*.rivet-project.wrapper-settings.json`): stores the endpoint draft plus endpoint and web-app publication state
- **Stats sidecar** (`*.rivet-project.wrapper-stats.json`): generated wrapper cache for graph/node counts in `filesystem` mode; it is rebuilt when the project file changes and is not part of publication state
- **Published snapshot** (`.published/<snapshotId>.rivet-project`): frozen copy of the currently published project version
- **Published web app**: one `Project.uiGraphs` entry pinned to a frozen project snapshot and exposed as `${RIVET_PUBLISHED_APPS_BASE_PATH:-/apps}/<slug>`, with a companion `${RIVET_LATEST_APPS_BASE_PATH:-/apps-latest}/<slug>` route that serves the latest saved draft for the same published app slug
- **Published version history**: every successful publish creates a durable downloadable history entry for that project
  - in `filesystem` mode: `.published/<versionId>.rivet-project` plus `.published/<versionId>.json` metadata and an optional `.rivet-data` sidecar
  - in `managed` mode: a `workflow_published_versions` row pointing at a durable `workflow_revisions` project blob in object storage
  - version stars are stored on the version metadata/row, so starred history survives browser reloads and server restarts
  - version comments are stored on the same version metadata/row, so operator labels survive browser reloads and server restarts
- **Dataset sidecar** (`*.rivet-data`): optional data associated with a project, published alongside it
- **Execution recording artifacts**
  - in `filesystem` mode: replayable bundles under `<RIVET_WORKFLOW_RECORDINGS_ROOT>/<workflowId>/<recordingId>/`
  - in `managed` mode: replayable blobs in managed object storage, keyed from Postgres metadata
- **Recording metadata index**
  - in `filesystem` mode: SQLite metadata index under `<RIVET_APP_DATA_ROOT>/recordings.sqlite`; it uses rollback journaling rather than WAL so Docker volumes and Kubernetes PVCs do not need SQLite shared-memory support
  - in `managed` mode: metadata rows in Postgres `workflow_recordings`

Projects live under the workflow root configured by `RIVET_WORKFLOWS_ROOT` in the API container and backed by `RIVET_WORKFLOWS_HOST_PATH` on the host in Docker modes.

Published snapshots always belong to workflow storage, but recording storage is backend-specific:

- in `filesystem` mode, recording bundles live under `RIVET_WORKFLOW_RECORDINGS_ROOT` and the metadata index lives under `RIVET_APP_DATA_ROOT` as `recordings.sqlite`
- in `managed` mode, recording metadata lives in Postgres and recording artifacts live in managed object storage

Published version history also belongs to workflow storage. It is not stored in the editor, browser IndexedDB, or recording storage.

## Stored settings model

The settings sidecar stores endpoint publication fields plus any web-app publications:

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
- `publishedWebApps`
  - array of published web-app entries keyed by `uiGraphId`
  - each entry stores the web app display name, public slug, published snapshot id, publish timestamp, and optional OAuth allowed-email list

Important current behavior:

- publishing updates both `endpointName` and `publishedEndpointName`
- publishing also updates `lastPublishedAt`
- unpublishing clears only the `published*` fields and keeps `endpointName` as the saved draft/default
- publishing or unpublishing workflow endpoints does not remove independently published web apps
- publishing or unpublishing a web app does not change workflow endpoint publication state
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

Tree project stats are intentionally separate from publication state. Filesystem mode stores stats in a generated `*.wrapper-stats.json` sidecar keyed by the project file size, modification time, and metadata-change time; managed mode stores stats on immutable `workflow_revisions` rows when a revision is created. Existing managed revisions that predate the stats columns are lazily backfilled the first time the tree needs their counts. These caches let `/api/workflows/tree` avoid re-parsing project contents only for graph/node counts. They must not be used to decide whether a saved project is `Published` or `Unpublished changes`.

In Project Settings:

- `Published` and `Unpublished changes` show `Last published at ...` directly beside the status pill
- `Unpublished` does not show that line and instead shows `Workflow is not published as endpoint.` in the same secondary status-text size and vertical alignment
- older already-published projects that predate the explicit `lastPublishedAt` field fall back to the settings-sidecar file timestamp
- the `Endpoint` tab always shows one compact endpoint row with a non-editable base path prefix, editable endpoint slug, and no extra visible field label; `Publish` creates the first workflow endpoint, while `Update` republishes unpublished changes or applies an endpoint slug change
- `Unpublish` sits next to the workflow endpoint row whenever the workflow is currently published or has unpublished changes
- `Delete project` is in a separated lower section that remains visible regardless of the selected Project Settings tab; it is enabled only when the workflow endpoint is unpublished and no web apps remain published. On the `Endpoint` tab only, that same lower section also shows the `Published version history` secondary action as a visible button.
- endpoint validation in the dashboard mirrors the server: only `Published` and `Unpublished changes` projects reserve endpoint names; fully unpublished projects may keep a saved draft endpoint without blocking another project from publishing there
- Project Settings is split into `Endpoint` and `Web apps` tabs. The `Endpoint` tab owns normal endpoint publication and published-version history. Its endpoint help always describes the currently saved publication until the user clicks `Publish` or `Update`. Endpoint and web-app slug validation errors render directly below their slug controls, before any publication URL/help text. The `Web apps` tab lists `Project.uiGraphs` when present, shows `No web apps in the project.` when there are none, shows `No web apps are published.` above the available list when none are published yet, and lets each web app publish, update, or unpublish its own compact prefixed slug row under `${RIVET_PUBLISHED_APPS_BASE_PATH:-/apps}` without requiring or changing the workflow endpoint publication. Once a web app is published, the displayed `/apps/<slug>` path is a link that opens in a new browser tab using the current Rivet server origin; the `/apps-latest/<slug>` latest-draft link is shown only while that app row is in `Unpublished changes` and the UI graph still exists in the current draft. The app's `Update` button remains disabled until the slug draft changes or the row reports `Unpublished changes`. When web-app OAuth mode is enabled, each row also exposes an allowed-email list. Saving that access list is an access-control update only; it does not republish the app or change its publication status.

## Publish flow

1. User sets an endpoint name and clicks `Publish`.
2. Server validates the name:
   - non-empty
   - letters, numbers, and hyphens only
   - unique across active published and latest endpoint identities, case-insensitively
   - the saved project has a selected Main Graph that still exists
   - in filesystem mode, the copied snapshot still has a selected Main Graph before it becomes active
3. Server computes a SHA-256 hash of `endpointName + project file + dataset state`.
4. Server writes a new published version snapshot and history metadata.
5. Server writes the settings sidecar with `endpointName`, `publishedEndpointName`, `publishedSnapshotId`, `publishedStateHash`, and `lastPublishedAt`.

Every publish gets a new version ID. The latest publish becomes the current `publishedSnapshotId`, while older snapshots remain in published version history.

In managed mode, publish inserts a `workflow_published_versions` row and updates `workflows.published_version_id` to that row. The row points at the draft revision that was published, so the actual project bytes remain in the same managed object-storage revision store as ordinary workflow revisions.

## Web app publish flow

Rivet web apps are stored in project YAML under `Project.uiGraphs`. They are published separately from workflow HTTP endpoints:

1. Project Settings loads the project's web-app list from `GET /api/workflows/projects/web-apps?relativePath=...`.
2. The user assigns a slug for one or more web apps. Slugs use the same public-name rule as workflow endpoints: letters, numbers, and hyphens only.
3. The dashboard posts `{ relativePath, publications: [{ uiGraphId, slug, allowedEmails? }] }` to `POST /api/workflows/projects/web-apps/publish`.
4. The server validates that every `uiGraphId` exists in the current saved project, that every slug is globally unique across published web apps case-insensitively, and that `auth` is not used as an app slug because `${RIVET_PUBLISHED_APPS_BASE_PATH:-/apps}/auth/*` belongs to OAuth callback/logout routes.
5. The server pins the selected web apps to the current saved project snapshot/revision and exposes each as `${RIVET_PUBLISHED_APPS_BASE_PATH:-/apps}/<slug>`.
6. The same published app slug also opens `${RIVET_LATEST_APPS_BASE_PATH:-/apps-latest}/<slug>`, which serves the latest saved draft/current server-side project for that app's UI graph.

Multiple web apps from the same project may be published at the same time as long as their slugs differ. Republish replaces only the selected UI graph publications; other web apps from that project keep serving their previous pinned snapshots. Unpublishing one web app removes only that `uiGraphId` publication and leaves any workflow endpoint publication plus other web apps intact. If a published UI graph is later removed from the draft project, the pinned app still serves from its old snapshot/revision; Project Settings lists it as missing from the current project so it can be explicitly unpublished, but it cannot be republished until the UI graph exists again.

When `Settings` -> `Web apps` -> `Auth` is set to OAuth, Project Settings stores an allowed-email list on each published web app. OAuth web apps are fail-closed: an empty list denies all signed-in users, and a non-empty list is matched case-insensitively against the email returned by the OAuth user-info response. The access list is stored with the web-app publication entry in the filesystem sidecar or managed `workflow_web_apps.allowed_emails` column. It is not written into `.rivet-project` YAML, and changing it through `PATCH /api/workflows/projects/web-apps/access` does not create a new published snapshot or revision.

Each web app row has its own publication status, independent from the workflow endpoint status:

- `Not published` means there is no web-app publication for that `uiGraphId`.
- `Published` means the latest saved draft project plus dataset matches the web app's pinned published snapshot/revision.
- `Unpublished changes` means the latest saved draft project plus dataset differs from the pinned web-app publication. This includes the case where the published UI graph was removed from the current draft; the row remains visible for unpublish, but cannot be republished until that UI graph exists again.

The comparison intentionally ignores the web-app slug and the workflow endpoint name. Renaming a web-app URL slug is an endpoint update, while `Unpublished changes` tracks whether `/apps/<slug>` and `/apps-latest/<slug>` would run against different saved project/dataset content. Publishing or unpublishing the workflow endpoint does not change web-app row statuses unless it is accompanied by an actual saved project/revision change.

A published app exposes two browser routes:

- `${RIVET_PUBLISHED_APPS_BASE_PATH:-/apps}/<slug>` serves the frozen project snapshot captured when that web app was published.
- `${RIVET_LATEST_APPS_BASE_PATH:-/apps-latest}/<slug>` serves the latest saved draft/current server-side project for that same app slug.

The latest web-app route cannot see unsaved in-browser editor state until the editor saves the project. It is "latest saved", matching the server-side latest workflow route model, not a live read from Rivet's in-memory editor tab.

In `filesystem` mode, web-app publications live in the settings sidecar's `publishedWebApps` array, and each publish writes a frozen `.published/<snapshotId>.rivet-project`. When multiple web apps are published in the same request, they share the same frozen snapshot id. Web-app status compares the current saved `.rivet-project` plus `.rivet-data` sidecar with that pinned snapshot plus its copied dataset sidecar. In `managed` mode, each published app is a row in `workflow_web_apps` pointing at the immutable workflow revision that was current when the app was published; status is `Published` only when that row's `revision_id` matches `workflows.current_draft_revision_id`. Filesystem-to-managed migration imports those web-app publication rows from the frozen snapshot files, so an existing `/apps/<slug>` route keeps serving the same pinned project content after cutover.

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
- in both storage modes, the workflow tree/file name is the hosted project title source of truth; saving rewrites `data.metadata.title` back to the current tree name if the editor changed it, and the hosted editor calls `RivetWorkspaceHost.updateProjectMetadata(..., { persistedExternally: true })` after save so open editor title surfaces match the stored tree name without reopening the project. If a future wrapper-owned save flow needs to mark a canonical saved snapshot clean without changing title/description, it should call `markCurrentProjectClean()` or `markProjectClean()` after backend save success instead of touching Rivet's dirty-state atoms.
- in `managed` mode, a no-op save does not create a new draft revision
- in `managed` mode, if the saved contents match the published revision exactly, the save path reuses that published revision instead of creating a distinct draft revision that would incorrectly appear as `unpublished_changes`

## Unpublish flow

1. Server clears the current published pointer.
2. Server clears `publishedEndpointName`, `publishedSnapshotId`, and `publishedStateHash`.
3. Server keeps `endpointName` in the settings sidecar as the saved draft endpoint name.
4. The saved draft endpoint no longer participates in endpoint uniqueness until the project is published again.

Unpublishing does not delete published version history. It closes the public/latest route lineage, but previous published versions remain downloadable from Project Settings. If a pre-history legacy project still has only a current published pointer, unpublish first backfills that current snapshot/revision into history before clearing the pointer.

In the current dashboard UI, the project-row context menu exposes `Rename project`, compare actions, `Download`, `Duplicate`, and `Delete project`.

Single-clicking a project row opens that project in the editor as a preview tab, so browsing through projects does not clutter the editor tab row. Opening another not-yet-open project by single click replaces the previous clean preview tab; when the old preview is active, it is replaced in place so the project selection does not blink back to a persistent project first. Preview tabs are marked through Rivet's transient tab UI state and render italic in the editor tab row. Clicking an already-open persistent project just activates that tab and leaves the current preview tab open until another project needs the preview slot. Double-clicking the row, editing the opened project, running it, saving it, activating Remote Debugger on the active preview project, or hitting an unsafe replacement condition promotes that tab to a normal persistent editor tab. Remote Debugger promotion observes Rivet's `external-debugger` session target only, so hosted internal Node executor reconnects do not persist preview tabs. The project details card keeps the visibly button-like `Settings` action before `Save`; it does not provide a separate edit/open button, shows `Save` only when the selected workflow is the active editor project and has unsaved changes, and becomes empty when the user clicks the workflow-library body outside a project row.

- `Rename project` edits the project name inline in the tree; `Enter` closes the edit field and shows a preloader on the project name while the API saves, while `Esc` or focus leaving the edit field cancels without calling the API
- `Compare opened project with this one` loads the right-clicked project's saved `.rivet-project` as Rivet's compare reference for the currently open editor project; compare mode is transient editor state and is not written into project YAML, settings sidecars, or published history. If the right-clicked project is in `Unpublished changes`, the dashboard asks whether to compare against its published snapshot or saved live file with unpublished changes. The wrapper labels the compare sides with the right-clicked project name, adding a version suffix when that choice was needed, and the open project name.
- `Compare to the published version` appears only on the active/open project row when that project is in `Unpublished changes`; it resolves the current published history entry, loads that stored snapshot as the compare reference, labels the compare sides `Published` and `Unpublished`, and leaves the editor on the live unpublished project instead of opening a preview tab

The folder-row context menu exposes `Rename folder`, `Create project`, `Upload project`, and `Delete folder`.

- `Rename folder` edits the folder name inline in the tree; `Enter` closes the edit field and shows a preloader on the folder name while the API saves, while `Esc` or focus leaving the edit field cancels without calling the API
- `Delete folder` is enabled only for empty folders in the dashboard, and the API still rejects non-empty folder deletion if called directly

`Delete project` is still guarded:

- for projects with no workflow endpoint publication and no published web apps, clicking it opens Project Settings and the user must click `Delete project` there to complete deletion
- for projects with a published workflow endpoint, unpublished workflow changes, or any published web apps, the dashboard shows a toast telling the user to unpublish the workflow endpoint and web apps first

The API delete route rejects direct deletion while a workflow endpoint or web app publication still exists. After the project is fully unpublished, deletion cleans up the project file, sidecars, recording references, and stored publication/history artifacts.

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

Rename treats the workflow tree/file name as the project-title source of truth. After the project file and sidecars move to the new path, the backend also rewrites the saved `.rivet-project` payload so `project.metadata.title` matches the new tree name. In managed storage, the same rule is applied by creating a new current draft revision with the rewritten title and the existing dataset contents; published revisions and published version history remain immutable. This content rewrite is tied to file-name renames only; moving the same project file into another folder does not rewrite the draft payload.

When the API returns `movedProjectPaths`, the dashboard retargets the selected project, open editor tabs, and Project Settings state to the new absolute path without opening a different project. The editor bridge waits for Rivet to acknowledge the path move before the rename/move interaction completes, so immediately reactivating an already-open moved project does not race against stale editor paths and reload from disk. If an already-open project file was renamed, the editor bridge calls `RivetWorkspaceHost.updateProjectMetadata(projectId, { title }, { path, persistedExternally: true, changeSource: 'external-wrapper-rename' })` so Rivet updates the tab title, live project metadata, inactive opened snapshot, remembered path, and clean baseline through its hosted workspace seam. Folder moves and renames where the project file name is unchanged still use the same method with an empty metadata patch plus the new `path`, because the path is the part that changed. The wrapper does not reload the active project or import Rivet dirty-state atoms just to refresh title surfaces, and unrelated unsaved graph edits stay dirty. If the API rejects the rename, the preloader clears and the tree returns to the original row name while the error toast reports the server message.

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
- `PATCH /api/workflows/projects/published-versions/comment`
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

Project Settings exposes a `Published version history` link. The modal lists publish events newest-first, marks the version that is currently serving the published endpoint as `Current`, lets the user star or unstar special versions, add a short comment label for each version, paginates the list after 10 versions with the same paging controls used by Run recordings, grows vertically before introducing list scrolling, and lets the user download, preview, or restore any stored project snapshot.

Stars and comments are persisted with the published version record:

- in `filesystem` mode, `isStarred` and `comment` are stored in `.published/<versionId>.json`
- in `managed` mode, `is_starred` and `comment` are stored on `workflow_published_versions`
- rows without a comment show a secondary `Comment` button; rows with a comment show the saved label as text that switches into an editor when clicked
- the dashboard updates stars optimistically and saves comments on blur/Enter, cancels draft edits on Escape, then replaces the row with the API response, so the API remains the durable source of truth

In filesystem mode, the metadata filename is the authoritative version ID. If `.published/<versionId>.json` contains a mismatched internal `id`, the API ignores that metadata and falls back to the matching snapshot when it can, so a stale or hand-edited JSON file cannot point history actions at a different snapshot.

Preview opens a detached editor tab through the dashboard/editor bridge instead of opening the source workflow project. The iframe receives `open-published-version-preview`, loads the virtual path `published-version-preview://<encodedRelativePath>/<encodedVersionId>/preview.rivet-project`, fetches the project and optional dataset snapshot from `POST /api/workflows/projects/published-versions/preview`, rewrites the project id to a fresh `published-version-preview:*` id, and imports datasets under that detached id. Because the path and project id are synthetic, the dashboard does not treat the preview as an active workflow project, the Project Settings modal is closed before previewing, and save/publish controls cannot write back to the source workflow. `HostedIOProvider` also rejects both prompt and no-prompt saves for preview projects as a second line of defense.

Restore asks for browser confirmation before making server changes. If confirmed, the selected stored snapshot and dataset replace the saved live project state, then the API publishes that restored state as a brand-new current history entry at the top of the list. The restored entry uses the endpoint name stored on the selected version. In filesystem mode this writes a new `.published/<newVersionId>.rivet-project` snapshot and updates the live `.rivet-project` plus optional `.rivet-data` sidecar; if a later filesystem write fails, the API removes the new published artifacts and rolls the live project/settings back to their pre-restore state. Filesystem restore also refuses a stored snapshot whose embedded project `metadata.id` no longer matches the history owner, so a corrupt history artifact cannot detach the live project from its workflow identity. In managed mode this points both `current_draft_revision_id` and `published_revision_id` at the restored revision and creates a new `workflow_published_versions` row in one transaction. Restore invalidates the same published/latest execution-cache surface as a normal publish, including failed filesystem attempts that reached a concrete project path, so the next endpoint run resolves storage again instead of trusting a warmed older materialization. After restore, the dashboard sends `refresh-open-project-from-disk` for the restored path. If that workflow is active, the editor reloads the current tab from storage; if it is open in a hidden tab, the editor invalidates that tab's cached snapshot so it loads the restored version the next time the user switches back. Restoring a version therefore behaves like reverting the saved project to that version and clicking Publish, rather than moving the current pointer back to an old history row.

The history is keyed by the stable workflow/project ID, not the display name, so renaming or moving a project keeps its history attached. Duplicating and uploading intentionally create fresh workflow IDs, so they start with empty history.

For projects that were already published before the history feature existed, the API exposes the current published snapshot/revision as a single legacy history entry when the stored published pointer still exists. If the user publishes again, the API first backfills that legacy entry where possible, then writes the new version entry, so the previous current publish is not lost from history. New publish events use explicit history metadata/version rows.

Unpublishing clears the current published pointer but keeps history rows/snapshots. Deleting a project removes the project's history along with the live project, sidecars, and recording history.

## Endpoint resolution

Four public endpoint families exist:

- **Published** (`${RIVET_PUBLISHED_WORKFLOWS_BASE_PATH:-/workflows}/:endpointName`)
  - serves the frozen published snapshot
  - stable across live edits
  - belongs to the execution surface
- **Published Rivet web app** (`${RIVET_PUBLISHED_APPS_BASE_PATH:-/apps}/:slug`)
  - serves one declarative `Project.uiGraphs` entry from the frozen snapshot/revision captured for that published app
  - belongs to the execution surface
- **Latest Rivet web app** (`${RIVET_LATEST_APPS_BASE_PATH:-/apps-latest}/:slug`)
  - serves the same published app slug from the latest saved draft/current server-side project
  - belongs to the control surface
- **Latest** (`${RIVET_LATEST_WORKFLOWS_BASE_PATH:-/workflows-latest}/:endpointName`)
  - serves the live draft project file for a workflow that still has active published lineage
  - uses the current draft endpoint name rather than the frozen published endpoint name
  - reflects unpublished changes immediately
  - belongs to the control surface

The published and latest workflow execution routes:

- are `POST`-only
- match endpoint names case-insensitively

Published web app routes match app slugs case-insensitively, but preserve the stored slug casing. They have their own HTTP shape:

- `GET ${RIVET_PUBLISHED_APPS_BASE_PATH:-/apps}/:slug`
  - renders HTML for the published UI graph attached to that slug
- `GET ${RIVET_PUBLISHED_APPS_BASE_PATH:-/apps}/:slug/app.json`
  - returns the published UI graph JSON
- `POST ${RIVET_PUBLISHED_APPS_BASE_PATH:-/apps}/:slug/actions/run`
  - runs the clicked button's same-project graph action
- `GET ${RIVET_LATEST_APPS_BASE_PATH:-/apps-latest}/:slug`
  - renders HTML for the latest saved draft of the published UI graph attached to that slug
- `GET ${RIVET_LATEST_APPS_BASE_PATH:-/apps-latest}/:slug/app.json`
  - returns the latest saved draft UI graph JSON
- `POST ${RIVET_LATEST_APPS_BASE_PATH:-/apps-latest}/:slug/actions/run`
  - runs the clicked button's same-project graph action against the latest saved draft

Top-level workflow and web-app route prefixes are wrapper app settings once saved. `Settings` -> `Workflow endpoints` -> `Routes` stores the published/latest workflow slugs, and `Settings` -> `Web apps` -> `Routes` stores the published/latest app slugs. Single-host mode persists `settings/public-routes.json` under `RIVET_APP_DATA_ROOT` and the proxy watches that file. Kubernetes stores the same typed domain in PostgreSQL and the proxy polls the authenticated non-secret settings snapshot. In either topology the proxy regenerates its nginx route include, validates it with `nginx -t`, and reloads nginx when the settings change. The legacy `settings/web-app-routes.json` file is still accepted as a migration fallback for the two web-app route families. `RIVET_PUBLISHED_WORKFLOWS_BASE_PATH`, `RIVET_LATEST_WORKFLOWS_BASE_PATH`, `RIVET_PUBLISHED_APPS_BASE_PATH`, and `RIVET_LATEST_APPS_BASE_PATH` are first-run/deployment defaults when no saved public-route settings value exists. The older `RIVET_WEB_APPS_BASE_PATH` and `RIVET_LATEST_WEB_APPS_BASE_PATH` names still work as aliases for the web-app defaults.

Project Settings displays workflow and web-app endpoint prefixes from the runtime `/api/config` response instead of hardcoding bundled Vite env values. After changing workflow route slugs in `Settings` -> `Workflow endpoints` -> `Routes` or web-app route slugs in `Settings` -> `Web apps` -> `Routes`, the settings modal waits until `/api/config` reflects the new paths before reporting success, so dashboard links and prefixed slug inputs update without a manual Docker/Compose/Kubernetes restart. In proxy-fronted deployments, the new public paths are served after the proxy's internal nginx reload completes; no image rebuild is required.

Newly rendered app pages use the upstream resumable WebSocket action transport at `/apps/<slug>/actions/ws` or `/apps-latest/<slug>/actions/ws`. It starts each action idempotently, streams graph-authored `Report Progress` events, supports explicit cancellation, and reconnects/resumes from durable event sequence numbers without running the graph a second time. The existing `POST .../actions/run` routes remain available for an already-open page produced by an older Rivet renderer; the client never falls back from an interrupted socket action to HTTP because a retry could duplicate an external side effect.

Both transports use the same project resolver family, dataset provider, project-reference loader, `ManagedCodeRunner`, and request-header context injection as workflow execution. The wrapper attaches an `ExecutionRecorder` in the WebSocket gateway's `onProcessorPrepared` hook, before `processor.run()`. After upstream Rivet durably stores the matching terminal socket event, its terminal hook queues the recorder into the normal Run recordings store using the exact server-assigned run id. This keeps concurrent button actions correlated correctly without delaying the browser result. HTML embeds an opaque `revisionKey`; stale HTTP or socket action attempts are rejected with `code: "revision_mismatch"`, and the embedded upstream Rivet web-app client shows a blocking `This app was updated. Reload to continue.` modal rather than auto-refreshing or rerunning the action.

Published web app action runs do not attach Remote Debugger. Latest web app action runs attach the same default-on `/ws/latest-debugger` remote debugger as latest workflow endpoint runs because they execute against the latest saved draft on the control-plane backend. Hardened deployments can explicitly disable that websocket with `RIVET_ENABLE_LATEST_REMOTE_DEBUGGER=false`. Published and latest web app action graph runs are persisted into the same Run recordings history as workflow endpoint runs. Their `endpointNameAtExecution` value is the route path that executed the action, such as `/apps/my-tool` or `/apps-latest/my-tool`, so the Run recordings modal can show whether a saved run came from a workflow endpoint or a web-app action.

The generated Rivet web-app client also handles action failures returned before the wrapper API can format JSON, such as an outer nginx or ingress body-size rejection. It shows the HTTP status message (for example, `413 Request Entity Too Large`) instead of attempting to parse the HTML error page as JSON. This makes the failure understandable, but does not raise an external proxy's request-body limit; configure that proxy or ingress to allow at least the `Settings` -> `Web apps` -> `Button data` limit. Saving that setting hot-reloads wrapper nginx and the HTTP parser; restart/recreate the API process after active actions complete to apply the new WebSocket message ceiling.

Published and latest web apps are browser surfaces, so their HTML, `app.json`, and action routes are gated by the persisted `Settings` -> `Web apps` -> `Auth` mode, not by the workflow endpoint bearer-token setting:

- `Key` is the default. Visitors enter the Rivet key before opening web apps.
- `oauth` shows unauthenticated HTML page requests a hosted `Sign in required` page; its `Sign in` button redirects to the configured OAuth provider and stores a signed HTTP-only web-app session cookie after the callback succeeds. Action and `app.json` requests without a valid session return JSON `401` with `code: "oauth_required"` instead of showing the key prompt.
- `No gate` leaves web-app route auth open at the API layer. Use this only behind an external access-control layer.

Successful UI-gate or OAuth login returns the browser to the original web-app URL, such as `/apps/my-tool/` or `/apps-latest/my-tool/`, instead of always redirecting to `/`. OAuth also signs that original path into the short-lived state cookie so provider-side errors that omit the OAuth `state` parameter, token exchange failures, or missing-email profile responses can still return to the app path with `auth_error=...`. App HTML requests with an OAuth `auth_error` render a sign-in failure page with a retry link instead of immediately starting another OAuth loop, even if a stale login trigger is also present. App HTML requests without a session and without an auth error render a sign-in page first, so users are not unexpectedly thrown to the provider. Web-app HTML and OAuth redirect responses use `Cache-Control: no-store` because they may include auth UI, sign-out links, revision keys, or short-lived state cookies. Hosts listed in `Settings` -> `General` -> `Trusted hosts` bypass web-app auth in every mode, so use that list only for trusted hostnames and keep `RIVET_TRUST_INCOMING_FORWARDED_HEADERS=false` unless a trusted ingress strips and rewrites forwarded headers. Workflow endpoint routes remain bearer/trusted-host routes and do not accept either the UI session cookie or the OAuth web-app session cookie as a substitute for `Authorization`.

Browser CORS is same-origin by default. If a separate browser application must call published workflow routes or other API routes directly, add that exact origin to `RIVET_CORS_ALLOWED_ORIGINS`; do not rely on CORS as an auth boundary and do not add broad public origins for OAuth-protected web apps.

For OAuth provider integration, the `Settings` -> `OAuth` email-claim field accepts dot paths such as `data.email`. External OAuth provider URLs must use `https`; plain `http` is accepted only for localhost development endpoints so client secrets and access tokens are not sent over an unencrypted provider connection. If the provider's profile shape is unknown, enable profile debug logging only temporarily; the API logs the raw profile JSON after the user-info request so operators can choose the claim path, and the flag should be disabled again because the payload can contain profile data.

For local OAuth testing, set the web-app auth mode to OAuth in `Settings` -> `Web apps` -> `Auth`, then choose `Local dummy` as the provider in `Settings` -> `OAuth`. The wrapper then sends the Sign in flow to the active published-app auth route, usually `/apps/auth/dummy`, where the tester can enter any email. Submitting the form still returns through the same callback/session-cookie path that real OAuth creates, so allowed-email lists are tested without a real provider. Dummy OAuth is localhost-only by default and should not be used for production deployments.

OAuth-authenticated web app HTML gets a small wrapper-owned sign-out link so users can switch accounts without clearing browser cookies manually. Sign-out clears only the Rivet web-app OAuth session cookie; it cannot clear the identity provider's own browser session. After sign-out, the next sign-in request includes the standard `prompt=select_account` authorization parameter so providers that support account selection show a chooser instead of silently reusing the previous identity. If the signed-in email is not allowed for that specific published app, the HTML route shows `Web app access denied` with a sign-out-and-retry action instead of a raw `Forbidden` page. If the request fails the earlier same-origin browser check, the HTML route shows `Web app request blocked` with `code: "origin_forbidden"`, which usually means the proxy forwarded an unexpected origin/host combination. Non-HTML action and `app.json` requests keep machine-readable `403` JSON responses.

Endpoint resolution is backend-specific:

- in `filesystem` mode, the API resolves published workflow routes from the published endpoint identity, latest routes from the current draft endpoint identity, and both web-app route families from `publishedWebApps` slugs
- in `managed` mode, the API resolves workflow endpoint ownership from `workflow_endpoints`, web-app ownership from `workflow_web_apps`, and selected revisions from Postgres, with project/dataset blobs stored in object storage; `/apps` reads the app's pinned revision while `/apps-latest` reads the workflow's current draft revision
- in `managed` mode, the first request after startup or after an invalidating mutation can still be a cold shared-state miss, but warm requests reuse API-local derived caches instead of repeating remote Postgres/object-storage reads for the same revision
- in `managed` mode, API replicas invalidate endpoint-pointer cache entries through same-process post-commit invalidation plus Postgres `LISTEN/NOTIFY`; immutable revision-payload cache entries remain valid by revision id

Fully unpublished projects are not served by the workflow execution route families. Published web apps are independent and remain served until their own web-app publication is removed.

There is also an internal published-only route:

- `POST /internal/workflows/:endpointName`

That route is mounted on the execution surface, is not exposed through nginx, and intentionally skips public bearer auth for trusted intra-stack callers.

## HTTP execution contract

Current request/response behavior for all execution routes:

- when the HTTP request has a real body, indicated by a positive
  `Content-Length` or transfer encoding, the parsed JSON body becomes the
  workflow `input`
- when the HTTP request has no body, including a zero-length JSON request, the
  wrapper does not pass `input` to Rivet; Graph Input node defaults can apply
  normally
- an explicit JSON body of `{}` is still a real input value and overrides Graph
  Input defaults with an empty object
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
- when both `RIVET_WORKFLOW_EXECUTION_DEBUG_HEADERS=true` and
  `RIVET_CODE_RUNNER_TELEMETRY=true`, execution responses also emit additive
  ManagedCodeRunner headers:
  - `x-code-runner-calls`
  - `x-code-runner-require-calls`
  - `x-code-runner-prepare-calls`
  - `x-code-runner-compile-calls`
  - `x-code-runner-prepare-ms`
  - `x-code-runner-compile-ms`
  - `x-code-runner-execute-ms`
  - `x-code-runner-cache-hits`
  - `x-code-runner-cache-misses`
  - `x-code-runner-cache`
  - `x-code-runner-force-prepare`
- successful object responses get `durationMs` injected unless already present
- failures return JSON with `error.name`/`error.message` plus `durationMs`

### Durable LLM profile suspension

When an LLM Profile configures automatic suspension, Rivet Studio Server
activates that saved configuration by injecting its health store. Standalone
Rivet intentionally does not enforce the policy. Every Studio Server profile
attempt consults the backend selected for the workflow deployment:

- filesystem mode uses the single-host SQLite health store under `RIVET_APP_DATA_ROOT`
- managed mode uses shared Postgres state across control and execution replicas
- published and latest workflow endpoints receive the store through their processor options
- HTTP compatibility and resumable WebSocket web-app actions receive the same store; reconnecting a web-app action does not create a browser-local health island

The state records only safe profile identity metadata, bounded failure timestamps, suspension state, and permit/lease data. The backend owns time and serializes same-key transitions. A suspended profile is skipped until its suspension ends; after that, one leased recovery attempt is allowed. Candidate activity renews the owning permit without shortening an existing lease. A successful recovery attempt invalidates all permits admitted before the profile was suspended. Stale permits, including a request that finishes after an administrator clears the project history, cannot mutate or recreate the record, and an existing key cannot be rebound to another project. Internally, this uses standard circuit-breaker states and leases; those implementation names are intentionally not shown in the product UI.

`GET /api/workflows/llm-profile-health?projectId=<id>` and `POST /api/workflows/llm-profile-health/reset` are trusted hosted-editor administration surfaces. Both require an exact project id. Reset accepts that project id alone for one atomic project-wide reset, or the project id plus one exact key; unscoped listing and key-only reset are rejected. Runtime `begin`, `finish`, and `renew` identities also require their project id. These routes use the normal wrapper proxy-auth contract and are not public workflow endpoints.

The wrapper-owned Project Settings > LLM profile suspension tab shows profiles that
are currently suspended, awaiting their recovery attempt, or running that attempt.
This keeps retained recovery state visible after a suspension expires instead of
presenting the project as having no operational reliability state. Clearing history
deletes the complete stored record, including failures, suspension, and recovery attempts; it does not alter the
LLM profile suspension settings in the project. Its full-width reliability explanation
is followed by Refresh and Clear-all actions, then a divider and the current
suspension state. Project deletion performs the same project-wide cleanup
before filesystem artifacts are removed or inside the managed workflow deletion
transaction, respectively.

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
- a managed save invalidates execution cache whenever the workflow has either a published workflow endpoint or at least one `workflow_web_apps` row, because `/apps-latest/<slug>` reads the current draft revision even when the project is not published as a workflow endpoint
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
- filesystem recording compatibility stays under `packages/studio-server-api/src/routes/workflows/`
  - `recordings.ts` is the public orchestrator
  - `recordings-artifacts.ts` owns bundle-path and artifact read/write helpers
  - `recordings-metadata.ts` owns stored metadata normalization and legacy metadata reads
  - `recordings-maintenance.ts` owns index rebuild, retention cleanup, and run deletion helpers
  - `recordings-store.ts` owns storage readiness, queue backpressure, cleanup scheduling, and test reset state
- managed workflow storage stays under `packages/studio-server-api/src/routes/workflows/managed/`
  - `backend.ts` is the facade/composition root
  - `context.ts`, `db.ts`, `transactions.ts`, `mappers.ts`, `revision-factory.ts`, and `endpoint-sync.ts` own the shared infrastructure seams
  - `catalog.ts`, `revisions.ts`, `publication.ts`, and `recordings.ts` stay domain-local
  - `execution-cache.ts`, `execution-invalidation.ts`, `execution-service.ts`, and `execution-types.ts` stay local to managed execution rather than becoming a generic platform layer
- managed virtual hosted-file semantics stay explicit through `managed-virtual-io.ts` instead of being folded into the filesystem branch

## Endpoint processor API

Endpoint execution intentionally uses Rivet Node's `createProcessor(...)` rather than `runGraph(...)`. `runGraph(...)` can accept most of the same runtime inputs the wrapper passes today, including request `inputs`, request-header `context`, `ManagedCodeRunner`, dataset providers, project-reference loading, project path, and the latest remote debugger. The reason the wrapper keeps `createProcessor(...)` is that it exposes the underlying `GraphProcessor` before the run starts.

That exposed processor is part of the current recording/replay contract:

- `ExecutionRecorder.record(processor.processor)` must attach before `processor.run()` so endpoint runs produce replay-compatible `recording.rivet-recording.gz` payloads.
- the endpoint can still choose explicit processor runtime behavior if upstream changes `runGraph(...)` defaults, because `createProcessor(...)` accepts `runtimeProfile` while `runGraph(...)` chooses its own default run plan.

Do not replace this path with `runGraph(...)` unless upstream exposes an equivalent pre-run processor/recording hook or the wrapper recording format is deliberately redesigned.

## Workflow execution auth

Public execution auth is separate from server UI auth:

- `Settings` -> `Workflow endpoints` -> `Access control` controls whether workflow endpoint routes require `Authorization: Bearer <RIVET_KEY>`; it is enabled by default and stored in app data
- hosts allowlisted in `Settings` -> `General` -> `Trusted hosts` bypass public-route bearer auth because nginx forwards a trusted internal-host signal
- if public auth is enabled but `RIVET_KEY` is empty, the public execution routes fail with `500`

See [access-and-routing.md](access-and-routing.md) for the nginx-side details.

## Execution recordings

Every workflow endpoint execution and web-app action graph execution is eligible to persist a recording bundle that the hosted editor can later load and replay:

- published endpoint runs
- latest endpoint runs
- internal published-only runs
- published web-app action runs
- latest web-app action runs

Recording capture is intentionally best-effort observability:

- the endpoint response is sent first
- recording persistence is queued in the background after execution finishes
- queued recording work is deferred past the current request turn, so recorder serialization, replay-project serialization, compression, and object/file writes should not inflate endpoint `durationMs` or `x-duration-ms`
- recording duration is the processor execution window, matching `x-workflow-execute-ms`, not the full HTTP request duration
- both successful and failed runs are eligible for recording
- successful runs whose final `output` is `control-flow-excluded` are marked as `suspicious`
- if the queue is full, new recordings are dropped so endpoint execution is not slowed or blocked

Endpoint execution uses the wrapper `ManagedCodeRunner` for API-side
Code/Expression nodes. That runner now avoids runtime-library sync for plain JS
invocations that do not receive `require(...)`, prepares managed runtime
libraries lazily at most once per workflow request when `require(...)` is
enabled, reuses a request-scoped managed `require` resolver, invalidates stale
managed package modules when a later request observes a new active
runtime-library snapshot, and caches successful compiled functions without
caching request values. This keeps recording behavior unchanged: recordings
still attach before `processor.run()`, while CodeRunner telemetry is additive
diagnostics only.

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

Recording history limits are wrapper-owned app settings, not deployment env. The dashboard exposes them under `Settings` -> `Run recordings`, and the API stores them as `settings/run-recordings.json` under `RIVET_APP_DATA_ROOT`. The saved settings are:

| Setting | Purpose | Default |
|---|---|---|
| `Queued recording writes` | How many recording save jobs can wait in memory before new recordings are skipped | `100` |
| `Runs kept per workflow endpoint` | Choose whether to keep every run for each endpoint or keep only the newest N runs | `Keep latest runs: 100` |
| `Days to keep recordings` | Choose whether to keep recordings forever or delete them after N days | `Keep for some time: 14 days` |

The legacy `RIVET_RECORDINGS_MAX_PENDING_WRITES`, `RIVET_RECORDINGS_MAX_RUNS_PER_ENDPOINT`, and `RIVET_RECORDINGS_RETENTION_DAYS` env vars are ignored so runtime retention policy comes only from the App Settings UI.

The remaining recording behavior is controlled by env vars:

| Variable | Purpose | Default |
|---|---|---|
| `RIVET_RECORDINGS_ENABLED` | Enable workflow recording persistence | `true` |
| `RIVET_RECORDINGS_COMPRESS` | Blob encoding (`gzip` or `identity`) | `gzip` |
| `RIVET_RECORDINGS_GZIP_LEVEL` | Gzip compression level | `4` |
| `RIVET_RECORDINGS_INCLUDE_PARTIAL_OUTPUTS` | Include partial outputs in recorder payloads | `false` |
| `RIVET_RECORDINGS_INCLUDE_TRACE` | Include trace data in recorder payloads | `false` |
| `RIVET_RECORDINGS_DATASET_MODE` | Dataset snapshot mode (`none` or `all`) | `none` |
| `RIVET_RECORDINGS_MAX_TOTAL_BYTES` | Global compressed-byte cap across recordings (`0` disables) | `0` |

Operational defaults are intentionally conservative:

- recordings are enabled and compressed by default
- partial outputs and trace capture are disabled by default
- dataset snapshots are disabled by default
- retention cleanup runs automatically

Retention applies to both storage backends. The per-endpoint cap groups by workflow id plus historical endpoint name, preserving independent allowances when a slug is later reused by another project. Filesystem cleanup deletes bundle directories and SQLite rows. Managed cleanup deletes matching Postgres rows transactionally and removes their recording/replay objects after commit; concurrent replicas delete blobs only for rows they actually claimed. Per-endpoint and age cleanup stays workflow/endpoint-scoped on ordinary managed writes, while startup reconciliation and the optional global byte cap inspect the full recording metadata set.

## Recording index and API shape

The browser does not scan recording bundles directly. The API serves recording lists and artifact lookup from the active backend:

- in `filesystem` mode, from `recordings.sqlite` plus `RIVET_WORKFLOW_RECORDINGS_ROOT`
- in `managed` mode, from Postgres `workflow_recordings` plus recording/replay blobs in object storage

In `filesystem` mode, startup reconciliation validates and rebuilds the SQLite index from completed recording bundles. Normal workflow-summary, run-page, artifact-read, and delete requests trust that maintained index instead of traversing every bundle before responding. The workflow-summary route can schedule a throttled background drift check after its response path; that repair scans metadata first and replaces the index in one SQLite transaction, so concurrent readers see either the previous complete index or the repaired complete index. If normal persistence or deletion changes the index during the scan, a revision guard discards the stale replacement instead of overwriting the newer mutation. A completed bundle is a bundle directory with `metadata.json`, and abandoned empty workflow-recording directories are ignored. This keeps manual/on-disk drift repair without making a large history capable of timing out `GET /api/workflows/recordings/workflows`.

Drift detection compares both counts and stable bundle keys, so replacing one indexed bundle with another cannot escape repair merely because the totals stayed equal. If repair still cannot converge, for example because a `metadata.json` file exists but cannot be parsed into an index row, the API logs the static mismatch and suppresses repeated repair until the on-disk completed-bundle signature or indexed state changes.

That backend data serves:

- workflow summaries ordered by most recent run
- per-workflow run pagination
- bad-only filtering, where `status=failed` includes both `failed` and `suspicious`
- optional input filtering against each recording's captured workflow request or graph action input
- artifact lookup by `recordingId`
- single-run deletion by `recordingId`

The workflow summary and ordinary run pages are metadata-only reads. They do not read compressed recording/replay payloads, and the workflow summary omits project graph/node statistics and aggregate web-app publication status that the recordings modal does not display. Full recording or replay artifacts are loaded only when the user opens a run; input filtering reads recording artifacts incrementally because the predicate depends on captured input data.

Completed bundle publication is crash-aware. Filesystem metadata becomes visible only after all artifacts are written; the completion marker is published by atomic rename, and the corresponding workflow/run index rows are inserted in one SQLite transaction. Recorder serialization and storage remain background work so they do not inflate endpoint response timing. Graceful API shutdown drains queued recording writes after active WebSocket actions are interrupted and their terminal hooks have run, then closes managed workflow storage. This protects accepted recordings during normal Docker/Kubernetes rollouts; forced process termination and queue overflow remain explicit loss boundaries and are logged.

The main recordings routes are:

- `GET /api/workflows/recordings/workflows`
- `GET /api/workflows/recordings/workflows/:workflowId/runs?page=1&pageSize=20&status=all|failed&inputPath=$.foo&inputOperator=%3D%3D&inputValue=bar&inputCursor=0`
- `GET /api/workflows/recordings/:recordingId/recording`
- `GET /api/workflows/recordings/:recordingId/replay-project`
- `GET /api/workflows/recordings/:recordingId/replay-dataset`
- `DELETE /api/workflows/recordings/:recordingId`
- `GET /api/workflows/run-statistics/targets?surface=endpoint|web_app`
- `POST /api/workflows/run-statistics/query`

`GET /api/workflows/recordings` still exists as a compatibility alias for the workflow-list response, but the dashboard uses `/recordings/workflows`.

## Recording browser

The dashboard exposes a `Run recordings` action next to `Runtime libraries`.

It also exposes a separate `Run statistics` action. It uses indexed recording metadata only; it never reads or decompresses replay bundles just to calculate timings. Its target dropdown is the complete retained endpoint or web-app action catalog for the selected surface, independent of period, version, and outcome filters. The modal defaults to the last seven days of successful published runs and lets a developer switch among those targets, choose 24-hour/7-day/30-day/90-day/custom periods, include failed or warning (`suspicious`) runs, and select Published, Latest, or Both. When the selected target has no runs under those filters, it stays selected and the modal says so below the filters. It reports count, median, P95, average, fastest, and slowest processor execution time for the selected period only. A colored Run outcomes section always shows the succeeded, error, and warning counts and percentages for every matching run, even when errors or warnings are excluded from duration metrics. The chart uses hour/day/week/month buckets according to the selected span.

New recording rows snapshot an execution identity before they are persisted: endpoint graph identity, or web-app UI graph/component identity and labels. This keeps web-app action statistics grouped by the stable UI graph and component IDs even after a project, app, or button is renamed. Older rows without that identity are shown as a `Legacy action` when their recorded endpoint path begins with `/`; other identity-less historical rows are treated as workflow endpoint runs. Malformed historical rows that identify themselves as web-app actions but lack either stable UI graph or component ID are also shown as a `Legacy action`, regardless of the old route shape. Statistics are therefore an observability view over retained historical data, not a claim about the project currently published at a matching slug.

Current browser behavior:

- lists currently published workflows and workflows that still have recording history from earlier publication
- sorts workflows by most recent run
- shows each workflow's neutral saved-recording count badge in the workflow dropdown
- pages runs from the API instead of materializing the whole history at once
- sorts runs by newest first with a recording-ID tie-breaker, so same-millisecond runs keep a stable order across pages and filters
- shows each run's historical endpoint name from `endpointNameAtExecution`, so recordings remain understandable after endpoint renames or republishing under a new endpoint
- supports `All` and `Bad only`, where `Bad only` includes both `failed` and `suspicious`
- supports an optional input filter. The filter uses a JSON path where `$` is the root graph input value recorded under Rivet's `inputs.input.value`; for workflow endpoint runs that value is the HTTP request body, and for web-app action runs with an `input` graph port it is the UI state mapped to that port. If a recorded run has graph inputs but no `input` port, `$` falls back to an object of all captured graph input values keyed by port name. For example, request input `{ "foo": "bar" }` matches `$.foo == bar`. Filtered searches scan newest-first, append matches to the visible list as each cursor response returns, and keep searching automatically until the history is exhausted or the user clicks `Stop search`. Clearing or hiding the filter uses the same stop path and aborts the in-flight request.
- hides without resetting when the user opens a recording from the list. The left panel then shows a compact `Found: N` indicator on the `Run recordings` row, and reopening the modal restores the same workflow, filter, page, and found list so the user can inspect multiple recordings. The modal state is flushed only by the explicit close button.
- lets the user delete individual stored runs
- opens a run by `recordingId`, not by raw filesystem path
- `useRunRecordingsController.ts` owns workflow loading, run paging/filtering, and delete flow
- `RecordingWorkflowSelect.tsx` and `RecordingRunsTable.tsx` render the focused UI slices instead of leaving all of that state and rendering in `RunRecordingsModal.tsx`

Input filtering does not change how recordings are created. When `inputPath` is present, the API reads existing serialized recording artifacts after the workflow/status filter, newest first, restores Rivet string-table references from each serialized recording payload, extracts the recorded root graph input value from the `start` or `graphStart` event, and applies the JSON-path/operator/value predicate. The extractor keeps endpoint compatibility by preferring `inputs.input.value`; when a web-app action or other graph run records only named input ports, it searches an object of all captured input values instead. The response may return before the full history has been exhausted, even when the current scan window has no matches; in that case `totalRunsExact` is `false`, `hasMore` is `true`, and `nextInputCursor` can be passed back as `inputCursor` to continue searching older recordings. The dashboard uses that cursor automatically, appending each newly found run to the same filtered list and showing a searching/completed/stopped status. This keeps old recordings readable, avoids adding wrapper-specific fields to the recording write path, and makes recent-request lookups responsive even when historical artifacts live in object storage. The browser request is abortable, and the API stops the artifact scan after the current small read batch when the client explicitly closes the modal, stops the search, clears or hides the filter, or navigates away. Supported operators are `==`, `!=`, `>`, `>=`, `<`, `<=`, `contains`, `exists`, and `not_exists`. When `contains` receives a filter value that parses as a string, including single-quoted text such as `'request_id'`, the resolved left operand is treated as a string too; objects and arrays are JSON-stringified, so `$ contains 'request_id'` searches the whole recorded input object. A missing JSON path matches `not_exists`, does not match `exists`, and resolves to actual `undefined` for the other operators; the filter value literal `undefined` also parses as `undefined`. Ordering comparisons with `undefined` do not match.

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

- `WorkflowLibraryPanel.tsx` renders the shell, while `useWorkflowLibraryController.ts` composes the tree and modal domains
- `useWorkflowLibraryTree.ts` owns refresh, stale-request protection, folder expansion, and save-triggered reconciliation
- `useWorkflowLibrarySelection.ts` owns selection, active-row scrolling, folder auto-expansion, and the single preview-open slot/debounce
- `useWorkflowLibraryDragAndDrop.ts` owns drag state and move reconciliation; `useWorkflowLibraryMutations.ts` owns create/upload/rename/delete operations and inline mutation state
- `useWorkflowProjectVersionActions.ts` owns duplicate/download/compare version choice and busy state; `useRunRecordingsModalState.ts` owns retained Run recordings modal state
- `ProjectSettingsModal.tsx` is mostly presentational
- `useProjectSettingsActions.ts` owns publish, unpublish, and guarded delete flows
- `WorkflowPublishedVersionHistoryModal.tsx` lists published versions for a project and stars, downloads, previews, or restores a selected stored snapshot
- `projectSettingsForm.ts` owns endpoint validation, last-published labels, and status labels
- `workflowApi.ts` keeps endpoint-specific calls flat while `apiRequest.ts` owns shared JSON/text parsing and error extraction

## Key files

- `packages/studio-server-api/src/routes/workflows/endpoint-names.ts` - shared endpoint-name validation and case-insensitive lookup normalization
- `packages/studio-server-api/src/routes/workflows/publication.ts` - filesystem publication logic, status derivation, and endpoint lookup
- `packages/studio-server-api/src/routes/workflows/web-app-publication.ts` - filesystem web-app publication, republish, and per-app unpublish mutations
- `packages/studio-server-api/src/routes/workflows/published-versions.ts` - filesystem published-version history metadata, star state, listing, download, preview, restore, and cleanup
- `packages/studio-server-api/src/routes/workflows/execution.ts` - public/latest/internal execution handlers and recording enqueue path
- `packages/studio-server-api/src/routes/workflows/hosted-project-contents.ts` - hosted project content normalization shared by filesystem and managed saves
- `packages/studio-server-api/src/routes/workflows/storage-backend.ts` - explicit filesystem-versus-managed dispatch for hosted workflow operations
- `packages/studio-server-api/src/routes/workflows/managed/backend.ts` - managed workflow facade/composition root
- `packages/studio-server-api/src/routes/workflows/managed/context.ts` - managed initialization/disposal ordering and shared dependency container
- `packages/studio-server-api/src/routes/workflows/managed/db.ts` - managed DB retry/query helpers
- `packages/studio-server-api/src/routes/workflows/managed/transactions.ts` - managed transaction runner plus commit/rollback hook sequencing
- `packages/studio-server-api/src/routes/workflows/managed/mappers.ts` - shared row mappers and SQL column constants
- `packages/studio-server-api/src/routes/workflows/managed/revision-factory.ts` - revision/blob-key creation and rollback cleanup helpers
- `packages/studio-server-api/src/routes/workflows/managed/endpoint-sync.ts` - endpoint ownership sync and conflict checks
- `packages/studio-server-api/src/routes/workflows/managed/catalog.ts` - managed folder/project CRUD plus duplicate/upload/download flows
- `packages/studio-server-api/src/routes/workflows/managed/revisions.ts` - managed save/import flows and revision persistence
- `packages/studio-server-api/src/routes/workflows/managed/publication.ts` - managed publish/unpublish mutations plus published-version history star/list/download/preview/restore
- `packages/studio-server-api/src/routes/workflows/managed/recordings.ts` - managed recording import, persistence, listing, artifact reads, and deletion
- `packages/studio-server-api/src/routes/workflows/managed/execution-cache.ts` - managed endpoint-pointer and immutable revision-payload caches
- `packages/studio-server-api/src/routes/workflows/managed/execution-invalidation.ts` - managed execution invalidation listener lifecycle and degraded-mode handling
- `packages/studio-server-api/src/routes/workflows/managed/execution-service.ts` - managed published/latest execution loading and debug info production
- `packages/studio-server-api/src/routes/workflows/recordings.ts` - filesystem recording orchestrator
- `packages/studio-server-api/src/routes/workflows/recordings-artifacts.ts` - filesystem recording artifact path/read/write helpers
- `packages/studio-server-api/src/routes/workflows/recordings-metadata.ts` - filesystem recording metadata normalization and legacy metadata reads
- `packages/studio-server-api/src/routes/workflows/recordings-maintenance.ts` - filesystem retention cleanup, index rebuild, and run deletion helpers
- `packages/studio-server-api/src/routes/workflows/recordings-store.ts` - filesystem recording queue/readiness/cleanup state owner
- `packages/studio-server-api/src/routes/workflows/recordings-config.ts` - recording env/app-settings parsing and defaults
- `packages/studio-server-api/src/routes/workflows/recordings-db.ts` - SQLite recording index
- `packages/studio-server-api/src/routes/workflows/workflow-mutations.ts` - duplicate, upload, publish, unpublish, rename, move, and delete orchestration
- `packages/studio-server-api/src/routes/workflows/workflow-download.ts` - project-download resolution and attachment filename generation
- `packages/studio-server-api/src/routes/workflows/workflow-query.ts` - workflow tree and hosted-project query helpers
- `packages/studio-server-api/src/routes/workflows/managed-virtual-io.ts` - managed virtual-path helpers used by hosted native IO
- `packages/studio-server-api/src/scripts/measure-workflow-execution.ts` - read-only filesystem/managed endpoint measurement helper for route-timing diagnosis
- `packages/studio-server-web/dashboard/useWorkflowLibraryController.ts` - workflow-tree controller
- `packages/studio-server-web/dashboard/useWorkflowLibraryTree.ts` - workflow-tree loading and expansion state
- `packages/studio-server-web/dashboard/useWorkflowLibrarySelection.ts` - project selection and preview-open lifecycle
- `packages/studio-server-web/dashboard/useWorkflowLibraryDragAndDrop.ts` - tree drag/drop operations
- `packages/studio-server-web/dashboard/useWorkflowLibraryMutations.ts` - folder/project create, upload, rename, and delete operations
- `packages/studio-server-web/dashboard/useWorkflowProjectVersionActions.ts` - duplicate, download, and compare version actions
- `packages/studio-server-web/dashboard/WorkflowInlineRenameInput.tsx` - shared inline rename input used by folder and project tree rows
- `packages/studio-server-web/dashboard/useProjectSettingsActions.ts` - project-settings mutations
- `packages/studio-server-web/dashboard/projectSettingsForm.ts` - project-settings validation and label helpers
- `packages/studio-server-web/dashboard/useRunRecordingsController.ts` - run-recordings controller
- `packages/studio-server-web/dashboard/RecordingWorkflowSelect.tsx` - workflow selector for run recordings
- `packages/studio-server-web/dashboard/RecordingRunsTable.tsx` - paged runs table for run recordings
- `packages/studio-server-shared/workflow-recording-types.ts` - shared recording types and virtual replay path helpers
- `packages/studio-server-shared/workflow-types.ts` - shared workflow types plus managed and published-version preview virtual path helpers
