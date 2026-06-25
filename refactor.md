# Rivet Refactor Candidates

## Baseline And Reassessment

The last substantial repo-wide maintainability refactor was the May 27, 2026 pass documented in `refactor-history.md` entry 131 and committed around:

- `eb575f91` - `refactor: tighten maintainability seams`
- `c4c490bc` - `Document completed maintainability refactor`

This plan was reassessed against the current code and developer docs. The important corrections are:

- `GraphList` already has an extraction seam at `packages/app/src/components/graphList/useGraphListPresentation.ts`; the next refactor should strengthen that seam, not invent a new hook elsewhere.
- Node output already has a documented view-model boundary at `packages/app/src/components/nodeOutput/nodeOutputViewModel.ts`; the next refactor should finish consolidating section/search/rendering policy around it, not create a second output model.
- Executor ownership is already project-scoped through `executorSession.ts` and `ExecutorSessionContext.tsx`; the refactor should reduce adapter duplication and routing complexity, not redesign the session model.
- Several tests are source-contract tests. They should be reduced only when a production helper gives them a real behavior seam to test.

The list is ordered by a combined score: most useful cleanup first, with simpler and safer refactors ahead of broad integration refactors.

The goal of every item is:

- no functionality change;
- less code where possible;
- fewer implicit cross-file contracts;
- clearer ownership boundaries;
- safer future feature work.

## 1. Graph Tree Presentation Model - DONE

Completed by strengthening `packages/app/src/components/graphList/useGraphListPresentation.ts` as the owner for graph-tree visible folder state, comparison-removed ghost graphs, graph compare badge kinds, and safe context-menu presentation. `GraphList.tsx` now consumes that presentation model and keeps command dispatch, DnD wiring, and modal ownership.

### Problem

The graph tree is large and heavily used. `packages/app/src/components/GraphList.tsx` is over 1,000 lines and still owns rendering, graph/folder menus, search/filter focus behavior, delete/info modals, drag/drop coordination, folder expansion, comparison-removed graphs, unreachable tags, reference indicators, and several crash guards.

There is already a useful presentation seam in `packages/app/src/components/graphList/useGraphListPresentation.ts`, but it only owns reachability/reference derivation and per-item presentation. More derived state still lives in `GraphList.tsx`.

### Assumption Check

Solid assumptions:

- graph-tree behavior is editor/UI-only and can be refactored without project YAML or runtime changes;
- the existing `components/graphList/*` folder is the right home for this work;
- `useGraphListPresentation.ts` should be extended rather than replaced.

Important constraints:

- right-click menu target resolution must stay defensive because stale graph/folder metadata has caused crashes before;
- empty folders must remain visible after graph drag/move operations;
- unreachable/reference indicators must keep the current rules, including ignoring Auto Delegate reachability.

### Suggested Refactor Vector

Move all graph-tree derived state into `components/graphList` helpers:

- visible folder tree, including comparison-removed graphs;
- visible folder paths and bulk expand/collapse targets;
- context-menu target and menu visibility;
- graph/folder item presentation;
- root notices such as missing Main Graph reachability message.

Leave `GraphList.tsx` as the renderer and command dispatcher.

### Files To Change

- `packages/app/src/components/GraphList.tsx`
  - Reduce render-time derivation and local menu visibility branching.
- `packages/app/src/components/graphList/useGraphListPresentation.ts`
  - Extend this existing seam to own more presentation state.
- `packages/app/src/components/graphList/graphFolders.ts`
  - Keep tree/folder construction and comparison-removed graph merging here.
- `packages/app/src/components/graphList/graphListContextMenu.ts`
  - Keep menu item and target derivation here.
- `packages/app/src/utils/graphReachability.ts`
  - Keep graph reachability policy separate from UI presentation.
- `packages/app/src/components/graphList/useGraphListPresentation.test.ts`
  - Expand model-level coverage.
- `developer-docs/APP-ARCHITECTURE.md`
  - Update graph-tree ownership notes if helper boundaries change.

### Risks

- Reintroducing the graph-tree right-click crash by rendering a stale context-menu target.
- Losing project-scoped folder expansion behavior.
- Accidentally changing the exact folder sorting, case-insensitive ordering, or empty-folder preservation rules.
- Hiding reachability warnings when the Main Graph is invalid.

### What Changes After Refactor

No behavior should change. The graph tree should become easier to modify because most "what should be shown" decisions will be testable without rendering the whole component.

## 2. Output Rendering And Fullscreen Modal Pipeline - DONE

Completed by moving generic output-section policy into
`packages/app/src/components/nodeOutput/nodeOutputViewModel.ts`. The shared
section model now owns visible port filtering, compact first-port selection,
definition-title/fallback labels, header visibility, fullscreen header sizing,
and output ordering. `RenderDataOutputs` consumes that model and stays
focused on rendering values, counters, and shared section styles without pulling
node-output policy into the generic `RenderDataValue` component. Fullscreen
search intentionally remains DOM/provider-based because folded Monaco blocks and
loaded large values need provider-owned offset mapping; this refactor keeps that
search path behaviorally unchanged instead of forcing it through section
metadata.

### Problem

Node output rendering has been fixed and polished repeatedly: fullscreen folding, large stored values, search highlighting, output section order, copy behavior, counters, inline full output, and action-button layout all interact.

The code already has a good view-model seam at `packages/app/src/components/nodeOutput/nodeOutputViewModel.ts`, but some section ordering, search, and rendering details still live across modal, inline output, render-data-value helpers, and source-contract tests.

### Assumption Check

Solid assumptions:

- output rendering can be refactored without changing stored execution data;
- `nodeOutputViewModel.ts` is the correct policy owner for selected process data, content state, copy source, and body-source selection;
- inline and fullscreen output should share more section policy but keep separate layout and interaction code.

Important constraints:

- fullscreen search must match what the user sees, including folded code blocks and loaded large values;
- search offset math must stay provider-aware for Monaco/colorized large values;
- copy/export must restore original refs and preserve current serialization behavior;
- compact inline previews must not gain fullscreen-only chrome.

### Suggested Refactor Vector

Finish consolidating the existing output model:

- add a shared output-section model for titles, fallback `Output` labels, section order, stats, and value kind;
- make fullscreen search consume that section model where possible;
- keep layout controls in `NodeInlineOutput.tsx` and `NodeFullscreenOutput.tsx`;
- keep data-type rendering in `renderDataValue/*`.

### Files To Change

- `packages/app/src/components/nodeOutput/nodeOutputViewModel.ts`
  - Extend the existing view model instead of adding a parallel model.
- `packages/app/src/components/nodeOutput/NodeFullscreenOutput.tsx`
  - Consume shared section metadata.
- `packages/app/src/components/nodeOutput/NodeInlineOutput.tsx`
  - Consume shared section metadata only where inline output uses the same policy.
- `packages/app/src/components/nodeOutput/fullscreenOutputSearch.ts`
  - Keep search indexing aligned with section text/render providers.
- `packages/app/src/components/renderDataValue/*`
  - Keep value rendering and Monaco/large-value provider behavior here.
- `packages/app/src/components/nodeOutput/nodeOutputViewModel.test.ts`
  - Expand behavior coverage.
- `developer-docs/EXECUTION-DATA-FLOW.md`
  - Update if the output view-model contract becomes more explicit.

### Risks

- Search highlights can drift from actual rendered text.
- Large-value loading can accidentally switch from preview mode to full rendering.
- Node-specific output order can regress, especially Code/Expression parsed-source sections.
- Inline output could accidentally inherit fullscreen-only counters or headers.

### What Changes After Refactor

No output content, order, copy behavior, or search behavior should change. The outcome should be fewer special cases in React components and clearer tests around output display policy.

## 3. Project Comparison Engine - DONE

Completed by keeping the public `packages/core/src/utils/projectComparison.ts`
facade stable, including public comparison types, while moving focused pure policies under
`packages/core/src/utils/projectComparison/`: graph comparison, node
normalization/diffing, connection key/rewire comparison, nested field-path
diffing, and summary aggregation. Core tests now exercise both the public
project-compare behavior and the focused helpers directly. App summary/canvas
components remain render adapters over core comparison results.

### Problem

Compare mode has a pure core diff utility plus app UI. It now handles ignored cosmetic fields, comment-node exclusion, side labels, node field diffs, added/removed/changed graph and connection visuals, summaries, and wrapper-facing helpers.

The current core file, `packages/core/src/utils/projectComparison.ts`, is still compact enough to refactor safely, but it mixes several policies in one file.

### Assumption Check

Solid assumptions:

- comparison is read-only and must not mutate projects, graphs, nodes, connections, execution data, or YAML;
- core comparison helpers are the right owner for graph/node/connection diff semantics;
- app components should only render comparison results.

Important constraints:

- comment nodes must remain ignored entirely;
- `visualData.x`, `visualData.y`, `visualData.zIndex`, and subgraph port-order fields must remain cosmetic and ignored;
- wrapper compare labels must stay transient UI state.

### Suggested Refactor Vector

Split pure comparison policy into focused helpers:

- graph comparison;
- node comparison and normalization;
- connection comparison;
- field-path comparison;
- summary calculation.

Keep public exports stable unless a compatibility alias is trivial.

### Files To Change

- `packages/core/src/utils/projectComparison.ts`
  - Split internally or extract neighboring helper modules.
- `packages/core/test/utils/projectComparison.test.ts`
  - Cover each policy directly.
- `packages/app/src/components/ProjectComparisonNodeChangesModal.tsx`
  - Keep rendering only.
- `packages/app/src/utils/projectComparisonSummary.ts`
  - Keep summary wording only.
- `packages/app/src/components/nodeCanvas/projectComparisonCanvas.ts`
  - Keep visual mapping only.
- `developer-docs/APP-ARCHITECTURE.md`
  - Update compare-layer ownership if module boundaries change.
- `developer-docs/PACKAGES.md`
  - Keep wrapper-facing compare helper docs accurate.

### Risks

- Accidentally changing what counts as a changed node.
- Breaking wrapper imports if exports are moved without compatibility.
- Regressing summary counts by including connection-only endpoint nodes.

### What Changes After Refactor

No comparison result should change. The compare engine should become easier to test and extend without app UI changes.

## 4. Theme And Color Token Architecture - DONE

### Problem

Theme work added dark themes, Bright theme, custom primary/secondary colors, canvas color, tinted controls, transparent popup menus, modal borders, contrast-selected node header text, native control colors, and many component-specific variables.

The docs now describe the intended token hierarchy, but `colors.css` and `nodeStyles.ts` still contain many tightly packed decisions. This makes visual polish easy to regress.

### Assumption Check

Solid assumptions:

- this is a CSS/token organization refactor, not a visual redesign;
- `--primary` should remain accent-oriented and `--secondary` should remain surface-tint-oriented;
- Bright theme must keep its own readable foreground, scrollbar, native control, and node-surface rules.

Important constraints:

- user-adjusted color values should not be "improved" during this refactor;
- existing variable names should remain as aliases where many components still consume them;
- visual tests/source contracts may need updating only to match equivalent ownership, not new colors.

### Suggested Refactor Vector

Reorganize theme tokens into documented layers:

- raw neutral/accent values;
- theme primary/secondary values;
- semantic surfaces;
- existing foreground/text tokens;
- component aliases.

Move repeated component-specific color math behind semantic variables where possible.

### Files To Change

- `packages/app/src/colors.css`
  - Reorganize sections and add compatibility aliases where useful.
- `packages/app/src/components/nodeStyles.ts`
  - Reduce direct color decisions where semantic tokens can own them.
- `packages/app/src/components/settings/pages/UiSettingsPage.tsx`
  - Keep controls but use clearer theme/canvas option data.
- `packages/app/src/components/SettingsModal.tsx`
  - Ensure modal surfaces use semantic tokens.
- `packages/app/src/hostStyleEntrypoint.test.ts`
  - Keep only important host/theme contracts.
- `packages/app/src/components/brightThemeCanvasNodeVisuals.test.ts`
  - Prefer semantic-token assertions over exact CSS adjacency.
- `developer-docs/APP-ARCHITECTURE.md`
  - Update token ownership notes if names or sections move.

### Risks

- Subtle visual regressions, especially in Bright theme.
- Portal/modal surfaces can accidentally miss root-level theme variables.
- Native controls and scrollbars can fall back to browser defaults.
- Node header contrast can regress for non-standard node colors.

### What Changes After Refactor

No intentional visual change. Future theme work should require fewer one-off CSS edits and less source-test churn.

Implementation note: completed by adding a semantic/component token layer in `colors.css` (`--surface-*`, `--modal-*`, `--popup-menu-*`, `--app-panel-*`, `--app-strip-*`, and node output/port aliases), moving modal, popup, app-shell, side-panel, and node-output CSS consumers to those tokens, and updating source-contract tests and developer docs to guard ownership rather than raw grey-token adjacency. Existing `--foreground-*` tokens remain the text/icon owner; no extra text/icon aliases were added because they would duplicate the same contract without reducing component complexity.

## 5. Project Tab And Main Strip Shell - DONE

### Problem

`packages/app/src/components/ProjectSelector.tsx` is over 1,100 lines and owns project tabs, preview/opening states, dirty dots, close confirmation, Menu tab behavior, graph-tree top-strip controls, Windows window controls, separators, active workspace state, and hosted-wrapper tab UI state.

The docs already say closing/reordering still lives in `ProjectSelector.tsx`, which is the clearest remaining ownership smell.

### Assumption Check

Solid assumptions:

- this is valuable because the top strip is now a product shell, not just a selector;
- project tab data can be transformed into a pure view model before rendering;
- desktop window controls can be extracted without changing Tauri/Rust behavior.

Important constraints:

- dirty close confirmation must stay exact;
- opening placeholder tabs must remain non-project UI state;
- preview tab styling must stay transient and keyed by project id;
- no-project/welcome workspace behavior must not create fake project tabs.

### Suggested Refactor Vector

Extract:

- project tab list/view model;
- tab row renderer;
- project close-confirm controller;
- Menu tab renderer;
- graph-tree top-strip controls;
- Windows window controls.

Keep `ProjectSelector.tsx` as the shell composer.

### Files To Change

- `packages/app/src/components/ProjectSelector.tsx`
  - Reduce to composition and high-level event wiring.
- `packages/app/src/components/projectSelector/*`
  - Add new extracted components/helpers.
- `packages/app/src/utils/openingProjectTabs.ts`
  - Keep opening-tab list helpers here if generic.
- `packages/app/src/components/ProjectSelector.test.ts`
  - Replace broad source-shape checks with view-model and minimal wiring tests where possible.
- `developer-docs/APP-ARCHITECTURE.md`
  - Update top-strip/tab-shell ownership docs.

### Risks

- Breaking hosted-wrapper preview/opening tab first-paint behavior.
- Changing tab close or replacement semantics.
- Regressing Windows frameless window controls or drag regions.
- Losing exact active/inactive tab visual rules.

### What Changes After Refactor

No user-visible behavior should change. Future tab, Menu, or window-control work should touch smaller files.

### Implemented

- `ProjectSelector.tsx` is now a shell composer for workspace selection, tab list assembly, high-level project selection, opening-tab selection, tab reordering, and left-sidebar spacing.
- Project-tab rendering and sortable-tab details moved to `components/projectSelector/ProjectTabRow.tsx`.
- Dirty-tab close confirmation moved to `components/projectSelector/useProjectCloseConfirmation.tsx`.
- In-strip Menu rendering moved to `components/projectSelector/ProjectFileMenu.tsx`.
- Graph-tree/history top-strip controls moved to `components/projectSelector/GraphTopBarControls.tsx`.
- Windows frameless drag/window controls moved to `components/projectSelector/WindowsWindowControls.tsx`.
- Top-strip CSS moved to `components/projectSelector/projectSelectorStyles.ts`.
- Follow-up cleanup consolidated the shared tab surface for real/loading project tabs, the shared top-strip item CSS for Menu/graph controls, and the shared Windows window-action wrapper.
- Source-contract tests and `developer-docs/APP-ARCHITECTURE.md` now describe the shell module boundaries.

## 6. Hosted Workspace API Hook - DONE

Completed by keeping `packages/app/src/hooks/useRivetWorkspaceHost.ts` as the
public facade and moving hosted workflow ownership under
`packages/app/src/hooks/workspaceHost/`. Public host types now live in the
workspace-host types module and are re-exported from the facade, snapshot
normalization is isolated, project close/replace cleanup is centralized, and
open/replace, opening placeholder tabs, metadata/path updates, clean-baseline
marking, compare controls, and tab UI state each have focused operation hooks.
Wrapper-facing method names and semantics remain unchanged.
Follow-up cleanup removed duplicated hosted option shapes and repeated
open/replace branch logic, and dropped duplicated internal hook return
signatures in favor of the public host facade type.

### Problem

`packages/app/src/hooks/useRivetWorkspaceHost.ts` is the main hosted-wrapper integration surface. It defines public types and implements open/replace, opening placeholders, metadata updates, path moves, clean baseline, project compare, tab UI state, close, context cleanup, executor mode carryover, and project snapshot restoration.

The public API is valuable, but unrelated hosted workflows are implemented in one hook.

### Assumption Check

Solid assumptions:

- public API names and semantics should stay stable;
- extraction can be internal-only if `useRivetWorkspaceHost()` returns the same object;
- existing docs in `PACKAGES.md` and `APP-ARCHITECTURE.md` are the compatibility contract.

Important constraints:

- clean-baseline updates must remain atomic with dirty flags;
- `finishOpeningProjectTab(...)` must return `false` if the placeholder was closed;
- metadata updates must not allow id/graph-id semantic mutation;
- hosted snapshot opens must preserve existing executor mode.

### Suggested Refactor Vector

Split implementation into internal modules:

- open/replace project snapshots;
- opening placeholder tabs;
- clean-baseline marking;
- metadata/path updates;
- compare session control;
- tab UI state;
- close/resource cleanup.

Keep `useRivetWorkspaceHost.ts` as the public type/export and assembly hook.

### Files To Change

- `packages/app/src/hooks/useRivetWorkspaceHost.ts`
  - Keep public types and compose internal handlers.
- `packages/app/src/hooks/workspaceHost/*`
  - Add internal implementation modules.
- `packages/app/src/hooks/useRivetWorkspaceHostProjectContext.test.ts`
  - Move behavior tests toward helper modules where practical.
- `packages/app/src/utils/openedProjects.ts`
  - Keep generic project-tab mutation helpers.
- `developer-docs/APP-ARCHITECTURE.md`
  - Update hosted API ownership.
- `developer-docs/PACKAGES.md`
  - Keep hosted wrapper API docs unchanged or clarify internal ownership only.

### Risks

- External wrappers depend on this seam, so accidental semantic changes are expensive.
- Captured state versus store-read state matters for tab/executor correctness.
- Close/replace cleanup touches execution snapshots, context storage, tab UI state, and Monaco model cache.

### What Changes After Refactor

No wrapper-facing API behavior should change. The implementation should become easier to audit and safer to extend.

## 7. Canvas Connection And Port Interactions - DONE

### Problem

Connection and port behavior spans `NodePorts.tsx`, `WireLayer.tsx`, `Wire.tsx`, `useDraggingWire.ts`, `useNodeCanvasInteractions.ts`, graph-editing commands, and several helper modules. Current features include connection mode, pan/zoom while wiring, right-click cancellation rules, hover highlighting, bend handles, subgraph port order, variadic port reorder, and conditional labels.

There is already a small `nodeCanvasInteractionModel.ts`, but it does not own the connection/port gesture model.

### Assumption Check

Solid assumptions:

- the behavior is valuable to refactor because it is gesture-heavy and bug-prone;
- graph edit commands should remain in `domain/graphEditing` or command modules;
- drawing should stay separate from interaction policy.

Important constraints:

- wire creation and reconnection semantics must remain exact;
- right-click on a connected port must not remove the connection;
- manual bend points are visual-only connection data and must remain backward-compatible;
- port rearrange must not alter execution semantics.

### Suggested Refactor Vector

Extract gesture-policy helpers before moving components:

- connection hover/bend-point state transitions;
- port reorder preview/finalization;
- dragging-wire drop-target resolution;
- right-click/Esc/canvas-click connection-mode rules.

Only after those helpers are tested should React components be slimmed down.

### Files To Change

- `packages/app/src/components/NodePorts.tsx`
  - Move reorder preview/finalization helpers out.
- `packages/app/src/components/WireLayer.tsx`
  - Move hover/bend-point interaction helpers out.
- `packages/app/src/components/Wire.tsx`
  - Keep path rendering and hit path rendering.
- `packages/app/src/hooks/useDraggingWire.ts`
  - Align with the extracted connection-mode policy.
- `packages/app/src/components/nodeCanvas/useNodeCanvasInteractions.ts`
  - Keep canvas-level event routing but consume the extracted policy.
- `packages/app/src/components/nodeCanvas/nodeCanvasInteractionModel.ts`
  - Either expand this model or create a neighboring connection-specific model.
- `packages/app/src/domain/graphEditing/*`
  - Keep actual graph mutation helpers here.
- `developer-docs/APP-ARCHITECTURE.md`
  - Update canvas interaction ownership if files move.

### Risks

- Pointer capture, pan, zoom, Esc, right-click, and click-outside behavior can regress subtly.
- Hover hit paths must remain cheap; do not replace SVG hit paths with per-mousemove Bezier scanning.
- Port reorder can accidentally rewrite the wrong connections.
- Read-only/historical views must keep bend handles pointer-transparent.

### What Changes After Refactor

No interaction should change. The outcome should be smaller components and behavior tests around gesture policy.

### Implemented

- Manual connection bend hover/click/drag thresholds and ghost visibility now live in `packages/app/src/components/nodeCanvas/connectionBendInteraction.ts`.
- `WireLayer.tsx` remains the SVG rendering and event-routing owner, while bend gesture decisions are covered by focused helper tests.
- Subgraph and variadic port reorder order math now lives in `packages/app/src/components/nodeCanvas/portReorderInteraction.ts`.
- `NodePorts.tsx` remains the React state and command-dispatch owner, while ordered definitions, subset placement, visible-row midpoint insertion, and equality checks are covered by focused helper tests.
- Existing wire creation/rewire/break behavior stays in `packages/app/src/domain/graphEditing/wireDragActions.ts`, so connection-mode graph mutations remain in the graph-editing domain layer.
- Developer docs now describe the canvas connection and port interaction ownership boundaries.

## 8. Node Canvas Command Glue

### Problem

`packages/app/src/components/NodeCanvas.tsx` is over 1,000 lines and coordinates selection, shift-drag selection, context-menu requests, compare overlays, node drag state, wire state, graph execution visuals, output state, canvas gesture boundaries, active resize groups, and debug overlays.

Some extraction already exists under `components/nodeCanvas`, so this refactor should continue that direction.

### Assumption Check

Solid assumptions:

- `NodeCanvas.tsx` should remain an orchestration component;
- pure helpers under `components/nodeCanvas` are the right direction;
- graph edit commands should not move into the canvas component.

Important constraints:

- additive shift-drag selection must keep the release-point finalization behavior;
- compare overlays must remain visual-only;
- resize and multi-select width behavior must preserve undo/redo command semantics.

### Suggested Refactor Vector

Extract or strengthen:

- selection-box and additive selection model;
- resize-group model;
- canvas context-menu request model;
- compare-overlay data mapping;
- debug overlay and performance overlay composition.

### Files To Change

- `packages/app/src/components/NodeCanvas.tsx`
  - Reduce orchestration weight.
- `packages/app/src/components/nodeCanvas/*`
  - Add focused helpers/hooks for selection, resize, context menus, and overlays.
- `packages/app/src/components/nodeCanvas/useNodeCanvasInteractions.ts`
  - Keep shared event routing separate from rendering.
- `packages/app/src/components/nodeCanvas/projectComparisonCanvas.ts`
  - Keep compare visual mapping here.
- `packages/app/src/domain/graphEditing/*`
  - Keep graph mutation behavior here.
- `developer-docs/APP-ARCHITECTURE.md`
  - Update canvas-shell ownership docs.

### Risks

- Selection and resize regressions are easy to miss in unit tests.
- Context menu behavior must stay compatible with connection mode.
- Compare overlays must not mutate graph state or selection.

### What Changes After Refactor

No visible behavior should change. Future canvas features should be easier to add without editing one thousand-line shell.

## 9. Executor Session Ownership

### Problem

Executor behavior recently became per-project across Browser, internal Node, hosted Node, and external Remote Debugger. The current docs correctly describe project-scoped ownership through `executorSession.ts`, `ExecutorSessionContext.tsx`, `useExecutorSessionCoordinator.ts`, `useLocalExecutor.ts`, `useRemoteExecutor.ts`, and `useRemoteDebugger.ts`.

The risky part is not the absence of a central model; it is the number of adapters and event reducers that must agree about active versus inactive projects, request ids, abort/user-input routing, and cleanup.

### Assumption Check

Solid assumptions:

- do not redesign the executor protocol or session ownership model;
- keep one runtime per project tab;
- Browser, Node, and Remote Debugger can be refactored only through adapter cleanup and shared reducers.

Important constraints:

- multiple project tabs must run independently in every mode;
- remote debugger tabs may use the same URL and port at the same time;
- inactive project events must update stored snapshots rather than visible active atoms;
- abort/pause/resume/user-input must target the owning request/session.

### Suggested Refactor Vector

Reduce duplication around the existing model:

- shared event-to-project-snapshot reducer;
- clearer active/inactive event routing helpers;
- narrower Browser executor adapter;
- narrower Node/internal executor adapter;
- narrower external Remote Debugger adapter;
- tests around cross-tab isolation and stale project closure guards.

### Files To Change

- `packages/app/src/hooks/executorSession.ts`
  - Keep low-level session runtime.
- `packages/app/src/providers/ExecutorSessionContext.tsx`
  - Keep registry ownership, reduce event-routing duplication where possible.
- `packages/app/src/hooks/useExecutorSessionCoordinator.ts`
  - Keep startup/reconnect policy.
- `packages/app/src/hooks/useLocalExecutor.ts`
  - Treat as Browser adapter.
- `packages/app/src/hooks/useRemoteExecutor.ts`
  - Treat as Node/internal executor adapter.
- `packages/app/src/hooks/useRemoteDebugger.ts`
  - Treat as external debugger command adapter.
- `packages/app/src/hooks/projectExecutionSnapshotEvents.ts`
  - Strengthen as shared reducer boundary.
- `developer-docs/APP-ARCHITECTURE.md`
  - Update only if ownership boundaries move.
- `developer-docs/EXECUTION-DATA-FLOW.md`
  - Update only if event-routing modules move.

### Risks

- This is beneficial but not simple; it should not be the first refactor.
- A small mistake can make a background tab hang or receive another tab's events.
- Remote Debugger and hosted internal executor classification must stay distinct.
- Loaded recordings and frozen-output flushes must stay out of live-run paths where required.

### What Changes After Refactor

No execution behavior should change. The app should have fewer duplicated event-routing rules and a clearer adapter boundary.

## 10. Brittle Source-Contract Tests

### Problem

The repo has many tests that read source files and assert strings or regexes. Some are legitimate architecture guardrails, but many now protect implementation shape instead of behavior. These tests increase the cost of harmless refactors.

### Assumption Check

Solid assumptions:

- source-contract tests should not be deleted blindly;
- tests should move toward behavior only when production code exposes a better seam;
- a small number of source contracts are still useful for import boundaries, host style entrypoints, and public wrapper seams.

Important constraints:

- do not reduce coverage while extracting helpers;
- do not replace source contracts with brittle DOM snapshots;
- preserve tests for public wrapper API contracts and important host entrypoints.

### Suggested Refactor Vector

Handle this opportunistically with the production refactors above:

- when extracting a pure helper, move source-regex expectations into helper behavior tests;
- keep only minimal wiring/source checks for boundaries that cannot be behavior-tested cheaply;
- prefer table-driven tests for presentation models and reducers.

### Files To Change

- `packages/app/src/components/ProjectSelector.test.ts`
  - Convert tab behavior checks to view-model tests where possible.
- `packages/app/src/components/wireLayerLayout.test.ts`
  - Move bend/hover behavior checks toward extracted interaction helpers.
- `packages/app/src/components/nodeOutputWrapping.test.ts`
  - Keep only output-renderer contracts that are not covered by view-model/search tests.
- `packages/app/src/components/frozenNodeVisuals.test.ts`
  - Retain only high-value visual ownership contracts.
- `packages/app/src/hooks/useRivetWorkspaceHostProjectContext.test.ts`
  - Move API-family behavior checks near extracted hosted modules.
- `packages/app/src/hostStyleEntrypoint.test.ts`
  - Keep host entrypoint/public style contracts.
- `developer-docs/APP-ARCHITECTURE.md`
  - Document when source-contract tests are appropriate.

### Risks

- Removing too many source contracts can weaken architecture guardrails.
- Moving tests before extracting production seams can create weaker tests, not better tests.
- Regex tests around public wrappers may still be the cheapest useful guard.

### What Changes After Refactor

No product behavior should change. The test suite should become less hostile to maintainability refactors while preserving real architecture constraints.

## Suggested Order

1. Graph Tree Presentation Model.
2. Output Rendering And Fullscreen Modal Pipeline.
3. Project Comparison Engine.
4. Theme And Color Token Architecture.
5. Project Tab And Main Strip Shell.
6. Hosted Workspace API Hook.
7. Canvas Connection And Port Interactions.
8. Node Canvas Command Glue.
9. Executor Session Ownership.
10. Brittle Source-Contract Tests, handled opportunistically alongside the production refactors above.

This order favors refactors that are both beneficial and comparatively simple:

- items 1-4 have existing seams or pure policy boundaries and should provide fast maintainability wins;
- items 5-6 are high-value shell/wrapper refactors but touch external-facing behavior, so they come after lower-risk cleanup;
- items 7-9 are high-benefit but gesture/runtime sensitive, so they should wait until the codebase is calmer;
- item 10 should not be a standalone cleanup sprint unless it is paired with real production seams.

## Verification Strategy

Each refactor should be done in small commits with focused tests:

- run focused tests for the touched helper/component;
- run `yarn workspace @valerypopoff/rivet2-app test` for app-facing refactors with broad UI impact;
- run `yarn workspace @valerypopoff/rivet2-app run build` for app-facing refactors;
- run `yarn workspace @valerypopoff/rivet2-core test` only when core behavior is touched;
- run `git diff --check`;
- manually smoke-test the affected editor surface when the change is UI-heavy.

Do not combine visual polish, feature changes, runtime behavior changes, or public API changes with these refactors unless the user explicitly asks for them.
