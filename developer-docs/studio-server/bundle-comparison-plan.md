# Bundle comparison: consolidated implementation plan

Status: implemented in the local `F:/Programming/Rivet2.0` checkout and validated
locally on 2026-11-12. This document retains the agreed design and acceptance scope.
Commit, publication and deployment remain separate actions; no database/schema
change, migration, backfill or cloud operation is part of this implementation.

All six implementation steps below are delivered. Local evidence includes 24
new bundle-comparison browser journeys and five existing standalone-comparison
journeys, plus normal Save/tab-activation browser regressions. Core identity,
matching/bridge ownership, API read/cancellation and App recovery/inspection tests
pass. The complete web unit suite passes (252 TypeScript tests and 39 Node tests).
API and shared type checks pass. The focused frontend comparison against HEAD
introduces no diagnostics; the checkout's broad frontend type baseline still has
pre-existing errors. Source inspection is not being substituted for browser evidence.

Session regressions cover pending/failed reads, empty reviews, isolated modal
drafts, metadata admission, native ownership changes and rejected tab closure.
Tracking uses the actual acknowledged project ID, including virtual inspections.
Metadata/Stop completion rechecks current ownership and host results before
cleanup or attachment. Normal tab closure owns replacement selection; Exit does
not activate a remembered tab afterward. A rejected close retains its inspection
identity and reports an error for an explicit later close, without automatic retry.
An interrupted cleanup message cannot enable Run or Save on a leftover inspection.
Recovery filters only known project-ID metadata and virtual contexts, preserving
authored payloads and real contexts. Controller fixtures use independent
structured-clone payloads and bounded gates for asynchronous race coverage.
The holistic UI review covers actual project names in the unmatched list,
collapsed selected-descendant cues during native tab navigation, availability
errors scoped to the confirmed review, and a 63-member narrow matching modal
with reachable actions, mobile labels and two-stage Escape dismissal.

The owning regression files are
[bundle comparison UI](../../packages/studio-server-web/playwright-observe/bundle-comparison.spec.ts),
[ordinary comparison UI](../../packages/studio-server-web/playwright-observe/project-compare-mode.spec.ts),
[editor ownership](../../packages/studio-server-web/tests/editor-bundle-comparison.test.ts),
[matching and wire validation](../../packages/studio-server-web/tests/bundle-comparison.test.ts),
[managed reads](../../packages/studio-server-api/src/tests/managed-bundle-comparison.test.ts),
[recovery filtering](../../packages/app/src/state/storage/comparisonRecovery.test.ts), and
[identity equivalence](../../packages/core/test/utils/projectComparisonIdentity.test.ts).

## 1. Agreed outcome

Rivet Server will let the developer select two bundles, confirm which projects
correspond, and navigate their comparisons through the Server project tree.
Rivet's existing project comparison remains responsible for graph, node, wire,
Library/UI-graph summaries and field-difference presentation.

The roles are explicit:

- **Older:** a captured Saved latest reference. Comparison does not edit or save
  this reference. Unsaved changes in a separately opened Older tab stay there
  and are excluded from the saved reference.
- **Newer:** the real project in its normal editor tab. It is editable and
  saveable, with existing unsaved changes preserved. Differences update while
  editing. Save uses the ordinary project path, revision checks and conflict
  behavior. Saving does not advance the Older reference.

Older/Newer are user-assigned roles, not timestamps. Swapping roles changes
which real project is editable; it never moves edits between projects.

The first release compares two existing explicit managed bundles. It needs no
schema migration, ancestry records, backfill, background comparison job, new
save API or deployment-process change. Historical bundle snapshots and separate
Published-version selectors are outside this initial feature.

## 2. User journey and interface

### Start with a matching modal

1. Add **Compare with another bundle…** to an explicit bundle's context menu.
   Preserve existing bundle actions and drag-to-merge.
2. Open **Compare bundles**, using the usual responsive modal/header/footer
   patterns. Preselect the clicked bundle as Newer. Show Older/Newer bundle
   selectors and **Swap**; require two distinct bundles.
3. Once both are selected, load a lightweight catalog and show a bordered
   **Match projects** section, using Merge bundle's table/select styling.
   Selecting bundles alone must not change the tree or open editor projects.
4. Show columns **Project in <Older bundle>** and **Corresponding project in
   <Newer bundle>**. List every Older member, including unchanged and
   disconnected projects. Use project names and bundle-relative subpaths;
   hide `.rivet-project` in all display labels.
5. Each row selects a Newer project or **No corresponding project**. Prefill
   clear suggestions and retain Suggested in their dropdowns. Show unclaimed
   Newer members in an **Only in Newer** list so every member is accounted for.
6. Enforce one-to-one matching. Ambiguous choices remain unresolved until the
   user chooses a counterpart or No corresponding project. Disable Compare
   bundles for unresolved/invalid choices or loading metadata. Empty bundles
   and explicit unmatched rows are valid. Clear suggestions need no separate
   per-row confirmation: the final button confirms the complete mapping.
7. **Compare bundles** starts the reviewed session. **Cancel** discards only
   the modal draft, leaving the ordinary tree/editor or existing session intact.

Use the same modal later for **Match projects** and changing bundles. Open a
copy of the current choices; apply them explicitly. Changing bundle identities
clears choices for the previous identities. Swapping roles reverses the logical
pairs and updates labels, retaining the user's decisions.

### Navigate the comparison

- The Server project tree shows exactly the two selected bundle roots and their
  member subfolders/projects. Label Older/Newer, omit unrelated ancestors and
  library entries, and initially expand both roots.
- Clicking either member of a pair activates the same **real Newer project**
  and compares it against its Older reference. Highlight both paired rows.
  Collapsed ancestors show the normal library's selected-descendant cue without
  overriding the user's collapsed folders.
  Clicking an Older row does not make that side editable.
- Show all members, with Paired, Only in older, Only in newer or a located
  Unavailable status. These labels describe correspondence, not ancestry or
  proof that a project was historically added/deleted. A failure affects its
  pair, not the whole feature.
- Provide compact **Swap**, **Match projects**, **Refresh older version** and
  **Exit comparison** controls. Existing normal tabs and Newer dirty indicators
  remain available. Reuse the setup modal rather than duplicating bundle pickers.
- Comparison-tree rows are navigation controls. Do not wire projected rows to
  normal rename/delete/move/drop/merge actions. Newer graph/project editing in
  the editor retains its ordinary behavior; the full library returns on exit.
- Activating an already-open Newer member tab selects/attaches its pair.
  Activating a normal tab outside the selected Newer bundle exits comparison
  and honors that navigation, keeping all real tabs and edits intact.
- Both the editor's existing comparison Exit and the Server Exit comparison
  end the same session. Restore the full tree, expansion/scroll/focus and normal
  selection without closing, reverting or saving real projects.

### One-sided projects

| Case          | Editor behavior                                                                                                                                                                |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Newer-only    | Open the real editable Newer project against an empty Older reference. Existing comparison shows its additions. Normal Save works.                                             |
| Older-only    | Show removals against an empty in-memory current side. This inspection has no real Newer save target, so it is read-only and cannot Save or Run. No stored project is created. |
| Empty bundles | Keep the two roots and controls visible with a clear empty state. Do not invent a project or open an arbitrary editor tab.                                                     |

The Older-only case is the sole virtual read-only comparison document. Scope its
identity to the session/pair, reuse existing virtual-preview write protection,
and exclude it from ordinary project recovery. Removed graphs, ghost nodes and
inspectors must remain navigable. Do not impose this restriction on real Newer
projects.

### Removed-graph inspection is required new work

The existing graph list renders removed graphs, but
`components/graphList/FolderItem.tsx` deliberately ignores clicks on those rows.
Do not assume the current comparison API already opens them.

Add a session-owned reference-graph view through the App workspace owner. It
selects a removed graph for the existing ghost rendering using an empty,
read-only canvas placeholder, while the actual Older definition stays in the
reference. Never load that Older graph into Newer's authored graph collection.

This view must have no live-graph commit or execution capability. The current
`activeProjectComparisonState` overlays the displayed graph into its comparison
input, and graph-save/dirty/snapshot owners merge the displayed graph into the
project. Make those owners distinguish a reference view from an authored live
graph, so inspection cannot resurrect a deleted graph or make it appear changed
instead of removed. A read-only border or boolean alone is insufficient.
Save of a real Newer project while inspecting a removed graph must still save
its actual authored contents, excluding the placeholder and reference graph.
Normal graph selection/Exit returns to a valid authored target; reference views
must not leak into ordinary graph-history recovery or another comparison.

## 3. Correspondence and comparison identity

### Facts verified in the owning code

Server bundle duplication creates fresh project UUIDs in
`packages/studio-server-api/src/routes/workflows/managed/bundles.ts` and writes
them into copied `project.metadata.id` through `remap-bundle-project.ts`.
Graph/node IDs survive. Project-ID equality therefore cannot establish ordinary
duplicate correspondence. Preserve this existing uniqueness policy.

Core already compares graph/node identities in
`packages/core/src/utils/projectComparison.ts`. The workspace compare hook in
`packages/app/src/hooks/workspaceHost/useWorkspaceHostCompare.ts` attaches a
reference to the live editable project. Reuse those contracts.

### Matching policy

- The reviewed mapping is authoritative. Store pairs independently of role
  assignment so Swap cannot lose them. Manual choices outrank every suggestion.
- Prefill unique bundle-relative paths, then unique names among unclaimed
  projects. Shared graph IDs from already available definitions can corroborate
  suggestions. They are evidence, not ancestry: multiple projects can share
  graph/node IDs after copying. Never pair projects by a node ID alone.
- Do not scan/download every project merely to discover identities before
  showing the modal. Renamed or ambiguous counterparts can be chosen manually.
  No fuzzy suffix stripping or silent first-candidate choice is needed.
- Once confirmed, every pair is fixed, including accepted suggestions. Late
  reads can offer a correction through Match projects but cannot silently alter
  a pair, overwrite a manual decision, or switch the displayed comparison.
- Represent unresolved choice and explicit No corresponding project as distinct
  states. Account for each member exactly once, including one-sided pairs after
  Swap. Do not turn an unfinished choice, HTTP failure or deleted artifact into
  a successful empty-side comparison.
- Match entire projects here. Inside a project, retain normal graph/node-ID
  matching; equal graph names do not equate different graph IDs. Recreated
  graphs remain additions/removals. No extra graph-matching UI is required.

### Suppress copied owner-ID noise without rewriting projects

Build a comparison-only identity-equivalence map from the accepted project
pairs. If a/a1 references matched b/b1, copied target-project IDs alone must not
mark the Subgraph changed. Unpaired and out-of-bundle targets remain distinct.

The map must be **side-aware**: only Older-side member IDs normalize on the
before side, and only Newer-side member IDs normalize on the after side. Use
distinct logical-pair versus unpaired/external identity representations. An
after-side node still targeting Older b must not normalize as legitimate Newer
b1. Similarly, an Older node targeting the opposite bundle must not be silently
treated as an internal Older binding. A single global ID-alias lookup on both
sides would hide real cross-bundle/stale-reference defects.

Add an optional identity context to Core comparison and field-detail helpers:

- Normalize only recognized owner/reference identity and discovery-path fields,
  including self references, legacy references/aliases, Library source nodes
  and variants. Keep actual titles/renames, graph IDs, targetVersion, boundaries
  and other authored settings meaningful.
- Use identical rules for equality and inspector changed-path calculation.
  Retain raw saved/live values for inspection and display; no synthetic or
  normalized identity becomes an authored change.
- Factor the pure reference traversal into a browser-safe Core/shared helper
  if needed. The existing server remapper changes copied Subgraph versions to
  Saved latest, so it cannot be called to normalize comparisons.
- Derive comparison values without mutating either project, its references,
  dirty baseline, undo state or serialization. Save and Run must always see
  the real authored Newer contents, never rewritten comparison identities.
- Without this optional context, existing standalone comparison stays unchanged.

Keep the existing comparison semantics: comments, node movement/z-order and
Subgraph port ordering are not highlighted as semantic changes. Server routes,
schedules, recording history and external dependency contents are outside this
project-comparison scope. A zero highlighted-change count does not certify
byte-for-byte equality of two complete bundles.

## 4. Versions, editing and session operations

Use the Older revisions captured for the confirmed setup and display that they
are saved references. Hold them fixed until an explicit refresh, role change or
new setup. Newer uses its live editor state, including unsaved work.

| Operation                       | Required behavior                                                                                                                                                                                                        |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Select pair                     | Prepare its pinned Older reference, activate/open the explicitly identified real Newer project, then attach comparison. Reuse an open tab without disk reload; otherwise use normal hosted open and revision binding.    |
| Edit / Save                     | Edit Newer normally. Save writes only that real project with its usual conflict checks. The pinned Older revision and mapping remain unchanged; comparison remains visible after Save.                                   |
| Switch pair                     | Keep real tabs, unsaved contents, undo, viewports and execution lifetimes. Do not replace a dirty tab through a preview-slot shortcut.                                                                                   |
| Swap                            | Preserve the same logical mapping, capture the newly Older side's saved revisions, and activate the newly Newer real project with any existing edits. Commit new role labels only when the editor confirms the new pair. |
| Refresh older version           | Fetch fresh saved Older revisions for the reviewed members. Do not reload Newer, reset its save baseline or save/discard edits. Replace the active reference only after successful preparation.                          |
| Match projects / change bundles | Edit a separate modal draft, leaving the active comparison usable. Apply confirmed choices through a new session generation; Cancel has no active-session effect.                                                        |
| Exit                            | Invalidate pending intents, stop the session-owned comparison, dispose only virtual inspection/cache state, and restore the normal tree. Real opened/edited projects remain.                                             |

Swap is not necessarily a reversal of cached snapshots: the former Newer may
have unsaved changes. Its new Older role uses its **saved** version; retain its
unsaved tab and show the distinction when relevant. Nothing is autosaved or
copied across. Subsequent Save always belongs to whichever real tab is active.

Save As and explicit Run retain normal Newer behavior. If Save As activates a
different project, do not silently retarget the reviewed pair. Exit comparison
for an out-of-scope target; a new in-scope member requires matching review.
Opening comparison itself triggers neither Save nor Run.

Continue normal catalog sync and remote revision/conflict handling. Labels/path
moves for the same validated identities may reconcile, but membership changes
must not automatically re-pair, drop members or manufacture an empty side. Mark
the affected comparison and offer Match projects to review a fresh catalog.
A missing/deleted artifact is Unavailable, not evidence of an intentional
one-sided project. Preserve dirty real tabs and existing reload/keep-local choices.

## 5. Read APIs and loading boundaries

Add a small read service beside the existing managed bundle service:

| Endpoint                                       | Contract                                                                                                                                                                                                                                                                                                                                                              |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/workflows/bundles/compare/manifest` | Accept two distinct bundle IDs. In one short consistent metadata snapshot, return roots/folders, member project IDs/names/paths, Saved latest revision IDs and optional published revision IDs, plus capture time. No project blobs.                                                                                                                                  |
| `POST /api/workflows/bundles/compare/pair`     | Accept explicit Older reference descriptor or null, and Newer project descriptor or null, with at least one side present. Validate both memberships/identities in a short metadata read, return exact Older project contents when present and authoritative current Newer binding metadata when present. No Newer content download, arbitrary path/blob key or write. |

Return the validated current Newer binding with the pair read, including actual
project identity, path and bundle membership. This is a metadata read, not a
second download or replacement of Newer's saved contents. Revalidate that binding
through normal activation/reconciliation before applying the bundle context;
never synthesize `hostedBundleKey` solely from a stale client role selection.
Moves/path reuse must not open a foreign project or attach the old bundle scope.

Expose `bundleCompare` as an additive capability in the existing tree contract.
Hide the UI on older APIs lacking it. Reuse the normal bundle authentication,
intent/origin validation, no-store policy and schema/request bounds. These reads
need no mutation receipt, write transaction, topology lock or maintenance job.

Reuse the established explicit-bundle bounds of 256 projects and 512 folders
per bundle. Release the short SQL snapshot before blob downloads. Use existing
cancellation-aware storage and asynchronous deserialization, with existing
artifact limits and located failures. Never scan the whole library/history,
run merge preview, construct execution closures or eagerly load legacy datasets
merely to compare.

The pair read's Older descriptor is bundle/project/captured revision; its Newer
descriptor is bundle/project. Both descriptors are required fields whose explicit
null means a reviewed absent counterpart, not a failed read. When both are
present their bundle IDs must be distinct. Validate the Older parsed metadata ID
and echo validated descriptors. The same reference-only read can supply an
additional pinned Older definition needed by a visible node without opening a
second project tab. Return located version/membership errors, not raw storage
keys or project contents in logs.

Use one bounded, cancellation-aware SQL statement for both catalogs/revision
pointers where possible, through the existing read-query owner. Do not merely
check an AbortSignal after an unbounded pool acquisition/query. Propagate browser
disconnect and the operation deadline through SQL and the selected blob read.

The revision factory's `readRevisionContents` reads project **and dataset** blobs
and accepts no cancellation signal. Its project-only reader currently also lacks
that signal. Extend `readRevisionProjectContents` with a backwards-compatible
optional signal and use it here, retaining the blob store's descriptor/size/hash
verification and decoding. Do not bypass managed artifact decoding with a raw
object fetch, or accidentally import legacy datasets/evaluation resources while
parsing an Older reference.

The catalog must also capture optional published revision pointers for reference
display lookups. The Older project being compared is still Saved latest, but its
authored Subgraphs can select Published. Resolve reference-side latest targets
from the captured draft pointer and Published targets from the captured published
pointer. Key derived lookups by side, project, authored version and revision;
the raw immutable payload cache can still share the same bundle/project/revision
bytes. Do not share a resolved dependency map keyed only by project ID.
Missing publication/definition data uses saved boundary/fallback presentation;
it must not silently resolve another version or Newer's dependency definitions.

The manifest's Newer revision IDs describe discovery-time saved state. They are
not the save baseline of an already-open Newer tab. Use the existing normal
hosted load/save and identity reconciliation owners for that side; never import
a cached comparison snapshot over it.

Fetch selected references on demand. Keep any immutable-reference cache bounded
and keyed by bundle/project/revision, with eviction; it is an optimization, not
a requirement for comparison correctness. There is no parallel editable-project
cache. A missing/collected reference gives a per-pair error with Refresh; never
silently substitute a newer file, another project at a reused path, or an empty
project. Already loaded reference snapshots remain inspectable.

## 6. State ownership and editor integration

Use one comparison controller with a confirmed session, optional modal draft
and pending intent. Keep normal library data and selection under their existing
owners. A session contains two bundle identities/catalogs, role assignment,
confirmed pairs, pinned Older revision descriptors and selected pair. Pending
intents carry session ID, selection generation, pair ID and editor instance.
Do not persist comparison sessions or cached references into normal recovery.
Real project edits continue to use normal workspace recovery.

Use plain validated JSON descriptors/pair arrays on the wire, constructing Maps
only inside the receiver. Enforce member uniqueness and the existing per-bundle
bounds: two 256-project bundles can produce **512 one-sided pairs**, so a 256-pair
limit would incorrectly reject a valid fully unmatched comparison. Keep opaque
project IDs case-sensitive; labels and normalized paths are never identity.

Extend the public workspace/bridge boundary, not private App atoms:

1. Add a serialized paired-comparison command and explicit success/failure/state
   replies. Pass descriptors and correspondence, not project contents through
   the bridge's 16 MiB admission queue. Reuse origin/window validation,
   EditorBridgeSession deadlines and acknowledgement matching.
   Store a bundle owner token (session/generation) on the App comparison
   reference. Start/stop/refresh and state reports must check that token as well
   as project identity. An old Exit cannot clear a newer reference on the same
   project or a standalone comparison that the user started afterward.
2. Prepare the Older reference before activating Newer. Then call the existing
   normal open/activation owner, with real expected project identity and bundle
   context, and attach comparison to that exact active identity. Do not issue
   two independent dashboard open/compare commands. No new open/save pipeline
   is needed to parallelize this short operation.
3. Check ownership before activation and again at reference attachment. The
   workspace-host compare operation must validate the expected active project
   against current workspace state at commit time; a stale React closure or
   native tab click must not attach the reference to another project. Reuse
   existing activation cancellation/ownership where possible.
4. A newer selection invalidates obsolete queued work and aborts obsolete
   reads. Swap, modal Apply, Refresh, Exit and local tab navigation participate
   in the same ownership rule. Late success/error replies cannot relabel the
   current pair, clear a newer error, change Save's target or re-enter after Exit.
   Distinguish the command's own project-activation notifications from native
   user tab navigation. Expected activation must not recursively queue another
   comparison or invalidate itself. Explicit native navigation still supersedes
   pending work. Closing a real tab must not cause the controller to reopen it
   merely because it was the previously selected pair.
5. Keep the completed displayed pair separate from the pending selection.
   Toolbar labels, row highlighting, editor banner and Save context must agree
   about the actual active project. While opening another pair, normal Ctrl+S
   saves the currently active real tab, never the merely requested target.
6. If an open already completed before its comparison was superseded, retain
   that real tab and any edits. Do not destructively roll it back. An unknown
   acknowledgement is not permission to replay open/save: reconcile through a
   read-only editor-state report; if unavailable, show unconfirmed state and
   allow Exit. Keep reconciliation under the same bridge owner.
7. Route both Exit controls through the comparison owner. Clearing a bundle
   session must not leave the tree filtered or an old reference attached to a
   subsequently opened unrelated project. Standalone comparison Exit remains
   unchanged. Replacing/reloading the iframe ends this transient session;
   ordinary recovery restores real project edits without automatic replay.

Use normal project identities, dirty tracking, graph selection, undo and runtime
for Newer. Scope all pair metadata by project/pair, not graph ID alone, since
multiple projects may share graph IDs. The virtual Older-only document needs
its own scoped identity, mutation/run/save guards and cleanup; changing pairs
must not reuse another pair's temporary inspection state.

Reference node rendering currently passes an empty `referencedProjects` map in
`comparisonNodeSnapshot.ts` and `ComparisonNode.tsx`. Add an optional read-only
reference-definition context there when pinned in-bundle lookups are available;
do not put Older definitions into Newer's live dependency store. Preserve raw
reference nodes and captured boundary fallbacks for missing plugins/projects.

Reuse ordinary Go to subgraph and PgUp/PgDn ownership. An in-scope jump selects
the relevant pair and graph on the real Newer project; outside-scope navigation
exits comparison and follows normal history. Reference-side inspection must not
silently open a live editable Older project. Resolve reference-side display
lookups from pinned Older definitions when needed; Newer uses its normal live
resolution. Missing plugins, broken references or invalid executable bundles
must remain inspectable without passing execution preflight.

## 7. Implementation sequence and owning files

Each step delivers its tests before the next dependent step. Implement in
`F:/Programming/Rivet2.0`, preserving unrelated uncommitted work.

1. **Session contracts and pure matching.** Add
   `packages/studio-server-shared/workflow-bundle-comparison-types.ts` and a
   small browser-safe matching/session model. Cover complete accounting,
   one-to-one choices, draft/confirmed separation, role reversal and generation
   invalidation. Share small merge matching primitives only if this reduces
   duplication without changing merge defaults.
2. **Pinned reference reads.** Add
   `packages/studio-server-api/src/routes/workflows/bundle-comparison.ts`;
   connect it through managed bundle/storage owners and `bundles-router.ts`.
   Extend `workflow-types.ts`/tree capabilities with `bundleCompare`. Test exact
   identities on both sides, revision/version pinning, project-only artifact
   reads, bounded SQL/cancellation, limits and errors. The pair API also supplies
   the authoritative current Newer binding, leaving its actual loading/saving
   under the existing hosted project owner.
3. **Comparison-only identity equivalence.** Extend
   `packages/core/src/utils/projectComparison.ts`, its graph/node/detail helpers,
   and pure reference traversal. Thread context through App comparison state
   and field inspectors. Prove default comparison compatibility, version/target
   differences and unchanged authored objects/serialization/dirty state.
4. **Editor vertical slice.** Extend the shared editor bridge, workspace-host
   compare/stop boundary and `editorProjectOpenCommands.ts` /
   `editorDetachedProjectCommands.ts` owners. Demonstrate one pinned Older
   reference against a real editable/saveable Newer tab, then one-sided cases.
   Implement reference-only graph views in `domain/workspace/projectWorkspaceTarget.ts`
   and the save/dirty/snapshot/comparison owners before enabling removed-graph
   clicks. Update `comparisonNodeSnapshot.ts` / `ComparisonNode.tsx` for optional
   pinned reference context. Test owner-token/expected-current-project checks,
   activation feedback, saves, superseded work, state acknowledgements and Exit
   before building the full tree UI.
5. **Server modal and tree.** Add `WorkflowBundleCompareModal.tsx`,
   `WorkflowBundleComparisonTree.tsx` and `useWorkflowBundleComparison.ts`;
   compose through folder context menus, library controller/modals/panel,
   DashboardPage and bridge events. Use existing modal/table/select/row patterns,
   both-root highlighting, normal dirty indicators and isolated modal drafts.
   Keep normal tree sync and mutation handlers separate from the projection.
6. **Integrated local acceptance and docs.** Add
   `playwright-observe/bundle-comparison.spec.ts`, extend relevant existing
   comparison/workspace/revision tests, and update the owning documentation.
   Only then mark this plan implemented. Commit/push/deployment are separate
   actions; planning does not authorize starting them.

## 8. Local acceptance and completion criteria

- **Complete journey:** duplicate a multi-project bundle, change one node,
  retain an unchanged/disconnected member, remove one member and add another.
  Review every project in the initial modal; verify two roots only and correct
  actual Rivet graph/node/wire/field rendering in both directions.
- **Matching:** duplicate names, nested paths, renames, repeated/shared graph
  IDs, ambiguous candidates, explicit unmatched rows, empty bundles and
  one-to-one conflicts. Confirmed and manual pairs survive delayed replies and
  Swap. Cancel initial/reopened drafts changes no active session or editor tab.
- **Identity equivalence:** copied internal references, self calls, aliases,
  Library sources, disabled nodes and variants do not generate owner-ID noise.
  Real target, graph and Published/Saved latest changes remain visible. Merely
  comparing never mutates project objects or saved/serialized references. Include
  a Newer node wrongly targeting the Older bundle, the reverse case, and an
  external target whose text resembles a logical-pair token; none may be hidden
  by identity normalization.
- **Live editing and saving:** start with Newer already dirty; edit, undo/redo,
  Ctrl+S and explicit Save As using the real editor. Inspect actual payloads and
  destinations. Only the intended real project is saved, comparison stays live,
  and the Older artifact/reference stays unchanged.
- **Swap / Refresh:** test unsaved work on both sides. Each Save retains its
  original real owner; newly Older uses saved contents with clear indication.
  Refresh never reloads Newer or replaces its revision/conflict baseline.
- **Navigation / Exit / recovery:** switch several edited pairs, activate tabs,
  navigate Subgraphs and PgUp/PgDn, exit from each UI location and reload the
  iframe/page. Preserve real tabs, edits, viewports, history and runtime. Restore
  the normal tree; do not recover virtual inspections as editable server files.
- **Races / failure:** delay/fail reads, native tab switches and acknowledgements;
  switch/swap/apply/refresh/exit during them. No wrong-tab reference, stale label,
  warning erased by an older reply, automatic command replay or post-exit reopen.
  Pending Ctrl+S saves the actually active tab. One failed pair leaves others usable.
  Programmatic activation must not recursively restart comparison; closing the
  active tab must not reopen it. Delayed Exit/Refresh must not clear a newer
  bundle reference or a replacement standalone comparison on the same project.
- **Storage changes:** missing/collected revisions, reused paths, moved/deleted
  members, remote saves and membership changes. Report availability accurately,
  retain dirty tabs and use normal conflict handling without silent fallbacks.
  Revalidate live Newer's bundle membership and binding; no stale manifest may
  force a foreign bundle key or path onto an already-open dirty project.
- **One-sided / degraded:** Newer-only edits save normally; Older-only ghost
  graph/node inspection cannot Save, Run or create a project. Missing plugins
  or dependencies remain inspectable. Test narrow/short layouts and keyboard focus.
- **Removed graphs:** actually click a removed graph in paired and Older-only
  projects, inspect nodes/wires, navigate away and back, and Save a real Newer
  project. The graph remains removed, Newer never gains the reference graph or
  placeholder, and mere inspection does not change its dirty flag, undo stack,
  plugin list, serialized contents or recovery snapshots.
- **Pinned dependencies / cancellation:** an Older Subgraph selecting Published
  uses the captured publication even if the target's draft differs; reference
  ports/bodies never borrow Newer's definitions. Instrument reads to prove no
  dataset blob is fetched, corrupted/compressed artifacts retain normal checks,
  and closing a modal or superseding a selection cancels SQL/blob work without
  abandoned pool waiters or stale UI callbacks.
- **Compatibility / cost of opening:** older API without bundleCompare hides the
  action. Ordinary project comparison, merge/download and normal preview tabs
  retain behavior. Request counts show lightweight catalog plus selected-pair
  work, not eager whole-bundle/library/dataset or execution-closure downloads.

Run targeted Core/API/App/web tests through their existing package test owners,
affected type/lint checks, shared-export/bridge validation and test registration,
then the repo's required headless browser runner against a local app:

```powershell
$env:PLAYWRIGHT_HEADLESS = '1'
$env:PLAYWRIGHT_SLOW_MO = '0'
$env:PLAYWRIGHT_BASE_URL = 'http://127.0.0.1:4318'
yarn studio-server:ui:observe bundle-comparison.spec.ts project-compare-mode.spec.ts
node scripts/checks/check-test-style.mjs
node scripts/checks/check-doc-links.mjs
git diff --check
```

Inspect failed UI artifacts under `artifacts/playwright/`. Include affected
hosted save/conflict, preview-tab, navigation and workspace browser regressions;
register new unit files in explicit package/CI lists where required. Measure a
new browser suite's shard weight rather than guessing it. No Kubernetes rehearsal
or cloud activation is needed to implement and validate this feature locally.

Update [Project bundles](project-bundles.md), [Editor bridge](editor-bridge.md),
[Server architecture](architecture.md), [Workflow publication](workflow-publication.md)
and [App architecture](../APP-ARCHITECTURE.md) with the final implemented contract.
The user journey is documented in
[Working with Projects](../../packages/docs/docs/user-guide/working-with-projects.md#comparing-studio-server-bundles)
and linked from the interface overview.
Completion requires the initial matching flow, correct tree navigation, live
Newer editing/saving, all role/lifecycle operations and the above local evidence;
a partial UI or isolated comparison demo does not complete this plan.
