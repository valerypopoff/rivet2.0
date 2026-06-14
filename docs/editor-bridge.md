# Editor Bridge

The dashboard and the Rivet editor run in separate browsing contexts:

- the dashboard is the top-level page at `/`
- the editor loads inside an `<iframe>` pointed at `/?editor`

They communicate through `window.postMessage`.

## Contract

All message types live in `wrapper/shared/editor-bridge.ts`. Both sides import from the same file so the contract cannot drift.

### Dashboard-to-editor commands

| Type | Payload | When sent |
|---|---|---|
| `open-project` | `path`, `replaceCurrent`, optional `reloadFromDisk` | User opens or creates a workflow project |
| `open-recording` | `recordingId`, `replaceCurrent` | User opens a stored workflow run from the recordings browser |
| `open-published-version-preview` | `relativePath`, `versionId`, `replaceCurrent` | User previews a stored published workflow version from Project Settings |
| `compare-open-project-with` | `path`, optional `referencePath` | User starts Rivet compare mode from another project row in the workflow tree |
| `refresh-open-project-from-disk` | `path` | A server-side mutation changed a project that may already be open in the editor |
| `save-project` | (none) | User saves from the dashboard surface or presses the save shortcut outside the iframe |
| `trigger-editor-duplicate-shortcut` | `modifier` | Dashboard-focused `Ctrl+D` / `Cmd+D` should duplicate the selected Rivet node instead of opening browser bookmark UI |
| `trigger-editor-find-shortcut` | `modifier` | Dashboard-focused `Ctrl+F` / `Cmd+F` should open Rivet search instead of browser find |
| `delete-workflow-project` | `path`, `projectId` | User deletes a workflow project from the dashboard |
| `workflow-paths-moved` | `moves[]` | A project or folder rename/move changed one or more workflow project references |

### Editor-to-dashboard events

| Type | Payload | When sent |
|---|---|---|
| `editor-ready` | (none) | Editor iframe mounted and is ready to receive commands |
| `project-opened` | `path` | A project or replay opened successfully |
| `project-open-failed` | `path`, `error` | Open failed for a project path or recording ID |
| `active-project-path-changed` | `path` | User switched the active tab inside the editor |
| `open-project-count-changed` | `count` | Number of open editor tabs changed |
| `project-compare-failed` | `path`, `error` | A project-tree compare reference could not be loaded or deserialized |
| `project-saved` | `path` | Current project saved successfully |

## Message flow

1. The dashboard renders the iframe. The editor emits `editor-ready` once mounted.
2. Commands sent before `editor-ready` are buffered by `useEditorCommandQueue` and flushed once the editor is ready.
3. Both sides validate message shape and origin before acting.
4. Project, recording, published-version preview, refresh, and project-compare commands are serialized inside the editor iframe so overlapping async work cannot leave the active virtual project state from different runs.
5. `open-project` uses the project reference supplied by the workflow tree, loads the snapshot through `HostedIOProvider`, then opens or replaces it through Rivet's `RivetWorkspaceHost`. The optional `reloadFromDisk` flag is reserved for server-side mutations such as published-version restore; it forces an already-open project path to bypass the cached in-memory snapshot and reload the saved project from storage before replacing the current tab. The wrapper keeps only the hosted path lookup, duplicate-id guard, stale-empty-tab cleanup, and replace-current confirmation around that upstream workspace handle. The opened-project sync also preserves an empty tab strip across reloads: it must not recreate a pathless `projectState` as a tab, and it normalizes stale persisted tab metadata by dropping missing entries, orphan metadata, duplicate project ids, legacy full-project payloads, and pathless entries with no active project or snapshot. When damaged duplicate entries share an id, it keeps the file-backed one.
6. In `filesystem` mode that reference is a real server filesystem path. In `managed` mode it is a virtual managed path under `/managed/workflows/...`, even though the shared bridge type still uses the legacy field name `path`.
7. Hosted editor project tabs show only the project title. The wrapper strips upstream's bracketed file-name suffix from `ProjectSelector` at build time because the workflow tree already owns the file/path context and this repo does not commit changes inside the vendored `rivet/` tree. That transform is scoped to the upstream file and tolerant of LF/CRLF line endings from linked Rivet checkouts. It recognizes the older all-tabs suffix expression and the newer active-tab-only suffix expression, but it still fails loudly if the upstream tab-label expression changes again and needs a fresh review.
8. `open-recording` first fetches the serialized recorder payload for the selected `recordingId`, extracts the preferred start graph, and asks the editor to open the virtual path `recording://<recordingId>/replay.rivet-project`.
9. When that virtual path loads, `HostedIOProvider` fetches the replay project and optional replay dataset from the API and imports the dataset snapshot into browser replay state.
10. `open-published-version-preview` asks the editor to open the virtual path `published-version-preview://<encodedRelativePath>/<encodedVersionId>/preview.rivet-project`. When that path loads, `HostedIOProvider` fetches the stored project snapshot and optional dataset snapshot from the published-version preview API, rewrites the project id to a fresh `published-version-preview:*` id, and imports datasets under that detached id. The dashboard closes Project Settings before opening the preview so the visible editor tab is not still coupled to the source workflow's publish controls.
11. Published-version previews are read-only and detached from the source workflow. Both prompt and no-prompt saves throw for preview projects, the dashboard has no active workflow project for the virtual path, and preview tabs cannot publish back into the workflow tree.
12. `refresh-open-project-from-disk` handles published-version restore and other server-side mutations that change a project the editor may already have open. If that project is active, the bridge reloads it from storage with `replaceCurrent` and `reloadFromDisk`. If it is open in a hidden tab, the bridge clears the hidden tab snapshot and opened-project session cache without changing focus; when the user switches back, upstream `useLoadProject` loads the saved project from storage instead of replaying the stale snapshot.
13. The bridge caches the loaded recorder by virtual replay path and restores or clears `loadedRecordingState` when the active tab path changes, because Rivet's loaded-recording state is global while the hosted workspace can keep multiple recording tabs open. Whenever a recorder is attached, the bridge forces Rivet's live `selectedExecutorState` to `browser`; changing only the default executor is not enough in current Rivet because `useGraphExecutor` routes clicks through the live selected executor. If a replay tab is restored after an iframe/page reload, the bridge derives the recording ID from the virtual path, refetches the serialized recorder, and restores browser replay mode for that tab instead of treating it as a normal runnable project.
14. Replay projects are read-only. A plain save from a replay project throws and the user must use Save As to create a normal project file.
15. `delete-workflow-project` carries the project metadata id returned by the delete API, resolves the hosted path to any current open tab, then calls `RivetWorkspaceHost.closeProject()` when the tab is still open. If that tab was active, upstream Rivet owns the fallback-tab load and can fail safely without dropping the current tab. The hosted build keeps Rivet's editor-owned project context values durable across close/reopen: those values live in app storage under keys like `projectContext__"<projectId>"`, so hosted tab close and replace-current transitions must not delete them just because the tab was closed. Actual workflow deletion is different: the bridge clears stored project context and hosted dataset cache for both the API-returned deleted project id and any open-tab project id for that deleted path even if the tab-close transition cannot complete, so replaced-file and already-closed-tab state are covered.
16. `workflow-paths-moved` rewrites wrapper revision/session caches and then calls `RivetWorkspaceHost.moveProjectPaths()` so open tabs, loaded-project state, and later saves keep pointing at the new location. In `managed` mode those `fromAbsolutePath` and `toAbsolutePath` fields contain managed virtual project paths rather than host filesystem paths.
17. Folder rename uses that same `workflow-paths-moved` path-rewrite flow for every affected project path under the folder.
18. Project duplication does not use the editor bridge. The dashboard calls `POST /api/workflows/projects/duplicate` directly, refreshes the workflow tree, and intentionally leaves selection and open tabs unchanged.
19. Project-tree compare uses `compare-open-project-with`. The dashboard sends the right-click target's hosted project path only when a normal workflow project is already open and the target is a different workflow project. The iframe bridge loads only the reference `.rivet-project` payload through `/api/projects/load`, deserializes it, and sets Rivet's transient `projectCompareReferenceState` for the current editor project. It does not import reference datasets, persist compare state, or write wrapper project metadata.
20. Project uploading also does not use the editor bridge. The dashboard opens a browser file picker, posts the selected file to `POST /api/workflows/projects/upload`, refreshes the workflow tree, and leaves selection and open tabs unchanged.
21. Project downloading also does not use the editor bridge. The dashboard calls `POST /api/workflows/projects/download` directly and only downloads saved server-side project files.
22. Empty-folder deletion is API-only and does not need special bridge cleanup because no workflow project paths move; the dashboard just refreshes the tree after the delete succeeds.
23. On `project-saved`, the hosted editor first reconciles the active project metadata and tab label back to the saved file-tree name without reloading the project, then the dashboard refreshes the workflow tree from the API and trusts the server-derived publication status. It does not locally force a `published -> unpublished_changes` status flip first, and the server now keeps published projects in `published` when the save was a true no-op.
24. On `project-opened`, both sides of the hosted bridge explicitly move focus to the editor iframe so keyboard shortcuts target the editor instead of the workflow-library row that triggered the open.
25. If the iframe reloads, `onLoad` resets `editorReady` to `false`, re-enabling the command buffer until `editor-ready` is sent again.

## Save behavior

Save can be initiated from either context:

- inside the iframe, the editor bridge listens for `Ctrl+S` / `Cmd+S` and calls the editor's normal save flow across platforms, including hosted Windows browser sessions
- outside the iframe, the dashboard captures the save shortcut and sends `save-project`
- save completion is reported through `RivetAppHost.onProjectSaved`, which the wrapper forwards to the dashboard as `project-saved`; the wrapper does not override upstream save/menu hooks just to observe saves
- the API validates the saved project payload before persistence and treats the workflow tree/file name as the hosted project title source of truth; if the editor changed `data.metadata.title`, the saved `.rivet-project` is rewritten back to the current tree name
- after a successful save, the hosted wrapper patches only project-title metadata in the active project, opened-project tab registry, and any cached opened-project snapshot so the visible tab updates to the file-tree name immediately without reopening the project or changing the active graph
- the hosted wrapper also overrides the upstream Windows hotkey fallback so `Ctrl+S` does not trigger a second save via the legacy keyup path

That lets the hosted shell behave like a single app even though the editor lives in an iframe.

## Search shortcut behavior

Rivet owns editor-local find/search UIs, but `Ctrl+F` / `Cmd+F` can fire while focus is still on dashboard chrome.

- inside the iframe, Rivet's normal handlers keep owning `Ctrl+F` / `Cmd+F` for graph search and fullscreen-output search, and the hosted bridge adds a capture-phase fallback that recognizes the physical `KeyF` shortcut before the browser find UI can open
- outside the iframe, the dashboard captures that find shortcut only when focus is not already in the iframe or in a real dashboard text input
- the dashboard prevents the browser find default, focuses the iframe, and sends `trigger-editor-find-shortcut` to `EditorMessageBridge`
- the iframe bridge replays the shortcut on the editor window so the currently relevant Rivet search handler wins, including fullscreen output search when that UI is mounted. If no upstream handler handles the event, the hosted fallback focuses an already-mounted visible editor search input first, then opens graph search only when focus is not in an editor text control and no Rivet overlay is open
- browser-reserved development shortcuts stay browser-owned; in particular the hosted Windows hotkey override must not bind `Ctrl+Shift+I` to graph import, because Chrome uses that shortcut for DevTools

## Copy/Paste behavior

Node copy/paste shortcuts do not cross the editor bridge. Dashboard-focused duplicate is the narrow exception because browsers reserve `Ctrl+D` / `Cmd+D` for bookmark UI before the iframe can see it.

- `Ctrl+C`, `Ctrl+X`, and `Ctrl+V` stay inside the iframe, but hosted builds replace the upstream hotkey hook with a tracked wrapper override so copy/cut/paste reads the latest Jotai state immediately instead of waiting for a React re-render.
- `Ctrl+D` / `Cmd+D` is editor-local when the iframe has focus. When an active project is open but focus is still on dashboard chrome, the dashboard prevents the browser bookmark default, focuses the iframe, and sends `trigger-editor-duplicate-shortcut`; the iframe then replays a normal `KeyD` shortcut so the existing Rivet node-duplicate handler owns selection, edit-state checks, and mutation.
- The dashboard does not relay copy/cut/paste shortcuts to the iframe. That approach was intentionally avoided because iframe-focused clipboard events are not reliable at the parent-page level.
- In hosted mode, shortcut reliability depends on editor focus, not dashboard focus. The hosted wrapper therefore explicitly focuses the iframe after `project-opened` and reclaims iframe focus on capture-phase pointer interactions inside `.node-canvas`.
- On those canvas interactions, the hosted editor bridge also focuses the canvas element itself unless the click is on a real form control, and blurs stale editor-local text inputs before keyboard node actions run.
- The hosted wrapper also replaces the upstream context-menu hook so closing a context menu clears any focused search input instead of leaving a hidden text field intercepting shortcuts.
- The hosted wrapper keeps the iframe and canvas focusable for keyboard reliability but suppresses their visible browser focus outline, so the editor does not show a white perimeter when focused.
- Save is still special: it crosses the bridge when initiated outside the iframe, duplicate crosses only for dashboard-focused browser-shortcut recovery, and iframe-focused save/duplicate behavior is handled directly inside the editor context.

## Adjacent hosted execution transport

The editor bridge is not the same thing as the executor/debugger websocket transport. In the Rivet 2.0 integration, the hosted shell mounts the editor through `RivetAppHost` and passes the hosted executor websocket as `executor.internalExecutorUrl`.

- the iframe app captures the upstream `RivetWorkspaceHost` through `RivetAppHost.onWorkspaceHostReady`, then renders `wrapper/web/dashboard/EditorMessageBridge.tsx` with that handle; executor UI classification stays in upstream Rivet's `useExecutorSession` / `useRemoteDebugger` flow through `executor.internalExecutorUrl`
- executor transport ownership stays in upstream Rivet app code (`useExecutorSession`, `useRemoteDebugger`, `useRemoteExecutor`, and the shared executor-session runtime); the wrapper passes the hosted executor URL and does not alias those transport/debugger hooks
- hosted wrapper code still owns project-open/delete/path-move messages, parent-page save relay, hosted IO adapters, and the hosted File menu visibility policy; upstream Rivet owns workspace transitions, tab close fallback, path moves, command behavior, and the actual save transition
- hosted File menu visibility uses the upstream `RivetAppHost.ui.fileMenu.visibleItems` seam. The wrapper currently exposes only `import_graph`, `export_graph`, `settings`, and `get_help` in the iframe File menu, preserving Rivet's command layer while hiding wrapper-owned project create/open/save commands.
- hosted provider wiring is explicit in `hostedRivetProviders`: the wrapper passes `HostedIOProvider`, an injected import/export-capable `HostedDatasetProvider`, hosted environment lookup, and hosted path-policy reads into `RivetAppHost.providers`; stale `ioProvider` and `TauriIOProvider` module aliases should stay removed
- hosted builds override only `clearProjectContextState` from `savedGraphs` so closing or replacing an editor tab forgets the atom instance without deleting stored project context values; project ids must remain stable because context persistence is keyed by `project.metadata.id`. `deleteHostedProjectContextState` is reserved for the dashboard delete-workflow command, which receives the deleted project id from the API so it can also clean closed-tab state.
- `HostedDatasetProvider` extends Rivet's browser dataset provider and prunes the previous IndexedDB dataset rows for the project before importing the authoritative dataset payload from the project load response, so deleted datasets do not reappear from stale app storage
- stale wrapper transport override files were removed after the Rivet 2 seam migration; do not restore `useExecutorSession`, `useRemoteDebugger`, `useGraphExecutor`, or `useRemoteExecutor` aliases unless the upstream seam is removed

Those execution websocket responsibilities are separate from the dashboard/editor `window.postMessage` bridge. The bridge moves open/save/delete/path-move intent between browsing contexts; the Rivet executor session talks to `/ws/executor*`.

## Key files

- `wrapper/shared/editor-bridge.ts` - shared message types, guards, and helpers
- `wrapper/shared/workflow-types.ts` - workflow project types plus managed and published-version preview virtual path helpers
- `wrapper/shared/workflow-recording-types.ts` - recording IDs and virtual replay path helpers
- `wrapper/web/dashboard/DashboardPage.tsx` - dashboard composition root that wires the bridge, sidebar, and editor iframe together
- `wrapper/web/dashboard/useEditorBridgeEvents.ts` - dashboard-side message listeners and outer-page save shortcut capture
- `wrapper/web/dashboard/useEditorCommandQueue.ts` - pre-ready command buffering
- `wrapper/web/dashboard/editorBridgeFocus.ts` - iframe/canvas focus helpers and save-shortcut detection
- `wrapper/web/dashboard/EditorMessageBridge.tsx` - editor-side message handling
- `wrapper/web/dashboard/HostedEditorApp.tsx` - `RivetAppHost` UI policy, callback forwarding for active project, open project count, saved project events, and workspace-host readiness
- `wrapper/web/dashboard/useReconcileHostedProjectTitleAfterSave.ts` - save-completion title reconciliation for active project metadata, tab labels, and opened-project snapshots
- `wrapper/web/dashboard/hostedRivetProviders.ts` - explicit provider overrides passed into `RivetAppHost`
- `wrapper/web/overrides/state/savedGraphs.ts` - hosted preservation of editor-owned `projectContext__"<projectId>"` storage across tab close/reopen
- `wrapper/web/dashboard/useOpenWorkflowProject.ts` - hosted path loading, duplicate-id checks, and open/replace-current calls through the captured `RivetWorkspaceHost`
- `wrapper/web/io/HostedDatasetProvider.ts` - hosted dataset import wrapper that prunes stale per-project IndexedDB dataset rows before importing the current project payload
- `wrapper/web/io/HostedIOProvider.ts` - API-backed project loading/saving plus replay and published-version preview loading
- `wrapper/web/overrides/hooks/useCopyNodesHotkeys.ts` - hosted clipboard hotkey override that reads the latest node state synchronously
- `wrapper/web/overrides/hooks/useContextMenu.ts` - hosted context-menu override that clears stale focused menu inputs
- `wrapper/web/overrides/hooks/useWindowsHotkeysFix.tsx` - hosted Windows hotkey override that suppresses duplicate save fallback
- `wrapper/web/hosted-editor.css` - hosted global CSS that suppresses visible canvas focus outlines
- `wrapper/web/vite.config.ts` and `wrapper/web/project-tab-label-transform.ts` - hosted build plugin and tested helper for scoped `ProjectSelector` tab-label normalization
- `wrapper/web/vite-aliases.ts` - Vite alias wiring that redirects hosted builds to tracked wrapper overrides
- `rivet/packages/app/src/host.tsx` - upstream Rivet 2.0 host seam that provides the editor providers, storage bootstrap, and external executor URL wiring
