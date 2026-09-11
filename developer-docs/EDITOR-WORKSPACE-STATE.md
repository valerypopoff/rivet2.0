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
instead exposes `Create web app` after `Filter graphs`. It calls the same
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

## Tests

Prefer pure transition/presentation tests for target restoration, tab labels,
capabilities, and leave policy. Source parsing is not an acceptable substitute for
workspace behavior. Browser coverage is reserved for actual portal/focus/drag
behavior that cannot be expressed through the domain owners.
