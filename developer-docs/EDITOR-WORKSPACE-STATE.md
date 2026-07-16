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
section as the project header uses before Web Apps.

## Hosted Workspace

Hosted wrappers use `RivetWorkspaceHost`; they must not mutate Jotai atoms. The host
API owns open/replace/close, clean baselines, path moves, metadata changes, compare
sessions, transient tab UI, and opening placeholders. Wrapper-owned persistence or
publication remains outside the app.

## Tests

Prefer pure transition/presentation tests for target restoration, tab labels,
capabilities, and leave policy. Source parsing is not an acceptable substitute for
workspace behavior. Browser coverage is reserved for actual portal/focus/drag
behavior that cannot be expressed through the domain owners.
