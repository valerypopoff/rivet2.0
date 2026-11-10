# Bundle merge implementation plan

Status: implemented and validated locally, 2026-11-10. The managed bundle merge UI
and API are available in source. Hosted publication and deployment remain separate;
this work does not start a cloud test or change production.

## Goal and first release scope

Support the normal authoring loop: duplicate bundle A, edit and test its copy A1,
then copy selected saved project changes back into A. Existing destination project
identities survive. Imported references point to the corresponding projects in A,
and the source bundle remains available unchanged.

The first release targets explicit Studio Server bundles in the project tree.
These currently require PostgreSQL/S3 and advertise the explicit-bundle and
namespace-mutation capabilities. The additive bundleMerge capability gates the
new action, keeping it hidden against an older API that only supports bundles.
Extracted Desktop bundles and legacy
filesystem/SQLite folders do not expose this action. This follows the existing
bundle capability boundary; it does not remove their current functionality.

Merge means whole-project saved-draft replacement or addition. It does not mean a
three-way merge of graph edits, automatic publication, or moving projects out of
the source. No ancestry schema, archive-format revision, separate job service,
background indexer, or Kubernetes component is needed for this first release.

## Confirmed implementation facts

| Existing behavior                                                                                                              | Owner and implication                                                                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Explicit bundles are folder identities with derived descendant membership; there is no entry project.                          | managed/bundles.ts and workflow-bundle-types.ts. Select members from metadata, not dependency reachability.                                                                          |
| Duplication creates fresh project IDs but preserves graph, node and port identities.                                           | managed/bundles.ts, remap-bundle-project.ts and its regression. The ordinary duplicate/edit/merge case needs project correspondence, usually no graph correspondence.                |
| Internal Subgraph bindings, legacy references/aliases, Library source nodes and saved variants already have a shared remapper. | remap-bundle-project.ts. Extend this traversal instead of introducing string replacement or a competing reference scanner.                                                           |
| Saved wire compatibility uses graph-boundary identities and data types, not just names.                                        | Core ProjectBundle.ts and nodes/SubGraphNode.ts. A same-name graph is not sufficient evidence of compatibility.                                                                      |
| Revision preparation writes immutable project/dataset artifacts and reference summaries.                                       | managed/revision-factory.ts and prepared-revisions.ts. Merged drafts are indexed in their insertion transaction; no merge backfill is needed.                                        |
| Structural operations have topology locking, identity preconditions, durable receipts and observational recovery.              | managed/structural-admission.ts, namespace-receipts.ts and workflow-mutation-contract.ts. Merge must use this owner.                                                                 |
| Open hosted tabs already track changed saved revisions and expose explicit reload/keep-local resolution.                       | Web dashboard/editorProjectLifecycleCommands.ts, io/hostedProjectRevisionTracker.ts and dashboard/useHostedProjectConflictNotices.tsx. Preserve this behavior for all affected tabs. |

Paths in the table are relative to the API workflows, shared contracts, Core
model, or web dashboard directories listed under Implementation owners below.
Existing contracts are described in [Project bundles](project-bundles.md) and
[Workflow publication](workflow-publication.md).

## Product contract

### Project actions and identities

The source bundle's context menu gains **Merge into another bundle…**. The modal
names both bundles and allows choosing a distinct existing destination bundle.
Every source project starts with **Skip**. A selected project has one of two
write actions:

| Action                                  | Result                                                                                                                                                                                                                               |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Replace an existing destination project | Save a new draft under that destination's existing project ID. Preserve its catalog name, title, filename and location. Replace its authored project contents, attached data and dataset snapshot with the selected source snapshot. |
| Add as a new project                    | Create a fresh destination-owned project ID. Default to the source-relative subfolder and filename, with editable placement/name when they collide. Copy the source snapshot and remap ownership.                                    |

Only selected projects and explicitly added dependencies receive new contents.
Unselected destination projects remain unchanged. Two source projects cannot
both replace the same destination project. References may share an explicitly
chosen destination counterpart if their graph contracts validate.

Preserve source graph/node/port IDs, wires, main graph, Library definitions,
variants, UI graphs, plugins, portable metadata and attached data. For replacements,
normalize the project's metadata ID and title to the destination owner and remove
the source path hint using the existing hosted serialization rules. Preserve
dataset and row IDs within the project; change only their project ownership.

Datasets are part of the whole-project replacement, including removals. Show
source dataset counts and this replacement rule in the review. Do not silently union old
and new datasets or leave old rows under a new draft. Old immutable revisions and
their dataset snapshots remain available through existing history/retention rules.

### Saved versions and publications

Use **Saved latest** source drafts in the first release. Do not silently save
open source tabs. The modal explains that unsaved changes are excluded.

Rewritten internal Subgraph targets use **Saved latest**, matching the current
copy/import policy and the newly merged drafts. State this in the review,
including any authored Published bindings whose selection changes. Ordinary
external references retain their project IDs and selected versions.
An authored Published binding to an existing destination member still resolves
its published snapshot if the same merge replaces that member's latest draft.
Only Saved latest bindings use the virtual replacement definition. This choice is
checked during preview, preparation and final execution without republishing.

Preserve destination endpoint names/access settings, publication records, published
revisions, web-app publications, schedules, recording history and server settings.
New additions start unpublished with no copied schedules or routes. The merge
does not claim that running applications are isolated from all draft changes:
published graphs that deliberately call Saved latest dependencies can observe
new drafts under the existing execution semantics. The review must explain this
when showing changed version bindings; do not promise a production cutover feature.

### Needed correspondence only

Keep the write selection and reference correspondence separate:

1. Selecting a1 to replace a establishes a1 → a automatically. Selecting b1 to
   replace b establishes b1 → b. An addition establishes a logical destination
   entry whose real ID will be allocated by the server.
2. Inspect recognized authored references in the selected source contents. Include
   Subgraphs, legacy references/aliases, disabled nodes, Library source nodes and
   saved variants. Opaque or unfinished variant payloads retain the existing safe
   narrowing behavior; do not interpret arbitrary strings as IDs.
3. For each referenced project belonging to A1, reuse any established mapping.
   Ask only for still-unmapped source-bundle projects, deduplicated by project ID.
   Show which selected projects, graphs and nodes require each mapping.
4. Offer **Use an existing project in A** or **Add this project to A** for each
   required dependency. A required mapping cannot be skipped while its referring
   content remains selected.
5. Using existing x stops traversal at x1: its contents and dependencies are not
   imported. Adding x1 puts that source project on the inspection queue. Process
   each imported source project once, so shared references and cycles terminate.
6. Removing a write action recomputes the required set. Discard unused dependency
   choices from the effective plan so they cannot cause an unintended addition.
   A dependency still required elsewhere retains its choice.

For a1 and b1 that only reference x1 and y1, the modal asks only about x1 and y1.
It must not require mappings for disconnected members of A1 or dependencies of a
source counterpart whose destination contents are being kept.

Recognized bindings outside A1 are retained if valid under the existing bundle
scope policy. A binding into another explicit bundle is a real conflict and must
identify its caller and target. Never silently preserve a reference back into A1
or retarget it by name after the user has reviewed a different mapping.

### Suggestions and graph correspondence

Offer project correspondence suggestions from unique source-relative paths, then
unique names, using the bounded catalogs already loaded. The explicit
**Use suggested matches** action accepts them. Ambiguous names remain
unresolved. Shared graph IDs establish the exact graph match once a project
counterpart is selected; suggesting projects does not download every candidate's
definition. Existing copies work without duplication ancestry records.

For each imported reference, resolve its target against the final destination
state: a replaced/added project's new contents take precedence over its old draft;
a use-existing counterpart contributes its current saved draft. This handles a1
referencing b1 when b1 is also being replaced in the same merge.

Keep an exact graph-ID match when present. The ordinary duplicate/edit case
preserves these identities. If a reference mapped to a use-existing counterpart
has no matching graph ID, ask for that specific graph's correspondence. Scope a
graph mapping by source project ID and source graph ID, not graph name alone.
Apply it only to imported references; never rewrite unrelated destination graphs.
Names/full graph paths may rank suggestions but cannot silently choose a graph.

Validate selected graphs with the existing boundary compatibility helpers. Keep
saved wire IDs, input data and port-order settings; do not regenerate boundaries,
match ports by their labels, or reconnect wires automatically. If no compatible
graph exists, report the caller project, graph, node ID and target graph. The user
can add/replace that dependency, choose a compatible graph, repair the source or
deselect the referring change. Arbitrary port migration is outside this release.

### Existing destination callers

Keeping a's project ID does not guarantee that an old caller remains compatible
if the replacement deletes a graph or changes its boundary. Review affected
unchanged destination drafts and active endpoint/web-app snapshots, including
published snapshots of projects whose drafts are replaced. Use the existing active
revision/index contracts to select call sites, then read only the needed definitions.

Show newly missing/incompatible incoming calls as explicit review warnings with
locations. Require acknowledgement when proceeding with known breaking changes,
as these can also result from ordinary draft edits. Do not automatically import,
edit or delete those callers, and do not turn this advisory review into a global
scan of all projects or all publication history. Incomplete advisory coverage is
displayed as incomplete, with its reason; it is not a fabricated clean result.
Existing published snapshots themselves are not rewritten.

Unresolved recognized internal project correspondences block the merge, including
bindings in inactive configurations: they must not retain source-bundle IDs.
Missing/incompatible active imported calls also block. Graph-contract issues used
only by disabled nodes, inactive variants or unused Library definitions are
located review warnings requiring acknowledgement, not an excuse to leave their
project IDs unmapped. Existing unrelated broken nodes and advisory warnings must
not become a new whole-library integrity gate. Distinguish new merge conflicts
from pre-existing issues in diagnostics.

## Modal flow

1. **Destination and changes.** Show source/destination names and paths, a
   searchable source-project list, Skip/Replace/Add controls and destination
   project selectors and editable destination-relative addition paths. Exclude
   the source from destination choices, including UUID case variants. Show selected
   only and search filter the visible list without changing choices or requesting
   a preview. Disable destination replacements already chosen by another row.
   Empty-state guidance explains when another bundle or a saved project is needed.
2. **Match referenced projects.** Show only newly required correspondences, their call
   sites and any graph choices. Highlight dependencies used only by disabled
   nodes, saved variants or Library definitions without expanding the whole bundle.
   Keep selected graph matches named and editable after validation, disambiguating
   duplicate graph names by ID. Use existing stops importing that source dependency;
   it does not prevent another explicit action from replacing the destination.
3. **Review and merge.** Summarize replacements, additions, kept counterparts,
   dataset replacement, reference/version rewrites and acknowledged warnings.
   Show an explicit source/action/destination/dataset-count table and a footer
   shortcut to the review. Explain why Merge projects is disabled.
   Disambiguate call sites by full catalog path and identify saved variants.
   Disable Merge until the latest preview is complete and blocking conflicts are
   resolved. A no-change selection cannot submit a write.

Changing selections or destination invalidates the old preview immediately.
Debounce requests, abort obsolete reads and ignore late responses using a request
sequence/lifetime guard. An earlier successful preview cannot enable Merge for
newer choices. Keep unresolved choices visible with an actionable error. Retain
matching catalog metadata for rendering while the next preview is pending or
fails, so addition paths stay mounted and retain input focus. This retained form
data never authorizes a write. Selecting the same destination or action preserves choices and custom paths
and avoids an unnecessary preview.

Use the shared Atlaskit modal/select styling and existing bundle icon conventions.
Provide labels, focus trapping, keyboard navigation, Escape cancellation, focus
return and a visible footer on short/narrow screens. Escape closes an open select
menu before dismissing the dialog. Review/error shortcuts scroll only the content,
keeping the header and actions visible. Full errors appear in the scrollable body;
the footer has a short notice and View error link rather than repeating a long
path. Suppress unrelated local
storage-upgrade prompts while the modal is open.

During commit, guard double submission synchronously and disable dismissal while
the result is pending. Preview cancellation is safe; cancelling an HTTP request
after a write starts is not proof of rollback. On an uncertain acknowledgement,
use receipt recovery and clearly retain an unknown outcome if it cannot confirm
the result. Never issue a second merge automatically. Show a success toast only
after the committed/recovered operation and an accepted fresh tree. An unsuccessful
or superseded tree refresh uses the existing refresh-needed notice. Unknown outcomes
offer Close rather than implying Cancel can undo the operation.

## API and data contracts

Add shared types alongside workflow-bundle-types.ts:

- BundleMergeChoices: destination bundle ID, selected Replace/Add actions,
  use-existing project correspondences and explicit graph correspondences.
- BundleMergePreview: source/destination identities, effective actions, required
  mappings and call sites, rewrite counts, blockers, advisory warnings and an
  optional ready fingerprint. Optional mappedGraphs contains resolved named graph
  choices for editing; it is presentation data and does not change write admission.
- BundleMergeResult: operation identity, destination folder identity, actual
  source-to-destination project mapping, changed project IDs/paths/revision IDs,
  additions and reviewed warnings.

Use discriminated actions so Use existing can never accidentally mean Replace.
The browser sends IDs, placement choices and mappings, not project contents,
dataset payloads or replacement IDs for additions. A ready preview fingerprint
is a concurrency check, not an authorization credential.

### Read-only preview

Route: POST /api/workflows/bundles/:sourceId/merge/preview.

Accept destination/choices, with an empty action list allowed for initial member
metadata. Return complete candidate lists from the bounded bundle catalogs.
Do not load all source blobs through the existing duplication preview: that
method prepares remapped copies of every member and is not the right owner here.

Capture metadata in a short consistent SQL snapshot. Read only selected/added
source drafts, needed graph counterparts and advisory caller definitions. Deduplicate
immutable revision reads. Do not download datasets for use-existing counterparts
or for graph-only diagnostics. Correspondence discovery needs project definitions
only. Once correspondences resolve, the ready review reads selected/added source
sidecars for their dataset counts, validation and write-size check. The commit
re-reads its immutable write inputs; do not create a persistent preview cache.
Check each revision row's workflow owner and each parsed project's metadata ID
against the selected project ID, using existing integrity-checked artifact reads.
Repeat owner/identity validation on cached reads too. Check definition and dataset
byte limits before parsing their payloads.

Return unresolved correspondences as normal preview state. Return typed errors
for missing/replaced bundles, unreadable revisions, unsupported storage,
oversized input or request timeout. Include useful project/graph/node locations;
never return raw parser excerpts, storage credentials or project payloads in errors.

### Commit and recovery

Route: POST /api/workflows/bundles/:sourceId/merge.

Accept the same frozen choices, ready preview fingerprint, acknowledged warning
identities and the existing StructuralMutation admission. Add an explicit
merge-bundle StructuralCommand variant. Bind the receipt to the complete canonical
request, including mappings and fingerprint. Recover through the existing
POST /api/workflows/namespace/receipt protocol; no separate merge recovery table
or mutation retry endpoint is needed.

The existing requestWorkflowBundle helper recognizes only certain write suffixes
and otherwise falls back to a create-bundle command. Do not send a merge through
that fallback or cast its command to the shared union. Add a typed merge API
function that invokes requestStructuralMutation with merge-bundle explicitly.
The preview API must remain a read-only request without structural admission.

Both routes retain requireAuth, maintenance-owner routing, no-store responses,
same-site checks, bundle intent and strict bounded Zod bodies. Use existing backend
capability checks rather than weakening bundle ownership or authorization rules.

### Concurrency read set

Fingerprint the canonical request choices and facts actually consumed. Unused
dependency choices never create an effective write or additional project read:

- Source/destination bundle IDs, namespace identities and reviewed root locations.
- Each imported source project's ID, membership, path/title and selected draft revision.
- Each replacement/use-existing target's ID, membership and consumed draft revision.
- Referenced external projects' membership and any version pointers actually used
  for binding validation.
- Addition locations and the folder identities/path-vacancy facts needed to commit.
- Caller revisions that produced acknowledged incoming-change warnings.

Do not put every unselected project's draft revision in this fingerprint. An
unrelated saved edit must not force another review. A change to a consumed project,
required mapping, graph contract or destination path returns 409 with a fresh-review
instruction, not a silent rebase. Recheck referenced membership under the topology
lock so a concurrently moved/converted project cannot bypass bundle scope checks.

## Commit algorithm

1. Capture and freeze the request with the existing receipt helper. Check for a
   committed matching receipt before requiring that source projects still exist.
   Reject expired unknown admissions and operation-ID reuse with a different body.
2. Recompute the ready preview from authoritative metadata and immutable revisions.
   Verify its fingerprint and warning acknowledgement set. Do not trust a client
   supplied graph boundary, path hint, membership claim or generated project ID.
3. Allocate all new project IDs before rewriting any project. Build one complete
   mapping for selected writes, added dependencies and use-existing counterparts.
   Use logical addition keys during preview so random UUID generation does not
   change an otherwise identical preview fingerprint.
4. Clone private parsed contents. Apply the shared typed remapper, optional graph
   mappings, destination identity/title normalization and dataset ownership
   remapping. Remove obsolete mapped path hints and refresh mapped legacy display
   titles from known destination metadata. Preserve unrelated external bindings.
5. Validate against a virtual post-merge destination, not a mixture of old and new
   definitions. Confirm imported recognized references retain no source-bundle IDs.
   Do not replace ID-like text in prompts, scripts, static data or plugin payloads.
6. Prepare every changed project's immutable revision through
   createPreparedRevisions/context.revisions outside SQL locks. Validate source
   dataset ownership and cumulative project/dataset bounds before writing artifacts.
   Preparation creates no visible draft pointer or destination catalog entry.
7. Enter structuralTransaction: topology lease first, then lock the complete
   consumed workflow-row set in deterministic project-ID order. Include read-only
   counterparts so a content save cannot change their checked boundary before
   commit. Do not acquire source and destination groups in opposing orders or
   open a nested save transaction while holding these locks.
8. Check the receipt again and revalidate the complete consumed read set,
   identities, graph versions, membership, addition vacancy and member/folder limits.
   Perform no blob reads or graph execution under these locks. A mismatch aborts
   all changes with a specific conflict.
9. Create only required ordinary destination subfolders and added project rows.
   Insert prepared revisions using insertRevision and update each replacement's
   current draft pointer/updated timestamp. Retain its catalog identity and server
   settings. Never delete/recreate a replacement project or its past revisions.
10. Queue normal managed draft/cache invalidation for changed project IDs and the
    existing catalog/tree notification in this transaction/commit lifecycle.
    Reuse the ordinary save policy; do not copy publication rows or trigger runs.
    Store the exact result envelope in the existing mutation receipt transaction.
11. Commit once. Mark attached preparations with the existing hooks, and close the
    preparation owner in finally. Known unused objects use reference-aware cleanup;
    uncertain commits retain objects until observational recovery settles ownership.
    Never directly delete blobs after a failed COMMIT acknowledgement.
12. Notify and reconcile the UI through the existing tree synchronization owner.
    A failed or superseded follow-up read does not change committed success into
    failure and must not repeat the merge. Show a refresh-needed notice if necessary.

The visibility guarantee is one committed destination state: either all chosen
draft/addition pointers change together or none do. Immutable artifact upload is
preparation, not a second catalog commit. An existing run's snapshot lifetime
continues to follow the normal runtime rules; this feature adds no run cutover lock.

## Open editors and performance

Use current hosted project revision tracking for active and inactive tabs. A tree
refresh observes changed saved revisions by stable project ID. Keep local contents
and use the existing reload/keep-local conflict UI; never call mark-clean with the
new server revision while retaining unrelated local contents. Existing optimistic
save checks prevent an old tab from silently overwriting the merged draft.

Do not automatically open added projects, switch the active tab, discard source
edits, clear unrelated recordings, or reload a tab that became dirty while a
refresh was pending. Explicit reload must retain existing binding/lifetime and
dataset-owner checks. A lost merge response followed by recovered success enters
this same reconciliation path.

Retain existing per-bundle limits of 256 projects and 512 folders, including the
post-merge destination count. Limit total prepared write content to the existing
64 MiB bundle bound. Use a separate bounded analysis budget, initially 128 MiB
across distinct project definitions, so validation cannot read unlimited content.
These are decoded limits, not compressed upload sizes.

Preview reads use one 30-second deadline. One read-only SQL statement captures
both bundle catalogs consistently. Metadata, revision and incoming-edge reads use
the existing bounded query helper, including cancellation during pool acquisition
and statement execution. Artifact reads use blobStore.getText's signal option.
Reads are sequential and cached per revision/project; no abandoned Promise.race
or new general read scheduler is introduced. Prepared writes remain sequential.
Commit preparation has a bounded 120-second budget and then uses the existing
transaction lock/statement timeouts; receipt expiry remains the existing admission
contract. Cancellation after SQL commit starts requires receipt recovery.

Validate these starting budgets with representative local latency and large
payload fixtures before freezing them in the API. Report progress/errors honestly;
do not invent a new cloud load test or turn an environment-wide latency target
into a merge correctness requirement. Preview cost should follow selected content
and needed counterparts, not total library size or publication history.

## Implementation owners

Existing root-relative files to extend:

| Area                                     | Files                                                                                                                                                                                                                         |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shared DTOs and command digest           | packages/studio-server-shared/workflow-bundle-types.ts; packages/studio-server-shared/workflow-mutation-contract.ts                                                                                                           |
| Typed authored-binding inspection/remap  | packages/studio-server-api/src/routes/workflows/remap-bundle-project.ts                                                                                                                                                       |
| Managed service wiring                   | packages/studio-server-api/src/routes/workflows/managed/bundles.ts; managed/backend.ts; storage-backend.ts in that workflows directory                                                                                        |
| HTTP/auth/admission                      | packages/studio-server-api/src/routes/workflows/bundles-router.ts; existing structural-contract.ts                                                                                                                            |
| Persistence/recovery primitives          | managed/structural-admission.ts; prepared-revisions.ts; namespace-receipts.ts; revision-factory.ts; transactions.ts, under the API workflows directory                                                                        |
| Graph contract validation                | packages/core/src/model/ProjectBundle.ts; GraphBoundaryCache.ts; nodes/SubGraphNode.ts                                                                                                                                        |
| API client and modal wiring              | packages/studio-server-web/dashboard/workflowApi.ts; WorkflowFolderContextMenu.tsx; WorkflowLibraryContextMenus.tsx; WorkflowLibraryModals.tsx; useWorkflowLibraryController.ts                                               |
| Authoritative tree/editor reconciliation | packages/studio-server-web/dashboard/useWorkflowLibraryTreeSync.ts; dashboard/editorProjectLifecycleCommands.ts; dashboard/useHostedProjectConflictNotices.tsx; packages/studio-server-web/io/hostedProjectRevisionTracker.ts |

New files, kept operation-specific:

- API workflows/bundle-merge-plan.ts: pure choices, mapping closure and validation
  helpers, with storage access supplied by the managed orchestration.
- API workflows/managed/bundle-merge.ts: metadata capture, bounded reads, ready
  preview, preparation and one transactional commit.
- Web dashboard/WorkflowBundleMergeModal.tsx and its scoped stylesheet.
- Web dashboard/bundleMerge.ts: pure form/effective-choice state only if extracting
  it makes the modal materially smaller; do not create a second server planner.
- Focused API/web unit tests, one managed integration helper and one Playwright
  bundle-merge.spec.ts.

Keep DTO leaves dependency-light and follow existing package import boundaries.
Review exact new cross-package edges if the architecture check requires it; do
not grant a blanket allowlist. Reuse graph validators and receipt owners unchanged
unless a concrete shared seam needs a small backwards-compatible extension.

## Ordered implementation and acceptance

### Phase 1 Contracts and pure mapping behavior

- [x] Define write actions, reference-only correspondences, graph mappings,
      diagnostics and the merge-bundle command.
- [x] Extend the existing binding traversal with caller locations and optional
      graph rewrites. Keep current duplicate/import behavior unchanged.
- [x] Implement the work queue, effective-plan pruning, mapping validation,
      post-merge lookup and deterministic fingerprint composition.
- [x] Establish fixtures for a1 → a, b1 → b, c1 → new c and x1 → existing x.

Accept when tests prove that only necessary correspondence is requested, inputs
are not mutated, cycles/shared dependencies terminate, graph IDs survive the normal
copy path, and no imported recognized binding leaks back to the source bundle.

### Phase 2 Read-only preview

- [x] Add bounded metadata capture and the preview route with strict validation.
- [x] Resolve final graph contracts and distinguish blockers, advisory incoming
      changes and existing unrelated issues.
- [x] Add scoped counterpart suggestions and exact caller/node diagnostics.
- [x] Prove read deduplication, cancellation, budgets and zero storage writes.

Accept when selecting two projects reads their content and actual needed
counterparts, not every member/blob in either bundle or the entire library.
An unchanged mapped counterpart must not expand the source dependency queue.

### Phase 3 Atomic commit and recovery

- [x] Integrate structural admission, exact request digest and receipt lookup.
- [x] Add immutable revision/dataset preparation and one catalog transaction.
- [x] Recheck the consumed read set under the established lock order.
- [x] Reuse revision summaries, invalidation, history and reference-aware cleanup.
- [x] Exercise the real PostgreSQL/MinIO rollback and lost-response cases before UI
      integration; do not consider mocked transaction tests sufficient.

Accept when failure at a later project leaves no earlier visible replacement or
addition, a repeated admitted request cannot create a second result, and committed
recovery still works after the source bundle is later deleted or moved.

### Phase 4 Modal and editor integration

- [x] Add the capability-gated source context action and modal steps.
- [x] Add an explicit typed API helper, stale-preview fencing, warnings and a
      synchronous submit guard.
- [x] Reconcile committed/recovered results through the existing tree owner and
      hosted content-conflict flow, preserving dirty active and inactive tabs.
- [x] Add shared modal theme/suppression rules and keyboard/narrow-screen behavior.

Accept when the example needs no mapping for unrelated projects, changing choices
cannot apply a stale preview, and tree refresh failures never repeat a committed
write or silently discard an open tab's edits.

### Phase 5 Integrated regression and documentation

- [x] Execute the matrix and local commands below, including real execution of
      the merged destination and required headless browser verification.
- [x] Enroll tests in existing API/web/browser CI lanes. No additional deployment
      workflow or release qualification service is needed for the feature.
- [x] Update project-bundles.md, this checklist and relevant publication/editor
      documentation to describe implemented rather than proposed behavior.
- [x] Review package versions according to the normal feature-release policy.

The feature is implementation-complete only after the full path works locally.
Hosted publication and deployment remain the ordinary release process; this plan
does not authorize launching a cloud test, deploying production or altering data.

## Required regression matrix

| Area                      | Cases and observable result                                                                                                                                                                                                                                                                                                  |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Main authoring loop       | Duplicate A, modify a1/b1, create c1, merge into A. Original a/b IDs and graph/node IDs survive; c has a fresh ID; source bytes/revisions stay unchanged; the destination executes the new behavior.                                                                                                                         |
| Minimal correspondence    | a1/b1 already mapped; shared x1 requested once; unrelated source members absent; use-existing x does not inspect x1's dependencies; Add x1 expands only its own needed closure.                                                                                                                                              |
| Choice changes and cycles | Unselecting a branch prunes its exclusive auto-required additions; explicitly selected additions remain. Shared dependencies remain once. Project-level cycles terminate without a blanket ban on valid graph calls.                                                                                                         |
| Typed authored bindings   | Subgraphs, self-calls, legacy aliases/references, Library sources, disabled nodes and saved variants are remapped. Missing Library definitions do not hide other bindings. Prompts/static data containing ID-looking text are unchanged.                                                                                     |
| Graph contracts           | Exact IDs, graph renames, explicit compatible graph mapping, same-name ambiguity, missing graph, changed boundary types/identities and preserved port orders/wires. A changed target included in the same merge validates against its new definition.                                                                        |
| Compatibility policy      | Unresolved internal project mappings and missing/incompatible active imported calls block. Known broken incoming destination callers and inactive graph-contract issues require acknowledgement. All recognized internal project IDs are still remapped. An unrelated pre-existing issue cannot disqualify the whole bundle. |
| Versions and scope        | Internal version normalization is reviewed; ordinary external Published/latest references remain unchanged. Another explicit bundle or a concurrently moved counterpart cannot bypass scope validation. No rewritten reference retains an A1 member ID.                                                                      |
| Data and settings         | Attached data, empty/nonempty sidecars, dataset removals, ownership mismatches and duplicate row/dataset identities. Replaced publications and their old sidecars, routes, schedules, recordings and endpoint configuration remain unchanged.                                                                                |
| Placement                 | Nested ordinary folders, same filenames in different folders, occupied paths, invalid names/escapes, source=destination and post-merge project/folder limits. No implicit overwrite on collision.                                                                                                                            |
| Concurrency               | Changed imported source, changed target/counterpart, changed graph selection, root path reuse and moved membership reject stale review. An unrelated project's draft edit does not. Opposite-direction merges and a concurrent ordinary save cannot deadlock through reversed locks.                                         |
| Atomicity and receipts    | Fail a later artifact upload and later SQL row update. Assert exact draft pointers, added rows, receipts and GC intents. Concurrent identical requests commit once. Same operation ID/different request rejects. Lost acknowledgement recovers, expired unknown request does not start.                                      |
| Editor safety             | Active/inactive dirty tabs retain local edits, stale saves reject, explicit reload uses the merged snapshot/datasets, source unsaved edits are excluded, and unrelated tabs/recordings remain active. Recovered success uses the same path.                                                                                  |
| UI resilience             | Late preview replies, destination changes, double click, Cancel, pending commit, narrow viewport, Escape/focus return, same-name projects distinguished by path, and failed/superseded refresh after successful commit.                                                                                                      |
| Bounds                    | One read per distinct needed revision, no unrelated dataset/history download, real abort propagation and no writes from preview. Large input returns an actionable bounded error rather than an empty successful plan.                                                                                                       |
| Index and runtime         | New revision summaries are immediately queryable with correct project IDs. A merged draft executes through hosted/Node paths; pinned published snapshots keep their version semantics. No production backfill or new runtime policy is required.                                                                             |

## Local verification commands

Run the fast pure/API tests first. New API tests are registered in
deploy/studio-server/scripts/api-test-files.mjs; web tests use the existing package
test command and the browser spec uses the existing editor shard list. Build the normal Core/Node
dependencies first when their compiled artifacts are missing or changed; use the
existing studio-server:build:dependencies command rather than stale declarations.

```sh
yarn workspace @valerypopoff/rivet-studio-server-api test:files src/tests/remap-bundle-project.test.ts src/tests/bundle-merge-plan.test.ts src/tests/managed-bundle-merge.test.ts src/tests/managed-bundles.test.ts src/tests/project-bundle-import.test.ts
yarn workspace @valerypopoff/rivet-studio-server-api exec tsc --noEmit
yarn workspace @valerypopoff/rivet-studio-server-web exec tsx --test tests/bundle-merge.test.ts tests/workflow-namespace.test.ts tests/editor-project-refresh.test.ts tests/hosted-project-revision-tracker.test.ts
yarn workspace @valerypopoff/rivet-studio-server-shared run build
yarn workspace @valerypopoff/rivet-studio-server-web run build
yarn node --test scripts/ci/api-test-shards.test.mjs
yarn node scripts/checks/check-doc-links.mjs
```

Extend the existing explicit-bundle contract, or a small helper it invokes, in
the local managed integration. It owns disposable PostgreSQL/MinIO services and
must never accept an ambient production URL:

```sh
yarn workspace @valerypopoff/rivet-studio-server-api test:async-managed
```

With the local application/preview running, verify the new journey and adjacent
bundle behavior using the repository runner:

```powershell
$env:PLAYWRIGHT_HEADLESS = '1'
$env:PLAYWRIGHT_SLOW_MO = '0'
$env:PLAYWRIGHT_BASE_URL = 'http://127.0.0.1:5174'
yarn studio-server:ui:observe bundle-merge.spec.ts explicit-bundles.spec.ts subgraph-bundle-scope.spec.ts
```

Inspect artifacts/playwright on a browser failure and report the actual failing
step. These are local application/storage tests, not a Kubernetes rehearsal.
Only broaden testing when changed shared seams or an observed failure justify it.

## Local validation evidence

The focused checks cover canonical fingerprints, minimal dependency closure,
stale/unused correspondence pruning, caller locations, graph remapping, safe paths,
cancellation before initialization and after an artifact read, bounded lease return,
external lookup/read deduplication and authored IDs resembling logical addition keys.
Preview-only keys are resolved by source role rather than treated as real IDs.
The implementation audit reproduced and repaired cached-owner bypass, oversized
sidecar parsing before budget validation, and case-variant self-merge admission.
Large fixtures cover the actual 128 MiB analysis and 64 MiB write boundaries.
A later preparation failure cleans the earlier owned preparation without starting
a catalog transaction.
Library activity is compared with Core's effective-node resolver: a disabled link
wrapper does not hide an active source call, while disabled or unused sources stay
advisory. The folder read set uses typed tuples without casts.
Adjacent regressions prove legacy aliases ignore Subgraph-only version/boundary
metadata, unavailable project/dataset reads fail without producing a reviewable
warning, and preview/automatic/explicit duplication reject foreign revision owners
before downloading artifacts. Storage errors expose only the safe project message;
their underlying details remain in the internal error cause.
The binding error handler distinguishes Core graph-contract failures from
infrastructure errors. Injected database failures abort both active and inactive
reviews. Revision-integrity conflicts are tagged and always block, including
cached-owner mismatch in an inactive call. Control cases preserve acknowledgement
warnings for an inactive missing graph or unavailable Published version.

The PostgreSQL/MinIO contract duplicates an actual bundle, replaces two projects,
adds one, maps a kept dependency and executes the destination. It verifies full
dataset ownership/replacement, preserved publications and source contents,
immediate reference summaries, rollback after a later-row failure, warning
acknowledgement, compatible graph correspondence, inactive warnings, exact receipt
recovery (also after source deletion), unrelated edits and a consumed save occurring
between artifact preparation and the topology transaction.
It also proves dataset removal, persisted acknowledged warning locations, two
concurrent identical admissions returning one exact result, and opposite-direction
merge serialization with a fresh-review conflict rather than a deadlock.
The mixed-version regression merges a valid Published call while replacing that
target's latest graph with an empty draft, then executes the merged caller using
the unchanged published revision. The corresponding Saved latest call correctly
blocks because its graph is gone.
The equivalent legacy alias also blocks despite a stale Published field, matching
the actual project-reference loader rather than that unsupported metadata.

Fifteen headless merge journeys cover the main selection flow, recovered success with
a failed refresh, obsolete previews, editable graph/warning choices, unknown acknowledgements,
older APIs, failed-preview refresh, large-list filtering, duplicate target choices,
dependency path focus across preview errors, same-destination/action choice preservation, empty
states, pending-commit dismissal and long errors on a 320px screen. They include
short-screen dropdown/footer access, double submission, dropdown Escape, content-only
review/error scrolling and focus return. The editor shard weight is 80 seconds to
reflect these journeys; its enrollment regression includes the new spec in the
36-spec set and checks balanced, complete coverage. The existing 23 bundle/scope
journeys also pass. Existing
hosted revision/refresh/receipt unit tests cover the reused dirty-tab and recovery
owner rather than introducing a second editor replacement path.
The review includes kept-counterpart counts and full project paths; focused web
tests distinguish equally named projects and saved variants.
A transient preview failure disables Merge; one successful manual refresh clears
its stale error without an automatic read/write retry. Unknown mutation outcomes
retain their explicit message and remain blocked.

Local acceptance passed 73 focused API tests, 40 web unit tests, the real
PostgreSQL/MinIO integration, and 38 browser journeys (15 merge and 23 adjacent
bundle/scope cases). A final targeted browser check also passed after preserving
choices when the same destination is selected again. API/shared checks, the
focused merge-UI typecheck, production web build, formatting, documentation links
and CI enrollment/balance checks passed. This is local acceptance, not a claim of
hosted CI or production deployment. Package versions are reviewed
but unchanged here: private API/shared/web feature version bumps belong to release
preparation; public Core/Node APIs were not changed by this feature.

## Implementation reconciliation

All five implementation phases are delivered in source. This audit
checks their owners and observed behavior rather than treating checked boxes as
evidence by themselves.

| Phase               | Delivered behavior                                                                                                                               | Local evidence                                                                                                                                    |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 Contracts/mapping | Typed actions, minimal dependency queue, cycles/pruning, graph and legacy-reference remapping, deterministic identity                            | Pure planner/remapper tests and existing copy/import regressions                                                                                  |
| 2 Preview           | Bounded cancellable reads, final-state graph checks, explicit required mappings, caller diagnostics, owner-safe read deduplication               | Managed preview tests including corrupt cached ownership and actual large byte-limit fixtures                                                     |
| 3 Commit/recovery   | Fresh revision preparation, one topology transaction, read-set fencing, dataset replacement/removal, durable warnings and exact receipts         | Disposable PostgreSQL/MinIO execution, rollback, concurrent admission, opposite-direction and save-race contracts; preparation failure regression |
| 4 Editor/modal      | Capability gate, compact filtered choices, editable graph matches, explicit review, current-preview admission, existing dirty-tab reconciliation | Fifteen merge browser journeys, adjacent bundle/scope checks, hosted revision/recovery tests and location-label tests                             |
| 5 Integration/docs  | Enrollment in existing API/web/browser CI lanes, updated feature/runbook documentation, reviewed version policy                                  | API/shared/UI typechecks, production builds, shard/style/structure checks and doc-link verification                                               |

The remaining publication/deployment steps use the ordinary release process and
are outside feature implementation. No production backfill, schema migration,
cloud diagnostic, additional service or runtime policy is required by this merge.

## Completion criteria and implementation stop conditions

- [x] The user's duplicate/edit/test/merge example succeeds end to end without
      manually moving projects or repairing the resulting internal references.
- [x] Only needed project/graph correspondence is requested; suggestions never
      silently decide ambiguous identity.
- [x] Whole-project/dataset replacement, saved-version selection and publication
      consequences are explicit before commit.
- [x] Replacements preserve destination identity, additions receive fresh identity,
      the source is intact, and one transaction owns all visible changes and receipt.
- [x] Real local storage, execution, recovery and browser checks pass; docs and
      test enrollment describe the same delivered behavior.

Stop and resolve the implementation design if it requires deleting/recreating
destination projects, rewriting arbitrary JSON strings, scanning every library
project synchronously, saving/importing unrelated projects, silently rebasing a
reviewed target, automatic mutation retries, or new cloud infrastructure. None is
needed to satisfy this feature. Track a concrete unsupported graph-port migration
as a targeted repair case rather than expanding this into a general graph diff
engine or weakening the existing wire contract.
