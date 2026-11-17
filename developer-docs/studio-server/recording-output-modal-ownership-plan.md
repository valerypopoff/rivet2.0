# Tab-owned node full-output modal

Status: complete and validated locally on 2026-11-17. Deployment is a separate release step.

## Original problem and verified assumptions

Opening another recording could leave the previous recording's node full-output modal visible with an empty body. Before this fix, the owning state, `fullscreenOutputNodeState` in `packages/app/src/state/graphBuilder.ts`, stored one global node ID. `FullscreenNodeOutputModalRenderer` in `packages/app/src/components/nodeOutput/NodeFullscreenOutput.tsx` is mounted once in `RivetApp.tsx`; it reset that selection only when the graph ID changed, the node disappeared, or the renderer unmounted.

Recordings legitimately have different replay project IDs and virtual paths while retaining original graph and node IDs. Filesystem artifact creation in `packages/studio-server-api/src/routes/workflows/recordings.ts` changes the project ID, not its graph/node IDs. Hosted opening in `packages/studio-server-web/dashboard/editorDetachedProjectCommands.ts` opens that replay project and activates its recording for that tab.

Output data already had the correct authority: `lastRunDataState` in `packages/app/src/state/dataFlow.ts` reads the active project's execution snapshot through `packages/app/src/state/projectExecutionStore.ts`. When B became active, its empty output made the contents component return null, but the global selection kept the modal shell open. The existing Run Activity ownership tests protected a deferred open before it happened; they did not cover an already-open modal crossing tabs.

The defect is presentation ownership, not a requirement to change recording storage, playback, execution or API requests.

## Behavior contract

| Action                                                              | Required result                                                                                                                                               |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A has full output open; activate B without its own open modal       | A's modal disappears immediately. B shows its ordinary editor.                                                                                                |
| Return to A with its original graph selected                        | A's modal opens again for A's selected node, reading A's retained execution data. No replay or artifact fetch is introduced by restoring the modal.           |
| Open full output in both A and B                                    | Each tab retains its own selected node. Switching tabs displays only the active tab's modal and output.                                                       |
| Close the visible modal                                             | Clear only that exact tab's current selection. Other tabs retain theirs.                                                                                      |
| Close an active or inactive project tab                             | Remove that tab's modal state as part of its confirmed close; a rejected/cancelled close preserves it. Reopening the project starts without a retained modal. |
| Switch graphs within one project                                    | Preserve existing behavior: close that project's modal. Returning to the previous graph does not reopen it merely because an old entry survived.              |
| Restore a tab onto a different graph                                | Discard that tab's incompatible selection. Do not discard another tab's selection because its graph ID differs.                                               |
| Remove the selected node or graph                                   | Do not render a stale shell. Invalidate that selection; preserve existing graph-edit Undo/Redo restoration semantics.                                         |
| Explicitly replace/reload project contents, even with identical IDs | Retire only that project's selection at the successful replacement boundary.                                                                                  |
| A late effect/close callback from a previous modal runs             | It cannot clear a different tab's selection or a newer selection in the original tab.                                                                         |

The retained state is modal open/closed state plus graph/node identity. Existing per-project execution/process-page selections remain authoritative, and existing shared resize bounds remain shared. On a new modal mount, ephemeral search/DOM scroll state follows ordinary close/reopen behavior; it must never leak between projects. Persisting search/scroll across tab switches is outside this correction.

## Implementation sequence

### 1. Give selection one tab-scoped authority

- Add a small, in-memory state module such as `packages/app/src/state/fullscreenOutput.ts` with one map keyed by the editor's runtime `ProjectId`. Store an immutable `{ graphId, nodeId }` selection for each owning tab; absence means closed.
- Use the same runtime project identity already used by execution snapshots and open tabs. Do not use a graph ID, node ID, project title, source workflow ID, or recording's display name as the tab key.
- Keep `fullscreenOutputNodeState` available from `graphBuilder.ts` as an active-project read/write facade with its existing `NodeId | null` contract. Existing consumers should not maintain a second global copy.
- The facade reads only the active project's selection for the current graph. Its synchronous writes affect only the active project; opening also captures the current graph. Reads must not mutate state.
- Provide explicit project-scoped clearing/removal and compare-and-clear for a captured selection. A renderer callback must carry its original owner and selection, rather than resolving whichever project happens to be active when it runs. Comparing the immutable captured entry avoids a new generation/token framework.
- Keep this separate from recorded execution snapshots and persistent project files. Inspect import boundaries and import the graph's primitive atoms where needed rather than the `state/graph.ts` facade, which imports graph-builder state itself.
- Preserve tab preview flags; do not broaden or repurpose their normalization helpers to carry unrelated output state.

### 2. Render only the active owner's modal

- Update `FullscreenNodeOutputModalRenderer` to resolve the active project's owned selection and matching current graph/node before rendering.
- Replace the global previous-graph reset effect and unconditional unmount clear. Unmounting/hiding A must preserve A's valid selection and must never clear B.
- Keep invalid-node cleanup narrowly tied to the captured project/selection. A stale effect must not clear a replacement selection created later.
- Recheck the current active tab and graph inside invalid-node cleanup, rather than trusting the effect's captured render. Undo may have restored the node, or tab activation may already have overtaken the effect.
- Key the modal contents by project, graph and node identity, so matching IDs in another project cannot reuse the previous project's React-local search, inspector or focus state. Include the existing project-binding lifetime when available to distinguish a replacement/close-reopen from the previous document with the same IDs; do not introduce another token registry. Normal output updates must not remount the modal.
- Keep only the active modal mounted. Do not leave hidden modals subscribed to active output atoms or listening for keyboard events.
- Continue reading output and selected process pages through existing active-project execution atoms. Do not freeze/copy output data or trigger playback to populate a modal.

### 3. Integrate with actual workspace lifetime boundaries

- In `packages/app/src/hooks/useWorkspaceTransitions.ts`, distinguish activating another tab from switching graphs inside the same tab. Clear only the affected project's selection on a real graph change; preserve entries for other tabs. A same-graph activation should not clear a valid selection.
- When loading a tab with an explicit/fallback graph different from its retained selection, discard that incompatible entry. Do not infer a graph switch from one global previous-graph ref across projects.
- Clear a reloaded project's selection on the committed `markClean` content-replacement path, including identical graph/node IDs. Preserve it if loading is cancelled or fails before committing.
- In `packages/app/src/hooks/workspaceHost/useWorkspaceHostReplaceProjectSnapshot.ts`, apply the same rule to a successful replacement of an inactive project; it must not activate that tab or clear the active tab's modal.
- In `packages/app/src/hooks/workspaceHost/useWorkspaceHostProjectCleanup.ts`, remove the closed/replaced tab's entry alongside the existing per-project UI cleanup. Confirm the active, inactive, last-tab and preview-replacement close paths all reach that owner. Avoid a second independent cleanup controller.
- A project rename/path update that retains the same document/tab must keep its modal. A genuine replacement or close/reopen must not inherit an old selection merely because IDs match.

### 4. Preserve all existing opening paths

- Reassess `NodeOutput.tsx`, `NodeCanvas.tsx`, `components/runActivity/runActivityOutputNavigation.ts`, and `features/graphBuilder/editorGateway.ts` against the active-project facade.
- Inline expansion and Run Activity should open the active project's selected node only. Retain Run Activity's existing project-binding, graph-view, invocation and output-availability checks before a deferred open.
- Graph-builder history still captures/restores the active project's node selection; it must not snapshot, overwrite or clear other tabs' entries. Preserve existing node-deletion/Undo behavior.
- Retain current resize controls, output rendering, paging, search shortcuts, Escape behavior and output navigation. Fix ownership at the shared editor layer so hosted recordings and ordinary desktop/hosted projects use the same correction.

### 5. Add a small regression set

Use real behavior assertions, distinct output markers, deterministic state transitions and the existing test runners. Avoid sleeps and tests that merely mirror map implementation.

**State/lifecycle tests:**

- A and B have identical graph/node IDs and different execution output. Switching selects only the correct owner's modal; changing graph IDs also works.
- Both tabs have different full-output selections; closing one does not modify the other.
- Captured close/invalid-node cleanup after A-to-B-to-A cannot clear B or a newer A selection.
- Confirmed active/inactive close, close/reopen with reused IDs, same-ID snapshot replacement, and incompatible restored graph retire the correct entry. Cancelled close/load leaves it intact.
- Removing a selected node and graph-builder Undo/Redo preserve their existing intended selection semantics.

Use the narrow app state test runner and extend existing workspace/Run Activity/gateway coverage where it exercises a changed boundary; avoid duplicating full fixtures for every map operation.

**Browser regression:** extend the CI-selected `packages/studio-server-web/playwright-observe/recording-playback-history.spec.ts` with a focused case using real Core-generated recordings and mocked recording API responses. Give A and B the same graph/node IDs, different replay project IDs and distinguishable recorded output.

1. Open A through Run recordings, play it and expand its node output.
2. Open B through the dashboard without closing A's modal. Assert B is active and no full-output modal is visible before B's own expansion.
3. Return to A through a supported visible navigation path. Assert A's modal and A's output return without another Play action.
4. Play B and open B's output; switch back and forth to verify distinct contents. Closing B's modal must leave A's retained modal intact.
5. Exercise a graph switch and project close/reopen; verify they do not resurrect an obsolete modal.

Use direct state/DOM coverage for lifecycle races that cannot be reached through visible controls while a modal is open. Do not force-click through a backdrop as a substitute for a real user path. Keep existing fullscreen search/resize/paging and hosted focus checks as adjacent browser coverage, rather than cloning them into the new scenario. Assert no uncaught browser errors.

### 6. Validate and document before release work

- Run focused state, workspace, Run Activity and graph-builder history tests affected by the final diff.
- Run app TypeScript checks and lint for changed code, plus formatting and documentation-link checks. Use `node .yarn/releases/yarn-4.17.1.cjs` if the host Yarn shim needs network access.
- Build the hosted web application before starting a fresh preview. Also verify desktop app compilation because the correction is shared editor code.
- Run the repository browser runner with `PLAYWRIGHT_HEADLESS=1`, `PLAYWRIGHT_SLOW_MO=0`, and `PLAYWRIGHT_BASE_URL` pointing to that fresh local app: `yarn studio-server:ui:observe recording-playback-history.spec.ts fullscreen-output-search-paging.spec.ts hosted-modal-focus.spec.ts`. Inspect `artifacts/playwright/` on a failed UI step; distinguish fixture/setup failures from a failed product assertion.
- Read `developer-docs/studio-server/ci-pre-push.local.md` during any later commit preparation and apply only relevant checks. Run root `test:style` before builds that consume compiled Core assets if that full check is needed; it can rebuild those assets.
- Update `developer-docs/studio-server/editor-bridge.md` with the tab ownership contract and mark this plan complete only after local validation passes. Record exactly what passed and any remaining limits.

## Completion criteria and scope

The original A-to-B reproduction must fail against the pre-fix code and pass after the correction. A's modal must remain associated with A and return on reactivation, while B can independently open/close its own modal. Identical IDs, distinct IDs, late callbacks, graph changes and project lifetime changes must not cross or resurrect owners.

This correction adds a small UI selection lookup and lifecycle cleanup. It adds no recording API calls, graph re-execution, output serialization/copies, execution waits, recording storage changes, database migration or server-side rollout tooling. The separate CPU/RAM monitoring feature has its own implementation and release contract in [resource-monitoring.md](resource-monitoring.md).

## Implementation and final local validation

- `state/fullscreenOutput.ts` is the sole tab-owned selection store; `graphBuilder.ts` re-exports the compatible active-tab facade. Only the active modal mounts, keyed by project binding, graph and node. Output bytes and execution state stay in their existing owners.
- Workspace activation and graph switching reconcile only the target project. Successful active/inactive snapshot replacement and confirmed project cleanup retire their own selection; failed or cancelled transitions preserve it. Inline expansion, Run Activity and graph-builder history use the same facade.
- Captured cleanup and dismissal recheck current ownership. A late effect cannot clear a newer same-ID selection or discard a node restored by Undo. A genuinely removed node still invalidates its selection.
- Deferred Run Activity opens capture the existing editor-session revision and observe selection changes only while pending. Leaving and returning to the same tab cannot revive an old intent, and a newer inline open or dismissal wins. The existing cancellation owner releases every observer before publishing a selection; obsolete-modal cleanup cannot cancel a valid new open.
- The new browser regression failed on the original built UI: opening B left one modal visible when zero was expected. It passes after the fix with distinct recorded output, independent dismissal, search-state isolation, restoration without playback, and inactive-tab close/reopen.
- The final **99 focused tests** cover state ownership, real workspace lifecycle, graph-builder history and Run Activity navigation. State tests use real Text nodes without constructing the full registry. Guard-removal checks confirmed that the newer-selection and functional-updater regressions fail when their protections are removed; the source was restored afterward.
- All **27 headless browser checks** in `recording-playback-history.spec.ts`, `fullscreen-output-search-paging.spec.ts` and `hosted-modal-focus.spec.ts` passed against the matching production build. Shared search, paging, resizing and cross-frame focus coverage remains in its existing suites.
- Hosted and desktop builds, App type-checking, relevant lint, formatting, test-style, editor boundaries, CI test discovery and documentation links passed. App lint retains one existing warning in `useDraggingWire.ts`.

Local evidence is retained under `artifacts/recording-adjacent-review/` and `artifacts/recording-test-review/`. Those generated artifacts are not part of the source commit. Cloud validation and deployment remain separate release operations.
