# Bundle action ownership in the project tree

Implemented on `develop` from baseline `3d7cd0abd` in `F:/Programming/Rivet2.0`.
The extraction and the confirmed adjacent deletion fixes are complete locally.
This record describes the final boundary, preserved behavior and verification.
Cloud qualification and deployment are outside this refactor.

## Goal and ownership

Separate bundle actions from the project-tree controller without changing
requests, modal lifetimes or editor behavior. The controller decreased from
977 to 835 lines. The new 239-line hook makes ownership explicit rather than
claiming an overall production line-count reduction.

| Owner                                         | Responsibility                                                                                                                                  |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `dashboard/useWorkflowBundleActions.ts`       | Bundle action state, conversion/duplication requests, merge/delete/upload/download initiation, completion callbacks and merge focus restoration |
| `dashboard/useWorkflowLibraryController.ts`   | Compose the hook, supply tree/selection dependencies, retain capability and generic deletion guards, forward the existing public interface      |
| Existing bundle modals                        | Merge preview/commit, upload, recursive deletion, export jobs, polling and their operation lifetimes                                            |
| Existing tree, comparison and drag/drop hooks | Tree synchronization, editor reconciliation, comparison sessions and drag interpretation                                                        |
| `dashboard/useEditorCommandBridge.ts`         | Order editor commands and read current workspace state                                                                                          |
| `dashboard/editorProjectLifecycleCommands.ts` | Apply confirmed project deletion and local cleanup by project ID                                                                                |

Paths in the table are relative to `packages/studio-server-web/`.
Read [Project bundles](project-bundles.md) and [Editor bridge](editor-bridge.md)
for the complete feature contracts.

## Hook contract

The hook accepts the active path, folder context menu, stable menu closer,
merge capability, flattened folders, mutation/upload guards, existing tree
reconciliation callback, expansion setter and project-deletion callback.
It returns the controller's existing bundle state/actions, plus the internal
`openBundleMerge` and `openBundleDelete` entry points. It does not import its
controller or create another tree owner.

The controller initializes tree and selection first, then ordinary mutations,
then the bundle hook and drag/drop composition. Panel, context-menu and modal
consumers retain their existing public members and component keys.

Keep these invariants when extending the hook.

- Conversion and duplication share one synchronous pending ref and rendered
  activity state. Keep the original checks before opening or submitting.
- `useWorkflowLibraryActionLifetime(activePath)` controls presentation only.
  Accepted and uncertain mutations still reconcile the tree after navigation;
  obsolete errors, success notifications and automatic expansion stay hidden.
- Conversion preserves its confirmation, `/kind` payload and error categories.
  Duplication submits once with `automatic: true`, keeping the source identity,
  namespace preconditions, warning count and bounded Unicode warning excerpt.
- Reuse the existing API helper and receipt recovery. A lost response does not
  authorize replaying a mutation.
- After duplication or import, locate the committed folder by namespace ID
  when supplied, otherwise by bundle ID. Flatten the returned tree once and
  expand its current ancestors, including a concurrent move.
- Download target and visibility stay independent. Closing hides the retained
  job and clears pending automatic file delivery; reopening the same bundle
  preserves its background-job identity. The download interaction follow-up
  below records the later change to a persistent form.
- Upload keeps the ancestor-bundle and mutation guards. Its modal owns obsolete
  completion handling; successful imports use existing tree reconciliation.
- Deletion completion always forwards the returned project IDs. Its modal
  lifetime controls only closing and presentation, not committed cleanup.
- Merge initiation keeps drag/drop target preselection, same-bundle rejection
  and capability checks. Closing restores focus only to a connected opener.

Workflow execution, API storage, publication and rollout code are unchanged.
The hook adds no network calls, effects or execution work.

## Confirmed adjacent deletion fixes

Two controlled browser reproductions established defects in the old editor
consumer, independently of the extraction.

1. A delayed deletion selected a tab by path and cleared both that ID and the
   supplied deleted ID. When another project reused the path, this could close
   the replacement and discard its unsaved state. The consumer now uses the
   supplied ID for tab, revision, context, dataset and session cleanup. Older
   commands without an ID retain normalized-path lookup. Dashboard selection
   follows the editor's actual active-tab transition for identified deletions.
2. Deletion bypassed the editor queue, so an earlier project load could finish
   afterward and reopen the deleted member. Deletion now uses the existing FIFO
   queue alongside opens, refreshes, path moves and reconciliation. Queueing
   alone still exposed pre-render React refs; project, tab and loaded-path
   getters now read the Jotai store directly. Three mirrored refs and two props
   were removed. No extra queue, retry or render delay was introduced.

The host still owns fallback-tab activation and close failure behavior. Cleanup
of a confirmed deletion also applies when the original tab is already closed.
The identity fix preserves a different project that now uses the old path.

## Regression coverage

`playwright-observe/explicit-bundles.spec.ts` exercises the delivered dashboard
and iframe editor. It keeps both reproduced deletion races, current-ancestor
expansion, navigation during pending actions, single submissions, receipt
recovery, capability fallback, conversion, duplication and retained unsaved
edits. Existing merge/export/upload suites cover their unchanged modal owners.

The race tests await a bounded, origin- and request-ID-matched reconciliation
acknowledgement and assert the returned project IDs. Held responses release in
`finally`. Pending menu guards share the navigation cases; common deletion
layout, clipboard, exact-name and cancel/reopen checks run once in the success
case. Failure variants keep their distinct behavior assertions.

`tests/editor-project-refresh.test.ts` covers a moved target, an already-closed
target and a legacy path-only command with Windows separators. Fixtures clean
up revision/session state. `tests/hosted-project-revision-tracker.test.ts` keeps
rollback authority and error-type assertions in the existing conflict-settlement
case instead of a duplicate test.

All changed tests remain registered in the existing pure-web command or editor
CI inventory. No standalone runner or test-only production API was added.

## Local verification

| Check                                                                                           | Result                                                                      |
| ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Full final explicit-bundle browser suite                                                        | 24 passed                                                                   |
| Adjacent comparison tab-close and remote move/rename browser cases                              | 6 passed before test-only cleanup                                           |
| Full pure-web command                                                                           | 300 passed across its two runner groups                                     |
| Final legacy-path fixture                                                                       | Focused rerun passed                                                        |
| Production web build                                                                            | Passed on final production code                                             |
| Expanded TypeScript baseline comparison                                                         | 0 new diagnostics; 209 existing diagnostics across 4,115 candidate files    |
| File-tree/import, test-style, editor boundaries, formatting, documentation links and whitespace | Passed                                                                      |
| Commit preparation                                                                              | Root `yarn test:style` and Studio Server repository structure checks passed |

The original two pending-navigation cases passed before extraction. Earlier
bundle/merge/export/upload validation passed 57 browser cases before the later
focused deletion fixes and test consolidation. Those historical checks are not
presented as a rerun of every suite on the final source.

Reuse passing checks against unchanged code. For affected changes, use the
pinned Yarn release and supported Node runtime with these maintained commands.

```powershell
yarn workspace @valerypopoff/rivet-studio-server-web run build
yarn studio-server:verify:web-pure
yarn check:file-tree
yarn studio-server:verify:test-style
yarn studio-server:verify:repo-structure
node scripts/checks/check-doc-links.mjs
git diff --check
```

For browser checks, serve the completed frontend at an owned local URL and set
`PLAYWRIGHT_HEADLESS=1`, `PLAYWRIGHT_SLOW_MO=0` and `PLAYWRIGHT_BASE_URL`. Set
`PLAYWRIGHT_EXECUTABLE_PATH` when reusing installed Chromium. Run
`yarn studio-server:ui:observe '[\\/]explicit-bundles\.spec\.ts$' --workers=1`.
Use the same anchored basename form for affected merge/export/upload specs.

The observation runner requires a running frontend. Restart a local static
server after rebuilding so its manifest matches the new assets. Keep source
edits outside running browser checks. Logs, screenshots, traces and temporary
compiler configurations remain in the ignored
`artifacts/bundle-actions-refactor-20261115/` directory.

## Limits

The scoped compiler comparison does not claim the repository is free of
pre-existing TypeScript errors. The optional desktop source-module fixture
was selected accidentally by an earlier unanchored filter; it could not run on
the static server, and a Vite attempt failed during React initialization. That
separate harness issue remains unresolved and is outside these results.

This change preserves execution code and request counts. No production latency
benchmark, cloud test, image qualification or deployment was performed here.

## Completed download interaction follow-up — 2026-11-26

The requested download UI changes are implemented and locally verified. They
extend the modal's existing job ownership; the project-tree hook, archive format,
source selection, authentication and backend storage owners are unchanged.
The [portable bundle contract](project-bundles.md#portable-project-bundles)
describes the current behavior.

- [x] Keep a single form before, during and after download: quoted bundle name,
      compact Saved latest / Published if available choices and one Download
      bundle button. Remove the enclosing card and preparation-management UI.
- [x] Capture fresh saved content on every explicit Download click. Dispose the
      previous job only after HTTP 204/404 confirmation, reserve a new identity,
      then download the completed archive through the native browser link.
- [x] Preserve single admission across cleanup and start, lost-acknowledgement
      recovery, stale-response rejection, the 20-second request timeout and
      existing polling cadence. Closing or switching bundles clears automatic
      file delivery without forgetting accepted background work.
- [x] Centralize adoption of a replacement job so its identity, status and error
      change together. A controlled pre-fix browser case reproduced an old
      archive's missing-status error leaking into the new job; both retained
      and replacement modal instances now clear it before admission completes.
- [x] Update the operating guide and retain the existing CI registration in
      `scripts/ci/editor-test-shards.mjs`.

Validation: all 12 cases in `playwright-observe/project-bundle.spec.ts` passed
headlessly against the completed web build. The journey creates and executes
real archives for original, edited, published and repaired snapshots. Controlled
cases cover invalid responses, failed cleanup, duplicate clicks, delayed replies,
reopening and bundle switching. Desktop and narrow screenshots were inspected.
Scoped TypeScript, typed lint, test-style, formatting and documentation-link
checks passed. Evidence stays in the ignored
`artifacts/bundle-download-ui-20261126/` directory. These are local results;
hosted CI and production rollout remain separate delivery steps.
