# Editor Workspace State

Canonical ownership guide for project tabs, graph/resource navigation, and hosted
workspace transitions. Detailed historical behavior remains in
[`APP-ARCHITECTURE.md`](./APP-ARCHITECTURE.md).

## Workspace Target

[`projectWorkspaceTarget.ts`](../packages/app/src/domain/workspace/projectWorkspaceTarget.ts)
defines the only valid selected workspace resource: `graph` with a
`GraphViewContext`, `nodeLibrary`, or `uiGraph` with a `uiGraphId`.

Do not add parallel resource-open booleans. Use
`getProjectWorkspaceTargetCapabilities(...)` for run/canvas/resource policy and
`getProjectWorkspaceLeavePolicy(...)` before transitioning away.

[`workspaceTarget.ts`](../packages/app/src/state/workspaceTarget.ts) stores the
target per open project. Graph viewport state remains graph-owned; Node library
viewport state is separate session state. UI graphs own their declarative editor
state. Closing a project clears every target/resource session entry for that id.
Always validate a stored target against current project content before rendering
it: project replacement and graph deletion can invalidate a graph view (including
a subgraph whose caller was removed or retargeted) without a normal workspace
transition.

## Transitions

- [`useWorkspaceTransitions.ts`](../packages/app/src/hooks/useWorkspaceTransitions.ts)
  is the transition coordinator.
- [`useProjectWorkspaceTarget.ts`](../packages/app/src/hooks/useProjectWorkspaceTarget.ts)
  is the component-facing target API.
- [`useLoadGraph.ts`](../packages/app/src/hooks/useLoadGraph.ts) loads an explicit
  graph target and must override resource restoration.

Persist graph coordinates only when leaving a graph. Never serialize Node library
or UI-graph viewport coordinates into the previously active graph.

`projectEditorStateByProjectIdState` keys navigation and canvas positions by
immutable project ID, then graph ID. It is captured with project/graph content in
the coherent browser checkpoint described below, not in an independent synchronous
`sessionStorage` record. `lastCanvasPositionByGraphState` remains a read-only
compatibility fallback for pre-existing browser state; new editor synchronization
must not write or repopulate it. The app shell snapshots the active graph viewport;
Node library and UI-graph canvases reuse the persisted graph snapshot instead of
overwriting it. Hidden visibility requests a flush while the document is alive.
Non-bfcache `pagehide` also requests a flush, but asynchronous work at that point
cannot guarantee completion after the document closes.
Closing a project tab is not project deletion: the project-scoped editor entry must
survive so reopening the same project restores its graph and viewport. The workspace
host snapshots the active tab, performs all tab/snapshot/context cleanup, and only
then flushes the grouped `project` store. The final flush must durably contain both
the retained editor state and the removed tab metadata; flushing before cleanup can
recover a contradictory stale-open tab after an immediate reload.

The last loaded `projectState` and `graphState` deliberately survive tab closure,
but they no longer own a live viewport. Every snapshot write therefore requires an
open tab and a graph workspace. Background synchronization, pagehide checkpointing,
and project transitions must ignore closed projects so an empty-workspace startup
cannot overwrite the retained viewport with the runtime canvas default.

### Project activation and content replacement

[`useActivateOpenedProject.ts`](../packages/app/src/hooks/useActivateOpenedProject.ts)
owns activation of an existing tab. Selecting an already-active project does not
reload bytes or reset its saved digest. Selecting another open tab prefers its
validated in-memory snapshot and retains unsaved edits, payloads and baseline.
An explicit graph selection may change its workspace target; it is not a project
reload. During opening, a clean content baseline comes from a successful initial
load or explicit authoritative replacement, not ordinary tab activation. Save
separately records the baseline for the snapshot actually written.

[`projectActivationCoordinator.ts`](../packages/app/src/utils/projectActivationCoordinator.ts)
supersedes the previous selection and aborts its preparation. Preparation does not
hold a serial activation lock: a stalled read cannot block a newer editor-tab
selection. A request generation and the tab's current identity/path are checked
before publishing prepared state. The coordinator defaults to a 60-second deadline;
native file-picker interaction is instead untimed, but its result is still fenced
against newer selections. Providers that cannot abort must not commit late results.
The hosted bridge has an additional command-ordering layer; see
[Editor Bridge](./studio-server/editor-bridge.md#message-flow).

Provider dataset imports and revision acceptance use optional deferred, guarded
commit hooks; fetching/deserializing alone must not change the live owner. The
workspace transition publishes project, graph, payload authority, path, tab and
baseline synchronously before derived cache hydration. Cache failure does not undo
a successful open. Close fallback shares the activation owner and skips failed
candidates without activating a closed or renamed tab.

Graph command history, Redo and recoverable-wire pools are project-scoped even
when cloned projects reuse graph IDs. Ordinary activation preserves them; an
authoritative reload clears the replaced project's history and advances its node
editor content generation. See [editor sessions](./MONACO-EDITOR-SURFACES.md#node-settings-ownership).

## Project Strip

[`ProjectSelector.tsx`](../packages/app/src/components/ProjectSelector.tsx) is the
strip shell. `ProjectTabRow`, `ProjectFileMenu`, `GraphTopBarControls`, and
`WindowsWindowControls` own their individual surfaces.

[`projectSelectorModel.ts`](../packages/app/src/components/projectSelector/projectSelectorModel.ts)
owns active/preview/unsaved tab presentation and OS-specific visibility policy.
Keep display-name and platform decisions out of JSX. Dirty state remains a
project-id keyed app/session concern and is not project YAML.
Dirty detection compares complete project content with its saved digest even
when the active canvas is an empty placeholder after graph deletion. The
placeholder is excluded from the save snapshot, so deletion immediately marks
the project dirty. `useDeleteGraphs()` only replaces the canvas when the deleted
graph was active; deleting another graph preserves the active canvas and any
unsaved edits there. `replaceProjectGraphs(...)` owns normal graph-collection
writes and Graph Builder history publication: it clears `metadata.mainGraphId`
when that graph no longer exists, reconciles graph-bound web-app actions, and
lets undo/redo restore a valid Main Graph setting.
`useDeleteGraphs()` is the deletion boundary for both individual graphs and
folders. It blocks removal of a graph that is executing and atomically removes
its frozen outputs, recoverable connections, legacy viewport cache, persisted
editor navigation/viewport entries, and invalid workspace target. When the
active project contains a surviving static caller or a web-app Button/Chat
action targeting a graph, deletion is also blocked; remove or retarget that
reference first. Dynamic Call Graph inputs remain valid after any graph is
removed, so they are deliberately diagnostic-only and do not block deletion. A
multi-graph folder deletion may remove references that stay entirely inside the
deleted set. When the
active graph is deleted, its blank placeholder has an empty navigation stack;
the deleted graph can never remain selected through session state. Graph
navigation deliberately skips history entries whose graph has since been
deleted, and persistence remaps the selected surviving entry rather than merely
clamping its old array index, so Back/Forward and reopening cannot target the
wrong graph after a deletion.

## Graph Tree And Resources

[`GraphList.tsx`](../packages/app/src/components/GraphList.tsx) is a shell around
`GraphListHeader`, `useGraphListPresentation`, `UiGraphResourceSection`,
`GraphListContextMenus`, `GraphListDialogs`, and `useUiGraphOperations`.

Node library and web apps are project resources, not executable graphs. Main graph,
graph history, and graph execution must not treat them as graphs. The graph-list
reachability diagnostic treats valid Button and Chat action targets as additional
entry points, but never treats a web app itself as a graph.
Web-app resource rows use the graph tree's shrink-and-ellipsis label contract, so a
long app name stays inside the left panel while its full accessible button name is
preserved. The resource section keeps the same breathing room before the Graphs
section as the project header uses before Web Apps. When a project has no web apps,
the empty Web Apps section and its `New web app` row stay hidden; `GraphListHeader`
instead exposes `Create web app` after `Node library`. It calls the same
`useUiGraphOperations.createUiGraph()` path, so the new app is opened and the normal
Web Apps resource section appears immediately on the resulting project update.

## Hosted Workspace

Hosted wrappers use `RivetWorkspaceHost`; they must not mutate Jotai atoms. The host
API owns open/replace/close, clean baselines, path moves, metadata changes, compare
sessions, transient tab UI, and opening placeholders. Wrapper-owned persistence or
publication remains outside the app.

Path and title are mutable metadata; they cannot replace the immutable project
identity used for an in-place hosted save. A rename/move updates the binding and
preserves unsaved graph edits. A saved-content revision requires the explicit
Reload/Keep mine workflow. Evaluation-library revisions use their own store and
notifications, never the open project's content revision. See
[Hosted Contracts](./HOSTED-WEB-APP-CONTRACTS.md) for asynchronous save completion,
revision acknowledgement and stale-path conflicts, and the
[refactor UI scenarios](./REFACTOR-BASELINE.md#ui-acceptance-scenarios) for two-window
and inactive-tab checks.

## Browser recovery

[`workspaceRecovery.ts`](../packages/app/src/state/storage/workspaceRecovery.ts)
wraps the default or injected `AsyncStorageBackend`. The `project`, `graph` and
`graphBuilder` groups are captured together into one version-1 envelope under
`workspace-recovery/v1/<document>/<writer>`. This includes active content, inactive
tab snapshots, payloads, saved baselines and editor navigation from the same
capture. General preferences, project-context values and the shared Evaluation
library retain their separate storage owners; recovery is not a server backup.

Each browser document has its own writer key. `sessionStorage` stores only the
latest committed checkpoint reference. Reload reads that checkpoint into a new
writer namespace; a duplicated tab may inherit the reference but cannot overwrite
the original tab's recovery. A checkpoint is published only after the backend
write and read-back verification succeed. IndexedDB writes await transaction
completion, not merely a successful `put` request. An older completion cannot
acknowledge newer pending edits. Reconfiguration captures the backend of queued
work and prevents retired owners from publishing a new recovery selection.

Legacy records are validated, imported into one envelope, committed and read back
before the editor mounts; originals are retained. A selected missing, malformed or
inaccessible checkpoint is never silently replaced by clean defaults or unrelated
legacy fragments. Interrupted imports remain retryable. Retained checkpoints are
available through the chooser when bootstrap is blocked; explicitly starting empty
also preserves the old evidence.

[`hybridStorage.ts`](../packages/app/src/state/storage/hybridStorage.ts) propagates
explicit flush failures and keeps subsequent writes retryable. Background errors
are handled without repeated recovery toasts. Browser recovery and project Save
have distinct acknowledgements: a confirmed provider write can succeed while a
later checkpoint fails, and unsaved edits can be checkpointed without being saved
to their project. Download-only browser providers cannot confirm a durable file
write and do not mark a project clean merely because a download was initiated.

[`WorkspaceRecoveryStatus.tsx`](../packages/app/src/components/WorkspaceRecoveryStatus.tsx)
renders nothing for healthy or pending checkpoints. Live failures retry the latest
in-memory state automatically (250 ms, 1 s, 2.5 s, then 30 s), with earlier retries
on focus, online or visible events. After three unsuccessful retries, an actionable
warning appears only while unsaved work is at risk; memory-only storage shows Save
instructions rather than disabled controls. Bootstrap retries transient IO twice,
then offers Retry loading or retained-workspace selection; invalid authority needs
an explicit choice. The unload warning applies only to unsaved work without
confirmed reload recovery. Neither `pagehide` nor successful initiation of a write
is proof of durability.

The default `BrowserStaticDataStore` is a derived document-local memory cache.
Legacy `rivet_static_data` is read only during compatibility bootstrap, never
cleared or rewritten. New payload authority lives in the checkpoint and project
file. Cache hydration is revision-fenced and must not overwrite newer edits;
injected provider interfaces remain supported.

## Tests

Prefer pure transition/presentation tests for target restoration, tab labels,
capabilities, and leave policy. Source parsing is not an acceptable substitute for
workspace behavior. Storage, activation, save and editor-session owners have
deterministic unit/component tests. Use real-browser tests for IndexedDB
transactions, two pages sharing one origin, reload, focus and iframe event delivery;
separate browser contexts cannot prove same-origin recovery isolation.

`project-tree-activation.spec.ts`, `project-preview-mode.spec.ts` and
`dashboard-save-button.spec.ts` cover hosted activation, recovery and save seams.
The node-editor ownership/lifecycle specs cover cloned IDs and immediate edits.
See [Development](./studio-server/development.md#node-settings-ownership-regressions)
for focused commands and evidence limits.
