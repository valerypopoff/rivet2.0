# Refactor History

This file consolidates the root-level refactor records into one planning source of truth.
It was created from:

- `past-refactors.md`
- `refactoring.md`
- `refactoring2.md`
- `refactoring3.md`
- `findings.md` for adjacent completed audit-remediation work and residual watchlist items

The older files mixed completed work, implementation plans, reassessment notes, line-count
targets, and verification commands. This file keeps the durable history: what was changed,
why it mattered, how the change was made, and which files or areas were affected.

Future refactor planning should start here, then verify the current code before editing.
Some older entries name broad areas rather than exact files because the original record did
not preserve a complete file list.

## Planning Rules Preserved

- Prefer one owner per behavior policy.
- Refactor only when the new shape is easier to understand, test, or safely change.
- Do not chase line-count reduction with dense code.
- Keep persisted project and graph formats stable unless a migration is explicitly planned.
- Keep app/editor UI concerns separate from core/programmatic execution concerns.
- Prefer pure helpers and named policy modules over broad frameworks.
- Keep generated/runtime source strings debuggable when users may see their errors.
- Update developer docs when a code change moves an ownership boundary or behavior contract.
- Treat "kept intentionally" as a valid refactor outcome when a helper already pays rent.

## Numbered History

1. **Eliminated circular dependencies through barrel imports**
   - Why: Imports from core barrels pulled in the entire export tree and created cycles around node registration.
   - How: Replaced barrel imports with direct type/source imports in registration code.
   - Affected files/areas: `packages/core/src/model/NodeRegistration.ts`, core barrel exports.

2. **Split path-capable IO from the base IO provider**
   - Why: Browser providers had to implement path-based methods that could only fail at runtime.
   - How: Introduced a smaller base IO contract plus path-capable extension and updated callers to check capability.
   - Affected files/areas: app IO providers, `IOProvider` contracts, project load/save callers.

3. **Removed the redundant selected-executor atom**
   - Why: `selectedExecutorState` duplicated `defaultExecutorState` without adding behavior.
   - How: Removed the pass-through atom and updated consumers to use the real executor state.
   - Affected files/areas: app state atoms and executor-selection consumers.

4. **Moved live WebSocket objects out of persisted Jotai state**
   - Why: Persisted atoms should not hold non-serializable runtime resources.
   - How: Split durable debugger configuration from transient socket state and moved sockets into lifecycle-owned refs.
   - Affected files/areas: remote debugger state/hooks and WebSocket lifecycle code.

5. **Added structural project-file validation**
   - Why: Malformed project data could pass top-level checks and fail later with confusing execution errors.
   - How: Validated graph, node, and connection structure after deserialization and improved load errors.
   - Affected files/areas: project deserialization/loading, project validation helpers, user-facing open errors.

6. **Surfaced plugin loading failures**
   - Why: Failed plugins silently disappeared from the UI.
   - How: Stored plugin failure state and surfaced it through notifications and plugin-management feedback.
   - Affected files/areas: plugin loading hooks/state, plugin UI feedback, node availability.

7. **Reduced widespread `as any` casts**
   - Why: `as any` hid useful type checking around registration and event handling.
   - How: Removed nearly all production casts and left only narrow test cases.
   - Affected files/areas: core node registration, app event handling, related tests.

8. **Replaced targeted global singleton coupling with injection**
   - Why: Dataset IO used ambient imports that made dependencies hidden and hard to test.
   - How: Passed the dataset provider explicitly into dataset IO helpers.
   - Affected files/areas: `packages/app/src/io/datasets.ts`, dataset provider call sites.

9. **Made `GraphProcessor` dependencies explicit**
   - Why: Hidden fallbacks for registry/tokenizer made execution harder to test and reuse.
   - How: Required callers to provide concrete dependencies.
   - Affected files/areas: `packages/core/src/model/GraphProcessor.ts`, processor creation APIs, tests.

10. **Deduplicated repeated `GraphProcessor` execution patterns**
    - Why: Readiness checks, cost accumulation, errored-input handling, and control-flow checks were repeated.
    - How: Extracted focused private helpers and shared cost accumulation.
    - Affected files/areas: `GraphProcessor` internals.

11. **Broke up the largest `GraphProcessor` methods**
    - Why: Long methods mixed orchestration, readiness, context construction, and result collection.
    - How: Split `processGraph`, node readiness, and node execution paths into smaller focused units.
    - Affected files/areas: `packages/core/src/model/GraphProcessor.ts`.

12. **Typed the executor/debugger WebSocket protocol**
    - Why: Message shapes were ad hoc and inconsistent across execution transports.
    - How: Introduced shared message typing while preserving compatibility quirks where needed.
    - Affected files/areas: executor/debugger protocol types, app/executor WebSocket send/receive paths.

13. **Centralized direct Tauri imports**
    - Why: Native assumptions leaked into platform-neutral app code.
    - How: Wrapped Tauri imports behind platform/native helpers.
    - Affected files/areas: `nativeApp.ts` at the time, app components/hooks/utilities that used Tauri directly.

14. **Split `useCurrentExecution` into smaller execution hooks**
    - Why: One hook owned execution events, graph lifecycle, user-input flows, and data transformation.
    - How: Moved concerns into smaller hooks and helpers while retaining a compatibility composition layer.
    - Affected files/areas: `useCurrentExecution` and execution state hooks.

15. **Reduced `VisualNode` prop drilling**
    - Why: Shared canvas context was threaded manually through many component layers.
    - How: Introduced canvas view/handler contexts and reduced the `VisualNode` prop surface.
    - Affected files/areas: `VisualNode`, `NodeCanvas`, canvas context providers.

16. **Optimized IO-definition derivation**
    - Why: Broad atom dependencies recomputed definitions for every node after small graph edits.
    - How: Shifted IO-definition calculation toward per-node derivation.
    - Affected files/areas: `ioDefinitionsState`, graph/node IO selectors.

17. **Added cleanup for atom-family state**
    - Why: Dynamic node/graph/project atoms could survive after their owners were deleted.
    - How: Expanded atom-family cleanup for execution and builder state.
    - Affected files/areas: `cleanupNodeAtomFamilies` and related atom families.

18. **Standardized error-handling patterns**
    - Why: Async failures surfaced inconsistently through local catches, swallowed promises, and generic toasts.
    - How: Moved repeated failure reporting into centralized helpers and clearer async patterns.
    - Affected files/areas: app error handlers, async UI flows, execution hooks.

19. **Simplified serialization compatibility paths**
    - Why: Version fallbacks and V3/V4 serialization code were duplicated and hard to audit.
    - How: Introduced clearer version-aware handling and shared helpers.
    - Affected files/areas: core serialization/deserialization modules and round-trip tests.

20. **Split `GraphProcessor` into focused modules**
    - Why: The processor still owned preprocessing, cycle detection, recording playback, and context building.
    - How: Extracted `GraphPreprocessor`, `CycleDetector`, `RecordingPlayer`, and `ProcessContextBuilder`.
    - Affected files/areas: `GraphProcessor`, `GraphPreprocessor`, `CycleDetector`, `RecordingPlayer`, `ProcessContextBuilder`.

21. **Decomposed monolithic UI components**
    - Why: Large UI files mixed rendering, state orchestration, event handling, and helper logic.
    - How: Split responsibilities in major components; `VisualNode`, `SettingsModal`, and `PromptDesigner` shrank substantially.
    - Affected files/areas: `VisualNode`, `SettingsModal`, `PromptDesigner`, `NodeCanvas`, `GraphList`.

22. **Added broader regression coverage**
    - Why: Core execution and app state had too little test coverage for safe refactoring.
    - How: Added tests for cycle detection, preprocessing, serialization, selectors, storage, user-input actions, and graph folders.
    - Affected files/areas: core tests, app selector/storage tests, graph action tests.

23. **Restructured state management boundaries**
    - Why: Raw atoms, derived selectors, storage, and business logic were interleaved.
    - How: Separated state shape, selectors, actions, and storage-oriented logic.
    - Affected files/areas: app state modules, selectors, actions, storage helpers.

24. **Moved `GraphProcessor` closer to orchestration-only ownership**
    - Why: Scheduling, control-flow exclusion, split runs, loops, subprocessors, and child events were still packed together.
    - How: Extracted planner/subprocessor helpers and passed shared execution state through deeper flows.
    - Affected files/areas: `GraphProcessor`, execution planner/subprocessor helpers.

25. **Broke up `ChatNodeBase` and provider duplication**
    - Why: Provider nodes duplicated prompt shaping, token budgeting, streaming, outputs, and cost tracking.
    - How: Moved shared chat pipeline behavior into focused helpers and left providers with provider-specific code.
    - Affected files/areas: `ChatNodeBase`, provider chat nodes, chat pipeline modules.

26. **Simplified execution connectivity into an explicit session manager**
    - Why: Readiness, reconnects, sockets, and promise bridges were spread across hooks.
    - How: Introduced one executor-session layer with explicit states and transport boundaries.
    - Affected files/areas: executor session hooks/state, internal sidecar connection, remote debugger connection.

27. **Consolidated project load/save/switch into workspace transitions**
    - Why: Project lifecycle hooks had slightly different persistence and cleanup rules.
    - How: Created a clearer workspace-transition flow for graph syncing, atom cleanup, view restore, and Trivet/static data persistence.
    - Affected files/areas: workspace/project load/save hooks, graph-switch code, persistence helpers.

28. **Decomposed remaining large app components by responsibility**
    - Why: Several UI files were still broad enough to slow review and hide ownership.
    - How: Split along domain boundaries instead of line-count chunks.
    - Affected files/areas: `NodeCanvas`, `NodeEditor`, `NodeOutput`, `RenderDataValue`, `SettingsPages`, `PluginsOverlay`.

29. **Centralized app-side execution status derivation**
    - Why: UI components computed run eligibility, active/paused state, node status, and output visibility in multiple ways.
    - How: Moved those concepts into selectors/helpers near execution state.
    - Affected files/areas: execution selectors, action bar, node styling, process page, output display.

30. **Separated platform-neutral app logic from desktop integration**
    - Why: Product logic depended on Tauri dialogs, sidecar bootstrap, filesystem paths, and desktop-only helpers.
    - How: Introduced explicit platform adapters and documented the boundary.
    - Affected files/areas: app platform utilities, IO providers, sidecar bootstrap, developer docs.

31. **Consolidated serialization further**
    - Why: V3/V4 compatibility and YAML envelope logic were still duplicated.
    - How: Extracted shared serialization helpers and narrowed version detection entry points.
    - Affected files/areas: serialization versions, compatibility helpers, round-trip tests.

32. **Split `nativeApp.ts` into platform capability modules**
    - Why: One native helper became a catch-all for app, shell, window, dialog, filesystem, updater, and HTTP behavior.
    - How: Replaced it with focused modules under `utils/platform/`.
    - Affected files/areas: `utils/platform/app`, `shell`, `window`, `dialog`, `fs`, `path`, `updater`, `http`.

33. **Simplified node/plugin registration ownership**
    - Why: Built-in registration, plugin loading, runtime reset, and global replacement were mixed together.
    - How: Created explicit registry assembly operations that app and executor can share.
    - Affected files/areas: registry assembly helpers, plugin loading hooks, app-executor registry setup.

34. **Replaced ad hoc detached async event emission**
    - Why: Fire-and-forget event emission used repeated local lint suppressions and promise-detachment patterns.
    - How: Added an explicit helper for intentional detached async emission.
    - Affected files/areas: core execution event emission paths.

35. **Cleaned up CJS/ESM friction in Node runtimes**
    - Why: `rivet-node` and `app-executor` had scattered mixed-module compatibility hacks.
    - How: Centralized interop helpers and documented why packaging-specific patterns exist.
    - Affected files/areas: `packages/node`, `packages/app-executor`, plugin dynamic import paths.

36. **Created a small UI domain layer for graph editing actions**
    - Why: Graph editing workflows were rebuilt in hooks, commands, state, and callbacks.
    - How: Grouped stable workflows into domain modules for node, connection, navigation, and graph/folder operations.
    - Affected files/areas: `packages/app/src/domain/graphEditing`, commands, graph editing hooks.

37. **Made data-value rendering table-driven**
    - Why: One large branch handled many data-value display types.
    - How: Moved type-specific behavior into renderer-map entries with a clear fallback.
    - Affected files/areas: `RenderDataValue`, render-data-value renderer modules/styles.

38. **Moved non-React logic out of hooks**
    - Why: Pure transformations and imperative workflows were hidden inside React hooks.
    - How: Extracted plain helper modules and left hooks as atom/effect/callback adapters.
    - Affected files/areas: app hooks and utility modules.

39. **Added regression coverage for simplified boundaries**
    - Why: New seams needed focused tests before more glue could be deleted safely.
    - How: Added tests around execution, workspace, platform, chat, and graph-editing helpers.
    - Affected files/areas: app/core test suites for the extracted boundaries.

40. **Replaced executor-session singleton ownership with an explicit runtime**
    - Why: Module-level mutable socket/callback state hid lifecycle ownership.
    - How: Moved connection state, routing, request dispatch, and teardown into an app-scoped runtime.
    - Affected files/areas: executor session runtime, executor hooks, transport adapters.

41. **Made remote execution request-scoped**
    - Why: Single-flight pending run state could attach completions/errors to the wrong request.
    - How: Added stable request IDs and request-scoped tracking.
    - Affected files/areas: remote executor, debugger protocol handling, run request state.

42. **Reduced mutable global registry switching**
    - Why: Project/plugin behavior depended on ambient registry mutation.
    - How: Moved toward explicit project-scoped registry ownership.
    - Affected files/areas: registry state, project plugin loading, validation/runtime setup.

43. **Added bounded concurrency policy to `GraphProcessor`**
    - Why: Execution queues defaulted to effectively unbounded concurrency.
    - How: Introduced explicit concurrency policy for scheduler behavior.
    - Affected files/areas: `GraphProcessor`, split-run/concurrency execution policy.

44. **Deduplicated multi-project workspace state**
    - Why: Open tabs and persistence layers duplicated project authority.
    - How: Moved toward one authoritative workspace model and narrower derived tab/snapshot metadata.
    - Affected files/areas: multi-project workspace state, tab metadata, project persistence.

45. **Made app error handling more boundary-aware**
    - Why: Important transport, execution, plugin, and workspace errors often collapsed into generic logs/toasts.
    - How: Preserved more context and made boundary-specific failures more structured.
    - Affected files/areas: executor/session errors, plugin loading errors, workspace transition errors.

46. **Consolidated repeated async action boilerplate**
    - Why: Components and hooks repeated `try/catch`, metadata wiring, and mutation setup.
    - How: Introduced helpers such as `wrapAsync` and shared handled-mutation plumbing where behavior was routine.
    - Affected files/areas: app async handlers, React Query mutation wrappers, UI action callbacks.

47. **Added execution identity to subgraph dataflow**
    - Why: Inspector data for repeated subgraph runs could mix different invocations by array position.
    - How: Added `rootRunId` and `graphRunId`, attached identities to events, updated recording/replay, and made graph-view inspection run-scoped.
    - Affected files/areas: core execution events, recording/replay, graph view context, app execution reducers, run switcher.

48. **Simplified the execution dataflow app layer**
    - Why: The first execution-identity landing used mismatched `GraphViewKey` formats and fallback logic.
    - How: Removed dead project-scanning inference, centralized graph selection, and filtered node data by `graphRunId`.
    - Affected files/areas: graph-run view selectors, execution data state, `getGraphRunsForView`, graph navigation.

49. **Simplified remaining execution dataflow glue**
    - Why: Local/remote run-from preload, input/output sanitization, graph-run completion updates, and selected-run lookup were duplicated.
    - How: Shared run-from preload derivation, centralized sanitization, added `finishGraphRun(...)`, and passed selected run data down from `VisualNode`.
    - Affected files/areas: `useGraphExecutionEvents`, execution data selectors, `VisualNode` children, preload helpers.

50. **Made canvas undo/redo transactional and preview-driven**
    - Why: Wire rewiring created broken intermediate undo states, and duplicate/paste/auto-layout bypassed history.
    - How: Kept graph state intact until drop, carried original connection in drag state, used preview-aware selectors, routed duplicate/paste/auto-layout through commands, and cleared stale history after out-of-band graph replacement.
    - Affected files/areas: canvas wire drag state, command history, duplicate/paste/auto-layout, preview selectors.

51. **Seeded blank projects with a real default graph**
    - Why: Blank projects showed an in-memory graph not yet present in `project.graphs`.
    - How: Created a `Main graph` in project state, set `mainGraphId`, and normalized project-load graph selection.
    - Affected files/areas: blank project creation, project loader, opened project metadata, workspace transitions.

52. **Made large execution outputs preview-first and ref-backed**
    - Why: Huge payloads in reactive state made the canvas sluggish even when full output was not open.
    - How: Stored oversized payloads in ref-backed storage with preview metadata, restored full values for copy/preload/inspection, and cleaned refs on reset/removal.
    - Affected files/areas: execution data storage, node output, fullscreen output, chat viewer, tooltips, preload/copy paths.

53. **Cleaned large-output boundaries and hot render paths**
    - Why: Stored-data restoration logic was repeated across output surfaces, and renderer registries were rebuilt per component.
    - How: Centralized readers in `executionDataReaders.ts`, added display-copy projection later, made renderer registry module-level/lazy, and tightened ref access.
    - Affected files/areas: `executionDataReaders.ts`, `executionDataCopyValue.ts`, `RenderDataValue`, node output readers.

54. **Added scoped Monaco folding for built-in node editors**
    - Why: Folding was needed for code/JSON node-editor fields without affecting prompt-like or unrelated Monaco surfaces.
    - How: Added `enableFolding` opt-in, enabled it for targeted built-in fields, remounted Monaco when folding/theme context changed, and shared prompt theme expansion.
    - Affected files/areas: code editor definitions, shared `CodeEditor`, node-editor Monaco wrapper, `codeEditorTheme.ts`.

55. **Added persistent per-node-type editor viewport resizing**
    - Why: Code/JSON editor fields were cramped and not user-resizable.
    - How: Added a bottom-edge resizable shell for `javascript` and `json` editor fields, persisted height in app UI storage by node type, and centralized eligibility/validation/final height.
    - Affected files/areas: node-editor code viewport shell, `useNodeEditorCodeViewportHeight.ts`, app UI storage.

56. **Made node-output `Copy value` match displayed output**
    - Why: Copying generic outputs returned internal `DataValue` wrappers instead of the shape users saw.
    - How: Added display-aligned projection, kept JSON/debug copy separate, added node-specific visible-output projectors, and delegated clipboard actions.
    - Affected files/areas: `executionDataCopyValue.ts`, `executionDataReaders.ts`, `nodeOutputCopyValueProjectors.ts`, `nodeOutputCopyActions.ts`, `NodeOutput.tsx`.

57. **Added fullscreen search inside node output**
    - Why: Users needed output-local search for large/structured fullscreen previews.
    - How: Added modal-scoped search UI, next/previous navigation, match counts, highlight rebuilds, markdown-aware behavior, and large-stored-value provider search.
    - Affected files/areas: `NodeOutput.tsx`, `FullscreenNodeOutputToolbar.tsx`, `fullscreenOutputSearch.ts`, `useFullscreenOutputSearch.ts`, `useLargeStoredValueFullscreenSearch.ts`.

58. **Persisted per-project editor view without changing project files**
    - Why: Reopening projects could lose active subgraph context, pan/zoom, or graph navigation state.
    - How: Added app-side project editor state keyed by project id, sanitized persisted graph-view state, synchronized snapshots through project load/switch/save flows, and flushed grouped storage on save.
    - Affected files/areas: `projectEditor.ts`, `projectEditorState.ts`, `useRestorePersistedWorkspace.ts`, `useSyncCurrentProjectEditorState.ts`, `useCurrentProjectEditorSnapshot.ts`.

59. **Centralized editor preference defaults after `PRE-refactor`**
    - Why: UI fallback reads for default colors and auto-open node settings were scattered.
    - How: Added `resolveEditorPreferences(settings)`, removed the narrower pass-through helper, and used resolved preferences in add-node commands.
    - Affected files/areas: `packages/app/src/state/settings.ts`, `settings.test.ts`, `packages/app/src/commands/addNodeCommand.ts`.

60. **Centralized runtime settings construction**
    - Why: Core, Node, and Trivet processor creation duplicated runtime settings defaults.
    - How: Added `resolveProcessSettings(...)` in core and reused it from processor creation while keeping Node environment fallbacks injected.
    - Affected files/areas: `packages/core/src/api/processSettings.ts`, `packages/core/src/api/createProcessor.ts`, `packages/node/src/api.ts`, `packages/trivet/src/api.ts`, `developer-docs/APP-ARCHITECTURE.md`.

61. **Documented editor-only settings boundaries**
    - Why: Public `Settings` contains editor-facing fields that graph execution ignores.
    - How: Kept fields for compatibility but documented app editor preferences versus runtime settings normalization.
    - Affected files/areas: `packages/core/src/model/Settings.ts`, `developer-docs/APP-ARCHITECTURE.md`.

62. **Extracted node metadata editing**
    - Why: `NodeEditor` mixed title, description, color, split-run, variant, and conditional controls.
    - How: Moved title/description/color metadata editing into `NodeMetadataEditor` and kept global controls focused on runtime/editing controls.
    - Affected files/areas: `packages/app/src/components/NodeEditor.tsx`, `packages/app/src/components/nodeEditor/NodeMetadataEditor.tsx`, `NodeEditorGlobalControls.tsx`.

63. **Centralized default node-editor row rendering**
    - Why: Editor definition mapping and grouped inline-field layout were duplicated in JSX.
    - How: Added `getEditorRenderRows(...)` and related key policy in `editorUtils`; `DefaultNodeEditor` renders the row model.
    - Affected files/areas: `DefaultNodeEditor.tsx`, `DefaultNodeEditorField.tsx`, `editorUtils.ts`, `editorUtils.test.ts`.

64. **Kept node-editor width ownership centralized**
    - Why: Width persistence is sticky user state and risky to duplicate.
    - How: Audited and kept `useNodeEditorWidth` plus `NodeEditorResizeContext` as the single width boundary.
    - Affected files/areas: `useNodeEditorWidth.ts`, `NodeEditorResizeContext.ts`, `NodeEditor.tsx`.

65. **Kept dynamic-port connection recovery in domain helpers**
    - Why: Recovery policy is undo-sensitive and should not live in editor UI.
    - How: Commands call existing domain helpers for recovery and validation rather than duplicating port filtering.
    - Affected files/areas: `editNodeCommand.ts`, `editNodeConnectionRecovery.ts`, `connectionValidation.ts`, `stringListPortBinding.ts`.

66. **Made canvas visibility policy explicit**
    - Why: Comment-node visibility, passive viewport freezing, and drag exceptions were easy to break.
    - How: Added `canvasVisibilityBounds.ts` and `viewportVisibilityPolicy.ts`, with focused tests.
    - Affected files/areas: `useVisibleCanvasNodes.ts`, `canvasVisibilityBounds.ts`, `viewportVisibilityPolicy.ts`, related tests.

67. **Separated wire candidate selection from SVG rendering**
    - Why: Wire clipping, freeze behavior, and selection policy made `WireLayer` too complex.
    - How: Added `useRenderableWires` and `getRenderableWireCandidates` so `WireLayer` focuses on SVG/event rendering.
    - Affected files/areas: `WireLayer.tsx`, `useRenderableWires.ts`, `getRenderableWireCandidates.ts`.

68. **Cleaned visual-node CSS without changing cascade broadly**
    - Why: Node state styling had repeated selectors and non-obvious stacking rules.
    - How: Grouped reveal selectors with `:is(...)`, documented Comment stacking, removed extra split-run markup, and kept broad reordering out.
    - Affected files/areas: `nodeStyles.ts`, `NormalVisualNodeContent.tsx`, `VisualNode.tsx`, `SplitRunModeIcon.tsx`.

69. **Added parsed-source display utilities**
    - Why: Expression, JS List, and Extract Object Path repeated display-only interpolation checks.
    - How: Added `parsedSourceDisplayUtils.ts` for "show parsed source only when interpolation-created inputs exist"; runtime substitution stayed node-specific.
    - Affected files/areas: `expressionOutputUtils.ts`, `jsListOutputUtils.ts`, `extractObjectPathOutputUtils.ts`, `parsedSourceDisplayUtils.ts`.

70. **Consolidated structured node output presentation**
    - Why: Expression, JS List, Extract Object Path, and Code diagnostics repeated labeled sections, error text, and parsed-source UI.
    - How: Added `StructuredNodeOutput.tsx` as a common shell without node-type switches or output-port knowledge.
    - Affected files/areas: `ExpressionNode.tsx`, `JSListNode.tsx`, `ExtractObjectPathNode.tsx`, `CodeNode.tsx`, `StructuredNodeOutput.tsx`.

71. **Isolated Code-node diagnostics display**
    - Why: Core error diagnostics and app formatting were mixed.
    - How: Added an app view-model helper while core kept diagnostics extraction.
    - Affected files/areas: `CodeNode.tsx`, `codeNodeOutputUtils.ts`, `codeNodeErrorDiagnostics.ts`.

72. **Shared JS Filter / JS Map scaffolding while keeping wrappers explicit**
    - Why: JS Filter and JS Map duplicated editor/body/process scaffolding.
    - How: Added `jsListCallbackHelpers.ts` for shared scaffolding and preview generation, while filter/map runtime wrappers remain readable and distinct.
    - Affected files/areas: `JSFilterNode.ts`, `JSMapNode.ts`, `jsListCallbackHelpers.ts`, related tests.

73. **Created a display-ready graph-input usage model**
    - Why: Delete-confirmation UI was recomputing graph names and caller labels.
    - How: `graphInputUsage.ts` returns display paths and caller labels; the modal stays presentational.
    - Affected files/areas: `graphInputUsage.ts`, `graphInputUsage.test.ts`, `DeleteGraphInputConfirmModal.tsx`.

74. **Kept graph-input rename and delete policies separate**
    - Why: Deletion warnings conservatively include Call Graph object-input usages; rename propagation should only rewrite direct Subgraph terminals.
    - How: Audited shared traversal opportunities and kept policy-specific paths separate.
    - Affected files/areas: `graphInputRenamePropagation.ts`, `graphInputUsage.ts`, `editNodeCommand.ts`, `deleteNodeCommand.ts`, domain tests.

75. **Extracted remote-debugger popup positioning**
    - Why: DOM measurement and popup clamping made UI code harder to read.
    - How: Added `debuggerPanelPosition.ts` for fallback, anchored placement, and horizontal clamping.
    - Affected files/areas: `DebuggerConnectPanel.tsx`, `ActionBar.tsx`, `debuggerPanelPosition.ts`, `debuggerPanelPosition.test.ts`.

76. **Kept modal sharing as pure helpers instead of a modal framework**
    - Why: A generic modal abstraction would add more complexity than it removed.
    - How: Kept fullscreen bounds math pure and graph-input modal data display-ready, but did not introduce a broad modal hierarchy.
    - Affected files/areas: `FullScreenModal.tsx`, `fullScreenModalBounds.ts`, `DeleteGraphInputConfirmModal.tsx`.

77. **Enforced maintainability-gated deletion in the second refactor pass**
    - Why: The first post-`PRE-refactor` cleanup improved structure but missed code-volume goals.
    - How: Used commit `29b9b889` as baseline, applied a helper-rent rule, and refused net-growth substeps unless they improved a boundary.
    - Affected files/areas: `refactoring2.md`; implementation touched editor, output, JS-list, canvas, and docs areas below.
    - Result: `152` net production lines removed, excluding docs/tests.

78. **Trimmed low-return editor abstractions**
    - Why: Some helper boundaries needed to prove they paid rent.
    - How: Kept `editorUtils` because it protects grouping/key policy, reverted a weak `NodeMetadataEditor` simplification, removed repeated title/description CSS, and left width persistence untouched.
    - Affected files/areas: `DefaultNodeEditor.tsx`, `editorUtils.ts`, `editorUtils.test.ts`, `NodeMetadataEditor.tsx`, `NodeEditorGlobalControls.tsx`, `NodeEditor.tsx`, `useNodeEditorWidth.ts`, `NodeEditorResizeContext.ts`.

79. **Collapsed structured-output duplication further**
    - Why: The structured shell still had nearby duplicated split-output and wrapper-component glue.
    - How: Centralized numeric split-output sorting, removed thin JS Filter/Map output wrapper components, and fixed error-state suppression to use status type.
    - Affected files/areas: `StructuredNodeOutput.tsx`, `CodeNode.tsx`, `ExpressionNode.tsx`, `JSListNode.tsx`, `ExtractObjectPathNode.tsx`.
    - Result: `81` net production lines removed in the structured-output phase.

80. **Trimmed JS-list helper surface**
    - Why: Preview-only helpers did not need to be exported as a larger API.
    - How: Made unneeded helpers file-local, kept wrapper builders exported where tests protect generated-code behavior, and kept wrapper strings explicit.
    - Affected files/areas: `jsListCallbackHelpers.ts`, `JSFilterNode.ts`, `JSMapNode.ts`.

81. **Hardened accepted-growth helpers without collapsing useful boundaries**
    - Why: Some new helpers added lines but protected difficult policies.
    - How: Kept `useRenderableWires`, visibility helpers, `processSettings`, `debuggerPanelPosition`, and graph-input usage model where they owned testable policy; trimmed small redundant exports/labels.
    - Affected files/areas: `useRenderableWires.ts`, `canvasVisibilityBounds.ts`, `viewportVisibilityPolicy.ts`, `processSettings.ts`, `debuggerPanelPosition.ts`, `graphInputUsage.ts`.

82. **Made refactor-plan outcomes more truthful**
    - Why: `DONE` labels were too ambiguous for future planning.
    - How: Recorded whether each substep was deleted, collapsed, kept intentionally, or accepted growth; updated docs only for real ownership changes.
    - Affected files/areas: `refactoring2.md`, `developer-docs/*`.

83. **Scoped the post-Chat-v2 hardening pass**
    - Why: After `a36014d5`, new complexity concentrated around LLM Chat v2, worker isolation, settings polish, output UI, and package metadata.
    - How: Used `a36014d5` as boundary, classified growth buckets, and avoided reopening stable completed areas without a concrete post-refactor reason.
    - Affected files/areas: `refactoring3.md`; subsequent entries describe implementation.
    - Result: Original deletion target was missed; the accepted tradeoff was clearer high-risk Chat v2 runtime ownership.

84. **Extracted LLM Chat v2 credential resolution**
    - Why: API-key source policy is security-sensitive and was mixed with provider/runtime setup.
    - How: Moved configured-provider keys, custom-provider env lookup, input-port validation, and missing-key errors into the cohesive runtime-options boundary.
    - Affected files/areas: `llmChatV2NodeRuntime.ts`, `chatV2RuntimeOptions.ts`, `LLMChatV2Node.test.ts`, `developer-docs/APP-ARCHITECTURE.md`.

85. **Extracted LLM Chat v2 editor-cache policy**
    - Why: Cache identity mixed prompts, credentials, provider config, tools, response format, and generation settings inside the runtime coordinator.
    - How: Added `chatV2EditorCache.ts` for cache keys, secret/provider fingerprints, output cloning, and editor-only cache lookup.
    - Affected files/areas: `llmChatV2NodeRuntime.ts`, `chatV2EditorCache.ts`, `llmChatV2NodeData.ts`, `LLMChatV2Node.test.ts`, `developer-docs/APP-ARCHITECTURE.md`.

86. **Extracted LLM Chat v2 generation, provider-option, and tool policy**
    - Why: Vercel SDK option shapes and provider-specific reasoning/tool settings were too dense in the coordinator.
    - How: Added cohesive `chatV2RuntimeOptions.ts` ownership for generation settings, extra provider options, provider-specific reasoning/thinking, tool choice, built-in provider tools, and OpenAI parallel-tool settings.
    - Affected files/areas: `llmChatV2NodeRuntime.ts`, `chatV2RuntimeOptions.ts`, `providerOptions.ts`, `toolContinuation.ts`, Chat v2 tests.

87. **Left the LLM Chat v2 runtime coordinator as high-level assembly**
    - Why: Too many small helpers can create jump fatigue, but the coordinator should not own raw JSON parsing or provider-specific object construction.
    - How: Kept `resolveLLMChatV2RuntimeConfig(...)` focused on provider/model/base URL, credentials, model instance, functions, runtime options, response format, and cache lookup.
    - Affected files/areas: `llmChatV2NodeRuntime.ts`, `chatV2RuntimeOptions.ts`, `chatV2EditorCache.ts`.

88. **Hardened LLM Chat v2 provider error normalization**
    - Why: Provider and Vercel errors need user-facing detail without leaking secrets or destroying unknown debugging information.
    - How: Trimmed broad data rendering, preserved scalar/nested provider messages, stripped endpoint query strings, passed aborts through, and kept original causes attached.
    - Affected files/areas: `chatV2Errors.ts`, `chatV2Errors.test.ts`, `chatV2Pipeline.ts`, `developer-docs/APP-ARCHITECTURE.md`.

89. **Grouped LLM Chat v2 provider-specific settings definitions**
    - Why: Provider editor sections were hard to audit for visibility/order.
    - How: Added named in-file builders for OpenAI, Anthropic, and Google sections plus a small provider-section helper; avoided a broad settings DSL.
    - Affected files/areas: `llmChatV2NodeEditors.ts`, `LLMChatV2Node.test.ts`.

90. **Simplified the LLM Chat v2 model catalog editor in place**
    - Why: Refresh status, provider/status keys, and refresh messages were mixed into render logic.
    - How: Kept status as a small module-level map, named provider/status-key helpers, and moved refresh message construction into a pure helper without extracting unnecessary hooks/components.
    - Affected files/areas: `LLMChatV2ModelCatalogEditor.tsx`, `chatV2ModelCatalog.ts`, `chatV2CustomProviderEnv.ts`.

91. **Standardized settings field spacing with small CSS ownership**
    - Why: Node/app settings spacing had repeated one-off margin fixes.
    - How: Used named spacing variables in settings page styles and node editor group/row styling instead of adding a new React shell.
    - Affected files/areas: `DefaultNodeEditorField.tsx`, `EditorGroup.tsx`, `KeyValuePairEditor.tsx`, `StringListEditor.tsx`, `SegmentedEditor.tsx`, app settings pages, `settingsPageStyles.ts`, `nodeStyles.ts`.

92. **Consolidated toggle and segmented-control sizing policy**
    - Why: App settings and node settings controls risked drifting visually.
    - How: Kept `ScalableToggle` as primitive, `LabeledToggle` as label/hint wrapper, and left segmented control sizing with its existing scaled owner.
    - Affected files/areas: `LabeledToggle.tsx`, `ScalableToggle.tsx`, `SegmentedEditor.tsx`, `UiSettingsPage.tsx`, node editor styles.

93. **Reunified output and fullscreen presentation where sharing already existed**
    - Why: Output surfaces should use one visual language without reopening completed structured-output internals.
    - How: Verified compact/fullscreen output share render-data-value styles and kept toolbar ownership split between modal geometry and toolbar controls.
    - Affected files/areas: `renderDataValueStyles.ts`, `NodeOutput.tsx`, `FullScreenModal.tsx`, `FullscreenNodeOutputToolbar.tsx`, `StructuredNodeOutput.tsx`.

94. **Audited app-executor worker console serialization**
    - Why: Worker source and current-thread fallback duplicated small console serialization logic.
    - How: Kept the duplication because the worker source is string-evaluated and sharing host functions would add bundling complexity; documented the `includeRivet` fallback boundary.
    - Affected files/areas: `packages/app-executor/bin/AppExecutorWorkerCodeRunner.mts`, `developer-docs/APP-ARCHITECTURE.md`, `developer-docs/CORE-ENGINE.md`.

95. **Kept Prompt and Tool body preview behavior explicit**
    - Why: Prompt has line-by-line empty-line preservation and interpolation highlighting; Tool uses markdown body rendering and schema interpolation rules.
    - How: Did not create a generic body-line renderer; documented that Tool Description reuses the resizable code editor shell without creating interpolation ports.
    - Affected files/areas: `PromptNode.tsx`, `NodeBody.tsx`, `ToolNode.ts`, `developer-docs/APP-ARCHITECTURE.md`.

96. **Audited OpenAI-compatible provider dependency ownership**
    - Why: Custom-provider support added package and PnP/Vite resolution risk.
    - How: Kept `@ai-sdk/openai-compatible` in `packages/core` for runtime construction and in `packages/app` for app/Vite workspace resolution under PnP.
    - Affected files/areas: `packages/core/package.json`, `packages/app/package.json`, `yarn.lock`, `.pnp.cjs`, `providerOptions.ts`, `developer-docs/PACKAGES.md`.

97. **Kept small post-refactor UI and graph patches local**
    - Why: Small cohesive patches should not be churned just because they landed after a refactor boundary.
    - How: Audited Ctrl+X, graph-reference reachability, split-run summary/concurrency, max concurrent runs, and resize cursor normalization; no refactor applied.
    - Affected files/areas: `useCopyNodesHotkeys.ts`, `graphReachability.ts`, `SplitRunSummary.tsx`, `SplitRunProcessor.ts`, `NodeBase.ts`, `resizeCursors.ts`.

98. **Fixed app lint including a hook-order bug**
    - Why: Lint was red and one failure was a real conditional-hook bug in `PortInfo`.
    - How: Split `PortInfo` into wrapper/inner components so hooks only mount after a valid port definition; cleaned duplicate imports, `prefer-const`, async click handlers, and hook dependencies.
    - Affected files/areas: `PortInfo.tsx`, `NavigationBar.tsx`, `LLMChatV2ModelCatalogEditor.tsx`, fullscreen/search hooks, prompt designer attached-node hook, execution/menu/node-event hooks, platform shell utility.

99. **Redacted runtime/provider logging**
    - Why: Runtime execution paths logged graph data and provider chunks too freely.
    - How: Added runtime logging helpers, moved shape diagnostics behind debug logging, summarized provider JSON parse failures, and avoided normal logs of raw port maps, provider chunks, and sidecar stderr text.
    - Affected files/areas: `runtimeLogging.ts`, `providerStreamParsing.ts`, `executor.mts`, executor sidecar runtime, local/remote executor hooks, OpenAI/Anthropic provider utilities, Trivet API, `developer-docs/CORE-ENGINE.md`.

100. **Extracted loop-controller break policy**
    - Why: `GraphProcessor` had a confusing suppressed branch around loop-controller break handling.
    - How: Added `loopControllerBreak.ts` with `didLoopControllerBreak(...)` and exported the `loop-not-broken` sentinel; covered behavior with focused tests.
    - Affected files/areas: `GraphProcessor.ts`, `loopControllerBreak.ts`, `loopControllerBreak.test.ts`.

101. **Documented tracked pnpm sidecar binary policy**
    - Why: Large platform sidecar binaries were tracked without an explicit review/update policy.
    - How: Kept binaries tracked, classified them in `.gitattributes`, added README/checksums, and documented update/release implications.
    - Affected files/areas: `.gitattributes`, `packages/app/sidecars/pnpm/README.md`, `packages/app/sidecars/pnpm/SHA256SUMS`, `useLoadPackagePlugin.ts`, `tauri.conf.json`, `developer-docs/BUILD-AND-CI.md`, `developer-docs/PLUGIN-SYSTEM.md`.

102. **Centralized unsafe provider stream parse diagnostics**
    - Why: OpenAI and Anthropic had duplicated raw-chunk parse diagnostics.
    - How: Added `providerStreamParsing.ts` and shared JSON chunk parse/error policy while avoiding a broad provider abstraction.
    - Affected files/areas: `openai.ts`, `anthropic.ts`, `ChatAnthropicNode.ts`, `providerStreamParsing.ts`, `providerStreamParsing.test.ts`.

103. **Split node-output surface ownership**
    - Why: `NodeOutput.tsx` had grown into a broad owner for inline rendering, fullscreen modal orchestration, process paging, output fade/replacement policy, search, wrapping, copy actions, and prompt-designer entry.
    - How: Kept `NodeOutput.tsx` as the stable adapter and compatibility re-export, then moved in-canvas rendering to `NodeInlineOutput.tsx`, fullscreen output orchestration to `NodeFullscreenOutput.tsx`, content-key fade/replacement-grace policy to `NodeOutputContentState.tsx`, and shared process controls to `NodeOutputPager.tsx`.
    - Affected files/areas: `NodeOutput.tsx`, `NodeInlineOutput.tsx`, `NodeFullscreenOutput.tsx`, `NodeOutputContentState.tsx`, `NodeOutputPager.tsx`, node-output regression tests, `developer-docs/APP-ARCHITECTURE.md`.
    - Result in numbers: `NodeOutput.tsx` shrank by 849 net production lines (`+9/-858`). The split added focused owner files, so production code moved `+876/-858` for a net `+18`; tests moved `+57/-26` for net `+31`; docs/planning moved `+1097/-9` for net `+1088` because the full refactor plan was introduced in this commit.

104. **Extract graph-list menu and presentation helpers**
    - Why: `GraphList.tsx` still owned menu item construction, context-menu target normalization, reachability/reference derivation, and row presentation flags alongside drag/drop, modal state, and rendering.
    - How: Added pure graph-list context-menu builders and target resolution in `graphListContextMenu.ts`, moved reachability/reference and row presentation derivation into `useGraphListPresentation.ts`, and left command dispatch plus graph/project modal ownership in `GraphList.tsx`.
    - Affected files/areas: `GraphList.tsx`, `FolderItem.tsx`, `graphListContextMenu.ts`, `useGraphListPresentation.ts`, graph-list regression tests, `developer-docs/APP-ARCHITECTURE.md`.
    - Result in numbers: `GraphList.tsx` shrank by 84 net production lines (`+55/-139`). The new tested helpers made production code move `+426/-170` for a net `+256`; tests moved `+288/-5` for net `+283`; docs/planning moved `+27/-5` for net `+22`.

105. **Separated execution-data storage, preview, and copy policy**
    - Why: `executionDataTransforms.ts` and `executionDataCopyValue.ts` mixed storage/ref lifecycle, preview decisions, restore helpers, and display-copy projection in broad utility files.
    - How: Added focused storage, preview, and sanitization modules, kept `executionDataTransforms.ts` as a compatibility facade, split display-copy implementation under `executionDataCopy/`, and moved internal imports to the new ownership modules.
    - Affected files/areas: `executionDataStorage.ts`, `executionDataPreview.ts`, `executionDataSanitization.ts`, `executionDataCopy/*`, execution-data regression tests, `developer-docs/APP-ARCHITECTURE.md`, `developer-docs/EXECUTION-DATA-FLOW.md`.
    - Result in numbers: broad compatibility files shrank substantially: `executionDataTransforms.ts` shrank by 780 net lines (`+22/-802`) and `executionDataCopyValue.ts` shrank by 311 net lines (`+9/-320`). The new focused modules made production code move `+1215/-1141` for a net `+74`; tests moved `+200/-0`; docs/planning moved `+154/-32` for net `+122`.

106. **Simplified remote execution client pipeline**
    - Why: `useRemoteExecutor.ts` owned upload cache decisions, websocket send handling, active request filtering, and Trivet pending-run cleanup alongside its React/session adapter responsibilities.
    - How: Added explicit upload planning in `remoteExecutorUploadCache.ts`, extracted request-id registration/filtering/send-failure helpers into `remoteExecutorRunRequest.ts`, and rewired `useRemoteExecutor.ts` to use those helpers while keeping atom reads and execution side effects in the hook.
    - Affected files/areas: `useRemoteExecutor.ts`, `remoteExecutorUploadCache.ts`, `remoteExecutorRunRequest.ts`, remote executor helper tests, `developer-docs/APP-ARCHITECTURE.md`, `developer-docs/EXECUTION-DATA-FLOW.md`.
    - Result in numbers: `useRemoteExecutor.ts` stayed essentially size-neutral (`+38/-39`, net `-1`) while request/upload policy moved into named helpers. Production code moved `+183/-46` for a net `+137`; tests moved `+208/-0`; docs/planning moved `+108/-8` for net `+100`.

107. **Split Remote Debugger server transport policies**
    - Why: `debugger.ts` owned websocket protocol handling, heartbeat, safe-send behavior, error emission, processor attachment cleanup, request-id association, and partial-output throttling in one high-impact transport file.
    - How: Kept `startDebuggerServer` as the public protocol assembler while extracting best-effort send/error policy to `debuggerTransport.ts`, heartbeat and timer cleanup to `debuggerHeartbeat.ts`, and processor listener lifecycle to `debuggerProcessorAttachments.ts`.
    - Affected files/areas: `packages/node/src/debugger.ts`, `debuggerTransport.ts`, `debuggerHeartbeat.ts`, `debuggerProcessorAttachments.ts`, Remote Debugger API docs, `developer-docs/APP-ARCHITECTURE.md`, `developer-docs/EXECUTION-DATA-FLOW.md`.
    - Result in numbers: `debugger.ts` shrank by 262 net production lines (`+41/-303`). Extracted transport/heartbeat/attachment helpers made production code move `+382/-303` for a net `+79`; no dedicated test lines moved in this commit; docs/planning moved `+88/-16` for net `+72`.

108. **Clarified app-executor Code worker ownership**
    - Why: `AppExecutorWorkerCodeRunner.mts` mixed CodeRunner orchestration, shared worker-pool lifecycle, package-sensitive stringified worker source, host-side request/result handling, and current-thread fallback behavior.
    - How: Kept `AppExecutorWorkerCodeRunner.mts` as the orchestration adapter, moved shared prewarm/pool lifecycle into `codeRunnerWorkerPool.mts`, and moved the eval worker source plus ready/result/error handling into `codeRunnerWorkerHost.mts`.
    - Affected files/areas: `packages/app-executor/bin/AppExecutorWorkerCodeRunner.mts`, `codeRunnerWorkerPool.mts`, `codeRunnerWorkerHost.mts`, `developer-docs/PACKAGES.md`, `developer-docs/EXECUTION-DATA-FLOW.md`, `developer-docs/CORE-ENGINE.md`, `developer-docs/APP-ARCHITECTURE.md`.
    - Result in numbers: `AppExecutorWorkerCodeRunner.mts` shrank by 493 net production lines (`+14/-507`). New worker host/pool owners made production code move `+546/-509` for a net `+37`; tests moved `+4/-2` for net `+2`; docs/planning moved `+78/-8` for net `+70`.

109. **Unified JS interpolation execution helpers**
    - Why: Code, Expression, JS Filter, and JS Map shared value-backed interpolation behavior but duplicated generated-code policy around input discovery, cloned inputs, safe helper identifiers, preview text, and generated-error sanitization.
    - How: Moved the shared mechanics into `jsValueInterpolation.ts` while keeping each node's runtime wrapper, output contract, permission policy, JS-list fixed-array clone order, and Code-specific line diagnostics explicit.
    - Affected files/areas: `CodeNewNode.ts`, `ExpressionNode.ts`, `jsListCallbackHelpers.ts`, `jsValueInterpolation.ts`, interpolation/display regression tests, `developer-docs/CORE-ENGINE.md`.
    - Result in numbers: duplicated node helpers shrank together by 70 net production lines across `CodeNewNode.ts`, `ExpressionNode.ts`, and `jsListCallbackHelpers.ts` (`+83/-153`). The shared helper made production code move `+168/-154` for a net `+14`; tests moved `+58/-3` for net `+55`; docs/planning moved `+34/-2` for net `+32`.

110. **Characterized GraphProcessor before further extraction**
    - Why: `GraphProcessor.ts` remains the execution heart, so further splitting needs a focused public-behavior safety net before any policy movement.
    - How: Added characterization coverage for root event order, error/finish behavior, partial-output process identity, subgraph execution metadata, preload/run-to boundaries, pause/resume scheduling, globals, and race winner/loser handling without moving runtime code.
    - Affected files/areas: `GraphProcessor.characterization.test.ts`, `developer-docs/CORE-ENGINE.md`, `refactor.md`.
    - Result in numbers: this was deliberately not a line-saving phase: production code moved `+0/-0`. It added 565 test lines and docs/planning moved `+45/-16` for net `+29`, giving future `GraphProcessor` extractions a behavior safety net before code moves.

111. **Hardened execution-data visibility, restore, and copy boundaries after the split**
    - Why: The storage/copy split exposed subtle presence-vs-value risks: absent/nullish stored port wrappers could look like explicit `undefined`, empty or hidden-only split-output maps could hide valid final `outputData`, and warnings/internal ports could leak into body rendering or copy projection.
    - How: Added shared visible-output-port policy, skipped absent wrappers consistently, preserved explicit `{ type: 'any', value: undefined }` as real data, restored preview-only inputs per port, kept executor preload strict while rejecting malformed empty output maps, aligned inline/fullscreen warning rendering, gated custom copy projectors on visible output maps, and covered hidden-only split data for internal JSON copy when no final output fallback exists.
    - Affected files/areas: `outputPortVisibility.ts`, `executionDataReaders.ts`, `executionDataStorage.ts`, `executionDataCopy/*`, `nodeOutputCopyValueProjectors.ts`, `RenderDataValue.tsx`, `PortInfo.tsx`, `ChatViewer.tsx`, node output components, Code/Expression/JS-list/Extract Object Path preview components, Prompt Designer hydration, run-from preload helpers, execution-data and output regression tests, `developer-docs/EXECUTION-DATA-FLOW.md`, `refactor.md`.
    - Result in numbers: entries 111-113 landed in one hardening commit. Commit-wide production code moved `+372/-174` for a net `+198`; tests moved `+727/-16` for net `+711`; docs/planning moved `+147/-12` for net `+135`. This entry accounts for the broad output-boundary portion, so it intentionally added code and tests rather than saving lines.

112. **Tightened remote-run preload eligibility after the client-pipeline split**
    - Why: Run-from preload should reuse only real stored boundary outputs. A stored map whose ports are all absent/nullish is malformed history, not a reusable upstream result.
    - How: Reused the execution-data reader boundary for preload extraction, skipped malformed empty stored output maps, and kept older usable runs eligible as fallback data for editor run-from behavior.
    - Affected files/areas: `remoteExecutorHelpers.ts`, `remoteExecutorHelpers.test.ts`, `executionDataReaders.ts`, `developer-docs/EXECUTION-DATA-FLOW.md`, `refactor.md`.
    - Result in numbers: the run-from preload slice of the hardening commit moved production code `+73/-15` for a net `+58` across `remoteExecutorHelpers.ts` and shared readers, added 78 focused test lines, and moved docs/planning `+122/-10` for net `+112`.

113. **Encapsulated Remote Debugger attachment snapshots after the transport split**
    - Why: Processor-routing callbacks received the live attached-processor list, which made it possible for routing code to mutate debugger-server attachment state accidentally.
    - How: Returned snapshots of attached processors to routing callbacks, kept the attachment helper as the state owner, and added regression coverage for snapshot behavior.
    - Affected files/areas: `packages/node/src/debuggerProcessorAttachments.ts`, `packages/node/src/debugger.ts`, `packages/node/test/debugger.test.ts`, `developer-docs/EXECUTION-DATA-FLOW.md`, `refactor.md`.
    - Result in numbers: the debugger attachment slice moved production code `+3/-7` for a net `-4`, added debugger test coverage `+33/-5` for net `+28`, and shared the hardening commit's docs/planning movement of `+122/-10` for net `+112`.

114. **Centralized node-output view models and copy policy**
    - Why: Inline output, fullscreen output, body rendering, warnings, split-output fallback, and copy actions still rediscovered nearby pieces of the same output-surface policy after the first output split.
    - How: Added `nodeOutputViewModel.ts` as the pure owner for selected fullscreen process data, content kind (`output`, `custom-error`, `code-error`, `generic-error`, `empty`), warning sections, body-source selection, display-copy serialization, and JSON-copy serialization. Rewired inline/fullscreen surfaces and copy actions to consume that owner while leaving React layout, fullscreen search, wrapping, Markdown toggles, prompt-designer entry, and modal geometry in the components.
    - Follow-up reassessment: Moved the absent-wrapper and hidden-only output-map guard into `nodeOutputViewModel.ts` itself so future output surfaces cannot render phantom body content by bypassing the existing selected-process filter.
    - Affected files/areas: `NodeInlineOutput.tsx`, `NodeFullscreenOutput.tsx`, `renderNodeOutputBody.tsx`, `nodeOutputCopyActions.ts`, `nodeOutputViewModel.ts`, node-output view-model tests, `developer-docs/APP-ARCHITECTURE.md`, `developer-docs/EXECUTION-DATA-FLOW.md`.
    - Result in numbers: existing inline/fullscreen/body/copy call sites moved `+82/-74` for a net `+8`, then the new 201-line `nodeOutputViewModel.ts` made production code net `+209`. The phase also added a 217-line view-model test file and updated the developer docs/refactor notes. This was not a line-saving phase; it traded a small net increase for one tested owner of duplicated output-surface policy.

115. **Deleted obsolete app-private compatibility facades**
    - Why: After storage/copy/output ownership moved to focused modules, several app-private facades no longer protected a real migration boundary and had no production imports.
    - How: Deleted the `executionDataTransforms.ts`, `syncWrapper.ts`, and `globals.ts` barrels, removed the `syncWrapper(...)` alias from `errorHandling.ts`, and moved execution-data storage regression coverage onto `executionDataStorage.test.ts` so tests import the real owner directly.
    - Affected files/areas: `executionDataStorage.test.ts`, `errorHandling.ts`, `errorHandling.test.ts`, execution-data and async-helper developer docs.
    - Result in numbers: production code moved `+0/-45` for net `-45`. Tests moved `+512/-575` for net `-63` while preserving storage/ref coverage and removing obsolete alias coverage. Docs/planning moved `+15/-4` for net `+11`.

116. **Simplified executor-session and remote transport ownership**
    - Why: `executorSession.ts` still coordinated socket lifecycle while also owning target identity, JSON frame classification, dataset request dispatch, pending graph-run promise maps, and callback error isolation.
    - How: Kept `executorSession.ts` as the state/reconnect/socket-generation coordinator and moved focused app-private policy into `executorSessionTarget.ts`, `executorSessionTransport.ts`, `executorSessionDatasetBridge.ts`, `executorSessionPendingExecutions.ts`, and `executorSessionCallbackIsolation.ts`. The debugger server and app-executor protocol were intentionally left unchanged.
    - Affected files/areas: `executorSession.ts`, new executor-session helper modules and tests, `developer-docs/APP-ARCHITECTURE.md`, `developer-docs/EXECUTION-DATA-FLOW.md`, `refactor.md`.
    - Result in numbers: `executorSession.ts` shrank by 241 net production lines (`+99/-340`). New focused production owner modules added 403 lines after the cleanup pass, so production code moved `+502/-340` for a net `+162`; tests moved `+287/-0`; docs/planning moved `+67/-9` for net `+58`.

117. **Made canvas interaction ownership explicit**
    - Why: `NodeCanvas.tsx` and `useDraggingNode.ts` still mixed React orchestration with drag policy, selection/highlight derivation, graph-search node matching, and node context-menu hydration.
    - How: Moved node-drag decision rules into `nodeDragInteraction.ts`, moved selected/editing/fullscreen/search/hover id derivation into `nodeCanvasInteractionModel.ts`, and moved node/blank-area context-menu hydration plus `Run from here` availability into `nodeCanvasContextMenuModel.ts`. The reassessment pass made graph-search highlight inputs explicit and made malformed node context-menu targets with missing node ids or node types fall back to blank-area context. `NodeCanvas` and `useDraggingNode` now pass current state into those policy owners while keeping command dispatch, refs, atoms, and rendering local.
    - Affected files/areas: `NodeCanvas.tsx`, `useDraggingNode.ts`, `DraggableNode.tsx`, `NodeCanvasViewport.tsx`, drag-overlay execution context, new node-canvas helper modules and tests, `developer-docs/APP-ARCHITECTURE.md`, `refactor.md`.
    - Result in numbers: `useDraggingNode.ts` shrank by 149 physical lines and `NodeCanvas.tsx` shrank by 17 physical lines. New focused production owner modules added 322 lines, so the production total moved to a net `+158` while taking fragile policy out of the large owners. The existing drag helper tests moved next to the new drag owner without line growth, and the phase added 205 focused test lines for interaction-model and context-menu decisions.

118. **Clarified Chat v2 output/runtime boundaries**
    - Why: `chatV2Pipeline.ts` still mixed provider-neutral output assembly, token/cost normalization, structured-response typing, request-status/request-error output construction, retry-attempt arrays, provider-failure output shape, and streaming orchestration.
    - How: Moved Chat v2 output assembly into internal `chatV2Outputs.ts` and updated the pipeline to delegate common outputs and provider-failure outputs to that owner without widening the public Chat v2 index. Added direct output-policy tests so structured response, usage/cost, reasoning, tool-call, request-status, retry-attempt, and provider-failure output shapes are pinned without relying only on mocked full-pipeline tests.
    - Affected files/areas: `packages/core/src/model/chat-v2/chatV2Pipeline.ts`, new `chatV2Outputs.ts`, focused Chat v2 output tests, `developer-docs/CORE-ENGINE.md`, `developer-docs/PACKAGES.md`, `refactor.md`.
    - Result in numbers: `chatV2Pipeline.ts` shrank by 284 physical lines (`620` -> `336`). The new focused production output owner added 296 lines after the line-reduction cleanup, so production moved by net `+12` while separating output policy from orchestration. The phase added 187 focused test lines for the newly isolated output policy.

119. **Reduced GraphProcessor node-exclusion responsibility**
    - Why: `GraphProcessor.ts` still owned disabled-node exclusion, conditional false exclusion, control-flow-excluded input policy, missing-required-input exclusion wording, merge-node exceptions, loop wait sentinel handling, and excluded output construction alongside execution state mutation.
    - How: Added `NodeExclusionPolicy.ts` as the pure owner of node-exclusion decisions and excluded output map construction. `GraphProcessor` now asks that helper for a decision, then keeps ownership of trace/event emission, stored results, attached-data propagation, in-flight cleanup, and downstream queueing.
    - Affected files/areas: `packages/core/src/model/GraphProcessor.ts`, `packages/core/src/model/NodeExclusionPolicy.ts`, focused node-exclusion policy tests, `developer-docs/CORE-ENGINE.md`, `developer-docs/PACKAGES.md`, `refactor.md`.
    - Result in numbers: `GraphProcessor.ts` shrank by 51 physical lines (`1722` -> `1671`). The new focused production policy owner added 116 lines, so production moved by net `+65` while separating exclusion policy from processor orchestration. The phase added 160 focused test lines for disabled nodes, conditional false ports, scalar control-flow exclusions, merge-node exceptions, loop wait sentinel skips, missing required input trace decisions, and excluded output creation.

120. **Closed the completed refactor record**
    - Why: After all five planned phases landed, `refactor.md` still read partly like an active future plan. It kept stale Go/No-Go gates and future-tense implementation sections, which made the completed refactor harder to audit.
    - How: Reassessed `refactor.md` against the live owner modules, focused tests, developer docs, and this history file. Rewrote it as a completed behavior-preserving refactor record, replaced future-plan sections with implemented scope, validation coverage, and remaining-risk sections, added an overall status, and removed stale active-plan gates.
    - Affected files/areas: `refactor.md`, `refactor-history.md`, live-code audit of `NodeExclusionPolicy.ts`, `chatV2Outputs.ts`, node-canvas interaction helpers, executor-session helpers, and `nodeOutputViewModel.ts`.
    - Result in numbers: no production or test code changed. Before this history entry, the `refactor.md` cleanup moved docs/planning `+107/-141` for a net `-34`, preserving the phase results while removing stale plan wording. Focused owner tests, docs typecheck, and `git diff --check` passed.

121. **Added runtime-speed benchmarks and equivalence guards**
    - Why: Runtime optimization needed a fixed measurement baseline and behavior guardrails before changing execution internals. Without them, it would be too easy to ship a risky rewrite that only moved noise or changed graph semantics.
    - How: Added shared runtime-speed fixture builders, public Node API equivalence tests, and the repeatable `yarn bench:runtime-speed` benchmark command. The benchmark suite measured file-load one-shots, loaded-project `runGraph(...)`, repeated `createProcessor(...)`, direct diagnostic `GraphProcessor`, cheap text DAGs, Expression and Code chains, lazy preprocessing/dependency planning, and Node CodeRunner micro-cost. The first averaged local baseline was recorded in `runtime-speed-plan.md` so later P1-P8 changes could compare against it instead of overwriting it.
    - Affected files/areas: `packages/node/test/runtimeSpeedFixtures.ts`, `packages/node/test/runtimeSpeedEquivalence.test.ts`, `packages/node/bench/runtimeSpeed.bench.ts`, root and Node package scripts, `developer-docs/PACKAGES.md`, `runtime-speed-plan.md`.
    - Result in numbers: the P0 commit added 1,315 lines with no deletions: 391 fixture lines, 275 equivalence-test lines, 187 benchmark lines, 432 planning/baseline lines, 28 developer-doc lines, and 2 script lines. The recorded baseline showed `runGraph` at `35.175ms` for a 500-node text chain, `2.955ms` for a 20-node Expression chain, and `10.391ms` for a 20-node Code chain, giving later optimization phases a concrete comparison point.

122. **Added a headless Node graph-runner seam for runtime-speed work**
    - Why: Programmatic Node execution needed an additive fast-path API before deeper core execution changes. Existing one-shot APIs capture inputs/context at creation or create full Node runtime defaults per call, while future runtime optimizations need one public seam that can safely own stable backend execution setup.
    - How: Added `createGraphRunner(...)` to `@valerypopoff/rivet2-node`, split runner creation-time options from per-run `inputs`, `context`, and `abortSignal`, and reused stable Node runtime providers/settings while keeping each run on a run-scoped `GraphProcessor`. The reassessment pass intentionally rejected direct processor reuse because Global node values and other processor-local mutable state could leak across backend requests.
    - Affected files/areas: `packages/node/src/api.ts`, `packages/node/test/graphRunner.test.ts`, `packages/node/test/runtimeSpeedEquivalence.test.ts`, `packages/node/test/runtimeSpeedFixtures.ts`, `packages/node/bench/runtimeSpeed.bench.ts`, Node API docs, `developer-docs/PACKAGES.md`, `runtime-speed-plan.md`.
    - Result in numbers: production Node API code moved `+141/-30` for a net `+111`, mostly for the new public runner and shared Node process-context helper. Existing test fixtures/guards moved `+88/-3`, and a new 158-line runner test file covers per-run values, overlap, abort, disposal, Global-node isolation, and creation-time provider reuse. P1 averaged benchmarks preserved the original P0 baseline and showed `createGraphRunner` at `0.084ms` for the passthrough case versus loaded-project `runGraph` at `0.117ms`, while 500-node cheap graphs stayed effectively unchanged (`33.171ms` runner versus `32.908ms` `runGraph`), confirming cached graph planning/preprocessing as the next speed target.

123. **Added the cached headless Node CodeRunner fast profile**
    - Why: The runtime-speed plan called for caching Code-family JavaScript compilation behind the new headless runner seam before attempting broader scheduler or graph-plan changes.
    - How: Added `CachedNodeCodeRunner` and a shared Node CodeRunner invocation helper, wired `createGraphRunner(..., { runtimeProfile: 'headless-fast' })` to use the cached runner only when no custom `codeRunner` is provided, and kept normal `runGraph(...)`, `createProcessor(...)`, Browser mode, Remote Debugger, and app-executor CodeRunner ownership unchanged. `Code` and `Code (legacy)` now use stable per-node source URLs so repeated backend runs can reuse compiled functions while preserving line/column error enrichment.
    - Affected files/areas: `packages/node/src/native/CachedNodeCodeRunner.ts`, `packages/node/src/native/nodeCodeRunnerInvocation.ts`, `packages/node/src/native/NodeCodeRunner.ts`, `packages/node/src/api.ts`, Code-family source URL call sites, runtime-speed benchmarks/equivalence tests, Node API docs, `developer-docs/PACKAGES.md`, `developer-docs/CORE-ENGINE.md`, `runtime-speed-plan.md`.
    - Result in numbers: production code moved about `+276/-54` for a net `+222`, mostly from the new cached runner and shared invocation helper while shrinking `NodeCodeRunner.ts` by 35 net lines and simplifying the Code source-url helper. Tests moved about `+155/-1`, adding direct cache coverage, custom-runner precedence coverage for `headless-fast`, and public runtime equivalence guards. Benchmarks moved `+47/-1`, adding direct compatible-versus-fast runner rows for Code and Expression chains. Docs/planning moved about `+125/-24`. Reassessed P2 averaged benchmarks showed the cached runner is behaviorally safe but not a reliable whole-graph Code-chain win (`6.741ms` `headless-fast` runner versus `6.584ms` compatible runner in that run), while Expression chains improved slightly (`2.785ms` fast versus `2.984ms` compatible). The next substantial target remains cached immutable graph planning and dependency data.

124. **Cached immutable graph plans for headless-fast graph runners**
    - Why: P2 proved CodeRunner compilation was not the main overhead for large cheap graphs. The next measured bottleneck was repeated graph preprocessing, connection scans, port-definition discovery, and planner adjacency work in repeated headless runs.
    - How: Extended `preprocessGraphState(...)` to produce a reusable graph execution plan with validated connection maps, directional input/output adjacency, missing-required-input lists, default start nodes, and cycle indexes. `NodeExecutionPlanner` now consumes these maps when present while keeping its old scan-based fallback. `GraphProcessor` accepts an internal runtime cache for graph-keyed preprocessed plans and loaded project-reference snapshots, and `createGraphRunner(..., { runtimeProfile: 'headless-fast' })` shares that cache across run-scoped processors and subprocessors. Reassessment passes kept the immutable plan cache but changed cached-plan runs back to fresh `NodeImpl` runtime instances, moved the node-instance stripping helper into the preprocessor owner module, and fixed a subprocess gap so subgraph/reference/call-graph child processors can cache their own plans instead of silently falling back to per-run preprocessing. Compatible runners and one-shot/editor/debugger/app-executor paths keep per-run preprocessing.
    - Affected files/areas: `packages/core/src/model/GraphPreprocessor.ts`, `packages/core/src/model/NodeExecutionPlanner.ts`, `packages/core/src/model/GraphProcessor.ts`, `packages/core/src/api/createProcessor.ts`, `packages/node/src/api.ts`, `packages/node/bench/runtimeSpeed.bench.ts`, `packages/node/test/graphRunner.test.ts`, `packages/core/test/model/GraphPreprocessor.test.ts`, Node API docs, `developer-docs/PACKAGES.md`, `developer-docs/CORE-ENGINE.md`, `runtime-speed-plan.md`.
    - Result in numbers: production core/node code moved `+310/-34`, tests moved `+244/-2`, benchmarks moved `+11/-0`, and docs/planning moved `+115/-19`. The final averaged P3 benchmark showed the first large runtime win: `createGraphRunner` 500-node text chain dropped from `32.892ms` compatible to `7.799ms` with `headless-fast`, while `runGraph` stayed on the compatible path at `32.764ms`. A temporary 50-subgraph chain benchmark measured `9.826ms` compatible versus `8.900ms` `headless-fast` after the graph-keyed subprocessor cache fix. The cache remains behavior-scoped to immutable runner snapshots and does not cache `NodeImpl` instances, run outputs, graph inputs, context, globals, queued state, abort state, or execution metadata. The larger test delta is mostly the new subgraph fixture that proves child processors reuse graph-keyed plans without losing fresh node-instance isolation.

125. **Promoted nested graph benchmark coverage**
    - Why: The P3 reassessment found the subprocessor planning gap through an ad hoc nested benchmark. Keeping that graph shape only as a temporary script would make the same regression easy to miss later.
    - How: Added `makeSubgraphChainProject(...)` to the shared runtime-speed fixtures, added compatible and `headless-fast` 50-subgraph rows to `runtimeSpeed.bench.ts`, and reused the shared fixture in `graphRunner.test.ts` instead of keeping a bespoke subgraph test builder. Updated the runtime-speed plan and developer package docs to name nested subgraph chains as part of the benchmark suite.
    - Affected files/areas: `packages/node/test/runtimeSpeedFixtures.ts`, `packages/node/bench/runtimeSpeed.bench.ts`, `packages/node/test/graphRunner.test.ts`, `developer-docs/PACKAGES.md`, `runtime-speed-plan.md`.
    - Result in numbers: benchmark code moved `+23/-0`, shared test fixtures moved `+78/-0`, and `graphRunner.test.ts` moved `+7/-119`, so the permanent nested benchmark guard actually reduced test code by about 34 net lines while adding the reusable fixture. The refreshed benchmark run measured `39.698ms` compatible versus `9.778ms` `headless-fast` for the 500-node text chain and `12.813ms` compatible versus `11.365ms` `headless-fast` for the 50-subgraph chain. The latest run was slower across most cases than the earlier P3 run, so relative wins are more meaningful than absolute milliseconds.

126. **Added orchestration benchmark fixtures before scheduler work**
    - Why: Before attempting the high-risk P4 scheduler, the runtime-speed plan
      needed permanent benchmark rows for large acyclic DAGs that stress
      fan-out/fan-in and mixed subgraph orchestration rather than only chains.
    - How: Added shared wide fan-in and mixed subgraph fan-in fixtures, added
      compatible and `headless-fast` benchmark rows for both shapes, and pinned
      their output equivalence across public Node APIs and the direct diagnostic
      processor path. Updated the runtime-speed plan to record the new benchmark
      pass and keep P4 deferred until a benchmark proves cached planning is not
      enough.
    - Affected files/areas: `packages/node/test/runtimeSpeedFixtures.ts`,
      `packages/node/bench/runtimeSpeed.bench.ts`,
      `packages/node/test/runtimeSpeedEquivalence.test.ts`,
      `developer-docs/PACKAGES.md`, `runtime-speed-plan.md`.
    - Result in numbers: benchmark harness code moved `+143/-86` for a net
      `+57`, including the new rows plus a shared runner-disposal helper.
      Shared runtime-speed fixtures moved `+104/-0`, and equivalence tests
      moved `+36/-0`. Docs/planning moved about `+102/-22` including this
      history entry. The averaged benchmark pass measured `22.535ms` compatible
      versus `4.961ms` `headless-fast` for a 200-branch fan-in graph and `9.158ms`
      compatible versus `6.999ms` `headless-fast` for the mixed subgraph fan-in
      graph.
      Those rows confirm P3's cached plan/adjacency path already delivers the
      substantial win on scheduler-heavy shapes, so P4 remains a future
      evidence-gated project rather than the next implementation step.

127. **Added single-run createProcessor runtime-speed guards**
    - Why: Wrapper endpoint execution creates a fresh `createProcessor(...)` per request, so the existing reusable-runner wins did not directly prove faster one-shot endpoint runs. The next optimization needed to improve work inside one fresh processor run while preserving debugger, recorder, custom runner, project-reference, callback, and shared-project-object behavior.
    - How: Added Node-only `NodeCreateProcessorOptions.runtimeProfile`, wired explicit `runtimeProfile: 'headless-fast'` to a run-scoped runtime cache, default CodeRunner compile cache, and narrow `fast-acyclic` ready-queue scheduler. Kept compatible defaults, kept `runGraph(...)` unchanged, and made `remoteDebugger !== undefined` force the compatible path. Cleaned preprocessor/planner hot paths by building reusable adjacency/port maps, grouping output connections by target, removing invalid connections only from their endpoint buckets, and using unique upstream-node counts so duplicate same-source input connections do not stall fast scheduling. Added P6 characterization that compares compatible and fast `createProcessor(...)` runs across final outputs, callback-visible events, serialized recorder events, user-input callbacks, partial outputs, global/user events, Code/Expression errors, aborts, subgraphs, custom CodeRunner ownership, project-reference loader behavior, and concurrent shared-project runs.
    - Affected files/areas: `packages/node/src/api.ts`, `packages/core/src/model/GraphProcessor.ts`, `packages/core/src/model/GraphPreprocessor.ts`, `packages/core/src/model/NodeExecutionPlanner.ts`, `packages/core/src/api/createProcessor.ts`, runtime-speed fixtures/benchmarks/equivalence/API/default-fast characterization tests, `developer-docs/CORE-ENGINE.md`, `developer-docs/PACKAGES.md`, `runtime-speed-plan.md`.
    - Result in numbers: production core/node code moved `+309/-65` for a net `+244`. Benchmarks moved `+53/-0`, and the Node package script changed `+1/-1` so runtime benchmarks rebuild core ESM before measuring. Tests and shared test fixtures moved about `+1318/-0`, including the new 985-line default-fast characterization suite. Developer docs and runtime-speed planning moved `+762/-90` before this history entry. Focused verification passed for Node fast-path/API/equivalence tests, core preprocessor/GraphProcessor characterization tests, node/core typechecks, node/core lint, docs build, and `git diff --check`.

128. **Split createProcessor runtime policy into explicit fast pieces**
    - Why: P7 needed the one-shot `createProcessor(...)` speed path to stop treating `headless-fast` as one all-or-nothing switch. Future default-safe behavior needs graph-plan caching, loaded-reference caching, CodeRunner caching, scheduling, and fallback reasons to be separately owned and tested.
    - How: Added internal `createProcessorRuntimePolicy.ts`, moved Node `createProcessor(...)` selection through that helper, kept omitted and explicit `compatible` fully compatible, kept explicit `headless-fast` aggressive, made Remote Debugger force full compatibility, made trace mode force only compatible scheduling, and split `GraphProcessor` loaded-project caching behind a `cacheLoadedProjects` option independent of the runtime cache itself. A reassessment pass also made execution-plan caching refuse projects with references when loaded-reference caching is disabled, because referenced project definitions can affect cached port plans.
    - Affected files/areas: `packages/node/src/createProcessorRuntimePolicy.ts`, `packages/node/src/api.ts`, `packages/core/src/model/GraphProcessor.ts`, `packages/core/src/api/createProcessor.ts`, focused policy tests, `developer-docs/CORE-ENGINE.md`, `developer-docs/PACKAGES.md`, `runtime-speed-plan.md`.
    - Result in numbers: production code moved `+105/-19` for a net `+86`, including the new 56-line runtime-policy owner. Tests moved about `+128/-0`, adding the focused policy suite plus a `GraphProcessor` guard proving loaded-project and execution-plan caches are ignored unless explicitly safe. Developer docs and runtime-speed planning moved about `+62/-7` before this history entry. The change is intentionally preparatory: omitted `runtimeProfile` still maps to compatible behavior, while P8 can now flip only the policy pieces proven safe.

129. **Made createProcessor default to the safe fast policy**
    - Why: P8 moved the headless Node endpoint path from opt-in-only optimization to a conservative default. Wrapper endpoints create a fresh processor per request, so omitted `runtimeProfile` should now get the safe one-shot wins while preserving an explicit compatible rollback.
    - How: Changed `resolveCreateProcessorRuntimePolicy(...)` so omitted `runtimeProfile` enables run-scoped subprocessor execution-plan caching and the cached default Node CodeRunner, while keeping compatible scheduling and loaded-project-reference caching off. Added an internal `executionPlanCacheMode` so the omitted default does not build an unreusable root graph plan for plain one-shot workflows. `runtimeProfile: 'compatible'` remains the old path, explicit `headless-fast` remains the aggressive profile, and unknown runtime string values from untyped callers fall back to the compatible path. Remote Debugger and omitted trace-sensitive runs force full compatibility. `runGraph(...)` now passes `runtimeProfile: 'compatible'` internally so that convenience API does not inherit the new `createProcessor(...)` default in this rollout.
    - Affected files/areas: `packages/node/src/createProcessorRuntimePolicy.ts`, `packages/node/src/api.ts`, `packages/core/src/model/GraphProcessor.ts`, `packages/core/src/api/createProcessor.ts`, `packages/node/bench/runtimeSpeed.bench.ts`, `packages/node/test/defaultFastCompatibility.test.ts`, `packages/node/test/createProcessorRuntimePolicy.test.ts`, `packages/node/test/api.test.ts`, `developer-docs/CORE-ENGINE.md`, `developer-docs/PACKAGES.md`, `runtime-speed-plan.md`.
    - Result in numbers: incremental P8 production code moved about `+35/-5` across Node policy/API and core cache-mode plumbing. Tests moved about `+167/-22`, extending policy coverage, default/compatible/fast characterization, reference-loader call-count checks, concurrent shared-project checks, a `runGraph(...)` compatibility guard, and a core characterization guard proving subprocessor-only execution-plan caching does not cache the root graph. Benchmarks moved about `+18/-3`, adding explicit compatible/default-safe/headless-fast one-shot rows. Developer docs and runtime-speed planning moved about `+139/-70` before this history entry. Focused verification passed for policy/API/default-fast characterization and core `GraphProcessor` characterization; the benchmark reassessment caught and drove the subprocessor-only default cache mode. The final P8 benchmark sample measured default-safe effectively matching compatible for a 500-node text chain (`11.592ms` versus `11.691ms`) while modestly improving repeated subgraph one-shot cases.

130. **Recovered runtime-speed regressions and finalized the execution-speed matrix**
    - Why: After the runtime-speed phases landed, the full matrix showed that isolated phase wins had hidden broad cheap-runtime regressions. The speed work needed a final recovery pass that protected the intended one-time run wins without shipping default slowdowns.
    - How: Added benchmark attribution support with `RIVET_RUNTIME_BENCH_FILTER` and `RIVET_RUNTIME_BENCH_JSON`, reran focused and full matrices, removed a redundant per-node errored-input scan from `GraphProcessor.#processNode(...)`, and added characterization coverage proving downstream nodes do not start or emit their own node errors after an upstream input node fails. Updated `execution-speed.md` to mark P8-P12 done, and rewrote `runtime-speed-before-after.md` as the canonical final full matrix.
    - Affected files/areas: `packages/core/src/model/GraphProcessor.ts`, `packages/core/test/model/GraphProcessor.characterization.test.ts`, `packages/node/bench/runtimeSpeed.bench.ts`, `runtime-speed-before-after.md`, `execution-speed.md`, `developer-docs/CORE-ENGINE.md`, `developer-docs/PACKAGES.md`.
    - Result in numbers: production runtime code shrank by 12 lines in `GraphProcessor.ts` by removing the duplicate input scan. Benchmark tooling moved `+53/-1`; focused characterization tests added 24 lines; developer docs moved `+30/-1`; planning/reporting docs moved `+544/-29` plus one 70-line benchmark report. The final full matrix compares 61 rows against the original baseline and reports 33 big wins, 11 additional wins, 16 neutral rows, 1 small slower row, and 0 regressions at or above 10%, using a `0.05ms` absolute noise gate.

131. **Closed the repo maintainability refactor plan with narrow seams and guardrails**
    - Why: The repo-wide maintainability audit identified five active risk areas: residual `GraphProcessor` responsibility concentration, large editor UI surfaces, CodeRunner capability drift, LLM Chat V2 provider-contract breadth, and report-only guardrails. The goal was to improve ownership and bug surface without changing functionality, serialized project formats, execution semantics, runtime-speed policy, or user-visible behavior.
    - How: Extracted graph-boundary effects from `GraphProcessor` into a pure `GraphBoundaryEffects` module while leaving event emission, global storage, and mutable run state in the processor. Moved graph-search panel resize math from `NavigationBar` into a small tested model. Documented the CodeRunner capability argument order and added an app-executor equivalence test against the public Node package runner for worker-safe capabilities. Added `developer-docs/LLM-CHAT-V2-CONTRACT.md` as the contract baseline for the Vercel SDK-powered `LLM Chat` node, explicitly keeping legacy Chat compatibility-only. Added a local Markdown link checker and wired it into `yarn test:style`, while leaving the broad import-boundary queue report-only because the current candidates are not all settled violations.
    - Affected files/areas: `packages/core/src/model/GraphBoundaryEffects.ts`, `packages/core/src/model/GraphProcessor.ts`, `packages/core/test/model/GraphBoundaryEffects.test.ts`, `packages/app/src/components/graphSearch/graphSearchPanelModel.ts`, `packages/app/src/components/NavigationBar.tsx`, `packages/app-executor/bin/AppExecutorWorkerCodeRunner.test.mts`, `scripts/checks/check-doc-links.mjs`, `developer-docs/CORE-ENGINE.md`, `developer-docs/APP-ARCHITECTURE.md`, `developer-docs/BUILD-AND-CI.md`, `developer-docs/LLM-CHAT-V2-CONTRACT.md`, root/developer-doc indexes, and `repo-maintainability-refactor-plan.md`.
    - Result in numbers: new production helper code is intentionally small: a 53-line core graph-boundary helper and a 33-line app graph-search model. Focused tests added 65 lines for graph-boundary effects, 42 lines for graph-search resize policy, and a cross-runner app-executor equivalence case. The docs-link guardrail added a 100-line repository script and now runs through `test:style`. The LLM Chat V2 contract added an 85-line docs-to-code matrix, and the plan was marked complete across all phases. Fresh verification passed for core tests, app tests, app-executor tests, style/docs-link checks, formatting, and `git diff --check`.

132. **Completed the ten-item UI/runtime ownership refactor series**
    - Why: After months of feature work, the app layer had accumulated several broad components and brittle tests around graph-tree rendering, output rendering, comparison UI, theme tokens, project tabs, hosted-wrapper APIs, canvas wiring, node-canvas command glue, executor-session ownership, and source-contract checks. The goal was to reduce complexity without changing runtime behavior, project YAML, hosted-wrapper contracts, or visible UI behavior.
    - How: Implemented every item in `refactor.md` and then reassessed the plan as a completed record. The refactor introduced presentation/view-model seams for graph tree rows, node-output rendering, project tabs, compare-mode canvases, and resize/command glue; moved comparison diffing into core project-comparison helpers; organized theme tokens around semantic owners; centralized hosted workspace API construction; extracted canvas connection, bend, port-hover, and port-reorder interaction helpers; clarified executor routing/session ownership; and replaced the most brittle source-string assertions with behavioral helpers where that reduced maintenance risk. The final source-contract item landed with the executor-routing cleanup, so the ten plan items correspond to nine commits after `f11847c5 PRE-refactor`.
    - Affected files/areas: `packages/app/src/components/graphList/*`, `packages/app/src/components/nodeOutput/*`, `packages/core/src/utils/projectComparison/*`, theme/color CSS and helpers, `packages/app/src/components/projectSelector/*`, `packages/app/src/hooks/workspaceHost/*`, node-canvas connection and port interaction helpers, node-canvas command/editing models, executor snapshot/session routing helpers, `scripts/checks/check-test-style.mjs`, `developer-docs/APP-ARCHITECTURE.md`, and `refactor.md`.
    - Result in numbers: relative to `f11847c5 PRE-refactor`, the completed series changed 89 files with `+5327/-3413` overall. Production code moved `+3717/-3168` for a net `+549`; tests and guardrails moved `+1469/-200`; docs/planning moved `+141/-45`. The production net increase is mostly new named owner modules and view models replacing inline responsibilities, while several large components became simpler call sites. Verification across the series included focused helper tests, app/core typechecks, app builds, style/source-contract checks, and `git diff --check`.

133. **Completed the ten-item security and maintainability refactor plan**
    - Why: The next repo-wide audit found active fragility at network-client lifecycles, rich-text trust boundaries, dependency/toolchain security, duplicated web-app semantics, UI Graph Builder state, Monaco feature registration, workspace resource selection, LLM request assembly, `GraphProcessor` lifecycle flags, and source-reading tests.
    - Plan reconciliation: This history entry closes every item marked `DONE` in the current `refactor.md`: (1) MCP transport, environment, and client lifecycle safety; (2) default-safe Markdown and HTML rendering; (3) dependency and toolchain security; (4) the shared Minimal Web App runtime; (5) the schema-driven UI Graph Builder; (6) Monaco and JSON-preview architecture; (7) project workspace target and navigator ownership; (8) the LLM Chat V2 and AI-assist request contract; (9) `GraphProcessor` run-lifecycle extraction; and (10) behavioral tests, architecture boundaries, and navigable contracts. The plan's completion record, audit date, baseline, residual watchlist, and verification evidence are now represented here as the durable historical record.
    - How: Made MCP clients operation-scoped with deterministic cleanup and secret-safe configuration; established default-safe Markdown sanitization in app and hosted renderers; upgraded the Node/Yarn/Tauri/dependency baseline and added ancestry-scoped JavaScript audit exceptions, Rust auditing, Dependabot, and immutable multi-architecture cache policy; centralized Minimal Web App semantics and generated the hosted client from a package-owned TypeScript runtime; split UI Graph Builder schemas, state, ordering, and bindings into tested owners; introduced declarative Monaco capabilities and decomposed JSON string-preview scanning, geometry, adapter, and view ownership; replaced separate graph/Node library/UI-app toggles with a project-keyed workspace target; centralized Chat V2 provider profiles, request plans, retries, model-catalog sessions, and AI-assist use of the same runtime; extracted `GraphRunLifecycle` from `GraphProcessor`; and converted high-churn source contracts to behavior models or intentional static checks with shrinking legacy allowlists.
    - Reassessment fixes: The final full-repo pass repaired stale documentation/checker references after workspace-target consolidation, made generated web-app verification resolve the Node package's own `esbuild`, tightened dependency exceptions so new runtime ancestry cannot inherit a docs/build waiver, isolated Gentrace's browser-compatible APIs from its Node-only package-root exports, exposed a narrow `@valerypopoff/rivet2-core/web-app-runtime` package contract, and moved app test discovery inside the runner to avoid Windows command-line limits. It also restored explicit DOM setup in Markdown tests and removed stale source assertions uncovered by the complete app suite.
    - Affected files/areas: MCP providers and tests; Markdown policy/renderers and sink checks; package manifests, Yarn cache/loader/lock state, Cargo and GitHub workflows; core/app/node web-app runtime modules; UI Graph Builder models/components; Monaco and JSON-preview modules; workspace target/navigation state; Chat V2 and AI-assist runtime/services; `GraphRunLifecycle` and `GraphProcessor`; test-style/file-tree/desktop/editor boundary checks; canonical developer-doc domain pages; `refactor.md`.
    - Verification: `yarn build`, aggregate `yarn test`, `yarn lint`, `yarn test:docs`, `yarn test:style`, `yarn check:file-tree`, `yarn prettier:check`, `yarn security:audit`, `cargo audit --file packages/app/src-tauri/Cargo.lock`, the runtime benchmark/equivalence matrix, and `git diff --check`. JavaScript auditing accepts only time-bounded reviewed high findings on named direct-dependent paths; Rust auditing reports the known Tauri 1/GTK maintenance warnings but no vulnerability failure. The source-reading migration queue fell to 57 guarded files and cannot grow, while the long-relative-import queue is fixed at a shrinking 154-entry baseline and package source deep imports fail immediately.

134. **Decomposed the Minimal Web App maintenance hotspots**
    - Why: The WebSocket gateway, generated hosted client source, persisted UI graph validation, builder orchestration, and Node test setup had each accumulated several responsibilities in one file. Changes to reconnect behavior, components, or builder interaction therefore carried avoidable cross-feature risk even though runtime semantics were already centralized.
    - How: Split the WebSocket gateway into ordered event-journal, active-run, lease, remote-subscription, socket-session, protocol, and bounded-store owners while preserving the public gateway API and protocol. Reduced the hosted browser entrypoint to bootstrap and separated direct-DOM rendering, HTTP/WebSocket transports, and DOM lifecycle helpers behind the existing action-runner contract. Replaced manual persisted-component validation with one Zod component/action/envelope schema plus a diagnostic and deterministic legacy-ID adapter. Moved builder selection, cross-reveal, insertion, reordering, confirmation, and keyboard deletion into `useUiGraphBuilderController`, and consolidated concrete graph-target, data-key, text-like, and mapping controls without introducing a generic form schema. Added shared typed Node project/action fixtures and a real WebSocket harness while retaining scenario-specific coordinator, persistence, timing, and failure setup in the existing suites. The final test audit also replaced revision-mismatch assertions tied to generated variable names with JSDOM behavior checks.
    - Affected files/areas: `packages/node/src/webAppSocketGateway.ts` and the new `webAppActiveRuns.ts`, `webAppRunJournal.ts`, `webAppRunStore.ts`, `webAppLeaseManager.ts`, `webAppRemoteRunSubscriptions.ts`, `webAppSocketProtocol.ts`, and `webAppSocketSession.ts`; hosted client source modules; `UiGraphSchema.ts` and `UiGraphNormalization.ts`; `UiGraphBuilder.tsx`, `componentDescriptors.tsx`, and `useUiGraphBuilderController.ts`; Node web-app tests and shared fixtures; web-app developer docs.
    - Result in numbers: Raw production LOC across the measured gateway, hosted client, schema/normalization, and builder surfaces moved from `4,744` to `4,897` (`+153`): gateway lifecycle extraction and shutdown hardening were `+230`, hosted client extraction plus back/forward-cache recovery `+1`, schema/normalization `-83`, and builder/controller/settings plus external-removal reconciliation `+5`. Node handler/gateway test infrastructure moved from `3,353` to `3,525` (`+172`) after adding multi-host drain-race, disposal-race, lease-shutdown, and browser-cache regressions. The projected large net deletion did not materialize because explicit distributed-run lifecycle ownership costs more lines than the former interdependent closure; the result favors smaller ownership units and preserved behavior over compressing coordination logic. Verification passed for 63 focused core tests, 28 builder/renderer/preview tests, 98 Node handler/gateway tests, the aggregate repository test command, all three affected workspace typechecks, root lint, Prettier, generated-client and graph-creator freshness checks, the full production build, and `git diff --check`.

135. **Made DataValue coercion one declarative policy**
    - Why: Runtime conversion and editor port compatibility were maintained by separate decision trees in `coerceType.ts`, including an explicit warning that they were hard to keep synchronized. A new scalar type or conversion could therefore change graph execution without changing connection validation, or vice versa.
    - How: Added an exhaustive mapped `scalarCoercionRules` registry keyed by every scalar target type, with an optional specialized runtime coercer and independent `canAttempt` compatibility predicate. `coerceTypeOptional(...)` now selects runtime behavior through the registry, while `canBeCoerced(...)` reads the same registry after shared array, function-target, and `any` wrapper rules. Kept `inferType(...)` separate and preserved the complete existing compatibility matrix, established scalar conversion behavior, identity where promised, and in-place assistant function-call argument normalization.
    - Reassessment fixes: Removed the redundant target property and routed target-`any` compatibility through its registry rule. Fixed structural contract gaps for deferred `any` values, `fn<T[]>` defaults, scalar extraction from function-array types, isolated mutable defaults, dynamic `any`/`object` arrays, concrete-to-deferred wrapping, compatible deferred function identity, raw-or-nested `any` deferred results, and the missing-value negative guard. Split full function return-type extraction from scalar classification so app labels still render `Function<T[]>`. Consolidated Get/Set Global defaults through `getDefaultValue(...)`.
    - Characterization: Added a full 80-by-80 ordered compatibility matrix guard covering all 6,400 pairs and locking the existing 2,270 incompatible pairs with an independent legacy-policy implementation plus a stable digest. Added value tests for scalar, array, `any`, function, binary/media, graph-reference, Knowledge Source, inference, identity, mutation, isolated defaults, dynamic arrays, deferred targets, `NaN`, undefined results, and thrown errors. Added focused app label tests and a Get Global default-isolation regression.
    - Affected files/areas: `packages/core/src/utils/coerceType.ts`, `packages/core/src/utils/expectType.ts`, `packages/core/src/model/DataValue.ts`, Get/Set Global nodes, app DataValue render/copy consumers, focused core/app tests, `developer-docs/CORE-ENGINE.md`, and `refactor.md`.
    - Result in numbers: Affected production files moved by net `+123` physical lines: `coerceType.ts` `+64`, `DataValue.ts` `+17`, `expectType.ts` `+50`, the two Global nodes `-9`, and app consumers `+1`. Focused coercion characterization added 359 test lines. The planned deletion was not pursued because explicit exhaustive and structural policy is safer and easier to audit than smaller implicit dispatch.
    - Verification: Focused coercion tests passed 17/17; the complete core suite passed 956 tests with 8 intentional skips; the complete app suite passed 1,559 tests; focused graph connection and port compatibility passed 13/13; complete core and app production builds and affected workspace lint passed; Prettier and `git diff --check` passed.

136. **Centralized Knowledge Store field and credential policy**
    - Why: Core runtime connection resolution and the project settings UI independently implemented provider defaults, required/type/select validation, and the nested local credential-settings tree. The editor could therefore drift from the runtime, and multiple owners needed to understand credential persistence.
    - How: Added the exported pure `KnowledgeStoreFieldPolicy` module for structured secret-free field issues, draft defaults, permissive editor normalization, strict persisted-definition normalization, credential normalization, and immutable credential reads/writes/removal. Reused it from provider registration, `KnowledgeStoreController`, and the settings UI. Extracted the editor-only draft workflow into a tested app model so duplication omits credentials, existing providers cannot change, new-provider changes reset local state, and Save/Test Connection share normalization of unsaved values.
    - Characterization: Covered every provider field type, false/zero/default/whitespace/nullish handling, unsupported selects, editor unknown-field dropping versus runtime rejection, exact outward errors, malformed and prototype-less settings, immutable write/replace/clear/remove behavior, empty credential parents, local-secret exclusion from project metadata and issues, duplicate naming, provider switching, and unsaved test inputs.
    - Affected files/areas: `packages/core/src/integrations/KnowledgeStoreFieldPolicy.ts`, `KnowledgeStoreProvider.ts`, core exports and focused tests; `packages/app/src/components/projectKnowledgeStoreDraft.ts`, its tests, and `ProjectKnowledgeStoresConfiguration.tsx`; `developer-docs/KNOWLEDGE-SOURCE-API.md`; `refactor.md`.
    - Result in numbers: Affected production code moved by net `+242` physical lines. The reusable core policy and app draft model add 447 lines; existing call sites and the core export move `+70/-275`. The main settings component loses 134 net lines and the provider/controller file loses 72 net lines. New policy/workflow tests plus the extended controller regression add 635 physical test lines.
    - Verification: The focused Knowledge Store matrix passed 66/66 tests; focused app draft coverage passed 5/5; the complete core suite passed 966 tests with 8 intentional skips; the complete app suite passed 1,564/1,564; affected core and app lint, production builds, docs/style checks, Prettier, and `git diff --check` passed. The repository-wide file-tree guard still reports four pre-existing long relative imports outside this phase against its 154-entry baseline.
    - Reassessment fixes: Required callers of the public single-field helper to choose an explicit connection/credential and draft/runtime mode; rejected definition and editor-draft normalization against a mismatched provider; made the credential-draft reader name consistently plural; materialized dynamic credential-tree and credential-field keys as own data properties instead of invoking inherited setters; named the readonly credential-field contract and aligned its defaults/options and JavaScript registration checks; made editor issue formatting exhaustive; and simplified declared-field collection without changing normal registered-provider behavior.

137. **Separated graph dependency discovery from reachability traversal**
    - Why: `graphReachability.ts` combined graph traversal, connection indexing, executor-node policy, Call Graph provenance, Delegate Tool Call interpretation, and warning construction. It also duplicated runtime Auto Delegate exact/contains matching, creating a drift risk.
    - How: Added `graphDependencyDiscovery.ts`, which builds ordered per-graph node/connection indexes and owns the existing closed resolver set for Subgraph, Loop Until, Cron, Delegate Tool Call, Run Thread, Call Graph/Graph Reference, and cross-project aliases. Reduced `graphReachability.ts` to reachability roots, definite/dynamic propagation, plugin diagnostics, and report buckets. Added the exported generic core `findAutoDelegateGraphCandidate(...)` helper used by runtime and analysis while preserving their distinct metadata-ID versus project-map-key behavior.
    - Characterization: Added direct shared-matcher coverage and malformed identity fixtures for both callers. Existing reachability coverage continues to protect first-valid connections, disabled providers, dynamic Tool names, exact/fallback order, warning order, dynamic Call Graph behavior, unsupported-plugin partial status, and the intentional Delegate exclusion from reverse references.
    - Affected files/areas: `packages/core/src/model/nodes/toolCallDelegation.ts`, core exports/delegation tests, `packages/app/src/utils/graphDependencyDiscovery.ts`, `graphReachability.ts`, reachability tests, `developer-docs/UNREACHABLE-GRAPH-DETECTION.md`, and `refactor.md`.
    - Result: Node-specific graph dependency policy now has one named owner and one reusable index per graph per analysis pass, while the public reachability API and persisted project behavior remain unchanged.
    - Verification: Focused delegation and reachability suites passed; the complete core suite passed 968 tests with 8 intentional skips, and the complete app suite passed 1,565/1,565. Core/app lint and production builds, docs/style checks, Prettier, generated graph-creator freshness, and `git diff --check` passed.
    - Reassessment: Made edge targets and indexed graph IDs readonly, so dynamic Call Graph edges reuse the one analysis-wide graph-ID list instead of allocating a copy per edge. Kept the index cache module-private rather than exposing mutable cache state. Added direct coverage that an index is cached per graph and preserves both graph connection order and first-valid-input selection.

138. **Centralized data-bus topology and presentation derivation**
    - Why: The rail, ports, and wire layer each reinterpreted bus connections, while `DataBusRail` also owned layout observers, row-height publication, styles, and channel presentation.
    - How: Added a canvas-scoped `createDataBusTopology(...)` index and `buildDataBusGroupPresentation(...)` pure view builder. Rewired NodeCanvas, NodePorts, DataBusRail, and WireLayer to use the shared topology. Extracted rail layout lifecycle to `useDataBusRailLayout.ts` and styles to `dataBusRailStyles.ts`.
    - Preserved behavior: Live node IO definitions remain subscribed in each rail group; preview versus persisted definition-valid versus comparison-removed connections stay distinct; DOM port positions remain measured by `useNodePortPositions(...)`.
    - Verification: Expanded focused data-bus model coverage for normal endpoints, direct bus links, sparse/missing/multiple providers, pathological ports, and wire visibility; ran data-bus layout/model tests and the app type check.
    - Reassessment: Typed rail-layout inputs as the actual bus/topology contract so a same-count bus replacement resets observers; also observe rail child changes and dimensions because live IO can add or remove variadic channels without rerendering the parent. Retained only data-bus endpoint connections in the shared indexes instead of every graph edge. Channel lookup now degrades safely if an inconsistent node/port definition appears rather than relying on a non-null assertion.

139. **Extracted connected tool-call continuation from GraphProcessor**
    - Why: Connected LLM tool continuation had become a coherent scheduler subsystem inside `GraphProcessor`: it planned temporary branches, launched per-call Delegate runs, coordinated cancellation and ordering, and committed branch state alongside the general execution engine.
    - How: Added the pure `ToolCallContinuationBranchPlanner` for effective-topology indexing, safe preload boundaries, unsafe-node rejection, and async subtree inclusion. Added `ToolCallContinuationCoordinator` to allocate model-order scalar calls, overlap early Message branches with tool handlers, perform fail-fast cancellation while awaiting settlement, and return ordered branch results. `GraphProcessor` now supplies only an operation adapter and retains all mutable run state, child processor construction, lifecycle events, cost accumulation, and model-order commits. A small `NodeIO` type module keeps the extracted policy files independent of `GraphProcessor` type imports.
    - Preserved behavior: Delegate process IDs and lifecycle events retain their original order; all scalar calls still start concurrently and join in provider order; early/final branches retain their isolated outputs; replay/frozen restrictions, Run To, async ownership, direct return, Graph Output conflict order, and continuation completion suppression remain processor-owned behavior.
    - Verification: Added pure planner tests for effective connections and preloads, unsafe ready nodes, and async plans, plus a coordinator test that pins post-pause branch-adapter creation. The 37-case connected-continuation characterization suite passed unchanged after extraction, together with the core TypeScript build.
    - Actual line movement: `GraphProcessor.ts` fell from 3,918 to 3,564 lines (-354). The three extracted production modules total 593 lines, for a net +239 lines in the ownership boundary. That intentional increase makes the pure planning and operation-only coordination contracts independently testable instead of leaving their implicit state dependencies inside the processor.

## Residual Watchlist For Future Refactors

1. **GraphProcessor size and responsibility concentration**
   - Current state: Several targeted extractions landed, Phase 8 added a characterization suite, node-exclusion decisions now live in `NodeExclusionPolicy.ts`, graph-boundary effects now live in `GraphBoundaryEffects.ts`, and the runtime-speed recovery removed one redundant hot-path scan while adding errored-input downstream characterization. `GraphProcessor.ts` still owns many execution policies.
   - Next refactor should extract one policy at a time and extend the characterization suite before touching event order, aborts, subgraphs, loops, or races.

2. **MCP stdio config logging and env handling**
   - Current state: Deferred intentionally.
   - Candidate target: `packages/node/src/native/NodeMCPProvider.ts`; avoid logging env secrets and pass configured env correctly to stdio transports.

3. **Global app error logging policy**
   - Current state: Runtime/provider logging was redacted, but generic app `handleError(...)` can still log normalized error objects.
   - Next refactor should decide whether desktop diagnostics or stricter privacy is the desired global policy.

4. **Tracked sidecar clone size**
   - Current state: Sidecar binaries are documented and checksummed, but still increase clone size.
   - Future work would be release-engineering heavy: Git LFS or checksum-verified downloads plus release packaging validation on every supported platform.

5. **Provider implementation size**
   - Current state: OpenAI/Anthropic unsafe parse diagnostics were centralized, provider files remain large, and `developer-docs/LLM-CHAT-V2-CONTRACT.md` now documents the Vercel SDK-powered `LLM Chat` ownership and test matrix. Legacy Chat remains compatibility-only.
   - Future extraction should only target proven shared seams in the LLM Chat V2 path, such as provider-option assembly, structured-output normalization, or tool-call accumulation, after focused tests exist.

6. **Deletion targets versus helper boundaries**
   - Current state: The second refactor met its deletion target; the third did not, because two Chat v2 helper modules made high-risk policy easier to audit.
   - Future plans should measure line deltas but prefer fewer concepts and safer ownership over raw deletion.
